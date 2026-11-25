export type MaintenanceCategory =
  | 'ENGINE_OIL'
  | 'TIRES_BRAKES'
  | 'GENERATOR_LPG'
  | 'KITCHEN_EQUIP'
  | 'LTO_EMISSIONS'
  | 'GENERAL';

export type MaintenanceStatus = 'OPEN' | 'COMPLETED';

export type MaintenanceAlertState = 'OVERDUE' | 'DUE_SOON' | 'UPCOMING' | 'COMPLETED' | 'LOGGED';

export interface FleetMaintenanceLog {
  id: string;
  truck_id: string;
  location_id: string | null;
  plate_number: string;
  truck_name: string;
  title: string;
  description: string | null;
  cost: number;
  odometer_km: number | null;
  service_date: string;
  next_due_date: string | null;
  maintenance_category: MaintenanceCategory;
  service_provider: string | null;
  maintenance_status: MaintenanceStatus;
  alert_lead_days: number;
  expense_id: string | null;
}

export interface MaintenanceAlertInfo {
  state: MaintenanceAlertState;
  label: string;
  countdownText: string;
  daysUntil: number | null;
  isActionableAlert: boolean;
}

export interface TruckMaintenanceSummary {
  truckId: string;
  totalCost: number;
  serviceCount: number;
  overdueCount: number;
  dueSoonCount: number;
  lastServiceDate: string | null;
  nextDueDate: string | null;
}

export const MAINTENANCE_CATEGORIES: Array<{ value: MaintenanceCategory; label: string }> = [
  { value: 'ENGINE_OIL', label: 'Engine & Oil' },
  { value: 'TIRES_BRAKES', label: 'Tires & Brakes' },
  { value: 'GENERATOR_LPG', label: 'Generator & LPG' },
  { value: 'KITCHEN_EQUIP', label: 'Grill & Kitchen Rig' },
  { value: 'LTO_EMISSIONS', label: 'LTO & Permits' },
  { value: 'GENERAL', label: 'General Service' },
];

export const MAINTENANCE_PRESETS: Array<{
  label: string;
  title: string;
  category: MaintenanceCategory;
  leadDays: number;
  intervalDays: number;
  defaultCost: number;
  description: string;
}> = [
  {
    label: 'Oil & Filter Change',
    title: 'Engine Oil & Filter Change',
    category: 'ENGINE_OIL',
    leadDays: 7,
    intervalDays: 90,
    defaultCost: 3200,
    description: 'Synthetic oil, oil filter, air filter inspection, and fluid top-up.',
  },
  {
    label: 'Generator 500-Hr Service',
    title: 'Generator Oil & Spark Service',
    category: 'GENERATOR_LPG',
    leadDays: 7,
    intervalDays: 30,
    defaultCost: 1800,
    description: 'Generator oil drain, filter clean, load voltage & output check.',
  },
  {
    label: 'LPG & Burner Safety Check',
    title: 'LPG Regulator & Grill Line Leak Test',
    category: 'KITCHEN_EQUIP',
    leadDays: 7,
    intervalDays: 30,
    defaultCost: 950,
    description: 'Pressurized soap leak test on dual manifolds, hoses, and smoker box seals.',
  },
  {
    label: 'Brakes & Tire Rotation',
    title: 'Brake Pad Check & Tire Rotation',
    category: 'TIRES_BRAKES',
    leadDays: 14,
    intervalDays: 120,
    defaultCost: 4500,
    description: 'Brake pad thickness check, hydraulic flush, and tire pressure/tread balancing.',
  },
  {
    label: 'LTO & Smoke Emission',
    title: 'LTO Registration & Smoke Emission Test',
    category: 'LTO_EMISSIONS',
    leadDays: 30,
    intervalDays: 365,
    defaultCost: 5200,
    description: 'Annual vehicle registration renewal, CTPL, and sanitary mobile kitchen permit.',
  },
];

export function formatMaintenanceCategory(cat?: string | null): string {
  const found = MAINTENANCE_CATEGORIES.find((c) => c.value === cat);
  return found ? found.label : 'General Service';
}

export function getTodayDateIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDaysToDateIso(baseIso: string, days: number): string {
  const parsed = parseIsoDay(baseIso);
  if (!parsed) return getTodayDateIso();
  const next = new Date(parsed + days * 86400000);
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

function parseIsoDay(dateStr?: string | null): number | null {
  if (!dateStr) return null;
  const clean = String(dateStr).trim().slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function getMaintenanceAlertInfo(
  log: Pick<FleetMaintenanceLog, 'next_due_date' | 'maintenance_status' | 'alert_lead_days'>,
  todayIso: string = getTodayDateIso(),
): MaintenanceAlertInfo {
  const dueIso = log.next_due_date ? String(log.next_due_date).slice(0, 10) : '';
  if (!dueIso) {
    return {
      state: 'LOGGED',
      label: 'Service Logged',
      countdownText: 'No follow-up due',
      daysUntil: null,
      isActionableAlert: false,
    };
  }

  if (log.maintenance_status === 'COMPLETED') {
    return {
      state: 'COMPLETED',
      label: 'Checkup Done',
      countdownText: `Completed (${dueIso})`,
      daysUntil: null,
      isActionableAlert: false,
    };
  }

  const todayMs = parseIsoDay(todayIso);
  const dueMs = parseIsoDay(dueIso);
  if (todayMs === null || dueMs === null) {
    return {
      state: 'UPCOMING',
      label: 'Scheduled',
      countdownText: dueIso,
      daysUntil: null,
      isActionableAlert: false,
    };
  }

  const daysUntil = Math.round((dueMs - todayMs) / 86400000);
  const leadDays = Number.isFinite(Number(log.alert_lead_days)) ? Math.max(0, Number(log.alert_lead_days)) : 7;

  if (daysUntil < 0) {
    const overdueDays = Math.abs(daysUntil);
    return {
      state: 'OVERDUE',
      label: 'Overdue',
      countdownText: `${overdueDays}d overdue`,
      daysUntil,
      isActionableAlert: true,
    };
  }

  if (daysUntil <= leadDays) {
    return {
      state: 'DUE_SOON',
      label: daysUntil === 0 ? 'Due Today' : 'Due Soon',
      countdownText: daysUntil === 0 ? 'Due today' : `Due in ${daysUntil}d`,
      daysUntil,
      isActionableAlert: true,
    };
  }

  return {
    state: 'UPCOMING',
    label: 'Scheduled',
    countdownText: `In ${daysUntil}d`,
    daysUntil,
    isActionableAlert: false,
  };
}

export function summarizeTruckMaintenance(
  truckId: string,
  logs: FleetMaintenanceLog[],
  todayIso: string = getTodayDateIso(),
): TruckMaintenanceSummary {
  const scoped = logs.filter((l) => l.truck_id === truckId);
  let totalCost = 0;
  let overdueCount = 0;
  let dueSoonCount = 0;
  let lastServiceDate: string | null = null;
  let nextDueDate: string | null = null;

  for (const log of scoped) {
    totalCost += Number(log.cost || 0);
    const svc = log.service_date ? String(log.service_date).slice(0, 10) : '';
    if (svc && (!lastServiceDate || svc > lastServiceDate)) {
      lastServiceDate = svc;
    }
    const info = getMaintenanceAlertInfo(log, todayIso);
    if (info.state === 'OVERDUE') overdueCount++;
    else if (info.state === 'DUE_SOON') dueSoonCount++;

    if (log.next_due_date && log.maintenance_status !== 'COMPLETED') {
      const due = String(log.next_due_date).slice(0, 10);
      if (!nextDueDate || due < nextDueDate) {
        nextDueDate = due;
      }
    }
  }

  return {
    truckId,
    totalCost: Math.round(totalCost * 100) / 100,
    serviceCount: scoped.length,
    overdueCount,
    dueSoonCount,
    lastServiceDate,
    nextDueDate,
  };
}
