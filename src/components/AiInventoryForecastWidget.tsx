import React, { useEffect, useState } from 'react';
import {
  Sparkles,
  RefreshCw,
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  ArrowRightLeft,
  ShoppingBag,
  Info,
  Layers,
} from 'lucide-react';
import { apiFetch, formatNum, formatPHP } from '../lib/api.ts';
import { LocationRow } from '../types/erp.ts';

interface Props {
  selectedLocationId: string;
  locations: LocationRow[];
  onNavigate: (tab: string) => void;
  onQuickAction?: (tab: string, action?: string) => void;
}

interface ForecastItem {
  id?: string;
  sku: string;
  name: string;
  category: string;
  uom: string;
  unitCost: number;
  onHand: number;
  reorderPt: number;
  estimatedDailyBurn: number;
  daysOfSupply: number;
  projectedDemand: number;
  projectedStockAfterHorizon: number;
  riskLevel: 'CRITICAL' | 'HIGH' | 'OPTIMAL';
  suggestedRestock: number;
  estimatedCost: number;
  reason: string;
}

interface ForecastSummary {
  totalItemsAnalyzed: number;
  criticalCount: number;
  highRiskCount: number;
  totalRecommendedRestockUnits: number;
  totalEstimatedReplenishmentCostPhp: number;
  strategicAdvice: string;
}

export function AiInventoryForecastWidget({
  selectedLocationId,
  locations,
  onNavigate,
  onQuickAction,
}: Props) {
  const [horizonDays, setHorizonDays] = useState<3 | 5 | 7>(5);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [forecastSource, setForecastSource] = useState<'gemini' | 'algorithmic'>('algorithmic');
  const [summary, setSummary] = useState<ForecastSummary | null>(null);
  const [items, setItems] = useState<ForecastItem[]>([]);
  const [activeTabFilter, setActiveTabFilter] = useState<'all' | 'critical' | 'high' | 'optimal'>('all');

  const selectedLoc = locations.find((l) => l.id === selectedLocationId);
  const locationLabel = selectedLoc ? selectedLoc.name : 'All Food Trucks (Fleet)';

  const fetchForecast = async (isManualRefresh = false) => {
    if (isManualRefresh) setRefreshing(true);
    else setLoading(true);
    setError('');

    try {
      const res = await apiFetch<{
        source: 'gemini' | 'algorithmic';
        horizonDays: number;
        summary: ForecastSummary;
        items: ForecastItem[];
      }>('/ai/inventory-forecast', {
        method: 'POST',
        body: JSON.stringify({
          locationId: selectedLocationId || 'ALL',
          horizonDays,
          truckName: locationLabel,
        }),
      });

      if (res && res.items) {
        setForecastSource(res.source || 'algorithmic');
        setSummary(res.summary);
        setItems(res.items);
      }
    } catch (err: any) {
      setError(err.message || 'Unable to generate inventory forecast');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchForecast();
  }, [selectedLocationId, horizonDays]);

  const filteredItems = items.filter((item) => {
    if (activeTabFilter === 'critical') return item.riskLevel === 'CRITICAL';
    if (activeTabFilter === 'high') return item.riskLevel === 'HIGH';
    if (activeTabFilter === 'optimal') return item.riskLevel === 'OPTIMAL';
    return true;
  });

  const criticalCount = items.filter((i) => i.riskLevel === 'CRITICAL').length;
  const highCount = items.filter((i) => i.riskLevel === 'HIGH').length;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4 shadow-xs">
      {/* Header bar */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-lg bg-indigo-600 text-white shrink-0 shadow-xs">
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-display text-base font-semibold text-slate-900">
                AI Inventory &amp; Supply Need Forecast
              </h2>
              <span
                className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-md ${
                  forecastSource === 'gemini'
                    ? 'bg-purple-50 text-purple-700 border border-purple-200'
                    : 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                }`}
              >
                {forecastSource === 'gemini' ? 'Gemini 4 Hydrogen AI' : 'BOM Sales Burn Engine'}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Projected demand &amp; stockout risks based on 7-day recipe velocity for{' '}
              <strong className="text-slate-700">{locationLabel}</strong>
            </p>
          </div>
        </div>

        {/* Controls: Horizon & Refresh */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg border border-slate-200">
            {([3, 5, 7] as const).map((h) => (
              <button
                key={h}
                type="button"
                onClick={() => setHorizonDays(h)}
                className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 font-mono ${
                  horizonDays === h
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {h}D Horizon
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => fetchForecast(true)}
            disabled={loading || refreshing}
            title="Refresh Forecast"
            className="p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-3 py-6">
          <div className="h-16 rounded-lg bg-slate-100 animate-pulse" />
          <div className="h-32 rounded-lg bg-slate-100 animate-pulse" />
        </div>
      ) : (
        <>
          {/* AI Strategic Recommendation Box */}
          {summary?.strategicAdvice && (
            <div className="p-3.5 rounded-lg border border-indigo-100 bg-indigo-50/60 flex items-start gap-3">
              <Info className="w-4 h-4 text-indigo-700 shrink-0 mt-0.5" />
              <div className="text-xs text-indigo-950 space-y-0.5">
                <span className="font-semibold text-indigo-900">AI Operational Insight:</span>{' '}
                <span>{summary.strategicAdvice}</span>
              </div>
            </div>
          )}

          {/* Metric KPI Tiles */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className={`p-3 rounded-xl border ${
              criticalCount > 0 ? 'bg-red-50/50 border-red-200' : 'bg-slate-50 border-slate-200'
            }`}>
              <div className="flex items-center justify-between text-slate-500 text-xs">
                <span>Critical Depletion</span>
                <AlertOctagon className={`w-3.5 h-3.5 ${criticalCount > 0 ? 'text-red-600' : 'text-slate-400'}`} />
              </div>
              <p className={`text-xl font-bold font-mono tabular-nums mt-1 ${criticalCount > 0 ? 'text-red-700' : 'text-slate-800'}`}>
                {criticalCount}
              </p>
              <p className="text-[11px] text-slate-500">out of stock within {horizonDays}d</p>
            </div>

            <div className={`p-3 rounded-xl border ${
              highCount > 0 ? 'bg-amber-50/50 border-amber-200' : 'bg-slate-50 border-slate-200'
            }`}>
              <div className="flex items-center justify-between text-slate-500 text-xs">
                <span>High Reorder Risk</span>
                <AlertTriangle className={`w-3.5 h-3.5 ${highCount > 0 ? 'text-amber-600' : 'text-slate-400'}`} />
              </div>
              <p className={`text-xl font-bold font-mono tabular-nums mt-1 ${highCount > 0 ? 'text-amber-700' : 'text-slate-800'}`}>
                {highCount}
              </p>
              <p className="text-[11px] text-slate-500">breaching safety stock</p>
            </div>

            <div className="p-3 rounded-xl border border-slate-200 bg-slate-50">
              <div className="flex items-center justify-between text-slate-500 text-xs">
                <span>Restock Required</span>
                <Layers className="w-3.5 h-3.5 text-slate-400" />
              </div>
              <p className="text-xl font-bold font-mono tabular-nums text-slate-900 mt-1">
                {summary?.totalRecommendedRestockUnits ?? 0}
              </p>
              <p className="text-[11px] text-slate-500">recommended units</p>
            </div>

            <div className="p-3 rounded-xl border border-slate-200 bg-slate-50">
              <div className="flex items-center justify-between text-slate-500 text-xs">
                <span>Estimated Cost</span>
                <ShoppingBag className="w-3.5 h-3.5 text-slate-400" />
              </div>
              <p className="text-xl font-bold font-mono tabular-nums text-slate-900 mt-1">
                {formatPHP(summary?.totalEstimatedReplenishmentCostPhp ?? 0)}
              </p>
              <p className="text-[11px] text-slate-500">projected replenishment</p>
            </div>
          </div>

          {/* Quick Filters and Action bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg border border-slate-200">
              {([
                { id: 'all', label: `All Ingredients (${items.length})` },
                { id: 'critical', label: `Critical (${criticalCount})` },
                { id: 'high', label: `High Risk (${highCount})` },
                { id: 'optimal', label: `Optimal (${items.length - criticalCount - highCount})` },
              ] as const).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTabFilter(tab.id)}
                  className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 font-mono tabular-nums ${
                    activeTabFilter === tab.id
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  if (onQuickAction) onQuickAction('inventory', 'new-transfer');
                  else onNavigate('inventory');
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
              >
                <ArrowRightLeft className="w-3.5 h-3.5 text-slate-600" />
                Commissary Transfer
              </button>

              <button
                type="button"
                onClick={() => {
                  if (onQuickAction) onQuickAction('procurement', 'new-po');
                  else onNavigate('procurement');
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
              >
                <ShoppingBag className="w-3.5 h-3.5" />
                Create PO
              </button>
            </div>
          </div>

          {/* Table of Forecasted Ingredients */}
          <div className="rounded-xl border border-slate-200 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                <tr>
                  <th className="p-3 font-medium">Ingredient / Item</th>
                  <th className="p-3 font-medium text-right">Current On-Hand</th>
                  <th className="p-3 font-medium text-right">Daily Burn Rate</th>
                  <th className="p-3 font-medium text-center">Days of Supply</th>
                  <th className="p-3 font-medium text-right">{horizonDays}D Demand</th>
                  <th className="p-3 font-medium text-right">Suggested Restock</th>
                  <th className="p-3 font-medium text-right">Est. Cost</th>
                  <th className="p-3 font-medium text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredItems.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="p-6 text-center text-slate-400">
                      No ingredients found for the selected risk filter.
                    </td>
                  </tr>
                ) : (
                  filteredItems.map((item) => {
                    const isCritical = item.riskLevel === 'CRITICAL';
                    const isHigh = item.riskLevel === 'HIGH';

                    return (
                      <tr
                        key={item.sku}
                        className={`hover:bg-slate-50/70 transition-colors ${
                          isCritical ? 'bg-red-50/20' : isHigh ? 'bg-amber-50/20' : ''
                        }`}
                      >
                        <td className="p-3">
                          <p className="font-semibold text-slate-900">{item.name}</p>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="font-mono text-[10px] text-slate-500">{item.sku}</span>
                            <span className="text-slate-300">·</span>
                            <span className="text-[10px] text-slate-500">{item.category}</span>
                          </div>
                          {item.reason && (
                            <p className="text-[11px] text-slate-500 mt-1 max-w-xs leading-snug">{item.reason}</p>
                          )}
                        </td>

                        <td className="p-3 text-right font-mono tabular-nums font-semibold text-slate-900">
                          {formatNum(item.onHand)} {item.uom}
                        </td>

                        <td className="p-3 text-right font-mono tabular-nums text-slate-600">
                          ~{formatNum(item.estimatedDailyBurn, 1)} {item.uom}/d
                        </td>

                        <td className="p-3 text-center">
                          <span
                            className={`inline-block font-mono tabular-nums font-semibold px-2 py-0.5 rounded text-[11px] ${
                              item.daysOfSupply <= 2
                                ? 'bg-red-100 text-red-800'
                                : item.daysOfSupply <= 5
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-emerald-100 text-emerald-800'
                            }`}
                          >
                            {item.daysOfSupply >= 99 ? '99+ d' : `${formatNum(item.daysOfSupply, 1)} d`}
                          </span>
                        </td>

                        <td className="p-3 text-right font-mono tabular-nums text-slate-700">
                          {formatNum(item.projectedDemand, 1)} {item.uom}
                        </td>

                        <td className="p-3 text-right">
                          {item.suggestedRestock > 0 ? (
                            <span className="font-mono tabular-nums font-bold text-indigo-700">
                              +{item.suggestedRestock} {item.uom}
                            </span>
                          ) : (
                            <span className="font-mono text-slate-400">—</span>
                          )}
                        </td>

                        <td className="p-3 text-right font-mono tabular-nums text-slate-800">
                          {item.estimatedCost > 0 ? formatPHP(item.estimatedCost) : '—'}
                        </td>

                        <td className="p-3 text-center whitespace-nowrap">
                          {isCritical ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-red-700">
                              <AlertOctagon className="w-3.5 h-3.5 shrink-0" /> CRITICAL
                            </span>
                          ) : isHigh ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-700">
                              <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> HIGH RISK
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700">
                              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> OPTIMAL
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
