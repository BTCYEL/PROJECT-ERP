import { AuthUser, PERMISSIONS, RoleCode } from '../types/erp.ts';

export type HuddlePriority = 'NORMAL' | 'URGENT' | 'CRITICAL';
export type HuddleChannel = 'POS' | 'KDS' | 'MOBILE';
export type HuddleShiftWindow = 'ALL_DAY' | 'OPENING' | 'MID_DAY' | 'CLOSING';

export interface DailyHuddleItem {
  id: string;
  title: string;
  message: string;
  priority: HuddlePriority;
  targetChannels: HuddleChannel[];
  locationId: string | null;
  locationName: string | null;
  shiftWindow: HuddleShiftWindow;
  authorId: string;
  authorName: string;
  authorRole: string;
  acknowledgedBy: string[];
  isPinned: boolean;
  isActive: boolean;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const MANAGER_HUDDLE_ROLES: RoleCode[] = [
  'SUPER_ADMIN',
  'BUSINESS_OWNER',
  'OPERATIONS_MANAGER',
  'FOOD_TRUCK_MANAGER',
  'HR_MANAGER',
  'FINANCE_MANAGER',
  'INVENTORY_MANAGER',
];

export const ALL_HUDDLE_CHANNELS: HuddleChannel[] = ['POS', 'KDS', 'MOBILE'];

export function canBroadcastDailyHuddle(user?: AuthUser | null): boolean {
  if (!user) return false;
  if (MANAGER_HUDDLE_ROLES.includes(user.roleCode)) return true;
  return Boolean(user.permissions?.includes(PERMISSIONS.SETTINGS_ADMIN));
}

export function formatShiftWindowLabel(windowCode: string): string {
  switch (String(windowCode || 'ALL_DAY').toUpperCase()) {
    case 'OPENING':
      return 'Opening Shift';
    case 'MID_DAY':
      return 'Mid-Day Shift';
    case 'CLOSING':
      return 'Closing Shift';
    default:
      return 'All Day';
  }
}

export function formatChannelLabel(channel: string): string {
  switch (String(channel || '').toUpperCase()) {
    case 'POS':
      return 'POS Terminal';
    case 'KDS':
      return 'Kitchen Display';
    case 'MOBILE':
      return 'Mobile View';
    default:
      return String(channel || '');
  }
}

export function isHuddleExpired(huddle: Pick<DailyHuddleItem, 'expiresAt'>, now = new Date()): boolean {
  if (!huddle.expiresAt) return false;
  const expMs = new Date(huddle.expiresAt).getTime();
  if (!Number.isFinite(expMs)) return false;
  return expMs <= now.getTime();
}

const PRIORITY_RANK: Record<HuddlePriority, number> = {
  CRITICAL: 3,
  URGENT: 2,
  NORMAL: 1,
};

export function sortDailyHuddles(huddles: DailyHuddleItem[]): DailyHuddleItem[] {
  return [...huddles].sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    const pDiff = (PRIORITY_RANK[b.priority] || 1) - (PRIORITY_RANK[a.priority] || 1);
    if (pDiff !== 0) return pDiff;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
}

export function filterActiveHuddlesForInterface(
  huddles: DailyHuddleItem[],
  opts: {
    channel: HuddleChannel;
    includeMobileChannel?: boolean;
    locationId?: string | null;
    now?: Date;
  },
): DailyHuddleItem[] {
  const now = opts.now || new Date();
  const normalizedLoc = opts.locationId && opts.locationId !== 'ALL' ? opts.locationId : null;

  const matching = huddles.filter((h) => {
    if (!h.isActive) return false;
    if (isHuddleExpired(h, now)) return false;

    const channels = Array.isArray(h.targetChannels) ? h.targetChannels : [];
    const matchesChannel =
      channels.includes(opts.channel) ||
      Boolean(opts.includeMobileChannel && channels.includes('MOBILE'));
    if (!matchesChannel) return false;

    if (normalizedLoc && h.locationId && h.locationId !== normalizedLoc) {
      return false;
    }
    return true;
  });

  return sortDailyHuddles(matching);
}

export interface HuddlePresetTemplate {
  id: string;
  label: string;
  title: string;
  message: string;
  priority: HuddlePriority;
  shiftWindow: HuddleShiftWindow;
  targetChannels: HuddleChannel[];
}

export const HUDDLE_PRESETS: HuddlePresetTemplate[] = [
  {
    id: 'rush',
    label: 'Peak Rush Protocol',
    title: 'Dinner Rush Target & Grill Ticket Priority',
    message:
      'Expect heavy walk-in and takeout volume from 6:00 PM to 9:00 PM. Batch-prep sisig platters ahead, confirm buzzer numbers on POS tickets, and keep KDS firing under 8 minutes.',
    priority: 'URGENT',
    shiftWindow: 'CLOSING',
    targetChannels: ['POS', 'KDS', 'MOBILE'],
  },
  {
    id: 'stock_86',
    label: '86 / Portion Substitution',
    title: 'Stock Watch: Confirm Portion Sizes Before Ring-Up',
    message:
      'Check remaining cold-chain meat trays before taking large catering or triple-patty orders. Flag any low items immediately in Inventory and notify the lead cashier.',
    priority: 'CRITICAL',
    shiftWindow: 'ALL_DAY',
    targetChannels: ['POS', 'KDS', 'MOBILE'],
  },
  {
    id: 'upsell',
    label: 'Upsell & Combo Focus',
    title: 'Shift Focus: Mango Shake & Fries Combo Suggestive Sell',
    message:
      'Offer Guimaras Mango Graham Shake or Truffle Fries add-on with every Sisig Taco and Smash Burger ticket. Remind loyalty guests to give their phone number before payment.',
    priority: 'NORMAL',
    shiftWindow: 'MID_DAY',
    targetChannels: ['POS', 'MOBILE'],
  },
  {
    id: 'closing',
    label: 'Closing & Cold-Chain',
    title: 'End-of-Shift Cleaning, FIFO Seal & Z-Reading',
    message:
      'Sanitize grill grates, label and seal leftover par-cooked batches with prep timestamps, and reconcile petty cash + E-Wallet totals before submitting Daily Shift Closing.',
    priority: 'NORMAL',
    shiftWindow: 'CLOSING',
    targetChannels: ['POS', 'KDS', 'MOBILE'],
  },
];
