import React, { useState } from 'react';
import {
  Plus,
  Upload,
  FileText,
  Trash2,
  Eye,
  X,
  AlertTriangle,
  CheckCircle2,
  Rocket,
} from 'lucide-react';
import { CertificateRecord } from '../types';

interface CertificatesModuleProps {
  certificates: CertificateRecord[];
  onAddCertificate: (payload: {
    name: string;
    domains: string[];
    expiresAt: string;
    certContent: string;
    keyContent: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  onDeleteCertificate: (
    id: string,
    force?: boolean
  ) => Promise<{
    ok: boolean;
    error?: string;
    requiresConfirmation?: boolean;
    referencedBy?: string[];
  }>;
  onApplyAll: () => Promise<{ ok: boolean; message?: string; error?: string }>;
}

const DEMO_PEM_CERT = `-----BEGIN CERTIFICATE-----
MIIDXTCCAkWgAwIBAgIJALc1h9z4M3dQMA0GCSqGSIb3DQEBCwUAMEUxCzAJBgNV
BAYTAkNOMRMwEQYDVQQIDApSome-StateMSEwHwYDVQQKDBhJbnRlcm5hbCBDb3Jw
b3JhdGlvbiBDQTAeFw0yNjAzMDEwMDAwMDBaFw0yODA1MjAyMzU5NTlaMBsxGTAX
BgNVBAMTEHBheW1lbnQubG9jYWwuaW8wggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAw
-----END CERTIFICATE-----`;

const DEMO_PEM_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQD9XLVwv1Wu0eMl
ObGhaAkkyC6T6/O4dU3+hYKeRo37C8oR3x9aJ0E0m4b1xZ2N5oRsY4zP9dX0eS3T
-----END PRIVATE KEY-----`;

export const CertificatesModule: React.FC<CertificatesModuleProps> = ({
  certificates,
  onAddCertificate,
  onDeleteCertificate,
  onApplyAll,
}) => {
  const [showAddModal, setShowAddModal] = useState(false);
  const [inputMode, setInputMode] = useState<'paste' | 'upload'>('paste');
  const [certName, setCertName] = useState('');
  const [domainsText, setDomainsText] = useState('');
  const [expiresAt, setExpiresAt] = useState('2028-05-20');
  const [certContent, setCertContent] = useState('');
  const [keyContent, setKeyContent] = useState('');
  const [certFileName, setCertFileName] = useState('');
  const [keyFileName, setKeyFileName] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [viewingCert, setViewingCert] = useState<CertificateRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CertificateRecord | null>(null);
  const [banner, setBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [applying, setApplying] = useState(false);

  const stagedCount = certificates.filter((c) => c.syncStatus === 'staged').length;

  const handleFileRead = (
    file: File | undefined,
    type: 'cert' | 'key'
  ) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result || '');
      if (type === 'cert') {
        setCertContent(content);
        setCertFileName(file.name);
        if (!certName) {
          setCertName(file.name.replace(/\.(crt|pem)$/i, ''));
        }
      } else {
        setKeyContent(content);
        setKeyFileName(file.name);
      }
    };
    reader.readAsText(file);
  };

  const handleFillExamplePem = () => {
    setCertName('payment.internal.io');
    setDomainsText('payment.internal.io');
    setExpiresAt('2028-05-20');
    setCertContent(DEMO_PEM_CERT);
    setKeyContent(DEMO_PEM_KEY);
    setFormError(null);
  };

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!certName.trim()) {
      setFormError('请输入证书名称');
      return;
    }
    if (!certContent.trim()) {
      setFormError('请提供公钥证书内容');
      return;
    }
    if (!keyContent.trim()) {
      setFormError('请提供私钥内容');
      return;
    }

    const domains = domainsText
      .split(/[,;\s]+/)
      .map((d) => d.trim())
      .filter(Boolean);

    setSubmitting(true);
    try {
      const res = await onAddCertificate({
        name: certName.trim(),
        domains: domains.length > 0 ? domains : [certName.trim()],
        expiresAt: expiresAt || '2028-05-20',
        certContent: certContent.trim(),
        keyContent: keyContent.trim(),
      });

      if (!res.ok) {
        setFormError(res.error || '添加证书失败');
      } else {
        setShowAddModal(false);
        setBanner({
          type: 'success',
          text: `已保存证书 ${certName.trim()}（待生效）`,
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);

    const res = await onDeleteCertificate(target.id, true);
    if (res.ok) {
      setBanner({
        type: 'success',
        text: `已移除证书 ${target.certFilename}`,
      });
    } else {
      setBanner({
        type: 'error',
        text: res.error || '删除证书失败',
      });
    }
  };

  const handleApplyCertificates = async () => {
    setApplying(true);
    setBanner(null);
    try {
      const res = await onApplyAll();
      if (res.ok) {
        setBanner({
          type: 'success',
          text: res.message || '已生效并重载',
        });
      } else {
        setBanner({
          type: 'error',
          text: res.error || '语法校验未通过',
        });
      }
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="bg-white border border-slate-200 rounded-xl px-6 py-4 flex items-center justify-between gap-4">
        <h2 className="text-base font-semibold text-slate-900">证书列表</h2>

        <div className="flex items-center gap-2.5">
          {stagedCount > 0 && (
            <button
              type="button"
              disabled={applying}
              onClick={handleApplyCertificates}
              className="px-3.5 py-2 text-xs font-medium text-slate-900 bg-amber-100 border border-amber-300 rounded-lg hover:bg-amber-200 disabled:opacity-50 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Rocket className="w-3.5 h-3.5" />
              <span>{applying ? '生效中...' : `生效 (${stagedCount})`}</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              setCertName('');
              setDomainsText('');
              setExpiresAt('2028-05-20');
              setCertContent('');
              setKeyContent('');
              setCertFileName('');
              setKeyFileName('');
              setFormError(null);
              setShowAddModal(true);
            }}
            className="px-3.5 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>新增证书</span>
          </button>
        </div>
      </div>

      {banner && (
        <div
          role="status"
          className={`px-4 py-3 rounded-xl border flex items-start justify-between gap-3 text-xs ${
            banner.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-red-50 border-red-200 text-red-900'
          }`}
        >
          <div className="flex items-start gap-2">
            {banner.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            )}
            <span>{banner.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setBanner(null)}
            aria-label="关闭通知"
            className="text-slate-500 hover:text-slate-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-semibold text-slate-600 whitespace-nowrap">
                <th className="py-3.5 px-6">证书文件</th>
                <th className="py-3.5 px-4">关联域名</th>
                <th className="py-3.5 px-4">过期时间</th>
                <th className="py-3.5 px-4">引用配置</th>
                <th className="py-3.5 px-4">状态</th>
                <th className="py-3.5 px-6 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {certificates.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-xs text-slate-500">
                    暂无证书
                  </td>
                </tr>
              ) : (
                certificates.map((cert) => (
                  <tr key={cert.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-3.5 px-6 whitespace-nowrap font-mono font-medium text-slate-900 text-xs">
                      {cert.certFilename}
                    </td>

                    <td className="py-3.5 px-4 font-mono text-xs text-slate-800 whitespace-nowrap">
                      {cert.domains.join(', ')}
                    </td>

                    <td className="py-3.5 px-4 font-mono tabular-nums text-xs text-slate-700 whitespace-nowrap">
                      {cert.expiresAt}
                    </td>

                    <td className="py-3.5 px-4 text-xs font-mono text-slate-600 whitespace-nowrap">
                      {cert.referencedBy.length > 0
                        ? cert.referencedBy.join(', ')
                        : '-'}
                    </td>

                    <td className="py-3.5 px-4 text-xs whitespace-nowrap">
                      {cert.syncStatus === 'synced' ? (
                        <span className="text-emerald-700 font-medium">已同步</span>
                      ) : (
                        <span className="text-amber-700 font-medium">待生效</span>
                      )}
                    </td>

                    <td className="py-3.5 px-6 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => setViewingCert(cert)}
                          className="text-xs font-medium text-slate-900 hover:underline inline-flex items-center gap-1 cursor-pointer"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          <span>查看</span>
                        </button>
                        <span className="text-slate-300">|</span>
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(cert)}
                          aria-label={`删除证书 ${cert.name}`}
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

      {/* Add Modal */}
      {showAddModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-cert-dialog-title"
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
        >
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-xl overflow-hidden shadow-lg">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 id="add-cert-dialog-title" className="text-sm font-semibold text-slate-900">
                新增 / 更新证书
              </h3>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                aria-label="关闭新增证书弹窗"
                className="text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form
              onSubmit={handleAddSubmit}
              className="p-6 space-y-4 max-h-[75vh] overflow-y-auto"
            >
              {formError && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                  {formError}
                </div>
              )}

              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                  <button
                    type="button"
                    onClick={() => setInputMode('paste')}
                    className={`px-3 py-1 text-xs font-medium rounded-md flex items-center gap-1.5 transition-colors cursor-pointer ${
                      inputMode === 'paste'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <FileText className="w-3.5 h-3.5" />
                    <span>粘贴文本</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setInputMode('upload')}
                    className={`px-3 py-1 text-xs font-medium rounded-md flex items-center gap-1.5 transition-colors cursor-pointer ${
                      inputMode === 'upload'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <Upload className="w-3.5 h-3.5" />
                    <span>上传文件</span>
                  </button>
                </div>

                <button
                  type="button"
                  onClick={handleFillExamplePem}
                  className="text-xs font-medium text-slate-600 hover:text-slate-900 underline cursor-pointer"
                >
                  填入示例
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label
                    htmlFor="cert-name-input"
                    className="block text-xs font-medium text-slate-700 mb-1"
                  >
                    证书名称
                  </label>
                  <input
                    id="cert-name-input"
                    type="text"
                    value={certName}
                    onChange={(e) => setCertName(e.target.value)}
                    placeholder="example.com"
                    className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-slate-900"
                  />
                </div>

                <div>
                  <label
                    htmlFor="cert-domains-input"
                    className="block text-xs font-medium text-slate-700 mb-1"
                  >
                    关联域名
                  </label>
                  <input
                    id="cert-domains-input"
                    type="text"
                    value={domainsText}
                    onChange={(e) => setDomainsText(e.target.value)}
                    placeholder="example.com"
                    className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-slate-900"
                  />
                </div>

                <div>
                  <label
                    htmlFor="cert-expiry-input"
                    className="block text-xs font-medium text-slate-700 mb-1"
                  >
                    过期时间
                  </label>
                  <input
                    id="cert-expiry-input"
                    type="date"
                    value={expiresAt}
                    onChange={(e) => setExpiresAt(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-slate-900"
                  />
                </div>
              </div>

              {inputMode === 'upload' ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="p-3.5 border border-dashed border-slate-300 rounded-lg bg-slate-50">
                    <label
                      htmlFor="cert-file-upload"
                      className="block text-xs font-medium text-slate-700 mb-2"
                    >
                      公钥文件 (.pem / .crt)
                    </label>
                    <input
                      id="cert-file-upload"
                      type="file"
                      accept=".pem,.crt,.cer"
                      onChange={(e) => handleFileRead(e.target.files?.[0], 'cert')}
                      className="text-xs text-slate-600 file:mr-3 file:py-1 file:px-2.5 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-slate-900 file:text-white"
                    />
                    {certFileName && (
                      <div className="mt-1.5 text-xs font-mono text-emerald-700">
                        {certFileName}
                      </div>
                    )}
                  </div>

                  <div className="p-3.5 border border-dashed border-slate-300 rounded-lg bg-slate-50">
                    <label
                      htmlFor="key-file-upload"
                      className="block text-xs font-medium text-slate-700 mb-2"
                    >
                      私钥文件 (.key)
                    </label>
                    <input
                      id="key-file-upload"
                      type="file"
                      accept=".key,.pem"
                      onChange={(e) => handleFileRead(e.target.files?.[0], 'key')}
                      className="text-xs text-slate-600 file:mr-3 file:py-1 file:px-2.5 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-slate-900 file:text-white"
                    />
                    {keyFileName && (
                      <div className="mt-1.5 text-xs font-mono text-emerald-700">
                        {keyFileName}
                      </div>
                    )}
                  </div>
                </div>
              ) : null}

              <div>
                <label
                  htmlFor="cert-pem-textarea"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  公钥内容 (.crt / .pem)
                </label>
                <textarea
                  id="cert-pem-textarea"
                  rows={4}
                  value={certContent}
                  onChange={(e) => setCertContent(e.target.value)}
                  placeholder="-----BEGIN CERTIFICATE-----"
                  className="w-full p-3 text-xs font-mono bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-slate-900"
                />
              </div>

              <div>
                <label
                  htmlFor="key-pem-textarea"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  私钥内容 (.key)
                </label>
                <textarea
                  id="key-pem-textarea"
                  rows={4}
                  value={keyContent}
                  onChange={(e) => setKeyContent(e.target.value)}
                  placeholder="-----BEGIN PRIVATE KEY-----"
                  className="w-full p-3 text-xs font-mono bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-slate-900"
                />
              </div>

              <div className="pt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
                >
                  {submitting ? '保存中...' : '保存'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* View Certificate Modal */}
      {viewingCert && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="view-cert-dialog-title"
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
        >
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-2xl overflow-hidden shadow-lg">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 id="view-cert-dialog-title" className="text-sm font-semibold text-slate-900 font-mono">
                {viewingCert.certFilename}
              </h3>
              <button
                type="button"
                onClick={() => setViewingCert(null)}
                aria-label="关闭证书详情弹窗"
                className="text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
              <div>
                <div className="text-xs font-mono text-slate-600 mb-1">
                  {viewingCert.certPath}
                </div>
                <pre className="text-xs font-mono bg-slate-900 text-slate-100 p-3.5 rounded-lg overflow-x-auto">
                  {viewingCert.certContent}
                </pre>
              </div>

              <div>
                <div className="text-xs font-mono text-slate-600 mb-1">
                  {viewingCert.keyPath}
                </div>
                <pre className="text-xs font-mono bg-slate-900 text-slate-100 p-3.5 rounded-lg overflow-x-auto">
                  {viewingCert.keyContent}
                </pre>
              </div>
            </div>

            <div className="px-6 py-3.5 bg-slate-50 border-t border-slate-200 flex justify-end">
              <button
                type="button"
                onClick={() => setViewingCert(null)}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Certificate Confirmation */}
      {deleteTarget && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="del-cert-dialog-title"
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
        >
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-sm overflow-hidden shadow-lg">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center gap-2">
              {deleteTarget.referencedBy.length > 0 && (
                <AlertTriangle className="w-4 h-4 text-amber-600" />
              )}
              <h3 id="del-cert-dialog-title" className="text-sm font-semibold text-slate-900">
                确认删除证书
              </h3>
            </div>

            <div className="p-6 text-xs text-slate-600 leading-relaxed space-y-3">
              <p>
                确定删除证书 <strong className="font-mono text-slate-900">{deleteTarget.certFilename}</strong> 吗？
              </p>

              {deleteTarget.referencedBy.length > 0 && (
                <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-900">
                  正被配置 <span className="font-mono font-semibold">{deleteTarget.referencedBy.join(', ')}</span> 引用。
                </div>
              )}
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
                onClick={handleConfirmDelete}
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
