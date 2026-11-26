import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createServer as createViteServer } from 'vite';
import {
  parseConfigContentToForm,
  generateNginxConfigFromForm,
  createDefaultConfigForm,
  validateMirrorConfigTree,
  rewriteMainNginxConfForMirror,
  formatBackupTimestamp,
  parseNginxToAst,
} from './src/utils/nginxParser.ts';
import type { NginxConfigForm } from './src/utils/nginxParser.ts';
import {
  DEFAULT_EXTRA_CONFIG_PATHS,
  extractIncludePathsFromNginxConf,
  collectManagedDirectories,
  toMirrorRelativePath,
  normalizeExtraConfigPaths,
  patternToFileGlob,
} from './src/utils/pathHelpers.ts';
import type {
  SessionInfo,
  NginxStatusInfo,
  ConfigItem,
  BackupRecord,
  CertificateRecord,
  PendingDeletionItem,
} from './src/types.ts';
import {
  verifyRemoteSshAndSudo,
  initializeRemoteMirrorAndScan,
  syncAndScanRemotePatterns,
  getRemoteStatus,
  controlRemoteNginx,
  runRemoteMirrorNginxTest,
  applyRemoteMirrorToLive,
  sftpWriteFile,
  execRemoteSsh,
  closePooledSshConnection,
} from './src/server/sshManager.ts';
import type { SshCredentials } from './src/server/sshManager.ts';

interface MirrorFileRecord {
  filename: string;
  relPath: string; // relative path inside mirrorDir
  filePath: string; // actual target path e.g. "/etc/nginx/sites-enabled/minimal-chat"
  isSymlink: boolean;
  symlinkTarget?: string;
  content: string;
  updatedAt: string;
}

interface WorkspaceState {
  session: SessionInfo;
  targetEtcNginxDir: string; // sandbox local /tmp dir
  mirrorDir: string; // /tmp/nginx_mgr_mirror_{id}
  running: boolean;
  version: string;
  pid: number;
  lastReloadAt: string;
  lastCommandOutput: string;
  nginxBin: string;
  nginxIncludePatterns: string[]; // actual include patterns from nginx.conf
  extraConfigPaths: string[]; // editable extra paths in Status UI
  sshCreds?: SshCredentials;
  liveFiles: Map<string, MirrorFileRecord>; // key: relPath
  mirrorFiles: Map<string, MirrorFileRecord>; // key: relPath
  backups: BackupRecord[];
  certificates: Map<string, CertificateRecord>;
  liveCertificates: Map<string, CertificateRecord>;
}

const workspaces = new Map<string, WorkspaceState>();

const SAMPLE_CERT_API = `-----BEGIN CERTIFICATE-----
MIIDXTCCAkWgAwIBAgIJALa8f9x2K1bOMA0GCSqGSIb3DQEBCwUAMEUxCzAJBgNV
BAYTAkNOMRMwEQYDVQQIDApSome-StateMSEwHwYDVQQKDBhJbnRlcm5hbCBDb3Jw
b3JhdGlvbiBDQTAeFw0yNjAxMDEwMDAwMDBaFw0yNzA4MTUyMzU5NTlaMBoxGDAW
BgNVBAMTD2FwaS5pbnRlcm5hbC5pbzCCASIwDQYJKoZIhvcNAQEBBQADggEPADCC
-----END CERTIFICATE-----`;

const SAMPLE_KEY_API = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC7VJTUt9Us8cKj
MzEfYyjiWA4R4/M2bS1+fWIcPm15A6mP1v7yH8C8k2Z9vX0L3mPqW2xN7bV8cQ1R
-----END PRIVATE KEY-----`;

const SAMPLE_CERT_WILDCARD = `-----BEGIN CERTIFICATE-----
MIIDXTCCAkWgAwIBAgIJALb9g8y3L2cPMA0GCSqGSIb3DQEBCwUAMEUxCzAJBgNV
BAYTAkNOMRMwEQYDVQQIDApSome-StateMSEwHwYDVQQKDBhJbnRlcm5hbCBDb3Jw
b3JhdGlvbiBDQTAeFw0yNjAyMDEwMDAwMDBaFw0yNzExMzAyMzU5NTlaMBcxFTAT
BgNVBAMMDCouY29ycC5sb2NhbDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC
-----END CERTIFICATE-----`;

const SAMPLE_KEY_WILDCARD = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQD8WKUvu0Vt9dLk
NaFgZzljXB5S5/N3cT2+gXJdQn26B7nQ2w8zI9D9l3a0wY1M4nQrX3yO8cW9dR2S
-----END PRIVATE KEY-----`;

const INITIAL_MAIN_NGINX_CONF = `user www-data;
worker_processes auto;
pid /run/nginx.pid;

events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    sendfile on;
    keepalive_timeout 65;

    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
}
`;

const INITIAL_CONFIG_FILES: { relPath: string; filename: string; content: string }[] = [
  {
    relPath: 'conf.d/api-gateway.conf',
    filename: 'api-gateway.conf',
    content: `upstream api_gateway_pool {
    server 10.0.1.11:8080 weight=5;
    server 10.0.1.12:8080;
}

server {
    listen 80;
    listen 443 ssl;
    server_name api.internal.io;
    ssl_certificate /etc/nginx/ssl/api.internal.io.crt;
    ssl_certificate_key /etc/nginx/ssl/api.internal.io.key;
    client_max_body_size 50m;
    proxy_connect_timeout 60s;
    proxy_read_timeout 60s;

    location / {
        proxy_pass http://api_gateway_pool;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
`,
  },
  {
    relPath: 'conf.d/order-service.conf',
    filename: 'order-service.conf',
    content: `server {
    listen 8080;
    server_name order.internal.io;

    location / {
        proxy_pass http://10.0.2.15:9000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
`,
  },
  {
    relPath: 'conf.d/admin-portal.conf',
    filename: 'admin-portal.conf',
    content: `server {
    listen 80;
    server_name admin.internal.io;
    root /var/www/admin-portal/dist;
    index index.html index.htm;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
`,
  },
  {
    relPath: 'sites-available/minimal-chat',
    filename: 'minimal-chat',
    content: `server {
    listen 8088;

    location / {
        proxy_pass http://127.0.0.1:3001;
    }
}
`,
  },
];

function getAvailableDirectories(ws: WorkspaceState): string[] {
  return collectManagedDirectories(ws.nginxIncludePatterns, ws.extraConfigPaths);
}

function isFileMatchedByPatterns(filePath: string, patterns: string[]): boolean {
  const dir = path.posix.dirname(filePath);
  const name = path.posix.basename(filePath);
  for (const pat of patterns) {
    const { baseDir, glob } = patternToFileGlob(pat);
    if (baseDir !== dir) continue;
    if (glob === '*') return true;
    const regexStr =
      '^' +
      glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$';
    if (new RegExp(regexStr).test(name)) return true;
  }
  return false;
}

function buildStatusInfo(ws: WorkspaceState): NginxStatusInfo {
  const { configs, pendingDeletions } = buildWorkspaceConfigsResponse(ws);
  const modifiedConfigs =
    configs.filter((c) => c.syncStatus !== 'synced').length + pendingDeletions.length;

  let pendingCerts = 0;
  for (const cert of ws.certificates.values()) {
    if (cert.syncStatus !== 'synced') pendingCerts++;
  }

  return {
    running: ws.running,
    version: ws.version,
    osType: ws.session.osType,
    mainConfigPath: '/etc/nginx/nginx.conf',
    configDirs: ws.nginxIncludePatterns,
    extraConfigPaths: ws.extraConfigPaths,
    availableDirectories: getAvailableDirectories(ws),
    mirrorDir: ws.mirrorDir,
    pid: ws.running ? ws.pid : 0,
    uptime: ws.running ? 'Running' : 'Stopped',
    lastReloadAt: ws.lastReloadAt,
    pendingConfigChanges: modifiedConfigs,
    pendingCertChanges: pendingCerts,
    lastCommandOutput: ws.lastCommandOutput,
  };
}

function createDemoSandboxWorkspace(sessionId = 'demo01'): WorkspaceState {
  const targetEtcNginxDir = `/tmp/nginx_mgr_target_${sessionId}/etc/nginx`;
  const mirrorDir = `/tmp/nginx_mgr_mirror_${sessionId}`;

  fs.rmSync(`/tmp/nginx_mgr_target_${sessionId}`, { recursive: true, force: true });
  fs.rmSync(mirrorDir, { recursive: true, force: true });

  fs.mkdirSync(path.join(targetEtcNginxDir, 'conf.d'), { recursive: true });
  fs.mkdirSync(path.join(targetEtcNginxDir, 'sites-available'), { recursive: true });
  fs.mkdirSync(path.join(targetEtcNginxDir, 'sites-enabled'), { recursive: true });
  fs.mkdirSync(path.join(targetEtcNginxDir, 'ssl'), { recursive: true });

  fs.writeFileSync(path.join(targetEtcNginxDir, 'nginx.conf'), INITIAL_MAIN_NGINX_CONF, 'utf-8');
  fs.writeFileSync(path.join(targetEtcNginxDir, 'ssl/api.internal.io.crt'), SAMPLE_CERT_API, 'utf-8');
  fs.writeFileSync(path.join(targetEtcNginxDir, 'ssl/api.internal.io.key'), SAMPLE_KEY_API, 'utf-8');
  fs.writeFileSync(
    path.join(targetEtcNginxDir, 'ssl/wildcard.corp.local.crt'),
    SAMPLE_CERT_WILDCARD,
    'utf-8'
  );
  fs.writeFileSync(
    path.join(targetEtcNginxDir, 'ssl/wildcard.corp.local.key'),
    SAMPLE_KEY_WILDCARD,
    'utf-8'
  );

  const nowIso = new Date().toISOString();
  const ts = formatBackupTimestamp(new Date());

  const liveFiles = new Map<string, MirrorFileRecord>();
  const mirrorFiles = new Map<string, MirrorFileRecord>();

  for (const item of INITIAL_CONFIG_FILES) {
    const fullTarget = path.join(targetEtcNginxDir, item.relPath);
    fs.mkdirSync(path.dirname(fullTarget), { recursive: true });
    fs.writeFileSync(fullTarget, item.content, 'utf-8');

    const rec: MirrorFileRecord = {
      filename: item.filename,
      relPath: item.relPath,
      filePath: `/etc/nginx/${item.relPath}`,
      isSymlink: false,
      content: item.content,
      updatedAt: nowIso,
    };
    liveFiles.set(item.relPath, { ...rec });
    mirrorFiles.set(item.relPath, { ...rec });
  }

  // Create realistic symlink in sites-enabled pointing to sites-available/minimal-chat
  const symlinkRel = 'sites-enabled/minimal-chat';
  const symlinkTarget = '/etc/nginx/sites-available/minimal-chat';
  fs.symlinkSync(symlinkTarget, path.join(targetEtcNginxDir, symlinkRel));
  const symRec: MirrorFileRecord = {
    filename: 'minimal-chat',
    relPath: symlinkRel,
    filePath: `/etc/nginx/${symlinkRel}`,
    isSymlink: true,
    symlinkTarget,
    content: '',
    updatedAt: nowIso,
  };
  liveFiles.set(symlinkRel, { ...symRec });
  mirrorFiles.set(symlinkRel, { ...symRec });

  fs.cpSync(targetEtcNginxDir, mirrorDir, { recursive: true, verbatimSymlinks: true });
  const rewrittenMain = rewriteMainNginxConfForMirror(INITIAL_MAIN_NGINX_CONF, mirrorDir);
  fs.writeFileSync(path.join(mirrorDir, 'nginx.conf'), rewrittenMain, 'utf-8');

  const backups: BackupRecord[] = INITIAL_CONFIG_FILES.map((item, idx) => ({
    id: `init-backup-${idx + 1}`,
    backupName: `${item.filename}-${ts}`,
    filename: item.filename,
    filePath: `/etc/nginx/${item.relPath}`,
    content: item.content,
    createdAt: nowIso,
    isInitial: true,
    label: '初始源配置',
  }));

  const cert1: CertificateRecord = {
    id: 'cert-api-internal',
    name: 'api.internal.io',
    certFilename: 'api.internal.io.crt',
    keyFilename: 'api.internal.io.key',
    certPath: '/etc/nginx/ssl/api.internal.io.crt',
    keyPath: '/etc/nginx/ssl/api.internal.io.key',
    domains: ['api.internal.io'],
    issuer: 'Internal Corporation CA',
    expiresAt: '2027-08-15',
    certContent: SAMPLE_CERT_API,
    keyContent: SAMPLE_KEY_API,
    syncStatus: 'synced',
    referencedBy: ['api-gateway.conf'],
    updatedAt: nowIso,
  };

  const cert2: CertificateRecord = {
    id: 'cert-wildcard-corp',
    name: 'wildcard.corp.local',
    certFilename: 'wildcard.corp.local.crt',
    keyFilename: 'wildcard.corp.local.key',
    certPath: '/etc/nginx/ssl/wildcard.corp.local.crt',
    keyPath: '/etc/nginx/ssl/wildcard.corp.local.key',
    domains: ['*.corp.local', 'corp.local'],
    issuer: 'Internal Corporation CA',
    expiresAt: '2027-11-30',
    certContent: SAMPLE_CERT_WILDCARD,
    keyContent: SAMPLE_KEY_WILDCARD,
    syncStatus: 'synced',
    referencedBy: [],
    updatedAt: nowIso,
  };

  const certificates = new Map<string, CertificateRecord>();
  certificates.set(cert1.id, { ...cert1 });
  certificates.set(cert2.id, { ...cert2 });

  const liveCertificates = new Map<string, CertificateRecord>();
  liveCertificates.set(cert1.id, { ...cert1 });
  liveCertificates.set(cert2.id, { ...cert2 });

  const session: SessionInfo = {
    sessionId,
    host: '192.168.10.42',
    port: 22,
    username: 'ubuntu',
    osType: 'Ubuntu 22.04 LTS',
    connectionMode: 'sandbox',
    mirrorDir,
    connectedAt: nowIso,
  };

  const nginxIncludePatterns = extractIncludePathsFromNginxConf(INITIAL_MAIN_NGINX_CONF);

  const state: WorkspaceState = {
    session,
    targetEtcNginxDir,
    mirrorDir,
    running: true,
    version: '1.24.0',
    pid: 1842,
    lastReloadAt: nowIso,
    lastCommandOutput: '',
    nginxBin: 'nginx',
    nginxIncludePatterns,
    extraConfigPaths: [...DEFAULT_EXTRA_CONFIG_PATHS],
    liveFiles,
    mirrorFiles,
    backups,
    certificates,
    liveCertificates,
  };

  workspaces.set(sessionId, state);
  return state;
}

function buildWorkspaceConfigsResponse(ws: WorkspaceState): {
  configs: ConfigItem[];
  pendingDeletions: PendingDeletionItem[];
} {
  const configs: ConfigItem[] = [];

  for (const [relPath, mFile] of ws.mirrorFiles.entries()) {
    const liveFile = ws.liveFiles.get(relPath);

    if (mFile.isSymlink) {
      let syncStatus: 'synced' | 'modified' | 'new' = 'synced';
      if (!liveFile) {
        syncStatus = 'new';
      } else if (
        !liveFile.isSymlink ||
        (liveFile.symlinkTarget || '') !== (mFile.symlinkTarget || '')
      ) {
        syncStatus = 'modified';
      }

      configs.push({
        filename: mFile.filename,
        filePath: mFile.filePath,
        isSymlink: true,
        symlinkTarget: mFile.symlinkTarget || '',
        listenPorts: [],
        serverName: '-',
        syncStatus,
        rawContent: '',
        liveRawContent: null,
        form: createDefaultConfigForm(
          mFile.filename,
          path.posix.dirname(mFile.filePath)
        ),
        updatedAt: mFile.updatedAt,
      });
      continue;
    }

    const parsed = parseConfigContentToForm(mFile.filename, mFile.filePath, mFile.content);

    let syncStatus: 'synced' | 'modified' | 'new' = 'synced';
    if (!liveFile) {
      syncStatus = 'new';
    } else if (liveFile.isSymlink || liveFile.content.trim() !== mFile.content.trim()) {
      syncStatus = 'modified';
    }

    configs.push({
      filename: mFile.filename,
      filePath: mFile.filePath,
      isSymlink: false,
      listenPorts: parsed.listenPortsList,
      serverName: parsed.displayServerName,
      syncStatus,
      rawContent: mFile.content,
      liveRawContent: liveFile ? liveFile.content : null,
      form: parsed.form,
      updatedAt: mFile.updatedAt,
    });
  }

  const pendingDeletions: PendingDeletionItem[] = [];
  for (const [relPath, lFile] of ws.liveFiles.entries()) {
    if (!ws.mirrorFiles.has(relPath)) {
      pendingDeletions.push({
        filename: lFile.filename,
        filePath: lFile.filePath,
        deletedAt: new Date().toISOString(),
      });
    }
  }

  return { configs, pendingDeletions };
}

function refreshCertificateReferences(
  ws: WorkspaceState,
  configs: ConfigItem[]
): CertificateRecord[] {
  const list: CertificateRecord[] = [];
  for (const cert of ws.certificates.values()) {
    if (cert.syncStatus === 'deleted') continue;
    const refs: string[] = [];
    for (const cfg of configs) {
      if (cfg.isSymlink) continue;
      if (
        cfg.rawContent.includes(cert.certPath) ||
        cfg.rawContent.includes(cert.keyPath) ||
        cfg.form.sslCertificate === cert.certPath
      ) {
        refs.push(cfg.filename);
      }
    }
    cert.referencedBy = refs;
    list.push({ ...cert });
  }
  return list;
}

function getAvailableCertPaths(ws: WorkspaceState): Set<string> {
  const paths = new Set<string>();
  for (const cert of ws.certificates.values()) {
    if (cert.syncStatus !== 'deleted') {
      paths.add(cert.certPath);
      paths.add(cert.keyPath);
    }
  }
  return paths;
}

function getStagedCertPaths(ws: WorkspaceState): string[] {
  const paths: string[] = [];
  for (const cert of ws.certificates.values()) {
    if (cert.syncStatus === 'staged') {
      paths.push(cert.certPath, cert.keyPath);
    }
  }
  return paths;
}

function findMirrorEntriesByFilename(
  ws: WorkspaceState,
  filename: string
): MirrorFileRecord[] {
  const matches: MirrorFileRecord[] = [];
  for (const rec of ws.mirrorFiles.values()) {
    if (rec.filename === filename) {
      matches.push(rec);
    }
  }
  return matches;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  const defaultDemoWs = createDemoSandboxWorkspace('demo01');

  function getWorkspaceFromReq(req: express.Request): WorkspaceState | null {
    const sid =
      (req.headers['x-session-id'] as string) ||
      (req.query.sessionId as string) ||
      '';
    if (sid && workspaces.has(sid)) {
      return workspaces.get(sid)!;
    }
    if (sid === 'demo01') {
      return defaultDemoWs;
    }
    return null;
  }

  // 1. Real SSH Login & Mirror Initialization
  app.post('/api/auth/login', async (req, res) => {
    const { host, port = 22, username, password } = req.body || {};
    if (!host || !String(host).trim()) {
      res.status(400).json({ error: '请输入目标主机 IP 地址' });
      return;
    }
    if (!username || !String(username).trim()) {
      res.status(400).json({ error: '请输入具备 sudo 权限的用户名' });
      return;
    }
    if (!password || !String(password).trim()) {
      res.status(400).json({ error: '请输入 SSH 登录密码' });
      return;
    }

    const creds: SshCredentials = {
      host: String(host).trim(),
      port: Number(port) || 22,
      username: String(username).trim(),
      password: String(password),
    };

    const verify = await verifyRemoteSshAndSudo(creds);
    if (!verify.ok) {
      res.status(401).json({ error: verify.error || 'SSH 连接或权限校验失败' });
      return;
    }

    const shortId = crypto.randomBytes(4).toString('hex');
    const remoteMirrorDir = `/tmp/nginx_mgr_mirror_${shortId}`;
    const initialExtraPaths = [...DEFAULT_EXTRA_CONFIG_PATHS];
    const initRes = await initializeRemoteMirrorAndScan(
      creds,
      remoteMirrorDir,
      initialExtraPaths
    );

    if (!initRes.ok) {
      res.status(500).json({ error: initRes.error || '初始化远程镜像失败' });
      return;
    }

    const remoteStatus = await getRemoteStatus(creds, verify.nginxBin || 'nginx');
    const nowIso = new Date().toISOString();
    const ts = formatBackupTimestamp(new Date());

    const liveFiles = new Map<string, MirrorFileRecord>();
    const mirrorFiles = new Map<string, MirrorFileRecord>();
    const backups: BackupRecord[] = [];

    for (const f of initRes.files) {
      const rec: MirrorFileRecord = {
        filename: f.filename,
        relPath: f.relPath,
        filePath: f.filePath,
        isSymlink: f.isSymlink,
        symlinkTarget: f.symlinkTarget,
        content: f.content,
        updatedAt: f.mtime,
      };
      liveFiles.set(f.relPath, { ...rec });
      mirrorFiles.set(f.relPath, { ...rec });

      if (!f.isSymlink) {
        backups.push({
          id: `init-bk-${backups.length + 1}`,
          backupName: `${f.filename}-${ts}`,
          filename: f.filename,
          filePath: f.filePath,
          content: f.content,
          createdAt: nowIso,
          isInitial: true,
          label: '初始源配置',
        });
      }
    }

    const certificates = new Map<string, CertificateRecord>();
    const liveCertificates = new Map<string, CertificateRecord>();
    for (const c of initRes.certs) {
      certificates.set(c.id, { ...c });
      liveCertificates.set(c.id, { ...c });
    }

    const session: SessionInfo = {
      sessionId: shortId,
      host: creds.host,
      port: creds.port,
      username: creds.username,
      osType: verify.osType || 'Ubuntu Linux',
      connectionMode: 'ssh',
      mirrorDir: remoteMirrorDir,
      connectedAt: nowIso,
    };

    const ws: WorkspaceState = {
      session,
      targetEtcNginxDir: '/etc/nginx',
      mirrorDir: remoteMirrorDir,
      running: remoteStatus.running,
      version: remoteStatus.version || verify.nginxVersion || 'unknown',
      pid: remoteStatus.pid,
      lastReloadAt: nowIso,
      lastCommandOutput: '',
      nginxBin: verify.nginxBin || 'nginx',
      nginxIncludePatterns:
        initRes.nginxIncludePatterns.length > 0
          ? initRes.nginxIncludePatterns
          : remoteStatus.configDirs,
      extraConfigPaths: initialExtraPaths,
      sshCreds: creds,
      liveFiles,
      mirrorFiles,
      backups,
      certificates,
      liveCertificates,
    };

    workspaces.set(shortId, ws);

    const { configs, pendingDeletions } = buildWorkspaceConfigsResponse(ws);
    const certList = refreshCertificateReferences(ws, configs);

    res.json({
      session: ws.session,
      status: buildStatusInfo(ws),
      configs,
      pendingDeletions,
      backups: ws.backups,
      certificates: certList,
    });
  });

  app.post('/api/auth/logout', (req, res) => {
    const ws = getWorkspaceFromReq(req);
    if (ws && ws.session.connectionMode === 'ssh') {
      closePooledSshConnection(ws.sshCreds);
      workspaces.delete(ws.session.sessionId);
    }
    res.json({ ok: true });
  });

  app.get('/api/session', (req, res) => {
    const ws = getWorkspaceFromReq(req);
    if (!ws) {
      res.status(401).json({ error: '会话已过期或未建立 SSH 连接，请重新登录' });
      return;
    }
    res.json({ session: ws.session });
  });

  // 2. Status Module
  app.get('/api/status', async (req, res) => {
    const ws = getWorkspaceFromReq(req);
    if (!ws) {
      res.status(401).json({ error: '会话已过期，请重新登录' });
      return;
    }

    if (ws.session.connectionMode === 'ssh' && ws.sshCreds) {
      const liveSt = await getRemoteStatus(ws.sshCreds, ws.nginxBin);
      ws.running = liveSt.running;
      ws.version = liveSt.version;
      ws.pid = liveSt.pid;
      if (liveSt.configDirs.length > 0) {
        ws.nginxIncludePatterns = liveSt.configDirs;
      }
    }

    res.json(buildStatusInfo(ws));
  });

  app.post('/api/status/extra-paths', async (req, res) => {
    const ws = getWorkspaceFromReq(req);
    if (!ws) {
      res.status(401).json({ error: '会话已过期，请重新登录' });
      return;
    }
    const { extraConfigPaths } = req.body as { extraConfigPaths?: string[] };
    if (!Array.isArray(extraConfigPaths)) {
      res.status(400).json({ error: '额外加载路径格式无效' });
      return;
    }

    const nextExtra = normalizeExtraConfigPaths(extraConfigPaths);
    ws.extraConfigPaths = nextExtra;
    const allPatterns = [...ws.nginxIncludePatterns, ...nextExtra];

    if (ws.session.connectionMode === 'ssh' && ws.sshCreds) {
      const scanned = await syncAndScanRemotePatterns(ws.sshCreds, ws.mirrorDir, allPatterns, {
        syncFromHost: true,
        skipExistingInMirror: true,
      });

      const scannedRelSet = new Set(scanned.map((s) => s.relPath));

      // Add newly discovered items from newly added extra paths (preserve existing unsaved mirror edits)
      for (const f of scanned) {
        const rec: MirrorFileRecord = {
          filename: f.filename,
          relPath: f.relPath,
          filePath: f.filePath,
          isSymlink: f.isSymlink,
          symlinkTarget: f.symlinkTarget,
          content: f.content,
          updatedAt: f.mtime,
        };
        if (!ws.liveFiles.has(f.relPath)) {
          ws.liveFiles.set(f.relPath, { ...rec });
        }
        if (!ws.mirrorFiles.has(f.relPath)) {
          ws.mirrorFiles.set(f.relPath, { ...rec });
        }
      }

      // Remove synced/untouched items that are no longer matched by any pattern
      for (const [relPath, lFile] of Array.from(ws.liveFiles.entries())) {
        if (!scannedRelSet.has(relPath) && !isFileMatchedByPatterns(lFile.filePath, allPatterns)) {
          const mFile = ws.mirrorFiles.get(relPath);
          const untouched =
            mFile &&
            mFile.isSymlink === lFile.isSymlink &&
            (mFile.isSymlink
              ? mFile.symlinkTarget === lFile.symlinkTarget
              : mFile.content.trim() === lFile.content.trim());
          if (untouched) {
            ws.mirrorFiles.delete(relPath);
            ws.liveFiles.delete(relPath);
          }
        }
      }
    } else {
      // Sandbox mode: rescan targetEtcNginxDir for newly covered patterns & prune untouched removed paths
      for (const pat of nextExtra) {
        const { baseDir, glob } = patternToFileGlob(pat);
        if (!baseDir) continue;
        const localTargetDir = baseDir.startsWith('/etc/nginx')
          ? path.join(ws.targetEtcNginxDir, baseDir.slice('/etc/nginx'.length))
          : baseDir;
        if (!fs.existsSync(localTargetDir) || !fs.statSync(localTargetDir).isDirectory()) continue;

        const regexStr =
          '^' +
          glob
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.') +
          '$';
        const globRegex = new RegExp(regexStr);

        for (const entry of fs.readdirSync(localTargetDir)) {
          if (entry.startsWith('.') || !globRegex.test(entry)) continue;
          const fullLocal = path.join(localTargetDir, entry);
          const stat = fs.lstatSync(fullLocal);
          const absRemotePath = `${baseDir}/${entry}`;
          const relPath = toMirrorRelativePath(absRemotePath);
          if (stat.isSymbolicLink()) {
            const tgt = fs.readlinkSync(fullLocal);
            const rec: MirrorFileRecord = {
              filename: entry,
              relPath,
              filePath: absRemotePath,
              isSymlink: true,
              symlinkTarget: tgt,
              content: '',
              updatedAt: stat.mtime.toISOString(),
            };
            if (!ws.liveFiles.has(relPath)) ws.liveFiles.set(relPath, { ...rec });
            if (!ws.mirrorFiles.has(relPath)) ws.mirrorFiles.set(relPath, { ...rec });
          } else if (stat.isFile()) {
            const content = fs.readFileSync(fullLocal, 'utf-8');
            const rec: MirrorFileRecord = {
              filename: entry,
              relPath,
              filePath: absRemotePath,
              isSymlink: false,
              content,
              updatedAt: stat.mtime.toISOString(),
            };
            if (!ws.liveFiles.has(relPath)) ws.liveFiles.set(relPath, { ...rec });
            if (!ws.mirrorFiles.has(relPath)) ws.mirrorFiles.set(relPath, { ...rec });
          }
        }
      }

      for (const [relPath, lFile] of Array.from(ws.liveFiles.entries())) {
        if (!isFileMatchedByPatterns(lFile.filePath, allPatterns)) {
          const mFile = ws.mirrorFiles.get(relPath);
          const untouched =
            mFile &&
            mFile.isSymlink === lFile.isSymlink &&
            (mFile.isSymlink
              ? mFile.symlinkTarget === lFile.symlinkTarget
              : mFile.content.trim() === lFile.content.trim());
          if (untouched) {
            ws.mirrorFiles.delete(relPath);
            ws.liveFiles.delete(relPath);
          }
        }
      }
    }

    const { configs, pendingDeletions } = buildWorkspaceConfigsResponse(ws);
    const certificates = refreshCertificateReferences(ws, configs);
    res.json({
      ok: true,
      status: buildStatusInfo(ws),
      configs,
      pendingDeletions,
      certificates,
    });
  });

  app.post('/api/status/control', async (req, res) => {
    const ws = getWorkspaceFromReq(req);
    if (!ws) {
      res.status(401).json({ error: '会话已过期，请重新登录' });
      return;
    }
    const { action } = req.body || {};
    if (!['reload', 'restart', 'start', 'stop'].includes(action)) {
      res.status(400).json({ error: '未知的服务控制指令' });
      return;
    }

    const nowIso = new Date().toISOString();

    if (ws.session.connectionMode === 'ssh' && ws.sshCreds) {
      const ctrl = await controlRemoteNginx(ws.sshCreds, action, ws.nginxBin);
      ws.lastCommandOutput = ctrl.output;
      if (!ctrl.ok) {
        res.status(400).json({
          error: `执行 ${action} 失败：${ctrl.output || '请检查配置与 Nginx 状态'}`,
        });
        return;
      }
      const liveSt = await getRemoteStatus(ws.sshCreds, ws.nginxBin);
      ws.running = liveSt.running;
      ws.pid = liveSt.pid;
      ws.lastReloadAt = nowIso;
    } else {
      if (action === 'reload' || action === 'start') {
        ws.running = true;
        ws.lastReloadAt = nowIso;
      } else if (action === 'restart') {
        ws.running = true;
        ws.pid = Math.floor(2000 + Math.random() * 6000);
        ws.lastReloadAt = nowIso;
      } else if (action === 'stop') {
        ws.running = false;
      }
    }

    res.json({
      ok: true,
      running: ws.running,
      pid: ws.running ? ws.pid : 0,
      lastReloadAt: ws.lastReloadAt,
      status: buildStatusInfo(ws),
    });
  });

  // 3. Configs Module (100% Mirror Isolated)
  app.get('/api/configs', (req, res) => {
    const ws = getWorkspaceFromReq(req);
    if (!ws) {
      res.status(401).json({ error: '会话已过期，请重新登录' });
      return;
    }
    const { configs, pendingDeletions } = buildWorkspaceConfigsResponse(ws);
    refreshCertificateReferences(ws, configs);
    res.json({ configs, pendingDeletions });
  });

  app.post('/api/configs', async (req, res) => {
    const ws = getWorkspaceFromReq(req);
    if (!ws) {
      res.status(401).json({ error: '会话已过期，请重新登录' });
      return;
    }
    const {
      entryType = 'regular',
      filename,
      directory,
      symlinkTarget,
    } = req.body || {};

    if (!filename || !String(filename).trim()) {
      res.status(400).json({ error: '请输入名称（如 app.conf 或 minimal-chat）' });
      return;
    }

    const cleanName = String(filename).trim();
    if (!/^[a-zA-Z0-9._-]+$/.test(cleanName) || cleanName === '.' || cleanName === '..') {
      res.status(400).json({ error: '文件名仅支持字母、数字、点、下划线和连字符' });
      return;
    }

    const availableDirs = getAvailableDirectories(ws);
    let targetDir =
      typeof directory === 'string' && directory.trim()
        ? directory.trim().replace(/\/+$/, '')
        : '';

    // Backward-compatible short dir names if passed
    if (targetDir === 'conf.d' || targetDir === 'sites-enabled' || targetDir === 'sites-available') {
      targetDir = `/etc/nginx/${targetDir}`;
    }

    if (!targetDir) {
      if (entryType === 'symlink') {
        targetDir = availableDirs.includes('/etc/nginx/sites-enabled')
          ? '/etc/nginx/sites-enabled'
          : availableDirs[0] || '/etc/nginx/sites-enabled';
      } else {
        targetDir = cleanName.endsWith('.conf')
          ? availableDirs.includes('/etc/nginx/conf.d')
            ? '/etc/nginx/conf.d'
            : availableDirs[0] || '/etc/nginx/conf.d'
          : availableDirs.includes('/etc/nginx/sites-available')
          ? '/etc/nginx/sites-available'
          : availableDirs[0] || '/etc/nginx/sites-available';
      }
    }

    if (!availableDirs.includes(targetDir)) {
      res.status(400).json({ error: `目录 ${targetDir} 不在当前管理加载路径范围内` });
      return;
    }

    const absFilePath = `${targetDir}/${cleanName}`;
    const relPath = toMirrorRelativePath(absFilePath);

    if (ws.mirrorFiles.has(relPath)) {
      res.status(400).json({ error: `镜像目录中已存在同名配置 ${absFilePath}` });
      return;
    }

    if (entryType === 'symlink') {
      const cleanTarget = typeof symlinkTarget === 'string' ? symlinkTarget.trim() : '';
      if (!cleanTarget || /[\r\n\0]/.test(cleanTarget)) {
        res.status(400).json({ error: '请输入有效的软链接指向目标路径' });
        return;
      }

      if (ws.session.connectionMode === 'ssh' && ws.sshCreds) {
        const mirrorLinkPath = `${ws.mirrorDir}/${relPath}`;
        const mirrorParent = path.posix.dirname(mirrorLinkPath);
        const mkRes = await execRemoteSsh(
          ws.sshCreds,
          `mkdir -p '${mirrorParent.replace(/'/g, `'\\''`)}' && ln -sfn '${cleanTarget.replace(/'/g, `'\\''`)}' '${mirrorLinkPath.replace(/'/g, `'\\''`)}'`,
          { timeoutMs: 8000 }
        );
        if (!mkRes.ok) {
          res.status(500).json({ error: `创建远程镜像软链接失败：${mkRes.stderr}` });
          return;
        }
      } else {
        const localPath = path.join(ws.mirrorDir, relPath);
        fs.mkdirSync(path.dirname(localPath), { recursive: true });
        if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
        fs.symlinkSync(cleanTarget, localPath);
      }

      ws.mirrorFiles.set(relPath, {
        filename: cleanName,
        relPath,
        filePath: absFilePath,
        isSymlink: true,
        symlinkTarget: cleanTarget,
        content: '',
        updatedAt: new Date().toISOString(),
      });

      const { configs, pendingDeletions } = buildWorkspaceConfigsResponse(ws);
      const created = configs.find((c) => c.filePath === absFilePath);
      res.json({ created, configs, pendingDeletions, status: buildStatusInfo(ws) });
      return;
    }

    const form = createDefaultConfigForm(cleanName, targetDir);
    const generated = generateNginxConfigFromForm(form);

    if (ws.session.connectionMode === 'ssh' && ws.sshCreds) {
      const mirrorTarget = `${ws.mirrorDir}/${relPath}`;
      let writeRes = await sftpWriteFile(ws.sshCreds, mirrorTarget, generated);
      if (!writeRes.ok) {
        const mirrorParent = path.posix.dirname(mirrorTarget);
        await execRemoteSsh(
          ws.sshCreds,
          `mkdir -p '${mirrorParent.replace(/'/g, `'\\''`)}'`,
          { timeoutMs: 5000 }
        );
        writeRes = await sftpWriteFile(ws.sshCreds, mirrorTarget, generated);
      }
      if (!writeRes.ok) {
        res.status(500).json({ error: `写入远程镜像失败：${writeRes.error}` });
        return;
      }
    } else {
      const localPath = path.join(ws.mirrorDir, relPath);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, generated, 'utf-8');
    }

    ws.mirrorFiles.set(relPath, {
      filename: cleanName,
      relPath,
      filePath: absFilePath,
      isSymlink: false,
      content: generated,
      updatedAt: new Date().toISOString(),
    });

    const { configs, pendingDeletions } = buildWorkspaceConfigsResponse(ws);
    const created = configs.find((c) => c.filePath === absFilePath);

    res.json({
      created,
      configs,
      pendingDeletions,
      status: buildStatusInfo(ws),
    });
  });

  app.delete('/api/configs/:filename', async (req, res) => {
    const ws = getWorkspaceFromReq(req);
    if (!ws) {
      res.status(401).json({ error: '会话已过期，请重新登录' });
      return;
    }
    const filename = req.params.filename;
    const requestedFilePath = typeof req.query.filePath === 'string' ? req.query.filePath : '';

    let matches = findMirrorEntriesByFilename(ws, filename);
    if (requestedFilePath) {
      matches = matches.filter((m) => m.filePath === requestedFilePath);
    }

    if (matches.length === 0) {
      res.status(404).json({ error: `未在镜像目录中找到配置文件 ${filename}` });
      return;
    }

    for (const rec of matches) {
      if (ws.session.connectionMode === 'ssh' && ws.sshCreds) {
        const targetMirrorFile = `${ws.mirrorDir}/${rec.relPath}`;
        await execRemoteSsh(
          ws.sshCreds,
          `rm -f '${targetMirrorFile.replace(/'/g, `'\\''`)}'`,
          { timeoutMs: 8000 }
        );
      } else {
        const localPath = path.join(ws.mirrorDir, rec.relPath);
        try {
          fs.lstatSync(localPath);
          fs.unlinkSync(localPath);
        } catch {
          // already removed
        }
      }
      ws.mirrorFiles.delete(rec.relPath);
    }

    const { configs, pendingDeletions } = buildWorkspaceConfigsResponse(ws);
    const certificates = refreshCertificateReferences(ws, configs);
    res.json({ ok: true, configs, pendingDeletions, certificates, status: buildStatusInfo(ws) });
  });

  function buildActiveSandboxConfigsForValidation(
    ws: WorkspaceState,
    override?: { filePath: string; content: string }
  ): Array<{ filePath: string; content: string }> {
    const active: Array<{ filePath: string; content: string }> = [];
    const seenPaths = new Set<string>();

    const getEntityContent = (targetPath: string): string | null => {
      if (override && override.filePath === targetPath) {
        return override.content;
      }
      const rel = toMirrorRelativePath(targetPath);
      const rec = ws.mirrorFiles.get(rel);
      if (rec && !rec.isSymlink) return rec.content;
      return null;
    };

    for (const rec of ws.mirrorFiles.values()) {
      if (!isFileMatchedByPatterns(rec.filePath, ws.nginxIncludePatterns)) continue;
      if (rec.isSymlink && rec.symlinkTarget) {
        const resolvedAbs = rec.symlinkTarget.startsWith('/')
          ? path.posix.normalize(rec.symlinkTarget)
          : path.posix.normalize(path.posix.join(path.posix.dirname(rec.filePath), rec.symlinkTarget));
        const content = getEntityContent(resolvedAbs);
        if (content !== null && !seenPaths.has(resolvedAbs)) {
          seenPaths.add(resolvedAbs);
          active.push({ filePath: resolvedAbs, content });
        }
      } else if (!rec.isSymlink) {
        const content = override && override.filePath === rec.filePath ? override.content : rec.content;
        if (!seenPaths.has(rec.filePath)) {
          seenPaths.add(rec.filePath);
          active.push({ filePath: rec.filePath, content });
        }
      }
    }

    return active;
  }

  app.post('/api/configs/preview', async (req, res) => {
    const ws = getWorkspaceFromReq(req);
    if (!ws) {
      res.status(401).json({ error: '会话已过期，请重新登录' });
      return;
    }
    const { form } = req.body as { form: NginxConfigForm };

    if (!form || !form.filename) {
      res.status(400).json({ error: '缺少配置表单数据' });
      return;
    }

    const relPath = toMirrorRelativePath(form.filePath);
    const existingMirror = ws.mirrorFiles.get(relPath);
    if (existingMirror?.isSymlink) {
      res.status(400).json({ error: '软链接不支持修改，请在主机上修改目标文件' });
      return;
    }

    const generatedConfig = generateNginxConfigFromForm(form);

    if (ws.session.connectionMode === 'ssh' && ws.sshCreds) {
      const testResult = await runRemoteMirrorNginxTest(
        ws.sshCreds,
        ws.mirrorDir,
        ws.nginxBin,
        getStagedCertPaths(ws),
        ws.nginxIncludePatterns,
        ws.extraConfigPaths,
        { relPath, content: generatedConfig }
      );
      res.json({
        ...testResult,
        generatedConfig,
      });
      return;
    }

    const activeConfigs = buildActiveSandboxConfigsForValidation(ws, {
      filePath: form.filePath,
      content: generatedConfig,
    });
    const testResult = validateMirrorConfigTree({
      mirrorDir: ws.mirrorDir,
      configs: activeConfigs,
      availableCertPaths: getAvailableCertPaths(ws),
    });

    if (testResult.valid) {
      const { errors } = parseNginxToAst(generatedConfig);
      if (errors.length > 0) {
        const err = errors[0];
        res.json({
          valid: false,
          command: testResult.command,
          output: `nginx: [emerg] ${err.message} in ${form.filePath}:${err.line}`,
          generatedConfig,
        });
        return;
      }
    }

    res.json({
      ...testResult,
      generatedConfig,
    });
  });

  app.post('/api/configs/save', async (req, res) => {
    const ws = getWorkspaceFromReq(req);
    if (!ws) {
      res.status(401).json({ error: '会话已过期，请重新登录' });
      return;
    }
    const { form, rawOverride } = req.body as {
      form: NginxConfigForm;
      rawOverride?: string;
    };

    if (!form || !form.filename) {
      res.status(400).json({ error: '缺少配置表单数据' });
      return;
    }

    const relPath = toMirrorRelativePath(form.filePath);
    const existingMirror = ws.mirrorFiles.get(relPath);
    if (existingMirror?.isSymlink) {
      res.status(400).json({ error: '软链接不支持修改，请在主机上修改目标文件' });
      return;
    }

    const generatedConfig =
      typeof rawOverride === 'string' && rawOverride.trim().length > 0
        ? rawOverride
        : generateNginxConfigFromForm(form);

    if (ws.session.connectionMode === 'ssh' && ws.sshCreds) {
      const astCheck = parseNginxToAst(generatedConfig);
      if (astCheck.errors.length > 0) {
        const err = astCheck.errors[0];
        res.status(400).json({
          error: '语法校验未通过，无法保存',
          testResult: {
            valid: false,
            command: `sudo nginx -t -c ${ws.mirrorDir}/nginx.conf`,
            output: `nginx: [emerg] ${err.message} in ${form.filePath}:${err.line}`,
          },
          generatedConfig,
        });
        return;
      }

      const testResult = await runRemoteMirrorNginxTest(
        ws.sshCreds,
        ws.mirrorDir,
        ws.nginxBin,
        getStagedCertPaths(ws),
        ws.nginxIncludePatterns,
        ws.extraConfigPaths,
        { relPath, content: generatedConfig }
      );

      if (!testResult.valid) {
        res.status(400).json({
          error: '语法校验未通过，无法保存',
          testResult,
          generatedConfig,
        });
        return;
      }

      const writeRes = await sftpWriteFile(
        ws.sshCreds,
        `${ws.mirrorDir}/${relPath}`,
        generatedConfig
      );
      if (!writeRes.ok) {
        res.status(500).json({ error: `写入远程镜像失败：${writeRes.error}` });
        return;
      }

      ws.mirrorFiles.set(relPath, {
        filename: form.filename,
        relPath,
        filePath: form.filePath,
        isSymlink: false,
        content: generatedConfig,
        updatedAt: new Date().toISOString(),
      });

      const ts = formatBackupTimestamp(new Date());
      const backupName = `${form.filename}-${ts}`;
      const newBackup: BackupRecord = {
        id: `bk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        backupName,
        filename: form.filename,
        filePath: form.filePath,
        content: generatedConfig,
        createdAt: new Date().toISOString(),
        isInitial: false,
        label: '手动保存备份',
      };
      ws.backups.unshift(newBackup);

      const { configs, pendingDeletions } = buildWorkspaceConfigsResponse(ws);
      const savedConfig = configs.find((c) => c.filePath === form.filePath);
      const certificates = refreshCertificateReferences(ws, configs);

      res.json({
        ok: true,
        testResult,
        savedConfig,
        backup: newBackup,
        configs,
        pendingDeletions,
        backups: ws.backups,
        certificates,
        status: buildStatusInfo(ws),
      });
      return;
    }

    // Sandbox mode
    const astCheck = parseNginxToAst(generatedConfig);
    if (astCheck.errors.length > 0) {
      const err = astCheck.errors[0];
      res.status(400).json({
        error: '语法校验未通过，无法保存',
        testResult: {
          valid: false,
          command: `sudo nginx -t -c ${ws.mirrorDir}/nginx.conf`,
          output: `nginx: [emerg] ${err.message} in ${form.filePath}:${err.line}`,
        },
        generatedConfig,
      });
      return;
    }

    const activeConfigs = buildActiveSandboxConfigsForValidation(ws, {
      filePath: form.filePath,
      content: generatedConfig,
    });

    const testResult = validateMirrorConfigTree({
      mirrorDir: ws.mirrorDir,
      configs: activeConfigs,
      availableCertPaths: getAvailableCertPaths(ws),
    });

    if (!testResult.valid) {
      res.status(400).json({
        error: '语法校验未通过，无法保存',
        testResult,
        generatedConfig,
      });
      return;
    }

    const mirrorFilePath = path.join(ws.mirrorDir, relPath);
    fs.mkdirSync(path.dirname(mirrorFilePath), { recursive: true });
    fs.writeFileSync(mirrorFilePath, generatedConfig, 'utf-8');

    ws.mirrorFiles.set(relPath, {
      filename: form.filename,
      relPath,
      filePath: form.filePath,
      isSymlink: false,
      content: generatedConfig,
      updatedAt: new Date().toISOString(),
    });

    const ts = formatBackupTimestamp(new Date());
    const backupName = `${form.filename}-${ts}`;
    const newBackup: BackupRecord = {
      id: `bk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      backupName,
      filename: form.filename,
      filePath: form.filePath,
      content: generatedConfig,
      createdAt: new Date().toISOString(),
      isInitial: false,
      label: '手动保存备份',
    };
    ws.backups.unshift(newBackup);

    const { configs, pendingDeletions } = buildWorkspaceConfigsResponse(ws);
    const savedConfig = configs.find((c) => c.filePath === form.filePath);
    const certificates = refreshCertificateReferences(ws, configs);

    res.json({
      ok: true,
      testResult,
      savedConfig,
      backup: newBackup,
      configs,
      pendingDeletions,
      backups: ws.backups,
      certificates,
      status: buildStatusInfo(ws),
    });
  });

  app.post('/api/configs/apply', async (req, res) => {
    const ws = getWorkspaceFromReq(req);
    if (!ws) {
      res.status(401).json({ error: '会话已过期，请重新登录' });
      return;
    }
    const { form } = req.body as { form?: NginxConfigForm };

    if (ws.session.connectionMode === 'ssh' && ws.sshCreds) {
      let fullTest: { valid: boolean; command: string; output: string };

      if (form && form.filename) {
        const relPath = toMirrorRelativePath(form.filePath);
        const existingMirror = ws.mirrorFiles.get(relPath);
        if (existingMirror?.isSymlink) {
          res.status(400).json({ error: '软链接不支持修改' });
          return;
        }
        const generatedConfig = generateNginxConfigFromForm(form);
        const preCheck = await runRemoteMirrorNginxTest(
          ws.sshCreds,
          ws.mirrorDir,
          ws.nginxBin,
          getStagedCertPaths(ws),
          ws.nginxIncludePatterns,
          ws.extraConfigPaths,
          { relPath, content: generatedConfig }
        );
        if (!preCheck.valid) {
          res.status(400).json({
            error: '语法校验未通过，线上配置未修改',
            testResult: preCheck,
          });
          return;
        }
        const writeRes = await sftpWriteFile(
          ws.sshCreds,
          `${ws.mirrorDir}/${relPath}`,
          generatedConfig
        );
        if (!writeRes.ok) {
          res.status(500).json({ error: `写入远程镜像失败：${writeRes.error}` });
          return;
        }
        ws.mirrorFiles.set(relPath, {
          filename: form.filename,
          relPath,
          filePath: form.filePath,
          isSymlink: false,
          content: generatedConfig,
          updatedAt: new Date().toISOString(),
        });
        fullTest = preCheck;
      } else {
        fullTest = await runRemoteMirrorNginxTest(
          ws.sshCreds,
          ws.mirrorDir,
          ws.nginxBin,
          getStagedCertPaths(ws),
          ws.nginxIncludePatterns,
          ws.extraConfigPaths
        );
        if (!fullTest.valid) {
          res.status(400).json({
            error: '语法校验未通过，线上配置未修改',
            testResult: fullTest,
          });
          return;
        }
      }

      const { pendingDeletions } = buildWorkspaceConfigsResponse(ws);
      const stagedCerts: CertificateRecord[] = [];
      const deletedCerts: CertificateRecord[] = [];
      for (const c of ws.certificates.values()) {
        if (c.syncStatus === 'staged') stagedCerts.push(c);
        else if (c.syncStatus === 'deleted') deletedCerts.push(c);
      }

      const applyRes = await applyRemoteMirrorToLive(
        ws.sshCreds,
        ws.mirrorDir,
        ws.nginxBin,
        {
          mirrorFiles: Array.from(ws.mirrorFiles.values()).map((m) => ({
            relPath: m.relPath,
            filePath: m.filePath,
            isSymlink: m.isSymlink,
            symlinkTarget: m.symlinkTarget,
          })),
          pendingDeletions: pendingDeletions.map((d) => ({ filePath: d.filePath })),
          stagedCerts,
          deletedCerts,
        }
      );

      if (!applyRes.ok) {
        res.status(400).json({
          error: `生效或重载失败：${applyRes.output}`,
          testResult: { ...fullTest, valid: false, output: applyRes.output },
        });
        return;
      }

      ws.liveFiles = new Map();
      for (const [k, v] of ws.mirrorFiles.entries()) {
        ws.liveFiles.set(k, { ...v });
      }
      for (const [cid, cert] of ws.certificates.entries()) {
        if (cert.syncStatus === 'deleted') {
          ws.certificates.delete(cid);
          ws.liveCertificates.delete(cid);
        } else {
          cert.syncStatus = 'synced';
          ws.liveCertificates.set(cid, { ...cert });
        }
      }

      const nowIso = new Date().toISOString();
      ws.lastReloadAt = nowIso;
      ws.lastCommandOutput = applyRes.output;

      const { configs, pendingDeletions: nextDel } = buildWorkspaceConfigsResponse(ws);
      const certificates = refreshCertificateReferences(ws, configs);

      res.json({
        ok: true,
        testResult: fullTest,
        configs,
        pendingDeletions: nextDel,
        certificates,
        lastReloadAt: ws.lastReloadAt,
        status: buildStatusInfo(ws),
      });
      return;
    }

    // Sandbox apply
    if (form && form.filename) {
      const relPath = toMirrorRelativePath(form.filePath);
      const existingMirror = ws.mirrorFiles.get(relPath);
      if (existingMirror?.isSymlink) {
        res.status(400).json({ error: '软链接不支持修改' });
        return;
      }

      const generatedConfig = generateNginxConfigFromForm(form);
      const mirrorFilePath = path.join(ws.mirrorDir, relPath);

      const activeCheckSet = buildActiveSandboxConfigsForValidation(ws, {
        filePath: form.filePath,
        content: generatedConfig,
      });

      const preCheck = validateMirrorConfigTree({
        mirrorDir: ws.mirrorDir,
        configs: activeCheckSet,
        availableCertPaths: getAvailableCertPaths(ws),
      });

      if (!preCheck.valid) {
        res.status(400).json({
          error: '语法校验未通过，线上配置未修改',
          testResult: preCheck,
        });
        return;
      }

      fs.mkdirSync(path.dirname(mirrorFilePath), { recursive: true });
      fs.writeFileSync(mirrorFilePath, generatedConfig, 'utf-8');
      ws.mirrorFiles.set(relPath, {
        filename: form.filename,
        relPath,
        filePath: form.filePath,
        isSymlink: false,
        content: generatedConfig,
        updatedAt: new Date().toISOString(),
      });
    }

    const activeMirrorConfigs = buildActiveSandboxConfigsForValidation(ws);
    const testResult = validateMirrorConfigTree({
      mirrorDir: ws.mirrorDir,
      configs: activeMirrorConfigs,
      availableCertPaths: getAvailableCertPaths(ws),
    });

    if (!testResult.valid) {
      res.status(400).json({
        error: '语法校验未通过，线上配置未修改',
        testResult,
      });
      return;
    }

    for (const sub of ['conf.d', 'sites-enabled', 'sites-available', 'ssl']) {
      const srcSub = path.join(ws.mirrorDir, sub);
      const dstSub = path.join(ws.targetEtcNginxDir, sub);
      fs.rmSync(dstSub, { recursive: true, force: true });
      if (fs.existsSync(srcSub)) {
        fs.cpSync(srcSub, dstSub, { recursive: true, verbatimSymlinks: true });
      } else {
        fs.mkdirSync(dstSub, { recursive: true });
      }
    }

    ws.liveFiles = new Map();
    for (const [k, v] of ws.mirrorFiles.entries()) {
      ws.liveFiles.set(k, { ...v });
    }

    for (const [cid, cert] of ws.certificates.entries()) {
      if (cert.syncStatus === 'deleted') {
        ws.certificates.delete(cid);
        ws.liveCertificates.delete(cid);
      } else {
        cert.syncStatus = 'synced';
        ws.liveCertificates.set(cid, { ...cert });
      }
    }

    const nowIso = new Date().toISOString();
    ws.running = true;
    ws.lastReloadAt = nowIso;

    const { configs, pendingDeletions } = buildWorkspaceConfigsResponse(ws);
    const certificates = refreshCertificateReferences(ws, configs);

    res.json({
      ok: true,
      testResult,
      configs,
      pendingDeletions,
      certificates,
      lastReloadAt: ws.lastReloadAt,
      status: buildStatusInfo(ws),
    });
  });

  // 4. Backups Module
  app.get('/api/backups', (req, res) => {
    const ws = getWorkspaceFromReq(req);
    if (!ws) {
      res.status(401).json({ error: '会话已过期，请重新登录' });
      return;
    }
    res.json({ backups: ws.backups });
  });

  app.delete('/api/backups/:id', (req, res) => {
    const ws = getWorkspaceFromReq(req);
    if (!ws) {
      res.status(401).json({ error: '会话已过期，请重新登录' });
      return;
    }
    const id = req.params.id;
    const idx = ws.backups.findIndex((b) => b.id === id);
    if (idx === -1) {
      res.status(404).json({ error: '未找到对应的备份记录' });
      return;
    }
    ws.backups.splice(idx, 1);
    res.json({ ok: true, backups: ws.backups });
  });

  app.post('/api/backups/:id/load', async (req, res) => {
    const ws = getWorkspaceFromReq(req);
    if (!ws) {
      res.status(401).json({ error: '会话已过期，请重新登录' });
      return;
    }
    const id = req.params.id;
    const backup = ws.backups.find((b) => b.id === id);
    if (!backup) {
      res.status(404).json({ error: '未找到指定的历史备份' });
      return;
    }

    const relPath = toMirrorRelativePath(backup.filePath);
    if (ws.session.connectionMode === 'ssh' && ws.sshCreds) {
      const writeRes = await sftpWriteFile(
        ws.sshCreds,
        `${ws.mirrorDir}/${relPath}`,
        backup.content
      );
      if (!writeRes.ok) {
        res.status(500).json({ error: `加载备份到远程镜像失败：${writeRes.error}` });
        return;
      }
    } else {
      const mirrorFilePath = path.join(ws.mirrorDir, relPath);
      fs.mkdirSync(path.dirname(mirrorFilePath), { recursive: true });
      fs.writeFileSync(mirrorFilePath, backup.content, 'utf-8');
    }

    ws.mirrorFiles.set(relPath, {
      filename: backup.filename,
      relPath,
      filePath: backup.filePath,
      isSymlink: false,
      content: backup.content,
      updatedAt: new Date().toISOString(),
    });

    const { configs, pendingDeletions } = buildWorkspaceConfigsResponse(ws);
    const loadedConfig = configs.find((c) => c.filePath === backup.filePath);
    const certificates = refreshCertificateReferences(ws, configs);

    res.json({
      ok: true,
      loadedConfig,
      configs,
      pendingDeletions,
      certificates,
      status: buildStatusInfo(ws),
    });
  });

  // 5. Certificates Module
  app.get('/api/certificates', (req, res) => {
    const ws = getWorkspaceFromReq(req);
    if (!ws) {
      res.status(401).json({ error: '会话已过期，请重新登录' });
      return;
    }
    const { configs } = buildWorkspaceConfigsResponse(ws);
    const certificates = refreshCertificateReferences(ws, configs);
    res.json({ certificates });
  });

  app.post('/api/certificates', async (req, res) => {
    const ws = getWorkspaceFromReq(req);
    if (!ws) {
      res.status(401).json({ error: '会话已过期，请重新登录' });
      return;
    }
    const { name, domains, expiresAt, certContent, keyContent } = req.body || {};

    if (!name || !String(name).trim()) {
      res.status(400).json({ error: '请输入证书名称' });
      return;
    }
    if (!certContent || !String(certContent).includes('BEGIN CERTIFICATE')) {
      res.status(400).json({ error: '公钥证书内容无效，需包含 -----BEGIN CERTIFICATE-----' });
      return;
    }
    if (!keyContent || !String(keyContent).includes('PRIVATE KEY')) {
      res.status(400).json({ error: '私钥内容无效，需包含 PRIVATE KEY 标识' });
      return;
    }

    const cleanBase = String(name)
      .trim()
      .replace(/\.(crt|pem|key)$/i, '')
      .replace(/[^a-zA-Z0-9._-]/g, '_');

    const certFilename = `${cleanBase}.crt`;
    const keyFilename = `${cleanBase}.key`;
    const certPath = `/etc/nginx/ssl/${certFilename}`;
    const keyPath = `/etc/nginx/ssl/${keyFilename}`;
    const certText = String(certContent).trim() + '\n';
    const keyText = String(keyContent).trim() + '\n';

    if (ws.session.connectionMode === 'ssh' && ws.sshCreds) {
      let [w1, w2] = await Promise.all([
        sftpWriteFile(ws.sshCreds, `${ws.mirrorDir}/ssl/${certFilename}`, certText),
        sftpWriteFile(ws.sshCreds, `${ws.mirrorDir}/ssl/${keyFilename}`, keyText),
      ]);
      if (!w1.ok || !w2.ok) {
        await execRemoteSsh(ws.sshCreds, `mkdir -p '${ws.mirrorDir}/ssl'`, { timeoutMs: 5000 });
        [w1, w2] = await Promise.all([
          sftpWriteFile(ws.sshCreds, `${ws.mirrorDir}/ssl/${certFilename}`, certText),
          sftpWriteFile(ws.sshCreds, `${ws.mirrorDir}/ssl/${keyFilename}`, keyText),
        ]);
      }
      if (!w1.ok || !w2.ok) {
        res.status(500).json({ error: `写入远程镜像证书失败：${w1.error || w2.error}` });
        return;
      }
    } else {
      const mirrorSslDir = path.join(ws.mirrorDir, 'ssl');
      fs.mkdirSync(mirrorSslDir, { recursive: true });
      fs.writeFileSync(path.join(mirrorSslDir, certFilename), certText, 'utf-8');
      fs.writeFileSync(path.join(mirrorSslDir, keyFilename), keyText, 'utf-8');
    }

    let parsedDomains: string[] =
      Array.isArray(domains) && domains.length > 0 ? domains : [cleanBase];
    let parsedIssuer = 'Custom Imported Authority';
    let parsedExpiry = expiresAt || '2027-12-31';

    try {
      const x509 = new crypto.X509Certificate(String(certContent));
      if (x509.subject) {
        const cnMatch = x509.subject.match(/CN=([^\n,]+)/);
        if (cnMatch?.[1]) parsedDomains = [cnMatch[1].trim()];
      }
      if (x509.issuer) {
        const issMatch =
          x509.issuer.match(/CN=([^\n,]+)/) || x509.issuer.match(/O=([^\n,]+)/);
        if (issMatch?.[1]) parsedIssuer = issMatch[1].trim();
      }
      if (x509.validTo) {
        const d = new Date(x509.validTo);
        if (!isNaN(d.getTime())) parsedExpiry = d.toISOString().slice(0, 10);
      }
    } catch {
      // Fallback
    }

    const existingId = Array.from(ws.certificates.values()).find(
      (c) => c.certPath === certPath
    )?.id;

    const id = existingId || `cert-${Date.now()}`;
    const record: CertificateRecord = {
      id,
      name: cleanBase,
      certFilename,
      keyFilename,
      certPath,
      keyPath,
      domains: parsedDomains,
      issuer: parsedIssuer,
      expiresAt: parsedExpiry,
      certContent: String(certContent).trim(),
      keyContent: String(keyContent).trim(),
      syncStatus: 'staged',
      referencedBy: [],
      updatedAt: new Date().toISOString(),
    };

    ws.certificates.set(id, record);

    const { configs } = buildWorkspaceConfigsResponse(ws);
    const certificates = refreshCertificateReferences(ws, configs);
    res.json({ ok: true, certificate: record, certificates, status: buildStatusInfo(ws) });
  });

  app.delete('/api/certificates/:id', async (req, res) => {
    const ws = getWorkspaceFromReq(req);
    if (!ws) {
      res.status(401).json({ error: '会话已过期，请重新登录' });
      return;
    }
    const id = req.params.id;
    const force = req.query.force === 'true';

    const cert = ws.certificates.get(id);
    if (!cert) {
      res.status(404).json({ error: '未找到该证书记录' });
      return;
    }

    const { configs } = buildWorkspaceConfigsResponse(ws);
    refreshCertificateReferences(ws, configs);

    if (cert.referencedBy.length > 0 && !force) {
      res.status(409).json({
        error: `该证书正被镜像配置 [${cert.referencedBy.join(', ')}] 引用`,
        referencedBy: cert.referencedBy,
        requiresConfirmation: true,
      });
      return;
    }

    if (ws.session.connectionMode === 'ssh' && ws.sshCreds) {
      await execRemoteSsh(
        ws.sshCreds,
        `rm -f '${ws.mirrorDir}/ssl/${cert.certFilename}' '${ws.mirrorDir}/ssl/${cert.keyFilename}'`,
        { timeoutMs: 8000 }
      );
    } else {
      const mirrorCertFile = path.join(ws.mirrorDir, 'ssl', cert.certFilename);
      const mirrorKeyFile = path.join(ws.mirrorDir, 'ssl', cert.keyFilename);
      if (fs.existsSync(mirrorCertFile)) fs.unlinkSync(mirrorCertFile);
      if (fs.existsSync(mirrorKeyFile)) fs.unlinkSync(mirrorKeyFile);
    }

    if (ws.liveCertificates.has(id)) {
      cert.syncStatus = 'deleted';
    } else {
      ws.certificates.delete(id);
    }

    const certificates = refreshCertificateReferences(ws, configs);
    res.json({ ok: true, certificates, status: buildStatusInfo(ws) });
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API route not found' });
  });

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = Number(process.env.PORT) || 1111;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Nginx Visual Config Manager running on http://localhost:${PORT}`);
  });
}

startServer();
