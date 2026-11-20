import React, { useEffect, useState } from 'react';
import { Lock, ArrowRight } from 'lucide-react';
import { apiFetch, setAuthToken } from '../lib/api.ts';
import { AuthUser } from '../types/erp.ts';
import { AvatarBadge } from './SettingsUserControlModule.tsx';

interface Props {
  onAuthenticated: (user: AuthUser) => void;
}

export function LoginView({ onAuthenticated }: Props) {
  const [email, setEmail] = useState('owner@maximusbbq.ph');
  const [password, setPassword] = useState('erp2026!');
  const [demoAccounts, setDemoAccounts] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('/api/v1/auth/demo-accounts')
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setDemoAccounts(data);
      })
      .catch(() => {});
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch<{ token: string; user: AuthUser }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      setAuthToken(res.token);
      onAuthenticated(res.user);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleQuickRole = async (userId: string) => {
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch<{ token: string; user: AuthUser }>('/auth/demo-switch', {
        method: 'POST',
        body: JSON.stringify({ userId }),
      });
      setAuthToken(res.token);
      onAuthenticated(res.user);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="w-full max-w-4xl grid grid-cols-1 lg:grid-cols-2 bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-8 lg:p-10 flex flex-col justify-between bg-slate-900 text-white">
          <div>
            <div className="flex items-center gap-3">
              <img
                src="/assets/aistudio/Logo_836b4628.png"
                alt="Maximus Barbecue Logo"
                referrerPolicy="no-referrer"
                className="w-12 h-12 rounded-full object-contain shrink-0 bg-white/10 p-0.5"
              />
              <span className="font-display font-bold text-lg tracking-tight text-white">Maximus Barbecue ERP</span>
            </div>
            <h1 className="mt-8 font-display text-3xl font-bold tracking-tight leading-tight text-balance">
              Unified Operations for Multi-Truck Food Businesses
            </h1>
            <p className="mt-4 text-sm text-slate-300 leading-relaxed">
              Real-time POS with offline queuing, BOM recipe deduction, FIFO batch inventory, supplier procurement, double-entry accounting, food costing, and Philippine payroll in one relational platform.
            </p>
          </div>
          <div className="mt-8 pt-6 border-t border-slate-800 text-xs text-slate-400 space-y-1">
            <p>Multi-Truck Commissary &amp; Fleet Architecture</p>
            <p>Configurable VAT / Percentage Tax &amp; Statutory Rules</p>
          </div>
        </div>

        <div className="p-8 lg:p-10 space-y-6">
          <div>
            <h2 className="font-display text-xl font-semibold text-slate-900">Sign in to Workspace</h2>
            <p className="mt-1 text-sm text-slate-500">Enter your credentials or select a seeded role to test RBAC controls.</p>
          </div>

          {error && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
              {error}
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Work Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Password</label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <Lock className="w-4 h-4" />
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>

          {demoAccounts.length > 0 && (
            <div className="pt-5 border-t border-slate-200">
              <p className="text-xs font-medium text-slate-500 mb-2.5">Quick Role Access (Seeded RBAC Accounts)</p>
              <div className="space-y-1.5">
                {demoAccounts.map((acc) => (
                  <button
                    key={acc.id}
                    type="button"
                    disabled={loading}
                    onClick={() => handleQuickRole(acc.id)}
                    className="w-full flex items-center justify-between px-3 py-2 rounded-lg border border-slate-200 text-left text-xs hover:bg-slate-50 transition-colors"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <AvatarBadge name={acc.full_name} src={acc.avatar_url} size="sm" />
                      <div className="truncate">
                        <span className="font-medium text-slate-900">{acc.full_name}</span>
                        <span className="mx-1.5 text-slate-300">·</span>
                        <span className="text-slate-500">{acc.role_name}</span>
                      </div>
                    </div>
                    <ArrowRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
