import React, { useEffect, useRef, useState } from 'react';
import { Download, Printer, Plus, Clock, Truck, ShieldCheck, Calendar, CalendarClock, CopyPlus, MapPin, Pencil, Trash2, X, Upload, Users, Camera, Check, ChefHat, ScanFace, KeyRound, AlertTriangle, ShieldAlert, CheckCircle2, Wrench, QrCode, Smartphone, Award, Sparkles, Search, Receipt, Eye } from 'lucide-react';
import { apiFetch, downloadCsv, formatNum, formatPHP } from '../lib/api.ts';
import { captureSnapshotDataUrl, extractFaceDescriptorFromDataUrl, parseDescriptorJson } from '../lib/faceRecognition.ts';
import { detectRosterScheduleConflicts, findScheduleCandidateConflicts, formatOverlapDuration, ShiftOverlapConflict, ShiftWindowLike } from '../lib/shiftConflicts.ts';
import { LocationRow } from '../types/erp.ts';
import { FaceAttendanceKioskModal } from './FaceAttendanceKioskModal.tsx';
import { FleetMaintenanceSection } from './FleetMaintenanceSection.tsx';
import { CustomerLoyaltyKiosk } from './CustomerLoyaltyKiosk.tsx';
import { AvatarBadge, resizeImageToDataUrl } from './SettingsUserControlModule.tsx';

interface Props {
  mode: 'fleet' | 'hr' | 'crm' | 'reports';
  locations?: LocationRow[];
  activeLocationId?: string;
  onLocationChange?: (locationId: string) => void;
  onLocationsChanged?: () => Promise<void> | void;
  onNotificationsChanged?: () => Promise<void> | void;
  quickAction?: { action: string; nonce: number } | null;
  onQuickActionHandled?: () => void;
}

export function OperationsHrCrmModule({
  mode,
  locations = [],
  activeLocationId = 'ALL',
  onLocationChange,
  onLocationsChanged,
  onNotificationsChanged,
  quickAction,
  onQuickActionHandled,
}: Props) {
  const [fleetData, setFleetData] = useState<any>(null);
  const [hrData, setHrData] = useState<any>(null);
  const [customers, setCustomers] = useState<any[]>([]);
  const [reportType, setReportType] = useState<'sales' | 'inventory' | 'expenses' | 'waste'>('sales');
  const [reportFrom, setReportFrom] = useState('');
  const [reportTo, setReportTo] = useState('');
  const [locationFilter, setLocationFilter] = useState<string>(activeLocationId === 'ALL' ? '' : activeLocationId);
  const [reportRows, setReportRows] = useState<any[]>([]);
  const [governance, setGovernance] = useState<any>(null);
  const [reportTab, setReportTab] = useState<'exports' | 'rbac' | 'audit'>('exports');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    setLocationFilter(activeLocationId === 'ALL' ? '' : activeLocationId);
  }, [activeLocationId]);

  // Quick forms
  const getTodayLocalDate = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const getDefaultCustLoc = () =>
    activeLocationId && activeLocationId !== 'ALL' && locations.some((l) => l.id === activeLocationId)
      ? activeLocationId
      : locations.find((l) => l.type === 'FOOD_TRUCK')?.id || locations[0]?.id || '';
  const [fuelForm, setFuelForm] = useState({ truckId: '', liters: '35', totalCost: '2100', odometerKm: '43100' });
  const [siteForm, setSiteForm] = useState({ truckId: '', siteName: '', shiftNotes: '' });
  const [custForm, setCustForm] = useState({
    fullName: '',
    phone: '',
    email: '',
    preferences: '',
    registeredAt: getTodayLocalDate(),
    locationId: getDefaultCustLoc(),
  });
  const [crmSubTab, setCrmSubTab] = useState<'members' | 'kiosk'>('members');
  const [crmSearch, setCrmSearch] = useState('');
  const [crmTierFilter, setCrmTierFilter] = useState<'ALL' | 'STANDARD' | 'SILVER' | 'GOLD' | 'PLATINUM'>('ALL');
  const [selectedCustDetail, setSelectedCustDetail] = useState<any | null>(null);
  const [detailTransactions, setDetailTransactions] = useState<any[]>([]);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [ruleCfg, setRuleCfg] = useState<any>(null);
  const [fleetModal, setFleetModal] = useState<'add' | 'edit' | null>(null);

  // Employee & Crew Photos + Face Biometrics Modal State (HR & PH Payroll)
  const [empModal, setEmpModal] = useState<{ mode: 'create' | 'edit'; id?: string } | null>(null);
  const [empForm, setEmpForm] = useState({
    employeeCode: '',
    fullName: '',
    phone: '',
    address: '',
    department: 'Kitchen Operations',
    position: 'Crew / Griller',
    locationId: '',
    payType: 'DAILY' as 'DAILY' | 'HOURLY' | 'MONTHLY',
    baseRate: '650',
    avatarUrl: '',
    faceDescriptorJson: '',
    faceEnrolledAt: '',
    attendancePin: '',
    isActive: true,
  });
  const [empModalErr, setEmpModalErr] = useState('');
  const [savingEmp, setSavingEmp] = useState(false);
  const [extractingFace, setExtractingFace] = useState(false);
  const [faceEnrollStatus, setFaceEnrollStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [showEmpCam, setShowEmpCam] = useState(false);
  const [empCamErr, setEmpCamErr] = useState('');
  const empFileRef = useRef<HTMLInputElement>(null);
  const empVideoRef = useRef<HTMLVideoElement | null>(null);
  const empStreamRef = useRef<MediaStream | null>(null);

  // Face Attendance Kiosk & Biometric Audit State
  const [showFaceKiosk, setShowFaceKiosk] = useState(false);
  const [useAttendanceDays, setUseAttendanceDays] = useState(false);
  const [attendancePhotoPreview, setAttendancePhotoPreview] = useState<{ title: string; subtitle: string; src: string } | null>(null);
  const [showPayrollModal, setShowPayrollModal] = useState(false);
  const [runningPayroll, setRunningPayroll] = useState(false);
  const [payrollModalErr, setPayrollModalErr] = useState('');
  const [payrollForm, setPayrollForm] = useState(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const isFirstHalf = now.getDate() <= 15;
    const lastDay = new Date(y, now.getMonth() + 1, 0).getDate();
    return {
      periodStart: `${y}-${m}-${isFirstHalf ? '01' : '16'}`,
      periodEnd: `${y}-${m}-${isFirstHalf ? '15' : String(lastDay).padStart(2, '0')}`,
      daysPerEmployee: '13',
      useAttendanceDays: false,
    };
  });
  const [fleetForm, setFleetForm] = useState({
    locationId: '',
    type: 'FOOD_TRUCK' as 'FOOD_TRUCK' | 'COMMISSARY',
    code: '',
    name: '',
    address: '',
    plateNumber: '',
    makeModel: '',
    currentSite: '',
    odometerKm: '0',
    status: 'ACTIVE' as 'ACTIVE' | 'MAINTENANCE' | 'INACTIVE',
    kdsEnabled: true,
  });
  const [fleetModalErr, setFleetModalErr] = useState('');
  const [savingFleet, setSavingFleet] = useState(false);
  const [togglingKdsId, setTogglingKdsId] = useState<string | null>(null);
  const [deleteLocTarget, setDeleteLocTarget] = useState<any>(null);
  const [deletingLoc, setDeletingLoc] = useState(false);
  const [maintPreselectTruckId, setMaintPreselectTruckId] = useState<string | null>(null);
  const maintSectionRef = useRef<HTMLDivElement | null>(null);

  // Shift Templates & Multi-Location Recurring Schedules State
  const WEEKDAY_ORDER = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  const shiftTemplatesSectionRef = useRef<HTMLDivElement | null>(null);
  const [shiftTplModal, setShiftTplModal] = useState<{ mode: 'create' | 'edit'; id?: string } | null>(null);
  const [shiftTplForm, setShiftTplForm] = useState({
    code: '',
    name: '',
    startTime: '07:00',
    endTime: '15:00',
    breakMinutes: '60',
    daysOfWeek: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as string[],
    locationIds: [] as string[],
    defaultRole: '',
    headcountNeeded: '2',
    notes: '',
    isActive: true,
  });
  const [shiftTplErr, setShiftTplErr] = useState('');
  const [savingShiftTpl, setSavingShiftTpl] = useState(false);
  const [deleteShiftTplTarget, setDeleteShiftTplTarget] = useState<any>(null);
  const [deletingShiftTpl, setDeletingShiftTpl] = useState(false);

  const [genSchedModal, setGenSchedModal] = useState<{ templateId: string } | null>(null);
  const [genSchedForm, setGenSchedForm] = useState({
    templateId: '',
    startDate: getTodayLocalDate(),
    endDate: getTodayLocalDate(),
    daysOfWeek: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as string[],
    locationIds: [] as string[],
    assignmentMode: 'AUTO_BY_LOCATION' as 'OPEN_SLOTS' | 'AUTO_BY_LOCATION' | 'SELECTED_EMPLOYEES',
    employeeIds: [] as string[],
    headcountPerLocation: '2',
    notes: '',
  });
  const [genSchedErr, setGenSchedErr] = useState('');
  const [genSchedConflicts, setGenSchedConflicts] = useState<ShiftOverlapConflict[]>([]);
  const [generatingSched, setGeneratingSched] = useState(false);
  const [schedFilterTemplate, setSchedFilterTemplate] = useState<string>('ALL');
  const [schedFilterDate, setSchedFilterDate] = useState<string>('');
  const [schedConflictsOnly, setSchedConflictsOnly] = useState<boolean>(false);
  const [recentConflictScheduleIds, setRecentConflictScheduleIds] = useState<string[]>([]);
  const [schedUpdatingId, setSchedUpdatingId] = useState<string | null>(null);

  const [singleShiftModal, setSingleShiftModal] = useState<boolean>(false);
  const [singleShiftForm, setSingleShiftForm] = useState({
    templateId: '',
    templateName: 'Custom Shift',
    locationId: '',
    employeeId: '',
    shiftDate: getTodayLocalDate(),
    startTime: '07:00',
    endTime: '15:00',
    breakMinutes: '60',
    status: 'SCHEDULED',
    notes: '',
  });
  const [singleShiftErr, setSingleShiftErr] = useState('');
  const [singleShiftConflicts, setSingleShiftConflicts] = useState<ShiftOverlapConflict[]>([]);
  const [savingSingleShift, setSavingSingleShift] = useState(false);

  const buildSiteFormForTruck = (truckId: string, fleetRes: any) => {
    const trk = (fleetRes?.trucks || []).find((t: any) => t.id === truckId);
    const latestAssign = (fleetRes?.assignments || []).find((a: any) => a.truck_id === truckId);
    return {
      truckId,
      siteName: trk?.current_site || latestAssign?.site_name || '',
      shiftNotes: trk?.latest_shift_notes ?? latestAssign?.shift_notes ?? '',
    };
  };

  // Inline camera lifecycle inside Employee & Crew modal
  useEffect(() => {
    if (!empModal || !showEmpCam) {
      if (empStreamRef.current) {
        empStreamRef.current.getTracks().forEach((t) => t.stop());
        empStreamRef.current = null;
      }
      return;
    }
    let cancelled = false;
    setEmpCamErr('');
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Camera is not supported in this browser.');
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 360 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        empStreamRef.current = stream;
        if (empVideoRef.current) {
          empVideoRef.current.srcObject = stream;
          await empVideoRef.current.play().catch(() => undefined);
        }
      } catch (e: any) {
        if (!cancelled) {
          setEmpCamErr(
            e?.name === 'NotAllowedError'
              ? 'Camera permission denied. Allow access or upload a photo file instead.'
              : e?.message || 'Unable to start camera',
          );
        }
      }
    })();
    return () => {
      cancelled = true;
      if (empStreamRef.current) {
        empStreamRef.current.getTracks().forEach((t) => t.stop());
        empStreamRef.current = null;
      }
    };
  }, [Boolean(empModal), showEmpCam]);

  // Employee & Crew Photo + Face Biometrics Handlers (HR & PH Payroll)
  const openCreateEmployee = () => {
    setEmpModalErr('');
    setFaceEnrollStatus(null);
    setShowEmpCam(false);
    setEmpCamErr('');
    const nextNum = (hrData?.employees?.length || 0) + 1;
    const defaultLoc =
      activeLocationId && activeLocationId !== 'ALL' && locations.some((l) => l.id === activeLocationId)
        ? activeLocationId
        : locations.find((l) => l.type === 'FOOD_TRUCK')?.id || locations[0]?.id || '';
    setEmpForm({
      employeeCode: `EMP-${String(nextNum).padStart(3, '0')}`,
      fullName: '',
      phone: '',
      address: '',
      department: 'Kitchen Operations',
      position: 'Crew / Griller',
      locationId: defaultLoc,
      payType: 'DAILY',
      baseRate: '650',
      avatarUrl: '',
      faceDescriptorJson: '',
      faceEnrolledAt: '',
      attendancePin: '',
      isActive: true,
    });
    setEmpModal({ mode: 'create' });
  };

  const openEditEmployee = (emp: any) => {
    setEmpModalErr('');
    setShowEmpCam(false);
    setEmpCamErr('');
    const hasFace = Boolean(parseDescriptorJson(emp.face_descriptor_json));
    setFaceEnrollStatus(
      hasFace
        ? { ok: true, text: 'On-device Face ID profile active' }
        : emp.avatar_url
          ? { ok: false, text: 'Photo uploaded without Face ID — click Re-Scan Photo or Take Live Photo' }
          : null,
    );
    setEmpForm({
      employeeCode: emp.employee_code || '',
      fullName: emp.full_name || '',
      phone: emp.phone || '',
      address: emp.address || '',
      department: emp.department || 'Kitchen Operations',
      position: emp.position || 'Crew / Griller',
      locationId: emp.location_id || '',
      payType: (emp.pay_type as any) || 'DAILY',
      baseRate: String(emp.base_rate ?? 650),
      avatarUrl: emp.avatar_url || '',
      faceDescriptorJson: emp.face_descriptor_json || '',
      faceEnrolledAt: emp.face_enrolled_at || '',
      attendancePin: emp.attendance_pin || '',
      isActive: emp.is_active !== 0,
    });
    setEmpModal({ mode: 'edit', id: emp.id });
  };

  const enrollFaceFromDataUrl = async (dataUrl: string) => {
    setExtractingFace(true);
    setFaceEnrollStatus(null);
    setEmpForm((f) => ({ ...f, avatarUrl: dataUrl }));
    try {
      const res = await extractFaceDescriptorFromDataUrl(dataUrl);
      const enrolledAt = new Date().toISOString();
      setEmpForm((f) => ({
        ...f,
        avatarUrl: dataUrl,
        faceDescriptorJson: res.descriptorJson,
        faceEnrolledAt: enrolledAt,
      }));
      setFaceEnrollStatus({ ok: true, text: `Face ID enrolled (${res.score}% detection clarity)` });
    } catch (e: any) {
      setEmpForm((f) => ({
        ...f,
        avatarUrl: dataUrl,
        faceDescriptorJson: '',
        faceEnrolledAt: '',
      }));
      setFaceEnrollStatus({
        ok: false,
        text: e?.message || 'Photo saved, but no clear front face was detected for Face ID.',
      });
    } finally {
      setExtractingFace(false);
    }
  };

  const handleEmpPhotoUpload = async (file: File | undefined) => {
    if (!file) return;
    setEmpModalErr('');
    setShowEmpCam(false);
    try {
      const dataUrl = await resizeImageToDataUrl(file, 256);
      await enrollFaceFromDataUrl(dataUrl);
    } catch (e: any) {
      setEmpModalErr(e.message || 'Unable to process crew photo');
    }
  };

  const handleCaptureEmpLivePhoto = async () => {
    if (!empVideoRef.current || empVideoRef.current.readyState < 2) {
      setEmpCamErr('Camera feed is still warming up. Wait a moment and try again.');
      return;
    }
    const snapshot = captureSnapshotDataUrl(empVideoRef.current, 256, true);
    setShowEmpCam(false);
    await enrollFaceFromDataUrl(snapshot);
  };

  const handleSaveEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!empModal) return;
    setEmpModalErr('');
    setSavingEmp(true);
    try {
      const payload = {
        employeeCode: empForm.employeeCode.trim(),
        fullName: empForm.fullName.trim(),
        phone: empForm.phone.trim() || null,
        address: empForm.address.trim() || null,
        department: empForm.department.trim(),
        position: empForm.position.trim(),
        locationId: empForm.locationId || null,
        payType: empForm.payType,
        baseRate: Number(empForm.baseRate || 0),
        avatarUrl: empForm.avatarUrl || null,
        faceDescriptorJson: empForm.faceDescriptorJson || null,
        faceEnrolledAt: empForm.faceEnrolledAt || null,
        attendancePin: empForm.attendancePin.trim() || null,
        isActive: empForm.isActive,
      };

      if (empModal.mode === 'create') {
        await apiFetch('/hr/employees', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        setMsg(`Added crew member ${payload.fullName}${payload.faceDescriptorJson ? ' with Face ID enrolled' : ''}.`);
      } else {
        await apiFetch(`/hr/employees/${empModal.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        setMsg(`Updated employee profile and biometrics for ${payload.fullName}.`);
      }

      setEmpModal(null);
      setShowEmpCam(false);
      await loadHr();
    } catch (err: any) {
      setEmpModalErr(err.message || 'Unable to save employee details');
    } finally {
      setSavingEmp(false);
    }
  };

  const loadFleet = async () => {
    try {
      setErr('');
      const res = await apiFetch<any>('/fleet');
      setFleetData(res);
      const allTrucks = res?.trucks || [];
      const scopedTrucks =
        activeLocationId && activeLocationId !== 'ALL'
          ? allTrucks.filter((t: any) => t.location_id === activeLocationId)
          : allTrucks;
      const candidateTrucks = scopedTrucks.length > 0 ? scopedTrucks : allTrucks;
      const firstTruckId = candidateTrucks[0]?.id || '';
      if (firstTruckId) {
        setSiteForm((prev) => {
          const targetId = candidateTrucks.some((t: any) => t.id === prev.truckId) ? prev.truckId : firstTruckId;
          return buildSiteFormForTruck(targetId, res);
        });
        setFuelForm((prev) =>
          candidateTrucks.some((t: any) => t.id === prev.truckId)
            ? prev
            : { ...prev, truckId: firstTruckId, odometerKm: String(candidateTrucks[0]?.odometer_km ?? prev.odometerKm) },
        );
      } else {
        setSiteForm({ truckId: '', siteName: '', shiftNotes: '' });
      }
    } catch (e: any) {
      setErr(e.message || 'Unable to load fleet data');
    }
  };

  useEffect(() => {
    if (mode !== 'fleet' || !fleetData?.trucks?.length) return;
    const allTrucks = fleetData.trucks;
    const matched =
      activeLocationId && activeLocationId !== 'ALL'
        ? allTrucks.filter((t: any) => t.location_id === activeLocationId)
        : allTrucks;
    const candidateTrucks = matched.length > 0 ? matched : allTrucks;
    const firstTruckId = candidateTrucks[0]?.id || '';
    if (!firstTruckId) return;
    setSiteForm((prev) => {
      const targetId = candidateTrucks.some((t: any) => t.id === prev.truckId) ? prev.truckId : firstTruckId;
      return buildSiteFormForTruck(targetId, fleetData);
    });
    setFuelForm((prev) =>
      candidateTrucks.some((t: any) => t.id === prev.truckId)
        ? prev
        : { ...prev, truckId: firstTruckId, odometerKm: String(candidateTrucks[0]?.odometer_km ?? prev.odometerKm) },
    );
  }, [mode, activeLocationId, fleetData]);
  const loadHr = async () => {
    try {
      setErr('');
      const res = await apiFetch('/hr');
      setHrData(res);
      if (res.payrollRules?.config) setRuleCfg(res.payrollRules.config);
    } catch (e: any) {
      setErr(e.message || 'Unable to load HR & Payroll data');
    }
  };

  useEffect(() => {
    if (mode !== 'hr' || !quickAction || !hrData) return;
    if (quickAction.action === 'new-payroll') {
      setPayrollModalErr('');
      setPayrollForm((f) => ({ ...f, useAttendanceDays }));
      setShowPayrollModal(true);
      onQuickActionHandled?.();
    } else if (quickAction.action === 'new-employee') {
      openCreateEmployee();
      onQuickActionHandled?.();
    } else if (quickAction.action === 'shift-templates') {
      shiftTemplatesSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      onQuickActionHandled?.();
    }
  }, [mode, quickAction, hrData]);

  useEffect(() => {
    if (mode === 'crm' && quickAction) {
      if (quickAction.action === 'loyalty-kiosk' || quickAction.action === 'crm-kiosk') {
        setCrmSubTab('kiosk');
        onQuickActionHandled?.();
      }
    }
  }, [mode, quickAction]);

  const addDaysIso = (baseIso: string, offsetDays: number) => {
    const [y, m, d] = baseIso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + offsetDays));
    return dt.toISOString().slice(0, 10);
  };

  const calcNetShiftHours = (startTime: string, endTime: string, breakMins: number) => {
    const [sh, sm] = String(startTime || '00:00').split(':').map(Number);
    const [eh, em] = String(endTime || '00:00').split(':').map(Number);
    if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return '—';
    const startM = sh * 60 + sm;
    let endM = eh * 60 + em;
    if (endM <= startM) endM += 1440;
    const netMins = Math.max(0, endM - startM - Number(breakMins || 0));
    return `${(netMins / 60).toFixed(1)}h net`;
  };

  const openCreateShiftTemplate = (preset?: { code: string; name: string; startTime: string; endTime: string; defaultRole: string }) => {
    setShiftTplErr('');
    const defaultLocs =
      activeLocationId && activeLocationId !== 'ALL'
        ? [activeLocationId]
        : locations.filter((l) => l.type === 'FOOD_TRUCK').map((l) => l.id);
    setShiftTplForm({
      code: preset?.code || '',
      name: preset?.name || '',
      startTime: preset?.startTime || '07:00',
      endTime: preset?.endTime || '15:00',
      breakMinutes: '60',
      daysOfWeek: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'],
      locationIds: defaultLocs.length > 0 ? defaultLocs : locations.map((l) => l.id),
      defaultRole: preset?.defaultRole || '',
      headcountNeeded: '2',
      notes: '',
      isActive: true,
    });
    setShiftTplModal({ mode: 'create' });
  };

  const openEditShiftTemplate = (tpl: any) => {
    setShiftTplErr('');
    setShiftTplForm({
      code: tpl.code || '',
      name: tpl.name || '',
      startTime: tpl.start_time || '07:00',
      endTime: tpl.end_time || '15:00',
      breakMinutes: String(tpl.break_minutes ?? 60),
      daysOfWeek: Array.isArray(tpl.days_of_week) && tpl.days_of_week.length > 0 ? tpl.days_of_week : ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'],
      locationIds: Array.isArray(tpl.location_ids) ? tpl.location_ids : [],
      defaultRole: tpl.default_role || '',
      headcountNeeded: String(tpl.headcount_needed ?? 2),
      notes: tpl.notes || '',
      isActive: tpl.is_active !== 0,
    });
    setShiftTplModal({ mode: 'edit', id: tpl.id });
  };

  const handleSaveShiftTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!shiftTplModal) return;
    setShiftTplErr('');
    if (shiftTplForm.daysOfWeek.length === 0) {
      setShiftTplErr('Select at least one recurring day of the week.');
      return;
    }
    setSavingShiftTpl(true);
    try {
      const payload = {
        code: shiftTplForm.code.trim().toUpperCase(),
        name: shiftTplForm.name.trim(),
        startTime: shiftTplForm.startTime,
        endTime: shiftTplForm.endTime,
        breakMinutes: Math.max(0, Math.min(480, Math.round(Number(shiftTplForm.breakMinutes || 0)))),
        daysOfWeek: shiftTplForm.daysOfWeek,
        locationIds: shiftTplForm.locationIds,
        defaultRole: shiftTplForm.defaultRole.trim() || null,
        headcountNeeded: Math.max(1, Math.min(100, Math.round(Number(shiftTplForm.headcountNeeded || 1)))),
        notes: shiftTplForm.notes.trim() || null,
        isActive: shiftTplForm.isActive,
      };
      if (shiftTplModal.mode === 'create') {
        await apiFetch('/hr/shift-templates', { method: 'POST', body: JSON.stringify(payload) });
        setMsg(`Created shift template "${payload.name}" (${payload.code}).`);
      } else {
        await apiFetch(`/hr/shift-templates/${shiftTplModal.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        setMsg(`Updated shift template "${payload.name}".`);
      }
      setShiftTplModal(null);
      await loadHr();
    } catch (error: any) {
      setShiftTplErr(error.message || 'Unable to save shift template');
    } finally {
      setSavingShiftTpl(false);
    }
  };

  const handleDeleteShiftTemplate = async () => {
    if (!deleteShiftTplTarget) return;
    setDeletingShiftTpl(true);
    try {
      setErr('');
      await apiFetch(`/hr/shift-templates/${deleteShiftTplTarget.id}`, { method: 'DELETE' });
      setMsg(`Deleted shift template "${deleteShiftTplTarget.name}".`);
      setDeleteShiftTplTarget(null);
      await loadHr();
    } catch (error: any) {
      setErr(error.message || 'Unable to delete shift template');
    } finally {
      setDeletingShiftTpl(false);
    }
  };

  const toUiShiftWindow = (s: any): ShiftWindowLike => ({
    id: s.id,
    templateId: s.template_id ?? null,
    templateName: s.template_name || 'Shift',
    locationId: s.location_id,
    locationName: s.location_name || locations.find((l) => l.id === s.location_id)?.name || s.location_id,
    employeeId: s.employee_id ?? null,
    employeeName: s.employee_name ?? null,
    employeeCode: s.employee_code ?? null,
    shiftDate: s.shift_date,
    startTime: s.start_time,
    endTime: s.end_time,
    status: s.status || 'SCHEDULED',
  });

  const buildGenSchedPreviewCandidates = (): ShiftWindowLike[] => {
    const tpl = (hrData?.shiftTemplates || []).find((t: any) => t.id === genSchedForm.templateId);
    if (!tpl || !genSchedForm.startDate || !genSchedForm.endDate || genSchedForm.startDate > genSchedForm.endDate) return [];
    if (genSchedForm.daysOfWeek.length === 0 || genSchedForm.locationIds.length === 0) return [];

    const [sy, sm, sd] = genSchedForm.startDate.split('-').map(Number);
    const [ey, em, ed] = genSchedForm.endDate.split('-').map(Number);
    const startMs = Date.UTC(sy, sm - 1, sd);
    const endMs = Date.UTC(ey, em - 1, ed);
    if (Math.round((endMs - startMs) / 86400000) + 1 > 62) return [];

    const weekdayMap = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    const activeCrew = (hrData?.employees || []).filter((e: any) => e.is_active !== 0);
    const existingActive = (hrData?.shiftSchedules || []).filter((s: any) => s.status !== 'CANCELLED');
    const headcount = Math.max(1, Math.min(20, Math.round(Number(genSchedForm.headcountPerLocation || 1))));
    const candidates: ShiftWindowLike[] = [];

    for (let t = startMs; t <= endMs; t += 86400000) {
      const dt = new Date(t);
      const dayCode = weekdayMap[dt.getUTCDay()];
      if (!genSchedForm.daysOfWeek.includes(dayCode)) continue;
      const dateStr = dt.toISOString().slice(0, 10);

      for (const locId of genSchedForm.locationIds) {
        const locName = locations.find((l) => l.id === locId)?.name || locId;
        const existingForSlot = existingActive.filter(
          (s: any) => s.template_id === tpl.id && s.location_id === locId && s.shift_date === dateStr,
        );

        if (genSchedForm.assignmentMode === 'SELECTED_EMPLOYEES') {
          for (const empId of genSchedForm.employeeIds) {
            if (existingForSlot.some((s: any) => s.employee_id === empId)) continue;
            const emp = activeCrew.find((e: any) => e.id === empId);
            candidates.push({
              id: `preview_${dateStr}_${locId}_${empId}`,
              templateId: tpl.id,
              templateName: tpl.name,
              locationId: locId,
              locationName: locName,
              employeeId: empId,
              employeeName: emp?.full_name || empId,
              employeeCode: emp?.employee_code || null,
              shiftDate: dateStr,
              startTime: tpl.start_time,
              endTime: tpl.end_time,
              status: 'SCHEDULED',
            });
          }
        } else if (genSchedForm.assignmentMode === 'AUTO_BY_LOCATION') {
          const locEmps = activeCrew.filter((e: any) => e.location_id === locId).slice(0, headcount);
          for (const emp of locEmps) {
            if (existingForSlot.some((s: any) => s.employee_id === emp.id)) continue;
            candidates.push({
              id: `preview_${dateStr}_${locId}_${emp.id}`,
              templateId: tpl.id,
              templateName: tpl.name,
              locationId: locId,
              locationName: locName,
              employeeId: emp.id,
              employeeName: emp.full_name,
              employeeCode: emp.employee_code || null,
              shiftDate: dateStr,
              startTime: tpl.start_time,
              endTime: tpl.end_time,
              status: 'SCHEDULED',
            });
          }
        }
      }
    }
    return candidates;
  };

  const openGenerateScheduleModal = (tpl?: any) => {
    const templatesList = hrData?.shiftTemplates || [];
    const chosen = tpl || templatesList.find((t: any) => t.is_active !== 0) || templatesList[0];
    if (!chosen) {
      openCreateShiftTemplate({ code: 'OPEN', name: 'Opening Shift', startTime: '07:00', endTime: '15:00', defaultRole: 'Lead Cashier / Prep Cook' });
      return;
    }
    const today = getTodayLocalDate();
    const tplLocs = Array.isArray(chosen.location_ids) && chosen.location_ids.length > 0
      ? chosen.location_ids.filter((id: string) => locations.some((l) => l.id === id))
      : locations.map((l) => l.id);
    const scopedLocs =
      activeLocationId && activeLocationId !== 'ALL' && locations.some((l) => l.id === activeLocationId)
        ? [activeLocationId]
        : tplLocs;

    setGenSchedErr('');
    setGenSchedConflicts([]);
    setGenSchedForm({
      templateId: chosen.id,
      startDate: today,
      endDate: addDaysIso(today, 6),
      daysOfWeek: Array.isArray(chosen.days_of_week) && chosen.days_of_week.length > 0 ? chosen.days_of_week : ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'],
      locationIds: scopedLocs.length > 0 ? scopedLocs : locations.map((l) => l.id),
      assignmentMode: 'AUTO_BY_LOCATION',
      employeeIds: [],
      headcountPerLocation: String(chosen.headcount_needed ?? 2),
      notes: chosen.notes || '',
    });
    setGenSchedModal({ templateId: chosen.id });
  };

  const applyTemplateDefaultsToGenForm = (templateId: string) => {
    const tpl = (hrData?.shiftTemplates || []).find((t: any) => t.id === templateId);
    setGenSchedConflicts([]);
    if (!tpl) {
      setGenSchedForm((f) => ({ ...f, templateId }));
      return;
    }
    const tplLocs = Array.isArray(tpl.location_ids) && tpl.location_ids.length > 0
      ? tpl.location_ids.filter((id: string) => locations.some((l) => l.id === id))
      : locations.map((l) => l.id);
    setGenSchedForm((f) => ({
      ...f,
      templateId,
      daysOfWeek: Array.isArray(tpl.days_of_week) && tpl.days_of_week.length > 0 ? tpl.days_of_week : f.daysOfWeek,
      locationIds: tplLocs.length > 0 ? tplLocs : f.locationIds,
      headcountPerLocation: String(tpl.headcount_needed ?? f.headcountPerLocation),
      notes: tpl.notes || '',
    }));
  };

  const executeGenerateSchedules = async (conflictPolicy: 'PROMPT' | 'SKIP_CONFLICTS' | 'ALLOW_CONFLICTS') => {
    setGenSchedErr('');
    if (!genSchedForm.templateId) {
      setGenSchedErr('Select a shift template.');
      return;
    }
    if (genSchedForm.locationIds.length === 0) {
      setGenSchedErr('Select at least one location.');
      return;
    }
    if (genSchedForm.daysOfWeek.length === 0) {
      setGenSchedErr('Select at least one day of the week.');
      return;
    }
    if (genSchedForm.assignmentMode === 'SELECTED_EMPLOYEES' && genSchedForm.employeeIds.length === 0) {
      setGenSchedErr('Select at least one employee or switch assignment mode.');
      return;
    }
    setGeneratingSched(true);
    try {
      const res = await apiFetch<{
        saved?: boolean;
        requiresConfirmation?: boolean;
        createdCount: number;
        skippedCount: number;
        conflicts?: ShiftOverlapConflict[];
        createdIds?: string[];
      }>('/hr/shift-schedules/generate', {
        method: 'POST',
        body: JSON.stringify({
          templateId: genSchedForm.templateId,
          locationIds: genSchedForm.locationIds,
          startDate: genSchedForm.startDate,
          endDate: genSchedForm.endDate,
          daysOfWeek: genSchedForm.daysOfWeek,
          assignmentMode: genSchedForm.assignmentMode,
          employeeIds: genSchedForm.assignmentMode === 'SELECTED_EMPLOYEES' ? genSchedForm.employeeIds : [],
          headcountPerLocation: Math.max(1, Math.min(20, Math.round(Number(genSchedForm.headcountPerLocation || 1)))),
          notes: genSchedForm.notes.trim() || null,
          conflictPolicy,
        }),
      });

      if (res.requiresConfirmation && (res.conflicts?.length || 0) > 0) {
        setGenSchedConflicts(res.conflicts || []);
        return;
      }

      const savedConflicts = res.conflicts || [];
      setGenSchedModal(null);
      setGenSchedConflicts([]);
      if (savedConflicts.length > 0) {
        const flaggedIds = Array.from(
          new Set(savedConflicts.flatMap((c) => [c.newScheduleId, c.existingScheduleId]).filter(Boolean)),
        );
        setRecentConflictScheduleIds(flaggedIds);
        setSchedConflictsOnly(true);
        setErr(
          `Saved ${res.createdCount} shift slot(s) with ${savedConflicts.length} overlapping crew conflict(s). Conflicting shifts are highlighted below for review.`,
        );
      } else {
        setRecentConflictScheduleIds([]);
        setMsg(
          `Generated ${res.createdCount} shift slot(s) across ${genSchedForm.locationIds.length} location(s)${res.skippedCount > 0 ? ` (${res.skippedCount} slot(s) skipped)` : ''}.`,
        );
      }
      await loadHr();
    } catch (error: any) {
      setGenSchedErr(error.message || 'Unable to generate recurring schedules');
    } finally {
      setGeneratingSched(false);
    }
  };

  const handleGenerateSchedules = async (e: React.FormEvent) => {
    e.preventDefault();
    await executeGenerateSchedules('PROMPT');
  };

  const openSingleShiftModal = () => {
    const activeTpls = (hrData?.shiftTemplates || []).filter((t: any) => t.is_active !== 0);
    const firstTpl = activeTpls[0];
    const defaultLoc =
      activeLocationId && activeLocationId !== 'ALL' && locations.some((l) => l.id === activeLocationId)
        ? activeLocationId
        : locations.find((l) => l.type === 'FOOD_TRUCK')?.id || locations[0]?.id || '';
    setSingleShiftErr('');
    setSingleShiftConflicts([]);
    setSingleShiftForm({
      templateId: firstTpl?.id || '',
      templateName: firstTpl?.name || 'Custom Shift',
      locationId: defaultLoc,
      employeeId: '',
      shiftDate: schedFilterDate || getTodayLocalDate(),
      startTime: firstTpl?.start_time || '07:00',
      endTime: firstTpl?.end_time || '15:00',
      breakMinutes: String(firstTpl?.break_minutes ?? 60),
      status: 'SCHEDULED',
      notes: '',
    });
    setSingleShiftModal(true);
  };

  const handleSingleShiftTemplateSelect = (tplId: string) => {
    const tpl = (hrData?.shiftTemplates || []).find((t: any) => t.id === tplId);
    setSingleShiftConflicts([]);
    if (!tpl) {
      setSingleShiftForm((f) => ({ ...f, templateId: '', templateName: 'Custom Shift' }));
      return;
    }
    setSingleShiftForm((f) => ({
      ...f,
      templateId: tpl.id,
      templateName: tpl.name,
      startTime: tpl.start_time || f.startTime,
      endTime: tpl.end_time || f.endTime,
      breakMinutes: String(tpl.break_minutes ?? f.breakMinutes),
    }));
  };

  const submitSingleShift = async (conflictPolicy: 'PROMPT' | 'ALLOW_CONFLICTS') => {
    setSingleShiftErr('');
    if (!singleShiftForm.locationId) {
      setSingleShiftErr('Select a location.');
      return;
    }
    if (!singleShiftForm.shiftDate) {
      setSingleShiftErr('Select a shift date.');
      return;
    }
    setSavingSingleShift(true);
    try {
      const res = await apiFetch<{
        saved?: boolean;
        requiresConfirmation?: boolean;
        id?: string;
        conflicts?: ShiftOverlapConflict[];
      }>('/hr/shift-schedules', {
        method: 'POST',
        body: JSON.stringify({
          templateId: singleShiftForm.templateId || null,
          templateName: singleShiftForm.templateName.trim() || 'Custom Shift',
          locationId: singleShiftForm.locationId,
          employeeId: singleShiftForm.employeeId || null,
          shiftDate: singleShiftForm.shiftDate,
          startTime: singleShiftForm.startTime,
          endTime: singleShiftForm.endTime,
          breakMinutes: Math.max(0, Math.min(480, Math.round(Number(singleShiftForm.breakMinutes || 0)))),
          status: singleShiftForm.status,
          notes: singleShiftForm.notes.trim() || null,
          conflictPolicy,
        }),
      });

      if (res.requiresConfirmation && (res.conflicts?.length || 0) > 0) {
        setSingleShiftConflicts(res.conflicts || []);
        return;
      }

      const savedConflicts = res.conflicts || [];
      setSingleShiftModal(false);
      setSingleShiftConflicts([]);
      if (savedConflicts.length > 0) {
        const flaggedIds = Array.from(
          new Set(savedConflicts.flatMap((c) => [c.newScheduleId, c.existingScheduleId]).filter(Boolean)),
        );
        setRecentConflictScheduleIds(flaggedIds);
        setSchedConflictsOnly(true);
        const c = savedConflicts[0];
        setErr(
          `Shift saved with overlap conflict: ${c.employeeName} already works ${c.existingTemplateName} (${c.existingTimeRange} · ${c.existingLocationName}) on ${c.shiftDate}. Highlighted below.`,
        );
      } else {
        setRecentConflictScheduleIds([]);
        setMsg(`Scheduled "${singleShiftForm.templateName}" on ${singleShiftForm.shiftDate}.`);
      }
      await loadHr();
    } catch (error: any) {
      setSingleShiftErr(error.message || 'Unable to save shift schedule');
    } finally {
      setSavingSingleShift(false);
    }
  };

  const handleUpdateScheduleSlot = async (schedId: string, patch: { employeeId?: string | null; status?: string }) => {
    setSchedUpdatingId(schedId);
    try {
      setErr('');
      const res = await apiFetch<{ ok: boolean; conflicts?: ShiftOverlapConflict[] }>(`/hr/shift-schedules/${schedId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      const conflicts = res?.conflicts || [];
      if (conflicts.length > 0) {
        const c = conflicts[0];
        const flaggedIds = Array.from(
          new Set(conflicts.flatMap((item) => [item.newScheduleId, item.existingScheduleId]).filter(Boolean)),
        );
        setRecentConflictScheduleIds(flaggedIds);
        setErr(
          `Overlap Alert: ${c.employeeName} already has ${c.existingTemplateName} (${c.existingTimeRange} at ${c.existingLocationName}) on ${c.shiftDate} (${formatOverlapDuration(c.overlapMinutes)} overlap). Highlighted in roster below.`,
        );
      } else {
        setRecentConflictScheduleIds((prev) => prev.filter((id) => id !== schedId));
      }
      await loadHr();
    } catch (error: any) {
      setErr(error.message || 'Unable to update scheduled shift');
    } finally {
      setSchedUpdatingId(null);
    }
  };

  const handleDeleteScheduleSlot = async (schedId: string) => {
    setSchedUpdatingId(schedId);
    try {
      setErr('');
      await apiFetch(`/hr/shift-schedules/${schedId}`, { method: 'DELETE' });
      setRecentConflictScheduleIds((prev) => prev.filter((id) => id !== schedId));
      setMsg('Removed shift schedule entry.');
      await loadHr();
    } catch (error: any) {
      setErr(error.message || 'Unable to remove scheduled shift');
    } finally {
      setSchedUpdatingId(null);
    }
  };
  const loadCrm = async () => {
    try {
      setErr('');
      setCustomers(await apiFetch('/crm/customers'));
    } catch (e: any) {
      setErr(e.message || 'Unable to load customer CRM data');
    }
  };
  const loadReports = async (type = reportType, from = reportFrom, to = reportTo, locId = locationFilter) => {
    if (from && to && from > to) {
      setErr('"Date From" cannot be later than "Until Date".');
      return;
    }
    try {
      setErr('');
      const qs = new URLSearchParams();
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      if (locId) qs.set('locationId', locId);
      const querySuffix = qs.toString() ? `?${qs.toString()}` : '';
      const [rows, gov] = await Promise.all([
        apiFetch(`/reports/${type}${querySuffix}`),
        apiFetch(`/admin/governance${querySuffix}`).catch(() => null),
      ]);
      setReportRows(rows);
      setGovernance(gov);
    } catch (e: any) {
      setErr(e.message || 'Unable to load reports');
    }
  };

  useEffect(() => {
    if (mode === 'fleet') loadFleet();
    if (mode === 'hr') loadHr();
    if (mode === 'crm') loadCrm();
    if (mode === 'reports') loadReports(reportType, reportFrom, reportTo, locationFilter);
  }, [mode, reportType, reportFrom, reportTo, locationFilter]);

  useEffect(() => {
    if (mode !== 'crm') return;
    setCustForm((prev) => {
      const nextLoc =
        activeLocationId && activeLocationId !== 'ALL' && locations.some((l) => l.id === activeLocationId)
          ? activeLocationId
          : prev.locationId && locations.some((l) => l.id === prev.locationId)
            ? prev.locationId
            : locations.find((l) => l.type === 'FOOD_TRUCK')?.id || locations[0]?.id || '';
      return nextLoc === prev.locationId ? prev : { ...prev, locationId: nextLoc };
    });
  }, [mode, activeLocationId, locations]);

  const applyDatePreset = (daysBack: number | 'today' | 'all') => {
    if (daysBack === 'all') {
      setReportFrom('');
      setReportTo('');
      return;
    }
    const end = new Date();
    const start = new Date(end);
    if (daysBack !== 'today') {
      start.setDate(end.getDate() - daysBack);
    }
    setReportFrom(start.toISOString().slice(0, 10));
    setReportTo(end.toISOString().slice(0, 10));
  };

  // ==========================================
  // FLEET & FOOD TRUCKS
  // ==========================================
  const openAddFleetModal = () => {
    setFleetModalErr('');
    const nextTruckNum = (fleetData?.trucks?.length || 0) + 1;
    setFleetForm({
      locationId: '',
      type: 'FOOD_TRUCK',
      code: `TRK-0${nextTruckNum}`,
      name: '',
      address: '',
      plateNumber: '',
      makeModel: '',
      currentSite: '',
      odometerKm: '0',
      status: 'ACTIVE',
      kdsEnabled: true,
    });
    setFleetModal('add');
  };

  const openEditLocationModal = (loc: any) => {
    setFleetModalErr('');
    const locKdsEnabled = loc.kds_enabled !== undefined ? Boolean(loc.kds_enabled) : loc.type !== 'COMMISSARY';
    setFleetForm({
      locationId: loc.id,
      type: loc.type === 'COMMISSARY' ? 'COMMISSARY' : 'FOOD_TRUCK',
      code: loc.code || '',
      name: loc.name || '',
      address: loc.address || '',
      plateNumber: loc.plate_number || '',
      makeModel: loc.make_model || '',
      currentSite: loc.current_site || '',
      odometerKm: String(loc.odometer_km ?? 0),
      status: loc.status || 'ACTIVE',
      kdsEnabled: locKdsEnabled,
    });
    setFleetModal('edit');
  };

  const handleToggleLocationKds = async (locationId: string, locationName: string, nextEnabled: boolean) => {
    setErr('');
    setMsg('');
    setTogglingKdsId(locationId);
    try {
      await apiFetch(`/fleet/locations/${locationId}/kds`, {
        method: 'PATCH',
        body: JSON.stringify({ kdsEnabled: nextEnabled }),
      });
      setMsg(`KDS ${nextEnabled ? 'enabled' : 'disabled'} for "${locationName}".`);
      await Promise.all([loadFleet(), onLocationsChanged?.()]);
    } catch (e: any) {
      setErr(e.message || 'Unable to update KDS setting');
    } finally {
      setTogglingKdsId(null);
    }
  };

  const handleSaveFleet = async (e: React.FormEvent) => {
    e.preventDefault();
    setFleetModalErr('');
    setSavingFleet(true);
    try {
      const payload = {
        name: fleetForm.name,
        code: fleetForm.code,
        type: fleetForm.type,
        address: fleetForm.address,
        plateNumber: fleetForm.plateNumber,
        makeModel: fleetForm.makeModel,
        currentSite: fleetForm.currentSite,
        odometerKm: Number(fleetForm.odometerKm || 0),
        status: fleetForm.status,
        kdsEnabled: Boolean(fleetForm.kdsEnabled),
      };
      if (fleetModal === 'add') {
        await apiFetch('/fleet/trucks', { method: 'POST', body: JSON.stringify(payload) });
        setMsg(`Added ${fleetForm.type === 'COMMISSARY' ? 'location' : 'food truck'} "${fleetForm.name}".`);
      } else if (fleetModal === 'edit' && fleetForm.locationId) {
        await apiFetch(`/fleet/locations/${fleetForm.locationId}`, { method: 'PUT', body: JSON.stringify(payload) });
        setMsg(`Updated "${fleetForm.name}".`);
      }
      setFleetModal(null);
      await Promise.all([loadFleet(), onLocationsChanged?.()]);
    } catch (e: any) {
      setFleetModalErr(e.message || 'Unable to save truck / location');
    } finally {
      setSavingFleet(false);
    }
  };

  const handleDeleteFleetLocation = async () => {
    if (!deleteLocTarget) return;
    setDeletingLoc(true);
    setErr('');
    try {
      const targetId = deleteLocTarget.location_id || deleteLocTarget.id;
      const res = await apiFetch<any>(`/fleet/locations/${targetId}`, { method: 'DELETE' });
      const targetName = deleteLocTarget.location_name || deleteLocTarget.name || 'Location';
      setMsg(
        res?.archived
          ? `Archived "${targetName}" (historical transactions preserved).`
          : `Deleted "${targetName}".`,
      );
      setDeleteLocTarget(null);
      await Promise.all([loadFleet(), onLocationsChanged?.()]);
    } catch (e: any) {
      setErr(e.message || 'Unable to delete truck / location');
      setDeleteLocTarget(null);
    } finally {
      setDeletingLoc(false);
    }
  };

  if (mode === 'fleet') {
    if (err && !fleetData) return <div className="p-4 rounded-lg border border-red-200 dark:border-red-800/80 bg-red-50 dark:bg-red-950/50 text-xs text-red-700 dark:text-red-300 font-medium">{err}</div>;
    if (!fleetData) return <div className="h-64 rounded-xl border bg-white dark:bg-slate-900 animate-pulse" />;
    const isLocFiltered = Boolean(activeLocationId && activeLocationId !== 'ALL');
    const allFleetTrucks = Array.isArray(fleetData.trucks) ? fleetData.trucks : [];
    const visibleFleetTrucks = isLocFiltered
      ? allFleetTrucks.filter((t: any) => t.location_id === activeLocationId)
      : allFleetTrucks;
    const allFleetLocations = Array.isArray(fleetData.locations) ? fleetData.locations : [];
    const fleetLocations = isLocFiltered
      ? allFleetLocations.filter((loc: any) => loc.id === activeLocationId)
      : allFleetLocations;
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-semibold text-slate-900 dark:text-slate-50">Food Trucks &amp; Locations</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">Per-truck profitability, fleet maintenance checkups, daily site dispatch, and branch management</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {visibleFleetTrucks.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setMaintPreselectTruckId(visibleFleetTrucks[0]?.id || null);
                  maintSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                <Wrench className="w-3.5 h-3.5" /> Log Maintenance
              </button>
            )}
            <button
              type="button"
              onClick={openAddFleetModal}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-4 py-2 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" /> Add Truck / Location
            </button>
          </div>
        </div>
        {msg && <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/45 border border-emerald-200 dark:border-emerald-700/80 text-xs text-emerald-800 dark:text-emerald-300 font-medium">{msg}</div>}
        {err && <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">{err}</div>}

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/60 flex items-center justify-between">
            <h2 className="font-display text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">Food Truck Fleet Performance</h2>
            <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">{visibleFleetTrucks.length} truck(s)</span>
          </div>
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
              <tr>
                <th className="p-3 font-medium">Truck / Plate</th>
                <th className="p-3 font-medium">Current Site &amp; Location</th>
                <th className="p-3 font-medium">Status</th>
                <th className="p-3 font-medium">KDS</th>
                <th className="p-3 font-medium">Maintenance &amp; Checkup</th>
                <th className="p-3 font-medium text-right">Odometer</th>
                <th className="p-3 font-medium text-right">Total Sales</th>
                <th className="p-3 font-medium text-right">COGS</th>
                <th className="p-3 font-medium text-right">Expenses</th>
                <th className="p-3 font-medium text-right">Net Contribution</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {visibleFleetTrucks.length === 0 ? (
                <tr>
                  <td colSpan={10} className="p-6 text-center text-xs text-slate-500 dark:text-slate-400">
                    {isLocFiltered
                      ? 'Selected location is a Commissary / non-truck branch.'
                      : 'No active food trucks yet. Click “Add Truck / Location” to register one.'}
                  </td>
                </tr>
              ) : (
                visibleFleetTrucks.map((t: any) => {
                  const net = t.total_sales - t.total_cogs - t.total_expenses;
                  const truckKdsOn = t.kds_enabled !== 0;
                  const overdueAlerts = Number(t.overdue_alerts || 0);
                  const dueSoonAlerts = Number(t.due_soon_alerts || 0);
                  return (
                    <tr key={t.id}>
                      <td className="p-3">
                        <p className="font-semibold text-slate-900 dark:text-slate-50 flex items-center gap-1.5">
                          <Truck className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400 shrink-0" /> {t.location_name}
                        </p>
                        <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                          {t.location_code ? `${t.location_code} · ` : ''}{t.plate_number} · {t.make_model}
                        </p>
                      </td>
                      <td className="p-3 text-slate-700 dark:text-slate-200">
                        <p className="font-medium text-slate-800 dark:text-slate-100">{t.current_site || 'Unassigned'}</p>
                        {t.location_address && <p className="text-[11px] text-slate-500 dark:text-slate-400">{t.location_address}</p>}
                      </td>
                      <td className="p-3">
                        <span
                          className={`inline-block rounded px-2 py-0.5 text-[11px] font-semibold ${
                            t.status === 'ACTIVE'
                              ? 'bg-emerald-50 dark:bg-emerald-950/45 text-emerald-700 dark:text-emerald-300'
                              : t.status === 'MAINTENANCE'
                                ? 'bg-amber-50 dark:bg-amber-950/45 text-amber-700 dark:text-amber-300'
                                : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                          }`}
                        >
                          {t.status}
                        </span>
                      </td>
                      <td className="p-3">
                        <button
                          type="button"
                          disabled={togglingKdsId === t.location_id}
                          onClick={() => handleToggleLocationKds(t.location_id, t.location_name, !truckKdsOn)}
                          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-semibold border transition-colors whitespace-nowrap disabled:opacity-50 ${
                            truckKdsOn
                              ? 'bg-emerald-50 dark:bg-emerald-950/45 border-emerald-200 dark:border-emerald-700/80 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/60'
                              : 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                          }`}
                          title="Click to enable or disable KDS for this truck"
                        >
                          <ChefHat className="w-3 h-3" />
                          {truckKdsOn ? 'KDS On' : 'KDS Off'}
                        </button>
                      </td>
                      <td className="p-3">
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-1.5 text-[11px]">
                            <span className="font-mono tabular-nums font-semibold text-slate-800 dark:text-slate-100">
                              {formatPHP(Number(t.maintenance_cost_total || 0))}
                            </span>
                            <span className="text-slate-500 dark:text-slate-400">·</span>
                            <button
                              type="button"
                              onClick={() => {
                                setMaintPreselectTruckId(t.id);
                                maintSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                              }}
                              className="text-slate-700 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white font-medium underline"
                            >
                              Log Service
                            </button>
                          </div>
                          <p
                            className={`text-[11px] font-mono tabular-nums ${
                              overdueAlerts > 0
                                ? 'font-semibold text-red-700 dark:text-red-300'
                                : dueSoonAlerts > 0
                                  ? 'font-semibold text-amber-700 dark:text-amber-300'
                                  : 'text-slate-500 dark:text-slate-400'
                            }`}
                          >
                            {overdueAlerts > 0
                              ? `${overdueAlerts} overdue checkup`
                              : dueSoonAlerts > 0
                                ? `${dueSoonAlerts} due soon (${t.next_due_date || 'check'})`
                                : t.next_due_date
                                  ? `Next due ${t.next_due_date}`
                                  : 'No checkup scheduled'}
                          </p>
                        </div>
                      </td>
                      <td className="p-3 text-right font-mono tabular-nums">{Number(t.odometer_km || 0).toLocaleString()} km</td>
                      <td className="p-3 text-right font-mono tabular-nums">{formatPHP(t.total_sales)}</td>
                      <td className="p-3 text-right font-mono tabular-nums">{formatPHP(t.total_cogs)}</td>
                      <td className="p-3 text-right font-mono tabular-nums">{formatPHP(t.total_expenses)}</td>
                      <td className={`p-3 text-right font-mono tabular-nums font-bold ${net >= 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'}`}>
                        {formatPHP(net)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div ref={maintSectionRef}>
          <FleetMaintenanceSection
            trucks={visibleFleetTrucks}
            maintenanceLogs={Array.isArray(fleetData.maintenanceLogs) ? fleetData.maintenanceLogs : []}
            activeLocationId={activeLocationId}
            preselectedTruckId={maintPreselectTruckId}
            onClearPreselect={() => setMaintPreselectTruckId(null)}
            onMaintenanceSaved={async (message) => {
              setMsg(message);
              await Promise.all([loadFleet(), onNotificationsChanged?.()]);
            }}
          />
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/60 flex items-center justify-between">
            <h2 className="font-display text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">All Active Branches &amp; Commissary Locations</h2>
            <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">{fleetLocations.length} location(s)</span>
          </div>
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
              <tr>
                <th className="p-3 font-medium">Code</th>
                <th className="p-3 font-medium">Location / Truck Name</th>
                <th className="p-3 font-medium">Type</th>
                <th className="p-3 font-medium">Address / Base Location</th>
                <th className="p-3 font-medium">KDS Setting</th>
                <th className="p-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {fleetLocations.map((loc: any) => {
                const locKdsOn = loc.kds_enabled !== undefined ? Boolean(loc.kds_enabled) : loc.type !== 'COMMISSARY';
                return (
                  <tr key={loc.id}>
                    <td className="p-3 font-mono text-slate-600 dark:text-slate-300 whitespace-nowrap">{loc.code}</td>
                    <td className="p-3 font-semibold text-slate-900 dark:text-slate-50">{loc.name}</td>
                    <td className="p-3 text-slate-600 dark:text-slate-300">{loc.type === 'COMMISSARY' ? 'Commissary' : 'Food Truck'}</td>
                    <td className="p-3 text-slate-600 dark:text-slate-300">{loc.address || '—'}</td>
                    <td className="p-3">
                      <button
                        type="button"
                        disabled={togglingKdsId === loc.id}
                        onClick={() => handleToggleLocationKds(loc.id, loc.name, !locKdsOn)}
                        className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-colors whitespace-nowrap disabled:opacity-50 ${
                          locKdsOn
                            ? 'border-emerald-200 dark:border-emerald-700/80 bg-emerald-50 dark:bg-emerald-950/45 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/60'
                            : 'border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                        }`}
                      >
                        <ChefHat className="w-3 h-3" />
                        {togglingKdsId === loc.id ? 'Updating...' : locKdsOn ? 'KDS Available' : 'KDS Disabled'}
                      </button>
                    </td>
                    <td className="p-3 text-right whitespace-nowrap space-x-1.5">
                      <button
                        type="button"
                        onClick={() => openEditLocationModal(loc)}
                        className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-slate-800 px-2 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                      >
                        <Pencil className="w-3 h-3" /> Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteLocTarget(loc)}
                        className="inline-flex items-center gap-1 rounded border border-red-200 dark:border-red-800/80 px-2 py-1 text-[11px] font-medium text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/70"
                      >
                        <Trash2 className="w-3 h-3" /> Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setErr('');
              try {
                await apiFetch('/fleet/assignments', { method: 'POST', body: JSON.stringify(siteForm) });
                setMsg('Updated daily truck site assignment.');
                await loadFleet();
              } catch (e: any) {
                setErr(e.message || 'Unable to save site assignment');
              }
            }}
            className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3"
          >
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50">Assign Daily Truck Site</h2>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Food Truck</label>
              <select
                value={siteForm.truckId}
                onChange={(e) => setSiteForm(buildSiteFormForTruck(e.target.value, fleetData))}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
              >
                {fleetData.trucks.map((t: any) => <option key={t.id} value={t.id}>{t.location_name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Pop-up / Park Site Name *</label>
              <input required placeholder="e.g. Salcedo Weekend Market" value={siteForm.siteName} onChange={(e) => setSiteForm({ ...siteForm, siteName: e.target.value })} className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Shift Notes</label>
              <input placeholder="Optional shift instructions or parking slot" value={siteForm.shiftNotes} onChange={(e) => setSiteForm({ ...siteForm, shiftNotes: e.target.value })} className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs" />
            </div>
            <button type="submit" disabled={fleetData.trucks.length === 0} className="rounded-lg bg-slate-900 dark:bg-slate-100 px-4 py-2 text-xs font-semibold text-white dark:text-slate-950 disabled:opacity-50">Save Site Assignment</button>
          </form>

          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setErr('');
              try {
                await apiFetch('/fleet/fuel', { method: 'POST', body: JSON.stringify(fuelForm) });
                setMsg('Fuel log recorded and linked to Operating Expenses.');
                await loadFleet();
              } catch (e: any) {
                setErr(e.message || 'Unable to record fuel log');
              }
            }}
            className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3"
          >
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50">Log Fuel Fill-up (Auto-Posts Expense)</h2>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Food Truck</label>
              <select value={fuelForm.truckId} onChange={(e) => setFuelForm({ ...fuelForm, truckId: e.target.value })} className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs">
                {fleetData.trucks.map((t: any) => <option key={t.id} value={t.id}>{t.location_name}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-3 gap-2.5">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Fuel (Liters)</label>
                <input type="number" step="0.1" placeholder="Liters" value={fuelForm.liters} onChange={(e) => setFuelForm({ ...fuelForm, liters: e.target.value })} className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Total Cost (PHP)</label>
                <input type="number" step="0.01" placeholder="Cost (PHP)" value={fuelForm.totalCost} onChange={(e) => setFuelForm({ ...fuelForm, totalCost: e.target.value })} className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Odometer (km)</label>
                <input type="number" placeholder="Odometer" value={fuelForm.odometerKm} onChange={(e) => setFuelForm({ ...fuelForm, odometerKm: e.target.value })} className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono" />
              </div>
            </div>
            <button type="submit" disabled={fleetData.trucks.length === 0} className="rounded-lg bg-slate-900 dark:bg-slate-100 px-4 py-2 text-xs font-semibold text-white dark:text-slate-950 disabled:opacity-50">Record Fuel Log</button>
          </form>
        </div>

        {/* Add / Edit Food Truck & Location Modal */}
        {fleetModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <form
              onSubmit={handleSaveFleet}
              className="w-full max-w-lg rounded-xl bg-white dark:bg-slate-900 p-5 space-y-4 border border-slate-200 dark:border-slate-800 max-h-[90vh] overflow-y-auto"
            >
              <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800/80 pb-3">
                <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">
                  {fleetModal === 'add' ? 'Add Food Truck / Location' : 'Edit Food Truck / Location'}
                </h3>
                <button
                  type="button"
                  onClick={() => setFleetModal(null)}
                  className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {fleetModalErr && (
                <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">
                  {fleetModalErr}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Location Type</label>
                  <select
                    value={fleetForm.type}
                    onChange={(e) => {
                      const nextType = e.target.value as 'FOOD_TRUCK' | 'COMMISSARY';
                      setFleetForm((f) => ({
                        ...f,
                        type: nextType,
                        kdsEnabled: fleetModal === 'add' ? nextType === 'FOOD_TRUCK' : f.kdsEnabled,
                        code:
                          fleetModal === 'add' && (!f.code || f.code.startsWith('TRK-') || f.code.startsWith('COM-'))
                            ? nextType === 'COMMISSARY'
                              ? `COM-0${(fleetData?.locations?.length || 0) + 1}`
                              : `TRK-0${(fleetData?.trucks?.length || 0) + 1}`
                            : f.code,
                      }));
                    }}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                  >
                    <option value="FOOD_TRUCK">Food Truck</option>
                    <option value="COMMISSARY">Commissary / Branch</option>
                  </select>
                </div>

                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Location Code *</label>
                  <input
                    required
                    placeholder="e.g. TRK-03"
                    value={fleetForm.code}
                    onChange={(e) => setFleetForm({ ...fleetForm, code: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Truck / Location Name *</label>
                  <input
                    required
                    placeholder="e.g. Truck 03 — Rockwell Makati"
                    value={fleetForm.name}
                    onChange={(e) => setFleetForm({ ...fleetForm, name: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Address / Street Location</label>
                  <input
                    placeholder="e.g. Power Plant Mall Driveway, Makati"
                    value={fleetForm.address}
                    onChange={(e) => setFleetForm({ ...fleetForm, address: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                  />
                </div>

                {fleetForm.type === 'FOOD_TRUCK' && (
                  <>
                    <div>
                      <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Plate Number *</label>
                      <input
                        required
                        placeholder="e.g. NDC-5520"
                        value={fleetForm.plateNumber}
                        onChange={(e) => setFleetForm({ ...fleetForm, plateNumber: e.target.value })}
                        className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Vehicle Make / Model *</label>
                      <input
                        required
                        placeholder="e.g. Isuzu Traviz Kitchen Rig"
                        value={fleetForm.makeModel}
                        onChange={(e) => setFleetForm({ ...fleetForm, makeModel: e.target.value })}
                        className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Current Pop-up Site</label>
                      <input
                        placeholder="e.g. Rockwell Weekend Market"
                        value={fleetForm.currentSite}
                        onChange={(e) => setFleetForm({ ...fleetForm, currentSite: e.target.value })}
                        className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Odometer (km)</label>
                        <input
                          type="number"
                          min="0"
                          value={fleetForm.odometerKm}
                          onChange={(e) => setFleetForm({ ...fleetForm, odometerKm: e.target.value })}
                          className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                        />
                      </div>
                      <div>
                        <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Status</label>
                        <select
                          value={fleetForm.status}
                          onChange={(e) => setFleetForm({ ...fleetForm, status: e.target.value as any })}
                          className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-2 py-2 text-xs"
                        >
                          <option value="ACTIVE">ACTIVE</option>
                          <option value="MAINTENANCE">MAINTENANCE</option>
                          <option value="INACTIVE">INACTIVE</option>
                        </select>
                      </div>
                    </div>
                  </>
                )}

                <div className="sm:col-span-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 p-3 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold text-slate-900 dark:text-slate-50 flex items-center gap-1.5">
                      <ChefHat className="w-3.5 h-3.5 text-slate-700 dark:text-slate-200" />
                      Kitchen Display System (KDS) Availability
                    </p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                      {fleetForm.kdsEnabled
                        ? 'Enabled — POS orders route to the KDS prep queue before handoff.'
                        : 'Disabled — POS orders complete directly without entering KDS.'}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={fleetForm.kdsEnabled}
                    onClick={() => setFleetForm((f) => ({ ...f, kdsEnabled: !f.kdsEnabled }))}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                      fleetForm.kdsEnabled ? 'bg-emerald-600' : 'bg-slate-300'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white dark:bg-slate-900 shadow transition-transform ${
                        fleetForm.kdsEnabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800/80">
                <button
                  type="button"
                  onClick={() => setFleetModal(null)}
                  className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingFleet}
                  className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 text-xs font-semibold hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50"
                >
                  {savingFleet ? 'Saving...' : fleetModal === 'add' ? 'Save Truck / Location' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Delete Confirmation Modal */}
        {deleteLocTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 p-5 space-y-4 border border-slate-200 dark:border-slate-800">
              <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">
                Delete {deleteLocTarget.location_name || deleteLocTarget.name}?
              </h3>
              <p className="text-xs text-slate-600 dark:text-slate-300">
                This will remove <span className="font-semibold text-slate-900 dark:text-slate-50">{deleteLocTarget.location_name || deleteLocTarget.name}</span> from active Food Trucks &amp; Locations. If historical sales, inventory, or fleet logs exist, it will be archived safely so past reports remain accurate.
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDeleteLocTarget(null)}
                  className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={deletingLoc}
                  onClick={handleDeleteFleetLocation}
                  className="px-4 py-2 rounded-lg bg-red-600 text-white text-xs font-semibold hover:bg-red-700 disabled:opacity-50"
                >
                  {deletingLoc ? 'Removing...' : 'Confirm Delete'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ==========================================
  // HR, ATTENDANCE & CONFIGURABLE PH PAYROLL
  // ==========================================
  if (mode === 'hr') {
    if (err && !hrData) return <div className="p-4 rounded-lg border border-red-200 dark:border-red-800/80 bg-red-50 dark:bg-red-950/50 text-xs text-red-700 dark:text-red-300 font-medium">{err}</div>;
    if (!hrData) return <div className="h-64 rounded-xl border bg-white dark:bg-slate-900 animate-pulse" />;

    const isHrLocFiltered = Boolean(activeLocationId && activeLocationId !== 'ALL');
    const visibleEmployees = isHrLocFiltered
      ? (hrData.employees || []).filter((emp: any) => emp.location_id === activeLocationId)
      : hrData.employees || [];
    const visibleAttendance = isHrLocFiltered
      ? (hrData.attendance || []).filter((att: any) => att.location_id === activeLocationId)
      : hrData.attendance || [];
    const openShiftEmployeeIds = new Set<string>(
      (hrData.attendance || []).filter((att: any) => !att.clock_out).map((att: any) => att.employee_id),
    );
    const enrolledFaceCount = visibleEmployees.filter((e: any) => Boolean(parseDescriptorJson(e.face_descriptor_json))).length;
    const photoCount = visibleEmployees.filter((e: any) => Boolean(e.avatar_url)).length;

    const latestRun = hrData.payrollRuns?.[0] || null;
    const visiblePayrollItems = latestRun
      ? isHrLocFiltered
        ? (latestRun.items || []).filter((pi: any) => pi.location_id === activeLocationId)
        : latestRun.items || []
      : [];

    const formatPunchTime = (iso: string | null | undefined) => {
      if (!iso) return '—';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    };

    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-semibold text-slate-900 dark:text-slate-50">Employees, Attendance &amp; PH Payroll</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">On-device face attendance scanner, crew biometrics, truck assignments, and Philippine statutory payroll</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowFaceKiosk(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-4 py-2 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white whitespace-nowrap shrink-0 shadow-xs"
            >
              <ScanFace className="w-4 h-4" /> Face Attendance Kiosk
            </button>
            <button
              type="button"
              onClick={() => shiftTemplatesSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              <CalendarClock className="w-3.5 h-3.5" /> Shift Templates
            </button>
            <button
              type="button"
              onClick={openCreateEmployee}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" /> Add Employee &amp; Crew
            </button>
            <label className="inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-[11px] font-medium text-slate-700 dark:text-slate-200 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={useAttendanceDays}
                onChange={(e) => setUseAttendanceDays(e.target.checked)}
                className="rounded border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-50 focus:ring-slate-900 dark:focus:ring-slate-200"
              />
              <span>Use logged attendance</span>
            </label>
            <button
              type="button"
              onClick={async () => {
                try {
                  setErr('');
                  const r = await apiFetch('/hr/payroll/run', {
                    method: 'POST',
                    body: JSON.stringify({
                      periodStart: '2026-11-01',
                      periodEnd: '2026-11-15',
                      daysPerEmployee: 13,
                      useAttendanceDays,
                    }),
                  });
                  setMsg(
                    `Payroll Run posted (${useAttendanceDays ? 'attendance-based' : '13-day cutoff'}) · Gross: ${formatPHP(r.totalGross)} · Net: ${formatPHP(r.totalNet)}`,
                  );
                  await loadHr();
                } catch (e: any) {
                  setErr(e.message);
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              Run Semi-Monthly Payroll
            </button>
          </div>
        </div>

        {/* HR & Crew Metrics */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5">
            <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Total Employees</p>
            <p className="font-display text-xl font-bold text-slate-900 dark:text-slate-50 mt-1 font-mono tabular-nums">{visibleEmployees.length}</p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">{isHrLocFiltered ? 'At selected location' : 'All branches & trucks'}</p>
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5">
            <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Active &amp; On Shift</p>
            <p className="font-display text-xl font-bold text-emerald-600 dark:text-emerald-400 mt-1 font-mono tabular-nums">
              {visibleEmployees.filter((e: any) => e.is_active !== 0).length}
              <span className="text-xs font-normal text-slate-500 dark:text-slate-400 ml-1.5">
                ({visibleEmployees.filter((e: any) => openShiftEmployeeIds.has(e.id)).length} clocked in)
              </span>
            </p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Live attendance status</p>
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5">
            <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Face Biometrics Ready</p>
            <p className="font-display text-xl font-bold text-blue-600 dark:text-blue-300 mt-1 font-mono tabular-nums">
              {enrolledFaceCount} <span className="text-xs font-normal text-slate-500 dark:text-slate-400">/ {visibleEmployees.length}</span>
            </p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
              {photoCount} photo(s) · {visibleEmployees.length ? Math.round((enrolledFaceCount / visibleEmployees.length) * 100) : 0}% scanner-ready
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5">
            <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Location Scope</p>
            <p className="font-display text-sm font-semibold text-slate-800 dark:text-slate-100 mt-1 truncate">
              {isHrLocFiltered ? locations.find((l) => l.id === activeLocationId)?.name || 'Filtered Truck' : 'All Food Trucks & Commissary'}
            </p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">{isHrLocFiltered ? 'Roster filtered' : 'Company-wide view'}</p>
          </div>
        </div>

        {msg && <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/45 border border-emerald-200 dark:border-emerald-700/80 text-xs text-emerald-800 dark:text-emerald-300 font-medium">{msg}</div>}
        {err && <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">{err}</div>}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-7 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/60 flex items-center justify-between">
              <div>
                <h2 className="font-display text-xs font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-200">Employee Directory &amp; Crew Biometrics</h2>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">Crew photos, on-device Face ID status, truck assignments, and shift punches</p>
              </div>
              <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">{visibleEmployees.length} employee(s)</span>
            </div>
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-100 dark:border-slate-800/80 text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/70">
                <tr>
                  <th className="p-3 font-medium">Crew Member &amp; Biometrics</th>
                  <th className="p-3 font-medium">Position · Truck</th>
                  <th className="p-3 font-medium">Status</th>
                  <th className="p-3 font-medium text-right">Daily Rate</th>
                  <th className="p-3 font-medium text-right">Actions &amp; Clock</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {visibleEmployees.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-6 text-center text-xs text-slate-500 dark:text-slate-400">
                      No employees found for the selected truck / location. Click &ldquo;Add Employee &amp; Crew&rdquo; to register one.
                    </td>
                  </tr>
                ) : visibleEmployees.map((emp: any) => {
                  const hasFaceId = Boolean(parseDescriptorJson(emp.face_descriptor_json));
                  const onShift = openShiftEmployeeIds.has(emp.id);
                  return (
                    <tr key={emp.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/50">
                      <td className="p-3 font-semibold text-slate-900 dark:text-slate-50">
                        <div className="flex items-center gap-2.5">
                          <div className="shrink-0">
                            <AvatarBadge name={emp.full_name} src={emp.avatar_url} size="sm" />
                          </div>
                          <div>
                            <p className="font-medium text-slate-900 dark:text-slate-50 leading-tight">{emp.full_name}</p>
                            <p className="text-[11px] font-normal text-slate-500 dark:text-slate-400">
                              <span className="font-mono">{emp.employee_code}</span>
                              <span aria-hidden="true"> · </span>
                              <span className={hasFaceId ? 'text-emerald-700 dark:text-emerald-300 font-medium' : emp.avatar_url ? 'text-amber-700 dark:text-amber-300' : 'text-slate-500 dark:text-slate-400'}>
                                {hasFaceId ? 'Face ID Ready' : emp.avatar_url ? 'Photo Only' : 'No Face ID'}
                              </span>
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="p-3 text-slate-600 dark:text-slate-300">
                        <p className="font-medium text-slate-800 dark:text-slate-100">{emp.position}</p>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400">{emp.location_name || 'Commissary HQ'}</p>
                      </td>
                      <td className="p-3">
                        <p className={`text-[11px] font-semibold ${emp.is_active !== 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-500 dark:text-slate-400'}`}>
                          {emp.is_active !== 0 ? 'Active' : 'Inactive'}
                        </p>
                        {onShift && (
                          <p className="text-[11px] text-blue-700 dark:text-blue-300 font-medium">On Shift</p>
                        )}
                      </td>
                      <td className="p-3 text-right font-mono tabular-nums text-slate-800 dark:text-slate-100">
                        {formatPHP(emp.base_rate)}
                        <span className="block text-[10px] text-slate-500 dark:text-slate-400 font-sans">{emp.pay_type || 'DAILY'}</span>
                      </td>
                      <td className="p-3 text-right whitespace-nowrap space-x-1.5">
                        <button
                          type="button"
                          onClick={() => openEditEmployee(emp)}
                          className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-slate-800 px-2 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                          title="Edit profile, Face ID & PIN"
                        >
                          <Pencil className="w-3 h-3 text-slate-500 dark:text-slate-400" /> Edit / Face
                        </button>
                        <button
                          type="button"
                          disabled={onShift}
                          onClick={async () => {
                            try {
                              setErr('');
                              await apiFetch('/hr/attendance/clock', {
                                method: 'POST',
                                body: JSON.stringify({
                                  employeeId: emp.id,
                                  action: 'CLOCK_IN',
                                  locationId: emp.location_id || null,
                                  verificationMethod: 'MANUAL',
                                }),
                              });
                              setMsg(`${emp.full_name} clocked in.`);
                              await loadHr();
                            } catch (e: any) {
                              setErr(e.message);
                            }
                          }}
                          className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-slate-800 px-2 py-1 text-[11px] font-medium hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <Clock className="w-3 h-3" /> In
                        </button>
                        <button
                          type="button"
                          disabled={!onShift}
                          onClick={async () => {
                            try {
                              setErr('');
                              await apiFetch('/hr/attendance/clock', {
                                method: 'POST',
                                body: JSON.stringify({
                                  employeeId: emp.id,
                                  action: 'CLOCK_OUT',
                                  verificationMethod: 'MANUAL',
                                }),
                              });
                              setMsg(`${emp.full_name} clocked out.`);
                              await loadHr();
                            } catch (e: any) {
                              setErr(e.message);
                            }
                          }}
                          className="rounded border border-slate-200 dark:border-slate-800 px-2 py-1 text-[11px] font-medium hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Out
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {ruleCfg && (
            <div className="lg:col-span-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50">Configurable PH Statutory Rules</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">Update rates whenever DOLE / BIR / SSS / PhilHealth circulars change.</p>
              <div className="grid grid-cols-2 gap-2.5 text-xs">
                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">SSS EE Rate %</label>
                  <input type="number" step="0.1" value={ruleCfg.sssEmployeeRatePct} onChange={(e) => setRuleCfg({ ...ruleCfg, sssEmployeeRatePct: Number(e.target.value) })} className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-1.5 font-mono" />
                </div>
                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">PhilHealth EE %</label>
                  <input type="number" step="0.1" value={ruleCfg.philhealthEmployeeRatePct} onChange={(e) => setRuleCfg({ ...ruleCfg, philhealthEmployeeRatePct: Number(e.target.value) })} className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-1.5 font-mono" />
                </div>
                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Pag-IBIG Monthly (PHP)</label>
                  <input type="number" value={ruleCfg.pagibigFixedEmployeePhp} onChange={(e) => setRuleCfg({ ...ruleCfg, pagibigFixedEmployeePhp: Number(e.target.value) })} className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-1.5 font-mono" />
                </div>
                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-300 mb-1">Tax Exempt Ceiling / Mo</label>
                  <input type="number" value={ruleCfg.taxExemptMonthlyCeilingPhp} onChange={(e) => setRuleCfg({ ...ruleCfg, taxExemptMonthlyCeilingPhp: Number(e.target.value) })} className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-1.5 font-mono" />
                </div>
              </div>
              <button
                onClick={async () => {
                  try {
                    setErr('');
                    await apiFetch('/hr/payroll-rules', { method: 'PUT', body: JSON.stringify({ config: ruleCfg }) });
                    setMsg('Updated Philippine statutory payroll deduction rules.');
                  } catch (e: any) {
                    setErr(e.message);
                  }
                }}
                className="rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-2 text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                Save Statutory Rules
              </button>
            </div>
          )}
        </div>

        {/* Attendance & Biometric Photo Audit Log */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/60 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-xs font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-200">Attendance &amp; Biometric Punch Audit</h2>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">Time In / Time Out log with face verification score, overtime computation, and photo snapshots</p>
            </div>
            <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">{visibleAttendance.length} punch record(s)</span>
          </div>
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-100 dark:border-slate-800/80 text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/70">
              <tr>
                <th className="p-3 font-medium">Crew Member</th>
                <th className="p-3 font-medium">Station / Truck</th>
                <th className="p-3 font-medium">Time In</th>
                <th className="p-3 font-medium">Time Out</th>
                <th className="p-3 font-medium text-right">Worked · OT</th>
                <th className="p-3 font-medium">Status</th>
                <th className="p-3 font-medium">Verification</th>
                <th className="p-3 font-medium text-right">Photo Proof</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {visibleAttendance.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-xs text-slate-500 dark:text-slate-400">
                    No attendance punches recorded yet. Launch &ldquo;Face Attendance Kiosk&rdquo; or use quick In / Out buttons.
                  </td>
                </tr>
              ) : visibleAttendance.map((att: any) => {
                const methodLabel =
                  att.verification_method === 'FACE_SCAN'
                    ? `Face Scan${att.match_confidence ? ` · ${att.match_confidence}%` : ''}`
                    : att.verification_method === 'PIN_FALLBACK'
                      ? 'PIN Fallback'
                      : 'Manual';
                return (
                  <tr key={att.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/50">
                    <td className="p-3">
                      <p className="font-medium text-slate-900 dark:text-slate-50">{att.full_name || 'Unknown Employee'}</p>
                      <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400">{att.employee_code || '—'}</p>
                    </td>
                    <td className="p-3 text-slate-600 dark:text-slate-300">{att.location_name || 'Commissary HQ'}</td>
                    <td className="p-3 font-mono text-slate-700 dark:text-slate-200 whitespace-nowrap">{formatPunchTime(att.clock_in)}</td>
                    <td className="p-3 font-mono whitespace-nowrap">
                      {att.clock_out ? (
                        <span className="text-slate-700 dark:text-slate-200">{formatPunchTime(att.clock_out)}</span>
                      ) : (
                        <span className="font-sans font-medium text-blue-700 dark:text-blue-300">On Shift</span>
                      )}
                    </td>
                    <td className="p-3 text-right font-mono tabular-nums text-slate-800 dark:text-slate-100 whitespace-nowrap">
                      {att.clock_out ? (
                        <>
                          {Number(att.worked_hours || 0).toFixed(2)}h
                          {Number(att.overtime_hours || 0) > 0 && (
                            <span className="text-amber-700 dark:text-amber-300 ml-1">({Number(att.overtime_hours).toFixed(2)}h OT)</span>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="p-3">
                      <span
                        className={`text-[11px] font-semibold ${
                          att.status === 'LATE'
                            ? 'text-amber-700 dark:text-amber-300'
                            : att.status === 'ABSENT'
                              ? 'text-red-700 dark:text-red-300'
                              : 'text-emerald-700 dark:text-emerald-300'
                        }`}
                      >
                        {att.status}
                      </span>
                    </td>
                    <td className="p-3 text-slate-600 dark:text-slate-300 whitespace-nowrap">{methodLabel}</td>
                    <td className="p-3 text-right">
                      <div className="inline-flex items-center justify-end gap-1.5">
                        {att.clock_in_photo && (
                          <button
                            type="button"
                            onClick={() =>
                              setAttendancePhotoPreview({
                                title: `${att.full_name} — Time In Snapshot`,
                                subtitle: `${formatPunchTime(att.clock_in)} · ${methodLabel}`,
                                src: att.clock_in_photo,
                              })
                            }
                            className="group relative rounded border border-slate-200 dark:border-slate-800 overflow-hidden hover:ring-2 hover:ring-slate-900"
                            title="View Time In photo proof"
                          >
                            <img src={att.clock_in_photo} alt="Time in proof" className="w-7 h-7 object-cover" />
                          </button>
                        )}
                        {att.clock_out_photo && (
                          <button
                            type="button"
                            onClick={() =>
                              setAttendancePhotoPreview({
                                title: `${att.full_name} — Time Out Snapshot`,
                                subtitle: `${formatPunchTime(att.clock_out)} · ${methodLabel}`,
                                src: att.clock_out_photo,
                              })
                            }
                            className="group relative rounded border border-slate-200 dark:border-slate-800 overflow-hidden hover:ring-2 hover:ring-slate-900"
                            title="View Time Out photo proof"
                          >
                            <img src={att.clock_out_photo} alt="Time out proof" className="w-7 h-7 object-cover" />
                          </button>
                        )}
                        {!att.clock_in_photo && !att.clock_out_photo && (
                          <span className="text-[11px] text-slate-500 dark:text-slate-400">—</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {hrData.payrollRuns.length > 0 && (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
            <div className="p-4 border-b border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-200">
              Latest Payroll Run ({hrData.payrollRuns[0].period_start} to {hrData.payrollRuns[0].period_end})
            </div>
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-100 dark:border-slate-800/80 text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="p-3 font-medium">Employee</th>
                  <th className="p-3 font-medium text-right">Days</th>
                  <th className="p-3 font-medium text-right">Gross Pay</th>
                  <th className="p-3 font-medium text-right">SSS</th>
                  <th className="p-3 font-medium text-right">PhilHealth</th>
                  <th className="p-3 font-medium text-right">Pag-IBIG</th>
                  <th className="p-3 font-medium text-right">Net Pay</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {visiblePayrollItems.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-6 text-center text-xs text-slate-500 dark:text-slate-400">
                      No payroll entries for employees at the selected truck / location.
                    </td>
                  </tr>
                ) : visiblePayrollItems.map((pi: any) => (
                  <tr key={pi.id}>
                    <td className="p-3 font-semibold">{pi.full_name}</td>
                    <td className="p-3 text-right font-mono">{pi.days_worked}</td>
                    <td className="p-3 text-right font-mono tabular-nums">{formatPHP(pi.gross_pay)}</td>
                    <td className="p-3 text-right font-mono tabular-nums">{formatPHP(pi.sss_deduction)}</td>
                    <td className="p-3 text-right font-mono tabular-nums">{formatPHP(pi.philhealth_deduction)}</td>
                    <td className="p-3 text-right font-mono tabular-nums">{formatPHP(pi.pagibig_deduction)}</td>
                    <td className="p-3 text-right font-mono tabular-nums font-bold text-emerald-700 dark:text-emerald-300">{formatPHP(pi.net_pay)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Shift Templates & Multi-Location Recurring Schedules */}
        <div ref={shiftTemplatesSectionRef} className="space-y-4">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="px-4 py-3.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/70 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50 flex items-center gap-2">
                  <CalendarClock className="w-4 h-4 text-slate-700 dark:text-slate-200" />
                  Shift Templates &amp; Recurring Multi-Location Schedules
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Standardize Opening, Mid-Day, and Closing windows and deploy recurring crew schedules across multiple trucks and commissary sites.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => openCreateShiftTemplate()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <Plus className="w-3.5 h-3.5" /> New Shift Template
                </button>
                <button
                  type="button"
                  onClick={openSingleShiftModal}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <Calendar className="w-3.5 h-3.5" /> Add Single Shift
                </button>
                <button
                  type="button"
                  onClick={() => openGenerateScheduleModal()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-3.5 py-2 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white shadow-xs"
                >
                  <CopyPlus className="w-3.5 h-3.5" /> Generate Recurring Schedule
                </button>
              </div>
            </div>

            <div className="p-4">
              {!(hrData.shiftTemplates || []).length ? (
                <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/50 p-8 text-center space-y-2">
                  <p className="text-xs font-medium text-slate-700 dark:text-slate-200">No shift templates configured yet.</p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">Create Opening, Mid-Day, or Closing templates to generate recurring multi-location rosters.</p>
                  <button
                    type="button"
                    onClick={() => openCreateShiftTemplate({ code: 'OPEN', name: 'Opening Shift', startTime: '07:00', endTime: '15:00', defaultRole: 'Lead Cashier / Prep Cook' })}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-3 py-1.5 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white"
                  >
                    <Plus className="w-3.5 h-3.5" /> Create Opening Template
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {(hrData.shiftTemplates || []).map((tpl: any) => {
                    const tplDays: string[] = Array.isArray(tpl.days_of_week) ? tpl.days_of_week : [];
                    const tplLocIds: string[] = Array.isArray(tpl.location_ids) ? tpl.location_ids : [];
                    const locNames = tplLocIds
                      .map((lid) => locations.find((l) => l.id === lid)?.name)
                      .filter(Boolean);
                    const isTemplateInFilteredLoc =
                      !isHrLocFiltered || tplLocIds.length === 0 || tplLocIds.includes(activeLocationId);

                    return (
                      <div
                        key={tpl.id}
                        className={`rounded-xl border p-4 flex flex-col justify-between gap-3 transition-colors ${
                          tpl.is_active === 0
                            ? 'border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/70 opacity-75'
                            : isTemplateInFilteredLoc
                              ? 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-600'
                              : 'border-slate-200 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-800/40'
                        }`}
                      >
                        <div className="space-y-2.5">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 text-xs">
                                <span className="font-mono font-bold text-slate-900 dark:text-slate-50 tracking-wide">{tpl.code}</span>
                                <span aria-hidden="true" className="text-slate-400 dark:text-slate-500">·</span>
                                <span className={`font-semibold ${tpl.is_active !== 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-500 dark:text-slate-400'}`}>
                                  {tpl.is_active !== 0 ? 'Active' : 'Paused'}
                                </span>
                              </div>
                              <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50 mt-0.5 truncate">{tpl.name}</h3>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                type="button"
                                onClick={() => openEditShiftTemplate(tpl)}
                                className="p-1.5 rounded-md border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white"
                                title="Edit shift template"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setDeleteShiftTplTarget(tpl)}
                                className="p-1.5 rounded-md border border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 hover:bg-red-50 dark:hover:bg-red-950/70 hover:text-red-700 dark:hover:text-red-300 hover:border-red-200 dark:hover:border-red-700"
                                title="Delete shift template"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>

                          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                            <span className="font-mono tabular-nums text-base font-bold text-slate-900 dark:text-slate-50">
                              {tpl.start_time} – {tpl.end_time}
                            </span>
                            <span className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                              {calcNetShiftHours(tpl.start_time, tpl.end_time, tpl.break_minutes)}
                              <span aria-hidden="true"> · </span>
                              {tpl.break_minutes ?? 60}m break
                            </span>
                          </div>

                          <div className="text-[11px] text-slate-600 dark:text-slate-300 space-y-1">
                            <div className="flex flex-wrap items-center gap-x-1.5 font-mono">
                              {WEEKDAY_ORDER.map((day) => {
                                const on = tplDays.includes(day);
                                return (
                                  <span
                                    key={day}
                                    className={on ? 'font-bold text-slate-900 dark:text-slate-50' : 'text-slate-500 dark:text-slate-500'}
                                  >
                                    {day}
                                  </span>
                                );
                              })}
                            </div>
                            <p className="text-slate-600 dark:text-slate-300">
                              <span className="font-medium text-slate-700 dark:text-slate-200">Locations:</span>{' '}
                              {locNames.length > 0 ? locNames.join(' · ') : 'All active locations'}
                            </p>
                            <p className="text-slate-600 dark:text-slate-300">
                              <span className="font-medium text-slate-700 dark:text-slate-200">Target Crew:</span>{' '}
                              <span className="font-mono tabular-nums">{tpl.headcount_needed ?? 2}</span> / location
                              {tpl.default_role ? ` · ${tpl.default_role}` : ''}
                            </p>
                            {tpl.notes && (
                              <p className="text-slate-500 dark:text-slate-400 line-clamp-2 pt-0.5">{tpl.notes}</p>
                            )}
                          </div>
                        </div>

                        <button
                          type="button"
                          disabled={tpl.is_active === 0}
                          onClick={() => openGenerateScheduleModal(tpl)}
                          className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/70 px-3 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-900 hover:text-white hover:border-slate-900 transition-colors disabled:opacity-45 disabled:pointer-events-none"
                        >
                          <CopyPlus className="w-3.5 h-3.5" /> Apply to Multi-Location Schedule
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Recurring Shift Schedule Roster & Automated Overlap Conflict Alerts */}
            {(() => {
              const allSchedules: any[] = hrData.shiftSchedules || [];
              const { conflictPairs, conflictsByScheduleId } = detectRosterScheduleConflicts(
                allSchedules.map(toUiShiftWindow),
              );
              const scheduleById = new Map(allSchedules.map((s) => [s.id, s]));
              const visibleConflictPairs = isHrLocFiltered
                ? conflictPairs.filter((pair) => {
                    const sa = scheduleById.get(pair.scheduleIdA);
                    const sb = scheduleById.get(pair.scheduleIdB);
                    return sa?.location_id === activeLocationId || sb?.location_id === activeLocationId;
                  })
                : conflictPairs;

              const filteredSchedules = allSchedules.filter((s) => {
                if (isHrLocFiltered && s.location_id !== activeLocationId) return false;
                if (schedFilterTemplate !== 'ALL' && s.template_id !== schedFilterTemplate) return false;
                if (schedFilterDate && s.shift_date !== schedFilterDate) return false;
                if (schedConflictsOnly && !(conflictsByScheduleId[s.id]?.length)) return false;
                return true;
              });
              const activeCrew = (hrData.employees || []).filter((e: any) => e.is_active !== 0);
              const conflictingRowCount = Object.keys(conflictsByScheduleId).length;

              return (
                <div className="border-t border-slate-200 dark:border-slate-800">
                  {visibleConflictPairs.length > 0 && (
                    <div className="m-4 rounded-xl border border-red-200 dark:border-red-800/80 bg-red-50/75 dark:bg-red-950/50 p-4 space-y-2.5">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="flex items-start gap-2.5">
                          <div className="p-1.5 rounded-lg bg-red-100 dark:bg-red-950/80 text-red-700 dark:text-red-300 shrink-0 mt-0.5">
                            <ShieldAlert className="w-4 h-4" />
                          </div>
                          <div className="space-y-0.5">
                            <h4 className="text-xs font-bold text-red-900 dark:text-red-300">
                              Automated Schedule Overlap Alert: <span className="font-mono tabular-nums">{visibleConflictPairs.length}</span> conflict pair(s) across <span className="font-mono tabular-nums">{conflictingRowCount}</span> shift slot(s)
                            </h4>
                            <p className="text-[11px] text-red-800 dark:text-red-300">
                              Same crew member is assigned to overlapping shift windows. Reassign one of the conflicting slots or set its status to Cancelled to clear the alert.
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => setSchedConflictsOnly((v) => !v)}
                            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${
                              schedConflictsOnly
                                ? 'border-red-700 bg-red-700 text-white hover:bg-red-800'
                                : 'border-red-300 dark:border-red-800/80 bg-white dark:bg-slate-900 text-red-800 dark:text-red-300 hover:bg-red-100/70'
                            }`}
                          >
                            <AlertTriangle className="w-3.5 h-3.5" />
                            {schedConflictsOnly ? 'Show All Roster Shifts' : 'Filter Conflicts Only'}
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2 pt-1">
                        {visibleConflictPairs.slice(0, 4).map((pair) => (
                          <div
                            key={pair.conflictId}
                            className="rounded-lg border border-red-200/90 bg-white/90 px-3 py-2 text-[11px] text-red-900 dark:text-red-300 flex items-start gap-2"
                          >
                            <AlertTriangle className="w-3.5 h-3.5 text-red-600 dark:text-red-300 shrink-0 mt-0.5" />
                            <div className="min-w-0">
                              <span className="font-mono font-semibold text-red-700 dark:text-red-300 mr-1.5">{pair.shiftDate}</span>
                              <span className="text-slate-800 dark:text-slate-100">{pair.summary}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                      {visibleConflictPairs.length > 4 && (
                        <p className="text-[11px] text-red-800 dark:text-red-300 font-medium">
                          +{visibleConflictPairs.length - 4} additional overlapping shift pair(s) highlighted in the roster below.
                        </p>
                      )}
                    </div>
                  )}

                  <div className="px-4 py-3 bg-slate-50/50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="font-display text-xs font-semibold uppercase tracking-wide text-slate-700 dark:text-slate-200 flex items-center gap-2">
                        <span>Multi-Location Recurring Shift Roster</span>
                        {conflictPairs.length === 0 && allSchedules.length > 0 && (
                          <span className="inline-flex items-center gap-1 font-normal normal-case text-[11px] text-emerald-700 dark:text-emerald-300">
                            <CheckCircle2 className="w-3.5 h-3.5" /> No shift overlaps
                          </span>
                        )}
                      </h3>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">
                        Assign or swap crew per shift slot and confirm coverage across trucks and commissary
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      {conflictPairs.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setSchedConflictsOnly((v) => !v)}
                          className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                            schedConflictsOnly
                              ? 'border-red-700 bg-red-700 text-white'
                              : 'border-red-200 dark:border-red-800/80 bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/60'
                          }`}
                        >
                          <AlertTriangle className="w-3.5 h-3.5" />
                          <span>Conflicts (<span className="font-mono tabular-nums">{visibleConflictPairs.length}</span>)</span>
                        </button>
                      )}
                      <select
                        value={schedFilterTemplate}
                        onChange={(e) => setSchedFilterTemplate(e.target.value)}
                        className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs text-slate-700 dark:text-slate-200"
                        aria-label="Filter schedules by template"
                      >
                        <option value="ALL">All Templates</option>
                        {(hrData.shiftTemplates || []).map((tpl: any) => (
                          <option key={tpl.id} value={tpl.id}>
                            {tpl.code} — {tpl.name}
                          </option>
                        ))}
                      </select>
                      <input
                        type="date"
                        value={schedFilterDate}
                        onChange={(e) => setSchedFilterDate(e.target.value)}
                        className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-mono text-slate-700 dark:text-slate-200"
                        aria-label="Filter schedules by date"
                      />
                      {schedFilterDate && (
                        <button
                          type="button"
                          onClick={() => setSchedFilterDate('')}
                          className="text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white underline"
                        >
                          Clear date
                        </button>
                      )}
                      <span className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400 ml-1">
                        {filteredSchedules.length} shift(s)
                      </span>
                    </div>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="border-b border-slate-100 dark:border-slate-800/80 text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/70">
                        <tr>
                          <th className="p-3 font-medium">Shift Date</th>
                          <th className="p-3 font-medium">Template &amp; Window</th>
                          <th className="p-3 font-medium">Location</th>
                          <th className="p-3 font-medium">Assigned Crew</th>
                          <th className="p-3 font-medium">Status</th>
                          <th className="p-3 font-medium text-right">Remove</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {filteredSchedules.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="p-6 text-center text-xs text-slate-500 dark:text-slate-400">
                              {schedConflictsOnly
                                ? 'No overlapping shift conflicts match the current filters.'
                                : 'No recurring shifts scheduled for the current filters. Click “Generate Recurring Schedule” or “Add Single Shift” above to populate shifts.'}
                            </td>
                          </tr>
                        ) : (
                          filteredSchedules.slice(0, 60).map((sched: any) => {
                            const dateObj = new Date(`${sched.shift_date}T00:00:00`);
                            const dayLabel = Number.isNaN(dateObj.getTime())
                              ? ''
                              : dateObj.toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric' });
                            const busy = schedUpdatingId === sched.id;
                            const rowConflicts = conflictsByScheduleId[sched.id] || [];
                            const hasConflict = rowConflicts.length > 0;
                            const isRecentConflict = hasConflict && recentConflictScheduleIds.includes(sched.id);

                            return (
                              <tr
                                key={sched.id}
                                className={
                                  isRecentConflict
                                    ? 'bg-red-100/75 hover:bg-red-100/90 transition-colors'
                                    : hasConflict
                                      ? 'bg-red-50/60 dark:bg-red-950/50 hover:bg-red-50/90 transition-colors'
                                      : 'hover:bg-slate-50/50 dark:hover:bg-slate-800/50'
                                }
                              >
                                <td className="p-3 whitespace-nowrap">
                                  <p className="font-mono tabular-nums font-medium text-slate-900 dark:text-slate-50">{sched.shift_date}</p>
                                  <p className="text-[11px] text-slate-500 dark:text-slate-400">{dayLabel}</p>
                                </td>
                                <td className="p-3 whitespace-nowrap">
                                  <div className="flex items-center gap-1.5">
                                    {hasConflict && (
                                      <span title="Overlapping crew schedule conflict" className="inline-flex shrink-0">
                                        <AlertTriangle className="w-3.5 h-3.5 text-red-600 dark:text-red-300" />
                                      </span>
                                    )}
                                    <p className={`font-semibold ${hasConflict ? 'text-red-900 dark:text-red-300' : 'text-slate-900 dark:text-slate-50'}`}>
                                      {sched.template_name}
                                    </p>
                                  </div>
                                  <p className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                                    {sched.start_time} – {sched.end_time} · {sched.break_minutes ?? 60}m break
                                  </p>
                                </td>
                                <td className="p-3 text-slate-700 dark:text-slate-200">
                                  <p className="font-medium text-slate-800 dark:text-slate-100">{sched.location_name || sched.location_id}</p>
                                  {sched.location_code && (
                                    <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400">{sched.location_code}</p>
                                  )}
                                </td>
                                <td className="p-3">
                                  <select
                                    disabled={busy}
                                    value={sched.employee_id || ''}
                                    onChange={(e) => handleUpdateScheduleSlot(sched.id, { employeeId: e.target.value || null })}
                                    className={`w-full max-w-[240px] rounded-md border px-2 py-1.5 text-xs ${
                                      hasConflict
                                        ? 'border-red-300 dark:border-red-800/80 bg-white dark:bg-slate-900 text-red-900 dark:text-red-300 font-semibold'
                                        : sched.employee_id
                                          ? 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 font-medium'
                                          : 'border-amber-200 dark:border-amber-700/80 bg-amber-50/60 dark:bg-amber-950/45 text-amber-800 dark:text-amber-300 font-medium'
                                    }`}
                                  >
                                    <option value="">Open Slot (Unassigned)</option>
                                    {activeCrew.map((emp: any) => (
                                      <option key={emp.id} value={emp.id}>
                                        {emp.full_name} ({emp.employee_code}){emp.location_id === sched.location_id ? ' ★' : ''}
                                      </option>
                                    ))}
                                  </select>
                                  {hasConflict && (
                                    <div className="mt-1 space-y-0.5 text-[11px] text-red-700 dark:text-red-300">
                                      {rowConflicts.slice(0, 2).map((cf) => (
                                        <p key={cf.conflictKey} className="font-medium leading-tight">
                                          Overlap ({formatOverlapDuration(cf.overlapMinutes)}): {cf.existingTemplateName}{' '}
                                          <span className="font-mono tabular-nums">({cf.existingTimeRange})</span> @ {cf.existingLocationName}
                                        </p>
                                      ))}
                                    </div>
                                  )}
                                </td>
                                <td className="p-3">
                                  <select
                                    disabled={busy}
                                    value={sched.status || 'SCHEDULED'}
                                    onChange={(e) => handleUpdateScheduleSlot(sched.id, { status: e.target.value })}
                                    className={`rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-1 text-xs font-semibold ${
                                      sched.status === 'CONFIRMED'
                                        ? 'text-emerald-700 dark:text-emerald-300'
                                        : sched.status === 'COMPLETED'
                                          ? 'text-blue-700 dark:text-blue-300'
                                          : sched.status === 'CANCELLED'
                                            ? 'text-red-700 dark:text-red-300'
                                            : 'text-slate-700 dark:text-slate-200'
                                    }`}
                                  >
                                    <option value="SCHEDULED">Scheduled</option>
                                    <option value="CONFIRMED">Confirmed</option>
                                    <option value="COMPLETED">Completed</option>
                                    <option value="CANCELLED">Cancelled</option>
                                  </select>
                                </td>
                                <td className="p-3 text-right">
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => handleDeleteScheduleSlot(sched.id)}
                                    className="p-1.5 rounded-md border border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 hover:bg-red-50 dark:hover:bg-red-950/70 hover:text-red-700 dark:hover:text-red-300 hover:border-red-200 dark:hover:border-red-700 disabled:opacity-40"
                                    title="Remove shift schedule slot"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>

        {/* Employee & Crew Photo Modal */}
        {empModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-lg rounded-xl bg-white dark:bg-slate-900 p-6 shadow-xl border border-slate-200 dark:border-slate-800 space-y-4 max-h-[92vh] overflow-y-auto">
              <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800/80">
                <div className="flex items-center gap-2">
                  <div className="p-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/45 text-emerald-700 dark:text-emerald-300">
                    <Users className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">
                      {empModal.mode === 'create' ? 'Add Employee & Crew Member' : 'Edit Employee & Crew Photo'}
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">Manage employee identity, crew photo, assigned truck, and wage rate</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setEmpModal(null)}
                  className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {empModalErr && (
                <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">
                  {empModalErr}
                </div>
              )}

              <form onSubmit={handleSaveEmployee} className="space-y-4">
                {/* Photo & Biometric Enrollment Section */}
                <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/60 space-y-3">
                  <div className="flex items-center gap-4">
                    <div className="relative group shrink-0">
                      <AvatarBadge name={empForm.fullName || 'Crew'} src={empForm.avatarUrl} size="lg" />
                      <button
                        type="button"
                        onClick={() => empFileRef.current?.click()}
                        className="absolute inset-0 rounded-full bg-black/40 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Upload crew photo"
                      >
                        <Camera className="w-5 h-5" />
                      </button>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-slate-900 dark:text-slate-50">Crew Photo &amp; On-Device Face ID</p>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                        Upload a clear front portrait or take a live webcam photo to enroll 128-D face recognition.
                      </p>
                      <div className="flex flex-wrap items-center gap-2 mt-2">
                        <button
                          type="button"
                          onClick={() => empFileRef.current?.click()}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <Upload className="w-3.5 h-3.5" /> {empForm.avatarUrl ? 'Change Photo' : 'Upload Photo'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowEmpCam((prev) => !prev)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <Camera className="w-3.5 h-3.5" /> {showEmpCam ? 'Close Camera' : 'Take Live Photo'}
                        </button>
                        {empForm.avatarUrl && !empForm.faceDescriptorJson && !extractingFace && (
                          <button
                            type="button"
                            onClick={() => enrollFaceFromDataUrl(empForm.avatarUrl)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-blue-200 dark:border-blue-700/80 bg-blue-50 dark:bg-blue-950/50 text-xs font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/60"
                          >
                            <ScanFace className="w-3.5 h-3.5" /> Re-Scan Photo
                          </button>
                        )}
                        {empForm.avatarUrl && (
                          <button
                            type="button"
                            onClick={() => {
                              setEmpForm((f) => ({ ...f, avatarUrl: '', faceDescriptorJson: '', faceEnrolledAt: '' }));
                              setFaceEnrollStatus(null);
                            }}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-red-600 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/70"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                      <input
                        ref={empFileRef}
                        type="file"
                        accept="image/*"
                        className="hidden bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                        onChange={(e) => handleEmpPhotoUpload(e.target.files?.[0])}
                      />
                    </div>
                  </div>

                  {showEmpCam && (
                    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-950 p-2.5 space-y-2">
                      {empCamErr ? (
                        <p className="text-xs text-amber-300 text-center py-4">{empCamErr}</p>
                      ) : (
                        <>
                          <video
                            ref={empVideoRef}
                            muted
                            playsInline
                            className="w-full max-h-52 rounded object-cover -scale-x-100 bg-slate-900 dark:bg-slate-100"
                          />
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setShowEmpCam(false)}
                              className="px-3 py-1.5 rounded-md border border-slate-600 text-xs text-slate-200 hover:bg-slate-800 dark:hover:bg-white"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={handleCaptureEmpLivePhoto}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-500"
                            >
                              <Camera className="w-3.5 h-3.5" /> Capture &amp; Enroll Face
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  {extractingFace && (
                    <p className="text-[11px] text-slate-600 dark:text-slate-300 font-medium">Analyzing facial landmarks on-device...</p>
                  )}
                  {!extractingFace && faceEnrollStatus && (
                    <p className={`text-[11px] font-medium ${faceEnrollStatus.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}`}>
                      {faceEnrollStatus.text}
                    </p>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Employee Code *</label>
                    <input
                      required
                      placeholder="e.g. EMP-001"
                      value={empForm.employeeCode}
                      onChange={(e) => setEmpForm({ ...empForm, employeeCode: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 font-mono"
                    />
                  </div>

                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Full Name *</label>
                    <input
                      required
                      placeholder="e.g. Juan dela Cruz"
                      value={empForm.fullName}
                      onChange={(e) => setEmpForm({ ...empForm, fullName: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2"
                    />
                  </div>

                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Department</label>
                    <select
                      value={empForm.department}
                      onChange={(e) => setEmpForm({ ...empForm, department: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2"
                    >
                      <option value="Kitchen Operations">Kitchen Operations</option>
                      <option value="Fleet &amp; Food Truck Crew">Fleet &amp; Food Truck Crew</option>
                      <option value="Cashier &amp; Service">Cashier &amp; Service</option>
                      <option value="Commissary &amp; Prep">Commissary &amp; Prep</option>
                      <option value="Logistics &amp; Transport">Logistics &amp; Transport</option>
                      <option value="Supervision &amp; Admin">Supervision &amp; Admin</option>
                    </select>
                  </div>

                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Position / Job Title *</label>
                    <input
                      required
                      placeholder="e.g. Pitmaster / Head Griller"
                      value={empForm.position}
                      onChange={(e) => setEmpForm({ ...empForm, position: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2"
                    />
                  </div>

                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Assigned Truck / Location</label>
                    <select
                      value={empForm.locationId}
                      onChange={(e) => setEmpForm({ ...empForm, locationId: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2"
                    >
                      <option value="">Unassigned / Commissary HQ</option>
                      {locations.map((loc) => (
                        <option key={loc.id} value={loc.id}>
                          {loc.name} {loc.code ? `(${loc.code})` : ''} — {loc.type === 'COMMISSARY' ? 'Commissary' : 'Food Truck'}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Mobile Number</label>
                    <input
                      placeholder="e.g. +63 917 555 1234"
                      value={empForm.phone}
                      onChange={(e) => setEmpForm({ ...empForm, phone: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 font-mono"
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Home Address</label>
                    <input
                      placeholder="e.g. 456 Rizal Ave, Manila"
                      value={empForm.address}
                      onChange={(e) => setEmpForm({ ...empForm, address: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Pay Type</label>
                      <select
                        value={empForm.payType}
                        onChange={(e) => setEmpForm({ ...empForm, payType: e.target.value as any })}
                        className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-2 py-2"
                      >
                        <option value="DAILY">Daily</option>
                        <option value="HOURLY">Hourly</option>
                        <option value="MONTHLY">Monthly</option>
                      </select>
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Rate (PHP) *</label>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        required
                        value={empForm.baseRate}
                        onChange={(e) => setEmpForm({ ...empForm, baseRate: e.target.value })}
                        className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-2 font-mono text-right"
                      />
                    </div>
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1 flex items-center gap-1.5">
                      <KeyRound className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
                      Attendance Fallback PIN (Optional, 4–12 digits)
                    </label>
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={12}
                      placeholder="e.g. 1234 (used when grill smoke or night lighting blocks face scan)"
                      value={empForm.attendancePin}
                      onChange={(e) => setEmpForm({ ...empForm, attendancePin: e.target.value.replace(/\s+/g, '') })}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 font-mono tracking-widest"
                    />
                  </div>
                </div>

                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="checkbox"
                    id="empIsActive"
                    checked={empForm.isActive}
                    onChange={(e) => setEmpForm({ ...empForm, isActive: e.target.checked })}
                    className="rounded border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-50 focus:ring-slate-900 dark:focus:ring-slate-200"
                  />
                  <label htmlFor="empIsActive" className="text-xs font-medium text-slate-700 dark:text-slate-200 cursor-pointer">
                    Active crew member (eligible for scheduling, payroll, and site clock-in)
                  </label>
                </div>

                <div className="flex justify-end gap-2 pt-3 border-t border-slate-100 dark:border-slate-800/80">
                  <button
                    type="button"
                    onClick={() => {
                      setShowEmpCam(false);
                      setEmpModal(null);
                    }}
                    className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={savingEmp || extractingFace}
                    className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 text-xs font-semibold hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50"
                  >
                    {savingEmp ? 'Saving...' : empModal.mode === 'create' ? 'Add Employee & Crew' : 'Save Changes'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Face Attendance Kiosk Modal */}
        <FaceAttendanceKioskModal
          isOpen={showFaceKiosk}
          onClose={() => setShowFaceKiosk(false)}
          employees={hrData.employees || []}
          attendance={hrData.attendance || []}
          locations={locations}
          defaultLocationId={activeLocationId}
          onPunchSuccess={loadHr}
          onAutoEnrollSuccess={loadHr}
        />

        {/* Attendance Snapshot Proof Lightbox */}
        {attendancePhotoPreview && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            onClick={() => setAttendancePhotoPreview(null)}
          >
            <div
              className="w-full max-w-sm rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 space-y-3 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">{attendancePhotoPreview.title}</h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{attendancePhotoPreview.subtitle}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setAttendancePhotoPreview(null)}
                  className="p-1 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <img
                src={attendancePhotoPreview.src}
                alt={attendancePhotoPreview.title}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-800 object-cover"
              />
            </div>
          </div>
        )}

        {/* Start New Payroll Run Modal */}
        {showPayrollModal && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
            onClick={() => setShowPayrollModal(false)}
          >
            <form
              onClick={(e) => e.stopPropagation()}
              onSubmit={async (e) => {
                e.preventDefault();
                setPayrollModalErr('');
                setRunningPayroll(true);
                try {
                  const r = await apiFetch('/hr/payroll/run', {
                    method: 'POST',
                    body: JSON.stringify({
                      periodStart: payrollForm.periodStart,
                      periodEnd: payrollForm.periodEnd,
                      daysPerEmployee: Number(payrollForm.daysPerEmployee || 13),
                      useAttendanceDays: payrollForm.useAttendanceDays,
                    }),
                  });
                  setUseAttendanceDays(payrollForm.useAttendanceDays);
                  setShowPayrollModal(false);
                  setMsg(
                    `Payroll Run posted (${payrollForm.periodStart} to ${payrollForm.periodEnd}) · Gross: ${formatPHP(r.totalGross)} · Net: ${formatPHP(r.totalNet)}`,
                  );
                  await loadHr();
                } catch (err: any) {
                  setPayrollModalErr(err.message || 'Unable to post payroll run');
                } finally {
                  setRunningPayroll(false);
                }
              }}
              className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 p-5 border border-slate-200 dark:border-slate-800 shadow-2xl space-y-4"
            >
              <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800/80 pb-3">
                <div>
                  <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">Start New Payroll Run</h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">Compute gross pay, SSS, PhilHealth, Pag-IBIG &amp; net pay</p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowPayrollModal(false)}
                  className="p-1 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {payrollModalErr && (
                <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">
                  {payrollModalErr}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Period Start *</label>
                  <input
                    type="date"
                    required
                    value={payrollForm.periodStart}
                    onChange={(e) => setPayrollForm((f) => ({ ...f, periodStart: e.target.value }))}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Period End *</label>
                  <input
                    type="date"
                    required
                    value={payrollForm.periodEnd}
                    onChange={(e) => setPayrollForm((f) => ({ ...f, periodEnd: e.target.value }))}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 font-mono"
                  />
                </div>
                <div className="col-span-2">
                  <label className="flex items-center gap-2 cursor-pointer select-none py-1">
                    <input
                      type="checkbox"
                      checked={payrollForm.useAttendanceDays}
                      onChange={(e) => setPayrollForm((f) => ({ ...f, useAttendanceDays: e.target.checked }))}
                      className="rounded border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-50 focus:ring-slate-900 dark:focus:ring-slate-200"
                    />
                    <span className="font-medium text-slate-700 dark:text-slate-200">Calculate worked days from logged Attendance punches</span>
                  </label>
                </div>
                {!payrollForm.useAttendanceDays && (
                  <div className="col-span-2">
                    <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Fixed Days per Employee</label>
                    <input
                      type="number"
                      min="1"
                      max="31"
                      required
                      value={payrollForm.daysPerEmployee}
                      onChange={(e) => setPayrollForm((f) => ({ ...f, daysPerEmployee: e.target.value }))}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 font-mono"
                    />
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800/80">
                <button
                  type="button"
                  onClick={() => setShowPayrollModal(false)}
                  className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={runningPayroll}
                  className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 text-xs font-semibold hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50"
                >
                  {runningPayroll ? 'Posting Payroll...' : 'Post Payroll Run'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Create / Edit Shift Template Modal */}
        {shiftTplModal && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
            onClick={() => setShiftTplModal(null)}
          >
            <form
              onClick={(e) => e.stopPropagation()}
              onSubmit={handleSaveShiftTemplate}
              className="w-full max-w-lg rounded-xl bg-white dark:bg-slate-900 p-6 border border-slate-200 dark:border-slate-800 shadow-2xl space-y-4 max-h-[92vh] overflow-y-auto"
            >
              <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800/80 pb-3">
                <div className="flex items-center gap-2.5">
                  <div className="p-2 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-100">
                    <CalendarClock className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">
                      {shiftTplModal.mode === 'create' ? 'Create Shift Template' : 'Edit Shift Template'}
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">Define shift timing, break allowance, recurring days, and default locations</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShiftTplModal(null)}
                  className="p-1 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {shiftTplModal.mode === 'create' && (
                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="text-slate-500 dark:text-slate-400 font-medium mr-1">Quick presets:</span>
                  {[
                    { code: 'OPEN', name: 'Opening Shift', startTime: '07:00', endTime: '15:00', defaultRole: 'Lead Cashier / Prep Cook' },
                    { code: 'MID', name: 'Mid-Day Shift', startTime: '11:00', endTime: '19:00', defaultRole: 'Line Cook / Service Crew' },
                    { code: 'CLOSE', name: 'Closing Shift', startTime: '15:00', endTime: '23:00', defaultRole: 'Griller / Closer' },
                  ].map((preset) => (
                    <button
                      key={preset.code}
                      type="button"
                      onClick={() =>
                        setShiftTplForm((f) => ({
                          ...f,
                          code: preset.code,
                          name: preset.name,
                          startTime: preset.startTime,
                          endTime: preset.endTime,
                          defaultRole: preset.defaultRole,
                        }))
                      }
                      className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 px-2.5 py-1 font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      {preset.name} ({preset.startTime}–{preset.endTime})
                    </button>
                  ))}
                </div>
              )}

              {shiftTplErr && (
                <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">
                  {shiftTplErr}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Template Code *</label>
                  <input
                    required
                    maxLength={32}
                    placeholder="e.g. OPEN, MID, CLOSE"
                    value={shiftTplForm.code}
                    onChange={(e) => setShiftTplForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 font-mono uppercase"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Template Name *</label>
                  <input
                    required
                    maxLength={120}
                    placeholder="e.g. Opening Shift"
                    value={shiftTplForm.name}
                    onChange={(e) => setShiftTplForm((f) => ({ ...f, name: e.target.value }))}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Start Time *</label>
                  <input
                    type="time"
                    required
                    value={shiftTplForm.startTime}
                    onChange={(e) => setShiftTplForm((f) => ({ ...f, startTime: e.target.value }))}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">End Time *</label>
                  <input
                    type="time"
                    required
                    value={shiftTplForm.endTime}
                    onChange={(e) => setShiftTplForm((f) => ({ ...f, endTime: e.target.value }))}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Unpaid Break (mins)</label>
                  <input
                    type="number"
                    min="0"
                    max="480"
                    required
                    value={shiftTplForm.breakMinutes}
                    onChange={(e) => setShiftTplForm((f) => ({ ...f, breakMinutes: e.target.value }))}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Crew Headcount / Location *</label>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    required
                    value={shiftTplForm.headcountNeeded}
                    onChange={(e) => setShiftTplForm((f) => ({ ...f, headcountNeeded: e.target.value }))}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 font-mono"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Default Role / Station</label>
                  <input
                    maxLength={120}
                    placeholder="e.g. Griller / Closer, Lead Cashier"
                    value={shiftTplForm.defaultRole}
                    onChange={(e) => setShiftTplForm((f) => ({ ...f, defaultRole: e.target.value }))}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2"
                  />
                </div>

                <div className="sm:col-span-2 space-y-1.5">
                  <label className="block font-medium text-slate-700 dark:text-slate-200">Recurring Days of Week *</label>
                  <div className="flex flex-wrap gap-1.5">
                    {WEEKDAY_ORDER.map((day) => {
                      const active = shiftTplForm.daysOfWeek.includes(day);
                      return (
                        <button
                          key={day}
                          type="button"
                          onClick={() =>
                            setShiftTplForm((f) => ({
                              ...f,
                              daysOfWeek: active
                                ? f.daysOfWeek.filter((d) => d !== day)
                                : [...f.daysOfWeek, day],
                            }))
                          }
                          className={`rounded-md border px-2.5 py-1.5 font-mono text-[11px] font-semibold transition-colors ${
                            active
                              ? 'border-slate-900 dark:border-slate-100 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950'
                              : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                          }`}
                        >
                          {day}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="sm:col-span-2 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="font-medium text-slate-700 dark:text-slate-200">Default Target Locations</label>
                    <div className="flex items-center gap-2 text-[11px]">
                      <button
                        type="button"
                        onClick={() => setShiftTplForm((f) => ({ ...f, locationIds: locations.map((l) => l.id) }))}
                        className="text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white underline"
                      >
                        Select all
                      </button>
                      <button
                        type="button"
                        onClick={() => setShiftTplForm((f) => ({ ...f, locationIds: [] }))}
                        className="text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100 underline"
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50 p-2.5">
                    {locations.map((loc) => {
                      const checked = shiftTplForm.locationIds.includes(loc.id);
                      return (
                        <label key={loc.id} className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-200 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) =>
                              setShiftTplForm((f) => ({
                                ...f,
                                locationIds: e.target.checked
                                  ? [...f.locationIds, loc.id]
                                  : f.locationIds.filter((id) => id !== loc.id),
                              }))
                            }
                            className="rounded border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-50 focus:ring-slate-900 dark:focus:ring-slate-200"
                          />
                          <span className="truncate">{loc.name}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div className="sm:col-span-2">
                  <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Shift Checklist / Notes</label>
                  <textarea
                    rows={2}
                    maxLength={400}
                    placeholder="Opening prep, POS float count, grill sanitization..."
                    value={shiftTplForm.notes}
                    onChange={(e) => setShiftTplForm((f) => ({ ...f, notes: e.target.value }))}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2"
                  />
                </div>

                <div className="sm:col-span-2 flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="shiftTplIsActive"
                    checked={shiftTplForm.isActive}
                    onChange={(e) => setShiftTplForm((f) => ({ ...f, isActive: e.target.checked }))}
                    className="rounded border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-50 focus:ring-slate-900 dark:focus:ring-slate-200"
                  />
                  <label htmlFor="shiftTplIsActive" className="text-xs font-medium text-slate-700 dark:text-slate-200 cursor-pointer">
                    Template is active for recurring schedule generation
                  </label>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100 dark:border-slate-800/80">
                <button
                  type="button"
                  onClick={() => setShiftTplModal(null)}
                  className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingShiftTpl}
                  className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 text-xs font-semibold hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50"
                >
                  {savingShiftTpl ? 'Saving...' : shiftTplModal.mode === 'create' ? 'Create Shift Template' : 'Save Template'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Generate Recurring Multi-Location Schedule Modal */}
        {genSchedModal && (() => {
          const allTpls = hrData.shiftTemplates || [];
          const activeCrew = (hrData.employees || []).filter((e: any) => e.is_active !== 0);
          const weekdayMap = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
          let matchingDays = 0;
          if (genSchedForm.startDate && genSchedForm.endDate && genSchedForm.startDate <= genSchedForm.endDate) {
            const [sy, sm, sd] = genSchedForm.startDate.split('-').map(Number);
            const [ey, em, ed] = genSchedForm.endDate.split('-').map(Number);
            const sMs = Date.UTC(sy, sm - 1, sd);
            const eMs = Date.UTC(ey, em - 1, ed);
            for (let t = sMs; t <= eMs && matchingDays < 65; t += 86400000) {
              const code = weekdayMap[new Date(t).getUTCDay()];
              if (genSchedForm.daysOfWeek.includes(code)) matchingDays++;
            }
          }
          const slotsPerLoc =
            genSchedForm.assignmentMode === 'SELECTED_EMPLOYEES'
              ? genSchedForm.employeeIds.length
              : Math.max(1, Number(genSchedForm.headcountPerLocation || 1));
          const previewTotal = matchingDays * genSchedForm.locationIds.length * slotsPerLoc;

          const existingWindows = (hrData.shiftSchedules || []).map(toUiShiftWindow);
          const previewCandidates = buildGenSchedPreviewCandidates();
          const liveConflicts = findScheduleCandidateConflicts(previewCandidates, existingWindows);
          const displayedConflicts = genSchedConflicts.length > 0 ? genSchedConflicts : liveConflicts;

          return (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
              onClick={() => setGenSchedModal(null)}
            >
              <form
                onClick={(e) => e.stopPropagation()}
                onSubmit={handleGenerateSchedules}
                className="w-full max-w-xl rounded-xl bg-white dark:bg-slate-900 p-6 border border-slate-200 dark:border-slate-800 shadow-2xl space-y-4 max-h-[92vh] overflow-y-auto"
              >
                <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800/80 pb-3">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950">
                      <CopyPlus className="w-4 h-4" />
                    </div>
                    <div>
                      <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">Generate Recurring Multi-Location Schedule</h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400">Roll out shifts from a template across multiple food trucks and dates</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setGenSchedModal(null)}
                    className="p-1 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {genSchedErr && (
                  <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">
                    {genSchedErr}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div className="sm:col-span-2">
                    <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Shift Template *</label>
                    <select
                      required
                      value={genSchedForm.templateId}
                      onChange={(e) => applyTemplateDefaultsToGenForm(e.target.value)}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 font-medium text-slate-800 dark:text-slate-100"
                    >
                      {allTpls.map((tpl: any) => (
                        <option key={tpl.id} value={tpl.id}>
                          {tpl.code} — {tpl.name} ({tpl.start_time}–{tpl.end_time})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Start Date *</label>
                    <input
                      type="date"
                      required
                      value={genSchedForm.startDate}
                      onChange={(e) => {
                        setGenSchedConflicts([]);
                        setGenSchedForm((f) => ({ ...f, startDate: e.target.value }));
                      }}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 font-mono"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">End Date *</label>
                    <input
                      type="date"
                      required
                      value={genSchedForm.endDate}
                      onChange={(e) => {
                        setGenSchedConflicts([]);
                        setGenSchedForm((f) => ({ ...f, endDate: e.target.value }));
                      }}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 font-mono"
                    />
                  </div>

                  <div className="sm:col-span-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className="text-slate-500 dark:text-slate-400 font-medium mr-1">Range presets:</span>
                    {[
                      { label: 'Next 7 Days', days: 6 },
                      { label: 'Next 14 Days', days: 13 },
                      { label: 'Next 30 Days', days: 29 },
                    ].map((rng) => (
                      <button
                        key={rng.label}
                        type="button"
                        onClick={() => {
                          setGenSchedConflicts([]);
                          const base = genSchedForm.startDate || getTodayLocalDate();
                          setGenSchedForm((f) => ({ ...f, startDate: base, endDate: addDaysIso(base, rng.days) }));
                        }}
                        className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 px-2.5 py-1 font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                      >
                        {rng.label}
                      </button>
                    ))}
                  </div>

                  <div className="sm:col-span-2 space-y-1.5">
                    <label className="block font-medium text-slate-700 dark:text-slate-200">Recurring Days *</label>
                    <div className="flex flex-wrap gap-1.5">
                      {WEEKDAY_ORDER.map((day) => {
                        const active = genSchedForm.daysOfWeek.includes(day);
                        return (
                          <button
                            key={day}
                            type="button"
                            onClick={() => {
                              setGenSchedConflicts([]);
                              setGenSchedForm((f) => ({
                                ...f,
                                daysOfWeek: active
                                  ? f.daysOfWeek.filter((d) => d !== day)
                                  : [...f.daysOfWeek, day],
                              }));
                            }}
                            className={`rounded-md border px-2.5 py-1.5 font-mono text-[11px] font-semibold transition-colors ${
                              active
                                ? 'border-slate-900 dark:border-slate-100 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950'
                                : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                            }`}
                          >
                            {day}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="sm:col-span-2 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label className="font-medium text-slate-700 dark:text-slate-200">Target Locations *</label>
                      <div className="flex items-center gap-2 text-[11px]">
                        <button
                          type="button"
                          onClick={() => {
                            setGenSchedConflicts([]);
                            setGenSchedForm((f) => ({ ...f, locationIds: locations.map((l) => l.id) }));
                          }}
                          className="text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white underline"
                        >
                          All locations
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setGenSchedConflicts([]);
                            setGenSchedForm((f) => ({
                              ...f,
                              locationIds: locations.filter((l) => l.type === 'FOOD_TRUCK').map((l) => l.id),
                            }));
                          }}
                          className="text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white underline"
                        >
                          Food trucks only
                        </button>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50 p-2.5">
                      {locations.map((loc) => {
                        const checked = genSchedForm.locationIds.includes(loc.id);
                        return (
                          <label key={loc.id} className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-200 cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => {
                                setGenSchedConflicts([]);
                                setGenSchedForm((f) => ({
                                  ...f,
                                  locationIds: e.target.checked
                                    ? [...f.locationIds, loc.id]
                                    : f.locationIds.filter((id) => id !== loc.id),
                                }));
                              }}
                              className="rounded border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-50 focus:ring-slate-900 dark:focus:ring-slate-200"
                            />
                            <span className="truncate">{loc.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  <div className="sm:col-span-2 space-y-2">
                    <label className="block font-medium text-slate-700 dark:text-slate-200">Crew Assignment Strategy</label>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      {[
                        { id: 'AUTO_BY_LOCATION', title: 'Auto-Assign Crew', desc: 'Match location staff + open slots' },
                        { id: 'OPEN_SLOTS', title: 'Open Shift Slots', desc: 'Create unassigned roster slots' },
                        { id: 'SELECTED_EMPLOYEES', title: 'Specific Crew', desc: 'Assign selected staff to sites' },
                      ].map((opt) => {
                        const active = genSchedForm.assignmentMode === opt.id;
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => {
                              setGenSchedConflicts([]);
                              setGenSchedForm((f) => ({ ...f, assignmentMode: opt.id as any }));
                            }}
                            className={`rounded-lg border p-2.5 text-left transition-colors ${
                              active
                                ? 'border-slate-900 dark:border-slate-100 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950'
                                : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800'
                            }`}
                          >
                            <p className="text-xs font-semibold">{opt.title}</p>
                            <p className={`text-[10px] mt-0.5 ${active ? 'text-slate-500 dark:text-slate-500' : 'text-slate-500 dark:text-slate-400'}`}>{opt.desc}</p>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {genSchedForm.assignmentMode !== 'SELECTED_EMPLOYEES' ? (
                    <div className="sm:col-span-2">
                      <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Slots per Location per Day</label>
                      <input
                        type="number"
                        min="1"
                        max="20"
                        required
                        value={genSchedForm.headcountPerLocation}
                        onChange={(e) => {
                          setGenSchedConflicts([]);
                          setGenSchedForm((f) => ({ ...f, headcountPerLocation: e.target.value }));
                        }}
                        className="w-full sm:w-40 rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 font-mono"
                      />
                    </div>
                  ) : (
                    <div className="sm:col-span-2 space-y-1.5">
                      <label className="block font-medium text-slate-700 dark:text-slate-200">Select Employees to Deploy *</label>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-36 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50 p-2.5">
                        {activeCrew.map((emp: any) => {
                          const checked = genSchedForm.employeeIds.includes(emp.id);
                          return (
                            <label key={emp.id} className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-200 cursor-pointer select-none">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => {
                                  setGenSchedConflicts([]);
                                  setGenSchedForm((f) => ({
                                    ...f,
                                    employeeIds: e.target.checked
                                      ? [...f.employeeIds, emp.id]
                                      : f.employeeIds.filter((id) => id !== emp.id),
                                  }));
                                }}
                                className="rounded border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-50 focus:ring-slate-900 dark:focus:ring-slate-200"
                              />
                              <span className="truncate">{emp.full_name} ({emp.employee_code})</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div className="sm:col-span-2">
                    <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Schedule Notes (Optional)</label>
                    <input
                      maxLength={400}
                      placeholder="Override template notes for this recurring cycle"
                      value={genSchedForm.notes}
                      onChange={(e) => setGenSchedForm((f) => ({ ...f, notes: e.target.value }))}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2"
                    />
                  </div>
                </div>

                {/* Live Overlap Scanner Feedback */}
                {displayedConflicts.length > 0 ? (
                  <div className="rounded-lg border border-red-200 dark:border-red-800/80 bg-red-50/80 dark:bg-red-950/50 p-3 space-y-2 text-xs">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-red-600 dark:text-red-300 shrink-0 mt-0.5" />
                      <div>
                        <p className="font-bold text-red-900 dark:text-red-300">
                          {genSchedConflicts.length > 0 ? 'Save Paused — ' : 'Pre-Save Overlap Check: '}
                          <span className="font-mono tabular-nums">{displayedConflicts.length}</span> overlapping crew shift(s) found
                        </p>
                        <p className="text-[11px] text-red-800 dark:text-red-300 mt-0.5">
                          Choose to skip conflicting assignments cleanly, or save anyway to flag and highlight them on the roster.
                        </p>
                      </div>
                    </div>
                    <div className="space-y-1 max-h-28 overflow-y-auto pl-6">
                      {displayedConflicts.slice(0, 6).map((c) => (
                        <p key={c.conflictKey} className="text-[11px] text-red-900 dark:text-red-300">
                          <span className="font-mono font-semibold">{c.shiftDate}</span> · <strong>{c.employeeName}</strong>: {c.newTemplateName} ({c.newTimeRange} @ {c.newLocationName}) overlaps {c.existingTemplateName} ({c.existingTimeRange} @ {c.existingLocationName}) by <strong>{formatOverlapDuration(c.overlapMinutes)}</strong>
                        </p>
                      ))}
                      {displayedConflicts.length > 6 && (
                        <p className="text-[11px] font-medium text-red-800 dark:text-red-300">
                          +{displayedConflicts.length - 6} more overlap conflict(s)
                        </p>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 px-3.5 py-2.5 text-xs text-slate-700 dark:text-slate-200 flex flex-wrap items-center justify-between gap-2">
                    <span>
                      Preview: <strong className="font-mono tabular-nums text-slate-900 dark:text-slate-50">{previewTotal}</strong> shift slot(s) across{' '}
                      <strong className="font-mono tabular-nums text-slate-900 dark:text-slate-50">{genSchedForm.locationIds.length}</strong> location(s) and{' '}
                      <strong className="font-mono tabular-nums text-slate-900 dark:text-slate-50">{matchingDays}</strong> matching day(s)
                    </span>
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                      <CheckCircle2 className="w-3.5 h-3.5" /> 0 overlaps detected
                    </span>
                  </div>
                )}

                <div className="flex flex-wrap justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800/80">
                  <button
                    type="button"
                    onClick={() => setGenSchedModal(null)}
                    className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    Cancel
                  </button>
                  {genSchedConflicts.length > 0 ? (
                    <>
                      <button
                        type="button"
                        disabled={generatingSched}
                        onClick={() => executeGenerateSchedules('SKIP_CONFLICTS')}
                        className="px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
                      >
                        Skip Conflicting Crew &amp; Save
                      </button>
                      <button
                        type="button"
                        disabled={generatingSched}
                        onClick={() => executeGenerateSchedules('ALLOW_CONFLICTS')}
                        className="px-4 py-2 rounded-lg bg-red-600 text-white text-xs font-semibold hover:bg-red-700 disabled:opacity-50"
                      >
                        {generatingSched ? 'Saving...' : 'Save Anyway & Highlight Conflicts'}
                      </button>
                    </>
                  ) : (
                    <button
                      type="submit"
                      disabled={generatingSched || previewTotal === 0}
                      className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 text-xs font-semibold hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50"
                    >
                      {generatingSched ? 'Generating Schedules...' : `Generate ${previewTotal} Shift(s)`}
                    </button>
                  )}
                </div>
              </form>
            </div>
          );
        })()}

        {/* Add Single Shift Slot Modal (with Automated Pre-Save Overlap Check) */}
        {singleShiftModal && (() => {
          const allTpls = hrData.shiftTemplates || [];
          const activeCrew = (hrData.employees || []).filter((e: any) => e.is_active !== 0);
          const existingWindows = (hrData.shiftSchedules || []).map(toUiShiftWindow);
          const locName = locations.find((l) => l.id === singleShiftForm.locationId)?.name || singleShiftForm.locationId;
          const emp = activeCrew.find((e: any) => e.id === singleShiftForm.employeeId);

          const candidateWindow: ShiftWindowLike = {
            id: 'new_single_shift_preview',
            templateId: singleShiftForm.templateId || null,
            templateName: singleShiftForm.templateName || 'Custom Shift',
            locationId: singleShiftForm.locationId,
            locationName: locName,
            employeeId: singleShiftForm.employeeId || null,
            employeeName: emp?.full_name || null,
            employeeCode: emp?.employee_code || null,
            shiftDate: singleShiftForm.shiftDate,
            startTime: singleShiftForm.startTime,
            endTime: singleShiftForm.endTime,
            status: singleShiftForm.status,
          };
          const liveSingleConflicts = findScheduleCandidateConflicts([candidateWindow], existingWindows);
          const activeSingleConflicts = singleShiftConflicts.length > 0 ? singleShiftConflicts : liveSingleConflicts;

          return (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
              onClick={() => !savingSingleShift && setSingleShiftModal(false)}
            >
              <form
                onClick={(e) => e.stopPropagation()}
                onSubmit={(e) => {
                  e.preventDefault();
                  submitSingleShift('PROMPT');
                }}
                className="w-full max-w-lg rounded-xl bg-white dark:bg-slate-900 p-6 border border-slate-200 dark:border-slate-800 shadow-2xl space-y-4 max-h-[92vh] overflow-y-auto"
              >
                <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800/80 pb-3">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950">
                      <Calendar className="w-4 h-4" />
                    </div>
                    <div>
                      <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">Schedule Single Shift</h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400">Automatically checks for overlapping crew shifts before saving</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSingleShiftModal(false)}
                    className="p-1 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {singleShiftErr && (
                  <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">
                    {singleShiftErr}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Preset Template</label>
                    <select
                      value={singleShiftForm.templateId}
                      onChange={(e) => handleSingleShiftTemplateSelect(e.target.value)}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 font-medium text-slate-800 dark:text-slate-100"
                    >
                      <option value="">Custom Shift Window</option>
                      {allTpls.map((tpl: any) => (
                        <option key={tpl.id} value={tpl.id}>
                          {tpl.code} — {tpl.name} ({tpl.start_time}–{tpl.end_time})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Shift Name *</label>
                    <input
                      required
                      maxLength={120}
                      value={singleShiftForm.templateName}
                      onChange={(e) => setSingleShiftForm((f) => ({ ...f, templateName: e.target.value }))}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2"
                    />
                  </div>

                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Location *</label>
                    <select
                      required
                      value={singleShiftForm.locationId}
                      onChange={(e) => {
                        setSingleShiftConflicts([]);
                        setSingleShiftForm((f) => ({ ...f, locationId: e.target.value }));
                      }}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2"
                    >
                      {locations.map((loc) => (
                        <option key={loc.id} value={loc.id}>
                          {loc.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Shift Date *</label>
                    <input
                      type="date"
                      required
                      value={singleShiftForm.shiftDate}
                      onChange={(e) => {
                        setSingleShiftConflicts([]);
                        setSingleShiftForm((f) => ({ ...f, shiftDate: e.target.value }));
                      }}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 font-mono"
                    />
                  </div>

                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Start Time *</label>
                    <input
                      type="time"
                      required
                      value={singleShiftForm.startTime}
                      onChange={(e) => {
                        setSingleShiftConflicts([]);
                        setSingleShiftForm((f) => ({ ...f, startTime: e.target.value }));
                      }}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 font-mono"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">End Time *</label>
                    <input
                      type="time"
                      required
                      value={singleShiftForm.endTime}
                      onChange={(e) => {
                        setSingleShiftConflicts([]);
                        setSingleShiftForm((f) => ({ ...f, endTime: e.target.value }));
                      }}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 font-mono"
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Assign Crew Member</label>
                    <select
                      value={singleShiftForm.employeeId}
                      onChange={(e) => {
                        setSingleShiftConflicts([]);
                        setSingleShiftForm((f) => ({ ...f, employeeId: e.target.value }));
                      }}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 font-medium text-slate-800 dark:text-slate-100"
                    >
                      <option value="">Open Slot (Unassigned)</option>
                      {activeCrew.map((c: any) => (
                        <option key={c.id} value={c.id}>
                          {c.full_name} ({c.employee_code}){c.location_id === singleShiftForm.locationId ? ' ★ Home Branch' : ''}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Break (mins)</label>
                    <input
                      type="number"
                      min="0"
                      max="480"
                      value={singleShiftForm.breakMinutes}
                      onChange={(e) => setSingleShiftForm((f) => ({ ...f, breakMinutes: e.target.value }))}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 font-mono"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1">Status</label>
                    <select
                      value={singleShiftForm.status}
                      onChange={(e) => {
                        setSingleShiftConflicts([]);
                        setSingleShiftForm((f) => ({ ...f, status: e.target.value }));
                      }}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 font-medium"
                    >
                      <option value="SCHEDULED">Scheduled</option>
                      <option value="CONFIRMED">Confirmed</option>
                    </select>
                  </div>
                </div>

                {activeSingleConflicts.length > 0 ? (
                  <div className="rounded-lg border border-red-200 dark:border-red-800/80 bg-red-50/80 dark:bg-red-950/50 p-3 space-y-1.5 text-xs">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-red-600 dark:text-red-300 shrink-0 mt-0.5" />
                      <div>
                        <p className="font-bold text-red-900 dark:text-red-300">
                          {singleShiftConflicts.length > 0 ? 'Conflict Confirmation Required' : 'Overlapping Shift Detected'}
                        </p>
                        {activeSingleConflicts.map((c) => (
                          <p key={c.conflictKey} className="text-[11px] text-red-800 dark:text-red-300 mt-0.5">
                            <strong>{c.employeeName}</strong> already has <strong>{c.existingTemplateName}</strong> (
                            <span className="font-mono">{c.existingTimeRange}</span> at {c.existingLocationName}) on{' '}
                            <span className="font-mono">{c.existingShiftDate}</span> —{' '}
                            <strong>{formatOverlapDuration(c.overlapMinutes)}</strong> overlap.
                          </p>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 px-3 py-2 text-[11px] text-emerald-700 dark:text-emerald-300 font-medium flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                    <span>
                      {singleShiftForm.employeeId
                        ? 'No overlapping shifts found for the selected crew member.'
                        : 'Assign a crew member above to validate against overlapping shifts.'}
                    </span>
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800/80">
                  <button
                    type="button"
                    disabled={savingSingleShift}
                    onClick={() => setSingleShiftModal(false)}
                    className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    Cancel
                  </button>
                  {singleShiftConflicts.length > 0 ? (
                    <button
                      type="button"
                      disabled={savingSingleShift}
                      onClick={() => submitSingleShift('ALLOW_CONFLICTS')}
                      className="px-4 py-2 rounded-lg bg-red-600 text-white text-xs font-semibold hover:bg-red-700 disabled:opacity-50"
                    >
                      {savingSingleShift ? 'Saving...' : 'Save & Highlight Conflict'}
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={savingSingleShift}
                      className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 text-xs font-semibold hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50"
                    >
                      {savingSingleShift ? 'Saving...' : 'Save Shift'}
                    </button>
                  )}
                </div>
              </form>
            </div>
          );
        })()}

        {/* Delete Shift Template Confirmation Modal */}
        {deleteShiftTplTarget && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
            onClick={() => !deletingShiftTpl && setDeleteShiftTplTarget(null)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-sm rounded-xl bg-white dark:bg-slate-900 p-5 border border-slate-200 dark:border-slate-800 shadow-2xl space-y-4"
            >
              <div className="space-y-1">
                <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">Delete Shift Template?</h3>
                <p className="text-xs text-slate-600 dark:text-slate-300">
                  Remove template <strong>{deleteShiftTplTarget.name}</strong> (<span className="font-mono">{deleteShiftTplTarget.code}</span>)? Already generated schedules will remain in the roster.
                </p>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  disabled={deletingShiftTpl}
                  onClick={() => setDeleteShiftTplTarget(null)}
                  className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={deletingShiftTpl}
                  onClick={handleDeleteShiftTemplate}
                  className="px-3.5 py-2 rounded-lg bg-red-600 text-white text-xs font-semibold hover:bg-red-700 disabled:opacity-50"
                >
                  {deletingShiftTpl ? 'Deleting...' : 'Delete Template'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ==========================================
  // CRM & LOYALTY
  // ==========================================
  if (mode === 'crm') {
    const isCrmLocFiltered = Boolean(activeLocationId && activeLocationId !== 'ALL');
    const locFilteredCustomers = isCrmLocFiltered
      ? customers.filter((c) => c.location_id === activeLocationId)
      : customers;

    const term = crmSearch.trim().toLowerCase();
    const visibleCustomers = locFilteredCustomers.filter((c) => {
      const matchTier = crmTierFilter === 'ALL' || c.tier === crmTierFilter;
      const matchText =
        !term ||
        (c.full_name || '').toLowerCase().includes(term) ||
        (c.phone || '').toLowerCase().includes(term) ||
        (c.email || '').toLowerCase().includes(term) ||
        (c.preferences || '').toLowerCase().includes(term);
      return matchTier && matchText;
    });

    const totalPoints = locFilteredCustomers.reduce((sum, c) => sum + Number(c.loyalty_points || 0), 0);
    const totalLifetimeSpend = locFilteredCustomers.reduce((sum, c) => sum + Number(c.lifetime_spend || 0), 0);
    const totalOrders = locFilteredCustomers.reduce((sum, c) => sum + Number(c.total_orders || 0), 0);
    const avgSpend = locFilteredCustomers.length ? totalLifetimeSpend / locFilteredCustomers.length : 0;

    const handleOpenCustomerDetail = async (cust: any) => {
      setSelectedCustDetail(cust);
      setIsLoadingDetail(true);
      setDetailTransactions([]);
      try {
        if (cust.phone) {
          const res = await apiFetch(`/crm/kiosk/lookup?phone=${encodeURIComponent(cust.phone)}`);
          if (res.transactions) {
            setDetailTransactions(res.transactions);
          }
        }
      } catch {
        // ignore
      } finally {
        setIsLoadingDetail(false);
      }
    };

    return (
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-semibold text-slate-900 dark:text-slate-50">
              Customer CRM &amp; Loyalty Kiosk
            </h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Points-based loyalty program, POS counter QR standee, phone-based member check-in, and transaction history linking
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCrmSubTab('kiosk')}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${
                crmSubTab === 'kiosk'
                  ? 'bg-amber-600 text-white shadow-sm'
                  : 'border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              <QrCode className="w-4 h-4" />
              Counter Loyalty Kiosk
            </button>
            <button
              type="button"
              onClick={() => setCrmSubTab('members')}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${
                crmSubTab === 'members'
                  ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 shadow-sm'
                  : 'border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              <Users className="w-4 h-4" />
              Member Directory ({locFilteredCustomers.length})
            </button>
          </div>
        </div>

        {msg && <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/45 border border-emerald-200 dark:border-emerald-700/80 text-xs text-emerald-800 dark:text-emerald-300 font-medium">{msg}</div>}
        {err && <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">{err}</div>}

        {/* SUBTAB 1: CUSTOMER LOYALTY KIOSK INTERFACE */}
        {crmSubTab === 'kiosk' && (
          <CustomerLoyaltyKiosk
            mode="embedded"
            locations={locations}
            activeLocationId={activeLocationId}
          />
        )}

        {/* SUBTAB 2: MEMBER DIRECTORY & REGISTRATION */}
        {crmSubTab === 'members' && (
          <div className="space-y-6">
            {/* KPI Summary Cards */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
                <div className="flex items-center justify-between text-slate-500 dark:text-slate-400">
                  <span className="text-xs font-medium">Registered Members</span>
                  <Users className="w-4 h-4 text-slate-500 dark:text-slate-400" />
                </div>
                <p className="mt-2 text-2xl font-bold font-mono text-slate-900 dark:text-slate-50 tabular-nums">
                  {locFilteredCustomers.length}
                </p>
                <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">{totalOrders} completed loyalty orders</p>
              </div>

              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
                <div className="flex items-center justify-between text-slate-500 dark:text-slate-400">
                  <span className="text-xs font-medium">Active Loyalty Points</span>
                  <Award className="w-4 h-4 text-amber-500" />
                </div>
                <p className="mt-2 text-2xl font-bold font-mono text-amber-700 dark:text-amber-300 tabular-nums">
                  {totalPoints}
                </p>
                <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">₱50 spend = 1 pt · 25 welcome bonus</p>
              </div>

              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
                <div className="flex items-center justify-between text-slate-500 dark:text-slate-400">
                  <span className="text-xs font-medium">Member Lifetime Spend</span>
                  <Receipt className="w-4 h-4 text-slate-500 dark:text-slate-400" />
                </div>
                <p className="mt-2 text-2xl font-bold font-mono text-slate-900 dark:text-slate-50 tabular-nums">
                  {formatPHP(totalLifetimeSpend)}
                </p>
                <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">Cumulative repeat customer revenue</p>
              </div>

              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
                <div className="flex items-center justify-between text-slate-500 dark:text-slate-400">
                  <span className="text-xs font-medium">Average Spend / Member</span>
                  <Sparkles className="w-4 h-4 text-slate-500 dark:text-slate-400" />
                </div>
                <p className="mt-2 text-2xl font-bold font-mono text-slate-900 dark:text-slate-50 tabular-nums">
                  {formatPHP(avgSpend)}
                </p>
                <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">Across {locations.length} food truck locations</p>
              </div>
            </div>

            {/* Main CRM Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* Left Column: Register Customer Manual Form */}
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setErr('');
                  try {
                    await apiFetch('/crm/customers', { method: 'POST', body: JSON.stringify(custForm) });
                    setCustForm({
                      fullName: '',
                      phone: '',
                      email: '',
                      preferences: '',
                      registeredAt: getTodayLocalDate(),
                      locationId: getDefaultCustLoc(),
                    });
                    setMsg('Added customer loyalty profile.');
                    await loadCrm();
                  } catch (e: any) {
                    setErr(e.message || 'Unable to save customer profile');
                  }
                }}
                className="lg:col-span-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3.5 shadow-sm"
              >
                <div className="flex items-center justify-between">
                  <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50 flex items-center gap-1.5">
                    <Plus className="w-4 h-4 text-amber-600 dark:text-amber-400" /> Register Customer
                  </h2>
                  <span className="text-[11px] text-amber-800 dark:text-amber-300 font-medium">Manual Entry</span>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Full Name *</label>
                  <input
                    required
                    placeholder="e.g. Marco Reyes"
                    value={custForm.fullName}
                    onChange={(e) => setCustForm({ ...custForm, fullName: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs text-slate-900 dark:text-slate-50 focus:outline-none focus:ring-1 focus:ring-amber-500"
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Registration Date *</label>
                    <input
                      type="date"
                      required
                      value={custForm.registeredAt}
                      onChange={(e) => setCustForm({ ...custForm, registeredAt: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Registered Truck / Location *</label>
                    <select
                      required
                      value={custForm.locationId}
                      onChange={(e) => setCustForm({ ...custForm, locationId: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                    >
                      <option value="">Select Truck / Location</option>
                      {locations.map((loc) => (
                        <option key={loc.id} value={loc.id}>
                          {loc.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Mobile Phone (PH)</label>
                  <input
                    placeholder="e.g. 0917 555 0192"
                    value={custForm.phone}
                    onChange={(e) => setCustForm({ ...custForm, phone: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Email Address</label>
                  <input
                    type="email"
                    placeholder="e.g. marco@email.com"
                    value={custForm.email}
                    onChange={(e) => setCustForm({ ...custForm, email: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Food Preferences / Allergies</label>
                  <input
                    placeholder="e.g. Extra spicy, no peanuts"
                    value={custForm.preferences}
                    onChange={(e) => setCustForm({ ...custForm, preferences: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                  />
                </div>
                <button type="submit" className="w-full rounded-lg bg-slate-900 dark:bg-slate-100 py-2 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white transition-colors shadow-sm">
                  Save Customer Profile
                </button>
              </form>

              {/* Right Column: Member Table with Search, Filter & Clickable Details */}
              <div className="lg:col-span-8 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-sm space-y-3">
                {/* Search & Tier Filters Bar */}
                <div className="p-3.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 bg-slate-50/50 dark:bg-slate-800/50">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {(['ALL', 'STANDARD', 'SILVER', 'GOLD', 'PLATINUM'] as const).map((tier) => (
                      <button
                        key={tier}
                        type="button"
                        onClick={() => setCrmTierFilter(tier)}
                        className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                          crmTierFilter === tier
                            ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 font-semibold'
                            : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                        }`}
                      >
                        {tier === 'ALL' ? 'All Tiers' : tier}
                      </button>
                    ))}
                  </div>

                  <div className="relative w-56">
                    <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400" />
                    <input
                      type="text"
                      value={crmSearch}
                      onChange={(e) => setCrmSearch(e.target.value)}
                      placeholder="Search name, phone, email..."
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 py-1.5 pl-9 pr-3 text-xs text-slate-900 dark:text-slate-50 focus:outline-none focus:ring-1 focus:ring-amber-500"
                    />
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
                      <tr>
                        <th className="p-3 font-medium">Customer</th>
                        <th className="p-3 font-medium">Registered</th>
                        <th className="p-3 font-medium">Tier</th>
                        <th className="p-3 font-medium text-right">Points</th>
                        <th className="p-3 font-medium text-right">Orders</th>
                        <th className="p-3 font-medium text-right">Lifetime Spend</th>
                        <th className="p-3 font-medium text-center">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {visibleCustomers.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
                            No customers found matching search or tier filters.
                          </td>
                        </tr>
                      ) : (
                        visibleCustomers.map((c) => (
                          <tr key={c.id} className="hover:bg-slate-50/80 dark:hover:bg-slate-800/80 transition-colors">
                            <td className="p-3">
                              <span className="font-semibold text-slate-900 dark:text-slate-50 block">{c.full_name}</span>
                              <p className="font-mono text-slate-500 dark:text-slate-400 text-[11px]">{c.phone || c.email || '—'}</p>
                            </td>
                            <td className="p-3 text-slate-600 dark:text-slate-300 whitespace-nowrap">
                              <p className="font-mono text-slate-800 dark:text-slate-100">{c.registered_at || '—'}</p>
                              <p className="text-[11px] text-slate-500 dark:text-slate-400">{c.location_name || 'Unassigned'}</p>
                            </td>
                            <td className="p-3">
                              <span
                                className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold ${
                                  c.tier === 'PLATINUM'
                                    ? 'bg-purple-100 text-purple-800'
                                    : c.tier === 'GOLD'
                                    ? 'bg-amber-100 dark:bg-amber-950/75 text-amber-800 dark:text-amber-300'
                                    : c.tier === 'SILVER'
                                    ? 'bg-blue-100 dark:bg-blue-950/75 text-blue-800 dark:text-blue-300'
                                    : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200'
                                }`}
                              >
                                {c.tier}
                              </span>
                            </td>
                            <td className="p-3 text-right font-mono tabular-nums font-semibold text-amber-700 dark:text-amber-300">
                              {c.loyalty_points}
                            </td>
                            <td className="p-3 text-right font-mono tabular-nums">{c.total_orders}</td>
                            <td className="p-3 text-right font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-50">
                              {formatPHP(c.lifetime_spend)}
                            </td>
                            <td className="p-3 text-center">
                              <button
                                type="button"
                                onClick={() => handleOpenCustomerDetail(c)}
                                className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                                title="View customer profile & transaction history"
                              >
                                <Eye className="w-3 h-3 text-slate-500 dark:text-slate-400" />
                                Details
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Customer Detail & Transaction History Drawer / Modal */}
        {selectedCustDetail && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
            <div className="w-full max-w-2xl rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
              {/* Modal Header */}
              <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex items-start justify-between bg-slate-50/50 dark:bg-slate-800/50">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-display text-lg font-bold text-slate-900 dark:text-slate-50">
                      {selectedCustDetail.full_name}
                    </h3>
                    <span className="inline-flex px-2 py-0.5 rounded text-xs font-bold bg-amber-100 dark:bg-amber-950/75 text-amber-800 dark:text-amber-300">
                      {selectedCustDetail.tier} Member
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 font-mono mt-0.5">
                    {selectedCustDetail.phone || 'No phone'} · Registered {selectedCustDetail.registered_at || '—'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedCustDetail(null)}
                  className="rounded-lg p-1.5 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 hover:text-slate-600 dark:hover:text-slate-300"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Modal Body */}
              <div className="p-5 overflow-y-auto space-y-4">
                {/* Stats Grid */}
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/70 p-3">
                    <span className="text-[11px] text-slate-500 dark:text-slate-400 block">Points Balance</span>
                    <span className="text-xl font-bold font-mono text-amber-700 dark:text-amber-300 tabular-nums">
                      {selectedCustDetail.loyalty_points}
                    </span>
                  </div>
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/70 p-3">
                    <span className="text-[11px] text-slate-500 dark:text-slate-400 block">Total Orders</span>
                    <span className="text-xl font-bold font-mono text-slate-900 dark:text-slate-50 tabular-nums">
                      {selectedCustDetail.total_orders}
                    </span>
                  </div>
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/70 p-3">
                    <span className="text-[11px] text-slate-500 dark:text-slate-400 block">Lifetime Spend</span>
                    <span className="text-xl font-bold font-mono text-slate-900 dark:text-slate-50 tabular-nums">
                      {formatPHP(selectedCustDetail.lifetime_spend)}
                    </span>
                  </div>
                </div>

                {selectedCustDetail.preferences && (
                  <div className="rounded-lg bg-amber-50/50 dark:bg-amber-950/45 border border-amber-200/60 p-3 text-xs text-amber-900 dark:text-amber-300">
                    <span className="font-semibold block mb-0.5">Food Preferences:</span>
                    <span>{selectedCustDetail.preferences}</span>
                  </div>
                )}

                {/* Linked Transactions Section */}
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-50 flex items-center gap-1.5">
                    <Receipt className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                    Linked Transactions ({detailTransactions.length})
                  </h4>

                  {isLoadingDetail ? (
                    <div className="p-6 text-center text-xs text-slate-500 dark:text-slate-400 animate-pulse">
                      Loading customer transaction history...
                    </div>
                  ) : detailTransactions.length === 0 ? (
                    <div className="p-6 text-center text-xs text-slate-500 dark:text-slate-400 border border-dashed border-slate-200 dark:border-slate-800 rounded-lg">
                      No transactions linked yet to this customer's mobile number.
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden max-h-60 overflow-y-auto">
                      {detailTransactions.map((t) => (
                        <div key={t.id} className="p-3 text-xs flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-800">
                          <div>
                            <span className="font-mono font-semibold text-slate-900 dark:text-slate-50 block">{t.receiptNumber}</span>
                            <span className="text-[11px] text-slate-500 dark:text-slate-400">
                              {t.soldAt ? new Date(t.soldAt).toLocaleString('en-PH', { dateStyle: 'short', timeStyle: 'short' }) : '—'} · {t.locationName}
                            </span>
                            <p className="text-[11px] text-slate-600 dark:text-slate-300 truncate max-w-sm mt-0.5">{t.itemsSummary}</p>
                          </div>
                          <div className="text-right shrink-0">
                            <span className="font-mono font-bold text-slate-900 dark:text-slate-50 block tabular-nums">{formatPHP(t.totalAmount)}</span>
                            <span className="text-[11px] font-semibold text-amber-700 dark:text-amber-300">+{t.pointsEarned} pts</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Modal Footer */}
              <div className="p-3.5 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end bg-slate-50 dark:bg-slate-800/70">
                <button
                  type="button"
                  onClick={() => setSelectedCustDetail(null)}
                  className="rounded-lg bg-slate-900 dark:bg-slate-100 px-4 py-1.5 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ==========================================
  // REPORTS, EXPORTS & RBAC GOVERNANCE
  // ==========================================
  const selectedLocationName = locationFilter
    ? locations.find((l) => l.id === locationFilter)?.name || 'Selected Branch'
    : 'All Trucks & Commissary';
  const hasActiveFilter = Boolean(locationFilter || reportFrom || reportTo);

  const handleBranchSelect = (nextLocId: string) => {
    setLocationFilter(nextLocId);
    onLocationChange?.(nextLocId || 'ALL');
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 dark:text-slate-50">Reports, Exports &amp; RBAC Audit</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">Exportable operational reports, 10-role permission matrix, and immutable audit trail</p>
        </div>
        <div className="flex items-center gap-2 no-print">
          <button
            onClick={() => {
              const branchSuffix = locationFilter ? `_${locationFilter}` : '';
              const rangeSuffix = reportFrom || reportTo ? `_${reportFrom || 'start'}_to_${reportTo || 'latest'}` : '';
              if (reportTab === 'audit' && governance?.auditLogs) {
                downloadCsv(`maximus_barbecue_audit_logs${branchSuffix}${rangeSuffix}.csv`, governance.auditLogs);
              } else if (reportTab === 'rbac' && governance?.roles) {
                const flatRoles = governance.roles.map((r: any) => ({
                  role_code: r.code,
                  role_name: r.name,
                  branch: selectedLocationName,
                  assigned_staff: (r.assigned_users || []).map((u: any) => `${u.full_name} (${u.email})`).join('; '),
                  audit_events: r.activity_count ?? 0,
                  permissions: (r.permissions || []).join(' | '),
                }));
                downloadCsv(`maximus_barbecue_rbac_matrix${branchSuffix}${rangeSuffix}.csv`, flatRoles);
              } else {
                downloadCsv(`maximus_barbecue_${reportType}_report${branchSuffix}${rangeSuffix}.csv`, reportRows);
              }
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            <Download className="w-3.5 h-3.5" /> Download CSV / Excel
          </button>
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-3 py-2 text-xs font-semibold text-white dark:text-slate-950"
          >
            <Printer className="w-3.5 h-3.5" /> Print / Save PDF
          </button>
        </div>
      </div>

      {err && <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">{err}</div>}

      <div className="flex flex-wrap items-center justify-between gap-3 no-print">
        <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-800 w-fit">
          {([
            { id: 'exports', label: 'Data Reports' },
            { id: 'rbac', label: '10-Role RBAC Matrix' },
            { id: 'audit', label: 'Immutable Audit Logs' },
          ] as const).map((t) => (
            <button
              key={t.id}
              onClick={() => setReportTab(t.id)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 ${
                reportTab === t.id ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50 shadow-sm' : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
            <MapPin className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
            Branch
          </span>
          <select
            aria-label="Filter by Branch"
            value={locationFilter}
            onChange={(e) => handleBranchSelect(e.target.value)}
            className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 px-2.5 py-1 text-xs font-medium text-slate-800 dark:text-slate-100"
          >
            <option value="">All Trucks &amp; Commissary</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>

          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 border-l border-slate-200 dark:border-slate-800 pl-2">
            <Calendar className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
            Date From
          </span>
          <input
            type="date"
            aria-label="Date From"
            value={reportFrom}
            onChange={(e) => setReportFrom(e.target.value)}
            className="rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-1 text-xs font-mono text-slate-800 dark:text-slate-100"
          />
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Until Date</span>
          <input
            type="date"
            aria-label="Until Date"
            value={reportTo}
            onChange={(e) => setReportTo(e.target.value)}
            className="rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-1 text-xs font-mono text-slate-800 dark:text-slate-100"
          />
          <div className="flex items-center gap-1 border-l border-slate-200 dark:border-slate-800 pl-2">
            <button
              type="button"
              onClick={() => applyDatePreset('today')}
              className="rounded border border-slate-200 dark:border-slate-800 px-2 py-1 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => applyDatePreset(7)}
              className="rounded border border-slate-200 dark:border-slate-800 px-2 py-1 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              7D
            </button>
            <button
              type="button"
              onClick={() => applyDatePreset(30)}
              className="rounded border border-slate-200 dark:border-slate-800 px-2 py-1 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              30D
            </button>
            {hasActiveFilter && (
              <button
                type="button"
                onClick={() => {
                  applyDatePreset('all');
                  handleBranchSelect('');
                }}
                title="Clear Branch and Date Filters"
                className="inline-flex items-center gap-1 rounded border border-red-200 dark:border-red-800/80 bg-red-50 dark:bg-red-950/50 px-2 py-1 text-[11px] font-medium text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/60"
              >
                <X className="w-3 h-3" /> Clear
              </button>
            )}
          </div>
        </div>
      </div>

      {reportTab === 'exports' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 no-print">
            <div className="flex flex-wrap gap-2">
              {(['sales', 'inventory', 'expenses', 'waste'] as const).map((rt) => (
                <button
                  key={rt}
                  onClick={() => setReportType(rt)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize border ${
                    reportType === rt ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 border-slate-900 dark:border-slate-100' : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200'
                  }`}
                >
                  {rt} Report
                </button>
              ))}
            </div>
            {hasActiveFilter && (
              <p className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                {selectedLocationName} · {reportRows.length} record(s)
                {(reportFrom || reportTo) ? ` · ${reportFrom || 'Beginning'} → ${reportTo || 'Latest'}` : ''}
              </p>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
            {reportRows.length === 0 ? (
              <p className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
                {hasActiveFilter
                  ? `No ${reportType} records matched ${selectedLocationName}${reportFrom || reportTo ? ' in the selected date range' : ''}.`
                  : 'No rows recorded for this report yet.'}
              </p>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
                  <tr>
                    {Object.keys(reportRows[0]).map((col) => (
                      <th key={col} className="p-3 font-medium uppercase">{col.replace(/_/g, ' ')}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {reportRows.map((row, idx) => (
                    <tr key={idx}>
                      {Object.values(row).map((val: any, cidx) => (
                        <td key={cidx} className="p-3 font-mono text-slate-800 dark:text-slate-100">
                          {typeof val === 'number' ? formatNum(val, 2) : String(val ?? '')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {reportTab === 'rbac' && governance && (
        <div className="space-y-3">
          {hasActiveFilter && (
            <p className="text-xs text-slate-500 dark:text-slate-400 font-mono text-right">
              {selectedLocationName} · {governance.roles.length} matching role(s)
              {(reportFrom || reportTo) ? ` · ${reportFrom || 'Beginning'} → ${reportTo || 'Latest'}` : ''}
            </p>
          )}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
            {governance.roles.length === 0 ? (
              <p className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
                No RBAC roles had assigned staff or audit activity for {selectedLocationName}
                {(reportFrom || reportTo) ? ' in the selected date range' : ''}.
              </p>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
                  <tr>
                    <th className="p-3 font-medium">Role</th>
                    <th className="p-3 font-medium">Assigned Staff ({selectedLocationName})</th>
                    <th className="p-3 font-medium text-right whitespace-nowrap">Audit Events</th>
                    <th className="p-3 font-medium">Granted Permissions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {governance.roles.map((r: any) => (
                    <tr key={r.id}>
                      <td className="p-3 font-semibold text-slate-900 dark:text-slate-50 whitespace-nowrap align-top">
                        <span className="inline-flex items-center gap-1.5">
                          <ShieldCheck className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" /> {r.name}
                        </span>
                        <p className="font-mono text-[11px] font-normal text-slate-500 dark:text-slate-400">{r.code}</p>
                      </td>
                      <td className="p-3 align-top min-w-[200px]">
                        {Array.isArray(r.assigned_users) && r.assigned_users.length > 0 ? (
                          <div className="space-y-1">
                            {r.assigned_users.map((u: any) => (
                              <div key={u.id} className="text-[11px] text-slate-700 dark:text-slate-200">
                                <span className="font-medium text-slate-900 dark:text-slate-50">{u.full_name}</span>
                                <span className="text-slate-500 dark:text-slate-400"> · {u.location_name}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="text-[11px] text-slate-500 dark:text-slate-400">No branch-assigned users</span>
                        )}
                      </td>
                      <td className="p-3 text-right font-mono tabular-nums font-semibold text-slate-800 dark:text-slate-100 align-top">
                        {r.activity_count ?? 0}
                      </td>
                      <td className="p-3 font-mono text-[11px] text-slate-600 dark:text-slate-300 align-top">{r.permissions.join(' · ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {reportTab === 'audit' && governance && (
        <div className="space-y-3">
          {hasActiveFilter && (
            <p className="text-xs text-slate-500 dark:text-slate-400 font-mono text-right">
              {selectedLocationName} · {governance.auditLogs.length} audit event(s)
              {(reportFrom || reportTo) ? ` · ${reportFrom || 'Beginning'} → ${reportTo || 'Latest'}` : ''}
            </p>
          )}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
            {governance.auditLogs.length === 0 ? (
              <p className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
                No audit logs matched {selectedLocationName}
                {(reportFrom || reportTo) ? ' in the selected date range' : ''}.
              </p>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
                  <tr>
                    <th className="p-3 font-medium">Timestamp</th>
                    <th className="p-3 font-medium">Branch</th>
                    <th className="p-3 font-medium">Actor</th>
                    <th className="p-3 font-medium">Action</th>
                    <th className="p-3 font-medium">Entity</th>
                    <th className="p-3 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {governance.auditLogs.map((log: any) => (
                    <tr key={log.id}>
                      <td className="p-3 font-mono text-slate-500 dark:text-slate-400 whitespace-nowrap">{String(log.created_at).slice(0, 19).replace('T', ' ')}</td>
                      <td className="p-3 text-slate-700 dark:text-slate-200 whitespace-nowrap">{log.location_name || 'HQ / Global'}</td>
                      <td className="p-3 font-medium text-slate-900 dark:text-slate-50">{log.user_name || 'System'}</td>
                      <td className="p-3 font-mono font-semibold text-slate-800 dark:text-slate-100">{log.action}</td>
                      <td className="p-3 text-slate-600 dark:text-slate-300">{log.entity_type} · {String(log.entity_id || '').slice(0, 8)}</td>
                      <td className="p-3 font-mono text-[11px] text-slate-500 dark:text-slate-400 truncate max-w-xs">{log.details}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
