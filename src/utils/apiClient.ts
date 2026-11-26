import {
  SessionInfo,
  NginxStatusInfo,
  ConfigItem,
  PendingDeletionItem,
  BackupRecord,
  CertificateRecord,
  PreviewResponse,
} from '../types';
import { NginxConfigForm } from './nginxParser';

async function tryJsonFetch<T>(
  url: string,
  options?: RequestInit
): Promise<{ ok: boolean; status: number; data: T } | null> {
  try {
    const res = await fetch(url, options);
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return null;
    }
    const data = (await res.json()) as T;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return null;
  }
}

export async function apiGetSession(
  sessionId = 'demo01'
): Promise<{ session: SessionInfo } | null> {
  const remote = await tryJsonFetch<{ session: SessionInfo }>(
    `/api/session?sessionId=${encodeURIComponent(sessionId)}`
  );
  if (remote && remote.ok) {
    return remote.data;
  }
  return null;
}

export interface WorkspacePatch {
  status?: NginxStatusInfo;
  configs?: ConfigItem[];
  pendingDeletions?: PendingDeletionItem[];
  backups?: BackupRecord[];
  certificates?: CertificateRecord[];
}

export async function apiLogin(params: {
  host: string;
  port: number;
  username: string;
  password: string;
}): Promise<
  {
    ok: boolean;
    error?: string;
    session?: SessionInfo;
  } & WorkspacePatch
> {
  if (!params.host.trim() || !params.username.trim() || !params.password.trim()) {
    return {
      ok: false,
      error: '请填写完整的主机 IP、用户名和密码',
    };
  }

  const remote = await tryJsonFetch<{
    error?: string;
    session: SessionInfo;
    status?: NginxStatusInfo;
    configs: ConfigItem[];
    pendingDeletions: PendingDeletionItem[];
    backups: BackupRecord[];
    certificates: CertificateRecord[];
  }>('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!remote) {
    return {
      ok: false,
      error: '后端服务未就绪或未返回有效的 JSON 响应，请检查服务端是否正常运行',
    };
  }

  if (!remote.ok) {
    return { ok: false, error: remote.data.error || 'SSH 连接失败' };
  }

  return {
    ok: true,
    session: remote.data.session,
    status: remote.data.status,
    configs: remote.data.configs,
    pendingDeletions: remote.data.pendingDeletions,
    backups: remote.data.backups,
    certificates: remote.data.certificates,
  };
}

export async function apiLogout(sessionId: string): Promise<void> {
  await tryJsonFetch('/api/auth/logout', {
    method: 'POST',
    headers: { 'x-session-id': sessionId },
  });
}

export async function apiFetchStatus(sessionId: string): Promise<NginxStatusInfo | null> {
  const remote = await tryJsonFetch<NginxStatusInfo>('/api/status', {
    headers: { 'x-session-id': sessionId },
  });
  return remote && remote.ok ? remote.data : null;
}

export async function apiFetchWorkspaceData(sessionId: string): Promise<{
  status: NginxStatusInfo | null;
  configs: ConfigItem[];
  pendingDeletions: PendingDeletionItem[];
  backups: BackupRecord[];
  certificates: CertificateRecord[];
}> {
  const headers = { 'x-session-id': sessionId };
  const [statusRes, configsRes, backupsRes, certsRes] = await Promise.all([
    tryJsonFetch<NginxStatusInfo>('/api/status', { headers }),
    tryJsonFetch<{ configs: ConfigItem[]; pendingDeletions: PendingDeletionItem[] }>(
      '/api/configs',
      { headers }
    ),
    tryJsonFetch<{ backups: BackupRecord[] }>('/api/backups', { headers }),
    tryJsonFetch<{ certificates: CertificateRecord[] }>('/api/certificates', { headers }),
  ]);

  return {
    status: statusRes?.ok ? statusRes.data : null,
    configs: configsRes?.ok ? configsRes.data.configs || [] : [],
    pendingDeletions: configsRes?.ok ? configsRes.data.pendingDeletions || [] : [],
    backups: backupsRes?.ok ? backupsRes.data.backups || [] : [],
    certificates: certsRes?.ok ? certsRes.data.certificates || [] : [],
  };
}

export async function apiControlService(
  sessionId: string,
  action: 'reload' | 'restart'
): Promise<{ ok: boolean; error?: string; status?: NginxStatusInfo }> {
  const remote = await tryJsonFetch<{
    ok?: boolean;
    error?: string;
    status?: NginxStatusInfo;
  }>('/api/status/control', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
    },
    body: JSON.stringify({ action }),
  });

  if (!remote) {
    return { ok: false, error: '服务控制请求失败，请检查后端连接' };
  }
  if (!remote.ok) {
    return { ok: false, error: remote.data.error || '服务控制执行失败' };
  }
  return { ok: true, status: remote.data.status };
}

export async function apiUpdateExtraPaths(
  sessionId: string,
  extraConfigPaths: string[]
): Promise<{
  ok: boolean;
  error?: string;
  status?: NginxStatusInfo;
  configs?: ConfigItem[];
  pendingDeletions?: PendingDeletionItem[];
  certificates?: CertificateRecord[];
}> {
  const remote = await tryJsonFetch<{
    ok?: boolean;
    error?: string;
    status?: NginxStatusInfo;
    configs?: ConfigItem[];
    pendingDeletions?: PendingDeletionItem[];
    certificates?: CertificateRecord[];
  }>('/api/status/extra-paths', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
    },
    body: JSON.stringify({ extraConfigPaths }),
  });

  if (!remote) {
    return { ok: false, error: '无法连接后端服务' };
  }
  if (!remote.ok) {
    return { ok: false, error: remote.data.error || '更新额外加载路径失败' };
  }
  return {
    ok: true,
    status: remote.data.status,
    configs: remote.data.configs,
    pendingDeletions: remote.data.pendingDeletions,
    certificates: remote.data.certificates,
  };
}

export async function apiCreateConfig(
  sessionId: string,
  payload: {
    entryType: 'regular' | 'symlink';
    filename: string;
    directory: string;
    symlinkTarget?: string;
  }
): Promise<{ created?: ConfigItem; error?: string } & WorkspacePatch> {
  const remote = await tryJsonFetch<
    {
      created?: ConfigItem;
      error?: string;
    } & WorkspacePatch
  >('/api/configs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
    },
    body: JSON.stringify(payload),
  });

  if (!remote) {
    return { error: '无法连接后端服务' };
  }
  if (!remote.ok) {
    return { error: remote.data.error || '创建配置失败' };
  }
  return {
    created: remote.data.created,
    configs: remote.data.configs,
    pendingDeletions: remote.data.pendingDeletions,
    status: remote.data.status,
  };
}

export async function apiDeleteConfig(
  sessionId: string,
  filename: string,
  filePath?: string
): Promise<WorkspacePatch | null> {
  const query = filePath ? `?filePath=${encodeURIComponent(filePath)}` : '';
  const remote = await tryJsonFetch<WorkspacePatch>(
    `/api/configs/${encodeURIComponent(filename)}${query}`,
    {
      method: 'DELETE',
      headers: { 'x-session-id': sessionId },
    }
  );
  return remote && remote.ok ? remote.data : null;
}

export async function apiPreviewConfig(
  sessionId: string,
  form: NginxConfigForm
): Promise<PreviewResponse> {
  const remote = await tryJsonFetch<PreviewResponse>('/api/configs/preview', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
    },
    body: JSON.stringify({ form }),
  });

  if (remote && remote.data && typeof remote.data.generatedConfig === 'string') {
    return remote.data;
  }

  return {
    valid: false,
    command: 'sudo nginx -t',
    output: '无法连接后端执行校验',
    generatedConfig: '',
  };
}

export async function apiSaveConfig(
  sessionId: string,
  form: NginxConfigForm
): Promise<{ ok: boolean; message?: string; error?: string } & WorkspacePatch> {
  const remote = await tryJsonFetch<
    {
      ok?: boolean;
      error?: string;
      backup?: BackupRecord;
      testResult?: { output?: string };
    } & WorkspacePatch
  >('/api/configs/save', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
    },
    body: JSON.stringify({ form }),
  });

  if (!remote) {
    return { ok: false, error: '无法连接后端服务' };
  }
  if (!remote.ok) {
    const detail = remote.data.testResult?.output
      ? `\n${remote.data.testResult.output}`
      : '';
    return { ok: false, error: `${remote.data.error || '保存失败'}${detail}` };
  }
  return {
    ok: true,
    message: `已保存并生成备份 ${remote.data.backup?.backupName || ''}`,
    configs: remote.data.configs,
    pendingDeletions: remote.data.pendingDeletions,
    backups: remote.data.backups,
    certificates: remote.data.certificates,
    status: remote.data.status,
  };
}

export async function apiApplyAll(
  sessionId: string,
  form?: NginxConfigForm
): Promise<{ ok: boolean; message?: string; error?: string } & WorkspacePatch> {
  const remote = await tryJsonFetch<
    {
      ok?: boolean;
      error?: string;
      testResult?: { output?: string };
    } & WorkspacePatch
  >('/api/configs/apply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
    },
    body: JSON.stringify({ form }),
  });

  if (!remote) {
    return { ok: false, error: '无法连接后端服务' };
  }
  if (!remote.ok) {
    const detail = remote.data.testResult?.output
      ? `\n${remote.data.testResult.output}`
      : '';
    return { ok: false, error: `${remote.data.error || '生效失败'}${detail}` };
  }
  return {
    ok: true,
    message: '已生效并重载 Nginx',
    configs: remote.data.configs,
    pendingDeletions: remote.data.pendingDeletions,
    certificates: remote.data.certificates,
    status: remote.data.status,
  };
}

export async function apiLoadBackup(
  sessionId: string,
  backupId: string
): Promise<{ loadedConfig: ConfigItem | null } & WorkspacePatch> {
  const remote = await tryJsonFetch<{ loadedConfig?: ConfigItem } & WorkspacePatch>(
    `/api/backups/${encodeURIComponent(backupId)}/load`,
    {
      method: 'POST',
      headers: { 'x-session-id': sessionId },
    }
  );
  if (!remote || !remote.ok) {
    return { loadedConfig: null };
  }
  return {
    loadedConfig: remote.data.loadedConfig || null,
    configs: remote.data.configs,
    pendingDeletions: remote.data.pendingDeletions,
    certificates: remote.data.certificates,
    status: remote.data.status,
  };
}

export async function apiDeleteBackup(
  sessionId: string,
  backupId: string
): Promise<WorkspacePatch | null> {
  const remote = await tryJsonFetch<WorkspacePatch>(
    `/api/backups/${encodeURIComponent(backupId)}`,
    {
      method: 'DELETE',
      headers: { 'x-session-id': sessionId },
    }
  );
  return remote && remote.ok ? remote.data : null;
}

export async function apiAddCertificate(
  sessionId: string,
  payload: {
    name: string;
    domains: string[];
    expiresAt: string;
    certContent: string;
    keyContent: string;
  }
): Promise<{ ok: boolean; error?: string } & WorkspacePatch> {
  const remote = await tryJsonFetch<{ error?: string } & WorkspacePatch>(
    '/api/certificates',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': sessionId,
      },
      body: JSON.stringify(payload),
    }
  );

  if (!remote) {
    return { ok: false, error: '无法连接后端服务' };
  }
  if (!remote.ok) {
    return { ok: false, error: remote.data.error || '保存证书失败' };
  }
  return {
    ok: true,
    certificates: remote.data.certificates,
    status: remote.data.status,
  };
}

export async function apiDeleteCertificate(
  sessionId: string,
  id: string,
  force = false
): Promise<
  {
    ok: boolean;
    error?: string;
    requiresConfirmation?: boolean;
    referencedBy?: string[];
  } & WorkspacePatch
> {
  const remote = await tryJsonFetch<
    {
      error?: string;
      requiresConfirmation?: boolean;
      referencedBy?: string[];
    } & WorkspacePatch
  >(`/api/certificates/${encodeURIComponent(id)}?force=${force ? 'true' : 'false'}`, {
    method: 'DELETE',
    headers: { 'x-session-id': sessionId },
  });

  if (!remote) {
    return { ok: false, error: '无法连接后端服务' };
  }
  if (!remote.ok) {
    return {
      ok: false,
      error: remote.data.error,
      requiresConfirmation: remote.data.requiresConfirmation,
      referencedBy: remote.data.referencedBy,
    };
  }
  return {
    ok: true,
    certificates: remote.data.certificates,
    status: remote.data.status,
  };
}
