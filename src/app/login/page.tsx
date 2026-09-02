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
    <div className="max-w-md mx-auto mt-12">
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="bg-slate-900 text-white p-6 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-blue-600/20 text-blue-400 mb-3 border border-blue-500/30">
            <Lock className="w-6 h-6" />
          </div>
          <h1 className="text-xl font-bold">Operator Authentication</h1>
          <p className="text-xs text-slate-400 mt-1">
            Sign in to access spending policy, approval controls, and audit trails.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm flex items-start space-x-2">
              <AlertCircle className="w-5 h-5 flex-shrink-0 text-red-500 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <div>
            <label htmlFor="operator-username" className="block text-xs font-semibold uppercase tracking-wider text-slate-700 mb-1">
              Operator Username
            </label>
            <input
              type="text"
              id="operator-username"
              autoComplete="username"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
              placeholder="e.g. operator"
            />
          </div>

          <div>
            <label htmlFor="operator-password" className="block text-xs font-semibold uppercase tracking-wider text-slate-700 mb-1">
              Password
            </label>
            <input
              type="password"
              id="operator-password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
              placeholder="••••••••••••"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 px-4 rounded-md font-medium text-white bg-blue-600 hover:bg-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors disabled:opacity-50 text-sm"
          >
            {loading ? 'Authenticating...' : 'Sign In as Operator'}
          </button>

          <div className="mt-6 pt-4 border-t border-slate-100 text-xs text-slate-500 space-y-2">
            <div className="flex items-center space-x-1.5 text-slate-700 font-medium">
              <Key className="w-3.5 h-3.5 text-slate-500" />
              <span>Default Seed Credentials</span>
            </div>
            <div className="bg-slate-50 p-2.5 rounded border border-slate-200 font-mono text-[11px] text-slate-600">
              Username: <span className="text-blue-700 font-semibold">operator</span><br />
              Password: <span className="text-blue-700 font-semibold">BoundPayPass123!</span>
            </div>
            <div className="flex items-center space-x-1 text-slate-400 text-[11px]">
              <Shield className="w-3 h-3 text-emerald-600" />
              <span>HttpOnly Session Cookies &bull; Throttled Login &bull; Server-Verified</span>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
