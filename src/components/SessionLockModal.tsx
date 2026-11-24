import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Delete,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  LogOut,
  ShieldCheck,
} from 'lucide-react';
import { apiFetch } from '../lib/api.ts';
import { AuthUser } from '../types/erp.ts';
import { AvatarBadge } from './SettingsUserControlModule.tsx';

interface Props {
  user: AuthUser;
  firebaseEmail?: string | null;
  onUnlocked: (updatedUser: AuthUser) => void;
  onSwitchOperator: () => void;
}

export function SessionLockModal({ user, firebaseEmail, onUnlocked, onSwitchOperator }: Props) {
  const [unlockMode, setUnlockMode] = useState<'pin' | 'password'>(user.hasPin ? 'pin' : 'password');
  const [pin, setPin] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [capsLockOn, setCapsLockOn] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setUnlockMode(user.hasPin ? 'pin' : 'password');
    setPin('');
    setPassword('');
    setError('');
  }, [user.id, user.hasPin]);

  const canGoogleReverify = Boolean(
    firebaseEmail && firebaseEmail.trim().toLowerCase() === String(user.email || '').trim().toLowerCase(),
  );

  const submitPinUnlock = useCallback(async () => {
    if (pin.length < 4) {
      setError('Enter your 4–6 digit Shift PIN');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch<{ ok: boolean; user: AuthUser }>('/auth/unlock', {
        method: 'POST',
        body: JSON.stringify({ userId: user.id, mode: 'pin', secret: pin }),
      });
      setPin('');
      onUnlocked(res.user);
    } catch (err: any) {
      setPin('');
      setError(err?.message || 'Unable to unlock terminal');
    } finally {
      setLoading(false);
    }
  }, [pin, user.id, onUnlocked]);

  const submitPasswordUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) {
      setError('Enter your password to unlock');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch<{ ok: boolean; user: AuthUser }>('/auth/unlock', {
        method: 'POST',
        body: JSON.stringify({ userId: user.id, mode: 'password', secret: password }),
      });
      setPassword('');
      onUnlocked(res.user);
    } catch (err: any) {
      setError(err?.message || 'Unable to unlock terminal');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleUnlock = async () => {
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch<{ ok: boolean; user: AuthUser }>('/auth/unlock', {
        method: 'POST',
        body: JSON.stringify({ userId: user.id, mode: 'google' }),
      });
      onUnlocked(res.user);
    } catch (err: any) {
      setError(err?.message || 'Google verification failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (unlockMode !== 'pin' || loading) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) {
        e.preventDefault();
        setPin((prev) => (prev.length < 6 ? prev + e.key : prev));
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        setPin((prev) => prev.slice(0, -1));
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setPin('');
      } else if (e.key === 'Enter' && pin.length >= 4) {
        e.preventDefault();
        void submitPinUnlock();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [unlockMode, loading, pin, submitPinUnlock]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/75 backdrop-blur-md p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Terminal Locked"
    >
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 space-y-5 shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-4">
          <div className="flex items-center gap-3 min-w-0">
            <AvatarBadge name={user.fullName} src={user.avatarUrl} size="md" />
            <div className="min-w-0">
              <p className="text-[11px] font-mono uppercase tracking-wider text-amber-700 font-semibold flex items-center gap-1">
                <Lock className="w-3 h-3" /> Terminal Locked
              </p>
              <h2 className="font-display text-base font-semibold text-slate-900 truncate">{user.fullName}</h2>
              <p className="text-xs text-slate-500 truncate">{user.roleName}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onSwitchOperator}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <LogOut className="w-3.5 h-3.5" /> Switch Operator
          </button>
        </div>

        <p className="text-xs text-slate-600">
          Your open workspace tabs and unsaved register state are preserved. Re-verify to resume.
        </p>

        {user.hasPin && (
          <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-slate-100 border border-slate-200">
            <button
              type="button"
              onClick={() => {
                setError('');
                setUnlockMode('pin');
              }}
              className={`rounded-lg py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                unlockMode === 'pin' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Shift PIN
            </button>
            <button
              type="button"
              onClick={() => {
                setError('');
                setUnlockMode('password');
              }}
              className={`rounded-lg py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                unlockMode === 'password' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Password
            </button>
          </div>
        )}

        {error && (
          <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {unlockMode === 'pin' ? (
          <div className="space-y-3">
            <div className="grid grid-cols-6 gap-2">
              {[0, 1, 2, 3, 4, 5].map((idx) => (
                <div
                  key={idx}
                  className={`h-10 rounded-lg border flex items-center justify-center font-mono text-lg font-bold ${
                    idx < pin.length
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-200 bg-slate-50 text-slate-300'
                  }`}
                >
                  {idx < pin.length ? '•' : '–'}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
                <button
                  key={digit}
                  type="button"
                  disabled={loading}
                  onClick={() => setPin((prev) => (prev.length < 6 ? prev + digit : prev))}
                  className="h-11 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 font-mono tabular-nums text-base font-semibold text-slate-900"
                >
                  {digit}
                </button>
              ))}
              <button
                type="button"
                disabled={loading || pin.length === 0}
                onClick={() => setPin('')}
                className="h-11 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 text-xs font-semibold text-slate-600 disabled:opacity-40"
              >
                Clear
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={() => setPin((prev) => (prev.length < 6 ? prev + '0' : prev))}
                className="h-11 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 font-mono tabular-nums text-base font-semibold text-slate-900"
              >
                0
              </button>
              <button
                type="button"
                disabled={loading || pin.length === 0}
                onClick={() => setPin((prev) => prev.slice(0, -1))}
                aria-label="Backspace"
                className="h-11 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 flex items-center justify-center text-slate-700 disabled:opacity-40"
              >
                <Delete className="w-4 h-4" />
              </button>
            </div>
            <button
              type="button"
              disabled={loading || pin.length < 4}
              onClick={submitPinUnlock}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
            >
              <KeyRound className="w-4 h-4" />
              {loading ? 'Unlocking...' : 'Unlock with Shift PIN'}
            </button>
          </div>
        ) : (
          <form onSubmit={submitPasswordUnlock} className="space-y-3">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-medium text-slate-700">Account Password</label>
                {capsLockOn && <span className="text-[11px] font-medium text-amber-700">Caps Lock is ON</span>}
              </div>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoFocus
                  placeholder="Enter password to unlock"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => typeof e.getModifierState === 'function' && setCapsLockOn(e.getModifierState('CapsLock'))}
                  onKeyUp={(e) => typeof e.getModifierState === 'function' && setCapsLockOn(e.getModifierState('CapsLock'))}
                  className="w-full rounded-lg border border-slate-300 pl-3.5 pr-10 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded text-slate-400 hover:text-slate-700"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
            >
              <Lock className="w-4 h-4" />
              {loading ? 'Unlocking...' : 'Unlock Terminal'}
            </button>
          </form>
        )}

        {canGoogleReverify && (
          <button
            type="button"
            disabled={loading}
            onClick={handleGoogleUnlock}
            className="w-full flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 px-3 py-2 text-xs font-medium text-slate-700"
          >
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
            Verify with Google ({firebaseEmail})
          </button>
        )}
      </div>
    </div>
  );
}
