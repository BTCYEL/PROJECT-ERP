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
  SlidersHorizontal,
  QrCode,
  Copy,
  Check,
  ExternalLink,
  Bluetooth,
  Download,
} from 'lucide-react';
import QRCode from 'qrcode';
import { apiFetch, downloadCsv, formatPHP } from '../lib/api.ts';
import { DailyHuddleItem } from '../lib/dailyHuddle.ts';
import { buildDigitalReceiptUrl, DigitalReceiptData, extractDigitalReceiptFromSale } from '../lib/digitalReceipt.ts';
import {
  clearTerminalPrinterConfig,
  getSavedTerminalPrinterConfig,
  printerMappingFromDeviceRow,
  reconnectBluetoothPrinter,
  saveTerminalPrinterConfig,
  sendBluetoothReceiptPrint,
  sendThermalReceiptPrint,
  TerminalPrinterMapping,
  ThermalReceiptPayload,
} from '../lib/printerDiscovery.ts';
import { getOrCreateHardwareUuid } from '../lib/terminalAuth.ts';
import { AuthUser, LocationRow, PERMISSIONS } from '../types/erp.ts';
import { DailyHuddleBanner } from './DailyHuddleBanner.tsx';
import { PublicDigitalReceiptView } from './PublicDigitalReceiptView.tsx';

interface Props {
  mode: 'pos' | 'kds';
  user: AuthUser;
  locations: LocationRow[];
  activeLocationId: string;
  onLocationChange?: (locationId: string) => void;
  onLocationsChanged?: () => Promise<void> | void;
  huddles?: DailyHuddleItem[];
  onAcknowledgeHuddle?: (huddleId: string) => Promise<void> | void;
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

const isLocationKdsEnabled = (loc?: LocationRow | null): boolean => {
  if (!loc) return true;
  return loc.kds_enabled === undefined ? loc.type === 'FOOD_TRUCK' : loc.kds_enabled === 1;
};

export function PosAndKdsModule({
  mode,
  user,
  locations,
  activeLocationId,
  onLocationChange,
  onLocationsChanged,
  huddles,
  onAcknowledgeHuddle,
}: Props) {
  const [localHuddles, setLocalHuddles] = useState<DailyHuddleItem[]>([]);

  useEffect(() => {
    if (huddles !== undefined) return;
    let cancelled = false;
    apiFetch<DailyHuddleItem[]>('/huddles')
      .then((rows) => {
        if (!cancelled) setLocalHuddles(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [huddles]);

  const resolvedHuddles = huddles ?? localHuddles;

  const handleHuddleAcknowledge = async (huddleId: string) => {
    if (onAcknowledgeHuddle) {
      await onAcknowledgeHuddle(huddleId);
      return;
    }
    const updated = await apiFetch<DailyHuddleItem>(`/huddles/${huddleId}/acknowledge`, { method: 'POST' });
    setLocalHuddles((prev) => prev.map((h) => (h.id === huddleId ? updated : h)));
  };

  const posSelectableLocations = useMemo(
    () => locations.filter((l) => l.type === 'FOOD_TRUCK' || isLocationKdsEnabled(l)),
    [locations],
  );
  const kdsSelectableLocations = useMemo(
    () => locations.filter((l) => isLocationKdsEnabled(l)),
    [locations],
  );
  const selectableLocations = mode === 'kds' ? kdsSelectableLocations : posSelectableLocations;

  const [posLocationId, setPosLocationId] = useState<string>(
    activeLocationId !== 'ALL' && locations.some((t) => t.id === activeLocationId)
      ? activeLocationId
      : mode === 'kds'
        ? ''
        : posSelectableLocations[0]?.id || '',
  );

  useEffect(() => {
    if (activeLocationId !== 'ALL' && locations.some((t) => t.id === activeLocationId)) {
      if (mode === 'kds' || posSelectableLocations.some((t) => t.id === activeLocationId)) {
        setPosLocationId(activeLocationId);
      } else {
        setPosLocationId((prev) => (posSelectableLocations.some((t) => t.id === prev) ? prev : posSelectableLocations[0]?.id || ''));
      }
    } else if (activeLocationId === 'ALL') {
      if (mode === 'kds') {
        setPosLocationId('');
      } else {
        setPosLocationId((prev) => (posSelectableLocations.some((t) => t.id === prev) ? prev : posSelectableLocations[0]?.id || ''));
      }
    }
  }, [activeLocationId, mode, locations, posSelectableLocations]);

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
  const [receiptQrDataUrl, setReceiptQrDataUrl] = useState('');
  const [receiptShareUrl, setReceiptShareUrl] = useState('');
  const [copiedQrLink, setCopiedQrLink] = useState(false);
  const [previewDigitalReceipt, setPreviewDigitalReceipt] = useState<DigitalReceiptData | null>(null);
  const [salesHistory, setSalesHistory] = useState<any[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [refundTarget, setRefundTarget] = useState<any>(null);
  const [refundReason, setRefundReason] = useState('');
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);
  const [mappedPrinter, setMappedPrinter] = useState<TerminalPrinterMapping | null>(() => getSavedTerminalPrinterConfig());
  const [thermalPrintState, setThermalPrintState] = useState<{ busy: boolean; msg?: string; err?: string } | null>(null);

  // KDS state
  const [kdsOrders, setKdsOrders] = useState<any[]>([]);
  const [showKdsSettings, setShowKdsSettings] = useState(false);
  const [togglingKdsLocId, setTogglingKdsLocId] = useState<string | null>(null);

  const canRefund = user.roleCode === 'SUPER_ADMIN' || user.roleCode === 'BUSINESS_OWNER' || user.permissions.includes(PERMISSIONS.POS_REFUND);
  const canManageFleet = user.roleCode === 'SUPER_ADMIN' || user.roleCode === 'BUSINESS_OWNER' || user.permissions.includes(PERMISSIONS.FLEET_MANAGE);
  const selectedLocationObj = useMemo(() => locations.find((l) => l.id === posLocationId) || null, [locations, posLocationId]);
  const selectedLocKdsEnabled = selectedLocationObj ? isLocationKdsEnabled(selectedLocationObj) : kdsSelectableLocations.length > 0;

  useEffect(() => {
    if (mode !== 'pos') return;
    let cancelled = false;
    const hwUuid = getOrCreateHardwareUuid();
    apiFetch<{ device: any | null }>(`/settings/devices/current?hardwareUuid=${encodeURIComponent(hwUuid)}`)
      .then((res) => {
        if (cancelled) return;
        const dev = res?.device;
        const synced = printerMappingFromDeviceRow(dev, hwUuid);
        if (synced) {
          saveTerminalPrinterConfig(synced);
          setMappedPrinter(synced);
        } else if (dev && (dev.status === 'REVOKED' || (!dev.printer_ip && !dev.printer_bt_device_id))) {
          clearTerminalPrinterConfig();
          setMappedPrinter(null);
        } else {
          setMappedPrinter(getSavedTerminalPrinterConfig());
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMappedPrinter(getSavedTerminalPrinterConfig());
        }
      });
    return () => {
      cancelled = true;
    };
  }, [mode]);

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

  const activeDigitalReceipt = useMemo<DigitalReceiptData | null>(() => {
    if (!receiptModal) return null;
    const receiptLoc = locations.find((l) => l.id === (receiptModal.location_id || posLocationId));
    return extractDigitalReceiptFromSale(receiptModal, receiptLoc);
  }, [receiptModal, locations, posLocationId]);

  useEffect(() => {
    if (!activeDigitalReceipt) {
      setReceiptQrDataUrl('');
      setReceiptShareUrl('');
      setCopiedQrLink(false);
      return;
    }
    let cancelled = false;
    const url = buildDigitalReceiptUrl(activeDigitalReceipt);
    setReceiptShareUrl(url);
    QRCode.toDataURL(url, {
      width: 200,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0f172a', light: '#ffffff' },
    })
      .then((dataUrl) => {
        if (!cancelled) setReceiptQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setReceiptQrDataUrl('');
      });
    return () => {
      cancelled = true;
    };
  }, [activeDigitalReceipt]);

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
        const activeLoc = locations.find((l) => l.id === posLocationId);
        let offlineSub = 0;
        let offlineTax = 0;
        for (const c of cart) {
          const prod = products.find((p) => p.id === c.productId);
          const lineGross = c.unitPrice * c.quantity;
          const rate = Number(prod?.rate_percent ?? 12);
          const isInc = prod?.is_inclusive !== 0;
          if (rate > 0) {
            const r = rate / 100;
            if (isInc) {
              const t = Math.round((lineGross - lineGross / (1 + r)) * 100) / 100;
              offlineTax += t;
              offlineSub += Math.round((lineGross - t) * 100) / 100;
            } else {
              const t = Math.round(lineGross * r * 100) / 100;
              offlineTax += t;
              offlineSub += lineGross;
            }
          } else {
            offlineSub += lineGross;
          }
        }
        setReceiptModal({
          receipt_number: `OFFLINE-${payload.clientTxnId.slice(0, 6).toUpperCase()}`,
          location_id: posLocationId,
          location_name: activeLoc?.name || 'Food Truck',
          location_address: activeLoc?.address || '',
          sold_at: payload.soldAt,
          subtotal: Math.round(offlineSub * 100) / 100,
          discount_amount: discountAmount,
          tax_amount: Math.round(offlineTax * 100) / 100,
          total_amount: cartTotal,
          items: cart.map((c) => ({ product_name: c.name, variant_name: c.variantName, quantity: c.quantity, line_total: c.unitPrice * c.quantity })),
          payments: effectivePayments,
          offline: true,
        });
        setFeedback({ type: 'ok', msg: 'Order saved to offline queue. Will sync when connection restores.' });
      } else {
        const sale = await apiFetch('/pos/sales', { method: 'POST', body: JSON.stringify(payload) });
        setThermalPrintState(null);
        setReceiptModal(sale);
        setFeedback({ type: 'ok', msg: `Sale ${sale.receipt_number} completed · Inventory & General Ledger updated.` });
        if (mappedPrinter?.autoPrint && (mappedPrinter.printerIp || mappedPrinter.btDeviceId)) {
          void printSaleToMappedThermalPrinter(sale, mappedPrinter);
        }
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

  const buildThermalReceiptPayload = (saleRow: any): ThermalReceiptPayload => {
    const loc = locations.find((l) => l.id === (saleRow.location_id || posLocationId));
    const digital = extractDigitalReceiptFromSale(saleRow, loc);
    return {
      businessName: 'MAXIMUS BARBECUE',
      locationName: saleRow.location_name || loc?.name || 'POS Terminal',
      locationAddress: saleRow.location_address || loc?.address || '',
      receiptNumber: String(saleRow.receipt_number || 'RECEIPT'),
      soldAt: saleRow.sold_at || new Date().toISOString(),
      cashierName: saleRow.cashier_name || user.fullName,
      customerName: saleRow.customer_name || null,
      orderChannel: saleRow.channel || 'WALK_IN',
      items: (saleRow.items || []).map((it: any) => {
        const qty = Number(it.quantity || 1);
        const lineTotal = Number(it.line_total ?? it.lineTotal ?? 0);
        const vName = it.variant_name ?? it.variantName;
        const baseName = String(it.product_name ?? it.productName ?? 'Item');
        return {
          name: vName && vName !== 'Standard' ? `${baseName} (${vName})` : baseName,
          qty,
          price: qty > 0 ? lineTotal / qty : lineTotal,
          lineTotal,
        };
      }),
      subtotal: Number(saleRow.subtotal ?? saleRow.total_amount ?? 0),
      taxAmount: Number(saleRow.tax_amount ?? 0),
      discountAmount: Number(saleRow.discount_amount ?? 0),
      totalAmount: Number(saleRow.total_amount ?? 0),
      payments: (saleRow.payments || []).map((p: any) => ({
        method: String(p.method || 'CASH'),
        amount: Number(p.amount || 0),
        reference: p.reference_no || p.referenceNo || null,
      })),
      shareUrl: buildDigitalReceiptUrl(digital),
    };
  };

  const printSaleToMappedThermalPrinter = async (saleRow: any, printerCfg?: TerminalPrinterMapping | null) => {
    const targetPrinter = printerCfg ?? mappedPrinter;
    if (!targetPrinter) return;
    setThermalPrintState({ busy: true });
    try {
      if (targetPrinter.connectionType === 'BLUETOOTH') {
        const res = await sendBluetoothReceiptPrint({
          btDeviceId: targetPrinter.btDeviceId,
          btServiceUuid: targetPrinter.btServiceUuid,
          btCharacteristicUuid: targetPrinter.btCharacteristicUuid,
          printerName: targetPrinter.printerName,
          paperWidthMm: targetPrinter.paperWidthMm,
          receipt: buildThermalReceiptPayload(saleRow),
        });
        setThermalPrintState({
          busy: false,
          msg: res.message || `Printed receipt via Bluetooth to ${targetPrinter.printerName}.`,
        });
        return;
      }

      if (!targetPrinter.printerIp) return;
      const res = await sendThermalReceiptPrint({
        ip: targetPrinter.printerIp,
        port: targetPrinter.printerPort || 9100,
        paperWidthMm: targetPrinter.paperWidthMm,
        receipt: buildThermalReceiptPayload(saleRow),
      });
      setThermalPrintState({
        busy: false,
        msg: res.message || `Printed receipt to ${targetPrinter.printerName} (${targetPrinter.printerIp}).`,
      });
    } catch (e: any) {
      setThermalPrintState({
        busy: false,
        err:
          e.message ||
          (targetPrinter.connectionType === 'BLUETOOTH'
            ? `Could not reach Bluetooth printer "${targetPrinter.printerName}".`
            : `Could not reach thermal printer at ${targetPrinter.printerIp}:${targetPrinter.printerPort}.`),
      });
    }
  };

  const handleReconnectBluetoothAndPrint = async (saleRow: any) => {
    if (!mappedPrinter || mappedPrinter.connectionType !== 'BLUETOOTH') return;
    setThermalPrintState({ busy: true });
    try {
      const reconnected = await reconnectBluetoothPrinter({
        btDeviceId: mappedPrinter.btDeviceId,
        btServiceUuid: mappedPrinter.btServiceUuid,
        btCharacteristicUuid: mappedPrinter.btCharacteristicUuid,
      });
      const updatedCfg: TerminalPrinterMapping = {
        ...mappedPrinter,
        btDeviceId: reconnected.btDeviceId,
        btServiceUuid: reconnected.btServiceUuid || mappedPrinter.btServiceUuid,
        btCharacteristicUuid: reconnected.btCharacteristicUuid || mappedPrinter.btCharacteristicUuid,
      };
      setMappedPrinter(updatedCfg);
      saveTerminalPrinterConfig(updatedCfg);
      await printSaleToMappedThermalPrinter(saleRow, updatedCfg);
    } catch (e: any) {
      setThermalPrintState({
        busy: false,
        err: e.message || 'Unable to reconnect Bluetooth thermal printer.',
      });
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

  const toggleLocationKds = async (loc: LocationRow, nextEnabled: boolean) => {
    setTogglingKdsLocId(loc.id);
    setFeedback(null);
    try {
      await apiFetch(`/fleet/locations/${loc.id}/kds`, {
        method: 'PATCH',
        body: JSON.stringify({ kdsEnabled: nextEnabled }),
      });
      await Promise.all([onLocationsChanged?.(), loadKdsOrders()]);
      setFeedback({
        type: 'ok',
        msg: `KDS ${nextEnabled ? 'enabled' : 'disabled'} for ${loc.name}.`,
      });
    } catch (err: any) {
      setFeedback({ type: 'err', msg: err.message || 'Failed to update KDS setting' });
    } finally {
      setTogglingKdsLocId(null);
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
    const currentLocationKdsDisabled = Boolean(selectedLocationObj && !isLocationKdsEnabled(selectedLocationObj));
    const allLocationsKdsDisabled = !selectedLocationObj && kdsSelectableLocations.length === 0;

    return (
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-semibold text-slate-900 dark:text-slate-50 flex items-center gap-2">
              <ChefHat className="w-6 h-6 text-slate-700 dark:text-slate-200" />
              Kitchen Display System (KDS)
            </h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">Live preparation queue across KDS-enabled trucks &amp; locations</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={posLocationId}
              onChange={(e) => {
                const val = e.target.value;
                setPosLocationId(val);
                onLocationChange?.(val || 'ALL');
              }}
              className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium"
            >
              <option value="">All KDS-Enabled Locations ({kdsSelectableLocations.length})</option>
              {kdsSelectableLocations.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
              {selectedLocationObj && !isLocationKdsEnabled(selectedLocationObj) && (
                <option value={selectedLocationObj.id}>{selectedLocationObj.name} (KDS Disabled)</option>
              )}
            </select>
            {canManageFleet && (
              <button
                type="button"
                onClick={() => setShowKdsSettings((v) => !v)}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium ${
                  showKdsSettings
                    ? 'border-slate-900 dark:border-slate-100 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950'
                    : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800'
                }`}
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                KDS Settings
              </button>
            )}
            <button
              onClick={loadKdsOrders}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh Queue
            </button>
          </div>
        </div>

        {feedback && (
          <div
            className={`p-3 rounded-lg border text-xs font-medium ${
              feedback.type === 'ok'
                ? 'bg-emerald-50 dark:bg-emerald-950/45 border-emerald-200 dark:border-emerald-700/80 text-emerald-800 dark:text-emerald-300'
                : 'bg-red-50 dark:bg-red-950/50 border-red-200 dark:border-red-800/80 text-red-700 dark:text-red-300'
            }`}
          >
            {feedback.msg}
          </div>
        )}

        <DailyHuddleBanner
          huddles={resolvedHuddles}
          user={user}
          channel="KDS"
          locationId={posLocationId || activeLocationId}
          onAcknowledge={handleHuddleAcknowledge}
        />

        {showKdsSettings && canManageFleet && (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-800/80 pb-2.5">
              <div>
                <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50">KDS Availability per Truck &amp; Location</h2>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Enable KDS to route POS orders into the prep queue, or disable KDS for direct POS order completion.
                </p>
              </div>
              <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                {kdsSelectableLocations.length} / {locations.length} enabled
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
              {locations.map((loc) => {
                const enabled = isLocationKdsEnabled(loc);
                return (
                  <div
                    key={loc.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/70 px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-slate-900 dark:text-slate-50 truncate">{loc.name}</p>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">
                        {loc.code} · {loc.type === 'COMMISSARY' ? 'Commissary' : 'Food Truck'}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={togglingKdsLocId === loc.id}
                      onClick={() => toggleLocationKds(loc, !enabled)}
                      className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap shrink-0 transition-colors disabled:opacity-50 ${
                        enabled
                          ? 'border-emerald-200 dark:border-emerald-700/80 bg-emerald-50 dark:bg-emerald-950/45 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/60'
                          : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                      }`}
                    >
                      {togglingKdsLocId === loc.id ? 'Saving...' : enabled ? 'Enabled' : 'Disabled'}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {currentLocationKdsDisabled || allLocationsKdsDisabled ? (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center space-y-3">
            <ChefHat className="w-8 h-8 text-slate-500 dark:text-slate-400 mx-auto" />
            <div className="space-y-1 max-w-md mx-auto">
              <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">
                {currentLocationKdsDisabled
                  ? `KDS is Disabled for ${selectedLocationObj?.name}`
                  : 'KDS is Disabled Across All Locations'}
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Orders completed at POS for {currentLocationKdsDisabled ? 'this truck / location' : 'disabled locations'} are marked completed immediately without entering the kitchen queue.
              </p>
            </div>
            {canManageFleet && (
              <div className="pt-1 flex justify-center gap-2">
                {currentLocationKdsDisabled && selectedLocationObj ? (
                  <button
                    type="button"
                    disabled={togglingKdsLocId === selectedLocationObj.id}
                    onClick={() => toggleLocationKds(selectedLocationObj, true)}
                    className="rounded-lg bg-slate-900 dark:bg-slate-100 px-4 py-2 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50"
                  >
                    {togglingKdsLocId === selectedLocationObj.id ? 'Enabling...' : `Enable KDS for ${selectedLocationObj.name}`}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowKdsSettings(true)}
                    className="rounded-lg bg-slate-900 dark:bg-slate-100 px-4 py-2 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white"
                  >
                    Configure KDS Locations
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            {lanes.map((lane) => {
              const laneOrders = kdsOrders.filter((o) => o.kds_status === lane.key);
              return (
                <div key={lane.key} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
                  <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800/80 pb-2.5">
                    <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50">{lane.label}</h2>
                    <span className="font-mono text-xs text-slate-500 dark:text-slate-400">{laneOrders.length} tickets</span>
                  </div>
                  {laneOrders.length === 0 ? (
                    <p className="py-10 text-center text-xs text-slate-500 dark:text-slate-400">No tickets in {lane.label.toLowerCase()}</p>
                  ) : (
                    laneOrders.map((ord) => (
                      <div key={ord.id} className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 p-3.5 space-y-2.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-mono font-semibold text-slate-900 dark:text-slate-50">{ord.receipt_number}</span>
                          <span className="text-slate-500 dark:text-slate-400">{ord.channel} · {ord.location_name}</span>
                        </div>
                        <ul className="space-y-1.5 text-sm">
                          {ord.items.map((it: any) => (
                            <li key={it.id} className="text-slate-800 dark:text-slate-100">
                              <span className="font-mono font-semibold mr-1.5">{it.quantity}x</span>
                              <span className="font-medium">{it.product_name}</span>
                              {it.variant_name && it.variant_name !== 'Standard' && (
                                <span className="text-xs text-slate-500 dark:text-slate-400 ml-1">({it.variant_name})</span>
                              )}
                              {it.kitchen_notes && (
                                <p className="text-xs text-amber-700 dark:text-amber-300 ml-6">Note: {it.kitchen_notes}</p>
                              )}
                            </li>
                          ))}
                        </ul>
                        {ord.notes && <p className="text-xs text-slate-600 dark:text-slate-300 italic">Order note: {ord.notes}</p>}
                        <button
                          onClick={() => advanceKds(ord.id, lane.next)}
                          className="w-full rounded-lg bg-slate-900 dark:bg-slate-100 py-2 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white"
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
        )}
      </div>
    );
  }

  // ==========================================
  // POINT OF SALE (POS) TERMINAL VIEW
  // ==========================================
  return (
    <div className="space-y-4">
      {/* POS Top Controls */}
      <div className={`flex flex-wrap items-center justify-between gap-3 ${receiptModal ? 'no-print' : ''}`}>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={posLocationId}
            onChange={(e) => {
              const val = e.target.value;
              setPosLocationId(val);
              onLocationChange?.(val);
            }}
            className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100"
          >
            {selectableLocations.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>

          <span
            className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-2 text-[11px] font-semibold whitespace-nowrap ${
              selectedLocKdsEnabled
                ? 'border-emerald-200 dark:border-emerald-700/80 bg-emerald-50 dark:bg-emerald-950/45 text-emerald-700 dark:text-emerald-300'
                : 'border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
            }`}
            title={
              selectedLocKdsEnabled
                ? 'Orders sent to Kitchen Display System (KDS)'
                : 'KDS disabled for this location; orders complete directly'
            }
          >
            <ChefHat className="w-3.5 h-3.5" />
            {selectedLocKdsEnabled ? 'KDS Active' : 'KDS Off · Direct'}
          </span>

          <button
            onClick={() => setSimulateOffline((v) => !v)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium whitespace-nowrap shrink-0 ${
              simulateOffline
                ? 'border-amber-300 dark:border-amber-700/80 bg-amber-50 dark:bg-amber-950/45 text-amber-800 dark:text-amber-300'
                : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200'
            }`}
          >
            {simulateOffline ? <WifiOff className="w-3.5 h-3.5" /> : <Wifi className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />}
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

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              const locName = selectedLocationObj ? selectedLocationObj.name.toLowerCase().replace(/[^a-z0-9]+/g, '_') : 'all_locations';
              const ts = new Date().toISOString().slice(0, 10);
              const csvRows = salesHistory.map((s: any) => ({
                'Receipt Number': s.receipt_number,
                'Status': s.status,
                'Sold At': s.sold_at,
                'Location': s.location_name || selectedLocationObj?.name || 'Food Truck',
                'Channel': s.channel || 'WALK_IN',
                'Items Summary': (s.items || []).map((i: any) => `${i.quantity}x ${i.product_name}`).join('; '),
                'Subtotal (PHP)': s.subtotal,
                'Discount (PHP)': s.discount_amount || 0,
                'Tax (PHP)': s.tax_amount || 0,
                'Total Amount (PHP)': s.total_amount,
                'Payment Method': s.payments?.[0]?.method || 'CASH',
                'Notes': s.notes || '',
              }));
              downloadCsv(`pos_transactions_${locName}_${ts}.csv`, csvRows);
            }}
            disabled={salesHistory.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0 disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
            Export CSV
          </button>
          <button
            onClick={() => setShowHistory((h) => !h)}
            className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            {showHistory ? 'Back to Register' : `Sales History & Refunds (${salesHistory.length})`}
          </button>
        </div>
      </div>

      {feedback && (
        <div
          className={`p-3 rounded-lg border text-xs font-medium ${receiptModal ? 'no-print' : ''} ${
            feedback.type === 'ok'
              ? 'bg-emerald-50 dark:bg-emerald-950/45 border-emerald-200 dark:border-emerald-700/80 text-emerald-800 dark:text-emerald-300'
              : 'bg-red-50 dark:bg-red-950/50 border-red-200 dark:border-red-800/80 text-red-700 dark:text-red-300'
          }`}
        >
          {feedback.msg}
        </div>
      )}

      <DailyHuddleBanner
        huddles={resolvedHuddles}
        user={user}
        channel="POS"
        locationId={posLocationId || activeLocationId}
        onAcknowledge={handleHuddleAcknowledge}
        className={receiptModal ? 'no-print' : ''}
      />

      {showHistory ? (
        <div className={`rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto ${receiptModal ? 'no-print' : ''}`}>
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
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
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {salesHistory.map((s) => (
                <tr key={s.id} className="hover:bg-slate-50 dark:hover:bg-slate-800">
                  <td className="p-3 font-mono font-semibold text-slate-900 dark:text-slate-50">{s.receipt_number}</td>
                  <td className="p-3 font-mono text-slate-500 dark:text-slate-400">{String(s.sold_at).slice(0, 16).replace('T', ' ')}</td>
                  <td className="p-3 text-slate-700 dark:text-slate-200">{s.location_name}</td>
                  <td className="p-3">
                    <span className={s.status === 'REFUNDED' ? 'text-red-700 dark:text-red-300 font-semibold' : 'text-emerald-700 dark:text-emerald-300 font-medium'}>
                      {s.channel} · {s.status}
                    </span>
                  </td>
                  <td className="p-3 text-right font-mono tabular-nums font-semibold">{formatPHP(s.total_amount)}</td>
                  <td className="p-3 text-right font-mono tabular-nums text-slate-500 dark:text-slate-400">{formatPHP(s.total_cogs)}</td>
                  <td className="p-3 text-right space-x-2">
                    <button
                      type="button"
                      onClick={() => setReceiptModal(s)}
                      className="inline-flex items-center gap-1 text-slate-700 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white font-medium hover:underline"
                    >
                      <QrCode className="w-3.5 h-3.5" /> Receipt QR
                    </button>
                    {s.status === 'COMPLETED' && canRefund && (
                      <button
                        onClick={() => setRefundTarget(s)}
                        className="inline-flex items-center gap-1 text-red-700 dark:text-red-300 hover:underline"
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
        <div className={`grid grid-cols-1 lg:grid-cols-12 gap-5 items-start ${receiptModal ? 'no-print' : ''}`}>
          {/* Left 7 cols: Menu Catalog */}
          <div className="lg:col-span-7 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="w-4 h-4 text-slate-500 dark:text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="search"
                  placeholder="Search dishes or SKU..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 dark:focus:ring-slate-200"
                />
              </div>
              <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-800 overflow-x-auto">
                <button
                  onClick={() => setActiveCat('ALL')}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 ${
                    activeCat === 'ALL' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50 shadow-sm' : 'text-slate-600 dark:text-slate-300'
                  }`}
                >
                  All
                </button>
                {categories.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setActiveCat(c.id)}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 ${
                      activeCat === c.id ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50 shadow-sm' : 'text-slate-600 dark:text-slate-300'
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
                  className="group text-left rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden hover:border-slate-900 transition-colors flex flex-col"
                >
                  <div className="aspect-[4/3] w-full bg-slate-100 dark:bg-slate-800 overflow-hidden relative">
                    {p.image_url ? (
                      <img
                        src={p.image_url}
                        alt={p.name}
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200 text-slate-500 dark:text-slate-400">
                        <Utensils className="w-7 h-7" />
                      </div>
                    )}
                  </div>
                  <div className="p-3 flex-1 flex flex-col justify-between">
                    <div>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">{p.category_name} · {p.sku}</p>
                      <p className="mt-0.5 text-sm font-semibold text-slate-900 dark:text-slate-50 line-clamp-2">{p.name}</p>
                    </div>
                    <p className="mt-2 font-mono tabular-nums text-base font-bold text-slate-900 dark:text-slate-50">
                      {formatPHP(p.base_price)}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Right 5 cols: Cart & Split Payments */}
          <div className="lg:col-span-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800/80 pb-3">
              <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">Active Order Ticket</h2>
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                className="rounded-md border border-slate-200 dark:border-slate-800 px-2 py-1 text-xs font-medium"
              >
                <option value="WALK_IN">Walk-in</option>
                <option value="TAKEOUT">Takeout</option>
                <option value="ONLINE">Online</option>
                <option value="PRE_ORDER">Pre-Order</option>
                <option value="CATERING">Catering</option>
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Customer / Loyalty Member</label>
              <select
                value={selectedCustomerId}
                onChange={(e) => setSelectedCustomerId(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs text-slate-700 dark:text-slate-200"
              >
                <option value="">Walk-in Guest (No Loyalty Profile)</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.full_name} · {c.tier} ({c.loyalty_points} pts)
                  </option>
                ))}
              </select>
            </div>

            <div className="max-h-60 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
              {cart.length === 0 ? (
                <p className="py-10 text-center text-xs text-slate-500 dark:text-slate-400">Select dishes on the left to build order</p>
              ) : (
                cart.map((line) => (
                  <div key={line.key} className="py-2.5 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 dark:text-slate-50">{line.name}</p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {line.variantName}
                        {line.modifiers.length > 0 && ` · +${line.modifiers.map((m) => m.name).join(', ')}`}
                      </p>
                      {line.kitchenNotes && <p className="text-xs text-amber-700 dark:text-amber-300">Note: {line.kitchenNotes}</p>}
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
                        className="w-7 h-7 rounded border border-slate-200 dark:border-slate-800 flex items-center justify-center hover:bg-slate-50 dark:hover:bg-slate-800"
                      >
                        <Minus className="w-3 h-3" />
                      </button>
                      <span className="w-5 text-center font-mono text-xs font-semibold">{line.quantity}</span>
                      <button
                        onClick={() =>
                          setCart((prev) => prev.map((x) => (x.key === line.key ? { ...x, quantity: x.quantity + 1 } : x)))
                        }
                        className="w-7 h-7 rounded border border-slate-200 dark:border-slate-800 flex items-center justify-center hover:bg-slate-50 dark:hover:bg-slate-800"
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

            <div className="space-y-2 border-t border-slate-100 dark:border-slate-800/80 pt-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-slate-600 dark:text-slate-300">Discount (PHP)</span>
                <input
                  type="number"
                  min={0}
                  value={discountAmount}
                  onChange={(e) => setDiscountAmount(Math.max(0, Number(e.target.value)))}
                  className="w-24 rounded border border-slate-200 dark:border-slate-800 px-2 py-1 text-right font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Order Notes / Table Buzzer #</label>
                <input
                  type="text"
                  placeholder="Order notes / table buzzer #..."
                  value={orderNotes}
                  onChange={(e) => setOrderNotes(e.target.value)}
                  className="w-full rounded border border-slate-200 dark:border-slate-800 px-2.5 py-1.5 text-xs"
                />
              </div>
              <div className="flex items-center justify-between pt-1 text-base font-bold text-slate-900 dark:text-slate-50">
                <span>Total Due (VAT Incl.)</span>
                <span className="font-mono tabular-nums text-lg">{formatPHP(cartTotal)}</span>
              </div>
            </div>

            {/* Split Payments */}
            <div className="space-y-2 border-t border-slate-100 dark:border-slate-800/80 pt-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-700 dark:text-slate-200">Payment Tender (Split Supported)</span>
                <button
                  type="button"
                  onClick={() => setPaymentRows((r) => [...r, { method: 'E_WALLET', amount: '', referenceNo: '' }])}
                  className="text-xs font-medium text-slate-700 dark:text-slate-200 hover:underline"
                >
                  + Add Split
                </button>
              </div>
              <div className="grid grid-cols-12 gap-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                <span className="col-span-5">Method</span>
                <span className="col-span-4 text-right">Amount (PHP)</span>
                <span className="col-span-2">Ref #</span>
                <span className="col-span-1" />
              </div>
              {paymentRows.map((row, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-1.5 items-center">
                  <select
                    aria-label="Payment Method"
                    value={row.method}
                    onChange={(e) =>
                      setPaymentRows((prev) => prev.map((r, i) => (i === idx ? { ...r, method: e.target.value } : r)))
                    }
                    className="col-span-5 rounded border border-slate-200 dark:border-slate-800 px-2 py-1.5 text-xs"
                  >
                    <option value="CASH">Cash</option>
                    <option value="E_WALLET">E-Wallet (GCash/Maya)</option>
                    <option value="CARD">Credit/Debit Card</option>
                    <option value="BANK_TRANSFER">Bank Transfer</option>
                  </select>
                  <input
                    type="number"
                    aria-label="Payment Amount"
                    placeholder={idx === 0 && paymentRows.length === 1 ? String(cartTotal) : 'Amount'}
                    value={row.amount}
                    onChange={(e) =>
                      setPaymentRows((prev) => prev.map((r, i) => (i === idx ? { ...r, amount: e.target.value } : r)))
                    }
                    className="col-span-4 rounded border border-slate-200 dark:border-slate-800 px-2 py-1.5 text-xs font-mono text-right"
                  />
                  <input
                    type="text"
                    aria-label="Reference Number"
                    placeholder="Ref #"
                    value={row.referenceNo}
                    onChange={(e) =>
                      setPaymentRows((prev) => prev.map((r, i) => (i === idx ? { ...r, referenceNo: e.target.value } : r)))
                    }
                    className="col-span-2 rounded border border-slate-200 dark:border-slate-800 px-1.5 py-1.5 text-xs"
                  />
                  {paymentRows.length > 1 && (
                    <button
                      onClick={() => setPaymentRows((prev) => prev.filter((_, i) => i !== idx))}
                      className="col-span-1 text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-300 flex justify-center"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
              {totalTendered > cartTotal && (
                <p className="text-xs font-mono text-emerald-700 dark:text-emerald-300 text-right">
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
          <div className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 p-5 space-y-4 border border-slate-200 dark:border-slate-800">
            <h3 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-50">{customizingProduct.name}</h3>
            {customizingProduct.variants?.length > 0 && (
              <div>
                <p className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-2">Size / Variant</p>
                <div className="grid grid-cols-2 gap-2">
                  {customizingProduct.variants.map((v: any) => (
                    <button
                      key={v.id}
                      onClick={() => setSelVariantId(v.id)}
                      className={`p-2.5 rounded-lg border text-left text-xs ${
                        selVariantId === v.id ? 'border-slate-900 dark:border-slate-100 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950' : 'border-slate-200 dark:border-slate-800'
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
                <p className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-2">Add-ons &amp; Modifiers</p>
                <div className="space-y-1.5">
                  {customizingProduct.modifiers.map((m: any) => {
                    const checked = selModIds.includes(m.id);
                    return (
                      <label key={m.id} className="flex items-center justify-between p-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs cursor-pointer">
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
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Kitchen Instruction</label>
              <input
                type="text"
                placeholder="e.g. No chili, extra calamansi..."
                value={itemKitchenNote}
                onChange={(e) => setItemKitchenNote(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
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
                className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 text-xs font-semibold"
              >
                Add to Order
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Printable Receipt Modal */}
      {receiptModal && (() => {
        const receiptLoc = locations.find((l) => l.id === (receiptModal.location_id || posLocationId));
        const truckName = receiptModal.location_name || receiptLoc?.name || 'Maximus Food Truck';
        const truckLocation = receiptModal.location_address || receiptLoc?.address || receiptModal.truck_site || '';
        const receiptDate = receiptModal.sold_at
          ? new Date(receiptModal.sold_at).toLocaleString('en-PH', {
              year: 'numeric',
              month: 'short',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            })
          : new Date().toLocaleString('en-PH');
        const totalDue = Number(receiptModal.total_amount || 0);
        const discountAmt = Number(receiptModal.discount_amount || 0);
        const vatAmt =
          receiptModal.tax_amount !== undefined && receiptModal.tax_amount !== null
            ? Number(receiptModal.tax_amount)
            : Math.round((totalDue - totalDue / 1.12) * 100) / 100;
        const vatableSales =
          receiptModal.subtotal !== undefined && receiptModal.subtotal !== null
            ? Number(receiptModal.subtotal)
            : Math.round((totalDue + discountAmt - vatAmt) * 100) / 100;
        const payments = Array.isArray(receiptModal.payments) ? receiptModal.payments : [];
        const totalPaid = payments.reduce((sum: number, p: any) => sum + Number(p.amount || 0), 0);
        const changeDue = Math.max(0, Math.round((totalPaid - totalDue) * 100) / 100);
        const formatMethod = (m: string) => {
          switch (m) {
            case 'CASH':
              return 'Cash';
            case 'E_WALLET':
              return 'E-Wallet';
            case 'CARD':
              return 'Card';
            case 'BANK_TRANSFER':
              return 'Bank Transfer';
            default:
              return m || 'Cash';
          }
        };

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 print:static print:bg-transparent print:p-0 print:block">
            <div className="w-full max-w-sm max-h-[92vh] overflow-y-auto rounded-xl bg-white dark:bg-slate-900 p-6 space-y-4 border border-slate-200 dark:border-slate-800 print:max-h-none print:overflow-visible print:border-0 print:shadow-none print:mx-auto">
              <div className="text-center border-b border-dashed border-slate-300 dark:border-slate-700 pb-3 space-y-1">
                <img
                  src="/assets/aistudio/Logo_836b4628.png"
                  alt="Maximus Barbecue Logo"
                  referrerPolicy="no-referrer"
                  className="w-12 h-12 mx-auto rounded-full object-contain"
                />
                <h3 className="font-display font-bold text-base text-slate-900 dark:text-slate-50">Maximus Barbecue ERP</h3>
                <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">{truckName}</p>
                {truckLocation && <p className="text-[11px] text-slate-500 dark:text-slate-400">{truckLocation}</p>}
                <p className="text-xs text-slate-600 dark:text-slate-300 font-mono pt-1">Receipt No.: {receiptModal.receipt_number}</p>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">Date: {receiptDate}</p>
                {receiptModal.offline && <p className="text-xs text-amber-700 dark:text-amber-300 font-medium mt-1">OFFLINE QUEUED RECEIPT</p>}
              </div>

              <div className="space-y-1.5 text-xs">
                {(receiptModal.items || []).map((it: any, idx: number) => (
                  <div key={idx} className="flex justify-between gap-2">
                    <span className="text-slate-800 dark:text-slate-100">
                      {it.quantity}x {it.product_name ?? it.productName}
                      {(it.variant_name ?? it.variantName) && (it.variant_name ?? it.variantName) !== 'Standard'
                        ? ` (${it.variant_name ?? it.variantName})`
                        : ''}
                    </span>
                    <span className="font-mono tabular-nums text-slate-900 dark:text-slate-50 shrink-0">
                      {formatPHP(it.line_total ?? it.lineTotal)}
                    </span>
                  </div>
                ))}
              </div>

              <div className="border-t border-dashed border-slate-300 dark:border-slate-700 pt-2.5 space-y-1.5">
                {discountAmt > 0 && (
                  <div className="flex justify-between text-xs text-slate-600 dark:text-slate-300">
                    <span>Discount</span>
                    <span className="font-mono tabular-nums">-{formatPHP(discountAmt)}</span>
                  </div>
                )}
                <div className="flex justify-between font-bold text-sm text-slate-900 dark:text-slate-50">
                  <span>TOTAL DUE</span>
                  <span className="font-mono tabular-nums">{formatPHP(totalDue)}</span>
                </div>

                {/* Payment Method(s) Used */}
                <div className="border-t border-dashed border-slate-200 dark:border-slate-800 pt-2 space-y-1 text-xs">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Payment Method</p>
                  {payments.length > 0 ? (
                    payments.map((p: any, idx: number) => (
                      <div key={idx} className="flex justify-between text-slate-700 dark:text-slate-200">
                        <span>
                          {formatMethod(p.method)}
                          {(p.reference_no || p.referenceNo) ? ` (Ref: ${p.reference_no || p.referenceNo})` : ''}
                        </span>
                        <span className="font-mono tabular-nums">{formatPHP(p.amount)}</span>
                      </div>
                    ))
                  ) : (
                    <div className="flex justify-between text-slate-700 dark:text-slate-200">
                      <span>Cash</span>
                      <span className="font-mono tabular-nums">{formatPHP(totalDue)}</span>
                    </div>
                  )}
                  {changeDue > 0 && (
                    <div className="flex justify-between text-slate-600 dark:text-slate-300">
                      <span>Change</span>
                      <span className="font-mono tabular-nums">{formatPHP(changeDue)}</span>
                    </div>
                  )}
                </div>

                {/* VAT Computation */}
                <div className="border-t border-dashed border-slate-200 dark:border-slate-800 pt-2 space-y-1 text-xs text-slate-600 dark:text-slate-300">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">VAT Computation</p>
                  <div className="flex justify-between">
                    <span>VATable Sales</span>
                    <span className="font-mono tabular-nums">{formatPHP(vatableSales)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>VAT (12%)</span>
                    <span className="font-mono tabular-nums">{formatPHP(vatAmt)}</span>
                  </div>
                  <div className="flex justify-between font-medium text-slate-800 dark:text-slate-100">
                    <span>Total Amount</span>
                    <span className="font-mono tabular-nums">{formatPHP(totalDue)}</span>
                  </div>
                </div>
              </div>

              <div className="border-t border-dashed border-slate-300 dark:border-slate-700 pt-3 text-center">
                <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">Thank you come again!</p>
              </div>

              {/* Customer Digital Receipt QR Code */}
              <div className="border-t border-dashed border-slate-300 dark:border-slate-700 pt-3 text-center space-y-2">
                <div className="flex items-center justify-center gap-1.5 text-[11px] font-semibold text-slate-700 dark:text-slate-200">
                  <QrCode className="w-3.5 h-3.5 text-slate-600 dark:text-slate-300" />
                  <span>Scan for Digital Receipt</span>
                </div>
                {receiptQrDataUrl ? (
                  <img
                    src={receiptQrDataUrl}
                    alt={`Digital receipt QR code for ${receiptModal.receipt_number}`}
                    className="w-36 h-36 mx-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-white p-1.5"
                  />
                ) : (
                  <div className="w-36 h-36 mx-auto rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 flex items-center justify-center text-[11px] text-slate-500 dark:text-slate-400">
                    Generating QR...
                  </div>
                )}
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Customers can scan with any phone camera to view or save their e-receipt
                </p>
                <div className="flex flex-wrap items-center justify-center gap-1.5 pt-0.5 no-print">
                  <button
                    type="button"
                    disabled={!receiptShareUrl}
                    onClick={() => {
                      if (!receiptShareUrl) return;
                      navigator.clipboard?.writeText(receiptShareUrl).then(() => {
                        setCopiedQrLink(true);
                        window.setTimeout(() => setCopiedQrLink(false), 2000);
                      }).catch(() => {});
                    }}
                    className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
                  >
                    {copiedQrLink ? <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    {copiedQrLink ? 'Copied Link' : 'Copy Link'}
                  </button>
                  <button
                    type="button"
                    disabled={!activeDigitalReceipt}
                    onClick={() => {
                      if (activeDigitalReceipt) setPreviewDigitalReceipt(activeDigitalReceipt);
                    }}
                    className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
                  >
                    <ExternalLink className="w-3 h-3" /> Preview
                  </button>
                  {receiptQrDataUrl && (
                    <a
                      href={receiptQrDataUrl}
                      download={`QR-${receiptModal.receipt_number || 'receipt'}.png`}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      <Download className="w-3 h-3" /> Save QR
                    </a>
                  )}
                </div>
              </div>

              {thermalPrintState && (
                <div
                  className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-medium no-print ${
                    thermalPrintState.busy
                      ? 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-700 dark:text-slate-200'
                      : thermalPrintState.err
                        ? 'border-amber-200 dark:border-amber-700/80 bg-amber-50 dark:bg-amber-950/45 text-amber-900 dark:text-amber-300'
                        : 'border-emerald-200 dark:border-emerald-700/80 bg-emerald-50 dark:bg-emerald-950/45 text-emerald-800 dark:text-emerald-300'
                  }`}
                >
                  {thermalPrintState.busy
                    ? mappedPrinter?.connectionType === 'BLUETOOTH'
                      ? `Sending ESC/POS receipt via Bluetooth to ${mappedPrinter.printerName}...`
                      : `Sending ESC/POS receipt to ${mappedPrinter?.printerIp}...`
                    : thermalPrintState.err || thermalPrintState.msg}
                </div>
              )}

              <div className="flex flex-wrap justify-end gap-2 no-print pt-1">
                {mappedPrinter && (
                  <button
                    type="button"
                    disabled={Boolean(thermalPrintState?.busy)}
                    onClick={() => void printSaleToMappedThermalPrinter(receiptModal, mappedPrinter)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-emerald-300 dark:border-emerald-700/80 bg-emerald-50 dark:bg-emerald-950/45 text-emerald-900 dark:text-emerald-300 text-xs font-semibold hover:bg-emerald-100 dark:hover:bg-emerald-900/60 disabled:opacity-50"
                  >
                    {mappedPrinter.connectionType === 'BLUETOOTH' ? (
                      <Bluetooth className="w-3.5 h-3.5" />
                    ) : (
                      <Printer className="w-3.5 h-3.5" />
                    )}
                    {thermalPrintState?.busy
                      ? 'Printing...'
                      : mappedPrinter.connectionType === 'BLUETOOTH'
                        ? `BT Print (${mappedPrinter.printerName})`
                        : `Thermal (${mappedPrinter.printerIp})`}
                  </button>
                )}
                {mappedPrinter?.connectionType === 'BLUETOOTH' && thermalPrintState?.err && (
                  <button
                    type="button"
                    disabled={Boolean(thermalPrintState?.busy)}
                    onClick={() => void handleReconnectBluetoothAndPrint(receiptModal)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-blue-300 dark:border-blue-700/80 bg-blue-50 dark:bg-blue-950/50 text-blue-900 dark:text-blue-300 text-xs font-semibold hover:bg-blue-100 dark:hover:bg-blue-900/60 disabled:opacity-50"
                  >
                    <Bluetooth className="w-3.5 h-3.5" /> Reconnect BT
                  </button>
                )}
                <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800">
                  <Printer className="w-3.5 h-3.5" /> Print
                </button>
                <button
                  onClick={() => {
                    setThermalPrintState(null);
                    setReceiptModal(null);
                  }}
                  className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 text-xs font-semibold hover:bg-slate-800 dark:hover:bg-white"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Customer Mobile Digital Receipt Preview Overlay */}
      {previewDigitalReceipt && (
        <div className="fixed inset-0 z-[60] overflow-y-auto bg-slate-100 dark:bg-slate-950">
          <PublicDigitalReceiptView
            receiptData={previewDigitalReceipt}
            onClosePreview={() => setPreviewDigitalReceipt(null)}
          />
        </div>
      )}

      {/* Refund Authorization Modal */}
      {refundTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 p-5 space-y-4 border border-slate-200 dark:border-slate-800">
            <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">
              Authorize Refund — {refundTarget.receipt_number}
            </h3>
            <p className="text-xs text-slate-600 dark:text-slate-300">
              Refunding {formatPHP(refundTarget.total_amount)} will preserve the audit trail and automatically post an equal-and-opposite reversing Journal Entry.
            </p>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Refund Reason (for audit log)</label>
              <input
                type="text"
                placeholder="Reason for refund (required for audit log)"
                value={refundReason}
                onChange={(e) => setRefundReason(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setRefundTarget(null)} className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800">Cancel</button>
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
