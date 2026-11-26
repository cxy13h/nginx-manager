import { Client as SshClient, type SFTPWrapper } from 'ssh2';
import path from 'path';
import crypto from 'crypto';
import type { CertificateRecord } from '../types.ts';
import {
  DEFAULT_EXTRA_CONFIG_PATHS,
  extractIncludePathsFromNginxConf,
  patternToFileGlob,
  toMirrorRelativePath,
  patternToBaseDir,
} from '../utils/pathHelpers.ts';

export interface SshCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface ExecResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  connectionError?: string;
}

export interface RemoteScannedFile {
  filename: string;
  relPath: string; // relative path inside mirrorDir (e.g. "conf.d/api.conf", "sites-available/minimal-chat")
  filePath: string; // remote path (e.g. "/etc/nginx/sites-enabled/minimal-chat")
  isSymlink: boolean;
  symlinkTarget?: string; // target from readlink if isSymlink
  content: string;
  mtime: string;
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function escapeSedPattern(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeSedReplacement(str: string): string {
  return str.replace(/[\\|&]/g, '\\$&');
}

interface PooledSshEntry {
  client: SshClient;
  ready: boolean;
  sftp?: SFTPWrapper;
  sftpPromise?: Promise<SFTPWrapper>;
  idleTimer?: ReturnType<typeof setTimeout>;
}

const SSH_POOL_IDLE_MS = 5 * 60 * 1000;
const sshPool = new Map<string, PooledSshEntry>();
const sshConnecting = new Map<string, Promise<PooledSshEntry>>();

export function buildSshPoolKey(creds: SshCredentials): string {
  return crypto
    .createHash('sha256')
    .update(`${creds.host}\0${creds.port}\0${creds.username}\0${creds.password}`)
    .digest('hex');
}

function evictPooledEntry(key: string, target?: PooledSshEntry) {
  const existing = sshPool.get(key);
  if (!existing || (target && existing !== target)) return;
  existing.ready = false;
  if (existing.idleTimer) {
    clearTimeout(existing.idleTimer);
    existing.idleTimer = undefined;
  }
  sshPool.delete(key);
  try {
    existing.sftp?.end();
  } catch {
    // ignore
  }
  try {
    existing.client.end();
  } catch {
    // ignore
  }
}

function touchPooledEntry(key: string, entry: PooledSshEntry) {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    evictPooledEntry(key, entry);
  }, SSH_POOL_IDLE_MS);
  entry.idleTimer.unref?.();
}

export function closePooledSshConnection(creds?: SshCredentials) {
  if (!creds) return;
  const key = buildSshPoolKey(creds);
  evictPooledEntry(key);
}

function acquirePooledConnection(
  creds: SshCredentials,
  timeoutMs: number
): Promise<PooledSshEntry> {
  const key = buildSshPoolKey(creds);
  const existing = sshPool.get(key);
  if (existing && existing.ready) {
    touchPooledEntry(key, existing);
    return Promise.resolve(existing);
  }

  const inflight = sshConnecting.get(key);
  if (inflight) {
    return inflight;
  }

  const connectPromise = new Promise<PooledSshEntry>((resolve, reject) => {
    const client = new SshClient();
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          client.end();
        } catch {
          // ignore
        }
        reject(new Error('SSH 连接超时，请检查主机 IP、端口或防火墙设置'));
      }
    }, timeoutMs);

    client
      .on('ready', () => {
        if (settled) {
          try {
            client.end();
          } catch {
            // ignore
          }
          return;
        }
        settled = true;
        clearTimeout(timer);
        const entry: PooledSshEntry = { client, ready: true };
        sshPool.set(key, entry);
        touchPooledEntry(key, entry);

        const cleanup = () => evictPooledEntry(key, entry);
        client.on('close', cleanup);
        client.on('end', cleanup);
        client.on('error', cleanup);

        resolve(entry);
      })
      .on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      })
      .connect({
        host: creds.host,
        port: creds.port,
        username: creds.username,
        password: creds.password,
        readyTimeout: timeoutMs,
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
      });
  });

  sshConnecting.set(key, connectPromise);
  connectPromise.finally(() => {
    if (sshConnecting.get(key) === connectPromise) {
      sshConnecting.delete(key);
    }
  });

  return connectPromise;
}

function acquirePooledSftp(
  key: string,
  entry: PooledSshEntry
): Promise<SFTPWrapper> {
  if (entry.sftp) return Promise.resolve(entry.sftp);
  if (entry.sftpPromise) return entry.sftpPromise;

  const p = new Promise<SFTPWrapper>((resolve, reject) => {
    entry.client.sftp((err, sftp) => {
      if (err) {
        entry.sftpPromise = undefined;
        reject(err);
        return;
      }
      entry.sftp = sftp;
      sftp.on('close', () => {
        if (entry.sftp === sftp) {
          entry.sftp = undefined;
          entry.sftpPromise = undefined;
        }
      });
      sftp.on('error', () => {
        if (entry.sftp === sftp) {
          entry.sftp = undefined;
          entry.sftpPromise = undefined;
        }
      });
      touchPooledEntry(key, entry);
      resolve(sftp);
    });
  });

  entry.sftpPromise = p;
  return p;
}

function execOnEntry(
  key: string,
  entry: PooledSshEntry,
  finalCommand: string,
  sudoPassword: string | null,
  timeoutMs: number
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({
          ok: false,
          code: -1,
          stdout: '',
          stderr: 'SSH 命令执行超时',
          connectionError: 'SSH 命令执行超时',
        });
      }
    }, timeoutMs);

    entry.client.exec(finalCommand, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
        return;
      }

      let stdout = '';
      let stderr = '';

      if (sudoPassword !== null) {
        stream.write(`${sudoPassword}\n`);
      }

      stream
        .on('error', (streamErr: Error) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(streamErr);
          }
        })
        .on('close', (code: number | null) => {
          clearTimeout(timer);
          touchPooledEntry(key, entry);
          if (!settled) {
            settled = true;
            resolve({
              ok: code === 0,
              code: code ?? 0,
              stdout,
              stderr,
            });
          }
        })
        .on('data', (data: Buffer) => {
          stdout += data.toString('utf-8');
        })
        .stderr.on('data', (data: Buffer) => {
          stderr += data.toString('utf-8');
        });
    });
  });
}

export async function execRemoteSsh(
  creds: SshCredentials,
  command: string,
  options?: { useSudo?: boolean; timeoutMs?: number }
): Promise<ExecResult> {
  const timeoutMs = options?.timeoutMs ?? 15000;
  const useSudo = options?.useSudo ?? false;
  const needsSudoPrefix = useSudo && creds.username !== 'root';
  const finalCommand = needsSudoPrefix
    ? `sudo -S -p '' sh -c ${shellQuote(command)}`
    : command;
  const key = buildSshPoolKey(creds);

  for (let attempt = 0; attempt < 2; attempt++) {
    let entry: PooledSshEntry;
    try {
      entry = await acquirePooledConnection(creds, timeoutMs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        code: -1,
        stdout: '',
        stderr: msg,
        connectionError: msg,
      };
    }

    try {
      return await execOnEntry(
        key,
        entry,
        finalCommand,
        needsSudoPrefix ? creds.password : null,
        timeoutMs
      );
    } catch (err) {
      evictPooledEntry(key, entry);
      if (attempt === 1) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          code: -1,
          stdout: '',
          stderr: msg,
          connectionError: msg,
        };
      }
    }
  }

  return {
    ok: false,
    code: -1,
    stdout: '',
    stderr: 'SSH 执行失败',
    connectionError: 'SSH 执行失败',
  };
}

export async function sftpReadFile(
  creds: SshCredentials,
  remotePath: string,
  timeoutMs = 15000
): Promise<{ ok: boolean; content?: string; error?: string }> {
  const key = buildSshPoolKey(creds);

  for (let attempt = 0; attempt < 2; attempt++) {
    let entry: PooledSshEntry;
    try {
      entry = await acquirePooledConnection(creds, timeoutMs);
      const sftp = await acquirePooledSftp(key, entry);

      const content = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('SFTP 读取超时')), timeoutMs);
        sftp.readFile(remotePath, (readErr, data) => {
          clearTimeout(timer);
          if (readErr) {
            reject(readErr);
            return;
          }
          touchPooledEntry(key, entry);
          resolve(data.toString('utf-8'));
        });
      });

      return { ok: true, content };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Do not retry normal file-not-found or permission errors
      if (/no such file|permission denied|ENOENT|EACCES/i.test(msg)) {
        return { ok: false, error: msg };
      }
      evictPooledEntry(key);
      if (attempt === 1) {
        return { ok: false, error: msg };
      }
    }
  }

  return { ok: false, error: 'SFTP 读取失败' };
}

export async function sftpWriteFile(
  creds: SshCredentials,
  remotePath: string,
  content: string,
  timeoutMs = 15000
): Promise<{ ok: boolean; error?: string }> {
  const key = buildSshPoolKey(creds);

  for (let attempt = 0; attempt < 2; attempt++) {
    let entry: PooledSshEntry;
    try {
      entry = await acquirePooledConnection(creds, timeoutMs);
      const sftp = await acquirePooledSftp(key, entry);

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('SFTP 写入超时')), timeoutMs);
        sftp.writeFile(remotePath, Buffer.from(content, 'utf-8'), (writeErr) => {
          clearTimeout(timer);
          if (writeErr) {
            reject(writeErr);
            return;
          }
          touchPooledEntry(key, entry);
          resolve();
        });
      });

      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/permission denied|EACCES/i.test(msg)) {
        return { ok: false, error: msg };
      }
      evictPooledEntry(key);
      if (attempt === 1) {
        return { ok: false, error: msg };
      }
    }
  }

  return { ok: false, error: 'SFTP 写入失败' };
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

export function hasSudoGroupMembership(username: string, groupsOutput: string): boolean {
  if (username === 'root') return true;
  const groups = groupsOutput.trim().split(/\s+/).filter(Boolean);
  return groups.includes('sudo');
}

export function parseVerifyProbeOutput(
  username: string,
  stdout: string,
  stderr = ''
): {
  ok: boolean;
  osType?: string;
  nginxBin?: string;
  nginxVersion?: string;
  error?: string;
} {
  const osSec = stdout.split('---OS---')[1]?.split('---NGINX---')[0]?.trim() || '';
  const nginxSec = stdout.split('---NGINX---')[1]?.split('---GROUPS---')[0]?.trim() || '';
  const groupsSec = stdout.split('---GROUPS---')[1]?.split('---VERSION---')[0]?.trim() || '';
  const versionSec = (stdout.split('---VERSION---')[1] || '') + '\n' + stderr;

  let osType = 'Ubuntu Linux';
  const prettyMatch = osSec.match(/PRETTY_NAME="([^"]+)"/);
  if (prettyMatch?.[1]) {
    osType = prettyMatch[1];
  } else {
    const firstLine = osSec.split('\n')[0]?.trim();
    if (firstLine) osType = firstLine;
  }

  const nginxBin = nginxSec.split('\n')[0]?.trim() || '/usr/sbin/nginx';

  if (username !== 'root' && !hasSudoGroupMembership(username, groupsSec)) {
    return {
      ok: false,
      error: `用户 ${username} 不属于 sudo 组，请确认该用户具备 sudo 权限`,
    };
  }

  const verMatch = versionSec.match(/nginx\/([\d.]+)/);
  if (!verMatch) {
    return {
      ok: false,
      error: '目标主机未检测到可用的 Nginx，请先安装 Nginx',
    };
  }

  return {
    ok: true,
    osType,
    nginxBin,
    nginxVersion: verMatch[1],
  };
}

export async function verifyRemoteSshAndSudo(creds: SshCredentials): Promise<{
  ok: boolean;
  osType?: string;
  nginxBin?: string;
  nginxVersion?: string;
  error?: string;
}> {
  const probeCmd = `
echo "---OS---"
(grep PRETTY_NAME /etc/os-release 2>/dev/null || uname -sr)
echo "---NGINX---"
NGINX_BIN=$(command -v nginx 2>/dev/null || ls /usr/sbin/nginx 2>/dev/null || echo "/usr/sbin/nginx")
echo "$NGINX_BIN"
echo "---GROUPS---"
id -nG 2>/dev/null || true
echo "---VERSION---"
"$NGINX_BIN" -v 2>&1 || nginx -v 2>&1 || true
`;

  const probeRes = await execRemoteSsh(creds, probeCmd, {
    useSudo: false,
    timeoutMs: 12000,
  });

  if (!probeRes.ok) {
    const rawErr = probeRes.connectionError || probeRes.stderr || 'SSH 连接失败';
    if (/authentication/i.test(rawErr)) {
      return { ok: false, error: `SSH 认证失败：用户名或密码错误 (${rawErr})` };
    }
    if (/ECONNREFUSED/i.test(rawErr)) {
      return { ok: false, error: `SSH 连接被拒绝：请检查 ${creds.host}:${creds.port} 是否开放` };
    }
    return { ok: false, error: `SSH 连接失败：${rawErr}` };
  }

  return parseVerifyProbeOutput(creds.username, probeRes.stdout, probeRes.stderr);
}

export async function getRemoteStatus(
  creds: SshCredentials,
  nginxBin = 'nginx'
): Promise<{
  running: boolean;
  version: string;
  pid: number;
  uptime: string;
  mainConfigPath: string;
  configDirs: string[];
}> {
  const cmd = `
${shellQuote(nginxBin)} -v 2>&1 || nginx -v 2>&1
echo "===ACTIVE==="
(systemctl is-active nginx 2>/dev/null || (pgrep -x nginx >/dev/null && echo "active" || echo "inactive"))
echo "===PID==="
(pgrep -o -x nginx 2>/dev/null || echo "0")
echo "===UPTIME==="
PID_VAL=$(pgrep -o -x nginx 2>/dev/null || true)
if [ -n "$PID_VAL" ]; then ps -o etime= -p "$PID_VAL" 2>/dev/null | xargs; else echo "Stopped"; fi
echo "===NGINX_CONF==="
cat /etc/nginx/nginx.conf 2>/dev/null || true
`;

  const res = await execRemoteSsh(creds, cmd, { useSudo: false, timeoutMs: 10000 });
  const text = res.stdout + '\n' + res.stderr;
  const verMatch = text.match(/nginx\/([\d.]+)/);
  const version = verMatch?.[1] || 'unknown';

  const activeSec = res.stdout.split('===ACTIVE===')[1]?.split('===PID===')[0]?.trim() || '';
  const running = activeSec === 'active';

  const pidStr = res.stdout.split('===PID===')[1]?.split('===UPTIME===')[0]?.trim() || '0';
  const pid = Number(pidStr) || 0;

  const uptime =
    res.stdout.split('===UPTIME===')[1]?.split('===NGINX_CONF===')[0]?.trim() ||
    (running ? 'Running' : 'Stopped');

  const nginxConfRaw = res.stdout.split('===NGINX_CONF===')[1] || '';
  const configDirs = extractIncludePathsFromNginxConf(nginxConfRaw);

  return {
    running,
    version,
    pid: running ? pid : 0,
    uptime: running ? uptime : 'Stopped',
    mainConfigPath: '/etc/nginx/nginx.conf',
    configDirs,
  };
}

export async function controlRemoteNginx(
  creds: SshCredentials,
  action: 'reload' | 'restart' | 'start' | 'stop',
  nginxBin = 'nginx'
): Promise<{ ok: boolean; output: string }> {
  let cmd = '';
  if (action === 'reload') {
    cmd = `${shellQuote(nginxBin)} -t && (${shellQuote(nginxBin)} -s reload || systemctl reload nginx)`;
  } else if (action === 'restart') {
    cmd = `${shellQuote(nginxBin)} -t && systemctl restart nginx`;
  } else if (action === 'start') {
    cmd = `${shellQuote(nginxBin)} -t && systemctl start nginx`;
  } else if (action === 'stop') {
    cmd = `systemctl stop nginx || ${shellQuote(nginxBin)} -s stop`;
  }

  const res = await execRemoteSsh(creds, cmd, { useSudo: true, timeoutMs: 15000 });
  return {
    ok: res.ok,
    output: [res.stdout, res.stderr].filter(Boolean).join('\n').trim(),
  };
}

/**
 * Sync specified directory/glob patterns from remote host into remoteMirrorDir
 * (preserving symlinks with `cp -a`) and scan them, cleanly separating symlinks from regular files.
 */
export async function syncAndScanRemotePatterns(
  creds: SshCredentials,
  remoteMirrorDir: string,
  patterns: string[],
  options?: { syncFromHost?: boolean; skipExistingInMirror?: boolean }
): Promise<RemoteScannedFile[]> {
  const syncFromHost = options?.syncFromHost ?? true;
  const skipExisting = options?.skipExistingInMirror ?? false;

  const parsedGlobs: Array<{ baseDir: string; dirRel: string; glob: string }> = [];
  const syncedBaseDirs = new Set<string>();

  for (const pat of patterns) {
    const { baseDir, glob } = patternToFileGlob(pat);
    if (!baseDir) continue;
    const dirRel = toMirrorRelativePath(baseDir);
    if (!dirRel) continue;
    parsedGlobs.push({ baseDir, dirRel, glob });
  }

  if (syncFromHost && parsedGlobs.length > 0) {
    const copyCmds: string[] = [];
    for (const item of parsedGlobs) {
      if (syncedBaseDirs.has(item.baseDir)) continue;
      syncedBaseDirs.add(item.baseDir);
      const mirrorSub = `${remoteMirrorDir}/${item.dirRel}`;
      if (skipExisting) {
        copyCmds.push(
          `if [ -d ${shellQuote(item.baseDir)} ] && [ ! -d ${shellQuote(mirrorSub)} ]; then mkdir -p ${shellQuote(mirrorSub)} && cp -a ${shellQuote(item.baseDir)}/. ${shellQuote(mirrorSub)}/ 2>/dev/null || true; chown -hR ${shellQuote(creds.username)} ${shellQuote(mirrorSub)}; find ${shellQuote(mirrorSub)} ! -type l -exec chmod u+rwX {} + 2>/dev/null || true; fi`
        );
      } else {
        copyCmds.push(
          `if [ -d ${shellQuote(item.baseDir)} ]; then mkdir -p ${shellQuote(mirrorSub)} && cp -a ${shellQuote(item.baseDir)}/. ${shellQuote(mirrorSub)}/ 2>/dev/null || true; chown -hR ${shellQuote(creds.username)} ${shellQuote(mirrorSub)}; find ${shellQuote(mirrorSub)} ! -type l -exec chmod u+rwX {} + 2>/dev/null || true; fi`
        );
      }
    }
    if (copyCmds.length > 0) {
      await execRemoteSsh(creds, copyCmds.join('\n'), { useSudo: true, timeoutMs: 15000 });
    }
  }

  if (parsedGlobs.length === 0) return [];

  const scanCmds = parsedGlobs.map(({ baseDir, dirRel, glob }) => {
    const mirrorSub = `${remoteMirrorDir}/${dirRel}`;
    return `
if [ -d ${shellQuote(mirrorSub)} ]; then
  find ${shellQuote(mirrorSub)} -maxdepth 1 \\( -type f -o -type l \\) -name ${shellQuote(glob)} 2>/dev/null | sort | while IFS= read -r f; do
    BN=$(basename "$f")
    case "$BN" in
      .*|*.bak|*.swp|*~|*.dpkg-*) continue ;;
    esac
    MTIME=$(stat -c '%Y' "$f" 2>/dev/null || echo "0")
    if [ -L "$f" ]; then
      TGT=$(readlink "$f" 2>/dev/null || echo "")
      echo "SYMLINK::${dirRel}/$BN::${baseDir}/$BN::$TGT::$MTIME"
    elif [ -f "$f" ]; then
      echo "FILE::${dirRel}/$BN::${baseDir}/$BN::$MTIME"
    fi
  done
fi`;
  });

  const scanRes = await execRemoteSsh(creds, scanCmds.join('\n'), {
    useSudo: false,
    timeoutMs: 12000,
  });

  const symlinks: RemoteScannedFile[] = [];
  const entityTasks: Array<{ relPath: string; filePath: string; mtime: string }> = [];
  const seenFilePaths = new Set<string>();

  for (const line of scanRes.stdout.split('\n')) {
    if (line.startsWith('SYMLINK::')) {
      const parts = line.split('::');
      const relPath = parts[1];
      const filePath = parts[2];
      const symlinkTarget = parts[3] || '';
      const mtimeEpoch = Number(parts[4]) || Math.floor(Date.now() / 1000);
      if (!relPath || !filePath || seenFilePaths.has(filePath)) continue;
      seenFilePaths.add(filePath);

      symlinks.push({
        filename: path.posix.basename(relPath),
        relPath,
        filePath,
        isSymlink: true,
        symlinkTarget,
        content: '',
        mtime: new Date(mtimeEpoch * 1000).toISOString(),
      });
    } else if (line.startsWith('FILE::')) {
      const parts = line.split('::');
      const relPath = parts[1];
      const filePath = parts[2];
      const mtimeEpoch = Number(parts[3]) || Math.floor(Date.now() / 1000);
      if (!relPath || !filePath || seenFilePaths.has(filePath)) continue;
      seenFilePaths.add(filePath);

      entityTasks.push({
        relPath,
        filePath,
        mtime: new Date(mtimeEpoch * 1000).toISOString(),
      });
    }
  }

  const readEntities = await runWithConcurrency(entityTasks, 6, async (task) => {
    const readRes = await sftpReadFile(creds, `${remoteMirrorDir}/${task.relPath}`);
    if (readRes.ok && typeof readRes.content === 'string') {
      return {
        filename: path.posix.basename(task.relPath),
        relPath: task.relPath,
        filePath: task.filePath,
        isSymlink: false,
        content: readRes.content,
        mtime: task.mtime,
      } satisfies RemoteScannedFile;
    }
    return null;
  });

  const files: RemoteScannedFile[] = [...symlinks];
  for (const item of readEntities) {
    if (item) files.push(item);
  }

  return files;
}

export async function initializeRemoteMirrorAndScan(
  creds: SshCredentials,
  remoteMirrorDir: string,
  extraConfigPaths: string[] = DEFAULT_EXTRA_CONFIG_PATHS
): Promise<{
  ok: boolean;
  error?: string;
  mainNginxConf: string;
  nginxIncludePatterns: string[];
  files: RemoteScannedFile[];
  certs: CertificateRecord[];
}> {
  const setupCmd = `
rm -rf ${shellQuote(remoteMirrorDir)}
mkdir -p ${shellQuote(remoteMirrorDir)}/ssl
for item in nginx.conf mime.types fastcgi_params proxy_params uwsgi_params scgi_params modules-enabled snippets; do
  if [ -e "/etc/nginx/$item" ]; then
    cp -a "/etc/nginx/$item" ${shellQuote(remoteMirrorDir)}/
  fi
done
if [ -d /etc/nginx/ssl ]; then
  cp -a /etc/nginx/ssl/. ${shellQuote(remoteMirrorDir)}/ssl/ 2>/dev/null || true
fi
if [ -d /etc/nginx/certs ]; then
  mkdir -p ${shellQuote(remoteMirrorDir)}/certs
  cp -a /etc/nginx/certs/. ${shellQuote(remoteMirrorDir)}/certs/ 2>/dev/null || true
fi
chown -hR ${shellQuote(creds.username)} ${shellQuote(remoteMirrorDir)}
find ${shellQuote(remoteMirrorDir)} ! -type l -exec chmod u+rwX {} + 2>/dev/null || true
`;

  const setupRes = await execRemoteSsh(creds, setupCmd, { useSudo: true, timeoutMs: 20000 });
  if (!setupRes.ok) {
    return {
      ok: false,
      error: `初始化远程镜像失败：${setupRes.stderr || setupRes.stdout}`,
      mainNginxConf: '',
      nginxIncludePatterns: [],
      files: [],
      certs: [],
    };
  }

  const mainConfRes = await sftpReadFile(creds, `${remoteMirrorDir}/nginx.conf`);
  const mainNginxConf = mainConfRes.ok && mainConfRes.content ? mainConfRes.content : '';

  // Parse active includes directly from nginx.conf
  const nginxIncludePatterns = extractIncludePathsFromNginxConf(mainNginxConf);
  const allPatterns = [...nginxIncludePatterns, ...extraConfigPaths];

  const files = await syncAndScanRemotePatterns(creds, remoteMirrorDir, allPatterns, {
    syncFromHost: true,
    skipExistingInMirror: false,
  });

  // Scan SSL certs in /etc/nginx/ssl + referenced ssl_certificate directives in entity files
  const certs = await scanRemoteCertificates(
    creds,
    remoteMirrorDir,
    files.filter((f) => !f.isSymlink)
  );

  return {
    ok: true,
    mainNginxConf,
    nginxIncludePatterns,
    files,
    certs,
  };
}

function parseX509Details(pem: string, fallbackName: string): {
  domains: string[];
  issuer: string;
  expiresAt: string;
} {
  let domains = [fallbackName];
  let issuer = 'Unknown CA';
  let expiresAt = '-';

  try {
    const x509 = new crypto.X509Certificate(pem);
    if (x509.subjectAltName) {
      const sanDomains = x509.subjectAltName
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.startsWith('DNS:'))
        .map((s) => s.slice(4).trim());
      if (sanDomains.length > 0) domains = sanDomains;
    } else if (x509.subject) {
      const cnMatch = x509.subject.match(/CN=([^\n,]+)/);
      if (cnMatch?.[1]) domains = [cnMatch[1].trim()];
    }
    if (x509.issuer) {
      const issMatch = x509.issuer.match(/CN=([^\n,]+)/) || x509.issuer.match(/O=([^\n,]+)/);
      if (issMatch?.[1]) issuer = issMatch[1].trim();
    }
    if (x509.validTo) {
      const d = new Date(x509.validTo);
      if (!isNaN(d.getTime())) expiresAt = d.toISOString().slice(0, 10);
    }
  } catch {
    // keep fallback
  }

  return { domains, issuer, expiresAt };
}

async function scanRemoteCertificates(
  creds: SshCredentials,
  remoteMirrorDir: string,
  files: RemoteScannedFile[]
): Promise<CertificateRecord[]> {
  const pairMap = new Map<string, { certPath: string; keyPath: string; name: string }>();

  const sslListRes = await execRemoteSsh(
    creds,
    `for f in ${shellQuote(remoteMirrorDir)}/ssl/*.crt ${shellQuote(remoteMirrorDir)}/ssl/*.pem; do [ -f "$f" ] && basename "$f"; done 2>/dev/null || true`,
    { timeoutMs: 8000 }
  );

  for (const fname of sslListRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    const base = fname.replace(/\.(crt|pem)$/i, '');
    const certPath = `/etc/nginx/ssl/${fname}`;
    const keyPath = `/etc/nginx/ssl/${base}.key`;
    pairMap.set(certPath, { certPath, keyPath, name: base });
  }

  for (const file of files) {
    if (file.isSymlink) continue;
    const certMatches = file.content.matchAll(/ssl_certificate\s+([^;\s]+)\s*;/g);
    const keyMatches = Array.from(file.content.matchAll(/ssl_certificate_key\s+([^;\s]+)\s*;/g));
    let idx = 0;
    for (const cm of certMatches) {
      const cPath = cm[1]?.trim();
      const kPath = keyMatches[idx]?.[1]?.trim() || cPath.replace(/\.(crt|pem)$/i, '.key');
      idx++;
      if (cPath && !pairMap.has(cPath)) {
        const base = path.posix.basename(cPath).replace(/\.(crt|pem)$/i, '');
        pairMap.set(cPath, { certPath: cPath, keyPath: kPath, name: base });
      }
    }
  }

  const pairList = Array.from(pairMap.values());
  const readPair = async (item: { certPath: string; keyPath: string; name: string }) => {
    const mirrorCert = item.certPath.startsWith('/etc/nginx/')
      ? `${remoteMirrorDir}/${item.certPath.slice('/etc/nginx/'.length)}`
      : item.certPath;
    const mirrorKey = item.keyPath.startsWith('/etc/nginx/')
      ? `${remoteMirrorDir}/${item.keyPath.slice('/etc/nginx/'.length)}`
      : item.keyPath;

    const readViaSftpOrSudo = async (primaryPath: string, fallbackPath: string): Promise<string> => {
      const first = await sftpReadFile(creds, primaryPath, 8000);
      if (first.ok && first.content) return first.content.trim();
      if (fallbackPath !== primaryPath) {
        const second = await sftpReadFile(creds, fallbackPath, 8000);
        if (second.ok && second.content) return second.content.trim();
      }
      const sudoRead = await execRemoteSsh(
        creds,
        `cat ${shellQuote(primaryPath)} 2>/dev/null || cat ${shellQuote(fallbackPath)} 2>/dev/null || true`,
        { useSudo: true, timeoutMs: 8000 }
      );
      return sudoRead.stdout.trim();
    };

    const [certContent, keyContent] = await Promise.all([
      readViaSftpOrSudo(mirrorCert, item.certPath),
      readViaSftpOrSudo(mirrorKey, item.keyPath),
    ]);

    if (!certContent) return null;
    const meta = parseX509Details(certContent, item.name);
    return { item, certContent, keyContent, meta };
  };

  const resolvedPairs = await runWithConcurrency(pairList, 4, readPair);
  const certs: CertificateRecord[] = [];
  let cIdx = 1;

  for (const res of resolvedPairs) {
    if (!res) continue;
    const { item, certContent, keyContent, meta } = res;
    certs.push({
      id: `cert-remote-${cIdx++}`,
      name: item.name,
      certFilename: path.posix.basename(item.certPath),
      keyFilename: path.posix.basename(item.keyPath),
      certPath: item.certPath,
      keyPath: item.keyPath,
      domains: meta.domains,
      issuer: meta.issuer,
      expiresAt: meta.expiresAt,
      certContent,
      keyContent,
      syncStatus: 'synced',
      referencedBy: [],
      updatedAt: new Date().toISOString(),
    });
  }

  return certs;
}

export async function runRemoteMirrorNginxTest(
  creds: SshCredentials,
  remoteMirrorDir: string,
  nginxBin: string,
  stagedCertPaths: string[],
  nginxIncludePatterns: string[],
  extraConfigPaths: string[],
  override?: { relPath: string; content: string }
): Promise<{ valid: boolean; command: string; output: string }> {
  const testDir = `${remoteMirrorDir}_test_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
  const mainMirrorConf = `${remoteMirrorDir}/nginx.conf`;
  const displayCommand = `sudo nginx -t -c ${mainMirrorConf}`;

  try {
    // Build rewrite rules for nginx.conf
    const replacePairs: Array<[string, string]> = [];
    const seenFrom = new Set<string>();
    const addPair = (fromPath: string, toRel: string) => {
      if (!fromPath || seenFrom.has(fromPath)) return;
      seenFrom.add(fromPath);
      replacePairs.push([fromPath, `${testDir}/${toRel}`]);
    };

    for (const pat of [...nginxIncludePatterns, ...extraConfigPaths]) {
      const baseDir = patternToBaseDir(pat);
      if (baseDir) {
        addPair(baseDir, toMirrorRelativePath(baseDir));
      }
    }
    for (const std of [
      'conf.d',
      'sites-enabled',
      'sites-available',
      'mime.types',
      'fastcgi_params',
      'proxy_params',
      'uwsgi_params',
      'scgi_params',
      'snippets',
      'modules-enabled',
      'ssl',
      'certs',
    ]) {
      addPair(`/etc/nginx/${std}`, std);
    }

    const sedRules = replacePairs
      .map(([fromP, toP]) => `s|${escapeSedPattern(fromP)}|${escapeSedReplacement(toP)}|g`)
      .join('; ');

    const prepParts: string[] = [
      'set -e',
      `cp -a ${shellQuote(remoteMirrorDir)} ${shellQuote(testDir)}`,
    ];

    if (override) {
      const targetFile = `${testDir}/${override.relPath}`;
      prepParts.push(`mkdir -p ${shellQuote(path.posix.dirname(targetFile))}`);
    }

    if (sedRules) {
      prepParts.push(`sed -i ${shellQuote(sedRules)} ${shellQuote(`${testDir}/nginx.conf`)}`);
    }

    // Redirect absolute symlinks inside testDir to mirror targets when present in testDir
    prepParts.push(`
find ${shellQuote(testDir)} -type l | while IFS= read -r lnk; do
  tgt=$(readlink "$lnk" 2>/dev/null || echo "")
  case "$tgt" in
    /etc/nginx/*)
      rel="\${tgt#/etc/nginx/}"
      if [ -e "${testDir}/$rel" ]; then
        ln -sfn "${testDir}/$rel" "$lnk"
      fi
      ;;
    /*)
      rel="_ext/\${tgt#/}"
      if [ -e "${testDir}/$rel" ]; then
        ln -sfn "${testDir}/$rel" "$lnk"
      fi
      ;;
  esac
done`);

    const prepRes = await execRemoteSsh(creds, prepParts.join('\n'), {
      useSudo: false,
      timeoutMs: 12000,
    });
    if (!prepRes.ok) {
      return {
        valid: false,
        command: displayCommand,
        output: `准备临时校验目录失败：${prepRes.stderr}`,
      };
    }

    if (override) {
      const targetFile = `${testDir}/${override.relPath}`;
      const writeRes = await sftpWriteFile(creds, targetFile, override.content);
      if (!writeRes.ok) {
        return {
          valid: false,
          command: displayCommand,
          output: `写入临时校验文件失败：${writeRes.error}`,
        };
      }
    }

    if (stagedCertPaths.length > 0) {
      const sedExprs = stagedCertPaths
        .map(
          (p) =>
            `s|${escapeSedPattern(p)}|${escapeSedReplacement(`${testDir}/ssl/${path.posix.basename(p)}`)}|g`
        )
        .join('; ');
      await execRemoteSsh(
        creds,
        `find ${shellQuote(testDir)} -maxdepth 4 -type f -exec sed -i ${shellQuote(sedExprs)} {} +`,
        { useSudo: false, timeoutMs: 8000 }
      );
    }

    const testRes = await execRemoteSsh(
      creds,
      `${shellQuote(nginxBin)} -t -c ${shellQuote(`${testDir}/nginx.conf`)} 2>&1`,
      { useSudo: true, timeoutMs: 15000 }
    );

    const rawOut = [testRes.stdout, testRes.stderr].filter(Boolean).join('\n').trim();
    const normalizedOut = rawOut.split(testDir).join(remoteMirrorDir);

    return {
      valid: testRes.ok,
      command: displayCommand,
      output: normalizedOut || (testRes.ok ? 'syntax is ok' : 'nginx -t failed'),
    };
  } finally {
    // Non-blocking cleanup (testDir is owned by creds.username); avoids delaying response
    void execRemoteSsh(creds, `rm -rf ${shellQuote(testDir)}`, {
      useSudo: false,
      timeoutMs: 8000,
    });
  }
}

export async function applyRemoteMirrorToLive(
  creds: SshCredentials,
  remoteMirrorDir: string,
  nginxBin: string,
  params: {
    mirrorFiles: Array<{
      relPath: string;
      filePath: string;
      isSymlink: boolean;
      symlinkTarget?: string;
    }>;
    pendingDeletions: Array<{ filePath: string }>;
    stagedCerts: CertificateRecord[];
    deletedCerts: CertificateRecord[];
  }
): Promise<{ ok: boolean; output: string }> {
  const cmds: string[] = ['set -e'];

  // 1. Sync staged SSL certificates
  if (params.stagedCerts.length > 0) {
    cmds.push('mkdir -p /etc/nginx/ssl');
    for (const c of params.stagedCerts) {
      const mCert = `${remoteMirrorDir}/ssl/${c.certFilename}`;
      const mKey = `${remoteMirrorDir}/ssl/${c.keyFilename}`;
      cmds.push(
        `cp ${shellQuote(mCert)} ${shellQuote(c.certPath)} && chown root:root ${shellQuote(c.certPath)} && chmod 644 ${shellQuote(c.certPath)}`,
        `cp ${shellQuote(mKey)} ${shellQuote(c.keyPath)} && chown root:root ${shellQuote(c.keyPath)} && chmod 600 ${shellQuote(c.keyPath)}`
      );
    }
  }

  // 2. Remove deleted certs if requested
  for (const dc of params.deletedCerts) {
    cmds.push(`rm -f ${shellQuote(dc.certPath)} ${shellQuote(dc.keyPath)}`);
  }

  // 3. Remove deleted config files / symlinks
  for (const del of params.pendingDeletions) {
    cmds.push(`rm -f ${shellQuote(del.filePath)}`);
  }

  // 4. Sync entity files and symlinks to live target paths
  for (const f of params.mirrorFiles) {
    if (f.isSymlink && f.symlinkTarget) {
      cmds.push(
        `mkdir -p ${shellQuote(path.posix.dirname(f.filePath))}`,
        `ln -sfn ${shellQuote(f.symlinkTarget)} ${shellQuote(f.filePath)}`
      );
    } else if (!f.isSymlink) {
      const mirrorFile = `${remoteMirrorDir}/${f.relPath}`;
      cmds.push(
        `mkdir -p ${shellQuote(path.posix.dirname(f.filePath))}`,
        `cp ${shellQuote(mirrorFile)} ${shellQuote(f.filePath)} && chown root:root ${shellQuote(f.filePath)} && chmod 644 ${shellQuote(f.filePath)}`
      );
    }
  }

  // 5. Verify live nginx.conf and reload if running
  cmds.push(
    `${shellQuote(nginxBin)} -t`,
    `if pgrep -x nginx >/dev/null 2>&1; then (${shellQuote(nginxBin)} -s reload || systemctl reload nginx); fi`
  );

  const res = await execRemoteSsh(creds, cmds.join(' && '), {
    useSudo: true,
    timeoutMs: 25000,
  });

  return {
    ok: res.ok,
    output: [res.stdout, res.stderr].filter(Boolean).join('\n').trim(),
  };
}
