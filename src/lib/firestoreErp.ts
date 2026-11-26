import { User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { auth, db, handleFirestoreError, OperationType } from './firebase.ts';
import { isTerminalModeDevice } from './terminalAuth.ts';
import { AuthUser, PERMISSIONS, RoleCode } from '../types/erp.ts';
import { findScheduleCandidateConflicts, formatOverlapDuration, ShiftWindowLike } from './shiftConflicts.ts';
import { buildThresholdNotification, evaluateIngredientThreshold } from './inventoryAlerts.ts';
import { buildWeeklyFoodCostSeries } from './financeCharts.ts';
import { buildPredictiveProcurementPlan, SupplierQuoteOption } from './predictiveProcurement.ts';
import {
  ALL_HUDDLE_CHANNELS,
  canBroadcastDailyHuddle,
  DailyHuddleItem,
  HuddleChannel,
  HuddlePriority,
  HuddleShiftWindow,
  sortDailyHuddles,
} from './dailyHuddle.ts';
import {
  getMaintenanceAlertInfo,
  getTodayDateIso,
  MaintenanceCategory,
  MaintenanceStatus,
  summarizeTruckMaintenance,
} from './fleetMaintenance.ts';
import { analyzeMenuEngineering } from './menuEngineering.ts';
import {
  getWasteReasonLabel,
  RecipeWasteOption,
  summarizeWasteLogs,
  WasteEntryMode,
  WasteLogRecord,
  WasteReasonCategory,
} from './wasteManagement.ts';
import {
  calculateLoyaltyTier,
  formatPhoneNumber,
  normalizePhoneNumber,
  SPEND_PER_POINT_PHP,
  WELCOME_POINTS_BONUS,
} from './loyaltyKiosk.ts';

const ACTIVE_USER_SESSION_KEY = 'maximus_bbq_active_erp_user_id';
const SIGNED_OUT_SESSION_KEY = 'maximus_bbq_erp_signed_out';
const BOOTSTRAP_ADMIN_EMAIL = 'norielescobio@gmail.com';
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 5 * 60 * 1000;

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const round4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000;

function prefixOf(uid: string): string {
  return uid.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 10);
}

function toDocId(logicalId: string, uid: string): string {
  const p = `${prefixOf(uid)}_`;
  return logicalId.startsWith(p) ? logicalId : `${p}${logicalId}`;
}

function toLogicalId(docId: string, uid: string): string {
  const p = `${prefixOf(uid)}_`;
  return docId.startsWith(p) ? docId.slice(p.length) : docId;
}

function tsToIso(val: unknown): string {
  if (!val) return new Date().toISOString();
  if (typeof val === 'string') return val;
  if (val instanceof Timestamp) return val.toDate().toISOString();
  if (typeof (val as any)?.toDate === 'function') return (val as any).toDate().toISOString();
  return new Date().toISOString();
}

async function hashPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(`maximus_erp:${password}`);
  const buf = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!storedHash) return false;
  if (storedHash.startsWith('sha256:')) {
    const candidate = await hashPassword(password);
    return candidate === storedHash;
  }
  return password === storedHash;
}

async function hashShiftPin(userDocId: string, pin: string): Promise<string> {
  const cleanPin = String(pin || '').trim();
  if (!/^\d{4,6}$/.test(cleanPin)) {
    throw new Error('Shift PIN must be 4 to 6 numeric digits');
  }
  const data = new TextEncoder().encode(`maximus_erp_pin:${userDocId}:${cleanPin}`);
  const buf = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `pin256:${hex}`;
}

async function verifyShiftPin(userDocId: string, pin: string, storedHash: string): Promise<boolean> {
  if (!storedHash || !/^\d{4,6}$/.test(String(pin || '').trim())) return false;
  const candidate = await hashShiftPin(userDocId, String(pin).trim());
  return candidate === storedHash;
}

function getLockRemainingMs(erpUser: any): number {
  if (!erpUser?.lockedUntil) return 0;
  const untilMs = new Date(erpUser.lockedUntil).getTime();
  if (!Number.isFinite(untilMs)) return 0;
  return Math.max(0, untilMs - Date.now());
}

function formatLockDuration(ms: number): string {
  const secs = Math.max(1, Math.ceil(ms / 1000));
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  if (mins > 0) return `${mins}m ${rem}s`;
  return `${rem}s`;
}

function formatDetailsText(details?: Record<string, unknown> | string | null): string | null {
  if (!details) return null;
  if (typeof details === 'string') return details.slice(0, 990);
  const parts = Object.entries(details)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? String(v) : String(v)}`);
  return parts.length ? parts.join(' | ').slice(0, 990) : null;
}

// =====================================================
// SNAPSHOT LOADER (WORKSPACE SCOPED BY ownerUid)
// =====================================================
export const DEFAULT_EXPENSE_CATEGORIES = [
  { id: 'cat_fuel', code: 'FUEL', name: 'Fuel (Diesel / Gasoline)', description: 'Food truck and generator fuel', sortOrder: 1, isActive: true },
  { id: 'cat_lpg', code: 'LPG', name: 'LPG Tank Refills', description: 'Cooking and grill gas', sortOrder: 2, isActive: true },
  { id: 'cat_electricity', code: 'ELECTRICITY', name: 'Electricity & Water', description: 'Site plug-in and utilities', sortOrder: 3, isActive: true },
  { id: 'cat_packaging', code: 'PACKAGING', name: 'Packaging & Disposables', description: 'Boxes, cups, napkins, paper wraps', sortOrder: 4, isActive: true },
  { id: 'cat_maintenance', code: 'MAINTENANCE', name: 'Vehicle & Equipment Repairs', description: 'Preventive truck and generator repairs', sortOrder: 5, isActive: true },
  { id: 'cat_permits', code: 'PERMITS', name: 'Permits & City Licenses', description: 'Barangay, mayor, sanitary permits', sortOrder: 6, isActive: true },
  { id: 'cat_rent', code: 'RENT_PARKING', name: 'Truck Slot Rent & Parking', description: 'Night market and site fees', sortOrder: 7, isActive: true },
  { id: 'cat_marketing', code: 'MARKETING', name: 'Marketing & Local Ads', description: 'Promotions and social campaigns', sortOrder: 8, isActive: true },
  { id: 'cat_misc', code: 'MISC', name: 'Miscellaneous Operating', description: 'Ice, small tools, and cleaning consumables', sortOrder: 9, isActive: true },
];

export const DEFAULT_SHIFT_TEMPLATES = [
  {
    id: 'tpl_opening',
    code: 'OPEN',
    name: 'Opening Shift',
    startTime: '07:00',
    endTime: '15:00',
    breakMinutes: 60,
    daysOfWeek: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'],
    locationIds: ['loc_truck_1', 'loc_truck_2', 'loc_commissary'],
    defaultRole: 'Lead Cashier / Prep Cook',
    headcountNeeded: 2,
    notes: 'Truck power-up, grill pre-heat, morning commissary stock check, and POS float count.',
    isActive: true,
  },
  {
    id: 'tpl_midday',
    code: 'MID',
    name: 'Mid-Day Shift',
    startTime: '11:00',
    endTime: '19:00',
    breakMinutes: 60,
    daysOfWeek: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'],
    locationIds: ['loc_truck_1', 'loc_truck_2'],
    defaultRole: 'Line Cook / Service Crew',
    headcountNeeded: 2,
    notes: 'Peak lunch & early dinner service coverage across active food truck sites.',
    isActive: true,
  },
  {
    id: 'tpl_closing',
    code: 'CLOSE',
    name: 'Closing Shift',
    startTime: '15:00',
    endTime: '23:00',
    breakMinutes: 60,
    daysOfWeek: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'],
    locationIds: ['loc_truck_1', 'loc_truck_2'],
    defaultRole: 'Griller / Closer',
    headcountNeeded: 2,
    notes: 'Dinner rush, grill sanitization, cold-chain batch sealing, and daily Z-reading sign-off.',
    isActive: true,
  },
];

interface WorkspaceSnapshot {
  uid: string;
  meta: any;
  erpUsers: any[];
  employees: any[];
  categories: any[];
  products: any[];
  inventoryItems: any[];
  stockBatches: any[];
  inventoryTxns: any[];
  stockTransfers: any[];
  sales: any[];
  suppliers: any[];
  purchaseOrders: any[];
  goodsReceipts: any[];
  supplierInvoices: any[];
  accounts: any[];
  journalEntries: any[];
  expenses: any[];
  expenseCategories: any[];
  dailyClosings: any[];
  taxConfigs: any[];
  locations: any[];
  foodTrucks: any[];
  fleetLogs: any[];
  attendanceLogs: any[];
  payrollRuns: any[];
  shiftTemplates: any[];
  shiftSchedules: any[];
  customers: any[];
  notifications: any[];
  dailyHuddles: any[];
  wasteLogs: any[];
  terminalDevices: any[];
  auditLogs: any[];
}

let cachedSnapshot: WorkspaceSnapshot | null = null;
const inflightSnapshotByUid = new Map<string, Promise<WorkspaceSnapshot>>();
const activeSyncByUid = new Map<string, Promise<void>>();
const syncedProfileByUid = new Map<string, string>();
const seededWorkspaceUids = new Set<string>();

export function invalidateWorkspaceCache() {
  cachedSnapshot = null;
  inflightSnapshotByUid.clear();
}

export function resetFirebaseSyncCache() {
  cachedSnapshot = null;
  inflightSnapshotByUid.clear();
  syncedProfileByUid.clear();
  seededWorkspaceUids.clear();
}

function isTransientReadError(err: unknown): boolean {
  const code = String((err as any)?.code || '').toLowerCase();
  const msg = (err instanceof Error ? err.message : String(err || '')).toLowerCase();
  return (
    code === 'unavailable' ||
    code === 'already-exists' ||
    code === 'aborted' ||
    code === 'deadline-exceeded' ||
    msg.includes('target id already exists') ||
    msg.includes('the client is offline') ||
    msg.includes('client is offline') ||
    msg.includes('network error') ||
    msg.includes('unavailable')
  );
}

async function runFirestoreRead<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientReadError(err) || attempt === maxRetries) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function queryCollection(colName: string, uid: string): Promise<any[]> {
  try {
    const q = query(collection(db, colName), where('ownerUid', '==', uid));
    const snap = await runFirestoreRead(() => getDocs(q));
    return snap.docs.map((d) => ({ ...d.data(), _docId: d.id }));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, colName);
  }
}

async function getWorkspaceMeta(uid: string): Promise<any | null> {
  const metaId = `ws_${uid}`;
  const path = `workspace_meta/${metaId}`;
  try {
    const snap = await runFirestoreRead(() => getDoc(doc(db, 'workspace_meta', metaId)));
    return snap.exists() ? { ...snap.data(), _docId: snap.id } : null;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

export function syncFirebaseUserAndSeed(firebaseUser: User): Promise<void> {
  const uid = firebaseUser.uid;
  const inflight = activeSyncByUid.get(uid);
  if (inflight) return inflight;

  const task = (async () => {
    await firebaseUser.getIdToken().catch(() => {});

    const userPath = `users/${uid}`;
    const isBootstrap = (firebaseUser.email || '').toLowerCase() === BOOTSTRAP_ADMIN_EMAIL;
    const cleanEmail = (firebaseUser.email || `${uid}@users.maximusbbq.ph`).trim().slice(0, 200);
    const cleanName = (firebaseUser.displayName?.trim() || cleanEmail.split('@')[0]?.trim() || 'Workspace User').slice(0, 150);
    const rawPhoto = firebaseUser.photoURL ? String(firebaseUser.photoURL).trim() : '';
    const cleanPhoto = rawPhoto && rawPhoto.length <= 250000 ? rawPhoto : null;
    const profileKey = `${cleanEmail}|${cleanName}|${cleanPhoto ?? ''}`;

    if (syncedProfileByUid.get(uid) !== profileKey) {
      const userRef = doc(db, 'users', uid);
      let userSnap;
      try {
        userSnap = await runFirestoreRead(() => getDoc(userRef));
      } catch (err) {
        handleFirestoreError(err, OperationType.GET, userPath);
      }

      if (!userSnap.exists()) {
        try {
          await setDoc(userRef, {
            uid,
            email: cleanEmail,
            displayName: cleanName,
            photoURL: cleanPhoto,
            role: isBootstrap ? 'admin' : 'member',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, userPath);
        }
      } else {
        const existing = userSnap.data();
        if (existing.displayName !== cleanName || (existing.photoURL ?? null) !== cleanPhoto) {
          try {
            await updateDoc(userRef, {
              displayName: cleanName,
              photoURL: cleanPhoto,
              updatedAt: serverTimestamp(),
            });
          } catch (err) {
            handleFirestoreError(err, OperationType.UPDATE, userPath);
          }
        }
      }
      syncedProfileByUid.set(uid, profileKey);
    }

    if (!seededWorkspaceUids.has(uid)) {
      const meta = await getWorkspaceMeta(uid);
      if (!meta?.seeded) {
        await seedWorkspaceFirestore(firebaseUser);
        invalidateWorkspaceCache();
      }
      seededWorkspaceUids.add(uid);
    }
  })().finally(() => {
    activeSyncByUid.delete(uid);
  });

  activeSyncByUid.set(uid, task);
  return task;
}

async function seedWorkspaceFirestore(firebaseUser: User): Promise<void> {
  const uid = firebaseUser.uid;
  const batch = writeBatch(db);
  const daysFromNow = (d: number) => new Date(Date.now() + d * 86400000).toISOString();
  const todayStr = new Date().toISOString().slice(0, 10);
  const demoPassHash = await hashPassword('erp2026!');

  // 1. Roles, UOMs, Conversions, Petty Cash, Financial Periods, Payroll Rules -> workspace_meta
  const allPerms = Object.values(PERMISSIONS);
  const roles = [
    { id: 'role_super_admin', code: 'SUPER_ADMIN', name: 'Super Administrator', description: 'Super Administrator role', permissions: allPerms },
    { id: 'role_business_owner', code: 'BUSINESS_OWNER', name: 'Business Owner', description: 'Business Owner role', permissions: allPerms },
    {
      id: 'role_operations_manager',
      code: 'OPERATIONS_MANAGER',
      name: 'Operations Manager',
      description: 'Operations Manager role',
      permissions: [
        PERMISSIONS.DASHBOARD_VIEW,
        PERMISSIONS.POS_SELL,
        PERMISSIONS.POS_REFUND,
        PERMISSIONS.KDS_MANAGE,
        PERMISSIONS.PRODUCT_MANAGE,
        PERMISSIONS.INVENTORY_VIEW,
        PERMISSIONS.INVENTORY_ADJUST,
        PERMISSIONS.PO_CREATE,
        PERMISSIONS.PO_APPROVE,
        PERMISSIONS.GRN_RECEIVE,
        PERMISSIONS.FLEET_MANAGE,
        PERMISSIONS.REPORTS_VIEW,
        PERMISSIONS.DAILY_CLOSE,
      ],
    },
    {
      id: 'role_finance_manager',
      code: 'FINANCE_MANAGER',
      name: 'Finance Manager',
      description: 'Finance Manager role',
      permissions: [
        PERMISSIONS.DASHBOARD_VIEW,
        PERMISSIONS.FINANCE_VIEW,
        PERMISSIONS.JOURNAL_POST,
        PERMISSIONS.DAILY_CLOSE,
        PERMISSIONS.PO_APPROVE,
        PERMISSIONS.REPORTS_VIEW,
        PERMISSIONS.HR_MANAGE,
        PERMISSIONS.PAYROLL_RUN,
      ],
    },
    {
      id: 'role_inventory_manager',
      code: 'INVENTORY_MANAGER',
      name: 'Inventory Manager',
      description: 'Inventory Manager role',
      permissions: [
        PERMISSIONS.DASHBOARD_VIEW,
        PERMISSIONS.INVENTORY_VIEW,
        PERMISSIONS.INVENTORY_ADJUST,
        PERMISSIONS.GRN_RECEIVE,
        PERMISSIONS.PO_CREATE,
        PERMISSIONS.PRODUCT_MANAGE,
        PERMISSIONS.REPORTS_VIEW,
      ],
    },
    {
      id: 'role_purchasing_officer',
      code: 'PURCHASING_OFFICER',
      name: 'Purchasing Officer',
      description: 'Purchasing Officer role',
      permissions: [
        PERMISSIONS.DASHBOARD_VIEW,
        PERMISSIONS.INVENTORY_VIEW,
        PERMISSIONS.PO_CREATE,
        PERMISSIONS.GRN_RECEIVE,
        PERMISSIONS.REPORTS_VIEW,
      ],
    },
    {
      id: 'role_food_truck_manager',
      code: 'FOOD_TRUCK_MANAGER',
      name: 'Food Truck Manager',
      description: 'Food Truck Manager role',
      permissions: [
        PERMISSIONS.DASHBOARD_VIEW,
        PERMISSIONS.POS_SELL,
        PERMISSIONS.POS_REFUND,
        PERMISSIONS.KDS_MANAGE,
        PERMISSIONS.INVENTORY_VIEW,
        PERMISSIONS.INVENTORY_ADJUST,
        PERMISSIONS.DAILY_CLOSE,
        PERMISSIONS.FLEET_MANAGE,
        PERMISSIONS.CRM_MANAGE,
      ],
    },
    {
      id: 'role_cashier',
      code: 'CASHIER',
      name: 'Cashier',
      description: 'Cashier role',
      permissions: [PERMISSIONS.POS_SELL, PERMISSIONS.CRM_MANAGE],
    },
    {
      id: 'role_kitchen_staff',
      code: 'KITCHEN_STAFF',
      name: 'Kitchen Staff',
      description: 'Kitchen Staff role',
      permissions: [PERMISSIONS.KDS_MANAGE, PERMISSIONS.INVENTORY_VIEW],
    },
    {
      id: 'role_hr_manager',
      code: 'HR_MANAGER',
      name: 'HR Manager',
      description: 'HR Manager role',
      permissions: [PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.HR_MANAGE, PERMISSIONS.PAYROLL_RUN, PERMISSIONS.REPORTS_VIEW],
    },
  ];

  const uoms = [
    { id: 'uom_g', code: 'g', name: 'Grams' },
    { id: 'uom_kg', code: 'kg', name: 'Kilograms' },
    { id: 'uom_ml', code: 'ml', name: 'Milliliters' },
    { id: 'uom_l', code: 'L', name: 'Liters' },
    { id: 'uom_pcs', code: 'pcs', name: 'Pieces' },
  ];

  const unitConversions = [
    { id: 'conv_kg_g', from_uom_id: 'uom_kg', to_uom_id: 'uom_g', factor: 1000 },
    { id: 'conv_l_ml', from_uom_id: 'uom_l', to_uom_id: 'uom_ml', factor: 1000 },
  ];

  const pettyCashFunds = [
    { id: 'pc_1', location_id: 'loc_truck_1', fund_name: 'Truck 01 Petty Cash', float_amount: 5000, current_balance: 4250 },
    { id: 'pc_2', location_id: 'loc_truck_2', fund_name: 'Truck 02 Petty Cash', float_amount: 5000, current_balance: 4600 },
  ];

  const financialPeriods = [
    { id: 'fp_2026_11', name: '2026-11', period_start: '2026-11-01', period_end: '2026-11-30', status: 'OPEN' },
  ];

  const payrollRule = {
    id: 'pr_ph_2026',
    code: 'PH_STATUTORY_2026',
    name: 'Configurable Philippine Statutory Contributions',
    is_active: 1,
    config: {
      sssEmployeeRatePct: 4.5,
      philhealthEmployeeRatePct: 2.5,
      pagibigFixedEmployeePhp: 200,
      overtimeMultiplier: 1.25,
      taxExemptMonthlyCeilingPhp: 20833,
      withholdingRateAboveCeilingPct: 15,
    },
  };

  const metaId = `ws_${uid}`;
  batch.set(doc(db, 'workspace_meta', metaId), {
    id: metaId,
    ownerUid: uid,
    seeded: true,
    businessName: 'Maximus Barbecue ERP',
    currency: 'PHP',
    roles,
    uoms,
    unitConversions,
    pettyCashFunds,
    financialPeriods,
    payrollRule,
    poApprovalThreshold: 10000,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // 2. Locations (no updatedAt)
  const locs = [
    { id: 'loc_commissary', code: 'COM-01', name: 'Central Commissary Kitchen', type: 'COMMISSARY', address: 'Pasig Food Hub, Metro Manila', kdsEnabled: false, dailySalesTarget: 5000 },
    { id: 'loc_truck_1', code: 'TRK-01', name: 'Truck 01 — BGC High Street', type: 'FOOD_TRUCK', address: '7th Ave & Bonifacio High St, Taguig', kdsEnabled: true, dailySalesTarget: 15000 },
    { id: 'loc_truck_2', code: 'TRK-02', name: 'Truck 02 — Ayala Triangle', type: 'FOOD_TRUCK', address: 'Makati Ave Night Market, Makati', kdsEnabled: true, dailySalesTarget: 12000 },
  ];
  for (const l of locs) {
    const docId = toDocId(l.id, uid);
    batch.set(doc(db, 'locations', docId), {
      id: docId,
      ownerUid: uid,
      code: l.code,
      name: l.name,
      type: l.type,
      address: l.address,
      isActive: true,
      kdsEnabled: l.kdsEnabled,
      dailySalesTarget: l.dailySalesTarget,
      createdAt: serverTimestamp(),
    });
  }

  // 3. Food Trucks & Fleet Logs
  const trucks = [
    { id: 'trk_1', locationId: 'loc_truck_1', plateNumber: 'NAA-4821', makeModel: 'Isuzu NLR Custom Kitchen Van', status: 'ACTIVE', currentSite: 'BGC High Street South', odometerKm: 42850 },
    { id: 'trk_2', locationId: 'loc_truck_2', plateNumber: 'NCB-9104', makeModel: 'Mitsubishi Canter Food Rig', status: 'ACTIVE', currentSite: 'Ayala Triangle Gardens', odometerKm: 31420 },
  ];
  for (const t of trucks) {
    const docId = toDocId(t.id, uid);
    batch.set(doc(db, 'food_trucks', docId), {
      id: docId,
      ownerUid: uid,
      locationId: toDocId(t.locationId, uid),
      plateNumber: t.plateNumber,
      makeModel: t.makeModel,
      status: t.status,
      currentSite: t.currentSite,
      odometerKm: t.odometerKm,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  const fleetSeeds = [
    { id: 'ta_1', logType: 'ASSIGNMENT', truckId: 'trk_1', siteName: 'BGC High Street South', assignedDate: todayStr, shiftNotes: 'Lunch & Dinner Peak Service', liters: null, totalCost: null, odometerKm: null, title: null, description: null, serviceDate: null, nextDueDate: null, maintenanceCategory: null, serviceProvider: null, maintenanceStatus: null, alertLeadDays: null },
    { id: 'ta_2', logType: 'ASSIGNMENT', truckId: 'trk_2', siteName: 'Ayala Triangle Gardens', assignedDate: todayStr, shiftNotes: 'Evening Street Market', liters: null, totalCost: null, odometerKm: null, title: null, description: null, serviceDate: null, nextDueDate: null, maintenanceCategory: null, serviceProvider: null, maintenanceStatus: null, alertLeadDays: null },
    { id: 'fuel_1', logType: 'FUEL', truckId: 'trk_1', siteName: null, assignedDate: daysFromNow(-2), shiftNotes: null, liters: 42.5, totalCost: 2450, odometerKm: 42850, title: null, description: null, serviceDate: null, nextDueDate: null, maintenanceCategory: null, serviceProvider: null, maintenanceStatus: null, alertLeadDays: null },
    { id: 'mnt_1', logType: 'MAINTENANCE', truckId: 'trk_2', siteName: null, assignedDate: null, shiftNotes: null, liters: null, totalCost: 1800, odometerKm: 31200, title: 'Generator Oil & Filter Service', description: 'Scheduled 500-hr generator preventive maintenance', serviceDate: daysFromNow(-3).slice(0, 10), nextDueDate: daysFromNow(27).slice(0, 10), maintenanceCategory: 'GENERATOR_LPG', serviceProvider: 'Honda Power Service BGC', maintenanceStatus: 'OPEN', alertLeadDays: 7 },
    { id: 'mnt_2', logType: 'MAINTENANCE', truckId: 'trk_1', siteName: null, assignedDate: null, shiftNotes: null, liters: null, totalCost: 3450, odometerKm: 42100, title: 'Engine Oil & Brake Inspection', description: 'Synthetic oil change, front brake pad measure & coolant flush', serviceDate: daysFromNow(-42).slice(0, 10), nextDueDate: daysFromNow(3).slice(0, 10), maintenanceCategory: 'ENGINE_OIL', serviceProvider: 'Petron Car Care BGC', maintenanceStatus: 'OPEN', alertLeadDays: 7 },
  ];
  for (const fl of fleetSeeds) {
    const docId = toDocId(fl.id, uid);
    batch.set(doc(db, 'fleet_logs', docId), {
      id: docId,
      ownerUid: uid,
      logType: fl.logType,
      truckId: toDocId(fl.truckId, uid),
      siteName: fl.siteName,
      assignedDate: fl.assignedDate,
      shiftNotes: fl.shiftNotes,
      liters: fl.liters,
      totalCost: fl.totalCost,
      odometerKm: fl.odometerKm,
      title: fl.title,
      description: fl.description,
      serviceDate: fl.serviceDate,
      nextDueDate: fl.nextDueDate,
      ...(fl.maintenanceCategory ? { maintenanceCategory: fl.maintenanceCategory } : {}),
      ...(fl.serviceProvider ? { serviceProvider: fl.serviceProvider } : {}),
      ...(fl.maintenanceStatus ? { maintenanceStatus: fl.maintenanceStatus } : {}),
      ...(fl.alertLeadDays !== null ? { alertLeadDays: fl.alertLeadDays } : {}),
      createdAt: serverTimestamp(),
    });
  }

  // 4. ERP Users (including signed-in Google Owner + seeded RBAC accounts)
  const erpUserSeeds: Array<{
    id: string;
    email: string;
    fullName: string;
    roleId: string;
    roleCode: string;
    roleName: string;
    assignedLocationId: string | null;
    avatarUrl: string | null;
  }> = [
    { id: 'usr_superadmin', email: 'superadmin@maximusbbq.ph', fullName: 'System Super Admin', roleId: 'role_super_admin', roleCode: 'SUPER_ADMIN', roleName: 'Super Administrator', assignedLocationId: null, avatarUrl: null },
    { id: 'usr_owner', email: 'owner@maximusbbq.ph', fullName: 'Marco Santos (Owner)', roleId: 'role_business_owner', roleCode: 'BUSINESS_OWNER', roleName: 'Business Owner', assignedLocationId: null, avatarUrl: null },
    { id: 'usr_ops', email: 'ops@maximusbbq.ph', fullName: 'Elena Reyes (Operations)', roleId: 'role_operations_manager', roleCode: 'OPERATIONS_MANAGER', roleName: 'Operations Manager', assignedLocationId: null, avatarUrl: null },
    { id: 'usr_fin', email: 'finance@maximusbbq.ph', fullName: 'Paolo Cruz (Finance)', roleId: 'role_finance_manager', roleCode: 'FINANCE_MANAGER', roleName: 'Finance Manager', assignedLocationId: null, avatarUrl: null },
    { id: 'usr_cashier', email: 'cashier@maximusbbq.ph', fullName: 'Bea Mendoza (Cashier)', roleId: 'role_cashier', roleCode: 'CASHIER', roleName: 'Cashier', assignedLocationId: toDocId('loc_truck_1', uid), avatarUrl: null },
    { id: 'usr_kitchen', email: 'kitchen@maximusbbq.ph', fullName: 'Carlo Villanueva (Kitchen)', roleId: 'role_kitchen_staff', roleCode: 'KITCHEN_STAFF', roleName: 'Kitchen Staff', assignedLocationId: toDocId('loc_truck_1', uid), avatarUrl: null },
  ];

  const googleEmail = (firebaseUser.email || '').trim().toLowerCase().slice(0, 200);
  const googleDisplayName = (firebaseUser.displayName?.trim() || googleEmail.split('@')[0]?.trim() || 'Workspace Owner').slice(0, 150);
  const rawGooglePhoto = firebaseUser.photoURL ? String(firebaseUser.photoURL).trim() : '';
  const safeGooglePhoto = rawGooglePhoto && rawGooglePhoto.length <= 250000 ? rawGooglePhoto : null;
  const isPasswordTerminalAuth =
    isTerminalModeDevice() &&
    firebaseUser.providerData?.some((p) => p.providerId === 'password') &&
    !firebaseUser.providerData?.some((p) => p.providerId === 'google.com');
  if (googleEmail && !isPasswordTerminalAuth && !erpUserSeeds.some((u) => u.email.toLowerCase() === googleEmail)) {
    erpUserSeeds.unshift({
      id: 'usr_google_owner',
      email: googleEmail,
      fullName: googleDisplayName,
      roleId: 'role_super_admin',
      roleCode: 'SUPER_ADMIN',
      roleName: 'Super Administrator',
      assignedLocationId: null,
      avatarUrl: safeGooglePhoto,
    });
  }

  for (const u of erpUserSeeds) {
    const docId = toDocId(u.id, uid);
    batch.set(doc(db, 'erp_users', docId), {
      id: docId,
      ownerUid: uid,
      email: u.email,
      fullName: u.fullName,
      roleId: u.roleId,
      roleCode: u.roleCode,
      roleName: u.roleName,
      assignedLocationId: u.assignedLocationId,
      avatarUrl: u.avatarUrl,
      passwordHash: demoPassHash,
      isActive: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  // 5. Inventory Items & Stock Batches
  const invSeeds = [
    { id: 'ing_pork', sku: 'ING-PORK', name: 'Crispy Pork Maskara & Belly', baseUomId: 'uom_g', uomCode: 'g', costingMethod: 'FIFO', minStockLevel: 5000, reorderPoint: 8000, lastUnitCost: 0.34, weightedAvgCost: 0.33 },
    { id: 'ing_beef', sku: 'ING-BEEF', name: 'Wagyu-Blend Ground Beef', baseUomId: 'uom_g', uomCode: 'g', costingMethod: 'FIFO', minStockLevel: 4000, reorderPoint: 6000, lastUnitCost: 0.58, weightedAvgCost: 0.56 },
    { id: 'ing_tortilla', sku: 'ING-TORT', name: 'Artisan Corn Tortillas', baseUomId: 'uom_pcs', uomCode: 'pcs', costingMethod: 'FIFO', minStockLevel: 100, reorderPoint: 150, lastUnitCost: 8.5, weightedAvgCost: 8.5 },
    { id: 'ing_bun', sku: 'ING-BUN', name: 'Toasted Brioche Buns', baseUomId: 'uom_pcs', uomCode: 'pcs', costingMethod: 'FIFO', minStockLevel: 80, reorderPoint: 120, lastUnitCost: 14.0, weightedAvgCost: 14.0 },
    { id: 'ing_cheddar', sku: 'ING-CHED', name: 'Aged Cheddar Slices', baseUomId: 'uom_pcs', uomCode: 'pcs', costingMethod: 'WEIGHTED_AVERAGE', minStockLevel: 100, reorderPoint: 140, lastUnitCost: 11.0, weightedAvgCost: 10.8 },
    { id: 'ing_potato', sku: 'ING-POT', name: 'Russet Shoestring Potatoes', baseUomId: 'uom_g', uomCode: 'g', costingMethod: 'FIFO', minStockLevel: 6000, reorderPoint: 9000, lastUnitCost: 0.14, weightedAvgCost: 0.14 },
    { id: 'ing_mango', sku: 'ING-MANG', name: 'Guimaras Ripe Mango Puree', baseUomId: 'uom_ml', uomCode: 'ml', costingMethod: 'FIFO', minStockLevel: 4000, reorderPoint: 6000, lastUnitCost: 0.16, weightedAvgCost: 0.16 },
    { id: 'ing_truffle', sku: 'ING-TRUF', name: 'Black Truffle Garlic Aioli', baseUomId: 'uom_ml', uomCode: 'ml', costingMethod: 'FIFO', minStockLevel: 1500, reorderPoint: 2500, lastUnitCost: 0.42, weightedAvgCost: 0.42 },
  ];
  for (const item of invSeeds) {
    const docId = toDocId(item.id, uid);
    batch.set(doc(db, 'inventory_items', docId), {
      id: docId,
      ownerUid: uid,
      sku: item.sku,
      name: item.name,
      itemType: 'RAW_MATERIAL',
      baseUomId: item.baseUomId,
      uomCode: item.uomCode,
      costingMethod: item.costingMethod,
      minStockLevel: item.minStockLevel,
      reorderPoint: item.reorderPoint,
      lastUnitCost: item.lastUnitCost,
      weightedAvgCost: item.weightedAvgCost,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  const batchSeeds = [
    ['bat_1', 'ing_pork', 'loc_truck_1', 'LOT-PRK-101', 12000, 9500, 0.32, daysFromNow(5), daysFromNow(-4)],
    ['bat_2', 'ing_pork', 'loc_truck_1', 'LOT-PRK-102', 8000, 8000, 0.34, daysFromNow(8), daysFromNow(-1)],
    ['bat_3', 'ing_beef', 'loc_truck_1', 'LOT-BEF-201', 10000, 7400, 0.58, daysFromNow(2), daysFromNow(-3)],
    ['bat_4', 'ing_tortilla', 'loc_truck_1', 'LOT-TRT-301', 300, 210, 8.5, daysFromNow(14), daysFromNow(-2)],
    ['bat_5', 'ing_bun', 'loc_truck_1', 'LOT-BUN-401', 150, 95, 14.0, daysFromNow(3), daysFromNow(-2)],
    ['bat_6', 'ing_cheddar', 'loc_truck_1', 'LOT-CHD-501', 250, 180, 10.8, daysFromNow(25), daysFromNow(-5)],
    ['bat_7', 'ing_potato', 'loc_truck_1', 'LOT-POT-601', 15000, 11500, 0.14, daysFromNow(30), daysFromNow(-4)],
    ['bat_8', 'ing_mango', 'loc_truck_1', 'LOT-MNG-701', 9000, 6200, 0.16, daysFromNow(6), daysFromNow(-2)],
    ['bat_9', 'ing_truffle', 'loc_truck_1', 'LOT-TRF-801', 3000, 1800, 0.42, daysFromNow(20), daysFromNow(-6)],
    ['bat_10', 'ing_pork', 'loc_truck_2', 'LOT-PRK-202', 10000, 8200, 0.34, daysFromNow(7), daysFromNow(-1)],
    ['bat_11', 'ing_beef', 'loc_truck_2', 'LOT-BEF-202', 9000, 6800, 0.58, daysFromNow(6), daysFromNow(-1)],
    ['bat_12', 'ing_tortilla', 'loc_truck_2', 'LOT-TRT-202', 240, 180, 8.5, daysFromNow(15), daysFromNow(-1)],
    ['bat_13', 'ing_bun', 'loc_truck_2', 'LOT-BUN-202', 180, 140, 14.0, daysFromNow(4), daysFromNow(-1)],
    ['bat_14', 'ing_cheddar', 'loc_truck_2', 'LOT-CHD-202', 200, 160, 10.8, daysFromNow(25), daysFromNow(-1)],
    ['bat_15', 'ing_potato', 'loc_truck_2', 'LOT-POT-202', 12000, 9600, 0.14, daysFromNow(30), daysFromNow(-1)],
    ['bat_16', 'ing_mango', 'loc_truck_2', 'LOT-MNG-202', 8000, 6400, 0.16, daysFromNow(7), daysFromNow(-1)],
    ['bat_17', 'ing_truffle', 'loc_truck_2', 'LOT-TRF-202', 3000, 2600, 0.42, daysFromNow(20), daysFromNow(-1)],
    ['bat_18', 'ing_pork', 'loc_commissary', 'LOT-COM-01', 25000, 25000, 0.32, daysFromNow(10), daysFromNow(-2)],
    ['bat_19', 'ing_beef', 'loc_commissary', 'LOT-COM-02', 20000, 20000, 0.55, daysFromNow(9), daysFromNow(-2)],
    ['bat_20', 'ing_bun', 'loc_commissary', 'LOT-COM-03', 400, 400, 13.5, daysFromNow(6), daysFromNow(-1)],
  ] as const;

  for (const [id, itemId, locId, batchNumber, initialQty, remainingQty, unitCost, expiryDate, receivedAt] of batchSeeds) {
    const docId = toDocId(id, uid);
    batch.set(doc(db, 'stock_batches', docId), {
      id: docId,
      ownerUid: uid,
      inventoryItemId: toDocId(itemId, uid),
      locationId: toDocId(locId, uid),
      batchNumber,
      initialQty,
      remainingQty,
      unitCost,
      expiryDate,
      receivedAt,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  // 6. Tax Configs & Categories
  const taxSeeds = [
    { id: 'tax_ph_vat', code: 'PH_VAT_12', name: 'Philippine VAT (12% Inclusive)', ratePercent: 12.0, isInclusive: true, isActive: true },
    { id: 'tax_ph_pct', code: 'PH_NONVAT_3', name: 'Philippine Percentage Tax (3%)', ratePercent: 3.0, isInclusive: true, isActive: false },
  ];
  for (const tc of taxSeeds) {
    const docId = toDocId(tc.id, uid);
    batch.set(doc(db, 'tax_configs', docId), {
      id: docId,
      ownerUid: uid,
      code: tc.code,
      name: tc.name,
      ratePercent: tc.ratePercent,
      isInclusive: tc.isInclusive,
      isActive: tc.isActive,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  const catSeeds = [
    { id: 'cat_tacos', name: 'Street Tacos', sortOrder: 1, showInPos: true },
    { id: 'cat_burgers', name: 'Smash Burgers', sortOrder: 2, showInPos: true },
    { id: 'cat_sides', name: 'Loaded Sides', sortOrder: 3, showInPos: true },
    { id: 'cat_drinks', name: 'Coolers & Shakes', sortOrder: 4, showInPos: true },
  ];
  for (const c of catSeeds) {
    const docId = toDocId(c.id, uid);
    batch.set(doc(db, 'categories', docId), {
      id: docId,
      ownerUid: uid,
      name: c.name,
      sortOrder: c.sortOrder,
      showInPos: c.showInPos,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  // 7. Products (with embedded variants, modifiers, recipe ingredients)
  const productSeeds = [
    {
      id: 'prd_sisig',
      sku: 'MNU-01',
      name: 'Crispy Pork Sisig Tacos (3 pcs)',
      description: 'Charred corn tortillas with crispy pork sisig, calamansi & chili crema',
      imageUrl: '/src/assets/images/dish_sisig_taco_1795140886147.jpg',
      categoryId: toDocId('cat_tacos', uid),
      basePrice: 215,
      packagingCost: 12,
      directLaborCost: 18,
      targetFoodCostPct: 34,
      taxConfigId: toDocId('tax_ph_vat', uid),
      expiryDate: null,
      isAvailable: true,
      variants: [
        { id: 'var_sisig_3', name: 'Solo (3 pcs)', priceDelta: 0, portionMultiplier: 1.0 },
        { id: 'var_sisig_5', name: 'Barkada (5 pcs)', priceDelta: 125, portionMultiplier: 1.66 },
      ],
      modifiers: [
        { id: 'mod_extra_pork', groupName: 'Protein Boost', name: 'Extra Crispy Sisig', priceDelta: 55, inventoryItemId: toDocId('ing_pork', uid), deductQty: 60, uomId: 'uom_g' },
      ],
      recipeYieldQty: 1,
      prepInstructions: 'Crisp pork on flat-top 4 min, assemble on charred tortillas',
      ingredients: [
        { id: 'ri_1', inventoryItemId: toDocId('ing_pork', uid), quantity: 160, uomId: 'uom_g', wasteFactorPct: 5 },
        { id: 'ri_2', inventoryItemId: toDocId('ing_tortilla', uid), quantity: 3, uomId: 'uom_pcs', wasteFactorPct: 2 },
      ],
    },
    {
      id: 'prd_burger',
      sku: 'MNU-02',
      name: 'Double Wagyu Smash Burger',
      description: 'Double seared beef patties, aged cheddar, caramelized onions on brioche',
      imageUrl: '/src/assets/images/dish_wagyu_burger_1795140888993.jpg',
      categoryId: toDocId('cat_burgers', uid),
      basePrice: 285,
      packagingCost: 14,
      directLaborCost: 22,
      targetFoodCostPct: 36,
      taxConfigId: toDocId('tax_ph_vat', uid),
      expiryDate: null,
      isAvailable: true,
      variants: [
        { id: 'var_brg_dbl', name: 'Double Patty', priceDelta: 0, portionMultiplier: 1.0 },
        { id: 'var_brg_trp', name: 'Triple Smash', priceDelta: 95, portionMultiplier: 1.5 },
      ],
      modifiers: [
        { id: 'mod_extra_cheese', groupName: 'Add-ons', name: 'Extra Aged Cheddar', priceDelta: 30, inventoryItemId: toDocId('ing_cheddar', uid), deductQty: 1, uomId: 'uom_pcs' },
      ],
      recipeYieldQty: 1,
      prepInstructions: 'Smash two 90g patties at 220C, melt 2 slices cheddar',
      ingredients: [
        { id: 'ri_3', inventoryItemId: toDocId('ing_beef', uid), quantity: 180, uomId: 'uom_g', wasteFactorPct: 4 },
        { id: 'ri_4', inventoryItemId: toDocId('ing_bun', uid), quantity: 1, uomId: 'uom_pcs', wasteFactorPct: 1 },
        { id: 'ri_5', inventoryItemId: toDocId('ing_cheddar', uid), quantity: 2, uomId: 'uom_pcs', wasteFactorPct: 0 },
      ],
    },
    {
      id: 'prd_fries',
      sku: 'MNU-03',
      name: 'Truffle Parmesan Fries',
      description: 'Hand-cut Russet fries tossed in parmesan with garlic truffle aioli',
      imageUrl: '/src/assets/images/dish_truffle_fries_1795140887488.jpg',
      categoryId: toDocId('cat_sides', uid),
      basePrice: 155,
      packagingCost: 10,
      directLaborCost: 12,
      targetFoodCostPct: 30,
      taxConfigId: toDocId('tax_ph_vat', uid),
      expiryDate: null,
      isAvailable: true,
      variants: [
        { id: 'var_frs_reg', name: 'Regular Boat', priceDelta: 0, portionMultiplier: 1.0 },
        { id: 'var_frs_shr', name: 'Sharing Tray', priceDelta: 85, portionMultiplier: 1.75 },
      ],
      modifiers: [
        { id: 'mod_extra_aioli', groupName: 'Dip Upgrade', name: 'Extra Truffle Aioli Cup', priceDelta: 35, inventoryItemId: toDocId('ing_truffle', uid), deductQty: 30, uomId: 'uom_ml' },
      ],
      recipeYieldQty: 1,
      prepInstructions: 'Double-fry Russet potatoes, serve with 45ml truffle aioli',
      ingredients: [
        { id: 'ri_6', inventoryItemId: toDocId('ing_potato', uid), quantity: 220, uomId: 'uom_g', wasteFactorPct: 6 },
        { id: 'ri_7', inventoryItemId: toDocId('ing_truffle', uid), quantity: 45, uomId: 'uom_ml', wasteFactorPct: 3 },
      ],
    },
    {
      id: 'prd_mango',
      sku: 'MNU-04',
      name: 'Guimaras Mango Graham Shake',
      description: 'Layered ripe mango puree, crushed graham & whipped cream',
      imageUrl: '/src/assets/images/dish_mango_shake_1795140887833.jpg',
      categoryId: toDocId('cat_drinks', uid),
      basePrice: 145,
      packagingCost: 11,
      directLaborCost: 10,
      targetFoodCostPct: 32,
      taxConfigId: toDocId('tax_ph_vat', uid),
      expiryDate: null,
      isAvailable: true,
      variants: [
        { id: 'var_mng_16', name: '16oz Cup', priceDelta: 0, portionMultiplier: 1.0 },
        { id: 'var_mng_22', name: '22oz Tall', priceDelta: 40, portionMultiplier: 1.35 },
      ],
      modifiers: [],
      recipeYieldQty: 1,
      prepInstructions: 'Blend 220ml mango puree with ice, layer graham',
      ingredients: [
        { id: 'ri_8', inventoryItemId: toDocId('ing_mango', uid), quantity: 220, uomId: 'uom_ml', wasteFactorPct: 4 },
      ],
    },
  ];
  for (const p of productSeeds) {
    const docId = toDocId(p.id, uid);
    batch.set(doc(db, 'products', docId), {
      ...p,
      id: docId,
      ownerUid: uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  // 8. Chart of Accounts (no updatedAt)
  const accountSeeds = [
    ['acc_1000', '1000', 'Cash on Hand & Register', 'ASSET', true],
    ['acc_1010', '1010', 'BPI Operating Bank & E-Wallet Clearing', 'ASSET', true],
    ['acc_1200', '1200', 'Food & Packaging Inventory', 'ASSET', true],
    ['acc_2000', '2000', 'Accounts Payable', 'LIABILITY', true],
    ['acc_2050', '2050', 'Accrued Purchases (GRNI)', 'LIABILITY', true],
    ['acc_2100', '2100', 'Output VAT Payable', 'LIABILITY', true],
    ['acc_3000', '3000', 'Owner Equity', 'EQUITY', true],
    ['acc_4000', '4000', 'Food & Beverage Sales Revenue', 'REVENUE', true],
    ['acc_5000', '5000', 'Cost of Goods Sold (COGS)', 'EXPENSE', true],
    ['acc_6100', '6100', 'Fuel & LPG Expense', 'EXPENSE', false],
    ['acc_6200', '6200', 'Truck Rent, Parking & Permits', 'EXPENSE', false],
    ['acc_6300', '6300', 'Salaries & Wages Expense', 'EXPENSE', false],
    ['acc_6400', '6400', 'Vehicle Maintenance & Repairs', 'EXPENSE', false],
  ] as const;
  for (const [id, code, name, type, isSystem] of accountSeeds) {
    const docId = toDocId(id, uid);
    batch.set(doc(db, 'accounts', docId), {
      id: docId,
      ownerUid: uid,
      code,
      name,
      type,
      isSystem,
      createdAt: serverTimestamp(),
    });
  }

  // 9. Suppliers, POs, Supplier Invoices
  const supSeeds = [
    { id: 'sup_1', code: 'SUP-MET', name: 'Metro Meat & Poultry Trading', contactPerson: 'Ramon Tan', phone: '+63 917 555 1021', email: 'orders@metromeat.ph', address: 'Marikina Cold Storage Hub', tin: '008-412-901-000', paymentTerms: 15 },
    { id: 'sup_2', code: 'SUP-BAK', name: 'Artisan Bakehouse Manila', contactPerson: 'Grace Lim', phone: '+63 918 442 8890', email: 'supply@artisanbake.ph', address: 'Mandaluyong City', tin: '009-221-445-000', paymentTerms: 7 },
    { id: 'sup_3', code: 'SUP-FRU', name: 'Visayas Highland Produce Corp', contactPerson: 'Lito Dizon', phone: '+63 922 778 3312', email: 'fresh@visayasproduce.ph', address: 'Divisoria Cold Hub', tin: '007-889-123-000', paymentTerms: 0 },
  ];
  for (const s of supSeeds) {
    const docId = toDocId(s.id, uid);
    batch.set(doc(db, 'suppliers', docId), {
      ...s,
      id: docId,
      ownerUid: uid,
      isActive: true,
      updatedBy: null,
      updatedByName: 'System Seed',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  const poSeeds = [
    {
      id: 'po_1',
      poNumber: 'PO-2026-089',
      supplierId: toDocId('sup_2', uid),
      locationId: toDocId('loc_truck_1', uid),
      status: 'PENDING_APPROVAL',
      totalAmount: 4200,
      approvedBy: null,
      notes: '',
      orderedAt: daysFromNow(-1),
      expectedAt: daysFromNow(1),
      items: [{ id: 'poi_1', inventoryItemId: toDocId('ing_bun', uid), orderedQty: 300, receivedQty: 0, unitCost: 14.0 }],
    },
    {
      id: 'po_2',
      poNumber: 'PO-2026-090',
      supplierId: toDocId('sup_1', uid),
      locationId: toDocId('loc_commissary', uid),
      status: 'APPROVED',
      totalAmount: 12400,
      approvedBy: toDocId('usr_ops', uid),
      notes: '',
      orderedAt: daysFromNow(-1),
      expectedAt: daysFromNow(1),
      items: [
        { id: 'poi_2', inventoryItemId: toDocId('ing_pork', uid), orderedQty: 20000, receivedQty: 0, unitCost: 0.34 },
        { id: 'poi_3', inventoryItemId: toDocId('ing_beef', uid), orderedQty: 10000, receivedQty: 0, unitCost: 0.56 },
      ],
    },
  ];
  for (const po of poSeeds) {
    const docId = toDocId(po.id, uid);
    batch.set(doc(db, 'purchase_orders', docId), {
      ...po,
      id: docId,
      ownerUid: uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  const invDocId = toDocId('sinv_1', uid);
  batch.set(doc(db, 'supplier_invoices', invDocId), {
    id: invDocId,
    ownerUid: uid,
    invoiceNumber: 'SI-MET-9941',
    supplierId: toDocId('sup_1', uid),
    purchaseOrderId: null,
    totalAmount: 18500,
    paidAmount: 10000,
    dueDate: daysFromNow(5),
    status: 'PARTIAL',
    payments: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // 10. Customers
  const custSeeds = [
    { id: 'cus_1', fullName: 'Andrea Bautista', phone: '09171234567', email: 'andrea.b@gmail.com', loyaltyPoints: 420, tier: 'GOLD', preferences: 'Extra calamansi on sisig tacos', feedbackNotes: null, registeredAt: '2026-10-15', locationId: toDocId('loc_truck_1', uid) },
    { id: 'cus_2', fullName: 'Rafael Navarro', phone: '09189876543', email: 'rafael.n@outlook.com', loyaltyPoints: 185, tier: 'SILVER', preferences: 'No onions on smash burger', feedbackNotes: null, registeredAt: '2026-10-28', locationId: toDocId('loc_truck_2', uid) },
    { id: 'cus_3', fullName: 'Katrina Sy', phone: '09178882211', email: 'katrina.sy@company.ph', loyaltyPoints: 610, tier: 'PLATINUM', preferences: 'Corporate catering organizer (BGC)', feedbackNotes: null, registeredAt: '2026-11-05', locationId: toDocId('loc_truck_1', uid) },
  ];
  for (const c of custSeeds) {
    const docId = toDocId(c.id, uid);
    batch.set(doc(db, 'customers', docId), {
      ...c,
      id: docId,
      ownerUid: uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  // 11. Employees & Attendance
  const empSeeds = [
    { id: 'emp_1', employeeCode: 'EMP-001', fullName: 'Bea Mendoza', department: 'Front of House', position: 'Lead Cashier', locationId: toDocId('loc_truck_1', uid), payType: 'DAILY', baseRate: 720, avatarUrl: null },
    { id: 'emp_2', employeeCode: 'EMP-002', fullName: 'Carlo Villanueva', department: 'Culinary', position: 'Line Cook', locationId: toDocId('loc_truck_1', uid), payType: 'DAILY', baseRate: 760, avatarUrl: null },
    { id: 'emp_3', employeeCode: 'EMP-003', fullName: 'Jericho Palma', department: 'Fleet & Ops', position: 'Truck Driver / Cook', locationId: toDocId('loc_truck_2', uid), payType: 'DAILY', baseRate: 800, avatarUrl: null },
    { id: 'emp_4', employeeCode: 'EMP-004', fullName: 'Dianne Mercado', department: 'Front of House', position: 'Cashier', locationId: toDocId('loc_truck_2', uid), payType: 'DAILY', baseRate: 690, avatarUrl: null },
  ];
  for (const e of empSeeds) {
    const docId = toDocId(e.id, uid);
    batch.set(doc(db, 'employees', docId), {
      ...e,
      id: docId,
      ownerUid: uid,
      isActive: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  const attSeeds = [
    { id: 'att_1', employeeId: toDocId('emp_1', uid), clockIn: `${todayStr}T09:00:00`, clockOut: null, overtimeHours: 0, status: 'PRESENT', notes: null },
    { id: 'att_2', employeeId: toDocId('emp_2', uid), clockIn: `${todayStr}T08:45:00`, clockOut: null, overtimeHours: 1.5, status: 'PRESENT', notes: null },
    { id: 'att_3', employeeId: toDocId('emp_3', uid), clockIn: `${todayStr}T09:15:00`, clockOut: null, overtimeHours: 0, status: 'LATE', notes: null },
  ];
  for (const a of attSeeds) {
    const docId = toDocId(a.id, uid);
    batch.set(doc(db, 'attendance_logs', docId), {
      ...a,
      id: docId,
      ownerUid: uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  // 12. Sales & Journal Entries
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
    const sid = toDocId(`sale_seed_${i + 1}`, uid);
    const gross = o.qty * o.price;
    const tax = Number((gross - gross / 1.12).toFixed(2));
    const sub = Number((gross - tax).toFixed(2));
    const cogs = Number((o.qty * o.cogs).toFixed(2));
    const soldAt = daysFromNow(o.dayOffset);
    const rcpt = `OR-2026${String(101 + i)}`;

    batch.set(doc(db, 'sales', sid), {
      id: sid,
      ownerUid: uid,
      receiptNumber: rcpt,
      clientTxnId: `seed_txn_${i + 1}`,
      locationId: toDocId(o.loc, uid),
      cashierId: toDocId('usr_cashier', uid),
      customerId: o.cust ? toDocId(o.cust, uid) : null,
      channel: 'WALK_IN',
      status: 'COMPLETED',
      kdsStatus: o.kds,
      subtotal: sub,
      discountAmount: 0,
      taxAmount: tax,
      totalAmount: gross,
      totalCogs: cogs,
      notes: null,
      isOfflineSynced: false,
      items: [
        {
          id: `si_seed_${i + 1}`,
          productId: toDocId(o.prod, uid),
          variantId: null,
          productName: o.name,
          variantName: 'Standard',
          quantity: o.qty,
          unitPrice: o.price,
          lineTotal: gross,
          cogsAmount: cogs,
          modifiers: [],
          kitchenNotes: null,
        },
      ],
      payments: [{ id: `pay_seed_${i + 1}`, method: o.method, amount: gross, referenceNo: null, paidAt: soldAt }],
      soldAt,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    const jeId = toDocId(`je_seed_${i + 1}`, uid);
    batch.set(doc(db, 'journal_entries', jeId), {
      id: jeId,
      ownerUid: uid,
      entryNumber: `JE-POS-${rcpt}`,
      entryDate: soldAt,
      description: `POS Sale ${rcpt}`,
      referenceType: 'SALE',
      referenceId: sid,
      isReversed: false,
      lines: [
        { id: `jl_${i}_1`, accountId: toDocId(o.method === 'CASH' ? 'acc_1000' : 'acc_1010', uid), debit: gross, credit: 0, memo: `${o.method} receipt` },
        { id: `jl_${i}_2`, accountId: toDocId('acc_4000', uid), debit: 0, credit: sub, memo: 'Food Sales Revenue' },
        { id: `jl_${i}_3`, accountId: toDocId('acc_2100', uid), debit: 0, credit: tax, memo: 'Output VAT 12%' },
        { id: `jl_${i}_4`, accountId: toDocId('acc_5000', uid), debit: cogs, credit: 0, memo: 'Cost of Goods Sold' },
        { id: `jl_${i}_5`, accountId: toDocId('acc_1200', uid), debit: 0, credit: cogs, memo: 'Inventory Asset Reduction' },
      ],
      createdAt: serverTimestamp(),
    });
  });

  // 13. Expenses (no updatedAt)
  const expSeeds = [
    { id: 'exp_1', locationId: toDocId('loc_truck_1', uid), accountId: toDocId('acc_6100', uid), category: 'FUEL', amount: 2450, description: 'Diesel Refill — Petron BGC', expenseDate: daysFromNow(-2) },
    { id: 'exp_2', locationId: toDocId('loc_truck_1', uid), accountId: toDocId('acc_6100', uid), category: 'LPG', amount: 1150, description: '2x 11kg Solane LPG Tank', expenseDate: daysFromNow(-1) },
    { id: 'exp_3', locationId: toDocId('loc_truck_2', uid), accountId: toDocId('acc_6200', uid), category: 'RENT_PARKING', amount: 3500, description: 'Ayala Night Market Slot Fee', expenseDate: daysFromNow(-1) },
    { id: 'exp_4', locationId: toDocId('loc_truck_2', uid), accountId: toDocId('acc_6400', uid), category: 'MAINTENANCE', amount: 1800, description: 'Generator Oil & Filter Service', expenseDate: daysFromNow(-3) },
  ];
  for (const e of expSeeds) {
    const docId = toDocId(e.id, uid);
    batch.set(doc(db, 'expenses', docId), {
      ...e,
      id: docId,
      ownerUid: uid,
      isRecurring: false,
      paidFromPettyCash: false,
      createdAt: serverTimestamp(),
    });
  }

  // 13b. Expense Categories
  for (const c of DEFAULT_EXPENSE_CATEGORIES) {
    const docId = toDocId(c.id, uid);
    batch.set(doc(db, 'expense_categories', docId), {
      id: docId,
      ownerUid: uid,
      code: c.code,
      name: c.name,
      description: c.description,
      sortOrder: c.sortOrder,
      isActive: c.isActive,
      createdAt: serverTimestamp(),
    });
  }

  // 14. Notifications
  const notifSeeds = [
    { id: 'ntf_1', type: 'LOW_STOCK', severity: 'WARNING', title: 'Low Stock: Toasted Brioche Buns', message: 'Truck 01 has 95 pcs remaining (below reorder point of 120 pcs).', locationId: toDocId('loc_truck_1', uid) },
    { id: 'ntf_2', type: 'EXPIRY', severity: 'CRITICAL', title: 'Expiring Batch: Wagyu-Blend Ground Beef', message: 'LOT-BEF-201 (7,400g) on Truck 01 expires within 48 hours.', locationId: toDocId('loc_truck_1', uid) },
    { id: 'ntf_3', type: 'PO_PENDING', severity: 'INFO', title: 'Purchase Order Awaiting Approval', message: 'PO-2026-089 (Artisan Bakehouse Manila · ₱4,200.00) needs manager approval.', locationId: toDocId('loc_truck_1', uid) },
  ];
  for (const n of notifSeeds) {
    const docId = toDocId(n.id, uid);
    batch.set(doc(db, 'notifications', docId), {
      ...n,
      id: docId,
      ownerUid: uid,
      isRead: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  // 15. Shift Templates
  for (const tpl of DEFAULT_SHIFT_TEMPLATES) {
    const docId = toDocId(tpl.id, uid);
    batch.set(doc(db, 'shift_templates', docId), {
      id: docId,
      ownerUid: uid,
      code: tpl.code,
      name: tpl.name,
      startTime: tpl.startTime,
      endTime: tpl.endTime,
      breakMinutes: tpl.breakMinutes,
      daysOfWeek: tpl.daysOfWeek,
      locationIds: tpl.locationIds.map((l) => toDocId(l, uid)),
      defaultRole: tpl.defaultRole,
      headcountNeeded: tpl.headcountNeeded,
      notes: tpl.notes,
      isActive: tpl.isActive,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  // 16. Initial Daily Huddle Briefing
  const huddleDocId = toDocId('hdl_1', uid);
  batch.set(doc(db, 'daily_huddles', huddleDocId), {
    id: huddleDocId,
    ownerUid: uid,
    title: 'Welcome Shift Brief — Brioche Bun & Sisig Prep Check',
    message:
      'Truck 01 is running low on Brioche Buns (95 pcs remaining). Offer Crispy Pork Sisig Tacos as the featured item during lunch rush and confirm buzzer numbers on all POS tickets.',
    priority: 'URGENT',
    targetChannels: ['POS', 'KDS', 'MOBILE'],
    locationId: null,
    locationName: null,
    shiftWindow: 'ALL_DAY',
    authorId: 'usr_ops',
    authorName: 'Elena Reyes (Operations)',
    authorRole: 'Operations Manager',
    acknowledgedBy: [],
    isPinned: true,
    isActive: true,
    expiresAt: daysFromNow(1),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'workspace_seed_batch');
  }
}

async function loadSnapshot(force = false): Promise<WorkspaceSnapshot> {
  const user = auth.currentUser;
  if (!user) throw new Error('Authentication required');
  const uid = user.uid;

  if (!force && cachedSnapshot && cachedSnapshot.uid === uid) {
    return cachedSnapshot;
  }

  if (!force) {
    const inflight = inflightSnapshotByUid.get(uid);
    if (inflight) return inflight;
  }

  const task = (async (): Promise<WorkspaceSnapshot> => {
    await syncFirebaseUserAndSeed(user);

    // Fetch workspace collections in bounded waves to avoid overloading the Firestore Listen stream with 27 concurrent targets.
    const [meta, erpUsers, employees, categories, products, inventoryItems, stockBatches] = await Promise.all([
      getWorkspaceMeta(uid),
      queryCollection('erp_users', uid),
      queryCollection('employees', uid),
      queryCollection('categories', uid),
      queryCollection('products', uid),
      queryCollection('inventory_items', uid),
      queryCollection('stock_batches', uid),
    ]);

    const [inventoryTxns, stockTransfers, sales, suppliers, purchaseOrders, goodsReceipts, supplierInvoices] = await Promise.all([
      queryCollection('inventory_transactions', uid),
      queryCollection('stock_transfers', uid),
      queryCollection('sales', uid),
      queryCollection('suppliers', uid),
      queryCollection('purchase_orders', uid),
      queryCollection('goods_receipts', uid),
      queryCollection('supplier_invoices', uid),
    ]);

    const [accounts, journalEntries, expenses, expenseCategories, dailyClosings, taxConfigs, locations, foodTrucks] = await Promise.all([
      queryCollection('accounts', uid),
      queryCollection('journal_entries', uid),
      queryCollection('expenses', uid),
      queryCollection('expense_categories', uid),
      queryCollection('daily_closings', uid),
      queryCollection('tax_configs', uid),
      queryCollection('locations', uid),
      queryCollection('food_trucks', uid),
    ]);

    const [fleetLogs, attendanceLogs, payrollRuns, customers, notifications, auditLogs] = await Promise.all([
      queryCollection('fleet_logs', uid),
      queryCollection('attendance_logs', uid),
      queryCollection('payroll_runs', uid),
      queryCollection('customers', uid),
      queryCollection('notifications', uid),
      queryCollection('audit_logs', uid),
    ]);

    const [shiftTemplatesRaw, shiftSchedules, dailyHuddles, wasteLogs, terminalDevices] = await Promise.all([
      queryCollection('shift_templates', uid),
      queryCollection('shift_schedules', uid),
      queryCollection('daily_huddles', uid),
      queryCollection('waste_logs', uid),
      queryCollection('terminal_devices', uid),
    ]);

    let activeShiftTemplates = shiftTemplatesRaw;
    if (activeShiftTemplates.length === 0 && meta?.seeded) {
      const seedBatch = writeBatch(db);
      const seededItems: any[] = [];
      const nowIso = new Date().toISOString();
      for (const tpl of DEFAULT_SHIFT_TEMPLATES) {
        const docId = toDocId(tpl.id, uid);
        const mappedLocIds = tpl.locationIds
          .map((l) => toDocId(l, uid))
          .filter((lid) => locations.some((loc) => loc.id === lid));
        const payload = {
          id: docId,
          ownerUid: uid,
          code: tpl.code,
          name: tpl.name,
          startTime: tpl.startTime,
          endTime: tpl.endTime,
          breakMinutes: tpl.breakMinutes,
          daysOfWeek: tpl.daysOfWeek,
          locationIds: mappedLocIds,
          defaultRole: tpl.defaultRole,
          headcountNeeded: tpl.headcountNeeded,
          notes: tpl.notes,
          isActive: tpl.isActive,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };
        seedBatch.set(doc(db, 'shift_templates', docId), payload);
        seededItems.push({ ...payload, createdAt: nowIso, updatedAt: nowIso });
      }
      try {
        await seedBatch.commit();
        activeShiftTemplates = seededItems;
      } catch (seedErr) {
        console.warn('[ShiftTemplates] Auto-seed fallback skipped:', seedErr);
      }
    }

    const activeExpCats = expenseCategories.length > 0
      ? expenseCategories
      : DEFAULT_EXPENSE_CATEGORIES.map((c) => ({
          ...c,
          id: toDocId(c.id, uid),
          ownerUid: uid,
          createdAt: new Date().toISOString(),
        }));

    const snapshot: WorkspaceSnapshot = {
      uid,
      meta,
      erpUsers,
      employees,
      categories,
      products,
      inventoryItems,
      stockBatches,
      inventoryTxns,
      stockTransfers,
      sales,
      suppliers,
      purchaseOrders,
      goodsReceipts,
      supplierInvoices,
      accounts,
      journalEntries,
      expenses,
      expenseCategories: activeExpCats,
      dailyClosings,
      taxConfigs,
      locations,
      foodTrucks,
      fleetLogs,
      attendanceLogs,
      payrollRuns,
      shiftTemplates: activeShiftTemplates,
      shiftSchedules,
      customers,
      notifications,
      dailyHuddles,
      wasteLogs,
      terminalDevices,
      auditLogs,
    };

    cachedSnapshot = snapshot;
    return snapshot;
  })().finally(() => {
    if (inflightSnapshotByUid.get(uid) === task) {
      inflightSnapshotByUid.delete(uid);
    }
  });

  inflightSnapshotByUid.set(uid, task);
  return task;
}

// =====================================================
// ACTIVE ERP USER & RBAC HELPERS
// =====================================================
function toAuthUser(erpUser: any, snap: WorkspaceSnapshot): AuthUser {
  const role = (snap.meta?.roles || []).find((r: any) => r.id === erpUser.roleId || r.code === erpUser.roleCode);
  return {
    id: toLogicalId(erpUser.id, snap.uid),
    email: erpUser.email,
    fullName: erpUser.fullName,
    roleCode: erpUser.roleCode as RoleCode,
    roleName: erpUser.roleName || role?.name || erpUser.roleCode,
    permissions: role?.permissions || [],
    assignedLocationId: erpUser.assignedLocationId ? toLogicalId(erpUser.assignedLocationId, snap.uid) : null,
    avatarUrl: erpUser.avatarUrl || null,
    hasPin: Boolean(erpUser.shiftPinHash),
  };
}

export function getActiveErpUserId(): string | null {
  try {
    return sessionStorage.getItem(ACTIVE_USER_SESSION_KEY);
  } catch {
    return null;
  }
}

export function setActiveErpUserId(id: string | null) {
  try {
    if (id) sessionStorage.setItem(ACTIVE_USER_SESSION_KEY, id);
    else sessionStorage.removeItem(ACTIVE_USER_SESSION_KEY);
  } catch {
    // ignore storage restrictions
  }
}

export function isSignedOutSession(): boolean {
  try {
    return sessionStorage.getItem(SIGNED_OUT_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

export function setSignedOutSession(signedOut: boolean) {
  try {
    if (signedOut) sessionStorage.setItem(SIGNED_OUT_SESSION_KEY, '1');
    else sessionStorage.removeItem(SIGNED_OUT_SESSION_KEY);
  } catch {
    // ignore storage restrictions
  }
}

function resolveOptionalErpUser(snap: WorkspaceSnapshot): AuthUser | null {
  if (isSignedOutSession()) return null;
  const activeUsers = snap.erpUsers.filter((u) => u.isActive);
  if (!activeUsers.length) return null;
  const storedLogicalId = getActiveErpUserId();
  if (storedLogicalId) {
    const match = activeUsers.find((u) => toLogicalId(u.id, snap.uid) === storedLogicalId || u.id === storedLogicalId);
    if (match) return toAuthUser(match, snap);
  }
  const fbEmail = (auth.currentUser?.email || '').toLowerCase();
  const byEmail = activeUsers.find((u) => String(u.email || '').toLowerCase() === fbEmail);
  return byEmail ? toAuthUser(byEmail, snap) : null;
}

function resolveCurrentErpUser(snap: WorkspaceSnapshot): AuthUser {
  if (isSignedOutSession()) {
    throw new Error('SIGNED_OUT');
  }
  const activeUsers = snap.erpUsers.filter((u) => u.isActive);
  if (!activeUsers.length) throw new Error('No active ERP user accounts found');

  const storedLogicalId = getActiveErpUserId();
  if (storedLogicalId) {
    const match = activeUsers.find((u) => toLogicalId(u.id, snap.uid) === storedLogicalId || u.id === storedLogicalId);
    if (match) return toAuthUser(match, snap);
  }

  // On shared Terminal-mode devices, staff must explicitly sign in via Shift PIN or Work Email & Password.
  if (isTerminalModeDevice()) {
    throw new Error('SIGNED_OUT');
  }

  const fbEmail = (auth.currentUser?.email || '').toLowerCase();
  const byEmail = activeUsers.find((u) => String(u.email || '').toLowerCase() === fbEmail);
  const chosen =
    byEmail ||
    activeUsers.find((u) => u.roleCode === 'SUPER_ADMIN') ||
    activeUsers.find((u) => u.roleCode === 'BUSINESS_OWNER') ||
    activeUsers[0];

  setActiveErpUserId(toLogicalId(chosen.id, snap.uid));
  return toAuthUser(chosen, snap);
}

function assertPerm(user: AuthUser, perm: string) {
  if (user.roleCode === 'SUPER_ADMIN' || user.roleCode === 'BUSINESS_OWNER' || user.permissions.includes(perm)) return;
  throw new Error(`Permission denied: requires ${perm}`);
}

function assertAnyPerm(user: AuthUser, ...perms: string[]) {
  if (user.roleCode === 'SUPER_ADMIN' || user.roleCode === 'BUSINESS_OWNER' || perms.some((p) => user.permissions.includes(p))) return;
  throw new Error(`Permission denied: requires one of ${perms.join(', ')}`);
}

function assertOwnerOrSuperAdmin(user: AuthUser) {
  if (user.roleCode === 'SUPER_ADMIN' || user.roleCode === 'BUSINESS_OWNER') return;
  throw new Error('Restricted: Company Owner or Super Admin access only');
}

function assertDeviceManagerAccess(user: AuthUser) {
  if (
    user.roleCode === 'SUPER_ADMIN' ||
    user.roleCode === 'BUSINESS_OWNER' ||
    user.roleCode === 'OPERATIONS_MANAGER' ||
    user.roleCode === 'FOOD_TRUCK_MANAGER'
  ) {
    return;
  }
  throw new Error('Restricted: Manager, Owner, or Super Admin access required for Device Pairing');
}

function normalizePrinterFields(input: any, existing?: any) {
  const clear =
    Boolean(input?.clearPrinter) ||
    (input?.printerIp === null && input?.printerBtDeviceId == null && input?.printerConnectionType == null) ||
    (input?.printerIp === '' && !input?.printerBtDeviceId && input?.printerConnectionType !== 'BLUETOOTH');

  const hasIncomingPrinterSpec =
    input?.printerConnectionType !== undefined ||
    input?.printerIp !== undefined ||
    input?.printerBtDeviceId !== undefined;

  if (!hasIncomingPrinterSpec && !clear) {
    return {
      printerConnectionType: existing?.printerConnectionType ?? (existing?.printerIp ? 'NETWORK' : existing?.printerBtDeviceId ? 'BLUETOOTH' : null),
      printerName: existing?.printerName ?? null,
      printerIp: existing?.printerIp ?? null,
      printerPort: existing?.printerPort ?? null,
      printerBtDeviceId: existing?.printerBtDeviceId ?? null,
      printerBtServiceUuid: existing?.printerBtServiceUuid ?? null,
      printerBtCharacteristicUuid: existing?.printerBtCharacteristicUuid ?? null,
      printerPaperWidthMm: existing?.printerPaperWidthMm ?? null,
      printerAutoPrint: Boolean(existing?.printerAutoPrint),
    };
  }
  if (clear) {
    return {
      printerConnectionType: null,
      printerName: null,
      printerIp: null,
      printerPort: null,
      printerBtDeviceId: null,
      printerBtServiceUuid: null,
      printerBtCharacteristicUuid: null,
      printerPaperWidthMm: null,
      printerAutoPrint: false,
    };
  }

  const rawWidth = Number(input?.printerPaperWidthMm ?? existing?.printerPaperWidthMm ?? 80);
  const paperWidthMm = rawWidth === 58 ? 58 : 80;
  const autoPrint =
    input?.printerAutoPrint !== undefined ? Boolean(input.printerAutoPrint) : Boolean(existing?.printerAutoPrint);

  const requestedType = String(
    input?.printerConnectionType ?? (input?.printerBtDeviceId ? 'BLUETOOTH' : 'NETWORK'),
  ).toUpperCase();

  if (requestedType === 'BLUETOOTH') {
    const cleanBtId = String(input?.printerBtDeviceId ?? existing?.printerBtDeviceId ?? '')
      .trim()
      .slice(0, 160);
    if (!cleanBtId) {
      throw new Error('Bluetooth printer Device ID or MAC address is required');
    }
    const cleanServiceUuid = input?.printerBtServiceUuid
      ? String(input.printerBtServiceUuid).trim().slice(0, 128)
      : null;
    const cleanCharUuid = input?.printerBtCharacteristicUuid
      ? String(input.printerBtCharacteristicUuid).trim().slice(0, 128)
      : null;
    const cleanName = String(input?.printerName || existing?.printerName || 'Bluetooth Thermal Printer')
      .trim()
      .slice(0, 120);

    return {
      printerConnectionType: 'BLUETOOTH' as const,
      printerName: cleanName || 'Bluetooth Thermal Printer',
      printerIp: null,
      printerPort: null,
      printerBtDeviceId: cleanBtId,
      printerBtServiceUuid: cleanServiceUuid,
      printerBtCharacteristicUuid: cleanCharUuid,
      printerPaperWidthMm: paperWidthMm,
      printerAutoPrint: autoPrint,
    };
  }

  const cleanIp = String(input?.printerIp || '').trim();
  const m = cleanIp.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) {
    throw new Error('Printer IP must be a valid private LAN IPv4 address (e.g. 192.168.1.88)');
  }
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error('Printer IP contains an invalid octet');
  }
  const [a, b] = octets;
  const isPrivate = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  if (!isPrivate) {
    throw new Error('Printer IP must be on a private LAN subnet (10.x, 172.16-31.x, or 192.168.x)');
  }
  const rawPort = Number(input?.printerPort ?? existing?.printerPort ?? 9100);
  if (![9100, 9101, 9102].includes(rawPort)) {
    throw new Error('Printer TCP port must be 9100, 9101, or 9102');
  }
  const cleanName = String(input?.printerName || existing?.printerName || `Thermal Printer (${cleanIp})`)
    .trim()
    .slice(0, 120);

  return {
    printerConnectionType: 'NETWORK' as const,
    printerName: cleanName || `Thermal Printer (${cleanIp})`,
    printerIp: cleanIp,
    printerPort: rawPort,
    printerBtDeviceId: null,
    printerBtServiceUuid: null,
    printerBtCharacteristicUuid: null,
    printerPaperWidthMm: paperWidthMm,
    printerAutoPrint: autoPrint,
  };
}

function mapTerminalDevice(d: any, uid: string, locMap: Map<string, any>) {
  const loc = d.locationId ? locMap.get(d.locationId) : null;
  const connType =
    d.printerConnectionType === 'BLUETOOTH'
      ? 'BLUETOOTH'
      : d.printerConnectionType === 'NETWORK'
        ? 'NETWORK'
        : d.printerBtDeviceId
          ? 'BLUETOOTH'
          : d.printerIp
            ? 'NETWORK'
            : null;
  return {
    id: toLogicalId(d.id, uid),
    hardware_uuid: String(d.hardwareUuid || ''),
    device_name: String(d.deviceName || 'POS Terminal'),
    location_id: d.locationId ? toLogicalId(d.locationId, uid) : null,
    location_name: loc?.name || null,
    station_email: d.stationEmail || null,
    status: d.status === 'REVOKED' ? 'REVOKED' : 'AUTHORIZED',
    paired_by_user_id: String(d.pairedByUserId || ''),
    paired_by_name: String(d.pairedByName || ''),
    paired_at: String(d.pairedAt || tsToIso(d.createdAt)),
    last_seen_at: String(d.lastSeenAt || tsToIso(d.updatedAt || d.createdAt)),
    user_agent_summary: d.userAgentSummary || null,
    printer_connection_type: connType,
    printer_name: d.printerName || null,
    printer_ip: d.printerIp || null,
    printer_port: d.printerPort ? Number(d.printerPort) : null,
    printer_bt_device_id: d.printerBtDeviceId || null,
    printer_bt_service_uuid: d.printerBtServiceUuid || null,
    printer_bt_characteristic_uuid: d.printerBtCharacteristicUuid || null,
    printer_paper_width_mm: d.printerPaperWidthMm === 58 ? 58 : d.printerPaperWidthMm === 80 ? 80 : null,
    printer_auto_print: Boolean(d.printerAutoPrint),
    created_at: tsToIso(d.createdAt),
    updated_at: tsToIso(d.updatedAt || d.createdAt),
  };
}

// =====================================================
// DOMAIN ENGINE HELPERS
// =====================================================
function convertQty(qty: number, fromUomId: string, toUomId: string, snap: WorkspaceSnapshot): number {
  if (fromUomId === toUomId) return qty;
  const convs: any[] = snap.meta?.unitConversions || [];
  const direct = convs.find((c) => c.from_uom_id === fromUomId && c.to_uom_id === toUomId);
  if (direct) return qty * direct.factor;
  const inverse = convs.find((c) => c.from_uom_id === toUomId && c.to_uom_id === fromUomId);
  if (inverse) return qty / inverse.factor;
  throw new Error(`Missing unit conversion between ${fromUomId} and ${toUomId}`);
}

async function addAuditLog(
  uid: string,
  userId: string | null,
  userName: string | null,
  action: string,
  entityType: string,
  entityId: string,
  details?: Record<string, unknown> | string | null,
) {
  const id = toDocId(crypto.randomUUID(), uid);
  const path = `audit_logs/${id}`;
  try {
    await setDoc(doc(db, 'audit_logs', id), {
      id,
      ownerUid: uid,
      userId,
      userName,
      action,
      entityType,
      entityId,
      details: formatDetailsText(details),
      loggedAt: new Date().toISOString(),
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

function toDailyHuddleItem(raw: any, uid: string): DailyHuddleItem {
  const priorityRaw = String(raw?.priority || 'NORMAL').toUpperCase();
  const priority: HuddlePriority =
    priorityRaw === 'CRITICAL' ? 'CRITICAL' : priorityRaw === 'URGENT' ? 'URGENT' : 'NORMAL';
  const shiftRaw = String(raw?.shiftWindow || 'ALL_DAY').toUpperCase();
  const shiftWindow: HuddleShiftWindow =
    shiftRaw === 'OPENING' || shiftRaw === 'MID_DAY' || shiftRaw === 'CLOSING' ? shiftRaw : 'ALL_DAY';
  const rawChannels = Array.isArray(raw?.targetChannels) ? raw.targetChannels : ALL_HUDDLE_CHANNELS;
  const targetChannels = rawChannels.filter((c: unknown): c is HuddleChannel =>
    c === 'POS' || c === 'KDS' || c === 'MOBILE',
  );

  return {
    id: toLogicalId(String(raw?.id || ''), uid),
    title: String(raw?.title || ''),
    message: String(raw?.message || ''),
    priority,
    targetChannels: targetChannels.length > 0 ? targetChannels : [...ALL_HUDDLE_CHANNELS],
    locationId: raw?.locationId ? toLogicalId(String(raw.locationId), uid) : null,
    locationName: raw?.locationName ? String(raw.locationName) : null,
    shiftWindow,
    authorId: String(raw?.authorId || ''),
    authorName: String(raw?.authorName || 'Manager'),
    authorRole: String(raw?.authorRole || 'Manager'),
    acknowledgedBy: Array.isArray(raw?.acknowledgedBy) ? raw.acknowledgedBy.map((x: unknown) => String(x)) : [],
    isPinned: Boolean(raw?.isPinned),
    isActive: raw?.isActive !== false,
    expiresAt: raw?.expiresAt ? String(raw.expiresAt) : null,
    createdAt: tsToIso(raw?.createdAt),
    updatedAt: tsToIso(raw?.updatedAt || raw?.createdAt),
  };
}

export function subscribeDailyHuddles(onUpdate: (items: DailyHuddleItem[]) => void): () => void {
  const fbUser = auth.currentUser;
  if (!fbUser) {
    onUpdate([]);
    return () => {};
  }
  const uid = fbUser.uid;
  const q = query(collection(db, 'daily_huddles'), where('ownerUid', '==', uid));
  return onSnapshot(
    q,
    (snapshot) => {
      const mapped = snapshot.docs.map((d) => toDailyHuddleItem(d.data(), uid));
      if (cachedSnapshot && cachedSnapshot.uid === uid) {
        cachedSnapshot.dailyHuddles = snapshot.docs.map((d) => d.data());
      }
      onUpdate(sortDailyHuddles(mapped));
    },
    (err) => {
      if (auth.currentUser) {
        handleFirestoreError(err, OperationType.GET, 'daily_huddles');
      }
    },
  );
}

async function addNotificationIfMissing(
  snap: WorkspaceSnapshot,
  type: string,
  severity: 'INFO' | 'WARNING' | 'CRITICAL',
  title: string,
  message: string,
  locationId?: string | null,
  options?: { onlyIfNeverNotified?: boolean },
): Promise<boolean> {
  const cleanLocId = locationId || null;
  const exists = snap.notifications.some(
    (n) =>
      n.type === type &&
      n.title === title &&
      (options?.onlyIfNeverNotified ? true : !n.isRead) &&
      (cleanLocId ? n.locationId === cleanLocId : !n.locationId || n.locationId === null),
  );
  if (exists) return false;
  const id = toDocId(crypto.randomUUID(), snap.uid);
  const path = `notifications/${id}`;
  const docObj = {
    id,
    ownerUid: snap.uid,
    type,
    severity,
    title,
    message,
    locationId: cleanLocId,
    isRead: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  try {
    await setDoc(doc(db, 'notifications', id), docObj);
    snap.notifications.push({ ...docObj, createdAt: new Date().toISOString() });
    return true;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
    return false;
  }
}

async function resolveMatchingNotifications(
  snap: WorkspaceSnapshot,
  types: string[],
  itemName: string,
  locationId?: string | null,
): Promise<number> {
  const cleanLocId = locationId || null;
  const targets = snap.notifications.filter((n) => {
    if (n.isRead) return false;
    if (!types.includes(n.type)) return false;
    const titleStr = String(n.title || '');
    const matchesItem = titleStr.includes(`: ${itemName}`);
    if (!matchesItem) return false;
    return cleanLocId ? n.locationId === cleanLocId : !n.locationId;
  });
  let resolved = 0;
  for (const n of targets) {
    try {
      await updateDoc(doc(db, 'notifications', n.id), { isRead: true, updatedAt: serverTimestamp() });
      n.isRead = true;
      resolved++;
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `notifications/${n.id}`);
    }
  }
  return resolved;
}

async function syncItemThresholdAlertsFirestore(
  snap: WorkspaceSnapshot,
  item: any,
  locDocId: string | null,
  onHandQty: number,
  options?: { onlyIfNeverNotified?: boolean },
): Promise<{ status: 'BELOW_SAFETY' | 'BELOW_REORDER' | 'NOMINAL'; createdCount: number; resolvedCount: number }> {
  const evalResult = evaluateIngredientThreshold({
    onHandQty,
    safetyStock: Number(item.minStockLevel || 0),
    reorderPoint: Number(item.reorderPoint || 0),
  });

  if (evalResult.status === 'NOMINAL') {
    const resolvedCount = await resolveMatchingNotifications(
      snap,
      ['SAFETY_STOCK', 'LOW_STOCK'],
      item.name,
      locDocId,
    );
    return { status: 'NOMINAL', createdCount: 0, resolvedCount };
  }

  let resolvedCount = 0;
  if (evalResult.status === 'BELOW_REORDER') {
    resolvedCount = await resolveMatchingNotifications(snap, ['SAFETY_STOCK'], item.name, locDocId);
  }

  const locName = locDocId
    ? snap.locations.find((l) => l.id === locDocId)?.name || 'Location'
    : 'All Locations';
  const payload = buildThresholdNotification({
    itemName: item.name,
    sku: item.sku,
    itemType: item.itemType,
    uomCode: item.uomCode,
    locationName: locName,
    evalResult,
  });

  let createdCount = 0;
  if (payload) {
    const created = await addNotificationIfMissing(
      snap,
      payload.type,
      payload.severity,
      payload.title,
      payload.message,
      locDocId,
      options,
    );
    if (created) createdCount = 1;
  }

  return { status: evalResult.status, createdCount, resolvedCount };
}

async function syncFleetMaintenanceAlertsFirestore(snap: WorkspaceSnapshot): Promise<{ createdCount: number; resolvedCount: number }> {
  const locMap = new Map(snap.locations.map((l) => [l.id, l]));
  const trkMap = new Map(snap.foodTrucks.map((t) => [t.id, t]));
  const todayIso = getTodayDateIso();
  let createdCount = 0;
  let resolvedCount = 0;

  const maintLogs = snap.fleetLogs.filter((fl) => fl.logType === 'MAINTENANCE');
  for (const fl of maintLogs) {
    const trk = trkMap.get(fl.truckId);
    const loc = trk ? locMap.get(trk.locationId) : null;
    if (loc && loc.isActive === false) continue;

    const titleText = String(fl.title || 'Scheduled Checkup').trim();
    const truckLabel = loc?.name || trk?.plateNumber || 'Food Truck';
    const alertInfo = getMaintenanceAlertInfo(
      {
        next_due_date: fl.nextDueDate || null,
        maintenance_status: fl.maintenanceStatus === 'COMPLETED' ? 'COMPLETED' : 'OPEN',
        alert_lead_days: Number.isFinite(Number(fl.alertLeadDays)) ? Number(fl.alertLeadDays) : 7,
      },
      todayIso,
    );

    if (alertInfo.state === 'OVERDUE' || alertInfo.state === 'DUE_SOON') {
      const notifTitle =
        alertInfo.state === 'OVERDUE'
          ? `Overdue Truck Checkup: ${titleText}`
          : `Upcoming Truck Checkup: ${titleText}`;
      const notifMsg = `${truckLabel}${trk?.plateNumber ? ` (${trk.plateNumber})` : ''} — due ${String(fl.nextDueDate).slice(0, 10)} (${alertInfo.countdownText}).`;
      const created = await addNotificationIfMissing(
        snap,
        'FLEET_MAINTENANCE',
        alertInfo.state === 'OVERDUE' ? 'CRITICAL' : 'WARNING',
        notifTitle.slice(0, 160),
        notifMsg.slice(0, 500),
        trk?.locationId || null,
        { onlyIfNeverNotified: false },
      );
      if (created) createdCount++;
    } else if (titleText) {
      resolvedCount += await resolveMatchingNotifications(
        snap,
        ['FLEET_MAINTENANCE'],
        titleText,
        trk?.locationId || null,
      );
    }
  }

  return { createdCount, resolvedCount };
}

function getProductCostingList(snap: WorkspaceSnapshot) {
  const catMap = new Map(snap.categories.map((c) => [c.id, c]));
  const taxMap = new Map(snap.taxConfigs.map((t) => [t.id, t]));
  const itemMap = new Map(snap.inventoryItems.map((i) => [i.id, i]));
  const uomMap = new Map<string, any>((snap.meta?.uoms || []).map((u: any) => [u.id, u]));

  const sorted = [...snap.products].sort((a, b) => {
    const ca = catMap.get(a.categoryId)?.sortOrder ?? 999;
    const cb = catMap.get(b.categoryId)?.sortOrder ?? 999;
    if (ca !== cb) return ca - cb;
    return String(a.name).localeCompare(String(b.name));
  });

  return sorted.map((p) => {
    const cat = catMap.get(p.categoryId);
    const tc = p.taxConfigId ? taxMap.get(p.taxConfigId) : null;
    const yieldQty = Number(p.recipeYieldQty || 1);

    let ingredientCost = 0;
    const ingredients = (p.ingredients || []).map((ing: any) => {
      const invItem = itemMap.get(ing.inventoryItemId) || itemMap.get(toDocId(ing.inventoryItemId, snap.uid));
      const uom = uomMap.get(ing.uomId);
      let lineCost = 0;
      if (invItem) {
        const effQty = (Number(ing.quantity) * (1 + Number(ing.wasteFactorPct || 0) / 100)) / yieldQty;
        try {
          const baseQty = convertQty(effQty, ing.uomId, invItem.baseUomId, snap);
          const unitCost = invItem.costingMethod === 'WEIGHTED_AVERAGE' ? invItem.weightedAvgCost : invItem.lastUnitCost;
          lineCost = round2(baseQty * unitCost);
        } catch {
          lineCost = 0;
        }
      }
      ingredientCost += lineCost;
      return {
        id: ing.id,
        recipe_id: toLogicalId(p.id, snap.uid),
        inventory_item_id: toLogicalId(ing.inventoryItemId, snap.uid),
        quantity: Number(ing.quantity),
        uom_id: ing.uomId,
        waste_factor_pct: Number(ing.wasteFactorPct || 0),
        item_name: invItem?.name || 'Ingredient',
        base_uom_id: invItem?.baseUomId || ing.uomId,
        costing_method: invItem?.costingMethod || 'FIFO',
        last_unit_cost: invItem?.lastUnitCost || 0,
        weighted_avg_cost: invItem?.weightedAvgCost || 0,
        uom_code: uom?.code || invItem?.uomCode || '',
        computedLineCost: lineCost,
      };
    });

    ingredientCost = round2(ingredientCost);
    const directCost = round2(ingredientCost + Number(p.packagingCost || 0) + Number(p.directLaborCost || 0));
    const grossProfit = round2(Number(p.basePrice) - directCost);
    const foodCostPct = Number(p.basePrice) > 0 ? round2((ingredientCost / Number(p.basePrice)) * 100) : 0;
    const marginPct = Number(p.basePrice) > 0 ? round2((grossProfit / Number(p.basePrice)) * 100) : 0;

    return {
      id: toLogicalId(p.id, snap.uid),
      sku: p.sku,
      name: p.name,
      description: p.description || '',
      image_url: p.imageUrl || null,
      category_id: toLogicalId(p.categoryId, snap.uid),
      category_name: cat?.name || 'Uncategorized',
      category_show_in_pos: cat?.showInPos !== false ? 1 : 0,
      base_price: Number(p.basePrice),
      packaging_cost: Number(p.packagingCost || 0),
      direct_labor_cost: Number(p.directLaborCost || 0),
      target_food_cost_pct: Number(p.targetFoodCostPct || 35),
      tax_config_id: p.taxConfigId ? toLogicalId(p.taxConfigId, snap.uid) : null,
      tax_code: tc?.code || null,
      rate_percent: tc?.ratePercent ?? 0,
      is_inclusive: tc?.isInclusive ? 1 : 0,
      expiry_date: p.expiryDate || null,
      is_available: p.isAvailable ? 1 : 0,
      variants: (p.variants || []).map((v: any) => ({
        id: v.id,
        product_id: toLogicalId(p.id, snap.uid),
        name: v.name,
        price_delta: Number(v.priceDelta || 0),
        portion_multiplier: Number(v.portionMultiplier || 1),
      })),
      modifiers: (p.modifiers || []).map((m: any) => ({
        id: m.id,
        product_id: toLogicalId(p.id, snap.uid),
        group_name: m.groupName,
        name: m.name,
        price_delta: Number(m.priceDelta || 0),
        inventory_item_id: m.inventoryItemId ? toLogicalId(m.inventoryItemId, snap.uid) : null,
        deduct_qty: Number(m.deductQty || 0),
        uom_id: m.uomId || null,
      })),
      recipe: {
        id: toLogicalId(p.id, snap.uid),
        product_id: toLogicalId(p.id, snap.uid),
        yield_qty: yieldQty,
        prep_instructions: p.prepInstructions || '',
        ingredients,
      },
      costing: {
        ingredientCost,
        packagingCost: Number(p.packagingCost || 0),
        directLaborCost: Number(p.directLaborCost || 0),
        directCost,
        grossProfit,
        foodCostPct,
        marginPct,
        isMarginAlert: foodCostPct > Number(p.targetFoodCostPct || 35),
      },
    };
  });
}

async function receiveStockFirestore(
  snap: WorkspaceSnapshot,
  input: {
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
  },
) {
  if (input.quantity <= 0) throw new Error('Received quantity must be positive');
  const itemDocId = toDocId(input.inventoryItemId, snap.uid);
  const locDocId = toDocId(input.locationId, snap.uid);
  const item = snap.inventoryItems.find((i) => i.id === itemDocId);
  if (!item) throw new Error('Inventory item not found');

  const currentQty = snap.stockBatches
    .filter((b) => b.inventoryItemId === itemDocId && b.remainingQty > 0)
    .reduce((s, b) => s + Number(b.remainingQty || 0), 0);

  const newTotal = currentQty + input.quantity;
  const newWac =
    newTotal > 0 ? (currentQty * Number(item.weightedAvgCost) + input.quantity * input.unitCost) / newTotal : input.unitCost;

  const batchId = toDocId(crypto.randomUUID(), snap.uid);
  const txnId = toDocId(crypto.randomUUID(), snap.uid);
  const nowIso = new Date().toISOString();
  const totalCost = round2(input.quantity * input.unitCost);

  const batch = writeBatch(db);
  const newBatchObj = {
    id: batchId,
    ownerUid: snap.uid,
    inventoryItemId: itemDocId,
    locationId: locDocId,
    batchNumber: input.batchNumber,
    initialQty: round4(input.quantity),
    remainingQty: round4(input.quantity),
    unitCost: round4(input.unitCost),
    expiryDate: input.expiryDate || null,
    receivedAt: nowIso,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  batch.set(doc(db, 'stock_batches', batchId), newBatchObj);

  batch.update(doc(db, 'inventory_items', itemDocId), {
    lastUnitCost: round4(input.unitCost),
    weightedAvgCost: round4(newWac),
    updatedAt: serverTimestamp(),
  });

  const txnObj = {
    id: txnId,
    ownerUid: snap.uid,
    inventoryItemId: itemDocId,
    locationId: locDocId,
    batchId,
    txnType: input.txnType || 'IN_PURCHASE',
    quantityDelta: round4(input.quantity),
    unitCost: round4(input.unitCost),
    totalCost,
    referenceType: input.referenceType || null,
    referenceId: input.referenceId || null,
    notes: input.notes || null,
    createdBy: input.userId || null,
    txnDate: nowIso,
    createdAt: serverTimestamp(),
  };
  batch.set(doc(db, 'inventory_transactions', txnId), txnObj);

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'stock_receive');
  }

  snap.stockBatches.push(newBatchObj);
  item.lastUnitCost = round4(input.unitCost);
  item.weightedAvgCost = round4(newWac);
  snap.inventoryTxns.push({ ...txnObj, createdAt: nowIso });

  const postQty = snap.stockBatches
    .filter((b) => b.inventoryItemId === itemDocId && b.locationId === locDocId)
    .reduce((s, b) => s + Number(b.remainingQty || 0), 0);
  await syncItemThresholdAlertsFirestore(snap, item, locDocId, postQty, { onlyIfNeverNotified: false });

  return { batchId, totalCost };
}

async function deductStockFirestore(
  snap: WorkspaceSnapshot,
  input: {
    inventoryItemId: string;
    locationId: string;
    quantity: number;
    txnType: string;
    referenceType: string;
    referenceId: string;
    userId?: string;
    notes?: string;
    allowNegative?: boolean;
  },
) {
  let remaining = input.quantity;
  if (remaining <= 0) return { totalCogs: 0, consumedBatches: [] as Array<{ qty: number; unitCost: number }> };

  const itemDocId = toDocId(input.inventoryItemId, snap.uid);
  const locDocId = toDocId(input.locationId, snap.uid);
  const item = snap.inventoryItems.find((i) => i.id === itemDocId);
  if (!item) throw new Error(`Inventory item ${input.inventoryItemId} not found`);

  const batches = snap.stockBatches
    .filter((b) => b.inventoryItemId === itemDocId && b.locationId === locDocId && Number(b.remainingQty) > 0)
    .sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));

  const avail = batches.reduce((s, b) => s + Number(b.remainingQty), 0);
  if (input.allowNegative === false && avail + 0.0001 < remaining) {
    throw new Error(`Insufficient stock for ${item.name} (short by ${round2(remaining - avail)})`);
  }

  const batch = writeBatch(db);
  const nowIso = new Date().toISOString();
  let totalCogs = 0;
  const consumedBatches: Array<{ qty: number; unitCost: number }> = [];

  for (const b of batches) {
    if (remaining <= 0) break;
    const take = Math.min(Number(b.remainingQty), remaining);
    const effectiveCost = item.costingMethod === 'WEIGHTED_AVERAGE' ? Number(item.weightedAvgCost) : Number(b.unitCost);
    const nextRem = round4(Number(b.remainingQty) - take);
    b.remainingQty = nextRem;

    batch.update(doc(db, 'stock_batches', b.id), {
      remainingQty: nextRem,
      updatedAt: serverTimestamp(),
    });

    const lineCost = round2(take * effectiveCost);
    const txnId = toDocId(crypto.randomUUID(), snap.uid);
    const txnObj = {
      id: txnId,
      ownerUid: snap.uid,
      inventoryItemId: itemDocId,
      locationId: locDocId,
      batchId: b.id,
      txnType: input.txnType,
      quantityDelta: round4(-take),
      unitCost: round4(effectiveCost),
      totalCost: lineCost,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      notes: input.notes || null,
      createdBy: input.userId || null,
      txnDate: nowIso,
      createdAt: serverTimestamp(),
    };
    batch.set(doc(db, 'inventory_transactions', txnId), txnObj);
    snap.inventoryTxns.push({ ...txnObj, createdAt: nowIso });

    totalCogs += lineCost;
    consumedBatches.push({ qty: take, unitCost: effectiveCost });
    remaining = round4(remaining - take);
  }

  if (remaining > 0) {
    const fallbackCost = item.costingMethod === 'WEIGHTED_AVERAGE' ? Number(item.weightedAvgCost) : Number(item.lastUnitCost);
    const shortageCost = round2(remaining * fallbackCost);
    const txnId = toDocId(crypto.randomUUID(), snap.uid);
    const txnObj = {
      id: txnId,
      ownerUid: snap.uid,
      inventoryItemId: itemDocId,
      locationId: locDocId,
      batchId: null,
      txnType: input.txnType,
      quantityDelta: round4(-remaining),
      unitCost: round4(fallbackCost),
      totalCost: shortageCost,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      notes: `${input.notes || ''} [UNBATCHED_SHORTAGE]`.trim(),
      createdBy: input.userId || null,
      txnDate: nowIso,
      createdAt: serverTimestamp(),
    };
    batch.set(doc(db, 'inventory_transactions', txnId), txnObj);
    snap.inventoryTxns.push({ ...txnObj, createdAt: nowIso });

    totalCogs += shortageCost;
    consumedBatches.push({ qty: remaining, unitCost: fallbackCost });
  }

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'stock_deduct');
  }

  const postQty = snap.stockBatches
    .filter((b) => b.inventoryItemId === itemDocId && b.locationId === locDocId)
    .reduce((s, b) => s + Number(b.remainingQty || 0), 0);

  await syncItemThresholdAlertsFirestore(snap, item, locDocId, postQty, { onlyIfNeverNotified: false });

  return { totalCogs: round2(totalCogs), consumedBatches };
}

function isLocationKdsEnabled(loc: any): boolean {
  if (!loc) return true;
  return loc.kdsEnabled === undefined ? loc.type === 'FOOD_TRUCK' : Boolean(loc.kdsEnabled);
}

async function processSaleFirestore(snap: WorkspaceSnapshot, dto: any, user: AuthUser) {
  if (dto.clientTxnId) {
    const existing = snap.sales.find((s) => s.clientTxnId === dto.clientTxnId);
    if (existing) return formatSaleDto(existing, snap);
  }
  if (!dto.items?.length) throw new Error('Order cart is empty');

  const saleId = toDocId(crypto.randomUUID(), snap.uid);
  const receiptNumber = `OR-${Date.now().toString().slice(-7)}`;
  const soldAt = dto.soldAt || new Date().toISOString();
  const locDocId = toDocId(dto.locationId, snap.uid);
  const cashierDocId = toDocId(user.id, snap.uid);

  let subtotal = 0;
  let totalTax = 0;
  let totalCogs = 0;
  const preparedItems: any[] = [];

  for (const line of dto.items) {
    const prodDocId = toDocId(line.productId, snap.uid);
    const prod = snap.products.find((p) => p.id === prodDocId);
    if (!prod) throw new Error(`Product ${line.productId} not found`);

    const tc = prod.taxConfigId ? snap.taxConfigs.find((t) => t.id === prod.taxConfigId) : null;
    const variant = line.variantId ? (prod.variants || []).find((v: any) => v.id === line.variantId) : null;
    const modIds = new Set((line.modifiers || []).map((m: any) => m.id));
    const dbMods = (prod.modifiers || []).filter((m: any) => modIds.has(m.id));

    const modPrice = dbMods.reduce((s: number, m: any) => s + Number(m.priceDelta || 0), 0);
    const unitPrice = round2(Number(prod.basePrice) + Number(variant?.priceDelta || 0) + modPrice);
    const grossLine = round2(unitPrice * Number(line.quantity));

    let lineTax = 0;
    if (tc && tc.isActive && tc.ratePercent > 0) {
      const r = tc.ratePercent / 100;
      if (tc.isInclusive) {
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

    let itemCogs = 0;
    const portionMult = Number(variant?.portionMultiplier || 1);
    const yieldQty = Number(prod.recipeYieldQty || 1);

    for (const ri of prod.ingredients || []) {
      const invItem = snap.inventoryItems.find((i) => i.id === ri.inventoryItemId || i.id === toDocId(ri.inventoryItemId, snap.uid));
      if (!invItem) continue;
      const rawQty = ((Number(ri.quantity) * (1 + Number(ri.wasteFactorPct || 0) / 100)) / yieldQty) * portionMult * Number(line.quantity);
      const baseQty = convertQty(rawQty, ri.uomId, invItem.baseUomId, snap);
      const deducted = await deductStockFirestore(snap, {
        inventoryItemId: invItem.id,
        locationId: locDocId,
        quantity: baseQty,
        txnType: 'OUT_SALE',
        referenceType: 'SALE',
        referenceId: saleId,
        userId: user.id,
        notes: `POS ${receiptNumber} - ${prod.name}`,
      });
      itemCogs += deducted.totalCogs;
    }

    for (const m of dbMods) {
      if (m.inventoryItemId && m.deductQty > 0 && m.uomId) {
        const invItem = snap.inventoryItems.find((i) => i.id === m.inventoryItemId || i.id === toDocId(m.inventoryItemId, snap.uid));
        if (invItem) {
          const baseQty = convertQty(Number(m.deductQty) * Number(line.quantity), m.uomId, invItem.baseUomId, snap);
          const deducted = await deductStockFirestore(snap, {
            inventoryItemId: invItem.id,
            locationId: locDocId,
            quantity: baseQty,
            txnType: 'OUT_SALE',
            referenceType: 'SALE',
            referenceId: saleId,
            userId: user.id,
            notes: `Modifier ${m.name}`,
          });
          itemCogs += deducted.totalCogs;
        }
      }
    }

    itemCogs = round2(itemCogs);
    totalCogs += itemCogs;
    preparedItems.push({
      id: crypto.randomUUID(),
      productId: prod.id,
      variantId: variant?.id || null,
      productName: prod.name,
      variantName: variant?.name || 'Standard',
      quantity: Number(line.quantity),
      unitPrice,
      lineTotal: grossLine,
      cogsAmount: itemCogs,
      modifiers: (line.modifiers || []).map((m: any) => ({ id: m.id, name: m.name, priceDelta: Number(m.priceDelta || 0) })),
      kitchenNotes: line.kitchenNotes || null,
    });
  }

  const discount = round2(Number(dto.discountAmount || 0));
  const totalAmount = round2(Math.max(0, subtotal + totalTax - discount));
  const paidSum = round2((dto.payments || []).reduce((s: number, p: any) => s + Number(p.amount || 0), 0));
  if (paidSum < totalAmount) {
    throw new Error(`Payment (${paidSum}) is less than order total (${totalAmount})`);
  }

  const preparedPayments = (dto.payments || []).map((p: any) => ({
    id: crypto.randomUUID(),
    method: p.method,
    amount: round2(Number(p.amount)),
    referenceNo: p.referenceNo || null,
    paidAt: soldAt,
  }));

  const saleLoc = snap.locations.find((l) => l.id === locDocId);
  const kdsEnabledForLoc = isLocationKdsEnabled(saleLoc);

  const saleDoc = {
    id: saleId,
    ownerUid: snap.uid,
    receiptNumber,
    clientTxnId: dto.clientTxnId || null,
    locationId: locDocId,
    cashierId: cashierDocId,
    customerId: dto.customerId ? toDocId(dto.customerId, snap.uid) : null,
    channel: dto.channel || 'WALK_IN',
    status: 'COMPLETED',
    kdsStatus: kdsEnabledForLoc ? 'PENDING' : 'COMPLETED',
    subtotal: round2(subtotal),
    discountAmount: discount,
    taxAmount: round2(totalTax),
    totalAmount,
    totalCogs: round2(totalCogs),
    notes: dto.notes || null,
    isOfflineSynced: Boolean(dto.isOfflineSynced),
    items: preparedItems,
    payments: preparedPayments,
    soldAt,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  const batch = writeBatch(db);
  batch.set(doc(db, 'sales', saleId), saleDoc);

  if (dto.customerId) {
    const custDocId = toDocId(dto.customerId, snap.uid);
    const cust = snap.customers.find((c) => c.id === custDocId);
    const pts = Math.floor(totalAmount / 50);
    if (cust && pts > 0) {
      batch.update(doc(db, 'customers', custDocId), {
        loyaltyPoints: Number(cust.loyaltyPoints || 0) + pts,
        updatedAt: serverTimestamp(),
      });
    }
  }

  const accByCode = new Map(snap.accounts.map((a) => [a.code, a.id]));
  const cashAcc = accByCode.get('1000');
  const bankAcc = accByCode.get('1010') || cashAcc;
  const invAcc = accByCode.get('1200');
  const taxAcc = accByCode.get('2100');
  const revAcc = accByCode.get('4000');
  const cogsAcc = accByCode.get('5000');

  if (cashAcc && invAcc && revAcc && cogsAcc) {
    const jeId = toDocId(crypto.randomUUID(), snap.uid);
    const lines: any[] = [];
    let rem = totalAmount;
    for (const p of preparedPayments) {
      if (rem <= 0) break;
      const settle = round2(Math.min(p.amount, rem));
      lines.push({
        id: crypto.randomUUID(),
        accountId: p.method === 'CASH' ? cashAcc : bankAcc!,
        debit: settle,
        credit: 0,
        memo: `${p.method} payment`,
      });
      rem = round2(rem - settle);
    }
    const netRev = round2(Math.max(0, subtotal - discount));
    lines.push({ id: crypto.randomUUID(), accountId: revAcc, debit: 0, credit: netRev, memo: 'Food & Beverage Sales' });
    if (totalTax > 0 && taxAcc) {
      lines.push({ id: crypto.randomUUID(), accountId: taxAcc, debit: 0, credit: round2(totalTax), memo: 'Output Tax Payable' });
    }
    if (totalCogs > 0) {
      lines.push({ id: crypto.randomUUID(), accountId: cogsAcc, debit: round2(totalCogs), credit: 0, memo: 'COGS Recognition' });
      lines.push({ id: crypto.randomUUID(), accountId: invAcc, debit: 0, credit: round2(totalCogs), memo: 'Inventory Asset Deduction' });
    }
    batch.set(doc(db, 'journal_entries', jeId), {
      id: jeId,
      ownerUid: snap.uid,
      entryNumber: `JE-POS-${receiptNumber}`,
      entryDate: soldAt,
      description: `POS Sale ${receiptNumber}`,
      referenceType: 'SALE',
      referenceId: saleId,
      isReversed: false,
      lines,
      createdAt: serverTimestamp(),
    });
  }

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `sales/${saleId}`);
  }

  await addAuditLog(snap.uid, user.id, user.fullName, 'POS_SALE', 'Sale', toLogicalId(saleId, snap.uid), {
    receiptNumber,
    totalAmount,
    totalCogs,
  });
  invalidateWorkspaceCache();

  return formatSaleDto({ ...saleDoc, createdAt: soldAt }, snap);
}

function formatSaleDto(s: any, snap: WorkspaceSnapshot) {
  const loc = snap.locations.find((l) => l.id === s.locationId);
  const truck = snap.foodTrucks.find((t) => t.locationId === s.locationId);
  const cashier = snap.erpUsers.find((u) => u.id === s.cashierId);
  const cust = s.customerId ? snap.customers.find((c) => c.id === s.customerId) : null;
  const logicalId = toLogicalId(s.id, snap.uid);

  return {
    id: logicalId,
    receipt_number: s.receiptNumber,
    client_txn_id: s.clientTxnId || null,
    location_id: toLogicalId(s.locationId, snap.uid),
    location_name: loc?.name || 'Location',
    location_address: loc?.address || truck?.currentSite || '',
    truck_site: truck?.currentSite || '',
    cashier_id: toLogicalId(s.cashierId, snap.uid),
    cashier_name: cashier?.fullName || 'Cashier',
    customer_id: s.customerId ? toLogicalId(s.customerId, snap.uid) : null,
    customer_name: cust?.fullName || null,
    channel: s.channel,
    status: s.status,
    kds_status: s.kdsStatus,
    subtotal: Number(s.subtotal),
    discount_amount: Number(s.discountAmount || 0),
    tax_amount: Number(s.taxAmount || 0),
    total_amount: Number(s.totalAmount),
    total_cogs: Number(s.totalCogs || 0),
    notes: s.notes || null,
    is_offline_synced: s.isOfflineSynced ? 1 : 0,
    sold_at: s.soldAt,
    items: (s.items || []).map((it: any) => ({
      id: it.id,
      sale_id: logicalId,
      product_id: toLogicalId(it.productId, snap.uid),
      variant_id: it.variantId || null,
      product_name: it.productName,
      variant_name: it.variantName || 'Standard',
      quantity: Number(it.quantity),
      unit_price: Number(it.unitPrice),
      line_total: Number(it.lineTotal),
      cogs_amount: Number(it.cogsAmount || 0),
      modifiers_json: JSON.stringify(it.modifiers || []),
      kitchen_notes: it.kitchenNotes || null,
    })),
    payments: (s.payments || []).map((p: any) => ({
      id: p.id,
      sale_id: logicalId,
      method: p.method,
      amount: Number(p.amount),
      reference_no: p.referenceNo || null,
      paid_at: p.paidAt,
    })),
  };
}

// =====================================================
// MAIN API ROUTER OVER FIRESTORE
// =====================================================
export async function firestoreApiRequest<T = any>(rawPath: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const [pathname, queryString = ''] = rawPath.split('?');
  const qs = new URLSearchParams(queryString);
  const body = options.body ? JSON.parse(String(options.body)) : {};

  const snap = await loadSnapshot();
  const uid = snap.uid;

  const recordFailureAndThrow = async (found: any, action: string, baseMsg: string) => {
    const prevFails = Number(found.failedLoginAttempts || 0);
    const nextFails = prevFails + 1;
    const isNowLocked = nextFails >= MAX_FAILED_LOGIN_ATTEMPTS;
    const lockedUntilIso = isNowLocked ? new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString() : null;
    try {
      await updateDoc(doc(db, 'erp_users', found.id), {
        failedLoginAttempts: isNowLocked ? MAX_FAILED_LOGIN_ATTEMPTS : nextFails,
        lockedUntil: lockedUntilIso,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `erp_users/${found.id}`);
    }
    const logicalId = toLogicalId(found.id, uid);
    await addAuditLog(uid, logicalId, found.fullName, isNowLocked ? 'ACCOUNT_LOCKED' : action, 'User', logicalId, {
      attempts: nextFails,
      lockedUntil: lockedUntilIso,
    });
    invalidateWorkspaceCache();
    if (isNowLocked) {
      throw new Error('Too many failed attempts. Account locked for 5 minutes.');
    }
    const remaining = MAX_FAILED_LOGIN_ATTEMPTS - nextFails;
    throw new Error(`${baseMsg} (${remaining} attempt${remaining === 1 ? '' : 's'} left before 5m lockout)`);
  };

  const resetFailuresIfNeeded = async (found: any) => {
    if (Number(found.failedLoginAttempts || 0) > 0 || found.lockedUntil) {
      try {
        await updateDoc(doc(db, 'erp_users', found.id), {
          failedLoginAttempts: 0,
          lockedUntil: null,
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `erp_users/${found.id}`);
      }
    }
  };

  // 1. AUTH ROUTES
  if (pathname === '/auth/operators' && method === 'GET') {
    const fbEmail = (auth.currentUser?.email || '').trim().toLowerCase();
    const active = snap.erpUsers
      .filter((u) => u.isActive)
      .sort((a, b) => {
        const rank = (c: string) => (c === 'SUPER_ADMIN' ? 0 : c === 'BUSINESS_OWNER' ? 1 : 2);
        const rDiff = rank(a.roleCode) - rank(b.roleCode);
        return rDiff !== 0 ? rDiff : String(a.fullName).localeCompare(String(b.fullName));
      })
      .map((u) => {
        const lockRemaining = getLockRemainingMs(u);
        return {
          id: toLogicalId(u.id, uid),
          full_name: u.fullName,
          avatar_url: u.avatarUrl || null,
          role_code: u.roleCode,
          role_name: u.roleName,
          assigned_location_id: u.assignedLocationId ? toLogicalId(u.assignedLocationId, uid) : null,
          has_pin: Boolean(u.shiftPinHash),
          is_locked: lockRemaining > 0,
          locked_until: lockRemaining > 0 ? u.lockedUntil : null,
          is_google_owner: Boolean(fbEmail && String(u.email || '').toLowerCase() === fbEmail),
        };
      });
    return active as T;
  }

  if (pathname === '/auth/login' && method === 'POST') {
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!email || !password) throw new Error('Work email and password are required');
    const found = snap.erpUsers.find((u) => String(u.email || '').toLowerCase() === email && u.isActive);
    if (!found) {
      throw new Error('Invalid email or password');
    }
    const lockRemaining = getLockRemainingMs(found);
    if (lockRemaining > 0) {
      throw new Error(`Account temporarily locked. Try again in ${formatLockDuration(lockRemaining)} or ask an Owner/Admin to unlock.`);
    }
    if (!(await verifyPassword(password, found.passwordHash))) {
      await recordFailureAndThrow(found, 'LOGIN_FAILED', 'Invalid email or password.');
    }
    await resetFailuresIfNeeded(found);
    const authUser = toAuthUser(found, snap);
    setSignedOutSession(false);
    setActiveErpUserId(authUser.id);
    await addAuditLog(uid, authUser.id, authUser.fullName, 'LOGIN', 'Session', authUser.id);
    invalidateWorkspaceCache();
    return { token: 'firebase-session', user: authUser } as T;
  }

  if (pathname === '/auth/pin-login' && method === 'POST') {
    const targetId = String(body.userId || '').trim();
    const pin = String(body.pin || '').trim();
    if (!targetId) throw new Error('Select an operator first');
    if (!/^\d{4,6}$/.test(pin)) throw new Error('Enter a valid 4–6 digit Shift PIN');
    const found = snap.erpUsers.find((u) => (toLogicalId(u.id, uid) === targetId || u.id === targetId) && u.isActive);
    if (!found) throw new Error('Operator account not found or inactive');

    const lockRemaining = getLockRemainingMs(found);
    if (lockRemaining > 0) {
      throw new Error(`Operator locked for ${formatLockDuration(lockRemaining)} due to repeated failed attempts.`);
    }
    if (!found.shiftPinHash) {
      throw new Error(`No Shift PIN is configured for ${found.fullName}. Use Work Email & Password or set a PIN in User Control.`);
    }
    if (!(await verifyShiftPin(found.id, pin, found.shiftPinHash))) {
      await recordFailureAndThrow(found, 'PIN_LOGIN_FAILED', 'Incorrect Shift PIN.');
    }
    await resetFailuresIfNeeded(found);
    const authUser = toAuthUser(found, snap);
    setSignedOutSession(false);
    setActiveErpUserId(authUser.id);
    await addAuditLog(uid, authUser.id, authUser.fullName, 'PIN_LOGIN', 'Session', authUser.id, { role: authUser.roleCode });
    invalidateWorkspaceCache();
    return { token: 'firebase-session', user: authUser } as T;
  }

  if (pathname === '/auth/google-sso' && method === 'POST') {
    const fbEmail = (auth.currentUser?.email || '').trim().toLowerCase();
    if (!fbEmail || !auth.currentUser?.emailVerified) {
      throw new Error('Verified Google session is required');
    }
    const found = snap.erpUsers.find((u) => String(u.email || '').toLowerCase() === fbEmail && u.isActive);
    if (!found) {
      throw new Error(`No active ERP operator account matches ${fbEmail}`);
    }
    const lockRemaining = getLockRemainingMs(found);
    if (lockRemaining > 0) {
      throw new Error(`Account temporarily locked. Try again in ${formatLockDuration(lockRemaining)}.`);
    }
    await resetFailuresIfNeeded(found);
    const authUser = toAuthUser(found, snap);
    setSignedOutSession(false);
    setActiveErpUserId(authUser.id);
    await addAuditLog(uid, authUser.id, authUser.fullName, 'GOOGLE_SSO_LOGIN', 'Session', authUser.id);
    invalidateWorkspaceCache();
    return { token: 'firebase-session', user: authUser } as T;
  }

  if (pathname === '/auth/unlock' && method === 'POST') {
    const targetId = String(body.userId || '').trim();
    const mode = String(body.mode || 'password');
    const secret = String(body.secret || '');
    const found = snap.erpUsers.find((u) => (toLogicalId(u.id, uid) === targetId || u.id === targetId) && u.isActive);
    if (!found) throw new Error('Operator account not found');
    const lockRemaining = getLockRemainingMs(found);
    if (lockRemaining > 0) {
      throw new Error(`Terminal locked for ${formatLockDuration(lockRemaining)} due to failed attempts.`);
    }

    if (mode === 'google') {
      const fbEmail = (auth.currentUser?.email || '').trim().toLowerCase();
      if (!fbEmail || !auth.currentUser?.emailVerified || fbEmail !== String(found.email || '').toLowerCase()) {
        throw new Error('Google account does not match the locked operator');
      }
    } else if (mode === 'pin') {
      if (!found.shiftPinHash) throw new Error('No Shift PIN configured for this account');
      if (!(await verifyShiftPin(found.id, secret, found.shiftPinHash))) {
        await recordFailureAndThrow(found, 'UNLOCK_PIN_FAILED', 'Incorrect Shift PIN.');
      }
    } else {
      if (!secret || !(await verifyPassword(secret, found.passwordHash))) {
        await recordFailureAndThrow(found, 'UNLOCK_FAILED', 'Incorrect password.');
      }
    }

    await resetFailuresIfNeeded(found);
    const authUser = toAuthUser(found, snap);
    await addAuditLog(uid, authUser.id, authUser.fullName, 'SESSION_UNLOCK', 'Session', authUser.id, { mode });
    invalidateWorkspaceCache();
    return { ok: true, user: authUser } as T;
  }

  if (pathname === '/auth/logout' && method === 'POST') {
    const current = resolveOptionalErpUser(snap);
    if (current) {
      await addAuditLog(uid, current.id, current.fullName, 'LOGOUT', 'Session', current.id).catch(() => {});
    }
    setActiveErpUserId(null);
    setSignedOutSession(true);
    return { ok: true } as T;
  }

  // Pre-login workspace endpoints (safe with Firebase Cloud Auth; required by LoginView & Attendance Kiosk)
  if (pathname === '/locations' && method === 'GET') {
    const rows = snap.locations
      .filter((l) => l.isActive)
      .sort((a, b) => String(a.type).localeCompare(String(b.type)) || String(a.name).localeCompare(String(b.name)))
      .map((l) => ({
        id: toLogicalId(l.id, uid),
        code: l.code,
        name: l.name,
        type: l.type,
        address: l.address || '',
        is_active: l.isActive ? 1 : 0,
        kds_enabled: isLocationKdsEnabled(l) ? 1 : 0,
        daily_sales_target: Number(l.dailySalesTarget ?? (l.type === 'FOOD_TRUCK' ? (l.code === 'TRK-02' ? 12000 : 15000) : 5000)),
      }));
    return rows as T;
  }

  if (pathname === '/attendance/kiosk' && method === 'GET') {
    const locMap = new Map(snap.locations.map((l) => [l.id, l]));
    const empMap = new Map(snap.employees.map((e) => [e.id, e]));

    const employees = [...snap.employees]
      .sort((a, b) => String(a.employeeCode).localeCompare(String(b.employeeCode)))
      .map((e) => ({
        id: toLogicalId(e.id, uid),
        employee_code: e.employeeCode,
        full_name: e.fullName,
        department: e.department,
        position: e.position,
        location_id: e.locationId ? toLogicalId(e.locationId, uid) : null,
        location_name: e.locationId ? locMap.get(e.locationId)?.name || '' : '',
        avatar_url: e.avatarUrl || null,
        face_descriptor_json: e.faceDescriptorJson || null,
        face_enrolled_at: e.faceEnrolledAt || null,
        has_pin: Boolean(String(e.attendancePin || '').trim()),
        is_active: e.isActive ? 1 : 0,
      }));

    const attendance = [...snap.attendanceLogs]
      .sort((a, b) => String(b.clockIn).localeCompare(String(a.clockIn)))
      .slice(0, 60)
      .map((a) => {
        const emp = empMap.get(a.employeeId);
        const resolvedLocId = a.locationId || emp?.locationId || null;
        return {
          id: toLogicalId(a.id, uid),
          employee_id: toLogicalId(a.employeeId, uid),
          clock_in: a.clockIn,
          clock_out: a.clockOut,
          worked_hours: Number(a.workedHours || 0),
          overtime_hours: Number(a.overtimeHours || 0),
          status: a.status,
          verification_method: a.verificationMethod || 'MANUAL',
          match_confidence: a.matchConfidence ?? null,
          clock_in_photo: a.clockInPhoto || null,
          clock_out_photo: a.clockOutPhoto || null,
          full_name: emp?.fullName || '',
          employee_code: emp?.employeeCode || '',
          employee_avatar_url: emp?.avatarUrl || null,
          location_id: resolvedLocId ? toLogicalId(resolvedLocId, uid) : null,
          location_name: resolvedLocId ? locMap.get(resolvedLocId)?.name || 'Commissary HQ' : 'Commissary HQ',
        };
      });

    return { employees, attendance } as T;
  }

  if (pathname === '/hr/attendance/clock' && method === 'POST') {
    const {
      employeeId,
      action = 'AUTO',
      overtimeHours,
      locationId,
      verificationMethod = 'MANUAL',
      matchConfidence = null,
      snapshotPhoto = null,
      pinCode,
      status: requestedStatus,
      notes,
    } = body || {};
    const empDocId = toDocId(employeeId, uid);
    const emp = snap.employees.find((e) => e.id === empDocId);
    if (!emp) throw new Error('Employee not found');

    const methodCode = ['FACE_SCAN', 'PIN_FALLBACK', 'MANUAL'].includes(String(verificationMethod).toUpperCase())
      ? String(verificationMethod).toUpperCase()
      : 'MANUAL';

    let actorUser = resolveOptionalErpUser(snap);
    if (methodCode === 'MANUAL') {
      actorUser = resolveCurrentErpUser(snap);
      assertPerm(actorUser, PERMISSIONS.HR_MANAGE);
    }

    if (methodCode === 'PIN_FALLBACK') {
      const configuredPin = String(emp.attendancePin || '').trim();
      const submittedPin = String(pinCode || '').trim();
      if (!configuredPin) {
        throw new Error(`No Attendance PIN is configured for ${emp.fullName}. Set one in Edit Employee first.`);
      }
      if (!submittedPin || submittedPin !== configuredPin) {
        throw new Error('Incorrect Attendance PIN');
      }
    }

    const openLog = [...snap.attendanceLogs]
      .filter((a) => a.employeeId === empDocId && !a.clockOut)
      .sort((a, b) => String(b.clockIn).localeCompare(String(a.clockIn)))[0];

    const resolvedAction = action === 'AUTO' ? (openLog ? 'CLOCK_OUT' : 'CLOCK_IN') : action;
    const nowIso = new Date().toISOString();
    const confidenceVal =
      matchConfidence !== null && matchConfidence !== undefined && Number.isFinite(Number(matchConfidence))
        ? Math.max(0, Math.min(100, Math.round(Number(matchConfidence))))
        : null;
    const safePhoto = snapshotPhoto ? String(snapshotPhoto).slice(0, 120000) : null;
    const actorId = actorUser?.id || 'kiosk_terminal';
    const actorName = actorUser?.fullName || 'Attendance Kiosk';

    if (resolvedAction === 'CLOCK_IN') {
      if (openLog) {
        throw new Error(`${emp.fullName} is already clocked in (since ${openLog.clockIn})`);
      }
      const id = toDocId(crypto.randomUUID(), uid);
      const nextStatus = requestedStatus === 'LATE' ? 'LATE' : 'PRESENT';
      const resolvedLocDocId = locationId ? toDocId(String(locationId), uid) : emp.locationId || null;
      try {
        await setDoc(doc(db, 'attendance_logs', id), {
          id,
          ownerUid: uid,
          employeeId: empDocId,
          locationId: resolvedLocDocId,
          clockIn: nowIso,
          clockOut: null,
          workedHours: 0,
          overtimeHours: 0,
          status: nextStatus,
          verificationMethod: methodCode,
          matchConfidence: confidenceVal,
          clockInPhoto: safePhoto,
          clockOutPhoto: null,
          notes: notes ? String(notes).slice(0, 300) : methodCode === 'PIN_FALLBACK' ? 'PIN fallback punch' : null,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, `attendance_logs/${id}`);
      }
      await addAuditLog(uid, actorId, actorName, `${methodCode}_CLOCK_IN`, 'AttendanceLog', toLogicalId(id, uid), {
        employeeName: emp.fullName,
        employeeCode: emp.employeeCode,
        locationId: resolvedLocDocId ? toLogicalId(resolvedLocDocId, uid) : null,
        confidence: confidenceVal,
        status: nextStatus,
      });
      invalidateWorkspaceCache();
      return {
        id: toLogicalId(id, uid),
        action: 'CLOCK_IN',
        employeeId: toLogicalId(emp.id, uid),
        employeeName: emp.fullName,
        employeeCode: emp.employeeCode,
        clockIn: nowIso,
        clockOut: null,
        workedHours: 0,
        overtimeHours: 0,
        status: nextStatus,
        verificationMethod: methodCode,
        matchConfidence: confidenceVal,
      } as T;
    }

    if (!openLog) throw new Error(`No active clock-in found for ${emp.fullName}`);
    const elapsedHrs = Math.max(0, round2((new Date(nowIso).getTime() - new Date(openLog.clockIn).getTime()) / 3600000));
    const resolvedOt =
      overtimeHours !== undefined && overtimeHours !== null
        ? Math.max(0, round2(Number(overtimeHours)))
        : Math.max(0, round2(elapsedHrs - 8));

    const updatePayload: Record<string, any> = {
      clockOut: nowIso,
      workedHours: elapsedHrs,
      overtimeHours: resolvedOt,
      updatedAt: serverTimestamp(),
    };
    if (safePhoto) updatePayload.clockOutPhoto = safePhoto;
    if (notes) updatePayload.notes = String(notes).slice(0, 300);

    try {
      await updateDoc(doc(db, 'attendance_logs', openLog.id), updatePayload);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `attendance_logs/${openLog.id}`);
    }
    await addAuditLog(uid, actorId, actorName, `${methodCode}_CLOCK_OUT`, 'AttendanceLog', toLogicalId(openLog.id, uid), {
      employeeName: emp.fullName,
      employeeCode: emp.employeeCode,
      workedHours: elapsedHrs,
      overtimeHours: resolvedOt,
      confidence: confidenceVal,
    });
    invalidateWorkspaceCache();
    return {
      id: toLogicalId(openLog.id, uid),
      action: 'CLOCK_OUT',
      employeeId: toLogicalId(emp.id, uid),
      employeeName: emp.fullName,
      employeeCode: emp.employeeCode,
      clockIn: openLog.clockIn,
      clockOut: nowIso,
      workedHours: elapsedHrs,
      overtimeHours: resolvedOt,
      status: openLog.status,
      verificationMethod: methodCode,
      matchConfidence: confidenceVal,
    } as T;
  }

  if (pathname === '/terminal/device-check' && method === 'POST') {
    const hardwareUuid = String(body?.hardwareUuid || '').trim();
    const userAgentSummary = body?.userAgentSummary ? String(body.userAgentSummary).trim().slice(0, 160) : null;
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(hardwareUuid)) {
      return { registered: false, status: 'UNREGISTERED' } as T;
    }
    const existing = snap.terminalDevices.find((d) => String(d.hardwareUuid || '').trim() === hardwareUuid);
    if (!existing) {
      return { registered: false, status: 'UNREGISTERED' } as T;
    }
    const locMap = new Map(snap.locations.map((l) => [l.id, l]));
    if (existing.status === 'AUTHORIZED') {
      const nowIso = new Date().toISOString();
      const lastSeenMs = existing.lastSeenAt ? new Date(existing.lastSeenAt).getTime() : 0;
      if (!Number.isFinite(lastSeenMs) || Date.now() - lastSeenMs > 60_000) {
        try {
          await updateDoc(doc(db, 'terminal_devices', existing.id), {
            lastSeenAt: nowIso,
            ...(userAgentSummary ? { userAgentSummary } : {}),
            updatedAt: serverTimestamp(),
          });
          existing.lastSeenAt = nowIso;
          if (userAgentSummary) existing.userAgentSummary = userAgentSummary;
        } catch {
          // non-fatal heartbeat update
        }
      }
    }
    return {
      registered: true,
      status: existing.status === 'REVOKED' ? 'REVOKED' : 'AUTHORIZED',
      device: mapTerminalDevice(existing, uid, locMap),
    } as T;
  }

  const user = resolveCurrentErpUser(snap);

  if (pathname === '/auth/me' && method === 'GET') {
    return user as T;
  }

  if (pathname === '/notifications' && method === 'GET') {
    const rawLoc = (qs.get('locationId') || '').trim();
    const locFilter = rawLoc && rawLoc !== 'ALL' ? toDocId(rawLoc, uid) : '';
    const locMap = new Map(snap.locations.map((l) => [l.id, l]));
    const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const resolveNotifLocationId = (n: any): string => {
      if (n.locationId) {
        const direct = String(n.locationId);
        if (locMap.has(direct)) return direct;
        const asDoc = toDocId(direct, uid);
        if (locMap.has(asDoc)) return asDoc;
      }

      const text = `${n.title || ''} ${n.message || ''}`;
      const lowerText = text.toLowerCase();

      for (const l of snap.locations) {
        const fullName = String(l.name || '').trim().toLowerCase();
        if (fullName && lowerText.includes(fullName)) return l.id;

        const shortPrefix = fullName.split(/\s*[—\-]\s*/)[0]?.trim();
        if (shortPrefix && shortPrefix.length >= 4) {
          const rx = new RegExp(`(^|[^a-z0-9])${escapeRx(shortPrefix)}([^a-z0-9]|$)`, 'i');
          if (rx.test(text)) return l.id;
        }

        const code = String(l.code || '').trim();
        if (code && new RegExp(`(^|[^a-z0-9])${escapeRx(code)}([^a-z0-9]|$)`, 'i').test(text)) {
          return l.id;
        }
      }

      for (const po of snap.purchaseOrders) {
        if (po.poNumber && text.includes(po.poNumber) && po.locationId) {
          return po.locationId;
        }
      }

      for (const b of snap.stockBatches) {
        if (b.batchNumber && text.includes(b.batchNumber) && b.locationId) {
          return b.locationId;
        }
      }

      if (n.type === 'LOW_STOCK' || n.type === 'SAFETY_STOCK') {
        const match = String(n.title || '').match(/^(?:Low Stock|Safety Stock Breach):\s*(.+?)(?:\s*\([^)]+\))?$/i);
        const itemName = match?.[1]?.trim().toLowerCase();
        const item = itemName
          ? snap.inventoryItems.find((it) => String(it.name || '').trim().toLowerCase() === itemName)
          : null;
        if (item) {
          const recentOutTxn = [...snap.inventoryTxns]
            .filter((t) => t.inventoryItemId === item.id && String(t.txnType || '').startsWith('OUT_'))
            .sort((a, b) => String(b.txnDate || tsToIso(b.createdAt)).localeCompare(String(a.txnDate || tsToIso(a.createdAt))))[0];
          if (recentOutTxn?.locationId) return recentOutTxn.locationId;

          const lowLocs = snap.locations.filter((l) => {
            const locQty = snap.stockBatches
              .filter((b) => b.inventoryItemId === item.id && b.locationId === l.id)
              .reduce((s, b) => s + Number(b.remainingQty || 0), 0);
            const ev = evaluateIngredientThreshold({
              onHandQty: locQty,
              safetyStock: Number(item.minStockLevel || 0),
              reorderPoint: Number(item.reorderPoint || 0),
            });
            return ev.status !== 'NOMINAL';
          });
          if (lowLocs.length === 1) return lowLocs[0].id;
        }
      }

      if (n.type === 'CASH_VARIANCE') {
        const dateMatch = String(n.title || '').match(/\((\d{4}-\d{2}-\d{2})\)/);
        if (dateMatch?.[1]) {
          const dc = snap.dailyClosings.find((c) => c.businessDate === dateMatch[1]);
          if (dc?.locationId) return dc.locationId;
        }
      }

      return '';
    };

    const rows = [...snap.notifications]
      .map((n) => ({ n, resolvedLocId: resolveNotifLocationId(n) }))
      .filter(({ resolvedLocId }) => !locFilter || resolvedLocId === locFilter)
      .sort((a, b) => Number(a.n.isRead) - Number(b.n.isRead) || tsToIso(b.n.createdAt).localeCompare(tsToIso(a.n.createdAt)))
      .slice(0, 30)
      .map(({ n, resolvedLocId }) => ({
        id: toLogicalId(n.id, uid),
        type: n.type,
        severity: n.severity,
        title: n.title,
        message: n.message,
        location_id: resolvedLocId ? toLogicalId(resolvedLocId, uid) : null,
        location_name: resolvedLocId ? locMap.get(resolvedLocId)?.name || '' : '',
        is_read: n.isRead ? 1 : 0,
        created_at: tsToIso(n.createdAt),
      }));
    return rows as T;
  }

  if (pathname.startsWith('/notifications/') && pathname.endsWith('/read') && method === 'POST') {
    const id = pathname.split('/')[2];
    const docId = toDocId(id, uid);
    try {
      await updateDoc(doc(db, 'notifications', docId), { isRead: true, updatedAt: serverTimestamp() });
      invalidateWorkspaceCache();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `notifications/${docId}`);
    }
    return { ok: true } as T;
  }

  // 1B. DAILY HUDDLE OPERATIONAL BRIEFINGS (MANAGER BROADCAST -> POS / KDS / MOBILE)
  if (pathname === '/huddles' && method === 'GET') {
    const rows = sortDailyHuddles(snap.dailyHuddles.map((h) => toDailyHuddleItem(h, uid)));
    return rows as T;
  }

  if (pathname === '/huddles' && method === 'POST') {
    if (!canBroadcastDailyHuddle(user)) {
      throw new Error('Only managers or administrators can broadcast Daily Huddle briefings');
    }
    const cleanTitle = String(body.title || '').trim().slice(0, 140);
    const cleanMessage = String(body.message || '').trim().slice(0, 800);
    if (!cleanTitle) throw new Error('Briefing title is required');
    if (!cleanMessage) throw new Error('Briefing message is required');

    const rawPriority = String(body.priority || 'NORMAL').toUpperCase();
    const priority: HuddlePriority =
      rawPriority === 'CRITICAL' ? 'CRITICAL' : rawPriority === 'URGENT' ? 'URGENT' : 'NORMAL';

    const rawShift = String(body.shiftWindow || 'ALL_DAY').toUpperCase();
    const shiftWindow: HuddleShiftWindow =
      rawShift === 'OPENING' || rawShift === 'MID_DAY' || rawShift === 'CLOSING' ? rawShift : 'ALL_DAY';

    const reqChannels: unknown[] = Array.isArray(body.targetChannels) ? body.targetChannels : ALL_HUDDLE_CHANNELS;
    const validChannels: HuddleChannel[] = Array.from(
      new Set<HuddleChannel>(
        reqChannels
          .map((c: unknown) => String(c || '').toUpperCase())
          .filter((c: string): c is HuddleChannel => c === 'POS' || c === 'KDS' || c === 'MOBILE'),
      ),
    ).slice(0, 3);
    const targetChannels: HuddleChannel[] = validChannels.length > 0 ? validChannels : [...ALL_HUDDLE_CHANNELS];

    const rawLocId = String(body.locationId || '').trim();
    const targetLocDocId = rawLocId && rawLocId !== 'ALL' ? toDocId(rawLocId, uid) : null;
    const targetLoc = targetLocDocId ? snap.locations.find((l) => l.id === targetLocDocId) : null;
    const locationName = targetLoc ? String(targetLoc.name).slice(0, 140) : null;

    const ttlHoursRaw = Number(body.ttlHours ?? 18);
    const expiresAt =
      Number.isFinite(ttlHoursRaw) && ttlHoursRaw > 0
        ? new Date(Date.now() + Math.min(168, Math.max(1, ttlHoursRaw)) * 3600000).toISOString()
        : null;

    const logicalId = crypto.randomUUID();
    const docId = toDocId(logicalId, uid);
    const safeAuthorId = String(user.id || 'usr_manager').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128) || 'usr_manager';

    const docObj = {
      id: docId,
      ownerUid: uid,
      title: cleanTitle,
      message: cleanMessage,
      priority,
      targetChannels,
      locationId: targetLoc ? targetLoc.id : null,
      locationName,
      shiftWindow,
      authorId: safeAuthorId,
      authorName: String(user.fullName || 'Manager').trim().slice(0, 150) || 'Manager',
      authorRole: String(user.roleName || user.roleCode || 'Manager').trim().slice(0, 80) || 'Manager',
      acknowledgedBy: [safeAuthorId],
      isPinned: body.isPinned !== false,
      isActive: true,
      expiresAt,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    try {
      await setDoc(doc(db, 'daily_huddles', docId), docObj);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `daily_huddles/${docId}`);
    }

    if (priority === 'CRITICAL') {
      await addNotificationIfMissing(
        snap,
        'DAILY_HUDDLE',
        'CRITICAL',
        `Daily Huddle: ${cleanTitle}`,
        cleanMessage.slice(0, 480),
        targetLoc ? targetLoc.id : null,
        { onlyIfNeverNotified: true },
      );
    }

    await addAuditLog(uid, user.id, user.fullName, 'BROADCAST_DAILY_HUDDLE', 'DailyHuddle', logicalId, {
      title: cleanTitle,
      priority,
      channels: targetChannels.join(','),
      location: locationName || 'All Locations',
    });
    invalidateWorkspaceCache();
    return toDailyHuddleItem(
      { ...docObj, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      uid,
    ) as T;
  }

  if (pathname.startsWith('/huddles/') && pathname.endsWith('/acknowledge') && method === 'POST') {
    const logicalId = pathname.split('/')[2];
    const docId = toDocId(logicalId, uid);
    const existing = snap.dailyHuddles.find((h) => h.id === docId);
    if (!existing) throw new Error('Daily Huddle briefing not found');
    const safeActorId = String(user.id || 'usr_staff').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128) || 'usr_staff';
    const currentAck = Array.isArray(existing.acknowledgedBy) ? existing.acknowledgedBy.map((x: unknown) => String(x)) : [];
    if (!currentAck.includes(safeActorId)) {
      const nextAck = [...currentAck, safeActorId].slice(0, 100);
      try {
        await updateDoc(doc(db, 'daily_huddles', docId), {
          acknowledgedBy: nextAck,
          updatedAt: serverTimestamp(),
        });
        existing.acknowledgedBy = nextAck;
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `daily_huddles/${docId}`);
      }
    }
    invalidateWorkspaceCache();
    return { ok: true, acknowledgedBy: existing.acknowledgedBy || [safeActorId] } as T;
  }

  if (pathname.startsWith('/huddles/') && method === 'PATCH') {
    if (!canBroadcastDailyHuddle(user)) {
      throw new Error('Only managers or administrators can update Daily Huddle briefings');
    }
    const logicalId = pathname.split('/')[2];
    const docId = toDocId(logicalId, uid);
    const existing = snap.dailyHuddles.find((h) => h.id === docId);
    if (!existing) throw new Error('Daily Huddle briefing not found');

    const cleanTitle =
      body.title !== undefined ? String(body.title || '').trim().slice(0, 140) : String(existing.title || '');
    const cleanMessage =
      body.message !== undefined ? String(body.message || '').trim().slice(0, 800) : String(existing.message || '');
    if (!cleanTitle) throw new Error('Briefing title is required');
    if (!cleanMessage) throw new Error('Briefing message is required');

    const rawPriority = String(body.priority ?? existing.priority ?? 'NORMAL').toUpperCase();
    const priority: HuddlePriority =
      rawPriority === 'CRITICAL' ? 'CRITICAL' : rawPriority === 'URGENT' ? 'URGENT' : 'NORMAL';

    const rawShift = String(body.shiftWindow ?? existing.shiftWindow ?? 'ALL_DAY').toUpperCase();
    const shiftWindow: HuddleShiftWindow =
      rawShift === 'OPENING' || rawShift === 'MID_DAY' || rawShift === 'CLOSING' ? rawShift : 'ALL_DAY';

    let targetChannels: HuddleChannel[] = Array.isArray(existing.targetChannels)
      ? existing.targetChannels
      : [...ALL_HUDDLE_CHANNELS];
    if (Array.isArray(body.targetChannels)) {
      const nextCh: HuddleChannel[] = Array.from(
        new Set<HuddleChannel>(
          (body.targetChannels as unknown[])
            .map((c: unknown) => String(c || '').toUpperCase())
            .filter((c: string): c is HuddleChannel => c === 'POS' || c === 'KDS' || c === 'MOBILE'),
        ),
      ).slice(0, 3);
      if (nextCh.length > 0) targetChannels = nextCh;
    }

    let locationId = existing.locationId ?? null;
    let locationName = existing.locationName ?? null;
    if (body.locationId !== undefined) {
      const rawLoc = String(body.locationId || '').trim();
      if (!rawLoc || rawLoc === 'ALL') {
        locationId = null;
        locationName = null;
      } else {
        const locDocId = toDocId(rawLoc, uid);
        const loc = snap.locations.find((l) => l.id === locDocId);
        locationId = loc ? loc.id : null;
        locationName = loc ? String(loc.name).slice(0, 140) : null;
      }
    }

    const isPinned = body.isPinned !== undefined ? Boolean(body.isPinned) : Boolean(existing.isPinned);
    const isActive = body.isActive !== undefined ? Boolean(body.isActive) : Boolean(existing.isActive);
    const expiresAt =
      body.ttlHours !== undefined
        ? Number(body.ttlHours) > 0
          ? new Date(Date.now() + Math.min(168, Math.max(1, Number(body.ttlHours))) * 3600000).toISOString()
          : null
        : existing.expiresAt ?? null;

    try {
      await updateDoc(doc(db, 'daily_huddles', docId), {
        title: cleanTitle,
        message: cleanMessage,
        priority,
        targetChannels,
        locationId,
        locationName,
        shiftWindow,
        isPinned,
        isActive,
        expiresAt,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `daily_huddles/${docId}`);
    }

    await addAuditLog(uid, user.id, user.fullName, 'UPDATE_DAILY_HUDDLE', 'DailyHuddle', logicalId, {
      title: cleanTitle,
      isActive,
      isPinned,
    });
    invalidateWorkspaceCache();
    return { ok: true } as T;
  }

  if (pathname.startsWith('/huddles/') && method === 'DELETE') {
    if (!canBroadcastDailyHuddle(user)) {
      throw new Error('Only managers or administrators can delete Daily Huddle briefings');
    }
    const logicalId = pathname.split('/')[2];
    const docId = toDocId(logicalId, uid);
    const existing = snap.dailyHuddles.find((h) => h.id === docId);
    if (!existing) throw new Error('Daily Huddle briefing not found');
    try {
      await deleteDoc(doc(db, 'daily_huddles', docId));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `daily_huddles/${docId}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'DELETE_DAILY_HUDDLE', 'DailyHuddle', logicalId, {
      title: existing.title,
    });
    invalidateWorkspaceCache();
    return { ok: true } as T;
  }

  if (pathname === '/dashboard/summary' && method === 'GET') {
    assertPerm(user, PERMISSIONS.DASHBOARD_VIEW);
    const to = qs.get('to') || new Date().toISOString();
    const from = qs.get('from') || new Date(Date.now() - 30 * 86400000).toISOString();
    const rawLoc = (qs.get('locationId') || '').trim();
    const locFilter = rawLoc && rawLoc !== 'ALL' ? toDocId(rawLoc, uid) : '';

    const completedSales = snap.sales.filter(
      (s) => s.status === 'COMPLETED' && s.soldAt >= from && s.soldAt <= to && (!locFilter || s.locationId === locFilter),
    );
    const filteredExpenses = snap.expenses.filter(
      (e) => e.expenseDate >= from && e.expenseDate <= to && (!locFilter || e.locationId === locFilter),
    );

    const totalSales = round2(completedSales.reduce((s, r) => s + Number(r.totalAmount || 0), 0));
    const totalCogs = round2(completedSales.reduce((s, r) => s + Number(r.totalCogs || 0), 0));
    const totalExpenses = round2(filteredExpenses.reduce((s, r) => s + Number(r.amount || 0), 0));
    const grossProfit = round2(totalSales - totalCogs);
    const netProfit = round2(grossProfit - totalExpenses);
    const avgTicket = completedSales.length > 0 ? round2(totalSales / completedSales.length) : 0;
    const pendingPOs = snap.purchaseOrders.filter(
      (po) =>
        ['PENDING_APPROVAL', 'PENDING_MANAGER_SIGNATURE', 'APPROVED', 'PARTIAL', 'PARTIALLY_RECEIVED'].includes(po.status) &&
        (!locFilter || po.locationId === locFilter),
    ).length;

    const invRows = snap.inventoryItems.map((i) => {
      const batches = snap.stockBatches.filter((b) => b.inventoryItemId === i.id && (!locFilter || b.locationId === locFilter));
      const currentQty = round2(batches.reduce((s, b) => s + Number(b.remainingQty || 0), 0));
      const stockValue = round2(batches.reduce((s, b) => s + Number(b.remainingQty || 0) * Number(b.unitCost || 0), 0));
      return {
        id: toLogicalId(i.id, uid),
        sku: i.sku,
        name: i.name,
        uom: i.uomCode,
        reorder_point: Number(i.reorderPoint || 0),
        current_qty: currentQty,
        stock_value: stockValue,
      };
    });

    const inventoryValuation = round2(invRows.reduce((s, r) => s + r.stock_value, 0));
    const lowStockItems = invRows.filter((r) => r.current_qty <= r.reorder_point);

    const payMap = new Map<string, number>();
    for (const s of completedSales) {
      for (const p of s.payments || []) {
        payMap.set(p.method, round2((payMap.get(p.method) || 0) + Number(p.amount || 0)));
      }
    }
    const salesByPayment = Array.from(payMap.entries()).map(([method, total]) => ({ method, total }));

    const salesByLocation = snap.locations
      .filter((l) => l.isActive !== false && l.type === 'FOOD_TRUCK' && (!locFilter || l.id === locFilter))
      .map((l) => {
        const locSales = completedSales.filter((s) => s.locationId === l.id);
        return {
          id: toLogicalId(l.id, uid),
          name: l.name,
          orders: locSales.length,
          revenue: round2(locSales.reduce((s, r) => s + Number(r.totalAmount || 0), 0)),
          cogs: round2(locSales.reduce((s, r) => s + Number(r.totalCogs || 0), 0)),
        };
      });

    const prodAgg = new Map<string, { product_name: string; qty_sold: number; revenue: number; cogs: number }>();
    const catAgg = new Map<string, number>();
    const prodMap = new Map(snap.products.map((p) => [p.id, p]));
    const catMap = new Map(snap.categories.map((c) => [c.id, c]));

    for (const s of completedSales) {
      for (const it of s.items || []) {
        const prev = prodAgg.get(it.productId) || { product_name: it.productName, qty_sold: 0, revenue: 0, cogs: 0 };
        prev.qty_sold += Number(it.quantity || 0);
        prev.revenue = round2(prev.revenue + Number(it.lineTotal || 0));
        prev.cogs = round2(prev.cogs + Number(it.cogsAmount || 0));
        prodAgg.set(it.productId, prev);

        const prod = prodMap.get(it.productId);
        const catName = prod ? catMap.get(prod.categoryId)?.name || 'Other' : 'Other';
        catAgg.set(catName, round2((catAgg.get(catName) || 0) + Number(it.lineTotal || 0)));
      }
    }

    const topProducts = Array.from(prodAgg.values())
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 6);
    const salesByCategory = Array.from(catAgg.entries())
      .map(([category, revenue]) => ({ category, revenue }))
      .sort((a, b) => b.revenue - a.revenue);

    const trendMap = new Map<string, { day: string; revenue: number; cogs: number; orders: number }>();
    for (const s of completedSales) {
      const day = String(s.soldAt).slice(0, 10);
      const prev = trendMap.get(day) || { day, revenue: 0, cogs: 0, orders: 0 };
      prev.revenue = round2(prev.revenue + Number(s.totalAmount || 0));
      prev.cogs = round2(prev.cogs + Number(s.totalCogs || 0));
      prev.orders += 1;
      trendMap.set(day, prev);
    }
    const dailyTrends = Array.from(trendMap.values()).sort((a, b) => a.day.localeCompare(b.day));

    const cutoffIso = new Date(Date.now() + 4 * 86400000).toISOString();
    const itemMap = new Map(snap.inventoryItems.map((i) => [i.id, i]));
    const locMap = new Map(snap.locations.map((l) => [l.id, l]));
    const expiringBatches = snap.stockBatches
      .filter((b) => Number(b.remainingQty) > 0 && b.expiryDate && b.expiryDate <= cutoffIso && (!locFilter || b.locationId === locFilter))
      .sort((a, b) => String(a.expiryDate).localeCompare(String(b.expiryDate)))
      .map((b) => ({
        id: toLogicalId(b.id, uid),
        batch_number: b.batchNumber,
        remaining_qty: Number(b.remainingQty),
        expiry_date: b.expiryDate,
        item_name: itemMap.get(b.inventoryItemId)?.name || 'Item',
        uom: itemMap.get(b.inventoryItemId)?.uomCode || '',
        location_name: locMap.get(b.locationId)?.name || '',
      }));

    const toIso = (val: any) => {
      if (!val) return '';
      if (typeof val === 'string') return val;
      if (typeof val?.toDate === 'function') return val.toDate().toISOString();
      return '';
    };

    const nowDate = new Date();
    const fallbackTodayStart = new Date(nowDate);
    fallbackTodayStart.setUTCHours(0, 0, 0, 0);
    const todayFrom = qs.get('todayFrom') || fallbackTodayStart.toISOString();
    const todayTo = qs.get('todayTo') || nowDate.toISOString();
    const yesterdayFrom = qs.get('yesterdayFrom') || new Date(new Date(todayFrom).getTime() - 86400000).toISOString();
    const yesterdayTo = qs.get('yesterdayTo') || new Date(new Date(todayFrom).getTime() - 1).toISOString();

    const calcPctChange = (current: number, previous: number) => {
      if (previous > 0) return round2(((current - previous) / previous) * 100);
      if (current > 0) return 100;
      return 0;
    };

    const todayCompletedSales = snap.sales.filter(
      (s) => s.status === 'COMPLETED' && s.soldAt >= todayFrom && s.soldAt <= todayTo && (!locFilter || s.locationId === locFilter),
    );
    const yesterdayCompletedSales = snap.sales.filter(
      (s) => s.status === 'COMPLETED' && s.soldAt >= yesterdayFrom && s.soldAt <= yesterdayTo && (!locFilter || s.locationId === locFilter),
    );
    const todayRevenue = round2(todayCompletedSales.reduce((s, r) => s + Number(r.totalAmount || 0), 0));
    const yesterdayRevenue = round2(yesterdayCompletedSales.reduce((s, r) => s + Number(r.totalAmount || 0), 0));

    const pendingKdsSales = snap.sales.filter(
      (s) => s.status === 'COMPLETED' && s.kdsStatus !== 'COMPLETED' && (!locFilter || s.locationId === locFilter),
    );
    const yesterdayPendingKdsCount = snap.sales.filter(
      (s) =>
        s.status === 'COMPLETED' &&
        s.kdsStatus !== 'COMPLETED' &&
        s.soldAt >= yesterdayFrom &&
        s.soldAt <= yesterdayTo &&
        (!locFilter || s.locationId === locFilter),
    ).length;

    const empMapById = new Map(snap.employees.map((e) => [e.id, e]));
    const activeEmployeesCount = snap.employees.filter(
      (e) => e.isActive !== false && (!locFilter || e.locationId === locFilter),
    ).length;

    const todayDateA = todayFrom.slice(0, 10);
    const todayDateB = todayTo.slice(0, 10);
    const yestDateA = yesterdayFrom.slice(0, 10);
    const yestDateB = yesterdayTo.slice(0, 10);

    const todayAttLogs = snap.attendanceLogs.filter((a) => {
      const emp = empMapById.get(a.employeeId);
      const effLoc = a.locationId || emp?.locationId || '';
      if (locFilter && effLoc !== locFilter) return false;
      const cin = String(a.clockIn || '');
      const cinDay = cin.slice(0, 10);
      return (cin >= todayFrom && cin <= todayTo) || cinDay === todayDateA || cinDay === todayDateB;
    });
    const clockedInToday = new Set(todayAttLogs.map((a) => a.employeeId)).size;
    const onShiftCount = new Set(todayAttLogs.filter((a) => !a.clockOut).map((a) => a.employeeId)).size;

    const yesterdayAttLogs = snap.attendanceLogs.filter((a) => {
      const emp = empMapById.get(a.employeeId);
      const effLoc = a.locationId || emp?.locationId || '';
      if (locFilter && effLoc !== locFilter) return false;
      const cin = String(a.clockIn || '');
      const cinDay = cin.slice(0, 10);
      return (cin >= yesterdayFrom && cin <= yesterdayTo) || cinDay === yestDateA || cinDay === yestDateB;
    });
    const clockedInYesterday = new Set(yesterdayAttLogs.map((a) => a.employeeId)).size;

    const todayDeltaByLogicalId = new Map<string, number>();
    for (const t of snap.inventoryTxns) {
      if (locFilter && t.locationId !== locFilter) continue;
      const tDate = String(t.txnDate || toIso(t.createdAt) || '');
      if (tDate >= todayFrom && tDate <= todayTo) {
        const lid = toLogicalId(t.inventoryItemId, uid);
        todayDeltaByLogicalId.set(lid, (todayDeltaByLogicalId.get(lid) || 0) + Number(t.quantityDelta || 0));
      }
    }
    const yesterdayAlertCount = invRows.filter((r) => {
      const prevQty = Number(r.current_qty || 0) - (todayDeltaByLogicalId.get(r.id) || 0);
      return prevQty <= Number(r.reorder_point || 0);
    }).length;
    const currentAlertCount = lowStockItems.length;

    return {
      kpis: { totalSales, grossProfit, netProfit, totalExpenses, txnCount: completedSales.length, avgTicket, inventoryValuation, pendingPOs },
      summaryCards: {
        totalRevenueToday: {
          value: todayRevenue,
          previousValue: yesterdayRevenue,
          pctChange: calcPctChange(todayRevenue, yesterdayRevenue),
          ordersToday: todayCompletedSales.length,
          comparisonLabel: 'vs yesterday',
        },
        pendingOrders: {
          value: pendingKdsSales.length,
          previousValue: yesterdayPendingKdsCount,
          pctChange: calcPctChange(pendingKdsSales.length, yesterdayPendingKdsCount),
          newCount: pendingKdsSales.filter((s) => s.kdsStatus === 'PENDING').length,
          preparingCount: pendingKdsSales.filter((s) => s.kdsStatus === 'PREPARING').length,
          readyCount: pendingKdsSales.filter((s) => s.kdsStatus === 'READY').length,
          pendingPOs,
          comparisonLabel: 'vs yesterday',
        },
        activeEmployees: {
          value: activeEmployeesCount,
          onShiftCount,
          clockedInToday,
          previousValue: clockedInYesterday,
          pctChange: calcPctChange(clockedInToday, clockedInYesterday),
          comparisonLabel: 'shift vs yesterday',
        },
        inventoryReorderAlerts: {
          value: currentAlertCount,
          previousValue: yesterdayAlertCount,
          pctChange: calcPctChange(currentAlertCount, yesterdayAlertCount),
          criticalOutCount: lowStockItems.filter((r) => Number(r.current_qty || 0) <= 0).length,
          comparisonLabel: 'vs yesterday',
        },
      },
      lowStockItems,
      expiringBatches,
      salesByPayment,
      salesByLocation,
      salesByCategory,
      topProducts,
      dailyTrends,
    } as T;
  }

  // 3. POS & KDS
  if (pathname === '/pos/catalog' && method === 'GET') {
    assertPerm(user, PERMISSIONS.POS_SELL);
    const categories = [...snap.categories]
      .filter((c) => c.showInPos !== false)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((c) => ({ id: toLogicalId(c.id, uid), name: c.name, sort_order: c.sortOrder, show_in_pos: true }));
    const visibleCatIds = new Set(categories.map((c) => c.id));
    const products = getProductCostingList(snap).filter((p) => p.is_available === 1 && visibleCatIds.has(p.category_id));
    const customers = [...snap.customers]
      .sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)))
      .map((c) => ({
        id: toLogicalId(c.id, uid),
        full_name: c.fullName,
        phone: c.phone,
        loyalty_points: c.loyaltyPoints,
        tier: c.tier,
      }));
    return { categories, products, customers } as T;
  }

  if (pathname === '/pos/sales' && method === 'GET') {
    assertPerm(user, PERMISSIONS.POS_SELL);
    const locFilter = qs.get('locationId') ? toDocId(qs.get('locationId')!, uid) : '';
    const rows = snap.sales
      .filter((s) => !locFilter || s.locationId === locFilter)
      .sort((a, b) => String(b.soldAt).localeCompare(String(a.soldAt)))
      .slice(0, 60)
      .map((s) => formatSaleDto(s, snap));
    return rows as T;
  }

  if (pathname === '/pos/sales' && method === 'POST') {
    assertPerm(user, PERMISSIONS.POS_SELL);
    return (await processSaleFirestore(snap, body, user)) as T;
  }

  if (pathname === '/pos/sales/sync-offline' && method === 'POST') {
    assertPerm(user, PERMISSIONS.POS_SELL);
    const list = Array.isArray(body?.sales) ? body.sales : [];
    const synced = [];
    for (const s of list) {
      synced.push(await processSaleFirestore(snap, { ...s, isOfflineSynced: true }, user));
    }
    return { syncedCount: synced.length, sales: synced } as T;
  }

  if (pathname.startsWith('/pos/sales/') && pathname.endsWith('/refund') && method === 'POST') {
    assertPerm(user, PERMISSIONS.POS_REFUND);
    const saleId = pathname.split('/')[3];
    const saleDocId = toDocId(saleId, uid);
    const sale = snap.sales.find((s) => s.id === saleDocId);
    if (!sale) throw new Error('Sale not found');
    if (sale.status === 'REFUNDED') throw new Error('Sale already refunded');

    const reason = String(body?.reason || 'Manager authorized refund');
    const nextNotes = `${sale.notes || ''} [REFUNDED: ${reason}]`.trim();

    const batch = writeBatch(db);
    batch.update(doc(db, 'sales', saleDocId), {
      status: 'REFUNDED',
      kdsStatus: 'CANCELLED',
      notes: nextNotes,
      updatedAt: serverTimestamp(),
    });

    const origJe = snap.journalEntries.find((je) => je.referenceType === 'SALE' && je.referenceId === saleDocId && !je.isReversed);
    if (origJe) {
      const revJeId = toDocId(crypto.randomUUID(), uid);
      batch.set(doc(db, 'journal_entries', revJeId), {
        id: revJeId,
        ownerUid: uid,
        entryNumber: `REV-${origJe.entryNumber}`,
        entryDate: new Date().toISOString(),
        description: `Refund Reversal: ${reason}`,
        referenceType: 'SALE_REFUND',
        referenceId: saleDocId,
        isReversed: false,
        lines: (origJe.lines || []).map((l: any) => ({
          id: crypto.randomUUID(),
          accountId: l.accountId,
          debit: Number(l.credit || 0),
          credit: Number(l.debit || 0),
          memo: `Reversal: ${l.memo || ''}`,
        })),
        createdAt: serverTimestamp(),
      });
    }

    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `sales/${saleDocId}`);
    }

    await addAuditLog(uid, user.id, user.fullName, 'REFUND_SALE', 'Sale', saleId, { receiptNumber: sale.receiptNumber, reason });
    invalidateWorkspaceCache();
    return { ...formatSaleDto({ ...sale, status: 'REFUNDED', kdsStatus: 'CANCELLED', notes: nextNotes }, snap) } as T;
  }

  if (pathname === '/kds/orders' && method === 'GET') {
    assertPerm(user, PERMISSIONS.KDS_MANAGE);
    const locFilter = qs.get('locationId') ? toDocId(qs.get('locationId')!, uid) : '';
    const kdsEnabledLocIds = new Set(
      snap.locations.filter((l) => l.isActive !== false && isLocationKdsEnabled(l)).map((l) => l.id),
    );
    const rows = snap.sales
      .filter(
        (s) =>
          s.status === 'COMPLETED' &&
          s.kdsStatus !== 'COMPLETED' &&
          kdsEnabledLocIds.has(s.locationId) &&
          (!locFilter || s.locationId === locFilter),
      )
      .sort((a, b) => String(a.soldAt).localeCompare(String(b.soldAt)))
      .map((s) => formatSaleDto(s, snap));
    return rows as T;
  }

  if (pathname.startsWith('/kds/orders/') && method === 'PATCH') {
    assertPerm(user, PERMISSIONS.KDS_MANAGE);
    const saleId = pathname.split('/')[3];
    const saleDocId = toDocId(saleId, uid);
    const kdsStatus = String(body.kdsStatus || '');
    if (!['PENDING', 'PREPARING', 'READY', 'COMPLETED'].includes(kdsStatus)) {
      throw new Error('Invalid KDS status');
    }
    try {
      await updateDoc(doc(db, 'sales', saleDocId), { kdsStatus, updatedAt: serverTimestamp() });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `sales/${saleDocId}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'KDS_STATUS', 'Sale', saleId, { kdsStatus });
    invalidateWorkspaceCache();
    return { ok: true, kdsStatus } as T;
  }

  // 4. PRODUCTS, CATEGORIES & BOM
  if (pathname === '/products' && method === 'GET') {
    assertPerm(user, PERMISSIONS.PRODUCT_MANAGE);
    return {
      products: getProductCostingList(snap),
      categories: [...snap.categories]
        .sort((a, b) => a.sortOrder - b.sortOrder || String(a.name).localeCompare(String(b.name)))
        .map((c) => ({ id: toLogicalId(c.id, uid), name: c.name, sort_order: c.sortOrder, show_in_pos: c.showInPos !== false })),
      inventoryItems: [...snap.inventoryItems]
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .map((i) => ({
          id: toLogicalId(i.id, uid),
          sku: i.sku,
          name: i.name,
          item_type: i.itemType,
          base_uom_id: i.baseUomId,
          uom_code: i.uomCode,
          costing_method: i.costingMethod,
          min_stock_level: i.minStockLevel,
          reorder_point: i.reorderPoint,
          last_unit_cost: i.lastUnitCost,
          weighted_avg_cost: i.weightedAvgCost,
        })),
      uoms: snap.meta?.uoms || [],
      taxConfigs: snap.taxConfigs.map((t) => ({
        id: toLogicalId(t.id, uid),
        code: t.code,
        name: t.name,
        rate_percent: t.ratePercent,
        is_inclusive: t.isInclusive ? 1 : 0,
        is_active: t.isActive ? 1 : 0,
      })),
    } as T;
  }

  if (pathname === '/products/menu-engineering' && method === 'GET') {
    assertPerm(user, PERMISSIONS.PRODUCT_MANAGE);
    const rawDays = (qs.get('days') || '30').trim().toLowerCase();
    const rawLoc = (qs.get('locationId') || 'ALL').trim();
    const rawCat = (qs.get('categoryId') || 'ALL').trim();
    const locFilter = rawLoc && rawLoc !== 'ALL' ? toDocId(rawLoc, uid) : '';
    const catFilter = rawCat && rawCat !== 'ALL' ? rawCat : '';

    let cutoffIso = '';
    if (rawDays !== 'all') {
      const daysNum = Math.min(365, Math.max(1, Math.round(Number(rawDays) || 30)));
      cutoffIso = new Date(Date.now() - daysNum * 24 * 60 * 60 * 1000).toISOString();
    }

    const salesByProduct = new Map<string, { unitsSold: number; realizedRevenue: number; realizedCogs: number }>();
    const matchingSales = snap.sales.filter(
      (s) =>
        s.status === 'COMPLETED' &&
        (!locFilter || s.locationId === locFilter) &&
        (!cutoffIso || String(s.soldAt || '') >= cutoffIso),
    );

    for (const sale of matchingSales) {
      for (const line of sale.items || []) {
        const logicalProdId = toLogicalId(String(line.productId || ''), uid);
        if (!logicalProdId) continue;
        const prev = salesByProduct.get(logicalProdId) || { unitsSold: 0, realizedRevenue: 0, realizedCogs: 0 };
        prev.unitsSold += Number(line.quantity || 0);
        prev.realizedRevenue += Number(line.lineTotal || 0);
        prev.realizedCogs += Number(line.cogsAmount || 0);
        salesByProduct.set(logicalProdId, prev);
      }
    }

    const costingProducts = getProductCostingList(snap).filter((p) => {
      if (!catFilter) return true;
      return p.category_id === catFilter || toDocId(p.category_id, uid) === toDocId(catFilter, uid);
    });

    const report = analyzeMenuEngineering(
      costingProducts.map((p) => {
        const agg = salesByProduct.get(p.id) || { unitsSold: 0, realizedRevenue: 0, realizedCogs: 0 };
        return {
          productId: p.id,
          sku: p.sku,
          name: p.name,
          imageUrl: p.image_url,
          categoryId: p.category_id,
          categoryName: p.category_name,
          isAvailable: p.is_available === 1,
          sellingPrice: Number(p.base_price || 0),
          ingredientCost: Number(p.costing.ingredientCost || 0),
          packagingCost: Number(p.costing.packagingCost || 0),
          directLaborCost: Number(p.costing.directLaborCost || 0),
          unitDirectCost: Number(p.costing.directCost || 0),
          targetFoodCostPct: Number(p.target_food_cost_pct || 35),
          unitsSold: agg.unitsSold,
          realizedRevenue: round2(agg.realizedRevenue),
          realizedCogs: round2(agg.realizedCogs),
        };
      }),
    );

    const categories = [...snap.categories]
      .sort((a, b) => a.sortOrder - b.sortOrder || String(a.name).localeCompare(String(b.name)))
      .map((c) => ({ id: toLogicalId(c.id, uid), name: c.name }));

    return {
      ...report,
      categories,
      filters: {
        days: rawDays,
        locationId: rawLoc || 'ALL',
        categoryId: rawCat || 'ALL',
        ordersAnalyzed: matchingSales.length,
      },
    } as T;
  }

  if (pathname === '/categories' && method === 'POST') {
    assertPerm(user, PERMISSIONS.PRODUCT_MANAGE);
    const cleanName = String(body?.name || '').trim();
    if (!cleanName) throw new Error('Category name is required');
    if (snap.categories.some((c) => String(c.name).toLowerCase() === cleanName.toLowerCase())) {
      throw new Error(`Category "${cleanName}" already exists`);
    }
    const maxSort = snap.categories.reduce((m, c) => Math.max(m, Number(c.sortOrder || 0)), 0);
    const sortOrder = Math.round(body?.sortOrder !== undefined && body?.sortOrder !== '' ? Number(body.sortOrder) : maxSort + 1);
    const showInPos = body?.showInPos !== undefined ? Boolean(body.showInPos) : true;
    const logicalId = crypto.randomUUID();
    const docId = toDocId(logicalId, uid);
    try {
      await setDoc(doc(db, 'categories', docId), {
        id: docId,
        ownerUid: uid,
        name: cleanName,
        sortOrder,
        showInPos,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `categories/${docId}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'CREATE_CATEGORY', 'Category', logicalId, { name: cleanName, sortOrder, showInPos });
    invalidateWorkspaceCache();
    return { id: logicalId, name: cleanName, sort_order: sortOrder, show_in_pos: showInPos } as T;
  }

  if (pathname.startsWith('/categories/') && method === 'PUT') {
    assertPerm(user, PERMISSIONS.PRODUCT_MANAGE);
    const id = pathname.split('/')[2];
    const docId = toDocId(id, uid);
    const existing = snap.categories.find((c) => c.id === docId);
    if (!existing) throw new Error('Category not found');
    const cleanName = String(body?.name || '').trim();
    if (!cleanName) throw new Error('Category name is required');
    if (snap.categories.some((c) => String(c.name).toLowerCase() === cleanName.toLowerCase() && c.id !== docId)) {
      throw new Error(`Category "${cleanName}" already exists`);
    }
    const sortOrder = Math.round(body?.sortOrder !== undefined && body?.sortOrder !== '' ? Number(body.sortOrder) : existing.sortOrder);
    const showInPos = body?.showInPos !== undefined ? Boolean(body.showInPos) : existing.showInPos !== false;
    try {
      await updateDoc(doc(db, 'categories', docId), {
        name: cleanName,
        sortOrder,
        showInPos,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `categories/${docId}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'UPDATE_CATEGORY', 'Category', id, { name: cleanName, sortOrder, showInPos });
    invalidateWorkspaceCache();
    return { id, name: cleanName, sort_order: sortOrder, show_in_pos: showInPos } as T;
  }

  if (pathname === '/products' && method === 'POST') {
    assertPerm(user, PERMISSIONS.PRODUCT_MANAGE);
    const { sku, name, description, imageUrl, categoryId, basePrice, packagingCost, directLaborCost, targetFoodCostPct, taxConfigId, expiryDate, ingredients } = body || {};
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('Product name is required');
    const cleanCatInput = String(categoryId || '').trim();
    if (!cleanCatInput) throw new Error('Category is required');
    const catDocId = toDocId(cleanCatInput, uid);
    if (!snap.categories.some((c) => c.id === catDocId)) throw new Error('Selected category does not exist');

    const parsedPrice = Number(basePrice);
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) throw new Error('Valid base price is required');

    const cleanSku = String(sku || '').trim() || `MNU-${Date.now().toString().slice(-5)}`;
    if (snap.products.some((p) => String(p.sku).toLowerCase() === cleanSku.toLowerCase())) {
      throw new Error(`SKU "${cleanSku}" is already used by another product`);
    }

    const rawImageUrl = imageUrl ? String(imageUrl).trim() : '';
    if (rawImageUrl.length > 250000) {
      throw new Error('Product photo is too large. Please upload a smaller image.');
    }
    const cleanImageUrl = rawImageUrl || null;

    const logicalId = crypto.randomUUID();
    const docId = toDocId(logicalId, uid);
    const cleanExpiry = expiryDate ? String(expiryDate).trim() || null : null;
    const cleanTaxId = taxConfigId ? toDocId(String(taxConfigId), uid) : toDocId('tax_ph_vat', uid);
    const mappedIngs = (ingredients || []).map((ing: any) => ({
      id: crypto.randomUUID(),
      inventoryItemId: toDocId(String(ing.inventoryItemId), uid),
      quantity: Number(ing.quantity),
      uomId: String(ing.uomId),
      wasteFactorPct: Number(ing.wasteFactorPct || 0),
    }));

    try {
      await setDoc(doc(db, 'products', docId), {
        id: docId,
        ownerUid: uid,
        sku: cleanSku,
        name: cleanName,
        description: description ? String(description).trim() : '',
        imageUrl: cleanImageUrl,
        categoryId: catDocId,
        basePrice: parsedPrice,
        packagingCost: Number(packagingCost || 0),
        directLaborCost: Number(directLaborCost || 0),
        targetFoodCostPct: Number(targetFoodCostPct || 35),
        taxConfigId: cleanTaxId,
        expiryDate: cleanExpiry,
        isAvailable: true,
        variants: [],
        modifiers: [],
        recipeYieldQty: 1,
        prepInstructions: '',
        ingredients: mappedIngs,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `products/${docId}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'CREATE_PRODUCT', 'Product', logicalId, { name: cleanName, sku: cleanSku, basePrice: parsedPrice });
    invalidateWorkspaceCache();
    return { id: logicalId } as T;
  }

  if (pathname.startsWith('/products/') && pathname.endsWith('/recipe') && method === 'PUT') {
    assertPerm(user, PERMISSIONS.PRODUCT_MANAGE);
    const id = pathname.split('/')[2];
    const docId = toDocId(id, uid);
    const existing = snap.products.find((p) => p.id === docId);
    if (!existing) throw new Error('Product not found');

    const { basePrice, packagingCost, directLaborCost, targetFoodCostPct, prepInstructions, ingredients } = body || {};
    const mappedIngs = (ingredients || []).map((ing: any) => ({
      id: ing.id || crypto.randomUUID(),
      inventoryItemId: toDocId(String(ing.inventoryItemId), uid),
      quantity: Number(ing.quantity),
      uomId: String(ing.uomId),
      wasteFactorPct: Number(ing.wasteFactorPct || 0),
    }));

    try {
      await updateDoc(doc(db, 'products', docId), {
        basePrice: Number(basePrice ?? existing.basePrice),
        packagingCost: Number(packagingCost ?? existing.packagingCost ?? 0),
        directLaborCost: Number(directLaborCost ?? existing.directLaborCost ?? 0),
        targetFoodCostPct: Number(targetFoodCostPct ?? existing.targetFoodCostPct ?? 35),
        prepInstructions: String(prepInstructions || ''),
        ingredients: mappedIngs,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `products/${docId}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'UPDATE_RECIPE', 'Product', id);
    invalidateWorkspaceCache();
    return { ok: true } as T;
  }

  if (pathname.startsWith('/products/') && pathname.endsWith('/availability') && method === 'PATCH') {
    assertPerm(user, PERMISSIONS.PRODUCT_MANAGE);
    const id = pathname.split('/')[2];
    const docId = toDocId(id, uid);
    try {
      await updateDoc(doc(db, 'products', docId), {
        isAvailable: Boolean(body.isAvailable),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `products/${docId}`);
    }
    invalidateWorkspaceCache();
    return { ok: true } as T;
  }

  if (pathname.startsWith('/products/') && method === 'PUT') {
    assertPerm(user, PERMISSIONS.PRODUCT_MANAGE);
    const id = pathname.split('/')[2];
    const docId = toDocId(id, uid);
    const existing = snap.products.find((p) => p.id === docId);
    if (!existing) throw new Error('Product not found');

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
    } = body || {};

    const cleanName = String(name || '').trim();
    const cleanSku = String(sku || '').trim();
    if (!cleanName) throw new Error('Product name is required');
    if (!cleanSku) throw new Error('SKU is required');
    if (!categoryId) throw new Error('Category is required');
    if (snap.products.some((p) => String(p.sku).toLowerCase() === cleanSku.toLowerCase() && p.id !== docId)) {
      throw new Error(`SKU "${cleanSku}" is already used by another product`);
    }

    const catDocId = toDocId(String(categoryId), uid);
    const mappedVariants = Array.isArray(variants)
      ? variants
          .filter((v: any) => String(v.name || '').trim())
          .map((v: any) => ({
            id: v.id || crypto.randomUUID(),
            name: String(v.name).trim(),
            priceDelta: Number(v.priceDelta || 0),
            portionMultiplier: Number(v.portionMultiplier || 1),
          }))
      : existing.variants || [];

    const mappedModifiers = Array.isArray(modifiers)
      ? modifiers
          .filter((m: any) => String(m.name || '').trim())
          .map((m: any) => ({
            id: m.id || crypto.randomUUID(),
            groupName: String(m.groupName || 'Add-ons').trim() || 'Add-ons',
            name: String(m.name).trim(),
            priceDelta: Number(m.priceDelta || 0),
          }))
      : existing.modifiers || [];

    const nextImageUrl =
      imageUrl !== undefined ? (imageUrl ? String(imageUrl).trim() || null : null) : existing.imageUrl ?? null;
    if (nextImageUrl && nextImageUrl.length > 250000) {
      throw new Error('Product photo is too large. Please upload a smaller image.');
    }

    try {
      await updateDoc(doc(db, 'products', docId), {
        sku: cleanSku,
        name: cleanName,
        description: description ?? existing.description ?? '',
        imageUrl: nextImageUrl,
        categoryId: catDocId,
        basePrice: Number(basePrice),
        packagingCost: Number(packagingCost || 0),
        directLaborCost: Number(directLaborCost || 0),
        targetFoodCostPct: Number(targetFoodCostPct || 35),
        taxConfigId: taxConfigId ? toDocId(String(taxConfigId), uid) : existing.taxConfigId ?? toDocId('tax_ph_vat', uid),
        expiryDate: expiryDate !== undefined ? String(expiryDate).trim() || null : existing.expiryDate ?? null,
        isAvailable: isAvailable === undefined ? Boolean(existing.isAvailable) : Boolean(isAvailable),
        variants: mappedVariants,
        modifiers: mappedModifiers,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `products/${docId}`);
    }

    await addAuditLog(uid, user.id, user.fullName, 'UPDATE_PRODUCT', 'Product', id, { name: cleanName, sku: cleanSku, basePrice: Number(basePrice) });
    invalidateWorkspaceCache();
    return { ok: true } as T;
  }

  // 5. INVENTORY
  if (pathname === '/inventory' && method === 'GET') {
    assertPerm(user, PERMISSIONS.INVENTORY_VIEW);
    const locFilter = qs.get('locationId') ? toDocId(qs.get('locationId')!, uid) : '';
    const itemMap = new Map(snap.inventoryItems.map((i) => [i.id, i]));
    const locMap = new Map(snap.locations.map((l) => [l.id, l]));

    const items = [...snap.inventoryItems]
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map((i) => {
        const relBatches = snap.stockBatches.filter((b) => b.inventoryItemId === i.id && (!locFilter || b.locationId === locFilter));
        const onHandQty = round2(relBatches.reduce((s, b) => s + Number(b.remainingQty || 0), 0));
        const stockValue = round2(relBatches.reduce((s, b) => s + Number(b.remainingQty || 0) * Number(b.unitCost || 0), 0));
        const evalRes = evaluateIngredientThreshold({
          onHandQty,
          safetyStock: Number(i.minStockLevel || 0),
          reorderPoint: Number(i.reorderPoint || 0),
        });
        return {
          id: toLogicalId(i.id, uid),
          sku: i.sku,
          name: i.name,
          item_type: i.itemType,
          base_uom_id: i.baseUomId,
          uom_code: i.uomCode,
          costing_method: i.costingMethod,
          min_stock_level: i.minStockLevel,
          safety_stock_level: i.minStockLevel,
          reorder_point: i.reorderPoint,
          last_unit_cost: i.lastUnitCost,
          weighted_avg_cost: i.weightedAvgCost,
          on_hand_qty: onHandQty,
          stock_value: stockValue,
          threshold_status: evalRes.status,
          safety_deficit: evalRes.status === 'BELOW_SAFETY' ? evalRes.deficitQty : 0,
        };
      });

    const batches = snap.stockBatches
      .filter((b) => Number(b.remainingQty) > 0 && (!locFilter || b.locationId === locFilter))
      .sort((a, b) => String(a.expiryDate || '9999').localeCompare(String(b.expiryDate || '9999')) || String(a.receivedAt).localeCompare(String(b.receivedAt)))
      .map((b) => ({
        id: toLogicalId(b.id, uid),
        inventory_item_id: toLogicalId(b.inventoryItemId, uid),
        location_id: toLogicalId(b.locationId, uid),
        batch_number: b.batchNumber,
        initial_qty: b.initialQty,
        remaining_qty: b.remainingQty,
        unit_cost: b.unitCost,
        expiry_date: b.expiryDate,
        received_at: b.receivedAt,
        item_name: itemMap.get(b.inventoryItemId)?.name || 'Item',
        uom_code: itemMap.get(b.inventoryItemId)?.uomCode || '',
        location_name: locMap.get(b.locationId)?.name || '',
      }));

    const movements = snap.inventoryTxns
      .filter((t) => !locFilter || t.locationId === locFilter)
      .sort((a, b) => String(b.txnDate || tsToIso(b.createdAt)).localeCompare(String(a.txnDate || tsToIso(a.createdAt))))
      .slice(0, 60)
      .map((t) => ({
        id: toLogicalId(t.id, uid),
        inventory_item_id: toLogicalId(t.inventoryItemId, uid),
        location_id: toLogicalId(t.locationId, uid),
        batch_id: t.batchId ? toLogicalId(t.batchId, uid) : null,
        txn_type: t.txnType,
        quantity_delta: t.quantityDelta,
        unit_cost: t.unitCost,
        total_cost: t.totalCost,
        reference_type: t.referenceType,
        reference_id: t.referenceId,
        notes: t.notes,
        created_at: t.txnDate || tsToIso(t.createdAt),
        item_name: itemMap.get(t.inventoryItemId)?.name || 'Item',
        uom_code: itemMap.get(t.inventoryItemId)?.uomCode || '',
        location_name: locMap.get(t.locationId)?.name || '',
      }));

    const belowSafetyItems = items.filter((i) => i.threshold_status === 'BELOW_SAFETY');
    const belowReorderItems = items.filter((i) => i.threshold_status === 'BELOW_REORDER');
    const rawBelowSafetyItems = belowSafetyItems.filter((i) => i.item_type === 'RAW_MATERIAL');

    return {
      items,
      batches,
      movements,
      uoms: snap.meta?.uoms || [],
      alertsSummary: {
        belowSafetyCount: belowSafetyItems.length,
        belowReorderCount: belowReorderItems.length,
        rawBelowSafetyCount: rawBelowSafetyItems.length,
        rawItemsBelowSafety: rawBelowSafetyItems.map((i) => ({
          id: i.id,
          sku: i.sku,
          name: i.name,
          onHandQty: i.on_hand_qty,
          safetyStock: i.safety_stock_level,
          deficitQty: i.safety_deficit,
          uomCode: i.uom_code,
        })),
      },
    } as T;
  }

  if (pathname === '/inventory/alerts/scan' && method === 'POST') {
    assertPerm(user, PERMISSIONS.INVENTORY_VIEW);
    const rawLoc = String(body?.locationId || '').trim();
    const locFilterDocId = rawLoc && rawLoc !== 'ALL' ? toDocId(rawLoc, uid) : '';
    const onlyIfNeverNotified = Boolean(body?.onlyIfNeverNotified);
    const rawOnly = body?.rawOnly !== false;

    const candidateItems = snap.inventoryItems.filter(
      (i) => (!rawOnly || i.itemType === 'RAW_MATERIAL') && (Number(i.minStockLevel || 0) > 0 || Number(i.reorderPoint || 0) > 0),
    );
    const activeLocs = snap.locations.filter((l) => l.isActive !== false);

    let scannedCount = 0;
    let belowSafetyCount = 0;
    let belowReorderCount = 0;
    let createdCount = 0;
    let resolvedCount = 0;
    const alerts: any[] = [];

    for (const item of candidateItems) {
      if (locFilterDocId) {
        scannedCount++;
        const locQty = round2(
          snap.stockBatches
            .filter((b) => b.inventoryItemId === item.id && b.locationId === locFilterDocId)
            .reduce((s, b) => s + Number(b.remainingQty || 0), 0),
        );
        const res = await syncItemThresholdAlertsFirestore(snap, item, locFilterDocId, locQty, { onlyIfNeverNotified });
        createdCount += res.createdCount;
        resolvedCount += res.resolvedCount;
        if (res.status === 'BELOW_SAFETY') {
          belowSafetyCount++;
          alerts.push({
            inventoryItemId: toLogicalId(item.id, uid),
            sku: item.sku,
            name: item.name,
            itemType: item.itemType,
            locationId: toLogicalId(locFilterDocId, uid),
            locationName: activeLocs.find((l) => l.id === locFilterDocId)?.name || 'Location',
            onHandQty: locQty,
            safetyStock: Number(item.minStockLevel || 0),
            reorderPoint: Number(item.reorderPoint || 0),
            uomCode: item.uomCode,
            status: res.status,
          });
        } else if (res.status === 'BELOW_REORDER') {
          belowReorderCount++;
        }
      } else {
        // Check network-wide aggregate AND each location where this raw ingredient has active/historical presence
        const stockedLocIds = activeLocs
          .filter(
            (l) =>
              snap.stockBatches.some((b) => b.inventoryItemId === item.id && b.locationId === l.id) ||
              snap.inventoryTxns.some((t) => t.inventoryItemId === item.id && t.locationId === l.id),
          )
          .map((l) => l.id);

        if (stockedLocIds.length === 0) {
          scannedCount++;
          const res = await syncItemThresholdAlertsFirestore(snap, item, null, 0, { onlyIfNeverNotified });
          createdCount += res.createdCount;
          resolvedCount += res.resolvedCount;
          if (res.status === 'BELOW_SAFETY') {
            belowSafetyCount++;
            alerts.push({
              inventoryItemId: toLogicalId(item.id, uid),
              sku: item.sku,
              name: item.name,
              itemType: item.itemType,
              locationId: null,
              locationName: 'All Locations',
              onHandQty: 0,
              safetyStock: Number(item.minStockLevel || 0),
              reorderPoint: Number(item.reorderPoint || 0),
              uomCode: item.uomCode,
              status: res.status,
            });
          } else if (res.status === 'BELOW_REORDER') {
            belowReorderCount++;
          }
        } else {
          for (const lid of stockedLocIds) {
            scannedCount++;
            const locQty = round2(
              snap.stockBatches
                .filter((b) => b.inventoryItemId === item.id && b.locationId === lid)
                .reduce((s, b) => s + Number(b.remainingQty || 0), 0),
            );
            const res = await syncItemThresholdAlertsFirestore(snap, item, lid, locQty, { onlyIfNeverNotified });
            createdCount += res.createdCount;
            resolvedCount += res.resolvedCount;
            if (res.status === 'BELOW_SAFETY') {
              belowSafetyCount++;
              alerts.push({
                inventoryItemId: toLogicalId(item.id, uid),
                sku: item.sku,
                name: item.name,
                itemType: item.itemType,
                locationId: toLogicalId(lid, uid),
                locationName: activeLocs.find((l) => l.id === lid)?.name || 'Location',
                onHandQty: locQty,
                safetyStock: Number(item.minStockLevel || 0),
                reorderPoint: Number(item.reorderPoint || 0),
                uomCode: item.uomCode,
                status: res.status,
              });
            } else if (res.status === 'BELOW_REORDER') {
              belowReorderCount++;
            }
          }
        }
      }
    }

    if (createdCount > 0 || resolvedCount > 0) {
      invalidateWorkspaceCache();
    }
    return {
      scannedCount,
      belowSafetyCount,
      belowReorderCount,
      createdCount,
      resolvedCount,
      alerts,
    } as T;
  }

  if (pathname === '/inventory/predictive-procurement' && method === 'GET') {
    assertPerm(user, PERMISSIONS.INVENTORY_VIEW);
    const rawLoc = qs.get('locationId') || '';
    const locFilterDocId = rawLoc && rawLoc !== 'ALL' ? toDocId(rawLoc, uid) : '';
    const lookbackDays = Math.min(180, Math.max(30, Math.round(Number(qs.get('lookbackDays') || 90) || 90)));
    const coverageDays = Math.min(45, Math.max(3, Math.round(Number(qs.get('coverageDays') || 14) || 14)));

    const items = snap.inventoryItems.map((i) => ({
      id: toLogicalId(i.id, uid),
      sku: String(i.sku || ''),
      name: String(i.name || ''),
      itemType: String(i.itemType || 'RAW_MATERIAL'),
      uomCode: String(i.uomCode || 'pcs'),
      safetyStock: Number(i.minStockLevel || 0),
      reorderPoint: Number(i.reorderPoint || 0),
      lastUnitCost: Number(i.lastUnitCost || 0),
    }));

    const onHandByItem = new Map<string, number>();
    for (const b of snap.stockBatches) {
      if (locFilterDocId && b.locationId !== locFilterDocId) continue;
      const qty = Number(b.remainingQty || 0);
      if (qty <= 0) continue;
      const lid = toLogicalId(b.inventoryItemId, uid);
      onHandByItem.set(lid, (onHandByItem.get(lid) || 0) + qty);
    }

    const openStatuses = new Set([
      'DRAFT',
      'PENDING_APPROVAL',
      'PENDING_MANAGER_SIGNATURE',
      'APPROVED',
      'PARTIAL',
      'PARTIALLY_RECEIVED',
    ]);
    const openPoByItem = new Map<string, number>();
    for (const po of snap.purchaseOrders) {
      if (!openStatuses.has(String(po.status || '').toUpperCase())) continue;
      if (locFilterDocId && po.locationId !== locFilterDocId) continue;
      for (const pi of po.items || []) {
        const pendingQty = Math.max(0, Number(pi.orderedQty || 0) - Number(pi.receivedQty || 0));
        if (pendingQty <= 0) continue;
        const lid = toLogicalId(pi.inventoryItemId, uid);
        openPoByItem.set(lid, (openPoByItem.get(lid) || 0) + pendingQty);
      }
    }

    const txns = snap.inventoryTxns.map((t) => ({
      inventoryItemId: toLogicalId(t.inventoryItemId, uid),
      locationId: toLogicalId(t.locationId, uid),
      txnType: String(t.txnType || ''),
      quantityDelta: Number(t.quantityDelta || 0),
      referenceType: t.referenceType || null,
      referenceId: t.referenceId ? toLogicalId(String(t.referenceId), uid) : null,
      txnDate: String(t.txnDate || tsToIso(t.createdAt)),
    }));

    const prodMap = new Map(snap.products.map((p) => [p.id, p]));
    const itemDocMap = new Map(snap.inventoryItems.map((i) => [i.id, i]));
    const salesBomUsages: Array<{
      saleId: string;
      locationId: string;
      inventoryItemId: string;
      quantity: number;
      soldAt: string;
    }> = [];

    for (const s of snap.sales) {
      if (s.status !== 'COMPLETED') continue;
      if (locFilterDocId && s.locationId !== locFilterDocId) continue;
      const logicalSaleId = toLogicalId(s.id, uid);
      const logicalLocId = toLogicalId(s.locationId, uid);
      const soldAt = String(s.soldAt || tsToIso(s.createdAt));

      for (const ci of s.items || []) {
        const prod = prodMap.get(ci.productId) || prodMap.get(toDocId(String(ci.productId || ''), uid));
        if (!prod) continue;
        const variant = ci.variantId ? (prod.variants || []).find((v: any) => v.id === ci.variantId) : null;
        const mult = Number(variant?.portionMultiplier || 1);
        const yieldQty = Number(prod.recipeYieldQty || 1);

        for (const ing of prod.ingredients || []) {
          const invItem = itemDocMap.get(ing.inventoryItemId) || itemDocMap.get(toDocId(String(ing.inventoryItemId || ''), uid));
          if (!invItem) continue;
          try {
            const rawQty =
              ((Number(ing.quantity) * (1 + Number(ing.wasteFactorPct || 0) / 100)) / yieldQty) *
              mult *
              Number(ci.quantity || 0);
            const baseQty = convertQty(rawQty, ing.uomId, invItem.baseUomId, snap);
            if (baseQty > 0) {
              salesBomUsages.push({
                saleId: logicalSaleId,
                locationId: logicalLocId,
                inventoryItemId: toLogicalId(invItem.id, uid),
                quantity: baseQty,
                soldAt,
              });
            }
          } catch {
            // ignore conversion errors
          }
        }

        const modIds = new Set((ci.modifiers || []).map((m: any) => m.id));
        for (const m of (prod.modifiers || []).filter((x: any) => modIds.has(x.id))) {
          if (!m.inventoryItemId || !(Number(m.deductQty) > 0) || !m.uomId) continue;
          const invItem = itemDocMap.get(m.inventoryItemId) || itemDocMap.get(toDocId(String(m.inventoryItemId || ''), uid));
          if (!invItem) continue;
          try {
            const baseQty = convertQty(Number(m.deductQty) * Number(ci.quantity || 0), m.uomId, invItem.baseUomId, snap);
            if (baseQty > 0) {
              salesBomUsages.push({
                saleId: logicalSaleId,
                locationId: logicalLocId,
                inventoryItemId: toLogicalId(invItem.id, uid),
                quantity: baseQty,
                soldAt,
              });
            }
          } catch {
            // ignore conversion errors
          }
        }
      }
    }

    const activeSuppliers = snap.suppliers
      .filter((s) => s.isActive !== false)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const supByDocId = new Map(activeSuppliers.map((s) => [s.id, s]));

    const seedPricePairs = [
      ['sup_1', 'ing_pork', 0.34, 1],
      ['sup_1', 'ing_beef', 0.58, 1],
      ['sup_3', 'ing_pork', 0.36, 2],
      ['sup_2', 'ing_bun', 14.0, 1],
      ['sup_2', 'ing_tortilla', 8.5, 1],
      ['sup_3', 'ing_potato', 0.14, 1],
      ['sup_3', 'ing_mango', 0.16, 2],
    ] as const;

    const supplierQuotesByItem = new Map<string, SupplierQuoteOption[]>();
    for (const [sId, iId, price, lead] of seedPricePairs) {
      const sup = supByDocId.get(toDocId(sId, uid));
      const invItem = itemDocMap.get(toDocId(iId, uid));
      if (!sup || !invItem) continue;
      const logicalItemId = toLogicalId(invItem.id, uid);
      const list = supplierQuotesByItem.get(logicalItemId) || [];
      list.push({
        supplierId: toLogicalId(sup.id, uid),
        supplierName: sup.name,
        unitPrice: price,
        leadTimeDays: lead,
      });
      supplierQuotesByItem.set(logicalItemId, list);
    }

    return buildPredictiveProcurementPlan({
      items,
      onHandByItem,
      openPoByItem,
      txns,
      salesBomUsages,
      supplierQuotesByItem,
      suppliers: activeSuppliers.map((s) => ({
        id: toLogicalId(s.id, uid),
        name: String(s.name || ''),
        code: String(s.code || ''),
      })),
      locationId: locFilterDocId ? toLogicalId(locFilterDocId, uid) : 'ALL',
      lookbackDays,
      coverageDays,
    }) as T;
  }

  if (pathname === '/inventory/predictive-procurement/auto-po' && method === 'POST') {
    assertPerm(user, PERMISSIONS.PO_CREATE);
    const { locationId, status, notes, coverageDays, items } = body || {};
    const rawLocId = String(locationId || '').trim();
    if (!rawLocId || rawLocId === 'ALL') {
      throw new Error('Select a specific delivery location (e.g., Commissary or Food Truck) before creating auto-restock POs');
    }
    const locDocId = toDocId(rawLocId, uid);
    const targetLoc = snap.locations.find((l) => l.id === locDocId && l.isActive !== false);
    if (!targetLoc) throw new Error('Selected delivery location was not found');

    const requestedStatus = String(status || 'DRAFT').toUpperCase();
    if (requestedStatus !== 'DRAFT' && requestedStatus !== 'PENDING_APPROVAL') {
      throw new Error('Predictive auto-restock POs can only be created as DRAFT or PENDING_APPROVAL');
    }

    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('Select at least one ingredient to generate purchase order(s)');
    }
    if (items.length > 120) {
      throw new Error('Too many line items in a single auto-restock batch');
    }

    const activeSupByDocId = new Map(snap.suppliers.filter((s) => s.isActive !== false).map((s) => [s.id, s]));
    const itemByDocId = new Map(snap.inventoryItems.map((i) => [i.id, i]));
    const groupedBySup = new Map<
      string,
      {
        supplierDocId: string;
        supplierName: string;
        leadTimeDays: number;
        lines: Array<{ inventoryItemId: string; orderedQty: number; unitCost: number }>;
      }
    >();

    for (const rawLine of items) {
      const invDocId = toDocId(String(rawLine?.inventoryItemId || '').trim(), uid);
      const supDocId = toDocId(String(rawLine?.supplierId || '').trim(), uid);
      const orderedQty = round2(Number(rawLine?.orderedQty || 0));
      const unitCost = round4(Number(rawLine?.unitCost ?? 0));
      const leadTimeDays = Math.max(1, Math.min(30, Math.round(Number(rawLine?.leadTimeDays || 2))));

      const invItem = itemByDocId.get(invDocId);
      if (!invItem) throw new Error('One or more selected inventory items could not be found');
      const sup = activeSupByDocId.get(supDocId);
      if (!sup) throw new Error(`Please assign an active supplier for "${invItem.name}"`);
      if (!Number.isFinite(orderedQty) || orderedQty <= 0) {
        throw new Error(`Restock quantity for "${invItem.name}" must be greater than zero`);
      }
      if (!Number.isFinite(unitCost) || unitCost < 0) {
        throw new Error(`Unit cost for "${invItem.name}" cannot be negative`);
      }

      const existingGroup = groupedBySup.get(supDocId);
      if (existingGroup) {
        const existingLine = existingGroup.lines.find((l) => l.inventoryItemId === invDocId);
        if (existingLine) {
          existingLine.orderedQty = round2(existingLine.orderedQty + orderedQty);
          existingLine.unitCost = unitCost;
        } else {
          existingGroup.lines.push({ inventoryItemId: invDocId, orderedQty, unitCost });
        }
        existingGroup.leadTimeDays = Math.max(existingGroup.leadTimeDays, leadTimeDays);
      } else {
        groupedBySup.set(supDocId, {
          supplierDocId: supDocId,
          supplierName: sup.name,
          leadTimeDays,
          lines: [{ inventoryItemId: invDocId, orderedQty, unitCost }],
        });
      }
    }

    const createdPos: Array<{
      id: string;
      poNumber: string;
      supplierId: string;
      supplierName: string;
      status: string;
      totalAmount: number;
      lineCount: number;
    }> = [];

    let seqIdx = 0;
    const covDays = Math.min(45, Math.max(3, Math.round(Number(coverageDays || 14) || 14)));
    const noteBase = String(notes || `Predictive 90d restock (${covDays}d target coverage)`).trim();

    for (const group of groupedBySup.values()) {
      for (let offset = 0; offset < group.lines.length; offset += 60) {
        const chunk = group.lines.slice(offset, offset + 60);
        seqIdx += 1;
        const logicalId = crypto.randomUUID();
        const poDocId = toDocId(logicalId, uid);
        const poNumber = `PO-${Date.now().toString().slice(-5)}${String(seqIdx).padStart(2, '0')}`;
        const totalAmount = round2(chunk.reduce((s, l) => s + l.orderedQty * l.unitCost, 0));
        const expectedIso = new Date(Date.now() + group.leadTimeDays * 86400000).toISOString().slice(0, 10);

        try {
          await setDoc(doc(db, 'purchase_orders', poDocId), {
            id: poDocId,
            ownerUid: uid,
            poNumber,
            supplierId: group.supplierDocId,
            locationId: locDocId,
            status: requestedStatus,
            totalAmount,
            approvedBy: null,
            notes: noteBase.slice(0, 500),
            items: chunk.map((l) => ({
              id: crypto.randomUUID(),
              inventoryItemId: l.inventoryItemId,
              orderedQty: l.orderedQty,
              receivedQty: 0,
              unitCost: l.unitCost,
            })),
            orderedAt: new Date().toISOString(),
            expectedAt: expectedIso,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, `purchase_orders/${poDocId}`);
        }

        await addAuditLog(uid, user.id, user.fullName, 'AUTO_CREATE_PREDICTIVE_PO', 'PurchaseOrder', logicalId, {
          poNumber,
          supplier: group.supplierName,
          location: targetLoc.name,
          totalAmount,
          status: requestedStatus,
          lineCount: chunk.length,
        });

        createdPos.push({
          id: logicalId,
          poNumber,
          supplierId: toLogicalId(group.supplierDocId, uid),
          supplierName: group.supplierName,
          status: requestedStatus,
          totalAmount,
          lineCount: chunk.length,
        });
      }
    }

    invalidateWorkspaceCache();
    return { createdPos } as T;
  }

  if (pathname === '/inventory/items' && method === 'POST') {
    assertAnyPerm(user, PERMISSIONS.INVENTORY_ADJUST, PERMISSIONS.PRODUCT_MANAGE);
    const { sku, name, itemType, baseUomId, costingMethod, minStockLevel, reorderPoint, lastUnitCost } = body || {};
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('Ingredient name is required');
    if (!baseUomId) throw new Error('Base unit (UOM) is required');

    const cleanSku = String(sku || '').trim() || `ING-${Date.now().toString().slice(-4)}`;
    if (snap.inventoryItems.some((i) => String(i.sku).toLowerCase() === cleanSku.toLowerCase())) {
      throw new Error(`SKU "${cleanSku}" is already used by another ingredient`);
    }
    if (snap.inventoryItems.some((i) => String(i.name).toLowerCase() === cleanName.toLowerCase())) {
      throw new Error(`Ingredient "${cleanName}" already exists`);
    }
    const cost = Number(lastUnitCost || 0);
    if (!Number.isFinite(cost) || cost < 0) throw new Error('Unit cost cannot be negative');

    const safety = Math.max(0, Number(minStockLevel || 0));
    const reorder = Math.max(0, Number(reorderPoint || 0));
    const uom = (snap.meta?.uoms || []).find((u: any) => u.id === baseUomId);
    const logicalId = crypto.randomUUID();
    const docId = toDocId(logicalId, uid);
    const createdItem = {
      id: docId,
      ownerUid: uid,
      sku: cleanSku,
      name: cleanName,
      itemType: itemType || 'RAW_MATERIAL',
      baseUomId,
      uomCode: uom?.code || 'pcs',
      costingMethod: costingMethod || 'FIFO',
      minStockLevel: safety,
      reorderPoint: reorder,
      lastUnitCost: cost,
      weightedAvgCost: cost,
    };

    try {
      await setDoc(doc(db, 'inventory_items', docId), {
        ...createdItem,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `inventory_items/${docId}`);
    }

    let alertsCreated = 0;
    if (safety > 0 || reorder > 0) {
      const syncRes = await syncItemThresholdAlertsFirestore(snap, createdItem, null, 0, { onlyIfNeverNotified: false });
      alertsCreated = syncRes.createdCount;
    }

    await addAuditLog(uid, user.id, user.fullName, 'CREATE_INGREDIENT', 'InventoryItem', logicalId, {
      name: cleanName,
      sku: cleanSku,
      safetyStock: safety,
      alertsCreated,
    });
    invalidateWorkspaceCache();
    return {
      id: logicalId,
      sku: cleanSku,
      name: cleanName,
      item_type: itemType || 'RAW_MATERIAL',
      base_uom_id: baseUomId,
      uom_code: uom?.code || 'pcs',
      costing_method: costingMethod || 'FIFO',
      min_stock_level: safety,
      reorder_point: reorder,
      last_unit_cost: cost,
      weighted_avg_cost: cost,
      alerts_created: alertsCreated,
    } as T;
  }

  if (pathname.startsWith('/inventory/items/') && method === 'PUT') {
    assertAnyPerm(user, PERMISSIONS.INVENTORY_ADJUST, PERMISSIONS.PRODUCT_MANAGE);
    const id = pathname.split('/')[3];
    const docId = toDocId(id, uid);
    const existing = snap.inventoryItems.find((i) => i.id === docId);
    if (!existing) throw new Error('Ingredient not found');

    const { sku, name, itemType, baseUomId, costingMethod, minStockLevel, reorderPoint, lastUnitCost } = body || {};
    const cleanName = String(name || '').trim();
    const cleanSku = String(sku || '').trim();
    if (!cleanName) throw new Error('Ingredient name is required');
    if (!cleanSku) throw new Error('SKU is required');
    if (!baseUomId) throw new Error('Base unit (UOM) is required');

    if (snap.inventoryItems.some((i) => String(i.sku).toLowerCase() === cleanSku.toLowerCase() && i.id !== docId)) {
      throw new Error(`SKU "${cleanSku}" is already used by another ingredient`);
    }
    if (snap.inventoryItems.some((i) => String(i.name).toLowerCase() === cleanName.toLowerCase() && i.id !== docId)) {
      throw new Error(`Ingredient "${cleanName}" already exists`);
    }

    if (baseUomId !== existing.baseUomId) {
      const usedInHistory =
        snap.stockBatches.some((b) => b.inventoryItemId === docId) ||
        snap.inventoryTxns.some((t) => t.inventoryItemId === docId) ||
        snap.products.some((p) => (p.ingredients || []).some((ri: any) => ri.inventoryItemId === docId));
      if (usedInHistory) {
        throw new Error('Cannot change base unit (UOM) because this ingredient is already used in recipes or stock history');
      }
    }

    const cost = Number(lastUnitCost ?? existing.lastUnitCost ?? 0);
    if (!Number.isFinite(cost) || cost < 0) throw new Error('Unit cost cannot be negative');
    const hasBatches = snap.stockBatches.some((b) => b.inventoryItemId === docId && Number(b.remainingQty) > 0);
    const nextWeightedAvg = hasBatches ? Number(existing.weightedAvgCost) : cost;
    const uom = (snap.meta?.uoms || []).find((u: any) => u.id === baseUomId);
    const nextSafety = Math.max(0, Number(minStockLevel ?? existing.minStockLevel ?? 0));
    const nextReorder = Math.max(0, Number(reorderPoint ?? existing.reorderPoint ?? 0));
    const nextType = itemType || existing.itemType || 'RAW_MATERIAL';

    try {
      await updateDoc(doc(db, 'inventory_items', docId), {
        sku: cleanSku,
        name: cleanName,
        itemType: nextType,
        baseUomId,
        uomCode: uom?.code || existing.uomCode,
        costingMethod: costingMethod || existing.costingMethod || 'FIFO',
        minStockLevel: nextSafety,
        reorderPoint: nextReorder,
        lastUnitCost: cost,
        weightedAvgCost: nextWeightedAvg,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `inventory_items/${docId}`);
    }

    const updatedItem = {
      ...existing,
      sku: cleanSku,
      name: cleanName,
      itemType: nextType,
      baseUomId,
      uomCode: uom?.code || existing.uomCode,
      minStockLevel: nextSafety,
      reorderPoint: nextReorder,
    };

    const activeLocs = snap.locations.filter((l) => l.isActive !== false);
    const stockedLocIds = activeLocs
      .filter(
        (l) =>
          snap.stockBatches.some((b) => b.inventoryItemId === docId && b.locationId === l.id) ||
          snap.inventoryTxns.some((t) => t.inventoryItemId === docId && t.locationId === l.id),
      )
      .map((l) => l.id);

    let alertsCreated = 0;
    if (stockedLocIds.length === 0) {
      const syncRes = await syncItemThresholdAlertsFirestore(snap, updatedItem, null, 0, { onlyIfNeverNotified: false });
      alertsCreated += syncRes.createdCount;
    } else {
      for (const lid of stockedLocIds) {
        const locQty = round2(
          snap.stockBatches
            .filter((b) => b.inventoryItemId === docId && b.locationId === lid)
            .reduce((s, b) => s + Number(b.remainingQty || 0), 0),
        );
        const syncRes = await syncItemThresholdAlertsFirestore(snap, updatedItem, lid, locQty, { onlyIfNeverNotified: false });
        alertsCreated += syncRes.createdCount;
      }
    }

    await addAuditLog(uid, user.id, user.fullName, 'UPDATE_INGREDIENT', 'InventoryItem', id, {
      name: cleanName,
      sku: cleanSku,
      cost,
      safetyStock: nextSafety,
      alertsCreated,
    });
    invalidateWorkspaceCache();
    return {
      id,
      sku: cleanSku,
      name: cleanName,
      item_type: nextType,
      base_uom_id: baseUomId,
      uom_code: uom?.code || existing.uomCode,
      costing_method: costingMethod || existing.costingMethod,
      min_stock_level: nextSafety,
      reorder_point: nextReorder,
      last_unit_cost: cost,
      weighted_avg_cost: nextWeightedAvg,
      alerts_created: alertsCreated,
    } as T;
  }

  if (pathname.startsWith('/inventory/items/') && method === 'DELETE') {
    assertAnyPerm(user, PERMISSIONS.INVENTORY_ADJUST, PERMISSIONS.PRODUCT_MANAGE);
    const id = pathname.split('/')[3];
    const docId = toDocId(id, uid);
    const existing = snap.inventoryItems.find((i) => i.id === docId);
    if (!existing) throw new Error('Ingredient not found');

    const recipeCount = snap.products.filter((p) => (p.ingredients || []).some((ri: any) => ri.inventoryItemId === docId)).length;
    if (recipeCount > 0) {
      throw new Error(`Cannot delete "${existing.name}" because it is used in ${recipeCount} product recipe(s). Remove it from BOM first.`);
    }
    if (snap.stockBatches.some((b) => b.inventoryItemId === docId) || snap.inventoryTxns.some((t) => t.inventoryItemId === docId)) {
      throw new Error(`Cannot delete "${existing.name}" because it has stock batches or movement history.`);
    }
    const poUsed = snap.purchaseOrders.some((po) => (po.items || []).some((pi: any) => pi.inventoryItemId === docId));
    const modUsed = snap.products.some((p) => (p.modifiers || []).some((m: any) => m.inventoryItemId === docId));
    if (poUsed || modUsed) {
      throw new Error(`Cannot delete "${existing.name}" because it is linked to purchase orders or menu modifiers.`);
    }

    try {
      await deleteDoc(doc(db, 'inventory_items', docId));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `inventory_items/${docId}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'DELETE_INGREDIENT', 'InventoryItem', id, { name: existing.name });
    invalidateWorkspaceCache();
    return { ok: true } as T;
  }

  if (pathname === '/inventory/transfers' && method === 'POST') {
    assertPerm(user, PERMISSIONS.INVENTORY_ADJUST);
    const { fromLocationId, toLocationId, inventoryItemId, quantity, notes } = body;
    if (fromLocationId === toLocationId) throw new Error('Source and destination locations must differ');
    const qty = Number(quantity);
    const trfId = toDocId(crypto.randomUUID(), uid);
    const trfNo = `TRF-${Date.now().toString().slice(-6)}`;

    const deducted = await deductStockFirestore(snap, {
      inventoryItemId,
      locationId: fromLocationId,
      quantity: qty,
      txnType: 'OUT_TRANSFER',
      referenceType: 'TRANSFER',
      referenceId: trfId,
      userId: user.id,
      notes: notes || `Transfer to ${toLocationId}`,
      allowNegative: false,
    });

    for (const b of deducted.consumedBatches) {
      await receiveStockFirestore(snap, {
        inventoryItemId,
        locationId: toLocationId,
        quantity: b.qty,
        unitCost: b.unitCost,
        batchNumber: trfNo,
        txnType: 'IN_TRANSFER',
        referenceType: 'TRANSFER',
        referenceId: trfId,
        userId: user.id,
        notes: `Received from ${fromLocationId}`,
      });
    }

    try {
      await setDoc(doc(db, 'stock_transfers', trfId), {
        id: trfId,
        ownerUid: uid,
        transferNumber: trfNo,
        fromLocationId: toDocId(fromLocationId, uid),
        toLocationId: toDocId(toLocationId, uid),
        status: 'RECEIVED',
        notes: notes || '',
        items: [{ id: crypto.randomUUID(), inventoryItemId: toDocId(inventoryItemId, uid), quantity: qty, totalCost: deducted.totalCogs }],
        createdBy: user.id,
        transferDate: new Date().toISOString(),
        createdAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `stock_transfers/${trfId}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'STOCK_TRANSFER', 'StockTransfer', toLogicalId(trfId, uid), { trfNo, qty });
    invalidateWorkspaceCache();
    return { trfId: toLogicalId(trfId, uid), trfNo, totalCost: deducted.totalCogs } as T;
  }

  if (pathname === '/inventory/waste' && method === 'GET') {
    assertPerm(user, PERMISSIONS.INVENTORY_VIEW);
    const rawLoc = String(qs.get('locationId') || '').trim();
    const locFilter = rawLoc && rawLoc !== 'ALL' ? toDocId(rawLoc, uid) : '';
    const locMap = new Map(snap.locations.map((l) => [l.id, l]));
    const itemMap = new Map(snap.inventoryItems.map((i) => [i.id, i]));
    const prodMap = new Map(snap.products.map((p) => [p.id, p]));

    const logs: WasteLogRecord[] = [...snap.wasteLogs]
      .filter((w) => !locFilter || w.locationId === locFilter)
      .sort((a, b) => String(b.wastedAt || tsToIso(b.createdAt)).localeCompare(String(a.wastedAt || tsToIso(a.createdAt))))
      .map((w) => ({
        id: toLogicalId(w.id, uid),
        locationId: toLogicalId(w.locationId, uid),
        locationName: w.locationName || locMap.get(w.locationId)?.name || 'Location',
        entryMode: (w.entryMode === 'RECIPE_PREP' ? 'RECIPE_PREP' : 'SINGLE_INGREDIENT') as WasteEntryMode,
        txnType: w.txnType === 'OUT_SPOILAGE' ? 'OUT_SPOILAGE' : 'OUT_WASTE',
        reasonCategory: (w.reasonCategory || 'OTHER') as WasteReasonCategory,
        reasonNotes: String(w.reasonNotes || ''),
        productId: w.productId ? toLogicalId(w.productId, uid) : null,
        productName: w.productName || (w.productId ? prodMap.get(w.productId)?.name || null : null),
        servingsWasted: Number(w.servingsWasted || 0),
        primaryItemId: w.primaryItemId ? toLogicalId(w.primaryItemId, uid) : null,
        primaryItemName: w.primaryItemName || (w.primaryItemId ? itemMap.get(w.primaryItemId)?.name || null : null),
        items: (w.items || []).map((li: any) => ({
          inventoryItemId: toLogicalId(String(li.inventoryItemId || ''), uid),
          ingredientName: String(li.ingredientName || 'Ingredient'),
          uomCode: String(li.uomCode || ''),
          quantity: Number(li.quantity || 0),
          totalCost: Number(li.totalCost || 0),
        })),
        totalQuantityBase: Number(w.totalQuantityBase || 0),
        totalLossCost: Number(w.totalLossCost || 0),
        loggedBy: toLogicalId(String(w.loggedBy || ''), uid),
        loggedByName: String(w.loggedByName || 'Staff'),
        wastedAt: String(w.wastedAt || tsToIso(w.createdAt)),
      }));

    const summary = summarizeWasteLogs(logs);

    const costingList = getProductCostingList(snap);
    const recipes: RecipeWasteOption[] = costingList.map((p) => {
      const yieldQty = Math.max(0.01, Number(p.recipe?.yield_qty || 1));
      const ingredients = (p.recipe?.ingredients || [])
        .map((ri: any) => {
          const invItem = itemMap.get(toDocId(ri.inventory_item_id, uid)) || itemMap.get(ri.inventory_item_id);
          if (!invItem) return null;
          let baseQtyPerServing = 0;
          try {
            const rawPerServing = (Number(ri.quantity || 0) * (1 + Number(ri.waste_factor_pct || 0) / 100)) / yieldQty;
            baseQtyPerServing = round4(convertQty(rawPerServing, ri.uom_id, invItem.baseUomId, snap));
          } catch {
            baseQtyPerServing = 0;
          }
          const unitCost =
            invItem.costingMethod === 'WEIGHTED_AVERAGE'
              ? Number(invItem.weightedAvgCost || 0)
              : Number(invItem.lastUnitCost || 0);
          return {
            inventoryItemId: toLogicalId(invItem.id, uid),
            ingredientName: invItem.name,
            uomCode: invItem.uomCode,
            baseQtyPerServing,
            unitCost,
          };
        })
        .filter((x: any): x is NonNullable<typeof x> => Boolean(x && x.baseQtyPerServing > 0));

      return {
        id: p.id,
        sku: p.sku,
        name: p.name,
        categoryName: p.category_name,
        yieldQty,
        ingredientCount: ingredients.length,
        unitDirectCost: Number(p.costing?.directCost || 0),
        ingredients,
      };
    });

    return { logs, summary, recipes } as T;
  }

  if (pathname === '/inventory/waste' && method === 'POST') {
    assertPerm(user, PERMISSIONS.INVENTORY_ADJUST);
    const {
      locationId,
      entryMode: rawEntryMode,
      inventoryItemId,
      quantity,
      productId,
      servingsWasted,
      ingredientOverrides,
      txnType: rawTxnType,
      reasonCategory: rawReasonCat,
      reason,
    } = body || {};

    const locDocId = toDocId(String(locationId || ''), uid);
    const locObj = snap.locations.find((l) => l.id === locDocId);
    if (!locObj) throw new Error('Valid branch or food truck location is required');

    const entryMode: WasteEntryMode = rawEntryMode === 'RECIPE_PREP' ? 'RECIPE_PREP' : 'SINGLE_INGREDIENT';
    const txnType = rawTxnType === 'OUT_SPOILAGE' ? 'OUT_SPOILAGE' : 'OUT_WASTE';
    const allowedReasons = new Set<WasteReasonCategory>([
      'PREP_TRIM',
      'BURNT_OVERCOOKED',
      'EXPIRED_SPOILED',
      'CONTAMINATION',
      'DROPPED_SPILL',
      'QUALITY_REJECT',
      'OTHER',
    ]);
    const reasonCategory: WasteReasonCategory = allowedReasons.has(rawReasonCat)
      ? rawReasonCat
      : txnType === 'OUT_SPOILAGE'
      ? 'EXPIRED_SPOILED'
      : 'PREP_TRIM';
    const reasonNotes = String(reason || '').trim().slice(0, 400);

    const linkedProd = productId
      ? snap.products.find((p) => p.id === toDocId(String(productId), uid) || p.id === productId) || null
      : null;
    if (entryMode === 'RECIPE_PREP' && !linkedProd) {
      throw new Error('Select a valid menu recipe to record recipe prep waste');
    }

    const deductionsPlan: Array<{ invItem: any; qty: number }> = [];
    let servingsNum = 0;
    let primaryItemDoc: any = null;

    if (entryMode === 'RECIPE_PREP' && linkedProd) {
      servingsNum = Number(servingsWasted);
      if (!Number.isFinite(servingsNum) || servingsNum <= 0) {
        throw new Error('Servings / portions wasted must be greater than zero');
      }
      const overrideList = Array.isArray(ingredientOverrides) ? ingredientOverrides : [];
      if (overrideList.length > 0) {
        for (const ov of overrideList.slice(0, 40)) {
          const ovQty = round4(Number(ov?.quantity || 0));
          if (!Number.isFinite(ovQty) || ovQty <= 0) continue;
          const invItem = snap.inventoryItems.find(
            (i) => i.id === toDocId(String(ov.inventoryItemId || ''), uid) || i.id === ov.inventoryItemId,
          );
          if (invItem) deductionsPlan.push({ invItem, qty: ovQty });
        }
      } else {
        const yieldQty = Math.max(0.01, Number(linkedProd.recipeYieldQty || 1));
        for (const ri of linkedProd.ingredients || []) {
          const invItem = snap.inventoryItems.find(
            (i) => i.id === ri.inventoryItemId || i.id === toDocId(String(ri.inventoryItemId || ''), uid),
          );
          if (!invItem) continue;
          const rawQty = ((Number(ri.quantity || 0) * (1 + Number(ri.wasteFactorPct || 0) / 100)) / yieldQty) * servingsNum;
          const baseQty = round4(convertQty(rawQty, ri.uomId, invItem.baseUomId, snap));
          if (baseQty > 0) {
            deductionsPlan.push({ invItem, qty: baseQty });
          }
        }
      }
      if (deductionsPlan.length === 0) {
        throw new Error(`Recipe "${linkedProd.name}" has no BOM ingredients with positive waste quantity`);
      }
    } else {
      const itemDocId = toDocId(String(inventoryItemId || ''), uid);
      primaryItemDoc = snap.inventoryItems.find((i) => i.id === itemDocId) || null;
      if (!primaryItemDoc) throw new Error('Select a valid ingredient to record waste');
      const qtyNum = round4(Number(quantity));
      if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
        throw new Error('Waste quantity must be greater than zero');
      }
      deductionsPlan.push({ invItem: primaryItemDoc, qty: qtyNum });
    }

    const logicalWasteId = crypto.randomUUID();
    const wasteDocId = toDocId(logicalWasteId, uid);
    const nowIso = new Date().toISOString();
    const noteSummary = `${linkedProd ? `[${linkedProd.name}] ` : ''}${getWasteReasonLabel(reasonCategory)}${reasonNotes ? ` — ${reasonNotes}` : ''}`.slice(0, 500);

    let totalCogs = 0;
    let totalQuantityBase = 0;
    const recordedLines: Array<{
      inventoryItemId: string;
      ingredientName: string;
      uomCode: string;
      quantity: number;
      totalCost: number;
    }> = [];

    for (const plan of deductionsPlan) {
      const res = await deductStockFirestore(snap, {
        inventoryItemId: plan.invItem.id,
        locationId: locDocId,
        quantity: plan.qty,
        txnType,
        referenceType: linkedProd ? 'RECIPE_WASTE' : 'WASTE_LOG',
        referenceId: wasteDocId,
        userId: user.id,
        notes: noteSummary,
      });
      totalCogs = round2(totalCogs + Number(res.totalCogs || 0));
      totalQuantityBase = round4(totalQuantityBase + plan.qty);
      recordedLines.push({
        inventoryItemId: toLogicalId(plan.invItem.id, uid),
        ingredientName: String(plan.invItem.name || 'Ingredient').slice(0, 120),
        uomCode: String(plan.invItem.uomCode || '').slice(0, 20),
        quantity: plan.qty,
        totalCost: round2(res.totalCogs || 0),
      });
    }

    const safeLoggedBy = String(user.id || 'usr_staff').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128) || 'usr_staff';
    const wasteDoc = {
      id: wasteDocId,
      ownerUid: uid,
      locationId: locDocId,
      locationName: String(locObj.name || 'Location').slice(0, 140),
      entryMode,
      txnType,
      reasonCategory,
      reasonNotes: reasonNotes || null,
      productId: linkedProd ? linkedProd.id : null,
      productName: linkedProd ? String(linkedProd.name).slice(0, 160) : null,
      servingsWasted: servingsNum,
      primaryItemId: primaryItemDoc ? primaryItemDoc.id : null,
      primaryItemName: primaryItemDoc ? String(primaryItemDoc.name).slice(0, 160) : null,
      items: recordedLines.slice(0, 40),
      totalQuantityBase,
      totalLossCost: totalCogs,
      loggedBy: safeLoggedBy,
      loggedByName: String(user.fullName || 'Kitchen Staff').trim().slice(0, 150) || 'Kitchen Staff',
      wastedAt: nowIso,
      createdAt: serverTimestamp(),
    };

    try {
      await setDoc(doc(db, 'waste_logs', wasteDocId), wasteDoc);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `waste_logs/${wasteDocId}`);
    }

    await addAuditLog(uid, user.id, user.fullName, 'RECORD_WASTE', linkedProd ? 'Product' : 'InventoryItem', linkedProd ? toLogicalId(linkedProd.id, uid) : toLogicalId(primaryItemDoc?.id || '', uid), {
      wasteId: logicalWasteId,
      entryMode,
      txnType,
      locationId: toLogicalId(locDocId, uid),
      productName: linkedProd?.name || null,
      servingsWasted: servingsNum,
      totalLossCost: totalCogs,
      reasonCategory,
      reason: reasonNotes,
    });
    invalidateWorkspaceCache();
    return {
      totalCogs,
      itemsDeducted: recordedLines.length,
      wasteLog: {
        ...wasteDoc,
        id: logicalWasteId,
        locationId: toLogicalId(locDocId, uid),
        productId: linkedProd ? toLogicalId(linkedProd.id, uid) : null,
        primaryItemId: primaryItemDoc ? toLogicalId(primaryItemDoc.id, uid) : null,
      },
    } as T;
  }

  if (pathname === '/inventory/reconcile' && method === 'POST') {
    assertPerm(user, PERMISSIONS.INVENTORY_ADJUST);
    const { inventoryItemId, locationId, countedQty, notes } = body;
    const itemDocId = toDocId(inventoryItemId, uid);
    const locDocId = toDocId(locationId, uid);
    const item = snap.inventoryItems.find((i) => i.id === itemDocId);
    if (!item) throw new Error('Inventory item not found');

    const sysQty = snap.stockBatches
      .filter((b) => b.inventoryItemId === itemDocId && b.locationId === locDocId)
      .reduce((s, b) => s + Number(b.remainingQty || 0), 0);
    const variance = round2(Number(countedQty) - sysQty);
    if (variance === 0) return { variance: 0, status: 'MATCHED' } as T;

    if (variance > 0) {
      await receiveStockFirestore(snap, {
        inventoryItemId: itemDocId,
        locationId: locDocId,
        quantity: variance,
        unitCost: Number(item.lastUnitCost || 0),
        batchNumber: `CNT-${Date.now().toString().slice(-5)}`,
        txnType: 'IN_ADJUSTMENT',
        referenceType: 'STOCK_COUNT',
        referenceId: crypto.randomUUID(),
        userId: user.id,
        notes: notes || 'Physical stock count surplus',
      });
    } else {
      await deductStockFirestore(snap, {
        inventoryItemId: itemDocId,
        locationId: locDocId,
        quantity: Math.abs(variance),
        txnType: 'OUT_ADJUSTMENT',
        referenceType: 'STOCK_COUNT',
        referenceId: crypto.randomUUID(),
        userId: user.id,
        notes: notes || 'Physical stock count shrinkage',
      });
    }
    await addAuditLog(uid, user.id, user.fullName, 'STOCK_RECONCILE', 'InventoryItem', inventoryItemId, {
      locationId: toLogicalId(locDocId, uid),
      sysQty,
      countedQty,
      variance,
    });
    invalidateWorkspaceCache();
    return { sysQty, countedQty: Number(countedQty), variance, status: 'ADJUSTED' } as T;
  }

  // 6. PROCUREMENT & AP
  const getApprovalThreshold = () => {
    const val = Number(snap.meta?.poApprovalThreshold);
    return Number.isFinite(val) && val >= 0 ? round2(val) : 10000;
  };

  if (pathname === '/procurement' && method === 'GET') {
    assertAnyPerm(user, PERMISSIONS.PO_CREATE, PERMISSIONS.PO_APPROVE);
    const approvalThreshold = getApprovalThreshold();
    const supMap = new Map(snap.suppliers.map((s) => [s.id, s]));
    const locMap = new Map(snap.locations.map((l) => [l.id, l]));
    const itemMap = new Map(snap.inventoryItems.map((i) => [i.id, i]));

    const supplierAuditLogs = [...snap.auditLogs]
      .filter((log) => log.entityType === 'Supplier')
      .map((log) => {
        const logicalSupId = toLogicalId(String(log.entityId || ''), uid);
        const sup = supMap.get(toDocId(logicalSupId, uid)) || supMap.get(String(log.entityId || ''));
        return {
          id: toLogicalId(log.id, uid),
          supplier_id: logicalSupId,
          supplier_name: sup?.name || 'Supplier',
          supplier_code: sup?.code || '',
          action: log.action,
          user_id: log.userId ? toLogicalId(String(log.userId), uid) : null,
          user_name: log.userName || 'System',
          details: log.details || '',
          logged_at: log.loggedAt || tsToIso(log.createdAt),
        };
      })
      .sort((a, b) => String(b.logged_at).localeCompare(String(a.logged_at)));

    const latestAuditBySupplier = new Map<string, any>();
    const auditCountBySupplier = new Map<string, number>();
    for (const entry of supplierAuditLogs) {
      if (!latestAuditBySupplier.has(entry.supplier_id)) {
        latestAuditBySupplier.set(entry.supplier_id, entry);
      }
      auditCountBySupplier.set(entry.supplier_id, (auditCountBySupplier.get(entry.supplier_id) || 0) + 1);
    }

    const suppliers = snap.suppliers
      .filter((s) => s.isActive)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map((s) => {
        const logicalId = toLogicalId(s.id, uid);
        const latestAudit = latestAuditBySupplier.get(logicalId);
        const createdIso = s.createdAt ? tsToIso(s.createdAt) : null;
        const updatedIso = s.updatedAt ? tsToIso(s.updatedAt) : latestAudit?.logged_at || createdIso;
        return {
          id: logicalId,
          code: s.code,
          name: s.name,
          contact_person: s.contactPerson,
          phone: s.phone,
          email: s.email,
          address: s.address,
          tin: s.tin,
          payment_terms: s.paymentTerms,
          created_at: createdIso,
          updated_at: updatedIso,
          updated_by: s.updatedBy ? toLogicalId(String(s.updatedBy), uid) : latestAudit?.user_id || null,
          updated_by_name: s.updatedByName || latestAudit?.user_name || 'System Seed',
          audit_count: auditCountBySupplier.get(logicalId) || 0,
        };
      });

    const seedPricePairs = [
      ['si_1', 'sup_1', 'ing_pork', 0.34, 1],
      ['si_2', 'sup_1', 'ing_beef', 0.58, 1],
      ['si_3', 'sup_3', 'ing_pork', 0.36, 2],
      ['si_4', 'sup_2', 'ing_bun', 14.0, 1],
      ['si_5', 'sup_2', 'ing_tortilla', 8.5, 1],
      ['si_6', 'sup_3', 'ing_potato', 0.14, 1],
      ['si_7', 'sup_3', 'ing_mango', 0.16, 2],
    ] as const;
    const priceComparison = seedPricePairs
      .map(([id, sId, iId, price, lead]) => {
        const s = supMap.get(toDocId(sId, uid));
        const item = itemMap.get(toDocId(iId, uid));
        if (!s || !item) return null;
        return {
          id,
          supplier_id: sId,
          inventory_item_id: iId,
          unit_price: price,
          lead_time_days: lead,
          supplier_name: s.name,
          item_name: item.name,
          uom_code: item.uomCode,
        };
      })
      .filter(Boolean);

    const poInvoicesMap = new Map<string, any[]>();
    for (const inv of snap.supplierInvoices) {
      if (!inv.purchaseOrderId) continue;
      const arr = poInvoicesMap.get(inv.purchaseOrderId) || [];
      arr.push(inv);
      poInvoicesMap.set(inv.purchaseOrderId, arr);
    }

    const purchaseOrders = [...snap.purchaseOrders]
      .sort((a, b) => String(b.orderedAt).localeCompare(String(a.orderedAt)))
      .map((po) => {
        const linkedInvs = poInvoicesMap.get(po.id) || [];
        const allLinkedPaid = linkedInvs.length > 0 && linkedInvs.every((inv) => inv.status === 'PAID');
        const resolvedStatus = po.status === 'RECEIVED' && allLinkedPaid ? 'PAID' : po.status;
        return {
          id: toLogicalId(po.id, uid),
          po_number: po.poNumber,
          supplier_id: toLogicalId(po.supplierId, uid),
          location_id: toLogicalId(po.locationId, uid),
          status: resolvedStatus,
          total_amount: po.totalAmount,
          approved_by: po.approvedBy ? toLogicalId(po.approvedBy, uid) : null,
          stage1_approved_by: po.stage1ApprovedBy ? toLogicalId(po.stage1ApprovedBy, uid) : null,
          stage1_approved_by_name: po.stage1ApprovedByName || null,
          stage1_approved_at: po.stage1ApprovedAt || null,
          manager_signature_data: po.managerSignatureData || null,
          manager_signer_name: po.managerSignerName || null,
          signed_at: po.signedAt || null,
          notes: po.notes,
          ordered_at: po.orderedAt,
          expected_at: po.expectedAt,
          supplier_name: supMap.get(po.supplierId)?.name || 'Supplier',
          location_name: locMap.get(po.locationId)?.name || 'Location',
          items: (po.items || []).map((pi: any) => {
            const item = itemMap.get(pi.inventoryItemId);
            return {
              id: pi.id,
              purchase_order_id: toLogicalId(po.id, uid),
              inventory_item_id: toLogicalId(pi.inventoryItemId, uid),
              ordered_qty: pi.orderedQty,
              received_qty: pi.receivedQty,
              unit_cost: pi.unitCost,
              item_name: item?.name || 'Item',
              uom_code: item?.uomCode || '',
            };
          }),
        };
      });

    const poMap = new Map(snap.purchaseOrders.map((p) => [p.id, p]));
    const grnByInvNoMap = new Map(snap.goodsReceipts.map((g) => [`SI-${g.grnNumber}`, g]));

    const invoices = [...snap.supplierInvoices]
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))
      .map((inv) => {
        const supplier = supMap.get(inv.supplierId);
        const po = inv.purchaseOrderId ? poMap.get(inv.purchaseOrderId) : null;
        const grn = grnByInvNoMap.get(inv.invoiceNumber) || null;
        const grnItems = (grn?.items || []).filter((gi: any) => Number(gi.receivedQty || 0) > 0);
        const rawItems = grnItems.length > 0 ? grnItems : po?.items || [];
        const items = rawItems.map((line: any) => {
          const item = itemMap.get(line.inventoryItemId);
          const qty = grnItems.length > 0 ? Number(line.receivedQty || 0) : Number(line.orderedQty || 0);
          const unitCost = Number(line.unitCost || 0);
          return {
            id: line.id,
            item_name: item?.name || 'Item',
            uom_code: item?.uomCode || '',
            quantity: qty,
            unit_cost: unitCost,
            line_total: round2(qty * unitCost),
            batch_number: line.batchNumber || null,
          };
        });
        const payments = (inv.payments || []).map((p: any) => ({
          id: p.id,
          payment_number: p.paymentNumber || p.payment_number || '',
          amount: Number(p.amount || 0),
          method: p.method || 'BANK_TRANSFER',
          reference_no: p.referenceNo || p.reference_no || '',
          paid_at: p.paidAt || p.paid_at || '',
        }));

        return {
          id: toLogicalId(inv.id, uid),
          invoice_number: inv.invoiceNumber,
          supplier_id: toLogicalId(inv.supplierId, uid),
          purchase_order_id: inv.purchaseOrderId ? toLogicalId(inv.purchaseOrderId, uid) : null,
          location_id: po?.locationId ? toLogicalId(po.locationId, uid) : null,
          total_amount: inv.totalAmount,
          paid_amount: inv.paidAmount,
          due_date: inv.dueDate,
          created_at: grn?.receivedAt || inv.dueDate,
          status: inv.status,
          supplier_name: supplier?.name || 'Supplier',
          supplier_code: supplier?.code || '',
          supplier_tin: supplier?.tin || '',
          supplier_contact: supplier?.contactPerson || '',
          supplier_phone: supplier?.phone || '',
          supplier_email: supplier?.email || '',
          supplier_address: supplier?.address || '',
          payment_terms: supplier?.paymentTerms ?? 0,
          po_number: po?.poNumber || null,
          grn_number: grn?.grnNumber || null,
          location_name: po ? locMap.get(po.locationId)?.name || null : null,
          items,
          payments,
        };
      });

    return { approvalThreshold, suppliers, supplierAuditLogs, priceComparison, purchaseOrders, invoices } as T;
  }

  if (pathname === '/procurement/approval-config' && method === 'PUT') {
    assertPerm(user, PERMISSIONS.PO_APPROVE);
    const raw = Number(body?.approvalThreshold);
    if (!Number.isFinite(raw) || raw < 0) {
      throw new Error('Approval threshold must be a valid non-negative amount');
    }
    const nextThreshold = round2(raw);
    try {
      await updateDoc(doc(db, 'workspace_meta', `ws_${uid}`), {
        poApprovalThreshold: nextThreshold,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `workspace_meta/ws_${uid}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'UPDATE_PO_APPROVAL_THRESHOLD', 'PurchaseOrderConfig', 'po_approval_threshold', {
      approvalThreshold: nextThreshold,
    });
    invalidateWorkspaceCache();
    return { ok: true, approvalThreshold: nextThreshold } as T;
  }

  if (pathname === '/procurement/suppliers' && method === 'POST') {
    assertPerm(user, PERMISSIONS.PO_CREATE);
    const { code, name, contactPerson, phone, email, address, tin, paymentTerms } = body || {};
    const cleanName = String(name || '').trim().slice(0, 160);
    if (!cleanName) throw new Error('Supplier name is required');
    const cleanCode = String(code || `SUP-${Date.now().toString().slice(-4)}`).trim().slice(0, 40);
    if (!cleanCode) throw new Error('Supplier code is required');

    const logicalId = crypto.randomUUID();
    const docId = toDocId(logicalId, uid);
    const cleanTerms = Math.max(0, Math.round(Number(paymentTerms || 0)));
    const actorName = String(user.fullName || user.email || 'Unknown User').trim().slice(0, 150);
    const actorDocId = toDocId(user.id, uid);
    try {
      await setDoc(doc(db, 'suppliers', docId), {
        id: docId,
        ownerUid: uid,
        code: cleanCode,
        name: cleanName,
        contactPerson: String(contactPerson || '').trim().slice(0, 120),
        phone: String(phone || '').trim().slice(0, 40),
        email: String(email || '').trim().slice(0, 160),
        address: String(address || '').trim().slice(0, 300),
        tin: String(tin || '').trim().slice(0, 40),
        paymentTerms: cleanTerms,
        isActive: true,
        updatedBy: actorDocId,
        updatedByName: actorName,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `suppliers/${docId}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'CREATE_SUPPLIER', 'Supplier', logicalId, {
      code: cleanCode,
      name: cleanName,
      paymentTerms: `${cleanTerms} days`,
    });
    invalidateWorkspaceCache();
    return { id: logicalId } as T;
  }

  if (pathname.startsWith('/procurement/suppliers/') && method === 'PUT') {
    assertPerm(user, PERMISSIONS.PO_CREATE);
    const rawId = pathname.split('/')[3];
    const docId = toDocId(rawId, uid);
    const existingSup = snap.suppliers.find((s) => s.id === docId);
    if (!existingSup) throw new Error('Supplier not found');

    const { code, name, contactPerson, phone, email, address, tin, paymentTerms } = body || {};
    const cleanName = String(name ?? existingSup.name ?? '').trim().slice(0, 160);
    const cleanCode = String(code ?? existingSup.code ?? '').trim().slice(0, 40);
    if (!cleanName) throw new Error('Supplier name is required');
    if (!cleanCode) throw new Error('Supplier code is required');

    const nextContact = String(contactPerson ?? existingSup.contactPerson ?? '').trim().slice(0, 120);
    const nextPhone = String(phone ?? existingSup.phone ?? '').trim().slice(0, 40);
    const nextEmail = String(email ?? existingSup.email ?? '').trim().slice(0, 160);
    const nextAddress = String(address ?? existingSup.address ?? '').trim().slice(0, 300);
    const nextTin = String(tin ?? existingSup.tin ?? '').trim().slice(0, 40);
    const nextTerms = Math.max(0, Math.round(Number(paymentTerms ?? existingSup.paymentTerms ?? 0)));
    const actorName = String(user.fullName || user.email || 'Unknown User').trim().slice(0, 150);
    const actorDocId = toDocId(user.id, uid);

    const changes: string[] = [];
    if (cleanCode !== String(existingSup.code || '')) changes.push(`Code: ${existingSup.code || '—'} -> ${cleanCode}`);
    if (cleanName !== String(existingSup.name || '')) changes.push(`Name: ${existingSup.name || '—'} -> ${cleanName}`);
    if (nextContact !== String(existingSup.contactPerson || '')) changes.push(`Contact: ${existingSup.contactPerson || '—'} -> ${nextContact || '—'}`);
    if (nextPhone !== String(existingSup.phone || '')) changes.push(`Phone: ${existingSup.phone || '—'} -> ${nextPhone || '—'}`);
    if (nextEmail !== String(existingSup.email || '')) changes.push(`Email: ${existingSup.email || '—'} -> ${nextEmail || '—'}`);
    if (nextAddress !== String(existingSup.address || '')) changes.push(`Address: ${existingSup.address || '—'} -> ${nextAddress || '—'}`);
    if (nextTin !== String(existingSup.tin || '')) changes.push(`TIN: ${existingSup.tin || '—'} -> ${nextTin || '—'}`);
    if (nextTerms !== Number(existingSup.paymentTerms || 0)) changes.push(`Terms: ${existingSup.paymentTerms || 0}d -> ${nextTerms}d`);

    try {
      await updateDoc(doc(db, 'suppliers', existingSup.id), {
        code: cleanCode,
        name: cleanName,
        contactPerson: nextContact,
        phone: nextPhone,
        email: nextEmail,
        address: nextAddress,
        tin: nextTin,
        paymentTerms: nextTerms,
        updatedBy: actorDocId,
        updatedByName: actorName,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `suppliers/${existingSup.id}`);
    }
    await addAuditLog(
      uid,
      user.id,
      user.fullName,
      'UPDATE_SUPPLIER',
      'Supplier',
      toLogicalId(existingSup.id, uid),
      changes.length > 0 ? changes.join(' | ') : `Reviewed supplier profile (${cleanName})`,
    );
    invalidateWorkspaceCache();
    return { ok: true, id: toLogicalId(existingSup.id, uid) } as T;
  }

  if (pathname.startsWith('/procurement/suppliers/') && method === 'DELETE') {
    assertPerm(user, PERMISSIONS.PO_CREATE);
    const rawId = pathname.split('/')[3];
    const docId = toDocId(rawId, uid);
    const existingSup = snap.suppliers.find((s) => s.id === docId);
    if (!existingSup) throw new Error('Supplier not found');

    const hasHistory =
      snap.purchaseOrders.some((p) => p.supplierId === existingSup.id) ||
      snap.supplierInvoices.some((inv) => inv.supplierId === existingSup.id);
    const actorName = String(user.fullName || user.email || 'Unknown User').trim().slice(0, 150);
    const actorDocId = toDocId(user.id, uid);

    try {
      if (hasHistory) {
        await updateDoc(doc(db, 'suppliers', existingSup.id), {
          isActive: false,
          updatedBy: actorDocId,
          updatedByName: actorName,
          updatedAt: serverTimestamp(),
        });
      } else {
        await deleteDoc(doc(db, 'suppliers', existingSup.id));
      }
    } catch (err) {
      handleFirestoreError(err, hasHistory ? OperationType.UPDATE : OperationType.DELETE, `suppliers/${existingSup.id}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'DELETE_SUPPLIER', 'Supplier', toLogicalId(existingSup.id, uid), {
      name: existingSup.name,
      archived: hasHistory,
    });
    invalidateWorkspaceCache();
    return { ok: true, archived: hasHistory } as T;
  }

  if (pathname === '/procurement/purchase-orders' && method === 'POST') {
    assertPerm(user, PERMISSIONS.PO_CREATE);
    const { supplierId, locationId, expectedAt, notes, items, status } = body || {};
    if (!items?.length) throw new Error('PO requires at least one item');
    const requestedStatus = String(status || 'PENDING_APPROVAL').toUpperCase();
    if (!['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(requestedStatus)) {
      throw new Error('Invalid initial purchase order status');
    }
    const approvalThreshold = getApprovalThreshold();
    const totalAmount = round2(items.reduce((s: number, i: any) => s + Number(i.orderedQty) * Number(i.unitCost), 0));

    if (requestedStatus === 'APPROVED') {
      assertPerm(user, PERMISSIONS.PO_APPROVE);
      if (totalAmount > approvalThreshold) {
        throw new Error(
          `Order total (${totalAmount.toFixed(2)}) exceeds the ${approvalThreshold.toFixed(2)} threshold. Submit for Stage 1 verification and Stage 2 Manager Digital Signature.`,
        );
      }
    }

    const logicalId = crypto.randomUUID();
    const poDocId = toDocId(logicalId, uid);
    const poNumber = `PO-${Date.now().toString().slice(-6)}`;

    try {
      await setDoc(doc(db, 'purchase_orders', poDocId), {
        id: poDocId,
        ownerUid: uid,
        poNumber,
        supplierId: toDocId(supplierId, uid),
        locationId: toDocId(locationId, uid),
        status: requestedStatus,
        totalAmount,
        approvedBy: requestedStatus === 'APPROVED' ? toDocId(user.id, uid) : null,
        notes: String(notes || '').slice(0, 500),
        items: items.map((i: any) => ({
          id: crypto.randomUUID(),
          inventoryItemId: toDocId(i.inventoryItemId, uid),
          orderedQty: Number(i.orderedQty),
          receivedQty: 0,
          unitCost: Number(i.unitCost),
        })),
        orderedAt: new Date().toISOString(),
        expectedAt: expectedAt || null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `purchase_orders/${poDocId}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'CREATE_PO', 'PurchaseOrder', logicalId, {
      poNumber,
      totalAmount,
      status: requestedStatus,
    });
    invalidateWorkspaceCache();
    return { id: logicalId, poNumber, status: requestedStatus } as T;
  }

  if (pathname.startsWith('/procurement/purchase-orders/') && method === 'PUT') {
    assertAnyPerm(user, PERMISSIONS.PO_CREATE, PERMISSIONS.PO_APPROVE, PERMISSIONS.FINANCE_VIEW);
    const id = pathname.split('/')[3];
    const poDocId = toDocId(id, uid);
    const po = snap.purchaseOrders.find((p) => p.id === poDocId);
    if (!po) throw new Error('Purchase order not found');

    const { supplierId, locationId, expectedAt, notes, items, approve, status } = body || {};
    const requestedStatus = status ? String(status).toUpperCase() : undefined;

    if (requestedStatus === 'PAID' && (po.status === 'RECEIVED' || po.status === 'PARTIAL' || po.status === 'PARTIALLY_RECEIVED')) {
      assertAnyPerm(user, PERMISSIONS.FINANCE_VIEW, PERMISSIONS.PO_APPROVE);
      try {
        await updateDoc(doc(db, 'purchase_orders', poDocId), {
          status: 'PAID',
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `purchase_orders/${poDocId}`);
      }
      await addAuditLog(uid, user.id, user.fullName, 'MARK_PO_PAID', 'PurchaseOrder', id, {
        poNumber: po.poNumber,
        status: 'PAID',
      });
      invalidateWorkspaceCache();
      return { ok: true, id, poNumber: po.poNumber, status: 'PAID', totalAmount: po.totalAmount } as T;
    }

    if (po.status !== 'DRAFT' && po.status !== 'PENDING_APPROVAL') {
      throw new Error('Only draft or pending purchase orders can be edited');
    }

    if (!supplierId || !locationId) throw new Error('Supplier and delivery location are required');
    if (!Array.isArray(items) || items.length === 0) throw new Error('PO requires at least one item');

    const normalizedItems = items.map((i: any) => {
      const qty = Number(i.orderedQty);
      const cost = Number(i.unitCost);
      if (!i.inventoryItemId || !Number.isFinite(qty) || qty <= 0) {
        throw new Error('Every PO line item requires an ingredient and positive quantity');
      }
      if (!Number.isFinite(cost) || cost < 0) {
        throw new Error('Unit cost cannot be negative');
      }
      return {
        id: String(i.id || crypto.randomUUID()),
        inventoryItemId: toDocId(i.inventoryItemId, uid),
        orderedQty: qty,
        receivedQty: 0,
        unitCost: cost,
      };
    });

    const approvalThreshold = getApprovalThreshold();
    const totalAmount = round2(normalizedItems.reduce((s: number, i: any) => s + i.orderedQty * i.unitCost, 0));
    const wantsApproval = Boolean(approve) || requestedStatus === 'APPROVED' || requestedStatus === 'PENDING_MANAGER_SIGNATURE';

    if (wantsApproval) {
      assertPerm(user, PERMISSIONS.PO_APPROVE);
    } else {
      assertAnyPerm(user, PERMISSIONS.PO_CREATE, PERMISSIONS.PO_APPROVE);
    }

    const requiresSignature = wantsApproval && totalAmount > approvalThreshold;
    const nextStatus = wantsApproval
      ? requiresSignature
        ? 'PENDING_MANAGER_SIGNATURE'
        : 'APPROVED'
      : requestedStatus === 'DRAFT'
        ? 'DRAFT'
        : 'PENDING_APPROVAL';

    const actorName = String(user.fullName || user.email || 'Manager').trim().slice(0, 150);
    const nowIso = new Date().toISOString();

    const updates: Record<string, any> = {
      supplierId: toDocId(supplierId, uid),
      locationId: toDocId(locationId, uid),
      expectedAt: expectedAt ? String(expectedAt).slice(0, 40) : null,
      notes: String(notes || '').slice(0, 500),
      items: normalizedItems,
      totalAmount,
      status: nextStatus,
      updatedAt: serverTimestamp(),
    };
    if (nextStatus === 'APPROVED') {
      updates.approvedBy = toDocId(user.id, uid);
    } else if (nextStatus === 'PENDING_MANAGER_SIGNATURE') {
      updates.stage1ApprovedBy = toDocId(user.id, uid);
      updates.stage1ApprovedByName = actorName;
      updates.stage1ApprovedAt = nowIso;
    }

    try {
      await updateDoc(doc(db, 'purchase_orders', poDocId), updates);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `purchase_orders/${poDocId}`);
    }
    await addAuditLog(
      uid,
      user.id,
      user.fullName,
      nextStatus === 'PENDING_MANAGER_SIGNATURE'
        ? 'STAGE1_APPROVE_PO'
        : nextStatus === 'APPROVED'
          ? 'REVIEW_AND_APPROVE_PO'
          : 'EDIT_PO',
      'PurchaseOrder',
      id,
      {
        poNumber: po.poNumber,
        totalAmount,
        status: nextStatus,
      },
    );
    invalidateWorkspaceCache();
    return { ok: true, id, poNumber: po.poNumber, status: nextStatus, requiresSignature, totalAmount } as T;
  }

  if (pathname.startsWith('/procurement/purchase-orders/') && pathname.endsWith('/approve') && method === 'POST') {
    assertPerm(user, PERMISSIONS.PO_APPROVE);
    const id = pathname.split('/')[3];
    const poDocId = toDocId(id, uid);
    const po = snap.purchaseOrders.find((p) => p.id === poDocId);
    if (!po) throw new Error('Purchase order not found');

    const approvalThreshold = getApprovalThreshold();
    const totalAmount = round2(Number(po.totalAmount || 0));
    const actorName = String(user.fullName || user.email || 'Manager').trim().slice(0, 150);
    const nowIso = new Date().toISOString();

    if (po.status === 'DRAFT' || po.status === 'PENDING_APPROVAL') {
      if (totalAmount > approvalThreshold) {
        try {
          await updateDoc(doc(db, 'purchase_orders', poDocId), {
            status: 'PENDING_MANAGER_SIGNATURE',
            stage1ApprovedBy: toDocId(user.id, uid),
            stage1ApprovedByName: actorName,
            stage1ApprovedAt: nowIso,
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `purchase_orders/${poDocId}`);
        }
        await addAuditLog(uid, user.id, user.fullName, 'STAGE1_APPROVE_PO', 'PurchaseOrder', id, {
          poNumber: po.poNumber,
          totalAmount,
          approvalThreshold,
        });
        invalidateWorkspaceCache();
        return { ok: true, status: 'PENDING_MANAGER_SIGNATURE', requiresSignature: true } as T;
      }

      try {
        await updateDoc(doc(db, 'purchase_orders', poDocId), {
          status: 'APPROVED',
          approvedBy: toDocId(user.id, uid),
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `purchase_orders/${poDocId}`);
      }
      await addAuditLog(uid, user.id, user.fullName, 'APPROVE_PO', 'PurchaseOrder', id, {
        poNumber: po.poNumber,
        totalAmount,
      });
      invalidateWorkspaceCache();
      return { ok: true, status: 'APPROVED', requiresSignature: false } as T;
    }

    if (po.status === 'PENDING_MANAGER_SIGNATURE') {
      const signatureData = String(body?.signatureData || '').trim();
      const signerName = String(body?.signerName || actorName).trim().slice(0, 150);
      if (!signatureData.startsWith('data:image/') || signatureData.length < 30 || signatureData.length > 200000) {
        throw new Error('A valid drawn manager digital signature is required for this purchase order');
      }
      if (!signerName) {
        throw new Error('Manager signer name is required');
      }
      try {
        await updateDoc(doc(db, 'purchase_orders', poDocId), {
          status: 'APPROVED',
          approvedBy: toDocId(user.id, uid),
          managerSignatureData: signatureData,
          managerSignerName: signerName,
          signedAt: nowIso,
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `purchase_orders/${poDocId}`);
      }
      await addAuditLog(uid, user.id, user.fullName, 'STAGE2_SIGN_APPROVE_PO', 'PurchaseOrder', id, {
        poNumber: po.poNumber,
        signerName,
        totalAmount,
        signedAt: nowIso,
      });
      invalidateWorkspaceCache();
      return { ok: true, status: 'APPROVED', signedAt: nowIso } as T;
    }

    throw new Error('Only draft, pending approval, or signature-pending purchase orders can be approved');
  }

  if (pathname.startsWith('/procurement/purchase-orders/') && pathname.endsWith('/cancel') && method === 'POST') {
    assertAnyPerm(user, PERMISSIONS.PO_CREATE, PERMISSIONS.PO_APPROVE);
    const id = pathname.split('/')[3];
    const poDocId = toDocId(id, uid);
    const po = snap.purchaseOrders.find((p) => p.id === poDocId);
    if (!po) throw new Error('Purchase order not found');
    if (po.status !== 'DRAFT' && po.status !== 'PENDING_APPROVAL' && po.status !== 'PENDING_MANAGER_SIGNATURE' && po.status !== 'APPROVED') {
      throw new Error('Only draft, pending, signature-pending, or unreceived approved purchase orders can be cancelled');
    }
    const hasReceived = (po.items || []).some((pi: any) => Number(pi.receivedQty || 0) > 0);
    if (hasReceived) {
      throw new Error('Cannot cancel a purchase order that already has received goods');
    }

    const reason = String(body?.reason || '').trim();
    const prevNotes = String(po.notes || '').trim();
    const cancelNote = reason ? `Cancelled: ${reason}` : 'Cancelled by user';
    const nextNotes = (prevNotes ? `${prevNotes} | ${cancelNote}` : cancelNote).slice(0, 500);

    try {
      await updateDoc(doc(db, 'purchase_orders', poDocId), {
        status: 'CANCELLED',
        notes: nextNotes,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `purchase_orders/${poDocId}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'CANCEL_PO', 'PurchaseOrder', id, {
      poNumber: po.poNumber,
      reason: reason || null,
    });
    invalidateWorkspaceCache();
    return { ok: true, id, status: 'CANCELLED' } as T;
  }

  if (pathname.startsWith('/procurement/purchase-orders/') && pathname.endsWith('/receive') && method === 'POST') {
    assertPerm(user, PERMISSIONS.GRN_RECEIVE);
    const id = pathname.split('/')[3];
    const poDocId = toDocId(id, uid);
    const po = snap.purchaseOrders.find((p) => p.id === poDocId);
    if (!po) throw new Error('PO not found');
    if (po.status !== 'APPROVED' && po.status !== 'PARTIAL' && po.status !== 'PARTIALLY_RECEIVED') {
      throw new Error('PO must be APPROVED or PARTIAL to receive');
    }

    const { items, notes } = body || {};
    const grnId = toDocId(crypto.randomUUID(), uid);
    const grnNumber = `GRN-${Date.now().toString().slice(-6)}`;
    let totalRecvValue = 0;
    const grnItems: any[] = [];
    const updatedPoItems = (po.items || []).map((pi: any) => ({ ...pi }));

    for (const line of items || []) {
      const poItem = updatedPoItems.find((x: any) => x.id === line.poItemId);
      if (!poItem) continue;
      const recvQty = Number(line.receivedQty || 0);
      const rejQty = Number(line.rejectedQty || 0);
      const unitCost = Number(line.unitCost ?? poItem.unitCost);
      const batchNo = line.batchNumber || `${grnNumber}-${String(poItem.inventoryItemId).slice(-4)}`;

      grnItems.push({
        id: crypto.randomUUID(),
        inventoryItemId: poItem.inventoryItemId,
        orderedQty: poItem.orderedQty,
        receivedQty: recvQty,
        rejectedQty: rejQty,
        unitCost,
        batchNumber: batchNo,
        expiryDate: line.expiryDate || null,
        discrepancyNotes: line.discrepancyNotes || null,
      });

      if (recvQty > 0) {
        await receiveStockFirestore(snap, {
          inventoryItemId: poItem.inventoryItemId,
          locationId: po.locationId,
          quantity: recvQty,
          unitCost,
          batchNumber: batchNo,
          expiryDate: line.expiryDate || null,
          txnType: 'IN_PURCHASE',
          referenceType: 'GRN',
          referenceId: grnId,
          userId: user.id,
          notes: `GRN ${grnNumber} (${po.poNumber})`,
        });
        totalRecvValue += round2(recvQty * unitCost);
        poItem.receivedQty = Number(poItem.receivedQty || 0) + recvQty;
      }
    }

    const allDone = updatedPoItems.every((x: any) => Number(x.receivedQty) >= Number(x.orderedQty));
    const nextStatus = allDone ? 'RECEIVED' : 'PARTIAL';

    const batch = writeBatch(db);
    batch.set(doc(db, 'goods_receipts', grnId), {
      id: grnId,
      ownerUid: uid,
      grnNumber,
      purchaseOrderId: poDocId,
      receivedBy: user.id,
      notes: notes || '',
      items: grnItems,
      receivedAt: new Date().toISOString(),
      createdAt: serverTimestamp(),
    });

    batch.update(doc(db, 'purchase_orders', poDocId), {
      status: nextStatus,
      items: updatedPoItems,
      updatedAt: serverTimestamp(),
    });

    if (totalRecvValue > 0) {
      const invId = toDocId(crypto.randomUUID(), uid);
      batch.set(doc(db, 'supplier_invoices', invId), {
        id: invId,
        ownerUid: uid,
        invoiceNumber: `SI-${grnNumber}`,
        supplierId: po.supplierId,
        purchaseOrderId: poDocId,
        totalAmount: round2(totalRecvValue),
        paidAmount: 0,
        dueDate: new Date(Date.now() + 15 * 86400000).toISOString(),
        status: 'UNPAID',
        payments: [],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      const jeId = toDocId(crypto.randomUUID(), uid);
      batch.set(doc(db, 'journal_entries', jeId), {
        id: jeId,
        ownerUid: uid,
        entryNumber: `JE-${grnNumber}`,
        entryDate: new Date().toISOString(),
        description: `Goods Receipt ${grnNumber}`,
        referenceType: 'GRN',
        referenceId: grnId,
        isReversed: false,
        lines: [
          { id: crypto.randomUUID(), accountId: toDocId('acc_1200', uid), debit: round2(totalRecvValue), credit: 0, memo: 'Inventory Received' },
          { id: crypto.randomUUID(), accountId: toDocId('acc_2000', uid), debit: 0, credit: round2(totalRecvValue), memo: 'Supplier Payable' },
        ],
        createdAt: serverTimestamp(),
      });
    }

    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `purchase_orders/${poDocId}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'RECEIVE_GRN', 'GoodsReceipt', toLogicalId(grnId, uid), {
      poNumber: po.poNumber,
      totalRecvValue: round2(totalRecvValue),
    });
    invalidateWorkspaceCache();
    return { grnId: toLogicalId(grnId, uid), grnNumber, totalRecvValue: round2(totalRecvValue) } as T;
  }

  if (pathname.startsWith('/procurement/invoices/') && pathname.endsWith('/pay') && method === 'POST') {
    assertPerm(user, PERMISSIONS.FINANCE_VIEW);
    const id = pathname.split('/')[3];
    const invDocId = toDocId(id, uid);
    const inv = snap.supplierInvoices.find((x) => x.id === invDocId);
    if (!inv) throw new Error('Invoice not found');

    const payAmt = round2(Number(body.amount));
    const newPaid = round2(Number(inv.paidAmount || 0) + payAmt);
    if (newPaid > Number(inv.totalAmount) + 0.01) throw new Error('Payment exceeds invoice balance');
    const payNo = `PAY-${Date.now().toString().slice(-6)}`;
    const nextPayments = [
      ...(inv.payments || []),
      {
        id: crypto.randomUUID(),
        paymentNumber: payNo,
        amount: payAmt,
        method: body.method || 'BANK_TRANSFER',
        referenceNo: body.referenceNo || '',
        paidBy: user.id,
        paidAt: new Date().toISOString(),
      },
    ];

    const nextInvStatus = newPaid >= Number(inv.totalAmount) ? 'PAID' : 'PARTIAL';
    const batch = writeBatch(db);
    batch.update(doc(db, 'supplier_invoices', invDocId), {
      paidAmount: newPaid,
      status: nextInvStatus,
      payments: nextPayments,
      updatedAt: serverTimestamp(),
    });

    if (nextInvStatus === 'PAID' && inv.purchaseOrderId) {
      const linkedPo = snap.purchaseOrders.find((p) => p.id === inv.purchaseOrderId);
      const poInvoices = snap.supplierInvoices.filter((x) => x.purchaseOrderId === inv.purchaseOrderId);
      const allPoInvoicesPaid = poInvoices.every((x) => (x.id === invDocId ? true : x.status === 'PAID'));
      if (linkedPo && linkedPo.status === 'RECEIVED' && allPoInvoicesPaid) {
        batch.update(doc(db, 'purchase_orders', linkedPo.id), {
          status: 'PAID',
          updatedAt: serverTimestamp(),
        });
      }
    }

    const jeId = toDocId(crypto.randomUUID(), uid);
    batch.set(doc(db, 'journal_entries', jeId), {
      id: jeId,
      ownerUid: uid,
      entryNumber: `JE-${payNo}`,
      entryDate: new Date().toISOString(),
      description: `Supplier Payment ${inv.invoiceNumber}`,
      referenceType: 'AP_PAYMENT',
      referenceId: invDocId,
      isReversed: false,
      lines: [
        { id: crypto.randomUUID(), accountId: toDocId('acc_2000', uid), debit: payAmt, credit: 0, memo: 'Accounts Payable Settled' },
        { id: crypto.randomUUID(), accountId: toDocId('acc_1010', uid), debit: 0, credit: payAmt, memo: 'Bank/Cash Disbursement' },
      ],
      createdAt: serverTimestamp(),
    });

    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `supplier_invoices/${invDocId}`);
    }
    invalidateWorkspaceCache();
    return { ok: true } as T;
  }

  // 7. FINANCE, STATEMENTS & FOOD COSTING
  if (pathname === '/finance/overview' && method === 'GET') {
    assertPerm(user, PERMISSIONS.FINANCE_VIEW);
    const from = qs.get('from') || '2000-01-01';
    const to = qs.get('to') || '2099-12-31';
    const rawLoc = (qs.get('locationId') || '').trim();
    const locFilter = rawLoc && rawLoc !== 'ALL' ? toDocId(rawLoc, uid) : '';
    const locMap = new Map(snap.locations.map((l) => [l.id, l]));
    const accMap = new Map(snap.accounts.map((a) => [a.id, a]));
    const userMap = new Map(snap.erpUsers.map((u) => [u.id, u]));

    const saleMap = new Map(snap.sales.map((s) => [s.id, s]));
    const expMap = new Map(snap.expenses.map((e) => [e.id, e]));
    const grnMap = new Map(snap.goodsReceipts.map((g) => [g.id, g]));
    const poMap = new Map(snap.purchaseOrders.map((p) => [p.id, p]));
    const invMap = new Map(snap.supplierInvoices.map((i) => [i.id, i]));
    const trfMap = new Map(snap.stockTransfers.map((t) => [t.id, t]));
    const empMap = new Map(snap.employees.map((e) => [e.id, e]));
    const prMap = new Map(snap.payrollRuns.map((pr) => [pr.id, pr]));

    const resolveJeLocations = (je: any): string[] => {
      const refType = String(je.referenceType || '');
      const refId = String(je.referenceId || '');
      const refDocId = refId ? toDocId(refId, uid) : '';
      if (refType === 'SALE' || refType === 'SALE_REFUND') {
        const s = saleMap.get(refDocId) || saleMap.get(refId);
        return s?.locationId ? [s.locationId] : [];
      }
      if (refType === 'EXPENSE') {
        const ex = expMap.get(refDocId) || expMap.get(refId);
        return ex?.locationId ? [ex.locationId] : [];
      }
      if (refType === 'GRN') {
        const grn = grnMap.get(refDocId) || grnMap.get(refId);
        const po = grn ? poMap.get(grn.purchaseOrderId) : null;
        return po?.locationId ? [po.locationId] : [];
      }
      if (refType === 'AP_PAYMENT') {
        const inv = invMap.get(refDocId) || invMap.get(refId);
        const po = inv?.purchaseOrderId ? poMap.get(inv.purchaseOrderId) : null;
        return po?.locationId ? [po.locationId] : [];
      }
      if (refType === 'TRANSFER') {
        const trf = trfMap.get(refDocId) || trfMap.get(refId);
        return [trf?.fromLocationId, trf?.toLocationId].filter(Boolean) as string[];
      }
      if (refType === 'WASTE_LOG' || refType === 'WASTE' || refType === 'STOCK_COUNT' || refType === 'RECONCILE') {
        const matched = snap.inventoryTxns.filter(
          (t) => t.referenceId === refDocId || t.referenceId === refId || toDocId(String(t.referenceId || ''), uid) === refDocId,
        );
        return Array.from(new Set(matched.map((t) => t.locationId).filter(Boolean))) as string[];
      }
      if (refType === 'PAYROLL') {
        const pr = prMap.get(refDocId) || prMap.get(refId);
        const locs = (pr?.items || [])
          .map((pi: any) => empMap.get(pi.employeeId)?.locationId)
          .filter(Boolean) as string[];
        return Array.from(new Set(locs));
      }
      return [];
    };

    const jeMatchesLoc = (je: any) => !locFilter || resolveJeLocations(je).includes(locFilter);

    const expenses = [...snap.expenses]
      .filter((e) => !locFilter || e.locationId === locFilter)
      .sort((a, b) => String(b.expenseDate).localeCompare(String(a.expenseDate)))
      .slice(0, 60)
      .map((e) => ({
        id: toLogicalId(e.id, uid),
        location_id: toLogicalId(e.locationId, uid),
        account_id: toLogicalId(e.accountId, uid),
        category: e.category,
        amount: e.amount,
        description: e.description,
        is_recurring: e.isRecurring ? 1 : 0,
        paid_from_petty_cash: e.paidFromPettyCash ? 1 : 0,
        expense_date: e.expenseDate,
        location_name: locMap.get(e.locationId)?.name || '',
        account_name: accMap.get(e.accountId)?.name || '',
      }));

    const closings = [...snap.dailyClosings]
      .filter((dc) => !locFilter || dc.locationId === locFilter)
      .sort((a, b) => String(b.businessDate).localeCompare(String(a.businessDate)))
      .slice(0, 30)
      .map((dc) => ({
        id: toLogicalId(dc.id, uid),
        location_id: toLogicalId(dc.locationId, uid),
        business_date: dc.businessDate,
        opening_float: dc.openingFloat,
        expected_cash: dc.expectedCash,
        actual_cash: dc.actualCash,
        variance: dc.variance,
        total_sales: dc.totalSales,
        gross_profit: dc.grossProfit,
        closed_by: toLogicalId(dc.closedBy, uid),
        notes: dc.notes,
        closed_at: dc.closedAt,
        location_name: locMap.get(dc.locationId)?.name || '',
        closed_by_name: userMap.get(dc.closedBy)?.fullName || 'Manager',
      }));

    const journals = [...snap.journalEntries]
      .filter(jeMatchesLoc)
      .sort((a, b) => String(b.entryDate).localeCompare(String(a.entryDate)))
      .slice(0, 40)
      .map((je) => ({
        id: toLogicalId(je.id, uid),
        entry_number: je.entryNumber,
        entry_date: je.entryDate,
        description: je.description,
        reference_type: je.referenceType,
        reference_id: je.referenceId,
        is_reversed: je.isReversed ? 1 : 0,
        lines: (je.lines || []).map((l: any) => ({
          id: l.id,
          account_id: toLogicalId(l.accountId, uid),
          account_code: accMap.get(l.accountId)?.code || '',
          account_name: accMap.get(l.accountId)?.name || '',
          debit: Number(l.debit || 0),
          credit: Number(l.credit || 0),
          memo: l.memo || '',
        })),
      }));

    const accounts = [...snap.accounts]
      .sort((a, b) => String(a.code).localeCompare(String(b.code)))
      .map((a) => ({ id: toLogicalId(a.id, uid), code: a.code, name: a.name, type: a.type, is_system: a.isSystem ? 1 : 0 }));

    const pettyCash = (snap.meta?.pettyCashFunds || [])
      .filter((pc: any) => !locFilter || toDocId(String(pc.location_id || ''), uid) === locFilter)
      .map((pc: any) => ({
        ...pc,
        location_name: locMap.get(toDocId(pc.location_id, uid))?.name || '',
      }));

    const periods = [...(snap.meta?.financialPeriods || [])].sort((a: any, b: any) => String(b.period_start).localeCompare(String(a.period_start)));

    // Financial statements
    const jeInRange = snap.journalEntries.filter((je) => je.entryDate >= from && je.entryDate <= to && jeMatchesLoc(je));
    const accBalances = accounts.map((a) => {
      const docAccId = toDocId(a.id, uid);
      let totalDebit = 0;
      let totalCredit = 0;
      for (const je of jeInRange) {
        for (const l of je.lines || []) {
          if (l.accountId === docAccId) {
            totalDebit += Number(l.debit || 0);
            totalCredit += Number(l.credit || 0);
          }
        }
      }
      return { ...a, total_debit: round2(totalDebit), total_credit: round2(totalCredit) };
    });

    const revenues = accBalances.filter((a) => a.type === 'REVENUE').map((a) => ({ ...a, balance: round2(a.total_credit - a.total_debit) }));
    const expSt = accBalances.filter((a) => a.type === 'EXPENSE').map((a) => ({ ...a, balance: round2(a.total_debit - a.total_credit) }));
    const assets = accBalances.filter((a) => a.type === 'ASSET').map((a) => ({ ...a, balance: round2(a.total_debit - a.total_credit) }));
    const liabilities = accBalances.filter((a) => a.type === 'LIABILITY').map((a) => ({ ...a, balance: round2(a.total_credit - a.total_debit) }));
    const equity = accBalances.filter((a) => a.type === 'EQUITY').map((a) => ({ ...a, balance: round2(a.total_credit - a.total_debit) }));

    const totalRevenue = round2(revenues.reduce((s, r) => s + r.balance, 0));
    const totalExp = round2(expSt.reduce((s, e) => s + e.balance, 0));
    const netIncome = round2(totalRevenue - totalExp);

    const taxConfigs = snap.taxConfigs.map((t) => ({
      id: toLogicalId(t.id, uid),
      code: t.code,
      name: t.name,
      rate_percent: t.ratePercent,
      is_inclusive: t.isInclusive ? 1 : 0,
      is_active: t.isActive ? 1 : 0,
    }));
    const salesInRange = snap.sales.filter(
      (s) => s.status === 'COMPLETED' && s.soldAt >= from && s.soldAt <= to && (!locFilter || s.locationId === locFilter),
    );
    const vatableSales = round2(salesInRange.reduce((s, r) => s + Number(r.subtotal || 0), 0));
    const outputTax = round2(salesInRange.reduce((s, r) => s + Number(r.taxAmount || 0), 0));

    const expenseCategories = [...(snap.expenseCategories && snap.expenseCategories.length > 0 ? snap.expenseCategories : DEFAULT_EXPENSE_CATEGORIES)]
      .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || String(a.name).localeCompare(String(b.name)))
      .map((c) => ({
        id: toLogicalId(c.id, uid),
        code: c.code,
        name: c.name,
        description: c.description || '',
        sort_order: c.sortOrder ?? 0,
        is_active: c.isActive !== false ? 1 : 0,
      }));

    return {
      expenses,
      closings,
      journals,
      accounts,
      pettyCash,
      periods,
      expenseCategories,
      statements: {
        trialBalance: accBalances,
        profitAndLoss: { revenues, expenses: expSt, totalRevenue, totalExpenses: totalExp, netIncome },
        balanceSheet: {
          assets,
          liabilities,
          equity,
          retainedEarningsCurrent: netIncome,
          totalAssets: round2(assets.reduce((s, a) => s + a.balance, 0)),
          totalLiabilitiesAndEquity: round2(liabilities.reduce((s, l) => s + l.balance, 0) + equity.reduce((s, e) => s + e.balance, 0) + netIncome),
        },
        taxSummary: { taxConfigs, vatableSales, outputTax },
      },
    } as T;
  }

  if (pathname === '/finance/weekly-food-cost' && method === 'GET') {
    assertPerm(user, PERMISSIONS.FINANCE_VIEW);
    const rawLoc = (qs.get('locationId') || '').trim();
    const locFilter = rawLoc && rawLoc !== 'ALL' ? toDocId(rawLoc, uid) : '';
    const weeks = Math.min(26, Math.max(2, Math.round(Number(qs.get('weeks') || 8) || 8)));

    const filteredSales = snap.sales
      .filter((s) => s.status === 'COMPLETED' && (!locFilter || s.locationId === locFilter))
      .map((s) => ({
        locationId: toLogicalId(s.locationId, uid),
        soldAt: s.soldAt,
        subtotal: Number(s.subtotal || 0),
        taxAmount: Number(s.taxAmount || 0),
        totalAmount: Number(s.totalAmount || 0),
        totalCogs: Number(s.totalCogs || 0),
      }));

    const filteredWaste = snap.inventoryTxns
      .filter(
        (t) =>
          ['OUT_WASTE', 'OUT_SPOILAGE'].includes(t.txnType) &&
          (!locFilter || t.locationId === locFilter),
      )
      .map((t) => ({
        locationId: toLogicalId(t.locationId, uid),
        txnDate: t.txnDate || tsToIso(t.createdAt),
        totalCost: Number(t.totalCost || 0),
      }));

    const activeProducts = snap.products.filter((p) => Number(p.targetFoodCostPct || 0) > 0);
    const avgTarget =
      activeProducts.length > 0
        ? activeProducts.reduce((sum, p) => sum + Number(p.targetFoodCostPct || 35), 0) / activeProducts.length
        : 35;

    return buildWeeklyFoodCostSeries({
      sales: filteredSales,
      wasteTxns: filteredWaste,
      targetFoodCostPct: avgTarget,
      locationId: rawLoc && rawLoc !== 'ALL' ? rawLoc : 'ALL',
      weeks,
    }) as T;
  }

  if (pathname === '/finance/expenses' && method === 'POST') {
    assertPerm(user, PERMISSIONS.FINANCE_VIEW);
    const { locationId, accountId, category, amount, description, expenseDate, paidFromPettyCash, isRecurring } = body || {};
    const amt = round2(Number(amount));
    if (!Number.isFinite(amt) || amt <= 0) throw new Error('Amount must be positive');
    const cleanDesc = String(description || '').trim();
    if (!cleanDesc) throw new Error('Description is required');

    const expId = toDocId(crypto.randomUUID(), uid);
    const locDocId = toDocId(locationId, uid);
    const accDocId = toDocId(accountId, uid);
    const rawExpDate = String(expenseDate || '').trim();
    const expDate = /^\d{4}-\d{2}-\d{2}$/.test(rawExpDate)
      ? `${rawExpDate}T12:00:00.000Z`
      : rawExpDate || new Date().toISOString();

    const batch = writeBatch(db);
    if (paidFromPettyCash) {
      const funds = [...(snap.meta?.pettyCashFunds || [])];
      const fIdx = funds.findIndex((f: any) => f.location_id === locationId || toDocId(f.location_id, uid) === locDocId);
      if (fIdx < 0 || Number(funds[fIdx].current_balance) < amt) {
        throw new Error('Insufficient petty cash balance');
      }
      funds[fIdx] = { ...funds[fIdx], current_balance: round2(Number(funds[fIdx].current_balance) - amt) };
      batch.update(doc(db, 'workspace_meta', `ws_${uid}`), { pettyCashFunds: funds, updatedAt: serverTimestamp() });
    }

    batch.set(doc(db, 'expenses', expId), {
      id: expId,
      ownerUid: uid,
      locationId: locDocId,
      accountId: accDocId,
      category: String(category || 'GENERAL'),
      amount: amt,
      description: cleanDesc,
      isRecurring: Boolean(isRecurring),
      paidFromPettyCash: Boolean(paidFromPettyCash),
      expenseDate: expDate,
      createdAt: serverTimestamp(),
    });

    const jeId = toDocId(crypto.randomUUID(), uid);
    batch.set(doc(db, 'journal_entries', jeId), {
      id: jeId,
      ownerUid: uid,
      entryNumber: `JE-EXP-${Date.now().toString().slice(-6)}`,
      entryDate: expDate,
      description: `${category}: ${cleanDesc}`,
      referenceType: 'EXPENSE',
      referenceId: expId,
      isReversed: false,
      lines: [
        { id: crypto.randomUUID(), accountId: accDocId, debit: amt, credit: 0, memo: cleanDesc },
        { id: crypto.randomUUID(), accountId: toDocId('acc_1000', uid), debit: 0, credit: amt, memo: paidFromPettyCash ? 'Petty Cash Disbursement' : 'Cash Disbursement' },
      ],
      createdAt: serverTimestamp(),
    });

    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `expenses/${expId}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'RECORD_EXPENSE', 'Expense', toLogicalId(expId, uid), { category, amt });
    invalidateWorkspaceCache();
    return { id: toLogicalId(expId, uid) } as T;
  }

  if (pathname.startsWith('/finance/expenses/') && method === 'PUT') {
    assertPerm(user, PERMISSIONS.FINANCE_VIEW);
    const rawId = pathname.split('/')[3];
    const expId = toDocId(rawId, uid);
    const existing = snap.expenses.find((e) => e.id === expId || toLogicalId(e.id, uid) === rawId);
    if (!existing) throw new Error('Expense not found');

    const { locationId, accountId, category, amount, description, expenseDate, paidFromPettyCash, isRecurring } = body || {};
    const amt = round2(Number(amount));
    if (!Number.isFinite(amt) || amt <= 0) throw new Error('Amount must be positive');
    const cleanDesc = String(description || '').trim();
    if (!cleanDesc) throw new Error('Description is required');

    const locDocId = toDocId(locationId || existing.locationId, uid);
    const accDocId = toDocId(accountId || existing.accountId, uid);
    const rawExpDate = String(expenseDate || existing.expenseDate || '').trim();
    const expDate = /^\d{4}-\d{2}-\d{2}$/.test(rawExpDate)
      ? `${rawExpDate}T12:00:00.000Z`
      : rawExpDate || new Date().toISOString();

    const batch = writeBatch(db);
    const funds = [...(snap.meta?.pettyCashFunds || [])];
    let fundsChanged = false;

    // Refund old petty cash if it was paid from petty cash
    if (existing.paidFromPettyCash) {
      const oldIdx = funds.findIndex((f: any) => f.location_id === existing.locationId || toDocId(f.location_id, uid) === existing.locationId);
      if (oldIdx >= 0) {
        funds[oldIdx] = { ...funds[oldIdx], current_balance: round2(Number(funds[oldIdx].current_balance) + Number(existing.amount || 0)) };
        fundsChanged = true;
      }
    }

    // Deduct new petty cash if paidFromPettyCash is true
    if (paidFromPettyCash) {
      const newIdx = funds.findIndex((f: any) => f.location_id === locationId || toDocId(f.location_id, uid) === locDocId);
      if (newIdx < 0 || Number(funds[newIdx].current_balance) < amt) {
        throw new Error('Insufficient petty cash balance for updated expense');
      }
      funds[newIdx] = { ...funds[newIdx], current_balance: round2(Number(funds[newIdx].current_balance) - amt) };
      fundsChanged = true;
    }

    if (fundsChanged) {
      batch.update(doc(db, 'workspace_meta', `ws_${uid}`), { pettyCashFunds: funds, updatedAt: serverTimestamp() });
    }

    batch.update(doc(db, 'expenses', existing.id), {
      locationId: locDocId,
      accountId: accDocId,
      category: String(category || existing.category || 'GENERAL'),
      amount: amt,
      description: cleanDesc,
      isRecurring: Boolean(isRecurring),
      paidFromPettyCash: Boolean(paidFromPettyCash),
      expenseDate: expDate,
      updatedAt: serverTimestamp(),
    });

    const je = snap.journalEntries.find((j) => j.referenceType === 'EXPENSE' && (j.referenceId === existing.id || j.referenceId === toLogicalId(existing.id, uid)));
    if (je) {
      batch.update(doc(db, 'journal_entries', je.id), {
        entryDate: expDate,
        description: `${category || existing.category}: ${cleanDesc}`,
        lines: [
          { id: crypto.randomUUID(), accountId: accDocId, debit: amt, credit: 0, memo: cleanDesc },
          { id: crypto.randomUUID(), accountId: toDocId('acc_1000', uid), debit: 0, credit: amt, memo: paidFromPettyCash ? 'Petty Cash Disbursement' : 'Cash Disbursement' },
        ],
        updatedAt: serverTimestamp(),
      });
    }

    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `expenses/${existing.id}`);
    }

    await addAuditLog(uid, user.id, user.fullName, 'UPDATE_EXPENSE', 'Expense', toLogicalId(existing.id, uid), { category, amt, cleanDesc });
    invalidateWorkspaceCache();
    return { ok: true, id: toLogicalId(existing.id, uid) } as T;
  }

  if (pathname.startsWith('/finance/expenses/') && method === 'DELETE') {
    assertPerm(user, PERMISSIONS.FINANCE_VIEW);
    const rawId = pathname.split('/')[3];
    const expId = toDocId(rawId, uid);
    const existing = snap.expenses.find((e) => e.id === expId || toLogicalId(e.id, uid) === rawId);
    if (!existing) throw new Error('Expense not found');

    const batch = writeBatch(db);

    if (existing.paidFromPettyCash) {
      const funds = [...(snap.meta?.pettyCashFunds || [])];
      const fIdx = funds.findIndex((f: any) => f.location_id === existing.locationId || toDocId(f.location_id, uid) === existing.locationId);
      if (fIdx >= 0) {
        funds[fIdx] = { ...funds[fIdx], current_balance: round2(Number(funds[fIdx].current_balance) + Number(existing.amount || 0)) };
        batch.update(doc(db, 'workspace_meta', `ws_${uid}`), { pettyCashFunds: funds, updatedAt: serverTimestamp() });
      }
    }

    const je = snap.journalEntries.find((j) => j.referenceType === 'EXPENSE' && (j.referenceId === existing.id || j.referenceId === toLogicalId(existing.id, uid)));
    if (je) {
      batch.delete(doc(db, 'journal_entries', je.id));
    }

    batch.delete(doc(db, 'expenses', existing.id));

    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `expenses/${existing.id}`);
    }

    await addAuditLog(uid, user.id, user.fullName, 'DELETE_EXPENSE', 'Expense', toLogicalId(existing.id, uid), { category: existing.category, amount: existing.amount });
    invalidateWorkspaceCache();
    return { ok: true } as T;
  }

  if (pathname === '/finance/expense-categories' && method === 'GET') {
    assertPerm(user, PERMISSIONS.FINANCE_VIEW);
    const cats = [...(snap.expenseCategories?.length ? snap.expenseCategories : DEFAULT_EXPENSE_CATEGORIES)]
      .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || String(a.name).localeCompare(String(b.name)))
      .map((c) => ({
        id: toLogicalId(c.id, uid),
        code: c.code,
        name: c.name,
        description: c.description || '',
        sort_order: c.sortOrder ?? 0,
        is_active: c.isActive !== false ? 1 : 0,
      }));
    return cats as T;
  }

  if (pathname === '/finance/expense-categories' && method === 'POST') {
    assertPerm(user, PERMISSIONS.FINANCE_VIEW);
    const { code, name, description, sortOrder, isActive } = body || {};
    const cleanCode = String(code || '').trim().toUpperCase().replace(/\s+/g, '_');
    const cleanName = String(name || '').trim();
    if (!cleanCode || !cleanName) throw new Error('Category code and name are required');

    const catDocId = toDocId(`cat_${cleanCode.toLowerCase()}`, uid);
    try {
      await setDoc(doc(db, 'expense_categories', catDocId), {
        id: catDocId,
        ownerUid: uid,
        code: cleanCode,
        name: cleanName,
        description: description ? String(description).trim() : '',
        sortOrder: Number(sortOrder) || 0,
        isActive: isActive !== false,
        createdAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `expense_categories/${catDocId}`);
    }

    await addAuditLog(uid, user.id, user.fullName, 'CREATE_EXPENSE_CATEGORY', 'ExpenseCategory', toLogicalId(catDocId, uid), { code: cleanCode, name: cleanName });
    invalidateWorkspaceCache();
    return { id: toLogicalId(catDocId, uid), code: cleanCode, name: cleanName } as T;
  }

  if (pathname.startsWith('/finance/expense-categories/') && method === 'PUT') {
    assertPerm(user, PERMISSIONS.FINANCE_VIEW);
    const rawId = pathname.split('/')[3];
    const catDocId = toDocId(rawId, uid);
    const existing = (snap.expenseCategories || []).find((c) => c.id === catDocId || toLogicalId(c.id, uid) === rawId);
    if (!existing) throw new Error('Expense category not found');

    const { code, name, description, sortOrder, isActive } = body || {};
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('Name is required');

    const nextCode = code ? String(code).trim().toUpperCase().replace(/\s+/g, '_') : existing.code;
    try {
      await updateDoc(doc(db, 'expense_categories', existing.id), {
        code: nextCode,
        name: cleanName,
        description: description !== undefined ? String(description).trim() : existing.description || '',
        sortOrder: sortOrder !== undefined ? Number(sortOrder) : existing.sortOrder || 0,
        isActive: isActive === undefined ? existing.isActive !== false : Boolean(isActive),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `expense_categories/${existing.id}`);
    }

    await addAuditLog(uid, user.id, user.fullName, 'UPDATE_EXPENSE_CATEGORY', 'ExpenseCategory', toLogicalId(existing.id, uid), { code: nextCode, name: cleanName });
    invalidateWorkspaceCache();
    return { ok: true } as T;
  }

  if (pathname.startsWith('/finance/expense-categories/') && method === 'DELETE') {
    assertPerm(user, PERMISSIONS.FINANCE_VIEW);
    const rawId = pathname.split('/')[3];
    const catDocId = toDocId(rawId, uid);
    const existing = (snap.expenseCategories || []).find((c) => c.id === catDocId || toLogicalId(c.id, uid) === rawId);
    if (!existing) throw new Error('Expense category not found');

    const inUse = snap.expenses.filter((e) => e.category === existing.code || e.category === existing.name).length;
    if (inUse > 0) {
      throw new Error(`Cannot delete category "${existing.name}" because it is currently linked to ${inUse} operating expense record(s).`);
    }

    try {
      await deleteDoc(doc(db, 'expense_categories', existing.id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `expense_categories/${existing.id}`);
    }

    await addAuditLog(uid, user.id, user.fullName, 'DELETE_EXPENSE_CATEGORY', 'ExpenseCategory', toLogicalId(existing.id, uid), { code: existing.code });
    invalidateWorkspaceCache();
    return { ok: true } as T;
  }

  if (pathname === '/finance/accounts' && method === 'POST') {
    assertPerm(user, PERMISSIONS.FINANCE_VIEW);
    const { code, name, type } = body || {};
    const cleanCode = String(code || '').trim();
    const cleanName = String(name || '').trim();
    const accType = type || 'EXPENSE';
    if (!cleanCode || !cleanName) throw new Error('Account code and name are required');

    const existingCode = snap.accounts.find((a) => a.code === cleanCode);
    if (existingCode) throw new Error(`GL Account code ${cleanCode} already exists`);

    const accDocId = toDocId(`acc_${cleanCode}`, uid);
    try {
      await setDoc(doc(db, 'accounts', accDocId), {
        id: accDocId,
        ownerUid: uid,
        code: cleanCode,
        name: cleanName,
        type: accType,
        isSystem: false,
        createdAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `accounts/${accDocId}`);
    }

    await addAuditLog(uid, user.id, user.fullName, 'CREATE_ACCOUNT', 'Account', toLogicalId(accDocId, uid), { code: cleanCode, name: cleanName, type: accType });
    invalidateWorkspaceCache();
    return { id: toLogicalId(accDocId, uid), code: cleanCode, name: cleanName, type: accType, is_system: 0 } as T;
  }

  if (pathname.startsWith('/finance/accounts/') && method === 'PUT') {
    assertPerm(user, PERMISSIONS.FINANCE_VIEW);
    const rawId = pathname.split('/')[3];
    const accDocId = toDocId(rawId, uid);
    const existing = snap.accounts.find((a) => a.id === accDocId || toLogicalId(a.id, uid) === rawId);
    if (!existing) throw new Error('Account not found');

    const { code, name } = body || {};
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('Account name is required');

    const nextCode = code ? String(code).trim() : existing.code;
    if (nextCode !== existing.code) {
      if (existing.isSystem) throw new Error('System account codes cannot be modified');
      const conflict = snap.accounts.find((a) => a.code === nextCode && a.id !== existing.id);
      if (conflict) throw new Error(`GL Account code ${nextCode} already exists`);
    }

    try {
      await updateDoc(doc(db, 'accounts', existing.id), {
        code: nextCode,
        name: cleanName,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `accounts/${existing.id}`);
    }

    await addAuditLog(uid, user.id, user.fullName, 'UPDATE_ACCOUNT', 'Account', toLogicalId(existing.id, uid), { code: nextCode, name: cleanName });
    invalidateWorkspaceCache();
    return { ok: true } as T;
  }

  if (pathname.startsWith('/finance/accounts/') && method === 'DELETE') {
    assertPerm(user, PERMISSIONS.FINANCE_VIEW);
    const rawId = pathname.split('/')[3];
    const accDocId = toDocId(rawId, uid);
    const existing = snap.accounts.find((a) => a.id === accDocId || toLogicalId(a.id, uid) === rawId);
    if (!existing) throw new Error('Account not found');

    if (existing.isSystem) {
      throw new Error(`Cannot delete system account "${existing.name}" (${existing.code})`);
    }

    const jeUsage = snap.journalEntries.filter((j) => (j.lines || []).some((l: any) => l.accountId === existing.id || toDocId(l.accountId, uid) === existing.id)).length;
    if (jeUsage > 0) {
      throw new Error(`Cannot delete account "${existing.name}" because it has ${jeUsage} posted journal transaction(s).`);
    }

    const expUsage = snap.expenses.filter((e) => e.accountId === existing.id || toDocId(e.accountId, uid) === existing.id).length;
    if (expUsage > 0) {
      throw new Error(`Cannot delete account "${existing.name}" because it is linked to ${expUsage} operating expense record(s).`);
    }

    try {
      await deleteDoc(doc(db, 'accounts', existing.id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `accounts/${existing.id}`);
    }

    await addAuditLog(uid, user.id, user.fullName, 'DELETE_ACCOUNT', 'Account', toLogicalId(existing.id, uid), { code: existing.code });
    invalidateWorkspaceCache();
    return { ok: true } as T;
  }

  // AI-Powered Inventory Forecasting Endpoint
  if (pathname === '/ai/inventory-forecast' && method === 'POST') {
    const { locationId, horizonDays = 5 } = body || {};
    const days = Math.max(1, Math.min(14, Number(horizonDays) || 5));
    const locDocId = locationId && locationId !== 'ALL' ? toDocId(locationId, uid) : '';
    const loc = snap.locations.find((l) => l.id === locDocId);

    // Prepare location inventory summary
    const batches = snap.stockBatches.filter((b) => !locDocId || b.locationId === locDocId);
    const onHandMap = new Map<string, number>();
    for (const b of batches) {
      const cur = onHandMap.get(b.inventoryItemId) || 0;
      onHandMap.set(b.inventoryItemId, cur + Number(b.remainingQty || 0));
    }

    const inventorySummary = snap.inventoryItems.map((item) => ({
      id: toLogicalId(item.id, uid),
      sku: item.sku,
      name: item.name,
      category: item.category,
      unit_of_measure: item.unitOfMeasure,
      cost_per_unit: item.costPerUnit,
      reorder_point: item.reorderPoint,
      on_hand: round2(onHandMap.get(item.id) || 0),
    }));

    // 7-day sales breakdown
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const recentCompletedSales = snap.sales.filter(
      (s) => s.status === 'COMPLETED' && s.soldAt >= sevenDaysAgo && (!locDocId || s.locationId === locDocId),
    );

    const salesItemMap = new Map<string, { qty: number; revenue: number }>();
    for (const sale of recentCompletedSales) {
      for (const it of sale.items || []) {
        const cur = salesItemMap.get(it.productName) || { qty: 0, revenue: 0 };
        cur.qty += Number(it.quantity || 0);
        cur.revenue += Number(it.lineTotal || 0);
        salesItemMap.set(it.productName, cur);
      }
    }

    const recentSalesSummary = Array.from(salesItemMap.entries()).map(([product_name, stats]) => ({
      product_name,
      total_qty: stats.qty,
      total_revenue: round2(stats.revenue),
    }));

    // First attempt to call the server-side proxy which holds GEMINI_API_KEY
    try {
      const token = auth.currentUser ? await auth.currentUser.getIdToken().catch(() => '') : '';
      const resp = await fetch('/api/v1/ai/inventory-forecast', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          locationId: locationId || 'ALL',
          horizonDays: days,
          truckName: loc?.name || 'All Food Trucks',
          inventorySummary,
          recentSalesSummary,
        }),
      });
      if (resp.ok) {
        const jsonResult = await resp.json();
        if (jsonResult && Array.isArray(jsonResult.items)) {
          return jsonResult as T;
        }
      }
    } catch (_) {
      // Backend unavailable or fetch failed; proceed to local deterministic prediction
    }

    // Direct fallback calculation using BOM matrix
    const recipeMap: Record<string, Array<{ ingredientSku: string; qty: number }>> = {
      'Double Wagyu Smash Burger': [
        { ingredientSku: 'ING-BEEF-01', qty: 2 },
        { ingredientSku: 'ING-BUN-01', qty: 1 },
        { ingredientSku: 'ING-CHEESE-01', qty: 2 },
      ],
      'Crispy Pork Sisig Tacos (3 pcs)': [
        { ingredientSku: 'ING-PORK-01', qty: 0.15 },
        { ingredientSku: 'ING-TORT-01', qty: 3 },
      ],
      'Truffle Parmesan Fries': [
        { ingredientSku: 'ING-FRIES-01', qty: 0.25 },
        { ingredientSku: 'ING-TRUFFLE-01', qty: 0.045 },
      ],
      'Guimaras Mango Graham Shake': [
        { ingredientSku: 'ING-MANGO-01', qty: 0.22 },
      ],
    };

    const calculatedItems = inventorySummary.map((item) => {
      const onHand = Number(item.on_hand || 0);
      const reorderPt = Number(item.reorder_point || 10);
      const unitCost = Number(item.cost_per_unit || 50);
      const uom = item.unit_of_measure || 'units';

      let estimatedDailyBurn = 0;
      for (const sale of recentSalesSummary) {
        const recipes = recipeMap[sale.product_name];
        if (recipes) {
          for (const ing of recipes) {
            if (ing.ingredientSku === item.sku || item.name.toLowerCase().includes(ing.ingredientSku.toLowerCase())) {
              estimatedDailyBurn += (ing.qty * sale.total_qty) / 7;
            }
          }
        }
      }

      if (estimatedDailyBurn <= 0) {
        estimatedDailyBurn = Math.max(0.6, round2(reorderPt * 0.16));
      } else {
        estimatedDailyBurn = round2(estimatedDailyBurn);
      }

      const projectedDemand = round2(estimatedDailyBurn * days);
      const daysOfSupply = estimatedDailyBurn > 0 ? round2(onHand / estimatedDailyBurn) : 99;
      const projectedStockAfterHorizon = round2(onHand - projectedDemand);

      let riskLevel: 'CRITICAL' | 'HIGH' | 'OPTIMAL' = 'OPTIMAL';
      let suggestedRestock = 0;

      if (projectedStockAfterHorizon <= 0) {
        riskLevel = 'CRITICAL';
        suggestedRestock = Math.ceil(Math.abs(projectedStockAfterHorizon) + reorderPt * 1.5);
      } else if (projectedStockAfterHorizon < reorderPt) {
        riskLevel = 'HIGH';
        suggestedRestock = Math.ceil((reorderPt * 1.4) - projectedStockAfterHorizon);
      }

      return {
        id: item.id,
        sku: item.sku,
        name: item.name,
        category: item.category || 'General',
        uom,
        unitCost,
        onHand,
        reorderPt,
        estimatedDailyBurn,
        daysOfSupply,
        projectedDemand,
        projectedStockAfterHorizon: Math.max(0, projectedStockAfterHorizon),
        riskLevel,
        suggestedRestock,
        estimatedCost: round2(suggestedRestock * unitCost),
        reason: riskLevel === 'CRITICAL'
          ? `Stock depletion expected in ${daysOfSupply} days at current sales velocity (${estimatedDailyBurn} ${uom}/day). Restock urgently.`
          : riskLevel === 'HIGH'
          ? `Stock projected to breach reorder point (${reorderPt} ${uom}) within ${days} days.`
          : `Healthy stock buffer. Safe for ${daysOfSupply} days of continuous operation.`,
      };
    });

    const totalCost = round2(calculatedItems.reduce((s, i) => s + i.estimatedCost, 0));
    const criticalCount = calculatedItems.filter((i) => i.riskLevel === 'CRITICAL').length;
    const highCount = calculatedItems.filter((i) => i.riskLevel === 'HIGH').length;

    return {
      source: 'algorithmic',
      horizonDays: days,
      summary: {
        totalItemsAnalyzed: calculatedItems.length,
        criticalCount,
        highRiskCount: highCount,
        totalRecommendedRestockUnits: calculatedItems.reduce((s, i) => s + i.suggestedRestock, 0),
        totalEstimatedReplenishmentCostPhp: totalCost,
        strategicAdvice: criticalCount > 0
          ? `Demand projection identified ${criticalCount} ingredient(s) at severe stockout risk within ${days} days based on 7-day sales velocity. Request Commissary Transfer immediately.`
          : `All inventory levels currently maintain adequate safety buffers for the upcoming ${days}-day service cycle.`,
      },
      items: calculatedItems,
    } as T;
  }

  if (pathname === '/finance/daily-closing' && method === 'POST') {
    assertPerm(user, PERMISSIONS.DAILY_CLOSE);
    const { locationId, businessDate, openingFloat, actualCash, notes } = body || {};
    const dateStr = businessDate || new Date().toISOString().slice(0, 10);
    const locDocId = toDocId(locationId, uid);

    if (snap.dailyClosings.some((dc) => dc.locationId === locDocId && dc.businessDate === dateStr)) {
      throw new Error(`Business day ${dateStr} is already closed for this location`);
    }

    const daySales = snap.sales.filter((s) => s.locationId === locDocId && s.status === 'COMPLETED' && String(s.soldAt).slice(0, 10) === dateStr);
    const totalSales = round2(daySales.reduce((s, r) => s + Number(r.totalAmount || 0), 0));
    const totalCogs = round2(daySales.reduce((s, r) => s + Number(r.totalCogs || 0), 0));
    const cashSales = round2(
      daySales.reduce(
        (s, r) => s + (r.payments || []).filter((p: any) => p.method === 'CASH').reduce((ps: number, p: any) => ps + Number(p.amount || 0), 0),
        0,
      ),
    );
    const pettyOut = round2(
      snap.expenses
        .filter((e) => e.locationId === locDocId && e.paidFromPettyCash && String(e.expenseDate).slice(0, 10) === dateStr)
        .reduce((s, e) => s + Number(e.amount || 0), 0),
    );

    const expectedCash = round2(Number(openingFloat || 0) + cashSales - pettyOut);
    const actual = round2(Number(actualCash));
    const variance = round2(actual - expectedCash);
    const grossProfit = round2(totalSales - totalCogs);
    const id = toDocId(crypto.randomUUID(), uid);
    const closedAt = new Date().toISOString();

    try {
      await setDoc(doc(db, 'daily_closings', id), {
        id,
        ownerUid: uid,
        locationId: locDocId,
        businessDate: dateStr,
        openingFloat: Number(openingFloat || 0),
        expectedCash,
        actualCash: actual,
        variance,
        totalSales,
        grossProfit,
        closedBy: toDocId(user.id, uid),
        notes: notes || '',
        closedAt,
        createdAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `daily_closings/${id}`);
    }

    if (variance !== 0) {
      const locName = snap.locations.find((l) => l.id === locDocId)?.name || 'Location';
      await addNotificationIfMissing(
        snap,
        'CASH_VARIANCE',
        Math.abs(variance) > 200 ? 'CRITICAL' : 'WARNING',
        `Cash Reconciliation Variance (${dateStr})`,
        `${locName}: Variance of PHP ${variance.toFixed(2)} recorded on closing.`,
        locDocId,
      );
    }
    await addAuditLog(uid, user.id, user.fullName, 'DAILY_CLOSE', 'DailyClosing', toLogicalId(id, uid), { dateStr, expectedCash, actual, variance });
    invalidateWorkspaceCache();
    return {
      id: toLogicalId(id, uid),
      business_date: dateStr,
      expected_cash: expectedCash,
      actual_cash: actual,
      variance,
      total_sales: totalSales,
      gross_profit: grossProfit,
    } as T;
  }

  if (pathname.startsWith('/finance/tax/') && method === 'PATCH') {
    assertPerm(user, PERMISSIONS.FINANCE_VIEW);
    const id = pathname.split('/')[3];
    const docId = toDocId(id, uid);
    const { ratePercent, isInclusive, isActive } = body || {};
    try {
      await updateDoc(doc(db, 'tax_configs', docId), {
        ratePercent: Number(ratePercent),
        isInclusive: Boolean(isInclusive),
        isActive: Boolean(isActive),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `tax_configs/${docId}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'UPDATE_TAX_CONFIG', 'TaxConfiguration', id, { ratePercent, isActive });
    invalidateWorkspaceCache();
    return { ok: true } as T;
  }

  if (pathname === '/food-costing' && method === 'GET') {
    assertPerm(user, PERMISSIONS.DASHBOARD_VIEW);
    const rawLoc = (qs.get('locationId') || '').trim();
    const locFilter = rawLoc && rawLoc !== 'ALL' ? toDocId(rawLoc, uid) : '';
    const products = getProductCostingList(snap);
    const completedSales = snap.sales.filter((s) => s.status === 'COMPLETED' && (!locFilter || s.locationId === locFilter));
    const soldStats = new Map<string, { units_sold: number; revenue: number; actual_cogs: number }>();

    for (const s of completedSales) {
      for (const it of s.items || []) {
        const lid = toLogicalId(it.productId, uid);
        const prev = soldStats.get(lid) || { units_sold: 0, revenue: 0, actual_cogs: 0 };
        prev.units_sold += Number(it.quantity || 0);
        prev.revenue = round2(prev.revenue + Number(it.lineTotal || 0));
        prev.actual_cogs = round2(prev.actual_cogs + Number(it.cogsAmount || 0));
        soldStats.set(lid, prev);
      }
    }

    const rows = products.map((p) => {
      const st = soldStats.get(p.id) || { units_sold: 0, revenue: 0, actual_cogs: 0 };
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
      const quadrant = highPop && highMargin ? 'Star' : highPop ? 'Plowhorse' : highMargin ? 'Puzzle' : 'Dog';
      return { ...r, quadrant };
    });

    const theoMap = new Map<string, number>();
    const prodMap = new Map(snap.products.map((p) => [p.id, p]));
    const itemMap = new Map(snap.inventoryItems.map((i) => [i.id, i]));
    for (const s of completedSales) {
      for (const ci of s.items || []) {
        const prod = prodMap.get(ci.productId);
        if (!prod) continue;
        const variant = ci.variantId ? (prod.variants || []).find((v: any) => v.id === ci.variantId) : null;
        const mult = Number(variant?.portionMultiplier || 1);
        for (const ing of prod.ingredients || []) {
          const invItem = itemMap.get(ing.inventoryItemId);
          if (!invItem) continue;
          try {
            const theoQty = convertQty(
              ((Number(ing.quantity) * (1 + Number(ing.wasteFactorPct || 0) / 100)) / Number(prod.recipeYieldQty || 1)) *
                mult *
                Number(ci.quantity),
              ing.uomId,
              invItem.baseUomId,
              snap,
            );
            theoMap.set(invItem.id, (theoMap.get(invItem.id) || 0) + theoQty);
          } catch {
            // ignore conversion errors
          }
        }
      }
    }

    const wasteLogsInLoc = snap.wasteLogs.filter((w) => !locFilter || w.locationId === locFilter);
    const wasteByProd = new Map<
      string,
      { events: number; servings: number; cost: number; ingredients: Map<string, { name: string; uom: string; qty: number; cost: number }> }
    >();
    const linkedRecipesByItem = new Map<string, Set<string>>();

    for (const w of wasteLogsInLoc) {
      if (w.productId) {
        const lid = toLogicalId(String(w.productId), uid);
        const rec = wasteByProd.get(lid) || { events: 0, servings: 0, cost: 0, ingredients: new Map() };
        rec.events += 1;
        rec.servings = round2(rec.servings + Number(w.servingsWasted || 0));
        rec.cost = round2(rec.cost + Number(w.totalLossCost || 0));
        for (const li of w.items || []) {
          const itemLid = toLogicalId(String(li.inventoryItemId || ''), uid);
          const ingPrev = rec.ingredients.get(itemLid) || {
            name: String(li.ingredientName || 'Ingredient'),
            uom: String(li.uomCode || ''),
            qty: 0,
            cost: 0,
          };
          ingPrev.qty = round2(ingPrev.qty + Number(li.quantity || 0));
          ingPrev.cost = round2(ingPrev.cost + Number(li.totalCost || 0));
          rec.ingredients.set(itemLid, ingPrev);

          const itemDocKey = toDocId(itemLid, uid);
          const recipeSet = linkedRecipesByItem.get(itemDocKey) || new Set<string>();
          if (w.productName) recipeSet.add(String(w.productName));
          linkedRecipesByItem.set(itemDocKey, recipeSet);
        }
        wasteByProd.set(lid, rec);
      }
    }

    const avtReport = snap.inventoryItems.map((item) => {
      const outTxns = snap.inventoryTxns.filter(
        (t) =>
          t.inventoryItemId === item.id &&
          (!locFilter || t.locationId === locFilter) &&
          ['OUT_SALE', 'OUT_WASTE', 'OUT_SPOILAGE', 'OUT_ADJUSTMENT'].includes(t.txnType),
      );
      const saleOutQty = round2(
        outTxns
          .filter((t) => t.txnType === 'OUT_SALE')
          .reduce((s, t) => s + Math.abs(Number(t.quantityDelta || 0)), 0),
      );
      const wasteQty = round2(
        outTxns
          .filter((t) => t.txnType === 'OUT_WASTE')
          .reduce((s, t) => s + Math.abs(Number(t.quantityDelta || 0)), 0),
      );
      const spoilageQty = round2(
        outTxns
          .filter((t) => t.txnType === 'OUT_SPOILAGE')
          .reduce((s, t) => s + Math.abs(Number(t.quantityDelta || 0)), 0),
      );
      const adjustmentQty = round2(
        outTxns
          .filter((t) => t.txnType === 'OUT_ADJUSTMENT')
          .reduce((s, t) => s + Math.abs(Number(t.quantityDelta || 0)), 0),
      );
      const actualOut = round2(outTxns.reduce((s, t) => s + Math.abs(Number(t.quantityDelta || 0)), 0));
      const wasteCost = round2(
        snap.inventoryTxns
          .filter(
            (t) =>
              t.inventoryItemId === item.id &&
              (!locFilter || t.locationId === locFilter) &&
              ['OUT_WASTE', 'OUT_SPOILAGE'].includes(t.txnType),
          )
          .reduce((s, t) => s + Number(t.totalCost || 0), 0),
      );
      const theo = round2(theoMap.get(item.id) || 0);
      const varianceQty = round2(actualOut - theo);
      const variancePct = theo > 0 ? round2((varianceQty / theo) * 100) : actualOut > 0 ? 100 : 0;
      const linkedRecipes = Array.from(linkedRecipesByItem.get(item.id) || []);
      return {
        id: toLogicalId(item.id, uid),
        name: item.name,
        uom: item.uomCode,
        theoreticalQty: theo,
        actualQty: actualOut,
        saleOutQty,
        wasteQty,
        spoilageQty,
        adjustmentQty,
        varianceQty,
        variancePct,
        varianceCost: round2(varianceQty * Number(item.lastUnitCost || 0)),
        wasteCost,
        linkedRecipes,
      };
    });

    const recipeUsageReport = products
      .map((p) => {
        const st = soldStats.get(p.id) || { units_sold: 0, revenue: 0, actual_cogs: 0 };
        const w = wasteByProd.get(p.id);
        const theoreticalIngCost = round2(st.units_sold * Number(p.costing.ingredientCost || 0));
        const actualSaleCogs = round2(st.actual_cogs);
        const linkedWasteCost = round2(w?.cost || 0);
        const totalActualCost = round2(actualSaleCogs + linkedWasteCost);
        const varianceCost = round2(totalActualCost - theoreticalIngCost);
        const variancePct =
          theoreticalIngCost > 0
            ? round2((varianceCost / theoreticalIngCost) * 100)
            : totalActualCost > 0
            ? 100
            : 0;
        const theoreticalFoodCostPct = p.costing.foodCostPct;
        const actualFoodCostPct =
          st.revenue > 0 ? round2((totalActualCost / st.revenue) * 100) : 0;

        return {
          id: p.id,
          sku: p.sku,
          name: p.name,
          categoryName: p.category_name,
          unitsSold: st.units_sold,
          salesRevenue: round2(st.revenue),
          theoreticalIngredientCost: theoreticalIngCost,
          actualSaleCogs,
          linkedWasteEvents: w?.events || 0,
          linkedWasteServings: w?.servings || 0,
          linkedWasteCost,
          totalActualCost,
          varianceCost,
          variancePct,
          theoreticalFoodCostPct,
          actualFoodCostPct,
          targetFoodCostPct: p.target_food_cost_pct,
          wasteIngredients: w ? Array.from(w.ingredients.values()) : [],
        };
      })
      .sort(
        (a, b) =>
          b.linkedWasteCost - a.linkedWasteCost ||
          Math.abs(b.varianceCost) - Math.abs(a.varianceCost) ||
          b.unitsSold - a.unitsSold,
      );

    const locMap = new Map(snap.locations.map((l) => [l.id, l]));
    const recentWasteLogs = [...wasteLogsInLoc]
      .sort((a, b) => String(b.wastedAt || tsToIso(b.createdAt)).localeCompare(String(a.wastedAt || tsToIso(a.createdAt))))
      .slice(0, 20)
      .map((w) => ({
        id: toLogicalId(w.id, uid),
        locationName: w.locationName || locMap.get(w.locationId)?.name || 'Location',
        entryMode: w.entryMode,
        txnType: w.txnType,
        reasonCategory: w.reasonCategory,
        reasonNotes: w.reasonNotes || '',
        productId: w.productId ? toLogicalId(w.productId, uid) : null,
        productName: w.productName || null,
        servingsWasted: Number(w.servingsWasted || 0),
        primaryItemName: w.primaryItemName || null,
        totalLossCost: Number(w.totalLossCost || 0),
        loggedByName: w.loggedByName || 'Staff',
        wastedAt: String(w.wastedAt || tsToIso(w.createdAt)),
      }));

    const wasteSummary = {
      totalTheoreticalIngredientCost: round2(recipeUsageReport.reduce((s, r) => s + r.theoreticalIngredientCost, 0)),
      totalActualCostWithWaste: round2(recipeUsageReport.reduce((s, r) => s + r.totalActualCost, 0)),
      totalNetVarianceCost: round2(avtReport.reduce((s, r) => s + r.varianceCost, 0)),
      totalRecordedWasteCost: round2(avtReport.reduce((s, r) => s + r.wasteCost, 0)),
      recipeLinkedWasteCost: round2(recipeUsageReport.reduce((s, r) => s + r.linkedWasteCost, 0)),
      recipeLinkedWasteEvents: recipeUsageReport.reduce((s, r) => s + r.linkedWasteEvents, 0),
    };

    return { menuEngineering, avtReport, recipeUsageReport, recentWasteLogs, wasteSummary } as T;
  }

  // 8. FLEET
  if (pathname === '/fleet' && method === 'GET') {
    assertPerm(user, PERMISSIONS.FLEET_MANAGE);
    const locMap = new Map(snap.locations.map((l) => [l.id, l]));
    const trkMap = new Map(snap.foodTrucks.map((t) => [t.id, t]));
    const trkByLocId = new Map(snap.foodTrucks.map((t) => [t.locationId, t]));

    const assignmentsDesc = snap.fleetLogs
      .filter((fl) => fl.logType === 'ASSIGNMENT')
      .sort(
        (a, b) =>
          String(b.assignedDate || '').localeCompare(String(a.assignedDate || '')) ||
          tsToIso(b.createdAt).localeCompare(tsToIso(a.createdAt)),
      );
    const latestAssignByTruck = new Map<string, any>();
    for (const fl of assignmentsDesc) {
      if (!latestAssignByTruck.has(fl.truckId)) {
        latestAssignByTruck.set(fl.truckId, fl);
      }
    }

    const trucks = snap.foodTrucks
      .filter((ft) => {
        const loc = locMap.get(ft.locationId);
        return !loc || loc.isActive !== false;
      })
      .map((ft) => {
        const loc = locMap.get(ft.locationId);
        const latestAssign = latestAssignByTruck.get(ft.id);
        const completed = snap.sales.filter((s) => s.locationId === ft.locationId && s.status === 'COMPLETED');
        const totalSales = round2(completed.reduce((s, r) => s + Number(r.totalAmount || 0), 0));
        const totalCogs = round2(completed.reduce((s, r) => s + Number(r.totalCogs || 0), 0));
        const totalExpenses = round2(snap.expenses.filter((e) => e.locationId === ft.locationId).reduce((s, e) => s + Number(e.amount || 0), 0));
        return {
          id: toLogicalId(ft.id, uid),
          location_id: toLogicalId(ft.locationId, uid),
          plate_number: ft.plateNumber,
          make_model: ft.makeModel,
          status: ft.status,
          current_site: ft.currentSite || latestAssign?.siteName || '',
          latest_shift_notes: latestAssign?.shiftNotes || '',
          latest_assigned_date: latestAssign?.assignedDate || '',
          odometer_km: ft.odometerKm,
          location_name: loc?.name || '',
          location_code: loc?.code || '',
          location_address: loc?.address || '',
          kds_enabled: isLocationKdsEnabled(loc) ? 1 : 0,
          total_sales: totalSales,
          total_cogs: totalCogs,
          total_expenses: totalExpenses,
        };
      });

    const locations = snap.locations
      .filter((l) => l.isActive !== false)
      .sort((a, b) => String(a.type).localeCompare(String(b.type)) || String(a.name).localeCompare(String(b.name)))
      .map((l) => {
        const trk = trkByLocId.get(l.id);
        return {
          id: toLogicalId(l.id, uid),
          code: l.code,
          name: l.name,
          type: l.type,
          address: l.address || '',
          is_active: l.isActive ? 1 : 0,
          kds_enabled: isLocationKdsEnabled(l) ? 1 : 0,
          daily_sales_target: Number(l.dailySalesTarget ?? (l.type === 'FOOD_TRUCK' ? (l.code === 'TRK-02' ? 12000 : 15000) : 5000)),
          truck_id: trk ? toLogicalId(trk.id, uid) : null,
          plate_number: trk?.plateNumber || '',
          make_model: trk?.makeModel || '',
          status: trk?.status || 'ACTIVE',
          current_site: trk?.currentSite || '',
          odometer_km: trk?.odometerKm ?? 0,
        };
      });

    const assignments = assignmentsDesc
      .slice(0, 20)
      .map((fl) => {
        const trk = trkMap.get(fl.truckId);
        return {
          id: toLogicalId(fl.id, uid),
          truck_id: toLogicalId(fl.truckId, uid),
          location_id: trk?.locationId ? toLogicalId(trk.locationId, uid) : null,
          site_name: fl.siteName,
          assigned_date: fl.assignedDate,
          shift_notes: fl.shiftNotes,
          plate_number: trk?.plateNumber || '',
          truck_name: (trk && locMap.get(trk.locationId)?.name) || '',
        };
      });

    const fuelLogs = snap.fleetLogs
      .filter((fl) => fl.logType === 'FUEL')
      .sort((a, b) => String(b.assignedDate || '').localeCompare(String(a.assignedDate || '')))
      .slice(0, 20)
      .map((fl) => {
        const trk = trkMap.get(fl.truckId);
        return {
          id: toLogicalId(fl.id, uid),
          truck_id: toLogicalId(fl.truckId, uid),
          location_id: trk?.locationId ? toLogicalId(trk.locationId, uid) : null,
          liters: fl.liters,
          total_cost: fl.totalCost,
          odometer_km: fl.odometerKm,
          fueled_at: fl.assignedDate,
          plate_number: trk?.plateNumber || '',
          truck_name: (trk && locMap.get(trk.locationId)?.name) || '',
        };
      });

    const maintenanceLogs = snap.fleetLogs
      .filter((fl) => fl.logType === 'MAINTENANCE')
      .sort(
        (a, b) =>
          String(b.serviceDate || '').localeCompare(String(a.serviceDate || '')) ||
          tsToIso(b.createdAt).localeCompare(tsToIso(a.createdAt)),
      )
      .slice(0, 100)
      .map((fl) => {
        const trk = trkMap.get(fl.truckId);
        const validCategories: MaintenanceCategory[] = [
          'ENGINE_OIL',
          'TIRES_BRAKES',
          'GENERATOR_LPG',
          'KITCHEN_EQUIP',
          'LTO_EMISSIONS',
          'GENERAL',
        ];
        const cat = validCategories.includes(fl.maintenanceCategory)
          ? (fl.maintenanceCategory as MaintenanceCategory)
          : 'GENERAL';
        const status: MaintenanceStatus = fl.maintenanceStatus === 'COMPLETED' ? 'COMPLETED' : 'OPEN';
        return {
          id: toLogicalId(fl.id, uid),
          truck_id: toLogicalId(fl.truckId, uid),
          location_id: trk?.locationId ? toLogicalId(trk.locationId, uid) : null,
          title: fl.title || 'Scheduled Service',
          description: fl.description || null,
          cost: round2(Number(fl.totalCost || 0)),
          odometer_km: fl.odometerKm !== null && fl.odometerKm !== undefined ? Number(fl.odometerKm) : null,
          service_date: fl.serviceDate || tsToIso(fl.createdAt).slice(0, 10),
          next_due_date: fl.nextDueDate || null,
          maintenance_category: cat,
          service_provider: fl.serviceProvider || null,
          maintenance_status: status,
          alert_lead_days: Number.isFinite(Number(fl.alertLeadDays)) ? Number(fl.alertLeadDays) : 7,
          expense_id: fl.expenseId ? toLogicalId(fl.expenseId, uid) : null,
          plate_number: trk?.plateNumber || '',
          truck_name: (trk && locMap.get(trk.locationId)?.name) || '',
        };
      });

    await syncFleetMaintenanceAlertsFirestore(snap);

    const trucksWithMaintenance = trucks.map((t) => {
      const mSummary = summarizeTruckMaintenance(t.id, maintenanceLogs);
      return {
        ...t,
        maintenance_cost_total: mSummary.totalCost,
        maintenance_count: mSummary.serviceCount,
        last_service_date: mSummary.lastServiceDate,
        next_due_date: mSummary.nextDueDate,
        overdue_alerts: mSummary.overdueCount,
        due_soon_alerts: mSummary.dueSoonCount,
      };
    });

    return { trucks: trucksWithMaintenance, locations, assignments, fuelLogs, maintenanceLogs } as T;
  }

  if (pathname === '/fleet/trucks' && method === 'POST') {
    assertPerm(user, PERMISSIONS.FLEET_MANAGE);
    const { name, code, type, address, plateNumber, makeModel, currentSite, odometerKm, status, kdsEnabled } = body || {};
    const cleanName = String(name || '').trim().slice(0, 140);
    const locType = type === 'COMMISSARY' ? 'COMMISSARY' : 'FOOD_TRUCK';
    const nextPrefix = locType === 'COMMISSARY' ? 'COM' : 'TRK';
    const cleanCode = String(code || `${nextPrefix}-${Date.now().toString().slice(-3)}`).trim().slice(0, 40);
    const cleanAddress = String(address || '').trim().slice(0, 240);
    const nextKdsEnabled = kdsEnabled !== undefined ? Boolean(kdsEnabled) : locType === 'FOOD_TRUCK';

    if (!cleanName) throw new Error('Truck / Location name is required');
    if (!cleanCode) throw new Error('Location code is required');
    if (snap.locations.some((l) => l.isActive !== false && String(l.code).toLowerCase() === cleanCode.toLowerCase())) {
      throw new Error(`Location code "${cleanCode}" already exists`);
    }

    const locLogicalId = crypto.randomUUID();
    const locDocId = toDocId(locLogicalId, uid);
    const batch = writeBatch(db);
    batch.set(doc(db, 'locations', locDocId), {
      id: locDocId,
      ownerUid: uid,
      code: cleanCode,
      name: cleanName,
      type: locType,
      address: cleanAddress || null,
      isActive: true,
      kdsEnabled: nextKdsEnabled,
      createdAt: serverTimestamp(),
    });

    let trkLogicalId: string | null = null;
    if (locType === 'FOOD_TRUCK') {
      const cleanPlate = String(plateNumber || '').trim().slice(0, 32);
      const cleanModel = String(makeModel || '').trim().slice(0, 140);
      if (!cleanPlate) throw new Error('Plate number is required for a food truck');
      if (!cleanModel) throw new Error('Make / Model is required for a food truck');
      const cleanSite = String(currentSite || cleanAddress || '').trim().slice(0, 160);
      const nextStatus = status === 'MAINTENANCE' || status === 'INACTIVE' ? status : 'ACTIVE';
      const nextOdo = Math.max(0, Number(odometerKm || 0));

      trkLogicalId = crypto.randomUUID();
      const trkDocId = toDocId(trkLogicalId, uid);
      batch.set(doc(db, 'food_trucks', trkDocId), {
        id: trkDocId,
        ownerUid: uid,
        locationId: locDocId,
        plateNumber: cleanPlate,
        makeModel: cleanModel,
        status: nextStatus,
        currentSite: cleanSite || null,
        odometerKm: nextOdo,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `locations/${locDocId}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'CREATE_LOCATION_TRUCK', 'Location', locLogicalId, {
      code: cleanCode,
      name: cleanName,
      type: locType,
    });
    invalidateWorkspaceCache();
    return { id: trkLogicalId || locLogicalId, locationId: locLogicalId } as T;
  }

  if (pathname.startsWith('/fleet/locations/') && method === 'PUT') {
    assertPerm(user, PERMISSIONS.FLEET_MANAGE);
    const rawId = pathname.split('/')[3];
    const maybeDocId = toDocId(rawId, uid);
    const existingLoc =
      snap.locations.find((l) => l.id === maybeDocId) ||
      (() => {
        const trk = snap.foodTrucks.find((t) => t.id === maybeDocId);
        return trk ? snap.locations.find((l) => l.id === trk.locationId) : undefined;
      })();
    if (!existingLoc) throw new Error('Location not found');

    const { name, code, type, address, plateNumber, makeModel, currentSite, odometerKm, status, kdsEnabled, dailySalesTarget } = body || {};
    const cleanName = String(name ?? existingLoc.name).trim().slice(0, 140);
    const cleanCode = String(code ?? existingLoc.code).trim().slice(0, 40);
    const nextType = type === 'COMMISSARY' || type === 'FOOD_TRUCK' ? type : existingLoc.type;
    const cleanAddress = address !== undefined ? String(address || '').trim().slice(0, 240) : existingLoc.address || '';
    const nextKdsEnabled =
      kdsEnabled !== undefined
        ? Boolean(kdsEnabled)
        : existingLoc.kdsEnabled !== undefined
          ? Boolean(existingLoc.kdsEnabled)
          : nextType === 'FOOD_TRUCK';
    const nextDailyTarget =
      dailySalesTarget !== undefined
        ? Math.max(0, Number(dailySalesTarget) || 0)
        : Number(existingLoc.dailySalesTarget ?? (nextType === 'FOOD_TRUCK' ? 15000 : 5000));

    if (!cleanName) throw new Error('Truck / Location name is required');
    if (!cleanCode) throw new Error('Location code is required');
    if (
      snap.locations.some(
        (l) => l.id !== existingLoc.id && l.isActive !== false && String(l.code).toLowerCase() === cleanCode.toLowerCase(),
      )
    ) {
      throw new Error(`Location code "${cleanCode}" already exists`);
    }

    const batch = writeBatch(db);
    batch.update(doc(db, 'locations', existingLoc.id), {
      code: cleanCode,
      name: cleanName,
      type: nextType,
      address: cleanAddress || null,
      isActive: existingLoc.isActive !== false,
      kdsEnabled: nextKdsEnabled,
      dailySalesTarget: nextDailyTarget,
    });

    const existingTruck = snap.foodTrucks.find((t) => t.locationId === existingLoc.id);
    if (nextType === 'FOOD_TRUCK') {
      const cleanPlate = String(plateNumber ?? existingTruck?.plateNumber ?? '').trim().slice(0, 32);
      const cleanModel = String(makeModel ?? existingTruck?.makeModel ?? '').trim().slice(0, 140);
      if (!cleanPlate) throw new Error('Plate number is required for a food truck');
      if (!cleanModel) throw new Error('Make / Model is required for a food truck');
      const cleanSite =
        currentSite !== undefined
          ? String(currentSite || '').trim().slice(0, 160)
          : String(existingTruck?.currentSite || cleanAddress || '').trim().slice(0, 160);
      const nextStatus =
        status === 'ACTIVE' || status === 'MAINTENANCE' || status === 'INACTIVE'
          ? status
          : existingTruck?.status || 'ACTIVE';
      const nextOdo = Math.max(0, Number(odometerKm !== undefined ? odometerKm : existingTruck?.odometerKm || 0));

      if (existingTruck) {
        batch.update(doc(db, 'food_trucks', existingTruck.id), {
          plateNumber: cleanPlate,
          makeModel: cleanModel,
          status: nextStatus,
          currentSite: cleanSite || null,
          odometerKm: nextOdo,
          updatedAt: serverTimestamp(),
        });
      } else {
        const trkDocId = toDocId(crypto.randomUUID(), uid);
        batch.set(doc(db, 'food_trucks', trkDocId), {
          id: trkDocId,
          ownerUid: uid,
          locationId: existingLoc.id,
          plateNumber: cleanPlate,
          makeModel: cleanModel,
          status: nextStatus,
          currentSite: cleanSite || null,
          odometerKm: nextOdo,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    }

    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `locations/${existingLoc.id}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'UPDATE_LOCATION_TRUCK', 'Location', toLogicalId(existingLoc.id, uid), {
      code: cleanCode,
      name: cleanName,
      type: nextType,
      kdsEnabled: nextKdsEnabled,
    });
    invalidateWorkspaceCache();
    return { ok: true } as T;
  }

  if (pathname.startsWith('/fleet/locations/') && pathname.endsWith('/kds') && method === 'PATCH') {
    assertPerm(user, PERMISSIONS.FLEET_MANAGE);
    const rawId = pathname.split('/')[3];
    const maybeDocId = toDocId(rawId, uid);
    const existingLoc =
      snap.locations.find((l) => l.id === maybeDocId) ||
      (() => {
        const trk = snap.foodTrucks.find((t) => t.id === maybeDocId);
        return trk ? snap.locations.find((l) => l.id === trk.locationId) : undefined;
      })();
    if (!existingLoc) throw new Error('Location not found');

    const nextKdsEnabled = Boolean(body?.kdsEnabled);
    try {
      await updateDoc(doc(db, 'locations', existingLoc.id), {
        kdsEnabled: nextKdsEnabled,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `locations/${existingLoc.id}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'TOGGLE_LOCATION_KDS', 'Location', toLogicalId(existingLoc.id, uid), {
      name: existingLoc.name,
      kdsEnabled: nextKdsEnabled,
    });
    invalidateWorkspaceCache();
    return { ok: true, id: toLogicalId(existingLoc.id, uid), kds_enabled: nextKdsEnabled ? 1 : 0 } as T;
  }

  if (pathname.startsWith('/fleet/locations/') && pathname.endsWith('/target') && method === 'PATCH') {
    assertPerm(user, PERMISSIONS.FLEET_MANAGE);
    const rawId = pathname.split('/')[3];
    const maybeDocId = toDocId(rawId, uid);
    const existingLoc =
      snap.locations.find((l) => l.id === maybeDocId) ||
      (() => {
        const trk = snap.foodTrucks.find((t) => t.id === maybeDocId);
        return trk ? snap.locations.find((l) => l.id === trk.locationId) : undefined;
      })();
    if (!existingLoc) throw new Error('Location not found');

    const rawTarget = Number(body?.dailySalesTarget);
    if (!Number.isFinite(rawTarget) || rawTarget < 0) {
      throw new Error('Daily sales target must be a valid non-negative amount');
    }
    const nextTarget = round2(rawTarget);
    try {
      await updateDoc(doc(db, 'locations', existingLoc.id), {
        dailySalesTarget: nextTarget,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `locations/${existingLoc.id}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'UPDATE_LOCATION_SALES_TARGET', 'Location', toLogicalId(existingLoc.id, uid), {
      name: existingLoc.name,
      dailySalesTarget: nextTarget,
    });
    invalidateWorkspaceCache();
    return { ok: true, id: toLogicalId(existingLoc.id, uid), daily_sales_target: nextTarget } as T;
  }

  if (pathname.startsWith('/fleet/locations/') && method === 'DELETE') {
    assertPerm(user, PERMISSIONS.FLEET_MANAGE);
    const rawId = pathname.split('/')[3];
    const maybeDocId = toDocId(rawId, uid);
    const existingLoc =
      snap.locations.find((l) => l.id === maybeDocId) ||
      (() => {
        const trk = snap.foodTrucks.find((t) => t.id === maybeDocId);
        return trk ? snap.locations.find((l) => l.id === trk.locationId) : undefined;
      })();
    if (!existingLoc) throw new Error('Location not found');

    const activeLocations = snap.locations.filter((l) => l.isActive !== false);
    if (activeLocations.length <= 1 && existingLoc.isActive !== false) {
      throw new Error('Cannot delete the last active location');
    }

    const existingTruck = snap.foodTrucks.find((t) => t.locationId === existingLoc.id);
    const hasFleetLogs = existingTruck ? snap.fleetLogs.some((fl) => fl.truckId === existingTruck.id) : false;
    const hasHistory =
      hasFleetLogs ||
      snap.sales.some((s) => s.locationId === existingLoc.id) ||
      snap.expenses.some((e) => e.locationId === existingLoc.id) ||
      snap.stockBatches.some((b) => b.locationId === existingLoc.id) ||
      snap.inventoryTxns.some((t) => t.locationId === existingLoc.id) ||
      snap.purchaseOrders.some((p) => p.locationId === existingLoc.id) ||
      snap.dailyClosings.some((d) => d.locationId === existingLoc.id) ||
      snap.stockTransfers.some((t) => t.fromLocationId === existingLoc.id || t.toLocationId === existingLoc.id);

    const batch = writeBatch(db);
    if (hasHistory) {
      batch.update(doc(db, 'locations', existingLoc.id), {
        isActive: false,
      });
      if (existingTruck && !hasFleetLogs) {
        batch.delete(doc(db, 'food_trucks', existingTruck.id));
      } else if (existingTruck) {
        batch.update(doc(db, 'food_trucks', existingTruck.id), {
          status: 'INACTIVE',
          updatedAt: serverTimestamp(),
        });
      }
    } else {
      if (existingTruck) {
        batch.delete(doc(db, 'food_trucks', existingTruck.id));
      }
      batch.delete(doc(db, 'locations', existingLoc.id));
    }

    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, hasHistory ? OperationType.UPDATE : OperationType.DELETE, `locations/${existingLoc.id}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'DELETE_LOCATION_TRUCK', 'Location', toLogicalId(existingLoc.id, uid), {
      code: existingLoc.code,
      name: existingLoc.name,
      archived: hasHistory,
    });
    invalidateWorkspaceCache();
    return { ok: true, archived: hasHistory } as T;
  }

  if (pathname === '/fleet/assignments' && method === 'POST') {
    assertPerm(user, PERMISSIONS.FLEET_MANAGE);
    const { truckId, siteName, assignedDate, shiftNotes } = body || {};
    const trkDocId = toDocId(truckId, uid);
    const logId = toDocId(crypto.randomUUID(), uid);
    const batch = writeBatch(db);
    batch.set(doc(db, 'fleet_logs', logId), {
      id: logId,
      ownerUid: uid,
      logType: 'ASSIGNMENT',
      truckId: trkDocId,
      siteName: String(siteName || ''),
      assignedDate: assignedDate || new Date().toISOString().slice(0, 10),
      shiftNotes: shiftNotes || '',
      liters: null,
      totalCost: null,
      odometerKm: null,
      title: null,
      description: null,
      serviceDate: null,
      nextDueDate: null,
      createdAt: serverTimestamp(),
    });
    batch.update(doc(db, 'food_trucks', trkDocId), {
      currentSite: String(siteName || ''),
      updatedAt: serverTimestamp(),
    });
    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'fleet_assignments');
    }
    invalidateWorkspaceCache();
    return { ok: true } as T;
  }

  if (pathname === '/fleet/fuel' && method === 'POST') {
    assertPerm(user, PERMISSIONS.FLEET_MANAGE);
    const { truckId, liters, totalCost, odometerKm } = body || {};
    const trkDocId = toDocId(truckId, uid);
    const trk = snap.foodTrucks.find((t) => t.id === trkDocId);
    if (!trk) throw new Error('Food truck not found');
    const cost = round2(Number(totalCost));
    const nowIso = new Date().toISOString();
    const expId = toDocId(crypto.randomUUID(), uid);
    const logId = toDocId(crypto.randomUUID(), uid);

    const batch = writeBatch(db);
    if (cost > 0) {
      batch.set(doc(db, 'expenses', expId), {
        id: expId,
        ownerUid: uid,
        locationId: trk.locationId,
        accountId: toDocId('acc_6100', uid),
        category: 'FUEL',
        amount: cost,
        description: `Fuel log (${liters}L @ ${odometerKm}km)`,
        isRecurring: false,
        paidFromPettyCash: false,
        expenseDate: nowIso,
        createdAt: serverTimestamp(),
      });
    }
    batch.set(doc(db, 'fleet_logs', logId), {
      id: logId,
      ownerUid: uid,
      logType: 'FUEL',
      truckId: trkDocId,
      siteName: null,
      assignedDate: nowIso,
      shiftNotes: null,
      liters: Number(liters),
      totalCost: cost,
      odometerKm: Number(odometerKm || 0),
      title: null,
      description: null,
      serviceDate: null,
      nextDueDate: null,
      createdAt: serverTimestamp(),
    });
    if (odometerKm) {
      batch.update(doc(db, 'food_trucks', trkDocId), {
        odometerKm: Number(odometerKm),
        updatedAt: serverTimestamp(),
      });
    }
    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'fleet_fuel');
    }
    invalidateWorkspaceCache();
    return { ok: true } as T;
  }

  if (pathname === '/fleet/maintenance' && method === 'POST') {
    assertPerm(user, PERMISSIONS.FLEET_MANAGE);
    const {
      truckId,
      title,
      description,
      serviceDate,
      nextDueDate,
      cost,
      odometerKm,
      maintenanceCategory,
      serviceProvider,
      alertLeadDays,
      postExpense,
      setTruckStatus,
    } = body || {};

    const trkDocId = toDocId(String(truckId || ''), uid);
    const trk = snap.foodTrucks.find((t) => t.id === trkDocId);
    if (!trk) throw new Error('Food truck not found');

    const cleanTitle = String(title || '').trim().slice(0, 160);
    if (!cleanTitle) throw new Error('Service title is required');

    const cleanServiceDate = String(serviceDate || new Date().toISOString().slice(0, 10)).trim().slice(0, 40);
    if (!/^\d{4}-\d{2}-\d{2}/.test(cleanServiceDate)) throw new Error('Valid service date is required');

    const cleanNextDueDate = nextDueDate ? String(nextDueDate).trim().slice(0, 40) : null;
    if (cleanNextDueDate && !/^\d{4}-\d{2}-\d{2}/.test(cleanNextDueDate)) {
      throw new Error('Next checkup date must be in YYYY-MM-DD format');
    }

    const numericCost = round2(Math.max(0, Number(cost || 0)));
    const numericOdo =
      odometerKm !== undefined && odometerKm !== null && odometerKm !== ''
        ? Math.max(0, Number(odometerKm))
        : null;
    const validCategories: MaintenanceCategory[] = [
      'ENGINE_OIL',
      'TIRES_BRAKES',
      'GENERATOR_LPG',
      'KITCHEN_EQUIP',
      'LTO_EMISSIONS',
      'GENERAL',
    ];
    const cleanCategory: MaintenanceCategory = validCategories.includes(maintenanceCategory)
      ? maintenanceCategory
      : 'GENERAL';
    const cleanProvider = serviceProvider ? String(serviceProvider).trim().slice(0, 140) || null : null;
    const cleanDesc = description ? String(description).trim().slice(0, 400) || null : null;
    const cleanLeadDays = Math.min(90, Math.max(0, Math.round(Number(alertLeadDays ?? 7))));
    const shouldPostExpense = numericCost > 0 && postExpense !== false;
    const maintStatus: MaintenanceStatus = cleanNextDueDate ? 'OPEN' : 'COMPLETED';

    const logId = toDocId(crypto.randomUUID(), uid);
    const expId = shouldPostExpense ? toDocId(crypto.randomUUID(), uid) : null;
    const expenseDateIso = cleanServiceDate.length === 10 ? `${cleanServiceDate}T08:00:00.000Z` : cleanServiceDate;

    const batch = writeBatch(db);
    if (shouldPostExpense && expId) {
      batch.set(doc(db, 'expenses', expId), {
        id: expId,
        ownerUid: uid,
        locationId: trk.locationId,
        accountId: toDocId('acc_6400', uid),
        category: 'MAINTENANCE',
        amount: numericCost,
        description: `Fleet Maintenance: ${cleanTitle}${cleanProvider ? ` (${cleanProvider})` : ''}`.slice(0, 400),
        isRecurring: false,
        paidFromPettyCash: false,
        expenseDate: expenseDateIso,
        createdAt: serverTimestamp(),
      });
    }

    const newLogDoc = {
      id: logId,
      ownerUid: uid,
      logType: 'MAINTENANCE',
      truckId: trkDocId,
      siteName: null,
      assignedDate: null,
      shiftNotes: null,
      liters: null,
      totalCost: numericCost,
      odometerKm: numericOdo,
      title: cleanTitle,
      description: cleanDesc,
      serviceDate: cleanServiceDate,
      nextDueDate: cleanNextDueDate,
      maintenanceCategory: cleanCategory,
      serviceProvider: cleanProvider,
      maintenanceStatus: maintStatus,
      alertLeadDays: cleanLeadDays,
      expenseId: expId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    batch.set(doc(db, 'fleet_logs', logId), newLogDoc);

    const truckPatch: Record<string, any> = {};
    if (numericOdo !== null && numericOdo > Number(trk.odometerKm || 0)) {
      truckPatch.odometerKm = numericOdo;
    }
    if (setTruckStatus === 'ACTIVE' || setTruckStatus === 'MAINTENANCE') {
      truckPatch.status = setTruckStatus;
    }
    if (Object.keys(truckPatch).length > 0) {
      truckPatch.updatedAt = serverTimestamp();
      batch.update(doc(db, 'food_trucks', trkDocId), truckPatch);
    }

    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'fleet_maintenance');
    }

    snap.fleetLogs.push({ ...newLogDoc, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await syncFleetMaintenanceAlertsFirestore(snap);
    await addAuditLog(uid, user.id, user.fullName, 'LOG_FLEET_MAINTENANCE', 'FleetLog', toLogicalId(logId, uid), {
      truckId: toLogicalId(trkDocId, uid),
      title: cleanTitle,
      serviceDate: cleanServiceDate,
      nextDueDate: cleanNextDueDate,
      cost: numericCost,
    });
    invalidateWorkspaceCache();
    return { ok: true, id: toLogicalId(logId, uid) } as T;
  }

  if (pathname.startsWith('/fleet/maintenance/') && method === 'PATCH') {
    assertPerm(user, PERMISSIONS.FLEET_MANAGE);
    const rawId = pathname.slice('/fleet/maintenance/'.length);
    const logDocId = toDocId(rawId, uid);
    const existing = snap.fleetLogs.find((fl) => (fl.id === logDocId || fl.id === rawId) && fl.logType === 'MAINTENANCE');
    if (!existing) throw new Error('Maintenance log not found');

    const {
      truckId,
      title,
      description,
      serviceDate,
      nextDueDate,
      cost,
      odometerKm,
      maintenanceCategory,
      serviceProvider,
      maintenanceStatus,
      alertLeadDays,
    } = body || {};

    const nextTruckDocId = truckId ? toDocId(String(truckId), uid) : existing.truckId;
    const nextTruck = snap.foodTrucks.find((t) => t.id === nextTruckDocId);
    if (!nextTruck) throw new Error('Food truck not found');

    const cleanTitle = title !== undefined ? String(title || '').trim().slice(0, 160) : String(existing.title || '');
    if (!cleanTitle) throw new Error('Service title is required');

    const cleanServiceDate =
      serviceDate !== undefined ? String(serviceDate || '').trim().slice(0, 40) : String(existing.serviceDate || '');
    const cleanNextDueDate =
      nextDueDate !== undefined ? (nextDueDate ? String(nextDueDate).trim().slice(0, 40) : null) : existing.nextDueDate || null;
    const numericCost = cost !== undefined ? round2(Math.max(0, Number(cost || 0))) : round2(Number(existing.totalCost || 0));
    const numericOdo =
      odometerKm !== undefined
        ? odometerKm !== null && odometerKm !== ''
          ? Math.max(0, Number(odometerKm))
          : null
        : existing.odometerKm ?? null;
    const validCategories: MaintenanceCategory[] = [
      'ENGINE_OIL',
      'TIRES_BRAKES',
      'GENERATOR_LPG',
      'KITCHEN_EQUIP',
      'LTO_EMISSIONS',
      'GENERAL',
    ];
    const cleanCategory: MaintenanceCategory =
      maintenanceCategory !== undefined
        ? validCategories.includes(maintenanceCategory)
          ? maintenanceCategory
          : 'GENERAL'
        : existing.maintenanceCategory || 'GENERAL';
    const cleanProvider =
      serviceProvider !== undefined
        ? serviceProvider
          ? String(serviceProvider).trim().slice(0, 140) || null
          : null
        : existing.serviceProvider ?? null;
    const cleanDesc =
      description !== undefined
        ? description
          ? String(description).trim().slice(0, 400) || null
          : null
        : existing.description ?? null;
    const cleanStatus: MaintenanceStatus =
      maintenanceStatus === 'COMPLETED' || maintenanceStatus === 'OPEN'
        ? maintenanceStatus
        : existing.maintenanceStatus === 'COMPLETED'
          ? 'COMPLETED'
          : 'OPEN';
    const cleanLeadDays =
      alertLeadDays !== undefined
        ? Math.min(90, Math.max(0, Math.round(Number(alertLeadDays ?? 7))))
        : Number.isFinite(Number(existing.alertLeadDays))
          ? Number(existing.alertLeadDays)
          : 7;

    const batch = writeBatch(db);
    let linkedExpenseId: string | null = existing.expenseId || null;
    const existingExpense = linkedExpenseId ? snap.expenses.find((e) => e.id === linkedExpenseId) : null;
    if (existingExpense) {
      if (numericCost > 0) {
        const expDateIso = cleanServiceDate.length === 10 ? `${cleanServiceDate}T08:00:00.000Z` : cleanServiceDate;
        batch.update(doc(db, 'expenses', existingExpense.id), {
          locationId: nextTruck.locationId,
          amount: numericCost,
          description: `Fleet Maintenance: ${cleanTitle}${cleanProvider ? ` (${cleanProvider})` : ''}`.slice(0, 400),
          expenseDate: expDateIso,
          updatedAt: serverTimestamp(),
        });
      } else {
        batch.delete(doc(db, 'expenses', existingExpense.id));
        linkedExpenseId = null;
      }
    }

    const patchPayload = {
      truckId: nextTruckDocId,
      title: cleanTitle,
      description: cleanDesc,
      serviceDate: cleanServiceDate,
      nextDueDate: cleanNextDueDate,
      totalCost: numericCost,
      odometerKm: numericOdo,
      maintenanceCategory: cleanCategory,
      serviceProvider: cleanProvider,
      maintenanceStatus: cleanStatus,
      alertLeadDays: cleanLeadDays,
      expenseId: linkedExpenseId,
      updatedAt: serverTimestamp(),
    };
    batch.update(doc(db, 'fleet_logs', existing.id), patchPayload);

    if (numericOdo !== null && numericOdo > Number(nextTruck.odometerKm || 0)) {
      batch.update(doc(db, 'food_trucks', nextTruckDocId), {
        odometerKm: numericOdo,
        updatedAt: serverTimestamp(),
      });
    }

    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `fleet_logs/${existing.id}`);
    }

    Object.assign(existing, patchPayload);
    if (cleanStatus === 'COMPLETED' && cleanTitle) {
      await resolveMatchingNotifications(snap, ['FLEET_MAINTENANCE'], cleanTitle, nextTruck.locationId);
    } else {
      await syncFleetMaintenanceAlertsFirestore(snap);
    }
    await addAuditLog(uid, user.id, user.fullName, 'UPDATE_FLEET_MAINTENANCE', 'FleetLog', toLogicalId(existing.id, uid), {
      title: cleanTitle,
      status: cleanStatus,
      cost: numericCost,
      nextDueDate: cleanNextDueDate,
    });
    invalidateWorkspaceCache();
    return { ok: true } as T;
  }

  if (pathname.startsWith('/fleet/maintenance/') && method === 'DELETE') {
    assertPerm(user, PERMISSIONS.FLEET_MANAGE);
    const rawId = pathname.slice('/fleet/maintenance/'.length);
    const logDocId = toDocId(rawId, uid);
    const existing = snap.fleetLogs.find((fl) => (fl.id === logDocId || fl.id === rawId) && fl.logType === 'MAINTENANCE');
    if (!existing) throw new Error('Maintenance log not found');

    const trk = snap.foodTrucks.find((t) => t.id === existing.truckId);
    const batch = writeBatch(db);
    batch.delete(doc(db, 'fleet_logs', existing.id));
    if (existing.expenseId && snap.expenses.some((e) => e.id === existing.expenseId)) {
      batch.delete(doc(db, 'expenses', existing.expenseId));
    }

    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `fleet_logs/${existing.id}`);
    }

    if (existing.title) {
      await resolveMatchingNotifications(snap, ['FLEET_MAINTENANCE'], existing.title, trk?.locationId || null);
    }
    await addAuditLog(uid, user.id, user.fullName, 'DELETE_FLEET_MAINTENANCE', 'FleetLog', toLogicalId(existing.id, uid), {
      title: existing.title,
    });
    invalidateWorkspaceCache();
    return { ok: true } as T;
  }

  // 9. HR, ATTENDANCE KIOSK & PAYROLL
  if (pathname === '/hr' && method === 'GET') {
    assertPerm(user, PERMISSIONS.HR_MANAGE);
    const locMap = new Map(snap.locations.map((l) => [l.id, l]));
    const empMap = new Map(snap.employees.map((e) => [e.id, e]));

    const employees = [...snap.employees]
      .sort((a, b) => String(a.employeeCode).localeCompare(String(b.employeeCode)))
      .map((e) => ({
        id: toLogicalId(e.id, uid),
        employee_code: e.employeeCode,
        full_name: e.fullName,
        phone: e.phone || '',
        address: e.address || '',
        department: e.department,
        position: e.position,
        location_id: e.locationId ? toLogicalId(e.locationId, uid) : null,
        location_name: e.locationId ? locMap.get(e.locationId)?.name || '' : '',
        pay_type: e.payType,
        base_rate: e.baseRate,
        avatar_url: e.avatarUrl || null,
        face_descriptor_json: e.faceDescriptorJson || null,
        face_enrolled_at: e.faceEnrolledAt || null,
        attendance_pin: e.attendancePin || null,
        is_active: e.isActive ? 1 : 0,
      }));

    const attendance = [...snap.attendanceLogs]
      .sort((a, b) => String(b.clockIn).localeCompare(String(a.clockIn)))
      .slice(0, 60)
      .map((a) => {
        const emp = empMap.get(a.employeeId);
        const resolvedLocId = a.locationId || emp?.locationId || null;
        return {
          id: toLogicalId(a.id, uid),
          employee_id: toLogicalId(a.employeeId, uid),
          clock_in: a.clockIn,
          clock_out: a.clockOut,
          worked_hours: Number(a.workedHours || 0),
          overtime_hours: Number(a.overtimeHours || 0),
          status: a.status,
          verification_method: a.verificationMethod || 'MANUAL',
          match_confidence: a.matchConfidence ?? null,
          clock_in_photo: a.clockInPhoto || null,
          clock_out_photo: a.clockOutPhoto || null,
          notes: a.notes || null,
          full_name: emp?.fullName || '',
          employee_code: emp?.employeeCode || '',
          employee_avatar_url: emp?.avatarUrl || null,
          location_id: resolvedLocId ? toLogicalId(resolvedLocId, uid) : null,
          location_name: resolvedLocId ? locMap.get(resolvedLocId)?.name || 'Commissary HQ' : 'Commissary HQ',
        };
      });

    const payrollRuns = [...snap.payrollRuns]
      .sort((a, b) => tsToIso(b.createdAt).localeCompare(tsToIso(a.createdAt)))
      .slice(0, 10)
      .map((pr) => ({
        id: toLogicalId(pr.id, uid),
        period_start: pr.periodStart,
        period_end: pr.periodEnd,
        status: pr.status,
        total_gross: pr.totalGross,
        total_deductions: pr.totalDeductions,
        total_net: pr.totalNet,
        created_at: tsToIso(pr.createdAt),
        items: (pr.items || []).map((pi: any) => {
          const emp = empMap.get(pi.employeeId);
          return {
            ...pi,
            full_name: emp?.fullName || pi.full_name || '',
            employee_code: emp?.employeeCode || pi.employee_code || '',
            location_id: emp?.locationId ? toLogicalId(emp.locationId, uid) : null,
          };
        }),
      }));

    const shiftTemplates = [...snap.shiftTemplates]
      .sort((a, b) => {
        if (Boolean(b.isActive) !== Boolean(a.isActive)) return Number(Boolean(b.isActive)) - Number(Boolean(a.isActive));
        const tCmp = String(a.startTime || '').localeCompare(String(b.startTime || ''));
        return tCmp !== 0 ? tCmp : String(a.name || '').localeCompare(String(b.name || ''));
      })
      .map((t) => ({
        id: toLogicalId(t.id, uid),
        code: t.code,
        name: t.name,
        start_time: t.startTime,
        end_time: t.endTime,
        break_minutes: Number(t.breakMinutes ?? 60),
        days_of_week: Array.isArray(t.daysOfWeek) ? t.daysOfWeek : [],
        location_ids: Array.isArray(t.locationIds) ? t.locationIds.map((lid: string) => toLogicalId(lid, uid)) : [],
        default_role: t.defaultRole || null,
        headcount_needed: Number(t.headcountNeeded ?? 2),
        notes: t.notes || null,
        is_active: t.isActive !== false ? 1 : 0,
        created_at: tsToIso(t.createdAt),
        updated_at: tsToIso(t.updatedAt),
      }));

    const shiftSchedules = [...snap.shiftSchedules]
      .sort((a, b) => {
        const dCmp = String(a.shiftDate || '').localeCompare(String(b.shiftDate || ''));
        if (dCmp !== 0) return dCmp;
        const tCmp = String(a.startTime || '').localeCompare(String(b.startTime || ''));
        if (tCmp !== 0) return tCmp;
        const locA = locMap.get(a.locationId)?.name || '';
        const locB = locMap.get(b.locationId)?.name || '';
        return locA.localeCompare(locB);
      })
      .slice(0, 300)
      .map((s) => {
        const loc = locMap.get(s.locationId);
        const emp = s.employeeId ? empMap.get(s.employeeId) : null;
        return {
          id: toLogicalId(s.id, uid),
          template_id: s.templateId ? toLogicalId(s.templateId, uid) : null,
          template_name: s.templateName,
          location_id: toLogicalId(s.locationId, uid),
          location_name: loc?.name || 'Location',
          location_code: loc?.code || '',
          employee_id: s.employeeId ? toLogicalId(s.employeeId, uid) : null,
          employee_name: emp?.fullName || null,
          employee_code: emp?.employeeCode || null,
          employee_position: emp?.position || null,
          shift_date: s.shiftDate,
          start_time: s.startTime,
          end_time: s.endTime,
          break_minutes: Number(s.breakMinutes ?? 60),
          status: s.status || 'SCHEDULED',
          notes: s.notes || null,
          created_at: tsToIso(s.createdAt),
        };
      });

    return {
      employees,
      attendance,
      payrollRules: snap.meta?.payrollRule || null,
      payrollRuns,
      shiftTemplates,
      shiftSchedules,
    } as T;
  }

  if (pathname === '/hr/payroll-rules' && method === 'PUT') {
    assertPerm(user, PERMISSIONS.PAYROLL_RUN);
    const nextRule = { ...(snap.meta?.payrollRule || {}), config: body.config };
    try {
      await updateDoc(doc(db, 'workspace_meta', `ws_${uid}`), {
        payrollRule: nextRule,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `workspace_meta/ws_${uid}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'UPDATE_PAYROLL_RULES', 'PayrollRule', 'PH_STATUTORY_2026');
    invalidateWorkspaceCache();
    return { ok: true } as T;
  }

  if (pathname === '/hr/payroll/run' && method === 'POST') {
    assertPerm(user, PERMISSIONS.PAYROLL_RUN);
    const { periodStart, periodEnd, daysPerEmployee, useAttendanceDays } = body || {};
    const cfg = snap.meta?.payrollRule?.config || {};
    const activeEmployees = snap.employees.filter((e) => e.isActive);
    const runId = toDocId(crypto.randomUUID(), uid);
    let totalGross = 0;
    let totalDed = 0;
    let totalNet = 0;
    const items: any[] = [];

    for (const emp of activeEmployees) {
      const periodLogs = snap.attendanceLogs.filter((a) => {
        if (a.employeeId !== emp.id) return false;
        const d = String(a.clockIn || '').slice(0, 10);
        return (!periodStart || d >= periodStart) && (!periodEnd || d <= periodEnd);
      });
      const uniqueDays = new Set(periodLogs.map((a) => String(a.clockIn || '').slice(0, 10))).size;
      const days = useAttendanceDays ? uniqueDays : Number(daysPerEmployee ?? 13);
      const otHours = periodLogs.reduce((s, a) => s + Number(a.overtimeHours || 0), 0);
      const dailyRate = emp.payType === 'HOURLY' ? Number(emp.baseRate) * 8 : emp.payType === 'MONTHLY' ? Number(emp.baseRate) / 26 : Number(emp.baseRate);
      const hourlyRate = dailyRate / 8;
      const otPay = round2(otHours * hourlyRate * (cfg.overtimeMultiplier || 1.25));
      const gross = round2(days * dailyRate + otPay);
      const sss = round2(gross * ((cfg.sssEmployeeRatePct || 4.5) / 100));
      const phic = round2(gross * ((cfg.philhealthEmployeeRatePct || 2.5) / 100));
      const pagibig = round2((cfg.pagibigFixedEmployeePhp || 200) / 2);
      const semiMonthlyCeiling = (cfg.taxExemptMonthlyCeilingPhp || 20833) / 2;
      const taxableExcess = Math.max(0, gross - (sss + phic + pagibig) - semiMonthlyCeiling);
      const tax = round2(taxableExcess * ((cfg.withholdingRateAboveCeilingPct || 15) / 100));
      const ded = round2(sss + phic + pagibig + tax);
      const net = round2(gross - ded);

      totalGross += gross;
      totalDed += ded;
      totalNet += net;
      items.push({
        id: crypto.randomUUID(),
        employeeId: emp.id,
        days_worked: days,
        overtime_pay: otPay,
        gross_pay: gross,
        sss_deduction: sss,
        philhealth_deduction: phic,
        pagibig_deduction: pagibig,
        tax_deduction: tax,
        net_pay: net,
      });
    }

    const batch = writeBatch(db);
    batch.set(doc(db, 'payroll_runs', runId), {
      id: runId,
      ownerUid: uid,
      periodStart: String(periodStart),
      periodEnd: String(periodEnd),
      status: 'APPROVED',
      totalGross: round2(totalGross),
      totalDeductions: round2(totalDed),
      totalNet: round2(totalNet),
      items,
      createdAt: serverTimestamp(),
    });

    const jeId = toDocId(crypto.randomUUID(), uid);
    const lines: any[] = [
      { id: crypto.randomUUID(), accountId: toDocId('acc_6300', uid), debit: round2(totalGross), credit: 0, memo: 'Salaries & Wages' },
      { id: crypto.randomUUID(), accountId: toDocId('acc_1010', uid), debit: 0, credit: round2(totalNet), memo: 'Net Payroll Disbursement' },
    ];
    if (totalDed > 0) {
      lines.push({ id: crypto.randomUUID(), accountId: toDocId('acc_2000', uid), debit: 0, credit: round2(totalDed), memo: 'Statutory & Tax Remittances Payable' });
    }
    batch.set(doc(db, 'journal_entries', jeId), {
      id: jeId,
      ownerUid: uid,
      entryNumber: `JE-PAY-${Date.now().toString().slice(-6)}`,
      entryDate: new Date().toISOString(),
      description: `Payroll ${periodStart} to ${periodEnd}`,
      referenceType: 'PAYROLL',
      referenceId: runId,
      isReversed: false,
      lines,
      createdAt: serverTimestamp(),
    });

    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `payroll_runs/${runId}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'RUN_PAYROLL', 'PayrollRun', toLogicalId(runId, uid), { totalGross: round2(totalGross), totalNet: round2(totalNet) });
    invalidateWorkspaceCache();
    return { runId: toLogicalId(runId, uid), totalGross: round2(totalGross), totalNet: round2(totalNet) } as T;
  }

  // 9b. SHIFT TEMPLATES & MULTI-LOCATION RECURRING SHIFT SCHEDULES
  const VALID_WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const VALID_SHIFT_STATUSES = ['SCHEDULED', 'CONFIRMED', 'COMPLETED', 'CANCELLED'];
  const normalizeTplDays = (raw: any): string[] => {
    if (!Array.isArray(raw)) return ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
    const cleaned = raw.map((d) => String(d).trim().toUpperCase()).filter((d) => VALID_WEEKDAYS.includes(d));
    return Array.from(new Set(cleaned)).slice(0, 7);
  };
  const normalizeTplTime = (raw: any, fallback: string) => {
    const val = String(raw || '').trim();
    return /^\d{2}:\d{2}$/.test(val) ? val : fallback;
  };

  if (pathname === '/hr/shift-templates' && method === 'POST') {
    assertPerm(user, PERMISSIONS.HR_MANAGE);
    const {
      code,
      name,
      startTime,
      endTime,
      breakMinutes = 60,
      daysOfWeek,
      locationIds = [],
      defaultRole = null,
      headcountNeeded = 2,
      notes = null,
      isActive = true,
    } = body || {};

    const cleanName = String(name || '').trim().slice(0, 120);
    const cleanCode = String(code || '').trim().toUpperCase().slice(0, 32);
    if (!cleanName) throw new Error('Shift template name is required');
    if (!cleanCode) throw new Error('Shift template code is required');
    if (snap.shiftTemplates.some((t) => String(t.code).toLowerCase() === cleanCode.toLowerCase())) {
      throw new Error(`Shift template code "${cleanCode}" already exists`);
    }

    const cleanStart = normalizeTplTime(startTime, '07:00');
    const cleanEnd = normalizeTplTime(endTime, '15:00');
    const cleanBreak = Math.max(0, Math.min(480, Math.round(Number(breakMinutes ?? 60))));
    const cleanHeadcount = Math.max(1, Math.min(100, Math.round(Number(headcountNeeded ?? 2))));
    const cleanDays = normalizeTplDays(daysOfWeek);
    const cleanLocs = Array.isArray(locationIds)
      ? Array.from(new Set(locationIds.map((l) => String(l).trim()).filter(Boolean)))
          .slice(0, 25)
          .map((l) => toDocId(l, uid))
      : [];
    const cleanRole = defaultRole ? String(defaultRole).trim().slice(0, 120) : null;
    const cleanNotes = notes ? String(notes).trim().slice(0, 400) : null;

    const logicalId = crypto.randomUUID();
    const docId = toDocId(logicalId, uid);
    try {
      await setDoc(doc(db, 'shift_templates', docId), {
        id: docId,
        ownerUid: uid,
        code: cleanCode,
        name: cleanName,
        startTime: cleanStart,
        endTime: cleanEnd,
        breakMinutes: cleanBreak,
        daysOfWeek: cleanDays,
        locationIds: cleanLocs,
        defaultRole: cleanRole,
        headcountNeeded: cleanHeadcount,
        notes: cleanNotes,
        isActive: isActive !== false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `shift_templates/${docId}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'CREATE_SHIFT_TEMPLATE', 'ShiftTemplate', logicalId, {
      code: cleanCode,
      name: cleanName,
      locationsCount: cleanLocs.length,
    });
    invalidateWorkspaceCache();
    return { id: logicalId } as T;
  }

  if (pathname.startsWith('/hr/shift-templates/') && method === 'PUT') {
    assertPerm(user, PERMISSIONS.HR_MANAGE);
    const tplId = pathname.split('/')[3];
    const docId = toDocId(tplId, uid);
    const existing = snap.shiftTemplates.find((t) => t.id === docId);
    if (!existing) throw new Error('Shift template not found');

    const {
      code,
      name,
      startTime,
      endTime,
      breakMinutes,
      daysOfWeek,
      locationIds,
      defaultRole,
      headcountNeeded,
      notes,
      isActive,
    } = body || {};

    const cleanName = String(name ?? existing.name).trim().slice(0, 120);
    const cleanCode = String(code ?? existing.code).trim().toUpperCase().slice(0, 32);
    if (!cleanName) throw new Error('Shift template name is required');
    if (!cleanCode) throw new Error('Shift template code is required');
    if (snap.shiftTemplates.some((t) => String(t.code).toLowerCase() === cleanCode.toLowerCase() && t.id !== docId)) {
      throw new Error(`Shift template code "${cleanCode}" is already used by another template`);
    }

    const cleanStart = startTime !== undefined ? normalizeTplTime(startTime, existing.startTime) : existing.startTime;
    const cleanEnd = endTime !== undefined ? normalizeTplTime(endTime, existing.endTime) : existing.endTime;
    const cleanBreak = breakMinutes !== undefined
      ? Math.max(0, Math.min(480, Math.round(Number(breakMinutes))))
      : Number(existing.breakMinutes ?? 60);
    const cleanHeadcount = headcountNeeded !== undefined
      ? Math.max(1, Math.min(100, Math.round(Number(headcountNeeded))))
      : Number(existing.headcountNeeded ?? 2);
    const cleanDays = daysOfWeek !== undefined ? normalizeTplDays(daysOfWeek) : (existing.daysOfWeek || []);
    const cleanLocs = locationIds !== undefined
      ? (Array.isArray(locationIds)
          ? Array.from(new Set(locationIds.map((l) => String(l).trim()).filter(Boolean)))
              .slice(0, 25)
              .map((l) => toDocId(l, uid))
          : [])
      : (existing.locationIds || []);
    const cleanRole = defaultRole !== undefined ? (defaultRole ? String(defaultRole).trim().slice(0, 120) : null) : (existing.defaultRole ?? null);
    const cleanNotes = notes !== undefined ? (notes ? String(notes).trim().slice(0, 400) : null) : (existing.notes ?? null);
    const nextActive = isActive === undefined ? Boolean(existing.isActive) : Boolean(isActive);

    try {
      await updateDoc(doc(db, 'shift_templates', docId), {
        code: cleanCode,
        name: cleanName,
        startTime: cleanStart,
        endTime: cleanEnd,
        breakMinutes: cleanBreak,
        daysOfWeek: cleanDays,
        locationIds: cleanLocs,
        defaultRole: cleanRole,
        headcountNeeded: cleanHeadcount,
        notes: cleanNotes,
        isActive: nextActive,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `shift_templates/${docId}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'UPDATE_SHIFT_TEMPLATE', 'ShiftTemplate', tplId, {
      code: cleanCode,
      name: cleanName,
      isActive: nextActive,
    });
    invalidateWorkspaceCache();
    return { ok: true } as T;
  }

  if (pathname.startsWith('/hr/shift-templates/') && method === 'DELETE') {
    assertPerm(user, PERMISSIONS.HR_MANAGE);
    const tplId = pathname.split('/')[3];
    const docId = toDocId(tplId, uid);
    const existing = snap.shiftTemplates.find((t) => t.id === docId);
    if (!existing) throw new Error('Shift template not found');
    try {
      await deleteDoc(doc(db, 'shift_templates', docId));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `shift_templates/${docId}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'DELETE_SHIFT_TEMPLATE', 'ShiftTemplate', tplId, {
      code: existing.code,
      name: existing.name,
    });
    invalidateWorkspaceCache();
    return { ok: true } as T;
  }

  const toLogicalShiftWindows = (snapRef: WorkspaceSnapshot, ownerUid: string): ShiftWindowLike[] => {
    const locMap = new Map(snapRef.locations.map((l) => [l.id, l]));
    const empMap = new Map(snapRef.employees.map((e) => [e.id, e]));
    return snapRef.shiftSchedules
      .filter((s) => s.status !== 'CANCELLED')
      .map((s) => {
        const loc = locMap.get(s.locationId);
        const emp = s.employeeId ? empMap.get(s.employeeId) : null;
        return {
          id: toLogicalId(s.id, ownerUid),
          templateId: s.templateId ? toLogicalId(s.templateId, ownerUid) : null,
          templateName: s.templateName,
          locationId: toLogicalId(s.locationId, ownerUid),
          locationName: loc?.name || toLogicalId(s.locationId, ownerUid),
          employeeId: s.employeeId ? toLogicalId(s.employeeId, ownerUid) : null,
          employeeName: emp?.fullName || null,
          employeeCode: emp?.employeeCode || null,
          shiftDate: s.shiftDate,
          startTime: s.startTime,
          endTime: s.endTime,
          status: s.status,
        };
      });
  };

  if (pathname === '/hr/shift-schedules' && method === 'POST') {
    assertPerm(user, PERMISSIONS.HR_MANAGE);
    const {
      templateId = null,
      templateName,
      locationId,
      employeeId = null,
      shiftDate,
      startTime,
      endTime,
      breakMinutes = 60,
      status = 'SCHEDULED',
      notes = null,
      conflictPolicy = 'PROMPT',
    } = body || {};

    const locDocId = toDocId(String(locationId || '').trim(), uid);
    const loc = snap.locations.find((l) => l.id === locDocId);
    if (!loc) throw new Error('Valid location is required');

    const dateStr = String(shiftDate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new Error('Valid shiftDate (YYYY-MM-DD) is required');

    const tplDocId = templateId ? toDocId(String(templateId).trim(), uid) : null;
    const tpl = tplDocId ? snap.shiftTemplates.find((t) => t.id === tplDocId) : null;
    const cleanTplName = String(templateName || tpl?.name || 'Custom Shift').trim().slice(0, 120);
    const cleanStart = normalizeTplTime(startTime || tpl?.startTime, '07:00');
    const cleanEnd = normalizeTplTime(endTime || tpl?.endTime, '15:00');
    const cleanBreak = Math.max(0, Math.min(480, Math.round(Number(breakMinutes ?? tpl?.breakMinutes ?? 60))));
    const cleanStatus = VALID_SHIFT_STATUSES.includes(String(status).toUpperCase())
      ? String(status).toUpperCase()
      : 'SCHEDULED';

    const cleanEmpDocId = employeeId ? toDocId(String(employeeId).trim(), uid) : null;
    const emp = cleanEmpDocId ? snap.employees.find((e) => e.id === cleanEmpDocId) : null;
    if (cleanEmpDocId && !emp) throw new Error('Selected employee not found');

    const logicalId = crypto.randomUUID();
    const docId = toDocId(logicalId, uid);
    const logicalLocId = toLogicalId(loc.id, uid);
    const logicalEmpId = emp ? toLogicalId(emp.id, uid) : null;

    const candidate: ShiftWindowLike = {
      id: logicalId,
      templateId: tpl ? toLogicalId(tpl.id, uid) : null,
      templateName: cleanTplName,
      locationId: logicalLocId,
      locationName: loc.name,
      employeeId: logicalEmpId,
      employeeName: emp?.fullName || null,
      employeeCode: emp?.employeeCode || null,
      shiftDate: dateStr,
      startTime: cleanStart,
      endTime: cleanEnd,
      status: cleanStatus,
    };

    const existingLogical = toLogicalShiftWindows(snap, uid);
    const conflicts = findScheduleCandidateConflicts([candidate], existingLogical);
    const policy = String(conflictPolicy || 'PROMPT').toUpperCase();

    if (conflicts.length > 0 && policy === 'PROMPT') {
      return {
        saved: false,
        requiresConfirmation: true,
        createdCount: 0,
        conflicts,
      } as T;
    }

    const cleanNotes = notes ? String(notes).trim().slice(0, 400) : null;
    try {
      await setDoc(doc(db, 'shift_schedules', docId), {
        id: docId,
        ownerUid: uid,
        templateId: tpl?.id || null,
        templateName: cleanTplName,
        locationId: loc.id,
        employeeId: emp?.id || null,
        shiftDate: dateStr,
        startTime: cleanStart,
        endTime: cleanEnd,
        breakMinutes: cleanBreak,
        status: cleanStatus,
        notes: cleanNotes,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `shift_schedules/${docId}`);
    }

    if (conflicts.length > 0) {
      const c = conflicts[0];
      await addNotificationIfMissing(
        snap,
        'SHIFT_CONFLICT',
        'WARNING',
        `Overlapping Shift Conflict: ${c.employeeName}`,
        `${c.newTemplateName} (${c.newTimeRange} at ${c.newLocationName}) on ${c.shiftDate} overlaps ${c.existingTemplateName} (${c.existingTimeRange} at ${c.existingLocationName}) by ${formatOverlapDuration(c.overlapMinutes)}.`,
        loc.id,
      );
    }

    await addAuditLog(uid, user.id, user.fullName, 'CREATE_SHIFT_SCHEDULE', 'ShiftSchedule', logicalId, {
      templateName: cleanTplName,
      locationId: logicalLocId,
      employeeId: logicalEmpId,
      shiftDate: dateStr,
      conflictCount: conflicts.length,
    });
    invalidateWorkspaceCache();
    return {
      saved: true,
      requiresConfirmation: false,
      id: logicalId,
      createdCount: 1,
      conflicts,
      createdIds: [logicalId],
    } as T;
  }

  if (pathname === '/hr/shift-schedules/generate' && method === 'POST') {
    assertPerm(user, PERMISSIONS.HR_MANAGE);
    const {
      templateId,
      locationIds,
      startDate,
      endDate,
      daysOfWeek,
      assignmentMode = 'OPEN_SLOTS',
      employeeIds = [],
      headcountPerLocation,
      notes = null,
      conflictPolicy = 'PROMPT',
    } = body || {};

    const tplDocId = toDocId(String(templateId || ''), uid);
    const tpl = snap.shiftTemplates.find((t) => t.id === tplDocId);
    if (!tpl) throw new Error('Shift template not found');

    const startStr = String(startDate || '').slice(0, 10);
    const endStr = String(endDate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startStr) || !/^\d{4}-\d{2}-\d{2}$/.test(endStr)) {
      throw new Error('Valid startDate and endDate (YYYY-MM-DD) are required');
    }
    if (startStr > endStr) throw new Error('Start date must be on or before end date');

    const parseUtc = (isoDate: string) => {
      const [y, m, d] = isoDate.split('-').map(Number);
      return Date.UTC(y, m - 1, d);
    };
    const startMs = parseUtc(startStr);
    const endMs = parseUtc(endStr);
    const spanDays = Math.round((endMs - startMs) / 86400000) + 1;
    if (spanDays > 62) throw new Error('Schedule generation range cannot exceed 62 days at once');

    const tplDays = normalizeTplDays(daysOfWeek !== undefined ? daysOfWeek : (tpl.daysOfWeek || []));
    if (tplDays.length === 0) throw new Error('Select at least one recurring day of the week');

    const validLocIds = new Set(snap.locations.map((l) => String(l.id)));
    const locMap = new Map(snap.locations.map((l) => [l.id, l]));
    const requestedLocDocIds: string[] = Array.isArray(locationIds) && locationIds.length > 0
      ? locationIds.map((l: any) => toDocId(String(l).trim(), uid))
      : Array.isArray(tpl.locationIds) && tpl.locationIds.length > 0
        ? (tpl.locationIds as any[]).map((l) => String(l))
        : snap.locations.map((l) => String(l.id));
    const targetLocs: string[] = Array.from(new Set<string>(requestedLocDocIds)).filter((l) => validLocIds.has(l));
    if (targetLocs.length === 0) throw new Error('Select at least one valid location for schedule generation');

    const activeEmployees = snap.employees.filter((e) => e.isActive !== false);
    const empMap = new Map(activeEmployees.map((e) => [e.id, e]));
    const selectedEmpDocIds = Array.isArray(employeeIds)
      ? Array.from(new Set(employeeIds.map((e: any) => toDocId(String(e).trim(), uid)).filter(Boolean)))
      : [];
    const headcount = Math.max(1, Math.min(20, Math.round(Number(headcountPerLocation ?? tpl.headcountNeeded ?? 1))));
    const cleanNotes = notes ? String(notes).trim().slice(0, 400) : (tpl.notes || null);
    const policy = String(conflictPolicy || 'PROMPT').toUpperCase();

    const activeSchedules = snap.shiftSchedules.filter((s) => s.status !== 'CANCELLED');
    const existingLogical = toLogicalShiftWindows(snap, uid);
    const logicalTplId = toLogicalId(tplDocId, uid);

    const candidateEntries: Array<{ candidate: ShiftWindowLike; docObj: any }> = [];
    let skippedCount = 0;

    const pushCandidate = (locDocId: string, dateStr: string, empDocId: string | null) => {
      const logicalId = crypto.randomUUID();
      const docId = toDocId(logicalId, uid);
      const loc = locMap.get(locDocId);
      const emp = empDocId ? empMap.get(empDocId) : null;
      const candidate: ShiftWindowLike = {
        id: logicalId,
        templateId: logicalTplId,
        templateName: tpl.name,
        locationId: toLogicalId(locDocId, uid),
        locationName: loc?.name || toLogicalId(locDocId, uid),
        employeeId: emp ? toLogicalId(emp.id, uid) : null,
        employeeName: emp?.fullName || null,
        employeeCode: emp?.employeeCode || null,
        shiftDate: dateStr,
        startTime: tpl.startTime,
        endTime: tpl.endTime,
        status: 'SCHEDULED',
      };
      const docObj = {
        id: docId,
        ownerUid: uid,
        templateId: tplDocId,
        templateName: tpl.name,
        locationId: locDocId,
        employeeId: empDocId,
        shiftDate: dateStr,
        startTime: tpl.startTime,
        endTime: tpl.endTime,
        breakMinutes: Number(tpl.breakMinutes ?? 60),
        status: 'SCHEDULED',
        notes: cleanNotes,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      candidateEntries.push({ candidate, docObj });
    };

    for (let t = startMs; t <= endMs; t += 86400000) {
      const dt = new Date(t);
      const dayCode = VALID_WEEKDAYS[dt.getUTCDay()];
      if (!tplDays.includes(dayCode)) continue;
      const dateStr = dt.toISOString().slice(0, 10);

      for (const locDocId of targetLocs) {
        const existingForSlot = activeSchedules.filter(
          (s) => s.templateId === tplDocId && s.locationId === locDocId && s.shiftDate === dateStr,
        );

        if (assignmentMode === 'SELECTED_EMPLOYEES' && selectedEmpDocIds.length > 0) {
          for (const empDocId of selectedEmpDocIds) {
            if (existingForSlot.some((s) => s.employeeId === empDocId)) {
              skippedCount++;
              continue;
            }
            pushCandidate(locDocId, dateStr, empDocId);
          }
        } else if (assignmentMode === 'AUTO_BY_LOCATION') {
          const locEmps = activeEmployees.filter((e) => e.locationId === locDocId).slice(0, headcount);
          let addedHere = 0;
          for (const emp of locEmps) {
            if (existingForSlot.some((s) => s.employeeId === emp.id)) {
              skippedCount++;
              continue;
            }
            pushCandidate(locDocId, dateStr, emp.id);
            addedHere++;
          }
          const totalAfter = existingForSlot.length + addedHere;
          const remainingOpen = Math.max(0, headcount - totalAfter);
          for (let k = 0; k < remainingOpen; k++) {
            pushCandidate(locDocId, dateStr, null);
          }
        } else {
          const toCreate = Math.max(0, headcount - existingForSlot.length);
          if (toCreate === 0) {
            skippedCount++;
            continue;
          }
          for (let k = 0; k < toCreate; k++) {
            pushCandidate(locDocId, dateStr, null);
          }
        }
      }
    }

    const detectedConflicts = findScheduleCandidateConflicts(
      candidateEntries.map((e) => e.candidate),
      existingLogical,
    );

    if (detectedConflicts.length > 0 && policy === 'PROMPT') {
      return {
        saved: false,
        requiresConfirmation: true,
        createdCount: 0,
        skippedCount,
        conflicts: detectedConflicts,
        createdIds: [],
      } as T;
    }

    const conflictingCandidateIds = new Set(detectedConflicts.map((c) => c.newScheduleId));
    const entriesToCreate =
      policy === 'SKIP_CONFLICTS'
        ? candidateEntries.filter((e) => !conflictingCandidateIds.has(e.candidate.id))
        : candidateEntries;
    const finalSkippedCount =
      skippedCount + (policy === 'SKIP_CONFLICTS' ? candidateEntries.length - entriesToCreate.length : 0);
    const savedConflicts = policy === 'SKIP_CONFLICTS' ? [] : detectedConflicts;

    for (let i = 0; i < entriesToCreate.length; i += 400) {
      const chunk = entriesToCreate.slice(i, i + 400);
      const b = writeBatch(db);
      for (const item of chunk) {
        b.set(doc(db, 'shift_schedules', item.docObj.id), item.docObj);
      }
      try {
        await b.commit();
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, 'shift_schedules_generate');
      }
    }

    if (savedConflicts.length > 0) {
      await addNotificationIfMissing(
        snap,
        'SHIFT_CONFLICT',
        'WARNING',
        `${savedConflicts.length} Overlapping Shift Conflict(s) Saved`,
        `Schedule generation for ${tpl.name} (${startStr} to ${endStr}) contains ${savedConflicts.length} overlapping crew shift(s). Review the HR Shift Roster to reassign.`,
      );
    }

    await addAuditLog(uid, user.id, user.fullName, 'GENERATE_SHIFT_SCHEDULES', 'ShiftTemplate', logicalTplId, {
      templateName: tpl.name,
      startDate: startStr,
      endDate: endStr,
      locationsCount: targetLocs.length,
      createdCount: entriesToCreate.length,
      skippedCount: finalSkippedCount,
      conflictCount: savedConflicts.length,
      conflictPolicy: policy,
    });
    invalidateWorkspaceCache();
    return {
      saved: true,
      requiresConfirmation: false,
      createdCount: entriesToCreate.length,
      skippedCount: finalSkippedCount,
      conflicts: savedConflicts,
      createdIds: entriesToCreate.map((e) => e.candidate.id),
    } as T;
  }

  if (pathname.startsWith('/hr/shift-schedules/') && method === 'PATCH') {
    assertPerm(user, PERMISSIONS.HR_MANAGE);
    const schedId = pathname.split('/')[3];
    const docId = toDocId(schedId, uid);
    const existing = snap.shiftSchedules.find((s) => s.id === docId);
    if (!existing) throw new Error('Shift schedule entry not found');

    const { locationId, employeeId, shiftDate, startTime, endTime, breakMinutes, status, notes } = body || {};
    const nextStatus = status !== undefined ? String(status).trim().toUpperCase() : existing.status;
    if (!VALID_SHIFT_STATUSES.includes(nextStatus)) throw new Error('Invalid shift status');

    const nextLoc = locationId !== undefined ? toDocId(String(locationId).trim(), uid) : existing.locationId;
    const nextEmp = employeeId !== undefined ? (employeeId ? toDocId(String(employeeId).trim(), uid) : null) : (existing.employeeId ?? null);
    const nextDate = shiftDate !== undefined ? String(shiftDate).slice(0, 10) : existing.shiftDate;
    const nextStart = startTime !== undefined ? normalizeTplTime(startTime, existing.startTime) : existing.startTime;
    const nextEnd = endTime !== undefined ? normalizeTplTime(endTime, existing.endTime) : existing.endTime;
    const nextBreak = breakMinutes !== undefined
      ? Math.max(0, Math.min(480, Math.round(Number(breakMinutes))))
      : Number(existing.breakMinutes ?? 60);
    const nextNotes = notes !== undefined ? (notes ? String(notes).trim().slice(0, 400) : null) : (existing.notes ?? null);

    try {
      await updateDoc(doc(db, 'shift_schedules', docId), {
        locationId: nextLoc,
        employeeId: nextEmp,
        shiftDate: nextDate,
        startTime: nextStart,
        endTime: nextEnd,
        breakMinutes: nextBreak,
        status: nextStatus,
        notes: nextNotes,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `shift_schedules/${docId}`);
    }

    const locRow = snap.locations.find((l) => l.id === nextLoc);
    const empRow = nextEmp ? snap.employees.find((e) => e.id === nextEmp) : null;
    const updatedLogical: ShiftWindowLike = {
      id: schedId,
      templateId: existing.templateId ? toLogicalId(existing.templateId, uid) : null,
      templateName: existing.templateName,
      locationId: toLogicalId(nextLoc, uid),
      locationName: locRow?.name || toLogicalId(nextLoc, uid),
      employeeId: nextEmp ? toLogicalId(nextEmp, uid) : null,
      employeeName: empRow?.fullName || null,
      employeeCode: empRow?.employeeCode || null,
      shiftDate: nextDate,
      startTime: nextStart,
      endTime: nextEnd,
      status: nextStatus,
    };
    const otherLogical = toLogicalShiftWindows(snap, uid).filter((w) => w.id !== schedId);
    const conflicts = findScheduleCandidateConflicts([updatedLogical], otherLogical);

    if (conflicts.length > 0) {
      const c = conflicts[0];
      await addNotificationIfMissing(
        snap,
        'SHIFT_CONFLICT',
        'WARNING',
        `Overlapping Shift Conflict: ${c.employeeName}`,
        `${c.newTemplateName} (${c.newTimeRange} at ${c.newLocationName}) on ${c.shiftDate} overlaps ${c.existingTemplateName} (${c.existingTimeRange} at ${c.existingLocationName}) by ${formatOverlapDuration(c.overlapMinutes)}.`,
        nextLoc,
      );
    }

    await addAuditLog(uid, user.id, user.fullName, 'UPDATE_SHIFT_SCHEDULE', 'ShiftSchedule', schedId, {
      status: nextStatus,
      employeeId: nextEmp ? toLogicalId(nextEmp, uid) : null,
      locationId: toLogicalId(nextLoc, uid),
      conflictCount: conflicts.length,
    });
    invalidateWorkspaceCache();
    return { ok: true, conflicts } as T;
  }

  if (pathname.startsWith('/hr/shift-schedules/') && method === 'DELETE') {
    assertPerm(user, PERMISSIONS.HR_MANAGE);
    const schedId = pathname.split('/')[3];
    const docId = toDocId(schedId, uid);
    const existing = snap.shiftSchedules.find((s) => s.id === docId);
    if (!existing) throw new Error('Shift schedule entry not found');
    try {
      await deleteDoc(doc(db, 'shift_schedules', docId));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `shift_schedules/${docId}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'DELETE_SHIFT_SCHEDULE', 'ShiftSchedule', schedId, {
      templateName: existing.templateName,
      shiftDate: existing.shiftDate,
    });
    invalidateWorkspaceCache();
    return { ok: true } as T;
  }

  // 10. CRM, REPORTS & GOVERNANCE
  if (pathname === '/crm/customers' && method === 'GET') {
    assertPerm(user, PERMISSIONS.CRM_MANAGE);
    const rawLoc = (qs.get('locationId') || '').trim();
    const locFilter = rawLoc && rawLoc !== 'ALL' ? toDocId(rawLoc, uid) : '';
    const locMap = new Map(snap.locations.map((l) => [l.id, l]));
    const rows = snap.customers
      .filter((c) => !locFilter || c.locationId === locFilter)
      .map((c) => {
        const custSales = snap.sales.filter((s) => s.customerId === c.id && s.status === 'COMPLETED');
        const lifetimeSpend = round2(custSales.reduce((sum, s) => sum + Number(s.totalAmount || 0), 0));
        const regRaw = String(c.registeredAt || tsToIso(c.createdAt) || '').slice(0, 10);
        return {
          id: toLogicalId(c.id, uid),
          full_name: c.fullName,
          phone: c.phone,
          email: c.email,
          loyalty_points: c.loyaltyPoints,
          tier: c.tier,
          preferences: c.preferences,
          registered_at: regRaw,
          location_id: c.locationId ? toLogicalId(c.locationId, uid) : null,
          location_name: c.locationId ? locMap.get(c.locationId)?.name || '' : '',
          total_orders: custSales.length,
          lifetime_spend: lifetimeSpend,
        };
      })
      .sort((a, b) => b.lifetime_spend - a.lifetime_spend);
    return rows as T;
  }

  if (pathname === '/crm/customers' && method === 'POST') {
    assertPerm(user, PERMISSIONS.CRM_MANAGE);
    const { fullName, phone, email, preferences, registeredAt, locationId } = body || {};
    const cleanName = String(fullName || '').trim();
    if (!cleanName) throw new Error('Customer full name is required');

    const cleanRegisteredAt = String(registeredAt || '').trim().slice(0, 40) || new Date().toISOString().slice(0, 10);
    const cleanLocId = locationId && String(locationId).trim() && String(locationId).trim() !== 'ALL'
      ? toDocId(String(locationId).trim(), uid)
      : null;

    const logicalId = crypto.randomUUID();
    const docId = toDocId(logicalId, uid);
    try {
      await setDoc(doc(db, 'customers', docId), {
        id: docId,
        ownerUid: uid,
        fullName: cleanName,
        phone: phone ? String(phone).trim().slice(0, 40) : null,
        email: email ? String(email).trim().slice(0, 160) : null,
        loyaltyPoints: 0,
        tier: 'STANDARD',
        preferences: preferences ? String(preferences).trim().slice(0, 300) : '',
        feedbackNotes: null,
        registeredAt: cleanRegisteredAt,
        locationId: cleanLocId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `customers/${docId}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'CREATE_CUSTOMER', 'Customer', logicalId, {
      fullName: cleanName,
      registeredAt: cleanRegisteredAt,
      locationId: cleanLocId ? toLogicalId(cleanLocId, uid) : null,
    });
    invalidateWorkspaceCache();
    return {
      id: logicalId,
      registered_at: cleanRegisteredAt,
      location_id: cleanLocId ? toLogicalId(cleanLocId, uid) : null,
    } as T;
  }

  // 10.1 CUSTOMER LOYALTY KIOSK & TRANSACTION LINKING
  if (pathname === '/crm/kiosk/lookup' && method === 'GET') {
    const rawPhone = (qs.get('phone') || '').trim();
    const normPhone = normalizePhoneNumber(rawPhone);
    const rawLoc = (qs.get('locationId') || '').trim();
    const locDoc = rawLoc && rawLoc !== 'ALL' ? toDocId(rawLoc, uid) : '';
    const locMap = new Map(snap.locations.map((l) => [l.id, l]));
    const prodMap = new Map(snap.products.map((p) => [p.id, p]));

    if (!normPhone) {
      return { found: false, error: 'Please enter a valid phone number', potentialUnlinkedCount: 0 } as T;
    }

    const cust = snap.customers.find((c) => normalizePhoneNumber(c.phone || '') === normPhone);
    if (!cust) {
      const potentialUnlinkedCount = snap.sales.filter(
        (s) => s.status === 'COMPLETED' && !s.customerId && (!locDoc || s.locationId === locDoc),
      ).length;
      return { found: false, phone: normPhone, potentialUnlinkedCount } as T;
    }

    const custSales = snap.sales.filter(
      (s) => s.status === 'COMPLETED' && (s.customerId === cust.id || (s.notes && s.notes.includes(normPhone))),
    );

    const transactions = custSales
      .map((s) => {
        const items = (s.items || []).map((it: any) => ({
          name: it.productName || prodMap.get(it.productId)?.name || 'BBQ Item',
          quantity: Number(it.quantity || 0),
          unitPrice: Number(it.unitPrice || 0),
          lineTotal: Number(it.lineTotal || 0),
        }));
        const itemsSummary = items.map((i: any) => `${i.quantity}x ${i.name}`).join(', ');
        const totalAmount = Number(s.totalAmount || 0);
        const pointsEarned = Math.floor(totalAmount / SPEND_PER_POINT_PHP);
        return {
          id: toLogicalId(s.id, uid),
          receiptNumber: s.receiptNumber,
          soldAt: String(s.soldAt || tsToIso(s.createdAt)),
          locationId: s.locationId ? toLogicalId(s.locationId, uid) : '',
          locationName: s.locationId ? locMap.get(s.locationId)?.name || 'Food Truck' : 'Food Truck',
          totalAmount: round2(totalAmount),
          pointsEarned,
          itemsCount: items.reduce((sum: number, i: any) => sum + i.quantity, 0),
          itemsSummary,
          items,
          paymentMethod: s.payments?.[0]?.method || 'CASH',
          isLinkedToCustomer: s.customerId === cust.id,
          notes: s.notes || null,
        };
      })
      .sort((a: any, b: any) => b.soldAt.localeCompare(a.soldAt));

    const lifetimeSpend = round2(custSales.reduce((sum, s) => sum + Number(s.totalAmount || 0), 0));
    const tier = calculateLoyaltyTier(Number(cust.loyaltyPoints || 0));

    return {
      found: true,
      customer: {
        id: toLogicalId(cust.id, uid),
        fullName: cust.fullName,
        phone: cust.phone || normPhone,
        email: cust.email || null,
        loyaltyPoints: Number(cust.loyaltyPoints || 0),
        tier,
        preferences: cust.preferences || null,
        feedbackNotes: cust.feedbackNotes || null,
        registeredAt: cust.registeredAt || tsToIso(cust.createdAt),
        locationId: cust.locationId ? toLogicalId(cust.locationId, uid) : null,
        locationName: cust.locationId ? locMap.get(cust.locationId)?.name || '' : '',
        totalOrders: custSales.length,
        lifetimeSpend,
      },
      transactions,
      potentialUnlinkedCount: 0,
    } as T;
  }

  if (pathname === '/crm/kiosk/join' && method === 'POST') {
    const { fullName, phone, email, preferences, locationId, autoLinkRecentSales } = body || {};
    const cleanName = String(fullName || '').trim();
    if (!cleanName) throw new Error('Customer full name is required to join');

    const normPhone = normalizePhoneNumber(String(phone || ''));
    if (!normPhone || normPhone.length !== 11) {
      throw new Error('Valid 11-digit Philippine mobile phone number (09XXXXXXXXX) is required');
    }

    const cleanLocId = locationId && String(locationId).trim() && String(locationId).trim() !== 'ALL'
      ? toDocId(String(locationId).trim(), uid)
      : null;

    const locMap = new Map(snap.locations.map((l) => [l.id, l]));
    const prodMap = new Map(snap.products.map((p) => [p.id, p]));
    const existing = snap.customers.find((c) => normalizePhoneNumber(c.phone || '') === normPhone);

    const batch = writeBatch(db);
    let custDocId: string;
    let logicalCustId: string;
    let welcomeBonusPoints = 0;
    let currentPoints = 0;
    let assignedTier: any = 'STANDARD';

    if (existing) {
      custDocId = existing.id;
      logicalCustId = toLogicalId(existing.id, uid);
      currentPoints = Number(existing.loyaltyPoints || 0);
      assignedTier = calculateLoyaltyTier(currentPoints);
      batch.update(doc(db, 'customers', custDocId), {
        fullName: cleanName || existing.fullName,
        phone: normPhone,
        email: email ? String(email).trim().slice(0, 160) : existing.email,
        preferences: preferences ? String(preferences).trim().slice(0, 300) : existing.preferences,
        locationId: cleanLocId || existing.locationId,
        updatedAt: serverTimestamp(),
      });
    } else {
      logicalCustId = crypto.randomUUID();
      custDocId = toDocId(logicalCustId, uid);
      welcomeBonusPoints = WELCOME_POINTS_BONUS;
      currentPoints = welcomeBonusPoints;
      assignedTier = calculateLoyaltyTier(currentPoints);
      const regDate = new Date().toISOString().slice(0, 10);

      batch.set(doc(db, 'customers', custDocId), {
        id: custDocId,
        ownerUid: uid,
        fullName: cleanName,
        phone: normPhone,
        email: email ? String(email).trim().slice(0, 160) : null,
        loyaltyPoints: welcomeBonusPoints,
        tier: assignedTier,
        preferences: preferences ? String(preferences).trim().slice(0, 300) : '',
        feedbackNotes: null,
        registeredAt: regDate,
        locationId: cleanLocId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    // Auto-link recent unlinked sales matching phone or location if requested
    let linkedSalesCount = 0;
    let extraPointsAwarded = 0;
    if (autoLinkRecentSales) {
      const candidates = snap.sales.filter((s) => {
        if (s.status !== 'COMPLETED' || s.customerId) return false;
        const matchesLoc = cleanLocId ? s.locationId === cleanLocId : true;
        const matchesNotePhone = s.notes && normalizePhoneNumber(s.notes).includes(normPhone);
        return matchesNotePhone || matchesLoc;
      }).slice(0, 5);

      for (const sale of candidates) {
        const pts = Math.floor(Number(sale.totalAmount || 0) / SPEND_PER_POINT_PHP);
        batch.update(doc(db, 'sales', sale.id), {
          customerId: custDocId,
          updatedAt: serverTimestamp(),
        });
        linkedSalesCount += 1;
        extraPointsAwarded += pts;
      }

      if (extraPointsAwarded > 0) {
        currentPoints += extraPointsAwarded;
        assignedTier = calculateLoyaltyTier(currentPoints);
        batch.update(doc(db, 'customers', custDocId), {
          loyaltyPoints: currentPoints,
          tier: assignedTier,
          updatedAt: serverTimestamp(),
        });
      }
    }

    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `customers/${custDocId}`);
    }

    await addAuditLog(
      uid,
      user?.id || 'kiosk',
      user?.fullName || 'Customer Loyalty Kiosk',
      existing ? 'UPDATE_CUSTOMER_KIOSK' : 'JOIN_LOYALTY_KIOSK',
      'Customer',
      logicalCustId,
      {
        fullName: cleanName,
        phone: normPhone,
        welcomeBonusPoints,
        linkedSalesCount,
        totalPoints: currentPoints,
      },
    );

    invalidateWorkspaceCache();

    // Query refreshed linked sales
    const linkedSales = snap.sales
      .filter((s) => s.status === 'COMPLETED' && (s.customerId === custDocId || (s.notes && s.notes.includes(normPhone))))
      .map((s) => {
        const items = (s.items || []).map((it: any) => ({
          name: it.productName || prodMap.get(it.productId)?.name || 'BBQ Item',
          quantity: Number(it.quantity || 0),
          unitPrice: Number(it.unitPrice || 0),
          lineTotal: Number(it.lineTotal || 0),
        }));
        return {
          id: toLogicalId(s.id, uid),
          receiptNumber: s.receiptNumber,
          soldAt: String(s.soldAt || tsToIso(s.createdAt)),
          locationId: s.locationId ? toLogicalId(s.locationId, uid) : '',
          locationName: s.locationId ? locMap.get(s.locationId)?.name || 'Food Truck' : 'Food Truck',
          totalAmount: round2(Number(s.totalAmount || 0)),
          pointsEarned: Math.floor(Number(s.totalAmount || 0) / SPEND_PER_POINT_PHP),
          itemsCount: items.reduce((sum: number, i: any) => sum + i.quantity, 0),
          itemsSummary: items.map((i: any) => `${i.quantity}x ${i.name}`).join(', '),
          items,
          paymentMethod: s.payments?.[0]?.method || 'CASH',
          isLinkedToCustomer: true,
          notes: s.notes || null,
        };
      })
      .sort((a: any, b: any) => b.soldAt.localeCompare(a.soldAt));

    return {
      ok: true,
      isNew: !existing,
      welcomeBonusPoints,
      linkedSalesCount,
      customer: {
        id: logicalCustId,
        fullName: cleanName,
        phone: normPhone,
        email: email || null,
        loyaltyPoints: currentPoints,
        tier: assignedTier,
        preferences: preferences || null,
        locationId: cleanLocId ? toLogicalId(cleanLocId, uid) : null,
        locationName: cleanLocId ? locMap.get(cleanLocId)?.name || '' : '',
        totalOrders: linkedSales.length,
        lifetimeSpend: round2(linkedSales.reduce((sum: number, s: any) => sum + Number(s.totalAmount || 0), 0)),
      },
      transactions: linkedSales,
    } as T;
  }

  if (pathname === '/crm/customers/link-sale' && method === 'POST') {
    assertPerm(user, PERMISSIONS.CRM_MANAGE);
    const { customerId, phone, saleId, receiptNumber } = body || {};

    let targetCust = customerId
      ? snap.customers.find((c) => c.id === toDocId(String(customerId).trim(), uid))
      : null;

    if (!targetCust && phone) {
      const norm = normalizePhoneNumber(String(phone).trim());
      targetCust = snap.customers.find((c) => normalizePhoneNumber(c.phone || '') === norm);
    }

    if (!targetCust) throw new Error('Customer profile not found for transaction linking');

    let targetSale = saleId
      ? snap.sales.find((s) => s.id === toDocId(String(saleId).trim(), uid))
      : null;

    if (!targetSale && receiptNumber) {
      const cleanRec = String(receiptNumber).trim().toUpperCase();
      targetSale = snap.sales.find((s) => String(s.receiptNumber || '').toUpperCase() === cleanRec);
    }

    if (!targetSale) throw new Error('Transaction / Receipt not found');

    if (targetSale.customerId === targetCust.id) {
      return {
        ok: true,
        alreadyLinked: true,
        message: 'Transaction is already linked to this customer',
        pointsAwarded: 0,
        newTotalPoints: targetCust.loyaltyPoints,
      } as T;
    }

    const pointsAwarded = Math.floor(Number(targetSale.totalAmount || 0) / SPEND_PER_POINT_PHP);
    const nextPoints = Number(targetCust.loyaltyPoints || 0) + pointsAwarded;
    const nextTier = calculateLoyaltyTier(nextPoints);

    const batch = writeBatch(db);
    batch.update(doc(db, 'sales', targetSale.id), {
      customerId: targetCust.id,
      updatedAt: serverTimestamp(),
    });

    batch.update(doc(db, 'customers', targetCust.id), {
      loyaltyPoints: nextPoints,
      tier: nextTier,
      updatedAt: serverTimestamp(),
    });

    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `sales/${targetSale.id}`);
    }

    await addAuditLog(uid, user.id, user.fullName, 'LINK_TRANSACTION_LOYALTY', 'Sale', targetSale.id, {
      customerId: targetCust.id,
      customerName: targetCust.fullName,
      receiptNumber: targetSale.receiptNumber,
      pointsAwarded,
      newTotalPoints: nextPoints,
    });

    invalidateWorkspaceCache();

    return {
      ok: true,
      saleId: toLogicalId(targetSale.id, uid),
      receiptNumber: targetSale.receiptNumber,
      pointsAwarded,
      newTotalPoints: nextPoints,
      newTier: nextTier,
    } as T;
  }

  if (pathname === '/crm/unlinked-sales' && method === 'GET') {
    assertPerm(user, PERMISSIONS.CRM_MANAGE);
    const rawLoc = (qs.get('locationId') || '').trim();
    const locDoc = rawLoc && rawLoc !== 'ALL' ? toDocId(rawLoc, uid) : '';
    const locMap = new Map(snap.locations.map((l) => [l.id, l]));

    const unlinked = snap.sales
      .filter((s) => s.status === 'COMPLETED' && !s.customerId && (!locDoc || s.locationId === locDoc))
      .slice(0, 30)
      .map((s) => ({
        id: toLogicalId(s.id, uid),
        receiptNumber: s.receiptNumber,
        soldAt: String(s.soldAt || tsToIso(s.createdAt)),
        locationName: s.locationId ? locMap.get(s.locationId)?.name || 'Food Truck' : 'Food Truck',
        totalAmount: round2(Number(s.totalAmount || 0)),
        pointsEligible: Math.floor(Number(s.totalAmount || 0) / SPEND_PER_POINT_PHP),
        itemsCount: (s.items || []).reduce((sum: number, it: any) => sum + Number(it.quantity || 0), 0),
        notes: s.notes || null,
      }))
      .sort((a, b) => b.soldAt.localeCompare(a.soldAt));

    return unlinked as T;
  }

  if (pathname.startsWith('/reports/') && method === 'GET') {
    assertPerm(user, PERMISSIONS.REPORTS_VIEW);
    const type = pathname.split('/')[2];
    const from = (qs.get('from') || '').trim().slice(0, 10);
    const to = (qs.get('to') || '').trim().slice(0, 10);
    const rawLoc = (qs.get('locationId') || '').trim();
    const locFilter = rawLoc && rawLoc !== 'ALL' ? toDocId(rawLoc, uid) : '';
    const inRange = (isoDate: string) => {
      const d = String(isoDate || '').slice(0, 10);
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    };
    const locMap = new Map(snap.locations.map((l) => [l.id, l]));
    const itemMap = new Map(snap.inventoryItems.map((i) => [i.id, i]));

    if (type === 'sales') {
      return snap.sales
        .filter((s) => (!locFilter || s.locationId === locFilter) && inRange(s.soldAt))
        .sort((a, b) => String(b.soldAt).localeCompare(String(a.soldAt)))
        .map((s) => ({
          receipt_number: s.receiptNumber,
          sold_at: String(s.soldAt).slice(0, 19),
          truck: locMap.get(s.locationId)?.name || '',
          channel: s.channel,
          status: s.status,
          subtotal: s.subtotal,
          tax_amount: s.taxAmount,
          total_amount: s.totalAmount,
          total_cogs: s.totalCogs,
          gross_profit: round2(Number(s.totalAmount) - Number(s.totalCogs)),
        })) as T;
    }
    if (type === 'inventory') {
      return snap.inventoryItems
        .map((i) => {
          const batches = snap.stockBatches.filter(
            (b) => b.inventoryItemId === i.id && (!locFilter || b.locationId === locFilter) && inRange(b.receivedAt),
          );
          if ((locFilter || from || to) && batches.length === 0) return null;
          return {
            sku: i.sku,
            name: i.name,
            location: locFilter ? locMap.get(locFilter)?.name || '' : 'All Branches',
            uom: i.uomCode,
            costing_method: i.costingMethod,
            reorder_point: i.reorderPoint,
            on_hand: round2(batches.reduce((s, b) => s + Number(b.remainingQty || 0), 0)),
            total_value: round2(batches.reduce((s, b) => s + Number(b.remainingQty || 0) * Number(b.unitCost || 0), 0)),
          };
        })
        .filter(Boolean) as T;
    }
    if (type === 'expenses') {
      return snap.expenses
        .filter((e) => (!locFilter || e.locationId === locFilter) && inRange(e.expenseDate))
        .sort((a, b) => String(b.expenseDate).localeCompare(String(a.expenseDate)))
        .map((e) => ({
          date: String(e.expenseDate).slice(0, 10),
          location: locMap.get(e.locationId)?.name || '',
          category: e.category,
          description: e.description,
          amount: e.amount,
        })) as T;
    }
    if (type === 'waste') {
      return snap.inventoryTxns
        .filter(
          (t) =>
            ['OUT_WASTE', 'OUT_SPOILAGE'].includes(t.txnType) &&
            (!locFilter || t.locationId === locFilter) &&
            inRange(t.txnDate || tsToIso(t.createdAt)),
        )
        .sort((a, b) => String(b.txnDate || tsToIso(b.createdAt)).localeCompare(String(a.txnDate || tsToIso(a.createdAt))))
        .map((t) => ({
          date: String(t.txnDate || tsToIso(t.createdAt)).slice(0, 19),
          location: locMap.get(t.locationId)?.name || '',
          ingredient: itemMap.get(t.inventoryItemId)?.name || '',
          qty: Math.abs(Number(t.quantityDelta || 0)),
          uom: itemMap.get(t.inventoryItemId)?.uomCode || '',
          cost_php: t.totalCost,
          reason: t.notes || '',
        })) as T;
    }
    return [] as T;
  }

  if (pathname === '/admin/governance' && method === 'GET') {
    assertPerm(user, PERMISSIONS.DASHBOARD_VIEW);
    const from = (qs.get('from') || '').trim().slice(0, 10);
    const to = (qs.get('to') || '').trim().slice(0, 10);
    const rawLoc = (qs.get('locationId') || '').trim();
    const locFilter = rawLoc && rawLoc !== 'ALL' ? toDocId(rawLoc, uid) : '';
    const inDateRange = (isoDate: string) => {
      const d = String(isoDate || '').slice(0, 10);
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    };

    const locMap = new Map(snap.locations.map((l) => [l.id, l]));
    const erpUserByDocId = new Map(snap.erpUsers.map((u) => [u.id, u]));

    const resolveAuditLocations = (l: any): string[] => {
      const entityDocId = toDocId(String(l.entityId || ''), uid);
      const entityType = String(l.entityType || '');
      if (entityType === 'Sale') {
        const sale = snap.sales.find((s) => s.id === entityDocId);
        if (sale?.locationId) return [sale.locationId];
      }
      if (entityType === 'Expense') {
        const exp = snap.expenses.find((e) => e.id === entityDocId);
        if (exp?.locationId) return [exp.locationId];
      }
      if (entityType === 'DailyClosing') {
        const dc = snap.dailyClosings.find((c) => c.id === entityDocId);
        if (dc?.locationId) return [dc.locationId];
      }
      if (entityType === 'PurchaseOrder') {
        const po = snap.purchaseOrders.find((p) => p.id === entityDocId);
        if (po?.locationId) return [po.locationId];
      }
      if (entityType === 'GoodsReceipt') {
        const grn = snap.goodsReceipts.find((g) => g.id === entityDocId);
        const po = grn ? snap.purchaseOrders.find((p) => p.id === grn.purchaseOrderId) : null;
        if (po?.locationId) return [po.locationId];
      }
      if (entityType === 'StockTransfer') {
        const trf = snap.stockTransfers.find((t) => t.id === entityDocId);
        const locs = [trf?.fromLocationId, trf?.toLocationId].filter(Boolean) as string[];
        if (locs.length > 0) return Array.from(new Set(locs));
      }
      if (entityType === 'Employee') {
        const emp = snap.employees.find((e) => e.id === entityDocId);
        if (emp?.locationId) return [emp.locationId];
      }
      if (entityType === 'User') {
        const targetUser = snap.erpUsers.find((u) => u.id === entityDocId);
        if (targetUser?.assignedLocationId) return [targetUser.assignedLocationId];
      }
      if (l.details) {
        const detailStr = String(l.details);
        const locMatch = detailStr.match(/locationId:\s*([a-zA-Z0-9_\-]+)/);
        if (locMatch?.[1]) return [toDocId(locMatch[1], uid)];
      }
      if (entityType === 'InventoryItem') {
        const logMinute = String(l.loggedAt || tsToIso(l.createdAt)).slice(0, 16);
        const txn = snap.inventoryTxns.find(
          (t) =>
            t.inventoryItemId === entityDocId &&
            String(t.txnDate || tsToIso(t.createdAt)).slice(0, 16) === logMinute,
        );
        if (txn?.locationId) return [txn.locationId];
      }
      if (l.userId) {
        const actor = erpUserByDocId.get(toDocId(String(l.userId), uid));
        if (actor?.assignedLocationId) return [actor.assignedLocationId];
      }
      return [];
    };

    const filteredLogs = snap.auditLogs
      .map((l) => {
        const locIds = resolveAuditLocations(l);
        return { raw: l, locIds };
      })
      .filter(({ raw, locIds }) => {
        if (!inDateRange(raw.loggedAt || tsToIso(raw.createdAt))) return false;
        if (locFilter && !locIds.includes(locFilter)) return false;
        return true;
      })
      .sort((a, b) =>
        String(b.raw.loggedAt || tsToIso(b.raw.createdAt)).localeCompare(String(a.raw.loggedAt || tsToIso(a.raw.createdAt))),
      );

    const activeUserDocIdsInLogs = new Set(
      filteredLogs
        .map(({ raw }) => (raw.userId ? toDocId(String(raw.userId), uid) : ''))
        .filter(Boolean),
    );

    const logCountByRoleId = new Map<string, number>();
    for (const { raw } of filteredLogs) {
      const actor = raw.userId ? erpUserByDocId.get(toDocId(String(raw.userId), uid)) : null;
      const roleId = actor?.roleId;
      if (roleId) {
        logCountByRoleId.set(roleId, (logCountByRoleId.get(roleId) || 0) + 1);
      }
      if (raw.entityType === 'User' && raw.entityId) {
        const target = erpUserByDocId.get(toDocId(String(raw.entityId), uid));
        if (target?.roleId && target.roleId !== roleId) {
          logCountByRoleId.set(target.roleId, (logCountByRoleId.get(target.roleId) || 0) + 1);
        }
      }
    }

    const allRoles = [...(snap.meta?.roles || [])].sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
    const roles = allRoles
      .map((r: any) => {
        const assignedUsers = snap.erpUsers
          .filter((u) => {
            if (u.roleId !== r.id) return false;
            if (locFilter && u.assignedLocationId !== locFilter) return false;
            if (from || to) {
              return inDateRange(tsToIso(u.createdAt)) || activeUserDocIdsInLogs.has(u.id);
            }
            return true;
          })
          .map((u) => ({
            id: toLogicalId(u.id, uid),
            full_name: u.fullName,
            email: u.email,
            is_active: u.isActive ? 1 : 0,
            location_name: u.assignedLocationId ? locMap.get(u.assignedLocationId)?.name || 'Branch' : 'HQ / All Branches',
          }));
        const activityCount = logCountByRoleId.get(r.id) || 0;
        return {
          ...r,
          assigned_users: assignedUsers,
          activity_count: activityCount,
        };
      })
      .filter((r: any) => (!locFilter && !from && !to) || r.assigned_users.length > 0 || r.activity_count > 0);

    const auditLogs = filteredLogs.slice(0, from || to || locFilter ? 200 : 100).map(({ raw: l, locIds }) => ({
      id: toLogicalId(l.id, uid),
      user_id: l.userId,
      user_name: l.userName,
      action: l.action,
      entity_type: l.entityType,
      entity_id: l.entityId,
      location_name: locIds.length > 0 ? locIds.map((id) => locMap.get(id)?.name || id).join(', ') : 'HQ / Global',
      details: l.details,
      created_at: l.loggedAt || tsToIso(l.createdAt),
    }));
    return { roles, auditLogs } as T;
  }

  // 11. USER CONTROL SETTINGS (OWNER & SUPER_ADMIN ONLY)
  if (pathname === '/settings/users-control' && method === 'GET') {
    assertOwnerOrSuperAdmin(user);
    const locMap = new Map(snap.locations.map((l) => [l.id, l]));
    const users = [...snap.erpUsers]
      .sort((a, b) => Number(b.isActive) - Number(a.isActive) || String(a.fullName).localeCompare(String(b.fullName)))
      .map((u) => {
        const lockRemaining = getLockRemainingMs(u);
        return {
          id: toLogicalId(u.id, uid),
          email: u.email,
          full_name: u.fullName,
          phone: u.phone || '',
          address: u.address || '',
          role_id: u.roleId,
          assigned_location_id: u.assignedLocationId ? toLogicalId(u.assignedLocationId, uid) : null,
          avatar_url: u.avatarUrl || null,
          has_pin: Boolean(u.shiftPinHash),
          failed_login_attempts: Number(u.failedLoginAttempts || 0),
          is_locked: lockRemaining > 0,
          locked_until: lockRemaining > 0 ? u.lockedUntil : null,
          is_active: u.isActive ? 1 : 0,
          created_at: tsToIso(u.createdAt),
          role_code: u.roleCode,
          role_name: u.roleName,
          location_name: u.assignedLocationId ? locMap.get(u.assignedLocationId)?.name || null : null,
        };
      });

    const employees = [...snap.employees]
      .sort((a, b) => Number(b.isActive) - Number(a.isActive) || String(a.employeeCode).localeCompare(String(b.employeeCode)))
      .map((e) => ({
        id: toLogicalId(e.id, uid),
        employee_code: e.employeeCode,
        full_name: e.fullName,
        phone: e.phone || '',
        address: e.address || '',
        department: e.department,
        position: e.position,
        location_id: e.locationId ? toLogicalId(e.locationId, uid) : null,
        pay_type: e.payType,
        base_rate: e.baseRate,
        avatar_url: e.avatarUrl || null,
        is_active: e.isActive ? 1 : 0,
        location_name: e.locationId ? locMap.get(e.locationId)?.name || null : null,
      }));

    const roles = [...(snap.meta?.roles || [])].sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
    const locations = snap.locations
      .filter((l) => l.isActive)
      .sort((a, b) => String(a.type).localeCompare(String(b.type)) || String(a.name).localeCompare(String(b.name)))
      .map((l) => ({ id: toLogicalId(l.id, uid), code: l.code, name: l.name, type: l.type }));

    return { users, employees, roles, locations } as T;
  }

  if (pathname === '/settings/users' && method === 'POST') {
    assertOwnerOrSuperAdmin(user);
    const { email, password, shiftPin, fullName, phone, address, roleId, assignedLocationId, avatarUrl, isActive } = body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanName = String(fullName || '').trim();
    if (!cleanEmail) throw new Error('Email is required');
    if (!cleanName) throw new Error('Full name is required');
    if (!password || String(password).length < 6) throw new Error('Password must be at least 6 characters');
    if (!roleId) throw new Error('Role is required');
    if (snap.erpUsers.some((u) => String(u.email).toLowerCase() === cleanEmail)) {
      throw new Error(`A user with email "${cleanEmail}" already exists`);
    }
    const roleRow = (snap.meta?.roles || []).find((r: any) => r.id === roleId);
    if (!roleRow) throw new Error('Selected role does not exist');

    const logicalId = crypto.randomUUID();
    const docId = toDocId(logicalId, uid);
    const pwdHash = await hashPassword(String(password));
    const cleanPin = String(shiftPin || '').trim();
    const pinHash = cleanPin ? await hashShiftPin(docId, cleanPin) : null;

    try {
      await setDoc(doc(db, 'erp_users', docId), {
        id: docId,
        ownerUid: uid,
        email: cleanEmail,
        fullName: cleanName,
        phone: phone ? String(phone).trim().slice(0, 40) : null,
        address: address ? String(address).trim().slice(0, 300) : null,
        roleId: roleRow.id,
        roleCode: roleRow.code,
        roleName: roleRow.name,
        assignedLocationId: assignedLocationId ? toDocId(String(assignedLocationId), uid) : null,
        avatarUrl: avatarUrl || null,
        passwordHash: pwdHash,
        shiftPinHash: pinHash,
        failedLoginAttempts: 0,
        lockedUntil: null,
        isActive: isActive !== false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `erp_users/${docId}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'CREATE_USER', 'User', logicalId, {
      email: cleanEmail,
      fullName: cleanName,
      roleCode: roleRow.code,
      hasPin: Boolean(pinHash),
    });
    invalidateWorkspaceCache();
    return { id: logicalId } as T;
  }

  if (pathname.startsWith('/settings/users/') && method === 'PUT') {
    const targetId = pathname.split('/')[3];
    const isOwnerOrSuperAdmin = user.roleCode === 'SUPER_ADMIN' || user.roleCode === 'BUSINESS_OWNER';
    const isSelfUpdate = targetId === user.id;
    if (!isOwnerOrSuperAdmin && !isSelfUpdate) {
      throw new Error('Restricted: Company Owner, Super Admin, or account owner access required');
    }

    const docId = toDocId(targetId, uid);
    const existing = snap.erpUsers.find((u) => u.id === docId);
    if (!existing) throw new Error('User not found');

    const { email, password, shiftPin, clearPin, unlockAccount, fullName, phone, address, roleId, assignedLocationId, avatarUrl, isActive } = body || {};
    const cleanEmail = String(email ?? existing.email).trim().toLowerCase();
    const cleanName = String(fullName ?? existing.fullName).trim();

    if (!isOwnerOrSuperAdmin) {
      if (roleId !== undefined && roleId !== existing.roleId) {
        throw new Error('Permission denied: only Company Owner or Super Admin can change user roles');
      }
      if (isActive !== undefined && Boolean(isActive) !== Boolean(existing.isActive)) {
        throw new Error('Permission denied: only Company Owner or Super Admin can change account active status');
      }
      if (assignedLocationId !== undefined) {
        const requestedLocId = assignedLocationId ? toDocId(String(assignedLocationId), uid) : null;
        if (requestedLocId !== (existing.assignedLocationId ?? null)) {
          throw new Error('Permission denied: only Company Owner or Super Admin can change assigned location');
        }
      }
      if (unlockAccount) {
        throw new Error('Permission denied: only Company Owner or Super Admin can unlock accounts');
      }
    }

    const nextRoleId = isOwnerOrSuperAdmin ? (roleId || existing.roleId) : existing.roleId;
    const nextActive = isOwnerOrSuperAdmin
      ? (isActive === undefined ? Boolean(existing.isActive) : Boolean(isActive))
      : Boolean(existing.isActive);
    const nextAssignedLocationId = isOwnerOrSuperAdmin
      ? (assignedLocationId !== undefined ? (assignedLocationId ? toDocId(String(assignedLocationId), uid) : null) : existing.assignedLocationId ?? null)
      : existing.assignedLocationId ?? null;

    if (!cleanEmail) throw new Error('Email is required');
    if (!cleanName) throw new Error('Full name is required');
    if (snap.erpUsers.some((u) => String(u.email).toLowerCase() === cleanEmail && u.id !== docId)) {
      throw new Error(`Email "${cleanEmail}" is already used by another account`);
    }
    const nextRole = (snap.meta?.roles || []).find((r: any) => r.id === nextRoleId);
    if (!nextRole) throw new Error('Selected role does not exist');

    if (targetId === user.id && isOwnerOrSuperAdmin) {
      if (!nextActive) throw new Error('You cannot deactivate your own active session account');
      if (nextRole.code !== 'SUPER_ADMIN' && nextRole.code !== 'BUSINESS_OWNER') {
        throw new Error('You cannot remove your own Owner/Super Admin access while signed in');
      }
    }

    const nextAvatar = avatarUrl !== undefined ? (avatarUrl ? String(avatarUrl) : null) : existing.avatarUrl ?? null;
    const nextPhone = phone !== undefined ? (phone ? String(phone).trim().slice(0, 40) : null) : existing.phone ?? null;
    const nextAddress = address !== undefined ? (address ? String(address).trim().slice(0, 300) : null) : existing.address ?? null;

    const updatePayload: Record<string, unknown> = {
      email: cleanEmail,
      fullName: cleanName,
      phone: nextPhone,
      address: nextAddress,
      roleId: nextRole.id,
      roleCode: nextRole.code,
      roleName: nextRole.name,
      assignedLocationId: nextAssignedLocationId,
      avatarUrl: nextAvatar,
      isActive: nextActive,
      updatedAt: serverTimestamp(),
    };

    if (password && String(password).trim().length > 0) {
      if (String(password).length < 6) throw new Error('New password must be at least 6 characters');
      updatePayload.passwordHash = await hashPassword(String(password));
    }

    if (clearPin) {
      updatePayload.shiftPinHash = null;
    } else if (shiftPin && String(shiftPin).trim().length > 0) {
      updatePayload.shiftPinHash = await hashShiftPin(docId, String(shiftPin).trim());
    }

    if (unlockAccount) {
      updatePayload.failedLoginAttempts = 0;
      updatePayload.lockedUntil = null;
    }

    try {
      await updateDoc(doc(db, 'erp_users', docId), updatePayload);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `erp_users/${docId}`);
    }
    await addAuditLog(uid, user.id, user.fullName, unlockAccount ? 'UNLOCK_USER' : 'UPDATE_USER', 'User', targetId, {
      email: cleanEmail,
      fullName: cleanName,
      roleCode: nextRole.code,
      isActive: nextActive,
    });
    invalidateWorkspaceCache();
    return { ok: true } as T;
  }

  if ((pathname === '/settings/employees' || pathname === '/hr/employees') && method === 'POST') {
    if (pathname.startsWith('/settings')) assertOwnerOrSuperAdmin(user);
    else assertPerm(user, PERMISSIONS.HR_MANAGE);

    const {
      employeeCode,
      fullName,
      phone,
      address,
      department,
      position,
      locationId,
      payType,
      baseRate,
      avatarUrl,
      faceDescriptorJson,
      faceEnrolledAt,
      attendancePin,
      isActive,
    } = body || {};
    const cleanName = String(fullName || '').trim();
    if (!cleanName) throw new Error('Employee full name is required');
    const code = String(employeeCode || `EMP-${Date.now().toString().slice(-3)}`).trim();
    if (snap.employees.some((e) => String(e.employeeCode).toLowerCase() === code.toLowerCase())) {
      throw new Error(`Employee code "${code}" already exists`);
    }

    const logicalId = crypto.randomUUID();
    const docId = toDocId(logicalId, uid);
    try {
      await setDoc(doc(db, 'employees', docId), {
        id: docId,
        ownerUid: uid,
        employeeCode: code,
        fullName: cleanName,
        phone: phone ? String(phone).trim().slice(0, 40) : null,
        address: address ? String(address).trim().slice(0, 300) : null,
        department: String(department || 'Operations').trim(),
        position: String(position || 'Crew').trim(),
        locationId: locationId ? toDocId(String(locationId), uid) : null,
        payType: payType || 'DAILY',
        baseRate: Number(baseRate || 650),
        avatarUrl: avatarUrl || null,
        faceDescriptorJson: faceDescriptorJson ? String(faceDescriptorJson).slice(0, 4096) : null,
        faceEnrolledAt: faceEnrolledAt || (faceDescriptorJson ? new Date().toISOString() : null),
        attendancePin: attendancePin ? String(attendancePin).trim().slice(0, 12) : null,
        isActive: isActive !== false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `employees/${docId}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'CREATE_EMPLOYEE', 'Employee', logicalId, { code, fullName: cleanName });
    invalidateWorkspaceCache();
    return { id: logicalId } as T;
  }

  if ((pathname.startsWith('/settings/employees/') || pathname.startsWith('/hr/employees/')) && method === 'PUT') {
    if (pathname.startsWith('/settings')) assertOwnerOrSuperAdmin(user);
    else assertPerm(user, PERMISSIONS.HR_MANAGE);
    const empId = pathname.split('/')[3];
    const docId = toDocId(empId, uid);
    const existing = snap.employees.find((e) => e.id === docId);
    if (!existing) throw new Error('Employee not found');

    const {
      employeeCode,
      fullName,
      phone,
      address,
      department,
      position,
      locationId,
      payType,
      baseRate,
      avatarUrl,
      faceDescriptorJson,
      faceEnrolledAt,
      attendancePin,
      isActive,
    } = body || {};
    const cleanName = String(fullName ?? existing.fullName).trim();
    const cleanCode = String(employeeCode ?? existing.employeeCode).trim();
    if (!cleanName) throw new Error('Employee full name is required');
    if (!cleanCode) throw new Error('Employee code is required');
    if (snap.employees.some((e) => String(e.employeeCode).toLowerCase() === cleanCode.toLowerCase() && e.id !== docId)) {
      throw new Error(`Employee code "${cleanCode}" is already used by another employee`);
    }

    const nextAvatar = avatarUrl !== undefined ? (avatarUrl ? String(avatarUrl) : null) : existing.avatarUrl ?? null;
    const nextPhone = phone !== undefined ? (phone ? String(phone).trim().slice(0, 40) : null) : existing.phone ?? null;
    const nextAddress = address !== undefined ? (address ? String(address).trim().slice(0, 300) : null) : existing.address ?? null;
    const nextDescriptor =
      faceDescriptorJson !== undefined
        ? faceDescriptorJson
          ? String(faceDescriptorJson).slice(0, 4096)
          : null
        : existing.faceDescriptorJson ?? null;
    const nextEnrolledAt =
      faceEnrolledAt !== undefined
        ? faceEnrolledAt || null
        : faceDescriptorJson !== undefined
          ? faceDescriptorJson
            ? new Date().toISOString()
            : null
          : existing.faceEnrolledAt ?? null;
    const nextPin =
      attendancePin !== undefined
        ? attendancePin
          ? String(attendancePin).trim().slice(0, 12)
          : null
        : existing.attendancePin ?? null;
    const nextActive = isActive === undefined ? Boolean(existing.isActive) : Boolean(isActive);

    try {
      await updateDoc(doc(db, 'employees', docId), {
        employeeCode: cleanCode,
        fullName: cleanName,
        phone: nextPhone,
        address: nextAddress,
        department: String(department ?? existing.department).trim(),
        position: String(position ?? existing.position).trim(),
        locationId: locationId !== undefined ? (locationId ? toDocId(String(locationId), uid) : null) : existing.locationId ?? null,
        payType: payType || existing.payType,
        baseRate: Number(baseRate ?? existing.baseRate),
        avatarUrl: nextAvatar,
        faceDescriptorJson: nextDescriptor,
        faceEnrolledAt: nextEnrolledAt,
        attendancePin: nextPin,
        isActive: nextActive,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `employees/${docId}`);
    }
    await addAuditLog(uid, user.id, user.fullName, 'UPDATE_EMPLOYEE', 'Employee', empId, { code: cleanCode, fullName: cleanName, isActive: nextActive });
    invalidateWorkspaceCache();
    return { ok: true } as T;
  }

  // 12. POS DEVICE PAIRING & REGISTER CONTROL (MANAGERS, OWNER & SUPER_ADMIN + POS STAFF CURRENT TERMINAL PRINTER)
  if (pathname === '/settings/devices/current' && method === 'GET') {
    assertAnyPerm(
      user,
      PERMISSIONS.POS_SELL,
      PERMISSIONS.SETTINGS_ADMIN,
      PERMISSIONS.FLEET_MANAGE,
    );
    const hardwareUuid = String(qs.get('hardwareUuid') || '').trim();
    const locMap = new Map(snap.locations.map((l) => [l.id, l]));
    const found = hardwareUuid
      ? snap.terminalDevices.find((d) => String(d.hardwareUuid || '').trim() === hardwareUuid)
      : null;
    const locations = snap.locations
      .filter((l) => l.isActive)
      .sort((a, b) => String(a.type).localeCompare(String(b.type)) || String(a.name).localeCompare(String(b.name)))
      .map((l) => ({ id: toLogicalId(l.id, uid), code: l.code, name: l.name, type: l.type }));
    return {
      device: found ? mapTerminalDevice(found, uid, locMap) : null,
      locations,
    } as T;
  }

  if (pathname === '/settings/devices/current-printer' && method === 'POST') {
    assertAnyPerm(
      user,
      PERMISSIONS.POS_SELL,
      PERMISSIONS.SETTINGS_ADMIN,
      PERMISSIONS.FLEET_MANAGE,
    );
    const hardwareUuid = String(body?.hardwareUuid || '').trim();
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(hardwareUuid)) {
      throw new Error('Valid Terminal hardware UUID is required to map a thermal printer');
    }
    const existing = snap.terminalDevices.find((d) => String(d.hardwareUuid || '').trim() === hardwareUuid);
    if (!existing) {
      throw new Error('Pair and register this Terminal hardware UUID first before saving a cloud printer mapping.');
    }
    if (existing.status === 'REVOKED') {
      throw new Error('This Terminal device is revoked. Re-authorize it before mapping a printer.');
    }

    const printerFields = normalizePrinterFields(body, existing);
    try {
      await updateDoc(doc(db, 'terminal_devices', existing.id), {
        printerConnectionType: printerFields.printerConnectionType,
        printerName: printerFields.printerName,
        printerIp: printerFields.printerIp,
        printerPort: printerFields.printerPort,
        printerBtDeviceId: printerFields.printerBtDeviceId,
        printerBtServiceUuid: printerFields.printerBtServiceUuid,
        printerBtCharacteristicUuid: printerFields.printerBtCharacteristicUuid,
        printerPaperWidthMm: printerFields.printerPaperWidthMm,
        printerAutoPrint: printerFields.printerAutoPrint,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `terminal_devices/${existing.id}`);
    }

    const isClearing = !printerFields.printerIp && !printerFields.printerBtDeviceId;
    await addAuditLog(
      uid,
      user.id,
      user.fullName,
      isClearing ? 'UNMAP_TERMINAL_PRINTER' : 'MAP_TERMINAL_PRINTER',
      'TerminalDevice',
      toLogicalId(existing.id, uid),
      {
        deviceName: existing.deviceName,
        hardwareUuid,
        connectionType: printerFields.printerConnectionType || 'NONE',
        printerName: printerFields.printerName,
        printerEndpoint: printerFields.printerIp
          ? `${printerFields.printerIp}:${printerFields.printerPort}`
          : printerFields.printerBtDeviceId
            ? `BT:${printerFields.printerBtDeviceId}`
            : 'NONE',
        paperWidthMm: printerFields.printerPaperWidthMm,
        autoPrint: printerFields.printerAutoPrint,
      },
    );
    invalidateWorkspaceCache();

    const locMap = new Map(snap.locations.map((l) => [l.id, l]));
    const updatedRow = {
      ...existing,
      ...printerFields,
      updatedAt: new Date().toISOString(),
    };
    return { ok: true, device: mapTerminalDevice(updatedRow, uid, locMap) } as T;
  }

  if (pathname === '/settings/devices' && method === 'GET') {
    assertDeviceManagerAccess(user);
    const locMap = new Map(snap.locations.map((l) => [l.id, l]));
    const devices = [...snap.terminalDevices]
      .sort((a, b) => {
        const sDiff = (a.status === 'AUTHORIZED' ? 0 : 1) - (b.status === 'AUTHORIZED' ? 0 : 1);
        if (sDiff !== 0) return sDiff;
        return String(b.lastSeenAt || b.pairedAt || '').localeCompare(String(a.lastSeenAt || a.pairedAt || ''));
      })
      .map((d) => mapTerminalDevice(d, uid, locMap));

    const locations = snap.locations
      .filter((l) => l.isActive)
      .sort((a, b) => String(a.type).localeCompare(String(b.type)) || String(a.name).localeCompare(String(b.name)))
      .map((l) => ({ id: toLogicalId(l.id, uid), code: l.code, name: l.name, type: l.type }));

    return { devices, locations } as T;
  }

  if (pathname === '/settings/devices' && method === 'POST') {
    assertDeviceManagerAccess(user);
    const { hardwareUuid, deviceName, locationId, stationEmail, userAgentSummary } = body || {};
    const cleanUuid = String(hardwareUuid || '').trim();
    const cleanName = String(deviceName || '').trim().slice(0, 120);
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(cleanUuid)) {
      throw new Error('Hardware UUID must be 8 to 128 alphanumeric, underscore, or hyphen characters');
    }
    if (!cleanName) {
      throw new Error('Device / Register name is required');
    }
    if (snap.terminalDevices.some((d) => String(d.hardwareUuid || '').trim() === cleanUuid)) {
      throw new Error(`Hardware UUID "${cleanUuid}" is already registered. Edit or re-authorize the existing terminal record.`);
    }

    const cleanLocId = locationId ? toDocId(String(locationId), uid) : null;
    const cleanStationEmail = stationEmail ? String(stationEmail).trim().toLowerCase().slice(0, 200) : null;
    const cleanUa = userAgentSummary ? String(userAgentSummary).trim().slice(0, 160) : null;
    const printerFields = normalizePrinterFields(body);
    const nowIso = new Date().toISOString();
    const logicalId = crypto.randomUUID();
    const docId = toDocId(logicalId, uid);

    try {
      await setDoc(doc(db, 'terminal_devices', docId), {
        id: docId,
        ownerUid: uid,
        hardwareUuid: cleanUuid,
        deviceName: cleanName,
        locationId: cleanLocId,
        stationEmail: cleanStationEmail,
        status: 'AUTHORIZED',
        pairedByUserId: user.id,
        pairedByName: user.fullName.slice(0, 150),
        pairedAt: nowIso,
        lastSeenAt: nowIso,
        userAgentSummary: cleanUa,
        printerConnectionType: printerFields.printerConnectionType,
        printerName: printerFields.printerName,
        printerIp: printerFields.printerIp,
        printerPort: printerFields.printerPort,
        printerBtDeviceId: printerFields.printerBtDeviceId,
        printerBtServiceUuid: printerFields.printerBtServiceUuid,
        printerBtCharacteristicUuid: printerFields.printerBtCharacteristicUuid,
        printerPaperWidthMm: printerFields.printerPaperWidthMm,
        printerAutoPrint: printerFields.printerAutoPrint,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `terminal_devices/${docId}`);
    }

    await addAuditLog(uid, user.id, user.fullName, 'REGISTER_TERMINAL_DEVICE', 'TerminalDevice', logicalId, {
      deviceName: cleanName,
      hardwareUuid: cleanUuid,
      locationId: cleanLocId ? toLogicalId(cleanLocId, uid) : 'ALL',
    });
    invalidateWorkspaceCache();
    return { id: logicalId } as T;
  }

  if (pathname.startsWith('/settings/devices/') && method === 'PUT') {
    assertDeviceManagerAccess(user);
    const targetId = pathname.split('/')[3];
    const docId = toDocId(targetId, uid);
    const existing = snap.terminalDevices.find((d) => d.id === docId);
    if (!existing) throw new Error('Registered POS device not found');

    const { deviceName, locationId, stationEmail, status, userAgentSummary } = body || {};
    const cleanName = String(deviceName ?? existing.deviceName).trim().slice(0, 120);
    if (!cleanName) throw new Error('Device / Register name is required');
    const nextStatus = status === 'REVOKED' ? 'REVOKED' : status === 'AUTHORIZED' ? 'AUTHORIZED' : existing.status;
    const nextLocId = locationId !== undefined ? (locationId ? toDocId(String(locationId), uid) : null) : existing.locationId ?? null;
    const nextStationEmail =
      stationEmail !== undefined ? (stationEmail ? String(stationEmail).trim().toLowerCase().slice(0, 200) : null) : existing.stationEmail ?? null;
    const nextUa =
      userAgentSummary !== undefined
        ? userAgentSummary
          ? String(userAgentSummary).trim().slice(0, 160)
          : null
        : existing.userAgentSummary ?? null;
    const printerFields = normalizePrinterFields(body, existing);
    const nowIso = new Date().toISOString();
    const reauthorized = existing.status !== 'AUTHORIZED' && nextStatus === 'AUTHORIZED';

    try {
      await updateDoc(doc(db, 'terminal_devices', docId), {
        deviceName: cleanName,
        locationId: nextLocId,
        stationEmail: nextStationEmail,
        status: nextStatus,
        pairedByUserId: reauthorized ? user.id : existing.pairedByUserId,
        pairedByName: reauthorized ? user.fullName.slice(0, 150) : existing.pairedByName,
        pairedAt: reauthorized ? nowIso : existing.pairedAt,
        lastSeenAt: reauthorized ? nowIso : existing.lastSeenAt,
        userAgentSummary: nextUa,
        printerConnectionType: printerFields.printerConnectionType,
        printerName: printerFields.printerName,
        printerIp: printerFields.printerIp,
        printerPort: printerFields.printerPort,
        printerBtDeviceId: printerFields.printerBtDeviceId,
        printerBtServiceUuid: printerFields.printerBtServiceUuid,
        printerBtCharacteristicUuid: printerFields.printerBtCharacteristicUuid,
        printerPaperWidthMm: printerFields.printerPaperWidthMm,
        printerAutoPrint: printerFields.printerAutoPrint,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `terminal_devices/${docId}`);
    }

    const action =
      nextStatus !== existing.status
        ? nextStatus === 'REVOKED'
          ? 'REVOKE_TERMINAL_DEVICE'
          : 'AUTHORIZE_TERMINAL_DEVICE'
        : 'UPDATE_TERMINAL_DEVICE';
    await addAuditLog(uid, user.id, user.fullName, action, 'TerminalDevice', targetId, {
      deviceName: cleanName,
      hardwareUuid: existing.hardwareUuid,
      status: nextStatus,
      printerIp: printerFields.printerIp || null,
    });
    invalidateWorkspaceCache();
    return { ok: true } as T;
  }

  if (pathname.startsWith('/settings/devices/') && method === 'DELETE') {
    assertDeviceManagerAccess(user);
    const targetId = pathname.split('/')[3];
    const docId = toDocId(targetId, uid);
    const existing = snap.terminalDevices.find((d) => d.id === docId);
    if (!existing) throw new Error('Registered POS device not found');

    try {
      await deleteDoc(doc(db, 'terminal_devices', docId));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `terminal_devices/${docId}`);
    }

    await addAuditLog(uid, user.id, user.fullName, 'REMOVE_TERMINAL_DEVICE', 'TerminalDevice', targetId, {
      deviceName: existing.deviceName,
      hardwareUuid: existing.hardwareUuid,
    });
    invalidateWorkspaceCache();
    return { ok: true } as T;
  }

  throw new Error(`Unsupported operation: ${method} ${pathname}`);
}
