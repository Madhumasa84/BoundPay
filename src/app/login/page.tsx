'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, AlertCircle, Shield, Key } from 'lucide-react';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('operator');
  const [password, setPassword] = useState('BoundPayPass123!');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Login failed');
      }

      router.push('/shop');
      router.refresh();
    } catch (err: any) {
      setError(err.message || 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-md mx-auto mt-14 px-4">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200/90 overflow-hidden">
        <div className="bg-slate-900 text-white p-7 text-center relative overflow-hidden">
          <div className="absolute inset-0 bg-radial from-blue-500/10 via-transparent to-transparent opacity-50" />
          <div className="relative z-10">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-blue-500/10 text-blue-400 mb-3 border border-blue-500/20 shadow-inner">
              <Lock className="w-5 h-5" />
            </div>
            <h1 className="text-lg font-bold tracking-tight text-white">Operator Authentication</h1>
            <p className="text-xs text-slate-400 mt-1 max-w-xs mx-auto leading-relaxed">
              Sign in to access spending policy, approval controls, and audit trails.
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 sm:p-7 space-y-4">
          {error && (
            <div className="p-3 rounded-xl bg-rose-50 border border-rose-200/80 text-rose-800 text-xs flex items-start space-x-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0 text-rose-600 mt-0.5" />
              <span className="font-medium">{error}</span>
            </div>
          )}

          <div className="space-y-1.5">
            <label htmlFor="operator-username" className="block text-xs font-semibold uppercase tracking-wider text-slate-700">
              Operator Username
            </label>
            <input
              type="text"
              id="operator-username"
              autoComplete="username"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-3.5 py-2.5 border border-slate-200/90 rounded-xl shadow-2xs focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 text-xs text-slate-900 bg-white placeholder-slate-400 transition"
              placeholder="e.g. operator"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="operator-password" className="block text-xs font-semibold uppercase tracking-wider text-slate-700">
              Password
            </label>
            <input
              type="password"
              id="operator-password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3.5 py-2.5 border border-slate-200/90 rounded-xl shadow-2xs focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 text-xs text-slate-900 bg-white placeholder-slate-400 transition font-mono"
              placeholder="••••••••••••"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full mt-2 py-2.5 px-4 rounded-xl font-semibold text-white bg-blue-600 hover:bg-blue-500 active:scale-[0.99] focus:outline-none focus:ring-2 focus:ring-blue-500/40 transition shadow-sm shadow-blue-600/20 disabled:opacity-50 text-xs cursor-pointer"
          >
            {loading ? 'Authenticating...' : 'Sign In as Operator'}
          </button>

          <div className="mt-6 pt-5 border-t border-slate-100 text-xs text-slate-500 space-y-2.5">
            <div className="flex items-center space-x-1.5 text-slate-700 font-medium text-xs">
              <Key className="w-3.5 h-3.5 text-slate-400" />
              <span>Default Seed Credentials</span>
            </div>
            <div className="bg-slate-50/80 p-3 rounded-xl border border-slate-200/80 font-mono text-[11px] text-slate-600 space-y-1">
              <div>Username: <span className="text-blue-700 font-semibold select-all">operator</span></div>
              <div>Password: <span className="text-blue-700 font-semibold select-all">BoundPayPass123!</span></div>
            </div>
            <div className="flex items-center space-x-1.5 text-slate-400 text-[11px] pt-1">
              <Shield className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
              <span>HttpOnly Session Cookies &bull; Throttled Login &bull; Server-Verified</span>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
