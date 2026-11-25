export type VelocityTier = 'HIGH' | 'MEDIUM' | 'LOW';
export type RestockUrgency = 'CRITICAL' | 'HIGH' | 'WATCH' | 'NOMINAL';

export interface SupplierQuoteOption {
  supplierId: string;
  supplierName: string;
  unitPrice: number;
  leadTimeDays: number;
}

export interface PredictiveRestockItem {
  inventoryItemId: string;
  sku: string;
  name: string;
  itemType: string;
  uomCode: string;
  onHandQty: number;
  openPoQty: number;
  effectiveStockQty: number;
  safetyStock: number;
  reorderPoint: number;
  lastUnitCost: number;
  monthlyUsage: {
    monthMinus2Qty: number; // 60–89 days ago
    monthMinus1Qty: number; // 30–59 days ago
    currentMonthQty: number; // 0–29 days ago
  };
  total90dUsage: number;
  sale90dUsage: number;
  waste90dUsage: number;
  activeSpanDays: number;
  avgDailyBurn: number;
  velocityTrendPct: number;
  velocityTier: VelocityTier;
  velocityRank: number | null;
  isHighVelocity: boolean;
  daysOfSupply: number;
  projectedCoverageDemand: number;
  targetStockLevel: number;
  suggestedRestockQty: number;
  urgency: RestockUrgency;
  preferredSupplierId: string;
  preferredSupplierName: string;
  preferredUnitCost: number;
  leadTimeDays: number;
  estimatedRestockCost: number;
  supplierOptions: SupplierQuoteOption[];
  rationale: string;
}

export interface PredictiveProcurementResponse {
  locationId: string;
  lookbackDays: number;
  coverageDays: number;
  windowStart: string;
  windowEnd: string;
  summary: {
    monitoredItemsCount: number;
    highVelocityCount: number;
    restockNeededCount: number;
    criticalCount: number;
    totalEstimatedCostPhp: number;
    totalOpenPoUnitsCount: number;
  };
  suggestions: PredictiveRestockItem[];
  suppliers: Array<{ id: string; name: string; code?: string }>;
}

export interface PredictiveItemInput {
  id: string;
  sku: string;
  name: string;
  itemType: string;
  uomCode: string;
  safetyStock: number;
  reorderPoint: number;
  lastUnitCost: number;
}

export interface PredictiveTxnInput {
  inventoryItemId: string;
  locationId: string;
  txnType: string;
  quantityDelta: number;
  referenceType?: string | null;
  referenceId?: string | null;
  txnDate: string;
}

export interface PredictiveSaleBomUsageInput {
  saleId: string;
  locationId: string;
  inventoryItemId: string;
  quantity: number;
  soldAt: string;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function parseDayMs(raw: string): number | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  const datePart = trimmed.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    const dt = new Date(trimmed);
    if (!Number.isNaN(dt.getTime())) {
      return Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate());
    }
    const [y, m, d] = datePart.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

function roundRestockQty(qty: number, uomCode: string): number {
  if (qty <= 0) return 0;
  const uom = String(uomCode || '').toLowerCase();
  if (uom === 'g' || uom === 'ml') {
    if (qty >= 1000) return Math.ceil(qty / 100) * 100;
    if (qty >= 100) return Math.ceil(qty / 50) * 50;
    return Math.ceil(qty);
  }
  return Math.ceil(qty);
}

export function buildPredictiveProcurementPlan(input: {
  items: PredictiveItemInput[];
  onHandByItem: Map<string, number>;
  openPoByItem: Map<string, number>;
  txns: PredictiveTxnInput[];
  salesBomUsages: PredictiveSaleBomUsageInput[];
  supplierQuotesByItem: Map<string, SupplierQuoteOption[]>;
  suppliers: Array<{ id: string; name: string; code?: string }>;
  locationId?: string;
  lookbackDays?: number;
  coverageDays?: number;
  now?: Date;
}): PredictiveProcurementResponse {
  const now = input.now || new Date();
  const lookbackDays = Math.min(180, Math.max(30, Math.round(Number(input.lookbackDays || 90))));
  const coverageDays = Math.min(45, Math.max(3, Math.round(Number(input.coverageDays || 14))));
  const locId = input.locationId && input.locationId !== 'ALL' ? input.locationId : 'ALL';

  const todayUtcMs = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const windowStartMs = todayUtcMs - (lookbackDays - 1) * 86400000;
  const windowStart = new Date(windowStartMs).toISOString().slice(0, 10);
  const windowEnd = new Date(todayUtcMs).toISOString().slice(0, 10);

  // Track which sales already posted OUT_SALE inventory transactions to avoid double counting
  const ledgerSaleKeys = new Set<string>();
  for (const t of input.txns) {
    if (t.txnType === 'OUT_SALE' && t.referenceType === 'SALE' && t.referenceId) {
      ledgerSaleKeys.add(`${t.referenceId}::${t.inventoryItemId}`);
    }
  }

  interface Accumulator {
    m1: number; // 60-89 days ago
    m2: number; // 30-59 days ago
    m3: number; // 0-29 days ago
    recent7d: number;
    prior7d: number;
    saleUsage: number;
    wasteUsage: number;
    earliestMs: number | null;
  }

  const accMap = new Map<string, Accumulator>();
  const getAcc = (itemId: string): Accumulator => {
    let a = accMap.get(itemId);
    if (!a) {
      a = { m1: 0, m2: 0, m3: 0, recent7d: 0, prior7d: 0, saleUsage: 0, wasteUsage: 0, earliestMs: null };
      accMap.set(itemId, a);
    }
    return a;
  };

  const addSample = (itemId: string, dayMs: number, qty: number, isWaste: boolean) => {
    if (qty <= 0 || dayMs < windowStartMs || dayMs > todayUtcMs) return;
    const daysAgo = Math.floor((todayUtcMs - dayMs) / 86400000);
    const acc = getAcc(itemId);
    if (acc.earliestMs === null || dayMs < acc.earliestMs) acc.earliestMs = dayMs;

    if (daysAgo < 30) acc.m3 += qty;
    else if (daysAgo < 60) acc.m2 += qty;
    else acc.m1 += qty;

    if (daysAgo < 7) acc.recent7d += qty;
    else if (daysAgo < 14) acc.prior7d += qty;

    if (isWaste) acc.wasteUsage += qty;
    else acc.saleUsage += qty;
  };

  for (const t of input.txns) {
    if (locId !== 'ALL' && t.locationId !== locId) continue;
    if (!['OUT_SALE', 'OUT_WASTE', 'OUT_SPOILAGE', 'OUT_ADJUSTMENT'].includes(t.txnType)) continue;
    const dayMs = parseDayMs(t.txnDate);
    if (dayMs === null) continue;
    const qty = Math.abs(Number(t.quantityDelta || 0));
    const isWaste = t.txnType === 'OUT_WASTE' || t.txnType === 'OUT_SPOILAGE';
    addSample(t.inventoryItemId, dayMs, qty, isWaste);
  }

  for (const su of input.salesBomUsages) {
    if (locId !== 'ALL' && su.locationId !== locId) continue;
    if (ledgerSaleKeys.has(`${su.saleId}::${su.inventoryItemId}`)) continue;
    const dayMs = parseDayMs(su.soldAt);
    if (dayMs === null) continue;
    addSample(su.inventoryItemId, dayMs, Number(su.quantity || 0), false);
  }

  // First pass: compute burn rate & normalized velocity score for ranking
  const rawMetrics = input.items.map((item) => {
    const acc = accMap.get(item.id);
    const m1 = round2(acc?.m1 || 0);
    const m2 = round2(acc?.m2 || 0);
    const m3 = round2(acc?.m3 || 0);
    const total90d = round2(m1 + m2 + m3);
    const sale90d = round2(acc?.saleUsage || 0);
    const waste90d = round2(acc?.wasteUsage || 0);
    const activeSpanDays =
      acc?.earliestMs !== null && acc?.earliestMs !== undefined
        ? Math.max(1, Math.min(lookbackDays, Math.floor((todayUtcMs - acc.earliestMs) / 86400000) + 1))
        : 0;

    let avgDailyBurn = 0;
    let velocityTrendPct = 0;

    if (total90d > 0) {
      if (m1 > 0 || m2 > 0) {
        avgDailyBurn = round2((m3 / 30) * 0.5 + (m2 / 30) * 0.3 + (m1 / 30) * 0.2);
        const priorMonthsDaily = (m1 + m2) / 60;
        if (priorMonthsDaily > 0) {
          velocityTrendPct = round2((((m3 / 30) - priorMonthsDaily) / priorMonthsDaily) * 100);
        }
      } else {
        const span = Math.max(1, Math.min(30, activeSpanDays));
        avgDailyBurn = round2(total90d / span);
        const recentDaily = (acc?.recent7d || 0) / Math.min(7, span);
        const priorDaily = (acc?.prior7d || 0) / 7;
        if (priorDaily > 0) {
          velocityTrendPct = round2(((recentDaily - priorDaily) / priorDaily) * 100);
        } else if (m3 > 0 && recentDaily > avgDailyBurn) {
          velocityTrendPct = round2(((recentDaily - avgDailyBurn) / Math.max(0.01, avgDailyBurn)) * 100);
        }
      }
    }

    const onHandQty = round2(input.onHandByItem.get(item.id) || 0);
    const openPoQty = round2(input.openPoByItem.get(item.id) || 0);
    const baselineRef = Math.max(1, item.reorderPoint || item.safetyStock || onHandQty || avgDailyBurn * 7);
    const turnoverScore = avgDailyBurn > 0 ? round2((avgDailyBurn * 30) / baselineRef) : 0;

    return {
      item,
      m1,
      m2,
      m3,
      total90d,
      sale90d,
      waste90d,
      activeSpanDays,
      avgDailyBurn,
      velocityTrendPct,
      onHandQty,
      openPoQty,
      turnoverScore,
    };
  });

  // Rank active items by turnover velocity descending
  const movingItems = [...rawMetrics]
    .filter((r) => r.total90d > 0)
    .sort((a, b) => b.turnoverScore - a.turnoverScore || b.total90d - a.total90d);

  const highCutoffIdx = Math.max(3, Math.ceil(movingItems.length * 0.55));
  const rankMap = new Map<string, number>();
  movingItems.forEach((m, idx) => rankMap.set(m.item.id, idx + 1));

  const fallbackSup = input.suppliers[0] || { id: '', name: 'Select Supplier' };

  const suggestions: PredictiveRestockItem[] = rawMetrics.map((m) => {
    const rank = rankMap.get(m.item.id) ?? null;
    const quotes = [...(input.supplierQuotesByItem.get(m.item.id) || [])].sort(
      (a, b) => a.unitPrice - b.unitPrice || a.leadTimeDays - b.leadTimeDays,
    );
    const preferred = quotes[0] || {
      supplierId: fallbackSup.id,
      supplierName: fallbackSup.name,
      unitPrice: Number(m.item.lastUnitCost || 0),
      leadTimeDays: 2,
    };

    const effectiveStockQty = round2(m.onHandQty + m.openPoQty);
    const daysOfSupply =
      m.avgDailyBurn > 0 ? round2(m.onHandQty / m.avgDailyBurn) : m.onHandQty > 0 ? 999 : 0;
    const projectedCoverageDemand = round2(m.avgDailyBurn * coverageDays);

    const isHighVelocity =
      m.total90d > 0 &&
      ((rank !== null && rank <= highCutoffIdx) || daysOfSupply <= coverageDays * 1.25 || m.turnoverScore >= 1.2);
    const velocityTier: VelocityTier = isHighVelocity
      ? 'HIGH'
      : m.total90d > 0
      ? 'MEDIUM'
      : 'LOW';

    const targetStockLevel = round2(
      Math.max(
        m.item.safetyStock + m.avgDailyBurn * preferred.leadTimeDays,
        m.item.reorderPoint,
        m.avgDailyBurn * (coverageDays + preferred.leadTimeDays),
      ),
    );
    const rawShortfall = Math.max(0, targetStockLevel - effectiveStockQty);
    const suggestedRestockQty = roundRestockQty(rawShortfall, m.item.uomCode);
    const estimatedRestockCost = round2(suggestedRestockQty * preferred.unitPrice);

    let urgency: RestockUrgency = 'NOMINAL';
    if (suggestedRestockQty > 0 && (m.onHandQty < m.item.safetyStock || daysOfSupply <= preferred.leadTimeDays + 1.5)) {
      urgency = 'CRITICAL';
    } else if (suggestedRestockQty > 0 && (m.onHandQty <= m.item.reorderPoint || daysOfSupply <= coverageDays || isHighVelocity)) {
      urgency = 'HIGH';
    } else if (isHighVelocity) {
      urgency = 'WATCH';
    }

    const rationale =
      m.total90d > 0
        ? suggestedRestockQty > 0
          ? `${coverageDays}d demand (${Math.round(projectedCoverageDemand)} ${m.item.uomCode}) + ${preferred.leadTimeDays}d lead buffer exceeds net available (${Math.round(effectiveStockQty)} ${m.item.uomCode}).`
          : `Well stocked for ${daysOfSupply >= 99 ? '99+' : daysOfSupply} days at ${m.avgDailyBurn} ${m.item.uomCode}/day burn rate.`
        : 'No outbound consumption recorded in the last 3 months.';

    return {
      inventoryItemId: m.item.id,
      sku: m.item.sku,
      name: m.item.name,
      itemType: m.item.itemType,
      uomCode: m.item.uomCode,
      onHandQty: m.onHandQty,
      openPoQty: m.openPoQty,
      effectiveStockQty,
      safetyStock: m.item.safetyStock,
      reorderPoint: m.item.reorderPoint,
      lastUnitCost: m.item.lastUnitCost,
      monthlyUsage: {
        monthMinus2Qty: m.m1,
        monthMinus1Qty: m.m2,
        currentMonthQty: m.m3,
      },
      total90dUsage: m.total90d,
      sale90dUsage: m.sale90d,
      waste90dUsage: m.waste90d,
      activeSpanDays: m.activeSpanDays,
      avgDailyBurn: m.avgDailyBurn,
      velocityTrendPct: m.velocityTrendPct,
      velocityTier,
      velocityRank: rank,
      isHighVelocity,
      daysOfSupply,
      projectedCoverageDemand,
      targetStockLevel,
      suggestedRestockQty,
      urgency,
      preferredSupplierId: preferred.supplierId,
      preferredSupplierName: preferred.supplierName,
      preferredUnitCost: preferred.unitPrice,
      leadTimeDays: preferred.leadTimeDays,
      estimatedRestockCost,
      supplierOptions: quotes,
      rationale,
    };
  });

  const urgencyRank: Record<RestockUrgency, number> = { CRITICAL: 0, HIGH: 1, WATCH: 2, NOMINAL: 3 };
  suggestions.sort((a, b) => {
    const uDiff = urgencyRank[a.urgency] - urgencyRank[b.urgency];
    if (uDiff !== 0) return uDiff;
    if (a.isHighVelocity !== b.isHighVelocity) return a.isHighVelocity ? -1 : 1;
    return (a.velocityRank ?? 999) - (b.velocityRank ?? 999) || b.suggestedRestockQty - a.suggestedRestockQty;
  });

  const highVelocityCount = suggestions.filter((s) => s.isHighVelocity).length;
  const restockNeededCount = suggestions.filter((s) => s.suggestedRestockQty > 0).length;
  const criticalCount = suggestions.filter((s) => s.urgency === 'CRITICAL').length;
  const totalEstimatedCostPhp = round2(suggestions.reduce((sum, s) => sum + s.estimatedRestockCost, 0));
  let totalOpenPoUnitsCount = 0;
  for (const s of suggestions) {
    if (s.openPoQty > 0) totalOpenPoUnitsCount++;
  }

  return {
    locationId: locId,
    lookbackDays,
    coverageDays,
    windowStart,
    windowEnd,
    summary: {
      monitoredItemsCount: suggestions.length,
      highVelocityCount,
      restockNeededCount,
      criticalCount,
      totalEstimatedCostPhp,
      totalOpenPoUnitsCount,
    },
    suggestions,
    suppliers: input.suppliers,
  };
}
