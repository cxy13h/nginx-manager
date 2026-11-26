import React, { useState } from 'react';
import {
  Plus,
  Rocket,
  Trash2,
  Edit3,
  X,
  CheckCircle2,
  AlertTriangle,
  Search,
  Link2,
  FileText,
} from 'lucide-react';
import {
  ConfigItem,
  PendingDeletionItem,
  BackupRecord,
  CertificateRecord,
  PreviewResponse,
} from '../types';
import { NginxConfigForm } from '../utils/nginxParser';
import { ConfigDetailEditor } from './ConfigDetailEditor';

interface ConfigsModuleProps {
  configs: ConfigItem[];
  pendingDeletions: PendingDeletionItem[];
  availableDirectories: string[];
  backups: BackupRecord[];
  certificates: CertificateRecord[];
  onCreateConfig: (payload: {
    entryType: 'regular' | 'symlink';
    filename: string;
    directory: string;
    symlinkTarget?: string;
  }) => Promise<{ created?: ConfigItem; error?: string }>;
  onDeleteConfig: (filename: string, filePath?: string) => Promise<void>;
  onPreviewConfig: (form: NginxConfigForm) => Promise<PreviewResponse>;
  onSaveConfig: (
    form: NginxConfigForm
  ) => Promise<{ ok: boolean; message?: string; error?: string }>;
  onApplyAll: (
    form?: NginxConfigForm
  ) => Promise<{ ok: boolean; message?: string; error?: string }>;
  onLoadBackup: (backupId: string) => Promise<ConfigItem | null>;
}

function pickDefaultDir(
  dirs: string[],
  entryType: 'regular' | 'symlink',
  filename: string
): string {
  if (dirs.length === 0) {
    return entryType === 'symlink' ? '/etc/nginx/sites-enabled' : '/etc/nginx/conf.d';
  }
  if (entryType === 'symlink') {
    return dirs.find((d) => d.endsWith('/sites-enabled')) || dirs[0];
  }
  if (filename.trim().endsWith('.conf')) {
    return dirs.find((d) => d.endsWith('/conf.d')) || dirs[0];
  }
  return dirs.find((d) => d.endsWith('/sites-available')) || dirs[0];
}

export const ConfigsModule: React.FC<ConfigsModuleProps> = ({
  configs,
  pendingDeletions,
  availableDirectories,
  backups,
  certificates,
  onCreateConfig,
  onDeleteConfig,
  onPreviewConfig,
  onSaveConfig,
  onApplyAll,
  onLoadBackup,
}) => {
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newEntryType, setNewEntryType] = useState<'regular' | 'symlink'>('regular');
  const [newFilename, setNewFilename] = useState('');
  const [newDirectory, setNewDirectory] = useState<string>('/etc/nginx/conf.d');
  const [dirManuallyChanged, setDirManuallyChanged] = useState(false);
  const [newSymlinkTarget, setNewSymlinkTarget] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<{
    filename: string;
    filePath: string;
    isSymlink: boolean;
  } | null>(null);
  const [applyingAll, setApplyingAll] = useState(false);
  const [listMessage, setListMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const selectedConfig =
    configs.find((c) => !c.isSymlink && c.filePath === selectedFilePath) || null;

  if (selectedConfig) {
    return (
      <ConfigDetailEditor
        config={selectedConfig}
        backups={backups}
        certificates={certificates}
        onBack={() => setSelectedFilePath(null)}
        onPreview={onPreviewConfig}
        onSave={onSaveConfig}
        onApply={onApplyAll}
        onLoadBackup={onLoadBackup}
        onDeleteConfig={async (fname) => {
          await onDeleteConfig(fname, selectedConfig.filePath);
          setSelectedFilePath(null);
        }}
      />
    );
  }

  const allEntityConfigs = configs.filter((c) => !c.isSymlink);
  const allSymlinkConfigs = configs.filter((c) => c.isSymlink);

  const q = searchQuery.trim().toLowerCase();
  const filteredEntities = allEntityConfigs.filter(
    (cfg) =>
      !q ||
      cfg.filename.toLowerCase().includes(q) ||
      cfg.filePath.toLowerCase().includes(q)
  );

  const filteredSymlinks = allSymlinkConfigs.filter(
    (cfg) =>
      !q ||
      cfg.filename.toLowerCase().includes(q) ||
      cfg.filePath.toLowerCase().includes(q) ||
      (cfg.symlinkTarget || '').toLowerCase().includes(q)
  );

  const unsyncedCount =
    configs.filter((c) => c.syncStatus !== 'synced').length + pendingDeletions.length;

  const openCreateModal = () => {
    setNewEntryType('regular');
    setNewFilename('');
    setNewDirectory(pickDefaultDir(availableDirectories, 'regular', ''));
    setDirManuallyChanged(false);
    setNewSymlinkTarget('');
    setCreateError(null);
    setShowCreateModal(true);
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError(null);
    if (!newFilename.trim()) {
      setCreateError(newEntryType === 'symlink' ? '请输入软链接名称' : '请输入配置文件名');
      return;
    }
    if (newEntryType === 'symlink' && !newSymlinkTarget.trim()) {
      setCreateError('请输入软链接指向目标路径');
      return;
    }
    setCreating(true);
    try {
      const res = await onCreateConfig({
        entryType: newEntryType,
        filename: newFilename.trim(),
        directory: newDirectory,
        symlinkTarget: newEntryType === 'symlink' ? newSymlinkTarget.trim() : undefined,
      });
      if (res.error) {
        setCreateError(res.error);
      } else if (res.created) {
        setShowCreateModal(false);
        setNewFilename('');
        setNewSymlinkTarget('');
        if (!res.created.isSymlink) {
          setSelectedFilePath(res.created.filePath);
        }
      }
    } finally {
      setCreating(false);
    }
  };

  const handleGlobalApply = async () => {
    setApplyingAll(true);
    setListMessage(null);
    try {
      const res = await onApplyAll();
      if (res.ok) {
        setListMessage({
          type: 'success',
          text: res.message || '已生效并重载',
        });
      } else {
        setListMessage({
          type: 'error',
          text: res.error || '语法校验未通过',
        });
      }
    } finally {
      setApplyingAll(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Header Bar */}
      <div className="bg-white border border-slate-200 rounded-xl px-6 py-4 flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-base font-semibold text-slate-900">配置列表</h2>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative w-56 sm:w-64">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              aria-label="搜索配置"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索文件名或路径..."
              className="w-full pl-9 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-slate-900"
            />
          </div>

          {unsyncedCount > 0 && (
            <button
              type="button"
              disabled={applyingAll}
              onClick={handleGlobalApply}
              className="px-3.5 py-2 text-xs font-medium text-slate-900 bg-amber-100 border border-amber-300 rounded-lg hover:bg-amber-200 disabled:opacity-50 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Rocket className="w-3.5 h-3.5" />
              <span>{applyingAll ? '生效中...' : `生效 (${unsyncedCount})`}</span>
            </button>
          )}

          <button
            type="button"
            onClick={openCreateModal}
            className="px-3.5 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>新增配置</span>
          </button>
        </div>
      </div>

      {listMessage && (
        <div
          role="status"
          className={`px-4 py-3 rounded-xl border flex items-start justify-between gap-3 text-xs ${
            listMessage.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-red-50 border-red-200 text-red-900'
          }`}
        >
          <div className="flex items-start gap-2">
            {listMessage.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            )}
            <span className="font-mono whitespace-pre-wrap">{listMessage.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setListMessage(null)}
            aria-label="关闭通知"
            className="text-slate-500 hover:text-slate-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {pendingDeletions.length > 0 && (
        <div className="px-4 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs flex items-center justify-between gap-3">
          <span className="font-mono">
            待删除未生效：{pendingDeletions.map((d) => d.filePath).join(', ')}
          </span>
        </div>
      )}

      {/* Entity Configs Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-3 border-b border-slate-200 bg-slate-50/50 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-800">
            <FileText className="w-3.5 h-3.5 text-slate-500" />
            <span>实体配置</span>
            <span className="font-mono text-slate-400 tabular-nums">
              ({filteredEntities.length})
            </span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] table-fixed text-left border-collapse">
            <colgroup>
              <col className="w-[18%]" />
              <col className="w-[58%]" />
              <col className="w-[11%]" />
              <col className="w-[13%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-semibold text-slate-600 whitespace-nowrap">
                <th className="py-3 pl-6 pr-3">配置文件名</th>
                <th className="py-3 px-4">所在路径</th>
                <th className="py-3 px-4">状态</th>
                <th className="py-3 pl-3 pr-6 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {filteredEntities.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-10 text-center text-xs text-slate-500">
                    暂无实体配置
                  </td>
                </tr>
              ) : (
                filteredEntities.map((cfg) => (
                  <tr
                    key={cfg.filePath}
                    className="hover:bg-slate-50/80 transition-colors"
                  >
                    <td className="py-3.5 pl-6 pr-3">
                      <button
                        type="button"
                        onClick={() => setSelectedFilePath(cfg.filePath)}
                        title={cfg.filename}
                        className="block max-w-full truncate font-mono font-medium text-xs text-slate-900 hover:underline cursor-pointer text-left"
                      >
                        {cfg.filename}
                      </button>
                    </td>

                    <td className="py-3.5 px-4 text-xs font-mono text-slate-600">
                      <div className="truncate" title={cfg.filePath}>
                        {cfg.filePath}
                      </div>
                    </td>

                    <td className="py-3.5 px-4 text-xs whitespace-nowrap">
                      {cfg.syncStatus === 'synced' ? (
                        <span className="text-emerald-700 font-medium">已同步</span>
                      ) : cfg.syncStatus === 'new' ? (
                        <span className="text-amber-700 font-medium">新增未生效</span>
                      ) : (
                        <span className="text-amber-700 font-medium">已修改未生效</span>
                      )}
                    </td>

                    <td className="py-3.5 pl-3 pr-6 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => setSelectedFilePath(cfg.filePath)}
                          className="text-xs font-medium text-slate-900 hover:underline inline-flex items-center gap-1 cursor-pointer"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                          <span>编辑</span>
                        </button>
                        <span className="text-slate-300">|</span>
                        <button
                          type="button"
                          onClick={() =>
                            setDeleteTarget({
                              filename: cfg.filename,
                              filePath: cfg.filePath,
                              isSymlink: false,
                            })
                          }
                          aria-label={`删除 ${cfg.filePath}`}
                          className="text-xs font-medium text-red-600 hover:underline inline-flex items-center gap-1 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>删除</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Symlink Configs Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-6 py-3 border-b border-slate-200 bg-slate-50/50 flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-800">
              <Link2 className="w-3.5 h-3.5 text-slate-500" />
              <span>软链接</span>
              <span className="font-mono text-slate-400 tabular-nums">
                ({filteredSymlinks.length})
              </span>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] table-fixed text-left border-collapse">
              <colgroup>
                <col className="w-[18%]" />
                <col className="w-[29%]" />
                <col className="w-[29%]" />
                <col className="w-[11%]" />
                <col className="w-[13%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-semibold text-slate-600 whitespace-nowrap">
                  <th className="py-3 pl-6 pr-3">软链接名称</th>
                  <th className="py-3 px-4">所在路径</th>
                  <th className="py-3 px-4">指向目标</th>
                  <th className="py-3 px-4">状态</th>
                  <th className="py-3 pl-3 pr-6 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {filteredSymlinks.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-10 text-center text-xs text-slate-500">
                      暂无软链接
                    </td>
                  </tr>
                ) : (
                  filteredSymlinks.map((cfg) => (
                    <tr
                      key={cfg.filePath}
                      className="hover:bg-slate-50/80 transition-colors"
                    >
                      <td className="py-3.5 pl-6 pr-3 font-mono font-medium text-xs text-slate-900">
                        <div className="truncate" title={cfg.filename}>
                          {cfg.filename}
                        </div>
                      </td>

                      <td className="py-3.5 px-4 text-xs font-mono text-slate-600">
                        <div className="truncate" title={cfg.filePath}>
                          {cfg.filePath}
                        </div>
                      </td>

                      <td className="py-3.5 px-4 text-xs font-mono text-slate-700">
                        <div className="truncate" title={cfg.symlinkTarget || '-'}>
                          {cfg.symlinkTarget || '-'}
                        </div>
                      </td>

                      <td className="py-3.5 px-4 text-xs whitespace-nowrap">
                        {cfg.syncStatus === 'synced' ? (
                          <span className="text-emerald-700 font-medium">已同步</span>
                        ) : (
                          <span className="text-amber-700 font-medium">新增未生效</span>
                        )}
                      </td>

                      <td className="py-3.5 pl-3 pr-6 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() =>
                            setDeleteTarget({
                              filename: cfg.filename,
                              filePath: cfg.filePath,
                              isSymlink: true,
                            })
                          }
                          aria-label={`删除软链接 ${cfg.filePath}`}
                          className="text-xs font-medium text-red-600 hover:underline inline-flex items-center gap-1 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>删除</span>
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

      {/* Create Modal */}
      {showCreateModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-cfg-dialog-title"
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
        >
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md overflow-hidden shadow-lg">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 id="create-cfg-dialog-title" className="text-sm font-semibold text-slate-900">
                新增配置
              </h3>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                aria-label="关闭新增配置弹窗"
                className="text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateSubmit} className="p-6 space-y-4">
              {createError && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                  {createError}
                </div>
              )}

              <div>
                <span className="block text-xs font-medium text-slate-700 mb-1.5">
                  配置类型
                </span>
                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => {
                      setNewEntryType('regular');
                      if (!dirManuallyChanged) {
                        setNewDirectory(pickDefaultDir(availableDirectories, 'regular', newFilename));
                      }
                    }}
                    className={`py-2 px-3 rounded-lg border text-xs font-medium transition-colors cursor-pointer ${
                      newEntryType === 'regular'
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-slate-200 bg-white text-slate-800 hover:bg-slate-50'
                    }`}
                  >
                    实体配置
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setNewEntryType('symlink');
                      if (!dirManuallyChanged) {
                        setNewDirectory(pickDefaultDir(availableDirectories, 'symlink', newFilename));
                      }
                    }}
                    className={`py-2 px-3 rounded-lg border text-xs font-medium transition-colors cursor-pointer ${
                      newEntryType === 'symlink'
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-slate-200 bg-white text-slate-800 hover:bg-slate-50'
                    }`}
                  >
                    软链接
                  </button>
                </div>
              </div>

              <div>
                <label
                  htmlFor="new-cfg-filename"
                  className="block text-xs font-medium text-slate-700 mb-1.5"
                >
                  {newEntryType === 'symlink' ? '软链接名称' : '配置文件名'}
                </label>
                <input
                  id="new-cfg-filename"
                  type="text"
                  value={newFilename}
                  onChange={(e) => {
                    const val = e.target.value;
                    setNewFilename(val);
                    if (!dirManuallyChanged) {
                      setNewDirectory(pickDefaultDir(availableDirectories, newEntryType, val));
                    }
                  }}
                  placeholder="app.conf 或 minimal-chat"
                  className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-slate-900"
                />
              </div>

              <div>
                <label
                  htmlFor="new-cfg-dir"
                  className="block text-xs font-medium text-slate-700 mb-1.5"
                >
                  所在目录
                </label>
                <select
                  id="new-cfg-dir"
                  value={newDirectory}
                  onChange={(e) => {
                    setDirManuallyChanged(true);
                    setNewDirectory(e.target.value);
                  }}
                  className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-slate-900"
                >
                  {availableDirectories.map((dir) => (
                    <option key={dir} value={dir}>
                      {dir}
                    </option>
                  ))}
                </select>
              </div>

              {newEntryType === 'symlink' && (
                <div className="space-y-2.5">
                  <div>
                    <label
                      htmlFor="new-symlink-target"
                      className="block text-xs font-medium text-slate-700 mb-1.5"
                    >
                      指向目标路径
                    </label>
                    <input
                      id="new-symlink-target"
                      type="text"
                      value={newSymlinkTarget}
                      onChange={(e) => setNewSymlinkTarget(e.target.value)}
                      placeholder="/etc/nginx/sites-available/minimal-chat"
                      className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-slate-900"
                    />
                  </div>

                  {allEntityConfigs.length > 0 && (
                    <div>
                      <label
                        htmlFor="quick-pick-target"
                        className="block text-xs text-slate-500 mb-1"
                      >
                        选择已有实体路径
                      </label>
                      <select
                        id="quick-pick-target"
                        value=""
                        onChange={(e) => {
                          const target = e.target.value;
                          if (!target) return;
                          setNewSymlinkTarget(target);
                          if (!newFilename.trim()) {
                            const base = target.split('/').pop() || '';
                            if (base) setNewFilename(base);
                          }
                        }}
                        className="w-full px-3 py-1.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-700 focus:outline-none focus:border-slate-900"
                      >
                        <option value="">-- 选择已有实体文件 --</option>
                        {allEntityConfigs.map((c) => (
                          <option key={c.filePath} value={c.filePath}>
                            {c.filePath}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              )}

              <div className="pt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
                >
                  {creating ? '创建中...' : '确定'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="list-delete-dialog-title"
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
        >
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-sm overflow-hidden shadow-lg">
            <div className="px-6 py-4 border-b border-slate-200">
              <h3 id="list-delete-dialog-title" className="text-sm font-semibold text-slate-900">
                确认删除
              </h3>
            </div>
            <div className="p-6 text-xs text-slate-600">
              确定删除{deleteTarget.isSymlink ? '软链接' : '配置文件'}{' '}
              <strong className="font-mono text-slate-900">{deleteTarget.filePath}</strong> 吗？
            </div>
            <div className="px-6 py-3.5 bg-slate-50 border-t border-slate-200 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                onClick={async () => {
                  const target = deleteTarget;
                  setDeleteTarget(null);
                  await onDeleteConfig(target.filename, target.filePath);
                }}
                className="px-4 py-2 text-xs font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 cursor-pointer"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
