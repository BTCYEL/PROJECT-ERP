import React, { useEffect, useRef, useState } from 'react';
import { Download, Printer, Plus, Clock, Truck, ShieldCheck, Calendar, MapPin, Pencil, Trash2, X, Upload, Users, Camera, Check, ChefHat, ScanFace, KeyRound } from 'lucide-react';
import { apiFetch, downloadCsv, formatNum, formatPHP } from '../lib/api.ts';
import { captureSnapshotDataUrl, extractFaceDescriptorFromDataUrl, parseDescriptorJson } from '../lib/faceRecognition.ts';
import { LocationRow } from '../types/erp.ts';
import { FaceAttendanceKioskModal } from './FaceAttendanceKioskModal.tsx';
import { AvatarBadge, resizeImageToDataUrl } from './SettingsUserControlModule.tsx';

interface Props {
  mode: 'fleet' | 'hr' | 'crm' | 'reports';
  locations?: LocationRow[];
  activeLocationId?: string;
  onLocationChange?: (locationId: string) => void;
  onLocationsChanged?: () => Promise<void> | void;
  quickAction?: { action: string; nonce: number } | null;
  onQuickActionHandled?: () => void;
}

export function OperationsHrCrmModule({
  mode,
  locations = [],
  activeLocationId = 'ALL',
  onLocationChange,
  onLocationsChanged,
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
  const [ruleCfg, setRuleCfg] = useState<any>(null);
  const [fleetModal, setFleetModal] = useState<'add' | 'edit' | null>(null);

  // Employee & Crew Photos + Face Biometrics Modal State (HR & PH Payroll)
  const [empModal, setEmpModal] = useState<{ mode: 'create' | 'edit'; id?: string } | null>(null);
  const [empForm, setEmpForm] = useState({
    employeeCode: '',
    fullName: '',
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
    }
  }, [mode, quickAction, hrData]);
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
    if (err && !fleetData) return <div className="p-4 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700 font-medium">{err}</div>;
    if (!fleetData) return <div className="h-64 rounded-xl border bg-white animate-pulse" />;
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
            <h1 className="font-display text-2xl font-semibold text-slate-900">Food Trucks &amp; Locations</h1>
            <p className="text-sm text-slate-500">Per-truck profitability, daily site dispatch, fuel consumption, and branch management</p>
          </div>
          <button
            type="button"
            onClick={openAddFleetModal}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" /> Add Truck / Location
          </button>
        </div>
        {msg && <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 font-medium">{msg}</div>}
        {err && <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">{err}</div>}

        <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/60 flex items-center justify-between">
            <h2 className="font-display text-xs font-semibold uppercase tracking-wide text-slate-600">Food Truck Fleet Performance</h2>
            <span className="text-[11px] font-mono text-slate-500">{visibleFleetTrucks.length} truck(s)</span>
          </div>
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr>
                <th className="p-3 font-medium">Truck / Plate</th>
                <th className="p-3 font-medium">Current Site &amp; Location</th>
                <th className="p-3 font-medium">Status</th>
                <th className="p-3 font-medium">KDS</th>
                <th className="p-3 font-medium text-right">Odometer</th>
                <th className="p-3 font-medium text-right">Total Sales</th>
                <th className="p-3 font-medium text-right">COGS</th>
                <th className="p-3 font-medium text-right">Expenses</th>
                <th className="p-3 font-medium text-right">Net Contribution</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visibleFleetTrucks.length === 0 ? (
                <tr>
                  <td colSpan={9} className="p-6 text-center text-xs text-slate-400">
                    {isLocFiltered
                      ? 'Selected location is a Commissary / non-truck branch.'
                      : 'No active food trucks yet. Click “Add Truck / Location” to register one.'}
                  </td>
                </tr>
              ) : (
                visibleFleetTrucks.map((t: any) => {
                  const net = t.total_sales - t.total_cogs - t.total_expenses;
                  const truckKdsOn = t.kds_enabled !== 0;
                  return (
                    <tr key={t.id}>
                      <td className="p-3">
                        <p className="font-semibold text-slate-900 flex items-center gap-1.5">
                          <Truck className="w-3.5 h-3.5 text-slate-500 shrink-0" /> {t.location_name}
                        </p>
                        <p className="text-[11px] font-mono text-slate-500">
                          {t.location_code ? `${t.location_code} · ` : ''}{t.plate_number} · {t.make_model}
                        </p>
                      </td>
                      <td className="p-3 text-slate-700">
                        <p className="font-medium text-slate-800">{t.current_site || 'Unassigned'}</p>
                        {t.location_address && <p className="text-[11px] text-slate-500">{t.location_address}</p>}
                      </td>
                      <td className="p-3">
                        <span
                          className={`inline-block rounded px-2 py-0.5 text-[11px] font-semibold ${
                            t.status === 'ACTIVE'
                              ? 'bg-emerald-50 text-emerald-700'
                              : t.status === 'MAINTENANCE'
                                ? 'bg-amber-50 text-amber-700'
                                : 'bg-slate-100 text-slate-600'
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
                              ? 'bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100'
                              : 'bg-slate-100 border-slate-200 text-slate-600 hover:bg-slate-200'
                          }`}
                          title="Click to enable or disable KDS for this truck"
                        >
                          <ChefHat className="w-3 h-3" />
                          {truckKdsOn ? 'KDS On' : 'KDS Off'}
                        </button>
                      </td>
                      <td className="p-3 text-right font-mono tabular-nums">{Number(t.odometer_km || 0).toLocaleString()} km</td>
                      <td className="p-3 text-right font-mono tabular-nums">{formatPHP(t.total_sales)}</td>
                      <td className="p-3 text-right font-mono tabular-nums">{formatPHP(t.total_cogs)}</td>
                      <td className="p-3 text-right font-mono tabular-nums">{formatPHP(t.total_expenses)}</td>
                      <td className={`p-3 text-right font-mono tabular-nums font-bold ${net >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                        {formatPHP(net)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/60 flex items-center justify-between">
            <h2 className="font-display text-xs font-semibold uppercase tracking-wide text-slate-600">All Active Branches &amp; Commissary Locations</h2>
            <span className="text-[11px] font-mono text-slate-500">{fleetLocations.length} location(s)</span>
          </div>
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr>
                <th className="p-3 font-medium">Code</th>
                <th className="p-3 font-medium">Location / Truck Name</th>
                <th className="p-3 font-medium">Type</th>
                <th className="p-3 font-medium">Address / Base Location</th>
                <th className="p-3 font-medium">KDS Setting</th>
                <th className="p-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {fleetLocations.map((loc: any) => {
                const locKdsOn = loc.kds_enabled !== undefined ? Boolean(loc.kds_enabled) : loc.type !== 'COMMISSARY';
                return (
                  <tr key={loc.id}>
                    <td className="p-3 font-mono text-slate-600 whitespace-nowrap">{loc.code}</td>
                    <td className="p-3 font-semibold text-slate-900">{loc.name}</td>
                    <td className="p-3 text-slate-600">{loc.type === 'COMMISSARY' ? 'Commissary' : 'Food Truck'}</td>
                    <td className="p-3 text-slate-600">{loc.address || '—'}</td>
                    <td className="p-3">
                      <button
                        type="button"
                        disabled={togglingKdsId === loc.id}
                        onClick={() => handleToggleLocationKds(loc.id, loc.name, !locKdsOn)}
                        className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-colors whitespace-nowrap disabled:opacity-50 ${
                          locKdsOn
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                            : 'border-slate-200 bg-slate-100 text-slate-600 hover:bg-slate-200'
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
                        className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                      >
                        <Pencil className="w-3 h-3" /> Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteLocTarget(loc)}
                        className="inline-flex items-center gap-1 rounded border border-red-200 px-2 py-1 text-[11px] font-medium text-red-700 hover:bg-red-50"
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
            className="rounded-xl border border-slate-200 bg-white p-5 space-y-3"
          >
            <h2 className="font-display text-sm font-semibold text-slate-900">Assign Daily Truck Site</h2>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Food Truck</label>
              <select
                value={siteForm.truckId}
                onChange={(e) => setSiteForm(buildSiteFormForTruck(e.target.value, fleetData))}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
              >
                {fleetData.trucks.map((t: any) => <option key={t.id} value={t.id}>{t.location_name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Pop-up / Park Site Name *</label>
              <input required placeholder="e.g. Salcedo Weekend Market" value={siteForm.siteName} onChange={(e) => setSiteForm({ ...siteForm, siteName: e.target.value })} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Shift Notes</label>
              <input placeholder="Optional shift instructions or parking slot" value={siteForm.shiftNotes} onChange={(e) => setSiteForm({ ...siteForm, shiftNotes: e.target.value })} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs" />
            </div>
            <button type="submit" disabled={fleetData.trucks.length === 0} className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">Save Site Assignment</button>
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
            className="rounded-xl border border-slate-200 bg-white p-5 space-y-3"
          >
            <h2 className="font-display text-sm font-semibold text-slate-900">Log Fuel Fill-up (Auto-Posts Expense)</h2>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Food Truck</label>
              <select value={fuelForm.truckId} onChange={(e) => setFuelForm({ ...fuelForm, truckId: e.target.value })} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs">
                {fleetData.trucks.map((t: any) => <option key={t.id} value={t.id}>{t.location_name}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-3 gap-2.5">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Fuel (Liters)</label>
                <input type="number" step="0.1" placeholder="Liters" value={fuelForm.liters} onChange={(e) => setFuelForm({ ...fuelForm, liters: e.target.value })} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Total Cost (PHP)</label>
                <input type="number" step="0.01" placeholder="Cost (PHP)" value={fuelForm.totalCost} onChange={(e) => setFuelForm({ ...fuelForm, totalCost: e.target.value })} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Odometer (km)</label>
                <input type="number" placeholder="Odometer" value={fuelForm.odometerKm} onChange={(e) => setFuelForm({ ...fuelForm, odometerKm: e.target.value })} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono" />
              </div>
            </div>
            <button type="submit" disabled={fleetData.trucks.length === 0} className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">Record Fuel Log</button>
          </form>
        </div>

        {/* Add / Edit Food Truck & Location Modal */}
        {fleetModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <form
              onSubmit={handleSaveFleet}
              className="w-full max-w-lg rounded-xl bg-white p-5 space-y-4 border border-slate-200 max-h-[90vh] overflow-y-auto"
            >
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <h3 className="font-display text-base font-semibold text-slate-900">
                  {fleetModal === 'add' ? 'Add Food Truck / Location' : 'Edit Food Truck / Location'}
                </h3>
                <button
                  type="button"
                  onClick={() => setFleetModal(null)}
                  className="p-1 rounded hover:bg-slate-100 text-slate-500"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {fleetModalErr && (
                <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">
                  {fleetModalErr}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div>
                  <label className="block font-medium text-slate-600 mb-1">Location Type</label>
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
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
                  >
                    <option value="FOOD_TRUCK">Food Truck</option>
                    <option value="COMMISSARY">Commissary / Branch</option>
                  </select>
                </div>

                <div>
                  <label className="block font-medium text-slate-600 mb-1">Location Code *</label>
                  <input
                    required
                    placeholder="e.g. TRK-03"
                    value={fleetForm.code}
                    onChange={(e) => setFleetForm({ ...fleetForm, code: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="block font-medium text-slate-600 mb-1">Truck / Location Name *</label>
                  <input
                    required
                    placeholder="e.g. Truck 03 — Rockwell Makati"
                    value={fleetForm.name}
                    onChange={(e) => setFleetForm({ ...fleetForm, name: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="block font-medium text-slate-600 mb-1">Address / Street Location</label>
                  <input
                    placeholder="e.g. Power Plant Mall Driveway, Makati"
                    value={fleetForm.address}
                    onChange={(e) => setFleetForm({ ...fleetForm, address: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
                  />
                </div>

                {fleetForm.type === 'FOOD_TRUCK' && (
                  <>
                    <div>
                      <label className="block font-medium text-slate-600 mb-1">Plate Number *</label>
                      <input
                        required
                        placeholder="e.g. NDC-5520"
                        value={fleetForm.plateNumber}
                        onChange={(e) => setFleetForm({ ...fleetForm, plateNumber: e.target.value })}
                        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-600 mb-1">Vehicle Make / Model *</label>
                      <input
                        required
                        placeholder="e.g. Isuzu Traviz Kitchen Rig"
                        value={fleetForm.makeModel}
                        onChange={(e) => setFleetForm({ ...fleetForm, makeModel: e.target.value })}
                        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-600 mb-1">Current Pop-up Site</label>
                      <input
                        placeholder="e.g. Rockwell Weekend Market"
                        value={fleetForm.currentSite}
                        onChange={(e) => setFleetForm({ ...fleetForm, currentSite: e.target.value })}
                        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block font-medium text-slate-600 mb-1">Odometer (km)</label>
                        <input
                          type="number"
                          min="0"
                          value={fleetForm.odometerKm}
                          onChange={(e) => setFleetForm({ ...fleetForm, odometerKm: e.target.value })}
                          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono"
                        />
                      </div>
                      <div>
                        <label className="block font-medium text-slate-600 mb-1">Status</label>
                        <select
                          value={fleetForm.status}
                          onChange={(e) => setFleetForm({ ...fleetForm, status: e.target.value as any })}
                          className="w-full rounded-lg border border-slate-200 px-2 py-2 text-xs"
                        >
                          <option value="ACTIVE">ACTIVE</option>
                          <option value="MAINTENANCE">MAINTENANCE</option>
                          <option value="INACTIVE">INACTIVE</option>
                        </select>
                      </div>
                    </div>
                  </>
                )}

                <div className="sm:col-span-2 rounded-lg border border-slate-200 bg-slate-50 p-3 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
                      <ChefHat className="w-3.5 h-3.5 text-slate-700" />
                      Kitchen Display System (KDS) Availability
                    </p>
                    <p className="text-[11px] text-slate-500 mt-0.5">
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
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                        fleetForm.kdsEnabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setFleetModal(null)}
                  className="px-4 py-2 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingFleet}
                  className="px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-50"
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
            <div className="w-full max-w-md rounded-xl bg-white p-5 space-y-4 border border-slate-200">
              <h3 className="font-display text-base font-semibold text-slate-900">
                Delete {deleteLocTarget.location_name || deleteLocTarget.name}?
              </h3>
              <p className="text-xs text-slate-600">
                This will remove <span className="font-semibold text-slate-900">{deleteLocTarget.location_name || deleteLocTarget.name}</span> from active Food Trucks &amp; Locations. If historical sales, inventory, or fleet logs exist, it will be archived safely so past reports remain accurate.
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDeleteLocTarget(null)}
                  className="px-4 py-2 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50"
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
    if (err && !hrData) return <div className="p-4 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700 font-medium">{err}</div>;
    if (!hrData) return <div className="h-64 rounded-xl border bg-white animate-pulse" />;

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
            <h1 className="font-display text-2xl font-semibold text-slate-900">Employees, Attendance &amp; PH Payroll</h1>
            <p className="text-sm text-slate-500">On-device face attendance scanner, crew biometrics, truck assignments, and Philippine statutory payroll</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowFaceKiosk(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap shrink-0 shadow-xs"
            >
              <ScanFace className="w-4 h-4" /> Face Attendance Kiosk
            </button>
            <button
              type="button"
              onClick={openCreateEmployee}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" /> Add Employee &amp; Crew
            </button>
            <label className="inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg border border-slate-200 bg-white text-[11px] font-medium text-slate-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={useAttendanceDays}
                onChange={(e) => setUseAttendanceDays(e.target.checked)}
                className="rounded border-slate-300 text-slate-900 focus:ring-slate-900"
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
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
            >
              Run Semi-Monthly Payroll
            </button>
          </div>
        </div>

        {/* HR & Crew Metrics */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-xl border border-slate-200 bg-white p-3.5">
            <p className="text-[11px] font-medium text-slate-500">Total Employees</p>
            <p className="font-display text-xl font-bold text-slate-900 mt-1 font-mono tabular-nums">{visibleEmployees.length}</p>
            <p className="text-[11px] text-slate-400 mt-0.5">{isHrLocFiltered ? 'At selected location' : 'All branches & trucks'}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-3.5">
            <p className="text-[11px] font-medium text-slate-500">Active &amp; On Shift</p>
            <p className="font-display text-xl font-bold text-emerald-600 mt-1 font-mono tabular-nums">
              {visibleEmployees.filter((e: any) => e.is_active !== 0).length}
              <span className="text-xs font-normal text-slate-500 ml-1.5">
                ({visibleEmployees.filter((e: any) => openShiftEmployeeIds.has(e.id)).length} clocked in)
              </span>
            </p>
            <p className="text-[11px] text-slate-400 mt-0.5">Live attendance status</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-3.5">
            <p className="text-[11px] font-medium text-slate-500">Face Biometrics Ready</p>
            <p className="font-display text-xl font-bold text-blue-600 mt-1 font-mono tabular-nums">
              {enrolledFaceCount} <span className="text-xs font-normal text-slate-400">/ {visibleEmployees.length}</span>
            </p>
            <p className="text-[11px] text-slate-400 mt-0.5">
              {photoCount} photo(s) · {visibleEmployees.length ? Math.round((enrolledFaceCount / visibleEmployees.length) * 100) : 0}% scanner-ready
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-3.5">
            <p className="text-[11px] font-medium text-slate-500">Location Scope</p>
            <p className="font-display text-sm font-semibold text-slate-800 mt-1 truncate">
              {isHrLocFiltered ? locations.find((l) => l.id === activeLocationId)?.name || 'Filtered Truck' : 'All Food Trucks & Commissary'}
            </p>
            <p className="text-[11px] text-slate-400 mt-0.5">{isHrLocFiltered ? 'Roster filtered' : 'Company-wide view'}</p>
          </div>
        </div>

        {msg && <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 font-medium">{msg}</div>}
        {err && <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">{err}</div>}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-7 rounded-xl border border-slate-200 bg-white overflow-x-auto">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/60 flex items-center justify-between">
              <div>
                <h2 className="font-display text-xs font-semibold uppercase tracking-wide text-slate-700">Employee Directory &amp; Crew Biometrics</h2>
                <p className="text-[11px] text-slate-500">Crew photos, on-device Face ID status, truck assignments, and shift punches</p>
              </div>
              <span className="text-[11px] font-mono text-slate-500">{visibleEmployees.length} employee(s)</span>
            </div>
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-100 text-slate-500 bg-slate-50">
                <tr>
                  <th className="p-3 font-medium">Crew Member &amp; Biometrics</th>
                  <th className="p-3 font-medium">Position · Truck</th>
                  <th className="p-3 font-medium">Status</th>
                  <th className="p-3 font-medium text-right">Daily Rate</th>
                  <th className="p-3 font-medium text-right">Actions &amp; Clock</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visibleEmployees.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-6 text-center text-xs text-slate-400">
                      No employees found for the selected truck / location. Click &ldquo;Add Employee &amp; Crew&rdquo; to register one.
                    </td>
                  </tr>
                ) : visibleEmployees.map((emp: any) => {
                  const hasFaceId = Boolean(parseDescriptorJson(emp.face_descriptor_json));
                  const onShift = openShiftEmployeeIds.has(emp.id);
                  return (
                    <tr key={emp.id} className="hover:bg-slate-50/50">
                      <td className="p-3 font-semibold text-slate-900">
                        <div className="flex items-center gap-2.5">
                          <div className="shrink-0">
                            <AvatarBadge name={emp.full_name} src={emp.avatar_url} size="sm" />
                          </div>
                          <div>
                            <p className="font-medium text-slate-900 leading-tight">{emp.full_name}</p>
                            <p className="text-[11px] font-normal text-slate-500">
                              <span className="font-mono">{emp.employee_code}</span>
                              <span aria-hidden="true"> · </span>
                              <span className={hasFaceId ? 'text-emerald-700 font-medium' : emp.avatar_url ? 'text-amber-700' : 'text-slate-400'}>
                                {hasFaceId ? 'Face ID Ready' : emp.avatar_url ? 'Photo Only' : 'No Face ID'}
                              </span>
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="p-3 text-slate-600">
                        <p className="font-medium text-slate-800">{emp.position}</p>
                        <p className="text-[11px] text-slate-500">{emp.location_name || 'Commissary HQ'}</p>
                      </td>
                      <td className="p-3">
                        <p className={`text-[11px] font-semibold ${emp.is_active !== 0 ? 'text-emerald-700' : 'text-slate-400'}`}>
                          {emp.is_active !== 0 ? 'Active' : 'Inactive'}
                        </p>
                        {onShift && (
                          <p className="text-[11px] text-blue-700 font-medium">On Shift</p>
                        )}
                      </td>
                      <td className="p-3 text-right font-mono tabular-nums text-slate-800">
                        {formatPHP(emp.base_rate)}
                        <span className="block text-[10px] text-slate-400 font-sans">{emp.pay_type || 'DAILY'}</span>
                      </td>
                      <td className="p-3 text-right whitespace-nowrap space-x-1.5">
                        <button
                          type="button"
                          onClick={() => openEditEmployee(emp)}
                          className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                          title="Edit profile, Face ID & PIN"
                        >
                          <Pencil className="w-3 h-3 text-slate-500" /> Edit / Face
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
                          className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-[11px] font-medium hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
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
                          className="rounded border border-slate-200 px-2 py-1 text-[11px] font-medium hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
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
            <div className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-5 space-y-3">
              <h2 className="font-display text-sm font-semibold text-slate-900">Configurable PH Statutory Rules</h2>
              <p className="text-xs text-slate-500">Update rates whenever DOLE / BIR / SSS / PhilHealth circulars change.</p>
              <div className="grid grid-cols-2 gap-2.5 text-xs">
                <div>
                  <label className="block font-medium text-slate-600 mb-1">SSS EE Rate %</label>
                  <input type="number" step="0.1" value={ruleCfg.sssEmployeeRatePct} onChange={(e) => setRuleCfg({ ...ruleCfg, sssEmployeeRatePct: Number(e.target.value) })} className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 font-mono" />
                </div>
                <div>
                  <label className="block font-medium text-slate-600 mb-1">PhilHealth EE %</label>
                  <input type="number" step="0.1" value={ruleCfg.philhealthEmployeeRatePct} onChange={(e) => setRuleCfg({ ...ruleCfg, philhealthEmployeeRatePct: Number(e.target.value) })} className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 font-mono" />
                </div>
                <div>
                  <label className="block font-medium text-slate-600 mb-1">Pag-IBIG Monthly (PHP)</label>
                  <input type="number" value={ruleCfg.pagibigFixedEmployeePhp} onChange={(e) => setRuleCfg({ ...ruleCfg, pagibigFixedEmployeePhp: Number(e.target.value) })} className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 font-mono" />
                </div>
                <div>
                  <label className="block font-medium text-slate-600 mb-1">Tax Exempt Ceiling / Mo</label>
                  <input type="number" value={ruleCfg.taxExemptMonthlyCeilingPhp} onChange={(e) => setRuleCfg({ ...ruleCfg, taxExemptMonthlyCeilingPhp: Number(e.target.value) })} className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 font-mono" />
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
                className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold hover:bg-slate-50"
              >
                Save Statutory Rules
              </button>
            </div>
          )}
        </div>

        {/* Attendance & Biometric Photo Audit Log */}
        <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/60 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-xs font-semibold uppercase tracking-wide text-slate-700">Attendance &amp; Biometric Punch Audit</h2>
              <p className="text-[11px] text-slate-500">Time In / Time Out log with face verification score, overtime computation, and photo snapshots</p>
            </div>
            <span className="text-[11px] font-mono text-slate-500">{visibleAttendance.length} punch record(s)</span>
          </div>
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-100 text-slate-500 bg-slate-50">
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
            <tbody className="divide-y divide-slate-100">
              {visibleAttendance.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-xs text-slate-400">
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
                  <tr key={att.id} className="hover:bg-slate-50/50">
                    <td className="p-3">
                      <p className="font-medium text-slate-900">{att.full_name || 'Unknown Employee'}</p>
                      <p className="text-[11px] font-mono text-slate-500">{att.employee_code || '—'}</p>
                    </td>
                    <td className="p-3 text-slate-600">{att.location_name || 'Commissary HQ'}</td>
                    <td className="p-3 font-mono text-slate-700 whitespace-nowrap">{formatPunchTime(att.clock_in)}</td>
                    <td className="p-3 font-mono whitespace-nowrap">
                      {att.clock_out ? (
                        <span className="text-slate-700">{formatPunchTime(att.clock_out)}</span>
                      ) : (
                        <span className="font-sans font-medium text-blue-700">On Shift</span>
                      )}
                    </td>
                    <td className="p-3 text-right font-mono tabular-nums text-slate-800 whitespace-nowrap">
                      {att.clock_out ? (
                        <>
                          {Number(att.worked_hours || 0).toFixed(2)}h
                          {Number(att.overtime_hours || 0) > 0 && (
                            <span className="text-amber-700 ml-1">({Number(att.overtime_hours).toFixed(2)}h OT)</span>
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
                            ? 'text-amber-700'
                            : att.status === 'ABSENT'
                              ? 'text-red-700'
                              : 'text-emerald-700'
                        }`}
                      >
                        {att.status}
                      </span>
                    </td>
                    <td className="p-3 text-slate-600 whitespace-nowrap">{methodLabel}</td>
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
                            className="group relative rounded border border-slate-200 overflow-hidden hover:ring-2 hover:ring-slate-900"
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
                            className="group relative rounded border border-slate-200 overflow-hidden hover:ring-2 hover:ring-slate-900"
                            title="View Time Out photo proof"
                          >
                            <img src={att.clock_out_photo} alt="Time out proof" className="w-7 h-7 object-cover" />
                          </button>
                        )}
                        {!att.clock_in_photo && !att.clock_out_photo && (
                          <span className="text-[11px] text-slate-400">—</span>
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
          <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
            <div className="p-4 border-b border-slate-200 text-xs font-semibold text-slate-700">
              Latest Payroll Run ({hrData.payrollRuns[0].period_start} to {hrData.payrollRuns[0].period_end})
            </div>
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-100 text-slate-500">
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
              <tbody className="divide-y divide-slate-100">
                {visiblePayrollItems.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-6 text-center text-xs text-slate-400">
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
                    <td className="p-3 text-right font-mono tabular-nums font-bold text-emerald-700">{formatPHP(pi.net_pay)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Employee & Crew Photo Modal */}
        {empModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl border border-slate-200 space-y-4 max-h-[92vh] overflow-y-auto">
              <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <div className="p-2 rounded-lg bg-emerald-50 text-emerald-700">
                    <Users className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="font-display text-base font-semibold text-slate-900">
                      {empModal.mode === 'create' ? 'Add Employee & Crew Member' : 'Edit Employee & Crew Photo'}
                    </h3>
                    <p className="text-xs text-slate-500">Manage employee identity, crew photo, assigned truck, and wage rate</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setEmpModal(null)}
                  className="p-1 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {empModalErr && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">
                  {empModalErr}
                </div>
              )}

              <form onSubmit={handleSaveEmployee} className="space-y-4">
                {/* Photo & Biometric Enrollment Section */}
                <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50/60 space-y-3">
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
                      <p className="text-xs font-semibold text-slate-900">Crew Photo &amp; On-Device Face ID</p>
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        Upload a clear front portrait or take a live webcam photo to enroll 128-D face recognition.
                      </p>
                      <div className="flex flex-wrap items-center gap-2 mt-2">
                        <button
                          type="button"
                          onClick={() => empFileRef.current?.click()}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-100"
                        >
                          <Upload className="w-3.5 h-3.5" /> {empForm.avatarUrl ? 'Change Photo' : 'Upload Photo'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowEmpCam((prev) => !prev)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-100"
                        >
                          <Camera className="w-3.5 h-3.5" /> {showEmpCam ? 'Close Camera' : 'Take Live Photo'}
                        </button>
                        {empForm.avatarUrl && !empForm.faceDescriptorJson && !extractingFace && (
                          <button
                            type="button"
                            onClick={() => enrollFaceFromDataUrl(empForm.avatarUrl)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-blue-200 bg-blue-50 text-xs font-medium text-blue-700 hover:bg-blue-100"
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
                            className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-red-600 hover:bg-red-50"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                      <input
                        ref={empFileRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => handleEmpPhotoUpload(e.target.files?.[0])}
                      />
                    </div>
                  </div>

                  {showEmpCam && (
                    <div className="rounded-lg border border-slate-200 bg-slate-950 p-2.5 space-y-2">
                      {empCamErr ? (
                        <p className="text-xs text-amber-300 text-center py-4">{empCamErr}</p>
                      ) : (
                        <>
                          <video
                            ref={empVideoRef}
                            muted
                            playsInline
                            className="w-full max-h-52 rounded object-cover -scale-x-100 bg-slate-900"
                          />
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setShowEmpCam(false)}
                              className="px-3 py-1.5 rounded-md border border-slate-600 text-xs text-slate-200 hover:bg-slate-800"
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
                    <p className="text-[11px] text-slate-600 font-medium">Analyzing facial landmarks on-device...</p>
                  )}
                  {!extractingFace && faceEnrollStatus && (
                    <p className={`text-[11px] font-medium ${faceEnrollStatus.ok ? 'text-emerald-700' : 'text-amber-700'}`}>
                      {faceEnrollStatus.text}
                    </p>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Employee Code *</label>
                    <input
                      required
                      placeholder="e.g. EMP-001"
                      value={empForm.employeeCode}
                      onChange={(e) => setEmpForm({ ...empForm, employeeCode: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                    />
                  </div>

                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Full Name *</label>
                    <input
                      required
                      placeholder="e.g. Juan dela Cruz"
                      value={empForm.fullName}
                      onChange={(e) => setEmpForm({ ...empForm, fullName: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2"
                    />
                  </div>

                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Department</label>
                    <select
                      value={empForm.department}
                      onChange={(e) => setEmpForm({ ...empForm, department: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2"
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
                    <label className="block font-medium text-slate-700 mb-1">Position / Job Title *</label>
                    <input
                      required
                      placeholder="e.g. Pitmaster / Head Griller"
                      value={empForm.position}
                      onChange={(e) => setEmpForm({ ...empForm, position: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2"
                    />
                  </div>

                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Assigned Truck / Location</label>
                    <select
                      value={empForm.locationId}
                      onChange={(e) => setEmpForm({ ...empForm, locationId: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2"
                    >
                      <option value="">Unassigned / Commissary HQ</option>
                      {locations.map((loc) => (
                        <option key={loc.id} value={loc.id}>
                          {loc.name} {loc.code ? `(${loc.code})` : ''} — {loc.type === 'COMMISSARY' ? 'Commissary' : 'Food Truck'}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">Pay Type</label>
                      <select
                        value={empForm.payType}
                        onChange={(e) => setEmpForm({ ...empForm, payType: e.target.value as any })}
                        className="w-full rounded-lg border border-slate-200 px-2 py-2"
                      >
                        <option value="DAILY">Daily</option>
                        <option value="HOURLY">Hourly</option>
                        <option value="MONTHLY">Monthly</option>
                      </select>
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">Rate (PHP) *</label>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        required
                        value={empForm.baseRate}
                        onChange={(e) => setEmpForm({ ...empForm, baseRate: e.target.value })}
                        className="w-full rounded-lg border border-slate-200 px-2.5 py-2 font-mono text-right"
                      />
                    </div>
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block font-medium text-slate-700 mb-1 flex items-center gap-1.5">
                      <KeyRound className="w-3.5 h-3.5 text-slate-500" />
                      Attendance Fallback PIN (Optional, 4–12 digits)
                    </label>
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={12}
                      placeholder="e.g. 1234 (used when grill smoke or night lighting blocks face scan)"
                      value={empForm.attendancePin}
                      onChange={(e) => setEmpForm({ ...empForm, attendancePin: e.target.value.replace(/\s+/g, '') })}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono tracking-widest"
                    />
                  </div>
                </div>

                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="checkbox"
                    id="empIsActive"
                    checked={empForm.isActive}
                    onChange={(e) => setEmpForm({ ...empForm, isActive: e.target.checked })}
                    className="rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                  />
                  <label htmlFor="empIsActive" className="text-xs font-medium text-slate-700 cursor-pointer">
                    Active crew member (eligible for scheduling, payroll, and site clock-in)
                  </label>
                </div>

                <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => {
                      setShowEmpCam(false);
                      setEmpModal(null);
                    }}
                    className="px-4 py-2 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={savingEmp || extractingFace}
                    className="px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-50"
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
              className="w-full max-w-sm rounded-xl bg-white border border-slate-200 p-4 space-y-3 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">{attendancePhotoPreview.title}</h3>
                  <p className="text-xs text-slate-500">{attendancePhotoPreview.subtitle}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setAttendancePhotoPreview(null)}
                  className="p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <img
                src={attendancePhotoPreview.src}
                alt={attendancePhotoPreview.title}
                className="w-full rounded-lg border border-slate-200 object-cover"
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
              className="w-full max-w-md rounded-xl bg-white p-5 border border-slate-200 shadow-2xl space-y-4"
            >
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div>
                  <h3 className="font-display text-base font-semibold text-slate-900">Start New Payroll Run</h3>
                  <p className="text-xs text-slate-500">Compute gross pay, SSS, PhilHealth, Pag-IBIG &amp; net pay</p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowPayrollModal(false)}
                  className="p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {payrollModalErr && (
                <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">
                  {payrollModalErr}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Period Start *</label>
                  <input
                    type="date"
                    required
                    value={payrollForm.periodStart}
                    onChange={(e) => setPayrollForm((f) => ({ ...f, periodStart: e.target.value }))}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Period End *</label>
                  <input
                    type="date"
                    required
                    value={payrollForm.periodEnd}
                    onChange={(e) => setPayrollForm((f) => ({ ...f, periodEnd: e.target.value }))}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                  />
                </div>
                <div className="col-span-2">
                  <label className="flex items-center gap-2 cursor-pointer select-none py-1">
                    <input
                      type="checkbox"
                      checked={payrollForm.useAttendanceDays}
                      onChange={(e) => setPayrollForm((f) => ({ ...f, useAttendanceDays: e.target.checked }))}
                      className="rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                    />
                    <span className="font-medium text-slate-700">Calculate worked days from logged Attendance punches</span>
                  </label>
                </div>
                {!payrollForm.useAttendanceDays && (
                  <div className="col-span-2">
                    <label className="block font-medium text-slate-700 mb-1">Fixed Days per Employee</label>
                    <input
                      type="number"
                      min="1"
                      max="31"
                      required
                      value={payrollForm.daysPerEmployee}
                      onChange={(e) => setPayrollForm((f) => ({ ...f, daysPerEmployee: e.target.value }))}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 font-mono"
                    />
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowPayrollModal(false)}
                  className="px-4 py-2 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={runningPayroll}
                  className="px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-50"
                >
                  {runningPayroll ? 'Posting Payroll...' : 'Post Payroll Run'}
                </button>
              </div>
            </form>
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
    const visibleCustomers = isCrmLocFiltered
      ? customers.filter((c) => c.location_id === activeLocationId)
      : customers;

    return (
      <div className="space-y-6">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900">Customer CRM &amp; Loyalty</h1>
          <p className="text-sm text-slate-500">Repeat customer profiles, registration branch &amp; date, purchase frequency, and loyalty points</p>
        </div>
        {msg && <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 font-medium">{msg}</div>}
        {err && <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">{err}</div>}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
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
            className="lg:col-span-4 rounded-xl border border-slate-200 bg-white p-5 space-y-3"
          >
            <h2 className="font-display text-sm font-semibold text-slate-900 flex items-center gap-1.5">
              <Plus className="w-4 h-4" /> Register Customer
            </h2>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Full Name *</label>
              <input required placeholder="e.g. Marco Reyes" value={custForm.fullName} onChange={(e) => setCustForm({ ...custForm, fullName: e.target.value })} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Registration Date *</label>
                <input
                  type="date"
                  required
                  value={custForm.registeredAt}
                  onChange={(e) => setCustForm({ ...custForm, registeredAt: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Registered Truck / Location *</label>
                <select
                  required
                  value={custForm.locationId}
                  onChange={(e) => setCustForm({ ...custForm, locationId: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
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
              <label className="block text-xs font-medium text-slate-600 mb-1">Mobile Number</label>
              <input placeholder="e.g. 0917 555 0192" value={custForm.phone} onChange={(e) => setCustForm({ ...custForm, phone: e.target.value })} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Email Address</label>
              <input type="email" placeholder="e.g. marco@email.com" value={custForm.email} onChange={(e) => setCustForm({ ...custForm, email: e.target.value })} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Food Preferences / Allergies</label>
              <input placeholder="e.g. Extra spicy, no peanuts" value={custForm.preferences} onChange={(e) => setCustForm({ ...custForm, preferences: e.target.value })} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs" />
            </div>
            <button type="submit" className="w-full rounded-lg bg-slate-900 py-2 text-xs font-semibold text-white">Save Profile</button>
          </form>

          <div className="lg:col-span-8 rounded-xl border border-slate-200 bg-white overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                <tr>
                  <th className="p-3 font-medium">Customer</th>
                  <th className="p-3 font-medium">Registered</th>
                  <th className="p-3 font-medium">Tier</th>
                  <th className="p-3 font-medium text-right">Points</th>
                  <th className="p-3 font-medium text-right">Orders</th>
                  <th className="p-3 font-medium text-right">Lifetime Spend</th>
                  <th className="p-3 font-medium">Preferences</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visibleCustomers.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-6 text-center text-xs text-slate-400">
                      No customers registered for the selected truck / location.
                    </td>
                  </tr>
                ) : visibleCustomers.map((c) => (
                  <tr key={c.id}>
                    <td className="p-3 font-semibold text-slate-900">
                      {c.full_name}
                      <p className="font-normal text-slate-500">{c.phone || c.email || '—'}</p>
                    </td>
                    <td className="p-3 text-slate-600 whitespace-nowrap">
                      <p className="font-mono text-slate-800">{c.registered_at || '—'}</p>
                      <p className="text-[11px] text-slate-500">{c.location_name || 'Unassigned'}</p>
                    </td>
                    <td className="p-3 font-semibold text-amber-700">{c.tier}</td>
                    <td className="p-3 text-right font-mono tabular-nums">{c.loyalty_points}</td>
                    <td className="p-3 text-right font-mono tabular-nums">{c.total_orders}</td>
                    <td className="p-3 text-right font-mono tabular-nums font-semibold">{formatPHP(c.lifetime_spend)}</td>
                    <td className="p-3 text-slate-600">{c.preferences}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
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
          <h1 className="font-display text-2xl font-semibold text-slate-900">Reports, Exports &amp; RBAC Audit</h1>
          <p className="text-sm text-slate-500">Exportable operational reports, 10-role permission matrix, and immutable audit trail</p>
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
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium hover:bg-slate-50"
          >
            <Download className="w-3.5 h-3.5" /> Download CSV / Excel
          </button>
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white"
          >
            <Printer className="w-3.5 h-3.5" /> Print / Save PDF
          </button>
        </div>
      </div>

      {err && <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">{err}</div>}

      <div className="flex flex-wrap items-center justify-between gap-3 no-print">
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg border border-slate-200 w-fit">
          {([
            { id: 'exports', label: 'Data Reports' },
            { id: 'rbac', label: '10-Role RBAC Matrix' },
            { id: 'audit', label: 'Immutable Audit Logs' },
          ] as const).map((t) => (
            <button
              key={t.id}
              onClick={() => setReportTab(t.id)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 ${
                reportTab === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600">
            <MapPin className="w-3.5 h-3.5 text-slate-400" />
            Branch
          </span>
          <select
            aria-label="Filter by Branch"
            value={locationFilter}
            onChange={(e) => handleBranchSelect(e.target.value)}
            className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-800"
          >
            <option value="">All Trucks &amp; Commissary</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>

          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 border-l border-slate-200 pl-2">
            <Calendar className="w-3.5 h-3.5 text-slate-400" />
            Date From
          </span>
          <input
            type="date"
            aria-label="Date From"
            value={reportFrom}
            onChange={(e) => setReportFrom(e.target.value)}
            className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-mono text-slate-800"
          />
          <span className="text-xs font-medium text-slate-600">Until Date</span>
          <input
            type="date"
            aria-label="Until Date"
            value={reportTo}
            onChange={(e) => setReportTo(e.target.value)}
            className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-mono text-slate-800"
          />
          <div className="flex items-center gap-1 border-l border-slate-200 pl-2">
            <button
              type="button"
              onClick={() => applyDatePreset('today')}
              className="rounded border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => applyDatePreset(7)}
              className="rounded border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
            >
              7D
            </button>
            <button
              type="button"
              onClick={() => applyDatePreset(30)}
              className="rounded border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
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
                className="inline-flex items-center gap-1 rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-medium text-red-700 hover:bg-red-100"
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
                    reportType === rt ? 'bg-slate-900 text-white border-slate-900' : 'bg-white border-slate-200 text-slate-700'
                  }`}
                >
                  {rt} Report
                </button>
              ))}
            </div>
            {hasActiveFilter && (
              <p className="text-xs text-slate-500 font-mono">
                {selectedLocationName} · {reportRows.length} record(s)
                {(reportFrom || reportTo) ? ` · ${reportFrom || 'Beginning'} → ${reportTo || 'Latest'}` : ''}
              </p>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
            {reportRows.length === 0 ? (
              <p className="p-8 text-center text-xs text-slate-400">
                {hasActiveFilter
                  ? `No ${reportType} records matched ${selectedLocationName}${reportFrom || reportTo ? ' in the selected date range' : ''}.`
                  : 'No rows recorded for this report yet.'}
              </p>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                  <tr>
                    {Object.keys(reportRows[0]).map((col) => (
                      <th key={col} className="p-3 font-medium uppercase">{col.replace(/_/g, ' ')}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {reportRows.map((row, idx) => (
                    <tr key={idx}>
                      {Object.values(row).map((val: any, cidx) => (
                        <td key={cidx} className="p-3 font-mono text-slate-800">
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
            <p className="text-xs text-slate-500 font-mono text-right">
              {selectedLocationName} · {governance.roles.length} matching role(s)
              {(reportFrom || reportTo) ? ` · ${reportFrom || 'Beginning'} → ${reportTo || 'Latest'}` : ''}
            </p>
          )}
          <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
            {governance.roles.length === 0 ? (
              <p className="p-8 text-center text-xs text-slate-400">
                No RBAC roles had assigned staff or audit activity for {selectedLocationName}
                {(reportFrom || reportTo) ? ' in the selected date range' : ''}.
              </p>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                  <tr>
                    <th className="p-3 font-medium">Role</th>
                    <th className="p-3 font-medium">Assigned Staff ({selectedLocationName})</th>
                    <th className="p-3 font-medium text-right whitespace-nowrap">Audit Events</th>
                    <th className="p-3 font-medium">Granted Permissions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {governance.roles.map((r: any) => (
                    <tr key={r.id}>
                      <td className="p-3 font-semibold text-slate-900 whitespace-nowrap align-top">
                        <span className="inline-flex items-center gap-1.5">
                          <ShieldCheck className="w-3.5 h-3.5 text-slate-500" /> {r.name}
                        </span>
                        <p className="font-mono text-[11px] font-normal text-slate-500">{r.code}</p>
                      </td>
                      <td className="p-3 align-top min-w-[200px]">
                        {Array.isArray(r.assigned_users) && r.assigned_users.length > 0 ? (
                          <div className="space-y-1">
                            {r.assigned_users.map((u: any) => (
                              <div key={u.id} className="text-[11px] text-slate-700">
                                <span className="font-medium text-slate-900">{u.full_name}</span>
                                <span className="text-slate-400"> · {u.location_name}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="text-[11px] text-slate-400">No branch-assigned users</span>
                        )}
                      </td>
                      <td className="p-3 text-right font-mono tabular-nums font-semibold text-slate-800 align-top">
                        {r.activity_count ?? 0}
                      </td>
                      <td className="p-3 font-mono text-[11px] text-slate-600 align-top">{r.permissions.join(' · ')}</td>
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
            <p className="text-xs text-slate-500 font-mono text-right">
              {selectedLocationName} · {governance.auditLogs.length} audit event(s)
              {(reportFrom || reportTo) ? ` · ${reportFrom || 'Beginning'} → ${reportTo || 'Latest'}` : ''}
            </p>
          )}
          <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
            {governance.auditLogs.length === 0 ? (
              <p className="p-8 text-center text-xs text-slate-400">
                No audit logs matched {selectedLocationName}
                {(reportFrom || reportTo) ? ' in the selected date range' : ''}.
              </p>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                  <tr>
                    <th className="p-3 font-medium">Timestamp</th>
                    <th className="p-3 font-medium">Branch</th>
                    <th className="p-3 font-medium">Actor</th>
                    <th className="p-3 font-medium">Action</th>
                    <th className="p-3 font-medium">Entity</th>
                    <th className="p-3 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {governance.auditLogs.map((log: any) => (
                    <tr key={log.id}>
                      <td className="p-3 font-mono text-slate-500 whitespace-nowrap">{String(log.created_at).slice(0, 19).replace('T', ' ')}</td>
                      <td className="p-3 text-slate-700 whitespace-nowrap">{log.location_name || 'HQ / Global'}</td>
                      <td className="p-3 font-medium text-slate-900">{log.user_name || 'System'}</td>
                      <td className="p-3 font-mono font-semibold text-slate-800">{log.action}</td>
                      <td className="p-3 text-slate-600">{log.entity_type} · {String(log.entity_id || '').slice(0, 8)}</td>
                      <td className="p-3 font-mono text-[11px] text-slate-500 truncate max-w-xs">{log.details}</td>
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
