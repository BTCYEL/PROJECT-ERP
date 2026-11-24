import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Delete,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  LogOut,
  Mail,
  MapPin,
  ScanFace,
  ShieldCheck,
} from 'lucide-react';
import { signInWithPopup, signOut, User } from 'firebase/auth';
import { auth, googleProvider } from '../lib/firebase.ts';
import { apiFetch } from '../lib/api.ts';
import {
  resetFirebaseSyncCache,
  setActiveErpUserId,
  setSignedOutSession,
  syncFirebaseUserAndSeed,
} from '../lib/firestoreErp.ts';
import { AuthUser, LocationRow } from '../types/erp.ts';
import { AvatarBadge } from './SettingsUserControlModule.tsx';
import { FaceAttendanceKioskModal } from './FaceAttendanceKioskModal.tsx';

interface Props {
  firebaseUser: User | null;
  onAuthenticated: (user: AuthUser) => void;
}

interface OperatorSummary {
  id: string;
  full_name: string;
  avatar_url?: string | null;
  role_code: string;
  role_name: string;
  assigned_location_id?: string | null;
  has_pin: boolean;
  is_locked: boolean;
  locked_until?: string | null;
  is_google_owner?: boolean;
}

export function LoginView({ firebaseUser, onAuthenticated }: Props) {
  const [authTab, setAuthTab] = useState<'password' | 'pin'>('password');

  // Password form state (strictly empty initial inputs)
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [capsLockOn, setCapsLockOn] = useState(false);

  // Operator & Shift PIN state
  const [operators, setOperators] = useState<OperatorSummary[]>([]);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [pinLocationFilter, setPinLocationFilter] = useState<string>('ALL');
  const [selectedOperatorId, setSelectedOperatorId] = useState<string>('');
  const [pin, setPin] = useState('');

  // Pre-login Attendance Kiosk state
  const [showKiosk, setShowKiosk] = useState(false);
  const [kioskData, setKioskData] = useState<{ employees: any[]; attendance: any[] }>({
    employees: [],
    attendance: [],
  });

  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const loadLoginMetadata = useCallback(async () => {
    const [ops, locs] = await Promise.all([
      apiFetch<OperatorSummary[]>('/auth/operators'),
      apiFetch<LocationRow[]>('/locations').catch(() => [] as LocationRow[]),
    ]);
    setOperators(Array.isArray(ops) ? ops : []);
    setLocations(Array.isArray(locs) ? locs : []);
  }, []);

  useEffect(() => {
    if (!firebaseUser) {
      setOperators([]);
      setLocations([]);
      setSelectedOperatorId('');
      setPin('');
      return;
    }
    let cancelled = false;
    syncFirebaseUserAndSeed(firebaseUser)
      .then(() => Promise.all([
        apiFetch<OperatorSummary[]>('/auth/operators'),
        apiFetch<LocationRow[]>('/locations').catch(() => [] as LocationRow[]),
      ]))
      .then(([ops, locs]) => {
        if (cancelled) return;
        const list = Array.isArray(ops) ? ops : [];
        setOperators(list);
        setLocations(Array.isArray(locs) ? locs : []);
        const visiblePinOps = list.filter((o) => !(o.is_google_owner && !o.has_pin));
        const firstPinOp = visiblePinOps.find((o) => o.has_pin && !o.is_locked) || visiblePinOps[0];
        if (firstPinOp) {
          setSelectedOperatorId((prev) => prev || firstPinOp.id);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || 'Unable to load workspace operators');
      });
    return () => {
      cancelled = true;
    };
  }, [firebaseUser]);

  const filteredOperators = useMemo(() => {
    const visible = operators.filter((op) => !(op.is_google_owner && !op.has_pin));
    if (pinLocationFilter === 'ALL') return visible;
    return visible.filter(
      (op) => !op.assigned_location_id || op.assigned_location_id === pinLocationFilter,
    );
  }, [operators, pinLocationFilter]);

  useEffect(() => {
    if (!filteredOperators.length) {
      setSelectedOperatorId('');
      return;
    }
    if (!filteredOperators.some((o) => o.id === selectedOperatorId)) {
      const preferred = filteredOperators.find((o) => o.has_pin && !o.is_locked) || filteredOperators[0];
      setSelectedOperatorId(preferred.id);
    }
  }, [filteredOperators, selectedOperatorId]);

  const selectedOperator = useMemo(
    () => filteredOperators.find((o) => o.id === selectedOperatorId) || null,
    [filteredOperators, selectedOperatorId],
  );

  const anyOperatorHasPin = useMemo(
    () => operators.some((o) => o.has_pin),
    [operators],
  );

  const handleGoogleSignIn = async () => {
    setError('');
    setLoading(true);
    try {
      setSignedOutSession(false);
      setActiveErpUserId(null);
      resetFirebaseSyncCache();
      const cred = await signInWithPopup(auth, googleProvider);
      await syncFirebaseUserAndSeed(cred.user);
      const user = await apiFetch<AuthUser>('/auth/me');
      onAuthenticated(user);
    } catch (err: any) {
      setError(err?.message || 'Google sign-in was cancelled or failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleDisconnect = async () => {
    setError('');
    setLoading(true);
    try {
      setActiveErpUserId(null);
      setSignedOutSession(false);
      resetFirebaseSyncCache();
      await signOut(auth);
    } catch (err: any) {
      setError(err?.message || 'Unable to sign out of Google');
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch<{ token: string; user: AuthUser }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      setPassword('');
      onAuthenticated(res.user);
    } catch (err: any) {
      setError(err?.message || 'Sign in failed');
      await loadLoginMetadata().catch(() => {});
    } finally {
      setLoading(false);
    }
  };

  const submitPinLogin = useCallback(async () => {
    if (!selectedOperatorId) {
      setError('Select an operator first');
      return;
    }
    if (pin.length < 4) {
      setError('Enter your 4 to 6 digit Shift PIN');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch<{ token: string; user: AuthUser }>('/auth/pin-login', {
        method: 'POST',
        body: JSON.stringify({ userId: selectedOperatorId, pin }),
      });
      setPin('');
      onAuthenticated(res.user);
    } catch (err: any) {
      setPin('');
      setError(err?.message || 'Shift PIN login failed');
      await loadLoginMetadata().catch(() => {});
    } finally {
      setLoading(false);
    }
  }, [selectedOperatorId, pin, onAuthenticated, loadLoginMetadata]);

  // Physical keyboard numeric support on Shift PIN tab
  useEffect(() => {
    if (!firebaseUser || authTab !== 'pin' || showKiosk || loading) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (/^\d$/.test(e.key)) {
        e.preventDefault();
        setPin((prev) => (prev.length < 6 ? prev + e.key : prev));
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        setPin((prev) => prev.slice(0, -1));
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setPin('');
      } else if (e.key === 'Enter' && pin.length >= 4 && selectedOperator?.has_pin && !selectedOperator?.is_locked) {
        e.preventDefault();
        void submitPinLogin();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [firebaseUser, authTab, showKiosk, loading, pin, selectedOperator, submitPinLogin]);

  const loadKiosk = async () => {
    try {
      const [res, locs] = await Promise.all([
        apiFetch<{ employees: any[]; attendance: any[] }>('/attendance/kiosk'),
        locations.length ? Promise.resolve(locations) : apiFetch<LocationRow[]>('/locations').catch(() => [] as LocationRow[]),
      ]);
      setKioskData(res);
      if (Array.isArray(locs) && locs.length) setLocations(locs);
    } catch (err: any) {
      setError(err?.message || 'Unable to load crew attendance roster');
    }
  };

  const openPreLoginKiosk = async () => {
    setError('');
    setShowKiosk(true);
    await loadKiosk();
  };

  const handlePasswordKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (typeof e.getModifierState === 'function') {
      setCapsLockOn(e.getModifierState('CapsLock'));
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-5xl grid grid-cols-1 lg:grid-cols-12 bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
        {/* Brand & Security Architecture Column */}
        <div className="lg:col-span-5 p-8 lg:p-10 flex flex-col justify-between bg-slate-900 text-white">
          <div>
            <div className="flex items-center gap-3">
              <img
                src="/assets/aistudio/Logo_836b4628.png"
                alt="Maximus Barbecue Logo"
                referrerPolicy="no-referrer"
                className="w-11 h-11 rounded-full object-contain shrink-0 bg-white/10 p-0.5"
              />
              <div>
                <span className="font-display font-bold text-base tracking-tight text-white block">
                  Maximus Barbecue ERP
                </span>
                <span className="text-[11px] text-slate-400 font-mono">TRUCK &amp; COMMISSARY TERMINAL</span>
              </div>
            </div>

            <h1 className="mt-8 font-display text-2xl sm:text-3xl font-bold tracking-tight leading-tight text-balance">
              Operations Access for Food Trucks &amp; Commissary
            </h1>
            <p className="mt-3 text-sm text-slate-300 leading-relaxed">
              POS order capture, kitchen display routing, FIFO batch inventory, procurement, and Philippine payroll secured per operator role.
            </p>
          </div>

          <div className="mt-8 pt-6 border-t border-slate-800 space-y-3 text-xs text-slate-300">
            <div className="flex items-start gap-2.5">
              <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-white">Credentialed RBAC &amp; Lockout Protection</p>
                <p className="text-slate-400">5 failed password or Shift PIN attempts trigger a 5-minute security lock logged to Audit Trail.</p>
              </div>
            </div>
            <div className="flex items-start gap-2.5">
              <KeyRound className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-white">Truck Operator Shift PIN &amp; Auto-Lock</p>
                <p className="text-slate-400">Fast counter sign-in with hashed 4–6 digit PINs and automatic terminal idle locking.</p>
              </div>
            </div>
            <div className="flex items-start gap-2.5">
              <ScanFace className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-white">Pre-Shift Face ID Attendance Kiosk</p>
                <p className="text-slate-400">Employee can clock Time In / Time Out directly before signing into a register.</p>
              </div>
            </div>
          </div>
        </div>

        {/* Authentication Terminal Column */}
        <div className="lg:col-span-7 p-6 sm:p-8 lg:p-10 flex flex-col justify-between space-y-6">
          {!firebaseUser ? (
            <div className="space-y-6 my-auto py-4">
              <div>
                <p className="text-xs font-mono uppercase tracking-wider text-slate-400">Step 1 · Cloud Workspace</p>
                <h2 className="mt-1 font-display text-2xl font-semibold text-slate-900">Connect Cloud Workspace</h2>
                <p className="mt-1.5 text-sm text-slate-500">
                  Authenticate with your workspace Google account to unlock Cloud Firestore persistence and operator sign-in.
                </p>
              </div>

              {error && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">
                  {error}
                </div>
              )}

              <button
                type="button"
                disabled={loading}
                onClick={handleGoogleSignIn}
                className="w-full flex items-center justify-center gap-2.5 rounded-lg bg-slate-900 px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
              >
                <ShieldCheck className="w-4 h-4" />
                {loading ? 'Connecting to Cloud Workspace...' : 'Continue with Google'}
              </button>

              <div className="rounded-lg bg-slate-50 border border-slate-200 p-4 text-xs text-slate-600 space-y-1.5">
                <p className="font-semibold text-slate-800">Workspace Security Notice</p>
                <p>
                  All operator credentials, encrypted Shift PINs, POS sales, FIFO inventory batches, and audit logs persist in Cloud Firestore.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              {/* Workspace Connection Bar */}
              <div className="flex flex-wrap items-start justify-between gap-3 pb-4 border-b border-slate-200">
                <div className="min-w-0">
                  <h2 className="font-display text-xl font-semibold text-slate-900">Operator Sign In</h2>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Sign in with your assigned work credentials or Operator Shift PIN.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={loading}
                  onClick={handleGoogleDisconnect}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 whitespace-nowrap shrink-0"
                >
                  <LogOut className="w-3.5 h-3.5" /> Disconnect Workspace
                </button>
              </div>

              {/* Auth Mode Tabs */}
              <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-slate-100 border border-slate-200">
                <button
                  type="button"
                  onClick={() => {
                    setError('');
                    setAuthTab('password');
                  }}
                  className={`flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                    authTab === 'password'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <Mail className="w-3.5 h-3.5" />
                  Work Email &amp; Password
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setError('');
                    setAuthTab('pin');
                  }}
                  className={`flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                    authTab === 'pin'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <KeyRound className="w-3.5 h-3.5" />
                  Operator Shift PIN
                </button>
              </div>

              {error && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              {authTab === 'password' ? (
                <form onSubmit={handlePasswordLogin} className="space-y-4" autoComplete="off">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Work Email</label>
                    <input
                      type="email"
                      required
                      autoComplete="username"
                      placeholder="name@maximusbbq.ph"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-xs font-medium text-slate-700">Password</label>
                      {capsLockOn && (
                        <span className="text-[11px] font-medium text-amber-700">Caps Lock is ON</span>
                      )}
                    </div>
                    <div className="relative">
                      <input
                        type={showPassword ? 'text' : 'password'}
                        required
                        autoComplete="current-password"
                        placeholder="Enter your password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        onKeyDown={handlePasswordKey}
                        onKeyUp={handlePasswordKey}
                        className="w-full rounded-lg border border-slate-300 pl-3.5 pr-10 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900"
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
                    className="w-full flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <Lock className="w-4 h-4" />
                    {loading ? 'Verifying Credentials...' : 'Sign In with Password'}
                  </button>
                </form>
              ) : (
                <div className="space-y-4">
                  {/* Location & Operator Selection */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Truck / Location Filter
                      </label>
                      <div className="relative">
                        <MapPin className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                        <select
                          value={pinLocationFilter}
                          onChange={(e) => setPinLocationFilter(e.target.value)}
                          className="w-full rounded-lg border border-slate-300 bg-white pl-8 pr-3 py-2 text-xs font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-900"
                        >
                          <option value="ALL">All Locations</option>
                          {locations.map((loc) => (
                            <option key={loc.id} value={loc.id}>
                              {loc.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Operator Account
                      </label>
                      <select
                        value={selectedOperatorId}
                        onChange={(e) => {
                          setSelectedOperatorId(e.target.value);
                          setPin('');
                          setError('');
                        }}
                        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-900"
                      >
                        {filteredOperators.length === 0 ? (
                          <option value="">No operators for location</option>
                        ) : (
                          filteredOperators.map((op) => (
                            <option key={op.id} value={op.id}>
                              {op.full_name} · {op.role_name}
                              {op.is_locked ? ' (Locked)' : !op.has_pin ? ' (No PIN)' : ''}
                            </option>
                          ))
                        )}
                      </select>
                    </div>
                  </div>

                  {/* Selected Operator Card */}
                  {selectedOperator && (
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <AvatarBadge
                          name={selectedOperator.full_name}
                          src={selectedOperator.avatar_url}
                          size="sm"
                        />
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-slate-900 truncate">
                            {selectedOperator.full_name}
                          </p>
                          <p className="text-[11px] text-slate-500 truncate">
                            {selectedOperator.role_name}
                          </p>
                        </div>
                      </div>
                      <span
                        className={`text-[11px] font-semibold shrink-0 ${
                          selectedOperator.is_locked
                            ? 'text-amber-700'
                            : selectedOperator.has_pin
                              ? 'text-emerald-700'
                              : 'text-slate-400'
                        }`}
                      >
                        {selectedOperator.is_locked
                          ? 'Locked (5m)'
                          : selectedOperator.has_pin
                            ? 'PIN Ready'
                            : 'No PIN Set'}
                      </span>
                    </div>
                  )}

                  {!anyOperatorHasPin && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                      No Operator Shift PINs are configured yet. Sign in with Work Email &amp; Password and set 4–6 digit PINs in <span className="font-semibold">User Control</span>.
                    </div>
                  )}

                  {/* PIN Slot Display */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-[11px] text-slate-500">
                      <span>Enter 4–6 digit Shift PIN (touch or keyboard)</span>
                      <span className="font-mono tabular-nums">{pin.length}/6</span>
                    </div>
                    <div className="grid grid-cols-6 gap-2">
                      {[0, 1, 2, 3, 4, 5].map((idx) => {
                        const filled = idx < pin.length;
                        return (
                          <div
                            key={idx}
                            className={`h-10 rounded-lg border flex items-center justify-center font-mono text-lg font-bold transition-colors ${
                              filled
                                ? 'border-slate-900 bg-slate-900 text-white'
                                : 'border-slate-200 bg-slate-50 text-slate-300'
                            }`}
                          >
                            {filled ? '•' : '–'}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Touch Numeric Keypad */}
                  <div className="grid grid-cols-3 gap-2">
                    {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
                      <button
                        key={digit}
                        type="button"
                        disabled={loading || !selectedOperator?.has_pin || selectedOperator?.is_locked}
                        onClick={() => setPin((prev) => (prev.length < 6 ? prev + digit : prev))}
                        className="h-11 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 active:bg-slate-100 font-mono tabular-nums text-base font-semibold text-slate-900 disabled:opacity-40"
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
                      disabled={loading || !selectedOperator?.has_pin || selectedOperator?.is_locked}
                      onClick={() => setPin((prev) => (prev.length < 6 ? prev + '0' : prev))}
                      className="h-11 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 active:bg-slate-100 font-mono tabular-nums text-base font-semibold text-slate-900 disabled:opacity-40"
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
                    disabled={
                      loading ||
                      !selectedOperator?.has_pin ||
                      selectedOperator?.is_locked ||
                      pin.length < 4
                    }
                    onClick={submitPinLogin}
                    className="w-full flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0"
                  >
                    <KeyRound className="w-4 h-4" />
                    {loading ? 'Unlocking Terminal...' : 'Sign In with Shift PIN'}
                  </button>
                </div>
              )}

              {/* Pre-Login Crew Attendance Kiosk Trigger */}
              <div className="pt-4 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-slate-500">
                  <p className="font-medium text-slate-700">Starting a crew shift?</p>
                  <p>Record Time In / Time Out without opening POS.</p>
                </div>
                <button
                  type="button"
                  onClick={openPreLoginKiosk}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 whitespace-nowrap shrink-0"
                >
                  <ScanFace className="w-4 h-4 text-slate-700" />
                  Crew Attendance Kiosk (Face ID)
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {firebaseUser && (
        <FaceAttendanceKioskModal
          isOpen={showKiosk}
          onClose={() => setShowKiosk(false)}
          employees={kioskData.employees}
          attendance={kioskData.attendance}
          locations={locations}
          defaultLocationId="ALL"
          canManageEmployees={false}
          onPunchSuccess={loadKiosk}
          onAutoEnrollSuccess={loadKiosk}
        />
      )}
    </div>
  );
}
