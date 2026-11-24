import { randomUUID } from 'crypto';
import { db } from './db.ts';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const round4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000;

export function writeAuditLog(
  userId: string | null,
  userName: string | null,
  action: string,
  entityType: string,
  entityId: string,
  details?: unknown,
) {
  db.prepare(
    'INSERT INTO audit_logs (id, user_id, user_name, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    randomUUID(),
    userId,
    userName,
    action,
    entityType,
    entityId,
    details ? JSON.stringify(details) : null,
  );
}

export function createNotification(type: string, severity: 'INFO' | 'WARNING' | 'CRITICAL', title: string, message: string) {
  const existing = db
    .prepare('SELECT id FROM notifications WHERE type = ? AND title = ? AND is_read = 0')
    .get(type, title);
  if (existing) return;
  db.prepare('INSERT INTO notifications (id, type, severity, title, message) VALUES (?, ?, ?, ?, ?)').run(
    randomUUID(),
    type,
    severity,
    title,
    message,
  );
}

export function convertQty(qty: number, fromUomId: string, toUomId: string): number {
  if (fromUomId === toUomId) return qty;
  const direct = db
    .prepare('SELECT factor FROM unit_conversions WHERE from_uom_id = ? AND to_uom_id = ?')
    .get(fromUomId, toUomId) as { factor: number } | undefined;
  if (direct) return qty * direct.factor;

  const inverse = db
    .prepare('SELECT factor FROM unit_conversions WHERE from_uom_id = ? AND to_uom_id = ?')
    .get(toUomId, fromUomId) as { factor: number } | undefined;
  if (inverse) return qty / inverse.factor;

  throw new Error(`Missing unit conversion between ${fromUomId} and ${toUomId}`);
}

export function receiveStockTx(input: {
  inventoryItemId: string;
  locationId: string;
  quantity: number;
  unitCost: number;
  batchNumber: string;
  expiryDate?: string | null;
  txnType?: string;
  referenceType?: string;
  referenceId?: string;
  userId?: string;
  notes?: string;
}) {
  if (input.quantity <= 0) throw new Error('Received quantity must be positive');
  const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(input.inventoryItemId) as any;
  if (!item) throw new Error('Inventory item not found');

  const agg = db
    .prepare('SELECT COALESCE(SUM(remaining_qty), 0) AS qty FROM stock_batches WHERE inventory_item_id = ? AND remaining_qty > 0')
    .get(item.id) as { qty: number };

  const currentQty = agg.qty || 0;
  const newTotal = currentQty + input.quantity;
  const newWac = newTotal > 0 ? (currentQty * item.weighted_avg_cost + input.quantity * input.unitCost) / newTotal : input.unitCost;

  const batchId = randomUUID();
  db.prepare(`
    INSERT INTO stock_batches (id, inventory_item_id, location_id, batch_number, initial_qty, remaining_qty, unit_cost, expiry_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    batchId,
    item.id,
    input.locationId,
    input.batchNumber,
    round4(input.quantity),
    round4(input.quantity),
    round4(input.unitCost),
    input.expiryDate || null,
  );

  db.prepare('UPDATE inventory_items SET last_unit_cost = ?, weighted_avg_cost = ? WHERE id = ?').run(
    round4(input.unitCost),
    round4(newWac),
    item.id,
  );

  const totalCost = round2(input.quantity * input.unitCost);
  db.prepare(`
    INSERT INTO inventory_transactions (id, inventory_item_id, location_id, batch_id, txn_type, quantity_delta, unit_cost, total_cost, reference_type, reference_id, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    item.id,
    input.locationId,
    batchId,
    input.txnType || 'IN_PURCHASE',
    round4(input.quantity),
    round4(input.unitCost),
    totalCost,
    input.referenceType || null,
    input.referenceId || null,
    input.notes || null,
    input.userId || null,
  );

  return { batchId, totalCost };
}

export function deductStockTx(input: {
  inventoryItemId: string;
  locationId: string;
  quantity: number;
  txnType: string;
  referenceType: string;
  referenceId: string;
  userId?: string;
  notes?: string;
  allowNegative?: boolean;
}) {
  let remaining = input.quantity;
  if (remaining <= 0) return { totalCogs: 0, consumedBatches: [] as Array<{ qty: number; unitCost: number }> };

  const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(input.inventoryItemId) as any;
  if (!item) throw new Error(`Inventory item ${input.inventoryItemId} not found`);

  const batches = db
    .prepare(`
      SELECT id, remaining_qty, unit_cost
      FROM stock_batches
      WHERE inventory_item_id = ? AND location_id = ? AND remaining_qty > 0
      ORDER BY received_at ASC
    `)
    .all(item.id, input.locationId) as Array<{ id: string; remaining_qty: number; unit_cost: number }>;

  let totalCogs = 0;
  const consumedBatches: Array<{ qty: number; unitCost: number }> = [];

  for (const b of batches) {
    if (remaining <= 0) break;
    const take = Math.min(b.remaining_qty, remaining);
    const effectiveCost = item.costing_method === 'WEIGHTED_AVERAGE' ? item.weighted_avg_cost : b.unit_cost;

    db.prepare('UPDATE stock_batches SET remaining_qty = ? WHERE id = ?').run(round4(b.remaining_qty - take), b.id);

    const lineCost = round2(take * effectiveCost);
    db.prepare(`
      INSERT INTO inventory_transactions (id, inventory_item_id, location_id, batch_id, txn_type, quantity_delta, unit_cost, total_cost, reference_type, reference_id, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      item.id,
      input.locationId,
      b.id,
      input.txnType,
      round4(-take),
      round4(effectiveCost),
      lineCost,
      input.referenceType,
      input.referenceId,
      input.notes || null,
      input.userId || null,
    );

    totalCogs += lineCost;
    consumedBatches.push({ qty: take, unitCost: effectiveCost });
    remaining = round4(remaining - take);
  }

  if (remaining > 0) {
    if (input.allowNegative === false) {
      throw new Error(`Insufficient stock for ${item.name} (short by ${remaining})`);
    }
    const fallbackCost = item.costing_method === 'WEIGHTED_AVERAGE' ? item.weighted_avg_cost : item.last_unit_cost;
    const shortageCost = round2(remaining * fallbackCost);
    db.prepare(`
      INSERT INTO inventory_transactions (id, inventory_item_id, location_id, batch_id, txn_type, quantity_delta, unit_cost, total_cost, reference_type, reference_id, notes, created_by)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      item.id,
      input.locationId,
      input.txnType,
      round4(-remaining),
      round4(fallbackCost),
      shortageCost,
      input.referenceType,
      input.referenceId,
      `${input.notes || ''} [UNBATCHED_SHORTAGE]`.trim(),
      input.userId || null,
    );
    totalCogs += shortageCost;
    consumedBatches.push({ qty: remaining, unitCost: fallbackCost });
  }

  // Workflow D check: low stock notification
  const postAgg = db
    .prepare('SELECT COALESCE(SUM(remaining_qty), 0) AS qty FROM stock_batches WHERE inventory_item_id = ? AND location_id = ?')
    .get(item.id, input.locationId) as { qty: number };
  if (postAgg.qty <= item.reorder_point) {
    createNotification(
      'LOW_STOCK',
      'WARNING',
      `Low Stock: ${item.name}`,
      `Remaining ${round2(postAgg.qty)} is at or below reorder point (${item.reorder_point}).`,
    );
  }

  return { totalCogs: round2(totalCogs), consumedBatches };
}

export function getProductCostingList() {
  const products = db
    .prepare(`
      SELECT p.*, c.name AS category_name, tc.code AS tax_code, tc.rate_percent, tc.is_inclusive
      FROM products p
      JOIN categories c ON c.id = p.category_id
      LEFT JOIN tax_configs tc ON tc.id = p.tax_config_id
      ORDER BY c.sort_order ASC, p.name ASC
    `)
    .all() as any[];

  return products.map((p) => {
    const variants = db.prepare('SELECT * FROM product_variants WHERE product_id = ?').all(p.id) as any[];
    const modifiers = db.prepare('SELECT * FROM modifier_options WHERE product_id = ?').all(p.id) as any[];
    const recipe = db.prepare('SELECT * FROM recipes WHERE product_id = ?').get(p.id) as any;

    let ingredients: any[] = [];
    let ingredientCost = 0;

    if (recipe) {
      ingredients = db
        .prepare(`
          SELECT ri.*, ii.name AS item_name, ii.base_uom_id, ii.costing_method, ii.last_unit_cost, ii.weighted_avg_cost, u.code AS uom_code
          FROM recipe_ingredients ri
          JOIN inventory_items ii ON ii.id = ri.inventory_item_id
          JOIN uoms u ON u.id = ri.uom_id
          WHERE ri.recipe_id = ?
        `)
        .all(recipe.id) as any[];

      for (const ing of ingredients) {
        const effQty = (ing.quantity * (1 + ing.waste_factor_pct / 100)) / (recipe.yield_qty || 1);
        const baseQty = convertQty(effQty, ing.uom_id, ing.base_uom_id);
        const unitCost = ing.costing_method === 'WEIGHTED_AVERAGE' ? ing.weighted_avg_cost : ing.last_unit_cost;
        const lineCost = round2(baseQty * unitCost);
        ing.computedLineCost = lineCost;
        ingredientCost += lineCost;
      }
    }

    ingredientCost = round2(ingredientCost);
    const directCost = round2(ingredientCost + p.packaging_cost + p.direct_labor_cost);
    const grossProfit = round2(p.base_price - directCost);
    const foodCostPct = p.base_price > 0 ? round2((ingredientCost / p.base_price) * 100) : 0;
    const marginPct = p.base_price > 0 ? round2((grossProfit / p.base_price) * 100) : 0;

    return {
      ...p,
      variants,
      modifiers,
      recipe: recipe ? { ...recipe, ingredients } : null,
      costing: {
        ingredientCost,
        packagingCost: p.packaging_cost,
        directLaborCost: p.direct_labor_cost,
        directCost,
        grossProfit,
        foodCostPct,
        marginPct,
        isMarginAlert: foodCostPct > p.target_food_cost_pct,
      },
    };
  });
}

function getAccountMap() {
  const rows = db.prepare('SELECT id, code FROM accounts').all() as Array<{ id: string; code: string }>;
  return new Map(rows.map((r) => [r.code, r.id]));
}

export function processSale(
  dto: {
    clientTxnId?: string;
    locationId: string;
    customerId?: string;
    channel?: string;
    discountAmount?: number;
    notes?: string;
    isOfflineSynced?: boolean;
    soldAt?: string;
    items: Array<{
      productId: string;
      variantId?: string;
      quantity: number;
      modifiers?: Array<{ id: string; name: string; priceDelta: number }>;
      kitchenNotes?: string;
    }>;
    payments: Array<{ method: string; amount: number; referenceNo?: string }>;
  },
  cashierId: string,
  cashierName: string,
) {
  if (dto.clientTxnId) {
    const existing = db.prepare('SELECT * FROM sales WHERE client_txn_id = ?').get(dto.clientTxnId) as any;
    if (existing) {
      const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(existing.id);
      const payments = db.prepare('SELECT * FROM payments WHERE sale_id = ?').all(existing.id);
      return { ...existing, items, payments };
    }
  }

  if (!dto.items?.length) throw new Error('Order cart is empty');

  const tx = db.transaction(() => {
    const saleId = randomUUID();
    const receiptNumber = `OR-${Date.now().toString().slice(-7)}`;
    const soldAt = dto.soldAt || new Date().toISOString();
    let subtotal = 0;
    let totalTax = 0;
    let totalCogs = 0;

    const preparedItems: any[] = [];

    for (const line of dto.items) {
      const prod = db
        .prepare(`
          SELECT p.*, tc.rate_percent, tc.is_inclusive, tc.is_active AS tax_active
          FROM products p
          LEFT JOIN tax_configs tc ON tc.id = p.tax_config_id
          WHERE p.id = ?
        `)
        .get(line.productId) as any;
      if (!prod) throw new Error(`Product ${line.productId} not found`);

      const variant = line.variantId
        ? (db.prepare('SELECT * FROM product_variants WHERE id = ?').get(line.variantId) as any)
        : null;

      const modIds = (line.modifiers || []).map((m) => m.id);
      const dbMods = modIds.length
        ? (db
            .prepare(`SELECT * FROM modifier_options WHERE id IN (${modIds.map(() => '?').join(',')})`)
            .all(...modIds) as any[])
        : [];

      const modPrice = dbMods.reduce((s, m) => s + m.price_delta, 0);
      const unitPrice = round2(prod.base_price + (variant?.price_delta || 0) + modPrice);
      const grossLine = round2(unitPrice * line.quantity);

      let lineTax = 0;
      if (prod.tax_active && prod.rate_percent > 0) {
        const r = prod.rate_percent / 100;
        if (prod.is_inclusive) {
          lineTax = round2(grossLine - grossLine / (1 + r));
          subtotal += round2(grossLine - lineTax);
        } else {
          lineTax = round2(grossLine * r);
          subtotal += grossLine;
        }
      } else {
        subtotal += grossLine;
      }
      totalTax += lineTax;

      // BOM Recipe deduction
      const recipe = db.prepare('SELECT * FROM recipes WHERE product_id = ?').get(prod.id) as any;
      let itemCogs = 0;
      const portionMult = variant?.portion_multiplier || 1;

      if (recipe) {
        const recIngs = db
          .prepare(`
            SELECT ri.*, ii.base_uom_id
            FROM recipe_ingredients ri
            JOIN inventory_items ii ON ii.id = ri.inventory_item_id
            WHERE ri.recipe_id = ?
          `)
          .all(recipe.id) as any[];

        for (const ri of recIngs) {
          const rawQty =
            ((ri.quantity * (1 + ri.waste_factor_pct / 100)) / (recipe.yield_qty || 1)) *
            portionMult *
            line.quantity;
          const baseQty = convertQty(rawQty, ri.uom_id, ri.base_uom_id);
          const deducted = deductStockTx({
            inventoryItemId: ri.inventory_item_id,
            locationId: dto.locationId,
            quantity: baseQty,
            txnType: 'OUT_SALE',
            referenceType: 'SALE',
            referenceId: saleId,
            userId: cashierId,
            notes: `POS ${receiptNumber} - ${prod.name}`,
          });
          itemCogs += deducted.totalCogs;
        }
      }

      // Modifier deductions
      for (const m of dbMods) {
        if (m.inventory_item_id && m.deduct_qty > 0 && m.uom_id) {
          const itemRow = db.prepare('SELECT base_uom_id FROM inventory_items WHERE id = ?').get(m.inventory_item_id) as any;
          if (itemRow) {
            const baseQty = convertQty(m.deduct_qty * line.quantity, m.uom_id, itemRow.base_uom_id);
            const deducted = deductStockTx({
              inventoryItemId: m.inventory_item_id,
              locationId: dto.locationId,
              quantity: baseQty,
              txnType: 'OUT_SALE',
              referenceType: 'SALE',
              referenceId: saleId,
              userId: cashierId,
              notes: `Modifier ${m.name}`,
            });
            itemCogs += deducted.totalCogs;
          }
        }
      }

      itemCogs = round2(itemCogs);
      totalCogs += itemCogs;
      preparedItems.push({
        id: randomUUID(),
        productId: prod.id,
        variantId: variant?.id || null,
        productName: prod.name,
        variantName: variant?.name || 'Standard',
        quantity: line.quantity,
        unitPrice,
        lineTotal: grossLine,
        cogsAmount: itemCogs,
        modifiersJson: JSON.stringify(line.modifiers || []),
        kitchenNotes: line.kitchenNotes || null,
      });
    }

    const discount = round2(dto.discountAmount || 0);
    const totalAmount = round2(Math.max(0, subtotal + totalTax - discount));
    const paidSum = round2((dto.payments || []).reduce((s, p) => s + p.amount, 0));
    if (paidSum < totalAmount) {
      throw new Error(`Payment (${paidSum}) is less than order total (${totalAmount})`);
    }

    const locCfg = db.prepare('SELECT kds_enabled FROM locations WHERE id = ?').get(dto.locationId) as { kds_enabled?: number } | undefined;
    const initialKdsStatus = locCfg && locCfg.kds_enabled === 0 ? 'COMPLETED' : 'PENDING';

    db.prepare(`
      INSERT INTO sales (id, receipt_number, client_txn_id, location_id, cashier_id, customer_id, channel, status, kds_status, subtotal, discount_amount, tax_amount, total_amount, total_cogs, notes, is_offline_synced, sold_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      saleId,
      receiptNumber,
      dto.clientTxnId || null,
      dto.locationId,
      cashierId,
      dto.customerId || null,
      dto.channel || 'WALK_IN',
      initialKdsStatus,
      round2(subtotal),
      discount,
      round2(totalTax),
      totalAmount,
      round2(totalCogs),
      dto.notes || null,
      dto.isOfflineSynced ? 1 : 0,
      soldAt,
    );

    const insSI = db.prepare(`
      INSERT INTO sale_items (id, sale_id, product_id, variant_id, product_name, variant_name, quantity, unit_price, line_total, cogs_amount, modifiers_json, kitchen_notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const pi of preparedItems) {
      insSI.run(
        pi.id,
        saleId,
        pi.productId,
        pi.variantId,
        pi.productName,
        pi.variantName,
        pi.quantity,
        pi.unitPrice,
        pi.lineTotal,
        pi.cogsAmount,
        pi.modifiersJson,
        pi.kitchenNotes,
      );
    }

    const insPay = db.prepare('INSERT INTO payments (id, sale_id, method, amount, reference_no, paid_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const p of dto.payments) {
      insPay.run(randomUUID(), saleId, p.method, round2(p.amount), p.referenceNo || null, soldAt);
    }

    // Customer loyalty points (1 point per PHP 50 spent)
    if (dto.customerId) {
      const pts = Math.floor(totalAmount / 50);
      if (pts > 0) {
        db.prepare('UPDATE customers SET loyalty_points = loyalty_points + ? WHERE id = ?').run(pts, dto.customerId);
      }
    }

    // Post balanced Double-Entry Journal Entry
    const acc = getAccountMap();
    const cashAcc = acc.get('1000');
    const bankAcc = acc.get('1010') || cashAcc;
    const invAcc = acc.get('1200');
    const taxAcc = acc.get('2100');
    const revAcc = acc.get('4000');
    const cogsAcc = acc.get('5000');

    if (cashAcc && invAcc && revAcc && cogsAcc) {
      const jeId = randomUUID();
      db.prepare('INSERT INTO journal_entries (id, entry_number, entry_date, description, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(jeId, `JE-POS-${receiptNumber}`, soldAt, `POS Sale ${receiptNumber}`, 'SALE', saleId);

      const insJL = db.prepare('INSERT INTO journal_lines (id, journal_entry_id, account_id, debit, credit, memo) VALUES (?, ?, ?, ?, ?, ?)');
      let rem = totalAmount;
      for (const p of dto.payments) {
        if (rem <= 0) break;
        const settle = round2(Math.min(p.amount, rem));
        insJL.run(randomUUID(), jeId, p.method === 'CASH' ? cashAcc : bankAcc!, settle, 0, `${p.method} payment`);
        rem = round2(rem - settle);
      }
      const netRev = round2(Math.max(0, subtotal - discount));
      insJL.run(randomUUID(), jeId, revAcc, 0, netRev, 'Food & Beverage Sales');
      if (totalTax > 0 && taxAcc) {
        insJL.run(randomUUID(), jeId, taxAcc, 0, round2(totalTax), 'Output Tax Payable');
      }
      if (totalCogs > 0) {
        insJL.run(randomUUID(), jeId, cogsAcc, round2(totalCogs), 0, 'COGS Recognition');
        insJL.run(randomUUID(), jeId, invAcc, 0, round2(totalCogs), 'Inventory Asset Deduction');
      }
    }

    writeAuditLog(cashierId, cashierName, 'POS_SALE', 'Sale', saleId, { receiptNumber, totalAmount, totalCogs });

    const createdSale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId) as Record<string, any>;
    return {
      ...createdSale,
      items: preparedItems,
      payments: dto.payments,
    };
  });

  return tx();
}

export function refundSale(saleId: string, reason: string, userId: string, userName: string) {
  return db.transaction(() => {
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId) as any;
    if (!sale) throw new Error('Sale not found');
    if (sale.status === 'REFUNDED') throw new Error('Sale already refunded');

    db.prepare('UPDATE sales SET status = ?, kds_status = ?, notes = ? WHERE id = ?').run(
      'REFUNDED',
      'CANCELLED',
      `${sale.notes || ''} [REFUNDED: ${reason}]`.trim(),
      saleId,
    );

    const origJe = db
      .prepare("SELECT * FROM journal_entries WHERE reference_type = 'SALE' AND reference_id = ? AND is_reversed = 0")
      .get(saleId) as any;

    if (origJe) {
      db.prepare('UPDATE journal_entries SET is_reversed = 1 WHERE id = ?').run(origJe.id);
      const revJeId = randomUUID();
      db.prepare('INSERT INTO journal_entries (id, entry_number, entry_date, description, reference_type, reference_id, reversal_of_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(revJeId, `REV-${origJe.entry_number}`, new Date().toISOString(), `Refund Reversal: ${reason}`, 'SALE_REFUND', saleId, origJe.id);

      const lines = db.prepare('SELECT * FROM journal_lines WHERE journal_entry_id = ?').all(origJe.id) as any[];
      const insJL = db.prepare('INSERT INTO journal_lines (id, journal_entry_id, account_id, debit, credit, memo) VALUES (?, ?, ?, ?, ?, ?)');
      for (const l of lines) {
        insJL.run(randomUUID(), revJeId, l.account_id, l.credit, l.debit, `Reversal: ${l.memo || ''}`);
      }
    }

    writeAuditLog(userId, userName, 'REFUND_SALE', 'Sale', saleId, { receiptNumber: sale.receipt_number, reason });
    return db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  })();
}

export function getDashboardSummary(params: { from?: string; to?: string; locationId?: string }) {
  const to = params.to || new Date().toISOString();
  const from = params.from || new Date(Date.now() - 30 * 86400000).toISOString();
  const locClause = params.locationId ? 'AND location_id = ?' : '';
  const locArgs = params.locationId ? [from, to, params.locationId] : [from, to];

  const salesAgg = db
    .prepare(`
      SELECT
        COALESCE(SUM(total_amount), 0) AS total_sales,
        COALESCE(SUM(total_cogs), 0) AS total_cogs,
        COALESCE(SUM(tax_amount), 0) AS total_tax,
        COUNT(*) AS txn_count
      FROM sales
      WHERE status = 'COMPLETED' AND sold_at >= ? AND sold_at <= ? ${locClause}
    `)
    .get(...locArgs) as any;

  const expAgg = db
    .prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total_expenses
      FROM expenses
      WHERE expense_date >= ? AND expense_date <= ? ${locClause}
    `)
    .get(...locArgs) as any;

  const pendingPOs = (
    db.prepare("SELECT COUNT(*) AS cnt FROM purchase_orders WHERE status IN ('PENDING_APPROVAL', 'PENDING_MANAGER_SIGNATURE', 'APPROVED', 'PARTIAL')").get() as any
  ).cnt;

  const totalSales = round2(salesAgg.total_sales);
  const totalCogs = round2(salesAgg.total_cogs);
  const totalExpenses = round2(expAgg.total_expenses);
  const grossProfit = round2(totalSales - totalCogs);
  const netProfit = round2(grossProfit - totalExpenses);
  const avgTicket = salesAgg.txn_count > 0 ? round2(totalSales / salesAgg.txn_count) : 0;

  const invLocJoin = params.locationId ? 'AND b.location_id = ?' : '';
  const invRows = db
    .prepare(`
      SELECT i.id, i.sku, i.name, u.code AS uom, i.reorder_point,
        COALESCE(SUM(b.remaining_qty), 0) AS current_qty,
        COALESCE(SUM(b.remaining_qty * b.unit_cost), 0) AS stock_value
      FROM inventory_items i
      JOIN uoms u ON u.id = i.base_uom_id
      LEFT JOIN stock_batches b ON b.inventory_item_id = i.id ${invLocJoin}
      GROUP BY i.id
    `)
    .all(...(params.locationId ? [params.locationId] : [])) as any[];

  const inventoryValuation = round2(invRows.reduce((s, r) => s + r.stock_value, 0));
  const lowStockItems = invRows.filter((r) => r.current_qty <= r.reorder_point);

  const salesByPayment = db
    .prepare(`
      SELECT p.method, COALESCE(SUM(p.amount), 0) AS total
      FROM payments p
      JOIN sales s ON s.id = p.sale_id
      WHERE s.status = 'COMPLETED' AND s.sold_at >= ? AND s.sold_at <= ? ${params.locationId ? 'AND s.location_id = ?' : ''}
      GROUP BY p.method
    `)
    .all(...locArgs) as any[];

  const salesByLocation = db
    .prepare(`
      SELECT l.id, l.name, COUNT(s.id) AS orders, COALESCE(SUM(s.total_amount), 0) AS revenue, COALESCE(SUM(s.total_cogs), 0) AS cogs
      FROM locations l
      LEFT JOIN sales s ON s.location_id = l.id AND s.status = 'COMPLETED' AND s.sold_at >= ? AND s.sold_at <= ?
      WHERE l.type = 'FOOD_TRUCK'
      GROUP BY l.id
    `)
    .all(from, to) as any[];

  const topProducts = db
    .prepare(`
      SELECT si.product_name, SUM(si.quantity) AS qty_sold, SUM(si.line_total) AS revenue, SUM(si.cogs_amount) AS cogs
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      WHERE s.status = 'COMPLETED' AND s.sold_at >= ? AND s.sold_at <= ? ${params.locationId ? 'AND s.location_id = ?' : ''}
      GROUP BY si.product_id, si.product_name
      ORDER BY revenue DESC
      LIMIT 6
    `)
    .all(...locArgs) as any[];

  const dailyTrends = db
    .prepare(`
      SELECT substr(sold_at, 1, 10) AS day, COALESCE(SUM(total_amount), 0) AS revenue, COALESCE(SUM(total_cogs), 0) AS cogs, COUNT(*) AS orders
      FROM sales
      WHERE status = 'COMPLETED' AND sold_at >= ? AND sold_at <= ? ${locClause}
      GROUP BY substr(sold_at, 1, 10)
      ORDER BY day ASC
    `)
    .all(...locArgs) as any[];

  const salesByCategory = db
    .prepare(`
      SELECT c.name AS category, COALESCE(SUM(si.line_total), 0) AS revenue
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      JOIN products p ON p.id = si.product_id
      JOIN categories c ON c.id = p.category_id
      WHERE s.status = 'COMPLETED' AND s.sold_at >= ? AND s.sold_at <= ? ${params.locationId ? 'AND s.location_id = ?' : ''}
      GROUP BY c.id, c.name
      ORDER BY revenue DESC
    `)
    .all(...locArgs) as any[];

  const expiringBatches = db
    .prepare(`
      SELECT b.id, b.batch_number, b.remaining_qty, b.expiry_date, i.name AS item_name, u.code AS uom, l.name AS location_name
      FROM stock_batches b
      JOIN inventory_items i ON i.id = b.inventory_item_id
      JOIN uoms u ON u.id = i.base_uom_id
      JOIN locations l ON l.id = b.location_id
      WHERE b.remaining_qty > 0 AND b.expiry_date IS NOT NULL AND b.expiry_date <= datetime('now', '+4 days')
      ${params.locationId ? 'AND b.location_id = ?' : ''}
      ORDER BY b.expiry_date ASC
    `)
    .all(...(params.locationId ? [params.locationId] : [])) as any[];

  return {
    kpis: {
      totalSales,
      grossProfit,
      netProfit,
      totalExpenses,
      txnCount: salesAgg.txn_count,
      avgTicket,
      inventoryValuation,
      pendingPOs,
    },
    lowStockItems,
    expiringBatches,
    salesByPayment,
    salesByLocation,
    salesByCategory,
    topProducts,
    dailyTrends,
  };
}

export function getFoodCostingAnalytics() {
  const products = getProductCostingList();

  // Menu Engineering Matrix (Stars, Plowhorses, Puzzles, Dogs)
  const soldStats = db
    .prepare(`
      SELECT si.product_id, COALESCE(SUM(si.quantity), 0) AS units_sold, COALESCE(SUM(si.line_total), 0) AS revenue, COALESCE(SUM(si.cogs_amount), 0) AS actual_cogs
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      WHERE s.status = 'COMPLETED'
      GROUP BY si.product_id
    `)
    .all() as any[];

  const statMap = new Map(soldStats.map((r) => [r.product_id, r]));
  const rows = products.map((p) => {
    const st = statMap.get(p.id) || { units_sold: 0, revenue: 0, actual_cogs: 0 };
    return {
      id: p.id,
      name: p.name,
      sellingPrice: p.base_price,
      theoreticalCost: p.costing.directCost,
      foodCostPct: p.costing.foodCostPct,
      targetFoodCostPct: p.target_food_cost_pct,
      grossProfitPerUnit: p.costing.grossProfit,
      unitsSold: st.units_sold,
      totalContribution: round2(st.units_sold * p.costing.grossProfit),
      isMarginAlert: p.costing.isMarginAlert,
    };
  });

  const avgPopularity = rows.length ? rows.reduce((s, r) => s + r.unitsSold, 0) / rows.length : 0;
  const avgMargin = rows.length ? rows.reduce((s, r) => s + r.grossProfitPerUnit, 0) / rows.length : 0;

  const menuEngineering = rows.map((r) => {
    const highPop = r.unitsSold >= avgPopularity;
    const highMargin = r.grossProfitPerUnit >= avgMargin;
    let quadrant = 'Dog';
    if (highPop && highMargin) quadrant = 'Star';
    else if (highPop && !highMargin) quadrant = 'Plowhorse';
    else if (!highPop && highMargin) quadrant = 'Puzzle';
    return { ...r, quadrant };
  });

  // Actual vs Theoretical (AvT) Ingredient Variance
  const theoreticalMap = new Map<string, number>();
  const completedItems = db
    .prepare(`
      SELECT si.product_id, si.quantity, pv.portion_multiplier
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      LEFT JOIN product_variants pv ON pv.id = si.variant_id
      WHERE s.status = 'COMPLETED'
    `)
    .all() as any[];

  for (const ci of completedItems) {
    const recipe = db.prepare('SELECT * FROM recipes WHERE product_id = ?').get(ci.product_id) as any;
    if (!recipe) continue;
    const ings = db
      .prepare(`
        SELECT ri.*, ii.base_uom_id
        FROM recipe_ingredients ri
        JOIN inventory_items ii ON ii.id = ri.inventory_item_id
        WHERE ri.recipe_id = ?
      `)
      .all(recipe.id) as any[];
    for (const ing of ings) {
      const theoQty = convertQty(
        ((ing.quantity * (1 + ing.waste_factor_pct / 100)) / (recipe.yield_qty || 1)) *
          (ci.portion_multiplier || 1) *
          ci.quantity,
        ing.uom_id,
        ing.base_uom_id,
      );
      theoreticalMap.set(ing.inventory_item_id, (theoreticalMap.get(ing.inventory_item_id) || 0) + theoQty);
    }
  }

  const allItems = db
    .prepare(`
      SELECT i.*, u.code AS uom_code,
        COALESCE((SELECT ABS(SUM(t.quantity_delta)) FROM inventory_transactions t WHERE t.inventory_item_id = i.id AND t.txn_type IN ('OUT_SALE', 'OUT_WASTE', 'OUT_SPOILAGE', 'OUT_ADJUSTMENT')), 0) AS actual_out_qty,
        COALESCE((SELECT SUM(t.total_cost) FROM inventory_transactions t WHERE t.inventory_item_id = i.id AND t.txn_type IN ('OUT_WASTE', 'OUT_SPOILAGE')), 0) AS waste_cost
      FROM inventory_items i
      JOIN uoms u ON u.id = i.base_uom_id
    `)
    .all() as any[];

  const avtReport = allItems.map((item) => {
    const theo = round2(theoreticalMap.get(item.id) || 0);
    const actual = round2(item.actual_out_qty || 0);
    const varianceQty = round2(actual - theo);
    const varianceCost = round2(varianceQty * item.last_unit_cost);
    return {
      id: item.id,
      name: item.name,
      uom: item.uom_code,
      theoreticalQty: theo,
      actualQty: actual,
      varianceQty,
      varianceCost,
      wasteCost: round2(item.waste_cost || 0),
    };
  });

  return { menuEngineering, avtReport };
}

export function getFinancialStatements(from?: string, to?: string) {
  const start = from || '2000-01-01';
  const end = to || '2099-12-31';

  const accountBalances = db
    .prepare(`
      SELECT a.id, a.code, a.name, a.type,
        COALESCE(SUM(jl.debit), 0) AS total_debit,
        COALESCE(SUM(jl.credit), 0) AS total_credit
      FROM accounts a
      LEFT JOIN journal_lines jl ON jl.account_id = a.id
      LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id AND je.entry_date >= ? AND je.entry_date <= ?
      GROUP BY a.id
      ORDER BY a.code ASC
    `)
    .all(start, end) as any[];

  const revenues = accountBalances
    .filter((a) => a.type === 'REVENUE')
    .map((a) => ({ ...a, balance: round2(a.total_credit - a.total_debit) }));

  const expenses = accountBalances
    .filter((a) => a.type === 'EXPENSE')
    .map((a) => ({ ...a, balance: round2(a.total_debit - a.total_credit) }));

  const assets = accountBalances
    .filter((a) => a.type === 'ASSET')
    .map((a) => ({ ...a, balance: round2(a.total_debit - a.total_credit) }));

  const liabilities = accountBalances
    .filter((a) => a.type === 'LIABILITY')
    .map((a) => ({ ...a, balance: round2(a.total_credit - a.total_debit) }));

  const equity = accountBalances
    .filter((a) => a.type === 'EQUITY')
    .map((a) => ({ ...a, balance: round2(a.total_credit - a.total_debit) }));

  const totalRevenue = round2(revenues.reduce((s, r) => s + r.balance, 0));
  const totalExpenses = round2(expenses.reduce((s, e) => s + e.balance, 0));
  const netIncome = round2(totalRevenue - totalExpenses);

  const taxConfigs = db.prepare('SELECT * FROM tax_configs').all();
  const taxAgg = db
    .prepare(`
      SELECT COALESCE(SUM(subtotal), 0) AS vatable_sales, COALESCE(SUM(tax_amount), 0) AS output_tax
      FROM sales WHERE status = 'COMPLETED' AND sold_at >= ? AND sold_at <= ?
    `)
    .get(start, end) as any;

  return {
    trialBalance: accountBalances,
    profitAndLoss: { revenues, expenses, totalRevenue, totalExpenses, netIncome },
    balanceSheet: {
      assets,
      liabilities,
      equity,
      retainedEarningsCurrent: netIncome,
      totalAssets: round2(assets.reduce((s, a) => s + a.balance, 0)),
      totalLiabilitiesAndEquity: round2(
        liabilities.reduce((s, l) => s + l.balance, 0) +
          equity.reduce((s, e) => s + e.balance, 0) +
          netIncome,
      ),
    },
    taxSummary: {
      taxConfigs,
      vatableSales: round2(taxAgg.vatable_sales),
      outputTax: round2(taxAgg.output_tax),
    },
  };
}
