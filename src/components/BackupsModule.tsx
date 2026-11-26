import React, { useState } from 'react';
import { Eye, Trash2, Search, X, RotateCcw } from 'lucide-react';
import { BackupRecord } from '../types';

interface BackupsModuleProps {
  backups: BackupRecord[];
  onDeleteBackup: (id: string) => Promise<void>;
  onRestoreBackupToMirror: (id: string) => Promise<void>;
}

export const BackupsModule: React.FC<BackupsModuleProps> = ({
  backups,
  onDeleteBackup,
  onRestoreBackupToMirror,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'time_desc' | 'filename_asc'>('time_desc');
  const [viewingBackup, setViewingBackup] = useState<BackupRecord | null>(null);
  const [deletingBackup, setDeletingBackup] = useState<BackupRecord | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const filtered = backups
    .filter((b) => {
      const q = searchQuery.trim().toLowerCase();
      if (!q) return true;
      return (
        b.backupName.toLowerCase().includes(q) ||
        b.filename.toLowerCase().includes(q) ||
        b.label.toLowerCase().includes(q)
      );
    })
    .sort((a, b) => {
      if (sortBy === 'filename_asc') {
        const cmp = a.filename.localeCompare(b.filename);
        if (cmp !== 0) return cmp;
      }
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

  const handleRestore = async (bk: BackupRecord) => {
    setRestoringId(bk.id);
    setFeedback(null);
    try {
      await onRestoreBackupToMirror(bk.id);
      setFeedback(`已加载备份 ${bk.backupName}`);
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="bg-white border border-slate-200 rounded-xl px-6 py-4 flex items-center justify-between gap-4">
        <h2 className="text-base font-semibold text-slate-900">备份记录</h2>

        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
          <button
            type="button"
            onClick={() => setSortBy('time_desc')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              sortBy === 'time_desc'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            时间倒序
          </button>
          <button
            type="button"
            onClick={() => setSortBy('filename_asc')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              sortBy === 'filename_asc'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            文件名排序
          </button>
        </div>
      </div>

      {feedback && (
        <div
          role="status"
          className="px-4 py-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-center justify-between"
        >
          <span>{feedback}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            aria-label="关闭通知"
            className="text-emerald-700 hover:text-emerald-950 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="flex items-center justify-between gap-4">
        <div className="text-xs text-slate-500 tabular-nums">
          共 {filtered.length} 条
        </div>

        <div className="relative w-full sm:w-64">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            aria-label="搜索备份"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索备份名称或文件名..."
            className="w-full pl-9 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-slate-900"
          />
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-semibold text-slate-600 whitespace-nowrap">
                <th className="py-3.5 px-6">备份名称</th>
                <th className="py-3.5 px-4">配置文件</th>
                <th className="py-3.5 px-4">类型</th>
                <th className="py-3.5 px-4">时间</th>
                <th className="py-3.5 px-6 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-12 text-center text-xs text-slate-500">
                    暂无备份记录
                  </td>
                </tr>
              ) : (
                filtered.map((bk) => (
                  <tr key={bk.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-3.5 px-6 whitespace-nowrap font-mono font-medium text-slate-900 text-xs">
                      {bk.backupName}
                    </td>

                    <td className="py-3.5 px-4 font-mono text-xs text-slate-700 whitespace-nowrap">
                      {bk.filename}
                    </td>

                    <td className="py-3.5 px-4 text-xs whitespace-nowrap">
                      <span
                        className={
                          bk.isInitial
                            ? 'text-slate-900 font-semibold'
                            : 'text-slate-600'
                        }
                      >
                        {bk.label}
                      </span>
                    </td>

                    <td className="py-3.5 px-4 text-xs font-mono tabular-nums text-slate-600 whitespace-nowrap">
                      {new Date(bk.createdAt).toLocaleString()}
                    </td>

                    <td className="py-3.5 px-6 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => setViewingBackup(bk)}
                          className="text-xs font-medium text-slate-900 hover:underline inline-flex items-center gap-1 cursor-pointer"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          <span>查看源码</span>
                        </button>
                        <span className="text-slate-300">|</span>
                        <button
                          type="button"
                          disabled={restoringId === bk.id}
                          onClick={() => handleRestore(bk)}
                          className="text-xs font-medium text-slate-700 hover:text-slate-900 hover:underline inline-flex items-center gap-1 cursor-pointer"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          <span>加载</span>
                        </button>
                        <span className="text-slate-300">|</span>
                        <button
                          type="button"
                          onClick={() => setDeletingBackup(bk)}
                          aria-label={`删除备份 ${bk.backupName}`}
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

      {viewingBackup && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="view-backup-title"
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
        >
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-2xl overflow-hidden shadow-lg">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 id="view-backup-title" className="text-sm font-semibold text-slate-900 font-mono">
                {viewingBackup.backupName}
              </h3>
              <button
                type="button"
                onClick={() => setViewingBackup(null)}
                aria-label="关闭源码查看弹窗"
                className="text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 max-h-[70vh] overflow-y-auto">
              <pre className="text-xs font-mono bg-slate-900 text-slate-100 p-4 rounded-lg overflow-x-auto leading-relaxed">
                {viewingBackup.content}
              </pre>
            </div>

            <div className="px-6 py-3.5 bg-slate-50 border-t border-slate-200 flex justify-end gap-2">
              <button
                type="button"
                onClick={async () => {
                  const target = viewingBackup;
                  setViewingBackup(null);
                  await handleRestore(target);
                }}
                className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 cursor-pointer"
              >
                加载此备份
              </button>
              <button
                type="button"
                onClick={() => setViewingBackup(null)}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {deletingBackup && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="del-backup-title"
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
        >
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-sm overflow-hidden shadow-lg">
            <div className="px-6 py-4 border-b border-slate-200">
              <h3 id="del-backup-title" className="text-sm font-semibold text-slate-900">
                确认删除
              </h3>
            </div>
            <div className="p-6 text-xs text-slate-600">
              确定删除备份 <strong className="font-mono text-slate-900">{deletingBackup.backupName}</strong> 吗？
            </div>
            <div className="px-6 py-3.5 bg-slate-50 border-t border-slate-200 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeletingBackup(null)}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                onClick={async () => {
                  const id = deletingBackup.id;
                  setDeletingBackup(null);
                  await onDeleteBackup(id);
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
