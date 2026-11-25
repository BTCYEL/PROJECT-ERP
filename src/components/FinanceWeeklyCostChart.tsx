import React, { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertTriangle, CheckCircle2, Truck } from 'lucide-react';
import { apiFetch, formatNum, formatPHP } from '../lib/api.ts';
import { WeeklyFoodCostPoint, WeeklyFoodCostResponse } from '../lib/financeCharts.ts';
import { useTheme } from '../lib/theme.ts';
import { LocationRow } from '../types/erp.ts';

interface Props {
  locations: LocationRow[];
  activeLocationId?: string;
}

function WeeklyTooltip({
  active,
  payload,
  targetPct,
}: {
  active?: boolean;
  payload?: Array<{ payload?: WeeklyFoodCostPoint }>;
  targetPct: number;
}) {
  if (!active || !payload || !payload.length) return null;
  const pt = payload[0]?.payload;
  if (!pt) return null;

  const isOverTarget = pt.foodCostPct !== null && pt.foodCostPct > targetPct;

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 shadow-md text-xs space-y-1.5 min-w-[220px]">
      <div className="font-semibold text-slate-900 dark:text-slate-50 border-b border-slate-100 dark:border-slate-800/80 pb-1">
        {pt.weekRange}
      </div>
      {pt.orderCount === 0 && pt.totalFoodCost === 0 ? (
        <p className="text-slate-500 dark:text-slate-400 py-1">No recorded sales or COGS this week</p>
      ) : (
        <div className="space-y-1 font-mono tabular-nums">
          <div className="flex justify-between gap-4">
            <span className="font-sans text-slate-500 dark:text-slate-400">Net Revenue (ex-VAT)</span>
            <span className="font-semibold text-slate-900 dark:text-slate-50">{formatPHP(pt.netRevenue)}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="font-sans text-slate-500 dark:text-slate-400">POS Sales COGS</span>
            <span className="text-slate-700 dark:text-slate-200">{formatPHP(pt.saleCogs)}</span>
          </div>
          {pt.wasteCost > 0 && (
            <div className="flex justify-between gap-4">
              <span className="font-sans text-slate-500 dark:text-slate-400">Waste &amp; Spoilage</span>
              <span className="text-amber-700 dark:text-amber-300">{formatPHP(pt.wasteCost)}</span>
            </div>
          )}
          <div className="flex justify-between gap-4 border-t border-slate-100 dark:border-slate-800/80 pt-1">
            <span className="font-sans text-slate-600 dark:text-slate-300 font-medium">Food Cost %</span>
            <span className={`font-bold ${isOverTarget ? 'text-red-600 dark:text-red-300' : 'text-emerald-700 dark:text-emerald-300'}`}>
              {pt.foodCostPct !== null ? `${formatNum(pt.foodCostPct, 1)}%` : '—'}
            </span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="font-sans text-slate-500 dark:text-slate-400">Gross Margin %</span>
            <span className="text-slate-700 dark:text-slate-200">
              {pt.grossMarginPct !== null ? `${formatNum(pt.grossMarginPct, 1)}%` : '—'}
            </span>
          </div>
          <div className="flex justify-between gap-4 text-[11px] text-slate-500 dark:text-slate-400 pt-0.5">
            <span className="font-sans">Completed Orders</span>
            <span>{formatNum(pt.orderCount, 0)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function FinanceWeeklyCostChart({ locations, activeLocationId = 'ALL' }: Props) {
  const truckLocations = useMemo(
    () => locations.filter((l) => l.type === 'FOOD_TRUCK' && l.is_active !== 0),
    [locations],
  );

  const { isDark, highContrast } = useTheme();
  const gridStroke = isDark ? (highContrast ? '#475569' : '#1e293b') : (highContrast ? '#94a3b8' : '#e2e8f0');
  const axisTickFill = isDark ? (highContrast ? '#f8fafc' : '#94a3b8') : (highContrast ? '#0f172a' : '#64748b');
  const axisLineStroke = isDark ? '#334155' : (highContrast ? '#475569' : '#cbd5e1');
  const pctAxisFill = isDark ? '#fbbf24' : '#b45309';
  const barFill = isDark ? '#e2e8f0' : '#0f172a';
  const dotStroke = isDark ? '#0f172a' : '#ffffff';
  const targetRefColor = isDark ? '#f87171' : '#dc2626';

  const [chartLocId, setChartLocId] = useState<string>(activeLocationId || 'ALL');
  const [weeks, setWeeks] = useState<4 | 8 | 12>(8);
  const [chartData, setChartData] = useState<WeeklyFoodCostResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setChartLocId(activeLocationId || 'ALL');
  }, [activeLocationId]);

  const loadWeeklyTrends = async (locId: string, weekWindow: number) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ weeks: String(weekWindow) });
      if (locId && locId !== 'ALL') {
        params.set('locationId', locId);
      }
      const res = await apiFetch<WeeklyFoodCostResponse>(`/finance/weekly-food-cost?${params.toString()}`);
      setChartData(res);
    } catch (e: any) {
      setError(e.message || 'Unable to load weekly food cost vs. revenue trends');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadWeeklyTrends(chartLocId, weeks);
  }, [chartLocId, weeks]);

  const selectedLocationLabel = useMemo(() => {
    if (!chartLocId || chartLocId === 'ALL') return 'All Food Trucks';
    return locations.find((l) => l.id === chartLocId)?.name || 'Selected Truck';
  }, [chartLocId, locations]);

  const targetPct = chartData?.targetFoodCostPct ?? 35;
  const summary = chartData?.summary;
  const avgPct = summary?.avgFoodCostPct ?? null;
  const isBlendedOverTarget = avgPct !== null && avgPct > targetPct;

  return (
    <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
      <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Truck className="w-4 h-4 text-slate-700 dark:text-slate-200 shrink-0" />
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">
              Weekly Food Cost % vs. Net Revenue
            </h2>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            <span>{selectedLocationLabel}</span>
            <span aria-hidden="true"> · </span>
            <span>Ex-VAT net sales vs. FIFO COGS &amp; waste</span>
            <span aria-hidden="true"> · </span>
            <span className="font-mono tabular-nums">Target ≤ {formatNum(targetPct, 1)}%</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Food Truck Location Segmented Toggle */}
          <div
            role="group"
            aria-label="Filter chart by food truck location"
            className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-800"
          >
            <button
              type="button"
              onClick={() => setChartLocId('ALL')}
              className={`px-2.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                chartLocId === 'ALL'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50 shadow-sm'
                  : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              All Trucks
            </button>
            {truckLocations.map((loc) => (
              <button
                key={loc.id}
                type="button"
                onClick={() => setChartLocId(loc.id)}
                className={`px-2.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                  chartLocId === loc.id
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50 shadow-sm'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {loc.name}
              </button>
            ))}
          </div>

          {/* Week Window Toggle */}
          <div
            role="group"
            aria-label="Select weekly timeframe"
            className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-800"
          >
            {([4, 8, 12] as const).map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setWeeks(w)}
                className={`px-2.5 py-1.5 rounded-md text-xs font-mono font-medium whitespace-nowrap shrink-0 transition-colors ${
                  weeks === w
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50 shadow-sm'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {w}W
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Period Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 border-y border-slate-100 dark:border-slate-800/80 py-3">
        <div>
          <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Period Net Revenue</p>
          <p className="font-mono tabular-nums text-lg font-bold text-slate-900 dark:text-slate-50 mt-0.5">
            {summary ? formatPHP(summary.totalNetRevenue) : '—'}
          </p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            {summary ? `${summary.activeWeeks} active week${summary.activeWeeks === 1 ? '' : 's'}` : 'Loading...'}
          </p>
        </div>
        <div>
          <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Total Food Cost (COGS + Waste)</p>
          <p className="font-mono tabular-nums text-lg font-bold text-slate-900 dark:text-slate-50 mt-0.5">
            {summary ? formatPHP(summary.totalFoodCost) : '—'}
          </p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            {summary ? `Waste: ${formatPHP(summary.totalWasteCost)}` : '—'}
          </p>
        </div>
        <div>
          <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Blended Food Cost %</p>
          <div className="flex items-baseline gap-2 mt-0.5">
            <span
              className={`font-mono tabular-nums text-lg font-bold ${
                avgPct === null
                  ? 'text-slate-500 dark:text-slate-400'
                  : isBlendedOverTarget
                  ? 'text-red-700 dark:text-red-300'
                  : 'text-emerald-700 dark:text-emerald-300'
              }`}
            >
              {avgPct !== null ? `${formatNum(avgPct, 1)}%` : '—'}
            </span>
            {avgPct !== null && (
              <span
                className={`inline-flex items-center gap-1 text-[11px] font-semibold ${
                  isBlendedOverTarget ? 'text-red-700 dark:text-red-300' : 'text-emerald-700 dark:text-emerald-300'
                }`}
              >
                {isBlendedOverTarget ? (
                  <>
                    <AlertTriangle className="w-3 h-3 shrink-0" />
                    <span>Above Target</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-3 h-3 shrink-0" />
                    <span>On Target</span>
                  </>
                )}
              </span>
            )}
          </div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            Benchmark ≤ {formatNum(targetPct, 1)}%
          </p>
        </div>
        <div>
          <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Completed Orders</p>
          <p className="font-mono tabular-nums text-lg font-bold text-slate-900 dark:text-slate-50 mt-0.5">
            {summary ? formatNum(summary.totalOrders, 0) : '—'}
          </p>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">Last {weeks} calendar weeks</p>
        </div>
      </div>

      {/* Chart Area */}
      {error ? (
        <div className="rounded-lg border border-red-200 dark:border-red-800/80 bg-red-50 dark:bg-red-950/50 p-4 flex items-center justify-between gap-3 text-xs text-red-700 dark:text-red-300">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => void loadWeeklyTrends(chartLocId, weeks)}
            className="rounded-md border border-red-300 dark:border-red-800/80 bg-white dark:bg-slate-900 px-3 py-1 font-semibold text-red-800 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/70 shrink-0"
          >
            Retry
          </button>
        </div>
      ) : loading ? (
        <div className="h-72 w-full rounded-lg border border-slate-100 dark:border-slate-800/80 bg-slate-50 dark:bg-slate-800/70 animate-pulse" />
      ) : !chartData || chartData.summary.totalOrders === 0 ? (
        <div className="h-72 w-full rounded-lg border border-dashed border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50 flex flex-col items-center justify-center p-6 text-center space-y-1.5">
          <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            No completed POS sales for {selectedLocationLabel}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md">
            Switch food truck locations above or record POS transactions to compare weekly net revenue against food cost percentage.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="h-72 w-full min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData.series} margin={{ top: 16, right: 16, left: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
                <XAxis
                  dataKey="weekLabel"
                  tick={{ fontSize: 11, fill: axisTickFill }}
                  axisLine={{ stroke: axisLineStroke }}
                  tickLine={false}
                />
                <YAxis
                  yAxisId="rev"
                  tick={{ fontSize: 11, fill: axisTickFill }}
                  axisLine={false}
                  tickLine={false}
                  width={64}
                  tickFormatter={(v: number) =>
                    v >= 1000 ? `₱${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k` : `₱${v}`
                  }
                />
                <YAxis
                  yAxisId="pct"
                  orientation="right"
                  domain={[0, (max: number) => Math.max(50, Math.ceil((Number(max || 0) + 10) / 10) * 10)]}
                  tick={{ fontSize: 11, fill: pctAxisFill }}
                  axisLine={false}
                  tickLine={false}
                  width={44}
                  tickFormatter={(v: number) => `${v}%`}
                />
                <Tooltip content={<WeeklyTooltip targetPct={targetPct} />} />
                <ReferenceLine
                  yAxisId="pct"
                  y={targetPct}
                  stroke={targetRefColor}
                  strokeDasharray="4 4"
                  label={{
                    value: `Target ${formatNum(targetPct, 0)}%`,
                    position: 'insideTopRight',
                    fill: targetRefColor,
                    fontSize: 10,
                    fontWeight: 600,
                  }}
                />
                <Bar
                  yAxisId="rev"
                  dataKey="netRevenue"
                  name="Net Revenue (PHP)"
                  fill={barFill}
                  radius={[4, 4, 0, 0]}
                  maxBarSize={42}
                />
                <Line
                  yAxisId="pct"
                  type="monotone"
                  dataKey="foodCostPct"
                  name="Food Cost %"
                  stroke="#f59e0b"
                  strokeWidth={2.5}
                  connectNulls={false}
                  dot={{ r: 4, fill: '#f59e0b', stroke: dotStroke, strokeWidth: 2 }}
                  activeDot={{ r: 6, fill: targetRefColor, stroke: dotStroke, strokeWidth: 2 }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-5 text-[11px] text-slate-600 dark:text-slate-300 pt-1">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-2.5 rounded-sm bg-slate-900 dark:bg-slate-100 inline-block" aria-hidden="true" />
              <span>Net Revenue (PHP, Left Axis)</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3.5 h-0.5 bg-amber-600 inline-block" aria-hidden="true" />
              <span>Food Cost % (Right Axis)</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3.5 border-t border-dashed border-red-600 inline-block" aria-hidden="true" />
              <span>Target Food Cost ({formatNum(targetPct, 1)}%)</span>
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
