import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  ChefHat,
  Info,
  Megaphone,
  MonitorSmartphone,
  Pencil,
  Pin,
  Plus,
  Send,
  ShieldAlert,
  ShoppingCart,
  Smartphone,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { apiFetch } from '../lib/api.ts';
import {
  ALL_HUDDLE_CHANNELS,
  canBroadcastDailyHuddle,
  DailyHuddleItem,
  formatChannelLabel,
  formatShiftWindowLabel,
  HUDDLE_PRESETS,
  HuddleChannel,
  HuddlePriority,
  HuddleShiftWindow,
  isHuddleExpired,
} from '../lib/dailyHuddle.ts';
import { AuthUser, LocationRow } from '../types/erp.ts';

interface Props {
  user?: AuthUser;
  locations: LocationRow[];
  selectedLocationId?: string;
  huddles: DailyHuddleItem[];
  onAcknowledge: (huddleId: string) => Promise<void> | void;
  onHuddlesChanged?: () => Promise<void> | void;
}

export function DailyHuddleModule({
  user,
  locations,
  selectedLocationId,
  huddles,
  onAcknowledge,
  onHuddlesChanged,
}: Props) {
  const canBroadcast = canBroadcastDailyHuddle(user);
  const [showComposer, setShowComposer] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filterTab, setFilterTab] = useState<'active' | 'archived' | 'all'>('active');

  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [priority, setPriority] = useState<HuddlePriority>('NORMAL');
  const [shiftWindow, setShiftWindow] = useState<HuddleShiftWindow>('ALL_DAY');
  const [targetLocationId, setTargetLocationId] = useState<string>(selectedLocationId || '');
  const [targetChannels, setTargetChannels] = useState<HuddleChannel[]>([...ALL_HUDDLE_CHANNELS]);
  const [ttlHours, setTtlHours] = useState<number>(18);
  const [isPinned, setIsPinned] = useState(true);

  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

  const now = new Date();

  const scopedHuddles = useMemo(() => {
    const loc = selectedLocationId && selectedLocationId !== 'ALL' ? selectedLocationId : '';
    return huddles.filter((h) => !loc || !h.locationId || h.locationId === loc);
  }, [huddles, selectedLocationId]);

  const activeCount = useMemo(
    () => scopedHuddles.filter((h) => h.isActive && !isHuddleExpired(h, now)).length,
    [scopedHuddles, now],
  );
  const archivedCount = scopedHuddles.length - activeCount;

  const visibleHuddles = useMemo(() => {
    return scopedHuddles.filter((h) => {
      const currentlyActive = h.isActive && !isHuddleExpired(h, now);
      if (filterTab === 'active') return currentlyActive;
      if (filterTab === 'archived') return !currentlyActive;
      return true;
    });
  }, [scopedHuddles, filterTab, now]);

  const resetForm = () => {
    setEditingId(null);
    setTitle('');
    setMessage('');
    setPriority('NORMAL');
    setShiftWindow('ALL_DAY');
    setTargetLocationId(selectedLocationId || '');
    setTargetChannels([...ALL_HUDDLE_CHANNELS]);
    setTtlHours(18);
    setIsPinned(true);
  };

  const openNewComposer = () => {
    resetForm();
    setFeedback(null);
    setShowComposer(true);
  };

  const openEditComposer = (h: DailyHuddleItem) => {
    setEditingId(h.id);
    setTitle(h.title);
    setMessage(h.message);
    setPriority(h.priority);
    setShiftWindow(h.shiftWindow);
    setTargetLocationId(h.locationId || '');
    setTargetChannels(h.targetChannels.length ? [...h.targetChannels] : [...ALL_HUDDLE_CHANNELS]);
    setIsPinned(h.isPinned);
    setTtlHours(18);
    setFeedback(null);
    setShowComposer(true);
  };

  const applyPreset = (presetId: string) => {
    const preset = HUDDLE_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setTitle(preset.title);
    setMessage(preset.message);
    setPriority(preset.priority);
    setShiftWindow(preset.shiftWindow);
    setTargetChannels([...preset.targetChannels]);
  };

  const toggleChannel = (ch: HuddleChannel) => {
    setTargetChannels((prev) => {
      if (prev.includes(ch)) {
        return prev.length > 1 ? prev.filter((item) => item !== ch) : prev;
      }
      return [...prev, ch];
    });
  };

  const handleBroadcastSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canBroadcast) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      const payload = {
        title: title.trim(),
        message: message.trim(),
        priority,
        shiftWindow,
        locationId: targetLocationId || 'ALL',
        targetChannels,
        ttlHours,
        isPinned,
      };
      if (editingId) {
        await apiFetch(`/huddles/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        setFeedback({ type: 'ok', msg: 'Daily Huddle briefing updated across POS, KDS, and mobile interfaces.' });
      } else {
        await apiFetch('/huddles', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        setFeedback({
          type: 'ok',
          msg: `Broadcast sent live to ${targetChannels.map(formatChannelLabel).join(', ')}.`,
        });
      }
      resetForm();
      setShowComposer(false);
      await onHuddlesChanged?.();
    } catch (err: any) {
      setFeedback({ type: 'err', msg: err.message || 'Unable to broadcast briefing' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleQuickPatch = async (id: string, patch: Record<string, unknown>, okMsg: string) => {
    setBusyId(id);
    setFeedback(null);
    try {
      await apiFetch(`/huddles/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      setFeedback({ type: 'ok', msg: okMsg });
      await onHuddlesChanged?.();
    } catch (err: any) {
      setFeedback({ type: 'err', msg: err.message || 'Failed to update briefing' });
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (id: string) => {
    setBusyId(id);
    setFeedback(null);
    try {
      await apiFetch(`/huddles/${id}`, { method: 'DELETE' });
      setConfirmDeleteId(null);
      setFeedback({ type: 'ok', msg: 'Briefing removed.' });
      await onHuddlesChanged?.();
    } catch (err: any) {
      setFeedback({ type: 'err', msg: err.message || 'Failed to delete briefing' });
    } finally {
      setBusyId(null);
    }
  };

  const renderPriorityBadge = (prio: HuddlePriority) => {
    if (prio === 'CRITICAL') {
      return (
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-700 dark:text-red-300">
          <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
          Critical
        </span>
      );
    }
    if (prio === 'URGENT') {
      return (
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700 dark:text-amber-300">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          Urgent
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-slate-700 dark:text-slate-200">
        <Info className="w-3.5 h-3.5 shrink-0" />
        Routine
      </span>
    );
  };

  return (
    <section
      aria-label="Daily Huddle Operational Briefings"
      className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4 no-print"
    >
      {/* Module Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 shrink-0">
            <Megaphone className="w-5 h-5" />
          </div>
          <div>
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">Daily Huddle</h2>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              <span>Broadcast operational briefings live to POS, KDS, and mobile staff</span>
              <span aria-hidden="true" className="text-slate-400 dark:text-slate-500">·</span>
              <span className="font-mono tabular-nums text-slate-700 dark:text-slate-200 font-medium">
                {activeCount} active
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-800">
            {([
              { id: 'active', label: `Active (${activeCount})` },
              { id: 'archived', label: `Archived (${archivedCount})` },
              { id: 'all', label: `All (${scopedHuddles.length})` },
            ] as const).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilterTab(tab.id)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 font-mono tabular-nums ${
                  filterTab === tab.id ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50 shadow-xs' : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {canBroadcast && (
            <button
              type="button"
              onClick={showComposer ? () => { setShowComposer(false); resetForm(); } : openNewComposer}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-3.5 py-2 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white whitespace-nowrap shrink-0"
            >
              {showComposer ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
              {showComposer ? 'Close Composer' : 'Broadcast Briefing'}
            </button>
          )}
        </div>
      </div>

      {feedback && (
        <div
          className={`rounded-lg border px-3 py-2 text-xs font-medium ${
            feedback.type === 'ok'
              ? 'border-emerald-200 dark:border-emerald-700/80 bg-emerald-50 dark:bg-emerald-950/45 text-emerald-800 dark:text-emerald-300'
              : 'border-red-200 dark:border-red-800/80 bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300'
          }`}
        >
          {feedback.msg}
        </div>
      )}

      {/* Manager Broadcast Composer */}
      {showComposer && canBroadcast && (
        <form
          onSubmit={handleBroadcastSubmit}
          className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/70 p-4 space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-800 pb-2.5">
            <div>
              <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-50">
                {editingId ? 'Edit Operational Briefing' : 'New Daily Huddle Broadcast'}
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Appears immediately for all staff signed into selected interfaces
              </p>
            </div>
            {!editingId && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-slate-500 dark:text-slate-400 mr-1">Quick Templates:</span>
                {HUDDLE_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => applyPreset(preset.id)}
                    className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3.5">
            <div className="lg:col-span-7 space-y-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">
                  Briefing Headline
                </label>
                <input
                  type="text"
                  required
                  maxLength={140}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g., Dinner Rush Target, 86'd Items, or Truck Dispatch Focus"
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-50 focus:border-slate-400 dark:focus:border-slate-500 focus:outline-none"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300">
                    Operational Instructions
                  </label>
                  <span className="font-mono tabular-nums text-[11px] text-slate-500 dark:text-slate-400">
                    {message.length}/800
                  </span>
                </div>
                <textarea
                  required
                  rows={4}
                  maxLength={800}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Write concise shift priorities, prep instructions, promo callouts, or safety reminders..."
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-50 focus:border-slate-400 dark:focus:border-slate-500 focus:outline-none"
                />
              </div>
            </div>

            <div className="lg:col-span-5 space-y-3">
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Priority</label>
                  <select
                    value={priority}
                    onChange={(e) => setPriority(e.target.value as HuddlePriority)}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-2 text-xs text-slate-800 dark:text-slate-100"
                  >
                    <option value="NORMAL">Routine Brief</option>
                    <option value="URGENT">Urgent Focus</option>
                    <option value="CRITICAL">Critical Alert</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Shift Window</label>
                  <select
                    value={shiftWindow}
                    onChange={(e) => setShiftWindow(e.target.value as HuddleShiftWindow)}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-2 text-xs text-slate-800 dark:text-slate-100"
                  >
                    <option value="ALL_DAY">All Day</option>
                    <option value="OPENING">Opening Shift</option>
                    <option value="MID_DAY">Mid-Day Shift</option>
                    <option value="CLOSING">Closing Shift</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Target Location</label>
                  <select
                    value={targetLocationId}
                    onChange={(e) => setTargetLocationId(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-2 text-xs text-slate-800 dark:text-slate-100"
                  >
                    <option value="">All Trucks &amp; Commissary</option>
                    {locations.map((loc) => (
                      <option key={loc.id} value={loc.id}>
                        {loc.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Active Duration</label>
                  <select
                    value={ttlHours}
                    onChange={(e) => setTtlHours(Number(e.target.value))}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-2 text-xs text-slate-800 dark:text-slate-100"
                  >
                    <option value={8}>8 Hours (Single Shift)</option>
                    <option value={18}>18 Hours (Full Day)</option>
                    <option value={24}>24 Hours</option>
                    <option value={0}>Until Manually Archived</option>
                  </select>
                </div>
              </div>

              <div>
                <span className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1.5">
                  Broadcast Interfaces
                </span>
                <div className="grid grid-cols-3 gap-2">
                  {([
                    { id: 'POS', label: 'POS', icon: ShoppingCart },
                    { id: 'KDS', label: 'KDS', icon: ChefHat },
                    { id: 'MOBILE', label: 'Mobile', icon: Smartphone },
                  ] as const).map((ch) => {
                    const Icon = ch.icon;
                    const selected = targetChannels.includes(ch.id);
                    return (
                      <button
                        key={ch.id}
                        type="button"
                        onClick={() => toggleChannel(ch.id)}
                        className={`flex items-center justify-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs font-medium transition-colors whitespace-nowrap ${
                          selected
                            ? 'border-slate-900 dark:border-slate-100 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950'
                            : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                        }`}
                      >
                        <Icon className="w-3.5 h-3.5 shrink-0" />
                        <span>{ch.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-200 pt-0.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isPinned}
                  onChange={(e) => setIsPinned(e.target.checked)}
                />
                <span>Pin briefing to top of staff POS, KDS &amp; mobile screens</span>
              </label>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-1 border-t border-slate-200 dark:border-slate-800">
            <button
              type="button"
              onClick={() => {
                setShowComposer(false);
                resetForm();
              }}
              className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-4 py-2 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50"
            >
              <Send className="w-3.5 h-3.5" />
              {submitting ? 'Broadcasting...' : editingId ? 'Save Briefing' : 'Broadcast to Staff'}
            </button>
          </div>
        </form>
      )}

      {/* Briefings List */}
      {visibleHuddles.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 dark:border-slate-800 py-8 px-4 text-center space-y-2">
          <MonitorSmartphone className="w-6 h-6 text-slate-500 dark:text-slate-400 mx-auto" />
          <p className="text-xs font-medium text-slate-700 dark:text-slate-200">
            {filterTab === 'active'
              ? 'No active Daily Huddle briefings right now.'
              : filterTab === 'archived'
                ? 'No archived briefings yet.'
                : 'No Daily Huddle briefings posted yet.'}
          </p>
          {canBroadcast && filterTab === 'active' && !showComposer && (
            <button
              type="button"
              onClick={openNewComposer}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <Plus className="w-3.5 h-3.5" /> Post Shift Briefing
            </button>
          )}
        </div>
      ) : (
        <div className="divide-y divide-slate-100 dark:divide-slate-800 border-t border-slate-100 dark:border-slate-800/80">
          {visibleHuddles.map((h) => {
            const expired = isHuddleExpired(h, now);
            const isCurrentlyLive = h.isActive && !expired;
            const userAcked = Boolean(user?.id && h.acknowledgedBy.includes(user.id));
            const timeLabel = h.createdAt
              ? new Date(h.createdAt).toLocaleString('en-PH', {
                  month: 'short',
                  day: '2-digit',
                  hour: 'numeric',
                  minute: '2-digit',
                })
              : '';
            const cardTone = !isCurrentlyLive
              ? 'bg-slate-50/40 dark:bg-slate-800/40 opacity-75'
              : h.priority === 'CRITICAL'
                ? 'bg-red-50/40 dark:bg-red-950/50'
                : h.priority === 'URGENT'
                  ? 'bg-amber-50/40 dark:bg-amber-950/45'
                  : 'bg-white dark:bg-slate-900';

            return (
              <div key={h.id} className={`py-4 px-2 space-y-2.5 ${cardTone}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      {renderPriorityBadge(h.priority)}
                      {h.isPinned && isCurrentlyLive && (
                        <>
                          <span aria-hidden="true" className="text-slate-400 dark:text-slate-500">·</span>
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 dark:text-slate-300">
                            <Pin className="w-3 h-3" /> Pinned
                          </span>
                        </>
                      )}
                      {!isCurrentlyLive && (
                        <>
                          <span aria-hidden="true" className="text-slate-400 dark:text-slate-500">·</span>
                          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                            {expired ? 'Expired' : 'Archived'}
                          </span>
                        </>
                      )}
                      <span aria-hidden="true" className="text-slate-400 dark:text-slate-500">·</span>
                      <span className="text-slate-600 dark:text-slate-300">{formatShiftWindowLabel(h.shiftWindow)}</span>
                      <span aria-hidden="true" className="text-slate-400 dark:text-slate-500">·</span>
                      <span className="text-slate-600 dark:text-slate-300">{h.locationName || 'All Trucks & Commissary'}</span>
                      <span aria-hidden="true" className="text-slate-400 dark:text-slate-500">·</span>
                      <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                        {h.targetChannels.join(' / ')}
                      </span>
                    </div>

                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">{h.title}</h3>
                    <p className="text-xs text-slate-700 dark:text-slate-200 leading-relaxed whitespace-pre-line max-w-4xl">
                      {h.message}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                    {isCurrentlyLive && (
                      <button
                        type="button"
                        disabled={userAcked || busyId === h.id}
                        onClick={() => void onAcknowledge(h.id)}
                        className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium whitespace-nowrap ${
                          userAcked
                            ? 'border-emerald-200 dark:border-emerald-700/80 bg-emerald-50 dark:bg-emerald-950/45 text-emerald-700 dark:text-emerald-300'
                            : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800'
                        }`}
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        {userAcked ? 'Acknowledged' : 'Acknowledge'}
                      </button>
                    )}

                    {canBroadcast && (
                      <>
                        <button
                          type="button"
                          onClick={() => openEditComposer(h)}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                        >
                          <Pencil className="w-3 h-3" /> Edit
                        </button>

                        {isCurrentlyLive && (
                          <button
                            type="button"
                            disabled={busyId === h.id}
                            onClick={() =>
                              void handleQuickPatch(
                                h.id,
                                { isPinned: !h.isPinned },
                                h.isPinned ? 'Briefing unpinned.' : 'Briefing pinned.',
                              )
                            }
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                          >
                            <Pin className="w-3 h-3" />
                            {h.isPinned ? 'Unpin' : 'Pin'}
                          </button>
                        )}

                        <button
                          type="button"
                          disabled={busyId === h.id}
                          onClick={() =>
                            void handleQuickPatch(
                              h.id,
                              { isActive: !h.isActive, ttlHours: h.isActive ? undefined : 18 },
                              h.isActive ? 'Briefing ended and archived.' : 'Briefing reactivated.',
                            )
                          }
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                        >
                          <Archive className="w-3 h-3" />
                          {h.isActive ? 'End Brief' : 'Reactivate'}
                        </button>

                        {confirmDeleteId === h.id ? (
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              disabled={busyId === h.id}
                              onClick={() => void handleDelete(h.id)}
                              className="rounded-lg bg-red-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-red-700 whitespace-nowrap"
                            >
                              Confirm Delete
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-1.5 text-xs text-slate-600 dark:text-slate-300"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(h.id)}
                            aria-label={`Delete briefing ${h.title}`}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-1.5 text-xs text-slate-500 dark:text-slate-400 hover:text-red-700 dark:hover:text-red-300 hover:border-red-200 dark:hover:border-red-700"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400">
                  <span className="inline-flex items-center gap-1 font-mono tabular-nums text-slate-700 dark:text-slate-200">
                    <Users className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
                    {h.acknowledgedBy.length} acknowledged
                  </span>
                  <span aria-hidden="true" className="text-slate-400 dark:text-slate-500">·</span>
                  <span>
                    Posted by <strong className="font-medium text-slate-700 dark:text-slate-200">{h.authorName}</strong> ({h.authorRole})
                  </span>
                  {timeLabel && (
                    <>
                      <span aria-hidden="true" className="text-slate-400 dark:text-slate-500">·</span>
                      <span className="font-mono tabular-nums">{timeLabel}</span>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
