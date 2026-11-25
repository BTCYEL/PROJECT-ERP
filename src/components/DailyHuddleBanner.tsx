import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Info,
  Megaphone,
  ShieldAlert,
} from 'lucide-react';
import {
  DailyHuddleItem,
  filterActiveHuddlesForInterface,
  formatShiftWindowLabel,
  HuddleChannel,
} from '../lib/dailyHuddle.ts';
import { AuthUser } from '../types/erp.ts';

interface Props {
  huddles: DailyHuddleItem[];
  user: AuthUser;
  channel: HuddleChannel;
  locationId?: string | null;
  onAcknowledge: (huddleId: string) => Promise<void> | void;
  className?: string;
}

export function DailyHuddleBanner({
  huddles,
  user,
  channel,
  locationId,
  onAcknowledge,
  className = '',
}: Props) {
  const [isMobileViewport, setIsMobileViewport] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(max-width: 1023px)').matches;
  });
  const [expanded, setExpanded] = useState(false);
  const [ackingId, setAckingId] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(max-width: 1023px)');
    const onChange = () => setIsMobileViewport(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const activeForInterface = useMemo(
    () =>
      filterActiveHuddlesForInterface(huddles, {
        channel,
        includeMobileChannel: channel === 'MOBILE' || isMobileViewport,
        locationId,
      }),
    [huddles, channel, isMobileViewport, locationId],
  );

  if (activeForInterface.length === 0) return null;

  const unacknowledged = activeForInterface.filter((h) => !h.acknowledgedBy.includes(user.id));
  const primary = unacknowledged[0] || activeForInterface[0];
  const allAcknowledged = unacknowledged.length === 0;

  const handleAck = async (id: string) => {
    setAckingId(id);
    try {
      await onAcknowledge(id);
    } finally {
      setAckingId(null);
    }
  };

  const renderPriorityTag = (prio: DailyHuddleItem['priority']) => {
    if (prio === 'CRITICAL') {
      return (
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-700 dark:text-red-300 shrink-0">
          <ShieldAlert className="w-3.5 h-3.5" />
          Critical Brief
        </span>
      );
    }
    if (prio === 'URGENT') {
      return (
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700 dark:text-amber-300 shrink-0">
          <AlertTriangle className="w-3.5 h-3.5" />
          Urgent Brief
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-slate-700 dark:text-slate-200 shrink-0">
        <Info className="w-3.5 h-3.5" />
        Daily Huddle
      </span>
    );
  };

  if (allAcknowledged && !expanded) {
    return (
      <div
        className={`rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3.5 py-2 flex items-center justify-between gap-3 no-print ${className}`}
      >
        <div className="flex items-center gap-2 min-w-0 text-xs text-slate-600 dark:text-slate-300">
          <Megaphone className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400 shrink-0" />
          <span className="font-semibold text-slate-800 dark:text-slate-100 shrink-0">Daily Huddle</span>
          <span aria-hidden="true" className="text-slate-400 dark:text-slate-500">·</span>
          <span className="truncate">{primary.title}</span>
          <span aria-hidden="true" className="text-slate-400 dark:text-slate-500 hidden sm:inline">·</span>
          <span className="hidden sm:inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300 font-medium shrink-0">
            <CheckCircle2 className="w-3.5 h-3.5" /> Acknowledged
          </span>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
        >
          <span>View ({activeForInterface.length})</span>
          <ChevronDown className="w-3 h-3" />
        </button>
      </div>
    );
  }

  const containerTone =
    primary.priority === 'CRITICAL'
      ? 'border-red-200 dark:border-red-800/80 bg-red-50/70 dark:bg-red-950/50'
      : primary.priority === 'URGENT'
        ? 'border-amber-200 dark:border-amber-700/80 bg-amber-50/70 dark:bg-amber-950/45'
        : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900';

  const displayList = expanded ? activeForInterface : [primary];

  return (
    <section
      aria-label="Daily Huddle Staff Briefing"
      className={`rounded-xl border p-3.5 space-y-2.5 no-print ${containerTone} ${className}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs">
          <Megaphone className="w-4 h-4 text-slate-800 dark:text-slate-100 shrink-0" />
          <span className="font-display font-semibold text-slate-900 dark:text-slate-50">Manager Daily Huddle</span>
          <span aria-hidden="true" className="text-slate-400 dark:text-slate-500">·</span>
          <span className="font-mono tabular-nums text-[11px] text-slate-600 dark:text-slate-300">
            {unacknowledged.length > 0
              ? `${unacknowledged.length} unread of ${activeForInterface.length}`
              : `${activeForInterface.length} active`}
          </span>
        </div>

        {(activeForInterface.length > 1 || allAcknowledged) && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            {expanded ? (
              <>
                <span>Collapse</span>
                <ChevronUp className="w-3 h-3" />
              </>
            ) : (
              <>
                <span>All Briefings ({activeForInterface.length})</span>
                <ChevronDown className="w-3 h-3" />
              </>
            )}
          </button>
        )}
      </div>

      <div className="divide-y divide-slate-200/70 dark:divide-slate-800/80">
        {displayList.map((h) => {
          const isAcked = h.acknowledgedBy.includes(user.id);
          const timeLabel = h.createdAt
            ? new Date(h.createdAt).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })
            : '';
          return (
            <div key={h.id} className="py-2 first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-start justify-between gap-3">
              <div className="space-y-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {renderPriorityTag(h.priority)}
                  <span aria-hidden="true" className="text-slate-400 dark:text-slate-500">·</span>
                  <span className="text-slate-600 dark:text-slate-300">{formatShiftWindowLabel(h.shiftWindow)}</span>
                  <span aria-hidden="true" className="text-slate-400 dark:text-slate-500">·</span>
                  <span className="text-slate-600 dark:text-slate-300">{h.locationName || 'All Locations'}</span>
                  {timeLabel && (
                    <>
                      <span aria-hidden="true" className="text-slate-400 dark:text-slate-500">·</span>
                      <span className="font-mono tabular-nums text-[11px] text-slate-500 dark:text-slate-400">{timeLabel}</span>
                    </>
                  )}
                </div>
                <p className="text-xs sm:text-sm font-semibold text-slate-900 dark:text-slate-50">{h.title}</p>
                <p className="text-xs text-slate-700 dark:text-slate-200 leading-relaxed">{h.message}</p>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  From {h.authorName} ({h.authorRole})
                </p>
              </div>

              <div className="shrink-0 flex items-center">
                {isAcked ? (
                  <span className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 dark:border-emerald-700/80 bg-emerald-50 dark:bg-emerald-950/45 px-3 py-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300 whitespace-nowrap">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Acknowledged
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={ackingId === h.id}
                    onClick={() => void handleAck(h.id)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-3 py-1.5 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50 whitespace-nowrap"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    {ackingId === h.id ? 'Saving...' : 'Acknowledge'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
