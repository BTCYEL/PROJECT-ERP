import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock,
  Download,
  MessageSquare,
  Pencil,
  Plus,
  Search,
  Send,
  Settings,
  ShieldAlert,
  Smartphone,
  Trash2,
  Truck,
  Wrench,
  X,
} from 'lucide-react';
import { apiFetch, downloadCsv, formatPHP } from '../lib/api.ts';
import {
  addDaysToDateIso,
  FleetMaintenanceLog,
  formatMaintenanceCategory,
  getMaintenanceAlertInfo,
  getTodayDateIso,
  MAINTENANCE_CATEGORIES,
  MAINTENANCE_PRESETS,
  MaintenanceCategory,
  summarizeTruckMaintenance,
} from '../lib/fleetMaintenance.ts';

interface TruckRow {
  id: string;
  location_id: string;
  plate_number: string;
  make_model: string;
  status: string;
  odometer_km: number;
  location_name: string;
  location_code?: string;
}

export interface ManagerContact {
  id: string;
  name: string;
  role: string;
  phone: string;
  active: boolean;
}

export interface SmsDispatchLog {
  id: string;
  sentAt: string;
  truckName: string;
  serviceTitle: string;
  recipientName: string;
  recipientPhone: string;
  message: string;
  status: 'DELIVERED' | 'QUEUED' | 'FAILED';
}

interface Props {
  trucks: TruckRow[];
  maintenanceLogs: FleetMaintenanceLog[];
  activeLocationId?: string;
  preselectedTruckId?: string | null;
  onMaintenanceSaved: (message: string) => Promise<void> | void;
  onClearPreselect?: () => void;
}

export function FleetMaintenanceSection({
  trucks,
  maintenanceLogs,
  activeLocationId = 'ALL',
  preselectedTruckId,
  onMaintenanceSaved,
  onClearPreselect,
}: Props) {
  const [selectedTruckId, setSelectedTruckId] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ALERTS' | 'UPCOMING' | 'COMPLETED'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  const [modalOpen, setModalOpen] = useState<{ mode: 'create' | 'edit'; logId?: string } | null>(null);
  const [form, setForm] = useState({
    truckId: '',
    title: '',
    maintenanceCategory: 'ENGINE_OIL' as MaintenanceCategory,
    serviceProvider: '',
    serviceDate: getTodayDateIso(),
    nextDueDate: addDaysToDateIso(getTodayDateIso(), 90),
    alertLeadDays: '7',
    cost: '0',
    odometerKm: '',
    description: '',
    postExpense: true,
    setTruckStatus: 'KEEP' as 'KEEP' | 'ACTIVE' | 'MAINTENANCE',
  });
  const [saving, setSaving] = useState(false);
  const [modalErr, setModalErr] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState('');

  const [managerPhones, setManagerPhones] = useState<ManagerContact[]>(() => {
    try {
      const saved = localStorage.getItem('restosys_fleet_managers_v1');
      if (saved) return JSON.parse(saved);
    } catch {}
    return [
      { id: 'mgr_1', name: 'Ramon Bautista', role: 'Operations Manager', phone: '+63 917 555 1234', active: true },
      { id: 'mgr_2', name: 'Carlo Mendoza', role: 'Fleet & Logistics Lead', phone: '+63 918 444 8890', active: true },
    ];
  });

  const [smsLogs, setSmsLogs] = useState<SmsDispatchLog[]>(() => {
    try {
      const saved = localStorage.getItem('restosys_fleet_sms_logs_v1');
      if (saved) return JSON.parse(saved);
    } catch {}
    return [];
  });

  const [showSmsModal, setShowSmsModal] = useState(false);
  const [newMgrName, setNewMgrName] = useState('');
  const [newMgrRole, setNewMgrRole] = useState('Manager');
  const [newMgrPhone, setNewMgrPhone] = useState('');
  const [smsNotice, setSmsNotice] = useState('');

  useEffect(() => {
    try {
      localStorage.setItem('restosys_fleet_managers_v1', JSON.stringify(managerPhones));
    } catch {}
  }, [managerPhones]);

  useEffect(() => {
    try {
      localStorage.setItem('restosys_fleet_sms_logs_v1', JSON.stringify(smsLogs));
    } catch {}
  }, [smsLogs]);



  const handleAddManager = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMgrName.trim() || !newMgrPhone.trim()) return;
    const item: ManagerContact = {
      id: `mgr_${Date.now()}`,
      name: newMgrName.trim(),
      role: newMgrRole.trim() || 'Manager',
      phone: newMgrPhone.trim(),
      active: true,
    };
    setManagerPhones((prev) => [...prev, item]);
    setNewMgrName('');
    setNewMgrPhone('');
  };

  // Sync truck filter when top location selector changes
  useEffect(() => {
    if (activeLocationId && activeLocationId !== 'ALL') {
      const match = trucks.find((t) => t.location_id === activeLocationId);
      setSelectedTruckId(match ? match.id : 'NONE');
    } else {
      setSelectedTruckId('ALL');
    }
  }, [activeLocationId, trucks]);

  // Allow external trigger (e.g., "Log Service" button on a specific truck row)
  useEffect(() => {
    if (!preselectedTruckId) return;
    openCreateModal(preselectedTruckId);
    onClearPreselect?.();
  }, [preselectedTruckId]);

  const todayIso = getTodayDateIso();

  const perTruckStats = useMemo(() => {
    const map = new Map<string, ReturnType<typeof summarizeTruckMaintenance>>();
    for (const trk of trucks) {
      map.set(trk.id, summarizeTruckMaintenance(trk.id, maintenanceLogs, todayIso));
    }
    return map;
  }, [trucks, maintenanceLogs, todayIso]);

  const truckScopedLogs = useMemo(() => {
    if (selectedTruckId === 'NONE') return [];
    if (selectedTruckId === 'ALL') {
      const visibleIds = new Set(trucks.map((t) => t.id));
      return maintenanceLogs.filter((l) => visibleIds.has(l.truck_id));
    }
    return maintenanceLogs.filter((l) => l.truck_id === selectedTruckId);
  }, [maintenanceLogs, selectedTruckId, trucks]);

  const checkupsDueIn48Hours = useMemo(() => {
    return truckScopedLogs
      .map((log) => ({ log, alert: getMaintenanceAlertInfo(log, todayIso) }))
      .filter(({ log, alert }) => {
        return log.maintenance_status !== 'COMPLETED' && alert.daysUntil !== null && alert.daysUntil >= 0 && alert.daysUntil <= 2;
      });
  }, [truckScopedLogs, todayIso]);

  const handleSend48HourSmsReminders = () => {
    if (checkupsDueIn48Hours.length === 0) {
      setSmsNotice('No maintenance checkups are due within the 48-hour window.');
      return;
    }
    const activeMgrs = managerPhones.filter((m) => m.active);
    if (activeMgrs.length === 0) {
      setSmsNotice('Please enable at least one manager phone contact to dispatch SMS reminders.');
      return;
    }

    const newLogs: SmsDispatchLog[] = [];
    const nowIso = new Date().toISOString();

    for (const { log, alert } of checkupsDueIn48Hours) {
      for (const mgr of activeMgrs) {
        const msg = `[FLEET SMS ALERT] Hi ${mgr.name}, truck ${log.truck_name} (${log.plate_number}) service "${log.title}" is due in ${alert.daysUntil === 0 ? 'today (48h window)' : `${alert.daysUntil} day(s)`} (${log.next_due_date?.slice(0, 10)}). Please verify workshop readiness.`;
        newLogs.push({
          id: `sms_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          sentAt: nowIso,
          truckName: log.truck_name,
          serviceTitle: log.title,
          recipientName: mgr.name,
          recipientPhone: mgr.phone,
          message: msg,
          status: 'DELIVERED',
        });
      }
    }

    setSmsLogs((prev) => [...newLogs, ...prev]);
    setSmsNotice(`Successfully dispatched ${newLogs.length} automated SMS reminder(s) to ${activeMgrs.length} manager(s) for ${checkupsDueIn48Hours.length} upcoming 48-hour checkup(s).`);
  };

  const actionableAlerts = useMemo(() => {
    return truckScopedLogs
      .map((log) => ({ log, alert: getMaintenanceAlertInfo(log, todayIso) }))
      .filter((item) => item.alert.isActionableAlert)
      .sort((a, b) => (a.alert.daysUntil ?? 999) - (b.alert.daysUntil ?? 999));
  }, [truckScopedLogs, todayIso]);

  const filteredLogs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return truckScopedLogs.filter((log) => {
      const alert = getMaintenanceAlertInfo(log, todayIso);
      if (statusFilter === 'ALERTS' && !alert.isActionableAlert) return false;
      if (statusFilter === 'UPCOMING' && alert.state !== 'UPCOMING') return false;
      if (statusFilter === 'COMPLETED' && alert.state !== 'COMPLETED' && alert.state !== 'LOGGED') return false;
      if (q) {
        const hay = `${log.title} ${log.description || ''} ${log.service_provider || ''} ${log.truck_name} ${log.plate_number} ${formatMaintenanceCategory(log.maintenance_category)}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [truckScopedLogs, statusFilter, searchQuery, todayIso]);

  const summaryKpis = useMemo(() => {
    let totalCost = 0;
    let overdueCount = 0;
    let dueSoonCount = 0;
    let nextDue: string | null = null;
    for (const log of truckScopedLogs) {
      totalCost += Number(log.cost || 0);
      const alert = getMaintenanceAlertInfo(log, todayIso);
      if (alert.state === 'OVERDUE') overdueCount++;
      else if (alert.state === 'DUE_SOON') dueSoonCount++;
      if (log.next_due_date && log.maintenance_status !== 'COMPLETED') {
        const due = String(log.next_due_date).slice(0, 10);
        if (!nextDue || due < nextDue) nextDue = due;
      }
    }
    return {
      totalCost: Math.round(totalCost * 100) / 100,
      serviceCount: truckScopedLogs.length,
      alertCount: overdueCount + dueSoonCount,
      overdueCount,
      dueSoonCount,
      nextDue,
    };
  }, [truckScopedLogs, todayIso]);

  const openCreateModal = (truckIdOverride?: string) => {
    setModalErr('');
    const chosenTruckId =
      truckIdOverride && trucks.some((t) => t.id === truckIdOverride)
        ? truckIdOverride
        : selectedTruckId !== 'ALL' && selectedTruckId !== 'NONE' && trucks.some((t) => t.id === selectedTruckId)
          ? selectedTruckId
          : trucks[0]?.id || '';
    const truckObj = trucks.find((t) => t.id === chosenTruckId);
    const today = getTodayDateIso();
    setForm({
      truckId: chosenTruckId,
      title: '',
      maintenanceCategory: 'ENGINE_OIL',
      serviceProvider: '',
      serviceDate: today,
      nextDueDate: addDaysToDateIso(today, 90),
      alertLeadDays: '7',
      cost: '',
      odometerKm: truckObj ? String(truckObj.odometer_km ?? '') : '',
      description: '',
      postExpense: true,
      setTruckStatus: 'KEEP',
    });
    setModalOpen({ mode: 'create' });
  };

  const openEditModal = (log: FleetMaintenanceLog) => {
    setModalErr('');
    setForm({
      truckId: log.truck_id,
      title: log.title,
      maintenanceCategory: log.maintenance_category || 'GENERAL',
      serviceProvider: log.service_provider || '',
      serviceDate: log.service_date.slice(0, 10),
      nextDueDate: log.next_due_date ? log.next_due_date.slice(0, 10) : '',
      alertLeadDays: String(log.alert_lead_days ?? 7),
      cost: String(log.cost ?? 0),
      odometerKm: log.odometer_km !== null && log.odometer_km !== undefined ? String(log.odometer_km) : '',
      description: log.description || '',
      postExpense: Boolean(log.expense_id),
      setTruckStatus: 'KEEP',
    });
    setModalOpen({ mode: 'edit', logId: log.id });
  };

  const applyPreset = (preset: (typeof MAINTENANCE_PRESETS)[number]) => {
    const baseDate = form.serviceDate || getTodayDateIso();
    setForm((prev) => ({
      ...prev,
      title: preset.title,
      maintenanceCategory: preset.category,
      alertLeadDays: String(preset.leadDays),
      nextDueDate: addDaysToDateIso(baseDate, preset.intervalDays),
      cost: prev.cost && Number(prev.cost) > 0 ? prev.cost : String(preset.defaultCost),
      description: preset.description,
    }));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!modalOpen) return;
    setModalErr('');
    if (!form.truckId) {
      setModalErr('Select a food truck.');
      return;
    }
    if (!form.title.trim()) {
      setModalErr('Service title is required.');
      return;
    }
    if (!form.serviceDate) {
      setModalErr('Service date is required.');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        truckId: form.truckId,
        title: form.title.trim(),
        maintenanceCategory: form.maintenanceCategory,
        serviceProvider: form.serviceProvider.trim() || null,
        serviceDate: form.serviceDate,
        nextDueDate: form.nextDueDate.trim() || null,
        alertLeadDays: Math.min(90, Math.max(0, Math.round(Number(form.alertLeadDays || 7)))),
        cost: Math.max(0, Number(form.cost || 0)),
        odometerKm: form.odometerKm !== '' ? Math.max(0, Number(form.odometerKm)) : null,
        description: form.description.trim() || null,
        postExpense: form.postExpense,
        ...(modalOpen.mode === 'create' && form.setTruckStatus !== 'KEEP' ? { setTruckStatus: form.setTruckStatus } : {}),
      };

      const trkName = trucks.find((t) => t.id === form.truckId)?.location_name || 'Food Truck';
      if (modalOpen.mode === 'create') {
        await apiFetch('/fleet/maintenance', { method: 'POST', body: JSON.stringify(payload) });
        setModalOpen(null);
        await onMaintenanceSaved(
          `Logged "${payload.title}" for ${trkName}${payload.cost > 0 && payload.postExpense ? ' and posted cost to Operating Expenses' : ''}.`,
        );
      } else if (modalOpen.logId) {
        await apiFetch(`/fleet/maintenance/${modalOpen.logId}`, { method: 'PATCH', body: JSON.stringify(payload) });
        setModalOpen(null);
        await onMaintenanceSaved(`Updated maintenance log "${payload.title}" for ${trkName}.`);
      }
    } catch (e: any) {
      setModalErr(e.message || 'Unable to save maintenance record');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleComplete = async (log: FleetMaintenanceLog) => {
    setActionErr('');
    setBusyId(log.id);
    const nextStatus = log.maintenance_status === 'COMPLETED' ? 'OPEN' : 'COMPLETED';
    try {
      await apiFetch(`/fleet/maintenance/${log.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ maintenanceStatus: nextStatus }),
      });
      await onMaintenanceSaved(
        nextStatus === 'COMPLETED'
          ? `Marked upcoming checkup for "${log.title}" as completed.`
          : `Reopened checkup alert for "${log.title}".`,
      );
    } catch (e: any) {
      setActionErr(e.message || 'Unable to update maintenance status');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (log: FleetMaintenanceLog) => {
    setActionErr('');
    setBusyId(log.id);
    try {
      await apiFetch(`/fleet/maintenance/${log.id}`, { method: 'DELETE' });
      setConfirmDeleteId(null);
      await onMaintenanceSaved(`Deleted maintenance record "${log.title}".`);
    } catch (e: any) {
      setActionErr(e.message || 'Unable to delete maintenance record');
    } finally {
      setBusyId(null);
    }
  };

  const handleExportCsv = () => {
    const rows = filteredLogs.map((l) => {
      const alert = getMaintenanceAlertInfo(l, todayIso);
      return {
        ServiceDate: l.service_date,
        Truck: l.truck_name,
        PlateNumber: l.plate_number,
        Category: formatMaintenanceCategory(l.maintenance_category),
        Title: l.title,
        ServiceProvider: l.service_provider || '',
        OdometerKm: l.odometer_km ?? '',
        NextDueDate: l.next_due_date || '',
        AlertStatus: alert.label,
        CostPHP: l.cost,
        Notes: l.description || '',
      };
    });
    downloadCsv('fleet-maintenance-logs.csv', rows);
  };

  const selectedTruckObj =
    selectedTruckId !== 'ALL' && selectedTruckId !== 'NONE'
      ? trucks.find((t) => t.id === selectedTruckId) || null
      : null;

  return (
    <section aria-label="Fleet Maintenance" className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
      {/* Header */}
      <div className="p-4 sm:p-5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50 flex items-center gap-2">
            <Wrench className="w-4 h-4 text-slate-700 dark:text-slate-200" />
            Fleet Maintenance &amp; Checkup Alerts
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Track service dates, upcoming preventive checkup deadlines, and repair expenses per individual food truck
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={filteredLogs.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            Export CSV
          </button>
          <button
            type="button"
            onClick={() => openCreateModal()}
            disabled={trucks.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-4 py-2 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            Log Service
          </button>
        </div>
      </div>

      {/* Per-Truck Selector Tabs */}
      {trucks.length > 0 && selectedTruckId !== 'NONE' && (
        <div className="px-4 sm:px-5 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/60 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setSelectedTruckId('ALL')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
              selectedTruckId === 'ALL'
                ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950'
                : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            All Trucks ({trucks.length})
          </button>
          {trucks.map((trk) => {
            const st = perTruckStats.get(trk.id);
            const alerts = (st?.overdueCount || 0) + (st?.dueSoonCount || 0);
            const active = selectedTruckId === trk.id;
            return (
              <button
                key={trk.id}
                type="button"
                onClick={() => setSelectedTruckId(trk.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950'
                    : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                <Truck className="w-3.5 h-3.5 shrink-0" />
                <span>{trk.location_name}</span>
                {alerts > 0 && (
                  <span
                    className={`font-mono tabular-nums text-[11px] font-semibold ${
                      active ? 'text-amber-300' : st?.overdueCount ? 'text-red-600 dark:text-red-300' : 'text-amber-700 dark:text-amber-300'
                    }`}
                  >
                    · {alerts} due
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {actionErr && (
        <div className="mx-4 sm:mx-5 mt-4 p-3 rounded-lg border border-red-200 dark:border-red-800/80 bg-red-50 dark:bg-red-950/50 text-xs font-medium text-red-700 dark:text-red-300">
          {actionErr}
        </div>
      )}

      {/* Automated 48-Hour SMS Notification Banner */}
      <div className="border-b border-indigo-200 dark:border-indigo-700/80 bg-indigo-50/70 dark:bg-indigo-950/50 px-4 sm:px-5 py-3.5 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-indigo-700 dark:text-indigo-300 shrink-0" />
            <span className="text-xs font-semibold text-slate-900 dark:text-slate-50">
              Automated 48-Hour SMS Reminders &amp; Manager Dispatch ({checkupsDueIn48Hours.length} due in 48h)
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowSmsModal(true)}
              className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 dark:border-indigo-700/80 bg-white dark:bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <Settings className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
              Manager Contacts &amp; Logs ({managerPhones.filter((m) => m.active).length})
            </button>
            <button
              type="button"
              onClick={handleSend48HourSmsReminders}
              disabled={checkupsDueIn48Hours.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              <Send className="w-3.5 h-3.5" />
              Send 48h SMS Reminders Now
            </button>
          </div>
        </div>
        {smsNotice && (
          <p className="text-[11px] font-medium text-indigo-900 dark:text-indigo-300 bg-indigo-100/70 px-2.5 py-1 rounded">
            {smsNotice}
          </p>
        )}
      </div>

      {/* Upcoming & Overdue Checkup Alert Feed */}
      {actionableAlerts.length > 0 && (
        <div className="border-b border-amber-200 dark:border-amber-700/80 bg-amber-50/70 dark:bg-amber-950/45 px-4 sm:px-5 py-3.5 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-700 dark:text-amber-300 shrink-0" />
              <span className="text-xs font-semibold text-slate-900 dark:text-slate-50">
                Upcoming &amp; Overdue Checkup Alerts ({actionableAlerts.length})
              </span>
            </div>
            <span className="text-[11px] text-slate-600 dark:text-slate-300">
              Synced to header Alerts feed
            </span>
          </div>
          <div className="divide-y divide-amber-200/70">
            {actionableAlerts.map(({ log, alert }) => {
              const isOverdue = alert.state === 'OVERDUE';
              return (
                <div
                  key={log.id}
                  className="py-2.5 first:pt-1 last:pb-0 flex flex-wrap items-center justify-between gap-3 text-xs"
                >
                  <div className="flex items-start gap-2 min-w-0">
                    {isOverdue ? (
                      <ShieldAlert className="w-4 h-4 text-red-600 dark:text-red-300 shrink-0 mt-0.5" />
                    ) : (
                      <CalendarClock className="w-4 h-4 text-amber-700 dark:text-amber-300 shrink-0 mt-0.5" />
                    )}
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-900 dark:text-slate-50 truncate">
                        {log.title}
                      </p>
                      <p className="text-[11px] text-slate-600 dark:text-slate-300 flex flex-wrap items-center gap-x-1.5 mt-0.5">
                        <span className={`font-semibold ${isOverdue ? 'text-red-700 dark:text-red-300' : 'text-amber-800 dark:text-amber-300'}`}>
                          {alert.label}
                        </span>
                        <span>·</span>
                        <span className="font-medium text-slate-800 dark:text-slate-100">{log.truck_name}</span>
                        <span>·</span>
                        <span className="font-mono tabular-nums">Due {log.next_due_date?.slice(0, 10)}</span>
                        <span>·</span>
                        <span className="font-mono tabular-nums">{alert.countdownText}</span>
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={busyId === log.id}
                      onClick={() => openEditModal(log)}
                      className="rounded-lg border border-amber-300 dark:border-amber-700/80 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                    >
                      Reschedule
                    </button>
                    <button
                      type="button"
                      disabled={busyId === log.id}
                      onClick={() => void handleToggleComplete(log)}
                      className="inline-flex items-center gap-1 rounded-lg bg-slate-900 dark:bg-slate-100 px-3 py-1.5 text-[11px] font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50 whitespace-nowrap"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      {busyId === log.id ? 'Saving...' : 'Mark Done'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 4 KPI Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-slate-200 dark:divide-slate-800 border-b border-slate-200 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-800/40">
        <div className="p-4">
          <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
            {selectedTruckObj ? `${selectedTruckObj.location_code || selectedTruckObj.plate_number} Maint. Spend` : 'Total Maintenance Spend'}
          </p>
          <p className="mt-1 font-mono tabular-nums text-lg font-bold text-slate-900 dark:text-slate-50">
            {formatPHP(summaryKpis.totalCost)}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">Logged repairs &amp; preventive service</p>
        </div>

        <div className="p-4">
          <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Services Logged</p>
          <p className="mt-1 font-mono tabular-nums text-lg font-bold text-slate-900 dark:text-slate-50">
            {summaryKpis.serviceCount}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
            {selectedTruckObj ? selectedTruckObj.make_model : `Across ${trucks.length} food truck(s)`}
          </p>
        </div>

        <div className="p-4">
          <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Active Checkup Alerts</p>
          <p
            className={`mt-1 font-mono tabular-nums text-lg font-bold ${
              summaryKpis.overdueCount > 0
                ? 'text-red-600 dark:text-red-300'
                : summaryKpis.dueSoonCount > 0
                  ? 'text-amber-700 dark:text-amber-300'
                  : 'text-emerald-700 dark:text-emerald-300'
            }`}
          >
            {summaryKpis.alertCount}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
            {summaryKpis.overdueCount > 0
              ? `${summaryKpis.overdueCount} overdue · ${summaryKpis.dueSoonCount} due soon`
              : summaryKpis.dueSoonCount > 0
                ? `${summaryKpis.dueSoonCount} checkup(s) due soon`
                : 'All trucks within schedule'}
          </p>
        </div>

        <div className="p-4">
          <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Next Checkup Due</p>
          <p className="mt-1 font-mono tabular-nums text-lg font-bold text-slate-900 dark:text-slate-50">
            {summaryKpis.nextDue || '—'}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
            {summaryKpis.nextDue ? 'Earliest open maintenance target' : 'No open checkup dates set'}
          </p>
        </div>
      </div>

      {/* Filters Toolbar */}
      <div className="px-4 sm:px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
          {[
            { id: 'ALL' as const, label: 'All Logs' },
            { id: 'ALERTS' as const, label: `Alerts (${actionableAlerts.length})` },
            { id: 'UPCOMING' as const, label: 'Scheduled' },
            { id: 'COMPLETED' as const, label: 'Completed' },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setStatusFilter(tab.id)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                statusFilter === tab.id ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50 shadow-sm' : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-64">
          <Search className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search service, mechanic, plate..."
            className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 pl-8 pr-3 py-1.5 text-xs text-slate-800 dark:text-slate-100 placeholder:text-slate-400"
          />
        </div>
      </div>

      {/* Maintenance Ledger Table */}
      <div className="overflow-x-auto">
        {filteredLogs.length === 0 ? (
          <div className="p-8 text-center space-y-2.5">
            <Wrench className="w-7 h-7 text-slate-400 dark:text-slate-500 mx-auto" />
            <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">
              {selectedTruckObj
                ? `No maintenance records match this filter for ${selectedTruckObj.location_name}`
                : 'No maintenance records match your current filter'}
            </p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 max-w-md mx-auto">
              Log service dates, shop fees, and next checkup reminders to track vehicle readiness and costs per truck.
            </p>
            {trucks.length > 0 && (
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => openCreateModal()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-3.5 py-2 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Log First Service
                </button>
              </div>
            )}
          </div>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
              <tr>
                <th className="p-3 font-medium">Service Date</th>
                {selectedTruckId === 'ALL' && <th className="p-3 font-medium">Food Truck</th>}
                <th className="p-3 font-medium">Service &amp; Provider</th>
                <th className="p-3 font-medium text-right">Odometer</th>
                <th className="p-3 font-medium">Upcoming Checkup Alert</th>
                <th className="p-3 font-medium text-right">Cost</th>
                <th className="p-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filteredLogs.map((log) => {
                const alert = getMaintenanceAlertInfo(log, todayIso);
                const isDone = log.maintenance_status === 'COMPLETED';
                return (
                  <tr key={log.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/70">
                    <td className="p-3 font-mono tabular-nums text-slate-700 dark:text-slate-200 whitespace-nowrap">
                      {log.service_date.slice(0, 10)}
                    </td>
                    {selectedTruckId === 'ALL' && (
                      <td className="p-3">
                        <p className="font-semibold text-slate-900 dark:text-slate-50 whitespace-nowrap">{log.truck_name}</p>
                        <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400">{log.plate_number}</p>
                      </td>
                    )}
                    <td className="p-3 max-w-xs">
                      <p className="font-semibold text-slate-900 dark:text-slate-50">{log.title}</p>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">
                        {formatMaintenanceCategory(log.maintenance_category)}
                        {log.service_provider ? ` · ${log.service_provider}` : ''}
                      </p>
                      {log.description && (
                        <p className="text-[11px] text-slate-600 dark:text-slate-300 mt-0.5 line-clamp-2">{log.description}</p>
                      )}
                    </td>
                    <td className="p-3 text-right font-mono tabular-nums text-slate-700 dark:text-slate-200 whitespace-nowrap">
                      {log.odometer_km !== null && log.odometer_km !== undefined
                        ? `${Number(log.odometer_km).toLocaleString()} km`
                        : '—'}
                    </td>
                    <td className="p-3">
                      {log.next_due_date ? (
                        <div className="space-y-0.5">
                          <div
                            className={`inline-flex items-center gap-1 text-[11px] font-semibold ${
                              alert.state === 'OVERDUE'
                                ? 'text-red-700 dark:text-red-300'
                                : alert.state === 'DUE_SOON'
                                  ? 'text-amber-700 dark:text-amber-300'
                                  : alert.state === 'COMPLETED'
                                    ? 'text-emerald-700 dark:text-emerald-300'
                                    : 'text-slate-700 dark:text-slate-200'
                            }`}
                          >
                            {alert.state === 'OVERDUE' ? (
                              <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
                            ) : alert.state === 'DUE_SOON' ? (
                              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                            ) : alert.state === 'COMPLETED' ? (
                              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                            ) : (
                              <Clock className="w-3.5 h-3.5 shrink-0" />
                            )}
                            <span>{alert.label}</span>
                          </div>
                          <p className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                            {log.next_due_date.slice(0, 10)} · {alert.countdownText}
                          </p>
                        </div>
                      ) : (
                        <span className="text-[11px] text-slate-500 dark:text-slate-400">One-time repair</span>
                      )}
                    </td>
                    <td className="p-3 text-right font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-50 whitespace-nowrap">
                      {formatPHP(log.cost)}
                    </td>
                    <td className="p-3 text-right whitespace-nowrap">
                      {confirmDeleteId === log.id ? (
                        <span className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={busyId === log.id}
                            onClick={() => void handleDelete(log)}
                            className="rounded bg-red-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                          >
                            {busyId === log.id ? 'Removing...' : 'Confirm'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="rounded border border-slate-200 dark:border-slate-800 px-2 py-1 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5">
                          {log.next_due_date && (
                            <button
                              type="button"
                              disabled={busyId === log.id}
                              onClick={() => void handleToggleComplete(log)}
                              className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] font-medium whitespace-nowrap ${
                                isDone
                                  ? 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                                  : 'border-emerald-200 dark:border-emerald-700/80 bg-emerald-50 dark:bg-emerald-950/45 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/60'
                              }`}
                            >
                              <CheckCircle2 className="w-3 h-3" />
                              {isDone ? 'Reopen' : 'Done'}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => openEditModal(log)}
                            className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-slate-800 px-2 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                          >
                            <Pencil className="w-3 h-3" />
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(log.id)}
                            className="inline-flex items-center gap-1 rounded border border-red-200 dark:border-red-800/80 px-2 py-1 text-[11px] font-medium text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/70"
                          >
                            <Trash2 className="w-3 h-3" />
                            Delete
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Log / Edit Maintenance Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form
            onSubmit={handleSave}
            className="w-full max-w-xl rounded-xl bg-white dark:bg-slate-900 p-5 space-y-4 border border-slate-200 dark:border-slate-800 max-h-[92vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800/80 pb-3">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">
                  {modalOpen.mode === 'create' ? 'Log Fleet Maintenance Service' : 'Edit Maintenance Record'}
                </h3>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                  Record service completion date, repair cost, and upcoming checkup alert window
                </p>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(null)}
                className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {modalOpen.mode === 'create' && (
              <div className="space-y-1.5">
                <span className="block text-[11px] font-medium text-slate-500 dark:text-slate-400">Quick Service Presets</span>
                <div className="flex flex-wrap gap-1.5">
                  {MAINTENANCE_PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => applyPreset(preset)}
                      className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:border-slate-400 dark:hover:border-slate-500 hover:bg-white dark:hover:bg-slate-800 transition-colors"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {modalErr && (
              <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">
                {modalErr}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Food Truck *</label>
                <select
                  required
                  value={form.truckId}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    const tObj = trucks.find((t) => t.id === nextId);
                    setForm((prev) => ({
                      ...prev,
                      truckId: nextId,
                      odometerKm: modalOpen.mode === 'create' && tObj ? String(tObj.odometer_km ?? '') : prev.odometerKm,
                    }));
                  }}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                >
                  {trucks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.location_name} ({t.plate_number})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Maintenance Category</label>
                <select
                  value={form.maintenanceCategory}
                  onChange={(e) => setForm({ ...form, maintenanceCategory: e.target.value as MaintenanceCategory })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                >
                  {MAINTENANCE_CATEGORIES.map((cat) => (
                    <option key={cat.value} value={cat.value}>
                      {cat.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="sm:col-span-2">
                <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Service Title *</label>
                <input
                  required
                  maxLength={160}
                  placeholder="e.g. 5,000km Oil & Brake Service"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Service Date *</label>
                <input
                  type="date"
                  required
                  value={form.serviceDate}
                  onChange={(e) => setForm({ ...form, serviceDate: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="font-medium text-slate-600 dark:text-slate-300">Next Checkup Alert Date</label>
                  <span className="flex items-center gap-1.5 text-[10px]">
                    {[30, 90, 180].map((days) => (
                      <button
                        key={days}
                        type="button"
                        onClick={() =>
                          setForm((f) => ({
                            ...f,
                            nextDueDate: addDaysToDateIso(f.serviceDate || getTodayDateIso(), days),
                          }))
                        }
                        className="text-slate-600 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white underline font-mono"
                      >
                        +{days}d
                      </button>
                    ))}
                  </span>
                </div>
                <input
                  type="date"
                  value={form.nextDueDate}
                  onChange={(e) => setForm({ ...form, nextDueDate: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Maintenance Cost (PHP)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={form.cost}
                  onChange={(e) => setForm({ ...form, cost: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Odometer at Service (km)</label>
                <input
                  type="number"
                  min="0"
                  placeholder="Optional km reading"
                  value={form.odometerKm}
                  onChange={(e) => setForm({ ...form, odometerKm: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Service Shop / Mechanic</label>
                <input
                  maxLength={140}
                  placeholder="e.g. Rapide BGC / In-House Mechanic"
                  value={form.serviceProvider}
                  onChange={(e) => setForm({ ...form, serviceProvider: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Checkup Alert Lead Window</label>
                <select
                  value={form.alertLeadDays}
                  onChange={(e) => setForm({ ...form, alertLeadDays: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                >
                  <option value="3">Alert 3 days before due</option>
                  <option value="7">Alert 7 days before due</option>
                  <option value="14">Alert 14 days before due</option>
                  <option value="30">Alert 30 days before due</option>
                </select>
              </div>

              <div className="sm:col-span-2">
                <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Work Done / Parts Replaced</label>
                <textarea
                  rows={2}
                  maxLength={400}
                  placeholder="Optional inspection findings, part serials, or warranty notes"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                />
              </div>

              {modalOpen.mode === 'create' && (
                <>
                  <div className="flex items-center gap-2 pt-1">
                    <input
                      id="post-maint-expense"
                      type="checkbox"
                      checked={form.postExpense}
                      onChange={(e) => setForm({ ...form, postExpense: e.target.checked })}
                      className="rounded border-slate-300 dark:border-slate-700"
                    />
                    <label htmlFor="post-maint-expense" className="text-xs text-slate-700 dark:text-slate-200">
                      Auto-post cost to Operating Expenses (Acc 6400)
                    </label>
                  </div>

                  <div>
                    <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Update Truck Status</label>
                    <select
                      value={form.setTruckStatus}
                      onChange={(e) => setForm({ ...form, setTruckStatus: e.target.value as any })}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                    >
                      <option value="KEEP">Keep current status</option>
                      <option value="ACTIVE">Set truck ACTIVE</option>
                      <option value="MAINTENANCE">Set truck MAINTENANCE</option>
                    </select>
                  </div>
                </>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800/80">
              <button
                type="button"
                onClick={() => setModalOpen(null)}
                className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 text-xs font-semibold hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50"
              >
                {saving ? 'Saving...' : modalOpen.mode === 'create' ? 'Save Service Log' : 'Save Changes'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Manager Contacts & SMS Audit Log Modal */}
      {showSmsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-2xl rounded-xl bg-white dark:bg-slate-900 p-5 space-y-5 border border-slate-200 dark:border-slate-800 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800/80 pb-3">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50 flex items-center gap-2">
                  <Smartphone className="w-4 h-4 text-indigo-600 dark:text-indigo-300" />
                  Manager SMS Notification &amp; 48-Hour Dispatch Settings
                </h3>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                  Configure manager mobile numbers receiving automated SMS checkup reminders 48 hours before due date
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowSmsModal(false)}
                className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Manager Phone Book Form & List */}
            <div className="space-y-3">
              <h4 className="text-xs font-semibold text-slate-800 dark:text-slate-100 uppercase tracking-wider">Manager Mobile Contacts</h4>
              <form onSubmit={handleAddManager} className="grid grid-cols-1 sm:grid-cols-3 gap-2 bg-slate-50 dark:bg-slate-800/70 p-3 rounded-lg border border-slate-200 dark:border-slate-800">
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Manager Name</label>
                  <input
                    required
                    placeholder="e.g. Sarah Jenkins"
                    value={newMgrName}
                    onChange={(e) => setNewMgrName(e.target.value)}
                    className="w-full rounded border border-slate-200 dark:border-slate-800 px-2.5 py-1.5 text-xs bg-white dark:bg-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Mobile Phone (PH)</label>
                  <input
                    required
                    placeholder="+63 917 555 0192"
                    value={newMgrPhone}
                    onChange={(e) => setNewMgrPhone(e.target.value)}
                    className="w-full rounded border border-slate-200 dark:border-slate-800 px-2.5 py-1.5 text-xs font-mono bg-white dark:bg-slate-900"
                  />
                </div>
                <div className="flex items-end">
                  <button
                    type="submit"
                    className="w-full rounded bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700"
                  >
                    Add Manager
                  </button>
                </div>
              </form>

              <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
                {managerPhones.map((mgr) => (
                  <div key={mgr.id} className="p-3 flex items-center justify-between text-xs bg-white dark:bg-slate-900">
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={mgr.active}
                        onChange={(e) => {
                          const val = e.target.checked;
                          setManagerPhones((prev) => prev.map((m) => (m.id === mgr.id ? { ...m, active: val } : m)));
                        }}
                        className="rounded border-slate-300 dark:border-slate-700 text-indigo-600 dark:text-indigo-300"
                      />
                      <div>
                        <p className="font-semibold text-slate-900 dark:text-slate-50">{mgr.name} <span className="font-normal text-slate-500 dark:text-slate-400">({mgr.role})</span></p>
                        <p className="font-mono text-[11px] text-slate-600 dark:text-slate-300">{mgr.phone}</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setManagerPhones((prev) => prev.filter((m) => m.id !== mgr.id))}
                      className="text-red-600 dark:text-red-300 hover:text-red-800 p-1"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* SMS Dispatch History */}
            <div className="space-y-3 pt-3 border-t border-slate-100 dark:border-slate-800/80">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold text-slate-800 dark:text-slate-100 uppercase tracking-wider">SMS Dispatch Audit Log ({smsLogs.length})</h4>
                {smsLogs.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSmsLogs([])}
                    className="text-[11px] text-red-600 dark:text-red-300 hover:underline"
                  >
                    Clear Logs
                  </button>
                )}
              </div>
              <div className="max-h-48 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg text-xs bg-slate-50 dark:bg-slate-800/70">
                {smsLogs.length === 0 ? (
                  <div className="p-6 text-center text-slate-500 dark:text-slate-400 text-xs">
                    No SMS reminders dispatched yet. Click "Send 48h SMS Reminders Now" when checkups are due within 48 hours.
                  </div>
                ) : (
                  smsLogs.map((log) => (
                    <div key={log.id} className="p-2.5 bg-white dark:bg-slate-900 space-y-1">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="font-semibold text-indigo-700 dark:text-indigo-300">To: {log.recipientName} ({log.recipientPhone})</span>
                        <span className="font-mono text-slate-500 dark:text-slate-400">{new Date(log.sentAt).toLocaleString()}</span>
                      </div>
                      <p className="text-slate-800 dark:text-slate-100 text-[11px] font-mono bg-slate-50 dark:bg-slate-800/70 p-1.5 rounded border border-slate-100 dark:border-slate-800/80">{log.message}</p>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="flex justify-end pt-3 border-t border-slate-100 dark:border-slate-800/80">
              <button
                type="button"
                onClick={() => setShowSmsModal(false)}
                className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 text-xs font-semibold hover:bg-slate-800 dark:hover:bg-white"
              >
                Close Settings
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
