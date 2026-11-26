import React, { useState } from 'react';
import { Server, Lock, User, Terminal, ArrowRight, AlertCircle } from 'lucide-react';

interface LoginViewProps {
  onLogin: (params: {
    host: string;
    port: number;
    username: string;
    password: string;
  }) => Promise<void>;
  loading: boolean;
  error: string | null;
}

export const LoginView: React.FC<LoginViewProps> = ({ onLogin, loading, error }) => {
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    if (!host.trim()) {
      setLocalError('请输入目标主机 IP');
      return;
    }
    const portNum = Number(port || '22');
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      setLocalError('请输入有效端口（1-65535）');
      return;
    }
    if (!username.trim()) {
      setLocalError('请输入用户名');
      return;
    }
    if (!password.trim()) {
      setLocalError('请输入密码');
      return;
    }

    await onLogin({
      host: host.trim(),
      port: portNum,
      username: username.trim(),
      password,
    });
  };

  const displayError = localError || error;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center items-center px-4 py-12">
      <div className="w-full max-w-sm bg-white border border-slate-200 rounded-xl p-7">
        <div className="flex items-center gap-2.5 mb-6">
          <div className="w-8 h-8 rounded-lg bg-slate-900 text-white flex items-center justify-center">
            <Terminal className="w-4 h-4" />
          </div>
          <h1 className="text-base font-semibold text-slate-900 tracking-tight">
            Nginx 配置管理器
          </h1>
        </div>

        {displayError && (
          <div
            role="alert"
            className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 flex items-start gap-2 text-xs text-red-700"
          >
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <span>{displayError}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label
                htmlFor="ssh-host"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                主机 IP
              </label>
              <div className="relative">
                <Server className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="ssh-host"
                  type="text"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="192.168.10.42"
                  className="w-full pl-9 pr-3 py-2 text-sm font-mono bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-slate-900 transition-colors"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="ssh-port"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                端口
              </label>
              <input
                id="ssh-port"
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="22"
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-slate-900 transition-colors"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="ssh-username"
              className="block text-xs font-medium text-slate-700 mb-1.5"
            >
              用户名
            </label>
            <div className="relative">
              <User className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="ssh-username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="ubuntu"
                className="w-full pl-9 pr-3 py-2 text-sm font-mono bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-slate-900 transition-colors"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="ssh-password"
              className="block text-xs font-medium text-slate-700 mb-1.5"
            >
              密码
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="ssh-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="SSH 密码"
                className="w-full pl-9 pr-3 py-2 text-sm font-mono bg-white border border-slate-200 rounded-lg text-slate-900 focus:outline-none focus:border-slate-900 transition-colors"
              />
            </div>
          </div>

          <div className="pt-2">
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-400 text-white text-sm font-medium rounded-lg flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              <span>{loading ? '连接中...' : '连接'}</span>
              {!loading && <ArrowRight className="w-4 h-4" />}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
