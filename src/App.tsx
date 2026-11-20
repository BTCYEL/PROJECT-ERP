import React, { useEffect, useMemo, useState } from 'react';
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
} from 'lucide-react';
import { MotionConfig } from 'motion/react';
import { apiFetch, getAuthToken, setAuthToken } from './lib/api.ts';
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

interface NavItem {
  id: string;
  label: string;
  group: string;
  perm: string;
  icon: React.ComponentType<{ className?: string }>;
  ownerOrSuperAdminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Company Dashboard', group: 'Overview', perm: PERMISSIONS.DASHBOARD_VIEW, icon: LayoutDashboard },
  { id: 'pos', label: 'POS Terminal', group: 'Frontline', perm: PERMISSIONS.POS_SELL, icon: ShoppingCart },
  { id: 'kds', label: 'Kitchen Display', group: 'Frontline', perm: PERMISSIONS.KDS_MANAGE, icon: ChefHat },
  { id: 'products', label: 'Menu & Recipes', group: 'Operations', perm: PERMISSIONS.PRODUCT_MANAGE, icon: BookOpen },
  { id: 'inventory', label: 'Inventory & FIFO', group: 'Operations', perm: PERMISSIONS.INVENTORY_VIEW, icon: Boxes },
  { id: 'procurement', label: 'Procurement & AP', group: 'Operations', perm: PERMISSIONS.PO_CREATE, icon: ShoppingBag },
  { id: 'costing', label: 'Food Costing', group: 'Finance', perm: PERMISSIONS.DASHBOARD_VIEW, icon: Calculator },
  { id: 'finance', label: 'Finance & Closing', group: 'Finance', perm: PERMISSIONS.FINANCE_VIEW, icon: Landmark },
  { id: 'fleet', label: 'Fleet & Sites', group: 'Workforce & Fleet', perm: PERMISSIONS.FLEET_MANAGE, icon: Truck },
  { id: 'hr', label: 'HR & PH Payroll', group: 'Workforce & Fleet', perm: PERMISSIONS.HR_MANAGE, icon: Users },
  { id: 'crm', label: 'Customer CRM', group: 'Growth & Audit', perm: PERMISSIONS.CRM_MANAGE, icon: HeartHandshake },
  { id: 'reports', label: 'Reports & RBAC', group: 'Growth & Audit', perm: PERMISSIONS.REPORTS_VIEW, icon: FileSpreadsheet },
  { id: 'settings', label: 'User Control', group: 'Administration', perm: PERMISSIONS.SETTINGS_ADMIN, icon: Settings, ownerOrSuperAdminOnly: true },
];

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [booting, setBooting] = useState(true);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [activeLocationId, setActiveLocationId] = useState<string>('ALL');
  const [notifications, setNotifications] = useState<any[]>([]);
  const [showNotifs, setShowNotifs] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const loadWorkspaceContext = async () => {
    try {
      const [locs, notifs] = await Promise.all([apiFetch<LocationRow[]>('/locations'), apiFetch<any[]>('/notifications')]);
      setLocations(locs);
      setNotifications(notifs);
    } catch {
      // Handled gracefully if session expires or lacks permissions
    }
  };

  useEffect(() => {
    const token = getAuthToken();
    if (!token) {
      setBooting(false);
      return;
    }
    apiFetch<AuthUser>('/auth/me')
      .then(async (u) => {
        setUser(u);
        await loadWorkspaceContext();
      })
      .catch(() => setAuthToken(null))
      .finally(() => setBooting(false));
  }, []);

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
    setAuthToken(null);
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

  if (!user) {
    return <LoginView onAuthenticated={handleAuthenticated} />;
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
              Maximus Barbecue ERP
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
            <div className="flex items-center gap-2.5 text-xs">
              <AvatarBadge name={user.fullName} src={user.avatarUrl} size="sm" />
              <div className="min-w-0">
                <p className="font-semibold text-slate-900 truncate">{user.fullName}</p>
                <p className="text-slate-500 truncate">{user.roleName}</p>
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <LogOut className="w-3.5 h-3.5" /> Switch Role / Sign Out
            </button>
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
                  <span className="font-display font-bold text-sm whitespace-nowrap">Maximus Barbecue ERP</span>
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
              <div className="p-3 border-t">
                <button onClick={handleLogout} className="w-full py-2 rounded-lg border text-xs font-medium">
                  Sign Out
                </button>
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
                value={activeLocationId}
                onChange={(e) => setActiveLocationId(e.target.value)}
                className="hidden sm:block rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700"
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

              <div className="relative">
                <button
                  onClick={() => setShowNotifs((s) => !s)}
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
                    <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                      <span className="text-xs font-semibold text-slate-900">Automated ERP Alerts</span>
                      <span className="text-[11px] font-mono text-slate-500">{unreadCount} unread</span>
                    </div>
                    <div className="max-h-72 overflow-y-auto divide-y divide-slate-100">
                      {notifications.length === 0 ? (
                        <p className="py-6 text-center text-xs text-slate-400">No alerts</p>
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
              <DashboardModule locations={locations} activeLocationId={activeLocationId} onNavigate={setActiveTab} />
            )}
            {currentTab === 'pos' && (
              <PosAndKdsModule mode="pos" user={user} locations={locations} activeLocationId={activeLocationId} />
            )}
            {currentTab === 'kds' && (
              <PosAndKdsModule mode="kds" user={user} locations={locations} activeLocationId={activeLocationId} />
            )}
            {currentTab === 'products' && <ProductsBomModule />}
            {currentTab === 'inventory' && <InventoryModule locations={locations} activeLocationId={activeLocationId} />}
            {currentTab === 'procurement' && <ProcurementModule user={user} locations={locations} />}
            {currentTab === 'finance' && <FinanceAndCostingModule mode="finance" locations={locations} />}
            {currentTab === 'costing' && <FinanceAndCostingModule mode="costing" locations={locations} />}
            {currentTab === 'fleet' && <OperationsHrCrmModule mode="fleet" />}
            {currentTab === 'hr' && <OperationsHrCrmModule mode="hr" />}
            {currentTab === 'crm' && <OperationsHrCrmModule mode="crm" />}
            {currentTab === 'reports' && <OperationsHrCrmModule mode="reports" />}
            {currentTab === 'settings' && (user.roleCode === 'SUPER_ADMIN' || user.roleCode === 'BUSINESS_OWNER') && (
              <SettingsUserControlModule currentUser={user} onProfileUpdated={refreshCurrentUser} />
            )}
          </main>
        </div>
      </div>
    </MotionConfig>
  );
}
