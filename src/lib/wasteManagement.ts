export type WasteEntryMode = 'RECIPE_PREP' | 'SINGLE_INGREDIENT';
export type WasteTxnType = 'OUT_WASTE' | 'OUT_SPOILAGE';
export type WasteReasonCategory =
  | 'PREP_TRIM'
  | 'BURNT_OVERCOOKED'
  | 'EXPIRED_SPOILED'
  | 'CONTAMINATION'
  | 'DROPPED_SPILL'
  | 'QUALITY_REJECT'
  | 'OTHER';

export const WASTE_REASON_OPTIONS: Array<{
  value: WasteReasonCategory;
  label: string;
  defaultTxnType: WasteTxnType;
}> = [
  { value: 'PREP_TRIM', label: 'Prep Trim / Butcher Loss', defaultTxnType: 'OUT_WASTE' },
  { value: 'BURNT_OVERCOOKED', label: 'Burnt / Overcooked Batch', defaultTxnType: 'OUT_WASTE' },
  { value: 'DROPPED_SPILL', label: 'Dropped / Kitchen Spill', defaultTxnType: 'OUT_WASTE' },
  { value: 'EXPIRED_SPOILED', label: 'Expired / Spoiled Batch', defaultTxnType: 'OUT_SPOILAGE' },
  { value: 'CONTAMINATION', label: 'Cross-Contamination / Cold Chain Breach', defaultTxnType: 'OUT_SPOILAGE' },
  { value: 'QUALITY_REJECT', label: 'Quality Check Reject', defaultTxnType: 'OUT_WASTE' },
  { value: 'OTHER', label: 'Other Operational Loss', defaultTxnType: 'OUT_WASTE' },
];

export function getWasteReasonLabel(category: WasteReasonCategory | string): string {
  return WASTE_REASON_OPTIONS.find((o) => o.value === category)?.label || String(category || 'Operational Waste');
}

export interface WasteLogItemLine {
  inventoryItemId: string;
  ingredientName: string;
  uomCode: string;
  quantity: number;
  totalCost: number;
}

export interface WasteLogRecord {
  id: string;
  locationId: string;
  locationName: string;
  entryMode: WasteEntryMode;
  txnType: WasteTxnType;
  reasonCategory: WasteReasonCategory;
  reasonNotes: string;
  productId: string | null;
  productName: string | null;
  servingsWasted: number;
  primaryItemId: string | null;
  primaryItemName: string | null;
  items: WasteLogItemLine[];
  totalQuantityBase: number;
  totalLossCost: number;
  loggedBy: string;
  loggedByName: string;
  wastedAt: string;
}

export interface RecipeWasteBomIngredient {
  inventoryItemId: string;
  ingredientName: string;
  uomCode: string;
  baseQtyPerServing: number;
  unitCost: number;
}

export interface RecipeWasteOption {
  id: string;
  sku: string;
  name: string;
  categoryName: string;
  yieldQty: number;
  ingredientCount: number;
  unitDirectCost: number;
  ingredients: RecipeWasteBomIngredient[];
}

export interface WasteManagementSummary {
  totalEvents: number;
  totalLossCost: number;
  prepWasteCost: number;
  spoilageCost: number;
  recipeLinkedCount: number;
  recipeLinkedCost: number;
  topWastedRecipeName: string | null;
  topWastedIngredientName: string | null;
}

function round2(n: number): number {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

export function summarizeWasteLogs(logs: WasteLogRecord[]): WasteManagementSummary {
  let totalLossCost = 0;
  let prepWasteCost = 0;
  let spoilageCost = 0;
  let recipeLinkedCount = 0;
  let recipeLinkedCost = 0;
  const byRecipe = new Map<string, number>();
  const byIngredient = new Map<string, number>();

  for (const log of logs) {
    const loss = Number(log.totalLossCost || 0);
    totalLossCost += loss;
    if (log.txnType === 'OUT_SPOILAGE') spoilageCost += loss;
    else prepWasteCost += loss;

    if (log.productId && log.productName) {
      recipeLinkedCount += 1;
      recipeLinkedCost += loss;
      byRecipe.set(log.productName, (byRecipe.get(log.productName) || 0) + loss);
    }

    for (const line of log.items || []) {
      if (line.ingredientName) {
        byIngredient.set(line.ingredientName, (byIngredient.get(line.ingredientName) || 0) + Number(line.totalCost || 0));
      }
    }
  }

  let topWastedRecipeName: string | null = null;
  let topRecipeVal = -1;
  for (const [name, cost] of byRecipe.entries()) {
    if (cost > topRecipeVal) {
      topRecipeVal = cost;
      topWastedRecipeName = name;
    }
  }

  let topWastedIngredientName: string | null = null;
  let topIngVal = -1;
  for (const [name, cost] of byIngredient.entries()) {
    if (cost > topIngVal) {
      topIngVal = cost;
      topWastedIngredientName = name;
    }
  }

  return {
    totalEvents: logs.length,
    totalLossCost: round2(totalLossCost),
    prepWasteCost: round2(prepWasteCost),
    spoilageCost: round2(spoilageCost),
    recipeLinkedCount,
    recipeLinkedCost: round2(recipeLinkedCost),
    topWastedRecipeName,
    topWastedIngredientName,
  };
}
