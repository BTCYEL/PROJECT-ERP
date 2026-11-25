import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Trash,
  Utensils,
  Package,
  AlertTriangle,
  Search,
  Download,
  RefreshCw,
  ArrowUpRight,
  Flame,
} from 'lucide-react';
import { apiFetch, downloadCsv, formatNum, formatPHP } from '../lib/api.ts';
import { LocationRow } from '../types/erp.ts';
import {
  getWasteReasonLabel,
  RecipeWasteOption,
  WASTE_REASON_OPTIONS,
  WasteEntryMode,
  WasteLogRecord,
  WasteManagementSummary,
  WasteReasonCategory,
  WasteTxnType,
} from '../lib/wasteManagement.ts';

interface WasteManagementPanelProps {
  locations: LocationRow[];
  activeLocationId: string;
  inventoryItems: any[];
  onWasteRecorded: () => Promise<void> | void;
  onNavigateToCosting?: () => void;
}

interface WasteApiResponse {
  logs: WasteLogRecord[];
  summary: WasteManagementSummary;
  recipes: RecipeWasteOption[];
}

export function WasteManagementPanel({
  locations,
  activeLocationId,
  inventoryItems,
  onWasteRecorded,
  onNavigateToCosting,
}: WasteManagementPanelProps) {
  const [data, setData] = useState<WasteApiResponse>({
    logs: [],
    summary: {
      totalEvents: 0,
      totalLossCost: 0,
      prepWasteCost: 0,
      spoilageCost: 0,
      recipeLinkedCount: 0,
      recipeLinkedCost: 0,
      topWastedRecipeName: null,
      topWastedIngredientName: null,
    },
    recipes: [],
  });
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  // Form state
  const defaultLocId =
    activeLocationId && activeLocationId !== 'ALL'
      ? activeLocationId
      : locations[0]?.id || 'loc_truck_1';
  const [entryMode, setEntryMode] = useState<WasteEntryMode>('RECIPE_PREP');
  const [locationId, setLocationId] = useState<string>(defaultLocId);
  const [productId, setProductId] = useState<string>('');
  const [servingsWasted, setServingsWasted] = useState<string>('1');
  const [ingredientOverrides, setIngredientOverrides] = useState<Record<string, string>>({});
  const [singleItemId, setSingleItemId] = useState<string>('');
  const [singleQty, setSingleQty] = useState<string>('100');
  const [linkedProductId, setLinkedProductId] = useState<string>('');
  const [txnType, setTxnType] = useState<WasteTxnType>('OUT_WASTE');
  const [reasonCategory, setReasonCategory] = useState<WasteReasonCategory>('PREP_TRIM');
  const [reasonNotes, setReasonNotes] = useState<string>('');

  // Ledger filters
  const [typeFilter, setTypeFilter] = useState<'ALL' | WasteTxnType>('ALL');
  const [recipeFilter, setRecipeFilter] = useState<string>('ALL');
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (activeLocationId && activeLocationId !== 'ALL') {
      setLocationId(activeLocationId);
    }
  }, [activeLocationId]);

  const loadWaste = useCallback(async () => {
    try {
      setLoading(true);
      setErr('');
      const q =
        activeLocationId && activeLocationId !== 'ALL'
          ? `?locationId=${encodeURIComponent(activeLocationId)}`
          : '';
      const res = await apiFetch<WasteApiResponse>(`/inventory/waste${q}`);
      setData(res);

      setProductId((prev) => {
        if (prev && res.recipes.some((r) => r.id === prev)) return prev;
        return (res.recipes.find((r) => r.ingredients.length > 0) || res.recipes[0])?.id || '';
      });
    } catch (e: any) {
      setErr(e?.message || 'Unable to load waste logs');
    } finally {
      setLoading(false);
    }
  }, [activeLocationId]);

  useEffect(() => {
    void loadWaste();
  }, [loadWaste]);

  useEffect(() => {
    if (!singleItemId && inventoryItems.length > 0) {
      setSingleItemId(inventoryItems[0].id);
    }
  }, [inventoryItems, singleItemId]);

  const selectedRecipe = useMemo(
    () => data.recipes.find((r) => r.id === productId) || null,
    [data.recipes, productId],
  );

  // Reset overrides when recipe or servings change
  useEffect(() => {
    if (!selectedRecipe) {
      setIngredientOverrides({});
      return;
    }
    const mult = Math.max(0, Number(servingsWasted) || 0);
    const next: Record<string, string> = {};
    for (const ing of selectedRecipe.ingredients) {
      const calcQty = Math.round(ing.baseQtyPerServing * mult * 100) / 100;
      next[ing.inventoryItemId] = String(calcQty);
    }
    setIngredientOverrides(next);
  }, [selectedRecipe, servingsWasted]);

  const recipePreviewLines = useMemo(() => {
    if (!selectedRecipe) return [];
    return selectedRecipe.ingredients.map((ing) => {
      const qty = Math.max(0, Number(ingredientOverrides[ing.inventoryItemId] ?? 0) || 0);
      const invMeta = inventoryItems.find((i) => i.id === ing.inventoryItemId);
      const unitCost = Number(invMeta?.last_unit_cost ?? ing.unitCost ?? 0);
      return {
        ...ing,
        qty,
        onHandQty: Number(invMeta?.on_hand_qty ?? 0),
        estCost: Math.round(qty * unitCost * 100) / 100,
      };
    });
  }, [selectedRecipe, ingredientOverrides, inventoryItems]);

  const estimatedBatchLoss = useMemo(() => {
    if (entryMode === 'RECIPE_PREP') {
      return recipePreviewLines.reduce((s, l) => s + l.estCost, 0);
    }
    const invMeta = inventoryItems.find((i) => i.id === singleItemId);
    const qty = Math.max(0, Number(singleQty) || 0);
    return Math.round(qty * Number(invMeta?.last_unit_cost || 0) * 100) / 100;
  }, [entryMode, recipePreviewLines, inventoryItems, singleItemId, singleQty]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setMsg('');
    setSubmitting(true);
    try {
      const payload: Record<string, any> = {
        locationId,
        entryMode,
        txnType,
        reasonCategory,
        reason: reasonNotes,
      };
      if (entryMode === 'RECIPE_PREP') {
        payload.productId = productId;
        payload.servingsWasted = Number(servingsWasted);
        payload.ingredientOverrides = recipePreviewLines
          .filter((l) => l.qty > 0)
          .map((l) => ({ inventoryItemId: l.inventoryItemId, quantity: l.qty }));
      } else {
        payload.inventoryItemId = singleItemId;
        payload.quantity = Number(singleQty);
        if (linkedProductId) {
          payload.productId = linkedProductId;
        }
      }

      const res = await apiFetch<{ totalCogs: number; itemsDeducted: number; wasteLog: WasteLogRecord }>(
        '/inventory/waste',
        { method: 'POST', body: JSON.stringify(payload) },
      );

      setMsg(
        `Recorded ${res.wasteLog.txnType === 'OUT_SPOILAGE' ? 'spoilage' : 'prep waste'}${
          res.wasteLog.productName ? ` for ${res.wasteLog.productName}` : ''
        } · Deducted ${res.itemsDeducted} ingredient line${res.itemsDeducted === 1 ? '' : 's'} (${formatPHP(
          res.totalCogs,
        )}) and synced Food Costing AvT reports.`,
      );
      setReasonNotes('');
      await Promise.all([loadWaste(), Promise.resolve(onWasteRecorded())]);
    } catch (e: any) {
      setErr(e?.message || 'Unable to record kitchen waste');
    } finally {
      setSubmitting(false);
    }
  };

  const filteredLogs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.logs.filter((log) => {
      if (typeFilter !== 'ALL' && log.txnType !== typeFilter) return false;
      if (recipeFilter === 'UNLINKED' && log.productId) return false;
      if (recipeFilter !== 'ALL' && recipeFilter !== 'UNLINKED' && log.productId !== recipeFilter) return false;
      if (q) {
        const hay = [
          log.productName || '',
          log.primaryItemName || '',
          log.locationName,
          log.reasonNotes,
          getWasteReasonLabel(log.reasonCategory),
          ...(log.items || []).map((i) => i.ingredientName),
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [data.logs, typeFilter, recipeFilter, search]);

  const handleExportCsv = () => {
    if (!filteredLogs.length) return;
    downloadCsv(
      'maximus_waste_management_logs.csv',
      filteredLogs.map((l) => ({
        Logged_At: l.wastedAt,
        Location: l.locationName,
        Entry_Mode: l.entryMode,
        Type: l.txnType === 'OUT_SPOILAGE' ? 'Spoilage' : 'Prep Waste',
        Linked_Recipe: l.productName || 'General Stock',
        Servings_Wasted: l.servingsWasted,
        Ingredients: l.items.map((i) => `${i.ingredientName} (${i.quantity} ${i.uomCode})`).join('; '),
        Reason: getWasteReasonLabel(l.reasonCategory),
        Notes: l.reasonNotes,
        Loss_Cost_PHP: l.totalLossCost,
        Logged_By: l.loggedByName,
      })),
    );
  };

  const { summary } = data;

  return (
    <div className="space-y-6">
      {/* 4 KPI Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Total Recorded Waste Loss</p>
          <p className="mt-1.5 font-mono tabular-nums text-2xl font-semibold text-red-700 dark:text-red-300">
            {formatPHP(summary.totalLossCost)}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            {summary.totalEvents} waste &amp; spoilage log{summary.totalEvents === 1 ? '' : 's'}
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Prep &amp; Trim Waste</p>
          <p className="mt-1.5 font-mono tabular-nums text-2xl font-semibold text-slate-900 dark:text-slate-50">
            {formatPHP(summary.prepWasteCost)}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Kitchen prep trim, burnt &amp; spills</p>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Spoilage &amp; Expiry</p>
          <p className="mt-1.5 font-mono tabular-nums text-2xl font-semibold text-amber-700 dark:text-amber-300">
            {formatPHP(summary.spoilageCost)}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Expired batches &amp; cold-chain loss</p>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Recipe-Linked AvT Attribution</p>
          <p className="mt-1.5 font-mono tabular-nums text-2xl font-semibold text-slate-900 dark:text-slate-50">
            {formatPHP(summary.recipeLinkedCost)}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 truncate">
            {summary.topWastedRecipeName
              ? `Top: ${summary.topWastedRecipeName}`
              : `${summary.recipeLinkedCount} recipe-linked entries`}
          </p>
        </div>
      </div>

      {msg && (
        <div className="rounded-lg border border-emerald-200 dark:border-emerald-700/80 bg-emerald-50 dark:bg-emerald-950/45 p-3 flex flex-wrap items-center justify-between gap-2 text-xs text-emerald-800 dark:text-emerald-300 font-medium">
          <span>{msg}</span>
          {onNavigateToCosting && (
            <button
              type="button"
              onClick={onNavigateToCosting}
              className="inline-flex items-center gap-1 font-semibold text-emerald-900 dark:text-emerald-300 underline hover:text-emerald-700 whitespace-nowrap"
            >
              Open Food Costing AvT <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}

      {err && (
        <div className="rounded-lg border border-red-200 dark:border-red-800/80 bg-red-50 dark:bg-red-950/50 p-3 text-xs font-medium text-red-700 dark:text-red-300">
          {err}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left: Kitchen Waste & Recipe Linkage Entry Form */}
        <form
          onSubmit={handleSubmit}
          className="xl:col-span-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4"
        >
          <div className="flex items-start justify-between gap-2 border-b border-slate-100 dark:border-slate-800/80 pb-3">
            <div>
              <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">
                Record Spoilage or Prep-Waste
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Deducts FIFO stock &amp; updates Food Costing AvT reports automatically
              </p>
            </div>
            {onNavigateToCosting && (
              <button
                type="button"
                onClick={onNavigateToCosting}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-700 dark:text-slate-200 hover:text-slate-900 dark:hover:text-white underline whitespace-nowrap"
              >
                AvT Report <ArrowUpRight className="w-3 h-3" />
              </button>
            )}
          </div>

          {/* Entry Mode Segmented Control */}
          <div className="grid grid-cols-2 gap-1 p-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70">
            <button
              type="button"
              onClick={() => setEntryMode('RECIPE_PREP')}
              className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-semibold transition-colors ${
                entryMode === 'RECIPE_PREP'
                  ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950'
                  : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Utensils className="w-3.5 h-3.5" />
              By Recipe / Portions
            </button>
            <button
              type="button"
              onClick={() => setEntryMode('SINGLE_INGREDIENT')}
              className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-semibold transition-colors ${
                entryMode === 'SINGLE_INGREDIENT'
                  ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950'
                  : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Package className="w-3.5 h-3.5" />
              Single Ingredient
            </button>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-200 mb-1">
              Kitchen / Food Truck Location
            </label>
            <select
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-50"
            >
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.name}
                </option>
              ))}
            </select>
          </div>

          {entryMode === 'RECIPE_PREP' ? (
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-200 mb-1">
                    Linked Recipe (Menu BOM)
                  </label>
                  <select
                    value={productId}
                    onChange={(e) => setProductId(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-50"
                  >
                    {data.recipes.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name} ({r.ingredientCount} BOM items)
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-200 mb-1">
                    Portions / Servings
                  </label>
                  <input
                    type="number"
                    min="0.1"
                    step="0.5"
                    required
                    value={servingsWasted}
                    onChange={(e) => setServingsWasted(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono tabular-nums"
                  />
                </div>
              </div>

              {/* Recipe BOM Deduction Preview */}
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 overflow-hidden">
                <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between text-[11px] font-semibold text-slate-700 dark:text-slate-200">
                  <span>Recipe BOM Ingredient Deductions</span>
                  <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400">Editable qty</span>
                </div>
                {recipePreviewLines.length === 0 ? (
                  <p className="p-3 text-xs text-amber-700 dark:text-amber-300">
                    This product has no Bill of Materials ingredients configured yet. Switch to Single Ingredient mode or add recipe ingredients first.
                  </p>
                ) : (
                  <div className="divide-y divide-slate-200/70 dark:divide-slate-800/80 max-h-52 overflow-y-auto">
                    {recipePreviewLines.map((line) => (
                      <div key={line.inventoryItemId} className="px-3 py-2 flex items-center justify-between gap-2 text-xs">
                        <div className="min-w-0">
                          <p className="font-medium text-slate-900 dark:text-slate-50 truncate">{line.ingredientName}</p>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                            Stock: {formatNum(line.onHandQty, 1)} {line.uomCode}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <input
                            type="number"
                            min="0"
                            step="any"
                            value={ingredientOverrides[line.inventoryItemId] ?? ''}
                            onChange={(e) =>
                              setIngredientOverrides((prev) => ({
                                ...prev,
                                [line.inventoryItemId]: e.target.value,
                              }))
                            }
                            className="w-20 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-right text-xs font-mono tabular-nums"
                          />
                          <span className="w-8 text-[11px] text-slate-500 dark:text-slate-400 font-mono">{line.uomCode}</span>
                          <span className="w-16 text-right font-mono tabular-nums font-semibold text-slate-800 dark:text-slate-100">
                            {formatPHP(line.estCost)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-200 mb-1">
                    Raw Ingredient / Material
                  </label>
                  <select
                    value={singleItemId}
                    onChange={(e) => setSingleItemId(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-50"
                  >
                    {inventoryItems.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.name} ({formatNum(it.on_hand_qty, 0)} {it.uom_code} on hand)
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-200 mb-1">
                    Qty Wasted (Base UOM)
                  </label>
                  <input
                    type="number"
                    min="0.01"
                    step="any"
                    required
                    value={singleQty}
                    onChange={(e) => setSingleQty(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono tabular-nums"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-200 mb-1">
                  Link to Recipe for AvT Reporting (Optional)
                </label>
                <select
                  value={linkedProductId}
                  onChange={(e) => setLinkedProductId(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-50"
                >
                  <option value="">Unlinked / General Stock Spoilage</option>
                  {data.recipes.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({r.categoryName})
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-200 mb-1">Loss Type</label>
              <select
                value={txnType}
                onChange={(e) => setTxnType(e.target.value as WasteTxnType)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-50"
              >
                <option value="OUT_WASTE">Prep Waste</option>
                <option value="OUT_SPOILAGE">Expired / Spoiled</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-200 mb-1">Cause Category</label>
              <select
                value={reasonCategory}
                onChange={(e) => {
                  const val = e.target.value as WasteReasonCategory;
                  setReasonCategory(val);
                  const opt = WASTE_REASON_OPTIONS.find((o) => o.value === val);
                  if (opt) setTxnType(opt.defaultTxnType);
                }}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-50"
              >
                {WASTE_REASON_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-200 mb-1">
              Shift / Kitchen Notes
            </label>
            <input
              type="text"
              value={reasonNotes}
              onChange={(e) => setReasonNotes(e.target.value)}
              placeholder="e.g. Charred during dinner rush or chiller temp drift"
              maxLength={350}
              className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
            />
          </div>

          <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-100 dark:border-slate-800/80">
            <div className="text-xs text-slate-600 dark:text-slate-300">
              Est. FIFO Loss:{' '}
              <span className="font-mono tabular-nums font-semibold text-red-700 dark:text-red-300">
                {formatPHP(estimatedBatchLoss)}
              </span>
            </div>
            <button
              type="submit"
              disabled={submitting || (entryMode === 'RECIPE_PREP' && recipePreviewLines.every((l) => l.qty <= 0))}
              className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50 whitespace-nowrap"
            >
              <Trash className="w-3.5 h-3.5" />
              {submitting ? 'Recording...' : 'Record Waste & Update AvT'}
            </button>
          </div>
        </form>

        {/* Right: Waste History Ledger */}
        <div className="xl:col-span-7 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="p-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  ['ALL', 'All Logs'],
                  ['OUT_WASTE', 'Prep Waste'],
                  ['OUT_SPOILAGE', 'Spoiled'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTypeFilter(key)}
                  className={`px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                    typeFilter === key
                      ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950'
                      : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {label}
                </button>
              ))}

              <select
                value={recipeFilter}
                onChange={(e) => setRecipeFilter(e.target.value)}
                className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200"
              >
                <option value="ALL">All Recipes &amp; Stock</option>
                <option value="UNLINKED">Unlinked General Stock</option>
                {data.recipes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search recipe or ingredient..."
                  className="w-44 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 pl-8 pr-2.5 py-1.5 text-xs"
                />
              </div>
              <button
                type="button"
                onClick={() => void loadWaste()}
                disabled={loading}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              </button>
              <button
                type="button"
                onClick={handleExportCsv}
                disabled={!filteredLogs.length}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40"
              >
                <Download className="w-3.5 h-3.5" />
                CSV
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="p-3 font-semibold">Timestamp / Site</th>
                  <th className="p-3 font-semibold">Type &amp; Cause</th>
                  <th className="p-3 font-semibold">Linked Recipe / Ingredients</th>
                  <th className="p-3 font-semibold text-right">FIFO Loss</th>
                  <th className="p-3 font-semibold">Staff</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {filteredLogs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-slate-500 dark:text-slate-400">
                      {loading
                        ? 'Loading waste & spoilage ledger...'
                        : 'No kitchen spoilage or prep-waste logged yet for this filter. Use the form to record waste linked to a menu recipe.'}
                    </td>
                  </tr>
                ) : (
                  filteredLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-slate-50 dark:hover:bg-slate-800 align-top">
                      <td className="p-3 whitespace-nowrap">
                        <p className="font-mono tabular-nums text-slate-700 dark:text-slate-200 font-medium">
                          {String(log.wastedAt).slice(0, 16).replace('T', ' ')}
                        </p>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">{log.locationName}</p>
                      </td>
                      <td className="p-3">
                        <span
                          className={`inline-flex items-center gap-1 font-semibold ${
                            log.txnType === 'OUT_SPOILAGE' ? 'text-amber-700 dark:text-amber-300' : 'text-red-700 dark:text-red-300'
                          }`}
                        >
                          {log.txnType === 'OUT_SPOILAGE' ? (
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                          ) : (
                            <Flame className="w-3.5 h-3.5 shrink-0" />
                          )}
                          <span>{log.txnType === 'OUT_SPOILAGE' ? 'Spoilage' : 'Prep Waste'}</span>
                        </span>
                        <p className="text-[11px] text-slate-600 dark:text-slate-300 mt-0.5">
                          {getWasteReasonLabel(log.reasonCategory)}
                        </p>
                        {log.reasonNotes && (
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 truncate max-w-[190px]">
                            {log.reasonNotes}
                          </p>
                        )}
                      </td>
                      <td className="p-3">
                        {log.productName ? (
                          <p className="font-semibold text-slate-900 dark:text-slate-50">
                            {log.productName}
                            {log.servingsWasted > 0
                              ? ` · ${formatNum(log.servingsWasted, 1)} serving${
                                  log.servingsWasted === 1 ? '' : 's'
                                }`
                              : ''}
                          </p>
                        ) : (
                          <p className="font-medium text-slate-700 dark:text-slate-200">General Stock</p>
                        )}
                        <div className="mt-1 space-y-0.5 text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                          {log.items.map((li, idx) => (
                            <p key={`${log.id}-${li.inventoryItemId}-${idx}`}>
                              <span className="font-sans text-slate-600 dark:text-slate-300">{li.ingredientName}:</span>{' '}
                              -{formatNum(li.quantity, 1)} {li.uomCode} ({formatPHP(li.totalCost)})
                            </p>
                          ))}
                        </div>
                      </td>
                      <td className="p-3 text-right font-mono tabular-nums font-semibold text-red-700 dark:text-red-300 whitespace-nowrap">
                        {formatPHP(log.totalLossCost)}
                      </td>
                      <td className="p-3 text-slate-600 dark:text-slate-300 whitespace-nowrap">{log.loggedByName}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
