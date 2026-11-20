import React, { useEffect, useState } from 'react';
import { Download, Printer, AlertTriangle, TrendingUp } from 'lucide-react';
import { apiFetch, downloadCsv, formatNum, formatPHP } from '../lib/api.ts';
import { LocationRow } from '../types/erp.ts';

interface Props {
  locations: LocationRow[];
  activeLocationId: string;
  onNavigate: (tab: string) => void;
}

export function DashboardModule({ locations, activeLocationId, onNavigate }: Props) {
  const [period, setPeriod] = useState<'today' | '7d' | '30d'>('30d');
  const [locationFilter, setLocationFilter] = useState<string>(activeLocationId === 'ALL' ? '' : activeLocationId);
  const [data, setData] = useState<any>(null);
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

    apiFetch(`/dashboard/summary?${qs.toString()}`)
      .then((res) => {
        if (!cancelled) setData(res);
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
            onChange={(e) => setLocationFilter(e.target.value)}
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
