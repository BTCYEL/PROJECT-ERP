export type MenuEngineeringClass = 'STAR' | 'PLOWHORSE' | 'PUZZLE' | 'DOG';

export interface MenuEngineeringInputItem {
  productId: string;
  sku: string;
  name: string;
  imageUrl?: string | null;
  categoryId: string;
  categoryName: string;
  isAvailable: boolean;
  sellingPrice: number;
  ingredientCost: number;
  packagingCost: number;
  directLaborCost: number;
  unitDirectCost: number;
  targetFoodCostPct: number;
  unitsSold: number;
  realizedRevenue?: number;
  realizedCogs?: number;
}

export interface MenuEngineeringAnalyzedItem {
  productId: string;
  sku: string;
  name: string;
  imageUrl: string | null;
  categoryId: string;
  categoryName: string;
  isAvailable: boolean;
  sellingPrice: number;
  ingredientCost: number;
  packagingCost: number;
  directLaborCost: number;
  unitDirectCost: number;
  unitContributionMargin: number;
  marginPct: number;
  foodCostPct: number;
  targetFoodCostPct: number;
  unitsSold: number;
  menuMixPct: number;
  totalRevenue: number;
  totalDirectCost: number;
  totalContributionMargin: number;
  isPopular: boolean;
  isHighMargin: boolean;
  classification: MenuEngineeringClass;
  label: string;
  actionTitle: string;
  actionRecommendation: string;
}

export interface MenuEngineeringQuadrantStats {
  count: number;
  unitsSold: number;
  totalRevenue: number;
  totalContributionMargin: number;
  marginSharePct: number;
}

export interface MenuEngineeringSummary {
  itemCount: number;
  activeSellingCount: number;
  totalUnitsSold: number;
  totalRevenue: number;
  totalDirectCost: number;
  totalContributionMargin: number;
  weightedAvgContributionMargin: number;
  popularityBenchmarkPct: number;
  overallFoodCostPct: number;
  counts: Record<MenuEngineeringClass, number>;
  quadrants: Record<MenuEngineeringClass, MenuEngineeringQuadrantStats>;
}

export interface MenuEngineeringReport {
  summary: MenuEngineeringSummary;
  items: MenuEngineeringAnalyzedItem[];
}

function round2(n: number): number {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

export function getMenuClassLabel(classification: MenuEngineeringClass): string {
  switch (classification) {
    case 'STAR':
      return 'Star';
    case 'PLOWHORSE':
      return 'Plowhorse';
    case 'PUZZLE':
      return 'Puzzle';
    case 'DOG':
      return 'Dog';
  }
}

export function getMenuActionGuidance(
  classification: MenuEngineeringClass,
  foodCostPct: number,
  targetFoodCostPct: number,
): { title: string; recommendation: string } {
  const overCostTarget = targetFoodCostPct > 0 && foodCostPct > targetFoodCostPct;
  switch (classification) {
    case 'STAR':
      return {
        title: 'Protect & Showcase',
        recommendation: overCostTarget
          ? 'High demand & strong margin, though ingredient cost exceeds target. Lock portion weights and showcase prominently at POS.'
          : 'Core profit driver. Keep recipe quality consistent, highlight on menu boards & POS, and protect current pricing.',
      };
    case 'PLOWHORSE':
      return {
        title: 'Optimize Margin',
        recommendation: overCostTarget
          ? 'Crowd favorite with food cost above target. Trim waste/portion variance, renegotiate ingredients, or test a slight price lift.'
          : 'High popularity with below-average margin. Pair with high-margin sides/drinks in combos or apply a modest price increase.',
      };
    case 'PUZZLE':
      return {
        title: 'Promote & Upsell',
        recommendation:
          'Strong contribution margin per order but low volume. Feature in cashier upsells, POS spotlights, and crew daily huddle promos.',
      };
    case 'DOG':
      return {
        title: 'Re-engineer or Retire',
        recommendation: overCostTarget
          ? 'Low volume with food cost above target. Redesign recipe cost, adjust price, or drop from menu to cut prep complexity.'
          : 'Below-average volume and margin. Test repositioning as a limited-time add-on or retire to focus on higher-yield items.',
      };
  }
}

export function analyzeMenuEngineering(
  inputs: MenuEngineeringInputItem[],
  options?: { popularityFactor?: number },
): MenuEngineeringReport {
  const popularityFactor = options?.popularityFactor ?? 0.7;
  const itemCount = inputs.length;

  const normalized = inputs.map((item) => {
    const sellingPrice = round2(Number(item.sellingPrice || 0));
    const ingredientCost = round2(Number(item.ingredientCost || 0));
    const packagingCost = round2(Number(item.packagingCost || 0));
    const directLaborCost = round2(Number(item.directLaborCost || 0));
    const unitDirectCost = round2(
      Number(item.unitDirectCost ?? ingredientCost + packagingCost + directLaborCost),
    );
    const unitContributionMargin = round2(sellingPrice - unitDirectCost);
    const marginPct = sellingPrice > 0 ? round2((unitContributionMargin / sellingPrice) * 100) : 0;
    const foodCostPct = sellingPrice > 0 ? round2((ingredientCost / sellingPrice) * 100) : 0;
    const unitsSold = Math.max(0, Math.round(Number(item.unitsSold || 0)));
    const totalRevenue =
      item.realizedRevenue !== undefined && item.realizedRevenue > 0
        ? round2(Number(item.realizedRevenue))
        : round2(sellingPrice * unitsSold);
    const totalDirectCost = round2(unitDirectCost * unitsSold);
    const totalContributionMargin = round2(unitContributionMargin * unitsSold);

    return {
      productId: item.productId,
      sku: item.sku,
      name: item.name,
      imageUrl: item.imageUrl ?? null,
      categoryId: item.categoryId,
      categoryName: item.categoryName,
      isAvailable: Boolean(item.isAvailable),
      sellingPrice,
      ingredientCost,
      packagingCost,
      directLaborCost,
      unitDirectCost,
      unitContributionMargin,
      marginPct,
      foodCostPct,
      targetFoodCostPct: round2(Number(item.targetFoodCostPct || 35)),
      unitsSold,
      totalRevenue,
      totalDirectCost,
      totalContributionMargin,
    };
  });

  const totalUnitsSold = normalized.reduce((s, i) => s + i.unitsSold, 0);
  const totalRevenue = round2(normalized.reduce((s, i) => s + i.totalRevenue, 0));
  const totalDirectCost = round2(normalized.reduce((s, i) => s + i.totalDirectCost, 0));
  const totalContributionMargin = round2(
    normalized.reduce((s, i) => s + i.totalContributionMargin, 0),
  );
  const totalIngredientCostSold = round2(
    normalized.reduce((s, i) => s + i.ingredientCost * i.unitsSold, 0),
  );

  // Kasavana & Smith popularity cutoff: (100% / N) * 70%
  const popularityBenchmarkPct = itemCount > 0 ? round2((100 / itemCount) * popularityFactor) : 0;

  // Weighted average contribution margin across units sold (falls back to simple average when 0 sales)
  const weightedAvgContributionMargin =
    totalUnitsSold > 0
      ? round2(totalContributionMargin / totalUnitsSold)
      : itemCount > 0
        ? round2(
            normalized.reduce((s, i) => s + i.unitContributionMargin, 0) / itemCount,
          )
        : 0;

  const counts: Record<MenuEngineeringClass, number> = {
    STAR: 0,
    PLOWHORSE: 0,
    PUZZLE: 0,
    DOG: 0,
  };

  const quadrants: Record<MenuEngineeringClass, MenuEngineeringQuadrantStats> = {
    STAR: { count: 0, unitsSold: 0, totalRevenue: 0, totalContributionMargin: 0, marginSharePct: 0 },
    PLOWHORSE: { count: 0, unitsSold: 0, totalRevenue: 0, totalContributionMargin: 0, marginSharePct: 0 },
    PUZZLE: { count: 0, unitsSold: 0, totalRevenue: 0, totalContributionMargin: 0, marginSharePct: 0 },
    DOG: { count: 0, unitsSold: 0, totalRevenue: 0, totalContributionMargin: 0, marginSharePct: 0 },
  };

  const items: MenuEngineeringAnalyzedItem[] = normalized.map((item) => {
    const menuMixPct = totalUnitsSold > 0 ? round2((item.unitsSold / totalUnitsSold) * 100) : 0;
    const isPopular = totalUnitsSold > 0 && menuMixPct >= popularityBenchmarkPct;
    const isHighMargin = item.unitContributionMargin >= weightedAvgContributionMargin;

    let classification: MenuEngineeringClass;
    if (isPopular && isHighMargin) classification = 'STAR';
    else if (isPopular && !isHighMargin) classification = 'PLOWHORSE';
    else if (!isPopular && isHighMargin) classification = 'PUZZLE';
    else classification = 'DOG';

    counts[classification] += 1;
    quadrants[classification].count += 1;
    quadrants[classification].unitsSold += item.unitsSold;
    quadrants[classification].totalRevenue = round2(
      quadrants[classification].totalRevenue + item.totalRevenue,
    );
    quadrants[classification].totalContributionMargin = round2(
      quadrants[classification].totalContributionMargin + item.totalContributionMargin,
    );

    const guidance = getMenuActionGuidance(
      classification,
      item.foodCostPct,
      item.targetFoodCostPct,
    );

    return {
      ...item,
      menuMixPct,
      isPopular,
      isHighMargin,
      classification,
      label: getMenuClassLabel(classification),
      actionTitle: guidance.title,
      actionRecommendation: guidance.recommendation,
    };
  });

  // Sort primarily by total contribution margin desc, then units sold desc, then unit CM desc
  items.sort(
    (a, b) =>
      b.totalContributionMargin - a.totalContributionMargin ||
      b.unitsSold - a.unitsSold ||
      b.unitContributionMargin - a.unitContributionMargin ||
      a.name.localeCompare(b.name),
  );

  for (const key of ['STAR', 'PLOWHORSE', 'PUZZLE', 'DOG'] as MenuEngineeringClass[]) {
    quadrants[key].marginSharePct =
      totalContributionMargin > 0
        ? round2((quadrants[key].totalContributionMargin / totalContributionMargin) * 100)
        : 0;
  }

  const activeSellingCount = items.filter((i) => i.unitsSold > 0).length;
  const overallFoodCostPct =
    totalRevenue > 0 ? round2((totalIngredientCostSold / totalRevenue) * 100) : 0;

  return {
    summary: {
      itemCount,
      activeSellingCount,
      totalUnitsSold,
      totalRevenue,
      totalDirectCost,
      totalContributionMargin,
      weightedAvgContributionMargin,
      popularityBenchmarkPct,
      overallFoodCostPct,
      counts,
      quadrants,
    },
    items,
  };
}
