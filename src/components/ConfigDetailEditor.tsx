import React, { useState, useEffect } from 'react';
import {
  ArrowLeft,
  Eye,
  History,
  Save,
  Rocket,
  Trash2,
  Plus,
  X,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import {
  ConfigItem,
  BackupRecord,
  CertificateRecord,
  PreviewResponse,
} from '../types';
import {
  NginxConfigForm,
  UpstreamBlock,
  UpstreamNode,
  LocationRule,
  LocationType,
} from '../utils/nginxParser';

interface ConfigDetailEditorProps {
  config: ConfigItem;
  backups: BackupRecord[];
  certificates: CertificateRecord[];
  onBack: () => void;
  onPreview: (form: NginxConfigForm) => Promise<PreviewResponse>;
  onSave: (form: NginxConfigForm) => Promise<{ ok: boolean; message?: string; error?: string }>;
  onApply: (form: NginxConfigForm) => Promise<{ ok: boolean; message?: string; error?: string }>;
  onLoadBackup: (backupId: string) => Promise<ConfigItem | null>;
  onDeleteConfig: (filename: string) => Promise<void>;
}

export const ConfigDetailEditor: React.FC<ConfigDetailEditorProps> = ({
  config,
  backups,
  certificates,
  onBack,
  onPreview,
  onSave,
  onApply,
  onLoadBackup,
  onDeleteConfig,
}) => {
  const [form, setForm] = useState<NginxConfigForm>(() => structuredClone(config.form));
  const [busyBtn, setBusyBtn] = useState<'preview' | 'save' | 'apply' | 'delete' | null>(null);
  const [bannerMsg, setBannerMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null
  );

  const [previewModal, setPreviewModal] = useState<PreviewResponse | null>(null);
  const [showLoadBackupModal, setShowLoadBackupModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    setForm(structuredClone(config.form));
  }, [config]);

  const fileBackups = backups.filter((b) => b.filename === config.filename);

  const updateField = <K extends keyof NginxConfigForm>(key: K, value: NginxConfigForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleToggleSsl = (checked: boolean) => {
    setForm((prev) => {
      const portTokens = prev.listenPorts
        .split(/[,，\s]+/)
        .map((p) => p.trim())
        .filter((p) => p && p !== 'ssl' && p !== 'http2' && p !== 'default_server');

      let nextPorts = [...portTokens];
      if (checked) {
        if (!nextPorts.includes('443')) {
          nextPorts.push('443');
        }
      } else if (nextPorts.includes('443') && nextPorts.length > 1) {
        nextPorts = nextPorts.filter((p) => p !== '443');
      }

      let sslCertificate = prev.sslCertificate;
      let sslCertificateKey = prev.sslCertificateKey;
      if (checked && !sslCertificate && certificates.length > 0) {
        sslCertificate = certificates[0].certPath;
        sslCertificateKey = certificates[0].keyPath;
      }
      return {
        ...prev,
        enableSsl: checked,
        listenPorts: nextPorts.join(', ') || '80',
        sslCertificate,
        sslCertificateKey,
      };
    });
  };

  const handleSelectCertificate = (certPath: string) => {
    if (!certPath) {
      setForm((prev) => ({ ...prev, sslCertificate: '', sslCertificateKey: '' }));
      return;
    }
    const found = certificates.find((c) => c.certPath === certPath);
    if (found) {
      setForm((prev) => ({
        ...prev,
        sslCertificate: found.certPath,
        sslCertificateKey: found.keyPath,
      }));
    } else {
      setForm((prev) => ({ ...prev, sslCertificate: certPath }));
    }
  };

  const handleAddUpstream = () => {
    const stem =
      form.filename.replace(/\.conf$/i, '').replace(/[^a-zA-Z0-9_]/g, '_') || 'app';
    const nextIdx = form.upstreams.length + 1;
    const nextBlock: UpstreamBlock = {
      id: `upstream-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      name: nextIdx === 1 ? `${stem}_backend` : `${stem}_backend_${nextIdx}`,
      nodes: [{ id: `node-${Date.now()}-1`, address: '127.0.0.1:8080', weight: '' }],
    };
    setForm((prev) => ({
      ...prev,
      upstreams: [...prev.upstreams, nextBlock],
    }));
  };

  const handleUpdateUpstreamName = (upstreamId: string, name: string) => {
    setForm((prev) => ({
      ...prev,
      upstreams: prev.upstreams.map((u) =>
        u.id === upstreamId ? { ...u, name } : u
      ),
    }));
  };

  const handleRemoveUpstream = (upstreamId: string) => {
    setForm((prev) => ({
      ...prev,
      upstreams: prev.upstreams.filter((u) => u.id !== upstreamId),
    }));
  };

  const handleAddUpstreamNode = (upstreamId: string) => {
    const nextNode: UpstreamNode = {
      id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      address: '127.0.0.1:8080',
      weight: '',
    };
    setForm((prev) => ({
      ...prev,
      upstreams: prev.upstreams.map((u) =>
        u.id === upstreamId ? { ...u, nodes: [...u.nodes, nextNode] } : u
      ),
    }));
  };

  const handleUpdateUpstreamNode = (
    upstreamId: string,
    nodeId: string,
    field: 'address' | 'weight',
    val: string
  ) => {
    setForm((prev) => ({
      ...prev,
      upstreams: prev.upstreams.map((u) =>
        u.id === upstreamId
          ? {
              ...u,
              nodes: u.nodes.map((n) => (n.id === nodeId ? { ...n, [field]: val } : n)),
            }
          : u
      ),
    }));
  };

  const handleRemoveUpstreamNode = (upstreamId: string, nodeId: string) => {
    setForm((prev) => ({
      ...prev,
      upstreams: prev.upstreams.map((u) =>
        u.id === upstreamId
          ? { ...u, nodes: u.nodes.filter((n) => n.id !== nodeId) }
          : u
      ),
    }));
  };

  const handleAddLocation = (type: LocationType) => {
    const hasRootLoc = form.locations.some((l) => l.path.trim() === '/');
    const defaultPath =
      type === 'reverse_proxy'
        ? hasRootLoc
          ? '/api/'
          : '/'
        : hasRootLoc
        ? '/static/'
        : '/';
    const nextLoc: LocationRule = {
      id: `loc-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      type,
      path: defaultPath,
      root: '',
      index: '',
      tryFiles: '',
      proxyPass: '',
      passHost: false,
      passRealIp: false,
      passForwardedFor: false,
      passForwardedProto: false,
      enableWebsocket: false,
      extraDirectives: [],
    };
    setForm((prev) => ({
      ...prev,
      locations: [...prev.locations, nextLoc],
    }));
  };

  const handleUpdateLocation = <K extends keyof LocationRule>(
    id: string,
    field: K,
    val: LocationRule[K]
  ) => {
    setForm((prev) => ({
      ...prev,
      locations: prev.locations.map((l) =>
        l.id === id ? { ...l, [field]: val } : l
      ),
    }));
  };

  const handleRemoveLocation = (id: string) => {
    setForm((prev) => ({
      ...prev,
      locations: prev.locations.filter((l) => l.id !== id),
    }));
  };

  const handlePreviewClick = async () => {
    setBusyBtn('preview');
    setBannerMsg(null);
    try {
      const res = await onPreview(form);
      setPreviewModal(res);
    } finally {
      setBusyBtn(null);
    }
  };

  const handleSelectBackupToLoad = async (backupId: string) => {
    const loaded = await onLoadBackup(backupId);
    setShowLoadBackupModal(false);
    if (loaded) {
      setForm(structuredClone(loaded.form));
      setBannerMsg({
        type: 'success',
        text: '已加载历史备份',
      });
    }
  };

  const handleSaveClick = async () => {
    setBusyBtn('save');
    setBannerMsg(null);
    try {
      const res = await onSave(form);
      if (res.ok) {
        setBannerMsg({
          type: 'success',
          text: res.message || '已保存并生成备份',
        });
      } else {
        setBannerMsg({
          type: 'error',
          text: res.error || '语法校验未通过',
        });
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setBusyBtn(null);
    }
  };

  const handleApplyClick = async () => {
    setBusyBtn('apply');
    setBannerMsg(null);
    try {
      const res = await onApply(form);
      if (res.ok) {
        setBannerMsg({
          type: 'success',
          text: res.message || '已生效并重载',
        });
      } else {
        setBannerMsg({
          type: 'error',
          text: res.error || '语法校验未通过',
        });
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setBusyBtn(null);
    }
  };

  return (
    <div className="space-y-5">
      {/* Top Action Bar */}
      <div className="bg-white border border-slate-200 rounded-xl px-6 py-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            aria-label="返回配置列表"
            className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-2.5">
            <h2 className="text-base font-semibold text-slate-900 font-mono">
              {config.filename}
            </h2>
            <span className="text-xs text-slate-300">·</span>
            <span
              className={`text-xs font-medium ${
                config.syncStatus === 'synced' ? 'text-emerald-700' : 'text-amber-700'
              }`}
            >
              {config.syncStatus === 'synced' ? '已同步' : '已修改未生效'}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busyBtn !== null}
            onClick={handlePreviewClick}
            className="px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Eye className="w-3.5 h-3.5" />
            <span>预览</span>
          </button>

          <button
            type="button"
            disabled={busyBtn !== null}
            onClick={() => setShowLoadBackupModal(true)}
            className="px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <History className="w-3.5 h-3.5" />
            <span>加载 ({fileBackups.length})</span>
          </button>

          <button
            type="button"
            disabled={busyBtn !== null}
            onClick={handleSaveClick}
            className="px-3.5 py-2 text-xs font-medium text-slate-900 bg-slate-100 border border-slate-300 rounded-lg hover:bg-slate-200 disabled:opacity-50 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Save className="w-3.5 h-3.5" />
            <span>{busyBtn === 'save' ? '保存中...' : '保存'}</span>
          </button>

          <button
            type="button"
            disabled={busyBtn !== null}
            onClick={handleApplyClick}
            className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Rocket className="w-3.5 h-3.5" />
            <span>{busyBtn === 'apply' ? '生效中...' : '生效'}</span>
          </button>

          <button
            type="button"
            disabled={busyBtn !== null}
            onClick={() => setShowDeleteConfirm(true)}
            aria-label={`删除配置 ${config.filename}`}
            className="px-3 py-2 text-xs font-medium text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50 flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>删除</span>
          </button>
        </div>
      </div>

      {bannerMsg && (
        <div
          role="status"
          className={`px-4 py-3 rounded-xl border flex items-start justify-between gap-3 text-xs ${
            bannerMsg.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-red-50 border-red-200 text-red-900'
          }`}
        >
          <div className="flex items-start gap-2">
            {bannerMsg.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            )}
            <span className="leading-relaxed whitespace-pre-wrap font-mono">
              {bannerMsg.text}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setBannerMsg(null)}
            aria-label="关闭提示"
            className="text-slate-500 hover:text-slate-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* 基础信息 */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="border-b border-slate-100 pb-3">
          <h3 className="text-sm font-semibold text-slate-900">基础信息</h3>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <label
              htmlFor="cfg-filepath"
              className="block text-xs font-medium text-slate-700 mb-1.5"
            >
              配置文件路径
            </label>
            <input
              id="cfg-filepath"
              type="text"
              readOnly
              value={form.filePath}
              className="w-full px-3 py-2 text-sm font-mono bg-slate-100 border border-slate-200 rounded-lg text-slate-600 cursor-not-allowed"
            />
          </div>

          <div>
            <label
              htmlFor="cfg-servername"
              className="block text-xs font-medium text-slate-700 mb-1.5"
            >
              HOST (server_name)
            </label>
            <input
              id="cfg-servername"
              type="text"
              value={form.serverName}
              onChange={(e) => updateField('serverName', e.target.value)}
              placeholder="选填，多域名空格分隔"
              className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-slate-900"
            />
          </div>

          <div>
            <label
              htmlFor="cfg-listen"
              className="block text-xs font-medium text-slate-700 mb-1.5"
            >
              监听端口
            </label>
            <input
              id="cfg-listen"
              type="text"
              value={form.listenPorts}
              onChange={(e) => updateField('listenPorts', e.target.value)}
              placeholder="80, 443"
              className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-slate-900"
            />
          </div>

          <div className="flex flex-col justify-end">
            <label className="flex items-center gap-2 text-sm text-slate-800 cursor-pointer py-2">
              <input
                type="checkbox"
                checked={form.enableSsl}
                onChange={(e) => handleToggleSsl(e.target.checked)}
                className="w-4 h-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
              />
              <span className="font-medium text-xs">开启 SSL</span>
            </label>
          </div>

          <div>
            <label
              htmlFor="cfg-server-root"
              className="block text-xs font-medium text-slate-700 mb-1.5"
            >
              根目录路径 (root)
            </label>
            <input
              id="cfg-server-root"
              type="text"
              value={form.rootPath}
              onChange={(e) => updateField('rootPath', e.target.value)}
              placeholder="选填，如 /var/www/dist"
              className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-slate-900"
            />
          </div>

          <div>
            <label
              htmlFor="cfg-server-index"
              className="block text-xs font-medium text-slate-700 mb-1.5"
            >
              默认索引 (index)
            </label>
            <input
              id="cfg-server-index"
              type="text"
              value={form.indexFiles}
              onChange={(e) => updateField('indexFiles', e.target.value)}
              placeholder="选填，如 index.html index.htm"
              className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-slate-900"
            />
          </div>
        </div>

        {form.enableSsl && (
          <div className="pt-4 border-t border-slate-100 space-y-4">
            <div>
              <label
                htmlFor="cfg-ssl-select"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                关联证书
              </label>
              <select
                id="cfg-ssl-select"
                value={form.sslCertificate}
                onChange={(e) => handleSelectCertificate(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-slate-900"
              >
                <option value="">-- 选择已加载证书 --</option>
                {certificates.map((cert) => (
                  <option key={cert.id} value={cert.certPath}>
                    {cert.name} ({cert.domains.join(', ')})
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="cfg-ssl-cert-path"
                  className="block text-xs font-medium text-slate-700 mb-1.5"
                >
                  公钥路径 (ssl_certificate)
                </label>
                <input
                  id="cfg-ssl-cert-path"
                  type="text"
                  value={form.sslCertificate}
                  onChange={(e) => updateField('sslCertificate', e.target.value)}
                  placeholder="/etc/nginx/ssl/example.crt"
                  className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-slate-900"
                />
              </div>

              <div>
                <label
                  htmlFor="cfg-ssl-key-path"
                  className="block text-xs font-medium text-slate-700 mb-1.5"
                >
                  私钥路径 (ssl_certificate_key)
                </label>
                <input
                  id="cfg-ssl-key-path"
                  type="text"
                  value={form.sslCertificateKey}
                  onChange={(e) => updateField('sslCertificateKey', e.target.value)}
                  placeholder="/etc/nginx/ssl/example.key"
                  className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-slate-900"
                />
              </div>
            </div>
          </div>
        )}

        {/* 可选服务端参数 */}
        <div className="pt-4 border-t border-slate-100 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label
              htmlFor="cfg-body-size"
              className="block text-xs font-medium text-slate-700 mb-1"
            >
              client_max_body_size
            </label>
            <input
              id="cfg-body-size"
              type="text"
              value={form.clientMaxBodySize}
              onChange={(e) => updateField('clientMaxBodySize', e.target.value)}
              placeholder="选填，如 50m"
              className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-slate-900"
            />
          </div>

          <div>
            <label
              htmlFor="cfg-conn-timeout"
              className="block text-xs font-medium text-slate-700 mb-1"
            >
              proxy_connect_timeout
            </label>
            <input
              id="cfg-conn-timeout"
              type="text"
              value={form.proxyConnectTimeout}
              onChange={(e) => updateField('proxyConnectTimeout', e.target.value)}
              placeholder="选填，如 60s"
              className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-slate-900"
            />
          </div>

          <div>
            <label
              htmlFor="cfg-read-timeout"
              className="block text-xs font-medium text-slate-700 mb-1"
            >
              proxy_read_timeout
            </label>
            <input
              id="cfg-read-timeout"
              type="text"
              value={form.proxyReadTimeout}
              onChange={(e) => updateField('proxyReadTimeout', e.target.value)}
              placeholder="选填，如 60s"
              className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-slate-900"
            />
          </div>
        </div>
      </div>

      {/* Location 规则 */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
          <h3 className="text-sm font-semibold text-slate-900">Location 规则</h3>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleAddLocation('static')}
              className="px-3 py-1.5 text-xs font-medium text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-lg flex items-center gap-1 transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>新增静态站点</span>
            </button>
            <button
              type="button"
              onClick={() => handleAddLocation('reverse_proxy')}
              className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg flex items-center gap-1 transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>新增反向代理</span>
            </button>
          </div>
        </div>

        {form.locations.length === 0 ? (
          <div className="py-6 text-center text-xs text-slate-400">暂无 location</div>
        ) : (
          <div className="space-y-4">
            {form.locations.map((loc, idx) => {
              const locType: LocationType =
                loc.type || (loc.proxyPass.trim() ? 'reverse_proxy' : 'static');
              return (
                <div
                  key={loc.id}
                  className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-mono font-semibold text-slate-500">
                        location #{idx + 1}
                      </span>
                      <div
                        role="group"
                        aria-label={`location #${idx + 1} 类型`}
                        className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5"
                      >
                        <button
                          type="button"
                          aria-pressed={locType === 'static'}
                          onClick={() => handleUpdateLocation(loc.id, 'type', 'static')}
                          className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                            locType === 'static'
                              ? 'bg-slate-900 text-white'
                              : 'text-slate-600 hover:text-slate-900'
                          }`}
                        >
                          静态站点
                        </button>
                        <button
                          type="button"
                          aria-pressed={locType === 'reverse_proxy'}
                          onClick={() => handleUpdateLocation(loc.id, 'type', 'reverse_proxy')}
                          className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                            locType === 'reverse_proxy'
                              ? 'bg-slate-900 text-white'
                              : 'text-slate-600 hover:text-slate-900'
                          }`}
                        >
                          反向代理
                        </button>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleRemoveLocation(loc.id)}
                      aria-label={`删除 location ${loc.path || idx + 1}`}
                      className="text-xs text-slate-400 hover:text-red-600 inline-flex items-center gap-1 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>删除</span>
                    </button>
                  </div>

                  {locType === 'static' ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                      <div>
                        <label
                          htmlFor={`loc-path-${loc.id}`}
                          className="block text-xs text-slate-600 mb-1"
                        >
                          匹配路径
                        </label>
                        <input
                          id={`loc-path-${loc.id}`}
                          type="text"
                          value={loc.path}
                          onChange={(e) => handleUpdateLocation(loc.id, 'path', e.target.value)}
                          placeholder="/ 或 /static/"
                          className="w-full px-3 py-1.5 text-xs font-mono bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:border-slate-900"
                        />
                      </div>

                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <label
                            htmlFor={`loc-tryfiles-${loc.id}`}
                            className="text-xs text-slate-600"
                          >
                            try_files
                          </label>
                          <div className="flex items-center gap-2 text-xs">
                            <button
                              type="button"
                              onClick={() =>
                                handleUpdateLocation(
                                  loc.id,
                                  'tryFiles',
                                  '$uri $uri/ /index.html'
                                )
                              }
                              className="text-slate-600 hover:text-slate-900 underline cursor-pointer"
                            >
                              默认
                            </button>
                            <span>·</span>
                            <button
                              type="button"
                              onClick={() => handleUpdateLocation(loc.id, 'tryFiles', '')}
                              className="text-slate-600 hover:text-slate-900 underline cursor-pointer"
                            >
                              清空
                            </button>
                          </div>
                        </div>
                        <input
                          id={`loc-tryfiles-${loc.id}`}
                          type="text"
                          value={loc.tryFiles}
                          onChange={(e) =>
                            handleUpdateLocation(loc.id, 'tryFiles', e.target.value)
                          }
                          placeholder="选填，如 $uri $uri/ /index.html"
                          className="w-full px-3 py-1.5 text-xs font-mono bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:border-slate-900"
                        />
                      </div>

                      <div>
                        <label
                          htmlFor={`loc-root-${loc.id}`}
                          className="block text-xs text-slate-600 mb-1"
                        >
                          root (location 级)
                        </label>
                        <input
                          id={`loc-root-${loc.id}`}
                          type="text"
                          value={loc.root}
                          onChange={(e) => handleUpdateLocation(loc.id, 'root', e.target.value)}
                          placeholder="选填，留空则沿用 server 级 root"
                          className="w-full px-3 py-1.5 text-xs font-mono bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:border-slate-900"
                        />
                      </div>

                      <div>
                        <label
                          htmlFor={`loc-index-${loc.id}`}
                          className="block text-xs text-slate-600 mb-1"
                        >
                          index (location 级)
                        </label>
                        <input
                          id={`loc-index-${loc.id}`}
                          type="text"
                          value={loc.index}
                          onChange={(e) =>
                            handleUpdateLocation(loc.id, 'index', e.target.value)
                          }
                          placeholder="选填，留空则沿用 server 级 index"
                          className="w-full px-3 py-1.5 text-xs font-mono bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:border-slate-900"
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3.5">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                        <div>
                          <label
                            htmlFor={`loc-path-${loc.id}`}
                            className="block text-xs text-slate-600 mb-1"
                          >
                            匹配路径
                          </label>
                          <input
                            id={`loc-path-${loc.id}`}
                            type="text"
                            value={loc.path}
                            onChange={(e) => handleUpdateLocation(loc.id, 'path', e.target.value)}
                            placeholder="/api/ 或 /"
                            className="w-full px-3 py-1.5 text-xs font-mono bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:border-slate-900"
                          />
                        </div>

                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <label
                              htmlFor={`loc-proxy-${loc.id}`}
                              className="text-xs text-slate-600"
                            >
                              proxy_pass
                            </label>
                            {form.upstreams.some((u) => u.name.trim()) && (
                              <div className="flex flex-wrap items-center gap-1.5">
                                {form.upstreams
                                  .filter((u) => u.name.trim())
                                  .map((u) => (
                                    <button
                                      key={u.id}
                                      type="button"
                                      onClick={() =>
                                        handleUpdateLocation(
                                          loc.id,
                                          'proxyPass',
                                          `http://${u.name.trim()}`
                                        )
                                      }
                                      className="text-xs font-mono text-slate-600 hover:text-slate-900 underline cursor-pointer"
                                    >
                                      {u.name.trim()}
                                    </button>
                                  ))}
                              </div>
                            )}
                          </div>
                          <input
                            id={`loc-proxy-${loc.id}`}
                            type="text"
                            value={loc.proxyPass}
                            onChange={(e) =>
                              handleUpdateLocation(loc.id, 'proxyPass', e.target.value)
                            }
                            placeholder="http://127.0.0.1:8080 或 http://upstream_name"
                            className="w-full px-3 py-1.5 text-xs font-mono bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:border-slate-900"
                          />
                        </div>
                      </div>

                      <div className="pt-2.5 border-t border-slate-200/80 flex flex-wrap items-center gap-x-5 gap-y-2">
                        <label className="flex items-center gap-1.5 text-xs text-slate-800 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={loc.passHost}
                            onChange={(e) =>
                              handleUpdateLocation(loc.id, 'passHost', e.target.checked)
                            }
                            className="w-3.5 h-3.5 rounded border-slate-300 text-slate-900"
                          />
                          <span>传递 Host 头</span>
                        </label>

                        <label className="flex items-center gap-1.5 text-xs text-slate-800 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={loc.passRealIp}
                            onChange={(e) =>
                              handleUpdateLocation(loc.id, 'passRealIp', e.target.checked)
                            }
                            className="w-3.5 h-3.5 rounded border-slate-300 text-slate-900"
                          />
                          <span>传递 X-Real-IP</span>
                        </label>

                        <label className="flex items-center gap-1.5 text-xs text-slate-800 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={loc.passForwardedFor}
                            onChange={(e) =>
                              handleUpdateLocation(
                                loc.id,
                                'passForwardedFor',
                                e.target.checked
                              )
                            }
                            className="w-3.5 h-3.5 rounded border-slate-300 text-slate-900"
                          />
                          <span>传递 X-Forwarded-For</span>
                        </label>

                        <label className="flex items-center gap-1.5 text-xs text-slate-800 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={loc.passForwardedProto}
                            onChange={(e) =>
                              handleUpdateLocation(
                                loc.id,
                                'passForwardedProto',
                                e.target.checked
                              )
                            }
                            className="w-3.5 h-3.5 rounded border-slate-300 text-slate-900"
                          />
                          <span>传递 X-Forwarded-Proto</span>
                        </label>

                        <label className="flex items-center gap-1.5 text-xs text-slate-800 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={loc.enableWebsocket}
                            onChange={(e) =>
                              handleUpdateLocation(
                                loc.id,
                                'enableWebsocket',
                                e.target.checked
                              )
                            }
                            className="w-3.5 h-3.5 rounded border-slate-300 text-slate-900"
                          />
                          <span>支持 WebSocket</span>
                        </label>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Upstream 集群（可选） */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <h3 className="text-sm font-semibold text-slate-900">Upstream 集群</h3>
          <button
            type="button"
            onClick={handleAddUpstream}
            className="px-3 py-1.5 text-xs font-medium text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-lg flex items-center gap-1 transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>新增 Upstream</span>
          </button>
        </div>

        {form.upstreams.length === 0 ? (
          <div className="py-4 text-center text-xs text-slate-400">暂无 Upstream</div>
        ) : (
          <div className="space-y-4">
            {form.upstreams.map((up, uIdx) => (
              <div
                key={up.id}
                className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 flex-1 min-w-[200px]">
                    <label
                      htmlFor={`up-name-${up.id}`}
                      className="text-xs font-medium text-slate-700 whitespace-nowrap"
                    >
                      名称
                    </label>
                    <input
                      id={`up-name-${up.id}`}
                      type="text"
                      value={up.name}
                      onChange={(e) => handleUpdateUpstreamName(up.id, e.target.value)}
                      placeholder="backend_pool"
                      className="flex-1 max-w-xs px-3 py-1.5 text-xs font-mono bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:border-slate-900"
                    />
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleAddUpstreamNode(up.id)}
                      className="px-2.5 py-1.5 text-xs font-medium text-slate-900 bg-white border border-slate-200 hover:bg-slate-100 rounded-md flex items-center gap-1 cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>添加节点</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemoveUpstream(up.id)}
                      aria-label={`删除 Upstream ${up.name || uIdx + 1}`}
                      className="p-1.5 text-slate-400 hover:text-red-600 cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  {up.nodes.map((node, index) => (
                    <div
                      key={node.id}
                      className="flex items-center gap-3 bg-white p-2 rounded-lg border border-slate-200"
                    >
                      <span className="text-xs font-mono text-slate-400 w-5 tabular-nums pl-1">
                        #{index + 1}
                      </span>
                      <div className="flex-1">
                        <input
                          type="text"
                          aria-label={`节点 ${index + 1} 地址`}
                          value={node.address}
                          onChange={(e) =>
                            handleUpdateUpstreamNode(up.id, node.id, 'address', e.target.value)
                          }
                          placeholder="ip:port (如 10.0.1.11:8080)"
                          className="w-full px-3 py-1.5 text-xs font-mono bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:border-slate-900"
                        />
                      </div>
                      <div className="w-32">
                        <input
                          type="text"
                          aria-label={`节点 ${index + 1} 权重`}
                          value={node.weight}
                          onChange={(e) =>
                            handleUpdateUpstreamNode(up.id, node.id, 'weight', e.target.value)
                          }
                          placeholder="weight (选填)"
                          className="w-full px-3 py-1.5 text-xs font-mono tabular-nums bg-white border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:border-slate-900"
                        />
                      </div>
                      <button
                        type="button"
                        disabled={up.nodes.length <= 1}
                        onClick={() => handleRemoveUpstreamNode(up.id, node.id)}
                        aria-label={`移除节点 ${index + 1}`}
                        className="p-1.5 text-slate-400 hover:text-red-600 disabled:opacity-30 cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 预览弹窗 */}
      {previewModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="preview-dialog-title"
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
        >
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-2xl overflow-hidden shadow-lg">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                {previewModal.valid ? (
                  <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                ) : (
                  <AlertTriangle className="w-5 h-5 text-red-600" />
                )}
                <h3 id="preview-dialog-title" className="text-sm font-semibold text-slate-900">
                  {previewModal.valid ? '语法校验通过 (nginx -t)' : '语法校验失败 (nginx -t)'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setPreviewModal(null)}
                aria-label="关闭预览弹窗"
                className="text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 space-y-4 max-h-[75vh] overflow-y-auto">
              <pre
                className={`text-xs font-mono p-3.5 rounded-lg border whitespace-pre-wrap ${
                  previewModal.valid
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                    : 'bg-red-50 border-red-200 text-red-900'
                }`}
              >
                {previewModal.output}
              </pre>

              <pre className="text-xs font-mono bg-slate-900 text-slate-100 p-4 rounded-lg overflow-x-auto leading-relaxed">
                {previewModal.generatedConfig}
              </pre>
            </div>

            <div className="px-6 py-3.5 bg-slate-50 border-t border-slate-200 flex justify-end">
              <button
                type="button"
                onClick={() => setPreviewModal(null)}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 加载备份弹窗 */}
      {showLoadBackupModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="load-backup-dialog-title"
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
        >
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-xl overflow-hidden shadow-lg">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 id="load-backup-dialog-title" className="text-sm font-semibold text-slate-900">
                加载历史备份 · {config.filename}
              </h3>
              <button
                type="button"
                onClick={() => setShowLoadBackupModal(false)}
                aria-label="关闭加载备份弹窗"
                className="text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 max-h-[65vh] overflow-y-auto">
              {fileBackups.length === 0 ? (
                <div className="text-center py-8 text-xs text-slate-500">
                  暂无历史备份
                </div>
              ) : (
                <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg">
                  {fileBackups.map((bk) => (
                    <div
                      key={bk.id}
                      className="p-3.5 flex items-center justify-between gap-4 hover:bg-slate-50"
                    >
                      <div>
                        <div className="text-xs font-mono font-medium text-slate-900">
                          {bk.backupName}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          {bk.label} · {new Date(bk.createdAt).toLocaleString()}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleSelectBackupToLoad(bk.id)}
                        className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        加载
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="px-6 py-3.5 bg-slate-50 border-t border-slate-200 flex justify-end">
              <button
                type="button"
                onClick={() => setShowLoadBackupModal(false)}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认弹窗 */}
      {showDeleteConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-cfg-dialog-title"
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
        >
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-sm overflow-hidden shadow-lg">
            <div className="px-6 py-4 border-b border-slate-200">
              <h3 id="delete-cfg-dialog-title" className="text-sm font-semibold text-slate-900">
                确认删除
              </h3>
            </div>
            <div className="p-6 text-xs text-slate-600">
              确定删除配置文件 <strong className="font-mono text-slate-900">{config.filename}</strong> 吗？
            </div>
            <div className="px-6 py-3.5 bg-slate-50 border-t border-slate-200 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(false)}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                onClick={async () => {
                  setShowDeleteConfirm(false);
                  await onDeleteConfig(config.filename);
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
