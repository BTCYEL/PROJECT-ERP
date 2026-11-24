import React, { useEffect, useState } from 'react';
import {
  Download,
  Printer,
  AlertTriangle,
  TrendingUp,
  ScanFace,
  Clock,
  ShoppingBag,
  ClipboardCheck,
  Calculator,
  Landmark,
  ShoppingCart,
  ArrowRightLeft,
  UserPlus,
  ChefHat,
  Truck,
  BookOpen,
  FileSpreadsheet,
  Lock,
  Package,
  Search,
  CheckCircle2,
  Target,
  Pencil,
} from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  PolarAngleAxis,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { apiFetch, downloadCsv, formatNum, formatPHP } from '../lib/api.ts';
import { AuthUser, LocationRow, PERMISSIONS } from '../types/erp.ts';

interface Props {
  user?: AuthUser;
  locations: LocationRow[];
  activeLocationId: string;
  onLocationChange?: (locationId: string) => void;
  onLocationsChanged?: () => void | Promise<void>;
  onNavigate: (tab: string) => void;
  onQuickAction?: (tab: string, action?: string) => void;
  kioskData?: { employees: any[]; attendance: any[] } | null;
  onOpenAttendanceKiosk?: () => void;
}

export function DashboardModule({
  user,
  locations,
  activeLocationId,
  onLocationChange,
  onLocationsChanged,
  onNavigate,
  onQuickAction,
  kioskData,
  onOpenAttendanceKiosk,
}: Props) {
  const [period, setPeriod] = useState<'today' | '7d' | '30d'>('30d');
  const [locationFilter, setLocationFilter] = useState<string>(activeLocationId === 'ALL' ? '' : activeLocationId);
  const [data, setData] = useState<any>(null);
  const [todayMetrics, setTodayMetrics] = useState<{ sales: number; txnCount: number }>({ sales: 0, txnCount: 0 });
  const [sevenDayTrends, setSevenDayTrends] = useState<Array<{ day: string; label: string; revenue: number; orders: number }>>([]);
  const [criticalFilter, setCriticalFilter] = useState<'all' | 'out' | 'low'>('all');
  const [criticalSearch, setCriticalSearch] = useState('');
  const [editingTarget, setEditingTarget] = useState(false);
  const [targetEditLocId, setTargetEditLocId] = useState('');
  const [targetInput, setTargetInput] = useState('');
  const [savingTarget, setSavingTarget] = useState(false);
  const [targetErr, setTargetErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLocationFilter(activeLocationId === 'ALL' ? '' : activeLocationId);
  }, [activeLocationId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');

    const now = new Date();
    const from = new Date(now);
    if (period === 'today') from.setHours(0, 0, 0, 0);
    else if (period === '7d') from.setDate(now.getDate() - 7);
    else from.setDate(now.getDate() - 30);

    const qs = new URLSearchParams({
      from: from.toISOString(),
      to: now.toISOString(),
      ...(locationFilter ? { locationId: locationFilter } : {}),
    });

    const sevenDayStart = new Date(now);
    sevenDayStart.setDate(now.getDate() - 6);
    sevenDayStart.setHours(0, 0, 0, 0);
    const qs7d = new URLSearchParams({
      from: sevenDayStart.toISOString(),
      to: now.toISOString(),
      ...(locationFilter ? { locationId: locationFilter } : {}),
    });

    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const qsToday = new URLSearchParams({
      from: todayStart.toISOString(),
      to: now.toISOString(),
      ...(locationFilter ? { locationId: locationFilter } : {}),
    });

    const buildSevenDaySeries = (rawRows: any[]) => {
      const byDay = new Map<string, { revenue: number; orders: number }>();
      for (const row of rawRows || []) {
        const key = String(row.day || '').slice(0, 10);
        if (key) {
          byDay.set(key, {
            revenue: Number(row.revenue || 0),
            orders: Number(row.orders || 0),
          });
        }
      }
      const series: Array<{ day: string; label: string; revenue: number; orders: number }> = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(now.getDate() - i);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const isoDay = `${y}-${m}-${dd}`;
        const hit = byDay.get(isoDay);
        series.push({
          day: isoDay,
          label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          revenue: hit?.revenue ?? 0,
          orders: hit?.orders ?? 0,
        });
      }
      return series;
    };

    Promise.all([
      apiFetch<any>(`/dashboard/summary?${qs.toString()}`),
      period === '7d' ? Promise.resolve(null) : apiFetch<any>(`/dashboard/summary?${qs7d.toString()}`).catch(() => null),
      period === 'today' ? Promise.resolve(null) : apiFetch<any>(`/dashboard/summary?${qsToday.toString()}`).catch(() => null),
    ])
      .then(([res, res7d, resToday]) => {
        if (!cancelled) {
          setData(res);
          const trendSource = (res7d?.dailyTrends || res?.dailyTrends || []) as any[];
          setSevenDayTrends(buildSevenDaySeries(trendSource));
          const todaySource = period === 'today' ? res : resToday;
          setTodayMetrics({
            sales: Number(todaySource?.kpis?.totalSales || 0),
            txnCount: Number(todaySource?.kpis?.txnCount || 0),
          });
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [period, locationFilter]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-24 rounded-lg border border-slate-200 bg-white animate-pulse" />
          ))}
        </div>
        <div className="h-72 rounded-lg border border-slate-200 bg-white animate-pulse" />
      </div>
    );
  }

  if (error) {
    return <div className="p-4 rounded-lg border border-red-200 bg-red-50 text-sm text-red-700">{error}</div>;
  }

  const { kpis, lowStockItems, expiringBatches, salesByPayment, salesByLocation, salesByCategory, topProducts, dailyTrends } = data;
  const maxTrend = Math.max(...(dailyTrends.map((d: any) => d.revenue) || [1]), 1);
  const sevenDayTotal = sevenDayTrends.reduce((sum, d) => sum + d.revenue, 0);
  const sevenDayAvg = sevenDayTrends.length ? sevenDayTotal / sevenDayTrends.length : 0;

  const isOwnerOrSuper = user?.roleCode === 'SUPER_ADMIN' || user?.roleCode === 'BUSINESS_OWNER';
  const hasPerm = (perm: string) => Boolean(user && (isOwnerOrSuper || user.permissions.includes(perm)));
  const selectedLocObj = locationFilter ? locations.find((l) => l.id === locationFilter) : undefined;
  const locationScopeLabel = selectedLocObj?.name || (locationFilter ? 'Selected Location' : 'All Trucks & Commissary');

  const getLocTarget = (loc: LocationRow) =>
    Number(loc.daily_sales_target ?? (loc.type === 'FOOD_TRUCK' ? (loc.code === 'TRK-02' ? 12000 : 15000) : 5000));
  const dailySalesTarget = selectedLocObj
    ? getLocTarget(selectedLocObj)
    : locations.reduce((sum, loc) => sum + getLocTarget(loc), 0);
  const rawTargetPct = dailySalesTarget > 0 ? (todayMetrics.sales / dailySalesTarget) * 100 : 0;
  const clampedTargetPct = Math.max(0, Math.min(100, rawTargetPct));
  const targetRemaining = Math.max(0, dailySalesTarget - todayMetrics.sales);
  const targetSurplus = Math.max(0, todayMetrics.sales - dailySalesTarget);
  const targetReached = dailySalesTarget > 0 && todayMetrics.sales >= dailySalesTarget;
  const gaugeFill =
    dailySalesTarget <= 0
      ? '#94a3b8'
      : targetReached
        ? '#16a34a'
        : rawTargetPct >= 60
          ? '#d97706'
          : '#0f172a';
  const targetStatusLabel =
    dailySalesTarget <= 0
      ? 'No Target Configured'
      : targetReached
        ? 'Target Reached'
        : rawTargetPct >= 60
          ? 'On Track'
          : 'In Progress';
  const targetStatusTone =
    dailySalesTarget <= 0
      ? 'text-slate-500'
      : targetReached
        ? 'text-emerald-700'
        : rawTargetPct >= 60
          ? 'text-amber-700'
          : 'text-slate-700';

  const openTargetEditor = () => {
    const initialLoc = selectedLocObj || locations[0];
    if (!initialLoc) return;
    setTargetEditLocId(initialLoc.id);
    setTargetInput(String(getLocTarget(initialLoc)));
    setTargetErr('');
    setEditingTarget(true);
  };

  const handleSaveTarget = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetEditLocId) return;
    const parsed = Number(targetInput);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setTargetErr('Enter a valid non-negative target amount.');
      return;
    }
    setSavingTarget(true);
    setTargetErr('');
    try {
      await apiFetch(`/fleet/locations/${targetEditLocId}/target`, {
        method: 'PATCH',
        body: JSON.stringify({ dailySalesTarget: parsed }),
      });
      await onLocationsChanged?.();
      setEditingTarget(false);
    } catch (err: any) {
      setTargetErr(err.message || 'Unable to update daily target');
    } finally {
      setSavingTarget(false);
    }
  };

  const criticalInventoryItems = (lowStockItems || [])
    .filter((item: any) => {
      const reorderPt = Number(item.reorder_point || 0);
      const currentQty = Number(item.current_qty || 0);
      return reorderPt > 0 && currentQty < reorderPt;
    })
    .map((item: any) => {
      const reorderPt = Number(item.reorder_point || 0);
      const currentQty = Number(item.current_qty || 0);
      const deficit = Math.max(0, reorderPt - currentQty);
      const pctOfReorder = reorderPt > 0 ? Math.max(0, Math.min(100, (currentQty / reorderPt) * 100)) : 0;
      const isOutOfStock = currentQty <= 0;
      return {
        ...item,
        reorderPt,
        currentQty,
        deficit,
        pctOfReorder,
        isOutOfStock,
      };
    })
    .sort((a: any, b: any) => {
      if (a.isOutOfStock !== b.isOutOfStock) return a.isOutOfStock ? -1 : 1;
      const ratioA = a.currentQty / Math.max(a.reorderPt, 1);
      const ratioB = b.currentQty / Math.max(b.reorderPt, 1);
      return ratioA - ratioB || String(a.name || '').localeCompare(String(b.name || ''));
    });

  const criticalOutCount = criticalInventoryItems.filter((i: any) => i.isOutOfStock).length;
  const criticalLowOnlyCount = criticalInventoryItems.length - criticalOutCount;
  const criticalQuery = criticalSearch.trim().toLowerCase();
  const filteredCriticalItems = criticalInventoryItems.filter((item: any) => {
    if (criticalFilter === 'out' && !item.isOutOfStock) return false;
    if (criticalFilter === 'low' && item.isOutOfStock) return false;
    if (criticalQuery) {
      const nameMatch = String(item.name || '').toLowerCase().includes(criticalQuery);
      const skuMatch = String(item.sku || '').toLowerCase().includes(criticalQuery);
      return nameMatch || skuMatch;
    }
    return true;
  });

  return (
    <div className="space-y-6">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900">Company Dashboard</h1>
          <p className="text-sm text-slate-500">Live SQL-backed sales, gross margin, inventory valuation, and fleet performance</p>
        </div>

        <div className="flex flex-wrap items-center gap-3 no-print">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg border border-slate-200">
            {([
              { id: 'today', label: 'Today' },
              { id: '7d', label: '7 Days' },
              { id: '30d', label: '30 Days' },
            ] as const).map((p) => (
              <button
                key={p.id}
                onClick={() => setPeriod(p.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  period === p.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <select
            value={locationFilter}
            onChange={(e) => {
              const val = e.target.value;
              setLocationFilter(val);
              onLocationChange?.(val || 'ALL');
            }}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700"
          >
            <option value="">All Trucks &amp; Commissary</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>

          <button
            onClick={() => downloadCsv(`maximus_barbecue_bi_${period}.csv`, topProducts)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            Export CSV
          </button>
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            <Printer className="w-3.5 h-3.5" />
            Print Brief
          </button>
        </div>
      </div>

      {/* Permission-Aware Quick Actions */}
      {(() => {
        const allActions: Array<{
          id: string;
          label: string;
          hint: string;
          perm: string | null;
          tab: string;
          action?: string;
          icon: React.ComponentType<{ className?: string }>;
        }> = [
          {
            id: 'new-po',
            label: 'Add Purchase Order',
            hint: 'Create supplier PO',
            perm: PERMISSIONS.PO_CREATE,
            tab: 'procurement',
            action: 'new-po',
            icon: ShoppingBag,
          },
          {
            id: 'new-payroll',
            label: 'Start New Payroll',
            hint: 'Compute PH cutoff run',
            perm: PERMISSIONS.PAYROLL_RUN,
            tab: 'hr',
            action: 'new-payroll',
            icon: Calculator,
          },
          {
            id: 'adjust-inv',
            label: 'Adjust Inventory',
            hint: 'Physical count & reconcile',
            perm: PERMISSIONS.INVENTORY_ADJUST,
            tab: 'inventory',
            action: 'count',
            icon: ClipboardCheck,
          },
          {
            id: 'transfer-inv',
            label: 'Transfer Stock',
            hint: 'Commissary to truck',
            perm: PERMISSIONS.INVENTORY_ADJUST,
            tab: 'inventory',
            action: 'transfer',
            icon: ArrowRightLeft,
          },
          {
            id: 'new-expense',
            label: 'Record Expense',
            hint: 'LPG, fuel & petty cash',
            perm: PERMISSIONS.FINANCE_VIEW,
            tab: 'finance',
            action: 'new-expense',
            icon: Landmark,
          },
          {
            id: 'daily-closing',
            label: 'Daily Shift Closing',
            hint: 'Cash & sales sign-off',
            perm: PERMISSIONS.DAILY_CLOSE,
            tab: 'finance',
            action: 'daily-closing',
            icon: Lock,
          },
          {
            id: 'new-employee',
            label: 'Add Employee & Crew',
            hint: 'Enroll photo & Face ID',
            perm: PERMISSIONS.HR_MANAGE,
            tab: 'hr',
            action: 'new-employee',
            icon: UserPlus,
          },
          {
            id: 'pos-sell',
            label: 'Open POS Terminal',
            hint: 'Ring up customer orders',
            perm: PERMISSIONS.POS_SELL,
            tab: 'pos',
            icon: ShoppingCart,
          },
          {
            id: 'kds',
            label: 'Kitchen Display',
            hint: 'Monitor prep queue',
            perm: PERMISSIONS.KDS_MANAGE,
            tab: 'kds',
            icon: ChefHat,
          },
          {
            id: 'fleet',
            label: 'Trucks & Dispatch',
            hint: 'Sites, fuel & KDS',
            perm: PERMISSIONS.FLEET_MANAGE,
            tab: 'fleet',
            icon: Truck,
          },
          {
            id: 'products',
            label: 'Menu & Recipes',
            hint: 'BOM & pricing matrix',
            perm: PERMISSIONS.PRODUCT_MANAGE,
            tab: 'products',
            icon: BookOpen,
          },
          {
            id: 'reports',
            label: 'Export Reports',
            hint: 'CSV, RBAC & audit log',
            perm: PERMISSIONS.REPORTS_VIEW,
            tab: 'reports',
            icon: FileSpreadsheet,
          },
        ];

        const allowedActions = allActions.filter((a) => !a.perm || hasPerm(a.perm));
        if (allowedActions.length === 0) return null;

        return (
          <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-3 no-print">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-display text-sm font-semibold text-slate-900">Quick Actions</h2>
                <p className="text-xs text-slate-500">
                  Direct shortcuts available for {user?.roleName || 'your role'}
                </p>
              </div>
              <span className="text-[11px] font-mono tabular-nums text-slate-500">
                {allowedActions.length} action(s) permitted
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-2.5">
              {allowedActions.map((qa) => {
                const Icon = qa.icon;
                return (
                  <button
                    key={qa.id}
                    type="button"
                    onClick={() => {
                      if (onQuickAction) onQuickAction(qa.tab, qa.action);
                      else onNavigate(qa.tab);
                    }}
                    className="group flex items-start gap-2.5 rounded-lg border border-slate-200 bg-slate-50/50 p-3 text-left hover:border-slate-400 hover:bg-white transition-colors"
                  >
                    <div className="p-2 rounded-md bg-slate-900 text-white shrink-0 group-hover:bg-slate-800 transition-colors">
                      <Icon className="w-3.5 h-3.5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-slate-900 leading-tight truncate">{qa.label}</p>
                      <p className="text-[11px] text-slate-500 mt-0.5 truncate">{qa.hint}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })()}

      {/* 8 KPI Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiTile label="Total Sales" value={formatPHP(kpis.totalSales)} sub={`${kpis.txnCount} completed orders`} />
        <KpiTile
          label="Gross Profit"
          value={formatPHP(kpis.grossProfit)}
          sub={kpis.totalSales > 0 ? `${formatNum((kpis.grossProfit / kpis.totalSales) * 100, 1)}% gross margin` : '0.0% margin'}
          tone="positive"
        />
        <KpiTile
          label="Net Profit"
          value={formatPHP(kpis.netProfit)}
          sub="After operating expenses"
          tone={kpis.netProfit >= 0 ? 'positive' : 'negative'}
        />
        <KpiTile label="Operating Expenses" value={formatPHP(kpis.totalExpenses)} sub="Fuel, LPG, rent &amp; payroll" />
        <KpiTile label="Avg Transaction Value" value={formatPHP(kpis.avgTicket)} sub="Per completed receipt" />
        <KpiTile label="Inventory Valuation" value={formatPHP(kpis.inventoryValuation)} sub="Live FIFO/WAC batch value" />
        <KpiTile
          label="Low-Stock Alerts"
          value={String(lowStockItems.length)}
          sub="Items at or below reorder"
          tone={lowStockItems.length > 0 ? 'warning' : 'neutral'}
        />
        <KpiTile
          label="Open Purchase Orders"
          value={String(kpis.pendingPOs)}
          sub="Pending approval or GRN"
        />
      </div>

      {/* Daily Revenue (Last 7 Days) & Daily Sales Target Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 rounded-xl border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-base font-semibold text-slate-900">Daily Revenue</h2>
              <p className="text-xs text-slate-500">
                Historical sales trend over the last 7 days · {locationScopeLabel}
              </p>
            </div>
            <div className="flex items-center gap-3 text-xs text-slate-600 font-mono tabular-nums">
              <span>
                7D Total: <strong className="text-slate-900">{formatPHP(sevenDayTotal)}</strong>
              </span>
              <span aria-hidden="true" className="text-slate-300">·</span>
              <span>
                Daily Avg: <strong className="text-slate-900">{formatPHP(sevenDayAvg)}</strong>
              </span>
            </div>
          </div>

          <div className="h-64 w-full min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={sevenDayTrends} margin={{ top: 10, right: 16, left: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: '#64748b' }}
                  axisLine={{ stroke: '#cbd5e1' }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: '#64748b' }}
                  axisLine={false}
                  tickLine={false}
                  width={64}
                  tickFormatter={(v: number) => (v >= 1000 ? `₱${Math.round(v / 1000)}k` : `₱${v}`)}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#ffffff',
                    borderColor: '#e2e8f0',
                    borderRadius: '0.5rem',
                    fontSize: '12px',
                  }}
                  formatter={(value: any, _name: any, item: any) => [
                    `${formatPHP(Number(value || 0))} (${item?.payload?.orders ?? 0} orders)`,
                    'Daily Revenue',
                  ]}
                  labelFormatter={(_label: any, payload: any) => payload?.[0]?.payload?.day || String(_label)}
                />
                <Line
                  type="monotone"
                  dataKey="revenue"
                  name="Daily Revenue"
                  stroke="#0f172a"
                  strokeWidth={2.5}
                  dot={{ r: 4, fill: '#0f172a', stroke: '#ffffff', strokeWidth: 2 }}
                  activeDot={{ r: 6, fill: '#d97706', stroke: '#ffffff', strokeWidth: 2 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Daily Sales Target Recharts Gauge */}
        <section className="rounded-xl border border-slate-200 bg-white p-5 flex flex-col justify-between gap-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="font-display text-base font-semibold text-slate-900">Daily Sales Target</h2>
              <p className="text-xs text-slate-500 truncate">{locationScopeLabel}</p>
            </div>
            {hasPerm(PERMISSIONS.FLEET_MANAGE) && locations.length > 0 && (
              <button
                type="button"
                onClick={editingTarget ? () => setEditingTarget(false) : openTargetEditor}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0 no-print"
              >
                <Pencil className="w-3 h-3" />
                {editingTarget ? 'Cancel' : 'Set Target'}
              </button>
            )}
          </div>

          {editingTarget ? (
            <form onSubmit={handleSaveTarget} className="space-y-3 border-t border-slate-100 pt-3 no-print">
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">Location</label>
                <select
                  value={targetEditLocId}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    setTargetEditLocId(nextId);
                    const loc = locations.find((l) => l.id === nextId);
                    if (loc) setTargetInput(String(getLocTarget(loc)));
                  }}
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-800"
                >
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">Daily Target (PHP)</label>
                <input
                  type="number"
                  min="0"
                  step="100"
                  value={targetInput}
                  onChange={(e) => setTargetInput(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-mono tabular-nums text-slate-900"
                  required
                />
              </div>
              {targetErr && <p className="text-[11px] text-red-700">{targetErr}</p>}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditingTarget(false)}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingTarget}
                  className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  {savingTarget ? 'Saving...' : 'Save Target'}
                </button>
              </div>
            </form>
          ) : (
            <>
              <div className="relative h-44 w-full min-w-0">
                <ResponsiveContainer width="100%" height="100%">
                  <RadialBarChart
                    cx="50%"
                    cy="76%"
                    innerRadius="72%"
                    outerRadius="100%"
                    barSize={16}
                    data={[{ name: 'Daily Sales', value: clampedTargetPct, fill: gaugeFill }]}
                    startAngle={180}
                    endAngle={0}
                  >
                    <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
                    <RadialBar background={{ fill: '#f1f5f9' }} dataKey="value" cornerRadius={8} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#ffffff',
                        borderColor: '#e2e8f0',
                        borderRadius: '0.5rem',
                        fontSize: '12px',
                      }}
                      formatter={() => [
                        `${formatPHP(todayMetrics.sales)} / ${formatPHP(dailySalesTarget)} (${formatNum(rawTargetPct, 1)}%)`,
                        'Today vs Target',
                      ]}
                    />
                  </RadialBarChart>
                </ResponsiveContainer>

                <div className="pointer-events-none absolute inset-x-0 bottom-9 flex flex-col items-center text-center">
                  <span className="font-mono tabular-nums text-2xl font-bold text-slate-900 leading-none">
                    {dailySalesTarget > 0 ? `${formatNum(rawTargetPct, 0)}%` : '—'}
                  </span>
                  <span className={`mt-1 inline-flex items-center gap-1 text-[11px] font-semibold ${targetStatusTone}`}>
                    <Target className="w-3 h-3 shrink-0" />
                    {targetStatusLabel}
                  </span>
                </div>
              </div>

              <div className="border-t border-slate-100 pt-3 space-y-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-500">Today&apos;s Sales ({todayMetrics.txnCount} orders)</span>
                  <span className="font-mono tabular-nums font-semibold text-slate-900">
                    {formatPHP(todayMetrics.sales)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-500">Daily Target</span>
                  <span className="font-mono tabular-nums font-semibold text-slate-900">
                    {formatPHP(dailySalesTarget)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-500">{targetReached ? 'Above Target' : 'Remaining to Goal'}</span>
                  <span
                    className={`font-mono tabular-nums font-semibold ${
                      targetReached ? 'text-emerald-700' : 'text-amber-700'
                    }`}
                  >
                    {targetReached ? `+${formatPHP(targetSurplus)}` : formatPHP(targetRemaining)}
                  </span>
                </div>
              </div>
            </>
          )}
        </section>
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-display text-base font-semibold text-slate-900">Daily Revenue &amp; COGS Trend</h2>
              <p className="text-xs text-slate-500">Completed POS receipts vs. FIFO ingredient cost</p>
            </div>
            <TrendingUp className="w-4 h-4 text-slate-400" />
          </div>

          {dailyTrends.length === 0 ? (
            <div className="h-52 flex items-center justify-center text-sm text-slate-400">
              No completed sales recorded in selected range.
            </div>
          ) : (
            <div className="h-56 flex items-end gap-3 pt-4 border-b border-slate-100 pb-2">
              {dailyTrends.map((d: any) => {
                const revH = Math.max(8, Math.round((d.revenue / maxTrend) * 170));
                const cogsH = Math.max(4, Math.round((d.cogs / maxTrend) * 170));
                return (
                  <div key={d.day} className="flex-1 flex flex-col items-center gap-1.5 group">
                    <div className="text-[11px] font-mono tabular-nums text-slate-600 opacity-80">
                      {formatPHP(d.revenue).replace('₱', '₱')}
                    </div>
                    <div className="w-full max-w-[44px] flex items-end justify-center gap-1 h-[172px]">
                      <div
                        style={{ height: `${revH}px` }}
                        className="w-5 rounded-t bg-slate-900 transition-all"
                        title={`Revenue: ${formatPHP(d.revenue)}`}
                      />
                      <div
                        style={{ height: `${cogsH}px` }}
                        className="w-3 rounded-t bg-amber-500 transition-all"
                        title={`COGS: ${formatPHP(d.cogs)}`}
                      />
                    </div>
                    <div className="text-[11px] font-mono text-slate-500">{d.day.slice(5)}</div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="mt-3 flex items-center gap-4 text-xs text-slate-500">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-2.5 bg-slate-900 rounded-sm inline-block" /> Gross Revenue
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-2.5 bg-amber-500 rounded-sm inline-block" /> FIFO COGS
            </span>
          </div>
        </div>

        {/* Sales by Payment & Category */}
        <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-5">
          <div>
            <h2 className="font-display text-base font-semibold text-slate-900 mb-3">Sales by Payment Method</h2>
            <div className="space-y-2.5">
              {salesByPayment.length === 0 ? (
                <p className="text-xs text-slate-400">No payments in range.</p>
              ) : (
                salesByPayment.map((p: any) => {
                  const pct = kpis.totalSales > 0 ? (p.total / kpis.totalSales) * 100 : 0;
                  return (
                    <div key={p.method} className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="font-medium text-slate-700">{p.method.replace('_', ' ')}</span>
                        <span className="font-mono tabular-nums text-slate-900">{formatPHP(p.total)} · {formatNum(pct, 0)}%</span>
                      </div>
                      <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                        <div className="h-full bg-slate-900" style={{ width: `${Math.min(100, pct)}%` }} />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="pt-4 border-t border-slate-100">
            <h2 className="font-display text-base font-semibold text-slate-900 mb-3">Sales by Menu Category</h2>
            <div className="space-y-2">
              {salesByCategory.map((c: any) => (
                <div key={c.category} className="flex justify-between text-xs">
                  <span className="text-slate-600">{c.category}</span>
                  <span className="font-mono tabular-nums font-medium text-slate-900">{formatPHP(c.revenue)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Critical Inventory Card (Items Below Reorder Point) */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="p-2.5 rounded-lg bg-slate-900 text-white shrink-0">
              <Package className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-display text-base font-semibold text-slate-900">Critical Inventory</h2>
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
                {criticalInventoryItems.length > 0 ? (
                  <>
                    <span className="text-red-700 font-medium">
                      {criticalInventoryItems.length} below reorder point
                    </span>
                    <span aria-hidden="true" className="text-slate-300">·</span>
                    <span>{criticalOutCount} out of stock</span>
                    <span aria-hidden="true" className="text-slate-300">·</span>
                    <span>{criticalLowOnlyCount} critically low</span>
                    <span aria-hidden="true" className="text-slate-300">·</span>
                    <span className="font-sans">{locationScopeLabel}</span>
                  </>
                ) : (
                  <>
                    <span className="text-emerald-700 font-medium">All items above reorder threshold</span>
                    <span aria-hidden="true" className="text-slate-300">·</span>
                    <span className="font-sans">{locationScopeLabel}</span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 no-print">
            {criticalInventoryItems.length > 0 && (
              <>
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={criticalSearch}
                    onChange={(e) => setCriticalSearch(e.target.value)}
                    placeholder="Filter SKU or item..."
                    aria-label="Filter critical inventory items"
                    className="w-44 rounded-lg border border-slate-200 bg-slate-50 pl-8 pr-3 py-1.5 text-xs text-slate-800 placeholder:text-slate-400 focus:bg-white focus:border-slate-400 focus:outline-none"
                  />
                </div>

                <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg border border-slate-200">
                  {([
                    { id: 'all', label: `All (${criticalInventoryItems.length})` },
                    { id: 'out', label: `Out (${criticalOutCount})` },
                    { id: 'low', label: `Low (${criticalLowOnlyCount})` },
                  ] as const).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setCriticalFilter(tab.id)}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 font-mono tabular-nums ${
                        criticalFilter === tab.id
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </>
            )}

            {hasPerm(PERMISSIONS.PO_CREATE) && (
              <button
                type="button"
                onClick={() => {
                  if (onQuickAction) onQuickAction('procurement', 'new-po');
                  else onNavigate('procurement');
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap shrink-0 transition-colors"
              >
                <ShoppingBag className="w-3.5 h-3.5" />
                Reorder via PO
              </button>
            )}

            {hasPerm(PERMISSIONS.INVENTORY_VIEW) && (
              <button
                type="button"
                onClick={() => onNavigate('inventory')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0 transition-colors"
              >
                Manage Inventory
              </button>
            )}
          </div>
        </div>

        {criticalInventoryItems.length === 0 ? (
          <div className="border-t border-slate-100 pt-5 pb-1 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 text-xs text-slate-600">
              <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
              <span>
                No inventory items are currently below their configured reorder point in {locationScopeLabel}.
              </span>
            </div>
            {hasPerm(PERMISSIONS.INVENTORY_VIEW) && (
              <button
                type="button"
                onClick={() => onNavigate('inventory')}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
              >
                Inspect Inventory
              </button>
            )}
          </div>
        ) : filteredCriticalItems.length === 0 ? (
          <div className="border-t border-slate-100 pt-5 pb-1 flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-slate-600">
              No critical inventory items match your current filter criteria.
            </span>
            <button
              type="button"
              onClick={() => {
                setCriticalFilter('all');
                setCriticalSearch('');
              }}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
            >
              Reset Filter
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 text-slate-500">
                <tr>
                  <th className="py-2.5 pr-4 font-medium">Inventory Item</th>
                  <th className="py-2.5 px-3 font-medium">Status</th>
                  <th className="py-2.5 px-3 font-medium text-right">On Hand</th>
                  <th className="py-2.5 px-3 font-medium text-right">Reorder Point</th>
                  <th className="py-2.5 px-3 font-medium text-right">Shortfall</th>
                  <th className="py-2.5 pl-3 font-medium w-44">Stock vs Threshold</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredCriticalItems.map((item: any) => {
                  const statusTone = item.isOutOfStock ? 'text-red-700' : 'text-amber-700';
                  const barTone = item.isOutOfStock ? 'bg-red-600' : 'bg-amber-500';
                  const statusLabel = item.isOutOfStock
                    ? 'Out of Stock'
                    : item.pctOfReorder <= 50
                      ? 'Critically Low'
                      : 'Below Reorder';
                  return (
                    <tr key={item.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="py-2.5 pr-4">
                        <p className="font-semibold text-slate-900">{item.name}</p>
                        <p className="text-[11px] text-slate-500 font-mono">
                          {item.sku || 'NO-SKU'} · {item.uom}
                        </p>
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1.5 font-semibold ${statusTone}`}>
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                          {statusLabel}
                        </span>
                      </td>
                      <td className={`py-2.5 px-3 text-right font-mono tabular-nums font-semibold ${statusTone}`}>
                        {formatNum(item.currentQty, 0)} {item.uom}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-600">
                        {formatNum(item.reorderPt, 0)} {item.uom}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums font-semibold text-red-700">
                        -{formatNum(item.deficit, 0)} {item.uom}
                      </td>
                      <td className="py-2.5 pl-3">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 flex-1 bg-slate-100 rounded-full overflow-hidden">
                            <div
                              className={`h-full ${barTone}`}
                              style={{ width: `${Math.max(item.currentQty > 0 ? 4 : 0, item.pctOfReorder)}%` }}
                            />
                          </div>
                          <span className="font-mono tabular-nums text-[11px] text-slate-600 w-9 text-right">
                            {formatNum(item.pctOfReorder, 0)}%
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Bottom Operational Grids: Truck Performance, Top Products & Alerts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-base font-semibold text-slate-900">Truck Performance</h2>
            <button onClick={() => onNavigate('fleet')} className="text-xs font-medium text-slate-600 hover:text-slate-900">
              View Fleet
            </button>
          </div>
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 text-slate-500">
              <tr>
                <th className="py-2 font-medium">Food Truck</th>
                <th className="py-2 font-medium text-right">Orders</th>
                <th className="py-2 font-medium text-right">Revenue</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {salesByLocation.map((loc: any) => (
                <tr key={loc.id}>
                  <td className="py-2.5 font-medium text-slate-800">{loc.name}</td>
                  <td className="py-2.5 text-right font-mono tabular-nums">{loc.orders}</td>
                  <td className="py-2.5 text-right font-mono tabular-nums font-semibold">{formatPHP(loc.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-base font-semibold text-slate-900">Best-Selling Menu Items</h2>
            <button onClick={() => onNavigate('costing')} className="text-xs font-medium text-slate-600 hover:text-slate-900">
              Menu Matrix
            </button>
          </div>
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 text-slate-500">
              <tr>
                <th className="py-2 font-medium">Product</th>
                <th className="py-2 font-medium text-right">Qty</th>
                <th className="py-2 font-medium text-right">Sales</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {topProducts.map((p: any) => (
                <tr key={p.product_name}>
                  <td className="py-2.5 font-medium text-slate-800 truncate max-w-[160px]">{p.product_name}</td>
                  <td className="py-2.5 text-right font-mono tabular-nums">{p.qty_sold}</td>
                  <td className="py-2.5 text-right font-mono tabular-nums font-semibold">{formatPHP(p.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-display text-base font-semibold text-slate-900">Inventory &amp; Expiry Alerts</h2>
            <button onClick={() => onNavigate('inventory')} className="text-xs font-medium text-slate-600 hover:text-slate-900">
              Manage Stock
            </button>
          </div>
          <div className="space-y-2.5 text-xs">
            {lowStockItems.map((item: any) => (
              <div key={item.id} className="flex items-start justify-between gap-2 pb-2 border-b border-slate-100">
                <div>
                  <p className="font-medium text-slate-900 flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                    {item.name}
                  </p>
                  <p className="text-slate-500 mt-0.5">
                    LOW STOCK · Reorder at {formatNum(item.reorder_point, 0)} {item.uom}
                  </p>
                </div>
                <span className="font-mono tabular-nums font-semibold text-amber-700 shrink-0">
                  {formatNum(item.current_qty, 0)} {item.uom}
                </span>
              </div>
            ))}
            {expiringBatches.map((b: any) => (
              <div key={b.id} className="flex items-start justify-between gap-2 pb-2 border-b border-slate-100">
                <div>
                  <p className="font-medium text-slate-900">{b.item_name}</p>
                  <p className="text-red-700 mt-0.5">
                    EXPIRING SOON · {b.batch_number} · {b.location_name}
                  </p>
                </div>
                <span className="font-mono tabular-nums text-red-700 shrink-0">
                  {String(b.expiry_date).slice(0, 10)}
                </span>
              </div>
            ))}
            {lowStockItems.length === 0 && expiringBatches.length === 0 && (
              <p className="text-slate-400 py-4 text-center">No stock shortages or expiring batches detected.</p>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Attendance Kiosk Section (Available for Every System User) */}
      {(() => {
        const allKioskEmps = (kioskData?.employees || []).filter((e: any) => e.is_active !== 0);
        const scopedEmps = locationFilter
          ? allKioskEmps.filter((e: any) => e.location_id === locationFilter)
          : allKioskEmps;
        const allPunches = kioskData?.attendance || [];
        const scopedPunches = locationFilter
          ? allPunches.filter((a: any) => a.location_id === locationFilter)
          : allPunches;
        const onShiftCount = scopedPunches.filter((a: any) => !a.clock_out).length;
        const faceReadyCount = scopedEmps.filter((e: any) => Boolean(e.face_descriptor_json)).length;
        const recentPunches = scopedPunches.slice(0, 4);

        return (
          <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4 no-print">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="p-2.5 rounded-lg bg-slate-900 text-white shrink-0">
                  <ScanFace className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="font-display text-base font-semibold text-slate-900">
                    Attendance Kiosk
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    On-device Face ID &amp; fallback PIN Time In / Time Out for all crew &amp; system users
                  </p>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600 mt-1.5 font-mono tabular-nums">
                    <span>
                      <strong className="text-emerald-700">{onShiftCount}</strong> on shift
                    </span>
                    <span aria-hidden="true" className="text-slate-300">·</span>
                    <span>
                      <strong className="text-slate-900">{faceReadyCount}</strong>/{scopedEmps.length} Face ID ready
                    </span>
                    <span aria-hidden="true" className="text-slate-300">·</span>
                    <span>
                      <strong className="text-slate-900">{scopedPunches.length}</strong> recent punches
                    </span>
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={() => onOpenAttendanceKiosk?.()}
                className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap shrink-0 shadow-xs transition-colors"
              >
                <ScanFace className="w-4 h-4" />
                Open Face Attendance Kiosk
              </button>
            </div>

            {recentPunches.length > 0 && (
              <div className="pt-3 border-t border-slate-100">
                <p className="text-[11px] font-medium text-slate-500 mb-2">Latest Shift Punches</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {recentPunches.map((att: any) => {
                    const punchTime = att.clock_out || att.clock_in;
                    const timeStr = punchTime
                      ? new Date(punchTime).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })
                      : '—';
                    const methodText =
                      att.verification_method === 'FACE_SCAN'
                        ? `Face Scan${att.match_confidence ? ` ${att.match_confidence}%` : ''}`
                        : att.verification_method === 'PIN_FALLBACK'
                          ? 'PIN Fallback'
                          : 'Manual';
                    return (
                      <div
                        key={att.id}
                        className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2.5 text-xs flex items-start justify-between gap-2"
                      >
                        <div className="min-w-0">
                          <p className="font-semibold text-slate-900 truncate">{att.full_name}</p>
                          <p className="text-[11px] text-slate-500 truncate">
                            {att.location_name || 'Commissary HQ'} · {methodText}
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className={`text-[11px] font-semibold ${att.clock_out ? 'text-slate-600' : 'text-emerald-700'}`}>
                            {att.clock_out ? 'Timed Out' : 'On Shift'}
                          </p>
                          <p className="font-mono tabular-nums text-[11px] text-slate-500 flex items-center justify-end gap-1">
                            <Clock className="w-3 h-3" /> {timeStr}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        );
      })()}
    </div>
  );
}

function KpiTile({
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  sub: string;
  tone?: 'neutral' | 'positive' | 'negative' | 'warning';
}) {
  const valueColor =
    tone === 'positive'
      ? 'text-emerald-700'
      : tone === 'negative'
      ? 'text-red-700'
      : tone === 'warning'
      ? 'text-amber-700'
      : 'text-slate-900';

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className={`mt-1.5 font-mono tabular-nums text-2xl font-semibold tracking-tight ${valueColor}`}>{value}</p>
      <p className="mt-1 text-xs text-slate-500">{sub}</p>
    </div>
  );
}
