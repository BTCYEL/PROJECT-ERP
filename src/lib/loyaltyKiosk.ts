export type LoyaltyTier = 'STANDARD' | 'SILVER' | 'GOLD' | 'PLATINUM';

export interface TierConfig {
  code: LoyaltyTier;
  name: string;
  minPoints: number;
  badgeBg: string;
  badgeText: string;
  perks: string[];
  discountPct: number;
}

export const TIER_CONFIGS: Record<LoyaltyTier, TierConfig> = {
  STANDARD: {
    code: 'STANDARD',
    name: 'Pitmaster Scout',
    minPoints: 0,
    badgeBg: 'bg-slate-100',
    badgeText: 'text-slate-800',
    perks: ['1 Loyalty Point per ₱50 spent', 'Digital receipt access', 'Birthday month surprise'],
    discountPct: 0,
  },
  SILVER: {
    code: 'SILVER',
    name: 'Grill Enthusiast',
    minPoints: 100,
    badgeBg: 'bg-blue-100',
    badgeText: 'text-blue-800',
    perks: ['5% off drinks & sides', 'Free bottomless iced tea refill', 'Priority online pickup'],
    discountPct: 5,
  },
  GOLD: {
    code: 'GOLD',
    name: 'Smokehouse Master',
    minPoints: 250,
    badgeBg: 'bg-amber-100',
    badgeText: 'text-amber-800',
    perks: ['10% off total bill', 'Free signature BBQ pork skewer every 5 visits', 'Exclusive secret menu access'],
    discountPct: 10,
  },
  PLATINUM: {
    code: 'PLATINUM',
    name: 'VIP Pitmaster Legend',
    minPoints: 500,
    badgeBg: 'bg-purple-100',
    badgeText: 'text-purple-800',
    perks: ['15% off total bill', 'VIP priority queue at food trucks', 'Complimentary BBQ Fiesta Platter on birthday', 'Direct catering concierge'],
    discountPct: 15,
  },
};

export const WELCOME_POINTS_BONUS = 25;
export const SPEND_PER_POINT_PHP = 50;

/**
 * Normalizes any Philippine mobile phone input into clean 11-digit 09XXXXXXXXX format.
 */
export function normalizePhoneNumber(raw: string): string {
  if (!raw) return '';
  // Strip all non-digit characters
  let digits = raw.replace(/\D/g, '');

  // Handle +63 or 63 country code prefix
  if (digits.startsWith('63') && digits.length === 12) {
    digits = '0' + digits.slice(2);
  } else if (digits.startsWith('9') && digits.length === 10) {
    digits = '0' + digits;
  }

  return digits.slice(0, 11);
}

/**
 * Formats an 11-digit number as "0917 123 4567" for high-legibility display.
 */
export function formatPhoneNumber(phone: string): string {
  const norm = normalizePhoneNumber(phone);
  if (norm.length !== 11) return phone || '—';
  return `${norm.slice(0, 4)} ${norm.slice(4, 7)} ${norm.slice(7)}`;
}

/**
 * Validates whether string is a valid 11-digit PH mobile number starting with 09.
 */
export function isValidPhPhoneNumber(phone: string): boolean {
  const norm = normalizePhoneNumber(phone);
  return /^09\d{9}$/.test(norm);
}

/**
 * Calculates current tier based on accumulated loyalty points.
 */
export function calculateLoyaltyTier(points: number): LoyaltyTier {
  const pts = Math.max(0, Number(points || 0));
  if (pts >= TIER_CONFIGS.PLATINUM.minPoints) return 'PLATINUM';
  if (pts >= TIER_CONFIGS.GOLD.minPoints) return 'GOLD';
  if (pts >= TIER_CONFIGS.SILVER.minPoints) return 'SILVER';
  return 'STANDARD';
}

/**
 * Points needed to upgrade to the next loyalty tier.
 */
export function pointsToNextTier(points: number): { nextTier: LoyaltyTier | null; neededPoints: number; progressPct: number } {
  const current = calculateLoyaltyTier(points);
  if (current === 'PLATINUM') {
    return { nextTier: null, neededPoints: 0, progressPct: 100 };
  }
  const nextTier: LoyaltyTier = current === 'STANDARD' ? 'SILVER' : current === 'SILVER' ? 'GOLD' : 'PLATINUM';
  const target = TIER_CONFIGS[nextTier].minPoints;
  const prevMin = TIER_CONFIGS[current].minPoints;
  const currentPts = Math.max(0, Number(points || 0));
  const needed = Math.max(0, target - currentPts);
  const range = target - prevMin;
  const progressPct = Math.min(100, Math.max(0, Math.round(((currentPts - prevMin) / range) * 100)));
  return { nextTier, neededPoints: needed, progressPct };
}

export interface CustomerLoyaltyProfile {
  id: string;
  fullName: string;
  phone: string;
  email?: string | null;
  loyaltyPoints: number;
  tier: LoyaltyTier;
  preferences?: string | null;
  feedbackNotes?: string | null;
  registeredAt?: string;
  locationId?: string | null;
  locationName?: string;
  totalOrders: number;
  lifetimeSpend: number;
}

export interface LinkedTransactionItem {
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface LinkedTransactionRecord {
  id: string;
  receiptNumber: string;
  soldAt: string;
  locationId: string;
  locationName: string;
  totalAmount: number;
  pointsEarned: number;
  itemsCount: number;
  itemsSummary: string;
  items: LinkedTransactionItem[];
  paymentMethod: string;
  isLinkedToCustomer: boolean;
  notes?: string | null;
}

export interface KioskLookupResult {
  found: boolean;
  customer?: CustomerLoyaltyProfile;
  transactions: LinkedTransactionRecord[];
  potentialUnlinkedCount?: number;
}

/**
 * Builds the URL encoded into the customer-facing QR code for counter standees or mobile kiosk.
 */
export function generateCounterKioskUrl(locationId?: string): string {
  try {
    const origin = window.location.origin || '';
    const path = window.location.pathname || '/';
    const locParam = locationId && locationId !== 'ALL' ? `&loc=${encodeURIComponent(locationId)}` : '';
    return `${origin}${path}?kiosk=loyalty${locParam}`;
  } catch {
    return `/?kiosk=loyalty`;
  }
}
