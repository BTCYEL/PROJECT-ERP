import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRightLeft,
  Trash,
  ClipboardCheck,
  Plus,
  Pencil,
  Trash2,
  X,
  ShieldAlert,
  AlertTriangle,
  BellRing,
  CheckCircle2,
} from 'lucide-react';
import { apiFetch, formatNum, formatPHP } from '../lib/api.ts';
import { evaluateIngredientThreshold } from '../lib/inventoryAlerts.ts';
import { AuthUser, LocationRow, PERMISSIONS } from '../types/erp.ts';
import { PredictiveProcurementPanel } from './PredictiveProcurementPanel.tsx';
import { WasteManagementPanel } from './WasteManagementPanel.tsx';

interface Props {
  user?: AuthUser;
  locations: LocationRow[];
  activeLocationId: string;
  onLocationChange?: (locationId: string) => void;
  onNotificationsChanged?: () => Promise<void> | void;
  onNavigate?: (tab: string) => void;
  quickAction?: { action: string; nonce: number } | null;
  onQuickActionHandled?: () => void;
}

export function InventoryModule({
  user,
  locations,
  activeLocationId,
  onLocationChange,
  onNotificationsChanged,
  onNavigate,
  quickAction,
  onQuickActionHandled,
}: Props) {
  const [locFilter, setLocFilter] = useState(activeLocationId === 'ALL' ? '' : activeLocationId);
  const [subTab, setSubTab] = useState<'stock' | 'waste' | 'predictive' | 'batches' | 'movements'>('stock');
  const [thresholdFilter, setThresholdFilter] = useState<'ALL' | 'BELOW_SAFETY' | 'BELOW_REORDER' | 'RAW_ONLY'>('ALL');
  const canCreatePo =
    !user ||
    user.roleCode === 'SUPER_ADMIN' ||
    user.roleCode === 'BUSINESS_OWNER' ||
    user.permissions.includes(PERMISSIONS.PO_CREATE);
  const [data, setData] = useState<any>({ items: [], batches: [], movements: [], uoms: [], alertsSummary: null });
  const [modal, setModal] = useState<'transfer' | 'count' | 'addItem' | 'editItem' | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [savingItem, setSavingItem] = useState(false);
  const [scanningAlerts, setScanningAlerts] = useState(false);
  const autoScannedLocsRef = useRef<Set<string>>(new Set());
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const [trfForm, setTrfForm] = useState({ fromLocationId: 'loc_commissary', toLocationId: 'loc_truck_1', inventoryItemId: '', quantity: '1000', notes: '' });
  const [wasteForm, setWasteForm] = useState({ locationId: 'loc_truck_1', inventoryItemId: '', quantity: '200', txnType: 'OUT_WASTE', reason: 'Spoilage / Prep trim loss' });
  const [countForm, setCountForm] = useState({ locationId: 'loc_truck_1', inventoryItemId: '', countedQty: '', notes: 'End-of-shift physical count' });
  const [itemForm, setItemForm] = useState({
    id: '',
    sku: '',
    name: '',
    itemType: 'RAW_MATERIAL',
    baseUomId: '',
    costingMethod: 'FIFO',
    lastUnitCost: '0',
    reorderPoint: '0',
    minStockLevel: '0',
  });

  const runThresholdScan = async (onlyIfNeverNotified: boolean) => {
    setScanningAlerts(true);
    try {
      const scanRes = await apiFetch<{
        scannedCount: number;
        belowSafetyCount: number;
        belowReorderCount: number;
        createdCount: number;
        resolvedCount: number;
      }>('/inventory/alerts/scan', {
        method: 'POST',
        body: JSON.stringify({
          locationId: locFilter || 'ALL',
          onlyIfNeverNotified,
          rawOnly: true,
        }),
      });
      if (scanRes.createdCount > 0 || scanRes.resolvedCount > 0) {
        await onNotificationsChanged?.();
      }
      if (!onlyIfNeverNotified) {
        if (scanRes.createdCount > 0) {
          setMsg(
            `Safety stock scan complete · Created ${scanRes.createdCount} alert${scanRes.createdCount === 1 ? '' : 's'} in the global notification feed (${scanRes.belowSafetyCount} below safety stock).`,
          );
        } else if (scanRes.belowSafetyCount > 0) {
          setMsg(
            `Safety stock scan complete · ${scanRes.belowSafetyCount} raw ingredient${scanRes.belowSafetyCount === 1 ? ' breach is' : ' breaches are'} already active in the global notification feed.`,
          );
        } else {
          setMsg(
            `Safety stock scan complete · All ${scanRes.scannedCount} monitored raw ingredients are above safety stock.`,
          );
        }
      }
    } catch (e: any) {
      if (!onlyIfNeverNotified) {
        setErr(e.message || 'Unable to scan inventory safety thresholds');
      }
    } finally {
      setScanningAlerts(false);
    }
  };

  const load = async () => {
    try {
      setErr('');
      const res = await apiFetch(`/inventory${locFilter ? `?locationId=${locFilter}` : ''}`);
      setData(res);
      if (res.items?.[0]) {
        setTrfForm((f) => ({ ...f, inventoryItemId: f.inventoryItemId || res.items[0].id }));
        setWasteForm((f) => ({ ...f, inventoryItemId: f.inventoryItemId || res.items[0].id }));
        setCountForm((f) => ({ ...f, inventoryItemId: f.inventoryItemId || res.items[0].id }));
      }
      const scanKey = locFilter || 'ALL';
      const hasBreach = Number(res.alertsSummary?.rawBelowSafetyCount || 0) > 0;
      if (hasBreach && !autoScannedLocsRef.current.has(scanKey)) {
        autoScannedLocsRef.current.add(scanKey);
        void runThresholdScan(true);
      }
    } catch (e: any) {
      setErr(e.message || 'Unable to load inventory data');
    }
  };

  useEffect(() => {
    const nextLoc = activeLocationId === 'ALL' ? '' : activeLocationId;
    setLocFilter(nextLoc);
    if (nextLoc) {
      setWasteForm((f) => ({ ...f, locationId: nextLoc }));
      setCountForm((f) => ({ ...f, locationId: nextLoc }));
    }
  }, [activeLocationId]);

  useEffect(() => {
    load();
  }, [locFilter]);

  useEffect(() => {
    if (!quickAction) return;
    if (quickAction.action === 'waste') {
      setSubTab('waste');
      setModal(null);
      onQuickActionHandled?.();
    } else if (quickAction.action === 'count' || quickAction.action === 'transfer') {
      setSubTab('stock');
      setModal(quickAction.action);
      onQuickActionHandled?.();
    }
  }, [quickAction]);

  const submitTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      const r = await apiFetch('/inventory/transfers', { method: 'POST', body: JSON.stringify(trfForm) });
      setMsg(`Transfer ${r.trfNo} completed · Cost moved: ${formatPHP(r.totalCost)}`);
      setModal(null);
      await load();
      await onNotificationsChanged?.();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const submitWaste = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      const r = await apiFetch('/inventory/waste', { method: 'POST', body: JSON.stringify(wasteForm) });
      setMsg(`Recorded waste/spoilage · FIFO loss value: ${formatPHP(r.totalCogs)}`);
      setModal(null);
      await load();
      await onNotificationsChanged?.();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const submitCount = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      const r = await apiFetch('/inventory/reconcile', { method: 'POST', body: JSON.stringify(countForm) });
      setMsg(`Physical count reconciled · Variance: ${r.variance}`);
      setModal(null);
      await load();
      await onNotificationsChanged?.();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const openAddItem = () => {
    setErr('');
    setItemForm({
      id: '',
      sku: '',
      name: '',
      itemType: 'RAW_MATERIAL',
      baseUomId: data.uoms?.[0]?.id || '',
      costingMethod: 'FIFO',
      lastUnitCost: '0',
      reorderPoint: '0',
      minStockLevel: '0',
    });
    setModal('addItem');
  };

  const openEditItem = (item: any) => {
    setErr('');
    setItemForm({
      id: item.id,
      sku: item.sku || '',
      name: item.name || '',
      itemType: item.item_type || 'RAW_MATERIAL',
      baseUomId: item.base_uom_id || data.uoms?.[0]?.id || '',
      costingMethod: item.costing_method || 'FIFO',
      lastUnitCost: String(item.last_unit_cost ?? 0),
      reorderPoint: String(item.reorder_point ?? 0),
      minStockLevel: String(item.min_stock_level ?? 0),
    });
    setModal('editItem');
  };

  const submitItemForm = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setSavingItem(true);
    try {
      const payload = {
        sku: itemForm.sku,
        name: itemForm.name,
        itemType: itemForm.itemType,
        baseUomId: itemForm.baseUomId,
        costingMethod: itemForm.costingMethod,
        lastUnitCost: Number(itemForm.lastUnitCost || 0),
        reorderPoint: Number(itemForm.reorderPoint || 0),
        minStockLevel: Number(itemForm.minStockLevel || 0),
      };
      if (modal === 'addItem') {
        const res = await apiFetch<any>('/inventory/items', { method: 'POST', body: JSON.stringify(payload) });
        const alertNote = res?.alerts_created > 0 ? ' · Safety stock alert dispatched to notification bell' : '';
        setMsg(`Added ingredient "${itemForm.name.trim()}"${alertNote}`);
      } else {
        const res = await apiFetch<any>(`/inventory/items/${itemForm.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        const alertNote = res?.alerts_created > 0 ? ' · Safety stock alert dispatched to notification bell' : '';
        setMsg(`Updated ingredient "${itemForm.name.trim()}"${alertNote}`);
      }
      setModal(null);
      await load();
      await onNotificationsChanged?.();
    } catch (e: any) {
      setErr(e.message || 'Unable to save ingredient');
    } finally {
      setSavingItem(false);
    }
  };

  const confirmDeleteItem = async () => {
    if (!deleteTarget) return;
    setErr('');
    setSavingItem(true);
    try {
      await apiFetch(`/inventory/items/${deleteTarget.id}`, { method: 'DELETE' });
      setMsg(`Deleted ingredient "${deleteTarget.name}"`);
      setDeleteTarget(null);
      await load();
      await onNotificationsChanged?.();
    } catch (e: any) {
      setErr(e.message || 'Unable to delete ingredient');
    } finally {
      setSavingItem(false);
    }
  };

  const enrichedItems = useMemo(() => {
    return (data.items || []).map((item: any) => {
      const evalRes = evaluateIngredientThreshold({
        onHandQty: Number(item.on_hand_qty || 0),
        safetyStock: Number(item.safety_stock_level ?? item.min_stock_level ?? 0),
        reorderPoint: Number(item.reorder_point || 0),
      });
      return {
        ...item,
        thresholdEval: evalRes,
      };
    });
  }, [data.items]);

  const belowSafetyItems = useMemo(
    () => enrichedItems.filter((i: any) => i.thresholdEval.status === 'BELOW_SAFETY'),
    [enrichedItems],
  );
  const rawBelowSafetyItems = useMemo(
    () => belowSafetyItems.filter((i: any) => (i.item_type || 'RAW_MATERIAL') === 'RAW_MATERIAL'),
    [belowSafetyItems],
  );
  const belowReorderItems = useMemo(
    () => enrichedItems.filter((i: any) => i.thresholdEval.status === 'BELOW_REORDER'),
    [enrichedItems],
  );

  const filteredItems = useMemo(() => {
    if (thresholdFilter === 'BELOW_SAFETY') return belowSafetyItems;
    if (thresholdFilter === 'BELOW_REORDER') return belowReorderItems;
    if (thresholdFilter === 'RAW_ONLY') {
      return enrichedItems.filter((i: any) => (i.item_type || 'RAW_MATERIAL') === 'RAW_MATERIAL');
    }
    return enrichedItems;
  }, [enrichedItems, belowSafetyItems, belowReorderItems, thresholdFilter]);

  const totalValuation = enrichedItems.reduce((s: number, i: any) => s + Number(i.stock_value || 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 dark:text-slate-50">Inventory &amp; Batch Control</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Total Valuation: <span className="font-mono font-semibold text-slate-900 dark:text-slate-50">{formatPHP(totalValuation)}</span> · FIFO &amp; Weighted Average Costing
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={locFilter}
            onChange={(e) => {
              const val = e.target.value;
              setLocFilter(val);
              onLocationChange?.(val || 'ALL');
            }}
            className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium"
          >
            <option value="">All Locations</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
          <button
            onClick={openAddItem}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" /> Add Ingredient
          </button>
          <button
            onClick={() => setModal('transfer')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            <ArrowRightLeft className="w-3.5 h-3.5" /> Transfer Stock
          </button>
          <button
            onClick={() => setSubTab('waste')}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium whitespace-nowrap shrink-0 ${
              subTab === 'waste'
                ? 'border-red-300 dark:border-red-800/80 bg-red-50 dark:bg-red-950/50 text-red-800 dark:text-red-300'
                : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800'
            }`}
          >
            <Trash className="w-3.5 h-3.5" /> Waste Management
          </button>
          <button
            onClick={() => setModal('count')}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-3 py-2 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white whitespace-nowrap shrink-0"
          >
            <ClipboardCheck className="w-3.5 h-3.5" /> Physical Count
          </button>
        </div>
      </div>

      {msg && <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/45 border border-emerald-200 dark:border-emerald-700/80 text-xs text-emerald-800 dark:text-emerald-300 font-medium">{msg}</div>}
      {err && <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">{err}</div>}

      {/* Safety Stock Threshold Alert Banner */}
      {rawBelowSafetyItems.length > 0 ? (
        <div className="rounded-xl border border-red-200 dark:border-red-800/80 bg-red-50/75 dark:bg-red-950/50 p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <ShieldAlert className="w-5 h-5 text-red-600 dark:text-red-300 shrink-0 mt-0.5" />
            <div className="space-y-1 min-w-0">
              <p className="text-xs font-semibold text-red-900 dark:text-red-300">
                Safety Stock Breach · {rawBelowSafetyItems.length} raw ingredient{rawBelowSafetyItems.length === 1 ? '' : 's'} below minimum safety threshold
              </p>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-red-800 dark:text-red-300">
                {rawBelowSafetyItems.slice(0, 4).map((item: any) => (
                  <span key={item.id} className="font-mono tabular-nums">
                    <span className="font-sans font-semibold">{item.name}:</span> {formatNum(item.on_hand_qty, 0)} / {formatNum(item.thresholdEval.safetyStock, 0)} {item.uom_code}{' '}
                    <span className="text-red-700 dark:text-red-300">(-{formatNum(item.thresholdEval.deficitQty, 0)})</span>
                  </span>
                ))}
                {rawBelowSafetyItems.length > 4 && (
                  <span className="text-red-700 dark:text-red-300 font-medium">+{rawBelowSafetyItems.length - 4} more</span>
                )}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                setSubTab('stock');
                setThresholdFilter(thresholdFilter === 'BELOW_SAFETY' ? 'ALL' : 'BELOW_SAFETY');
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 dark:border-red-800/80 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold text-red-800 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/70 whitespace-nowrap shrink-0"
            >
              {thresholdFilter === 'BELOW_SAFETY' ? 'Show All Items' : 'Filter Flagged'}
            </button>
            <button
              type="button"
              disabled={scanningAlerts}
              onClick={() => void runThresholdScan(false)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-60 whitespace-nowrap shrink-0"
            >
              <BellRing className="w-3.5 h-3.5" />
              {scanningAlerts ? 'Syncing Alerts...' : 'Push Alerts to Bell'}
            </button>
          </div>
        </div>
      ) : belowReorderItems.length > 0 ? (
        <div className="rounded-xl border border-amber-200 dark:border-amber-700/80 bg-amber-50/75 dark:bg-amber-950/45 p-3.5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-xs text-amber-900 dark:text-amber-300">
            <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <span>
              <span className="font-semibold">{belowReorderItems.length} item{belowReorderItems.length === 1 ? '' : 's'}</span> at or below reorder point (safety stock thresholds nominal).
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              setSubTab('stock');
              setThresholdFilter(thresholdFilter === 'BELOW_REORDER' ? 'ALL' : 'BELOW_REORDER');
            }}
            className="rounded-lg border border-amber-300 dark:border-amber-700/80 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold text-amber-900 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/70 whitespace-nowrap shrink-0"
          >
            {thresholdFilter === 'BELOW_REORDER' ? 'Show All Items' : 'Filter Reorder Alerts'}
          </button>
        </div>
      ) : null}

      {/* Segmented Tabs & Threshold Filter Strip */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-800 w-fit">
          {([
            { id: 'stock', label: 'Current Stock' },
            { id: 'waste', label: 'Waste Management' },
            { id: 'predictive', label: 'Predictive Restock' },
            { id: 'batches', label: `Batches & Expiry (${data.batches.length})` },
            { id: 'movements', label: 'Movement Ledger' },
          ] as const).map((t) => (
            <button
              key={t.id}
              onClick={() => setSubTab(t.id)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 ${
                subTab === t.id ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50 shadow-sm' : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {subTab === 'stock' && (
          <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-800">
            {([
              { id: 'ALL', label: `All (${enrichedItems.length})` },
              { id: 'BELOW_SAFETY', label: `Below Safety (${belowSafetyItems.length})` },
              { id: 'BELOW_REORDER', label: `Low Stock (${belowReorderItems.length})` },
              { id: 'RAW_ONLY', label: 'Raw Ingredients' },
            ] as const).map((f) => {
              const isActive = thresholdFilter === f.id;
              const isDanger = f.id === 'BELOW_SAFETY' && belowSafetyItems.length > 0;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setThresholdFilter(f.id)}
                  className={`px-2.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 ${
                    isActive
                      ? isDanger
                        ? 'bg-red-600 text-white shadow-sm'
                        : 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50 shadow-sm'
                      : isDanger
                      ? 'text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/70'
                      : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {subTab === 'stock' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
              <tr>
                <th className="p-3 font-medium">SKU</th>
                <th className="p-3 font-medium">Ingredient / Material</th>
                <th className="p-3 font-medium">Method</th>
                <th className="p-3 font-medium text-right">On Hand</th>
                <th className="p-3 font-medium text-right">Safety Stock</th>
                <th className="p-3 font-medium text-right">Reorder Pt</th>
                <th className="p-3 font-medium text-right">Unit Cost</th>
                <th className="p-3 font-medium text-right">Stock Value</th>
                <th className="p-3 font-medium">Status</th>
                <th className="p-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filteredItems.length === 0 ? (
                <tr>
                  <td colSpan={10} className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
                    No inventory items match the selected threshold filter.
                  </td>
                </tr>
              ) : (
                filteredItems.map((item: any) => {
                  const status = item.thresholdEval.status as 'BELOW_SAFETY' | 'BELOW_REORDER' | 'NOMINAL';
                  const safetyStock = item.thresholdEval.safetyStock;
                  const deficitQty = item.thresholdEval.deficitQty;
                  const rowTone =
                    status === 'BELOW_SAFETY'
                      ? 'bg-red-50/55 dark:bg-red-950/50 hover:bg-red-50/90'
                      : status === 'BELOW_REORDER'
                      ? 'bg-amber-50/40 dark:bg-amber-950/45 hover:bg-amber-50/75'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800';
                  return (
                    <tr key={item.id} className={rowTone}>
                      <td className="p-3 font-mono text-slate-500 dark:text-slate-400">{item.sku}</td>
                      <td className="p-3">
                        <div className="font-semibold text-slate-900 dark:text-slate-50">{item.name}</div>
                        {item.item_type && item.item_type !== 'RAW_MATERIAL' && (
                          <div className="text-[10px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">{item.item_type.replace('_', ' ')}</div>
                        )}
                      </td>
                      <td className="p-3 text-slate-600 dark:text-slate-300">{item.costing_method}</td>
                      <td
                        className={`p-3 text-right font-mono tabular-nums font-semibold ${
                          status === 'BELOW_SAFETY'
                            ? 'text-red-700 dark:text-red-300 font-bold'
                            : status === 'BELOW_REORDER'
                            ? 'text-amber-700 dark:text-amber-300'
                            : 'text-slate-900 dark:text-slate-50'
                        }`}
                      >
                        {formatNum(item.on_hand_qty, 0)} {item.uom_code}
                      </td>
                      <td className="p-3 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                        {safetyStock > 0 ? `${formatNum(safetyStock, 0)} ${item.uom_code}` : '—'}
                      </td>
                      <td className="p-3 text-right font-mono tabular-nums text-slate-500 dark:text-slate-400">
                        {formatNum(item.reorder_point, 0)} {item.uom_code}
                      </td>
                      <td className="p-3 text-right font-mono tabular-nums">{formatPHP(item.last_unit_cost)}</td>
                      <td className="p-3 text-right font-mono tabular-nums font-semibold">{formatPHP(item.stock_value)}</td>
                      <td className="p-3">
                        {status === 'BELOW_SAFETY' ? (
                          <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-300 font-semibold whitespace-nowrap">
                            <ShieldAlert className="w-3.5 h-3.5 text-red-600 dark:text-red-300 shrink-0" />
                            <span>BELOW SAFETY (-{formatNum(deficitQty, 0)} {item.uom_code})</span>
                          </span>
                        ) : status === 'BELOW_REORDER' ? (
                          <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300 font-semibold whitespace-nowrap">
                            <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
                            <span>LOW STOCK</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300 font-medium whitespace-nowrap">
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                            <span>NOMINAL</span>
                          </span>
                        )}
                      </td>
                      <td className="p-3 text-right">
                        <div className="inline-flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => openEditItem(item)}
                            className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                          >
                            <Pencil className="w-3 h-3" /> Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setErr('');
                              setDeleteTarget(item);
                            }}
                            className="inline-flex items-center gap-1 rounded border border-red-200 dark:border-red-800/80 bg-white dark:bg-slate-900 px-2 py-1 text-[11px] font-medium text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/70"
                          >
                            <Trash2 className="w-3 h-3" /> Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {subTab === 'batches' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
              <tr>
                <th className="p-3 font-medium">Batch / Lot #</th>
                <th className="p-3 font-medium">Ingredient</th>
                <th className="p-3 font-medium">Location</th>
                <th className="p-3 font-medium text-right">Remaining</th>
                <th className="p-3 font-medium text-right">Batch Cost</th>
                <th className="p-3 font-medium">Expiry Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {data.batches.map((b: any) => {
                const daysLeft = b.expiry_date ? Math.ceil((new Date(b.expiry_date).getTime() - Date.now()) / 86400000) : 99;
                return (
                  <tr key={b.id} className="hover:bg-slate-50 dark:hover:bg-slate-800">
                    <td className="p-3 font-mono font-semibold text-slate-900 dark:text-slate-50">{b.batch_number}</td>
                    <td className="p-3">{b.item_name}</td>
                    <td className="p-3 text-slate-600 dark:text-slate-300">{b.location_name}</td>
                    <td className="p-3 text-right font-mono tabular-nums">{formatNum(b.remaining_qty, 0)} {b.uom_code}</td>
                    <td className="p-3 text-right font-mono tabular-nums">{formatPHP(b.unit_cost)}</td>
                    <td className={`p-3 font-mono ${daysLeft <= 3 ? 'text-red-700 dark:text-red-300 font-semibold' : 'text-slate-600 dark:text-slate-300'}`}>
                      {b.expiry_date ? String(b.expiry_date).slice(0, 10) : 'No Expiry'}
                      {daysLeft <= 3 && ' (Expiring Soon)'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {subTab === 'movements' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
              <tr>
                <th className="p-3 font-medium">Timestamp</th>
                <th className="p-3 font-medium">Type</th>
                <th className="p-3 font-medium">Ingredient</th>
                <th className="p-3 font-medium">Location</th>
                <th className="p-3 font-medium text-right">Qty Delta</th>
                <th className="p-3 font-medium text-right">Total Cost</th>
                <th className="p-3 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {data.movements.map((m: any) => (
                <tr key={m.id}>
                  <td className="p-3 font-mono text-slate-500 dark:text-slate-400">{String(m.created_at).slice(0, 16).replace('T', ' ')}</td>
                  <td className="p-3 font-mono font-semibold">{m.txn_type}</td>
                  <td className="p-3">{m.item_name}</td>
                  <td className="p-3 text-slate-600 dark:text-slate-300">{m.location_name}</td>
                  <td className={`p-3 text-right font-mono tabular-nums font-semibold ${m.quantity_delta < 0 ? 'text-red-700 dark:text-red-300' : 'text-emerald-700 dark:text-emerald-300'}`}>
                    {m.quantity_delta > 0 ? '+' : ''}{formatNum(m.quantity_delta, 1)} {m.uom_code}
                  </td>
                  <td className="p-3 text-right font-mono tabular-nums">{formatPHP(m.total_cost)}</td>
                  <td className="p-3 text-slate-500 dark:text-slate-400 truncate max-w-[200px]">{m.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {subTab === 'waste' && (
        <WasteManagementPanel
          locations={locations}
          activeLocationId={locFilter || 'ALL'}
          inventoryItems={data.items}
          onWasteRecorded={async () => {
            await load();
            await onNotificationsChanged?.();
          }}
          onNavigateToCosting={onNavigate ? () => onNavigate('costing') : undefined}
        />
      )}

      {subTab === 'predictive' && (
        <PredictiveProcurementPanel
          locations={locations}
          activeLocationId={locFilter || 'ALL'}
          canCreatePo={canCreatePo}
          onPoCreated={async () => {
            await load();
            await onNotificationsChanged?.();
          }}
          onNavigateToProcurement={onNavigate ? () => onNavigate('procurement') : undefined}
        />
      )}

      {/* Modals */}
      {modal === 'transfer' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form onSubmit={submitTransfer} className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 p-5 space-y-3 border border-slate-200 dark:border-slate-800">
            <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">Transfer Stock Between Locations</h3>
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">From Location</label>
                <select value={trfForm.fromLocationId} onChange={(e) => setTrfForm({ ...trfForm, fromLocationId: e.target.value })} className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-2 text-xs">
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">To Location</label>
                <select value={trfForm.toLocationId} onChange={(e) => setTrfForm({ ...trfForm, toLocationId: e.target.value })} className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-2 text-xs">
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Ingredient / Item</label>
              <select value={trfForm.inventoryItemId} onChange={(e) => setTrfForm({ ...trfForm, inventoryItemId: e.target.value })} className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-2 text-xs">
                {data.items.map((i: any) => <option key={i.id} value={i.id}>{i.name} ({i.uom_code})</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Quantity (Base UOM)</label>
              <input type="number" required placeholder="e.g. 5000" value={trfForm.quantity} onChange={(e) => setTrfForm({ ...trfForm, quantity: e.target.value })} className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono" />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setModal(null)} className="px-4 py-2 rounded-lg border text-xs">Cancel</button>
              <button type="submit" className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 text-xs font-semibold">Execute FIFO Transfer</button>
            </div>
          </form>
        </div>
      )}

      {modal === 'count' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form onSubmit={submitCount} className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 p-5 space-y-3 border border-slate-200 dark:border-slate-800">
            <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">Physical Stock Count Reconciliation</h3>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Branch / Location</label>
              <select value={countForm.locationId} onChange={(e) => setCountForm({ ...countForm, locationId: e.target.value })} className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-2 text-xs">
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Ingredient / Item</label>
              <select value={countForm.inventoryItemId} onChange={(e) => setCountForm({ ...countForm, inventoryItemId: e.target.value })} className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-2 text-xs">
                {data.items.map((i: any) => <option key={i.id} value={i.id}>{i.name} ({i.uom_code})</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Actual Counted Quantity (Base UOM)</label>
              <input type="number" required placeholder="e.g. 12500" value={countForm.countedQty} onChange={(e) => setCountForm({ ...countForm, countedQty: e.target.value })} className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Reconciliation Notes</label>
              <input type="text" placeholder="Optional variance remarks" value={countForm.notes} onChange={(e) => setCountForm({ ...countForm, notes: e.target.value })} className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs" />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setModal(null)} className="px-4 py-2 rounded-lg border text-xs">Cancel</button>
              <button type="submit" className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 text-xs font-semibold">Post Adjustment</button>
            </div>
          </form>
        </div>
      )}

      {(modal === 'addItem' || modal === 'editItem') && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form onSubmit={submitItemForm} className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 p-5 space-y-3 border border-slate-200 dark:border-slate-800">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800/80 pb-2.5">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">
                  {modal === 'addItem' ? 'Add Ingredient / Raw Material' : 'Edit Ingredient / Raw Material'}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">Manage raw materials, packaging, and base unit costing</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setErr('');
                  setModal(null);
                }}
                className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {err && <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">{err}</div>}

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Ingredient Name</label>
                <input
                  required
                  placeholder="e.g. Pork Belly Slab"
                  value={itemForm.name}
                  onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">SKU</label>
                <input
                  required={modal === 'editItem'}
                  placeholder="Auto if blank"
                  value={itemForm.sku}
                  onChange={(e) => setItemForm({ ...itemForm, sku: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2.5">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Item Type</label>
                <select
                  value={itemForm.itemType}
                  onChange={(e) => setItemForm({ ...itemForm, itemType: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-2 text-xs"
                >
                  <option value="RAW_MATERIAL">Raw Material</option>
                  <option value="PACKAGING">Packaging</option>
                  <option value="FINISHED_GOOD">Finished Good</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Base UOM</label>
                <select
                  value={itemForm.baseUomId}
                  onChange={(e) => setItemForm({ ...itemForm, baseUomId: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-2 text-xs"
                >
                  {data.uoms.map((u: any) => (
                    <option key={u.id} value={u.id}>{u.code} — {u.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Costing</label>
                <select
                  value={itemForm.costingMethod}
                  onChange={(e) => setItemForm({ ...itemForm, costingMethod: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-2 text-xs"
                >
                  <option value="FIFO">FIFO</option>
                  <option value="WEIGHTED_AVERAGE">Weighted Avg</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2.5">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Unit Cost (PHP)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={itemForm.lastUnitCost}
                  onChange={(e) => setItemForm({ ...itemForm, lastUnitCost: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono text-right"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Reorder Point (Warning)</label>
                <input
                  type="number"
                  step="1"
                  min="0"
                  value={itemForm.reorderPoint}
                  onChange={(e) => setItemForm({ ...itemForm, reorderPoint: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono text-right"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Safety Stock (Critical Alert)</label>
                <input
                  type="number"
                  step="1"
                  min="0"
                  value={itemForm.minStockLevel}
                  onChange={(e) => setItemForm({ ...itemForm, minStockLevel: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono text-right"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800/80">
              <button
                type="button"
                onClick={() => {
                  setErr('');
                  setModal(null);
                }}
                className="px-4 py-2 rounded-lg border text-xs"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingItem}
                className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 text-xs font-semibold hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50"
              >
                {savingItem ? 'Saving...' : modal === 'addItem' ? 'Create Ingredient' : 'Save Changes'}
              </button>
            </div>
          </form>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-xl bg-white dark:bg-slate-900 p-5 space-y-3 border border-slate-200 dark:border-slate-800">
            <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">Delete Ingredient / Raw Material</h3>
            <p className="text-xs text-slate-600 dark:text-slate-300">
              Are you sure you want to delete <span className="font-semibold text-slate-900 dark:text-slate-50">{deleteTarget.name}</span> ({deleteTarget.sku})? Items used in product recipes or stock batches cannot be deleted until unlinked.
            </p>
            {err && <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">{err}</div>}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  setErr('');
                  setDeleteTarget(null);
                }}
                className="px-4 py-2 rounded-lg border text-xs"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={savingItem}
                onClick={confirmDeleteItem}
                className="px-4 py-2 rounded-lg bg-red-600 text-white text-xs font-semibold hover:bg-red-700 disabled:opacity-50"
              >
                {savingItem ? 'Deleting...' : 'Confirm Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
