import React, { Component, useEffect, useMemo, useState } from 'react';
import {
  LayoutDashboard,
  ShoppingCart,
  ChefHat,
  BookOpen,
  Boxes,
  Truck,
  ShoppingBag,
  Landmark,
  Calculator,
  Users,
  HeartHandshake,
  FileSpreadsheet,
  Bell,
  LogOut,
  Menu,
  X,
  Settings,
  ScanFace,
  Lock,
} from 'lucide-react';
import { onAuthStateChanged, signOut, User } from 'firebase/auth';
import { MotionConfig } from 'motion/react';
import { auth } from './lib/firebase.ts';
import { apiFetch } from './lib/api.ts';
import {
  resetFirebaseSyncCache,
  setActiveErpUserId,
  setSignedOutSession,
  syncFirebaseUserAndSeed,
} from './lib/firestoreErp.ts';
import { AuthUser, LocationRow, PERMISSIONS } from './types/erp.ts';
import { LoginView } from './components/LoginView.tsx';
import { DashboardModule } from './components/DashboardModule.tsx';
import { PosAndKdsModule } from './components/PosAndKdsModule.tsx';
import { ProductsBomModule } from './components/ProductsBomModule.tsx';
import { InventoryModule } from './components/InventoryModule.tsx';
import { ProcurementModule } from './components/ProcurementModule.tsx';
import { FinanceAndCostingModule } from './components/FinanceAndCostingModule.tsx';
import { OperationsHrCrmModule } from './components/OperationsHrCrmModule.tsx';
import { AvatarBadge, SettingsUserControlModule } from './components/SettingsUserControlModule.tsx';
import { FaceAttendanceKioskModal } from './components/FaceAttendanceKioskModal.tsx';
import { SessionLockModal } from './components/SessionLockModal.tsx';

const IDLE_LOCK_STORAGE_KEY = 'maximus_bbq_idle_lock_mins';

interface ErrorBoundaryState {
  error: Error | null;
}

class AppErrorBoundary extends Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render() {
    if (this.state.error) {
      let friendlyMsg = this.state.error.message;
      try {
        const parsed = JSON.parse(this.state.error.message);
        if (parsed?.error) friendlyMsg = `${parsed.error} (${parsed.operationType || 'read'} on ${parsed.path || 'workspace'})`;
      } catch {
        // plain error message
      }
      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-white border border-red-200 rounded-xl p-6 space-y-4">
            <h2 className="font-display text-lg font-semibold text-slate-900">Workspace Sync Error</h2>
            <p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg p-3 break-words">{friendlyMsg}</p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => window.location.reload()}
                className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
              >
                Reload Workspace
              </button>
              <button
                onClick={() => {
                  setActiveErpUserId(null);
                  resetFirebaseSyncCache();
                  signOut(auth).finally(() => window.location.reload());
                }}
                className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Sign Out
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

interface NavItem {
  id: string;
  label: string;
  group: string;
  perm: string;
  icon: React.ComponentType<{ className?: string }>;
  ownerOrSuperAdminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', group: 'Overview', perm: PERMISSIONS.DASHBOARD_VIEW, icon: LayoutDashboard },
  { id: 'pos', label: 'POS Terminal', group: 'Frontline', perm: PERMISSIONS.POS_SELL, icon: ShoppingCart },
  { id: 'kds', label: 'Kitchen Display', group: 'Frontline', perm: PERMISSIONS.KDS_MANAGE, icon: ChefHat },
  { id: 'products', label: 'Menu & Recipes', group: 'Operations', perm: PERMISSIONS.PRODUCT_MANAGE, icon: BookOpen },
  { id: 'inventory', label: 'Inventory & FIFO', group: 'Operations', perm: PERMISSIONS.INVENTORY_VIEW, icon: Boxes },
  { id: 'procurement', label: 'Procurement & AP', group: 'Operations', perm: PERMISSIONS.PO_CREATE, icon: ShoppingBag },
  { id: 'costing', label: 'Food Costing', group: 'Finance', perm: PERMISSIONS.DASHBOARD_VIEW, icon: Calculator },
  { id: 'finance', label: 'Finance & Closing', group: 'Finance', perm: PERMISSIONS.FINANCE_VIEW, icon: Landmark },
  { id: 'fleet', label: 'Truck & Sites', group: 'Workforce & Fleet', perm: PERMISSIONS.FLEET_MANAGE, icon: Truck },
  { id: 'hr', label: 'HR & PH Payroll', group: 'Workforce & Fleet', perm: PERMISSIONS.HR_MANAGE, icon: Users },
  { id: 'crm', label: 'Customer CRM', group: 'Growth & Audit', perm: PERMISSIONS.CRM_MANAGE, icon: HeartHandshake },
  { id: 'reports', label: 'Reports & RBAC', group: 'Growth & Audit', perm: PERMISSIONS.REPORTS_VIEW, icon: FileSpreadsheet },
  { id: 'settings', label: 'User Control', group: 'Administration', perm: PERMISSIONS.SETTINGS_ADMIN, icon: Settings, ownerOrSuperAdminOnly: true },
];

function AppShell() {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState('');
  const [activeTab, setActiveTab] = useState('dashboard');
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [activeLocationId, setActiveLocationId] = useState<string>('ALL');
  const [notifications, setNotifications] = useState<any[]>([]);
  const [showNotifs, setShowNotifs] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showGlobalKiosk, setShowGlobalKiosk] = useState(false);
  const [kioskData, setKioskData] = useState<{ employees: any[]; attendance: any[] } | null>(null);
  const [pendingQuickAction, setPendingQuickAction] = useState<{ tab: string; action: string; nonce: number } | null>(null);
  const [isLocked, setIsLocked] = useState(false);
  const [idleTimeoutMins, setIdleTimeoutMins] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(IDLE_LOCK_STORAGE_KEY));
      if ([0, 5, 15, 30].includes(saved)) return saved;
    } catch {
      // ignore storage failure
    }
    return 15;
  });

  const handleQuickAction = (tab: string, action?: string) => {
    setActiveTab(tab);
    if (action) {
      setPendingQuickAction({ tab, action, nonce: Date.now() });
    } else {
      setPendingQuickAction(null);
    }
  };

  const loadAttendanceKiosk = async () => {
    try {
      const res = await apiFetch<{ employees: any[]; attendance: any[] }>('/attendance/kiosk');
      setKioskData(res);
    } catch {
      // Handled gracefully if session expires
    }
  };

  const openAttendanceKiosk = () => {
    setShowGlobalKiosk(true);
    void loadAttendanceKiosk();
  };

  const loadNotifications = async (locId = activeLocationId) => {
    try {
      const qs = locId && locId !== 'ALL' ? `?locationId=${encodeURIComponent(locId)}` : '';
      const notifs = await apiFetch<any[]>(`/notifications${qs}`);
      setNotifications(notifs);
    } catch {
      // Handled gracefully if session expires or lacks permissions
    }
  };

  const loadWorkspaceContext = async (locId = activeLocationId) => {
    try {
      const qs = locId && locId !== 'ALL' ? `?locationId=${encodeURIComponent(locId)}` : '';
      const [locs, notifs, kiosk] = await Promise.all([
        apiFetch<LocationRow[]>('/locations'),
        apiFetch<any[]>(`/notifications${qs}`),
        apiFetch<{ employees: any[]; attendance: any[] }>('/attendance/kiosk').catch(() => null),
      ]);
      setLocations(locs);
      setNotifications(notifs);
      if (kiosk) setKioskData(kiosk);
    } catch {
      // Handled gracefully if session expires or lacks permissions
    }
  };

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      setFirebaseUser(fbUser);
      setBootError('');
      if (!fbUser) {
        setUser(null);
        setIsLocked(false);
        resetFirebaseSyncCache();
        setBooting(false);
        return;
      }

      try {
        await syncFirebaseUserAndSeed(fbUser);
        const erpUser = await apiFetch<AuthUser>('/auth/me');
        setUser(erpUser);
        setIsLocked(false);
        await loadWorkspaceContext();
      } catch (err: any) {
        if (err?.message === 'SIGNED_OUT') {
          setUser(null);
          setIsLocked(false);
        } else {
          let msg = err?.message || 'Failed to load cloud workspace';
          try {
            const parsed = JSON.parse(msg);
            if (parsed?.error) msg = `${parsed.error} (${parsed.operationType || 'read'} on ${parsed.path || 'workspace'})`;
          } catch {
            // plain error message
          }
          setBootError(msg);
          setUser(null);
        }
      } finally {
        setBooting(false);
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!user || isLocked || idleTimeoutMins <= 0) return;
    let timerId: number | undefined;
    const resetTimer = () => {
      if (timerId !== undefined) window.clearTimeout(timerId);
      timerId = window.setTimeout(() => {
        setIsLocked(true);
      }, idleTimeoutMins * 60 * 1000);
    };
    const events: Array<keyof WindowEventMap> = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'];
    events.forEach((evt) => window.addEventListener(evt, resetTimer, { passive: true }));
    resetTimer();
    return () => {
      if (timerId !== undefined) window.clearTimeout(timerId);
      events.forEach((evt) => window.removeEventListener(evt, resetTimer));
    };
  }, [user, isLocked, idleTimeoutMins]);

  const handleIdleTimeoutChange = (mins: number) => {
    setIdleTimeoutMins(mins);
    try {
      localStorage.setItem(IDLE_LOCK_STORAGE_KEY, String(mins));
    } catch {
      // ignore storage failure
    }
  };

  useEffect(() => {
    if (user) {
      loadNotifications(activeLocationId);
    }
  }, [user, activeLocationId]);

  const visibleNav = useMemo(() => {
    if (!user) return [];
    const isOwnerOrSuper = user.roleCode === 'SUPER_ADMIN' || user.roleCode === 'BUSINESS_OWNER';
    return NAV_ITEMS.filter((n) => {
      if (n.ownerOrSuperAdminOnly) return isOwnerOrSuper;
      return isOwnerOrSuper || user.permissions.includes(n.perm);
    });
  }, [user]);

  const currentTab = useMemo(() => {
    if (!visibleNav.length) return '';
    return visibleNav.some((n) => n.id === activeTab) ? activeTab : visibleNav[0].id;
  }, [visibleNav, activeTab]);

  useEffect(() => {
    if (currentTab && currentTab !== activeTab) {
      setActiveTab(currentTab);
    }
  }, [currentTab, activeTab]);

  const handleAuthenticated = async (u: AuthUser) => {
    setBootError('');
    setIsLocked(false);
    const isOwnerOrSuper = u.roleCode === 'SUPER_ADMIN' || u.roleCode === 'BUSINESS_OWNER';
    const allowed = NAV_ITEMS.filter((n) => {
      if (n.ownerOrSuperAdminOnly) return isOwnerOrSuper;
      return isOwnerOrSuper || u.permissions.includes(n.perm);
    });
    setActiveTab(allowed[0]?.id || 'dashboard');
    setUser(u);
    await loadWorkspaceContext();
  };

  const refreshCurrentUser = async () => {
    try {
      const updated = await apiFetch<AuthUser>('/auth/me');
      setUser(updated);
    } catch {
      // ignore
    }
  };

  const handleLogout = async () => {
    await apiFetch('/auth/logout', { method: 'POST' }).catch(() => {});
    setSignedOutSession(true);
    setActiveErpUserId(null);
    setIsLocked(false);
    setUser(null);
    setActiveTab('dashboard');
  };

  const markRead = async (id: string) => {
    try {
      await apiFetch(`/notifications/${id}/read`, { method: 'POST' });
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, is_read: 1 } : n)));
    } catch {
      // ignore
    }
  };

  if (booting) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 text-sm text-slate-500">
        Loading Maximus Barbecue ERP...
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white border border-red-200 rounded-xl p-6 space-y-4">
          <h2 className="font-display text-lg font-semibold text-slate-900">Unable to Connect to Cloud Workspace</h2>
          <p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg p-3 break-words">{bootError}</p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => window.location.reload()}
              className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
            >
              Retry
            </button>
            <button
              onClick={() => signOut(auth).finally(() => window.location.reload())}
              className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!firebaseUser || !user) {
    return <LoginView firebaseUser={firebaseUser} onAuthenticated={handleAuthenticated} />;
  }

  const unreadCount = notifications.filter((n) => n.is_read === 0).length;
  const activeItem = NAV_ITEMS.find((n) => n.id === currentTab) || visibleNav[0];
  const groups = Array.from(new Set(visibleNav.map((n) => n.group)));

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-screen bg-slate-50 flex">
        {/* Desktop Sidebar */}
        <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:shrink-0 bg-white border-r border-slate-200 no-print">
          <div className="h-16 px-4 flex items-center gap-2.5 border-b border-slate-200">
            <img
              src="/assets/aistudio/Logo_836b4628.png"
              alt="Maximus Barbecue Logo"
              referrerPolicy="no-referrer"
              className="w-8 h-8 rounded-full object-contain shrink-0"
            />
            <span className="font-display font-bold text-sm tracking-tight text-slate-900 whitespace-nowrap">
              Maximus Barbecue
            </span>
          </div>

          <nav className="flex-1 overflow-y-auto p-3.5 space-y-5">
            {groups.map((grp) => (
              <div key={grp} className="space-y-1">
                <p className="px-3 text-[11px] font-semibold text-slate-400">{grp}</p>
                {visibleNav
                  .filter((item) => item.group === grp)
                  .map((item) => {
                    const Icon = item.icon;
                    const active = currentTab === item.id;
                    return (
                      <button
                        key={item.id}
                        onClick={() => setActiveTab(item.id)}
                        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                          active
                            ? 'bg-slate-900 text-white'
                            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                        }`}
                      >
                        <Icon className="w-4 h-4 shrink-0" />
                        <span>{item.label}</span>
                      </button>
                    );
                  })}
              </div>
            ))}
          </nav>

          <div className="p-4 border-t border-slate-200 space-y-2.5">
            <button
              type="button"
              onClick={openAttendanceKiosk}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition-colors"
            >
              <ScanFace className="w-3.5 h-3.5" /> Attendance Kiosk
            </button>
            <div className="flex items-center gap-2.5 text-xs pt-0.5">
              <AvatarBadge name={user.fullName} src={user.avatarUrl} size="sm" />
              <div className="min-w-0">
                <p className="font-semibold text-slate-900 truncate">{user.fullName}</p>
                <p className="text-slate-500 truncate">{user.roleName}</p>
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
              <span>Auto-Lock</span>
              <select
                aria-label="Idle Auto-Lock Timeout"
                value={idleTimeoutMins}
                onChange={(e) => handleIdleTimeoutChange(Number(e.target.value))}
                className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] font-medium text-slate-700"
              >
                <option value={5}>5m idle</option>
                <option value={15}>15m idle</option>
                <option value={30}>30m idle</option>
                <option value={0}>Off</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => setIsLocked(true)}
                className="inline-flex items-center justify-center gap-1 rounded-lg border border-slate-200 px-2.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
              >
                <Lock className="w-3.5 h-3.5" /> Lock
              </button>
              <button
                type="button"
                onClick={handleLogout}
                className="inline-flex items-center justify-center gap-1 rounded-lg border border-slate-200 px-2.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
              >
                <LogOut className="w-3.5 h-3.5" /> Sign Out
              </button>
            </div>
          </div>
        </aside>

        {/* Mobile Drawer */}
        {mobileMenuOpen && (
          <div className="fixed inset-0 z-50 lg:hidden flex">
            <div className="w-64 bg-white h-full border-r border-slate-200 flex flex-col">
              <div className="h-16 px-4 flex items-center justify-between border-b border-slate-200">
                <div className="flex items-center gap-2">
                  <img
                    src="/assets/aistudio/Logo_836b4628.png"
                    alt="Maximus Barbecue Logo"
                    referrerPolicy="no-referrer"
                    className="w-7 h-7 rounded-full object-contain shrink-0"
                  />
                  <span className="font-display font-bold text-sm whitespace-nowrap">Maximus Barbecue</span>
                </div>
                <button onClick={() => setMobileMenuOpen(false)} className="p-1">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <nav className="flex-1 overflow-y-auto p-3 space-y-1">
                {visibleNav.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      onClick={() => {
                        setActiveTab(item.id);
                        setMobileMenuOpen(false);
                      }}
                      className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-xs font-medium ${
                        currentTab === item.id ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </nav>
              <div className="p-3 border-t space-y-2">
                <button
                  type="button"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    openAttendanceKiosk();
                  }}
                  className="w-full inline-flex items-center justify-center gap-1.5 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold"
                >
                  <ScanFace className="w-3.5 h-3.5" /> Attendance Kiosk
                </button>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setMobileMenuOpen(false);
                      setIsLocked(true);
                    }}
                    className="inline-flex items-center justify-center gap-1 py-2 rounded-lg border text-xs font-medium text-slate-700"
                  >
                    <Lock className="w-3.5 h-3.5" /> Lock
                  </button>
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="inline-flex items-center justify-center gap-1 py-2 rounded-lg border text-xs font-medium text-slate-700"
                  >
                    <LogOut className="w-3.5 h-3.5" /> Sign Out
                  </button>
                </div>
              </div>
            </div>
            <div className="flex-1 bg-black/40" onClick={() => setMobileMenuOpen(false)} />
          </div>
        )}

        {/* Main Viewport */}
        <div className="flex-1 flex flex-col min-w-0">
          <header className="h-16 bg-white border-b border-slate-200 px-4 lg:px-8 flex items-center justify-between gap-4 no-print">
            <div className="flex items-center gap-3 min-w-0">
              <button
                onClick={() => setMobileMenuOpen(true)}
                className="lg:hidden p-2 rounded-lg border border-slate-200 text-slate-700"
              >
                <Menu className="w-4 h-4" />
              </button>
              <div className="text-xs text-slate-500 truncate">
                <span>{activeItem?.group}</span>
                <span className="mx-1.5">/</span>
                <span className="font-semibold text-slate-900">{activeItem?.label}</span>
              </div>
            </div>

            <div className="flex items-center gap-3 shrink-0">
              <select
                aria-label="Filter by Food Truck & Location"
                value={activeLocationId}
                onChange={(e) => setActiveLocationId(e.target.value)}
                className="max-w-[145px] sm:max-w-none rounded-lg border border-slate-200 bg-slate-50 px-2.5 sm:px-3 py-1.5 text-xs font-medium text-slate-700"
              >
                <option value="ALL">All Trucks &amp; Commissary</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>

              <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 min-w-0">
                <AvatarBadge name={user.fullName} src={user.avatarUrl} size="sm" />
                <div className="leading-tight min-w-0">
                  <p className="text-xs font-semibold text-slate-900 truncate max-w-[120px] sm:max-w-[180px]">{user.fullName}</p>
                  <p className="text-[11px] text-slate-500 truncate max-w-[120px] sm:max-w-[180px]">{user.roleName}</p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setIsLocked(true)}
                title="Lock Terminal"
                aria-label="Lock Terminal"
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
              >
                <Lock className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Lock</span>
              </button>

              <div className="relative">
                <button
                  onClick={() => {
                    const next = !showNotifs;
                    setShowNotifs(next);
                    if (next) loadNotifications(activeLocationId);
                  }}
                  className="relative p-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700"
                  aria-label="Notifications"
                >
                  <Bell className="w-4 h-4" />
                  {unreadCount > 0 && (
                    <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-600 text-white text-[10px] font-mono font-bold flex items-center justify-center">
                      {unreadCount}
                    </span>
                  )}
                </button>

                {showNotifs && (
                  <div className="absolute right-0 mt-2 w-80 rounded-xl border border-slate-200 bg-white shadow-lg z-40 p-3 space-y-2">
                    <div className="flex items-center justify-between border-b border-slate-100 pb-2 gap-2">
                      <div className="min-w-0">
                        <span className="block text-xs font-semibold text-slate-900">Automated ERP Alerts</span>
                        <span className="block text-[10px] text-slate-500 truncate">
                          {activeLocationId === 'ALL'
                            ? 'All Trucks & Commissary'
                            : locations.find((l) => l.id === activeLocationId)?.name || 'Selected Location'}
                        </span>
                      </div>
                      <span className="text-[11px] font-mono text-slate-500 shrink-0">{unreadCount} unread</span>
                    </div>
                    <div className="max-h-72 overflow-y-auto divide-y divide-slate-100">
                      {notifications.length === 0 ? (
                        <p className="py-6 text-center text-xs text-slate-400">
                          {activeLocationId === 'ALL' ? 'No alerts' : 'No alerts for selected truck / location'}
                        </p>
                      ) : (
                        notifications.map((n) => (
                          <div key={n.id} className={`py-2.5 text-xs space-y-1 ${n.is_read ? 'opacity-60' : ''}`}>
                            <div className="flex justify-between gap-2">
                              <span className="font-semibold text-slate-900">{n.title}</span>
                              {!n.is_read && (
                                <button onClick={() => markRead(n.id)} className="text-[11px] text-slate-600 underline shrink-0">
                                  Dismiss
                                </button>
                              )}
                            </div>
                            {n.location_name && (
                              <p className="text-[10px] font-medium text-amber-700">{n.location_name}</p>
                            )}
                            <p className="text-slate-600">{n.message}</p>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </header>

          <main className="flex-1 p-4 lg:p-8 max-w-[1440px] w-full mx-auto">
            {currentTab === 'dashboard' && (
              <DashboardModule
                user={user}
                locations={locations}
                activeLocationId={activeLocationId}
                onLocationChange={setActiveLocationId}
                onLocationsChanged={loadWorkspaceContext}
                onNavigate={setActiveTab}
                onQuickAction={handleQuickAction}
                kioskData={kioskData}
                onOpenAttendanceKiosk={openAttendanceKiosk}
              />
            )}
            {currentTab === 'pos' && (
              <PosAndKdsModule
                mode="pos"
                user={user}
                locations={locations}
                activeLocationId={activeLocationId}
                onLocationChange={setActiveLocationId}
                onLocationsChanged={loadWorkspaceContext}
              />
            )}
            {currentTab === 'kds' && (
              <PosAndKdsModule
                mode="kds"
                user={user}
                locations={locations}
                activeLocationId={activeLocationId}
                onLocationChange={setActiveLocationId}
                onLocationsChanged={loadWorkspaceContext}
              />
            )}
            {currentTab === 'products' && <ProductsBomModule />}
            {currentTab === 'inventory' && (
              <InventoryModule
                locations={locations}
                activeLocationId={activeLocationId}
                onLocationChange={setActiveLocationId}
                quickAction={pendingQuickAction?.tab === 'inventory' ? pendingQuickAction : null}
                onQuickActionHandled={() => setPendingQuickAction(null)}
              />
            )}
            {currentTab === 'procurement' && (
              <ProcurementModule
                user={user}
                locations={locations}
                activeLocationId={activeLocationId}
                quickAction={pendingQuickAction?.tab === 'procurement' ? pendingQuickAction : null}
                onQuickActionHandled={() => setPendingQuickAction(null)}
              />
            )}
            {currentTab === 'finance' && (
              <FinanceAndCostingModule
                mode="finance"
                locations={locations}
                activeLocationId={activeLocationId}
                quickAction={pendingQuickAction?.tab === 'finance' ? pendingQuickAction : null}
                onQuickActionHandled={() => setPendingQuickAction(null)}
              />
            )}
            {currentTab === 'costing' && (
              <FinanceAndCostingModule mode="costing" locations={locations} activeLocationId={activeLocationId} />
            )}
            {currentTab === 'fleet' && (
              <OperationsHrCrmModule
                mode="fleet"
                locations={locations}
                activeLocationId={activeLocationId}
                onLocationsChanged={loadWorkspaceContext}
              />
            )}
            {currentTab === 'hr' && (
              <OperationsHrCrmModule
                mode="hr"
                locations={locations}
                activeLocationId={activeLocationId}
                quickAction={pendingQuickAction?.tab === 'hr' ? pendingQuickAction : null}
                onQuickActionHandled={() => setPendingQuickAction(null)}
              />
            )}
            {currentTab === 'crm' && (
              <OperationsHrCrmModule mode="crm" locations={locations} activeLocationId={activeLocationId} />
            )}
            {currentTab === 'reports' && (
              <OperationsHrCrmModule
                mode="reports"
                locations={locations}
                activeLocationId={activeLocationId}
                onLocationChange={setActiveLocationId}
              />
            )}
            {currentTab === 'settings' && (user.roleCode === 'SUPER_ADMIN' || user.roleCode === 'BUSINESS_OWNER') && (
              <SettingsUserControlModule currentUser={user} onProfileUpdated={refreshCurrentUser} />
            )}
          </main>
        </div>

        <FaceAttendanceKioskModal
          isOpen={showGlobalKiosk}
          onClose={() => setShowGlobalKiosk(false)}
          employees={kioskData?.employees || []}
          attendance={kioskData?.attendance || []}
          locations={locations}
          defaultLocationId={activeLocationId}
          canManageEmployees={
            user.roleCode === 'SUPER_ADMIN' ||
            user.roleCode === 'BUSINESS_OWNER' ||
            user.permissions.includes(PERMISSIONS.HR_MANAGE)
          }
          onPunchSuccess={loadAttendanceKiosk}
          onAutoEnrollSuccess={loadAttendanceKiosk}
        />

        {isLocked && (
          <SessionLockModal
            user={user}
            firebaseEmail={firebaseUser.email}
            onUnlocked={(updatedUser) => {
              setUser(updatedUser);
              setIsLocked(false);
            }}
            onSwitchOperator={handleLogout}
          />
        )}
      </div>
    </MotionConfig>
  );
}

export default function App() {
  return (
    <AppErrorBoundary>
      <AppShell />
    </AppErrorBoundary>
  );
}
