import React, { useEffect, useState } from 'react';
import { Plus, CheckCircle2, PackageCheck, Pencil, XCircle, Eye, Printer, Trash2, X } from 'lucide-react';
import { apiFetch, formatNum, formatPHP } from '../lib/api.ts';
import { AuthUser, LocationRow, PERMISSIONS } from '../types/erp.ts';

interface Props {
  user: AuthUser;
  locations: LocationRow[];
  activeLocationId?: string;
}

interface PoLineDraft {
  id?: string;
  inventoryItemId: string;
  orderedQty: string;
  unitCost: string;
}

export function ProcurementModule({ user, locations, activeLocationId = 'ALL' }: Props) {
  const [subTab, setSubTab] = useState<'pos' | 'suppliers' | 'payables'>('pos');
  const [data, setData] = useState<any>({ suppliers: [], priceComparison: [], purchaseOrders: [], invoices: [] });
  const [invItems, setInvItems] = useState<any[]>([]);
  const [receivingPo, setReceivingPo] = useState<any>(null);
  const [recvMap, setRecvMap] = useState<Record<string, { qty: string; batch: string; expiry: string; notes: string }>>({});

  // Create PO Modal
  const [showNewPo, setShowNewPo] = useState(false);
  const [poForm, setPoForm] = useState<{
    supplierId: string;
    locationId: string;
    expectedAt: string;
    notes: string;
    items: PoLineDraft[];
  }>({
    supplierId: '',
    locationId: 'loc_commissary',
    expectedAt: '',
    notes: '',
    items: [{ inventoryItemId: '', orderedQty: '100', unitCost: '14' }],
  });

  // Review / Edit PO Modal
  const [reviewPo, setReviewPo] = useState<any>(null);
  const [reviewForm, setReviewForm] = useState<{
    supplierId: string;
    locationId: string;
    expectedAt: string;
    notes: string;
    items: PoLineDraft[];
  }>({
    supplierId: '',
    locationId: '',
    expectedAt: '',
    notes: '',
    items: [],
  });
  const [savingReview, setSavingReview] = useState(false);

  // Cancel PO Modal
  const [cancelPoTarget, setCancelPoTarget] = useState<any>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancellingPo, setCancellingPo] = useState(false);

  // View / Print Supplier Invoice Modal
  const [viewInvoice, setViewInvoice] = useState<any>(null);

  // Supplier Add / Edit / Delete Modals
  const [supplierModal, setSupplierModal] = useState<'add' | 'edit' | null>(null);
  const [supplierEditId, setSupplierEditId] = useState<string>('');
  const [supplierForm, setSupplierForm] = useState({
    code: '',
    name: '',
    contactPerson: '',
    phone: '',
    email: '',
    address: '',
    tin: '',
    paymentTerms: '15',
  });
  const [supplierModalErr, setSupplierModalErr] = useState('');
  const [savingSupplier, setSavingSupplier] = useState(false);
  const [supplierContext, setSupplierContext] = useState<'newPo' | 'reviewPo' | 'tab'>('tab');
  const [deleteSupplierTarget, setDeleteSupplierTarget] = useState<any>(null);
  const [deletingSupplier, setDeletingSupplier] = useState(false);

  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const canApprove =
    user.roleCode === 'SUPER_ADMIN' ||
    user.roleCode === 'BUSINESS_OWNER' ||
    user.permissions.includes(PERMISSIONS.PO_APPROVE);

  const load = async () => {
    try {
      setErr('');
      const [proc, inv] = await Promise.all([apiFetch('/procurement'), apiFetch('/inventory')]);
      setData(proc);
      setInvItems(inv.items || []);
      setViewInvoice((prev: any) => (prev ? proc.invoices?.find((x: any) => x.id === prev.id) || prev : null));
      if (proc.suppliers?.[0] && !poForm.supplierId) {
        const firstItem = inv.items?.[0];
        const defaultLoc =
          activeLocationId !== 'ALL' && locations.some((l) => l.id === activeLocationId)
            ? activeLocationId
            : locations[0]?.id || '';
        setPoForm((f) => ({
          ...f,
          supplierId: proc.suppliers[0].id,
          locationId: defaultLoc || f.locationId,
          items: [
            {
              inventoryItemId: firstItem?.id || '',
              orderedQty: f.items[0]?.orderedQty || '100',
              unitCost: String(firstItem?.last_unit_cost ?? f.items[0]?.unitCost ?? '14'),
            },
          ],
        }));
      }
      return proc;
    } catch (e: any) {
      setErr(e.message || 'Unable to load procurement data');
      return null;
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openNewPoModal = () => {
    setErr('');
    const firstItem = invItems[0];
    const defaultLoc =
      activeLocationId !== 'ALL' && locations.some((l) => l.id === activeLocationId)
        ? activeLocationId
        : locations[0]?.id || 'loc_commissary';
    setPoForm({
      supplierId: data.suppliers?.[0]?.id || '',
      locationId: defaultLoc,
      expectedAt: '',
      notes: '',
      items: [
        {
          inventoryItemId: firstItem?.id || '',
          orderedQty: '100',
          unitCost: String(firstItem?.last_unit_cost ?? 14),
        },
      ],
    });
    setShowNewPo(true);
  };

  const openReviewModal = (po: any) => {
    setErr('');
    setReviewPo(po);
    setReviewForm({
      supplierId: po.supplier_id || data.suppliers?.[0]?.id || '',
      locationId: po.location_id || locations[0]?.id || '',
      expectedAt: po.expected_at ? String(po.expected_at).slice(0, 10) : '',
      notes: po.notes || '',
      items: (po.items || []).map((pi: any) => ({
        id: pi.id,
        inventoryItemId: pi.inventory_item_id,
        orderedQty: String(pi.ordered_qty),
        unitCost: String(pi.unit_cost),
      })),
    });
  };

  const saveReviewPo = async (approveAfterSave: boolean) => {
    if (!reviewPo) return;
    setErr('');
    setSavingReview(true);
    try {
      const res = await apiFetch<any>(`/procurement/purchase-orders/${reviewPo.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          supplierId: reviewForm.supplierId,
          locationId: reviewForm.locationId,
          expectedAt: reviewForm.expectedAt || null,
          notes: reviewForm.notes,
          approve: approveAfterSave,
          items: reviewForm.items.map((line) => ({
            id: line.id,
            inventoryItemId: line.inventoryItemId,
            orderedQty: Number(line.orderedQty),
            unitCost: Number(line.unitCost),
          })),
        }),
      });
      setReviewPo(null);
      setMsg(
        approveAfterSave
          ? `Reviewed and approved ${res.poNumber} (${formatPHP(res.totalAmount)}). Ready for goods receiving.`
          : `Updated purchase order ${res.poNumber} (${formatPHP(res.totalAmount)}).`,
      );
      await load();
    } catch (e: any) {
      setErr(e.message || 'Unable to update purchase order');
    } finally {
      setSavingReview(false);
    }
  };

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

  const confirmCancelPO = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cancelPoTarget) return;
    setErr('');
    setCancellingPo(true);
    try {
      await apiFetch(`/procurement/purchase-orders/${cancelPoTarget.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: cancelReason }),
      });
      const cancelledNumber = cancelPoTarget.po_number;
      setCancelPoTarget(null);
      setCancelReason('');
      setReviewPo(null);
      setMsg(`Cancelled purchase order ${cancelledNumber}.`);
      await load();
    } catch (e: any) {
      setErr(e.message || 'Unable to cancel purchase order');
    } finally {
      setCancellingPo(false);
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

  const openAddSupplierModal = (context: 'newPo' | 'reviewPo' | 'tab') => {
    setSupplierModalErr('');
    setSupplierContext(context);
    setSupplierEditId('');
    const nextNum = (data.suppliers?.length || 0) + 1;
    setSupplierForm({
      code: `SUP-${String(nextNum).padStart(3, '0')}`,
      name: '',
      contactPerson: '',
      phone: '',
      email: '',
      address: '',
      tin: '',
      paymentTerms: '15',
    });
    setSupplierModal('add');
  };

  const openEditSupplierModal = (sup: any, context: 'newPo' | 'reviewPo' | 'tab') => {
    if (!sup) return;
    setSupplierModalErr('');
    setSupplierContext(context);
    setSupplierEditId(sup.id);
    setSupplierForm({
      code: sup.code || '',
      name: sup.name || '',
      contactPerson: sup.contact_person || '',
      phone: sup.phone || '',
      email: sup.email || '',
      address: sup.address || '',
      tin: sup.tin || '',
      paymentTerms: String(sup.payment_terms ?? 0),
    });
    setSupplierModal('edit');
  };

  const handleSaveSupplier = async (e: React.FormEvent) => {
    e.preventDefault();
    setSupplierModalErr('');
    if (!supplierForm.name.trim()) {
      setSupplierModalErr('Supplier name is required');
      return;
    }
    setSavingSupplier(true);
    try {
      const payload = {
        code: supplierForm.code.trim(),
        name: supplierForm.name.trim(),
        contactPerson: supplierForm.contactPerson.trim(),
        phone: supplierForm.phone.trim(),
        email: supplierForm.email.trim(),
        address: supplierForm.address.trim(),
        tin: supplierForm.tin.trim(),
        paymentTerms: Math.max(0, Math.round(Number(supplierForm.paymentTerms || 0))),
      };
      if (supplierModal === 'add') {
        const res = await apiFetch<{ id: string }>('/procurement/suppliers', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        setMsg(`Added supplier "${payload.name}".`);
        setSupplierModal(null);
        await load();
        if (supplierContext === 'newPo' && res?.id) {
          setPoForm((f) => ({ ...f, supplierId: res.id }));
        } else if (supplierContext === 'reviewPo' && res?.id) {
          setReviewForm((f) => ({ ...f, supplierId: res.id }));
        }
      } else if (supplierModal === 'edit' && supplierEditId) {
        await apiFetch(`/procurement/suppliers/${supplierEditId}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        setMsg(`Updated supplier "${payload.name}".`);
        setSupplierModal(null);
        await load();
      }
    } catch (e: any) {
      setSupplierModalErr(e.message || 'Unable to save supplier');
    } finally {
      setSavingSupplier(false);
    }
  };

  const handleDeleteSupplier = async () => {
    if (!deleteSupplierTarget) return;
    setDeletingSupplier(true);
    setErr('');
    try {
      const targetId = deleteSupplierTarget.id;
      const targetName = deleteSupplierTarget.name || 'Supplier';
      const res = await apiFetch<any>(`/procurement/suppliers/${targetId}`, { method: 'DELETE' });
      setDeleteSupplierTarget(null);
      setMsg(
        res?.archived
          ? `Archived supplier "${targetName}" (historical POs and invoices preserved).`
          : `Deleted supplier "${targetName}".`,
      );
      const refreshed = await load();
      const remaining = refreshed?.suppliers || [];
      if (poForm.supplierId === targetId) {
        setPoForm((f) => ({ ...f, supplierId: remaining[0]?.id || '' }));
      }
      if (reviewForm.supplierId === targetId) {
        setReviewForm((f) => ({ ...f, supplierId: remaining[0]?.id || '' }));
      }
    } catch (e: any) {
      setErr(e.message || 'Unable to delete supplier');
      setDeleteSupplierTarget(null);
    } finally {
      setDeletingSupplier(false);
    }
  };

  const createPO = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (!poForm.supplierId) {
      setErr('Please select or add a supplier before submitting a purchase order.');
      return;
    }
    try {
      const r = await apiFetch('/procurement/purchase-orders', {
        method: 'POST',
        body: JSON.stringify({
          supplierId: poForm.supplierId,
          locationId: poForm.locationId,
          expectedAt: poForm.expectedAt || null,
          notes: poForm.notes,
          items: poForm.items.map((i) => ({
            inventoryItemId: i.inventoryItemId,
            orderedQty: Number(i.orderedQty),
            unitCost: Number(i.unitCost),
          })),
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

  const getStatusClass = (status: string) => {
    switch (status) {
      case 'PENDING_APPROVAL':
        return 'text-amber-700';
      case 'APPROVED':
        return 'text-emerald-700';
      case 'PARTIAL':
      case 'PARTIALLY_RECEIVED':
        return 'text-blue-700';
      case 'RECEIVED':
        return 'text-slate-800';
      case 'CANCELLED':
        return 'text-red-600';
      default:
        return 'text-slate-800';
    }
  };

  const newPoTotal = poForm.items.reduce((s, i) => s + (Number(i.orderedQty) || 0) * (Number(i.unitCost) || 0), 0);
  const reviewPoTotal = reviewForm.items.reduce((s, i) => s + (Number(i.orderedQty) || 0) * (Number(i.unitCost) || 0), 0);
  const reviewEditable = reviewPo?.status === 'PENDING_APPROVAL';
  const reviewCanCancel =
    reviewPo &&
    (reviewPo.status === 'PENDING_APPROVAL' || reviewPo.status === 'APPROVED') &&
    (reviewPo.items || []).every((pi: any) => Number(pi.received_qty || 0) === 0);

  const visiblePurchaseOrders =
    activeLocationId && activeLocationId !== 'ALL'
      ? (data.purchaseOrders || []).filter((po: any) => po.location_id === activeLocationId)
      : data.purchaseOrders || [];
  const visibleInvoices =
    activeLocationId && activeLocationId !== 'ALL'
      ? (data.invoices || []).filter((inv: any) => inv.location_id === activeLocationId)
      : data.invoices || [];

  return (
    <div className="space-y-6">
      <div className={viewInvoice ? 'no-print space-y-6' : 'space-y-6'}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900">Procurement &amp; Suppliers</h1>
          <p className="text-sm text-slate-500">Purchase orders, manager approvals, partial GRN batch receiving, and supplier payables</p>
        </div>
        <button
          onClick={openNewPoModal}
          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap shrink-0"
        >
          <Plus className="w-4 h-4" /> Create Purchase Order
        </button>
      </div>

      {msg && <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 font-medium">{msg}</div>}
      {err && <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">{err}</div>}

      <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg border border-slate-200 w-fit">
        {([
          { id: 'pos', label: `Purchase Orders (${visiblePurchaseOrders.length})` },
          { id: 'suppliers', label: 'Suppliers & Price Comparison' },
          { id: 'payables', label: `Supplier Invoices & AP (${visibleInvoices.length})` },
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
              {visiblePurchaseOrders.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-xs text-slate-400">
                    No purchase orders match the selected truck / location.
                  </td>
                </tr>
              ) : visiblePurchaseOrders.map((po: any) => {
                const hasReceived = (po.items || []).some((pi: any) => Number(pi.received_qty || 0) > 0);
                const canCancel = (po.status === 'PENDING_APPROVAL' || po.status === 'APPROVED') && !hasReceived;

                return (
                  <tr key={po.id} className="hover:bg-slate-50">
                    <td className="p-3 font-mono font-semibold text-slate-900 whitespace-nowrap">{po.po_number}</td>
                    <td className="p-3">{po.supplier_name}</td>
                    <td className="p-3 text-slate-600">{po.location_name}</td>
                    <td className="p-3 text-slate-600">
                      {po.items.map((i: any) => `${i.item_name} (${i.received_qty}/${i.ordered_qty} ${i.uom_code})`).join(', ')}
                    </td>
                    <td className="p-3 text-right font-mono tabular-nums font-semibold whitespace-nowrap">{formatPHP(po.total_amount)}</td>
                    <td className={`p-3 font-semibold whitespace-nowrap ${getStatusClass(po.status)}`}>{po.status}</td>
                    <td className="p-3 text-right whitespace-nowrap">
                      <div className="inline-flex items-center justify-end gap-1.5">
                        {po.status === 'PENDING_APPROVAL' ? (
                          <button
                            type="button"
                            onClick={() => openReviewModal(po)}
                            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                          >
                            <Pencil className="w-3.5 h-3.5" /> Edit / Review
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => openReviewModal(po)}
                            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                          >
                            <Eye className="w-3.5 h-3.5" /> Review
                          </button>
                        )}

                        {po.status === 'PENDING_APPROVAL' && canApprove && (
                          <button
                            type="button"
                            onClick={() => approvePO(po.id)}
                            className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                          </button>
                        )}

                        {(po.status === 'APPROVED' || po.status === 'PARTIAL' || po.status === 'PARTIALLY_RECEIVED') && (
                          <button
                            type="button"
                            onClick={() => openReceive(po)}
                            className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                          >
                            <PackageCheck className="w-3.5 h-3.5" /> Receive Goods
                          </button>
                        )}

                        {canCancel && (
                          <button
                            type="button"
                            onClick={() => {
                              setErr('');
                              setCancelReason('');
                              setCancelPoTarget(po);
                            }}
                            className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
                          >
                            <XCircle className="w-3.5 h-3.5" /> Cancel
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {subTab === 'suppliers' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-700">Active Suppliers ({data.suppliers.length})</span>
              <button
                type="button"
                onClick={() => openAddSupplierModal('tab')}
                className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-slate-800 whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" /> Add Supplier
              </button>
            </div>
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-100 text-slate-500">
                <tr>
                  <th className="p-3 font-medium">Supplier</th>
                  <th className="p-3 font-medium">Contact</th>
                  <th className="p-3 font-medium text-right">Terms</th>
                  <th className="p-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.suppliers.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="p-6 text-center text-xs text-slate-400">
                      No active suppliers yet. Click &ldquo;Add Supplier&rdquo; to register one.
                    </td>
                  </tr>
                ) : (
                  data.suppliers.map((s: any) => (
                    <tr key={s.id}>
                      <td className="p-3 font-semibold text-slate-900">
                        {s.name}
                        <p className="font-normal text-slate-500 font-mono text-[11px]">{[s.code, s.tin].filter(Boolean).join(' · ') || '—'}</p>
                      </td>
                      <td className="p-3 text-slate-600">{s.contact_person || '—'}<p className="text-[11px]">{s.phone || ''}</p></td>
                      <td className="p-3 text-right font-mono whitespace-nowrap">{s.payment_terms} days</td>
                      <td className="p-3 text-right whitespace-nowrap space-x-1">
                        <button
                          type="button"
                          onClick={() => openEditSupplierModal(s, 'tab')}
                          className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                        >
                          <Pencil className="w-3 h-3" /> Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteSupplierTarget(s)}
                          className="inline-flex items-center gap-1 rounded border border-red-200 px-2 py-1 text-[11px] font-medium text-red-700 hover:bg-red-50"
                        >
                          <Trash2 className="w-3 h-3" /> Delete
                        </button>
                      </td>
                    </tr>
                  ))
                )}
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
              {visibleInvoices.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-xs text-slate-400">
                    No supplier invoices match the selected truck / location.
                  </td>
                </tr>
              ) : visibleInvoices.map((inv: any) => {
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
                    <td className="p-3 text-right whitespace-nowrap">
                      <div className="inline-flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => setViewInvoice(inv)}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                        >
                          <Eye className="w-3.5 h-3.5" /> View / Print
                        </button>
                        {inv.status !== 'PAID' && (
                          <button
                            type="button"
                            onClick={() => payInvoice(inv)}
                            className="rounded-md bg-slate-900 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                          >
                            Settle Balance
                          </button>
                        )}
                      </div>
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
                <div key={it.id} className="grid grid-cols-1 sm:grid-cols-5 gap-2.5 items-end border border-slate-200 rounded-lg p-3">
                  <div className="sm:col-span-2">
                    <p className="text-xs font-semibold text-slate-900">{it.item_name}</p>
                    <p className="text-[11px] text-slate-500">Ordered: {formatNum(it.ordered_qty, 0)} {it.uom_code}</p>
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">Received Qty</label>
                    <input
                      type="number"
                      placeholder="Recv Qty"
                      value={recvMap[it.id]?.qty || ''}
                      onChange={(e) => setRecvMap((m) => ({ ...m, [it.id]: { ...m[it.id], qty: e.target.value } }))}
                      className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">Batch / Lot #</label>
                    <input
                      type="text"
                      placeholder="Lot #"
                      value={recvMap[it.id]?.batch || ''}
                      onChange={(e) => setRecvMap((m) => ({ ...m, [it.id]: { ...m[it.id], batch: e.target.value } }))}
                      className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">Expiry Date</label>
                    <input
                      type="date"
                      value={recvMap[it.id]?.expiry || ''}
                      onChange={(e) => setRecvMap((m) => ({ ...m, [it.id]: { ...m[it.id], expiry: e.target.value } }))}
                      className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-mono"
                    />
                  </div>
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

      {/* New Purchase Order Modal */}
      {showNewPo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form onSubmit={createPO} className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-xl bg-white p-5 space-y-4 border border-slate-200">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900">New Purchase Order</h3>
                <p className="text-xs text-slate-500">Create a supplier order for manager review and approval</p>
              </div>
              <button
                type="button"
                onClick={() => setShowNewPo(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <label className="block text-xs font-medium text-slate-600">Supplier</label>
                  <div className="inline-flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => openAddSupplierModal('newPo')}
                      className="inline-flex items-center gap-0.5 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                      title="Add new supplier"
                    >
                      <Plus className="w-3 h-3" /> Add
                    </button>
                    <button
                      type="button"
                      disabled={!poForm.supplierId}
                      onClick={() => {
                        const sel = data.suppliers.find((s: any) => s.id === poForm.supplierId);
                        if (sel) openEditSupplierModal(sel, 'newPo');
                      }}
                      className="inline-flex items-center gap-0.5 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40"
                      title="Edit selected supplier"
                    >
                      <Pencil className="w-3 h-3" /> Edit
                    </button>
                    <button
                      type="button"
                      disabled={!poForm.supplierId}
                      onClick={() => {
                        const sel = data.suppliers.find((s: any) => s.id === poForm.supplierId);
                        if (sel) setDeleteSupplierTarget(sel);
                      }}
                      className="inline-flex items-center gap-0.5 rounded border border-red-200 bg-red-50/60 px-1.5 py-0.5 text-[11px] font-medium text-red-700 hover:bg-red-100 disabled:opacity-40"
                      title="Delete selected supplier"
                    >
                      <Trash2 className="w-3 h-3" /> Delete
                    </button>
                  </div>
                </div>
                <select
                  required
                  value={poForm.supplierId}
                  onChange={(e) => setPoForm({ ...poForm, supplierId: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
                >
                  {data.suppliers.length === 0 ? (
                    <option value="">No suppliers available — click Add</option>
                  ) : (
                    data.suppliers.map((s: any) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))
                  )}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Delivery Location</label>
                <select
                  value={poForm.locationId}
                  onChange={(e) => setPoForm({ ...poForm, locationId: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
                >
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Expected Delivery Date (optional)</label>
                <input
                  type="date"
                  value={poForm.expectedAt}
                  onChange={(e) => setPoForm({ ...poForm, expectedAt: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Order Notes (optional)</label>
                <input
                  type="text"
                  placeholder="e.g. Morning commissary delivery"
                  value={poForm.notes}
                  onChange={(e) => setPoForm({ ...poForm, notes: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
                />
              </div>
            </div>

            <div className="space-y-2.5 border-t border-slate-100 pt-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-700">Order Line Items</span>
                <button
                  type="button"
                  onClick={() => {
                    const first = invItems[0];
                    setPoForm((f) => ({
                      ...f,
                      items: [
                        ...f.items,
                        {
                          inventoryItemId: first?.id || '',
                          orderedQty: '50',
                          unitCost: String(first?.last_unit_cost ?? 0),
                        },
                      ],
                    }));
                  }}
                  className="text-xs font-medium text-slate-900 hover:underline"
                >
                  + Add Line Item
                </button>
              </div>

              {poForm.items.map((line, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2 items-end rounded-lg border border-slate-200 bg-slate-50/60 p-2.5">
                  <div className="col-span-12 sm:col-span-5">
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">Ingredient / Item</label>
                    <select
                      value={line.inventoryItemId}
                      onChange={(e) => {
                        const nextItem = invItems.find((x) => x.id === e.target.value);
                        setPoForm((f) => ({
                          ...f,
                          items: f.items.map((x, i) =>
                            i === idx
                              ? {
                                  ...x,
                                  inventoryItemId: e.target.value,
                                  unitCost: nextItem ? String(nextItem.last_unit_cost ?? x.unitCost) : x.unitCost,
                                }
                              : x,
                          ),
                        }));
                      }}
                      className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs"
                    >
                      {invItems.map((i) => (
                        <option key={i.id} value={i.id}>{i.name} ({i.uom_code})</option>
                      ))}
                    </select>
                  </div>
                  <div className="col-span-5 sm:col-span-3">
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">Order Quantity</label>
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      required
                      placeholder="Qty"
                      value={line.orderedQty}
                      onChange={(e) =>
                        setPoForm((f) => ({
                          ...f,
                          items: f.items.map((x, i) => (i === idx ? { ...x, orderedQty: e.target.value } : x)),
                        }))
                      }
                      className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-mono"
                    />
                  </div>
                  <div className="col-span-5 sm:col-span-3">
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">Unit Cost (PHP)</label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      required
                      placeholder="Unit Cost"
                      value={line.unitCost}
                      onChange={(e) =>
                        setPoForm((f) => ({
                          ...f,
                          items: f.items.map((x, i) => (i === idx ? { ...x, unitCost: e.target.value } : x)),
                        }))
                      }
                      className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-mono"
                    />
                  </div>
                  <div className="col-span-2 sm:col-span-1 flex justify-end pb-1.5">
                    {poForm.items.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          setPoForm((f) => ({ ...f, items: f.items.filter((_, i) => i !== idx) }))
                        }
                        className="p-1.5 text-slate-400 hover:text-red-600"
                        title="Remove line item"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              ))}

              <div className="flex items-center justify-between pt-1 text-xs">
                <span className="text-slate-500">Estimated Order Total</span>
                <span className="font-mono tabular-nums text-sm font-bold text-slate-900">{formatPHP(newPoTotal)}</span>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button type="button" onClick={() => setShowNewPo(false)} className="px-4 py-2 rounded-lg border text-xs">Cancel</button>
              <button type="submit" className="px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800">
                Submit for Approval
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Edit / Review Purchase Order Modal */}
      {reviewPo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveReviewPo(false);
            }}
            className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl bg-white p-5 space-y-4 border border-slate-200"
          >
            <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-3">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900">
                  {reviewEditable ? `Edit / Review Purchase Order — ${reviewPo.po_number}` : `Review Purchase Order — ${reviewPo.po_number}`}
                </h3>
                <p className="text-xs text-slate-500">
                  Status: <span className={`font-semibold ${getStatusClass(reviewPo.status)}`}>{reviewPo.status}</span>
                  {reviewPo.ordered_at ? ` · Ordered ${String(reviewPo.ordered_at).slice(0, 10)}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setReviewPo(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {err && <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">{err}</div>}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <label className="block text-xs font-medium text-slate-600">Supplier</label>
                  {reviewEditable && (
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => openAddSupplierModal('reviewPo')}
                        className="inline-flex items-center gap-0.5 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                        title="Add new supplier"
                      >
                        <Plus className="w-3 h-3" /> Add
                      </button>
                      <button
                        type="button"
                        disabled={!reviewForm.supplierId}
                        onClick={() => {
                          const sel = data.suppliers.find((s: any) => s.id === reviewForm.supplierId);
                          if (sel) openEditSupplierModal(sel, 'reviewPo');
                        }}
                        className="inline-flex items-center gap-0.5 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40"
                        title="Edit selected supplier"
                      >
                        <Pencil className="w-3 h-3" /> Edit
                      </button>
                      <button
                        type="button"
                        disabled={!reviewForm.supplierId}
                        onClick={() => {
                          const sel = data.suppliers.find((s: any) => s.id === reviewForm.supplierId);
                          if (sel) setDeleteSupplierTarget(sel);
                        }}
                        className="inline-flex items-center gap-0.5 rounded border border-red-200 bg-red-50/60 px-1.5 py-0.5 text-[11px] font-medium text-red-700 hover:bg-red-100 disabled:opacity-40"
                        title="Delete selected supplier"
                      >
                        <Trash2 className="w-3 h-3" /> Delete
                      </button>
                    </div>
                  )}
                </div>
                <select
                  disabled={!reviewEditable}
                  value={reviewForm.supplierId}
                  onChange={(e) => setReviewForm({ ...reviewForm, supplierId: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs disabled:bg-slate-50 disabled:text-slate-600"
                >
                  {data.suppliers.map((s: any) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Delivery Location</label>
                <select
                  disabled={!reviewEditable}
                  value={reviewForm.locationId}
                  onChange={(e) => setReviewForm({ ...reviewForm, locationId: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs disabled:bg-slate-50 disabled:text-slate-600"
                >
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Expected Delivery Date</label>
                <input
                  type="date"
                  disabled={!reviewEditable}
                  value={reviewForm.expectedAt}
                  onChange={(e) => setReviewForm({ ...reviewForm, expectedAt: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono disabled:bg-slate-50 disabled:text-slate-600"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Order / Review Notes</label>
                <input
                  type="text"
                  disabled={!reviewEditable}
                  placeholder={reviewEditable ? 'Review remarks or delivery instructions' : 'No notes recorded'}
                  value={reviewForm.notes}
                  onChange={(e) => setReviewForm({ ...reviewForm, notes: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs disabled:bg-slate-50 disabled:text-slate-600"
                />
              </div>
            </div>

            <div className="space-y-2.5 border-t border-slate-100 pt-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-700">Order Line Items</span>
                {reviewEditable && (
                  <button
                    type="button"
                    onClick={() => {
                      const first = invItems[0];
                      setReviewForm((f) => ({
                        ...f,
                        items: [
                          ...f.items,
                          {
                            inventoryItemId: first?.id || '',
                            orderedQty: '50',
                            unitCost: String(first?.last_unit_cost ?? 0),
                          },
                        ],
                      }));
                    }}
                    className="text-xs font-medium text-slate-900 hover:underline"
                  >
                    + Add Line Item
                  </button>
                )}
              </div>

              {reviewEditable ? (
                reviewForm.items.map((line, idx) => {
                  const lineTotal = (Number(line.orderedQty) || 0) * (Number(line.unitCost) || 0);
                  return (
                    <div key={idx} className="grid grid-cols-12 gap-2 items-end rounded-lg border border-slate-200 bg-slate-50/60 p-2.5">
                      <div className="col-span-12 sm:col-span-4">
                        <label className="block text-[11px] font-medium text-slate-600 mb-1">Ingredient / Item</label>
                        <select
                          value={line.inventoryItemId}
                          onChange={(e) => {
                            const nextItem = invItems.find((x) => x.id === e.target.value);
                            setReviewForm((f) => ({
                              ...f,
                              items: f.items.map((x, i) =>
                                i === idx
                                  ? {
                                      ...x,
                                      inventoryItemId: e.target.value,
                                      unitCost: nextItem ? String(nextItem.last_unit_cost ?? x.unitCost) : x.unitCost,
                                    }
                                  : x,
                              ),
                            }));
                          }}
                          className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs"
                        >
                          {invItems.map((i) => (
                            <option key={i.id} value={i.id}>{i.name} ({i.uom_code})</option>
                          ))}
                        </select>
                      </div>
                      <div className="col-span-4 sm:col-span-3">
                        <label className="block text-[11px] font-medium text-slate-600 mb-1">Order Qty</label>
                        <input
                          type="number"
                          min="0.01"
                          step="0.01"
                          required
                          value={line.orderedQty}
                          onChange={(e) =>
                            setReviewForm((f) => ({
                              ...f,
                              items: f.items.map((x, i) => (i === idx ? { ...x, orderedQty: e.target.value } : x)),
                            }))
                          }
                          className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-mono"
                        />
                      </div>
                      <div className="col-span-4 sm:col-span-2">
                        <label className="block text-[11px] font-medium text-slate-600 mb-1">Unit Cost</label>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          required
                          value={line.unitCost}
                          onChange={(e) =>
                            setReviewForm((f) => ({
                              ...f,
                              items: f.items.map((x, i) => (i === idx ? { ...x, unitCost: e.target.value } : x)),
                            }))
                          }
                          className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-mono"
                        />
                      </div>
                      <div className="col-span-3 sm:col-span-2 text-right pb-2">
                        <span className="block text-[10px] text-slate-400">Subtotal</span>
                        <span className="font-mono text-xs font-semibold text-slate-900">{formatPHP(lineTotal)}</span>
                      </div>
                      <div className="col-span-1 flex justify-end pb-1.5">
                        {reviewForm.items.length > 1 && (
                          <button
                            type="button"
                            onClick={() =>
                              setReviewForm((f) => ({ ...f, items: f.items.filter((_, i) => i !== idx) }))
                            }
                            className="p-1.5 text-slate-400 hover:text-red-600"
                            title="Remove line item"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="rounded-lg border border-slate-200 overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                      <tr>
                        <th className="p-2.5 font-medium">Ingredient / Item</th>
                        <th className="p-2.5 font-medium text-right">Ordered</th>
                        <th className="p-2.5 font-medium text-right">Received</th>
                        <th className="p-2.5 font-medium text-right">Unit Cost</th>
                        <th className="p-2.5 font-medium text-right">Subtotal</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {(reviewPo.items || []).map((pi: any) => (
                        <tr key={pi.id}>
                          <td className="p-2.5 font-medium text-slate-900">{pi.item_name}</td>
                          <td className="p-2.5 text-right font-mono">{formatNum(pi.ordered_qty, 2)} {pi.uom_code}</td>
                          <td className="p-2.5 text-right font-mono">{formatNum(pi.received_qty, 2)} {pi.uom_code}</td>
                          <td className="p-2.5 text-right font-mono">{formatPHP(pi.unit_cost)}</td>
                          <td className="p-2.5 text-right font-mono font-semibold">{formatPHP(Number(pi.ordered_qty) * Number(pi.unit_cost))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="flex items-center justify-between pt-1 text-xs">
                <span className="text-slate-500">Total Purchase Order Amount</span>
                <span className="font-mono tabular-nums text-base font-bold text-slate-900">
                  {formatPHP(reviewEditable ? reviewPoTotal : reviewPo.total_amount)}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-slate-100">
              <div>
                {reviewCanCancel && (
                  <button
                    type="button"
                    onClick={() => {
                      setErr('');
                      setCancelReason('');
                      setCancelPoTarget(reviewPo);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-2 text-xs font-medium text-red-700 hover:bg-red-50"
                  >
                    <XCircle className="w-3.5 h-3.5" /> Cancel PO
                  </button>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setReviewPo(null)}
                  className="px-4 py-2 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  Close
                </button>
                {reviewEditable && (
                  <>
                    <button
                      type="submit"
                      disabled={savingReview}
                      className="px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"
                    >
                      {savingReview ? 'Saving...' : 'Save Changes'}
                    </button>
                    {canApprove && (
                      <button
                        type="button"
                        disabled={savingReview}
                        onClick={() => saveReviewPo(true)}
                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-50"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        {savingReview ? 'Approving...' : 'Save & Approve'}
                      </button>
                    )}
                  </>
                )}
                {(reviewPo.status === 'APPROVED' || reviewPo.status === 'PARTIAL' || reviewPo.status === 'PARTIALLY_RECEIVED') && (
                  <button
                    type="button"
                    onClick={() => {
                      const target = reviewPo;
                      setReviewPo(null);
                      openReceive(target);
                    }}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700"
                  >
                    <PackageCheck className="w-3.5 h-3.5" /> Receive Goods
                  </button>
                )}
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Cancel Purchase Order Confirmation Modal */}
      {cancelPoTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form onSubmit={confirmCancelPO} className="w-full max-w-md rounded-xl bg-white p-5 space-y-4 border border-slate-200">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900">
                  Cancel Purchase Order {cancelPoTarget.po_number}?
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {cancelPoTarget.supplier_name} · {formatPHP(cancelPoTarget.total_amount)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setCancelPoTarget(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-600">
              Cancelling this order will mark it as <span className="font-semibold text-red-600">CANCELLED</span> and prevent goods receiving or supplier billing against it.
            </p>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Cancellation Reason (optional)</label>
              <input
                type="text"
                placeholder="e.g. Supplier out of stock or revised quantity"
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setCancelPoTarget(null)}
                className="px-4 py-2 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Keep PO
              </button>
              <button
                type="submit"
                disabled={cancellingPo}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-600 text-white text-xs font-semibold hover:bg-red-700 disabled:opacity-50"
              >
                <XCircle className="w-3.5 h-3.5" />
                {cancellingPo ? 'Cancelling...' : 'Confirm Cancel PO'}
              </button>
            </div>
          </form>
        </div>
      )}
      </div>

      {/* View / Print Supplier Invoice Modal */}
      {viewInvoice && (() => {
        const balance = Math.max(0, Number(viewInvoice.total_amount || 0) - Number(viewInvoice.paid_amount || 0));
        const invItemsList = Array.isArray(viewInvoice.items) ? viewInvoice.items : [];
        const invPayments = Array.isArray(viewInvoice.payments) ? viewInvoice.payments : [];
        const statusColor =
          viewInvoice.status === 'PAID'
            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
            : viewInvoice.status === 'PARTIAL'
            ? 'bg-blue-50 text-blue-700 border-blue-200'
            : 'bg-amber-50 text-amber-700 border-amber-200';

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 overflow-y-auto print:static print:bg-transparent print:p-0 print:block">
            <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl bg-white p-6 space-y-5 border border-slate-200 print:max-h-none print:overflow-visible print:border-0 print:shadow-none print:mx-auto print:max-w-full">
              {/* Header */}
              <div className="flex items-start justify-between gap-4 border-b border-slate-200 pb-4">
                <div className="flex items-center gap-3">
                  <img
                    src="/assets/aistudio/Logo_836b4628.png"
                    alt="Maximus Barbecue Logo"
                    referrerPolicy="no-referrer"
                    className="w-11 h-11 rounded-full object-contain border border-slate-100"
                  />
                  <div>
                    <h3 className="font-display text-lg font-bold text-slate-900">Maximus Barbecue ERP</h3>
                    <p className="text-xs text-slate-500">Supplier Invoice &amp; Accounts Payable Voucher</p>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <div className="text-right">
                    <p className="font-mono text-sm font-bold text-slate-900">{viewInvoice.invoice_number}</p>
                    <span className={`inline-block mt-1 px-2 py-0.5 rounded border text-[11px] font-semibold ${statusColor}`}>
                      {viewInvoice.status}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setViewInvoice(null)}
                    className="no-print p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Supplier & Invoice Metadata */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 space-y-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Supplier (Bill From)</p>
                  <p className="text-sm font-semibold text-slate-900">{viewInvoice.supplier_name}</p>
                  {viewInvoice.supplier_code && <p className="font-mono text-slate-600">Code: {viewInvoice.supplier_code}</p>}
                  {viewInvoice.supplier_tin && <p className="font-mono text-slate-600">TIN: {viewInvoice.supplier_tin}</p>}
                  {viewInvoice.supplier_contact && <p className="text-slate-600">Contact: {viewInvoice.supplier_contact}</p>}
                  {(viewInvoice.supplier_phone || viewInvoice.supplier_email) && (
                    <p className="text-slate-600">
                      {[viewInvoice.supplier_phone, viewInvoice.supplier_email].filter(Boolean).join(' · ')}
                    </p>
                  )}
                  {viewInvoice.supplier_address && <p className="text-slate-500">{viewInvoice.supplier_address}</p>}
                </div>

                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 space-y-1.5">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Voucher Reference</p>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Invoice Date</span>
                    <span className="font-mono font-medium text-slate-900">
                      {viewInvoice.created_at ? String(viewInvoice.created_at).slice(0, 10) : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Due Date</span>
                    <span className="font-mono font-semibold text-slate-900">{String(viewInvoice.due_date || '').slice(0, 10)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Linked PO #</span>
                    <span className="font-mono text-slate-900">{viewInvoice.po_number || 'Direct / Opening AP'}</span>
                  </div>
                  {viewInvoice.grn_number && (
                    <div className="flex justify-between">
                      <span className="text-slate-500">GRN Reference</span>
                      <span className="font-mono text-slate-900">{viewInvoice.grn_number}</span>
                    </div>
                  )}
                  {viewInvoice.location_name && (
                    <div className="flex justify-between">
                      <span className="text-slate-500">Receiving Location</span>
                      <span className="text-slate-900">{viewInvoice.location_name}</span>
                    </div>
                  )}
                  {Number(viewInvoice.payment_terms || 0) > 0 && (
                    <div className="flex justify-between">
                      <span className="text-slate-500">Payment Terms</span>
                      <span className="font-mono text-slate-900">Net {viewInvoice.payment_terms} days</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Line Items */}
              <div className="space-y-2">
                <p className="text-xs font-semibold text-slate-700">Billed Line Items</p>
                {invItemsList.length > 0 ? (
                  <div className="rounded-lg border border-slate-200 overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                        <tr>
                          <th className="p-2.5 font-medium">Item</th>
                          <th className="p-2.5 font-medium">Batch / Lot</th>
                          <th className="p-2.5 font-medium text-right">Qty</th>
                          <th className="p-2.5 font-medium text-right">Unit Cost</th>
                          <th className="p-2.5 font-medium text-right">Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {invItemsList.map((it: any, idx: number) => (
                          <tr key={it.id || idx}>
                            <td className="p-2.5 font-medium text-slate-900">{it.item_name}</td>
                            <td className="p-2.5 font-mono text-slate-500">{it.batch_number || '—'}</td>
                            <td className="p-2.5 text-right font-mono tabular-nums">
                              {formatNum(it.quantity, 2)} {it.uom_code}
                            </td>
                            <td className="p-2.5 text-right font-mono tabular-nums">{formatPHP(it.unit_cost)}</td>
                            <td className="p-2.5 text-right font-mono tabular-nums font-semibold text-slate-900">
                              {formatPHP(it.line_total)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                    Summary supplier billing voucher for <span className="font-semibold text-slate-800">{viewInvoice.supplier_name}</span> (no linked PO line breakdown).
                  </div>
                )}
              </div>

              {/* AP Financial Summary */}
              <div className="flex justify-end">
                <div className="w-full sm:w-72 rounded-lg border border-slate-200 bg-slate-50 p-3.5 space-y-1.5 text-xs">
                  <div className="flex justify-between text-slate-600">
                    <span>Invoice Total</span>
                    <span className="font-mono tabular-nums font-semibold text-slate-900">{formatPHP(viewInvoice.total_amount)}</span>
                  </div>
                  <div className="flex justify-between text-slate-600">
                    <span>Amount Paid</span>
                    <span className="font-mono tabular-nums font-medium text-emerald-700">-{formatPHP(viewInvoice.paid_amount)}</span>
                  </div>
                  <div className="border-t border-slate-200 pt-1.5 flex justify-between text-sm font-bold text-slate-900">
                    <span>Balance Due</span>
                    <span className={`font-mono tabular-nums ${balance > 0 ? 'text-red-700' : 'text-emerald-700'}`}>
                      {formatPHP(balance)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Payment History */}
              <div className="space-y-2">
                <p className="text-xs font-semibold text-slate-700">Payment History</p>
                {invPayments.length > 0 ? (
                  <div className="rounded-lg border border-slate-200 overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                        <tr>
                          <th className="p-2.5 font-medium">Payment #</th>
                          <th className="p-2.5 font-medium">Date</th>
                          <th className="p-2.5 font-medium">Method</th>
                          <th className="p-2.5 font-medium">Reference</th>
                          <th className="p-2.5 font-medium text-right">Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {invPayments.map((pmt: any, idx: number) => (
                          <tr key={pmt.id || idx}>
                            <td className="p-2.5 font-mono font-semibold text-slate-900">{pmt.payment_number || '—'}</td>
                            <td className="p-2.5 font-mono text-slate-500">{pmt.paid_at ? String(pmt.paid_at).slice(0, 10) : '—'}</td>
                            <td className="p-2.5 text-slate-700">{pmt.method}</td>
                            <td className="p-2.5 font-mono text-slate-600">{pmt.reference_no || '—'}</td>
                            <td className="p-2.5 text-right font-mono tabular-nums font-semibold text-emerald-700">
                              {formatPHP(pmt.amount)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : Number(viewInvoice.paid_amount || 0) > 0 ? (
                  <p className="text-xs text-slate-500">
                    Initial partial payment of {formatPHP(viewInvoice.paid_amount)} recorded prior to detailed payment log.
                  </p>
                ) : (
                  <p className="text-xs text-slate-500">No payments recorded yet.</p>
                )}
              </div>

              {/* Print Signature Lines */}
              <div className="hidden print:grid grid-cols-3 gap-6 pt-8 text-xs text-slate-600">
                <div className="border-t border-slate-400 pt-1.5 text-center">Prepared By</div>
                <div className="border-t border-slate-400 pt-1.5 text-center">Verified / Approved By</div>
                <div className="border-t border-slate-400 pt-1.5 text-center">Received By (Supplier)</div>
              </div>

              {/* Footer Actions */}
              <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-3 no-print">
                <button
                  type="button"
                  onClick={() => setViewInvoice(null)}
                  className="px-4 py-2 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  Close
                </button>
                {viewInvoice.status !== 'PAID' && (
                  <button
                    type="button"
                    onClick={() => payInvoice(viewInvoice)}
                    className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700"
                  >
                    Settle Balance
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800"
                >
                  <Printer className="w-3.5 h-3.5" /> Print / Save PDF
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Add / Edit Supplier Modal */}
      {supplierModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4">
          <form
            onSubmit={handleSaveSupplier}
            className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl bg-white p-5 space-y-4 border border-slate-200 shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900">
                  {supplierModal === 'add' ? 'Add Supplier' : 'Edit Supplier'}
                </h3>
                <p className="text-xs text-slate-500">Manage supplier profile, contact info, and payment terms</p>
              </div>
              <button
                type="button"
                onClick={() => setSupplierModal(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {supplierModalErr && (
              <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">
                {supplierModalErr}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block font-medium text-slate-600 mb-1">Supplier Code *</label>
                <input
                  required
                  placeholder="e.g. SUP-004"
                  value={supplierForm.code}
                  onChange={(e) => setSupplierForm({ ...supplierForm, code: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-600 mb-1">Payment Terms (Days)</label>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={supplierForm.paymentTerms}
                  onChange={(e) => setSupplierForm({ ...supplierForm, paymentTerms: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block font-medium text-slate-600 mb-1">Supplier Name *</label>
                <input
                  required
                  placeholder="e.g. Prime Grill Poultry & Meat Corp."
                  value={supplierForm.name}
                  onChange={(e) => setSupplierForm({ ...supplierForm, name: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-600 mb-1">Contact Person</label>
                <input
                  placeholder="e.g. Maria Santos"
                  value={supplierForm.contactPerson}
                  onChange={(e) => setSupplierForm({ ...supplierForm, contactPerson: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-600 mb-1">Phone</label>
                <input
                  placeholder="e.g. +63 917 555 0199"
                  value={supplierForm.phone}
                  onChange={(e) => setSupplierForm({ ...supplierForm, phone: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-600 mb-1">Email</label>
                <input
                  type="email"
                  placeholder="orders@supplier.ph"
                  value={supplierForm.email}
                  onChange={(e) => setSupplierForm({ ...supplierForm, email: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-600 mb-1">TIN</label>
                <input
                  placeholder="000-000-000-000"
                  value={supplierForm.tin}
                  onChange={(e) => setSupplierForm({ ...supplierForm, tin: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block font-medium text-slate-600 mb-1">Business Address</label>
                <input
                  placeholder="Warehouse / pickup address"
                  value={supplierForm.address}
                  onChange={(e) => setSupplierForm({ ...supplierForm, address: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setSupplierModal(null)}
                className="px-4 py-2 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingSupplier}
                className="px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-50"
              >
                {savingSupplier ? 'Saving...' : supplierModal === 'add' ? 'Save Supplier' : 'Update Supplier'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Delete Supplier Confirmation Modal */}
      {deleteSupplierTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-5 space-y-4 border border-slate-200 shadow-xl">
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Delete {deleteSupplierTarget.name}?
              </h3>
              <button
                type="button"
                onClick={() => setDeleteSupplierTarget(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-600">
              This will remove <span className="font-semibold text-slate-900">{deleteSupplierTarget.name}</span> from active suppliers. If purchase orders or supplier invoices reference this supplier, it will be archived safely to preserve historical records.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteSupplierTarget(null)}
                className="px-4 py-2 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deletingSupplier}
                onClick={handleDeleteSupplier}
                className="px-4 py-2 rounded-lg bg-red-600 text-white text-xs font-semibold hover:bg-red-700 disabled:opacity-50"
              >
                {deletingSupplier ? 'Removing...' : 'Confirm Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
