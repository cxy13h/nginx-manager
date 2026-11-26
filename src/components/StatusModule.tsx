import React, { useState } from 'react';
import { RefreshCw, RotateCcw, CheckCircle2, XCircle, Plus, X } from 'lucide-react';
import { NginxStatusInfo } from '../types';

interface StatusModuleProps {
  status: NginxStatusInfo | null;
  onControlService: (action: 'reload' | 'restart') => Promise<{ ok: boolean; error?: string }>;
  onUpdateExtraPaths: (paths: string[]) => Promise<{ ok: boolean; error?: string }>;
}

export const StatusModule: React.FC<StatusModuleProps> = ({
  status,
  onControlService,
  onUpdateExtraPaths,
}) => {
  const [busyAction, setBusyAction] = useState<'reload' | 'restart' | null>(null);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null
  );
  const [newPathInput, setNewPathInput] = useState('');
  const [savingPaths, setSavingPaths] = useState(false);

  if (!status) {
    return (
      <div className="p-8 bg-white border border-slate-200 rounded-xl text-sm text-slate-500">
        加载中...
      </div>
    );
  }

  const handleControl = async (action: 'reload' | 'restart') => {
    setBusyAction(action);
    setNotice(null);
    try {
      const res = await onControlService(action);
      if (res.ok) {
        setNotice({
          type: 'success',
          text: action === 'reload' ? '已执行 Reload' : '已执行 Restart',
        });
      } else {
        setNotice({
          type: 'error',
          text: res.error || '执行失败',
        });
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleAddExtraPath = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newPathInput.trim();
    if (!trimmed) return;
    const current = status.extraConfigPaths || [];
    if (current.includes(trimmed)) {
      setNewPathInput('');
      return;
    }
    setSavingPaths(true);
    setNotice(null);
    try {
      const res = await onUpdateExtraPaths([...current, trimmed]);
      if (res.ok) {
        setNewPathInput('');
        setNotice({ type: 'success', text: '已更新额外加载路径' });
      } else {
        setNotice({ type: 'error', text: res.error || '更新路径失败' });
      }
    } finally {
      setSavingPaths(false);
    }
  };

  const handleRemoveExtraPath = async (targetPath: string) => {
    const current = status.extraConfigPaths || [];
    const next = current.filter((p) => p !== targetPath);
    setSavingPaths(true);
    setNotice(null);
    try {
      const res = await onUpdateExtraPaths(next);
      if (res.ok) {
        setNotice({ type: 'success', text: '已更新额外加载路径' });
      } else {
        setNotice({ type: 'error', text: res.error || '更新路径失败' });
      }
    } finally {
      setSavingPaths(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="bg-white border border-slate-200 rounded-xl px-6 py-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-semibold text-slate-900">运行状态</h2>
          {notice && (
            <span
              className={`text-xs font-medium ${
                notice.type === 'success' ? 'text-emerald-700' : 'text-red-600'
              }`}
            >
              {notice.text}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => handleControl('reload')}
            className="px-3.5 py-2 text-xs font-medium text-slate-900 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${busyAction === 'reload' ? 'animate-spin' : ''}`} />
            <span>重载 Reload</span>
          </button>

          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => handleControl('restart')}
            className="px-3.5 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RotateCcw className={`w-3.5 h-3.5 ${busyAction === 'restart' ? 'animate-spin' : ''}`} />
            <span>重启 Restart</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs text-slate-500 mb-2">服务状态</div>
          <div className="flex items-center gap-2">
            {status.running ? (
              <>
                <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                <span className="text-base font-semibold text-emerald-700">
                  运行中 Running
                </span>
              </>
            ) : (
              <>
                <XCircle className="w-5 h-5 text-red-600 shrink-0" />
                <span className="text-base font-semibold text-red-700">
                  已停止 Stopped
                </span>
              </>
            )}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs text-slate-500 mb-2">Nginx 版本</div>
          <div className="text-base font-semibold font-mono tabular-nums text-slate-900">
            {status.version}
          </div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200 text-sm">
        <div className="px-6 py-4 flex items-center justify-between gap-4">
          <span className="text-xs text-slate-600">主配置文件路径</span>
          <code className="font-mono text-xs text-slate-900">
            {status.mainConfigPath}
          </code>
        </div>

        <div className="px-6 py-4 flex items-center justify-between gap-4">
          <span className="text-xs text-slate-600 shrink-0">配置加载目录路径</span>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {status.configDirs.length === 0 ? (
              <span className="text-xs text-slate-400">-</span>
            ) : (
              status.configDirs.map((dir) => (
                <code
                  key={dir}
                  className="font-mono text-xs text-slate-900 bg-slate-50 px-2 py-0.5 rounded border border-slate-200"
                >
                  {dir}
                </code>
              ))
            )}
          </div>
        </div>

        <div className="px-6 py-4 space-y-3">
          <div className="flex items-center justify-between gap-4">
            <label htmlFor="extra-managed-path-input" className="text-xs text-slate-600 shrink-0">
              管理界面额外加载的目录路径
            </label>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {(status.extraConfigPaths || []).map((dir) => (
                <span
                  key={dir}
                  className="inline-flex items-center gap-1.5 font-mono text-xs text-slate-900 bg-slate-50 pl-2.5 pr-1.5 py-0.5 rounded border border-slate-200"
                >
                  <span>{dir}</span>
                  <button
                    type="button"
                    disabled={savingPaths}
                    onClick={() => handleRemoveExtraPath(dir)}
                    aria-label={`移除路径 ${dir}`}
                    className="text-slate-400 hover:text-red-600 disabled:opacity-50 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </span>
              ))}
            </div>
          </div>

          <form onSubmit={handleAddExtraPath} className="flex items-center gap-2 justify-end">
            <input
              id="extra-managed-path-input"
              type="text"
              value={newPathInput}
              onChange={(e) => setNewPathInput(e.target.value)}
              placeholder="/etc/nginx/sites-available/*"
              className="w-full sm:w-80 px-3 py-1.5 text-xs font-mono bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-slate-900"
            />
            <button
              type="submit"
              disabled={savingPaths || !newPathInput.trim()}
              className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>添加路径</span>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
