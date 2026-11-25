import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Star,
  Gauge,
  Sparkles,
  TrendingDown,
  Search,
  Download,
  ArrowUpDown,
  Pencil,
  Utensils,
  RefreshCw,
} from 'lucide-react';
import {
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  Cell,
} from 'recharts';
import { apiFetch, downloadCsv, formatNum, formatPHP } from '../lib/api.ts';
import { useTheme } from '../lib/theme.ts';
import type {
  MenuEngineeringAnalyzedItem,
  MenuEngineeringClass,
  MenuEngineeringReport,
} from '../lib/menuEngineering.ts';

interface MenuEngineeringDashboardProps {
  locations?: any[];
  activeLocationId?: string;
  refreshTrigger?: number;
  onSelectProductForEdit: (productId: string) => void;
}

interface MenuEngineeringResponse extends MenuEngineeringReport {
  categories: Array<{ id: string; name: string }>;
  filters: {
    days: string;
    locationId: string;
    categoryId: string;
    ordersAnalyzed: number;
  };
}

type QuadrantFilter = 'ALL' | MenuEngineeringClass;
type SortKey =
  | 'totalContributionMargin'
  | 'unitsSold'
  | 'unitContributionMargin'
  | 'menuMixPct'
  | 'foodCostPct';

const QUADRANT_META: Record<
  MenuEngineeringClass,
  {
    label: string;
    pluralLabel: string;
    rule: string;
    color: string;
    textClass: string;
    activeCardClass: string;
    icon: React.ComponentType<{ className?: string }>;
  }
> = {
  STAR: {
    label: 'Star',
    pluralLabel: 'Stars',
    rule: 'High Popularity · High Margin',
    color: '#059669',
    textClass: 'text-emerald-700 dark:text-emerald-300',
    activeCardClass: 'border-emerald-500 bg-emerald-50/70 dark:bg-emerald-950/45',
    icon: Star,
  },
  PLOWHORSE: {
    label: 'Plowhorse',
    pluralLabel: 'Plowhorses',
    rule: 'High Popularity · Low Margin',
    color: '#d97706',
    textClass: 'text-amber-700 dark:text-amber-300',
    activeCardClass: 'border-amber-500 bg-amber-50/70 dark:bg-amber-950/45',
    icon: Gauge,
  },
  PUZZLE: {
    label: 'Puzzle',
    pluralLabel: 'Puzzles',
    rule: 'Low Popularity · High Margin',
    color: '#2563eb',
    textClass: 'text-blue-700 dark:text-blue-300',
    activeCardClass: 'border-blue-500 bg-blue-50/70 dark:bg-blue-950/50',
    icon: Sparkles,
  },
  DOG: {
    label: 'Dog',
    pluralLabel: 'Dogs',
    rule: 'Low Popularity · Low Margin',
    color: '#dc2626',
    textClass: 'text-red-700 dark:text-red-300',
    activeCardClass: 'border-red-500 bg-red-50/70 dark:bg-red-950/50',
    icon: TrendingDown,
  },
};

function QuadrantBadge({ classification }: { classification: MenuEngineeringClass }) {
  const meta = QUADRANT_META[classification];
  const Icon = meta.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${meta.textClass}`}>
      <Icon className="w-3.5 h-3.5 shrink-0" />
      <span>{meta.label}</span>
    </span>
  );
}

function MatrixTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: MenuEngineeringAnalyzedItem }>;
}) {
  if (!active || !payload || !payload.length) return null;
  const item = payload[0].payload;
  const meta = QUADRANT_META[item.classification];
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 text-xs shadow-sm max-w-[240px]">
      <div className="flex items-center justify-between gap-2 pb-1.5 border-b border-slate-100 dark:border-slate-800/80">
        <span className="font-semibold text-slate-900 dark:text-slate-50 truncate">{item.name}</span>
        <span className={`font-semibold shrink-0 ${meta.textClass}`}>{meta.label}</span>
      </div>
      <div className="mt-2 space-y-1 text-slate-600 dark:text-slate-300 font-mono tabular-nums">
        <div className="flex justify-between gap-4">
          <span className="font-sans text-slate-500 dark:text-slate-400">Units Sold</span>
          <span className="font-semibold text-slate-900 dark:text-slate-50">
            {formatNum(item.unitsSold, 0)} ({formatNum(item.menuMixPct, 1)}%)
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="font-sans text-slate-500 dark:text-slate-400">Unit Margin</span>
          <span className="font-semibold text-slate-900 dark:text-slate-50">{formatPHP(item.unitContributionMargin)}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="font-sans text-slate-500 dark:text-slate-400">Food Cost %</span>
          <span className="font-semibold text-slate-900 dark:text-slate-50">{formatNum(item.foodCostPct, 1)}%</span>
        </div>
        <div className="flex justify-between gap-4 pt-1 border-t border-slate-100 dark:border-slate-800/80">
          <span className="font-sans text-slate-500 dark:text-slate-400">Total CM</span>
          <span className="font-semibold text-slate-900 dark:text-slate-50">{formatPHP(item.totalContributionMargin)}</span>
        </div>
      </div>
    </div>
  );
}

export function MenuEngineeringDashboard({
  locations = [],
  activeLocationId,
  refreshTrigger = 0,
  onSelectProductForEdit,
}: MenuEngineeringDashboardProps) {
  const { isDark, highContrast } = useTheme();
  const gridStroke = isDark ? (highContrast ? '#475569' : '#1e293b') : (highContrast ? '#94a3b8' : '#e2e8f0');
  const axisTickFill = isDark ? (highContrast ? '#f8fafc' : '#94a3b8') : (highContrast ? '#0f172a' : '#64748b');
  const axisStroke = isDark ? '#334155' : (highContrast ? '#475569' : '#cbd5e1');
  const refStroke = isDark ? '#94a3b8' : '#475569';
  const selStroke = isDark ? '#f8fafc' : '#0f172a';
  const unselStroke = isDark ? '#0f172a' : '#ffffff';

  const [days, setDays] = useState<'7' | '30' | '90' | 'all'>('30');
  const [locationFilter, setLocationFilter] = useState<string>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [quadrantFilter, setQuadrantFilter] = useState<QuadrantFilter>('ALL');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('totalContributionMargin');
  const [sortAsc, setSortAsc] = useState(false);

  const [report, setReport] = useState<MenuEngineeringResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const loadMatrix = useCallback(async () => {
    try {
      setLoading(true);
      setErr('');
      const params = new URLSearchParams({
        days,
        locationId: locationFilter,
        categoryId: categoryFilter,
      });
      const data = await apiFetch<MenuEngineeringResponse>(
        `/products/menu-engineering?${params.toString()}`,
      );
      setReport(data);
      setSelectedId((prev) => {
        if (prev && data.items.some((it) => it.productId === prev)) return prev;
        return data.items[0]?.productId || null;
      });
    } catch (e: any) {
      setErr(e?.message || 'Unable to load menu engineering metrics');
    } finally {
      setLoading(false);
    }
  }, [days, locationFilter, categoryFilter, refreshTrigger]);

  useEffect(() => {
    void loadMatrix();
  }, [loadMatrix]);

  const filteredItems = useMemo(() => {
    if (!report) return [];
    const q = search.trim().toLowerCase();
    const list = report.items.filter((item) => {
      if (quadrantFilter !== 'ALL' && item.classification !== quadrantFilter) return false;
      if (
        q &&
        !item.name.toLowerCase().includes(q) &&
        !item.sku.toLowerCase().includes(q) &&
        !item.categoryName.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
    const sorted = [...list].sort((a, b) => {
      const diff = Number(a[sortKey]) - Number(b[sortKey]);
      return sortAsc ? diff : -diff;
    });
    return sorted;
  }, [report, quadrantFilter, search, sortKey, sortAsc]);

  const selectedItem = useMemo(() => {
    if (!report) return null;
    return (
      report.items.find((i) => i.productId === selectedId) ||
      filteredItems[0] ||
      report.items[0] ||
      null
    );
  }, [report, selectedId, filteredItems]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc((prev) => !prev);
    } else {
      setSortKey(key);
      setSortAsc(false);
    }
  };

  const handleExportCsv = () => {
    if (!filteredItems.length) return;
    downloadCsv(
      `maximus_menu_engineering_${days}d.csv`,
      filteredItems.map((i) => ({
        SKU: i.sku,
        Product: i.name,
        Category: i.categoryName,
        Quadrant: i.label,
        Units_Sold: i.unitsSold,
        Menu_Mix_Pct: i.menuMixPct,
        Selling_Price: i.sellingPrice,
        Unit_Direct_Cost: i.unitDirectCost,
        Unit_Contribution_Margin: i.unitContributionMargin,
        Food_Cost_Pct: i.foodCostPct,
        Total_Revenue: i.totalRevenue,
        Total_Contribution_Margin: i.totalContributionMargin,
        Recommended_Action: i.actionTitle,
      })),
    );
  };

  const summary = report?.summary;
  const maxMixPct = useMemo(() => {
    if (!report) return 20;
    const maxItemMix = report.items.reduce((m, i) => Math.max(m, i.menuMixPct), 0);
    return Math.max(
      Math.ceil(Math.max(maxItemMix, report.summary.popularityBenchmarkPct * 1.4, 5) * 1.15),
      10,
    );
  }, [report]);

  const marginBounds = useMemo(() => {
    if (!report || !report.items.length) return { min: 0, max: 200 };
    const vals = report.items.map((i) => i.unitContributionMargin);
    const minVal = Math.min(0, ...vals);
    const maxVal = Math.max(report.summary.weightedAvgContributionMargin * 1.35, ...vals, 20);
    return {
      min: Math.floor(minVal * 1.1),
      max: Math.ceil(maxVal * 1.15),
    };
  }, [report]);

  return (
    <div className="space-y-6">
      {/* Control Toolbar */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 p-0.5">
            {(
              [
                ['7', '7D'],
                ['30', '30D'],
                ['90', '90D'],
                ['all', 'All Time'],
              ] as const
            ).map(([val, label]) => (
              <button
                key={val}
                type="button"
                onClick={() => setDays(val)}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                  days === val
                    ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {locations.length > 0 && (
            <select
              value={locationFilter}
              onChange={(e) => setLocationFilter(e.target.value)}
              className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200"
            >
              <option value="ALL">All Trucks &amp; Sites</option>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.name}
                  {activeLocationId === loc.id ? ' (Current)' : ''}
                </option>
              ))}
            </select>
          )}

          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200"
          >
            <option value="ALL">All Categories</option>
            {(report?.categories || []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter menu item..."
              className="w-48 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 pl-8 pr-3 py-1.5 text-xs text-slate-800 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-slate-400 dark:focus:border-slate-500"
            />
          </div>
          <button
            type="button"
            onClick={() => void loadMatrix()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={!filteredItems.length}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40"
          >
            <Download className="w-3.5 h-3.5" />
            Export CSV
          </button>
        </div>
      </div>

      {err && (
        <div className="rounded-lg border border-red-200 dark:border-red-800/80 bg-red-50 dark:bg-red-950/50 p-3 text-xs font-medium text-red-700 dark:text-red-300">
          {err}
        </div>
      )}

      {/* 4 KPI Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Total Contribution Margin</p>
          <p className="mt-1.5 font-mono tabular-nums text-2xl font-semibold text-slate-900 dark:text-slate-50">
            {formatPHP(summary?.totalContributionMargin || 0)}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            Menu Revenue {formatPHP(summary?.totalRevenue || 0)} · Food Cost {formatNum(summary?.overallFoodCostPct || 0, 1)}%
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Units Sold (Analyzed)</p>
          <p className="mt-1.5 font-mono tabular-nums text-2xl font-semibold text-slate-900 dark:text-slate-50">
            {formatNum(summary?.totalUnitsSold || 0, 0)}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            {summary?.activeSellingCount || 0} of {summary?.itemCount || 0} menu items · {report?.filters.ordersAnalyzed || 0} orders
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Weighted Avg Margin Cutoff</p>
          <p className="mt-1.5 font-mono tabular-nums text-2xl font-semibold text-slate-900 dark:text-slate-50">
            {formatPHP(summary?.weightedAvgContributionMargin || 0)}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Per-unit CM threshold for High vs Low margin
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Popularity Cutoff (70% Rule)</p>
          <p className="mt-1.5 font-mono tabular-nums text-2xl font-semibold text-slate-900 dark:text-slate-50">
            {formatNum(summary?.popularityBenchmarkPct || 0, 1)}%
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            {summary?.counts.STAR || 0} Stars · {summary?.counts.PLOWHORSE || 0} Plowhorses · {summary?.counts.PUZZLE || 0} Puzzles · {summary?.counts.DOG || 0} Dogs
          </p>
        </div>
      </div>

      {/* Zero Sales Notice */}
      {!loading && summary && summary.totalUnitsSold === 0 && (
        <div className="rounded-xl border border-amber-200 dark:border-amber-700/80 bg-amber-50 dark:bg-amber-950/45 p-4 text-xs text-amber-800 dark:text-amber-300">
          No completed POS orders matched this timeframe and site filter yet. Unit margins come from your current Recipe BOM costing; once orders are completed at POS, popularity mix percentages will update automatically.
        </div>
      )}

      {/* Scatter Matrix + Inspector */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* 2x2 Menu Engineering Matrix Chart */}
        <div className="xl:col-span-7 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">
                Kasavana &amp; Smith Menu Matrix
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Menu Mix Popularity (%) vs Unit Contribution Margin (PHP) · Click any point to inspect
              </p>
            </div>
            <div className="text-right text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
              <span>Pop ≥ {formatNum(summary?.popularityBenchmarkPct || 0, 1)}%</span>
              <span className="mx-1.5">·</span>
              <span>CM ≥ {formatPHP(summary?.weightedAvgContributionMargin || 0)}</span>
            </div>
          </div>

          <div className="h-[360px] w-full">
            {report && report.items.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 18, right: 20, bottom: 20, left: 6 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
                  <XAxis
                    type="number"
                    dataKey="menuMixPct"
                    name="Menu Mix"
                    domain={[0, maxMixPct]}
                    tickFormatter={(v) => `${v}%`}
                    tick={{ fontSize: 11, fill: axisTickFill }}
                    stroke={axisStroke}
                    label={{
                      value: 'Menu Mix Popularity (%)',
                      position: 'insideBottom',
                      offset: -10,
                      style: { fontSize: 11, fill: axisTickFill },
                    }}
                  />
                  <YAxis
                    type="number"
                    dataKey="unitContributionMargin"
                    name="Unit CM"
                    domain={[marginBounds.min, marginBounds.max]}
                    tickFormatter={(v) => `₱${v}`}
                    tick={{ fontSize: 11, fill: axisTickFill }}
                    stroke={axisStroke}
                    width={64}
                    label={{
                      value: 'Unit CM (PHP)',
                      angle: -90,
                      position: 'insideLeft',
                      style: { fontSize: 11, fill: axisTickFill, textAnchor: 'middle' },
                    }}
                  />
                  <ZAxis
                    type="number"
                    dataKey="totalContributionMargin"
                    range={[75, 420]}
                    name="Total CM"
                  />
                  <Tooltip content={<MatrixTooltip />} cursor={{ strokeDasharray: '3 3', stroke: '#94a3b8' }} />
                  {summary && (
                    <ReferenceLine
                      x={summary.popularityBenchmarkPct}
                      stroke={refStroke}
                      strokeDasharray="5 4"
                      label={{
                        value: `Pop ${formatNum(summary.popularityBenchmarkPct, 1)}%`,
                        position: 'top',
                        fill: refStroke,
                        fontSize: 10,
                      }}
                    />
                  )}
                  {summary && (
                    <ReferenceLine
                      y={summary.weightedAvgContributionMargin}
                      stroke={refStroke}
                      strokeDasharray="5 4"
                      label={{
                        value: `Avg CM ${formatPHP(summary.weightedAvgContributionMargin)}`,
                        position: 'insideTopRight',
                        fill: refStroke,
                        fontSize: 10,
                      }}
                    />
                  )}
                  <Scatter
                    data={filteredItems.length > 0 ? filteredItems : report.items}
                    onClick={(node: any) => {
                      const prodId = node?.productId || node?.payload?.productId;
                      if (prodId) setSelectedId(prodId);
                    }}
                    className="cursor-pointer"
                  >
                    {(filteredItems.length > 0 ? filteredItems : report.items).map((entry) => {
                      const isSel = selectedItem?.productId === entry.productId;
                      const color = QUADRANT_META[entry.classification].color;
                      return (
                        <Cell
                          key={entry.productId}
                          fill={color}
                          fillOpacity={isSel ? 0.95 : 0.72}
                          stroke={isSel ? selStroke : unselStroke}
                          strokeWidth={isSel ? 2.5 : 1.5}
                        />
                      );
                    })}
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-xs text-slate-500 dark:text-slate-400">
                {loading ? 'Calculating menu matrix...' : 'No menu products available to plot.'}
              </div>
            )}
          </div>

          {/* 4-Quadrant Legend Guide */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-slate-100 dark:border-slate-800/80">
            {(['STAR', 'PLOWHORSE', 'PUZZLE', 'DOG'] as MenuEngineeringClass[]).map((cls) => {
              const meta = QUADRANT_META[cls];
              const Icon = meta.icon;
              return (
                <div key={cls} className="text-[11px] text-slate-600 dark:text-slate-300">
                  <div className={`inline-flex items-center gap-1 font-semibold ${meta.textClass}`}>
                    <Icon className="w-3 h-3" />
                    <span>{meta.pluralLabel}</span>
                  </div>
                  <p className="text-slate-500 dark:text-slate-400 mt-0.5">{meta.rule}</p>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Panel: Quadrant Filter Breakdown + Product Action Inspector */}
        <div className="xl:col-span-5 space-y-4">
          {/* Quadrant Breakdown Cards */}
          <div className="grid grid-cols-2 gap-3">
            {(['STAR', 'PLOWHORSE', 'PUZZLE', 'DOG'] as MenuEngineeringClass[]).map((cls) => {
              const meta = QUADRANT_META[cls];
              const Icon = meta.icon;
              const qStats = summary?.quadrants[cls];
              const active = quadrantFilter === cls;
              return (
                <button
                  key={cls}
                  type="button"
                  onClick={() => setQuadrantFilter((prev) => (prev === cls ? 'ALL' : cls))}
                  className={`text-left rounded-xl border p-3.5 transition-colors ${
                    active
                      ? meta.activeCardClass
                      : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${meta.textClass}`}>
                      <Icon className="w-3.5 h-3.5" />
                      {meta.pluralLabel}
                    </span>
                    <span className="font-mono tabular-nums text-xs font-semibold text-slate-900 dark:text-slate-50">
                      {qStats?.count || 0}
                    </span>
                  </div>
                  <p className="mt-2 font-mono tabular-nums text-sm font-semibold text-slate-900 dark:text-slate-50">
                    {formatPHP(qStats?.totalContributionMargin || 0)}
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                    {formatNum(qStats?.marginSharePct || 0, 1)}% of CM · {formatNum(qStats?.unitsSold || 0, 0)} sold
                  </p>
                </button>
              );
            })}
          </div>

          {/* Item Spotlight & Action Inspector */}
          {selectedItem && (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
              <div className="flex items-start justify-between gap-3 border-b border-slate-100 dark:border-slate-800/80 pb-3.5">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-11 h-11 rounded-lg overflow-hidden bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-800 flex items-center justify-center shrink-0">
                    {selectedItem.imageUrl ? (
                      <img
                        src={selectedItem.imageUrl}
                        alt={selectedItem.name}
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <Utensils className="w-4 h-4 text-slate-500 dark:text-slate-400" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50 truncate">
                      {selectedItem.name}
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                      {selectedItem.sku} · {selectedItem.categoryName}
                    </p>
                  </div>
                </div>
                <QuadrantBadge classification={selectedItem.classification} />
              </div>

              <div className="grid grid-cols-3 gap-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 p-3">
                <div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">Selling Price</p>
                  <p className="font-mono tabular-nums text-sm font-semibold text-slate-900 dark:text-slate-50">
                    {formatPHP(selectedItem.sellingPrice)}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">Direct Cost</p>
                  <p className="font-mono tabular-nums text-sm font-semibold text-slate-900 dark:text-slate-50">
                    {formatPHP(selectedItem.unitDirectCost)}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">Unit Margin (CM)</p>
                  <p className="font-mono tabular-nums text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                    {formatPHP(selectedItem.unitContributionMargin)}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">Units Sold</p>
                  <p className="font-mono tabular-nums text-sm font-semibold text-slate-900 dark:text-slate-50">
                    {formatNum(selectedItem.unitsSold, 0)}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">Menu Mix %</p>
                  <p className="font-mono tabular-nums text-sm font-semibold text-slate-900 dark:text-slate-50">
                    {formatNum(selectedItem.menuMixPct, 1)}%
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">Food Cost %</p>
                  <p
                    className={`font-mono tabular-nums text-sm font-semibold ${
                      selectedItem.foodCostPct > selectedItem.targetFoodCostPct
                        ? 'text-amber-700 dark:text-amber-300'
                        : 'text-slate-900 dark:text-slate-50'
                    }`}
                  >
                    {formatNum(selectedItem.foodCostPct, 1)}%
                  </p>
                </div>
              </div>

              <div className="space-y-1">
                <p className="text-xs font-semibold text-slate-900 dark:text-slate-50">
                  Strategy: {selectedItem.actionTitle}
                </p>
                <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                  {selectedItem.actionRecommendation}
                </p>
              </div>

              <div className="flex items-center justify-between gap-3 pt-1">
                <span className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                  Total CM: <strong className="text-slate-900 dark:text-slate-50">{formatPHP(selectedItem.totalContributionMargin)}</strong>
                </span>
                <button
                  type="button"
                  onClick={() => onSelectProductForEdit(selectedItem.productId)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-3.5 py-2 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white whitespace-nowrap"
                >
                  <Pencil className="w-3.5 h-3.5" />
                  Edit Recipe &amp; Price
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Menu Engineering Performance Table */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                ['ALL', `All (${summary?.itemCount || 0})`],
                ['STAR', `Stars (${summary?.counts.STAR || 0})`],
                ['PLOWHORSE', `Plowhorses (${summary?.counts.PLOWHORSE || 0})`],
                ['PUZZLE', `Puzzles (${summary?.counts.PUZZLE || 0})`],
                ['DOG', `Dogs (${summary?.counts.DOG || 0})`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setQuadrantFilter(key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  quadrantFilter === key
                    ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950'
                    : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <ArrowUpDown className="w-3.5 h-3.5" />
            <span>Sort:</span>
            <select
              value={sortKey}
              onChange={(e) => {
                setSortKey(e.target.value as SortKey);
                setSortAsc(false);
              }}
              className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200"
            >
              <option value="totalContributionMargin">Total Contribution Margin</option>
              <option value="unitsSold">Units Sold</option>
              <option value="unitContributionMargin">Unit Margin (CM)</option>
              <option value="menuMixPct">Menu Mix %</option>
              <option value="foodCostPct">Food Cost %</option>
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
              <tr>
                <th className="p-3 font-semibold">Menu Item</th>
                <th className="p-3 font-semibold">Quadrant</th>
                <th
                  onClick={() => handleSort('unitsSold')}
                  className="p-3 font-semibold text-right cursor-pointer hover:text-slate-900 dark:hover:text-white"
                >
                  Units Sold
                </th>
                <th
                  onClick={() => handleSort('menuMixPct')}
                  className="p-3 font-semibold text-right cursor-pointer hover:text-slate-900 dark:hover:text-white"
                >
                  Mix %
                </th>
                <th className="p-3 font-semibold text-right">Price</th>
                <th className="p-3 font-semibold text-right">Unit Cost</th>
                <th
                  onClick={() => handleSort('unitContributionMargin')}
                  className="p-3 font-semibold text-right cursor-pointer hover:text-slate-900 dark:hover:text-white"
                >
                  Unit CM
                </th>
                <th
                  onClick={() => handleSort('foodCostPct')}
                  className="p-3 font-semibold text-right cursor-pointer hover:text-slate-900 dark:hover:text-white"
                >
                  Food Cost %
                </th>
                <th
                  onClick={() => handleSort('totalContributionMargin')}
                  className="p-3 font-semibold text-right cursor-pointer hover:text-slate-900 dark:hover:text-white"
                >
                  Total CM
                </th>
                <th className="p-3 font-semibold">Recommended Action</th>
                <th className="p-3 font-semibold text-right">BOM</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filteredItems.length === 0 ? (
                <tr>
                  <td colSpan={11} className="p-8 text-center text-slate-500 dark:text-slate-400">
                    No menu items match the selected quadrant or search filter.
                  </td>
                </tr>
              ) : (
                filteredItems.map((item) => {
                  const isSelected = selectedItem?.productId === item.productId;
                  return (
                    <tr
                      key={item.productId}
                      onClick={() => setSelectedId(item.productId)}
                      className={`cursor-pointer transition-colors ${
                        isSelected ? 'bg-slate-100/80' : 'hover:bg-slate-50 dark:hover:bg-slate-800'
                      }`}
                    >
                      <td className="p-3">
                        <p className="font-semibold text-slate-900 dark:text-slate-50">{item.name}</p>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400">
                          {item.sku} · {item.categoryName}
                          {!item.isAvailable ? ' · 86 / Unavailable' : ''}
                        </p>
                      </td>
                      <td className="p-3 whitespace-nowrap">
                        <QuadrantBadge classification={item.classification} />
                      </td>
                      <td className="p-3 text-right font-mono tabular-nums font-medium text-slate-800 dark:text-slate-100">
                        {formatNum(item.unitsSold, 0)}
                      </td>
                      <td className="p-3 text-right font-mono tabular-nums text-slate-700 dark:text-slate-200">
                        {formatNum(item.menuMixPct, 1)}%
                      </td>
                      <td className="p-3 text-right font-mono tabular-nums text-slate-700 dark:text-slate-200">
                        {formatPHP(item.sellingPrice)}
                      </td>
                      <td className="p-3 text-right font-mono tabular-nums text-slate-700 dark:text-slate-200">
                        {formatPHP(item.unitDirectCost)}
                      </td>
                      <td className="p-3 text-right font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-50">
                        {formatPHP(item.unitContributionMargin)}
                      </td>
                      <td
                        className={`p-3 text-right font-mono tabular-nums font-medium ${
                          item.foodCostPct > item.targetFoodCostPct
                            ? 'text-amber-700 dark:text-amber-300'
                            : 'text-slate-700 dark:text-slate-200'
                        }`}
                      >
                        {formatNum(item.foodCostPct, 1)}%
                      </td>
                      <td className="p-3 text-right font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-50">
                        {formatPHP(item.totalContributionMargin)}
                      </td>
                      <td className="p-3 text-slate-600 dark:text-slate-300 max-w-[200px]">
                        <span className="font-medium text-slate-800 dark:text-slate-100">{item.actionTitle}</span>
                      </td>
                      <td className="p-3 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectProductForEdit(item.productId);
                          }}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <Pencil className="w-3 h-3" /> Edit
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
