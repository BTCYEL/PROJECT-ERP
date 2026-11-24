import React, { useEffect, useState } from 'react';
import { ArrowRightLeft, Trash, ClipboardCheck, Plus, Pencil, Trash2, X } from 'lucide-react';
import { apiFetch, formatNum, formatPHP } from '../lib/api.ts';
import { LocationRow } from '../types/erp.ts';

interface Props {
  locations: LocationRow[];
  activeLocationId: string;
  onLocationChange?: (locationId: string) => void;
  quickAction?: { action: string; nonce: number } | null;
  onQuickActionHandled?: () => void;
}

export function InventoryModule({ locations, activeLocationId, onLocationChange, quickAction, onQuickActionHandled }: Props) {
  const [locFilter, setLocFilter] = useState(activeLocationId === 'ALL' ? '' : activeLocationId);
  const [subTab, setSubTab] = useState<'stock' | 'batches' | 'movements'>('stock');
  const [data, setData] = useState<any>({ items: [], batches: [], movements: [], uoms: [] });
  const [modal, setModal] = useState<'transfer' | 'waste' | 'count' | 'addItem' | 'editItem' | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [savingItem, setSavingItem] = useState(false);
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
    if (quickAction.action === 'count' || quickAction.action === 'transfer' || quickAction.action === 'waste') {
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
        await apiFetch('/inventory/items', { method: 'POST', body: JSON.stringify(payload) });
        setMsg(`Added ingredient "${itemForm.name.trim()}"`);
      } else {
        await apiFetch(`/inventory/items/${itemForm.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        setMsg(`Updated ingredient "${itemForm.name.trim()}"`);
      }
      setModal(null);
      await load();
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
    } catch (e: any) {
      setErr(e.message || 'Unable to delete ingredient');
    } finally {
      setSavingItem(false);
    }
  };

  const totalValuation = data.items.reduce((s: number, i: any) => s + Number(i.stock_value || 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900">Inventory &amp; Batch Control</h1>
          <p className="text-sm text-slate-500">
            Total Valuation: <span className="font-mono font-semibold text-slate-900">{formatPHP(totalValuation)}</span> · FIFO &amp; Weighted Average Costing
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
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium"
          >
            <option value="">All Locations</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
          <button
            onClick={openAddItem}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" /> Add Ingredient
          </button>
          <button
            onClick={() => setModal('transfer')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <ArrowRightLeft className="w-3.5 h-3.5" /> Transfer Stock
          </button>
          <button
            onClick={() => setModal('waste')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <Trash className="w-3.5 h-3.5" /> Log Waste
          </button>
          <button
            onClick={() => setModal('count')}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            <ClipboardCheck className="w-3.5 h-3.5" /> Physical Count
          </button>
        </div>
      </div>

      {msg && <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 font-medium">{msg}</div>}
      {err && <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">{err}</div>}

      {/* Segmented Tabs */}
      <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg border border-slate-200 w-fit">
        {([
          { id: 'stock', label: 'Current Stock' },
          { id: 'batches', label: `Batches & Expiry (${data.batches.length})` },
          { id: 'movements', label: 'Movement Ledger' },
        ] as const).map((t) => (
          <button
            key={t.id}
            onClick={() => setSubTab(t.id)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 ${
              subTab === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subTab === 'stock' && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr>
                <th className="p-3 font-medium">SKU</th>
                <th className="p-3 font-medium">Ingredient / Material</th>
                <th className="p-3 font-medium">Method</th>
                <th className="p-3 font-medium text-right">On Hand</th>
                <th className="p-3 font-medium text-right">Reorder Pt</th>
                <th className="p-3 font-medium text-right">Unit Cost</th>
                <th className="p-3 font-medium text-right">Stock Value</th>
                <th className="p-3 font-medium">Status</th>
                <th className="p-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.items.map((item: any) => {
                const isLow = item.on_hand_qty <= item.reorder_point;
                return (
                  <tr key={item.id} className="hover:bg-slate-50">
                    <td className="p-3 font-mono text-slate-500">{item.sku}</td>
                    <td className="p-3 font-semibold text-slate-900">{item.name}</td>
                    <td className="p-3 text-slate-600">{item.costing_method}</td>
                    <td className="p-3 text-right font-mono tabular-nums font-semibold">
                      {formatNum(item.on_hand_qty, 0)} {item.uom_code}
                    </td>
                    <td className="p-3 text-right font-mono tabular-nums text-slate-500">
                      {formatNum(item.reorder_point, 0)} {item.uom_code}
                    </td>
                    <td className="p-3 text-right font-mono tabular-nums">{formatPHP(item.last_unit_cost)}</td>
                    <td className="p-3 text-right font-mono tabular-nums font-semibold">{formatPHP(item.stock_value)}</td>
                    <td className="p-3">
                      <span className={isLow ? 'text-amber-700 font-semibold' : 'text-emerald-700 font-medium'}>
                        {isLow ? 'LOW STOCK' : 'NOMINAL'}
                      </span>
                    </td>
                    <td className="p-3 text-right">
                      <div className="inline-flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => openEditItem(item)}
                          className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                        >
                          <Pencil className="w-3 h-3" /> Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setErr('');
                            setDeleteTarget(item);
                          }}
                          className="inline-flex items-center gap-1 rounded border border-red-200 bg-white px-2 py-1 text-[11px] font-medium text-red-700 hover:bg-red-50"
                        >
                          <Trash2 className="w-3 h-3" /> Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {subTab === 'batches' && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr>
                <th className="p-3 font-medium">Batch / Lot #</th>
                <th className="p-3 font-medium">Ingredient</th>
                <th className="p-3 font-medium">Location</th>
                <th className="p-3 font-medium text-right">Remaining</th>
                <th className="p-3 font-medium text-right">Batch Cost</th>
                <th className="p-3 font-medium">Expiry Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.batches.map((b: any) => {
                const daysLeft = b.expiry_date ? Math.ceil((new Date(b.expiry_date).getTime() - Date.now()) / 86400000) : 99;
                return (
                  <tr key={b.id} className="hover:bg-slate-50">
                    <td className="p-3 font-mono font-semibold text-slate-900">{b.batch_number}</td>
                    <td className="p-3">{b.item_name}</td>
                    <td className="p-3 text-slate-600">{b.location_name}</td>
                    <td className="p-3 text-right font-mono tabular-nums">{formatNum(b.remaining_qty, 0)} {b.uom_code}</td>
                    <td className="p-3 text-right font-mono tabular-nums">{formatPHP(b.unit_cost)}</td>
                    <td className={`p-3 font-mono ${daysLeft <= 3 ? 'text-red-700 font-semibold' : 'text-slate-600'}`}>
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
        <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
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
            <tbody className="divide-y divide-slate-100">
              {data.movements.map((m: any) => (
                <tr key={m.id}>
                  <td className="p-3 font-mono text-slate-500">{String(m.created_at).slice(0, 16).replace('T', ' ')}</td>
                  <td className="p-3 font-mono font-semibold">{m.txn_type}</td>
                  <td className="p-3">{m.item_name}</td>
                  <td className="p-3 text-slate-600">{m.location_name}</td>
                  <td className={`p-3 text-right font-mono tabular-nums font-semibold ${m.quantity_delta < 0 ? 'text-red-700' : 'text-emerald-700'}`}>
                    {m.quantity_delta > 0 ? '+' : ''}{formatNum(m.quantity_delta, 1)} {m.uom_code}
                  </td>
                  <td className="p-3 text-right font-mono tabular-nums">{formatPHP(m.total_cost)}</td>
                  <td className="p-3 text-slate-500 truncate max-w-[200px]">{m.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Modals */}
      {modal === 'transfer' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form onSubmit={submitTransfer} className="w-full max-w-md rounded-xl bg-white p-5 space-y-3 border border-slate-200">
            <h3 className="font-display text-base font-semibold text-slate-900">Transfer Stock Between Locations</h3>
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">From Location</label>
                <select value={trfForm.fromLocationId} onChange={(e) => setTrfForm({ ...trfForm, fromLocationId: e.target.value })} className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-xs">
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">To Location</label>
                <select value={trfForm.toLocationId} onChange={(e) => setTrfForm({ ...trfForm, toLocationId: e.target.value })} className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-xs">
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Ingredient / Item</label>
              <select value={trfForm.inventoryItemId} onChange={(e) => setTrfForm({ ...trfForm, inventoryItemId: e.target.value })} className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-xs">
                {data.items.map((i: any) => <option key={i.id} value={i.id}>{i.name} ({i.uom_code})</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Quantity (Base UOM)</label>
              <input type="number" required placeholder="e.g. 5000" value={trfForm.quantity} onChange={(e) => setTrfForm({ ...trfForm, quantity: e.target.value })} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono" />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setModal(null)} className="px-4 py-2 rounded-lg border text-xs">Cancel</button>
              <button type="submit" className="px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold">Execute FIFO Transfer</button>
            </div>
          </form>
        </div>
      )}

      {modal === 'waste' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form onSubmit={submitWaste} className="w-full max-w-md rounded-xl bg-white p-5 space-y-3 border border-slate-200">
            <h3 className="font-display text-base font-semibold text-slate-900">Log Spoilage or Kitchen Waste</h3>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Branch / Location</label>
              <select value={wasteForm.locationId} onChange={(e) => setWasteForm({ ...wasteForm, locationId: e.target.value })} className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-xs">
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Ingredient / Item</label>
              <select value={wasteForm.inventoryItemId} onChange={(e) => setWasteForm({ ...wasteForm, inventoryItemId: e.target.value })} className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-xs">
                {data.items.map((i: any) => <option key={i.id} value={i.id}>{i.name} ({i.uom_code})</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Loss Type</label>
                <select value={wasteForm.txnType} onChange={(e) => setWasteForm({ ...wasteForm, txnType: e.target.value })} className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-xs">
                  <option value="OUT_WASTE">Prep Waste</option>
                  <option value="OUT_SPOILAGE">Expired / Spoiled</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Quantity (Base UOM)</label>
                <input type="number" required placeholder="Qty" value={wasteForm.quantity} onChange={(e) => setWasteForm({ ...wasteForm, quantity: e.target.value })} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Reason / Cause</label>
              <input type="text" required placeholder="e.g. Over-trimmed or expired batch" value={wasteForm.reason} onChange={(e) => setWasteForm({ ...wasteForm, reason: e.target.value })} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs" />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setModal(null)} className="px-4 py-2 rounded-lg border text-xs">Cancel</button>
              <button type="submit" className="px-4 py-2 rounded-lg bg-red-600 text-white text-xs font-semibold">Record Loss</button>
            </div>
          </form>
        </div>
      )}

      {modal === 'count' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form onSubmit={submitCount} className="w-full max-w-md rounded-xl bg-white p-5 space-y-3 border border-slate-200">
            <h3 className="font-display text-base font-semibold text-slate-900">Physical Stock Count Reconciliation</h3>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Branch / Location</label>
              <select value={countForm.locationId} onChange={(e) => setCountForm({ ...countForm, locationId: e.target.value })} className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-xs">
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Ingredient / Item</label>
              <select value={countForm.inventoryItemId} onChange={(e) => setCountForm({ ...countForm, inventoryItemId: e.target.value })} className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-xs">
                {data.items.map((i: any) => <option key={i.id} value={i.id}>{i.name} ({i.uom_code})</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Actual Counted Quantity (Base UOM)</label>
              <input type="number" required placeholder="e.g. 12500" value={countForm.countedQty} onChange={(e) => setCountForm({ ...countForm, countedQty: e.target.value })} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Reconciliation Notes</label>
              <input type="text" placeholder="Optional variance remarks" value={countForm.notes} onChange={(e) => setCountForm({ ...countForm, notes: e.target.value })} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs" />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setModal(null)} className="px-4 py-2 rounded-lg border text-xs">Cancel</button>
              <button type="submit" className="px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold">Post Adjustment</button>
            </div>
          </form>
        </div>
      )}

      {(modal === 'addItem' || modal === 'editItem') && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form onSubmit={submitItemForm} className="w-full max-w-md rounded-xl bg-white p-5 space-y-3 border border-slate-200">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900">
                  {modal === 'addItem' ? 'Add Ingredient / Raw Material' : 'Edit Ingredient / Raw Material'}
                </h3>
                <p className="text-xs text-slate-500">Manage raw materials, packaging, and base unit costing</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setErr('');
                  setModal(null);
                }}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {err && <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">{err}</div>}

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Ingredient Name</label>
                <input
                  required
                  placeholder="e.g. Pork Belly Slab"
                  value={itemForm.name}
                  onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">SKU</label>
                <input
                  required={modal === 'editItem'}
                  placeholder="Auto if blank"
                  value={itemForm.sku}
                  onChange={(e) => setItemForm({ ...itemForm, sku: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono"
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2.5">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Item Type</label>
                <select
                  value={itemForm.itemType}
                  onChange={(e) => setItemForm({ ...itemForm, itemType: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-xs"
                >
                  <option value="RAW_MATERIAL">Raw Material</option>
                  <option value="PACKAGING">Packaging</option>
                  <option value="FINISHED_GOOD">Finished Good</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Base UOM</label>
                <select
                  value={itemForm.baseUomId}
                  onChange={(e) => setItemForm({ ...itemForm, baseUomId: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-xs"
                >
                  {data.uoms.map((u: any) => (
                    <option key={u.id} value={u.id}>{u.code} — {u.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Costing</label>
                <select
                  value={itemForm.costingMethod}
                  onChange={(e) => setItemForm({ ...itemForm, costingMethod: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-xs"
                >
                  <option value="FIFO">FIFO</option>
                  <option value="WEIGHTED_AVERAGE">Weighted Avg</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2.5">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Unit Cost (PHP)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={itemForm.lastUnitCost}
                  onChange={(e) => setItemForm({ ...itemForm, lastUnitCost: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono text-right"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Reorder Point</label>
                <input
                  type="number"
                  step="1"
                  min="0"
                  value={itemForm.reorderPoint}
                  onChange={(e) => setItemForm({ ...itemForm, reorderPoint: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono text-right"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Min Stock</label>
                <input
                  type="number"
                  step="1"
                  min="0"
                  value={itemForm.minStockLevel}
                  onChange={(e) => setItemForm({ ...itemForm, minStockLevel: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono text-right"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
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
                className="px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-50"
              >
                {savingItem ? 'Saving...' : modal === 'addItem' ? 'Create Ingredient' : 'Save Changes'}
              </button>
            </div>
          </form>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-xl bg-white p-5 space-y-3 border border-slate-200">
            <h3 className="font-display text-base font-semibold text-slate-900">Delete Ingredient / Raw Material</h3>
            <p className="text-xs text-slate-600">
              Are you sure you want to delete <span className="font-semibold text-slate-900">{deleteTarget.name}</span> ({deleteTarget.sku})? Items used in product recipes or stock batches cannot be deleted until unlinked.
            </p>
            {err && <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">{err}</div>}
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
