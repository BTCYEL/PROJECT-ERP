import React, { useEffect, useState } from 'react';
import { Plus, CheckCircle2, PackageCheck } from 'lucide-react';
import { apiFetch, formatNum, formatPHP } from '../lib/api.ts';
import { AuthUser, LocationRow, PERMISSIONS } from '../types/erp.ts';

interface Props {
  user: AuthUser;
  locations: LocationRow[];
}

export function ProcurementModule({ user, locations }: Props) {
  const [subTab, setSubTab] = useState<'pos' | 'suppliers' | 'payables'>('pos');
  const [data, setData] = useState<any>({ suppliers: [], priceComparison: [], purchaseOrders: [], invoices: [] });
  const [invItems, setInvItems] = useState<any[]>([]);
  const [receivingPo, setReceivingPo] = useState<any>(null);
  const [recvMap, setRecvMap] = useState<Record<string, { qty: string; batch: string; expiry: string; notes: string }>>({});
  const [showNewPo, setShowNewPo] = useState(false);
  const [poForm, setPoForm] = useState({ supplierId: '', locationId: 'loc_commissary', itemId: '', qty: '100', unitCost: '14' });
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const canApprove = user.roleCode === 'SUPER_ADMIN' || user.roleCode === 'BUSINESS_OWNER' || user.permissions.includes(PERMISSIONS.PO_APPROVE);

  const load = async () => {
    try {
      setErr('');
      const [proc, inv] = await Promise.all([apiFetch('/procurement'), apiFetch('/inventory')]);
      setData(proc);
      setInvItems(inv.items || []);
      if (proc.suppliers?.[0] && !poForm.supplierId) {
        setPoForm((f) => ({ ...f, supplierId: proc.suppliers[0].id, itemId: inv.items?.[0]?.id || '' }));
      }
    } catch (e: any) {
      setErr(e.message || 'Unable to load procurement data');
    }
  };

  useEffect(() => {
    load();
  }, []);

  const approvePO = async (id: string) => {
    setErr('');
    try {
      await apiFetch(`/procurement/purchase-orders/${id}/approve`, { method: 'POST' });
      setMsg('Purchase order approved and ready for goods receiving.');
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const openReceive = (po: any) => {
    const map: any = {};
    po.items.forEach((it: any) => {
      map[it.id] = {
        qty: String(Math.max(0, it.ordered_qty - it.received_qty)),
        batch: `LOT-${Date.now().toString().slice(-4)}`,
        expiry: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
        notes: '',
      };
    });
    setRecvMap(map);
    setReceivingPo(po);
  };

  const submitReceive = async () => {
    if (!receivingPo) return;
    setErr('');
    try {
      const items = receivingPo.items.map((it: any) => ({
        poItemId: it.id,
        receivedQty: Number(recvMap[it.id]?.qty || 0),
        batchNumber: recvMap[it.id]?.batch,
        expiryDate: recvMap[it.id]?.expiry || null,
        discrepancyNotes: recvMap[it.id]?.notes || '',
      }));
      const r = await apiFetch(`/procurement/purchase-orders/${receivingPo.id}/receive`, {
        method: 'POST',
        body: JSON.stringify({ items }),
      });
      setReceivingPo(null);
      setMsg(`Posted ${r.grnNumber} · Created StockBatches & Supplier Invoice (${formatPHP(r.totalRecvValue)})`);
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const createPO = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      const r = await apiFetch('/procurement/purchase-orders', {
        method: 'POST',
        body: JSON.stringify({
          supplierId: poForm.supplierId,
          locationId: poForm.locationId,
          items: [{ inventoryItemId: poForm.itemId, orderedQty: Number(poForm.qty), unitCost: Number(poForm.unitCost) }],
        }),
      });
      setShowNewPo(false);
      setMsg(`Created ${r.poNumber} awaiting manager approval.`);
      await load();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const payInvoice = async (inv: any) => {
    setErr('');
    try {
      const balance = inv.total_amount - inv.paid_amount;
      await apiFetch(`/procurement/invoices/${inv.id}/pay`, {
        method: 'POST',
        body: JSON.stringify({ amount: balance, method: 'BANK_TRANSFER', referenceNo: `BPI-${Date.now().toString().slice(-5)}` }),
      });
      setMsg(`Paid ${formatPHP(balance)} for ${inv.invoice_number} and posted AP settlement Journal Entry.`);
      await load();
    } catch (e: any) {
      setErr(e.message || 'Unable to settle invoice');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900">Procurement &amp; Suppliers</h1>
          <p className="text-sm text-slate-500">Purchase orders, manager approvals, partial GRN batch receiving, and supplier payables</p>
        </div>
        <button
          onClick={() => setShowNewPo(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap shrink-0"
        >
          <Plus className="w-4 h-4" /> Create Purchase Order
        </button>
      </div>

      {msg && <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 font-medium">{msg}</div>}
      {err && <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">{err}</div>}

      <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg border border-slate-200 w-fit">
        {([
          { id: 'pos', label: `Purchase Orders (${data.purchaseOrders.length})` },
          { id: 'suppliers', label: 'Suppliers & Price Comparison' },
          { id: 'payables', label: `Supplier Invoices & AP (${data.invoices.length})` },
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

      {subTab === 'pos' && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr>
                <th className="p-3 font-medium">PO Number</th>
                <th className="p-3 font-medium">Supplier</th>
                <th className="p-3 font-medium">Delivery Location</th>
                <th className="p-3 font-medium">Items</th>
                <th className="p-3 font-medium text-right">Total Amount</th>
                <th className="p-3 font-medium">Status</th>
                <th className="p-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.purchaseOrders.map((po: any) => (
                <tr key={po.id} className="hover:bg-slate-50">
                  <td className="p-3 font-mono font-semibold text-slate-900">{po.po_number}</td>
                  <td className="p-3">{po.supplier_name}</td>
                  <td className="p-3 text-slate-600">{po.location_name}</td>
                  <td className="p-3 text-slate-600">
                    {po.items.map((i: any) => `${i.item_name} (${i.received_qty}/${i.ordered_qty} ${i.uom_code})`).join(', ')}
                  </td>
                  <td className="p-3 text-right font-mono tabular-nums font-semibold">{formatPHP(po.total_amount)}</td>
                  <td className="p-3 font-semibold text-slate-800">{po.status}</td>
                  <td className="p-3 text-right space-x-2">
                    {po.status === 'PENDING_APPROVAL' && canApprove && (
                      <button
                        onClick={() => approvePO(po.id)}
                        className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-2.5 py-1.5 text-xs font-semibold text-white"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                      </button>
                    )}
                    {(po.status === 'APPROVED' || po.status === 'PARTIAL') && (
                      <button
                        onClick={() => openReceive(po)}
                        className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white"
                      >
                        <PackageCheck className="w-3.5 h-3.5" /> Receive Goods
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {subTab === 'suppliers' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
            <div className="p-4 border-b border-slate-200 text-xs font-semibold text-slate-700">Active Suppliers</div>
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-100 text-slate-500">
                <tr>
                  <th className="p-3 font-medium">Supplier</th>
                  <th className="p-3 font-medium">Contact</th>
                  <th className="p-3 font-medium text-right">Terms</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.suppliers.map((s: any) => (
                  <tr key={s.id}>
                    <td className="p-3 font-semibold text-slate-900">{s.name}<p className="font-normal text-slate-500">{s.tin}</p></td>
                    <td className="p-3 text-slate-600">{s.contact_person}<p>{s.phone}</p></td>
                    <td className="p-3 text-right font-mono">{s.payment_terms} days</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
            <div className="p-4 border-b border-slate-200 text-xs font-semibold text-slate-700">Supplier Price Comparison</div>
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-100 text-slate-500">
                <tr>
                  <th className="p-3 font-medium">Ingredient</th>
                  <th className="p-3 font-medium">Supplier</th>
                  <th className="p-3 font-medium text-right">Unit Price</th>
                  <th className="p-3 font-medium text-right">Lead Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.priceComparison.map((pc: any) => (
                  <tr key={pc.id}>
                    <td className="p-3 font-medium text-slate-900">{pc.item_name}</td>
                    <td className="p-3 text-slate-600">{pc.supplier_name}</td>
                    <td className="p-3 text-right font-mono tabular-nums font-semibold">{formatPHP(pc.unit_price)} / {pc.uom_code}</td>
                    <td className="p-3 text-right font-mono">{pc.lead_time_days}d</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {subTab === 'payables' && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr>
                <th className="p-3 font-medium">Invoice #</th>
                <th className="p-3 font-medium">Supplier</th>
                <th className="p-3 font-medium">Due Date</th>
                <th className="p-3 font-medium text-right">Total</th>
                <th className="p-3 font-medium text-right">Paid</th>
                <th className="p-3 font-medium text-right">Balance</th>
                <th className="p-3 font-medium">Status</th>
                <th className="p-3 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.invoices.map((inv: any) => {
                const bal = inv.total_amount - inv.paid_amount;
                return (
                  <tr key={inv.id}>
                    <td className="p-3 font-mono font-semibold">{inv.invoice_number}</td>
                    <td className="p-3">{inv.supplier_name}</td>
                    <td className="p-3 font-mono text-slate-500">{String(inv.due_date).slice(0, 10)}</td>
                    <td className="p-3 text-right font-mono tabular-nums">{formatPHP(inv.total_amount)}</td>
                    <td className="p-3 text-right font-mono tabular-nums">{formatPHP(inv.paid_amount)}</td>
                    <td className="p-3 text-right font-mono tabular-nums font-semibold text-red-700">{formatPHP(bal)}</td>
                    <td className="p-3 font-semibold">{inv.status}</td>
                    <td className="p-3 text-right">
                      {inv.status !== 'PAID' && (
                        <button onClick={() => payInvoice(inv)} className="rounded-md bg-slate-900 px-2.5 py-1.5 text-xs font-semibold text-white">
                          Settle Balance
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Receive Goods (GRN) Modal */}
      {receivingPo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-2xl rounded-xl bg-white p-5 space-y-4 border border-slate-200">
            <h3 className="font-display text-base font-semibold">Receive Goods — {receivingPo.po_number}</h3>
            <div className="space-y-3 max-h-80 overflow-y-auto">
              {receivingPo.items.map((it: any) => (
                <div key={it.id} className="grid grid-cols-1 sm:grid-cols-5 gap-2 items-center border border-slate-200 rounded-lg p-3">
                  <div className="sm:col-span-2">
                    <p className="text-xs font-semibold text-slate-900">{it.item_name}</p>
                    <p className="text-[11px] text-slate-500">Ordered: {formatNum(it.ordered_qty, 0)} {it.uom_code}</p>
                  </div>
                  <input
                    type="number"
                    placeholder="Recv Qty"
                    value={recvMap[it.id]?.qty || ''}
                    onChange={(e) => setRecvMap((m) => ({ ...m, [it.id]: { ...m[it.id], qty: e.target.value } }))}
                    className="rounded border px-2 py-1.5 text-xs font-mono"
                  />
                  <input
                    type="text"
                    placeholder="Lot #"
                    value={recvMap[it.id]?.batch || ''}
                    onChange={(e) => setRecvMap((m) => ({ ...m, [it.id]: { ...m[it.id], batch: e.target.value } }))}
                    className="rounded border px-2 py-1.5 text-xs font-mono"
                  />
                  <input
                    type="date"
                    value={recvMap[it.id]?.expiry || ''}
                    onChange={(e) => setRecvMap((m) => ({ ...m, [it.id]: { ...m[it.id], expiry: e.target.value } }))}
                    className="rounded border px-2 py-1.5 text-xs font-mono"
                  />
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setReceivingPo(null)} className="px-4 py-2 rounded-lg border text-xs">Cancel</button>
              <button onClick={submitReceive} className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-xs font-semibold">
                Post GRN &amp; Create Stock Batches
              </button>
            </div>
          </div>
        </div>
      )}

      {showNewPo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form onSubmit={createPO} className="w-full max-w-md rounded-xl bg-white p-5 space-y-3 border border-slate-200">
            <h3 className="font-display text-base font-semibold">New Purchase Order</h3>
            <select value={poForm.supplierId} onChange={(e) => setPoForm({ ...poForm, supplierId: e.target.value })} className="w-full rounded border px-3 py-2 text-xs">
              {data.suppliers.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select value={poForm.locationId} onChange={(e) => setPoForm({ ...poForm, locationId: e.target.value })} className="w-full rounded border px-3 py-2 text-xs">
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <select value={poForm.itemId} onChange={(e) => setPoForm({ ...poForm, itemId: e.target.value })} className="w-full rounded border px-3 py-2 text-xs">
              {invItems.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.uom_code})</option>)}
            </select>
            <div className="grid grid-cols-2 gap-2">
              <input type="number" required placeholder="Qty" value={poForm.qty} onChange={(e) => setPoForm({ ...poForm, qty: e.target.value })} className="rounded border px-3 py-2 text-xs font-mono" />
              <input type="number" step="0.01" required placeholder="Unit Cost" value={poForm.unitCost} onChange={(e) => setPoForm({ ...poForm, unitCost: e.target.value })} className="rounded border px-3 py-2 text-xs font-mono" />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowNewPo(false)} className="px-4 py-2 rounded-lg border text-xs">Cancel</button>
              <button type="submit" className="px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold">Submit for Approval</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
