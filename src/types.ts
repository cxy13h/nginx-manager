import type {
  NginxConfigForm,
  ConfigSyncStatus,
  NginxTestResult,
} from './utils/nginxParser.ts';

export interface SessionInfo {
  sessionId: string;
  host: string;
  port: number;
  username: string;
  osType: string;
  connectionMode: 'ssh' | 'sandbox';
  mirrorDir: string;
  connectedAt: string;
}

export interface NginxStatusInfo {
  running: boolean;
  version: string;
  osType: string;
  mainConfigPath: string;
  configDirs: string[]; // Actual include paths parsed from nginx.conf
  extraConfigPaths: string[]; // Extra managed directory paths configured in Status UI
  availableDirectories: string[]; // All base directories selectable when adding a config
  mirrorDir: string;
  pid: number;
  uptime: string;
  lastReloadAt: string;
  pendingConfigChanges: number;
  pendingCertChanges: number;
  lastCommandOutput?: string;
}

export interface ConfigItem {
  filename: string;
  filePath: string;
  isSymlink: boolean;
  symlinkTarget?: string;
  listenPorts: string[];
  serverName: string; // "-" if empty
  syncStatus: ConfigSyncStatus;
  rawContent: string;
  liveRawContent: string | null; // null if new and not yet on live target
  form: NginxConfigForm;
  updatedAt: string;
}

export interface PendingDeletionItem {
  filename: string;
  filePath: string;
  deletedAt: string;
}

export interface BackupRecord {
  id: string;
  backupName: string; // e.g. "api.conf-20261116143022"
  filename: string; // e.g. "api.conf"
  filePath: string;
  content: string;
  createdAt: string;
  isInitial: boolean;
  label: string; // "初始源配置" | "手动保存备份"
}

export interface CertificateRecord {
  id: string;
  name: string; // e.g. "api.internal.io"
  certFilename: string; // e.g. "api.internal.io.crt"
  keyFilename: string; // e.g. "api.internal.io.key"
  certPath: string; // e.g. "/etc/nginx/ssl/api.internal.io.crt"
  keyPath: string; // e.g. "/etc/nginx/ssl/api.internal.io.key"
  domains: string[];
  issuer: string;
  expiresAt: string;
  certContent: string;
  keyContent: string;
  syncStatus: 'synced' | 'staged' | 'deleted';
  referencedBy: string[]; // config filenames referencing this cert
  updatedAt: string;
}

export interface PreviewResponse extends NginxTestResult {
  generatedConfig: string;
}
