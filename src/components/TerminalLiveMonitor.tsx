import React, { useEffect, useState, useRef } from 'react';
import {
  ShoppingCart,
  Clock,
  ShieldAlert,
  Monitor,
  User,
  MapPin,
  Activity,
  History,
  RotateCw,
  LogOut,
  AlertTriangle,
  CheckCircle2,
  X,
  RefreshCw,
  Power,
  Flame,
  Info,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { apiFetch } from '../lib/api.ts';
import { AuthUser, PERMISSIONS } from '../types/erp.ts';

interface TerminalEvent {
  id: string;
  hardwareUuid: string;
  terminalName: string;
  eventType: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  description: string;
  triggeredBy: string;
  createdAt: string;
}

interface TerminalRecord {
  id: string;
  locationId: string;
  locationName: string;
  locationType: string;
  locationAddress: string;
  hardwareUuid: string;
  terminalName: string;
  currentUserId: string | null;
  currentUserName: string;
  currentRoleName: string;
  ipAddress: string;
  terminalStatus: string;
  latencyMs: number | null;
  lastCommand: string | null;
  lastCommandAt: string | null;
  lastSeenAt: string;
  secondsAgo: number;
  isOnline: boolean;
}

interface Props {
  user?: AuthUser | null;
  activeLocationId?: string;
}

export function TerminalLiveMonitor({ user, activeLocationId }: Props) {
  const [terminals, setTerminals] = useState<TerminalRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');

  // Troubleshooting action state: { [hwUuid]: 'rebooting' | 'logging_out' }
  const [actionLoading, setActionLoading] = useState<Record<string, string>>({});
  // Confirm reboot state: hardwareUuid | null
  const [confirmRebootHw, setConfirmRebootHw] = useState<string | null>(null);
  // Confirm force logout state: hardwareUuid | null
  const [confirmLogoutHw, setConfirmLogoutHw] = useState<string | null>(null);

  // History Popover state
  const [historyTarget, setHistoryTarget] = useState<TerminalRecord | null>(null);
  const [historyEvents, setHistoryEvents] = useState<TerminalEvent[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  const isManagerOwnerOrSuperAdmin =
    user?.roleCode === 'SUPER_ADMIN' ||
    user?.roleCode === 'BUSINESS_OWNER' ||
    user?.roleCode === 'OPERATIONS_MANAGER' ||
    user?.roleCode === 'FOOD_TRUCK_MANAGER' ||
    user?.roleCode === 'FINANCE_MANAGER' ||
    (user?.permissions?.includes(PERMISSIONS.SETTINGS_ADMIN) ?? false) ||
    (user?.permissions?.includes(PERMISSIONS.FLEET_MANAGE) ?? false) ||
    (user?.permissions?.includes(PERMISSIONS.DASHBOARD_VIEW) ?? false);

  const fetchTerminals = async () => {
    if (!isManagerOwnerOrSuperAdmin) return;
    try {
      const res = await apiFetch<TerminalRecord[]>('/terminals/presence');
      setTerminals(res);
      setError('');
    } catch (err: any) {
      setError(err?.message || 'Failed to fetch terminal live presence');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isManagerOwnerOrSuperAdmin) return;
    void fetchTerminals();
    const interval = setInterval(() => {
      void fetchTerminals();
    }, 10000);
    return () => clearInterval(interval);
  }, [isManagerOwnerOrSuperAdmin]);

  // Click away to close history popover
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setHistoryTarget(null);
      }
    };
    if (historyTarget) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [historyTarget]);

  // Open History Popover and fetch last 5 events
  const handleOpenHistory = async (term: TerminalRecord) => {
    setHistoryTarget(term);
    setLoadingHistory(true);
    setHistoryEvents([]);
    try {
      const events = await apiFetch<TerminalEvent[]>(`/terminals/${encodeURIComponent(term.hardwareUuid)}/events`);
      setHistoryEvents(events);
    } catch {
      setHistoryEvents([]);
    } finally {
      setLoadingHistory(false);
    }
  };

  // Remote Reboot Handler
  const handleRemoteReboot = async (hw: string, termName: string) => {
    setConfirmRebootHw(null);
    setActionLoading((prev) => ({ ...prev, [hw]: 'rebooting' }));
    setError('');
    try {
      const res = await apiFetch<{ ok: boolean; message: string }>(`/terminals/${encodeURIComponent(hw)}/reboot`, {
        method: 'POST',
      });
      setActionSuccess(res.message || `Reboot command dispatched to ${termName}`);
      setTimeout(() => setActionSuccess(''), 6000);
      await fetchTerminals();
    } catch (err: any) {
      setError(err?.message || `Failed to reboot terminal ${termName}`);
    } finally {
      setActionLoading((prev) => {
        const next = { ...prev };
        delete next[hw];
        return next;
      });
    }
  };

  // Force Logout Handler
  const handleForceLogout = async (hw: string, termName: string) => {
    setConfirmLogoutHw(null);
    setActionLoading((prev) => ({ ...prev, [hw]: 'logging_out' }));
    setError('');
    try {
      const res = await apiFetch<{ ok: boolean; message: string }>(`/terminals/${encodeURIComponent(hw)}/force-logout`, {
        method: 'POST',
      });
      setActionSuccess(res.message || `Operator force-logged out from ${termName}`);
      setTimeout(() => setActionSuccess(''), 6000);
      await fetchTerminals();
    } catch (err: any) {
      setError(err?.message || `Failed to force logout operator from ${termName}`);
    } finally {
      setActionLoading((prev) => {
        const next = { ...prev };
        delete next[hw];
        return next;
      });
    }
  };

  if (!isManagerOwnerOrSuperAdmin) {
    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 text-center space-y-2">
        <ShieldAlert className="w-8 h-8 text-amber-600 dark:text-amber-400 mx-auto" />
        <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50">Restricted Monitor</h3>
        <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mx-auto">
          Terminal Live Monitor is restricted to Company Owners, Super Administrators, and Operations/Food Truck Managers.
        </p>
      </div>
    );
  }

  // Filter terminals if activeLocationId is set and not 'ALL'
  const filteredTerminals = activeLocationId && activeLocationId !== 'ALL'
    ? terminals.filter((t) => t.locationId === activeLocationId)
    : terminals;

  const onlineCount = terminals.filter((t) => t.isOnline).length;
  const busyCount = terminals.filter((t) => t.terminalStatus === 'BUSY').length;
  const onlineLatencies = terminals
    .filter((t) => t.isOnline && typeof t.latencyMs === 'number')
    .map((t) => t.latencyMs as number);
  const avgLatencyMs = onlineLatencies.length
    ? Math.round(onlineLatencies.reduce((sum, v) => sum + v, 0) / onlineLatencies.length)
    : null;
  const unstableCount = onlineLatencies.filter((ms) => ms >= 250).length;

  return (
    <section className="relative rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4 no-print shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-lg bg-emerald-600 text-white shrink-0 shadow-xs">
            <ShoppingCart className="w-5 h-5" />
          </div>
          <div>
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50 flex items-center gap-2">
              Terminal Live Monitor
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-100 dark:bg-emerald-950/80 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" /> LIVE PRESENCE
              </span>
            </h2>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-mono">
              <span>{terminals.length} Terminals Registered</span>
              <span>·</span>
              <span className="text-emerald-700 dark:text-emerald-400 font-semibold">{onlineCount} Online</span>
              <span>·</span>
              <span className="text-amber-700 dark:text-amber-400 font-semibold">{busyCount} Busy in Rush</span>
              {avgLatencyMs !== null && (
                <>
                  <span>·</span>
                  <span
                    className={`font-semibold ${
                      avgLatencyMs >= 250
                        ? 'text-red-700 dark:text-red-400'
                        : avgLatencyMs >= 100
                        ? 'text-amber-700 dark:text-amber-400'
                        : 'text-emerald-700 dark:text-emerald-400'
                    }`}
                  >
                    Avg Latency: {avgLatencyMs}ms
                  </span>
                </>
              )}
              {unstableCount > 0 && (
                <>
                  <span>·</span>
                  <span className="text-red-700 dark:text-red-400 font-semibold">
                    {unstableCount} High Latency
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void fetchTerminals()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
            title="Refresh Real-time Status"
          >
            <Clock className="w-3.5 h-3.5" /> Refresh Status
          </button>
        </div>
      </div>

      {actionSuccess && (
        <div className="flex items-center justify-between rounded-lg bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 p-3 text-xs text-emerald-800 dark:text-emerald-300 animate-fade-in">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span>{actionSuccess}</span>
          </div>
          <button
            type="button"
            onClick={() => setActionSuccess('')}
            className="text-emerald-600 hover:text-emerald-800 dark:hover:text-emerald-100 p-0.5"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {error && (
        <div className="flex items-center justify-between rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 p-3 text-xs text-red-700 dark:text-red-300 animate-fade-in">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={() => setError('')}
            className="text-red-600 hover:text-red-800 dark:hover:text-red-100 p-0.5"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {loading && terminals.length === 0 ? (
          <div className="col-span-full py-8 text-center text-xs text-slate-500 dark:text-slate-400 flex items-center justify-center gap-2">
            <RefreshCw className="w-4 h-4 animate-spin text-slate-400" />
            Scanning active terminal sites...
          </div>
        ) : filteredTerminals.length === 0 ? (
          <div className="col-span-full py-8 text-center text-xs text-slate-500 dark:text-slate-400">
            No POS terminals or register heartbeats detected for the selected location filter.
          </div>
        ) : (
          filteredTerminals.map((term) => {
            const isRebooting = term.terminalStatus === 'REBOOTING' || actionLoading[term.hardwareUuid] === 'rebooting';
            const isLoggingOut = actionLoading[term.hardwareUuid] === 'logging_out';
            const isOnline = Boolean(term.isOnline) && !isRebooting;

            let statusLabel = 'OFFLINE';
            let statusBg = 'bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-300 dark:border-slate-700';

            if (isRebooting) {
              statusLabel = 'REBOOTING...';
              statusBg = 'bg-indigo-100 dark:bg-indigo-950/80 text-indigo-800 dark:text-indigo-300 border-indigo-300 dark:border-indigo-700 animate-pulse';
            } else if (isOnline) {
              if (term.terminalStatus === 'BUSY' || term.secondsAgo < 45) {
                statusLabel = 'ONLINE & BUSY';
                statusBg = 'bg-amber-100 dark:bg-amber-950/80 text-amber-800 dark:text-amber-300 border-amber-300 dark:border-amber-700';
              } else {
                statusLabel = 'ONLINE & IDLE';
                statusBg = 'bg-emerald-100 dark:bg-emerald-950/80 text-emerald-800 dark:text-emerald-300 border-emerald-300 dark:border-emerald-700';
              }
            }

            const hasOperator = term.currentUserName && term.currentUserName !== 'No Operator Logged In';

            const latencyMs = isOnline && typeof term.latencyMs === 'number' ? term.latencyMs : null;
            const latencyTier =
              !isOnline
                ? {
                    label: isRebooting ? 'Syncing' : 'Offline',
                    bars: 0,
                    textTone: 'text-slate-500 dark:text-slate-400',
                    badgeTone: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700',
                    barActiveColor: 'bg-slate-400',
                  }
                : latencyMs === null
                ? {
                    label: 'Measuring',
                    bars: 2,
                    textTone: 'text-slate-600 dark:text-slate-300',
                    badgeTone: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700',
                    barActiveColor: 'bg-slate-400',
                  }
                : latencyMs >= 250
                ? {
                    label: 'High',
                    bars: 1,
                    textTone: 'text-red-700 dark:text-red-300',
                    badgeTone: 'bg-red-50 dark:bg-red-950/70 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800',
                    barActiveColor: 'bg-red-500',
                  }
                : latencyMs >= 100
                ? {
                    label: 'Fair',
                    bars: 2,
                    textTone: 'text-amber-700 dark:text-amber-300',
                    badgeTone: 'bg-amber-50 dark:bg-amber-950/70 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
                    barActiveColor: 'bg-amber-500',
                  }
                : {
                    label: 'Stable',
                    bars: 3,
                    textTone: 'text-emerald-700 dark:text-emerald-300',
                    badgeTone: 'bg-emerald-50 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
                    barActiveColor: 'bg-emerald-500',
                  };

            return (
              <div
                key={term.id}
                className={`rounded-xl border p-4 space-y-3.5 transition-all relative flex flex-col justify-between ${
                  isRebooting
                    ? 'border-indigo-300 dark:border-indigo-800/80 bg-indigo-50/20 dark:bg-indigo-950/20'
                    : isOnline
                    ? 'border-emerald-200 dark:border-emerald-800/80 bg-emerald-50/20 dark:bg-emerald-950/15'
                    : 'border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/60 opacity-80'
                }`}
              >
                <div>
                  {/* Top Bar: Terminal Name & Badges + History Button */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <Monitor
                          className={`w-4 h-4 shrink-0 ${
                            isRebooting
                              ? 'text-indigo-600 dark:text-indigo-400 animate-spin'
                              : isOnline
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-slate-400'
                          }`}
                        />
                        <h3 className="font-semibold text-xs text-slate-900 dark:text-slate-50 truncate" title={term.terminalName}>
                          {term.terminalName}
                        </h3>
                      </div>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5 flex items-center gap-1">
                        <MapPin className="w-3 h-3 shrink-0" /> {term.locationName} ({term.ipAddress})
                      </p>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold border ${statusBg}`}>
                        {statusLabel}
                      </span>
                      {/* History Icon Button */}
                      <button
                        type="button"
                        onClick={() => void handleOpenHistory(term)}
                        className="p-1 rounded-md text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 transition-colors"
                        title="View Last 5 Critical Events & Status History"
                        aria-label={`View history for ${term.terminalName}`}
                      >
                        <History className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Terminal Metadata Details */}
                  <div className="space-y-1.5 text-xs pt-2.5 mt-2 border-t border-slate-200/70 dark:border-slate-800">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500 dark:text-slate-400 flex items-center gap-1">
                        <User className="w-3 h-3" /> Logged In:
                      </span>
                      <span className={`font-semibold truncate max-w-[170px] ${hasOperator ? 'text-slate-900 dark:text-slate-50' : 'text-slate-400 italic'}`}>
                        {term.currentUserName}
                      </span>
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500 dark:text-slate-400 flex items-center gap-1">
                        <Activity className="w-3 h-3" /> Role:
                      </span>
                      <span className="font-medium text-slate-700 dark:text-slate-300 truncate max-w-[160px]">
                        {term.currentRoleName}
                      </span>
                    </div>

                    <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400 pt-0.5">
                      <span>UUID:</span>
                      <span className="font-mono text-[10px] truncate max-w-[180px]">{term.hardwareUuid}</span>
                    </div>

                    <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                      <span>Heartbeat:</span>
                      <span className="font-mono">
                        {term.secondsAgo < 60 ? `${term.secondsAgo}s ago` : `${Math.floor(term.secondsAgo / 60)}m ago`}
                      </span>
                    </div>

                    <div
                      className="flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400 pt-0.5"
                      title="Network round-trip latency (<100ms Stable · 100–249ms Fair · 250ms+ High)"
                    >
                      <span className="flex items-center gap-1">
                        {isOnline ? (
                          <Wifi className={`w-3 h-3 ${latencyTier.textTone}`} />
                        ) : (
                          <WifiOff className="w-3 h-3 text-slate-400" />
                        )}
                        Network Latency:
                      </span>
                      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border font-mono text-[10px] font-semibold ${latencyTier.badgeTone}`}>
                        <span className="inline-flex items-end gap-0.5 h-2.5" aria-hidden="true">
                          <span className={`w-0.5 h-1 rounded-xs ${latencyTier.bars >= 1 ? latencyTier.barActiveColor : 'bg-slate-300 dark:bg-slate-700'}`} />
                          <span className={`w-0.5 h-1.5 rounded-xs ${latencyTier.bars >= 2 ? latencyTier.barActiveColor : 'bg-slate-300 dark:bg-slate-700'}`} />
                          <span className={`w-0.5 h-2.5 rounded-xs ${latencyTier.bars >= 3 ? latencyTier.barActiveColor : 'bg-slate-300 dark:bg-slate-700'}`} />
                        </span>
                        <span>
                          {latencyMs !== null ? `${latencyMs} ms · ${latencyTier.label}` : `-- ms · ${latencyTier.label}`}
                        </span>
                      </span>
                    </div>
                  </div>
                </div>

                {/* Troubleshoot Action Bar: Remote Reboot & Force Logout */}
                <div className="pt-2.5 border-t border-slate-200/70 dark:border-slate-800 space-y-2">
                  {confirmRebootHw === term.hardwareUuid ? (
                    <div className="rounded-lg bg-red-50 dark:bg-red-950/60 border border-red-200 dark:border-red-800 p-2 space-y-1.5">
                      <p className="text-[11px] font-medium text-red-800 dark:text-red-300 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3 shrink-0" /> Confirm Reboot? Terminal will reload.
                      </p>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => void handleRemoteReboot(term.hardwareUuid, term.terminalName)}
                          className="flex-1 rounded bg-red-600 hover:bg-red-700 text-white px-2 py-1 text-[11px] font-semibold transition-colors flex items-center justify-center gap-1"
                        >
                          <Power className="w-3 h-3" /> Yes, Reboot
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmRebootHw(null)}
                          className="rounded border border-slate-300 dark:border-slate-700 px-2 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : confirmLogoutHw === term.hardwareUuid ? (
                    <div className="rounded-lg bg-amber-50 dark:bg-amber-950/60 border border-amber-200 dark:border-amber-800 p-2 space-y-1.5">
                      <p className="text-[11px] font-medium text-amber-800 dark:text-amber-300 flex items-center gap-1">
                        <LogOut className="w-3 h-3 shrink-0" /> Force sign out {term.currentUserName}?
                      </p>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => void handleForceLogout(term.hardwareUuid, term.terminalName)}
                          className="flex-1 rounded bg-amber-600 hover:bg-amber-700 text-white px-2 py-1 text-[11px] font-semibold transition-colors flex items-center justify-center gap-1"
                        >
                          <LogOut className="w-3 h-3" /> Yes, Sign Out
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmLogoutHw(null)}
                          className="rounded border border-slate-300 dark:border-slate-700 px-2 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        disabled={isLoggingOut || !hasOperator}
                        onClick={() => setConfirmLogoutHw(term.hardwareUuid)}
                        className="inline-flex items-center justify-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1.5 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-amber-50 dark:hover:bg-amber-950/40 hover:text-amber-700 dark:hover:text-amber-300 hover:border-amber-300 dark:hover:border-amber-700 transition-colors disabled:opacity-50"
                        title={hasOperator ? 'Force sign out current operator from frozen register' : 'No operator currently logged in'}
                      >
                        {isLoggingOut ? (
                          <RefreshCw className="w-3 h-3 animate-spin" />
                        ) : (
                          <LogOut className="w-3 h-3 text-amber-600 dark:text-amber-400" />
                        )}
                        <span>Force Logout</span>
                      </button>

                      <button
                        type="button"
                        disabled={isRebooting}
                        onClick={() => setConfirmRebootHw(term.hardwareUuid)}
                        className="inline-flex items-center justify-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1.5 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-700 dark:hover:text-red-300 hover:border-red-300 dark:hover:border-red-700 transition-colors disabled:opacity-50"
                        title="Troubleshoot frozen POS terminal by sending remote restart signal"
                      >
                        {isRebooting ? (
                          <RefreshCw className="w-3 h-3 animate-spin" />
                        ) : (
                          <RotateCw className="w-3 h-3 text-red-600 dark:text-red-400" />
                        )}
                        <span>Remote Reboot</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* History Popover Modal */}
      {historyTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 animate-fade-in">
          <div
            ref={popoverRef}
            className="w-full max-w-lg rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xl p-5 space-y-4"
          >
            <div className="flex items-start justify-between gap-3 border-b border-slate-100 dark:border-slate-800 pb-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 shrink-0">
                    <History className="w-4 h-4" />
                  </div>
                  <h3 className="font-display font-semibold text-sm text-slate-900 dark:text-slate-50 truncate">
                    Terminal Event History
                  </h3>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate pl-8">
                  {historyTarget.terminalName} · UUID: {historyTarget.hardwareUuid}
                </p>
              </div>

              <button
                type="button"
                onClick={() => setHistoryTarget(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close History Popover"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div>
              <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">
                Last 5 Critical Events &amp; Status Transitions
              </p>

              {loadingHistory ? (
                <div className="py-8 text-center text-xs text-slate-500 dark:text-slate-400 flex items-center justify-center gap-2">
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Loading terminal event audit trail...
                </div>
              ) : historyEvents.length === 0 ? (
                <div className="py-8 text-center text-xs text-slate-500 dark:text-slate-400">
                  No critical events recorded for this terminal hardware yet.
                </div>
              ) : (
                <div className="space-y-2.5 max-h-80 overflow-y-auto pr-1">
                  {historyEvents.map((evt) => {
                    const isCritical = evt.severity === 'CRITICAL';
                    const isWarning = evt.severity === 'WARNING';

                    const borderTone = isCritical
                      ? 'border-red-200 dark:border-red-800/80 bg-red-50/40 dark:bg-red-950/20'
                      : isWarning
                      ? 'border-amber-200 dark:border-amber-800/80 bg-amber-50/40 dark:bg-amber-950/20'
                      : 'border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40';

                    const badgeTone = isCritical
                      ? 'bg-red-100 dark:bg-red-900/60 text-red-800 dark:text-red-300'
                      : isWarning
                      ? 'bg-amber-100 dark:bg-amber-900/60 text-amber-800 dark:text-amber-300'
                      : 'bg-emerald-100 dark:bg-emerald-900/60 text-emerald-800 dark:text-emerald-300';

                    const Icon = isCritical ? Flame : isWarning ? AlertTriangle : Info;

                    const formattedDate = new Date(evt.createdAt).toLocaleString('en-PH', {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    });

                    return (
                      <div key={evt.id} className={`rounded-xl border p-3 text-xs space-y-1.5 ${borderTone}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <Icon
                              className={`w-3.5 h-3.5 shrink-0 ${
                                isCritical ? 'text-red-600 dark:text-red-400' : isWarning ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400'
                              }`}
                            />
                            <span className="font-semibold text-slate-900 dark:text-slate-50 truncate">
                              {evt.title}
                            </span>
                          </div>
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold shrink-0 ${badgeTone}`}>
                            {evt.severity}
                          </span>
                        </div>

                        <p className="text-slate-600 dark:text-slate-300 pl-5 whitespace-pre-line leading-relaxed">
                          {evt.description}
                        </p>

                        <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 pl-5 pt-0.5">
                          <span>By: {evt.triggeredBy || 'System Daemon'}</span>
                          <span className="font-mono">{formattedDate}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setHistoryTarget(null)}
                className="rounded-lg bg-slate-900 dark:bg-slate-100 px-3 py-1.5 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
