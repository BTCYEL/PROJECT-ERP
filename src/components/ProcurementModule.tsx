import React, { useEffect, useRef, useState } from 'react';
import {
  Plus,
  CheckCircle2,
  PackageCheck,
  Pencil,
  XCircle,
  Eye,
  Printer,
  Trash2,
  X,
  History,
  User,
  PenTool,
  ShieldCheck,
  SlidersHorizontal,
  RotateCcw,
} from 'lucide-react';
import { apiFetch, formatNum, formatPHP } from '../lib/api.ts';
import { AuthUser, LocationRow, PERMISSIONS } from '../types/erp.ts';

interface Props {
  user: AuthUser;
  locations: LocationRow[];
  activeLocationId?: string;
  quickAction?: { action: string; nonce: number } | null;
  onQuickActionHandled?: () => void;
}

interface PoLineDraft {
  id?: string;
  inventoryItemId: string;
  orderedQty: string;
  unitCost: string;
}

export function ProcurementModule({ user, locations, activeLocationId = 'ALL', quickAction, onQuickActionHandled }: Props) {
  const [subTab, setSubTab] = useState<'pos' | 'suppliers' | 'payables'>('pos');
  const [data, setData] = useState<any>({ approvalThreshold: 10000, suppliers: [], supplierAuditLogs: [], priceComparison: [], purchaseOrders: [], invoices: [] });
  const [invItems, setInvItems] = useState<any[]>([]);
  const [receivingPo, setReceivingPo] = useState<any>(null);
  const [recvMap, setRecvMap] = useState<Record<string, { qty: string; batch: string; expiry: string; notes: string }>>({});

  const [poStatusFilter, setPoStatusFilter] = useState<'ALL' | 'DRAFT' | 'PENDING_APPROVAL' | 'PENDING_MANAGER_SIGNATURE' | 'APPROVED' | 'PARTIAL' | 'RECEIVED' | 'PAID' | 'CANCELLED'>('ALL');

  // Configurable Approval Threshold Modal
  const [showThresholdModal, setShowThresholdModal] = useState(false);
  const [thresholdInput, setThresholdInput] = useState('10000');
  const [thresholdErr, setThresholdErr] = useState('');
  const [savingThreshold, setSavingThreshold] = useState(false);

  // Stage 2 Manager Digital Signature Modal
  const [signaturePo, setSignaturePo] = useState<any>(null);
  const [signerName, setSignerName] = useState(user.fullName || '');
  const [signatureErr, setSignatureErr] = useState('');
  const [submittingSignature, setSubmittingSignature] = useState(false);
  const [hasSignatureStroke, setHasSignatureStroke] = useState(false);
  const [isDrawingSignature, setIsDrawingSignature] = useState(false);
  const sigCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Create PO Modal
  const [showNewPo, setShowNewPo] = useState(false);
  const [poForm, setPoForm] = useState<{
    supplierId: string;
    locationId: string;
    status: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED';
    expectedAt: string;
    notes: string;
    items: PoLineDraft[];
  }>({
    supplierId: '',
    locationId: 'loc_commissary',
    status: 'PENDING_APPROVAL',
    expectedAt: '',
    notes: '',
    items: [{ inventoryItemId: '', orderedQty: '100', unitCost: '14' }],
  });

  // Review / Edit PO Modal
  const [reviewPo, setReviewPo] = useState<any>(null);
  const [reviewForm, setReviewForm] = useState<{
    supplierId: string;
    locationId: string;
    status: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED';
    expectedAt: string;
    notes: string;
    items: PoLineDraft[];
  }>({
    supplierId: '',
    locationId: '',
    status: 'PENDING_APPROVAL',
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
  const [auditSupplierTarget, setAuditSupplierTarget] = useState<any>(null);
  const [auditFilterSupplierId, setAuditFilterSupplierId] = useState<string>('ALL');

  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const canApprove =
    user.roleCode === 'SUPER_ADMIN' ||
    user.roleCode === 'BUSINESS_OWNER' ||
    user.permissions.includes(PERMISSIONS.PO_APPROVE);

  const canMarkPaid =
    user.roleCode === 'SUPER_ADMIN' ||
    user.roleCode === 'BUSINESS_OWNER' ||
    user.permissions.includes(PERMISSIONS.FINANCE_VIEW) ||
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

  useEffect(() => {
    if (!quickAction) return;
    if (quickAction.action === 'new-po') {
      setSubTab('pos');
      openNewPoModal();
      onQuickActionHandled?.();
    }
  }, [quickAction]);

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
      status: 'PENDING_APPROVAL',
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
    const editableStatus: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' =
      po.status === 'DRAFT' ? 'DRAFT' : 'PENDING_APPROVAL';
    setReviewForm({
      supplierId: po.supplier_id || data.suppliers?.[0]?.id || '',
      locationId: po.location_id || locations[0]?.id || '',
      status: editableStatus,
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

  const approvalThreshold = Number.isFinite(Number(data.approvalThreshold)) ? Number(data.approvalThreshold) : 10000;

  const openThresholdModal = () => {
    setThresholdErr('');
    setThresholdInput(String(approvalThreshold));
    setShowThresholdModal(true);
  };

  const saveApprovalThreshold = async (e: React.FormEvent) => {
    e.preventDefault();
    setThresholdErr('');
    const parsed = Number(thresholdInput);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setThresholdErr('Please enter a valid non-negative threshold amount in PHP.');
      return;
    }
    setSavingThreshold(true);
    try {
      const res = await apiFetch<{ ok: boolean; approvalThreshold: number }>('/procurement/approval-config', {
        method: 'PUT',
        body: JSON.stringify({ approvalThreshold: parsed }),
      });
      setShowThresholdModal(false);
      setMsg(`Updated multi-stage signature threshold to ${formatPHP(res.approvalThreshold)}.`);
      await load();
    } catch (e: any) {
      setThresholdErr(e.message || 'Unable to update approval threshold');
    } finally {
      setSavingThreshold(false);
    }
  };

  const openSignatureModal = (po: any) => {
    setSignatureErr('');
    setSignerName(user.fullName || '');
    setHasSignatureStroke(false);
    setIsDrawingSignature(false);
    setSignaturePo(po);
    requestAnimationFrame(() => {
      const canvas = sigCanvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
      }
    });
  };

  const clearSignatureCanvas = () => {
    const canvas = sigCanvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
    setHasSignatureStroke(false);
    setSignatureErr('');
  };

  const getSignaturePoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = sigCanvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * canvas.width) / rect.width,
      y: ((e.clientY - rect.top) * canvas.height) / rect.height,
    };
  };

  const handleSigPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = sigCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const { x, y } = getSignaturePoint(e);
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 0.01, y + 0.01);
    ctx.stroke();
    setIsDrawingSignature(true);
    setHasSignatureStroke(true);
    setSignatureErr('');
  };

  const handleSigPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingSignature) return;
    const canvas = sigCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { x, y } = getSignaturePoint(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const handleSigPointerUp = () => {
    setIsDrawingSignature(false);
  };

  const submitManagerSignature = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signaturePo) return;
    setSignatureErr('');
    if (!signerName.trim()) {
      setSignatureErr('Please enter the signing manager’s full name.');
      return;
    }
    if (!hasSignatureStroke || !sigCanvasRef.current) {
      setSignatureErr('Please draw your digital signature on the signature pad before approving.');
      return;
    }
    setSubmittingSignature(true);
    try {
      const signatureData = sigCanvasRef.current.toDataURL('image/png');
      await apiFetch(`/procurement/purchase-orders/${signaturePo.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({
          signerName: signerName.trim(),
          signatureData,
        }),
      });
      const signedNo = signaturePo.po_number;
      setSignaturePo(null);
      setReviewPo((prev: any) => (prev?.id === signaturePo.id ? null : prev));
      setMsg(`Digitally signed and finalized approval for ${signedNo}. Ready for goods receiving.`);
      await load();
    } catch (e: any) {
      setSignatureErr(e.message || 'Unable to apply manager signature');
    } finally {
      setSubmittingSignature(false);
    }
  };

  const saveReviewPo = async (approveAfterSave: boolean) => {
    if (!reviewPo) return;
    setErr('');
    setSavingReview(true);
    const targetStatus = approveAfterSave ? 'APPROVED' : reviewForm.status;
    try {
      const res = await apiFetch<any>(`/procurement/purchase-orders/${reviewPo.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          supplierId: reviewForm.supplierId,
          locationId: reviewForm.locationId,
          status: targetStatus,
          expectedAt: reviewForm.expectedAt || null,
          notes: reviewForm.notes,
          approve: targetStatus === 'APPROVED',
          items: reviewForm.items.map((line) => ({
            id: line.id,
            inventoryItemId: line.inventoryItemId,
            orderedQty: Number(line.orderedQty),
            unitCost: Number(line.unitCost),
          })),
        }),
      });
      setReviewPo(null);
      const refreshed = await load();
      if (res.status === 'PENDING_MANAGER_SIGNATURE') {
        setMsg(
          `Stage 1 verified ${res.poNumber} (${formatPHP(res.totalAmount)}). Manager digital signature is now required.`,
        );
        const updatedPo = refreshed?.purchaseOrders?.find((p: any) => p.id === res.id);
        if (updatedPo && canApprove) {
          openSignatureModal(updatedPo);
        }
      } else {
        setMsg(
          res.status === 'APPROVED'
            ? `Reviewed and approved ${res.poNumber} (${formatPHP(res.totalAmount)}). Ready for goods receiving.`
            : res.status === 'DRAFT'
              ? `Saved ${res.poNumber} as Draft (${formatPHP(res.totalAmount)}).`
              : `Updated purchase order ${res.poNumber} (${formatPHP(res.totalAmount)}).`,
        );
      }
    } catch (e: any) {
      setErr(e.message || 'Unable to update purchase order');
    } finally {
      setSavingReview(false);
    }
  };

  const approvePO = async (po: any) => {
    setErr('');
    if (po.status === 'PENDING_MANAGER_SIGNATURE') {
      openSignatureModal(po);
      return;
    }
    try {
      const res = await apiFetch<any>(`/procurement/purchase-orders/${po.id}/approve`, { method: 'POST' });
      const refreshed = await load();
      if (res?.status === 'PENDING_MANAGER_SIGNATURE' || res?.requiresSignature) {
        setMsg(
          `Stage 1 approved ${po.po_number}. Order exceeds ${formatPHP(approvalThreshold)} — Stage 2 Manager Digital Signature required.`,
        );
        const updatedPo = refreshed?.purchaseOrders?.find((p: any) => p.id === po.id) || {
          ...po,
          status: 'PENDING_MANAGER_SIGNATURE',
          stage1_approved_by_name: user.fullName,
          stage1_approved_at: new Date().toISOString(),
        };
        openSignatureModal(updatedPo);
      } else {
        setMsg(`Purchase order ${po.po_number} approved and ready for goods receiving.`);
      }
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const markPoPaid = async (po: any) => {
    setErr('');
    try {
      await apiFetch(`/procurement/purchase-orders/${po.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'PAID' }),
      });
      setReviewPo((prev: any) => (prev?.id === po.id ? null : prev));
      setMsg(`Marked purchase order ${po.po_number} as Paid.`);
      await load();
    } catch (e: any) {
      setErr(e.message || 'Unable to mark purchase order as paid');
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
      const r = await apiFetch<any>('/procurement/purchase-orders', {
        method: 'POST',
        body: JSON.stringify({
          supplierId: poForm.supplierId,
          locationId: poForm.locationId,
          status: poForm.status,
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
      setMsg(
        poForm.status === 'DRAFT'
          ? `Saved ${r.poNumber} as Draft.`
          : poForm.status === 'APPROVED'
            ? `Created and approved ${r.poNumber}. Ready for goods receiving.`
            : `Created ${r.poNumber} awaiting manager approval.`,
      );
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

  const getPoStatusMeta = (status: string) => {
    switch (status) {
      case 'DRAFT':
        return {
          label: 'Draft',
          badgeClass: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-800',
          dotClass: 'bg-slate-400',
          textClass: 'text-slate-700 dark:text-slate-200',
        };
      case 'PENDING_APPROVAL':
        return {
          label: 'Pending',
          badgeClass: 'bg-amber-50 dark:bg-amber-950/45 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-700/80',
          dotClass: 'bg-amber-500',
          textClass: 'text-amber-700 dark:text-amber-300',
        };
      case 'PENDING_MANAGER_SIGNATURE':
        return {
          label: 'Pending Signature',
          badgeClass: 'bg-violet-50 dark:bg-violet-950/50 text-violet-800 dark:text-violet-300 border-violet-200 dark:border-violet-700/80',
          dotClass: 'bg-violet-600',
          textClass: 'text-violet-700 dark:text-violet-300',
        };
      case 'APPROVED':
        return {
          label: 'Approved',
          badgeClass: 'bg-sky-50 dark:bg-sky-950/50 text-sky-800 dark:text-sky-300 border-sky-200 dark:border-sky-700/80',
          dotClass: 'bg-sky-500',
          textClass: 'text-sky-700 dark:text-sky-300',
        };
      case 'PARTIAL':
      case 'PARTIALLY_RECEIVED':
        return {
          label: 'Partial',
          badgeClass: 'bg-indigo-50 dark:bg-indigo-950/50 text-indigo-800 dark:text-indigo-300 border-indigo-200 dark:border-indigo-700/80',
          dotClass: 'bg-indigo-500',
          textClass: 'text-indigo-700 dark:text-indigo-300',
        };
      case 'RECEIVED':
        return {
          label: 'Received',
          badgeClass: 'bg-emerald-50 dark:bg-emerald-950/45 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-700/80',
          dotClass: 'bg-emerald-500',
          textClass: 'text-emerald-700 dark:text-emerald-300',
        };
      case 'PAID':
        return {
          label: 'Paid',
          badgeClass: 'bg-teal-50 dark:bg-teal-950/50 text-teal-800 dark:text-teal-300 border-teal-200 dark:border-teal-700/80',
          dotClass: 'bg-teal-600',
          textClass: 'text-teal-700 dark:text-teal-300',
        };
      case 'CANCELLED':
        return {
          label: 'Cancelled',
          badgeClass: 'bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800/80',
          dotClass: 'bg-red-500',
          textClass: 'text-red-600 dark:text-red-300',
        };
      default:
        return {
          label: status || 'Unknown',
          badgeClass: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-800',
          dotClass: 'bg-slate-400',
          textClass: 'text-slate-700 dark:text-slate-200',
        };
    }
  };

  const renderPoStatusBadge = (status: string) => {
    const meta = getPoStatusMeta(status);
    return (
      <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${meta.badgeClass}`}>
        <span className={`w-1.5 h-1.5 rounded-xs ${meta.dotClass}`} />
        {meta.label}
      </span>
    );
  };

  const renderInvoiceStatusBadge = (status: string) => {
    const normalized = String(status || '').toUpperCase();
    const cls =
      normalized === 'PAID'
        ? 'bg-teal-50 dark:bg-teal-950/50 text-teal-800 dark:text-teal-300 border-teal-200 dark:border-teal-700/80'
        : normalized === 'PARTIAL'
          ? 'bg-indigo-50 dark:bg-indigo-950/50 text-indigo-800 dark:text-indigo-300 border-indigo-200 dark:border-indigo-700/80'
          : 'bg-amber-50 dark:bg-amber-950/45 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-700/80';
    const dot =
      normalized === 'PAID' ? 'bg-teal-600' : normalized === 'PARTIAL' ? 'bg-indigo-500' : 'bg-amber-500';
    return (
      <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${cls}`}>
        <span className={`w-1.5 h-1.5 rounded-xs ${dot}`} />
        {normalized === 'PAID' ? 'Paid' : normalized === 'PARTIAL' ? 'Partial' : 'Unpaid'}
      </span>
    );
  };

  const formatAuditTimestamp = (iso?: string | null) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16);
    return d.toLocaleString('en-PH', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  const renderSupplierAuditActionBadge = (action: string) => {
    const act = String(action || '').toUpperCase();
    const meta =
      act === 'CREATE_SUPPLIER'
        ? { label: 'Created', cls: 'bg-emerald-50 dark:bg-emerald-950/45 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-700/80', dot: 'bg-emerald-500' }
        : act === 'DELETE_SUPPLIER'
          ? { label: 'Removed / Archived', cls: 'bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800/80', dot: 'bg-red-500' }
          : { label: 'Updated', cls: 'bg-sky-50 dark:bg-sky-950/50 text-sky-800 dark:text-sky-300 border-sky-200 dark:border-sky-700/80', dot: 'bg-sky-500' };
    return (
      <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${meta.cls}`}>
        <span className={`w-1.5 h-1.5 rounded-xs ${meta.dot}`} />
        {meta.label}
      </span>
    );
  };

  const allSupplierAuditLogs: any[] = data.supplierAuditLogs || [];
  const visibleSupplierAuditLogs =
    auditFilterSupplierId === 'ALL'
      ? allSupplierAuditLogs
      : allSupplierAuditLogs.filter((log) => log.supplier_id === auditFilterSupplierId);

  const newPoTotal = poForm.items.reduce((s, i) => s + (Number(i.orderedQty) || 0) * (Number(i.unitCost) || 0), 0);
  const newPoExceedsThreshold = newPoTotal > approvalThreshold;
  const reviewPoTotal = reviewForm.items.reduce((s, i) => s + (Number(i.orderedQty) || 0) * (Number(i.unitCost) || 0), 0);
  const reviewEditable = reviewPo?.status === 'DRAFT' || reviewPo?.status === 'PENDING_APPROVAL';
  const reviewDisplayTotal = reviewEditable ? reviewPoTotal : Number(reviewPo?.total_amount || 0);
  const reviewExceedsThreshold = reviewDisplayTotal > approvalThreshold;
  const reviewCanCancel =
    reviewPo &&
    (reviewPo.status === 'DRAFT' || reviewPo.status === 'PENDING_APPROVAL' || reviewPo.status === 'PENDING_MANAGER_SIGNATURE' || reviewPo.status === 'APPROVED') &&
    (reviewPo.items || []).every((pi: any) => Number(pi.received_qty || 0) === 0);

  useEffect(() => {
    if (newPoExceedsThreshold && poForm.status === 'APPROVED') {
      setPoForm((f) => ({ ...f, status: 'PENDING_APPROVAL' }));
    }
  }, [newPoExceedsThreshold, poForm.status]);

  useEffect(() => {
    if (reviewEditable && reviewPoTotal > approvalThreshold && reviewForm.status === 'APPROVED') {
      setReviewForm((f) => ({ ...f, status: 'PENDING_APPROVAL' }));
    }
  }, [reviewEditable, reviewPoTotal, approvalThreshold, reviewForm.status]);

  const visiblePurchaseOrders =
    activeLocationId && activeLocationId !== 'ALL'
      ? (data.purchaseOrders || []).filter((po: any) => po.location_id === activeLocationId)
      : data.purchaseOrders || [];
  const filteredPurchaseOrders =
    poStatusFilter === 'ALL'
      ? visiblePurchaseOrders
      : visiblePurchaseOrders.filter((po: any) =>
          poStatusFilter === 'PARTIAL'
            ? po.status === 'PARTIAL' || po.status === 'PARTIALLY_RECEIVED'
            : po.status === poStatusFilter,
        );
  const poStatusCounts = {
    ALL: visiblePurchaseOrders.length,
    DRAFT: visiblePurchaseOrders.filter((po: any) => po.status === 'DRAFT').length,
    PENDING_APPROVAL: visiblePurchaseOrders.filter((po: any) => po.status === 'PENDING_APPROVAL').length,
    PENDING_MANAGER_SIGNATURE: visiblePurchaseOrders.filter((po: any) => po.status === 'PENDING_MANAGER_SIGNATURE').length,
    APPROVED: visiblePurchaseOrders.filter((po: any) => po.status === 'APPROVED').length,
    PARTIAL: visiblePurchaseOrders.filter((po: any) => po.status === 'PARTIAL' || po.status === 'PARTIALLY_RECEIVED').length,
    RECEIVED: visiblePurchaseOrders.filter((po: any) => po.status === 'RECEIVED').length,
    PAID: visiblePurchaseOrders.filter((po: any) => po.status === 'PAID').length,
    CANCELLED: visiblePurchaseOrders.filter((po: any) => po.status === 'CANCELLED').length,
  };
  const visibleInvoices =
    activeLocationId && activeLocationId !== 'ALL'
      ? (data.invoices || []).filter((inv: any) => inv.location_id === activeLocationId)
      : data.invoices || [];

  return (
    <div className="space-y-6">
      <div className={viewInvoice ? 'no-print space-y-6' : 'space-y-6'}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 dark:text-slate-50">Procurement &amp; Suppliers</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">Purchase orders, manager approvals, partial GRN batch receiving, and supplier payables</p>
        </div>
        <button
          onClick={openNewPoModal}
          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-4 py-2 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white whitespace-nowrap shrink-0"
        >
          <Plus className="w-4 h-4" /> Create Purchase Order
        </button>
      </div>

      {msg && <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/45 border border-emerald-200 dark:border-emerald-700/80 text-xs text-emerald-800 dark:text-emerald-300 font-medium">{msg}</div>}
      {err && <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">{err}</div>}

      <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-800 w-fit">
        {([
          { id: 'pos', label: `Purchase Orders (${visiblePurchaseOrders.length})` },
          { id: 'suppliers', label: 'Suppliers & Price Comparison' },
          { id: 'payables', label: `Supplier Invoices & AP (${visibleInvoices.length})` },
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

      {subTab === 'pos' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-2.5">
            <div className="flex items-center gap-2.5 text-xs">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-50 dark:bg-violet-950/50 text-violet-700 dark:text-violet-300 border border-violet-200 dark:border-violet-700/80 shrink-0">
                <ShieldCheck className="w-4 h-4" />
              </div>
              <div>
                <span className="font-semibold text-slate-900 dark:text-slate-50">
                  Multi-Stage Signature Threshold: <span className="font-mono text-violet-800 dark:text-violet-300">{formatPHP(approvalThreshold)}</span>
                </span>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Orders exceeding {formatPHP(approvalThreshold)} require Stage 1 verification and a Stage 2 Manager Digital Signature before goods receiving.
                </p>
              </div>
            </div>
            {canApprove && (
              <button
                type="button"
                onClick={openThresholdModal}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" /> Configure Threshold
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {([
              { id: 'ALL', label: 'All POs', dot: 'bg-slate-400', count: poStatusCounts.ALL },
              { id: 'DRAFT', label: 'Draft', dot: 'bg-slate-400', count: poStatusCounts.DRAFT },
              { id: 'PENDING_APPROVAL', label: 'Pending', dot: 'bg-amber-500', count: poStatusCounts.PENDING_APPROVAL },
              { id: 'PENDING_MANAGER_SIGNATURE', label: 'Pending Signature', dot: 'bg-violet-600', count: poStatusCounts.PENDING_MANAGER_SIGNATURE },
              { id: 'APPROVED', label: 'Approved', dot: 'bg-sky-500', count: poStatusCounts.APPROVED },
              { id: 'PARTIAL', label: 'Partial', dot: 'bg-indigo-500', count: poStatusCounts.PARTIAL },
              { id: 'RECEIVED', label: 'Received', dot: 'bg-emerald-500', count: poStatusCounts.RECEIVED },
              { id: 'PAID', label: 'Paid', dot: 'bg-teal-600', count: poStatusCounts.PAID },
              { id: 'CANCELLED', label: 'Cancelled', dot: 'bg-red-500', count: poStatusCounts.CANCELLED },
            ] as const).map((st) => {
              const active = poStatusFilter === st.id;
              return (
                <button
                  key={st.id}
                  type="button"
                  onClick={() => setPoStatusFilter(st.id)}
                  className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                    active
                      ? 'border-slate-900 dark:border-slate-100 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950'
                      : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                >
                  {st.id !== 'ALL' && <span className={`w-1.5 h-1.5 rounded-xs ${active ? 'bg-white dark:bg-slate-900' : st.dot}`} />}
                  <span>{st.label}</span>
                  <span className={`font-mono text-[11px] ${active ? 'text-slate-500 dark:text-slate-500' : 'text-slate-500 dark:text-slate-400'}`}>
                    {st.count}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
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
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {filteredPurchaseOrders.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-6 text-center text-xs text-slate-500 dark:text-slate-400">
                      No purchase orders match the selected location or status filter.
                    </td>
                  </tr>
                ) : filteredPurchaseOrders.map((po: any) => {
                  const hasReceived = (po.items || []).some((pi: any) => Number(pi.received_qty || 0) > 0);
                  const isDraftOrPending = po.status === 'DRAFT' || po.status === 'PENDING_APPROVAL';
                  const isAwaitingSignature = po.status === 'PENDING_MANAGER_SIGNATURE';
                  const exceedsThreshold = Number(po.total_amount || 0) > approvalThreshold;
                  const canCancel = (isDraftOrPending || isAwaitingSignature || po.status === 'APPROVED') && !hasReceived;

                  return (
                    <tr key={po.id} className="hover:bg-slate-50 dark:hover:bg-slate-800">
                      <td className="p-3 font-mono font-semibold text-slate-900 dark:text-slate-50 whitespace-nowrap">{po.po_number}</td>
                      <td className="p-3">{po.supplier_name}</td>
                      <td className="p-3 text-slate-600 dark:text-slate-300">{po.location_name}</td>
                      <td className="p-3 text-slate-600 dark:text-slate-300">
                        {po.items.map((i: any) => `${i.item_name} (${i.received_qty}/${i.ordered_qty} ${i.uom_code})`).join(', ')}
                      </td>
                      <td className="p-3 text-right whitespace-nowrap">
                        <div className="font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-50">{formatPHP(po.total_amount)}</div>
                        {po.manager_signature_data ? (
                          <div className="text-[10px] font-medium text-violet-700 dark:text-violet-300">Digitally Signed</div>
                        ) : exceedsThreshold ? (
                          <div className="text-[10px] font-medium text-amber-700 dark:text-amber-300">&gt; Threshold · 2-Stage</div>
                        ) : null}
                      </td>
                      <td className="p-3 whitespace-nowrap">{renderPoStatusBadge(po.status)}</td>
                      <td className="p-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center justify-end gap-1.5">
                          {isDraftOrPending ? (
                            <button
                              type="button"
                              onClick={() => openReviewModal(po)}
                              className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                            >
                              <Pencil className="w-3.5 h-3.5" /> Edit / Review
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => openReviewModal(po)}
                              className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                            >
                              <Eye className="w-3.5 h-3.5" /> Review
                            </button>
                          )}

                          {isDraftOrPending && canApprove && (
                            <button
                              type="button"
                              onClick={() => approvePO(po)}
                              className="inline-flex items-center gap-1 rounded-md bg-slate-900 dark:bg-slate-100 px-2.5 py-1.5 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" /> {exceedsThreshold ? 'Verify (Stage 1)' : 'Approve'}
                            </button>
                          )}

                          {isAwaitingSignature && canApprove && (
                            <button
                              type="button"
                              onClick={() => openSignatureModal(po)}
                              className="inline-flex items-center gap-1 rounded-md bg-violet-700 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-violet-800"
                            >
                              <PenTool className="w-3.5 h-3.5" /> Sign &amp; Approve
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

                          {po.status === 'RECEIVED' && canMarkPaid && (
                            <button
                              type="button"
                              onClick={() => markPoPaid(po)}
                              className="inline-flex items-center gap-1 rounded-md border border-teal-200 dark:border-teal-700/80 bg-teal-50 dark:bg-teal-950/50 px-2.5 py-1.5 text-xs font-semibold text-teal-800 dark:text-teal-300 hover:bg-teal-100 dark:hover:bg-teal-900/60"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" /> Mark Paid
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
                              className="inline-flex items-center gap-1 rounded-md border border-red-200 dark:border-red-800/80 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/70"
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
        </div>
      )}

      {subTab === 'suppliers' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
            <div className="xl:col-span-7 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
              <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">Active Suppliers ({data.suppliers.length})</span>
                <button
                  type="button"
                  onClick={() => openAddSupplierModal('tab')}
                  className="inline-flex items-center gap-1 rounded-md bg-slate-900 dark:bg-slate-100 px-2.5 py-1.5 text-[11px] font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" /> Add Supplier
                </button>
              </div>
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-100 dark:border-slate-800/80 text-slate-500 dark:text-slate-400">
                  <tr>
                    <th className="p-3 font-medium">Supplier</th>
                    <th className="p-3 font-medium">Contact</th>
                    <th className="p-3 font-medium text-right">Terms</th>
                    <th className="p-3 font-medium">Last Modified</th>
                    <th className="p-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {data.suppliers.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="p-6 text-center text-xs text-slate-500 dark:text-slate-400">
                        No active suppliers yet. Click &ldquo;Add Supplier&rdquo; to register one.
                      </td>
                    </tr>
                  ) : (
                    data.suppliers.map((s: any) => (
                      <tr key={s.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/70">
                        <td className="p-3 font-semibold text-slate-900 dark:text-slate-50">
                          {s.name}
                          <p className="font-normal text-slate-500 dark:text-slate-400 font-mono text-[11px]">{[s.code, s.tin].filter(Boolean).join(' · ') || '—'}</p>
                        </td>
                        <td className="p-3 text-slate-600 dark:text-slate-300">{s.contact_person || '—'}<p className="text-[11px]">{s.phone || ''}</p></td>
                        <td className="p-3 text-right font-mono whitespace-nowrap">{s.payment_terms} days</td>
                        <td className="p-3 whitespace-nowrap">
                          <div className="text-[11px] font-medium text-slate-800 dark:text-slate-100 font-mono">
                            {formatAuditTimestamp(s.updated_at)}
                          </div>
                          <div className="inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                            <User className="w-3 h-3 text-slate-500 dark:text-slate-400" />
                            <span>{s.updated_by_name || 'System Seed'}</span>
                          </div>
                        </td>
                        <td className="p-3 text-right whitespace-nowrap space-x-1">
                          <button
                            type="button"
                            onClick={() => setAuditSupplierTarget(s)}
                            className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-slate-800 px-2 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                            title="View supplier audit trail"
                          >
                            <History className="w-3 h-3" /> History
                            {Number(s.audit_count || 0) > 0 && (
                              <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400">({s.audit_count})</span>
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => openEditSupplierModal(s, 'tab')}
                            className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-slate-800 px-2 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                          >
                            <Pencil className="w-3 h-3" /> Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteSupplierTarget(s)}
                            className="inline-flex items-center gap-1 rounded border border-red-200 dark:border-red-800/80 px-2 py-1 text-[11px] font-medium text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/70"
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

            <div className="xl:col-span-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
              <div className="p-4 border-b border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-200">Supplier Price Comparison</div>
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-100 dark:border-slate-800/80 text-slate-500 dark:text-slate-400">
                  <tr>
                    <th className="p-3 font-medium">Ingredient</th>
                    <th className="p-3 font-medium">Supplier</th>
                    <th className="p-3 font-medium text-right">Unit Price</th>
                    <th className="p-3 font-medium text-right">Lead Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {data.priceComparison.map((pc: any) => (
                    <tr key={pc.id}>
                      <td className="p-3 font-medium text-slate-900 dark:text-slate-50">{pc.item_name}</td>
                      <td className="p-3 text-slate-600 dark:text-slate-300">{pc.supplier_name}</td>
                      <td className="p-3 text-right font-mono tabular-nums font-semibold">{formatPHP(pc.unit_price)} / {pc.uom_code}</td>
                      <td className="p-3 text-right font-mono">{pc.lead_time_days}d</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
            <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100">
                  <History className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
                  <span>Supplier Profile Audit Trail ({visibleSupplierAuditLogs.length})</span>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                  Chronological record of supplier profile creations, edits, and removals with responsible user
                </p>
              </div>
              <select
                value={auditFilterSupplierId}
                onChange={(e) => setAuditFilterSupplierId(e.target.value)}
                className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs text-slate-700 dark:text-slate-200"
              >
                <option value="ALL">All Suppliers</option>
                {data.suppliers.map((s: any) => (
                  <option key={s.id} value={s.id}>{s.name} ({s.code})</option>
                ))}
              </select>
            </div>
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-100 dark:border-slate-800/80 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="p-3 font-medium">Modified Date</th>
                  <th className="p-3 font-medium">Supplier</th>
                  <th className="p-3 font-medium">Change Type</th>
                  <th className="p-3 font-medium">Responsible User</th>
                  <th className="p-3 font-medium">Change Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {visibleSupplierAuditLogs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-6 text-center text-xs text-slate-500 dark:text-slate-400">
                      No supplier profile changes recorded yet. Creating or editing a supplier will log entries here.
                    </td>
                  </tr>
                ) : (
                  visibleSupplierAuditLogs.map((log: any) => (
                    <tr key={log.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/70">
                      <td className="p-3 font-mono text-[11px] text-slate-700 dark:text-slate-200 whitespace-nowrap">
                        {formatAuditTimestamp(log.logged_at)}
                      </td>
                      <td className="p-3 font-medium text-slate-900 dark:text-slate-50 whitespace-nowrap">
                        {log.supplier_name}
                        {log.supplier_code && (
                          <span className="ml-1.5 font-mono text-[11px] text-slate-500 dark:text-slate-400">{log.supplier_code}</span>
                        )}
                      </td>
                      <td className="p-3 whitespace-nowrap">{renderSupplierAuditActionBadge(log.action)}</td>
                      <td className="p-3 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5 font-medium text-slate-800 dark:text-slate-100">
                          <User className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
                          {log.user_name || 'System'}
                        </span>
                      </td>
                      <td className="p-3 text-slate-600 dark:text-slate-300">{log.details || '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {subTab === 'payables' && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
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
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {visibleInvoices.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-xs text-slate-500 dark:text-slate-400">
                    No supplier invoices match the selected truck / location.
                  </td>
                </tr>
              ) : visibleInvoices.map((inv: any) => {
                const bal = inv.total_amount - inv.paid_amount;
                return (
                  <tr key={inv.id}>
                    <td className="p-3 font-mono font-semibold">{inv.invoice_number}</td>
                    <td className="p-3">{inv.supplier_name}</td>
                    <td className="p-3 font-mono text-slate-500 dark:text-slate-400">{String(inv.due_date).slice(0, 10)}</td>
                    <td className="p-3 text-right font-mono tabular-nums">{formatPHP(inv.total_amount)}</td>
                    <td className="p-3 text-right font-mono tabular-nums">{formatPHP(inv.paid_amount)}</td>
                    <td className="p-3 text-right font-mono tabular-nums font-semibold text-red-700 dark:text-red-300">{formatPHP(bal)}</td>
                    <td className="p-3 whitespace-nowrap">{renderInvoiceStatusBadge(inv.status)}</td>
                    <td className="p-3 text-right whitespace-nowrap">
                      <div className="inline-flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => setViewInvoice(inv)}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <Eye className="w-3.5 h-3.5" /> View / Print
                        </button>
                        {inv.status !== 'PAID' && (
                          <button
                            type="button"
                            onClick={() => payInvoice(inv)}
                            className="rounded-md bg-slate-900 dark:bg-slate-100 px-2.5 py-1.5 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white"
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
          <div className="w-full max-w-2xl rounded-xl bg-white dark:bg-slate-900 p-5 space-y-4 border border-slate-200 dark:border-slate-800">
            <h3 className="font-display text-base font-semibold">Receive Goods — {receivingPo.po_number}</h3>
            <div className="space-y-3 max-h-80 overflow-y-auto">
              {receivingPo.items.map((it: any) => (
                <div key={it.id} className="grid grid-cols-1 sm:grid-cols-5 gap-2.5 items-end border border-slate-200 dark:border-slate-800 rounded-lg p-3">
                  <div className="sm:col-span-2">
                    <p className="text-xs font-semibold text-slate-900 dark:text-slate-50">{it.item_name}</p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">Ordered: {formatNum(it.ordered_qty, 0)} {it.uom_code}</p>
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Received Qty</label>
                    <input
                      type="number"
                      placeholder="Recv Qty"
                      value={recvMap[it.id]?.qty || ''}
                      onChange={(e) => setRecvMap((m) => ({ ...m, [it.id]: { ...m[it.id], qty: e.target.value } }))}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-1.5 text-xs font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Batch / Lot #</label>
                    <input
                      type="text"
                      placeholder="Lot #"
                      value={recvMap[it.id]?.batch || ''}
                      onChange={(e) => setRecvMap((m) => ({ ...m, [it.id]: { ...m[it.id], batch: e.target.value } }))}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-1.5 text-xs font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Expiry Date</label>
                    <input
                      type="date"
                      value={recvMap[it.id]?.expiry || ''}
                      onChange={(e) => setRecvMap((m) => ({ ...m, [it.id]: { ...m[it.id], expiry: e.target.value } }))}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-1.5 text-xs font-mono"
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
          <form onSubmit={createPO} className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-xl bg-white dark:bg-slate-900 p-5 space-y-4 border border-slate-200 dark:border-slate-800">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800/80 pb-3">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">New Purchase Order</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">Create a supplier order for manager review and approval</p>
              </div>
              <button
                type="button"
                onClick={() => setShowNewPo(false)}
                className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">Supplier</label>
                  <div className="inline-flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => openAddSupplierModal('newPo')}
                      className="inline-flex items-center gap-0.5 rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 px-1.5 py-0.5 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
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
                      className="inline-flex items-center gap-0.5 rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 px-1.5 py-0.5 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
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
                      className="inline-flex items-center gap-0.5 rounded border border-red-200 dark:border-red-800/80 bg-red-50/60 dark:bg-red-950/50 px-1.5 py-0.5 text-[11px] font-medium text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/60 disabled:opacity-40"
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
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
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
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Delivery Location</label>
                <select
                  value={poForm.locationId}
                  onChange={(e) => setPoForm({ ...poForm, locationId: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                >
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Purchase Order Status</label>
                <div className="flex items-center gap-2">
                  <select
                    value={poForm.status}
                    onChange={(e) => setPoForm({ ...poForm, status: e.target.value as 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' })}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                  >
                    <option value="DRAFT">Draft</option>
                    <option value="PENDING_APPROVAL">Pending Approval</option>
                    {canApprove && !newPoExceedsThreshold && <option value="APPROVED">Approved</option>}
                  </select>
                  {renderPoStatusBadge(poForm.status)}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Expected Delivery Date (optional)</label>
                <input
                  type="date"
                  value={poForm.expectedAt}
                  onChange={(e) => setPoForm({ ...poForm, expectedAt: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Order Notes (optional)</label>
                <input
                  type="text"
                  placeholder="e.g. Morning commissary delivery"
                  value={poForm.notes}
                  onChange={(e) => setPoForm({ ...poForm, notes: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                />
              </div>
            </div>

            <div className="space-y-2.5 border-t border-slate-100 dark:border-slate-800/80 pt-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">Order Line Items</span>
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
                  className="text-xs font-medium text-slate-900 dark:text-slate-50 hover:underline"
                >
                  + Add Line Item
                </button>
              </div>

              {poForm.items.map((line, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2 items-end rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/60 p-2.5">
                  <div className="col-span-12 sm:col-span-5">
                    <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Ingredient / Item</label>
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
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-2 text-xs"
                    >
                      {invItems.map((i) => (
                        <option key={i.id} value={i.id}>{i.name} ({i.uom_code})</option>
                      ))}
                    </select>
                  </div>
                  <div className="col-span-5 sm:col-span-3">
                    <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Order Quantity</label>
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
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-2 text-xs font-mono"
                    />
                  </div>
                  <div className="col-span-5 sm:col-span-3">
                    <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Unit Cost (PHP)</label>
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
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-2 text-xs font-mono"
                    />
                  </div>
                  <div className="col-span-2 sm:col-span-1 flex justify-end pb-1.5">
                    {poForm.items.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          setPoForm((f) => ({ ...f, items: f.items.filter((_, i) => i !== idx) }))
                        }
                        className="p-1.5 text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-300"
                        title="Remove line item"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              ))}

              <div className="flex items-center justify-between pt-1 text-xs">
                <span className="text-slate-500 dark:text-slate-400">Estimated Order Total</span>
                <span className="font-mono tabular-nums text-sm font-bold text-slate-900 dark:text-slate-50">{formatPHP(newPoTotal)}</span>
              </div>
              {newPoExceedsThreshold && (
                <div className="rounded-lg border border-violet-200 dark:border-violet-700/80 bg-violet-50 dark:bg-violet-950/50 px-3 py-2 text-[11px] text-violet-900 dark:text-violet-300">
                  Exceeds the <span className="font-mono font-semibold">{formatPHP(approvalThreshold)}</span> approval threshold — after submission, this PO requires Stage 1 verification and a Stage 2 Manager Digital Signature.
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800/80">
              <button type="button" onClick={() => setShowNewPo(false)} className="px-4 py-2 rounded-lg border text-xs">Cancel</button>
              <button type="submit" className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 text-xs font-semibold hover:bg-slate-800 dark:hover:bg-white">
                {poForm.status === 'DRAFT'
                  ? 'Save as Draft'
                  : poForm.status === 'APPROVED'
                    ? 'Create & Approve'
                    : 'Submit for Approval'}
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
            className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl bg-white dark:bg-slate-900 p-5 space-y-4 border border-slate-200 dark:border-slate-800"
          >
            <div className="flex items-start justify-between gap-3 border-b border-slate-100 dark:border-slate-800/80 pb-3">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">
                  {reviewEditable ? `Edit / Review Purchase Order — ${reviewPo.po_number}` : `Review Purchase Order — ${reviewPo.po_number}`}
                </h3>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                  {renderPoStatusBadge(reviewPo.status)}
                  {reviewPo.ordered_at && <span>Ordered {String(reviewPo.ordered_at).slice(0, 10)}</span>}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setReviewPo(null)}
                className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {err && <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">{err}</div>}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">Supplier</label>
                  {reviewEditable && (
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => openAddSupplierModal('reviewPo')}
                        className="inline-flex items-center gap-0.5 rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 px-1.5 py-0.5 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
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
                        className="inline-flex items-center gap-0.5 rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 px-1.5 py-0.5 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
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
                        className="inline-flex items-center gap-0.5 rounded border border-red-200 dark:border-red-800/80 bg-red-50/60 dark:bg-red-950/50 px-1.5 py-0.5 text-[11px] font-medium text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/60 disabled:opacity-40"
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
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs disabled:bg-slate-50 dark:disabled:bg-slate-900 disabled:text-slate-600 dark:disabled:text-slate-400"
                >
                  {data.suppliers.map((s: any) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Delivery Location</label>
                <select
                  disabled={!reviewEditable}
                  value={reviewForm.locationId}
                  onChange={(e) => setReviewForm({ ...reviewForm, locationId: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs disabled:bg-slate-50 dark:disabled:bg-slate-900 disabled:text-slate-600 dark:disabled:text-slate-400"
                >
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Purchase Order Status</label>
                {reviewEditable ? (
                  <div className="flex items-center gap-2">
                    <select
                      value={reviewForm.status}
                      onChange={(e) => setReviewForm({ ...reviewForm, status: e.target.value as 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' })}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                    >
                      <option value="DRAFT">Draft</option>
                      <option value="PENDING_APPROVAL">Pending Approval</option>
                      {canApprove && reviewPoTotal <= approvalThreshold && <option value="APPROVED">Approved</option>}
                    </select>
                    {renderPoStatusBadge(reviewForm.status)}
                  </div>
                ) : (
                  <div className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 px-3 py-2">
                    {renderPoStatusBadge(reviewPo.status)}
                    <span className="text-[11px] text-slate-500 dark:text-slate-400">
                      {reviewPo.status === 'PAID'
                        ? 'Settled'
                        : reviewPo.status === 'RECEIVED'
                          ? 'Goods Received'
                          : reviewPo.status === 'PENDING_MANAGER_SIGNATURE'
                            ? 'Awaiting Digital Signature'
                            : reviewPo.status === 'CANCELLED'
                              ? 'Cancelled'
                              : 'Locked for Receiving'}
                    </span>
                  </div>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Expected Delivery Date</label>
                <input
                  type="date"
                  disabled={!reviewEditable}
                  value={reviewForm.expectedAt}
                  onChange={(e) => setReviewForm({ ...reviewForm, expectedAt: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono disabled:bg-slate-50 dark:disabled:bg-slate-900 disabled:text-slate-600 dark:disabled:text-slate-400"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Order / Review Notes</label>
                <input
                  type="text"
                  disabled={!reviewEditable}
                  placeholder={reviewEditable ? 'Review remarks or delivery instructions' : 'No notes recorded'}
                  value={reviewForm.notes}
                  onChange={(e) => setReviewForm({ ...reviewForm, notes: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs disabled:bg-slate-50 dark:disabled:bg-slate-900 disabled:text-slate-600 dark:disabled:text-slate-400"
                />
              </div>
            </div>

            <div className="space-y-2.5 border-t border-slate-100 dark:border-slate-800/80 pt-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">Order Line Items</span>
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
                    className="text-xs font-medium text-slate-900 dark:text-slate-50 hover:underline"
                  >
                    + Add Line Item
                  </button>
                )}
              </div>

              {reviewEditable ? (
                reviewForm.items.map((line, idx) => {
                  const lineTotal = (Number(line.orderedQty) || 0) * (Number(line.unitCost) || 0);
                  return (
                    <div key={idx} className="grid grid-cols-12 gap-2 items-end rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/60 p-2.5">
                      <div className="col-span-12 sm:col-span-4">
                        <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Ingredient / Item</label>
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
                          className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-2 text-xs"
                        >
                          {invItems.map((i) => (
                            <option key={i.id} value={i.id}>{i.name} ({i.uom_code})</option>
                          ))}
                        </select>
                      </div>
                      <div className="col-span-4 sm:col-span-3">
                        <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Order Qty</label>
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
                          className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-2 text-xs font-mono"
                        />
                      </div>
                      <div className="col-span-4 sm:col-span-2">
                        <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Unit Cost</label>
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
                          className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-2 text-xs font-mono"
                        />
                      </div>
                      <div className="col-span-3 sm:col-span-2 text-right pb-2">
                        <span className="block text-[10px] text-slate-500 dark:text-slate-400">Subtotal</span>
                        <span className="font-mono text-xs font-semibold text-slate-900 dark:text-slate-50">{formatPHP(lineTotal)}</span>
                      </div>
                      <div className="col-span-1 flex justify-end pb-1.5">
                        {reviewForm.items.length > 1 && (
                          <button
                            type="button"
                            onClick={() =>
                              setReviewForm((f) => ({ ...f, items: f.items.filter((_, i) => i !== idx) }))
                            }
                            className="p-1.5 text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-300"
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
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
                      <tr>
                        <th className="p-2.5 font-medium">Ingredient / Item</th>
                        <th className="p-2.5 font-medium text-right">Ordered</th>
                        <th className="p-2.5 font-medium text-right">Received</th>
                        <th className="p-2.5 font-medium text-right">Unit Cost</th>
                        <th className="p-2.5 font-medium text-right">Subtotal</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {(reviewPo.items || []).map((pi: any) => (
                        <tr key={pi.id}>
                          <td className="p-2.5 font-medium text-slate-900 dark:text-slate-50">{pi.item_name}</td>
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
                <span className="text-slate-500 dark:text-slate-400">Total Purchase Order Amount</span>
                <span className="font-mono tabular-nums text-base font-bold text-slate-900 dark:text-slate-50">
                  {formatPHP(reviewDisplayTotal)}
                </span>
              </div>
            </div>

            {(reviewExceedsThreshold || reviewPo.stage1_approved_at || reviewPo.manager_signature_data || reviewPo.status === 'PENDING_MANAGER_SIGNATURE') && (
              <div className="rounded-lg border border-violet-200 dark:border-violet-700/80 bg-violet-50/50 dark:bg-violet-950/50 p-3 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-violet-900 dark:text-violet-300">
                    <ShieldCheck className="w-4 h-4 text-violet-700 dark:text-violet-300" />
                    Multi-Stage Approval Workflow
                  </div>
                  <span className="font-mono text-[11px] text-violet-800 dark:text-violet-300">
                    Threshold: {formatPHP(approvalThreshold)}
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                  <div className="rounded-md border border-violet-200/80 bg-white dark:bg-slate-900 p-2.5">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Stage 1 · Initial Verification</div>
                    <div className="mt-1 font-medium text-slate-900 dark:text-slate-50">
                      {reviewPo.stage1_approved_by_name
                        ? `Verified by ${reviewPo.stage1_approved_by_name}`
                        : reviewPo.status === 'APPROVED' || reviewPo.status === 'PARTIAL' || reviewPo.status === 'RECEIVED' || reviewPo.status === 'PAID'
                          ? 'Completed'
                          : 'Awaiting Stage 1 Verification'}
                    </div>
                    {reviewPo.stage1_approved_at && (
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">{formatAuditTimestamp(reviewPo.stage1_approved_at)}</div>
                    )}
                  </div>
                  <div className="rounded-md border border-violet-200/80 bg-white dark:bg-slate-900 p-2.5">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Stage 2 · Manager Digital Signature</div>
                    <div className="mt-1 font-medium text-slate-900 dark:text-slate-50">
                      {reviewPo.manager_signature_data
                        ? `Signed by ${reviewPo.manager_signer_name || 'Authorized Manager'}`
                        : reviewPo.status === 'PENDING_MANAGER_SIGNATURE'
                          ? 'Awaiting Manager Signature'
                          : reviewExceedsThreshold
                            ? 'Required after Stage 1'
                            : 'Not required (under threshold)'}
                    </div>
                    {reviewPo.signed_at && (
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">{formatAuditTimestamp(reviewPo.signed_at)}</div>
                    )}
                  </div>
                </div>
                {reviewPo.manager_signature_data && (
                  <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2.5">
                    <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 mb-1.5">
                      <span>Captured Digital Signature</span>
                      <span className="font-mono">{reviewPo.manager_signer_name}</span>
                    </div>
                    <div className="flex justify-center rounded border border-dashed border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/70 p-2">
                      <img
                        src={reviewPo.manager_signature_data}
                        alt="Manager digital signature"
                        className="max-h-20 object-contain"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-slate-100 dark:border-slate-800/80">
              <div>
                {reviewCanCancel && (
                  <button
                    type="button"
                    onClick={() => {
                      setErr('');
                      setCancelReason('');
                      setCancelPoTarget(reviewPo);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 dark:border-red-800/80 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/70"
                  >
                    <XCircle className="w-3.5 h-3.5" /> Cancel PO
                  </button>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setReviewPo(null)}
                  className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  Close
                </button>
                {reviewEditable && (
                  <>
                    <button
                      type="submit"
                      disabled={savingReview}
                      className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
                    >
                      {savingReview ? 'Saving...' : 'Save Changes'}
                    </button>
                    {canApprove && (
                      <button
                        type="button"
                        disabled={savingReview}
                        onClick={() => saveReviewPo(true)}
                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 text-xs font-semibold hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        {savingReview
                          ? 'Processing...'
                          : reviewPoTotal > approvalThreshold
                            ? 'Verify Stage 1 & Request Signature'
                            : 'Save & Approve'}
                      </button>
                    )}
                  </>
                )}
                {reviewPo.status === 'PENDING_MANAGER_SIGNATURE' && canApprove && (
                  <button
                    type="button"
                    onClick={() => openSignatureModal(reviewPo)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-violet-700 text-white text-xs font-semibold hover:bg-violet-800"
                  >
                    <PenTool className="w-3.5 h-3.5" /> Sign &amp; Final Approve
                  </button>
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
                {reviewPo.status === 'RECEIVED' && canMarkPaid && (
                  <button
                    type="button"
                    onClick={() => markPoPaid(reviewPo)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-teal-600 text-white text-xs font-semibold hover:bg-teal-700"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" /> Mark as Paid
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
          <form onSubmit={confirmCancelPO} className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 p-5 space-y-4 border border-slate-200 dark:border-slate-800">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">
                  Cancel Purchase Order {cancelPoTarget.po_number}?
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  {cancelPoTarget.supplier_name} · {formatPHP(cancelPoTarget.total_amount)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setCancelPoTarget(null)}
                className="p-1 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-600 dark:text-slate-300">
              Cancelling this order will mark it as <span className="font-semibold text-red-600 dark:text-red-300">CANCELLED</span> and prevent goods receiving or supplier billing against it.
            </p>

            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Cancellation Reason (optional)</label>
              <input
                type="text"
                placeholder="e.g. Supplier out of stock or revised quantity"
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setCancelPoTarget(null)}
                className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
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
            ? 'bg-emerald-50 dark:bg-emerald-950/45 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-700/80'
            : viewInvoice.status === 'PARTIAL'
            ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-700/80'
            : 'bg-amber-50 dark:bg-amber-950/45 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-700/80';

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 overflow-y-auto print:static print:bg-transparent print:p-0 print:block">
            <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl bg-white dark:bg-slate-900 p-6 space-y-5 border border-slate-200 dark:border-slate-800 print:max-h-none print:overflow-visible print:border-0 print:shadow-none print:mx-auto print:max-w-full">
              {/* Header */}
              <div className="flex items-start justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
                <div className="flex items-center gap-3">
                  <img
                    src="/assets/aistudio/Logo_836b4628.png"
                    alt="Maximus Barbecue Logo"
                    referrerPolicy="no-referrer"
                    className="w-11 h-11 rounded-full object-contain border border-slate-100 dark:border-slate-800/80"
                  />
                  <div>
                    <h3 className="font-display text-lg font-bold text-slate-900 dark:text-slate-50">Maximus Barbecue ERP</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">Supplier Invoice &amp; Accounts Payable Voucher</p>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <div className="text-right">
                    <p className="font-mono text-sm font-bold text-slate-900 dark:text-slate-50">{viewInvoice.invoice_number}</p>
                    <span className={`inline-block mt-1 px-2 py-0.5 rounded border text-[11px] font-semibold ${statusColor}`}>
                      {viewInvoice.status}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setViewInvoice(null)}
                    className="no-print p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Supplier & Invoice Metadata */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 p-3.5 space-y-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Supplier (Bill From)</p>
                  <p className="text-sm font-semibold text-slate-900 dark:text-slate-50">{viewInvoice.supplier_name}</p>
                  {viewInvoice.supplier_code && <p className="font-mono text-slate-600 dark:text-slate-300">Code: {viewInvoice.supplier_code}</p>}
                  {viewInvoice.supplier_tin && <p className="font-mono text-slate-600 dark:text-slate-300">TIN: {viewInvoice.supplier_tin}</p>}
                  {viewInvoice.supplier_contact && <p className="text-slate-600 dark:text-slate-300">Contact: {viewInvoice.supplier_contact}</p>}
                  {(viewInvoice.supplier_phone || viewInvoice.supplier_email) && (
                    <p className="text-slate-600 dark:text-slate-300">
                      {[viewInvoice.supplier_phone, viewInvoice.supplier_email].filter(Boolean).join(' · ')}
                    </p>
                  )}
                  {viewInvoice.supplier_address && <p className="text-slate-500 dark:text-slate-400">{viewInvoice.supplier_address}</p>}
                </div>

                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 p-3.5 space-y-1.5">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Voucher Reference</p>
                  <div className="flex justify-between">
                    <span className="text-slate-500 dark:text-slate-400">Invoice Date</span>
                    <span className="font-mono font-medium text-slate-900 dark:text-slate-50">
                      {viewInvoice.created_at ? String(viewInvoice.created_at).slice(0, 10) : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500 dark:text-slate-400">Due Date</span>
                    <span className="font-mono font-semibold text-slate-900 dark:text-slate-50">{String(viewInvoice.due_date || '').slice(0, 10)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500 dark:text-slate-400">Linked PO #</span>
                    <span className="font-mono text-slate-900 dark:text-slate-50">{viewInvoice.po_number || 'Direct / Opening AP'}</span>
                  </div>
                  {viewInvoice.grn_number && (
                    <div className="flex justify-between">
                      <span className="text-slate-500 dark:text-slate-400">GRN Reference</span>
                      <span className="font-mono text-slate-900 dark:text-slate-50">{viewInvoice.grn_number}</span>
                    </div>
                  )}
                  {viewInvoice.location_name && (
                    <div className="flex justify-between">
                      <span className="text-slate-500 dark:text-slate-400">Receiving Location</span>
                      <span className="text-slate-900 dark:text-slate-50">{viewInvoice.location_name}</span>
                    </div>
                  )}
                  {Number(viewInvoice.payment_terms || 0) > 0 && (
                    <div className="flex justify-between">
                      <span className="text-slate-500 dark:text-slate-400">Payment Terms</span>
                      <span className="font-mono text-slate-900 dark:text-slate-50">Net {viewInvoice.payment_terms} days</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Line Items */}
              <div className="space-y-2">
                <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">Billed Line Items</p>
                {invItemsList.length > 0 ? (
                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
                        <tr>
                          <th className="p-2.5 font-medium">Item</th>
                          <th className="p-2.5 font-medium">Batch / Lot</th>
                          <th className="p-2.5 font-medium text-right">Qty</th>
                          <th className="p-2.5 font-medium text-right">Unit Cost</th>
                          <th className="p-2.5 font-medium text-right">Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {invItemsList.map((it: any, idx: number) => (
                          <tr key={it.id || idx}>
                            <td className="p-2.5 font-medium text-slate-900 dark:text-slate-50">{it.item_name}</td>
                            <td className="p-2.5 font-mono text-slate-500 dark:text-slate-400">{it.batch_number || '—'}</td>
                            <td className="p-2.5 text-right font-mono tabular-nums">
                              {formatNum(it.quantity, 2)} {it.uom_code}
                            </td>
                            <td className="p-2.5 text-right font-mono tabular-nums">{formatPHP(it.unit_cost)}</td>
                            <td className="p-2.5 text-right font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-50">
                              {formatPHP(it.line_total)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 p-3 text-xs text-slate-600 dark:text-slate-300">
                    Summary supplier billing voucher for <span className="font-semibold text-slate-800 dark:text-slate-100">{viewInvoice.supplier_name}</span> (no linked PO line breakdown).
                  </div>
                )}
              </div>

              {/* AP Financial Summary */}
              <div className="flex justify-end">
                <div className="w-full sm:w-72 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 p-3.5 space-y-1.5 text-xs">
                  <div className="flex justify-between text-slate-600 dark:text-slate-300">
                    <span>Invoice Total</span>
                    <span className="font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-50">{formatPHP(viewInvoice.total_amount)}</span>
                  </div>
                  <div className="flex justify-between text-slate-600 dark:text-slate-300">
                    <span>Amount Paid</span>
                    <span className="font-mono tabular-nums font-medium text-emerald-700 dark:text-emerald-300">-{formatPHP(viewInvoice.paid_amount)}</span>
                  </div>
                  <div className="border-t border-slate-200 dark:border-slate-800 pt-1.5 flex justify-between text-sm font-bold text-slate-900 dark:text-slate-50">
                    <span>Balance Due</span>
                    <span className={`font-mono tabular-nums ${balance > 0 ? 'text-red-700 dark:text-red-300' : 'text-emerald-700 dark:text-emerald-300'}`}>
                      {formatPHP(balance)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Payment History */}
              <div className="space-y-2">
                <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">Payment History</p>
                {invPayments.length > 0 ? (
                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
                        <tr>
                          <th className="p-2.5 font-medium">Payment #</th>
                          <th className="p-2.5 font-medium">Date</th>
                          <th className="p-2.5 font-medium">Method</th>
                          <th className="p-2.5 font-medium">Reference</th>
                          <th className="p-2.5 font-medium text-right">Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {invPayments.map((pmt: any, idx: number) => (
                          <tr key={pmt.id || idx}>
                            <td className="p-2.5 font-mono font-semibold text-slate-900 dark:text-slate-50">{pmt.payment_number || '—'}</td>
                            <td className="p-2.5 font-mono text-slate-500 dark:text-slate-400">{pmt.paid_at ? String(pmt.paid_at).slice(0, 10) : '—'}</td>
                            <td className="p-2.5 text-slate-700 dark:text-slate-200">{pmt.method}</td>
                            <td className="p-2.5 font-mono text-slate-600 dark:text-slate-300">{pmt.reference_no || '—'}</td>
                            <td className="p-2.5 text-right font-mono tabular-nums font-semibold text-emerald-700 dark:text-emerald-300">
                              {formatPHP(pmt.amount)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : Number(viewInvoice.paid_amount || 0) > 0 ? (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Initial partial payment of {formatPHP(viewInvoice.paid_amount)} recorded prior to detailed payment log.
                  </p>
                ) : (
                  <p className="text-xs text-slate-500 dark:text-slate-400">No payments recorded yet.</p>
                )}
              </div>

              {/* Print Signature Lines */}
              <div className="hidden print:grid grid-cols-3 gap-6 pt-8 text-xs text-slate-600 dark:text-slate-300">
                <div className="border-t border-slate-400 dark:border-slate-600 pt-1.5 text-center">Prepared By</div>
                <div className="border-t border-slate-400 dark:border-slate-600 pt-1.5 text-center">Verified / Approved By</div>
                <div className="border-t border-slate-400 dark:border-slate-600 pt-1.5 text-center">Received By (Supplier)</div>
              </div>

              {/* Footer Actions */}
              <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 dark:border-slate-800/80 pt-3 no-print">
                <button
                  type="button"
                  onClick={() => setViewInvoice(null)}
                  className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
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
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 text-xs font-semibold hover:bg-slate-800 dark:hover:bg-white"
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
            className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl bg-white dark:bg-slate-900 p-5 space-y-4 border border-slate-200 dark:border-slate-800 shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800/80 pb-3">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">
                  {supplierModal === 'add' ? 'Add Supplier' : 'Edit Supplier'}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">Manage supplier profile, contact info, and payment terms</p>
              </div>
              <button
                type="button"
                onClick={() => setSupplierModal(null)}
                className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {supplierModalErr && (
              <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">
                {supplierModalErr}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Supplier Code *</label>
                <input
                  required
                  placeholder="e.g. SUP-004"
                  value={supplierForm.code}
                  onChange={(e) => setSupplierForm({ ...supplierForm, code: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Payment Terms (Days)</label>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={supplierForm.paymentTerms}
                  onChange={(e) => setSupplierForm({ ...supplierForm, paymentTerms: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Supplier Name *</label>
                <input
                  required
                  placeholder="e.g. Prime Grill Poultry & Meat Corp."
                  value={supplierForm.name}
                  onChange={(e) => setSupplierForm({ ...supplierForm, name: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Contact Person</label>
                <input
                  placeholder="e.g. Maria Santos"
                  value={supplierForm.contactPerson}
                  onChange={(e) => setSupplierForm({ ...supplierForm, contactPerson: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Phone</label>
                <input
                  placeholder="e.g. +63 917 555 0199"
                  value={supplierForm.phone}
                  onChange={(e) => setSupplierForm({ ...supplierForm, phone: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Email</label>
                <input
                  type="email"
                  placeholder="orders@supplier.ph"
                  value={supplierForm.email}
                  onChange={(e) => setSupplierForm({ ...supplierForm, email: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">TIN</label>
                <input
                  placeholder="000-000-000-000"
                  value={supplierForm.tin}
                  onChange={(e) => setSupplierForm({ ...supplierForm, tin: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Business Address</label>
                <input
                  placeholder="Warehouse / pickup address"
                  value={supplierForm.address}
                  onChange={(e) => setSupplierForm({ ...supplierForm, address: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                />
              </div>
            </div>

            {supplierModal === 'edit' && (() => {
              const editedSupplier = (data.suppliers || []).find((s: any) => s.id === supplierEditId);
              if (!editedSupplier) return null;
              const supLogs = allSupplierAuditLogs.filter((l) => l.supplier_id === editedSupplier.id).slice(0, 3);
              return (
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-800/80 p-3 space-y-2 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Audit Trail</span>
                      <p className="text-[11px] text-slate-700 dark:text-slate-200 mt-0.5">
                        Last modified <span className="font-mono font-semibold text-slate-900 dark:text-slate-50">{formatAuditTimestamp(editedSupplier.updated_at)}</span> by{' '}
                        <span className="font-semibold text-slate-900 dark:text-slate-50">{editedSupplier.updated_by_name || 'System Seed'}</span>
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setAuditSupplierTarget(editedSupplier)}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      <History className="w-3 h-3" /> View History
                    </button>
                  </div>
                  {supLogs.length > 0 && (
                    <div className="space-y-1 border-t border-slate-200/80 pt-2">
                      {supLogs.map((entry: any) => (
                        <div key={entry.id} className="flex items-start justify-between gap-2 text-[11px]">
                          <div className="text-slate-600 dark:text-slate-300 truncate">
                            <span className="font-semibold text-slate-800 dark:text-slate-100">{entry.user_name || 'System'}:</span>{' '}
                            <span>{entry.details || entry.action}</span>
                          </div>
                          <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400 shrink-0">
                            {formatAuditTimestamp(entry.logged_at)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800/80">
              <button
                type="button"
                onClick={() => setSupplierModal(null)}
                className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingSupplier}
                className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 text-xs font-semibold hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50"
              >
                {savingSupplier ? 'Saving...' : supplierModal === 'add' ? 'Save Supplier' : 'Update Supplier'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Supplier Audit Trail Modal */}
      {auditSupplierTarget && (() => {
        const targetLogs = allSupplierAuditLogs.filter((l) => l.supplier_id === auditSupplierTarget.id);
        return (
          <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/45 p-4">
            <div className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-xl bg-white dark:bg-slate-900 p-5 space-y-4 border border-slate-200 dark:border-slate-800 shadow-xl">
              <div className="flex items-start justify-between gap-3 border-b border-slate-100 dark:border-slate-800/80 pb-3">
                <div>
                  <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">
                    Supplier Audit Trail — {auditSupplierTarget.name}
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 font-mono mt-0.5">
                    {[auditSupplierTarget.code, auditSupplierTarget.tin].filter(Boolean).join(' · ') || 'Supplier Profile'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setAuditSupplierTarget(null)}
                  className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 p-3">
                  <span className="block text-[11px] font-medium text-slate-500 dark:text-slate-400">Last Modified Date</span>
                  <span className="mt-0.5 block font-mono font-semibold text-slate-900 dark:text-slate-50">
                    {formatAuditTimestamp(auditSupplierTarget.updated_at)}
                  </span>
                </div>
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 p-3">
                  <span className="block text-[11px] font-medium text-slate-500 dark:text-slate-400">Last Modified By</span>
                  <span className="mt-0.5 inline-flex items-center gap-1.5 font-semibold text-slate-900 dark:text-slate-50">
                    <User className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
                    {auditSupplierTarget.updated_by_name || 'System Seed'}
                  </span>
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 dark:border-slate-800 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
                    <tr>
                      <th className="p-2.5 font-medium">Date &amp; Time</th>
                      <th className="p-2.5 font-medium">Action</th>
                      <th className="p-2.5 font-medium">User</th>
                      <th className="p-2.5 font-medium">Changes / Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {targetLogs.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="p-5 text-center text-xs text-slate-500 dark:text-slate-400">
                          No detailed change events recorded after initial workspace setup.
                        </td>
                      </tr>
                    ) : (
                      targetLogs.map((log: any) => (
                        <tr key={log.id} className="hover:bg-slate-50 dark:hover:bg-slate-800">
                          <td className="p-2.5 font-mono text-[11px] text-slate-700 dark:text-slate-200 whitespace-nowrap">
                            {formatAuditTimestamp(log.logged_at)}
                          </td>
                          <td className="p-2.5 whitespace-nowrap">{renderSupplierAuditActionBadge(log.action)}</td>
                          <td className="p-2.5 font-medium text-slate-800 dark:text-slate-100 whitespace-nowrap">{log.user_name || 'System'}</td>
                          <td className="p-2.5 text-slate-600 dark:text-slate-300">{log.details || '—'}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <div className="flex justify-end pt-1">
                <button
                  type="button"
                  onClick={() => setAuditSupplierTarget(null)}
                  className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Delete Supplier Confirmation Modal */}
      {deleteSupplierTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 p-5 space-y-4 border border-slate-200 dark:border-slate-800 shadow-xl">
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">
                Delete {deleteSupplierTarget.name}?
              </h3>
              <button
                type="button"
                onClick={() => setDeleteSupplierTarget(null)}
                className="p-1 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-300">
              This will remove <span className="font-semibold text-slate-900 dark:text-slate-50">{deleteSupplierTarget.name}</span> from active suppliers. If purchase orders or supplier invoices reference this supplier, it will be archived safely to preserve historical records.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteSupplierTarget(null)}
                className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
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

      {/* Configurable Financial Approval Threshold Modal */}
      {showThresholdModal && (
        <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/45 p-4">
          <form onSubmit={saveApprovalThreshold} className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 p-5 space-y-4 border border-slate-200 dark:border-slate-800 shadow-xl">
            <div className="flex items-start justify-between gap-2 border-b border-slate-100 dark:border-slate-800/80 pb-3">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">PO Signature Threshold</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Set the order amount above which Stage 2 Manager Digital Signature is mandatory.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowThresholdModal(false)}
                className="p-1 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {thresholdErr && (
              <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">{thresholdErr}</div>
            )}

            <div className="space-y-2">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-200">Threshold Amount (PHP)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                required
                value={thresholdInput}
                onChange={(e) => setThresholdInput(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-sm font-mono font-semibold text-slate-900 dark:text-slate-50"
              />
              <div className="flex flex-wrap gap-1.5 pt-1">
                {[5000, 10000, 25000, 50000].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setThresholdInput(String(preset))}
                    className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 px-2.5 py-1 text-[11px] font-mono text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    {formatPHP(preset)}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800/80">
              <button
                type="button"
                onClick={() => setShowThresholdModal(false)}
                className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingThreshold}
                className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 text-xs font-semibold hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50"
              >
                {savingThreshold ? 'Saving...' : 'Save Threshold'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Stage 2 Manager Digital Signature Approval Modal */}
      {signaturePo && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
          <form onSubmit={submitManagerSignature} className="w-full max-w-lg max-h-[92vh] overflow-y-auto rounded-xl bg-white dark:bg-slate-900 p-5 space-y-4 border border-slate-200 dark:border-slate-800 shadow-2xl">
            <div className="flex items-start justify-between gap-2 border-b border-slate-100 dark:border-slate-800/80 pb-3">
              <div>
                <div className="inline-flex items-center gap-1.5 rounded-md border border-violet-200 dark:border-violet-700/80 bg-violet-50 dark:bg-violet-950/50 px-2 py-0.5 text-[11px] font-semibold text-violet-800 dark:text-violet-300 mb-1.5">
                  <PenTool className="w-3 h-3" /> Stage 2 · Manager Digital Signature
                </div>
                <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">
                  Authorize {signaturePo.po_number}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {signaturePo.supplier_name} · {signaturePo.location_name}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSignaturePo(null)}
                className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {signatureErr && (
              <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">{signatureErr}</div>
            )}

            <div className="grid grid-cols-2 gap-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 p-3 text-xs">
              <div>
                <span className="block text-[11px] text-slate-500 dark:text-slate-400">Purchase Order Total</span>
                <span className="font-mono text-sm font-bold text-slate-900 dark:text-slate-50">{formatPHP(signaturePo.total_amount)}</span>
              </div>
              <div>
                <span className="block text-[11px] text-slate-500 dark:text-slate-400">Approval Threshold</span>
                <span className="font-mono text-sm font-semibold text-violet-800 dark:text-violet-300">{formatPHP(approvalThreshold)}</span>
              </div>
              <div className="col-span-2 border-t border-slate-200 dark:border-slate-800 pt-2 text-[11px] text-slate-600 dark:text-slate-300">
                Stage 1 Verified By: <span className="font-semibold text-slate-900 dark:text-slate-50">{signaturePo.stage1_approved_by_name || user.fullName}</span>
                {signaturePo.stage1_approved_at ? ` · ${formatAuditTimestamp(signaturePo.stage1_approved_at)}` : ''}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-200 mb-1">Signing Manager Name</label>
              <input
                type="text"
                required
                value={signerName}
                onChange={(e) => setSignerName(e.target.value)}
                placeholder="Full name of authorizing manager"
                className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-medium text-slate-900 dark:text-slate-50"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-200">Draw Digital Signature</label>
                <button
                  type="button"
                  onClick={clearSignatureCanvas}
                  className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-1 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <RotateCcw className="w-3 h-3" /> Clear Pad
                </button>
              </div>
              <div className="relative rounded-lg border-2 border-dashed border-slate-300 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/50 overflow-hidden">
                {!hasSignatureStroke && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-slate-500 dark:text-slate-400">
                    Sign here using mouse or touch
                  </div>
                )}
                <div className="pointer-events-none absolute left-6 right-6 bottom-6 border-b border-slate-300 dark:border-slate-700" />
                <canvas
                  ref={sigCanvasRef}
                  width={520}
                  height={170}
                  onPointerDown={handleSigPointerDown}
                  onPointerMove={handleSigPointerMove}
                  onPointerUp={handleSigPointerUp}
                  onPointerCancel={handleSigPointerUp}
                  className="relative z-10 w-full h-40 touch-none cursor-crosshair block"
                />
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                {hasSignatureStroke
                  ? 'Signature captured and ready to attach to the purchase order approval record.'
                  : 'Signature stroke required before final approval.'}
              </p>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800/80">
              <button
                type="button"
                onClick={() => setSignaturePo(null)}
                className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                Leave Pending Signature
              </button>
              <button
                type="submit"
                disabled={submittingSignature}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-violet-700 text-white text-xs font-semibold hover:bg-violet-800 disabled:opacity-50"
              >
                <PenTool className="w-3.5 h-3.5" />
                {submittingSignature ? 'Signing & Approving...' : 'Apply Signature & Approve'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
