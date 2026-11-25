export interface DigitalReceiptItem {
  quantity: number;
  productName: string;
  variantName: string;
  lineTotal: number;
}

export interface DigitalReceiptPayment {
  method: string;
  amount: number;
  referenceNo?: string;
}

export interface DigitalReceiptData {
  receiptNumber: string;
  locationName: string;
  locationAddress: string;
  soldAt: string;
  channel: string;
  status: 'COMPLETED' | 'REFUNDED' | 'OFFLINE_QUEUED';
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  totalAmount: number;
  items: DigitalReceiptItem[];
  payments: DigitalReceiptPayment[];
  truncatedItemsCount?: number;
  offline?: boolean;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(b64u: string): Uint8Array | null {
  try {
    const padded = b64u.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64u.length + 3) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

export function formatPaymentMethodLabel(method: string): string {
  switch (String(method || '').toUpperCase()) {
    case 'CASH':
      return 'Cash';
    case 'E_WALLET':
      return 'E-Wallet';
    case 'CARD':
      return 'Card';
    case 'BANK_TRANSFER':
      return 'Bank Transfer';
    default:
      return method ? String(method) : 'Cash';
  }
}

function maskRefNo(raw: unknown): string | undefined {
  const s = String(raw || '').trim();
  if (!s) return undefined;
  if (s.length <= 6) return s;
  return `***${s.slice(-4)}`;
}

/**
 * Extracts a customer-safe DigitalReceiptData object from any POS sale / receipt object.
 * Strictly excludes internal COGS, cashier IDs, and customer PII.
 */
export function extractDigitalReceiptFromSale(
  sale: any,
  fallbackLocation?: { name?: string; address?: string } | null,
): DigitalReceiptData {
  const totalAmount = round2(Math.max(0, Number(sale?.total_amount ?? sale?.totalAmount ?? 0)));
  const discountAmount = round2(Math.max(0, Number(sale?.discount_amount ?? sale?.discountAmount ?? 0)));
  const rawTax = sale?.tax_amount ?? sale?.taxAmount;
  const taxAmount =
    rawTax !== undefined && rawTax !== null && Number.isFinite(Number(rawTax))
      ? round2(Math.max(0, Number(rawTax)))
      : round2(totalAmount - totalAmount / 1.12);
  const rawSub = sale?.subtotal;
  const subtotal =
    rawSub !== undefined && rawSub !== null && Number.isFinite(Number(rawSub))
      ? round2(Math.max(0, Number(rawSub)))
      : round2(Math.max(0, totalAmount + discountAmount - taxAmount));

  const rawItems = Array.isArray(sale?.items) ? sale.items : [];
  const items: DigitalReceiptItem[] = rawItems.slice(0, 50).map((it: any) => ({
    quantity: Math.max(1, Number(it?.quantity || 1)),
    productName: String(it?.product_name ?? it?.productName ?? 'Menu Item').trim().slice(0, 80),
    variantName: String(it?.variant_name ?? it?.variantName ?? 'Standard').trim().slice(0, 40),
    lineTotal: round2(Math.max(0, Number(it?.line_total ?? it?.lineTotal ?? 0))),
  }));

  const rawPayments = Array.isArray(sale?.payments) ? sale.payments : [];
  const payments: DigitalReceiptPayment[] =
    rawPayments.length > 0
      ? rawPayments.slice(0, 12).map((p: any) => ({
          method: String(p?.method || 'CASH').toUpperCase().slice(0, 30),
          amount: round2(Math.max(0, Number(p?.amount || 0))),
          referenceNo: maskRefNo(p?.reference_no ?? p?.referenceNo),
        }))
      : [{ method: 'CASH', amount: totalAmount }];

  const isOffline = Boolean(sale?.offline);
  const rawStatus = String(sale?.status || 'COMPLETED').toUpperCase();
  const status: DigitalReceiptData['status'] = isOffline
    ? 'OFFLINE_QUEUED'
    : rawStatus === 'REFUNDED'
      ? 'REFUNDED'
      : 'COMPLETED';

  return {
    receiptNumber: String(sale?.receipt_number ?? sale?.receiptNumber ?? 'OR-RECEIPT').trim().slice(0, 64),
    locationName: String(sale?.location_name ?? fallbackLocation?.name ?? 'Maximus Barbecue Food Truck')
      .trim()
      .slice(0, 100),
    locationAddress: String(sale?.location_address ?? sale?.truck_site ?? fallbackLocation?.address ?? '')
      .trim()
      .slice(0, 160),
    soldAt: String(sale?.sold_at ?? sale?.soldAt ?? new Date().toISOString()).slice(0, 40),
    channel: String(sale?.channel || 'WALK_IN').trim().slice(0, 32),
    status,
    subtotal,
    discountAmount,
    taxAmount,
    totalAmount,
    items,
    payments,
    offline: isOffline,
  };
}

function serializeCompactToken(data: DigitalReceiptData, maxItems: number): string {
  const includedItems = data.items.slice(0, maxItems);
  const truncatedItemsCount = Math.max(0, data.items.length - includedItems.length) + (data.truncatedItemsCount || 0);

  const compact: Record<string, unknown> = {
    v: 1,
    r: data.receiptNumber.slice(0, 64),
    l: data.locationName.slice(0, 80),
    a: data.locationAddress.slice(0, 120),
    t: data.soldAt.slice(0, 32),
    c: data.channel.slice(0, 24),
    st: data.status === 'REFUNDED' ? 'R' : data.status === 'OFFLINE_QUEUED' ? 'O' : 'C',
    sub: round2(data.subtotal),
    dis: round2(data.discountAmount),
    tax: round2(data.taxAmount),
    tot: round2(data.totalAmount),
    i: includedItems.map((it) => [
      Number(it.quantity),
      it.productName.slice(0, 56),
      it.variantName && it.variantName !== 'Standard' ? it.variantName.slice(0, 28) : '',
      round2(it.lineTotal),
    ]),
    p: data.payments.slice(0, 6).map((pay) => [
      pay.method.slice(0, 20),
      round2(pay.amount),
      pay.referenceNo ? pay.referenceNo.slice(0, 16) : '',
    ]),
  };
  if (truncatedItemsCount > 0) {
    compact.tr = truncatedItemsCount;
  }

  const encoded = new TextEncoder().encode(JSON.stringify(compact));
  return toBase64Url(encoded);
}

/**
 * Encodes receipt into a compact URL-safe token kept within reliable mobile QR scan density.
 */
export function encodeDigitalReceiptToken(data: DigitalReceiptData): string {
  let token = serializeCompactToken(data, data.items.length);
  if (token.length <= 1250) return token;

  for (const limit of [12, 8, 5, 3]) {
    token = serializeCompactToken(data, limit);
    if (token.length <= 1250) return token;
  }
  return token;
}

export function buildDigitalReceiptUrl(data: DigitalReceiptData, origin?: string): string {
  const token = encodeDigitalReceiptToken(data);
  const base =
    origin ||
    (typeof window !== 'undefined' ? `${window.location.origin}${window.location.pathname}` : '/');
  const cleanBase = base.endsWith('/') ? base : `${base}`;
  const sep = cleanBase.includes('?') ? '&' : '?';
  return `${cleanBase}${sep}receipt=${encodeURIComponent(token)}`;
}

export function decodeDigitalReceiptToken(token: string): DigitalReceiptData | null {
  const clean = String(token || '').trim();
  if (!clean || clean.length > 4096) return null;
  const bytes = fromBase64Url(clean);
  if (!bytes) return null;

  try {
    const raw = JSON.parse(new TextDecoder().decode(bytes));
    if (!raw || typeof raw !== 'object' || raw.v !== 1) return null;
    const receiptNumber = String(raw.r || '').trim().slice(0, 64);
    if (!receiptNumber) return null;

    const totalAmount = Number(raw.tot);
    const subtotal = Number(raw.sub);
    const discountAmount = Number(raw.dis || 0);
    const taxAmount = Number(raw.tax || 0);
    if (
      !Number.isFinite(totalAmount) ||
      totalAmount < 0 ||
      !Number.isFinite(subtotal) ||
      !Number.isFinite(discountAmount) ||
      !Number.isFinite(taxAmount)
    ) {
      return null;
    }

    const rawItems = Array.isArray(raw.i) ? raw.i.slice(0, 50) : [];
    const items: DigitalReceiptItem[] = rawItems.map((entry: any) => ({
      quantity: Math.max(1, Number(Array.isArray(entry) ? entry[0] : 1) || 1),
      productName: String(Array.isArray(entry) ? entry[1] || 'Item' : 'Item').slice(0, 80),
      variantName: String(Array.isArray(entry) && entry[2] ? entry[2] : 'Standard').slice(0, 40),
      lineTotal: round2(Math.max(0, Number(Array.isArray(entry) ? entry[3] : 0) || 0)),
    }));

    const rawPayments = Array.isArray(raw.p) ? raw.p.slice(0, 10) : [];
    const payments: DigitalReceiptPayment[] = rawPayments.map((entry: any) => ({
      method: String(Array.isArray(entry) ? entry[0] || 'CASH' : 'CASH').slice(0, 30),
      amount: round2(Math.max(0, Number(Array.isArray(entry) ? entry[1] : 0) || 0)),
      referenceNo: Array.isArray(entry) && entry[2] ? String(entry[2]).slice(0, 24) : undefined,
    }));

    const stCode = String(raw.st || 'C');
    const status: DigitalReceiptData['status'] =
      stCode === 'R' ? 'REFUNDED' : stCode === 'O' ? 'OFFLINE_QUEUED' : 'COMPLETED';

    return {
      receiptNumber,
      locationName: String(raw.l || 'Maximus Barbecue').slice(0, 100),
      locationAddress: String(raw.a || '').slice(0, 160),
      soldAt: String(raw.t || '').slice(0, 40),
      channel: String(raw.c || 'WALK_IN').slice(0, 32),
      status,
      subtotal: round2(subtotal),
      discountAmount: round2(discountAmount),
      taxAmount: round2(taxAmount),
      totalAmount: round2(totalAmount),
      items,
      payments: payments.length > 0 ? payments : [{ method: 'CASH', amount: round2(totalAmount) }],
      truncatedItemsCount: Number(raw.tr || 0) > 0 ? Math.round(Number(raw.tr)) : undefined,
      offline: status === 'OFFLINE_QUEUED',
    };
  } catch {
    return null;
  }
}
