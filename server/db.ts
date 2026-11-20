import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { PERMISSIONS } from '../src/types/erp.ts';

const dataDir = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'kalyefleet_erp.sqlite');
export const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS permissions (
      id TEXT PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      module TEXT NOT NULL,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
      PRIMARY KEY (role_id, permission_id)
    );

    CREATE TABLE IF NOT EXISTS locations (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      address TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role_id TEXT NOT NULL REFERENCES roles(id),
      assigned_location_id TEXT REFERENCES locations(id),
      avatar_url TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      user_name TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS food_trucks (
      id TEXT PRIMARY KEY,
      location_id TEXT UNIQUE NOT NULL REFERENCES locations(id),
      plate_number TEXT UNIQUE NOT NULL,
      make_model TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      current_site TEXT,
      odometer_km INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS truck_assignments (
      id TEXT PRIMARY KEY,
      truck_id TEXT NOT NULL REFERENCES food_trucks(id),
      site_name TEXT NOT NULL,
      assigned_date TEXT NOT NULL,
      shift_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS fuel_logs (
      id TEXT PRIMARY KEY,
      truck_id TEXT NOT NULL REFERENCES food_trucks(id),
      liters REAL NOT NULL,
      total_cost REAL NOT NULL,
      odometer_km INTEGER NOT NULL,
      fueled_at TEXT NOT NULL,
      expense_id TEXT
    );

    CREATE TABLE IF NOT EXISTS maintenance_logs (
      id TEXT PRIMARY KEY,
      truck_id TEXT NOT NULL REFERENCES food_trucks(id),
      title TEXT NOT NULL,
      description TEXT,
      cost REAL NOT NULL,
      service_date TEXT NOT NULL,
      next_due_date TEXT,
      status TEXT NOT NULL DEFAULT 'COMPLETED'
    );

    CREATE TABLE IF NOT EXISTS uoms (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS unit_conversions (
      id TEXT PRIMARY KEY,
      from_uom_id TEXT NOT NULL REFERENCES uoms(id),
      to_uom_id TEXT NOT NULL REFERENCES uoms(id),
      factor REAL NOT NULL,
      UNIQUE(from_uom_id, to_uom_id)
    );

    CREATE TABLE IF NOT EXISTS inventory_items (
      id TEXT PRIMARY KEY,
      sku TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      item_type TEXT NOT NULL DEFAULT 'RAW_MATERIAL',
      base_uom_id TEXT NOT NULL REFERENCES uoms(id),
      costing_method TEXT NOT NULL DEFAULT 'FIFO',
      min_stock_level REAL NOT NULL DEFAULT 0,
      reorder_point REAL NOT NULL DEFAULT 0,
      last_unit_cost REAL NOT NULL DEFAULT 0,
      weighted_avg_cost REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS stock_batches (
      id TEXT PRIMARY KEY,
      inventory_item_id TEXT NOT NULL REFERENCES inventory_items(id),
      location_id TEXT NOT NULL REFERENCES locations(id),
      batch_number TEXT NOT NULL,
      initial_qty REAL NOT NULL,
      remaining_qty REAL NOT NULL,
      unit_cost REAL NOT NULL,
      expiry_date TEXT,
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_batches_fifo ON stock_batches(inventory_item_id, location_id, received_at);

    CREATE TABLE IF NOT EXISTS inventory_transactions (
      id TEXT PRIMARY KEY,
      inventory_item_id TEXT NOT NULL REFERENCES inventory_items(id),
      location_id TEXT NOT NULL REFERENCES locations(id),
      batch_id TEXT REFERENCES stock_batches(id),
      txn_type TEXT NOT NULL,
      quantity_delta REAL NOT NULL,
      unit_cost REAL NOT NULL,
      total_cost REAL NOT NULL,
      reference_type TEXT,
      reference_id TEXT,
      notes TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_inv_txn_date ON inventory_transactions(created_at);

    CREATE TABLE IF NOT EXISTS stock_transfers (
      id TEXT PRIMARY KEY,
      transfer_number TEXT UNIQUE NOT NULL,
      from_location_id TEXT NOT NULL REFERENCES locations(id),
      to_location_id TEXT NOT NULL REFERENCES locations(id),
      status TEXT NOT NULL DEFAULT 'RECEIVED',
      notes TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS stock_transfer_items (
      id TEXT PRIMARY KEY,
      transfer_id TEXT NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
      inventory_item_id TEXT NOT NULL REFERENCES inventory_items(id),
      quantity REAL NOT NULL,
      total_cost REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tax_configs (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      rate_percent REAL NOT NULL,
      is_inclusive INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      sku TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      image_url TEXT,
      category_id TEXT NOT NULL REFERENCES categories(id),
      base_price REAL NOT NULL,
      packaging_cost REAL NOT NULL DEFAULT 0,
      direct_labor_cost REAL NOT NULL DEFAULT 0,
      target_food_cost_pct REAL NOT NULL DEFAULT 35,
      tax_config_id TEXT REFERENCES tax_configs(id),
      is_available INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS product_variants (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      price_delta REAL NOT NULL DEFAULT 0,
      portion_multiplier REAL NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS modifier_options (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      group_name TEXT NOT NULL,
      name TEXT NOT NULL,
      price_delta REAL NOT NULL DEFAULT 0,
      inventory_item_id TEXT REFERENCES inventory_items(id),
      deduct_qty REAL DEFAULT 0,
      uom_id TEXT REFERENCES uoms(id)
    );

    CREATE TABLE IF NOT EXISTS recipes (
      id TEXT PRIMARY KEY,
      product_id TEXT UNIQUE NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      yield_qty REAL NOT NULL DEFAULT 1,
      prep_instructions TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS recipe_ingredients (
      id TEXT PRIMARY KEY,
      recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      inventory_item_id TEXT NOT NULL REFERENCES inventory_items(id),
      quantity REAL NOT NULL,
      uom_id TEXT NOT NULL REFERENCES uoms(id),
      waste_factor_pct REAL NOT NULL DEFAULT 0,
      substitute_item_id TEXT REFERENCES inventory_items(id)
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      contact_person TEXT,
      phone TEXT,
      email TEXT,
      address TEXT,
      tin TEXT,
      payment_terms INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS supplier_items (
      id TEXT PRIMARY KEY,
      supplier_id TEXT NOT NULL REFERENCES suppliers(id),
      inventory_item_id TEXT NOT NULL REFERENCES inventory_items(id),
      unit_price REAL NOT NULL,
      lead_time_days INTEGER NOT NULL DEFAULT 1,
      UNIQUE(supplier_id, inventory_item_id)
    );

    CREATE TABLE IF NOT EXISTS purchase_orders (
      id TEXT PRIMARY KEY,
      po_number TEXT UNIQUE NOT NULL,
      supplier_id TEXT NOT NULL REFERENCES suppliers(id),
      location_id TEXT NOT NULL REFERENCES locations(id),
      status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
      total_amount REAL NOT NULL DEFAULT 0,
      approved_by TEXT REFERENCES users(id),
      notes TEXT,
      ordered_at TEXT NOT NULL DEFAULT (datetime('now')),
      expected_at TEXT
    );

    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id TEXT PRIMARY KEY,
      purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      inventory_item_id TEXT NOT NULL REFERENCES inventory_items(id),
      ordered_qty REAL NOT NULL,
      received_qty REAL NOT NULL DEFAULT 0,
      unit_cost REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS goods_receipts (
      id TEXT PRIMARY KEY,
      grn_number TEXT UNIQUE NOT NULL,
      purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id),
      received_by TEXT,
      notes TEXT,
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS goods_receipt_items (
      id TEXT PRIMARY KEY,
      goods_receipt_id TEXT NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
      inventory_item_id TEXT NOT NULL REFERENCES inventory_items(id),
      ordered_qty REAL NOT NULL,
      received_qty REAL NOT NULL,
      rejected_qty REAL NOT NULL DEFAULT 0,
      unit_cost REAL NOT NULL,
      batch_number TEXT NOT NULL,
      expiry_date TEXT,
      discrepancy_notes TEXT
    );

    CREATE TABLE IF NOT EXISTS supplier_invoices (
      id TEXT PRIMARY KEY,
      invoice_number TEXT NOT NULL,
      supplier_id TEXT NOT NULL REFERENCES suppliers(id),
      purchase_order_id TEXT REFERENCES purchase_orders(id),
      total_amount REAL NOT NULL,
      paid_amount REAL NOT NULL DEFAULT 0,
      due_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'UNPAID',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS supplier_payments (
      id TEXT PRIMARY KEY,
      payment_number TEXT UNIQUE NOT NULL,
      supplier_invoice_id TEXT NOT NULL REFERENCES supplier_invoices(id),
      amount REAL NOT NULL,
      method TEXT NOT NULL,
      reference_no TEXT,
      paid_by TEXT,
      paid_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      phone TEXT UNIQUE,
      email TEXT,
      loyalty_points INTEGER NOT NULL DEFAULT 0,
      tier TEXT NOT NULL DEFAULT 'STANDARD',
      preferences TEXT,
      feedback_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY,
      receipt_number TEXT UNIQUE NOT NULL,
      client_txn_id TEXT UNIQUE,
      location_id TEXT NOT NULL REFERENCES locations(id),
      cashier_id TEXT NOT NULL REFERENCES users(id),
      customer_id TEXT REFERENCES customers(id),
      channel TEXT NOT NULL DEFAULT 'WALK_IN',
      status TEXT NOT NULL DEFAULT 'COMPLETED',
      kds_status TEXT NOT NULL DEFAULT 'PENDING',
      subtotal REAL NOT NULL,
      discount_amount REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL,
      total_cogs REAL NOT NULL DEFAULT 0,
      notes TEXT,
      is_offline_synced INTEGER NOT NULL DEFAULT 0,
      sold_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sales_loc_date ON sales(location_id, sold_at);

    CREATE TABLE IF NOT EXISTS sale_items (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL REFERENCES products(id),
      variant_id TEXT REFERENCES product_variants(id),
      product_name TEXT NOT NULL,
      variant_name TEXT,
      quantity REAL NOT NULL,
      unit_price REAL NOT NULL,
      line_total REAL NOT NULL,
      cogs_amount REAL NOT NULL DEFAULT 0,
      modifiers_json TEXT,
      kitchen_notes TEXT
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      method TEXT NOT NULL,
      amount REAL NOT NULL,
      reference_no TEXT,
      paid_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      is_system INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS journal_entries (
      id TEXT PRIMARY KEY,
      entry_number TEXT UNIQUE NOT NULL,
      entry_date TEXT NOT NULL,
      description TEXT NOT NULL,
      reference_type TEXT,
      reference_id TEXT,
      is_reversed INTEGER NOT NULL DEFAULT 0,
      reversal_of_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS journal_lines (
      id TEXT PRIMARY KEY,
      journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      debit REAL NOT NULL DEFAULT 0,
      credit REAL NOT NULL DEFAULT 0,
      memo TEXT
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      location_id TEXT NOT NULL REFERENCES locations(id),
      account_id TEXT NOT NULL REFERENCES accounts(id),
      category TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT NOT NULL,
      is_recurring INTEGER NOT NULL DEFAULT 0,
      paid_from_petty_cash INTEGER NOT NULL DEFAULT 0,
      expense_date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS petty_cash_funds (
      id TEXT PRIMARY KEY,
      location_id TEXT UNIQUE NOT NULL REFERENCES locations(id),
      fund_name TEXT NOT NULL,
      float_amount REAL NOT NULL,
      current_balance REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_closings (
      id TEXT PRIMARY KEY,
      location_id TEXT NOT NULL REFERENCES locations(id),
      business_date TEXT NOT NULL,
      opening_float REAL NOT NULL DEFAULT 0,
      expected_cash REAL NOT NULL,
      actual_cash REAL NOT NULL,
      variance REAL NOT NULL,
      total_sales REAL NOT NULL,
      gross_profit REAL NOT NULL,
      closed_by TEXT NOT NULL REFERENCES users(id),
      notes TEXT,
      closed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(location_id, business_date)
    );

    CREATE TABLE IF NOT EXISTS financial_periods (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      closed_by TEXT,
      closed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY,
      employee_code TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      department TEXT NOT NULL,
      position TEXT NOT NULL,
      location_id TEXT REFERENCES locations(id),
      pay_type TEXT NOT NULL DEFAULT 'DAILY',
      base_rate REAL NOT NULL,
      avatar_url TEXT,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS attendance_logs (
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL REFERENCES employees(id),
      clock_in TEXT NOT NULL,
      clock_out TEXT,
      overtime_hours REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'PRESENT',
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS payroll_rules (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      rule_json TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS payroll_runs (
      id TEXT PRIMARY KEY,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'APPROVED',
      total_gross REAL NOT NULL,
      total_deductions REAL NOT NULL,
      total_net REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payroll_items (
      id TEXT PRIMARY KEY,
      payroll_run_id TEXT NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
      employee_id TEXT NOT NULL REFERENCES employees(id),
      days_worked REAL NOT NULL,
      overtime_pay REAL NOT NULL,
      gross_pay REAL NOT NULL,
      sss_deduction REAL NOT NULL,
      philhealth_deduction REAL NOT NULL,
      pagibig_deduction REAL NOT NULL,
      tax_deduction REAL NOT NULL,
      net_pay REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'WARNING',
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const ensureColumn = (table: string, column: string, colDef: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${colDef}`);
    }
  };
  ensureColumn('users', 'avatar_url', 'TEXT');
  ensureColumn('employees', 'avatar_url', 'TEXT');

  db.exec(`
    UPDATE users SET email = REPLACE(email, '@kalyefleet.ph', '@maximusbbq.ph') WHERE email LIKE '%@kalyefleet.ph';
    UPDATE app_settings SET value = 'Maximus Barbecue ERP' WHERE key = 'business_name' AND value = 'KalyeFleet Street Kitchen';
    INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES ('role_finance_manager', 'perm_hr_manage');
  `);

  const hasSuperRole = db.prepare("SELECT id FROM roles WHERE id = 'role_super_admin'").get();
  const hasSuperUser = db.prepare("SELECT id FROM users WHERE role_id = 'role_super_admin'").get();
  if (hasSuperRole && !hasSuperUser) {
    const demoHash = bcrypt.hashSync('erp2026!', 10);
    db.prepare('INSERT OR IGNORE INTO users (id, email, password_hash, full_name, role_id, assigned_location_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run('usr_superadmin', 'superadmin@maximusbbq.ph', demoHash, 'System Super Admin', 'role_super_admin', null);
  }
}

export function seedDatabase() {
  const existingUser = db.prepare('SELECT id FROM users LIMIT 1').get();
  if (existingUser) return;

  const tx = db.transaction(() => {
    // 1. Permissions
    const allPerms = Object.values(PERMISSIONS);
    const insPerm = db.prepare('INSERT INTO permissions (id, key, module, description) VALUES (?, ?, ?, ?)');
    allPerms.forEach((key) => {
      const mod = key.split(':')[0];
      insPerm.run(`perm_${key.replace(':', '_')}`, key, mod, `Permission to ${key.replace(':', ' ')}`);
    });

    // 2. Roles
    const roles: Array<{ code: string; name: string; perms: string[] }> = [
      { code: 'SUPER_ADMIN', name: 'Super Administrator', perms: allPerms },
      { code: 'BUSINESS_OWNER', name: 'Business Owner', perms: allPerms },
      {
        code: 'OPERATIONS_MANAGER',
        name: 'Operations Manager',
        perms: [
          PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.POS_SELL, PERMISSIONS.POS_REFUND,
          PERMISSIONS.KDS_MANAGE, PERMISSIONS.PRODUCT_MANAGE, PERMISSIONS.INVENTORY_VIEW,
          PERMISSIONS.INVENTORY_ADJUST, PERMISSIONS.PO_CREATE, PERMISSIONS.PO_APPROVE,
          PERMISSIONS.GRN_RECEIVE, PERMISSIONS.FLEET_MANAGE, PERMISSIONS.REPORTS_VIEW,
          PERMISSIONS.DAILY_CLOSE,
        ],
      },
      {
        code: 'FINANCE_MANAGER',
        name: 'Finance Manager',
        perms: [
          PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.FINANCE_VIEW, PERMISSIONS.JOURNAL_POST,
          PERMISSIONS.DAILY_CLOSE, PERMISSIONS.PO_APPROVE, PERMISSIONS.REPORTS_VIEW,
          PERMISSIONS.HR_MANAGE, PERMISSIONS.PAYROLL_RUN,
        ],
      },
      {
        code: 'INVENTORY_MANAGER',
        name: 'Inventory Manager',
        perms: [
          PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.INVENTORY_VIEW, PERMISSIONS.INVENTORY_ADJUST,
          PERMISSIONS.GRN_RECEIVE, PERMISSIONS.PO_CREATE, PERMISSIONS.PRODUCT_MANAGE,
          PERMISSIONS.REPORTS_VIEW,
        ],
      },
      {
        code: 'PURCHASING_OFFICER',
        name: 'Purchasing Officer',
        perms: [
          PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.INVENTORY_VIEW, PERMISSIONS.PO_CREATE,
          PERMISSIONS.GRN_RECEIVE, PERMISSIONS.REPORTS_VIEW,
        ],
      },
      {
        code: 'FOOD_TRUCK_MANAGER',
        name: 'Food Truck Manager',
        perms: [
          PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.POS_SELL, PERMISSIONS.POS_REFUND,
          PERMISSIONS.KDS_MANAGE, PERMISSIONS.INVENTORY_VIEW, PERMISSIONS.INVENTORY_ADJUST,
          PERMISSIONS.DAILY_CLOSE, PERMISSIONS.FLEET_MANAGE, PERMISSIONS.CRM_MANAGE,
        ],
      },
      {
        code: 'CASHIER',
        name: 'Cashier',
        perms: [PERMISSIONS.POS_SELL, PERMISSIONS.CRM_MANAGE],
      },
      {
        code: 'KITCHEN_STAFF',
        name: 'Kitchen Staff',
        perms: [PERMISSIONS.KDS_MANAGE, PERMISSIONS.INVENTORY_VIEW],
      },
      {
        code: 'HR_MANAGER',
        name: 'HR Manager',
        perms: [PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.HR_MANAGE, PERMISSIONS.PAYROLL_RUN, PERMISSIONS.REPORTS_VIEW],
      },
    ];

    const insRole = db.prepare('INSERT INTO roles (id, code, name, description) VALUES (?, ?, ?, ?)');
    const insRP = db.prepare('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)');
    roles.forEach((r) => {
      const roleId = `role_${r.code.toLowerCase()}`;
      insRole.run(roleId, r.code, r.name, `${r.name} role`);
      r.perms.forEach((pKey) => {
        insRP.run(roleId, `perm_${pKey.replace(':', '_')}`);
      });
    });

    // 3. Locations & Trucks
    const insLoc = db.prepare('INSERT INTO locations (id, code, name, type, address) VALUES (?, ?, ?, ?, ?)');
    insLoc.run('loc_commissary', 'COM-01', 'Central Commissary Kitchen', 'COMMISSARY', 'Pasig Food Hub, Metro Manila');
    insLoc.run('loc_truck_1', 'TRK-01', 'Truck 01 — BGC High Street', 'FOOD_TRUCK', '7th Ave & Bonifacio High St, Taguig');
    insLoc.run('loc_truck_2', 'TRK-02', 'Truck 02 — Ayala Triangle', 'FOOD_TRUCK', 'Makati Ave Night Market, Makati');

    const insTruck = db.prepare('INSERT INTO food_trucks (id, location_id, plate_number, make_model, status, current_site, odometer_km) VALUES (?, ?, ?, ?, ?, ?, ?)');
    insTruck.run('trk_1', 'loc_truck_1', 'NAA-4821', 'Isuzu NLR Custom Kitchen Van', 'ACTIVE', 'BGC High Street South', 42850);
    insTruck.run('trk_2', 'loc_truck_2', 'NCB-9104', 'Mitsubishi Canter Food Rig', 'ACTIVE', 'Ayala Triangle Gardens', 31420);

    db.prepare('INSERT INTO truck_assignments (id, truck_id, site_name, assigned_date, shift_notes) VALUES (?, ?, ?, ?, ?)')
      .run('ta_1', 'trk_1', 'BGC High Street South', new Date().toISOString().slice(0, 10), 'Lunch & Dinner Peak Service');
    db.prepare('INSERT INTO truck_assignments (id, truck_id, site_name, assigned_date, shift_notes) VALUES (?, ?, ?, ?, ?)')
      .run('ta_2', 'trk_2', 'Ayala Triangle Gardens', new Date().toISOString().slice(0, 10), 'Evening Street Market');

    // 4. Users (demo accounts with real bcrypt hashes)
    const demoHash = bcrypt.hashSync('erp2026!', 10);
    const insUser = db.prepare('INSERT INTO users (id, email, password_hash, full_name, role_id, assigned_location_id) VALUES (?, ?, ?, ?, ?, ?)');
    insUser.run('usr_superadmin', 'superadmin@maximusbbq.ph', demoHash, 'System Super Admin', 'role_super_admin', null);
    insUser.run('usr_owner', 'owner@maximusbbq.ph', demoHash, 'Marco Santos (Owner)', 'role_business_owner', null);
    insUser.run('usr_ops', 'ops@maximusbbq.ph', demoHash, 'Elena Reyes (Operations)', 'role_operations_manager', null);
    insUser.run('usr_fin', 'finance@maximusbbq.ph', demoHash, 'Paolo Cruz (Finance)', 'role_finance_manager', null);
    insUser.run('usr_cashier', 'cashier@maximusbbq.ph', demoHash, 'Bea Mendoza (Cashier)', 'role_cashier', 'loc_truck_1');
    insUser.run('usr_kitchen', 'kitchen@maximusbbq.ph', demoHash, 'Carlo Villanueva (Kitchen)', 'role_kitchen_staff', 'loc_truck_1');

    // 5. UOMs & Conversions
    const insUom = db.prepare('INSERT INTO uoms (id, code, name) VALUES (?, ?, ?)');
    insUom.run('uom_g', 'g', 'Grams');
    insUom.run('uom_kg', 'kg', 'Kilograms');
    insUom.run('uom_ml', 'ml', 'Milliliters');
    insUom.run('uom_l', 'L', 'Liters');
    insUom.run('uom_pcs', 'pcs', 'Pieces');

    const insConv = db.prepare('INSERT INTO unit_conversions (id, from_uom_id, to_uom_id, factor) VALUES (?, ?, ?, ?)');
    insConv.run('conv_kg_g', 'uom_kg', 'uom_g', 1000);
    insConv.run('conv_l_ml', 'uom_l', 'uom_ml', 1000);

    // 6. Inventory Items & Stock Batches (FIFO)
    const insItem = db.prepare(`
      INSERT INTO inventory_items (id, sku, name, item_type, base_uom_id, costing_method, min_stock_level, reorder_point, last_unit_cost, weighted_avg_cost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insItem.run('ing_pork', 'ING-PORK', 'Crispy Pork Maskara & Belly', 'RAW_MATERIAL', 'uom_g', 'FIFO', 5000, 8000, 0.34, 0.33);
    insItem.run('ing_beef', 'ING-BEEF', 'Wagyu-Blend Ground Beef', 'RAW_MATERIAL', 'uom_g', 'FIFO', 4000, 6000, 0.58, 0.56);
    insItem.run('ing_tortilla', 'ING-TORT', 'Artisan Corn Tortillas', 'RAW_MATERIAL', 'uom_pcs', 'FIFO', 100, 150, 8.5, 8.5);
    insItem.run('ing_bun', 'ING-BUN', 'Toasted Brioche Buns', 'RAW_MATERIAL', 'uom_pcs', 'FIFO', 80, 120, 14.0, 14.0);
    insItem.run('ing_cheddar', 'ING-CHED', 'Aged Cheddar Slices', 'RAW_MATERIAL', 'uom_pcs', 'WEIGHTED_AVERAGE', 100, 140, 11.0, 10.8);
    insItem.run('ing_potato', 'ING-POT', 'Russet Shoestring Potatoes', 'RAW_MATERIAL', 'uom_g', 'FIFO', 6000, 9000, 0.14, 0.14);
    insItem.run('ing_mango', 'ING-MANG', 'Guimaras Ripe Mango Puree', 'RAW_MATERIAL', 'uom_ml', 'FIFO', 4000, 6000, 0.16, 0.16);
    insItem.run('ing_truffle', 'ING-TRUF', 'Black Truffle Garlic Aioli', 'RAW_MATERIAL', 'uom_ml', 'FIFO', 1500, 2500, 0.42, 0.42);

    const insBatch = db.prepare(`
      INSERT INTO stock_batches (id, inventory_item_id, location_id, batch_number, initial_qty, remaining_qty, unit_cost, expiry_date, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const daysFromNow = (d: number) => new Date(Date.now() + d * 86400000).toISOString();

    // Truck 1 active batches (including one expiring soon & one low-stock item to show real alerts!)
    insBatch.run('bat_1', 'ing_pork', 'loc_truck_1', 'LOT-PRK-101', 12000, 9500, 0.32, daysFromNow(5), daysFromNow(-4));
    insBatch.run('bat_2', 'ing_pork', 'loc_truck_1', 'LOT-PRK-102', 8000, 8000, 0.34, daysFromNow(8), daysFromNow(-1));
    insBatch.run('bat_3', 'ing_beef', 'loc_truck_1', 'LOT-BEF-201', 10000, 7400, 0.58, daysFromNow(2), daysFromNow(-3)); // Expiring in 2 days!
    insBatch.run('bat_4', 'ing_tortilla', 'loc_truck_1', 'LOT-TRT-301', 300, 210, 8.5, daysFromNow(14), daysFromNow(-2));
    insBatch.run('bat_5', 'ing_bun', 'loc_truck_1', 'LOT-BUN-401', 150, 95, 14.0, daysFromNow(3), daysFromNow(-2)); // Below reorder 120!
    insBatch.run('bat_6', 'ing_cheddar', 'loc_truck_1', 'LOT-CHD-501', 250, 180, 10.8, daysFromNow(25), daysFromNow(-5));
    insBatch.run('bat_7', 'ing_potato', 'loc_truck_1', 'LOT-POT-601', 15000, 11500, 0.14, daysFromNow(30), daysFromNow(-4));
    insBatch.run('bat_8', 'ing_mango', 'loc_truck_1', 'LOT-MNG-701', 9000, 6200, 0.16, daysFromNow(6), daysFromNow(-2));
    insBatch.run('bat_9', 'ing_truffle', 'loc_truck_1', 'LOT-TRF-801', 3000, 1800, 0.42, daysFromNow(20), daysFromNow(-6)); // Below reorder 2500!

    // Truck 2 & Commissary reserve batches
    insBatch.run('bat_10', 'ing_pork', 'loc_truck_2', 'LOT-PRK-202', 10000, 8200, 0.34, daysFromNow(7), daysFromNow(-1));
    insBatch.run('bat_11', 'ing_beef', 'loc_truck_2', 'LOT-BEF-202', 9000, 6800, 0.58, daysFromNow(6), daysFromNow(-1));
    insBatch.run('bat_12', 'ing_tortilla', 'loc_truck_2', 'LOT-TRT-202', 240, 180, 8.5, daysFromNow(15), daysFromNow(-1));
    insBatch.run('bat_13', 'ing_bun', 'loc_truck_2', 'LOT-BUN-202', 180, 140, 14.0, daysFromNow(4), daysFromNow(-1));
    insBatch.run('bat_14', 'ing_cheddar', 'loc_truck_2', 'LOT-CHD-202', 200, 160, 10.8, daysFromNow(25), daysFromNow(-1));
    insBatch.run('bat_15', 'ing_potato', 'loc_truck_2', 'LOT-POT-202', 12000, 9600, 0.14, daysFromNow(30), daysFromNow(-1));
    insBatch.run('bat_16', 'ing_mango', 'loc_truck_2', 'LOT-MNG-202', 8000, 6400, 0.16, daysFromNow(7), daysFromNow(-1));
    insBatch.run('bat_17', 'ing_truffle', 'loc_truck_2', 'LOT-TRF-202', 3000, 2600, 0.42, daysFromNow(20), daysFromNow(-1));

    insBatch.run('bat_18', 'ing_pork', 'loc_commissary', 'LOT-COM-01', 25000, 25000, 0.32, daysFromNow(10), daysFromNow(-2));
    insBatch.run('bat_19', 'ing_beef', 'loc_commissary', 'LOT-COM-02', 20000, 20000, 0.55, daysFromNow(9), daysFromNow(-2));
    insBatch.run('bat_20', 'ing_bun', 'loc_commissary', 'LOT-COM-03', 400, 400, 13.5, daysFromNow(6), daysFromNow(-1));

    // 7. Tax Config & Categories
    db.prepare('INSERT INTO tax_configs (id, code, name, rate_percent, is_inclusive, is_active) VALUES (?, ?, ?, ?, ?, ?)')
      .run('tax_ph_vat', 'PH_VAT_12', 'Philippine VAT (12% Inclusive)', 12.0, 1, 1);
    db.prepare('INSERT INTO tax_configs (id, code, name, rate_percent, is_inclusive, is_active) VALUES (?, ?, ?, ?, ?, ?)')
      .run('tax_ph_pct', 'PH_NONVAT_3', 'Philippine Percentage Tax (3%)', 3.0, 1, 0);

    const insCat = db.prepare('INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)');
    insCat.run('cat_tacos', 'Street Tacos', 1);
    insCat.run('cat_burgers', 'Smash Burgers', 2);
    insCat.run('cat_sides', 'Loaded Sides', 3);
    insCat.run('cat_drinks', 'Coolers & Shakes', 4);

    // 8. Products, Variants, Modifiers & BOM Recipes
    const insProd = db.prepare(`
      INSERT INTO products (id, sku, name, description, image_url, category_id, base_price, packaging_cost, direct_labor_cost, target_food_cost_pct, tax_config_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insProd.run('prd_sisig', 'MNU-01', 'Crispy Pork Sisig Tacos (3 pcs)', 'Charred corn tortillas with crispy pork sisig, calamansi & chili crema', '/src/assets/images/dish_sisig_taco_1795140886147.jpg', 'cat_tacos', 215, 12, 18, 34, 'tax_ph_vat');
    insProd.run('prd_burger', 'MNU-02', 'Double Wagyu Smash Burger', 'Double seared beef patties, aged cheddar, caramelized onions on brioche', '/src/assets/images/dish_wagyu_burger_1795140888993.jpg', 'cat_burgers', 285, 14, 22, 36, 'tax_ph_vat');
    insProd.run('prd_fries', 'MNU-03', 'Truffle Parmesan Fries', 'Hand-cut Russet fries tossed in parmesan with garlic truffle aioli', '/src/assets/images/dish_truffle_fries_1795140887488.jpg', 'cat_sides', 155, 10, 12, 30, 'tax_ph_vat');
    insProd.run('prd_mango', 'MNU-04', 'Guimaras Mango Graham Shake', 'Layered ripe mango puree, crushed graham & whipped cream', '/src/assets/images/dish_mango_shake_1795140887833.jpg', 'cat_drinks', 145, 11, 10, 32, 'tax_ph_vat');

    const insVar = db.prepare('INSERT INTO product_variants (id, product_id, name, price_delta, portion_multiplier) VALUES (?, ?, ?, ?, ?)');
    insVar.run('var_sisig_3', 'prd_sisig', 'Solo (3 pcs)', 0, 1.0);
    insVar.run('var_sisig_5', 'prd_sisig', 'Barkada (5 pcs)', 125, 1.66);
    insVar.run('var_brg_dbl', 'prd_burger', 'Double Patty', 0, 1.0);
    insVar.run('var_brg_trp', 'prd_burger', 'Triple Smash', 95, 1.5);
    insVar.run('var_frs_reg', 'prd_fries', 'Regular Boat', 0, 1.0);
    insVar.run('var_frs_shr', 'prd_fries', 'Sharing Tray', 85, 1.75);
    insVar.run('var_mng_16', 'prd_mango', '16oz Cup', 0, 1.0);
    insVar.run('var_mng_22', 'prd_mango', '22oz Tall', 40, 1.35);

    const insMod = db.prepare('INSERT INTO modifier_options (id, product_id, group_name, name, price_delta, inventory_item_id, deduct_qty, uom_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insMod.run('mod_extra_cheese', 'prd_burger', 'Add-ons', 'Extra Aged Cheddar', 30, 'ing_cheddar', 1, 'uom_pcs');
    insMod.run('mod_extra_aioli', 'prd_fries', 'Dip Upgrade', 'Extra Truffle Aioli Cup', 35, 'ing_truffle', 30, 'uom_ml');
    insMod.run('mod_extra_pork', 'prd_sisig', 'Protein Boost', 'Extra Crispy Sisig', 55, 'ing_pork', 60, 'uom_g');

    const insRec = db.prepare('INSERT INTO recipes (id, product_id, yield_qty, prep_instructions) VALUES (?, ?, ?, ?)');
    insRec.run('rec_sisig', 'prd_sisig', 1, 'Crisp pork on flat-top 4 min, assemble on charred tortillas');
    insRec.run('rec_burger', 'prd_burger', 1, 'Smash two 90g patties at 220C, melt 2 slices cheddar');
    insRec.run('rec_fries', 'prd_fries', 1, 'Double-fry Russet potatoes, serve with 45ml truffle aioli');
    insRec.run('rec_mango', 'prd_mango', 1, 'Blend 220ml mango puree with ice, layer graham');

    const insRecIng = db.prepare('INSERT INTO recipe_ingredients (id, recipe_id, inventory_item_id, quantity, uom_id, waste_factor_pct) VALUES (?, ?, ?, ?, ?, ?)');
    insRecIng.run('ri_1', 'rec_sisig', 'ing_pork', 160, 'uom_g', 5);
    insRecIng.run('ri_2', 'rec_sisig', 'ing_tortilla', 3, 'uom_pcs', 2);
    insRecIng.run('ri_3', 'rec_burger', 'ing_beef', 180, 'uom_g', 4);
    insRecIng.run('ri_4', 'rec_burger', 'ing_bun', 1, 'uom_pcs', 1);
    insRecIng.run('ri_5', 'rec_burger', 'ing_cheddar', 2, 'uom_pcs', 0);
    insRecIng.run('ri_6', 'rec_fries', 'ing_potato', 220, 'uom_g', 6);
    insRecIng.run('ri_7', 'rec_fries', 'ing_truffle', 45, 'uom_ml', 3);
    insRecIng.run('ri_8', 'rec_mango', 'ing_mango', 220, 'uom_ml', 4);

    // 9. Chart of Accounts
    const insAcc = db.prepare('INSERT INTO accounts (id, code, name, type, is_system) VALUES (?, ?, ?, ?, ?)');
    insAcc.run('acc_1000', '1000', 'Cash on Hand & Register', 'ASSET', 1);
    insAcc.run('acc_1010', '1010', 'BPI Operating Bank & E-Wallet Clearing', 'ASSET', 1);
    insAcc.run('acc_1200', '1200', 'Food & Packaging Inventory', 'ASSET', 1);
    insAcc.run('acc_2000', '2000', 'Accounts Payable', 'LIABILITY', 1);
    insAcc.run('acc_2050', '2050', 'Accrued Purchases (GRNI)', 'LIABILITY', 1);
    insAcc.run('acc_2100', '2100', 'Output VAT Payable', 'LIABILITY', 1);
    insAcc.run('acc_3000', '3000', 'Owner Equity', 'EQUITY', 1);
    insAcc.run('acc_4000', '4000', 'Food & Beverage Sales Revenue', 'REVENUE', 1);
    insAcc.run('acc_5000', '5000', 'Cost of Goods Sold (COGS)', 'EXPENSE', 1);
    insAcc.run('acc_6100', '6100', 'Fuel & LPG Expense', 'EXPENSE', 0);
    insAcc.run('acc_6200', '6200', 'Truck Rent, Parking & Permits', 'EXPENSE', 0);
    insAcc.run('acc_6300', '6300', 'Salaries & Wages Expense', 'EXPENSE', 0);
    insAcc.run('acc_6400', '6400', 'Vehicle Maintenance & Repairs', 'EXPENSE', 0);

    // 10. Petty Cash & Financial Period
    db.prepare('INSERT INTO petty_cash_funds (id, location_id, fund_name, float_amount, current_balance) VALUES (?, ?, ?, ?, ?)')
      .run('pc_1', 'loc_truck_1', 'Truck 01 Petty Cash', 5000, 4250);
    db.prepare('INSERT INTO petty_cash_funds (id, location_id, fund_name, float_amount, current_balance) VALUES (?, ?, ?, ?, ?)')
      .run('pc_2', 'loc_truck_2', 'Truck 02 Petty Cash', 5000, 4600);

    db.prepare('INSERT INTO financial_periods (id, name, period_start, period_end, status) VALUES (?, ?, ?, ?, ?)')
      .run('fp_2026_11', '2026-11', '2026-11-01', '2026-11-30', 'OPEN');

    // 11. Suppliers & Purchase Orders
    const insSup = db.prepare('INSERT INTO suppliers (id, code, name, contact_person, phone, email, address, tin, payment_terms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    insSup.run('sup_1', 'SUP-MET', 'Metro Meat & Poultry Trading', 'Ramon Tan', '+63 917 555 1021', 'orders@metromeat.ph', 'Marikina Cold Storage Hub', '008-412-901-000', 15);
    insSup.run('sup_2', 'SUP-BAK', 'Artisan Bakehouse Manila', 'Grace Lim', '+63 918 442 8890', 'supply@artisanbake.ph', 'Mandaluyong City', '009-221-445-000', 7);
    insSup.run('sup_3', 'SUP-FRU', 'Visayas Highland Produce Corp', 'Lito Dizon', '+63 922 778 3312', 'fresh@visayasproduce.ph', 'Divisoria Cold Hub', '007-889-123-000', 0);

    const insSupItem = db.prepare('INSERT INTO supplier_items (id, supplier_id, inventory_item_id, unit_price, lead_time_days) VALUES (?, ?, ?, ?, ?)');
    insSupItem.run('si_1', 'sup_1', 'ing_pork', 0.34, 1);
    insSupItem.run('si_2', 'sup_1', 'ing_beef', 0.58, 1);
    insSupItem.run('si_3', 'sup_3', 'ing_pork', 0.36, 2);
    insSupItem.run('si_4', 'sup_2', 'ing_bun', 14.0, 1);
    insSupItem.run('si_5', 'sup_2', 'ing_tortilla', 8.5, 1);
    insSupItem.run('si_6', 'sup_3', 'ing_potato', 0.14, 1);
    insSupItem.run('si_7', 'sup_3', 'ing_mango', 0.16, 2);

    // Pending PO awaiting approval & Approved PO ready to receive
    db.prepare('INSERT INTO purchase_orders (id, po_number, supplier_id, location_id, status, total_amount, ordered_at, expected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('po_1', 'PO-2026-089', 'sup_2', 'loc_truck_1', 'PENDING_APPROVAL', 4200, daysFromNow(-1), daysFromNow(1));
    db.prepare('INSERT INTO purchase_order_items (id, purchase_order_id, inventory_item_id, ordered_qty, received_qty, unit_cost) VALUES (?, ?, ?, ?, ?, ?)')
      .run('poi_1', 'po_1', 'ing_bun', 300, 0, 14.0);

    db.prepare('INSERT INTO purchase_orders (id, po_number, supplier_id, location_id, status, total_amount, approved_by, ordered_at, expected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('po_2', 'PO-2026-090', 'sup_1', 'loc_commissary', 'APPROVED', 12400, 'usr_ops', daysFromNow(-1), daysFromNow(1));
    db.prepare('INSERT INTO purchase_order_items (id, purchase_order_id, inventory_item_id, ordered_qty, received_qty, unit_cost) VALUES (?, ?, ?, ?, ?, ?)')
      .run('poi_2', 'po_2', 'ing_pork', 20000, 0, 0.34);
    db.prepare('INSERT INTO purchase_order_items (id, purchase_order_id, inventory_item_id, ordered_qty, received_qty, unit_cost) VALUES (?, ?, ?, ?, ?, ?)')
      .run('poi_3', 'po_2', 'ing_beef', 10000, 0, 0.56);

    db.prepare('INSERT INTO supplier_invoices (id, invoice_number, supplier_id, purchase_order_id, total_amount, paid_amount, due_date, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('sinv_1', 'SI-MET-9941', 'sup_1', null, 18500, 10000, daysFromNow(5), 'PARTIAL');

    // 12. Customers
    const insCust = db.prepare('INSERT INTO customers (id, full_name, phone, email, loyalty_points, tier, preferences) VALUES (?, ?, ?, ?, ?, ?, ?)');
    insCust.run('cus_1', 'Andrea Bautista', '09171234567', 'andrea.b@gmail.com', 420, 'GOLD', 'Extra calamansi on sisig tacos');
    insCust.run('cus_2', 'Rafael Navarro', '09189876543', 'rafael.n@outlook.com', 185, 'SILVER', 'No onions on smash burger');
    insCust.run('cus_3', 'Katrina Sy', '09178882211', 'katrina.sy@company.ph', 610, 'PLATINUM', 'Corporate catering organizer (BGC)');

    // 13. Employees & PH Statutory Rules
    const insEmp = db.prepare('INSERT INTO employees (id, employee_code, full_name, department, position, location_id, pay_type, base_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insEmp.run('emp_1', 'EMP-001', 'Bea Mendoza', 'Front of House', 'Lead Cashier', 'loc_truck_1', 'DAILY', 720);
    insEmp.run('emp_2', 'EMP-002', 'Carlo Villanueva', 'Culinary', 'Line Cook', 'loc_truck_1', 'DAILY', 760);
    insEmp.run('emp_3', 'EMP-003', 'Jericho Palma', 'Fleet & Ops', 'Truck Driver / Cook', 'loc_truck_2', 'DAILY', 800);
    insEmp.run('emp_4', 'EMP-004', 'Dianne Mercado', 'Front of House', 'Cashier', 'loc_truck_2', 'DAILY', 690);

    const insAtt = db.prepare('INSERT INTO attendance_logs (id, employee_id, clock_in, clock_out, overtime_hours, status) VALUES (?, ?, ?, ?, ?, ?)');
    const todayStr = new Date().toISOString().slice(0, 10);
    insAtt.run('att_1', 'emp_1', `${todayStr}T09:00:00`, null, 0, 'PRESENT');
    insAtt.run('att_2', 'emp_2', `${todayStr}T08:45:00`, null, 1.5, 'PRESENT');
    insAtt.run('att_3', 'emp_3', `${todayStr}T09:15:00`, null, 0, 'LATE');

    db.prepare('INSERT INTO payroll_rules (id, code, name, rule_json, is_active) VALUES (?, ?, ?, ?, ?)')
      .run(
        'pr_ph_2026',
        'PH_STATUTORY_2026',
        'Configurable Philippine Statutory Contributions',
        JSON.stringify({
          sssEmployeeRatePct: 4.5,
          philhealthEmployeeRatePct: 2.5,
          pagibigFixedEmployeePhp: 200,
          overtimeMultiplier: 1.25,
          taxExemptMonthlyCeilingPhp: 20833,
          withholdingRateAboveCeilingPct: 15,
        }),
        1,
      );

    // 14. Seed 7 days of historical completed Sales, SaleItems, Payments, Expenses & Journal Entries
    const insSale = db.prepare(`
      INSERT INTO sales (id, receipt_number, client_txn_id, location_id, cashier_id, customer_id, channel, status, kds_status, subtotal, discount_amount, tax_amount, total_amount, total_cogs, sold_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?)
    `);
    const insSaleItem = db.prepare(`
      INSERT INTO sale_items (id, sale_id, product_id, variant_id, product_name, variant_name, quantity, unit_price, line_total, cogs_amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insPay = db.prepare('INSERT INTO payments (id, sale_id, method, amount, paid_at) VALUES (?, ?, ?, ?, ?)');
    const insJE = db.prepare('INSERT INTO journal_entries (id, entry_number, entry_date, description, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?)');
    const insJL = db.prepare('INSERT INTO journal_lines (id, journal_entry_id, account_id, debit, credit, memo) VALUES (?, ?, ?, ?, ?, ?)');

    const sampleOrders = [
      { dayOffset: -6, loc: 'loc_truck_1', prod: 'prd_sisig', name: 'Crispy Pork Sisig Tacos (3 pcs)', qty: 6, price: 215, cogs: 82, method: 'CASH', kds: 'COMPLETED', cust: 'cus_1' },
      { dayOffset: -5, loc: 'loc_truck_2', prod: 'prd_burger', name: 'Double Wagyu Smash Burger', qty: 8, price: 285, cogs: 140, method: 'E_WALLET', kds: 'COMPLETED', cust: 'cus_2' },
      { dayOffset: -4, loc: 'loc_truck_1', prod: 'prd_fries', name: 'Truffle Parmesan Fries', qty: 10, price: 155, cogs: 52, method: 'CARD', kds: 'COMPLETED', cust: null },
      { dayOffset: -3, loc: 'loc_truck_1', prod: 'prd_burger', name: 'Double Wagyu Smash Burger', qty: 9, price: 285, cogs: 140, method: 'E_WALLET', kds: 'COMPLETED', cust: 'cus_3' },
      { dayOffset: -2, loc: 'loc_truck_2', prod: 'prd_sisig', name: 'Crispy Pork Sisig Tacos (3 pcs)', qty: 11, price: 215, cogs: 82, method: 'CASH', kds: 'COMPLETED', cust: null },
      { dayOffset: -1, loc: 'loc_truck_1', prod: 'prd_mango', name: 'Guimaras Mango Graham Shake', qty: 14, price: 145, cogs: 37, method: 'E_WALLET', kds: 'COMPLETED', cust: 'cus_1' },
      { dayOffset: 0, loc: 'loc_truck_1', prod: 'prd_sisig', name: 'Crispy Pork Sisig Tacos (3 pcs)', qty: 4, price: 215, cogs: 82, method: 'CASH', kds: 'PREPARING', cust: 'cus_1' },
      { dayOffset: 0, loc: 'loc_truck_1', prod: 'prd_burger', name: 'Double Wagyu Smash Burger', qty: 3, price: 285, cogs: 140, method: 'E_WALLET', kds: 'PENDING', cust: 'cus_2' },
      { dayOffset: 0, loc: 'loc_truck_2', prod: 'prd_fries', name: 'Truffle Parmesan Fries', qty: 5, price: 155, cogs: 52, method: 'CARD', kds: 'READY', cust: null },
    ];

    sampleOrders.forEach((o, i) => {
      const sid = `sale_seed_${i + 1}`;
      const gross = o.qty * o.price;
      const tax = Number((gross - gross / 1.12).toFixed(2));
      const sub = Number((gross - tax).toFixed(2));
      const cogs = Number((o.qty * o.cogs).toFixed(2));
      const soldAt = daysFromNow(o.dayOffset);
      const rcpt = `OR-2026${String(101 + i)}`;

      insSale.run(sid, rcpt, `seed_txn_${i + 1}`, o.loc, 'usr_cashier', o.cust, 'WALK_IN', o.kds, sub, 0, tax, gross, cogs, soldAt);
      insSaleItem.run(`si_seed_${i + 1}`, sid, o.prod, null, o.name, 'Standard', o.qty, o.price, gross, cogs);
      insPay.run(`pay_seed_${i + 1}`, sid, o.method, gross, soldAt);

      const jeId = `je_seed_${i + 1}`;
      insJE.run(jeId, `JE-POS-${rcpt}`, soldAt, `POS Sale ${rcpt}`, 'SALE', sid);
      insJL.run(`jl_${i}_1`, jeId, o.method === 'CASH' ? 'acc_1000' : 'acc_1010', gross, 0, `${o.method} receipt`);
      insJL.run(`jl_${i}_2`, jeId, 'acc_4000', 0, sub, 'Food Sales Revenue');
      insJL.run(`jl_${i}_3`, jeId, 'acc_2100', 0, tax, 'Output VAT 12%');
      insJL.run(`jl_${i}_4`, jeId, 'acc_5000', cogs, 0, 'Cost of Goods Sold');
      insJL.run(`jl_${i}_5`, jeId, 'acc_1200', 0, cogs, 'Inventory Asset Reduction');
    });

    // Historical Expenses
    const insExp = db.prepare('INSERT INTO expenses (id, location_id, account_id, category, amount, description, expense_date) VALUES (?, ?, ?, ?, ?, ?, ?)');
    insExp.run('exp_1', 'loc_truck_1', 'acc_6100', 'FUEL', 2450, 'Diesel Refill — Petron BGC', daysFromNow(-2));
    insExp.run('exp_2', 'loc_truck_1', 'acc_6100', 'LPG', 1150, '2x 11kg Solane LPG Tank', daysFromNow(-1));
    insExp.run('exp_3', 'loc_truck_2', 'acc_6200', 'RENT_PARKING', 3500, 'Ayala Night Market Slot Fee', daysFromNow(-1));
    insExp.run('exp_4', 'loc_truck_2', 'acc_6400', 'MAINTENANCE', 1800, 'Generator Oil & Filter Service', daysFromNow(-3));

    db.prepare('INSERT INTO fuel_logs (id, truck_id, liters, total_cost, odometer_km, fueled_at, expense_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('fuel_1', 'trk_1', 42.5, 2450, 42850, daysFromNow(-2), 'exp_1');
    db.prepare('INSERT INTO maintenance_logs (id, truck_id, title, description, cost, service_date, next_due_date) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('mnt_1', 'trk_2', 'Generator Oil & Filter Service', 'Scheduled 500-hr generator preventive maintenance', 1800, daysFromNow(-3).slice(0, 10), daysFromNow(27).slice(0, 10));

    // Seed initial notifications
    const insNotif = db.prepare('INSERT INTO notifications (id, type, severity, title, message) VALUES (?, ?, ?, ?, ?)');
    insNotif.run('ntf_1', 'LOW_STOCK', 'WARNING', 'Low Stock: Toasted Brioche Buns', 'Truck 01 has 95 pcs remaining (below reorder point of 120 pcs).');
    insNotif.run('ntf_2', 'EXPIRY', 'CRITICAL', 'Expiring Batch: Wagyu-Blend Ground Beef', 'LOT-BEF-201 (7,400g) on Truck 01 expires within 48 hours.');
    insNotif.run('ntf_3', 'PO_PENDING', 'INFO', 'Purchase Order Awaiting Approval', 'PO-2026-089 (Artisan Bakehouse Manila · ₱4,200.00) needs manager approval.');

    // App settings
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('currency', 'PHP');
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('business_name', 'Maximus Barbecue ERP');
  });

  tx();
}
