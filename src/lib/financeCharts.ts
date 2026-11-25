export interface WeeklyFoodCostPoint {
  weekKey: string;
  weekLabel: string;
  weekRange: string;
  netRevenue: number;
  grossRevenue: number;
  saleCogs: number;
  wasteCost: number;
  totalFoodCost: number;
  foodCostPct: number | null;
  grossMarginPct: number | null;
  orderCount: number;
}

export interface WeeklyFoodCostResponse {
  weeks: number;
  locationId: string;
  targetFoodCostPct: number;
  series: WeeklyFoodCostPoint[];
  summary: {
    totalNetRevenue: number;
    totalFoodCost: number;
    totalWasteCost: number;
    avgFoodCostPct: number | null;
    totalOrders: number;
    activeWeeks: number;
  };
}

export interface SaleTrendInput {
  locationId?: string | null;
  soldAt: string;
  subtotal: number;
  taxAmount?: number;
  totalAmount: number;
  totalCogs: number;
}

export interface WasteTrendInput {
  locationId?: string | null;
  txnDate: string;
  totalCost: number;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseUtcDateOnly(raw: string): Date | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  const datePart = trimmed.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()));
    }
    const [y, m, d] = datePart.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  const fallback = new Date(trimmed);
  if (Number.isNaN(fallback.getTime())) return null;
  return new Date(Date.UTC(fallback.getFullYear(), fallback.getMonth(), fallback.getDate()));
}

function getMondayUtc(d: Date): Date {
  const day = d.getUTCDay(); // 0 = Sun, 1 = Mon, ...
  const diffToMon = (day + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diffToMon));
}

function toIsoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatWeekLabel(monday: Date): { weekLabel: string; weekRange: string } {
  const sunday = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + 6));
  const m1 = SHORT_MONTHS[monday.getUTCMonth()];
  const d1 = monday.getUTCDate();
  const m2 = SHORT_MONTHS[sunday.getUTCMonth()];
  const d2 = sunday.getUTCDate();
  const weekLabel = m1 === m2 ? `${m1} ${d1}–${d2}` : `${m1} ${d1}–${m2} ${d2}`;
  const weekRange = `${m1} ${d1} – ${m2} ${d2}, ${sunday.getUTCFullYear()}`;
  return { weekLabel, weekRange };
}

export function buildWeeklyFoodCostSeries(input: {
  sales: SaleTrendInput[];
  wasteTxns: WasteTrendInput[];
  targetFoodCostPct?: number;
  locationId?: string;
  weeks?: number;
  now?: Date;
}): WeeklyFoodCostResponse {
  const weeks = Math.min(26, Math.max(2, Math.round(Number(input.weeks || 8))));
  const now = input.now || new Date();
  const todayUtc = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const currentMonday = getMondayUtc(todayUtc);

  const buckets = new Map<
    string,
    {
      weekKey: string;
      weekLabel: string;
      weekRange: string;
      netRevenue: number;
      grossRevenue: number;
      saleCogs: number;
      wasteCost: number;
      orderCount: number;
    }
  >();

  const orderedKeys: string[] = [];
  for (let offset = -(weeks - 1); offset <= 0; offset++) {
    const mon = new Date(
      Date.UTC(currentMonday.getUTCFullYear(), currentMonday.getUTCMonth(), currentMonday.getUTCDate() + offset * 7),
    );
    const key = toIsoDate(mon);
    const { weekLabel, weekRange } = formatWeekLabel(mon);
    orderedKeys.push(key);
    buckets.set(key, {
      weekKey: key,
      weekLabel,
      weekRange,
      netRevenue: 0,
      grossRevenue: 0,
      saleCogs: 0,
      wasteCost: 0,
      orderCount: 0,
    });
  }

  for (const s of input.sales) {
    const d = parseUtcDateOnly(s.soldAt);
    if (!d) continue;
    const key = toIsoDate(getMondayUtc(d));
    const bucket = buckets.get(key);
    if (!bucket) continue;

    const gross = Number(s.totalAmount || 0);
    const net =
      Number(s.subtotal || 0) > 0
        ? Number(s.subtotal)
        : Math.max(0, gross - Number(s.taxAmount || 0));
    const cogs = Math.max(0, Number(s.totalCogs || 0));

    bucket.netRevenue = round2(bucket.netRevenue + net);
    bucket.grossRevenue = round2(bucket.grossRevenue + gross);
    bucket.saleCogs = round2(bucket.saleCogs + cogs);
    bucket.orderCount += 1;
  }

  for (const w of input.wasteTxns) {
    const d = parseUtcDateOnly(w.txnDate);
    if (!d) continue;
    const key = toIsoDate(getMondayUtc(d));
    const bucket = buckets.get(key);
    if (!bucket) continue;

    const cost = Math.max(0, Number(w.totalCost || 0));
    bucket.wasteCost = round2(bucket.wasteCost + cost);
  }

  let totalNetRevenue = 0;
  let totalFoodCost = 0;
  let totalWasteCost = 0;
  let totalOrders = 0;
  let activeWeeks = 0;

  const series: WeeklyFoodCostPoint[] = orderedKeys.map((key) => {
    const b = buckets.get(key)!;
    const foodCost = round2(b.saleCogs + b.wasteCost);
    const hasRev = b.netRevenue > 0;
    const foodCostPct = hasRev ? round2((foodCost / b.netRevenue) * 100) : null;
    const grossMarginPct = hasRev ? round2(((b.netRevenue - foodCost) / b.netRevenue) * 100) : null;

    if (hasRev || b.orderCount > 0) activeWeeks++;
    totalNetRevenue = round2(totalNetRevenue + b.netRevenue);
    totalFoodCost = round2(totalFoodCost + foodCost);
    totalWasteCost = round2(totalWasteCost + b.wasteCost);
    totalOrders += b.orderCount;

    return {
      weekKey: b.weekKey,
      weekLabel: b.weekLabel,
      weekRange: b.weekRange,
      netRevenue: b.netRevenue,
      grossRevenue: b.grossRevenue,
      saleCogs: b.saleCogs,
      wasteCost: b.wasteCost,
      totalFoodCost: foodCost,
      foodCostPct,
      grossMarginPct,
      orderCount: b.orderCount,
    };
  });

  const avgFoodCostPct = totalNetRevenue > 0 ? round2((totalFoodCost / totalNetRevenue) * 100) : null;
  const target = round2(Number(input.targetFoodCostPct || 35));

  return {
    weeks,
    locationId: input.locationId || 'ALL',
    targetFoodCostPct: target > 0 ? target : 35,
    series,
    summary: {
      totalNetRevenue,
      totalFoodCost,
      totalWasteCost,
      avgFoodCostPct,
      totalOrders,
      activeWeeks,
    },
  };
}
