import React, { useEffect, useMemo, useState } from 'react';
import {
  Search,
  Wifi,
  WifiOff,
  RefreshCw,
  Printer,
  Trash2,
  Plus,
  Minus,
  RotateCcw,
  ChefHat,
  Utensils,
} from 'lucide-react';
import { apiFetch, formatPHP } from '../lib/api.ts';
import { AuthUser, LocationRow, PERMISSIONS } from '../types/erp.ts';

interface Props {
  mode: 'pos' | 'kds';
  user: AuthUser;
  locations: LocationRow[];
  activeLocationId: string;
}

interface CartLine {
  key: string;
  productId: string;
  name: string;
  variantId?: string;
  variantName: string;
  unitPrice: number;
  quantity: number;
  modifiers: Array<{ id: string; name: string; priceDelta: number }>;
  kitchenNotes: string;
}

const OFFLINE_QUEUE_KEY = 'maximus_bbq_offline_pos_queue';

export function PosAndKdsModule({ mode, user, locations, activeLocationId }: Props) {
  const truckLocations = useMemo(() => locations.filter((l) => l.type === 'FOOD_TRUCK'), [locations]);
  const [posLocationId, setPosLocationId] = useState<string>(
    activeLocationId !== 'ALL' && truckLocations.some((t) => t.id === activeLocationId)
      ? activeLocationId
      : truckLocations[0]?.id || '',
  );

  // Catalog & POS state
  const [categories, setCategories] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [activeCat, setActiveCat] = useState('ALL');
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [channel, setChannel] = useState('WALK_IN');
  const [discountAmount, setDiscountAmount] = useState(0);
  const [orderNotes, setOrderNotes] = useState('');

  // Split payment lines
  const [paymentRows, setPaymentRows] = useState<Array<{ method: string; amount: string; referenceNo: string }>>([
    { method: 'CASH', amount: '', referenceNo: '' },
  ]);

  // Customize product modal
  const [customizingProduct, setCustomizingProduct] = useState<any>(null);
  const [selVariantId, setSelVariantId] = useState<string>('');
  const [selModIds, setSelModIds] = useState<string[]>([]);
  const [itemKitchenNote, setItemKitchenNote] = useState('');

  // Offline Queue & Sales History / Refunds
  const [simulateOffline, setSimulateOffline] = useState(false);
  const [offlineQueue, setOfflineQueue] = useState<any[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]');
    } catch {
      return [];
    }
  });
  const [submitting, setSubmitting] = useState(false);
  const [receiptModal, setReceiptModal] = useState<any>(null);
  const [salesHistory, setSalesHistory] = useState<any[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [refundTarget, setRefundTarget] = useState<any>(null);
  const [refundReason, setRefundReason] = useState('');
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

  // KDS state
  const [kdsOrders, setKdsOrders] = useState<any[]>([]);

  const canRefund = user.roleCode === 'SUPER_ADMIN' || user.roleCode === 'BUSINESS_OWNER' || user.permissions.includes(PERMISSIONS.POS_REFUND);

  const loadPosData = async () => {
    try {
      const [catRes, histRes] = await Promise.all([
        apiFetch('/pos/catalog'),
        apiFetch(`/pos/sales${posLocationId ? `?locationId=${posLocationId}` : ''}`),
      ]);
      setCategories(catRes.categories || []);
      setProducts(catRes.products || []);
      setCustomers(catRes.customers || []);
      setSalesHistory(histRes || []);
    } catch (e: any) {
      setFeedback({ type: 'err', msg: e.message });
    }
  };

  const loadKdsOrders = async () => {
    try {
      const data = await apiFetch(`/kds/orders${posLocationId ? `?locationId=${posLocationId}` : ''}`);
      setKdsOrders(data || []);
    } catch {
      // ignore if user lacks kds permission
    }
  };

  useEffect(() => {
    if (mode === 'pos') loadPosData();
    else loadKdsOrders();
  }, [mode, posLocationId]);

  useEffect(() => {
    if (mode !== 'kds') return;
    const t = setInterval(loadKdsOrders, 8000);
    return () => clearInterval(t);
  }, [mode, posLocationId]);

  const filteredProducts = useMemo(() => {
    return products.filter((p) => {
      const catOk = activeCat === 'ALL' || p.category_id === activeCat;
      const qOk = p.name.toLowerCase().includes(search.toLowerCase()) || p.sku.toLowerCase().includes(search.toLowerCase());
      return catOk && qOk;
    });
  }, [products, activeCat, search]);

  const openProductCustomizer = (product: any) => {
    if (!product.variants?.length && !product.modifiers?.length) {
      addLineToCart(product, undefined, [], '');
      return;
    }
    setCustomizingProduct(product);
    setSelVariantId(product.variants?.[0]?.id || '');
    setSelModIds([]);
    setItemKitchenNote('');
  };

  const addLineToCart = (
    product: any,
    variant: any,
    mods: Array<{ id: string; name: string; price_delta: number }>,
    kitchenNotes: string,
  ) => {
    const modKey = mods.map((m) => m.id).sort().join(',');
    const key = `${product.id}:${variant?.id || 'base'}:${modKey}:${kitchenNotes}`;
    const unitPrice =
      Number(product.base_price) +
      (variant ? Number(variant.price_delta) : 0) +
      mods.reduce((s, m) => s + Number(m.price_delta), 0);

    setCart((prev) => {
      const existing = prev.find((i) => i.key === key);
      if (existing) {
        return prev.map((i) => (i.key === key ? { ...i, quantity: i.quantity + 1 } : i));
      }
      return [
        ...prev,
        {
          key,
          productId: product.id,
          name: product.name,
          variantId: variant?.id,
          variantName: variant?.name || 'Standard',
          unitPrice,
          quantity: 1,
          modifiers: mods.map((m) => ({ id: m.id, name: m.name, priceDelta: Number(m.price_delta) })),
          kitchenNotes,
        },
      ];
    });
  };

  const cartGross = useMemo(() => cart.reduce((s, i) => s + i.unitPrice * i.quantity, 0), [cart]);
  const cartTotal = Math.max(0, cartGross - discountAmount);
  const totalTendered = paymentRows.reduce((s, p) => s + (Number(p.amount) || 0), 0);

  const syncOfflineOrders = async () => {
    if (simulateOffline || !navigator.onLine || offlineQueue.length === 0) return;
    setSubmitting(true);
    try {
      const res = await apiFetch('/pos/sales/sync-offline', {
        method: 'POST',
        body: JSON.stringify({ sales: offlineQueue }),
      });
      localStorage.removeItem(OFFLINE_QUEUE_KEY);
      setOfflineQueue([]);
      setFeedback({ type: 'ok', msg: `Synced ${res.syncedCount} offline order(s) and updated FIFO inventory & GL.` });
      await loadPosData();
    } catch (err: any) {
      setFeedback({ type: 'err', msg: err.message });
    } finally {
      setSubmitting(false);
    }
  };

  const handleCheckout = async () => {
    if (!cart.length || !posLocationId) return;
    setSubmitting(true);
    setFeedback(null);

    const effectivePayments = paymentRows.map((p, idx) => ({
      method: p.method,
      amount: p.amount ? Number(p.amount) : idx === 0 && paymentRows.length === 1 ? cartTotal : 0,
      referenceNo: p.referenceNo || undefined,
    }));

    const payload = {
      clientTxnId: crypto.randomUUID(),
      locationId: posLocationId,
      customerId: selectedCustomerId || undefined,
      channel,
      discountAmount,
      notes: orderNotes,
      soldAt: new Date().toISOString(),
      items: cart.map((c) => ({
        productId: c.productId,
        variantId: c.variantId,
        quantity: c.quantity,
        modifiers: c.modifiers,
        kitchenNotes: c.kitchenNotes,
      })),
      payments: effectivePayments,
    };

    try {
      if (simulateOffline || !navigator.onLine) {
        const next = [...offlineQueue, payload];
        localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(next));
        setOfflineQueue(next);
        setReceiptModal({
          receipt_number: `OFFLINE-${payload.clientTxnId.slice(0, 6).toUpperCase()}`,
          total_amount: cartTotal,
          items: cart.map((c) => ({ product_name: c.name, variant_name: c.variantName, quantity: c.quantity, line_total: c.unitPrice * c.quantity })),
          payments: effectivePayments,
          offline: true,
        });
        setFeedback({ type: 'ok', msg: 'Order saved to offline queue. Will sync when connection restores.' });
      } else {
        const sale = await apiFetch('/pos/sales', { method: 'POST', body: JSON.stringify(payload) });
        setReceiptModal(sale);
        setFeedback({ type: 'ok', msg: `Sale ${sale.receipt_number} completed · Inventory & General Ledger updated.` });
        await loadPosData();
      }
      setCart([]);
      setDiscountAmount(0);
      setOrderNotes('');
      setPaymentRows([{ method: 'CASH', amount: '', referenceNo: '' }]);
    } catch (err: any) {
      setFeedback({ type: 'err', msg: err.message });
    } finally {
      setSubmitting(false);
    }
  };

  const handleRefund = async () => {
    if (!refundTarget) return;
    try {
      await apiFetch(`/pos/sales/${refundTarget.id}/refund`, {
        method: 'POST',
        body: JSON.stringify({ reason: refundReason || 'Customer refund' }),
      });
      setRefundTarget(null);
      setRefundReason('');
      setFeedback({ type: 'ok', msg: 'Refund processed and reversing Journal Entry posted.' });
      await loadPosData();
    } catch (err: any) {
      setFeedback({ type: 'err', msg: err.message });
    }
  };

  const advanceKds = async (saleId: string, nextStatus: string) => {
    try {
      await apiFetch(`/kds/orders/${saleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ kdsStatus: nextStatus }),
      });
      await loadKdsOrders();
    } catch (err: any) {
      setFeedback({ type: 'err', msg: err.message });
    }
  };

  // ==========================================
  // KITCHEN DISPLAY SYSTEM (KDS) VIEW
  // ==========================================
  if (mode === 'kds') {
    const lanes = [
      { key: 'PENDING', label: 'New Orders', next: 'PREPARING', btnLabel: 'Start Prep' },
      { key: 'PREPARING', label: 'On the Grill', next: 'READY', btnLabel: 'Mark Ready' },
      { key: 'READY', label: 'Ready for Pickup', next: 'COMPLETED', btnLabel: 'Handed Off' },
    ];
    return (
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-semibold text-slate-900 flex items-center gap-2">
              <ChefHat className="w-6 h-6 text-slate-700" />
              Kitchen Display System (KDS)
            </h1>
            <p className="text-sm text-slate-500">Live preparation queue across active food trucks</p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={posLocationId}
              onChange={(e) => setPosLocationId(e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium"
            >
              <option value="">All Trucks</option>
              {truckLocations.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <button
              onClick={loadKdsOrders}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium hover:bg-slate-50"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh Queue
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {lanes.map((lane) => {
            const laneOrders = kdsOrders.filter((o) => o.kds_status === lane.key);
            return (
              <div key={lane.key} className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                  <h2 className="font-display text-sm font-semibold text-slate-900">{lane.label}</h2>
                  <span className="font-mono text-xs text-slate-500">{laneOrders.length} tickets</span>
                </div>
                {laneOrders.length === 0 ? (
                  <p className="py-10 text-center text-xs text-slate-400">No tickets in {lane.label.toLowerCase()}</p>
                ) : (
                  laneOrders.map((ord) => (
                    <div key={ord.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 space-y-2.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-mono font-semibold text-slate-900">{ord.receipt_number}</span>
                        <span className="text-slate-500">{ord.channel} · {ord.location_name}</span>
                      </div>
                      <ul className="space-y-1.5 text-sm">
                        {ord.items.map((it: any) => (
                          <li key={it.id} className="text-slate-800">
                            <span className="font-mono font-semibold mr-1.5">{it.quantity}x</span>
                            <span className="font-medium">{it.product_name}</span>
                            {it.variant_name && it.variant_name !== 'Standard' && (
                              <span className="text-xs text-slate-500 ml-1">({it.variant_name})</span>
                            )}
                            {it.kitchen_notes && (
                              <p className="text-xs text-amber-700 ml-6">Note: {it.kitchen_notes}</p>
                            )}
                          </li>
                        ))}
                      </ul>
                      {ord.notes && <p className="text-xs text-slate-600 italic">Order note: {ord.notes}</p>}
                      <button
                        onClick={() => advanceKds(ord.id, lane.next)}
                        className="w-full rounded-lg bg-slate-900 py-2 text-xs font-semibold text-white hover:bg-slate-800"
                      >
                        {lane.btnLabel}
                      </button>
                    </div>
                  ))
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ==========================================
  // POINT OF SALE (POS) TERMINAL VIEW
  // ==========================================
  return (
    <div className="space-y-4">
      {/* POS Top Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={posLocationId}
            onChange={(e) => setPosLocationId(e.target.value)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-800"
          >
            {truckLocations.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>

          <button
            onClick={() => setSimulateOffline((v) => !v)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium whitespace-nowrap shrink-0 ${
              simulateOffline
                ? 'border-amber-300 bg-amber-50 text-amber-800'
                : 'border-slate-200 bg-white text-slate-700'
            }`}
          >
            {simulateOffline ? <WifiOff className="w-3.5 h-3.5" /> : <Wifi className="w-3.5 h-3.5 text-emerald-600" />}
            {simulateOffline ? 'Offline Mode Active' : 'Online · Auto-Sync'}
          </button>

          {offlineQueue.length > 0 && (
            <button
              onClick={syncOfflineOrders}
              disabled={simulateOffline || submitting}
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Sync {offlineQueue.length} Queued
            </button>
          )}
        </div>

        <button
          onClick={() => setShowHistory((h) => !h)}
          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
        >
          {showHistory ? 'Back to Register' : `Sales History & Refunds (${salesHistory.length})`}
        </button>
      </div>

      {feedback && (
        <div
          className={`p-3 rounded-lg border text-xs font-medium ${
            feedback.type === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}
        >
          {feedback.msg}
        </div>
      )}

      {showHistory ? (
        <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr>
                <th className="p-3 font-medium">Receipt #</th>
                <th className="p-3 font-medium">Date / Time</th>
                <th className="p-3 font-medium">Truck</th>
                <th className="p-3 font-medium">Channel · Status</th>
                <th className="p-3 font-medium text-right">Total</th>
                <th className="p-3 font-medium text-right">COGS</th>
                <th className="p-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {salesHistory.map((s) => (
                <tr key={s.id} className="hover:bg-slate-50">
                  <td className="p-3 font-mono font-semibold text-slate-900">{s.receipt_number}</td>
                  <td className="p-3 font-mono text-slate-500">{String(s.sold_at).slice(0, 16).replace('T', ' ')}</td>
                  <td className="p-3 text-slate-700">{s.location_name}</td>
                  <td className="p-3">
                    <span className={s.status === 'REFUNDED' ? 'text-red-700 font-semibold' : 'text-emerald-700 font-medium'}>
                      {s.channel} · {s.status}
                    </span>
                  </td>
                  <td className="p-3 text-right font-mono tabular-nums font-semibold">{formatPHP(s.total_amount)}</td>
                  <td className="p-3 text-right font-mono tabular-nums text-slate-500">{formatPHP(s.total_cogs)}</td>
                  <td className="p-3 text-right space-x-2">
                    <button onClick={() => setReceiptModal(s)} className="text-slate-700 hover:underline">Receipt</button>
                    {s.status === 'COMPLETED' && canRefund && (
                      <button
                        onClick={() => setRefundTarget(s)}
                        className="inline-flex items-center gap-1 text-red-700 hover:underline"
                      >
                        <RotateCcw className="w-3 h-3" /> Refund
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          {/* Left 7 cols: Menu Catalog */}
          <div className="lg:col-span-7 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="search"
                  placeholder="Search dishes or SKU..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
              </div>
              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg border border-slate-200 overflow-x-auto">
                <button
                  onClick={() => setActiveCat('ALL')}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 ${
                    activeCat === 'ALL' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                  }`}
                >
                  All
                </button>
                {categories.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setActiveCat(c.id)}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 ${
                      activeCat === c.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
                    }`}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3.5">
              {filteredProducts.map((p) => (
                <button
                  key={p.id}
                  onClick={() => openProductCustomizer(p)}
                  className="group text-left rounded-xl border border-slate-200 bg-white overflow-hidden hover:border-slate-900 transition-colors flex flex-col"
                >
                  <div className="aspect-[4/3] w-full bg-slate-100 overflow-hidden relative">
                    {p.image_url ? (
                      <img
                        src={p.image_url}
                        alt={p.name}
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200 text-slate-400">
                        <Utensils className="w-7 h-7" />
                      </div>
                    )}
                  </div>
                  <div className="p-3 flex-1 flex flex-col justify-between">
                    <div>
                      <p className="text-[11px] text-slate-500">{p.category_name} · {p.sku}</p>
                      <p className="mt-0.5 text-sm font-semibold text-slate-900 line-clamp-2">{p.name}</p>
                    </div>
                    <p className="mt-2 font-mono tabular-nums text-base font-bold text-slate-900">
                      {formatPHP(p.base_price)}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Right 5 cols: Cart & Split Payments */}
          <div className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-4 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h2 className="font-display text-base font-semibold text-slate-900">Active Order Ticket</h2>
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                className="rounded-md border border-slate-200 px-2 py-1 text-xs font-medium"
              >
                <option value="WALK_IN">Walk-in</option>
                <option value="TAKEOUT">Takeout</option>
                <option value="ONLINE">Online</option>
                <option value="PRE_ORDER">Pre-Order</option>
                <option value="CATERING">Catering</option>
              </select>
            </div>

            <div>
              <select
                value={selectedCustomerId}
                onChange={(e) => setSelectedCustomerId(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-700"
              >
                <option value="">Walk-in Guest (No Loyalty Profile)</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.full_name} · {c.tier} ({c.loyalty_points} pts)
                  </option>
                ))}
              </select>
            </div>

            <div className="max-h-60 overflow-y-auto divide-y divide-slate-100">
              {cart.length === 0 ? (
                <p className="py-10 text-center text-xs text-slate-400">Select dishes on the left to build order</p>
              ) : (
                cart.map((line) => (
                  <div key={line.key} className="py-2.5 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900">{line.name}</p>
                      <p className="text-xs text-slate-500">
                        {line.variantName}
                        {line.modifiers.length > 0 && ` · +${line.modifiers.map((m) => m.name).join(', ')}`}
                      </p>
                      {line.kitchenNotes && <p className="text-xs text-amber-700">Note: {line.kitchenNotes}</p>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() =>
                          setCart((prev) =>
                            prev
                              .map((x) => (x.key === line.key ? { ...x, quantity: x.quantity - 1 } : x))
                              .filter((x) => x.quantity > 0),
                          )
                        }
                        className="w-7 h-7 rounded border border-slate-200 flex items-center justify-center hover:bg-slate-50"
                      >
                        <Minus className="w-3 h-3" />
                      </button>
                      <span className="w-5 text-center font-mono text-xs font-semibold">{line.quantity}</span>
                      <button
                        onClick={() =>
                          setCart((prev) => prev.map((x) => (x.key === line.key ? { ...x, quantity: x.quantity + 1 } : x)))
                        }
                        className="w-7 h-7 rounded border border-slate-200 flex items-center justify-center hover:bg-slate-50"
                      >
                        <Plus className="w-3 h-3" />
                      </button>
                      <span className="w-20 text-right font-mono tabular-nums text-xs font-semibold">
                        {formatPHP(line.unitPrice * line.quantity)}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="space-y-2 border-t border-slate-100 pt-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-slate-600">Discount (PHP)</span>
                <input
                  type="number"
                  min={0}
                  value={discountAmount}
                  onChange={(e) => setDiscountAmount(Math.max(0, Number(e.target.value)))}
                  className="w-24 rounded border border-slate-200 px-2 py-1 text-right font-mono"
                />
              </div>
              <input
                type="text"
                placeholder="Order notes / table buzzer #..."
                value={orderNotes}
                onChange={(e) => setOrderNotes(e.target.value)}
                className="w-full rounded border border-slate-200 px-2.5 py-1.5 text-xs"
              />
              <div className="flex items-center justify-between pt-1 text-base font-bold text-slate-900">
                <span>Total Due (VAT Incl.)</span>
                <span className="font-mono tabular-nums text-lg">{formatPHP(cartTotal)}</span>
              </div>
            </div>

            {/* Split Payments */}
            <div className="space-y-2 border-t border-slate-100 pt-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-700">Payment Tender (Split Supported)</span>
                <button
                  type="button"
                  onClick={() => setPaymentRows((r) => [...r, { method: 'E_WALLET', amount: '', referenceNo: '' }])}
                  className="text-xs font-medium text-slate-700 hover:underline"
                >
                  + Add Split
                </button>
              </div>
              {paymentRows.map((row, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-1.5 items-center">
                  <select
                    value={row.method}
                    onChange={(e) =>
                      setPaymentRows((prev) => prev.map((r, i) => (i === idx ? { ...r, method: e.target.value } : r)))
                    }
                    className="col-span-5 rounded border border-slate-200 px-2 py-1.5 text-xs"
                  >
                    <option value="CASH">Cash</option>
                    <option value="E_WALLET">E-Wallet (GCash/Maya)</option>
                    <option value="CARD">Credit/Debit Card</option>
                    <option value="BANK_TRANSFER">Bank Transfer</option>
                  </select>
                  <input
                    type="number"
                    placeholder={idx === 0 && paymentRows.length === 1 ? String(cartTotal) : 'Amount'}
                    value={row.amount}
                    onChange={(e) =>
                      setPaymentRows((prev) => prev.map((r, i) => (i === idx ? { ...r, amount: e.target.value } : r)))
                    }
                    className="col-span-4 rounded border border-slate-200 px-2 py-1.5 text-xs font-mono text-right"
                  />
                  <input
                    type="text"
                    placeholder="Ref #"
                    value={row.referenceNo}
                    onChange={(e) =>
                      setPaymentRows((prev) => prev.map((r, i) => (i === idx ? { ...r, referenceNo: e.target.value } : r)))
                    }
                    className="col-span-2 rounded border border-slate-200 px-1.5 py-1.5 text-xs"
                  />
                  {paymentRows.length > 1 && (
                    <button
                      onClick={() => setPaymentRows((prev) => prev.filter((_, i) => i !== idx))}
                      className="col-span-1 text-slate-400 hover:text-red-600 flex justify-center"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
              {totalTendered > cartTotal && (
                <p className="text-xs font-mono text-emerald-700 text-right">
                  Change Due: {formatPHP(totalTendered - cartTotal)}
                </p>
              )}
            </div>

            <button
              disabled={!cart.length || submitting}
              onClick={handleCheckout}
              className="w-full rounded-lg bg-emerald-600 py-3 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-40"
            >
              {submitting ? 'Recording Sale & Deducting FIFO Stock...' : `Charge ${formatPHP(cartTotal)}`}
            </button>
          </div>
        </div>
      )}

      {/* Product Variant & Modifier Modal */}
      {customizingProduct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-5 space-y-4 border border-slate-200">
            <h3 className="font-display text-lg font-semibold text-slate-900">{customizingProduct.name}</h3>
            {customizingProduct.variants?.length > 0 && (
              <div>
                <p className="text-xs font-medium text-slate-600 mb-2">Size / Variant</p>
                <div className="grid grid-cols-2 gap-2">
                  {customizingProduct.variants.map((v: any) => (
                    <button
                      key={v.id}
                      onClick={() => setSelVariantId(v.id)}
                      className={`p-2.5 rounded-lg border text-left text-xs ${
                        selVariantId === v.id ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200'
                      }`}
                    >
                      <p className="font-semibold">{v.name}</p>
                      <p className="font-mono opacity-80">+{formatPHP(v.price_delta)}</p>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {customizingProduct.modifiers?.length > 0 && (
              <div>
                <p className="text-xs font-medium text-slate-600 mb-2">Add-ons &amp; Modifiers</p>
                <div className="space-y-1.5">
                  {customizingProduct.modifiers.map((m: any) => {
                    const checked = selModIds.includes(m.id);
                    return (
                      <label key={m.id} className="flex items-center justify-between p-2 rounded-lg border border-slate-200 text-xs cursor-pointer">
                        <span className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setSelModIds((prev) =>
                                checked ? prev.filter((x) => x !== m.id) : [...prev, m.id],
                              )
                            }
                          />
                          {m.name}
                        </span>
                        <span className="font-mono">+{formatPHP(m.price_delta)}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Kitchen Instruction</label>
              <input
                type="text"
                placeholder="e.g. No chili, extra calamansi..."
                value={itemKitchenNote}
                onChange={(e) => setItemKitchenNote(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setCustomizingProduct(null)} className="px-4 py-2 rounded-lg border text-xs font-medium">
                Cancel
              </button>
              <button
                onClick={() => {
                  const variant = customizingProduct.variants?.find((v: any) => v.id === selVariantId);
                  const mods = (customizingProduct.modifiers || []).filter((m: any) => selModIds.includes(m.id));
                  addLineToCart(customizingProduct, variant, mods, itemKitchenNote);
                  setCustomizingProduct(null);
                }}
                className="px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold"
              >
                Add to Order
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Printable Receipt Modal */}
      {receiptModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-xl bg-white p-6 space-y-4 border border-slate-200">
            <div className="text-center border-b border-dashed border-slate-300 pb-3 space-y-1">
              <img
                src="/assets/aistudio/Logo_836b4628.png"
                alt="Maximus Barbecue Logo"
                referrerPolicy="no-referrer"
                className="w-12 h-12 mx-auto rounded-full object-contain"
              />
              <h3 className="font-display font-bold text-base">Maximus Barbecue ERP</h3>
              <p className="text-xs text-slate-500 font-mono mt-0.5">{receiptModal.receipt_number}</p>
              {receiptModal.offline && <p className="text-xs text-amber-700 font-medium mt-1">OFFLINE QUEUED RECEIPT</p>}
            </div>
            <div className="space-y-1.5 text-xs">
              {(receiptModal.items || []).map((it: any, idx: number) => (
                <div key={idx} className="flex justify-between">
                  <span>{it.quantity}x {it.product_name}</span>
                  <span className="font-mono tabular-nums">{formatPHP(it.line_total)}</span>
                </div>
              ))}
            </div>
            <div className="border-t border-dashed border-slate-300 pt-2.5 flex justify-between font-bold text-sm">
              <span>TOTAL</span>
              <span className="font-mono tabular-nums">{formatPHP(receiptModal.total_amount)}</span>
            </div>
            <div className="flex justify-end gap-2 no-print pt-2">
              <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium">
                <Printer className="w-3.5 h-3.5" /> Print
              </button>
              <button onClick={() => setReceiptModal(null)} className="px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold">
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Refund Authorization Modal */}
      {refundTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-5 space-y-4 border border-slate-200">
            <h3 className="font-display text-base font-semibold text-slate-900">
              Authorize Refund — {refundTarget.receipt_number}
            </h3>
            <p className="text-xs text-slate-600">
              Refunding {formatPHP(refundTarget.total_amount)} will preserve the audit trail and automatically post an equal-and-opposite reversing Journal Entry.
            </p>
            <input
              type="text"
              placeholder="Reason for refund (required for audit log)"
              value={refundReason}
              onChange={(e) => setRefundReason(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setRefundTarget(null)} className="px-4 py-2 rounded-lg border text-xs font-medium">Cancel</button>
              <button onClick={handleRefund} className="px-4 py-2 rounded-lg bg-red-600 text-white text-xs font-semibold">
                Confirm Refund
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
