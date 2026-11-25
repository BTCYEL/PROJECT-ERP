import React, { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import {
  ArrowLeft,
  ArrowRight,
  Award,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  ExternalLink,
  Flame,
  Link as LinkIcon,
  Phone,
  Plus,
  Printer,
  QrCode,
  Receipt,
  RotateCcw,
  Search,
  ShieldCheck,
  Smartphone,
  Sparkles,
  User,
  X,
} from 'lucide-react';
import { apiFetch, formatNum, formatPHP } from '../lib/api.ts';
import { LocationRow } from '../types/erp.ts';
import {
  calculateLoyaltyTier,
  CustomerLoyaltyProfile,
  formatPhoneNumber,
  generateCounterKioskUrl,
  isValidPhPhoneNumber,
  LinkedTransactionRecord,
  normalizePhoneNumber,
  pointsToNextTier,
  SPEND_PER_POINT_PHP,
  TIER_CONFIGS,
  WELCOME_POINTS_BONUS,
} from '../lib/loyaltyKiosk.ts';
import { ThemeToggle } from './ThemeToggle.tsx';

interface Props {
  mode?: 'embedded' | 'standalone' | 'counter-modal';
  locations?: LocationRow[];
  activeLocationId?: string;
  onExit?: () => void;
  onCustomerSelected?: (customer: CustomerLoyaltyProfile) => void;
}

export function CustomerLoyaltyKiosk({
  mode = 'embedded',
  locations = [],
  activeLocationId = 'ALL',
  onExit,
  onCustomerSelected,
}: Props) {
  const [kioskTab, setKioskTab] = useState<'standee' | 'terminal' | 'linker'>('standee');
  const [selectedLocId, setSelectedLocId] = useState<string>(() => {
    if (activeLocationId && activeLocationId !== 'ALL') return activeLocationId;
    return locations.find((l) => l.type === 'FOOD_TRUCK')?.id || locations[0]?.id || '';
  });

  // QR Code State
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [copiedLink, setCopiedLink] = useState(false);

  // Kiosk Terminal State
  const [phoneInput, setPhoneInput] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [activeCustomer, setActiveCustomer] = useState<CustomerLoyaltyProfile | null>(null);
  const [transactions, setTransactions] = useState<LinkedTransactionRecord[]>([]);
  const [showJoinForm, setShowJoinForm] = useState(false);
  const [isNewJoinSuccess, setIsNewJoinSuccess] = useState(false);

  // Join Form State
  const [joinForm, setJoinForm] = useState({
    fullName: '',
    phone: '',
    email: '',
    preferences: '',
    autoLinkRecentSales: true,
  });
  const [isSubmittingJoin, setIsSubmittingJoin] = useState(false);

  // Transaction Linking State
  const [linkReceiptInput, setLinkReceiptInput] = useState('');
  const [isLinkingReceipt, setIsLinkingReceipt] = useState(false);
  const [linkSuccessMsg, setLinkSuccessMsg] = useState('');
  const [linkErrorMsg, setLinkErrorMsg] = useState('');
  const [unlinkedSales, setUnlinkedSales] = useState<any[]>([]);
  const [isLoadingUnlinked, setIsLoadingUnlinked] = useState(false);
  const [expandedTxnId, setExpandedTxnId] = useState<string | null>(null);

  const selectedLocName = useMemo(() => {
    return locations.find((l) => l.id === selectedLocId)?.name || 'Food Truck Counter';
  }, [locations, selectedLocId]);

  const kioskUrl = useMemo(() => {
    return generateCounterKioskUrl(selectedLocId);
  }, [selectedLocId]);

  // Generate QR Code whenever kioskUrl changes
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(kioskUrl, {
      width: 380,
      margin: 2,
      color: {
        dark: '#0f172a',
        light: '#ffffff',
      },
      errorCorrectionLevel: 'H',
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch((err) => {
        console.error('Failed to generate Kiosk QR code:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [kioskUrl]);

  // Load unlinked sales for staff linker
  const loadUnlinkedSales = async () => {
    setIsLoadingUnlinked(true);
    try {
      const locQ = selectedLocId && selectedLocId !== 'ALL' ? `?locationId=${encodeURIComponent(selectedLocId)}` : '';
      const res = await apiFetch(`/crm/unlinked-sales${locQ}`);
      setUnlinkedSales(res || []);
    } catch {
      // ignore
    } finally {
      setIsLoadingUnlinked(false);
    }
  };

  useEffect(() => {
    if (kioskTab === 'linker') {
      loadUnlinkedSales();
    }
  }, [kioskTab, selectedLocId]);

  // Search/Lookup Customer by Phone
  const handlePhoneLookup = async (phoneToSearch?: string) => {
    const raw = phoneToSearch !== undefined ? phoneToSearch : phoneInput;
    const norm = normalizePhoneNumber(raw);
    if (!norm || norm.length < 10) {
      setSearchError('Please enter a valid 11-digit mobile phone number (e.g. 0917 123 4567)');
      return;
    }
    setSearchError('');
    setIsSearching(true);
    setShowJoinForm(false);
    setIsNewJoinSuccess(false);
    setLinkSuccessMsg('');
    setLinkErrorMsg('');

    try {
      const res = await apiFetch(`/crm/kiosk/lookup?phone=${encodeURIComponent(norm)}&locationId=${encodeURIComponent(selectedLocId)}`);
      if (res.found && res.customer) {
        setActiveCustomer(res.customer);
        setTransactions(res.transactions || []);
      } else {
        // Not found: prompt to join with prefilled phone
        setActiveCustomer(null);
        setTransactions([]);
        setJoinForm((f) => ({
          ...f,
          phone: norm,
          fullName: '',
          email: '',
          preferences: '',
        }));
        setShowJoinForm(true);
      }
    } catch (e: any) {
      setSearchError(e.message || 'Error looking up customer profile');
    } finally {
      setIsSearching(false);
    }
  };

  // Join Loyalty Program
  const handleJoinProgram = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!joinForm.fullName.trim()) {
      setSearchError('Please provide your full name');
      return;
    }
    if (!isValidPhPhoneNumber(joinForm.phone)) {
      setSearchError('Valid 11-digit mobile number required (09XXXXXXXXX)');
      return;
    }

    setIsSubmittingJoin(true);
    setSearchError('');
    try {
      const res = await apiFetch('/crm/kiosk/join', {
        method: 'POST',
        body: JSON.stringify({
          fullName: joinForm.fullName.trim(),
          phone: joinForm.phone.trim(),
          email: joinForm.email.trim() || undefined,
          preferences: joinForm.preferences.trim() || undefined,
          locationId: selectedLocId,
          autoLinkRecentSales: joinForm.autoLinkRecentSales,
        }),
      });

      if (res.ok && res.customer) {
        setActiveCustomer(res.customer);
        setTransactions(res.transactions || []);
        setShowJoinForm(false);
        setIsNewJoinSuccess(true);
        if (onCustomerSelected) {
          onCustomerSelected(res.customer);
        }
      }
    } catch (e: any) {
      setSearchError(e.message || 'Unable to join loyalty program');
    } finally {
      setIsSubmittingJoin(false);
    }
  };

  // Link Transaction to Current Customer
  const handleLinkTransaction = async (receiptNumToLink?: string) => {
    const recNum = receiptNumToLink || linkReceiptInput;
    if (!activeCustomer || !recNum.trim()) return;

    setIsLinkingReceipt(true);
    setLinkErrorMsg('');
    setLinkSuccessMsg('');

    try {
      const res = await apiFetch('/crm/customers/link-sale', {
        method: 'POST',
        body: JSON.stringify({
          customerId: activeCustomer.id,
          receiptNumber: recNum.trim().toUpperCase(),
        }),
      });

      if (res.ok) {
        setLinkSuccessMsg(`Linked receipt ${res.receiptNumber}! Awarded +${res.pointsAwarded} loyalty points.`);
        setLinkReceiptInput('');
        // Refresh customer profile
        handlePhoneLookup(activeCustomer.phone);
        if (kioskTab === 'linker') {
          loadUnlinkedSales();
        }
      }
    } catch (e: any) {
      setLinkErrorMsg(e.message || 'Failed to link transaction');
    } finally {
      setIsLinkingReceipt(false);
    }
  };

  // Keypad click handler for physical counter touchscreen
  const handleKeypadPress = (val: string) => {
    if (val === 'CLEAR') {
      setPhoneInput('');
      setActiveCustomer(null);
      setShowJoinForm(false);
      setSearchError('');
    } else if (val === 'BACK') {
      setPhoneInput((p) => p.slice(0, -1));
    } else {
      if (phoneInput.length < 11) {
        setPhoneInput((p) => p + val);
      }
    }
  };

  // Tier info for active customer
  const currentTierConfig = activeCustomer ? TIER_CONFIGS[activeCustomer.tier] : TIER_CONFIGS.STANDARD;
  const tierProgress = activeCustomer ? pointsToNextTier(activeCustomer.loyaltyPoints) : null;

  return (
    <div className={`space-y-6 ${mode === 'standalone' ? 'min-h-screen bg-slate-50 dark:bg-slate-950 p-4 sm:p-8 max-w-5xl mx-auto' : ''}`}>
      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500 text-white shadow-sm">
              <Award className="h-4 w-4" />
            </span>
            <h1 className="font-display text-xl sm:text-2xl font-semibold text-slate-900 dark:text-slate-50">
              Customer Loyalty Kiosk
            </h1>
          </div>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            POS counter QR standee, phone-based member lookup, and automatic transaction history linking
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Location Selector */}
          <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs text-slate-700 dark:text-slate-200">
            <span className="text-slate-500 dark:text-slate-400">Truck / Counter:</span>
            <select
              value={selectedLocId}
              onChange={(e) => setSelectedLocId(e.target.value)}
              className="bg-transparent font-medium text-slate-900 dark:text-slate-50 focus:outline-none"
            >
              <option value="ALL">All Branches / Global</option>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.name}
                </option>
              ))}
            </select>
          </div>

          <ThemeToggle variant="header" />

          {onExit && (
            <button
              type="button"
              onClick={onExit}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Exit Kiosk
            </button>
          )}
        </div>
      </div>

      {/* Navigation Sub-Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3 no-print">
        <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800 p-1 text-xs">
          <button
            type="button"
            onClick={() => setKioskTab('standee')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-all ${
              kioskTab === 'standee'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50 shadow-sm font-semibold'
                : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <QrCode className="w-3.5 h-3.5" />
            POS Counter Standee (QR Code)
          </button>
          <button
            type="button"
            onClick={() => setKioskTab('terminal')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-all ${
              kioskTab === 'terminal'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50 shadow-sm font-semibold'
                : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <Smartphone className="w-3.5 h-3.5" />
            Customer Touchscreen Terminal
          </button>
          <button
            type="button"
            onClick={() => setKioskTab('linker')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-all ${
              kioskTab === 'linker'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50 shadow-sm font-semibold'
                : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <LinkIcon className="w-3.5 h-3.5" />
            Transaction Linker ({unlinkedSales.length} unlinked)
          </button>
        </div>

        {kioskTab === 'standee' && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(kioskUrl).then(() => {
                  setCopiedLink(true);
                  window.setTimeout(() => setCopiedLink(false), 2000);
                });
              }}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
            >
              {copiedLink ? <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />}
              {copiedLink ? 'Copied Link' : 'Copy Kiosk Link'}
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-3 py-1.5 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white transition-colors shadow-sm"
            >
              <Printer className="w-3.5 h-3.5" />
              Print Table Tent Standee
            </button>
          </div>
        )}
      </div>

      {/* TAB 1: POS COUNTER QR STANDEE */}
      {kioskTab === 'standee' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Visual Printable Standee */}
          <div className="lg:col-span-7 flex flex-col items-center">
            <div
              id="kiosk-printable-standee"
              className="w-full max-w-md rounded-2xl border-2 border-slate-900 dark:border-slate-100 bg-gradient-to-b from-amber-50/40 via-white to-white dark:from-amber-950/30 dark:via-slate-900 dark:to-slate-900 p-6 sm:p-8 text-center shadow-xl space-y-5"
            >
              {/* Standee Header */}
              <div className="space-y-1">
                <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-900 dark:text-amber-300">
                  <Flame className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                  MAXIMUS SMOKEHOUSE &amp; BBQ
                </div>
                <h2 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
                  Join Our Loyalty Club
                </h2>
                <p className="text-xs text-slate-600 dark:text-slate-300 font-medium">
                  {selectedLocName}
                </p>
              </div>

              {/* QR Code Container (white quiet zone preserved for reliable camera scan) */}
              <div className="relative mx-auto w-64 h-64 rounded-2xl border-2 border-dashed border-amber-300 dark:border-amber-700/80 bg-white p-3 shadow-inner flex items-center justify-center">
                {qrDataUrl ? (
                  <img
                    src={qrDataUrl}
                    alt="Scan to join Maximus Barbecue Loyalty"
                    className="w-full h-full object-contain rounded-xl"
                  />
                ) : (
                  <div className="text-xs text-slate-500 animate-pulse">Generating Kiosk QR...</div>
                )}
                {/* Center Logo Overlay Icon */}
                <div className="absolute inset-0 m-auto w-12 h-12 rounded-xl bg-amber-500 text-white flex items-center justify-center shadow-md border-2 border-white pointer-events-none">
                  <Award className="w-6 h-6" />
                </div>
              </div>

              {/* Reward Highlights */}
              <div className="space-y-2">
                <div className="rounded-xl bg-amber-50 dark:bg-amber-950/45 border border-amber-200/80 p-3 text-xs text-amber-900 dark:text-amber-300 font-medium space-y-1">
                  <div className="flex items-center justify-center gap-1 font-bold text-amber-950 dark:text-amber-300">
                    <Sparkles className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                    <span>Instant 25 Welcome Points Upon Sign-Up</span>
                  </div>
                  <p className="text-[11px] text-amber-800 dark:text-amber-300">
                    Scan with any smartphone camera · ₱50 spend = 1 Loyalty Point
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2 text-left text-[11px]">
                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/70 p-2">
                    <span className="font-semibold text-slate-900 dark:text-slate-50 block">Grill Enthusiast</span>
                    <span className="text-slate-500 dark:text-slate-400">100 pts · 5% off sides &amp; drinks</span>
                  </div>
                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/70 p-2">
                    <span className="font-semibold text-slate-900 dark:text-slate-50 block">Smokehouse Master</span>
                    <span className="text-slate-500 dark:text-slate-400">250 pts · 10% off entire order</span>
                  </div>
                </div>
              </div>

              {/* Instructions Callout */}
              <div className="border-t border-dashed border-slate-200 dark:border-slate-800 pt-3 text-[11px] text-slate-500 dark:text-slate-400 flex items-center justify-center gap-2">
                <Phone className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
                <span>Link your mobile number to view past orders &amp; digital receipts</span>
              </div>
            </div>

            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400 no-print">
              Display this standee at your food truck order counter or cash register.
            </p>
          </div>

          {/* Standee Configuration & Guidelines */}
          <div className="lg:col-span-5 space-y-5 no-print">
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
              <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50 flex items-center gap-2">
                <QrCode className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                How the Counter Kiosk Works
              </h3>
              <ol className="list-decimal list-inside space-y-2.5 text-xs text-slate-600 dark:text-slate-300">
                <li className="leading-relaxed">
                  <strong className="font-semibold text-slate-900 dark:text-slate-50">Customer Scans:</strong> At the food truck counter, the customer scans this QR code with their mobile phone camera (iOS/Android).
                </li>
                <li className="leading-relaxed">
                  <strong className="font-semibold text-slate-900 dark:text-slate-50">Mobile Phone Entry:</strong> They enter their 11-digit mobile phone number (e.g. 0917 123 4567).
                </li>
                <li className="leading-relaxed">
                  <strong className="font-semibold text-slate-900 dark:text-slate-50">Automatic Linking:</strong> If they're a new customer, they claim <span className="font-semibold text-amber-700 dark:text-amber-300">25 Welcome Points</span> and their profile is created. If they have unlinked orders from today, they link instantly!
                </li>
                <li className="leading-relaxed">
                  <strong className="font-semibold text-slate-900 dark:text-slate-50">Points &amp; Receipts:</strong> The customer can immediately view their points balance, tier discounts, and linked transaction receipts.
                </li>
              </ol>

              <div className="pt-2 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between text-xs">
                <span className="text-slate-500 dark:text-slate-400">Target URL:</span>
                <a
                  href={kioskUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-amber-700 dark:text-amber-300 hover:underline flex items-center gap-1 text-[11px]"
                >
                  {kioskUrl.slice(0, 32)}...
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>

            {/* Loyalty Program Tier Matrix */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
              <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50 flex items-center gap-2">
                <Award className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                Active Loyalty Tier Matrix
              </h3>
              <div className="space-y-2 text-xs">
                {Object.values(TIER_CONFIGS).map((t) => (
                  <div key={t.code} className="flex items-start justify-between p-2.5 rounded-lg border border-slate-100 dark:border-slate-800/80 bg-slate-50/50 dark:bg-slate-800/50">
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold ${t.badgeBg} ${t.badgeText}`}>
                          {t.name}
                        </span>
                        <span className="text-slate-500 dark:text-slate-400 font-mono text-[11px]">({t.minPoints}+ pts)</span>
                      </div>
                      <p className="mt-1 text-[11px] text-slate-600 dark:text-slate-300">{t.perks.join(' · ')}</p>
                    </div>
                    {t.discountPct > 0 && (
                      <span className="font-mono font-semibold text-emerald-700 dark:text-emerald-300 text-xs shrink-0">
                        {t.discountPct}% OFF
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: TOUCHSCREEN KIOSK TERMINAL (For Counter Tablets / Customer Mobile) */}
      {kioskTab === 'terminal' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Column: Phone Entry & Touch Keypad */}
          <div className="lg:col-span-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
            <div>
              <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50 flex items-center gap-2">
                <Smartphone className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                Check In / Join Loyalty
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Enter customer's 11-digit mobile phone number
              </p>
            </div>

            {/* Phone Display Input */}
            <div className="relative">
              <div className="flex items-center rounded-xl border-2 border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/70 px-3.5 py-3 text-lg font-mono text-slate-900 dark:text-slate-50 focus-within:border-amber-500 focus-within:bg-white shadow-inner">
                <span className="text-sm font-semibold text-slate-500 dark:text-slate-400 mr-2 flex items-center gap-1">
                  🇵🇭 +63
                </span>
                <input
                  type="tel"
                  value={phoneInput}
                  onChange={(e) => setPhoneInput(normalizePhoneNumber(e.target.value))}
                  placeholder="0917 123 4567"
                  className="w-full bg-transparent font-mono tracking-wider text-slate-900 dark:text-slate-50 focus:outline-none placeholder:text-slate-300 text-base sm:text-lg"
                  maxLength={11}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handlePhoneLookup();
                  }}
                />
                {phoneInput && (
                  <button
                    type="button"
                    onClick={() => setPhoneInput('')}
                    className="p-1 text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>

            {searchError && (
              <div className="p-2.5 rounded-lg border border-red-200 dark:border-red-800/80 bg-red-50 dark:bg-red-950/50 text-xs text-red-700 dark:text-red-300 font-medium">
                {searchError}
              </div>
            )}

            {/* Touchpad / Number Keypad for Tablets & Counter Display */}
            <div className="grid grid-cols-3 gap-2">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'CLEAR', '0', 'BACK'].map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => handleKeypadPress(key)}
                  className={`h-12 rounded-lg text-sm font-semibold transition-all active:scale-95 shadow-sm border ${
                    key === 'CLEAR'
                      ? 'border-red-200 dark:border-red-800/80 bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/60'
                      : key === 'BACK'
                      ? 'border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700'
                      : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50 hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                >
                  {key === 'BACK' ? '⌫' : key}
                </button>
              ))}
            </div>

            <button
              type="button"
              disabled={isSearching || phoneInput.length < 10}
              onClick={() => handlePhoneLookup()}
              className="w-full h-11 rounded-lg bg-amber-600 py-2.5 text-xs font-semibold text-white hover:bg-amber-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5 shadow-sm"
            >
              {isSearching ? (
                <span className="animate-pulse">Checking Member Database...</span>
              ) : (
                <>
                  <Search className="w-4 h-4" />
                  Look Up / Check In
                </>
              )}
            </button>
          </div>

          {/* Right Column: Member Profile, Onboarding Form, or Transaction History */}
          <div className="lg:col-span-7 space-y-4">
            {/* Case A: Existing Member Profile & Linked Transactions */}
            {activeCustomer && (
              <div className="space-y-4">
                {/* Member Profile Card */}
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="font-display text-lg font-bold text-slate-900 dark:text-slate-50">
                          {activeCustomer.fullName}
                        </h2>
                        <span className={`inline-flex px-2 py-0.5 rounded text-xs font-bold ${currentTierConfig.badgeBg} ${currentTierConfig.badgeText}`}>
                          {currentTierConfig.name}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 font-mono">
                        {formatPhoneNumber(activeCustomer.phone)} {activeCustomer.email ? `· ${activeCustomer.email}` : ''}
                      </p>
                    </div>

                    <div className="text-right">
                      <span className="text-[11px] text-slate-500 dark:text-slate-400 font-medium block">Loyalty Balance</span>
                      <span className="text-2xl font-bold font-mono text-amber-700 dark:text-amber-300 tabular-nums">
                        {activeCustomer.loyaltyPoints}
                      </span>
                      <span className="text-xs text-slate-500 dark:text-slate-400 ml-1">pts</span>
                    </div>
                  </div>

                  {/* Tier Progress Bar */}
                  {tierProgress && tierProgress.nextTier && (
                    <div className="rounded-lg bg-slate-50 dark:bg-slate-800/70 p-3 border border-slate-100 dark:border-slate-800/80 space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-slate-600 dark:text-slate-300 font-medium">
                          Next Tier: <strong className="text-slate-900 dark:text-slate-50">{TIER_CONFIGS[tierProgress.nextTier].name}</strong>
                        </span>
                        <span className="font-mono text-amber-800 dark:text-amber-300 font-semibold">
                          {tierProgress.neededPoints} pts away
                        </span>
                      </div>
                      <div className="w-full h-2 rounded-full bg-slate-200 overflow-hidden">
                        <div
                          className="h-full bg-amber-500 rounded-full transition-all duration-500"
                          style={{ width: `${tierProgress.progressPct}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Perks Summary */}
                  <div className="text-xs text-slate-600 dark:text-slate-300 flex flex-wrap gap-2 pt-1">
                    {currentTierConfig.perks.map((perk, i) => (
                      <span key={i} className="inline-flex items-center gap-1 rounded bg-slate-100 dark:bg-slate-800 px-2 py-1 text-[11px] text-slate-700 dark:text-slate-200">
                        <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                        {perk}
                      </span>
                    ))}
                  </div>

                  {/* Actions Bar */}
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-slate-100 dark:border-slate-800/80">
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      Lifetime Spend: <strong className="text-slate-900 dark:text-slate-50 font-mono tabular-nums">{formatPHP(activeCustomer.lifetimeSpend)}</strong> ({activeCustomer.totalOrders} visits)
                    </div>
                    {onCustomerSelected && (
                      <button
                        type="button"
                        onClick={() => onCustomerSelected(activeCustomer)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 transition-colors shadow-sm"
                      >
                        <Check className="w-3.5 h-3.5" />
                        Use Member in Current POS Cart
                      </button>
                    )}
                  </div>
                </div>

                {/* Manual Receipt Linker Box */}
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-2">
                  <div className="flex items-center justify-between text-xs font-semibold text-slate-900 dark:text-slate-50">
                    <span className="flex items-center gap-1.5">
                      <Receipt className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                      Link a Past Transaction to this Member
                    </span>
                    <span className="text-[11px] text-slate-500 dark:text-slate-400 font-normal">Earn 1 pt per ₱50 spent</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={linkReceiptInput}
                      onChange={(e) => setLinkReceiptInput(e.target.value.toUpperCase())}
                      placeholder="e.g. REC-20261124-001"
                      className="flex-1 rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-1.5 text-xs font-mono uppercase text-slate-900 dark:text-slate-50 focus:outline-none focus:ring-1 focus:ring-amber-500"
                    />
                    <button
                      type="button"
                      disabled={isLinkingReceipt || !linkReceiptInput.trim()}
                      onClick={() => handleLinkTransaction()}
                      className="rounded-lg bg-slate-900 dark:bg-slate-100 px-3 py-1.5 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white transition-colors disabled:opacity-50"
                    >
                      {isLinkingReceipt ? 'Linking...' : 'Link Order'}
                    </button>
                  </div>
                  {linkSuccessMsg && (
                    <p className="text-xs text-emerald-700 dark:text-emerald-300 font-medium">{linkSuccessMsg}</p>
                  )}
                  {linkErrorMsg && (
                    <p className="text-xs text-red-600 dark:text-red-300 font-medium">{linkErrorMsg}</p>
                  )}
                </div>

                {/* Linked Transaction History List */}
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-sm">
                  <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                    <div>
                      <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-50">Linked Transaction History</h4>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">Orders linked to {formatPhoneNumber(activeCustomer.phone)}</p>
                    </div>
                    <span className="text-xs font-mono text-slate-500 dark:text-slate-400">{transactions.length} record(s)</span>
                  </div>

                  {transactions.length === 0 ? (
                    <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
                      No past transactions linked yet. Orders made at the POS counter with this phone number or customer profile will appear here.
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-96 overflow-y-auto">
                      {transactions.map((txn) => {
                        const isExpanded = expandedTxnId === txn.id;
                        return (
                          <div key={txn.id} className="p-3.5 hover:bg-slate-50/80 dark:hover:bg-slate-800/80 transition-colors text-xs space-y-2">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className="font-mono font-semibold text-slate-900 dark:text-slate-50">{txn.receiptNumber}</span>
                                  <span className="text-[10px] text-slate-500 dark:text-slate-400 font-normal">· {txn.locationName}</span>
                                </div>
                                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                                  {txn.soldAt ? new Date(txn.soldAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '—'} · {txn.paymentMethod}
                                </p>
                              </div>
                              <div className="text-right">
                                <span className="font-mono font-bold text-slate-900 dark:text-slate-50 tabular-nums block">
                                  {formatPHP(txn.totalAmount)}
                                </span>
                                <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
                                  +{txn.pointsEarned} pts
                                </span>
                              </div>
                            </div>

                            <div className="flex items-center justify-between text-[11px] text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/70 p-2 rounded">
                              <span className="truncate max-w-[280px]" title={txn.itemsSummary}>
                                {txn.itemsSummary || `${txn.itemsCount} items`}
                              </span>
                              {txn.items && txn.items.length > 0 && (
                                <button
                                  type="button"
                                  onClick={() => setExpandedTxnId(isExpanded ? null : txn.id)}
                                  className="text-amber-800 dark:text-amber-300 font-medium hover:underline flex items-center gap-0.5 shrink-0"
                                >
                                  {isExpanded ? 'Hide' : 'Items'}
                                  {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                                </button>
                              )}
                            </div>

                            {/* Itemized details */}
                            {isExpanded && txn.items && (
                              <div className="rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2.5 space-y-1 text-[11px]">
                                {txn.items.map((it, idx) => (
                                  <div key={idx} className="flex items-center justify-between text-slate-700 dark:text-slate-200">
                                    <span>
                                      {it.quantity}x {it.name}
                                    </span>
                                    <span className="font-mono tabular-nums">{formatPHP(it.lineTotal)}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Case B: New Customer Join Form */}
            {showJoinForm && (
              <div className="rounded-xl border border-amber-200 dark:border-amber-700/80 bg-white dark:bg-slate-900 p-5 space-y-4 shadow-md">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 dark:bg-amber-950/75 px-2.5 py-0.5 text-xs font-semibold text-amber-900 dark:text-amber-300 mb-1">
                      <Sparkles className="w-3.5 h-3.5 text-amber-700 dark:text-amber-300" />
                      New Customer Registration
                    </div>
                    <h3 className="font-display text-lg font-bold text-slate-900 dark:text-slate-50">
                      Join Maximus Loyalty Club
                    </h3>
                    <p className="text-xs text-slate-600 dark:text-slate-300">
                      Mobile number <strong className="font-mono text-slate-900 dark:text-slate-50">{formatPhoneNumber(joinForm.phone)}</strong> is not yet enrolled. Register now to claim your welcome bonus!
                    </p>
                  </div>
                  <div className="text-right">
                    <span className="inline-flex items-center px-2 py-1 rounded bg-amber-500 text-white text-xs font-bold shadow-sm">
                      +25 Welcome Pts
                    </span>
                  </div>
                </div>

                <form onSubmit={handleJoinProgram} className="space-y-3.5 pt-2 border-t border-slate-100 dark:border-slate-800/80">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-200 mb-1">Full Name *</label>
                    <input
                      required
                      type="text"
                      placeholder="e.g. Maria Santos"
                      value={joinForm.fullName}
                      onChange={(e) => setJoinForm({ ...joinForm, fullName: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs text-slate-900 dark:text-slate-50 focus:outline-none focus:ring-1 focus:ring-amber-500"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-200 mb-1">Mobile Phone *</label>
                      <input
                        required
                        type="tel"
                        value={joinForm.phone}
                        onChange={(e) => setJoinForm({ ...joinForm, phone: normalizePhoneNumber(e.target.value) })}
                        className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-50 bg-slate-50 dark:bg-slate-800/70 focus:outline-none focus:ring-1 focus:ring-amber-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-200 mb-1">Email Address (Optional)</label>
                      <input
                        type="email"
                        placeholder="e.g. maria@email.com"
                        value={joinForm.email}
                        onChange={(e) => setJoinForm({ ...joinForm, email: e.target.value })}
                        className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs text-slate-900 dark:text-slate-50 focus:outline-none focus:ring-1 focus:ring-amber-500"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-200 mb-1">BBQ Preferences / Dietary Notes</label>
                    <input
                      type="text"
                      placeholder="e.g. Extra spicy, sweet BBQ glaze, no pork"
                      value={joinForm.preferences}
                      onChange={(e) => setJoinForm({ ...joinForm, preferences: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs text-slate-900 dark:text-slate-50 focus:outline-none focus:ring-1 focus:ring-amber-500"
                    />
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <input
                      type="checkbox"
                      id="autoLinkCheck"
                      checked={joinForm.autoLinkRecentSales}
                      onChange={(e) => setJoinForm({ ...joinForm, autoLinkRecentSales: e.target.checked })}
                      className="rounded border-slate-300 dark:border-slate-700 text-amber-600 dark:text-amber-400 focus:ring-amber-500"
                    />
                    <label htmlFor="autoLinkCheck" className="text-xs text-slate-600 dark:text-slate-300 select-none">
                      Automatically link any unlinked orders at this counter to credit points right away
                    </label>
                  </div>

                  <div className="flex items-center gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setShowJoinForm(false)}
                      className="w-1/3 rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isSubmittingJoin}
                      className="w-2/3 rounded-lg bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-700 shadow-sm flex items-center justify-center gap-1.5 disabled:opacity-50"
                    >
                      {isSubmittingJoin ? 'Registering Member...' : 'Complete Join & Claim 25 Pts'}
                    </button>
                  </div>
                </form>
              </div>
            )}

            {/* Case C: Idle state instructions */}
            {!activeCustomer && !showJoinForm && (
              <div className="rounded-xl border border-dashed border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center space-y-3">
                <Smartphone className="w-10 h-10 text-slate-400 dark:text-slate-500 mx-auto" />
                <div className="space-y-1">
                  <h4 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50">
                    Awaiting Customer Phone Entry
                  </h4>
                  <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mx-auto">
                    Type a customer's 11-digit mobile number using the keypad to inspect their loyalty status, claim rewards, or register a new member.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: TRANSACTION LINKER (Staff Tool) */}
      {kioskTab === 'linker' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50 flex items-center gap-2">
                  <LinkIcon className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                  Link Walk-In Orders to Customer Loyalty Profiles
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Select any unlinked transaction from this food truck and attribute it to a customer's phone number to credit loyalty points retroactively
                </p>
              </div>
              <button
                type="button"
                onClick={loadUnlinkedSales}
                disabled={isLoadingUnlinked}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <RotateCcw className={`w-3.5 h-3.5 text-slate-500 dark:text-slate-400 ${isLoadingUnlinked ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>

            {unlinkedSales.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
                No unlinked transactions found for the selected location. All recent orders have been attributed to customer profiles!
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
                    <tr>
                      <th className="p-3 font-medium">Receipt #</th>
                      <th className="p-3 font-medium">Date &amp; Time</th>
                      <th className="p-3 font-medium">Location</th>
                      <th className="p-3 font-medium text-right">Order Amount</th>
                      <th className="p-3 font-medium text-right">Points Value</th>
                      <th className="p-3 font-medium">Customer Mobile to Link</th>
                      <th className="p-3 font-medium text-center">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {unlinkedSales.map((s) => (
                      <tr key={s.id} className="hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                        <td className="p-3 font-mono font-semibold text-slate-900 dark:text-slate-50">{s.receiptNumber}</td>
                        <td className="p-3 text-slate-600 dark:text-slate-300 font-mono text-[11px] whitespace-nowrap">
                          {s.soldAt ? new Date(s.soldAt).toLocaleString('en-PH', { dateStyle: 'short', timeStyle: 'short' }) : '—'}
                        </td>
                        <td className="p-3 text-slate-700 dark:text-slate-200">{s.locationName}</td>
                        <td className="p-3 text-right font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-50">
                          {formatPHP(s.totalAmount)}
                        </td>
                        <td className="p-3 text-right font-mono tabular-nums text-amber-700 dark:text-amber-300 font-semibold">
                          +{s.pointsEligible} pts
                        </td>
                        <td className="p-3">
                          <input
                            type="tel"
                            placeholder="09XXXXXXXXX"
                            id={`link-phone-${s.id}`}
                            className="w-36 rounded border border-slate-200 dark:border-slate-800 px-2 py-1 text-xs font-mono bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                          />
                        </td>
                        <td className="p-3 text-center">
                          <button
                            type="button"
                            onClick={async () => {
                              const inputEl = document.getElementById(`link-phone-${s.id}`) as HTMLInputElement | null;
                              const phoneVal = inputEl?.value || '';
                              if (!phoneVal) {
                                alert('Please enter customer phone number');
                                return;
                              }
                              try {
                                const res = await apiFetch('/crm/customers/link-sale', {
                                  method: 'POST',
                                  body: JSON.stringify({
                                    phone: phoneVal,
                                    receiptNumber: s.receiptNumber,
                                  }),
                                });
                                alert(`Linked to customer! Awarded +${res.pointsAwarded} points.`);
                                loadUnlinkedSales();
                              } catch (e: any) {
                                alert(e.message || 'Error linking transaction');
                              }
                            }}
                            className="inline-flex items-center gap-1 rounded bg-slate-900 dark:bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white"
                          >
                            <LinkIcon className="w-3 h-3" />
                            Link Order
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
