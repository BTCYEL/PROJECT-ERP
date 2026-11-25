import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Minus,
} from 'lucide-react';
import { apiFetch, formatNum, formatPHP } from '../lib/api.ts';
import { PredictiveProcurementResponse, PredictiveRestockItem } from '../lib/predictiveProcurement.ts';
import { LocationRow } from '../types/erp.ts';

interface Props {
  locations: LocationRow[];
  activeLocationId: string;
  canCreatePo: boolean;
  onPoCreated?: () => Promise<void> | void;
  onNavigateToProcurement?: () => void;
}

type ViewFilter = 'HIGH_VELOCITY' | 'RESTOCK_NEEDED' | 'ALL';

interface CreatedPoReceipt {
  id: string;
  poNumber: string;
  supplierId: string;
  supplierName: string;
  status: string;
  totalAmount: number;
  lineCount: number;
}

export function PredictiveProcurementPanel({
  locations,
  activeLocationId,
  canCreatePo,
  onPoCreated,
  onNavigateToProcurement,
}: Props) {
  const [coverageDays, setCoverageDays] = useState<7 | 14 | 21>(14);
  const [viewFilter, setViewFilter] = useState<ViewFilter>('HIGH_VELOCITY');
  const [plan, setPlan] = useState<PredictiveProcurementResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [submittingStatus, setSubmittingStatus] = useState<'DRAFT' | 'PENDING_APPROVAL' | null>(null);
  const [error, setError] = useState('');
  const [createdPos, setCreatedPos] = useState<CreatedPoReceipt[]>([]);

  // User-editable overrides keyed by inventoryItemId
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [qtyOverrides, setQtyOverrides] = useState<Record<string, string>>({});
  const [supplierOverrides, setSupplierOverrides] = useState<Record<string, string>>({});

  // Delivery location for auto-generated POs (cannot be 'ALL')
  const defaultDeliveryLocId = useMemo(() => {
    if (activeLocationId && activeLocationId !== 'ALL') return activeLocationId;
    const commissary = locations.find((l) => l.type === 'COMMISSARY');
    return commissary?.id || locations[0]?.id || '';
  }, [activeLocationId, locations]);

  const [deliveryLocationId, setDeliveryLocationId] = useState<string>(defaultDeliveryLocId);

  useEffect(() => {
    if (activeLocationId && activeLocationId !== 'ALL') {
      setDeliveryLocationId(activeLocationId);
    } else if (!deliveryLocationId && defaultDeliveryLocId) {
      setDeliveryLocationId(defaultDeliveryLocId);
    }
  }, [activeLocationId, defaultDeliveryLocId, deliveryLocationId]);

  const loadPlan = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams();
      if (activeLocationId && activeLocationId !== 'ALL') {
        qs.set('locationId', activeLocationId);
      }
      qs.set('lookbackDays', '90');
      qs.set('coverageDays', String(coverageDays));
      const res = await apiFetch<PredictiveProcurementResponse>(
        `/inventory/predictive-procurement?${qs.toString()}`,
      );
      setPlan(res);

      // Initialize defaults cleanly without discarding explicit user overrides if items remain relevant
      const nextSelected: Record<string, boolean> = {};
      const nextQtys: Record<string, string> = {};
      const nextSups: Record<string, string> = {};
      for (const s of res.suggestions) {
        nextSelected[s.inventoryItemId] = s.suggestedRestockQty > 0 && (s.isHighVelocity || s.urgency === 'CRITICAL');
        nextQtys[s.inventoryItemId] = String(s.suggestedRestockQty);
        nextSups[s.inventoryItemId] = s.preferredSupplierId;
      }
      setSelectedIds(nextSelected);
      setQtyOverrides(nextQtys);
      setSupplierOverrides(nextSups);
    } catch (e: any) {
      setError(e?.message || 'Unable to compute 90-day predictive procurement plan');
    } finally {
      setLoading(false);
    }
  }, [activeLocationId, coverageDays]);

  useEffect(() => {
    void loadPlan();
  }, [loadPlan]);

  const filteredSuggestions = useMemo(() => {
    const list = plan?.suggestions || [];
    if (viewFilter === 'HIGH_VELOCITY') {
      return list.filter((s) => s.isHighVelocity || s.urgency === 'CRITICAL');
    }
    if (viewFilter === 'RESTOCK_NEEDED') {
      return list.filter((s) => s.suggestedRestockQty > 0);
    }
    return list;
  }, [plan, viewFilter]);

  const resolveQuoteForRow = useCallback(
    (row: PredictiveRestockItem) => {
      const chosenSupId = supplierOverrides[row.inventoryItemId] ?? row.preferredSupplierId;
      const matchedQuote = row.supplierOptions.find((q) => q.supplierId === chosenSupId);
      if (matchedQuote) return matchedQuote;
      const fallbackSup = plan?.suppliers.find((s) => s.id === chosenSupId);
      return {
        supplierId: chosenSupId,
        supplierName: fallbackSup?.name || row.preferredSupplierName || 'Select Supplier',
        unitPrice: row.preferredUnitCost || row.lastUnitCost || 0,
        leadTimeDays: row.leadTimeDays || 2,
      };
    },
    [plan?.suppliers, supplierOverrides],
  );

  const selectedLineItems = useMemo(() => {
    if (!plan) return [];
    const lines: Array<{
      row: PredictiveRestockItem;
      orderedQty: number;
      supplierId: string;
      supplierName: string;
      unitCost: number;
      leadTimeDays: number;
      lineTotal: number;
    }> = [];

    for (const row of plan.suggestions) {
      if (!selectedIds[row.inventoryItemId]) continue;
      const qty = Math.max(0, Number(qtyOverrides[row.inventoryItemId] ?? row.suggestedRestockQty ?? 0));
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const quote = resolveQuoteForRow(row);
      lines.push({
        row,
        orderedQty: qty,
        supplierId: quote.supplierId,
        supplierName: quote.supplierName,
        unitCost: quote.unitPrice,
        leadTimeDays: quote.leadTimeDays,
        lineTotal: Math.round((qty * quote.unitPrice + Number.EPSILON) * 100) / 100,
      });
    }
    return lines;
  }, [plan, selectedIds, qtyOverrides, resolveQuoteForRow]);

  const selectedSupplierGroupCount = useMemo(() => {
    const ids = new Set(selectedLineItems.map((l) => l.supplierId).filter(Boolean));
    return ids.size;
  }, [selectedLineItems]);

  const selectedTotalPhp = useMemo(
    () => selectedLineItems.reduce((sum, l) => sum + l.lineTotal, 0),
    [selectedLineItems],
  );

  const visibleRestockableIds = useMemo(
    () =>
      filteredSuggestions
        .filter((r) => Number(qtyOverrides[r.inventoryItemId] ?? r.suggestedRestockQty) > 0)
        .map((r) => r.inventoryItemId),
    [filteredSuggestions, qtyOverrides],
  );

  const allVisibleSelected =
    visibleRestockableIds.length > 0 && visibleRestockableIds.every((id) => Boolean(selectedIds[id]));

  const toggleAllVisible = () => {
    const next = { ...selectedIds };
    const targetVal = !allVisibleSelected;
    for (const id of visibleRestockableIds) {
      next[id] = targetVal;
    }
    setSelectedIds(next);
  };

  const handleGeneratePos = async (targetStatus: 'DRAFT' | 'PENDING_APPROVAL') => {
    setError('');
    setCreatedPos([]);
    if (!deliveryLocationId || deliveryLocationId === 'ALL') {
      setError('Select a specific delivery location for the generated Purchase Orders.');
      return;
    }
    if (selectedLineItems.length === 0) {
      setError('Select at least one ingredient with a restock quantity greater than zero.');
      return;
    }
    const missingSupplier = selectedLineItems.find((l) => !l.supplierId);
    if (missingSupplier) {
      setError(`Assign an active supplier for "${missingSupplier.row.name}" before generating POs.`);
      return;
    }

    setSubmittingStatus(targetStatus);
    try {
      const res = await apiFetch<{ createdPos: CreatedPoReceipt[] }>('/inventory/predictive-procurement/auto-po', {
        method: 'POST',
        body: JSON.stringify({
          locationId: deliveryLocationId,
          status: targetStatus,
          coverageDays,
          notes: `Predictive 90d restock (${coverageDays}d coverage)`,
          items: selectedLineItems.map((l) => ({
            inventoryItemId: l.row.inventoryItemId,
            supplierId: l.supplierId,
            orderedQty: l.orderedQty,
            unitCost: l.unitCost,
            leadTimeDays: l.leadTimeDays,
          })),
        }),
      });
      setCreatedPos(res.createdPos || []);
      await loadPlan();
      await onPoCreated?.();
    } catch (e: any) {
      setError(e?.message || 'Unable to generate purchase orders from predictive restock plan');
    } finally {
      setSubmittingStatus(null);
    }
  };

  const activeLocLabel =
    activeLocationId && activeLocationId !== 'ALL'
      ? locations.find((l) => l.id === activeLocationId)?.name || 'Selected Location'
      : 'All Locations';

  return (
    <div className="space-y-4">
      {/* Header & Horizon / View Controls */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
              <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">
                Predictive Procurement &amp; 90-Day Velocity Planner
              </h2>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Scope: <span className="font-semibold text-slate-700 dark:text-slate-200">{activeLocLabel}</span> · Analyzing weighted outbound sales &amp; waste velocity ({plan?.windowStart || '—'} to {plan?.windowEnd || '—'})
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Target Coverage Horizon */}
            <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-800">
              {([7, 14, 21] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setCoverageDays(d)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap shrink-0 ${
                    coverageDays === d ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50 shadow-sm' : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {d}D Cover
                </button>
              ))}
            </div>

            {/* Velocity / Urgency Filter */}
            <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-800">
              {([
                { id: 'HIGH_VELOCITY', label: `High-Velocity (${plan?.summary.highVelocityCount ?? 0})` },
                { id: 'RESTOCK_NEEDED', label: `Restock Needed (${plan?.summary.restockNeededCount ?? 0})` },
                { id: 'ALL', label: `All Items (${plan?.summary.monitoredItemsCount ?? 0})` },
              ] as const).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setViewFilter(f.id)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap shrink-0 ${
                    viewFilter === f.id ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50 shadow-sm' : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              disabled={loading}
              onClick={() => void loadPlan()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-60 whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>

        {/* Unboxed 4-column Summary Strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 pt-3 border-t border-slate-100 dark:border-slate-800/80">
          <div>
            <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">High-Velocity Movers (90d)</div>
            <div className="text-lg font-display font-semibold text-slate-900 dark:text-slate-50 font-mono tabular-nums mt-0.5">
              {plan?.summary.highVelocityCount ?? 0}
              <span className="text-xs font-sans font-normal text-slate-500 dark:text-slate-400 ml-1">
                / {plan?.summary.monitoredItemsCount ?? 0} SKUs
              </span>
            </div>
          </div>
          <div>
            <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">SKUs Needing Restock</div>
            <div className="text-lg font-display font-semibold text-slate-900 dark:text-slate-50 font-mono tabular-nums mt-0.5">
              {plan?.summary.restockNeededCount ?? 0}
              {(plan?.summary.criticalCount ?? 0) > 0 && (
                <span className="text-xs font-sans font-semibold text-red-600 dark:text-red-300 ml-1.5">
                  ({plan?.summary.criticalCount} critical)
                </span>
              )}
            </div>
          </div>
          <div>
            <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Projected Restock Spend ({coverageDays}d)</div>
            <div className="text-lg font-display font-semibold text-slate-900 dark:text-slate-50 font-mono tabular-nums mt-0.5">
              {formatPHP(plan?.summary.totalEstimatedCostPhp ?? 0)}
            </div>
          </div>
          <div>
            <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Open PO Pipeline</div>
            <div className="text-lg font-display font-semibold text-slate-900 dark:text-slate-50 font-mono tabular-nums mt-0.5">
              {plan?.summary.totalOpenPoUnitsCount ?? 0}
              <span className="text-xs font-sans font-normal text-slate-500 dark:text-slate-400 ml-1">items inbound</span>
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 dark:border-red-800/80 bg-red-50 dark:bg-red-950/50 p-3 text-xs font-medium text-red-700 dark:text-red-300">{error}</div>
      )}

      {createdPos.length > 0 && (
        <div className="rounded-xl border border-emerald-200 dark:border-emerald-700/80 bg-emerald-50 dark:bg-emerald-950/45 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-900 dark:text-emerald-300">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <span>
                Generated {createdPos.length} Purchase Order{createdPos.length === 1 ? '' : 's'} from predictive restock plan
              </span>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-emerald-800 dark:text-emerald-300">
              {createdPos.map((po) => (
                <span key={po.id} className="font-mono tabular-nums">
                  <span className="font-semibold">{po.poNumber}</span> · <span className="font-sans">{po.supplierName}</span> ({po.lineCount} item{po.lineCount === 1 ? '' : 's'}, {formatPHP(po.totalAmount)}, {po.status.replace('_', ' ')})
                </span>
              ))}
            </div>
          </div>
          {onNavigateToProcurement && (
            <button
              type="button"
              onClick={onNavigateToProcurement}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800 whitespace-nowrap shrink-0"
            >
              Open Procurement <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}

      {/* Predictive Restock Table */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
            <tr>
              <th className="p-3 w-8">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  disabled={visibleRestockableIds.length === 0 || !canCreatePo}
                  onChange={toggleAllVisible}
                  aria-label="Select all restockable items"
                  className="rounded border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-50 focus:ring-slate-500 bg-white dark:bg-slate-950"
                />
              </th>
              <th className="p-3 font-medium">Ingredient / Velocity</th>
              <th className="p-3 font-medium text-right">3-Mo Usage (M-2 / M-1 / Cur)</th>
              <th className="p-3 font-medium text-right">Daily Burn</th>
              <th className="p-3 font-medium text-right">On Hand + Open PO</th>
              <th className="p-3 font-medium">Supply Status</th>
              <th className="p-3 font-medium">Supplier Quote</th>
              <th className="p-3 font-medium text-right">Auto-Restock Qty</th>
              <th className="p-3 font-medium text-right">Est. Cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {loading && !plan ? (
              <tr>
                <td colSpan={9} className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
                  Analyzing 90-day consumption and BOM sales velocity...
                </td>
              </tr>
            ) : filteredSuggestions.length === 0 ? (
              <tr>
                <td colSpan={9} className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
                  No ingredients match the current predictive procurement filter.
                </td>
              </tr>
            ) : (
              filteredSuggestions.map((row) => {
                const quote = resolveQuoteForRow(row);
                const editedQtyStr = qtyOverrides[row.inventoryItemId] ?? String(row.suggestedRestockQty);
                const editedQty = Math.max(0, Number(editedQtyStr || 0));
                const estCost = Math.round((editedQty * quote.unitPrice + Number.EPSILON) * 100) / 100;
                const isChecked = Boolean(selectedIds[row.inventoryItemId]);

                const rowTone =
                  row.urgency === 'CRITICAL'
                    ? 'bg-red-50/45 dark:bg-red-950/50 hover:bg-red-50/80'
                    : row.urgency === 'HIGH'
                    ? 'bg-amber-50/35 dark:bg-amber-950/45 hover:bg-amber-50/70'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-800';

                return (
                  <tr key={row.inventoryItemId} className={rowTone}>
                    <td className="p-3 align-top">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={!canCreatePo}
                        onChange={(e) =>
                          setSelectedIds((prev) => ({ ...prev, [row.inventoryItemId]: e.target.checked }))
                        }
                        aria-label={`Select ${row.name}`}
                        className="mt-0.5 rounded border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-50 focus:ring-slate-500"
                      />
                    </td>
                    <td className="p-3 align-top">
                      <div className="font-semibold text-slate-900 dark:text-slate-50">{row.name}</div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono mt-0.5">
                        {row.sku}
                        {row.isHighVelocity && row.velocityRank !== null && (
                          <span className="font-sans font-semibold text-amber-700 dark:text-amber-300 ml-2">
                            High Velocity · #{row.velocityRank}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 max-w-[260px]">{row.rationale}</div>
                    </td>
                    <td className="p-3 text-right align-top font-mono tabular-nums">
                      <div className="text-slate-900 dark:text-slate-50">
                        {formatNum(row.monthlyUsage.monthMinus2Qty, 0)} /{' '}
                        {formatNum(row.monthlyUsage.monthMinus1Qty, 0)} /{' '}
                        <span className="font-semibold">{formatNum(row.monthlyUsage.currentMonthQty, 0)}</span>{' '}
                        <span className="text-slate-500 dark:text-slate-400">{row.uomCode}</span>
                      </div>
                      <div className="inline-flex items-center justify-end gap-1 text-[11px] mt-0.5">
                        {row.velocityTrendPct > 3 ? (
                          <span className="inline-flex items-center gap-0.5 text-amber-700 dark:text-amber-300 font-semibold">
                            <TrendingUp className="w-3 h-3" /> +{formatNum(row.velocityTrendPct, 0)}% pace
                          </span>
                        ) : row.velocityTrendPct < -3 ? (
                          <span className="inline-flex items-center gap-0.5 text-emerald-700 dark:text-emerald-300 font-medium">
                            <TrendingDown className="w-3 h-3" /> {formatNum(row.velocityTrendPct, 0)}% pace
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-0.5 text-slate-500 dark:text-slate-400">
                            <Minus className="w-3 h-3" /> Steady 90d
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="p-3 text-right align-top font-mono tabular-nums">
                      <div className="font-semibold text-slate-900 dark:text-slate-50">
                        {formatNum(row.avgDailyBurn, row.uomCode === 'pcs' ? 1 : 0)} {row.uomCode}/d
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">
                        {coverageDays}d need: {formatNum(row.projectedCoverageDemand, 0)}
                      </div>
                    </td>
                    <td className="p-3 text-right align-top font-mono tabular-nums">
                      <div className="font-semibold text-slate-900 dark:text-slate-50">
                        {formatNum(row.onHandQty, 0)} {row.uomCode}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">
                        {row.openPoQty > 0 ? `+${formatNum(row.openPoQty, 0)} open PO` : `Safety: ${formatNum(row.safetyStock, 0)}`}
                      </div>
                    </td>
                    <td className="p-3 align-top whitespace-nowrap">
                      {row.urgency === 'CRITICAL' ? (
                        <div className="inline-flex items-center gap-1 text-red-700 dark:text-red-300 font-semibold">
                          <ShieldAlert className="w-3.5 h-3.5 text-red-600 dark:text-red-300 shrink-0" />
                          <span>CRITICAL</span>
                        </div>
                      ) : row.urgency === 'HIGH' ? (
                        <div className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300 font-semibold">
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
                          <span>RESTOCK</span>
                        </div>
                      ) : row.urgency === 'WATCH' ? (
                        <div className="inline-flex items-center gap-1 text-slate-700 dark:text-slate-200 font-medium">
                          <Clock className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400 shrink-0" />
                          <span>WATCH</span>
                        </div>
                      ) : (
                        <div className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300 font-medium">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                          <span>NOMINAL</span>
                        </div>
                      )}
                      <div className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400 mt-0.5">
                        {row.avgDailyBurn > 0
                          ? row.daysOfSupply >= 99
                            ? '99+ days left'
                            : `${formatNum(row.daysOfSupply, 1)} days left`
                          : 'No 90d burn'}
                      </div>
                    </td>
                    <td className="p-3 align-top min-w-[175px]">
                      <select
                        value={quote.supplierId}
                        disabled={!canCreatePo}
                        onChange={(e) =>
                          setSupplierOverrides((prev) => ({
                            ...prev,
                            [row.inventoryItemId]: e.target.value,
                          }))
                        }
                        className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-1.5 text-[11px] font-medium text-slate-800 dark:text-slate-100"
                      >
                        {row.supplierOptions.map((opt) => (
                          <option key={opt.supplierId} value={opt.supplierId}>
                            {opt.supplierName} ({formatPHP(opt.unitPrice)}/{row.uomCode})
                          </option>
                        ))}
                        {(plan?.suppliers || [])
                          .filter((sup) => !row.supplierOptions.some((o) => o.supplierId === sup.id))
                          .map((sup) => (
                            <option key={sup.id} value={sup.id}>
                              {sup.name} ({formatPHP(row.lastUnitCost)}/{row.uomCode})
                            </option>
                          ))}
                      </select>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums mt-0.5">
                        {formatPHP(quote.unitPrice)}/{row.uomCode} · {quote.leadTimeDays}d lead
                      </div>
                    </td>
                    <td className="p-3 text-right align-top">
                      <div className="inline-flex items-center justify-end gap-1">
                        <input
                          type="number"
                          min="0"
                          step="1"
                          disabled={!canCreatePo}
                          value={editedQtyStr}
                          onChange={(e) => {
                            const val = e.target.value;
                            setQtyOverrides((prev) => ({ ...prev, [row.inventoryItemId]: val }));
                            if (Number(val) > 0) {
                              setSelectedIds((prev) => ({ ...prev, [row.inventoryItemId]: true }));
                            }
                          }}
                          className="w-24 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-1 text-right font-mono tabular-nums text-xs font-semibold text-slate-900 dark:text-slate-50"
                        />
                        <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400 w-7 text-left">{row.uomCode}</span>
                      </div>
                    </td>
                    <td className="p-3 text-right align-top font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-50 whitespace-nowrap">
                      {formatPHP(estCost)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Auto-PO Generation Bar */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
        <div className="space-y-0.5">
          <div className="text-xs font-semibold text-slate-900 dark:text-slate-50 font-mono tabular-nums">
            {selectedLineItems.length} item{selectedLineItems.length === 1 ? '' : 's'} selected ·{' '}
            {selectedSupplierGroupCount} supplier PO{selectedSupplierGroupCount === 1 ? '' : 's'} ·{' '}
            Est. {formatPHP(selectedTotalPhp)}
          </div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            Lines are grouped automatically by supplier with lead-time ETA prefilled.
          </p>
        </div>

        {canCreatePo ? (
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5">
              <label className="text-[11px] font-medium text-slate-500 dark:text-slate-400 whitespace-nowrap">Deliver To:</label>
              <select
                value={deliveryLocationId}
                onChange={(e) => setDeliveryLocationId(e.target.value)}
                className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-800 dark:text-slate-100"
              >
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              disabled={selectedLineItems.length === 0 || submittingStatus !== null}
              onClick={() => void handleGeneratePos('DRAFT')}
              className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              {submittingStatus === 'DRAFT' ? 'Saving Drafts...' : 'Save Draft PO(s)'}
            </button>
            <button
              type="button"
              disabled={selectedLineItems.length === 0 || submittingStatus !== null}
              onClick={() => void handleGeneratePos('PENDING_APPROVAL')}
              className="rounded-lg bg-slate-900 dark:bg-slate-100 px-3 py-1.5 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              {submittingStatus === 'PENDING_APPROVAL' ? 'Submitting...' : 'Submit PO(s) for Approval'}
            </button>
          </div>
        ) : (
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Procurement creation permission required to convert suggestions into Purchase Orders.
          </div>
        )}
      </div>
    </div>
  );
}
