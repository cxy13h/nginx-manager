import { useState, useEffect, useCallback } from 'react';
import {
  Activity,
  FileSliders,
  Archive,
  ShieldCheck,
  LogOut,
  Terminal,
} from 'lucide-react';
import {
  SessionInfo,
  NginxStatusInfo,
  ConfigItem,
  PendingDeletionItem,
  BackupRecord,
  CertificateRecord,
  PreviewResponse,
} from './types';
import { NginxConfigForm } from './utils/nginxParser';
import {
  apiGetSession,
  apiLogin,
  apiLogout,
  apiFetchStatus,
  apiFetchWorkspaceData,
  apiControlService,
  apiUpdateExtraPaths,
  apiCreateConfig,
  apiDeleteConfig,
  apiPreviewConfig,
  apiSaveConfig,
  apiApplyAll,
  apiLoadBackup,
  apiDeleteBackup,
  apiAddCertificate,
  apiDeleteCertificate,
  type WorkspacePatch,
} from './utils/apiClient';
import { LoginView } from './components/LoginView';
import { StatusModule } from './components/StatusModule';
import { ConfigsModule } from './components/ConfigsModule';
import { BackupsModule } from './components/BackupsModule';
import { CertificatesModule } from './components/CertificatesModule';

type NavTab = 'status' | 'configs' | 'backups' | 'certificates';

export default function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<NavTab>('configs');

  const [statusInfo, setStatusInfo] = useState<NginxStatusInfo | null>(null);
  const [configs, setConfigs] = useState<ConfigItem[]>([]);
  const [pendingDeletions, setPendingDeletions] = useState<PendingDeletionItem[]>([]);
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [certificates, setCertificates] = useState<CertificateRecord[]>([]);

  const applyWorkspacePatch = useCallback((patch?: WorkspacePatch | null) => {
    if (!patch) return;
    if (patch.status) setStatusInfo(patch.status);
    if (patch.configs) setConfigs(patch.configs);
    if (patch.pendingDeletions) setPendingDeletions(patch.pendingDeletions);
    if (patch.backups) setBackups(patch.backups);
    if (patch.certificates) setCertificates(patch.certificates);
  }, []);

  const fetchAllWorkspaceData = useCallback(async (sid: string) => {
    const data = await apiFetchWorkspaceData(sid);
    setStatusInfo(data.status);
    setConfigs(data.configs);
    setPendingDeletions(data.pendingDeletions);
    setBackups(data.backups);
    setCertificates(data.certificates);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('autostart') === '1') {
      (async () => {
        const data = await apiGetSession('demo01');
        if (data?.session) {
          setSession(data.session);
          await fetchAllWorkspaceData(data.session.sessionId);
        }
      })();
    }
  }, [fetchAllWorkspaceData]);

  // Refresh live remote Nginx status on demand when switching to the Status tab
  useEffect(() => {
    if (!session || activeTab !== 'status') return;
    let cancelled = false;
    apiFetchStatus(session.sessionId).then((st) => {
      if (!cancelled && st) setStatusInfo(st);
    });
    return () => {
      cancelled = true;
    };
  }, [activeTab, session]);

  const handleLogin = async (params: {
    host: string;
    port: number;
    username: string;
    password: string;
  }) => {
    setLoginLoading(true);
    setLoginError(null);
    try {
      const data = await apiLogin(params);
      if (!data.ok || !data.session) {
        setLoginError(data.error || 'SSH 连接失败');
        return;
      }
      setSession(data.session);
      setStatusInfo(data.status || null);
      setConfigs(data.configs || []);
      setPendingDeletions(data.pendingDeletions || []);
      setBackups(data.backups || []);
      setCertificates(data.certificates || []);
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : '网络请求异常');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    if (session) {
      void apiLogout(session.sessionId);
    }
    setSession(null);
    setStatusInfo(null);
  };

  const handleControlService = async (
    action: 'reload' | 'restart'
  ): Promise<{ ok: boolean; error?: string }> => {
    if (!session) return { ok: false, error: '未登录' };
    const res = await apiControlService(session.sessionId, action);
    if (res.ok && res.status) {
      setStatusInfo(res.status);
    }
    return { ok: res.ok, error: res.error };
  };

  const handleUpdateExtraPaths = async (
    extraConfigPaths: string[]
  ): Promise<{ ok: boolean; error?: string }> => {
    if (!session) return { ok: false, error: '未登录' };
    const res = await apiUpdateExtraPaths(session.sessionId, extraConfigPaths);
    if (res.ok) {
      applyWorkspacePatch(res);
      return { ok: true };
    }
    return { ok: false, error: res.error };
  };

  const handleCreateConfig = async (payload: {
    entryType: 'regular' | 'symlink';
    filename: string;
    directory: string;
    symlinkTarget?: string;
  }): Promise<{ created?: ConfigItem; error?: string }> => {
    if (!session) return { error: '未建立连接' };
    const res = await apiCreateConfig(session.sessionId, payload);
    if (res.error) {
      return { error: res.error };
    }
    applyWorkspacePatch(res);
    return { created: res.created };
  };

  const handleDeleteConfig = async (filename: string, filePath?: string) => {
    if (!session) return;
    const patch = await apiDeleteConfig(session.sessionId, filename, filePath);
    applyWorkspacePatch(patch);
  };

  const handlePreviewConfig = async (
    form: NginxConfigForm
  ): Promise<PreviewResponse> => {
    return await apiPreviewConfig(session?.sessionId || 'demo01', form);
  };

  const handleSaveConfig = async (
    form: NginxConfigForm
  ): Promise<{ ok: boolean; message?: string; error?: string }> => {
    if (!session) return { ok: false, error: '未登录' };
    const res = await apiSaveConfig(session.sessionId, form);
    if (res.ok) {
      applyWorkspacePatch(res);
    }
    return { ok: res.ok, message: res.message, error: res.error };
  };

  const handleApplyAll = async (
    form?: NginxConfigForm
  ): Promise<{ ok: boolean; message?: string; error?: string }> => {
    if (!session) return { ok: false, error: '未登录' };
    const res = await apiApplyAll(session.sessionId, form);
    if (res.ok) {
      applyWorkspacePatch(res);
    }
    return { ok: res.ok, message: res.message, error: res.error };
  };

  const handleLoadBackup = async (backupId: string): Promise<ConfigItem | null> => {
    if (!session) return null;
    const res = await apiLoadBackup(session.sessionId, backupId);
    applyWorkspacePatch(res);
    return res.loadedConfig;
  };

  const handleDeleteBackup = async (backupId: string) => {
    if (!session) return;
    const patch = await apiDeleteBackup(session.sessionId, backupId);
    applyWorkspacePatch(patch);
  };

  const handleAddCertificate = async (payload: {
    name: string;
    domains: string[];
    expiresAt: string;
    certContent: string;
    keyContent: string;
  }): Promise<{ ok: boolean; error?: string }> => {
    if (!session) return { ok: false, error: '未登录' };
    const res = await apiAddCertificate(session.sessionId, payload);
    if (res.ok) {
      applyWorkspacePatch(res);
    }
    return { ok: res.ok, error: res.error };
  };

  const handleDeleteCertificate = async (
    id: string,
    force = false
  ): Promise<{
    ok: boolean;
    error?: string;
    requiresConfirmation?: boolean;
    referencedBy?: string[];
  }> => {
    if (!session) return { ok: false, error: '未登录' };
    const res = await apiDeleteCertificate(session.sessionId, id, force);
    if (res.ok) {
      applyWorkspacePatch(res);
    }
    return {
      ok: res.ok,
      error: res.error,
      requiresConfirmation: res.requiresConfirmation,
      referencedBy: res.referencedBy,
    };
  };

  if (!session) {
    return (
      <LoginView
        onLogin={handleLogin}
        loading={loginLoading}
        error={loginError}
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* 顶部状态栏: 主机 IP | 当前用户名 | 操作系统类型 */}
      <header className="sticky top-0 z-30 h-14 bg-white border-b border-slate-200 px-6 flex items-center justify-between gap-6">
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="w-7 h-7 rounded-md bg-slate-900 text-white flex items-center justify-center">
            <Terminal className="w-4 h-4" />
          </div>
          <span className="text-sm font-semibold tracking-tight text-slate-900 whitespace-nowrap">
            Nginx 配置管理器
          </span>
        </div>

        <div
          aria-label="当前主机连接信息"
          className="flex items-center gap-3 text-xs font-mono text-slate-700 overflow-x-auto whitespace-nowrap"
        >
          <span>{session.host}</span>
          <span className="text-slate-300">|</span>
          <span>{session.username}</span>
          <span className="text-slate-300">|</span>
          <span>{session.osType}</span>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={handleLogout}
            className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>退出</span>
          </button>
        </div>
      </header>

      {/* 主体布局 */}
      <div className="flex-1 flex flex-col md:flex-row">
        <aside className="w-full md:w-52 bg-white border-b md:border-b-0 md:border-r border-slate-200 shrink-0">
          <nav aria-label="主导航栏" className="p-3 flex md:flex-col gap-1 overflow-x-auto">
            <button
              type="button"
              onClick={() => setActiveTab('status')}
              className={`w-full px-3.5 py-2.5 rounded-lg text-xs font-medium flex items-center gap-2.5 transition-colors whitespace-nowrap cursor-pointer ${
                activeTab === 'status'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              <Activity className="w-4 h-4" />
              <span>状态</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('configs')}
              className={`w-full px-3.5 py-2.5 rounded-lg text-xs font-medium flex items-center justify-between transition-colors whitespace-nowrap cursor-pointer ${
                activeTab === 'configs'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <FileSliders className="w-4 h-4" />
                <span>配置</span>
              </span>
              <span
                className={`text-xs font-mono tabular-nums ${
                  activeTab === 'configs' ? 'text-slate-300' : 'text-slate-400'
                }`}
              >
                {configs.length}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('backups')}
              className={`w-full px-3.5 py-2.5 rounded-lg text-xs font-medium flex items-center justify-between transition-colors whitespace-nowrap cursor-pointer ${
                activeTab === 'backups'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Archive className="w-4 h-4" />
                <span>备份</span>
              </span>
              <span
                className={`text-xs font-mono tabular-nums ${
                  activeTab === 'backups' ? 'text-slate-300' : 'text-slate-400'
                }`}
              >
                {backups.length}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('certificates')}
              className={`w-full px-3.5 py-2.5 rounded-lg text-xs font-medium flex items-center justify-between transition-colors whitespace-nowrap cursor-pointer ${
                activeTab === 'certificates'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <ShieldCheck className="w-4 h-4" />
                <span>证书</span>
              </span>
              <span
                className={`text-xs font-mono tabular-nums ${
                  activeTab === 'certificates' ? 'text-slate-300' : 'text-slate-400'
                }`}
              >
                {certificates.length}
              </span>
            </button>
          </nav>
        </aside>

        <main className="flex-1 p-6 max-w-6xl w-full mx-auto">
          {activeTab === 'status' && (
            <StatusModule
              status={statusInfo}
              onControlService={handleControlService}
              onUpdateExtraPaths={handleUpdateExtraPaths}
            />
          )}

          {activeTab === 'configs' && (
            <ConfigsModule
              configs={configs}
              pendingDeletions={pendingDeletions}
              availableDirectories={
                statusInfo?.availableDirectories || [
                  '/etc/nginx/conf.d',
                  '/etc/nginx/sites-enabled',
                  '/etc/nginx/sites-available',
                ]
              }
              backups={backups}
              certificates={certificates}
              onCreateConfig={handleCreateConfig}
              onDeleteConfig={handleDeleteConfig}
              onPreviewConfig={handlePreviewConfig}
              onSaveConfig={handleSaveConfig}
              onApplyAll={handleApplyAll}
              onLoadBackup={handleLoadBackup}
            />
          )}

          {activeTab === 'backups' && (
            <BackupsModule
              backups={backups}
              onDeleteBackup={handleDeleteBackup}
              onRestoreBackupToMirror={async (id) => {
                await handleLoadBackup(id);
              }}
            />
          )}

          {activeTab === 'certificates' && (
            <CertificatesModule
              certificates={certificates}
              onAddCertificate={handleAddCertificate}
              onDeleteCertificate={handleDeleteCertificate}
              onApplyAll={() => handleApplyAll()}
            />
          )}
        </main>
      </div>
    </div>
  );
}
