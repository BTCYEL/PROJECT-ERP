export type StockThresholdStatus = 'BELOW_SAFETY' | 'BELOW_REORDER' | 'NOMINAL';

export interface ThresholdEvalResult {
  status: StockThresholdStatus;
  severity: 'CRITICAL' | 'WARNING' | null;
  onHandQty: number;
  safetyStock: number;
  reorderPoint: number;
  deficitQty: number;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function formatAlertQty(qty: number): string {
  const r = round2(Number(qty || 0));
  return Number.isInteger(r)
    ? r.toLocaleString('en-US')
    : r.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export function evaluateIngredientThreshold(input: {
  onHandQty: number;
  safetyStock: number;
  reorderPoint: number;
}): ThresholdEvalResult {
  const onHandQty = round2(Number(input.onHandQty || 0));
  const safetyStock = Math.max(0, round2(Number(input.safetyStock || 0)));
  const reorderPoint = Math.max(0, round2(Number(input.reorderPoint || 0)));

  if (safetyStock > 0 && onHandQty < safetyStock) {
    return {
      status: 'BELOW_SAFETY',
      severity: 'CRITICAL',
      onHandQty,
      safetyStock,
      reorderPoint,
      deficitQty: round2(safetyStock - onHandQty),
    };
  }

  if (reorderPoint > 0 && onHandQty <= reorderPoint) {
    return {
      status: 'BELOW_REORDER',
      severity: 'WARNING',
      onHandQty,
      safetyStock,
      reorderPoint,
      deficitQty: round2(Math.max(0, reorderPoint - onHandQty)),
    };
  }

  return {
    status: 'NOMINAL',
    severity: null,
    onHandQty,
    safetyStock,
    reorderPoint,
    deficitQty: 0,
  };
}

export function buildThresholdNotification(input: {
  itemName: string;
  sku?: string | null;
  itemType?: string | null;
  uomCode?: string | null;
  locationName?: string | null;
  evalResult: ThresholdEvalResult;
}): {
  type: 'SAFETY_STOCK' | 'LOW_STOCK';
  severity: 'CRITICAL' | 'WARNING';
  title: string;
  message: string;
} | null {
  const { evalResult } = input;
  if (evalResult.status === 'NOMINAL' || !evalResult.severity) return null;

  const uom = String(input.uomCode || '').trim();
  const uomSuffix = uom ? ` ${uom}` : '';
  const locLabel = String(input.locationName || '').trim() || 'All Locations';
  const skuTag = input.sku ? ` (${input.sku})` : '';
  const kindPrefix = input.itemType === 'RAW_MATERIAL' ? 'Raw ingredient' : 'Stock item';

  if (evalResult.status === 'BELOW_SAFETY') {
    const title = `Safety Stock Breach: ${input.itemName} (${locLabel})`.slice(0, 160);
    const message = `${locLabel}: ${kindPrefix} ${input.itemName}${skuTag} is at ${formatAlertQty(evalResult.onHandQty)}${uomSuffix} — ${formatAlertQty(evalResult.deficitQty)}${uomSuffix} below safety stock of ${formatAlertQty(evalResult.safetyStock)}${uomSuffix}.`.slice(0, 500);
    return {
      type: 'SAFETY_STOCK',
      severity: 'CRITICAL',
      title,
      message,
    };
  }

  const title = `Low Stock: ${input.itemName} (${locLabel})`.slice(0, 160);
  const safetyNote =
    evalResult.safetyStock > 0
      ? `; safety stock: ${formatAlertQty(evalResult.safetyStock)}${uomSuffix}`
      : '';
  const message = `${locLabel}: ${input.itemName}${skuTag} has ${formatAlertQty(evalResult.onHandQty)}${uomSuffix} remaining (at or below reorder point of ${formatAlertQty(evalResult.reorderPoint)}${uomSuffix}${safetyNote}).`.slice(0, 500);
  return {
    type: 'LOW_STOCK',
    severity: 'WARNING',
    title,
    message,
  };
}
