import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { db } from './db.ts';
import {
  createNotification,
  deductStockTx,
  getDashboardSummary,
  getFinancialStatements,
  getFoodCostingAnalytics,
  getProductCostingList,
  processSale,
  receiveStockTx,
  refundSale,
  writeAuditLog,
} from './erpEngine.ts';
import { AuthUser, PERMISSIONS } from '../src/types/erp.ts';

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser;
    }
  }
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function loadUserWithPermissions(userId: string): AuthUser | null {
  const user = db
    .prepare(`
      SELECT u.id, u.email, u.full_name, u.assigned_location_id, u.avatar_url, u.is_active, r.id AS role_id, r.code AS role_code, r.name AS role_name
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE u.id = ?
    `)
    .get(userId) as any;

  if (!user || !user.is_active) return null;

  const perms = db
    .prepare(`
      SELECT p.key
      FROM role_permissions rp
      JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = ?
    `)
    .all(user.role_id) as Array<{ key: string }>;

  return {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    roleCode: user.role_code,
    roleName: user.role_name,
    permissions: perms.map((p) => p.key),
    assignedLocationId: user.assigned_location_id,
    avatarUrl: user.avatar_url || null,
  };
}

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '').trim();
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const sess = db
    .prepare("SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')")
    .get(token) as { user_id: string } | undefined;

  if (!sess) {
    res.status(401).json({ error: 'Session expired or invalid' });
    return;
  }

  const authUser = loadUserWithPermissions(sess.user_id);
  if (!authUser) {
    res.status(401).json({ error: 'User inactive' });
    return;
  }

  req.authUser = authUser;
  next();
}

function requirePerm(perm: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const u = req.authUser;
    if (!u) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    if (u.roleCode === 'SUPER_ADMIN' || u.roleCode === 'BUSINESS_OWNER' || u.permissions.includes(perm)) {
      next();
      return;
    }
    res.status(403).json({ error: `Permission denied: requires ${perm}` });
  };
}

function requireAnyPerm(...perms: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const u = req.authUser;
    if (!u) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    if (u.roleCode === 'SUPER_ADMIN' || u.roleCode === 'BUSINESS_OWNER' || perms.some((p) => u.permissions.includes(p))) {
      next();
      return;
    }
    res.status(403).json({ error: `Permission denied: requires one of ${perms.join(', ')}` });
  };
}

function requireOwnerOrSuperAdmin(req: Request, res: Response, next: NextFunction) {
  const u = req.authUser;
  if (!u) {
    res.status(401).json({ error: 'Unauthenticated' });
    return;
  }
  if (u.roleCode === 'SUPER_ADMIN' || u.roleCode === 'BUSINESS_OWNER') {
    next();
    return;
  }
  res.status(403).json({ error: 'Restricted: Company Owner or Super Admin access only' });
}

export const apiRouter = Router();

// ==========================================
// 1. AUTHENTICATION & SESSIONS
// ==========================================
apiRouter.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }
  const user = db.prepare('SELECT id, password_hash, full_name FROM users WHERE lower(email) = lower(?)').get(email) as any;
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }
  const token = randomUUID();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+7 days'))").run(token, user.id);
  const authUser = loadUserWithPermissions(user.id);
  writeAuditLog(user.id, user.full_name, 'LOGIN', 'Session', token.slice(0, 8));
  res.json({ token, user: authUser });
});

apiRouter.post('/auth/demo-switch', (req, res) => {
  const { userId } = req.body || {};
  const authUser = loadUserWithPermissions(userId);
  if (!authUser) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const token = randomUUID();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+7 days'))").run(token, authUser.id);
  writeAuditLog(authUser.id, authUser.fullName, 'ROLE_SWITCH', 'User', authUser.id, { role: authUser.roleCode });
  res.json({ token, user: authUser });
});

apiRouter.get('/auth/demo-accounts', (_req, res) => {
  const rows = db
    .prepare(`
      SELECT u.id, u.email, u.full_name, u.avatar_url, r.code AS role_code, r.name AS role_name
      FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.is_active = 1
      ORDER BY CASE r.code WHEN 'SUPER_ADMIN' THEN 0 WHEN 'BUSINESS_OWNER' THEN 1 ELSE 2 END, u.full_name ASC
    `)
    .all();
  res.json(rows);
});

apiRouter.get('/auth/me', authMiddleware, (req, res) => {
  res.json(req.authUser);
});

apiRouter.post('/auth/logout', authMiddleware, (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '').trim();
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.json({ ok: true });
});

// All routes below require authentication
apiRouter.use(authMiddleware);

// ==========================================
// 2. LOCATIONS, DASHBOARD & NOTIFICATIONS
// ==========================================
apiRouter.get('/locations', (_req, res) => {
  res.json(db.prepare('SELECT * FROM locations WHERE is_active = 1 ORDER BY type ASC, name ASC').all());
});

apiRouter.get('/notifications', (_req, res) => {
  res.json(db.prepare('SELECT * FROM notifications ORDER BY is_read ASC, created_at DESC LIMIT 30').all());
});

apiRouter.post('/notifications/:id/read', (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

apiRouter.get('/dashboard/summary', requirePerm(PERMISSIONS.DASHBOARD_VIEW), (req, res) => {
  const { from, to, locationId } = req.query as Record<string, string | undefined>;
  res.json(getDashboardSummary({ from, to, locationId: locationId || undefined }));
});

// ==========================================
// 3. POS, OFFLINE SYNC & KITCHEN DISPLAY (KDS)
// ==========================================
apiRouter.get('/pos/catalog', requirePerm(PERMISSIONS.POS_SELL), (_req, res) => {
  const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order ASC').all() as any[];
  const products = getProductCostingList().filter((p) => p.is_available === 1);
  const customers = db.prepare('SELECT id, full_name, phone, loyalty_points, tier FROM customers ORDER BY full_name ASC').all();
  res.json({ categories, products, customers });
});

apiRouter.post('/pos/sales', requirePerm(PERMISSIONS.POS_SELL), (req, res) => {
  try {
    const sale = processSale(req.body, req.authUser!.id, req.authUser!.fullName);
    res.status(201).json(sale);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/pos/sales/sync-offline', requirePerm(PERMISSIONS.POS_SELL), (req, res) => {
  try {
    const sales = Array.isArray(req.body?.sales) ? req.body.sales : [];
    const synced = sales.map((s: any) =>
      processSale({ ...s, isOfflineSynced: true }, req.authUser!.id, req.authUser!.fullName),
    );
    res.json({ syncedCount: synced.length, sales: synced });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.get('/pos/sales', requirePerm(PERMISSIONS.POS_SELL), (req, res) => {
  const locationId = req.query.locationId as string | undefined;
  const sales = db
    .prepare(`
      SELECT s.*, l.name AS location_name, u.full_name AS cashier_name, c.full_name AS customer_name
      FROM sales s
      JOIN locations l ON l.id = s.location_id
      JOIN users u ON u.id = s.cashier_id
      LEFT JOIN customers c ON c.id = s.customer_id
      ${locationId ? 'WHERE s.location_id = ?' : ''}
      ORDER BY s.sold_at DESC
      LIMIT 60
    `)
    .all(...(locationId ? [locationId] : [])) as any[];

  const enriched = sales.map((s) => ({
    ...s,
    items: db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(s.id),
    payments: db.prepare('SELECT * FROM payments WHERE sale_id = ?').all(s.id),
  }));
  res.json(enriched);
});

apiRouter.post('/pos/sales/:id/refund', requirePerm(PERMISSIONS.POS_REFUND), (req, res) => {
  try {
    const updated = refundSale(req.params.id, req.body?.reason || 'Manager authorized refund', req.authUser!.id, req.authUser!.fullName);
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.get('/kds/orders', requirePerm(PERMISSIONS.KDS_MANAGE), (req, res) => {
  const locationId = req.query.locationId as string | undefined;
  const orders = db
    .prepare(`
      SELECT s.*, l.name AS location_name
      FROM sales s
      JOIN locations l ON l.id = s.location_id
      WHERE s.status = 'COMPLETED' AND s.kds_status != 'COMPLETED' AND l.kds_enabled = 1
      ${locationId ? 'AND s.location_id = ?' : ''}
      ORDER BY s.sold_at ASC
    `)
    .all(...(locationId ? [locationId] : [])) as any[];

  res.json(
    orders.map((o) => ({
      ...o,
      items: db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(o.id),
    })),
  );
});

apiRouter.patch('/kds/orders/:id', requirePerm(PERMISSIONS.KDS_MANAGE), (req, res) => {
  const { kdsStatus } = req.body || {};
  const allowed = ['PENDING', 'PREPARING', 'READY', 'COMPLETED'];
  if (!allowed.includes(kdsStatus)) {
    res.status(400).json({ error: 'Invalid KDS status' });
    return;
  }
  db.prepare('UPDATE sales SET kds_status = ? WHERE id = ?').run(kdsStatus, req.params.id);
  writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'KDS_STATUS', 'Sale', req.params.id, { kdsStatus });
  res.json({ ok: true, kdsStatus });
});

// ==========================================
// 4. PRODUCTS, MENUS & BOM RECIPES
// ==========================================
apiRouter.get('/products', requirePerm(PERMISSIONS.PRODUCT_MANAGE), (_req, res) => {
  res.json({
    products: getProductCostingList(),
    categories: db.prepare('SELECT * FROM categories ORDER BY sort_order ASC, name ASC').all(),
    inventoryItems: db.prepare('SELECT i.*, u.code AS uom_code FROM inventory_items i JOIN uoms u ON u.id = i.base_uom_id ORDER BY i.name ASC').all(),
    uoms: db.prepare('SELECT * FROM uoms').all(),
    taxConfigs: db.prepare('SELECT * FROM tax_configs').all(),
  });
});

apiRouter.post('/categories', requirePerm(PERMISSIONS.PRODUCT_MANAGE), (req, res) => {
  try {
    const cleanName = String(req.body?.name || '').trim();
    if (!cleanName) throw new Error('Category name is required');
    const dup = db.prepare('SELECT id FROM categories WHERE lower(name) = lower(?)').get(cleanName);
    if (dup) throw new Error(`Category "${cleanName}" already exists`);

    const maxRow = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS maxSort FROM categories').get() as { maxSort: number };
    const sortOrder = req.body?.sortOrder !== undefined && req.body?.sortOrder !== '' ? Number(req.body.sortOrder) : (maxRow.maxSort || 0) + 1;
    const id = randomUUID();
    db.prepare('INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)').run(id, cleanName, sortOrder);
    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'CREATE_CATEGORY', 'Category', id, { name: cleanName, sortOrder });
    res.status(201).json({ id, name: cleanName, sort_order: sortOrder });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put('/categories/:id', requirePerm(PERMISSIONS.PRODUCT_MANAGE), (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id) as any;
    if (!existing) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }
    const cleanName = String(req.body?.name || '').trim();
    if (!cleanName) throw new Error('Category name is required');
    const dup = db.prepare('SELECT id FROM categories WHERE lower(name) = lower(?) AND id != ?').get(cleanName, req.params.id);
    if (dup) throw new Error(`Category "${cleanName}" already exists`);

    const sortOrder = req.body?.sortOrder !== undefined && req.body?.sortOrder !== '' ? Number(req.body.sortOrder) : existing.sort_order;
    db.prepare('UPDATE categories SET name = ?, sort_order = ? WHERE id = ?').run(cleanName, sortOrder, req.params.id);
    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'UPDATE_CATEGORY', 'Category', req.params.id, { name: cleanName, sortOrder });
    res.json({ id: req.params.id, name: cleanName, sort_order: sortOrder });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/products', requirePerm(PERMISSIONS.PRODUCT_MANAGE), (req, res) => {
  try {
    const { sku, name, description, categoryId, basePrice, packagingCost, directLaborCost, targetFoodCostPct, taxConfigId, expiryDate, ingredients } = req.body || {};
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('Product name is required');
    const cleanCategoryId = String(categoryId || '').trim();
    if (!cleanCategoryId) throw new Error('Category is required');
    const catRow = db.prepare('SELECT id FROM categories WHERE id = ?').get(cleanCategoryId);
    if (!catRow) throw new Error('Selected category does not exist');

    const parsedPrice = Number(basePrice);
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) throw new Error('Valid base price is required');

    const cleanSku = String(sku || '').trim() || `MNU-${Date.now().toString().slice(-5)}`;
    const dupSku = db.prepare('SELECT id FROM products WHERE lower(sku) = lower(?)').get(cleanSku);
    if (dupSku) throw new Error(`SKU "${cleanSku}" is already used by another product`);

    const prodId = randomUUID();
    const recId = randomUUID();
    const cleanExpiry = expiryDate ? String(expiryDate).trim() || null : null;
    db.transaction(() => {
      db.prepare(`
        INSERT INTO products (id, sku, name, description, category_id, base_price, packaging_cost, direct_labor_cost, target_food_cost_pct, tax_config_id, expiry_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        prodId,
        cleanSku,
        cleanName,
        description ? String(description).trim() : '',
        cleanCategoryId,
        parsedPrice,
        Number(packagingCost || 0),
        Number(directLaborCost || 0),
        Number(targetFoodCostPct || 35),
        taxConfigId || 'tax_ph_vat',
        cleanExpiry,
      );

      db.prepare('INSERT INTO recipes (id, product_id, yield_qty) VALUES (?, ?, 1)').run(recId, prodId);
      const insIng = db.prepare('INSERT INTO recipe_ingredients (id, recipe_id, inventory_item_id, quantity, uom_id, waste_factor_pct) VALUES (?, ?, ?, ?, ?, ?)');
      for (const ing of ingredients || []) {
        insIng.run(randomUUID(), recId, ing.inventoryItemId, Number(ing.quantity), ing.uomId, Number(ing.wasteFactorPct || 0));
      }
    })();
    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'CREATE_PRODUCT', 'Product', prodId, { name: cleanName, sku: cleanSku, basePrice: parsedPrice, expiryDate: cleanExpiry });
    res.status(201).json({ id: prodId });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put('/products/:id', requirePerm(PERMISSIONS.PRODUCT_MANAGE), (req, res) => {
  try {
    const productId = req.params.id;
    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as any;
    if (!existing) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }

    const {
      sku,
      name,
      description,
      imageUrl,
      categoryId,
      basePrice,
      packagingCost,
      directLaborCost,
      targetFoodCostPct,
      taxConfigId,
      expiryDate,
      isAvailable,
      variants,
      modifiers,
    } = req.body || {};

    const cleanName = String(name || '').trim();
    const cleanSku = String(sku || '').trim();
    if (!cleanName) throw new Error('Product name is required');
    if (!cleanSku) throw new Error('SKU is required');
    if (!categoryId) throw new Error('Category is required');

    const dupSku = db.prepare('SELECT id FROM products WHERE lower(sku) = lower(?) AND id != ?').get(cleanSku, productId);
    if (dupSku) throw new Error(`SKU "${cleanSku}" is already used by another product`);

    db.transaction(() => {
      db.prepare(`
        UPDATE products
        SET sku = ?, name = ?, description = ?, image_url = ?, category_id = ?,
            base_price = ?, packaging_cost = ?, direct_labor_cost = ?,
            target_food_cost_pct = ?, tax_config_id = ?, expiry_date = ?, is_available = ?
        WHERE id = ?
      `).run(
        cleanSku,
        cleanName,
        description ?? existing.description ?? '',
        imageUrl !== undefined ? (String(imageUrl).trim() || null) : existing.image_url,
        categoryId,
        Number(basePrice),
        Number(packagingCost || 0),
        Number(directLaborCost || 0),
        Number(targetFoodCostPct || 35),
        taxConfigId || existing.tax_config_id || 'tax_ph_vat',
        expiryDate !== undefined ? (String(expiryDate).trim() || null) : existing.expiry_date,
        isAvailable === undefined ? existing.is_available : isAvailable ? 1 : 0,
        productId,
      );

      if (Array.isArray(variants)) {
        const existingVars = db.prepare('SELECT id, name FROM product_variants WHERE product_id = ?').all(productId) as Array<{ id: string; name: string }>;
        const incomingIds = new Set(variants.map((v: any) => v.id).filter(Boolean));
        for (const ev of existingVars) {
          if (!incomingIds.has(ev.id)) {
            const usedInSales = db.prepare('SELECT 1 FROM sale_items WHERE variant_id = ? LIMIT 1').get(ev.id);
            if (usedInSales) {
              throw new Error(`Cannot remove variant "${ev.name}" because it has past POS sales`);
            }
            db.prepare('DELETE FROM product_variants WHERE id = ?').run(ev.id);
          }
        }
        const updVar = db.prepare('UPDATE product_variants SET name = ?, price_delta = ?, portion_multiplier = ? WHERE id = ? AND product_id = ?');
        const insVar = db.prepare('INSERT INTO product_variants (id, product_id, name, price_delta, portion_multiplier) VALUES (?, ?, ?, ?, ?)');
        for (const v of variants) {
          const vName = String(v.name || '').trim();
          if (!vName) continue;
          if (v.id && existingVars.some((ev) => ev.id === v.id)) {
            updVar.run(vName, Number(v.priceDelta || 0), Number(v.portionMultiplier || 1), v.id, productId);
          } else {
            insVar.run(randomUUID(), productId, vName, Number(v.priceDelta || 0), Number(v.portionMultiplier || 1));
          }
        }
      }

      if (Array.isArray(modifiers)) {
        const existingMods = db.prepare('SELECT id FROM modifier_options WHERE product_id = ?').all(productId) as Array<{ id: string }>;
        const incomingModIds = new Set(modifiers.map((m: any) => m.id).filter(Boolean));
        for (const em of existingMods) {
          if (!incomingModIds.has(em.id)) {
            db.prepare('DELETE FROM modifier_options WHERE id = ?').run(em.id);
          }
        }
        const updMod = db.prepare('UPDATE modifier_options SET group_name = ?, name = ?, price_delta = ? WHERE id = ? AND product_id = ?');
        const insMod = db.prepare('INSERT INTO modifier_options (id, product_id, group_name, name, price_delta) VALUES (?, ?, ?, ?, ?)');
        for (const m of modifiers) {
          const mName = String(m.name || '').trim();
          if (!mName) continue;
          const groupName = String(m.groupName || 'Add-ons').trim() || 'Add-ons';
          if (m.id && existingMods.some((em) => em.id === m.id)) {
            updMod.run(groupName, mName, Number(m.priceDelta || 0), m.id, productId);
          } else {
            insMod.run(randomUUID(), productId, groupName, mName, Number(m.priceDelta || 0));
          }
        }
      }
    })();

    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'UPDATE_PRODUCT', 'Product', productId, {
      name: cleanName,
      sku: cleanSku,
      basePrice: Number(basePrice),
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put('/products/:id/recipe', requirePerm(PERMISSIONS.PRODUCT_MANAGE), (req, res) => {
  try {
    const { basePrice, packagingCost, directLaborCost, targetFoodCostPct, prepInstructions, ingredients } = req.body;
    db.transaction(() => {
      db.prepare('UPDATE products SET base_price = ?, packaging_cost = ?, direct_labor_cost = ?, target_food_cost_pct = ? WHERE id = ?')
        .run(Number(basePrice), Number(packagingCost), Number(directLaborCost), Number(targetFoodCostPct), req.params.id);

      let recipe = db.prepare('SELECT id FROM recipes WHERE product_id = ?').get(req.params.id) as { id: string } | undefined;
      if (!recipe) {
        const rid = randomUUID();
        db.prepare('INSERT INTO recipes (id, product_id, yield_qty, prep_instructions) VALUES (?, ?, 1, ?)').run(rid, req.params.id, prepInstructions || '');
        recipe = { id: rid };
      } else {
        db.prepare("UPDATE recipes SET prep_instructions = ?, updated_at = datetime('now') WHERE id = ?").run(prepInstructions || '', recipe.id);
        db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(recipe.id);
      }

      const ins = db.prepare('INSERT INTO recipe_ingredients (id, recipe_id, inventory_item_id, quantity, uom_id, waste_factor_pct) VALUES (?, ?, ?, ?, ?, ?)');
      for (const ing of ingredients || []) {
        ins.run(randomUUID(), recipe.id, ing.inventoryItemId, Number(ing.quantity), ing.uomId, Number(ing.wasteFactorPct || 0));
      }
    })();
    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'UPDATE_RECIPE', 'Product', req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.patch('/products/:id/availability', requirePerm(PERMISSIONS.PRODUCT_MANAGE), (req, res) => {
  db.prepare('UPDATE products SET is_available = ? WHERE id = ?').run(req.body.isAvailable ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

// ==========================================
// 5. INVENTORY, BATCHES, TRANSFERS & WASTE
// ==========================================
apiRouter.get('/inventory', requirePerm(PERMISSIONS.INVENTORY_VIEW), (req, res) => {
  const locationId = req.query.locationId as string | undefined;
  const items = db
    .prepare(`
      SELECT i.*, u.code AS uom_code,
        COALESCE((SELECT SUM(b.remaining_qty) FROM stock_batches b WHERE b.inventory_item_id = i.id ${locationId ? 'AND b.location_id = ?' : ''}), 0) AS on_hand_qty,
        COALESCE((SELECT SUM(b.remaining_qty * b.unit_cost) FROM stock_batches b WHERE b.inventory_item_id = i.id ${locationId ? 'AND b.location_id = ?' : ''}), 0) AS stock_value
      FROM inventory_items i
      JOIN uoms u ON u.id = i.base_uom_id
      ORDER BY i.name ASC
    `)
    .all(...(locationId ? [locationId, locationId] : []));

  const batches = db
    .prepare(`
      SELECT b.*, i.name AS item_name, u.code AS uom_code, l.name AS location_name
      FROM stock_batches b
      JOIN inventory_items i ON i.id = b.inventory_item_id
      JOIN uoms u ON u.id = i.base_uom_id
      JOIN locations l ON l.id = b.location_id
      WHERE b.remaining_qty > 0 ${locationId ? 'AND b.location_id = ?' : ''}
      ORDER BY b.expiry_date ASC, b.received_at ASC
    `)
    .all(...(locationId ? [locationId] : []));

  const movements = db
    .prepare(`
      SELECT t.*, i.name AS item_name, u.code AS uom_code, l.name AS location_name
      FROM inventory_transactions t
      JOIN inventory_items i ON i.id = t.inventory_item_id
      JOIN uoms u ON u.id = i.base_uom_id
      JOIN locations l ON l.id = t.location_id
      ${locationId ? 'WHERE t.location_id = ?' : ''}
      ORDER BY t.created_at DESC
      LIMIT 60
    `)
    .all(...(locationId ? [locationId] : []));

  const uoms = db.prepare('SELECT * FROM uoms').all();
  res.json({ items, batches, movements, uoms });
});

apiRouter.post('/inventory/items', requireAnyPerm(PERMISSIONS.INVENTORY_ADJUST, PERMISSIONS.PRODUCT_MANAGE), (req, res) => {
  try {
    const { sku, name, itemType, baseUomId, costingMethod, minStockLevel, reorderPoint, lastUnitCost } = req.body || {};
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('Ingredient name is required');
    if (!baseUomId) throw new Error('Base unit (UOM) is required');

    const cleanSku = String(sku || '').trim() || `ING-${Date.now().toString().slice(-4)}`;
    const dupSku = db.prepare('SELECT id FROM inventory_items WHERE lower(sku) = lower(?)').get(cleanSku);
    if (dupSku) throw new Error(`SKU "${cleanSku}" is already used by another ingredient`);
    const dupName = db.prepare('SELECT id FROM inventory_items WHERE lower(name) = lower(?)').get(cleanName);
    if (dupName) throw new Error(`Ingredient "${cleanName}" already exists`);

    const cost = Number(lastUnitCost || 0);
    if (!Number.isFinite(cost) || cost < 0) throw new Error('Unit cost cannot be negative');

    const id = randomUUID();
    db.prepare(`
      INSERT INTO inventory_items (id, sku, name, item_type, base_uom_id, costing_method, min_stock_level, reorder_point, last_unit_cost, weighted_avg_cost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      cleanSku,
      cleanName,
      itemType || 'RAW_MATERIAL',
      baseUomId,
      costingMethod || 'FIFO',
      Number(minStockLevel || 0),
      Number(reorderPoint || 0),
      cost,
      cost,
    );

    const created = db
      .prepare('SELECT i.*, u.code AS uom_code FROM inventory_items i JOIN uoms u ON u.id = i.base_uom_id WHERE i.id = ?')
      .get(id);
    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'CREATE_INGREDIENT', 'InventoryItem', id, { name: cleanName, sku: cleanSku });
    res.status(201).json(created);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put('/inventory/items/:id', requireAnyPerm(PERMISSIONS.INVENTORY_ADJUST, PERMISSIONS.PRODUCT_MANAGE), (req, res) => {
  try {
    const itemId = req.params.id;
    const existing = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(itemId) as any;
    if (!existing) {
      res.status(404).json({ error: 'Ingredient not found' });
      return;
    }

    const { sku, name, itemType, baseUomId, costingMethod, minStockLevel, reorderPoint, lastUnitCost } = req.body || {};
    const cleanName = String(name || '').trim();
    const cleanSku = String(sku || '').trim();
    if (!cleanName) throw new Error('Ingredient name is required');
    if (!cleanSku) throw new Error('SKU is required');
    if (!baseUomId) throw new Error('Base unit (UOM) is required');

    const dupSku = db.prepare('SELECT id FROM inventory_items WHERE lower(sku) = lower(?) AND id != ?').get(cleanSku, itemId);
    if (dupSku) throw new Error(`SKU "${cleanSku}" is already used by another ingredient`);
    const dupName = db.prepare('SELECT id FROM inventory_items WHERE lower(name) = lower(?) AND id != ?').get(cleanName, itemId);
    if (dupName) throw new Error(`Ingredient "${cleanName}" already exists`);

    if (baseUomId !== existing.base_uom_id) {
      const hasStockOrRecipe =
        db.prepare('SELECT 1 FROM stock_batches WHERE inventory_item_id = ? LIMIT 1').get(itemId) ||
        db.prepare('SELECT 1 FROM inventory_transactions WHERE inventory_item_id = ? LIMIT 1').get(itemId) ||
        db.prepare('SELECT 1 FROM recipe_ingredients WHERE inventory_item_id = ? LIMIT 1').get(itemId);
      if (hasStockOrRecipe) {
        throw new Error('Cannot change base unit (UOM) because this ingredient is already used in recipes or stock history');
      }
    }

    const cost = Number(lastUnitCost ?? existing.last_unit_cost ?? 0);
    if (!Number.isFinite(cost) || cost < 0) throw new Error('Unit cost cannot be negative');

    const hasBatches = db.prepare('SELECT 1 FROM stock_batches WHERE inventory_item_id = ? AND remaining_qty > 0 LIMIT 1').get(itemId);
    const nextWeightedAvg = hasBatches ? existing.weighted_avg_cost : cost;

    db.prepare(`
      UPDATE inventory_items
      SET sku = ?, name = ?, item_type = ?, base_uom_id = ?, costing_method = ?,
          min_stock_level = ?, reorder_point = ?, last_unit_cost = ?, weighted_avg_cost = ?
      WHERE id = ?
    `).run(
      cleanSku,
      cleanName,
      itemType || existing.item_type || 'RAW_MATERIAL',
      baseUomId,
      costingMethod || existing.costing_method || 'FIFO',
      Number(minStockLevel ?? existing.min_stock_level ?? 0),
      Number(reorderPoint ?? existing.reorder_point ?? 0),
      cost,
      nextWeightedAvg,
      itemId,
    );

    const updated = db
      .prepare('SELECT i.*, u.code AS uom_code FROM inventory_items i JOIN uoms u ON u.id = i.base_uom_id WHERE i.id = ?')
      .get(itemId);
    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'UPDATE_INGREDIENT', 'InventoryItem', itemId, { name: cleanName, sku: cleanSku, cost });
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.delete('/inventory/items/:id', requireAnyPerm(PERMISSIONS.INVENTORY_ADJUST, PERMISSIONS.PRODUCT_MANAGE), (req, res) => {
  try {
    const itemId = req.params.id;
    const existing = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(itemId) as any;
    if (!existing) {
      res.status(404).json({ error: 'Ingredient not found' });
      return;
    }

    const recipeCount = (db.prepare('SELECT COUNT(*) AS cnt FROM recipe_ingredients WHERE inventory_item_id = ? OR substitute_item_id = ?').get(itemId, itemId) as { cnt: number }).cnt;
    if (recipeCount > 0) {
      throw new Error(`Cannot delete "${existing.name}" because it is used in ${recipeCount} product recipe(s). Remove it from BOM first.`);
    }

    const batchCount = (db.prepare('SELECT COUNT(*) AS cnt FROM stock_batches WHERE inventory_item_id = ?').get(itemId) as { cnt: number }).cnt;
    const txnCount = (db.prepare('SELECT COUNT(*) AS cnt FROM inventory_transactions WHERE inventory_item_id = ?').get(itemId) as { cnt: number }).cnt;
    if (batchCount > 0 || txnCount > 0) {
      throw new Error(`Cannot delete "${existing.name}" because it has stock batches or movement history.`);
    }

    const poCount = (db.prepare('SELECT COUNT(*) AS cnt FROM purchase_order_items WHERE inventory_item_id = ?').get(itemId) as { cnt: number }).cnt;
    const modCount = (db.prepare('SELECT COUNT(*) AS cnt FROM modifier_options WHERE inventory_item_id = ?').get(itemId) as { cnt: number }).cnt;
    if (poCount > 0 || modCount > 0) {
      throw new Error(`Cannot delete "${existing.name}" because it is linked to purchase orders or menu modifiers.`);
    }

    db.transaction(() => {
      db.prepare('DELETE FROM supplier_items WHERE inventory_item_id = ?').run(itemId);
      db.prepare('DELETE FROM inventory_items WHERE id = ?').run(itemId);
    })();

    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'DELETE_INGREDIENT', 'InventoryItem', itemId, { name: existing.name });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/inventory/transfers', requirePerm(PERMISSIONS.INVENTORY_ADJUST), (req, res) => {
  try {
    const { fromLocationId, toLocationId, inventoryItemId, quantity, notes } = req.body;
    if (fromLocationId === toLocationId) throw new Error('Source and destination locations must differ');
    const qty = Number(quantity);
    const result = db.transaction(() => {
      const trfId = randomUUID();
      const trfNo = `TRF-${Date.now().toString().slice(-6)}`;
      const deducted = deductStockTx({
        inventoryItemId,
        locationId: fromLocationId,
        quantity: qty,
        txnType: 'OUT_TRANSFER',
        referenceType: 'TRANSFER',
        referenceId: trfId,
        userId: req.authUser!.id,
        notes: notes || `Transfer to ${toLocationId}`,
        allowNegative: false,
      });

      for (const b of deducted.consumedBatches) {
        receiveStockTx({
          inventoryItemId,
          locationId: toLocationId,
          quantity: b.qty,
          unitCost: b.unitCost,
          batchNumber: trfNo,
          txnType: 'IN_TRANSFER',
          referenceType: 'TRANSFER',
          referenceId: trfId,
          userId: req.authUser!.id,
          notes: `Received from ${fromLocationId}`,
        });
      }

      db.prepare('INSERT INTO stock_transfers (id, transfer_number, from_location_id, to_location_id, status, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(trfId, trfNo, fromLocationId, toLocationId, 'RECEIVED', notes || '', req.authUser!.id);
      db.prepare('INSERT INTO stock_transfer_items (id, transfer_id, inventory_item_id, quantity, total_cost) VALUES (?, ?, ?, ?, ?)')
        .run(randomUUID(), trfId, inventoryItemId, qty, deducted.totalCogs);
      writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'STOCK_TRANSFER', 'StockTransfer', trfId, { trfNo, qty });
      return { trfId, trfNo, totalCost: deducted.totalCogs };
    })();
    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/inventory/waste', requirePerm(PERMISSIONS.INVENTORY_ADJUST), (req, res) => {
  try {
    const { inventoryItemId, locationId, quantity, reason, txnType } = req.body;
    const resDeduct = db.transaction(() => {
      const d = deductStockTx({
        inventoryItemId,
        locationId,
        quantity: Number(quantity),
        txnType: txnType === 'OUT_SPOILAGE' ? 'OUT_SPOILAGE' : 'OUT_WASTE',
        referenceType: 'WASTE_LOG',
        referenceId: `WST-${Date.now()}`,
        userId: req.authUser!.id,
        notes: reason || 'Spoilage / Kitchen waste',
      });
      writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'RECORD_WASTE', 'InventoryItem', inventoryItemId, { quantity, reason });
      return d;
    })();
    res.status(201).json(resDeduct);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/inventory/reconcile', requirePerm(PERMISSIONS.INVENTORY_ADJUST), (req, res) => {
  try {
    const { inventoryItemId, locationId, countedQty, notes } = req.body;
    const result = db.transaction(() => {
      const agg = db
        .prepare('SELECT COALESCE(SUM(remaining_qty), 0) AS qty FROM stock_batches WHERE inventory_item_id = ? AND location_id = ?')
        .get(inventoryItemId, locationId) as { qty: number };
      const sysQty = agg.qty || 0;
      const variance = round2(Number(countedQty) - sysQty);
      if (variance === 0) return { variance: 0, status: 'MATCHED' };
      const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(inventoryItemId) as any;
      if (variance > 0) {
        receiveStockTx({
          inventoryItemId,
          locationId,
          quantity: variance,
          unitCost: item.last_unit_cost,
          batchNumber: `CNT-${Date.now().toString().slice(-5)}`,
          txnType: 'IN_ADJUSTMENT',
          referenceType: 'STOCK_COUNT',
          referenceId: randomUUID(),
          userId: req.authUser!.id,
          notes: notes || 'Physical stock count surplus',
        });
      } else {
        deductStockTx({
          inventoryItemId,
          locationId,
          quantity: Math.abs(variance),
          txnType: 'OUT_ADJUSTMENT',
          referenceType: 'STOCK_COUNT',
          referenceId: randomUUID(),
          userId: req.authUser!.id,
          notes: notes || 'Physical stock count shrinkage',
        });
      }
      writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'STOCK_RECONCILE', 'InventoryItem', inventoryItemId, { sysQty, countedQty, variance });
      return { sysQty, countedQty: Number(countedQty), variance, status: 'ADJUSTED' };
    })();
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// 6. PROCUREMENT & SUPPLIERS (WORKFLOW B)
// ==========================================
apiRouter.get('/procurement', requirePerm(PERMISSIONS.PO_CREATE), (_req, res) => {
  const suppliers = db.prepare('SELECT * FROM suppliers WHERE is_active = 1 ORDER BY name ASC').all();
  const priceComparison = db
    .prepare(`
      SELECT si.*, s.name AS supplier_name, ii.name AS item_name, u.code AS uom_code
      FROM supplier_items si
      JOIN suppliers s ON s.id = si.supplier_id
      JOIN inventory_items ii ON ii.id = si.inventory_item_id
      JOIN uoms u ON u.id = ii.base_uom_id
      ORDER BY ii.name ASC, si.unit_price ASC
    `)
    .all();

  const purchaseOrders = (
    db
      .prepare(`
        SELECT po.*, s.name AS supplier_name, l.name AS location_name
        FROM purchase_orders po
        JOIN suppliers s ON s.id = po.supplier_id
        JOIN locations l ON l.id = po.location_id
        ORDER BY po.ordered_at DESC
      `)
      .all() as any[]
  ).map((po) => ({
    ...po,
    items: db
      .prepare(`
        SELECT poi.*, ii.name AS item_name, u.code AS uom_code
        FROM purchase_order_items poi
        JOIN inventory_items ii ON ii.id = poi.inventory_item_id
        JOIN uoms u ON u.id = ii.base_uom_id
        WHERE poi.purchase_order_id = ?
      `)
      .all(po.id),
  }));

  const invoices = db
    .prepare(`
      SELECT inv.*, s.name AS supplier_name
      FROM supplier_invoices inv
      JOIN suppliers s ON s.id = inv.supplier_id
      ORDER BY inv.due_date ASC
    `)
    .all();

  res.json({ suppliers, priceComparison, purchaseOrders, invoices });
});

apiRouter.post('/procurement/suppliers', requirePerm(PERMISSIONS.PO_CREATE), (req, res) => {
  try {
    const { code, name, contactPerson, phone, email, address, tin, paymentTerms } = req.body;
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('Supplier name is required');
    const id = randomUUID();
    const cleanCode = String(code || `SUP-${Date.now().toString().slice(-4)}`).trim();
    db.prepare('INSERT INTO suppliers (id, code, name, contact_person, phone, email, address, tin, payment_terms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, cleanCode, cleanName, contactPerson || '', phone || '', email || '', address || '', tin || '', Math.max(0, Math.round(Number(paymentTerms || 0))));
    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'CREATE_SUPPLIER', 'Supplier', id, { code: cleanCode, name: cleanName });
    res.status(201).json({ id });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put('/procurement/suppliers/:id', requirePerm(PERMISSIONS.PO_CREATE), (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id) as any;
    if (!existing) {
      res.status(404).json({ error: 'Supplier not found' });
      return;
    }
    const { code, name, contactPerson, phone, email, address, tin, paymentTerms } = req.body || {};
    const cleanName = String(name ?? existing.name ?? '').trim();
    const cleanCode = String(code ?? existing.code ?? '').trim();
    if (!cleanName) throw new Error('Supplier name is required');
    if (!cleanCode) throw new Error('Supplier code is required');

    db.prepare(`
      UPDATE suppliers
      SET code = ?, name = ?, contact_person = ?, phone = ?, email = ?, address = ?, tin = ?, payment_terms = ?
      WHERE id = ?
    `).run(
      cleanCode,
      cleanName,
      contactPerson ?? existing.contact_person ?? '',
      phone ?? existing.phone ?? '',
      email ?? existing.email ?? '',
      address ?? existing.address ?? '',
      tin ?? existing.tin ?? '',
      Math.max(0, Math.round(Number(paymentTerms ?? existing.payment_terms ?? 0))),
      existing.id,
    );
    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'UPDATE_SUPPLIER', 'Supplier', existing.id, { code: cleanCode, name: cleanName });
    res.json({ ok: true, id: existing.id });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.delete('/procurement/suppliers/:id', requirePerm(PERMISSIONS.PO_CREATE), (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id) as any;
    if (!existing) {
      res.status(404).json({ error: 'Supplier not found' });
      return;
    }
    const poRef = db.prepare('SELECT COUNT(*) AS cnt FROM purchase_orders WHERE supplier_id = ?').get(existing.id) as { cnt: number };
    const invRef = db.prepare('SELECT COUNT(*) AS cnt FROM supplier_invoices WHERE supplier_id = ?').get(existing.id) as { cnt: number };
    const hasHistory = (poRef?.cnt || 0) > 0 || (invRef?.cnt || 0) > 0;

    if (hasHistory) {
      db.prepare('UPDATE suppliers SET is_active = 0 WHERE id = ?').run(existing.id);
    } else {
      db.prepare('DELETE FROM supplier_items WHERE supplier_id = ?').run(existing.id);
      db.prepare('DELETE FROM suppliers WHERE id = ?').run(existing.id);
    }
    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'DELETE_SUPPLIER', 'Supplier', existing.id, { name: existing.name, archived: hasHistory });
    res.json({ ok: true, archived: hasHistory });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/procurement/purchase-orders', requirePerm(PERMISSIONS.PO_CREATE), (req, res) => {
  try {
    const { supplierId, locationId, expectedAt, notes, items } = req.body;
    if (!items?.length) throw new Error('PO requires at least one item');
    const poId = randomUUID();
    const poNumber = `PO-${Date.now().toString().slice(-6)}`;
    const totalAmount = round2(items.reduce((s: number, i: any) => s + Number(i.orderedQty) * Number(i.unitCost), 0));

    db.transaction(() => {
      db.prepare('INSERT INTO purchase_orders (id, po_number, supplier_id, location_id, status, total_amount, notes, expected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(poId, poNumber, supplierId, locationId, 'PENDING_APPROVAL', totalAmount, notes || '', expectedAt || null);
      const ins = db.prepare('INSERT INTO purchase_order_items (id, purchase_order_id, inventory_item_id, ordered_qty, unit_cost) VALUES (?, ?, ?, ?, ?)');
      for (const i of items) {
        ins.run(randomUUID(), poId, i.inventoryItemId, Number(i.orderedQty), Number(i.unitCost));
      }
      writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'CREATE_PO', 'PurchaseOrder', poId, { poNumber, totalAmount });
    })();
    res.status(201).json({ id: poId, poNumber });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/procurement/purchase-orders/:id/approve', requirePerm(PERMISSIONS.PO_APPROVE), (req, res) => {
  db.prepare("UPDATE purchase_orders SET status = 'APPROVED', approved_by = ? WHERE id = ?").run(req.authUser!.id, req.params.id);
  writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'APPROVE_PO', 'PurchaseOrder', req.params.id);
  res.json({ ok: true });
});

apiRouter.post('/procurement/purchase-orders/:id/receive', requirePerm(PERMISSIONS.GRN_RECEIVE), (req, res) => {
  try {
    const { items, notes } = req.body;
    const result = db.transaction(() => {
      const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id) as any;
      if (!po) throw new Error('PO not found');
      if (po.status !== 'APPROVED' && po.status !== 'PARTIAL') throw new Error('PO must be APPROVED or PARTIAL to receive');

      const grnId = randomUUID();
      const grnNumber = `GRN-${Date.now().toString().slice(-6)}`;
      db.prepare('INSERT INTO goods_receipts (id, grn_number, purchase_order_id, received_by, notes) VALUES (?, ?, ?, ?, ?)')
        .run(grnId, grnNumber, po.id, req.authUser!.id, notes || '');

      let totalRecvValue = 0;
      const poItems = db.prepare('SELECT * FROM purchase_order_items WHERE purchase_order_id = ?').all(po.id) as any[];

      for (const line of items) {
        const poItem = poItems.find((x) => x.id === line.poItemId);
        if (!poItem) continue;
        const recvQty = Number(line.receivedQty || 0);
        const rejQty = Number(line.rejectedQty || 0);
        const unitCost = Number(line.unitCost ?? poItem.unit_cost);
        const batchNo = line.batchNumber || `${grnNumber}-${poItem.inventory_item_id.slice(0, 4)}`;

        db.prepare(`
          INSERT INTO goods_receipt_items (id, goods_receipt_id, inventory_item_id, ordered_qty, received_qty, rejected_qty, unit_cost, batch_number, expiry_date, discrepancy_notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), grnId, poItem.inventory_item_id, poItem.ordered_qty, recvQty, rejQty, unitCost, batchNo, line.expiryDate || null, line.discrepancyNotes || null);

        if (recvQty > 0) {
          receiveStockTx({
            inventoryItemId: poItem.inventory_item_id,
            locationId: po.location_id,
            quantity: recvQty,
            unitCost,
            batchNumber: batchNo,
            expiryDate: line.expiryDate || null,
            txnType: 'IN_PURCHASE',
            referenceType: 'GRN',
            referenceId: grnId,
            userId: req.authUser!.id,
            notes: `GRN ${grnNumber} (${po.po_number})`,
          });
          totalRecvValue += round2(recvQty * unitCost);
          db.prepare('UPDATE purchase_order_items SET received_qty = received_qty + ? WHERE id = ?').run(recvQty, poItem.id);
        }
      }

      const refreshed = db.prepare('SELECT ordered_qty, received_qty FROM purchase_order_items WHERE purchase_order_id = ?').all(po.id) as any[];
      const allDone = refreshed.every((x) => x.received_qty >= x.ordered_qty);
      db.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?').run(allDone ? 'RECEIVED' : 'PARTIAL', po.id);

      // Record Supplier Invoice + Accounting JE (DR 1200 Inventory / CR 2000 AP)
      if (totalRecvValue > 0) {
        const invId = randomUUID();
        db.prepare(`
          INSERT INTO supplier_invoices (id, invoice_number, supplier_id, purchase_order_id, total_amount, due_date, status)
          VALUES (?, ?, ?, ?, ?, datetime('now', '+15 days'), 'UNPAID')
        `).run(invId, `SI-${grnNumber}`, po.supplier_id, po.id, round2(totalRecvValue));

        const jeId = randomUUID();
        db.prepare('INSERT INTO journal_entries (id, entry_number, entry_date, description, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?)')
          .run(jeId, `JE-${grnNumber}`, new Date().toISOString(), `Goods Receipt ${grnNumber}`, 'GRN', grnId);
        db.prepare('INSERT INTO journal_lines (id, journal_entry_id, account_id, debit, credit, memo) VALUES (?, ?, ?, ?, ?, ?)')
          .run(randomUUID(), jeId, 'acc_1200', round2(totalRecvValue), 0, 'Inventory Received');
        db.prepare('INSERT INTO journal_lines (id, journal_entry_id, account_id, debit, credit, memo) VALUES (?, ?, ?, ?, ?, ?)')
          .run(randomUUID(), jeId, 'acc_2000', 0, round2(totalRecvValue), 'Supplier Payable');
      }

      writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'RECEIVE_GRN', 'GoodsReceipt', grnId, { poNumber: po.po_number, totalRecvValue });
      return { grnId, grnNumber, totalRecvValue: round2(totalRecvValue) };
    })();
    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/procurement/invoices/:id/pay', requirePerm(PERMISSIONS.FINANCE_VIEW), (req, res) => {
  try {
    const payAmt = round2(Number(req.body.amount));
    db.transaction(() => {
      const inv = db.prepare('SELECT * FROM supplier_invoices WHERE id = ?').get(req.params.id) as any;
      if (!inv) throw new Error('Invoice not found');
      const newPaid = round2(inv.paid_amount + payAmt);
      if (newPaid > inv.total_amount + 0.01) throw new Error('Payment exceeds invoice balance');
      const payNo = `PAY-${Date.now().toString().slice(-6)}`;
      db.prepare('INSERT INTO supplier_payments (id, payment_number, supplier_invoice_id, amount, method, reference_no, paid_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), payNo, inv.id, payAmt, req.body.method || 'BANK_TRANSFER', req.body.referenceNo || '', req.authUser!.id);
      db.prepare('UPDATE supplier_invoices SET paid_amount = ?, status = ? WHERE id = ?')
        .run(newPaid, newPaid >= inv.total_amount ? 'PAID' : 'PARTIAL', inv.id);

      const jeId = randomUUID();
      db.prepare('INSERT INTO journal_entries (id, entry_number, entry_date, description, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(jeId, `JE-${payNo}`, new Date().toISOString(), `Supplier Payment ${inv.invoice_number}`, 'AP_PAYMENT', inv.id);
      db.prepare('INSERT INTO journal_lines (id, journal_entry_id, account_id, debit, credit, memo) VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), jeId, 'acc_2000', payAmt, 0, 'Accounts Payable Settled');
      db.prepare('INSERT INTO journal_lines (id, journal_entry_id, account_id, debit, credit, memo) VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), jeId, 'acc_1010', 0, payAmt, 'Bank/Cash Disbursement');
    })();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// 7. FINANCE, EXPENSES, CLOSING & ACCOUNTING
// ==========================================
apiRouter.get('/finance/overview', requirePerm(PERMISSIONS.FINANCE_VIEW), (req, res) => {
  const { from, to } = req.query as Record<string, string | undefined>;
  const expenses = db
    .prepare(`
      SELECT e.*, l.name AS location_name, a.name AS account_name
      FROM expenses e
      JOIN locations l ON l.id = e.location_id
      JOIN accounts a ON a.id = e.account_id
      ORDER BY e.expense_date DESC
      LIMIT 60
    `)
    .all();

  const closings = db
    .prepare(`
      SELECT dc.*, l.name AS location_name, u.full_name AS closed_by_name
      FROM daily_closings dc
      JOIN locations l ON l.id = dc.location_id
      JOIN users u ON u.id = dc.closed_by
      ORDER BY dc.business_date DESC
      LIMIT 30
    `)
    .all();

  const journals = (
    db.prepare('SELECT * FROM journal_entries ORDER BY entry_date DESC, created_at DESC LIMIT 40').all() as any[]
  ).map((je) => ({
    ...je,
    lines: db
      .prepare('SELECT jl.*, a.code AS account_code, a.name AS account_name FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE jl.journal_entry_id = ?')
      .all(je.id),
  }));

  const accounts = db.prepare('SELECT * FROM accounts ORDER BY code ASC').all();
  const pettyCash = db
    .prepare('SELECT pc.*, l.name AS location_name FROM petty_cash_funds pc JOIN locations l ON l.id = pc.location_id')
    .all();
  const periods = db.prepare('SELECT * FROM financial_periods ORDER BY period_start DESC').all();
  const statements = getFinancialStatements(from, to);

  res.json({ expenses, closings, journals, accounts, pettyCash, periods, statements });
});

apiRouter.post('/finance/expenses', requirePerm(PERMISSIONS.FINANCE_VIEW), (req, res) => {
  try {
    const { locationId, accountId, category, amount, description, expenseDate, paidFromPettyCash, isRecurring } = req.body;
    const amt = round2(Number(amount));
    if (amt <= 0) throw new Error('Amount must be positive');

    const expId = randomUUID();
    db.transaction(() => {
      db.prepare(`
        INSERT INTO expenses (id, location_id, account_id, category, amount, description, is_recurring, paid_from_petty_cash, expense_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(expId, locationId, accountId, category, amt, description, isRecurring ? 1 : 0, paidFromPettyCash ? 1 : 0, expenseDate || new Date().toISOString());

      if (paidFromPettyCash) {
        const fund = db.prepare('SELECT * FROM petty_cash_funds WHERE location_id = ?').get(locationId) as any;
        if (!fund || fund.current_balance < amt) throw new Error('Insufficient petty cash balance');
        db.prepare('UPDATE petty_cash_funds SET current_balance = current_balance - ? WHERE id = ?').run(amt, fund.id);
      }

      const jeId = randomUUID();
      db.prepare('INSERT INTO journal_entries (id, entry_number, entry_date, description, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(jeId, `JE-EXP-${Date.now().toString().slice(-6)}`, expenseDate || new Date().toISOString(), `${category}: ${description}`, 'EXPENSE', expId);
      db.prepare('INSERT INTO journal_lines (id, journal_entry_id, account_id, debit, credit, memo) VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), jeId, accountId, amt, 0, description);
      db.prepare('INSERT INTO journal_lines (id, journal_entry_id, account_id, debit, credit, memo) VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), jeId, 'acc_1000', 0, amt, paidFromPettyCash ? 'Petty Cash Disbursement' : 'Cash Disbursement');

      writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'RECORD_EXPENSE', 'Expense', expId, { category, amt });
    })();
    res.status(201).json({ id: expId });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/finance/daily-closing', requirePerm(PERMISSIONS.DAILY_CLOSE), (req, res) => {
  try {
    const { locationId, businessDate, openingFloat, actualCash, notes } = req.body;
    const dateStr = businessDate || new Date().toISOString().slice(0, 10);

    const closing = db.transaction(() => {
      const existing = db.prepare('SELECT id FROM daily_closings WHERE location_id = ? AND business_date = ?').get(locationId, dateStr);
      if (existing) throw new Error(`Business day ${dateStr} is already closed for this location`);

      const salesAgg = db
        .prepare("SELECT COALESCE(SUM(total_amount), 0) AS sales, COALESCE(SUM(total_cogs), 0) AS cogs FROM sales WHERE location_id = ? AND status = 'COMPLETED' AND substr(sold_at, 1, 10) = ?")
        .get(locationId, dateStr) as any;

      const cashSales = (
        db
          .prepare("SELECT COALESCE(SUM(p.amount), 0) AS cash FROM payments p JOIN sales s ON s.id = p.sale_id WHERE s.location_id = ? AND s.status = 'COMPLETED' AND p.method = 'CASH' AND substr(s.sold_at, 1, 10) = ?")
          .get(locationId, dateStr) as any
      ).cash;

      const pettyOut = (
        db
          .prepare("SELECT COALESCE(SUM(amount), 0) AS amt FROM expenses WHERE location_id = ? AND paid_from_petty_cash = 1 AND substr(expense_date, 1, 10) = ?")
          .get(locationId, dateStr) as any
      ).amt;

      const expectedCash = round2(Number(openingFloat || 0) + cashSales - pettyOut);
      const actual = round2(Number(actualCash));
      const variance = round2(actual - expectedCash);
      const grossProfit = round2(salesAgg.sales - salesAgg.cogs);

      const id = randomUUID();
      db.prepare(`
        INSERT INTO daily_closings (id, location_id, business_date, opening_float, expected_cash, actual_cash, variance, total_sales, gross_profit, closed_by, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, locationId, dateStr, Number(openingFloat || 0), expectedCash, actual, variance, round2(salesAgg.sales), grossProfit, req.authUser!.id, notes || '');

      if (variance !== 0) {
        createNotification(
          'CASH_VARIANCE',
          Math.abs(variance) > 200 ? 'CRITICAL' : 'WARNING',
          `Cash Reconciliation Variance (${dateStr})`,
          `Variance of PHP ${variance.toFixed(2)} recorded on closing.`,
        );
      }

      writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'DAILY_CLOSE', 'DailyClosing', id, { dateStr, expectedCash, actual, variance });
      return db.prepare('SELECT * FROM daily_closings WHERE id = ?').get(id);
    })();
    res.status(201).json(closing);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/finance/journals', requirePerm(PERMISSIONS.JOURNAL_POST), (req, res) => {
  try {
    const { entryDate, description, lines } = req.body;
    const totalD = round2((lines || []).reduce((s: number, l: any) => s + Number(l.debit || 0), 0));
    const totalC = round2((lines || []).reduce((s: number, l: any) => s + Number(l.credit || 0), 0));
    if (totalD !== totalC || totalD <= 0) throw new Error(`Unbalanced journal: Debit (${totalD}) must equal Credit (${totalC})`);

    const jeId = randomUUID();
    db.transaction(() => {
      db.prepare('INSERT INTO journal_entries (id, entry_number, entry_date, description, reference_type) VALUES (?, ?, ?, ?, ?)')
        .run(jeId, `JE-MAN-${Date.now().toString().slice(-6)}`, entryDate || new Date().toISOString(), description, 'MANUAL');
      const ins = db.prepare('INSERT INTO journal_lines (id, journal_entry_id, account_id, debit, credit, memo) VALUES (?, ?, ?, ?, ?, ?)');
      for (const l of lines) {
        ins.run(randomUUID(), jeId, l.accountId, round2(Number(l.debit || 0)), round2(Number(l.credit || 0)), l.memo || '');
      }
      writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'MANUAL_JOURNAL', 'JournalEntry', jeId, { description, totalD });
    })();
    res.status(201).json({ id: jeId });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.patch('/finance/tax/:id', requirePerm(PERMISSIONS.FINANCE_VIEW), (req, res) => {
  const { ratePercent, isInclusive, isActive } = req.body;
  db.prepare('UPDATE tax_configs SET rate_percent = ?, is_inclusive = ?, is_active = ? WHERE id = ?')
    .run(Number(ratePercent), isInclusive ? 1 : 0, isActive ? 1 : 0, req.params.id);
  writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'UPDATE_TAX_CONFIG', 'TaxConfiguration', req.params.id, req.body);
  res.json({ ok: true });
});

// ==========================================
// 8. FOOD COSTING & MENU ENGINEERING
// ==========================================
apiRouter.get('/food-costing', requirePerm(PERMISSIONS.DASHBOARD_VIEW), (_req, res) => {
  res.json(getFoodCostingAnalytics());
});

// ==========================================
// 9. FLEET & FOOD TRUCK MANAGEMENT
// ==========================================
apiRouter.get('/fleet', requirePerm(PERMISSIONS.FLEET_MANAGE), (_req, res) => {
  const trucks = db
    .prepare(`
      SELECT ft.*, l.name AS location_name, l.code AS location_code, l.address AS location_address, l.kds_enabled AS kds_enabled,
        COALESCE((SELECT SUM(s.total_amount) FROM sales s WHERE s.location_id = l.id AND s.status = 'COMPLETED'), 0) AS total_sales,
        COALESCE((SELECT SUM(s.total_cogs) FROM sales s WHERE s.location_id = l.id AND s.status = 'COMPLETED'), 0) AS total_cogs,
        COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.location_id = l.id), 0) AS total_expenses
      FROM food_trucks ft
      JOIN locations l ON l.id = ft.location_id
      WHERE l.is_active = 1
    `)
    .all();
  const locations = db
    .prepare(`
      SELECT l.*, ft.id AS truck_id, ft.plate_number, ft.make_model, ft.status, ft.current_site, ft.odometer_km
      FROM locations l
      LEFT JOIN food_trucks ft ON ft.location_id = l.id
      WHERE l.is_active = 1
      ORDER BY l.type ASC, l.name ASC
    `)
    .all();
  const assignments = db
    .prepare('SELECT ta.*, ft.plate_number, l.name AS truck_name FROM truck_assignments ta JOIN food_trucks ft ON ft.id = ta.truck_id JOIN locations l ON l.id = ft.location_id ORDER BY ta.assigned_date DESC LIMIT 20')
    .all();
  const fuelLogs = db
    .prepare('SELECT fl.*, ft.plate_number, l.name AS truck_name FROM fuel_logs fl JOIN food_trucks ft ON ft.id = fl.truck_id JOIN locations l ON l.id = ft.location_id ORDER BY fl.fueled_at DESC LIMIT 20')
    .all();
  const maintenanceLogs = db
    .prepare('SELECT ml.*, ft.plate_number, l.name AS truck_name FROM maintenance_logs ml JOIN food_trucks ft ON ft.id = ml.truck_id JOIN locations l ON l.id = ft.location_id ORDER BY ml.service_date DESC LIMIT 20')
    .all();
  res.json({ trucks, locations, assignments, fuelLogs, maintenanceLogs });
});

apiRouter.post('/fleet/trucks', requirePerm(PERMISSIONS.FLEET_MANAGE), (req, res) => {
  try {
    const { code, name, type, address, plateNumber, makeModel, currentSite, odometerKm, status, kdsEnabled } = req.body;
    const locType = type === 'COMMISSARY' ? 'COMMISSARY' : 'FOOD_TRUCK';
    const nextKds = kdsEnabled !== undefined ? (kdsEnabled ? 1 : 0) : (locType === 'FOOD_TRUCK' ? 1 : 0);
    const locId = randomUUID();
    const trkId = locType === 'FOOD_TRUCK' ? randomUUID() : null;
    db.transaction(() => {
      db.prepare('INSERT INTO locations (id, code, name, type, address, kds_enabled) VALUES (?, ?, ?, ?, ?, ?)').run(locId, code, name, locType, address || currentSite || '', nextKds);
      if (locType === 'FOOD_TRUCK' && trkId) {
        db.prepare('INSERT INTO food_trucks (id, location_id, plate_number, make_model, status, current_site, odometer_km) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          trkId,
          locId,
          plateNumber,
          makeModel,
          status || 'ACTIVE',
          currentSite || address || '',
          Number(odometerKm || 0),
        );
      }
      db.prepare('INSERT INTO petty_cash_funds (id, location_id, fund_name, float_amount, current_balance) VALUES (?, ?, ?, 5000, 5000)').run(randomUUID(), locId, `${name} Petty Cash`);
    })();
    res.status(201).json({ id: trkId || locId, locationId: locId });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put('/fleet/locations/:id', requirePerm(PERMISSIONS.FLEET_MANAGE), (req, res) => {
  try {
    const existingLoc = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id) as any;
    if (!existingLoc) {
      res.status(404).json({ error: 'Location not found' });
      return;
    }
    const { code, name, type, address, plateNumber, makeModel, currentSite, odometerKm, status, kdsEnabled } = req.body || {};
    const nextType = type === 'COMMISSARY' || type === 'FOOD_TRUCK' ? type : existingLoc.type;
    const nextKds = kdsEnabled !== undefined ? (kdsEnabled ? 1 : 0) : existingLoc.kds_enabled;
    db.transaction(() => {
      db.prepare('UPDATE locations SET code = ?, name = ?, type = ?, address = ?, kds_enabled = ? WHERE id = ?')
        .run(code ?? existingLoc.code, name ?? existingLoc.name, nextType, address ?? existingLoc.address ?? '', nextKds, existingLoc.id);
      if (nextType === 'FOOD_TRUCK') {
        const existingTrk = db.prepare('SELECT * FROM food_trucks WHERE location_id = ?').get(existingLoc.id) as any;
        if (existingTrk) {
          db.prepare('UPDATE food_trucks SET plate_number = ?, make_model = ?, status = ?, current_site = ?, odometer_km = ? WHERE id = ?')
            .run(
              plateNumber ?? existingTrk.plate_number,
              makeModel ?? existingTrk.make_model,
              status ?? existingTrk.status,
              currentSite ?? existingTrk.current_site ?? '',
              odometerKm !== undefined ? Number(odometerKm) : existingTrk.odometer_km,
              existingTrk.id,
            );
        }
      }
    })();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.patch('/fleet/locations/:id/kds', requirePerm(PERMISSIONS.FLEET_MANAGE), (req, res) => {
  const existingLoc = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id) as any;
  if (!existingLoc) {
    res.status(404).json({ error: 'Location not found' });
    return;
  }
  const nextKds = req.body?.kdsEnabled ? 1 : 0;
  db.prepare('UPDATE locations SET kds_enabled = ? WHERE id = ?').run(nextKds, existingLoc.id);
  writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'TOGGLE_LOCATION_KDS', 'Location', existingLoc.id, { kdsEnabled: Boolean(nextKds) });
  res.json({ ok: true, id: existingLoc.id, kds_enabled: nextKds });
});

apiRouter.post('/fleet/assignments', requirePerm(PERMISSIONS.FLEET_MANAGE), (req, res) => {
  const { truckId, siteName, assignedDate, shiftNotes } = req.body;
  db.transaction(() => {
    db.prepare('INSERT INTO truck_assignments (id, truck_id, site_name, assigned_date, shift_notes) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), truckId, siteName, assignedDate || new Date().toISOString().slice(0, 10), shiftNotes || '');
    db.prepare('UPDATE food_trucks SET current_site = ? WHERE id = ?').run(siteName, truckId);
  })();
  res.status(201).json({ ok: true });
});

apiRouter.post('/fleet/fuel', requirePerm(PERMISSIONS.FLEET_MANAGE), (req, res) => {
  const { truckId, liters, totalCost, odometerKm } = req.body;
  db.transaction(() => {
    const trk = db.prepare('SELECT location_id FROM food_trucks WHERE id = ?').get(truckId) as any;
    const expId = randomUUID();
    const cost = round2(Number(totalCost));
    db.prepare('INSERT INTO expenses (id, location_id, account_id, category, amount, description, expense_date) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(expId, trk.location_id, 'acc_6100', 'FUEL', cost, `Fuel log (${liters}L @ ${odometerKm}km)`, new Date().toISOString());
    db.prepare('INSERT INTO fuel_logs (id, truck_id, liters, total_cost, odometer_km, fueled_at, expense_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), truckId, Number(liters), cost, Number(odometerKm || 0), new Date().toISOString(), expId);
    if (odometerKm) db.prepare('UPDATE food_trucks SET odometer_km = ? WHERE id = ?').run(Number(odometerKm), truckId);
  })();
  res.status(201).json({ ok: true });
});

apiRouter.post('/fleet/maintenance', requirePerm(PERMISSIONS.FLEET_MANAGE), (req, res) => {
  const { truckId, title, description, cost, serviceDate, nextDueDate } = req.body;
  db.transaction(() => {
    const trk = db.prepare('SELECT location_id FROM food_trucks WHERE id = ?').get(truckId) as any;
    const amt = round2(Number(cost));
    db.prepare('INSERT INTO maintenance_logs (id, truck_id, title, description, cost, service_date, next_due_date) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), truckId, title, description || '', amt, serviceDate || new Date().toISOString().slice(0, 10), nextDueDate || null);
    if (amt > 0) {
      db.prepare('INSERT INTO expenses (id, location_id, account_id, category, amount, description, expense_date) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), trk.location_id, 'acc_6400', 'MAINTENANCE', amt, `Maintenance: ${title}`, new Date().toISOString());
    }
  })();
  res.status(201).json({ ok: true });
});

// ==========================================
// 10. HR, ATTENDANCE & CONFIGURABLE PH PAYROLL
// ==========================================
apiRouter.get('/hr', requirePerm(PERMISSIONS.HR_MANAGE), (_req, res) => {
  const employees = db
    .prepare('SELECT e.*, l.name AS location_name FROM employees e LEFT JOIN locations l ON l.id = e.location_id ORDER BY e.employee_code ASC')
    .all();
  const attendance = db
    .prepare('SELECT a.*, e.full_name, e.employee_code FROM attendance_logs a JOIN employees e ON e.id = a.employee_id ORDER BY a.clock_in DESC LIMIT 40')
    .all();
  const rules = db.prepare('SELECT * FROM payroll_rules WHERE is_active = 1').get() as any;
  const payrollRuns = (db.prepare('SELECT * FROM payroll_runs ORDER BY created_at DESC LIMIT 10').all() as any[]).map((pr) => ({
    ...pr,
    items: db
      .prepare('SELECT pi.*, e.full_name, e.employee_code FROM payroll_items pi JOIN employees e ON e.id = pi.employee_id WHERE pi.payroll_run_id = ?')
      .all(pr.id),
  }));
  res.json({
    employees,
    attendance,
    payrollRules: rules ? { ...rules, config: JSON.parse(rules.rule_json) } : null,
    payrollRuns,
  });
});

apiRouter.post('/hr/employees', requirePerm(PERMISSIONS.HR_MANAGE), (req, res) => {
  try {
    const { employeeCode, fullName, department, position, locationId, payType, baseRate, avatarUrl, isActive } = req.body;
    const id = randomUUID();
    db.prepare('INSERT INTO employees (id, employee_code, full_name, department, position, location_id, pay_type, base_rate, avatar_url, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, employeeCode || `EMP-${Date.now().toString().slice(-3)}`, fullName, department, position, locationId || null, payType || 'DAILY', Number(baseRate), avatarUrl || null, isActive !== false ? 1 : 0);
    res.status(201).json({ id });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put('/hr/employees/:id', requirePerm(PERMISSIONS.HR_MANAGE), (req, res) => {
  try {
    const empId = req.params.id;
    const existing = db.prepare('SELECT * FROM employees WHERE id = ?').get(empId) as any;
    if (!existing) {
      res.status(404).json({ error: 'Employee not found' });
      return;
    }

    const { employeeCode, fullName, department, position, locationId, payType, baseRate, avatarUrl, isActive } = req.body || {};
    const cleanName = String(fullName ?? existing.full_name).trim();
    const cleanCode = String(employeeCode ?? existing.employee_code).trim();
    if (!cleanName) throw new Error('Employee full name is required');
    if (!cleanCode) throw new Error('Employee code is required');

    const dup = db.prepare('SELECT id FROM employees WHERE lower(employee_code) = lower(?) AND id != ?').get(cleanCode, empId);
    if (dup) throw new Error(`Employee code "${cleanCode}" is already used by another employee`);

    const nextAvatar = avatarUrl !== undefined ? (avatarUrl ? String(avatarUrl) : null) : existing.avatar_url;
    const nextActive = isActive === undefined ? existing.is_active : isActive ? 1 : 0;

    db.prepare(`
      UPDATE employees
      SET employee_code = ?, full_name = ?, department = ?, position = ?, location_id = ?, pay_type = ?, base_rate = ?, avatar_url = ?, is_active = ?
      WHERE id = ?
    `).run(
      cleanCode,
      cleanName,
      department !== undefined ? String(department).trim() : existing.department,
      position !== undefined ? String(position).trim() : existing.position,
      locationId !== undefined ? (locationId || null) : existing.location_id,
      payType || existing.pay_type,
      Number(baseRate ?? existing.base_rate),
      nextAvatar,
      nextActive,
      empId,
    );

    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/hr/attendance/clock', requirePerm(PERMISSIONS.HR_MANAGE), (req, res) => {
  const { employeeId, action, overtimeHours } = req.body;
  if (action === 'CLOCK_IN') {
    const id = randomUUID();
    db.prepare('INSERT INTO attendance_logs (id, employee_id, clock_in, status) VALUES (?, ?, ?, ?)')
      .run(id, employeeId, new Date().toISOString(), 'PRESENT');
    res.status(201).json({ id });
    return;
  }
  const openLog = db.prepare('SELECT id FROM attendance_logs WHERE employee_id = ? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1').get(employeeId) as any;
  if (!openLog) {
    res.status(400).json({ error: 'No active clock-in found for employee' });
    return;
  }
  db.prepare('UPDATE attendance_logs SET clock_out = ?, overtime_hours = ? WHERE id = ?')
    .run(new Date().toISOString(), Number(overtimeHours || 0), openLog.id);
  res.json({ ok: true });
});

apiRouter.put('/hr/payroll-rules', requirePerm(PERMISSIONS.PAYROLL_RUN), (req, res) => {
  db.prepare('UPDATE payroll_rules SET rule_json = ? WHERE code = ?')
    .run(JSON.stringify(req.body.config), 'PH_STATUTORY_2026');
  writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'UPDATE_PAYROLL_RULES', 'PayrollRule', 'PH_STATUTORY_2026', req.body.config);
  res.json({ ok: true });
});

apiRouter.post('/hr/payroll/run', requirePerm(PERMISSIONS.PAYROLL_RUN), (req, res) => {
  const { periodStart, periodEnd, daysPerEmployee } = req.body;
  const rulesRow = db.prepare('SELECT rule_json FROM payroll_rules WHERE is_active = 1').get() as any;
  const cfg = JSON.parse(rulesRow.rule_json);

  const run = db.transaction(() => {
    const employees = db.prepare('SELECT * FROM employees WHERE is_active = 1').all() as any[];
    const runId = randomUUID();
    let totalGross = 0;
    let totalDed = 0;
    let totalNet = 0;

    const items: any[] = [];
    for (const emp of employees) {
      const days = Number(daysPerEmployee ?? 13);
      const otHours = (
        db
          .prepare('SELECT COALESCE(SUM(overtime_hours), 0) AS ot FROM attendance_logs WHERE employee_id = ?')
          .get(emp.id) as any
      ).ot;

      const dailyRate = emp.pay_type === 'MONTHLY' ? emp.base_rate / 26 : emp.base_rate;
      const hourlyRate = dailyRate / 8;
      const otPay = round2(otHours * hourlyRate * (cfg.overtimeMultiplier || 1.25));
      const gross = round2(days * dailyRate + otPay);

      const sss = round2(gross * ((cfg.sssEmployeeRatePct || 4.5) / 100));
      const phic = round2(gross * ((cfg.philhealthEmployeeRatePct || 2.5) / 100));
      const pagibig = round2((cfg.pagibigFixedEmployeePhp || 200) / 2); // Semi-monthly share
      const semiMonthlyCeiling = (cfg.taxExemptMonthlyCeilingPhp || 20833) / 2;
      const taxableExcess = Math.max(0, gross - (sss + phic + pagibig) - semiMonthlyCeiling);
      const tax = round2(taxableExcess * ((cfg.withholdingRateAboveCeilingPct || 15) / 100));

      const ded = round2(sss + phic + pagibig + tax);
      const net = round2(gross - ded);

      totalGross += gross;
      totalDed += ded;
      totalNet += net;

      items.push({ id: randomUUID(), empId: emp.id, days, otPay, gross, sss, phic, pagibig, tax, net });
    }

    db.prepare('INSERT INTO payroll_runs (id, period_start, period_end, status, total_gross, total_deductions, total_net) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(runId, periodStart, periodEnd, 'APPROVED', round2(totalGross), round2(totalDed), round2(totalNet));

    const insPI = db.prepare(`
      INSERT INTO payroll_items (id, payroll_run_id, employee_id, days_worked, overtime_pay, gross_pay, sss_deduction, philhealth_deduction, pagibig_deduction, tax_deduction, net_pay)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const i of items) {
      insPI.run(i.id, runId, i.empId, i.days, i.otPay, i.gross, i.sss, i.phic, i.pagibig, i.tax, i.net);
    }

    // Post Payroll Expense Journal Entry
    const jeId = randomUUID();
    db.prepare('INSERT INTO journal_entries (id, entry_number, entry_date, description, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(jeId, `JE-PAY-${Date.now().toString().slice(-6)}`, new Date().toISOString(), `Payroll ${periodStart} to ${periodEnd}`, 'PAYROLL', runId);
    db.prepare('INSERT INTO journal_lines (id, journal_entry_id, account_id, debit, credit, memo) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), jeId, 'acc_6300', round2(totalGross), 0, 'Salaries & Wages');
    db.prepare('INSERT INTO journal_lines (id, journal_entry_id, account_id, debit, credit, memo) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), jeId, 'acc_1010', 0, round2(totalNet), 'Net Payroll Disbursement');
    if (totalDed > 0) {
      db.prepare('INSERT INTO journal_lines (id, journal_entry_id, account_id, debit, credit, memo) VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), jeId, 'acc_2000', 0, round2(totalDed), 'Statutory & Tax Remittances Payable');
    }

    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'RUN_PAYROLL', 'PayrollRun', runId, { totalGross, totalNet });
    return { runId, totalGross: round2(totalGross), totalNet: round2(totalNet) };
  })();
  res.status(201).json(run);
});

// ==========================================
// 11. CRM, REPORTS & GOVERNANCE
// ==========================================
apiRouter.get('/crm/customers', requirePerm(PERMISSIONS.CRM_MANAGE), (_req, res) => {
  const customers = db
    .prepare(`
      SELECT c.*,
        COALESCE((SELECT COUNT(*) FROM sales s WHERE s.customer_id = c.id AND s.status = 'COMPLETED'), 0) AS total_orders,
        COALESCE((SELECT SUM(s.total_amount) FROM sales s WHERE s.customer_id = c.id AND s.status = 'COMPLETED'), 0) AS lifetime_spend
      FROM customers c
      ORDER BY lifetime_spend DESC
    `)
    .all();
  res.json(customers);
});

apiRouter.post('/crm/customers', requirePerm(PERMISSIONS.CRM_MANAGE), (req, res) => {
  try {
    const { fullName, phone, email, preferences } = req.body;
    const id = randomUUID();
    db.prepare('INSERT INTO customers (id, full_name, phone, email, preferences) VALUES (?, ?, ?, ?, ?)')
      .run(id, fullName, phone || null, email || null, preferences || '');
    res.status(201).json({ id });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.get('/reports/:type', requirePerm(PERMISSIONS.REPORTS_VIEW), (req, res) => {
  const { type } = req.params;
  const from = typeof req.query.from === 'string' && req.query.from.trim() ? req.query.from.trim().slice(0, 10) : '';
  const to = typeof req.query.to === 'string' && req.query.to.trim() ? req.query.to.trim().slice(0, 10) : '';

  const buildDateFilter = (expr: string) => {
    const clauses: string[] = [];
    const args: string[] = [];
    if (from) {
      clauses.push(`${expr} >= ?`);
      args.push(from);
    }
    if (to) {
      clauses.push(`${expr} <= ?`);
      args.push(to);
    }
    return { clauses, args };
  };

  if (type === 'sales') {
    const { clauses, args } = buildDateFilter('substr(s.sold_at, 1, 10)');
    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    res.json(
      db.prepare(`
        SELECT s.receipt_number, substr(s.sold_at, 1, 19) AS sold_at, l.name AS truck, s.channel, s.status, s.subtotal, s.tax_amount, s.total_amount, s.total_cogs, (s.total_amount - s.total_cogs) AS gross_profit
        FROM sales s JOIN locations l ON l.id = s.location_id
        ${whereSql}
        ORDER BY s.sold_at DESC
      `).all(...args),
    );
    return;
  }
  if (type === 'inventory') {
    const { clauses, args } = buildDateFilter('substr(b.received_at, 1, 10)');
    const joinFilter = clauses.length ? `AND ${clauses.join(' AND ')}` : '';
    res.json(
      db.prepare(`
        SELECT i.sku, i.name, u.code AS uom, i.costing_method, i.reorder_point,
          COALESCE(SUM(b.remaining_qty), 0) AS on_hand,
          COALESCE(SUM(b.remaining_qty * b.unit_cost), 0) AS total_value
        FROM inventory_items i JOIN uoms u ON u.id = i.base_uom_id
        LEFT JOIN stock_batches b ON b.inventory_item_id = i.id ${joinFilter}
        GROUP BY i.id
      `).all(...args),
    );
    return;
  }
  if (type === 'expenses') {
    const { clauses, args } = buildDateFilter('substr(e.expense_date, 1, 10)');
    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    res.json(
      db.prepare(`
        SELECT substr(e.expense_date, 1, 10) AS date, l.name AS location, e.category, e.description, e.amount
        FROM expenses e JOIN locations l ON l.id = e.location_id
        ${whereSql}
        ORDER BY e.expense_date DESC
      `).all(...args),
    );
    return;
  }
  if (type === 'waste') {
    const { clauses, args } = buildDateFilter('substr(t.created_at, 1, 10)');
    const extraWhere = clauses.length ? `AND ${clauses.join(' AND ')}` : '';
    res.json(
      db.prepare(`
        SELECT substr(t.created_at, 1, 19) AS date, l.name AS location, i.name AS ingredient, ABS(t.quantity_delta) AS qty, u.code AS uom, t.total_cost AS cost_php, t.notes AS reason
        FROM inventory_transactions t
        JOIN inventory_items i ON i.id = t.inventory_item_id
        JOIN uoms u ON u.id = i.base_uom_id
        JOIN locations l ON l.id = t.location_id
        WHERE t.txn_type IN ('OUT_WASTE', 'OUT_SPOILAGE') ${extraWhere}
        ORDER BY t.created_at DESC
      `).all(...args),
    );
    return;
  }
  res.json([]);
});

apiRouter.get('/admin/governance', requirePerm(PERMISSIONS.DASHBOARD_VIEW), (req, res) => {
  const from = typeof req.query.from === 'string' && req.query.from.trim() ? req.query.from.trim().slice(0, 10) : '';
  const to = typeof req.query.to === 'string' && req.query.to.trim() ? req.query.to.trim().slice(0, 10) : '';

  const roles = (db.prepare('SELECT * FROM roles ORDER BY name ASC').all() as any[]).map((r) => ({
    ...r,
    permissions: db
      .prepare('SELECT p.key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?')
      .all(r.id)
      .map((x: any) => x.key),
  }));

  const clauses: string[] = [];
  const args: string[] = [];
  if (from) {
    clauses.push('substr(created_at, 1, 10) >= ?');
    args.push(from);
  }
  if (to) {
    clauses.push('substr(created_at, 1, 10) <= ?');
    args.push(to);
  }
  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = clauses.length ? 200 : 100;
  const auditLogs = db.prepare(`SELECT * FROM audit_logs ${whereSql} ORDER BY created_at DESC LIMIT ${limit}`).all(...args);
  res.json({ roles, auditLogs });
});

// ==========================================
// 12. USER CONTROL SETTINGS (OWNER & SUPER_ADMIN ONLY)
// ==========================================
apiRouter.get('/settings/users-control', requireOwnerOrSuperAdmin, (_req, res) => {
  const users = db
    .prepare(`
      SELECT u.id, u.email, u.full_name, u.role_id, u.assigned_location_id, u.avatar_url, u.is_active, u.created_at,
             r.code AS role_code, r.name AS role_name, l.name AS location_name
      FROM users u
      JOIN roles r ON r.id = u.role_id
      LEFT JOIN locations l ON l.id = u.assigned_location_id
      ORDER BY u.is_active DESC, u.full_name ASC
    `)
    .all();

  const employees = db
    .prepare(`
      SELECT e.*, l.name AS location_name
      FROM employees e
      LEFT JOIN locations l ON l.id = e.location_id
      ORDER BY e.is_active DESC, e.employee_code ASC
    `)
    .all();

  const roles = db.prepare('SELECT id, code, name, description FROM roles ORDER BY name ASC').all();
  const locations = db.prepare('SELECT id, code, name, type FROM locations WHERE is_active = 1 ORDER BY type ASC, name ASC').all();

  res.json({ users, employees, roles, locations });
});

apiRouter.post('/settings/users', requireOwnerOrSuperAdmin, (req, res) => {
  try {
    const { email, password, fullName, roleId, assignedLocationId, avatarUrl, isActive } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanName = String(fullName || '').trim();
    if (!cleanEmail) throw new Error('Email is required');
    if (!cleanName) throw new Error('Full name is required');
    if (!password || String(password).length < 6) throw new Error('Password must be at least 6 characters');
    if (!roleId) throw new Error('Role is required');

    const dup = db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(cleanEmail);
    if (dup) throw new Error(`A user with email "${cleanEmail}" already exists`);

    const roleRow = db.prepare('SELECT id, code, name FROM roles WHERE id = ?').get(roleId) as any;
    if (!roleRow) throw new Error('Selected role does not exist');

    const id = randomUUID();
    const hash = bcrypt.hashSync(String(password), 10);
    db.prepare(`
      INSERT INTO users (id, email, password_hash, full_name, role_id, assigned_location_id, avatar_url, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, cleanEmail, hash, cleanName, roleId, assignedLocationId || null, avatarUrl || null, isActive === false ? 0 : 1);

    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'CREATE_USER', 'User', id, {
      email: cleanEmail,
      fullName: cleanName,
      roleCode: roleRow.code,
    });
    res.status(201).json({ id });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put('/settings/users/:id', requireOwnerOrSuperAdmin, (req, res) => {
  try {
    const targetId = req.params.id;
    const existing = db
      .prepare('SELECT u.*, r.code AS role_code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?')
      .get(targetId) as any;
    if (!existing) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const { email, password, fullName, roleId, assignedLocationId, avatarUrl, isActive } = req.body || {};
    const cleanEmail = String(email ?? existing.email).trim().toLowerCase();
    const cleanName = String(fullName ?? existing.full_name).trim();
    const nextRoleId = roleId || existing.role_id;
    const nextActive = isActive === undefined ? existing.is_active : isActive ? 1 : 0;

    if (!cleanEmail) throw new Error('Email is required');
    if (!cleanName) throw new Error('Full name is required');

    const dup = db.prepare('SELECT id FROM users WHERE lower(email) = lower(?) AND id != ?').get(cleanEmail, targetId);
    if (dup) throw new Error(`Email "${cleanEmail}" is already used by another account`);

    const nextRole = db.prepare('SELECT id, code FROM roles WHERE id = ?').get(nextRoleId) as any;
    if (!nextRole) throw new Error('Selected role does not exist');

    if (targetId === req.authUser!.id) {
      if (nextActive === 0) throw new Error('You cannot deactivate your own active session account');
      if (nextRole.code !== 'SUPER_ADMIN' && nextRole.code !== 'BUSINESS_OWNER') {
        throw new Error('You cannot remove your own Owner/Super Admin access while signed in');
      }
    }

    const nextAvatar = avatarUrl !== undefined ? (avatarUrl ? String(avatarUrl) : null) : existing.avatar_url;
    if (password && String(password).trim().length > 0) {
      if (String(password).length < 6) throw new Error('New password must be at least 6 characters');
      const hash = bcrypt.hashSync(String(password), 10);
      db.prepare(`
        UPDATE users
        SET email = ?, password_hash = ?, full_name = ?, role_id = ?, assigned_location_id = ?, avatar_url = ?, is_active = ?
        WHERE id = ?
      `).run(cleanEmail, hash, cleanName, nextRoleId, assignedLocationId || null, nextAvatar, nextActive, targetId);
    } else {
      db.prepare(`
        UPDATE users
        SET email = ?, full_name = ?, role_id = ?, assigned_location_id = ?, avatar_url = ?, is_active = ?
        WHERE id = ?
      `).run(cleanEmail, cleanName, nextRoleId, assignedLocationId || null, nextAvatar, nextActive, targetId);
    }

    if (nextActive === 0) {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
    }

    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'UPDATE_USER', 'User', targetId, {
      email: cleanEmail,
      fullName: cleanName,
      roleCode: nextRole.code,
      isActive: nextActive === 1,
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/settings/employees', requireOwnerOrSuperAdmin, (req, res) => {
  try {
    const { employeeCode, fullName, department, position, locationId, payType, baseRate, avatarUrl, isActive } = req.body || {};
    const cleanName = String(fullName || '').trim();
    if (!cleanName) throw new Error('Employee full name is required');
    const code = String(employeeCode || `EMP-${Date.now().toString().slice(-3)}`).trim();
    const dup = db.prepare('SELECT id FROM employees WHERE lower(employee_code) = lower(?)').get(code);
    if (dup) throw new Error(`Employee code "${code}" already exists`);

    const id = randomUUID();
    db.prepare(`
      INSERT INTO employees (id, employee_code, full_name, department, position, location_id, pay_type, base_rate, avatar_url, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      code,
      cleanName,
      String(department || 'Operations').trim(),
      String(position || 'Crew').trim(),
      locationId || null,
      payType || 'DAILY',
      Number(baseRate || 650),
      avatarUrl || null,
      isActive === false ? 0 : 1,
    );
    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'CREATE_EMPLOYEE', 'Employee', id, { code, fullName: cleanName });
    res.status(201).json({ id });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put('/settings/employees/:id', requireOwnerOrSuperAdmin, (req, res) => {
  try {
    const empId = req.params.id;
    const existing = db.prepare('SELECT * FROM employees WHERE id = ?').get(empId) as any;
    if (!existing) {
      res.status(404).json({ error: 'Employee not found' });
      return;
    }

    const { employeeCode, fullName, department, position, locationId, payType, baseRate, avatarUrl, isActive } = req.body || {};
    const cleanName = String(fullName ?? existing.full_name).trim();
    const cleanCode = String(employeeCode ?? existing.employee_code).trim();
    if (!cleanName) throw new Error('Employee full name is required');
    if (!cleanCode) throw new Error('Employee code is required');

    const dup = db.prepare('SELECT id FROM employees WHERE lower(employee_code) = lower(?) AND id != ?').get(cleanCode, empId);
    if (dup) throw new Error(`Employee code "${cleanCode}" is already used by another employee`);

    const nextAvatar = avatarUrl !== undefined ? (avatarUrl ? String(avatarUrl) : null) : existing.avatar_url;
    const nextActive = isActive === undefined ? existing.is_active : isActive ? 1 : 0;

    db.prepare(`
      UPDATE employees
      SET employee_code = ?, full_name = ?, department = ?, position = ?, location_id = ?, pay_type = ?, base_rate = ?, avatar_url = ?, is_active = ?
      WHERE id = ?
    `).run(
      cleanCode,
      cleanName,
      String(department ?? existing.department).trim(),
      String(position ?? existing.position).trim(),
      locationId !== undefined ? (locationId || null) : existing.location_id,
      payType || existing.pay_type,
      Number(baseRate ?? existing.base_rate),
      nextAvatar,
      nextActive,
      empId,
    );

    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'UPDATE_EMPLOYEE', 'Employee', empId, {
      code: cleanCode,
      fullName: cleanName,
      isActive: nextActive === 1,
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
