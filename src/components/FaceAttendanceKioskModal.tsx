import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  Clock,
  KeyRound,
  RefreshCw,
  ScanFace,
  ShieldCheck,
  Sparkles,
  UserCheck,
  X,
} from 'lucide-react';
import { apiFetch } from '../lib/api.ts';
import {
  captureSnapshotDataUrl,
  detectLiveFace,
  extractFaceDescriptorFromDataUrl,
  loadFaceModels,
  matchEmployeeFace,
  parseDescriptorJson,
} from '../lib/faceRecognition.ts';
import { LocationRow } from '../types/erp.ts';
import { AvatarBadge } from './SettingsUserControlModule.tsx';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  employees: any[];
  attendance: any[];
  locations: LocationRow[];
  defaultLocationId?: string;
  canManageEmployees?: boolean;
  onPunchSuccess: () => Promise<void>;
  onAutoEnrollSuccess: () => Promise<void>;
}

export function FaceAttendanceKioskModal({
  isOpen,
  onClose,
  employees,
  attendance,
  locations,
  defaultLocationId = 'ALL',
  canManageEmployees = true,
  onPunchSuccess,
  onAutoEnrollSuccess,
}: Props) {
  const [kioskMode, setKioskMode] = useState<'FACE' | 'PIN'>('FACE');
  const [kioskLocationId, setKioskLocationId] = useState<string>('');
  const [shiftStartTime, setShiftStartTime] = useState<string>('09:00');
  const [requireLiveness, setRequireLiveness] = useState<boolean>(true);

  const [modelsReady, setModelsReady] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [cameraActive, setCameraActive] = useState(false);

  const [scanStatus, setScanStatus] = useState<string>('Initializing camera & on-device face recognition...');
  const [matchedCandidate, setMatchedCandidate] = useState<{
    employee: any;
    confidencePct: number;
    livenessProgress: number;
    livenessPassed: boolean;
    nextAction: 'CLOCK_IN' | 'CLOCK_OUT';
  } | null>(null);
  const [lastPunch, setLastPunch] = useState<{
    action: 'CLOCK_IN' | 'CLOCK_OUT';
    employeeName: string;
    employeeCode: string;
    timestamp: string;
    workedHours?: number;
    overtimeHours?: number;
    confidencePct?: number | null;
    method: string;
    status: string;
    snapshotPhoto?: string | null;
    avatarUrl?: string | null;
  } | null>(null);
  const [submittingPunch, setSubmittingPunch] = useState(false);

  // PIN Fallback State
  const [pinEmployeeId, setPinEmployeeId] = useState<string>('');
  const [pinCode, setPinCode] = useState<string>('');
  const [pinErr, setPinErr] = useState<string>('');

  // Batch auto-enroll existing crew photos
  const [enrollingBatch, setEnrollingBatch] = useState(false);
  const [enrollProgressMsg, setEnrollProgressMsg] = useState('');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const cooldownMapRef = useRef<Map<string, number>>(new Map());
  const livenessRef = useRef<{
    empId: string | null;
    earMin: number;
    earMax: number;
    yawMin: number;
    yawMax: number;
    frames: number;
  }>({ empId: null, earMin: 1, earMax: 0, yawMin: 1, yawMax: 0, frames: 0 });
  const submittingRef = useRef(false);

  const activeEmployees = useMemo(
    () => (employees || []).filter((e) => e.is_active !== 0),
    [employees],
  );

  const enrolledEmployees = useMemo(
    () => activeEmployees.filter((e) => Boolean(parseDescriptorJson(e.face_descriptor_json))),
    [activeEmployees],
  );

  const pendingAutoEnroll = useMemo(
    () => activeEmployees.filter((e) => Boolean(e.avatar_url) && !parseDescriptorJson(e.face_descriptor_json)),
    [activeEmployees],
  );

  const openShiftByEmployee = useMemo(() => {
    const map = new Map<string, any>();
    for (const log of attendance || []) {
      if (!log.clock_out && !map.has(log.employee_id)) {
        map.set(log.employee_id, log);
      }
    }
    return map;
  }, [attendance]);

  useEffect(() => {
    if (!isOpen) return;
    const initialLoc =
      defaultLocationId && defaultLocationId !== 'ALL' && locations.some((l) => l.id === defaultLocationId)
        ? defaultLocationId
        : locations[0]?.id || '';
    setKioskLocationId(initialLoc);
    if (!pinEmployeeId && activeEmployees[0]) {
      setPinEmployeeId(activeEmployees[0].id);
    }
  }, [isOpen, defaultLocationId, locations, activeEmployees]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const computeClockInStatus = () => {
    const [hh, mm] = shiftStartTime.split(':').map((n) => Number(n));
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return 'PRESENT';
    const now = new Date();
    const graceCutoff = hh * 60 + mm + 15; // 15-min grace period
    const currentMin = now.getHours() * 60 + now.getMinutes();
    return currentMin > graceCutoff ? 'LATE' : 'PRESENT';
  };

  const executeClockPunch = async (params: {
    employee: any;
    verificationMethod: 'FACE_SCAN' | 'PIN_FALLBACK';
    confidencePct?: number | null;
    snapshotPhoto?: string | null;
    pinCode?: string;
  }) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmittingPunch(true);
    setPinErr('');
    try {
      const hasOpen = openShiftByEmployee.has(params.employee.id);
      const nextAction = hasOpen ? 'CLOCK_OUT' : 'CLOCK_IN';
      const status = nextAction === 'CLOCK_IN' ? computeClockInStatus() : undefined;

      const res = await apiFetch<any>('/hr/attendance/clock', {
        method: 'POST',
        body: JSON.stringify({
          employeeId: params.employee.id,
          action: nextAction,
          locationId: kioskLocationId || params.employee.location_id || null,
          verificationMethod: params.verificationMethod,
          matchConfidence: params.confidencePct ?? null,
          snapshotPhoto: params.snapshotPhoto || null,
          pinCode: params.pinCode,
          status,
        }),
      });

      cooldownMapRef.current.set(params.employee.id, Date.now() + 8000);
      livenessRef.current = { empId: null, earMin: 1, earMax: 0, yawMin: 1, yawMax: 0, frames: 0 };

      setLastPunch({
        action: res.action,
        employeeName: params.employee.full_name,
        employeeCode: params.employee.employee_code,
        timestamp: res.action === 'CLOCK_OUT' ? res.clockOut : res.clockIn,
        workedHours: res.workedHours,
        overtimeHours: res.overtimeHours,
        confidencePct: params.confidencePct ?? null,
        method: params.verificationMethod,
        status: res.status || 'PRESENT',
        snapshotPhoto: params.snapshotPhoto || null,
        avatarUrl: params.employee.avatar_url || null,
      });
      setMatchedCandidate(null);
      setPinCode('');
      await onPunchSuccess();
    } catch (e: any) {
      if (params.verificationMethod === 'PIN_FALLBACK') {
        setPinErr(e.message || 'Unable to process PIN punch');
      } else {
        setScanStatus(e.message || 'Unable to log attendance');
        cooldownMapRef.current.set(params.employee.id, Date.now() + 4000);
      }
    } finally {
      submittingRef.current = false;
      setSubmittingPunch(false);
    }
  };

  // Start / Stop webcam + face models when modal opens
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    const startCameraAndModels = async () => {
      setCameraError('');
      setModelsReady(false);
      setCameraActive(false);
      setMatchedCandidate(null);
      setScanStatus('Loading on-device biometric face models...');

      try {
        await loadFaceModels();
        if (cancelled) return;
        setModelsReady(true);

        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Camera access is not supported in this browser. Switch to PIN Fallback mode.');
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        setCameraActive(true);
        setScanStatus(
          enrolledEmployees.length > 0
            ? 'Position your face in front of the camera to Time In or Time Out'
            : 'No crew faces enrolled yet — click "Auto-Enroll Existing Photos" or edit an employee to enroll.',
        );
      } catch (e: any) {
        if (!cancelled) {
          setCameraError(
            e?.name === 'NotAllowedError'
              ? 'Camera permission denied. Allow camera access in your browser or use PIN Fallback.'
              : e?.message || 'Unable to start camera',
          );
          setScanStatus('Camera unavailable — you can still use PIN Fallback.');
        }
      }
    };

    startCameraAndModels();

    return () => {
      cancelled = true;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      setCameraActive(false);
    };
  }, [isOpen]);

  // Live face scanning loop
  useEffect(() => {
    if (!isOpen || kioskMode !== 'FACE' || !modelsReady || !cameraActive) return;
    let stopped = false;
    let timerId: number | null = null;

    const drawOverlay = (
      obs: { box: { x: number; y: number; width: number; height: number } } | null,
      label: string,
      tone: 'emerald' | 'amber' | 'slate',
    ) => {
      const video = videoRef.current;
      const canvas = overlayRef.current;
      if (!video || !canvas) return;
      const w = video.videoWidth || 640;
      const h = video.videoHeight || 480;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      if (!obs) return;

      // Mirror X coordinate so box aligns with mirrored video feed
      const mirroredX = w - obs.box.x - obs.box.width;
      const { y, width, height } = obs.box;

      const stroke = tone === 'emerald' ? '#10b981' : tone === 'amber' ? '#f59e0b' : '#94a3b8';
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 3;
      ctx.strokeRect(mirroredX, y, width, height);

      if (label) {
        ctx.font = '600 13px Inter, system-ui, sans-serif';
        const textWidth = ctx.measureText(label).width;
        const boxY = Math.max(8, y - 28);
        ctx.fillStyle = stroke;
        ctx.fillRect(mirroredX, boxY, textWidth + 16, 24);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(label, mirroredX + 8, boxY + 16);
      }
    };

    const tick = async () => {
      if (stopped) return;
      try {
        if (!videoRef.current || submittingRef.current) {
          if (!stopped) timerId = window.setTimeout(tick, 240);
          return;
        }

        const obs = await detectLiveFace(videoRef.current);
        if (stopped) return;

        if (!obs) {
          drawOverlay(null, '', 'slate');
          setMatchedCandidate(null);
          livenessRef.current = { empId: null, earMin: 1, earMax: 0, yawMin: 1, yawMax: 0, frames: 0 };
          setScanStatus(
            enrolledEmployees.length > 0
              ? 'Looking for face... center yourself in the frame'
              : 'No enrolled crew faces available yet',
          );
        } else {
          const match = matchEmployeeFace(obs.descriptor, enrolledEmployees);
          if (!match) {
            drawOverlay(obs, 'Unrecognized face', 'amber');
            setMatchedCandidate(null);
            livenessRef.current = { empId: null, earMin: 1, earMax: 0, yawMin: 1, yawMax: 0, frames: 0 };
            setScanStatus('Face detected, but no matching enrolled employee found');
          } else {
            const emp = match.employee;
            const cooldownUntil = cooldownMapRef.current.get(emp.id) || 0;
            const hasOpen = openShiftByEmployee.has(emp.id);
            const nextAction: 'CLOCK_IN' | 'CLOCK_OUT' = hasOpen ? 'CLOCK_OUT' : 'CLOCK_IN';

            if (Date.now() < cooldownUntil) {
              drawOverlay(obs, `${emp.full_name} · Recorded`, 'emerald');
              setScanStatus(`Punch recorded for ${emp.full_name}. Ready for next crew member shortly...`);
            } else {
              const prev = livenessRef.current;
              const nextState =
                prev.empId === emp.id
                  ? {
                      empId: emp.id,
                      earMin: Math.min(prev.earMin, obs.eyeAspectRatio),
                      earMax: Math.max(prev.earMax, obs.eyeAspectRatio),
                      yawMin: Math.min(prev.yawMin, obs.headYawRatio),
                      yawMax: Math.max(prev.yawMax, obs.headYawRatio),
                      frames: prev.frames + 1,
                    }
                  : {
                      empId: emp.id,
                      earMin: obs.eyeAspectRatio,
                      earMax: obs.eyeAspectRatio,
                      yawMin: obs.headYawRatio,
                      yawMax: obs.headYawRatio,
                      frames: 1,
                    };
              livenessRef.current = nextState;

              const blinkDelta = nextState.earMax - nextState.earMin;
              const yawDelta = nextState.yawMax - nextState.yawMin;
              const livenessPassed = !requireLiveness || blinkDelta >= 0.035 || yawDelta >= 0.055;
              const livenessProgress = livenessPassed
                ? 100
                : Math.min(95, Math.round(Math.max(blinkDelta / 0.035, yawDelta / 0.055) * 100));

              drawOverlay(obs, `${emp.full_name} (${match.confidencePct}%)`, livenessPassed ? 'emerald' : 'amber');
              setMatchedCandidate({
                employee: emp,
                confidencePct: match.confidencePct,
                livenessProgress,
                livenessPassed,
                nextAction,
              });

              if (livenessPassed) {
                setScanStatus(`Verified ${emp.full_name} — recording ${nextAction === 'CLOCK_IN' ? 'Time In' : 'Time Out'}...`);
                const snapshotPhoto = captureSnapshotDataUrl(videoRef.current, 240, true);
                await executeClockPunch({
                  employee: emp,
                  verificationMethod: 'FACE_SCAN',
                  confidencePct: match.confidencePct,
                  snapshotPhoto,
                });
              } else {
                setScanStatus(
                  `Matched ${emp.full_name} (${match.confidencePct}%) — blink or turn slightly to confirm live presence`,
                );
              }
            }
          }
        }
      } catch {
        // Keep scanning loop resilient across transient frame hiccups
      }

      if (!stopped) {
        timerId = window.setTimeout(tick, 220);
      }
    };

    timerId = window.setTimeout(tick, 250);
    return () => {
      stopped = true;
      if (timerId !== null) window.clearTimeout(timerId);
    };
  }, [isOpen, kioskMode, modelsReady, cameraActive, enrolledEmployees, openShiftByEmployee, requireLiveness, kioskLocationId, shiftStartTime]);

  const handleBatchEnrollPhotos = async () => {
    if (pendingAutoEnroll.length === 0 || enrollingBatch) return;
    setEnrollingBatch(true);
    setEnrollProgressMsg('Analyzing existing crew photos on-device...');
    let successCount = 0;
    let failCount = 0;

    for (const emp of pendingAutoEnroll) {
      try {
        const res = await extractFaceDescriptorFromDataUrl(emp.avatar_url);
        await apiFetch(`/hr/employees/${emp.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            faceDescriptorJson: res.descriptorJson,
            faceEnrolledAt: new Date().toISOString(),
          }),
        });
        successCount++;
      } catch {
        failCount++;
      }
    }

    setEnrollingBatch(false);
    setEnrollProgressMsg(
      successCount > 0
        ? `Enrolled ${successCount} crew face(s)${failCount > 0 ? ` (${failCount} photo(s) need a clearer front portrait)` : ''}.`
        : 'Could not detect a clear front face in existing photos. Capture a live photo in Edit Employee.',
    );
    await onAutoEnrollSuccess();
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="On-Device Face Attendance Kiosk"
    >
      <div
        className="w-full max-w-5xl max-h-[92vh] overflow-y-auto rounded-xl bg-white border border-slate-200 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-slate-200 bg-slate-50/70">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-slate-900 text-white shrink-0">
              <ScanFace className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-display text-base font-semibold text-slate-900">
                On-Device Face Attendance Kiosk
              </h2>
              <p className="text-xs text-slate-500">
                Real-time local biometric Time In / Time Out with blink/head-turn liveness &amp; photo audit
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg border border-slate-200">
              <button
                type="button"
                onClick={() => setKioskMode('FACE')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  kioskMode === 'FACE' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <ScanFace className="w-3.5 h-3.5" /> Face Scanner
              </button>
              <button
                type="button"
                onClick={() => setKioskMode('PIN')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  kioskMode === 'PIN' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <KeyRound className="w-3.5 h-3.5" /> PIN Fallback
              </button>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 hover:text-slate-900 transition-colors"
              aria-label="Close attendance kiosk"
            >
              <X className="w-4 h-4" /> Close
            </button>
          </div>
        </div>

        {/* Configuration Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-b border-slate-100 bg-white text-xs">
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2">
              <span className="font-medium text-slate-600">Station / Truck:</span>
              <select
                value={kioskLocationId}
                onChange={(e) => setKioskLocationId(e.target.value)}
                className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs bg-white"
              >
                <option value="">Employee Assigned Location</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span className="font-medium text-slate-600">Shift Start (Late &gt;15m):</span>
              <input
                type="time"
                value={shiftStartTime}
                onChange={(e) => setShiftStartTime(e.target.value)}
                className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-mono"
              />
            </label>
          </div>

          {kioskMode === 'FACE' && (
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={requireLiveness}
                onChange={(e) => setRequireLiveness(e.target.checked)}
                className="rounded border-slate-300 text-slate-900 focus:ring-slate-900"
              />
              <span className="font-medium text-slate-700">Require blink / head-turn liveness</span>
            </label>
          )}
        </div>

        {/* Main Body */}
        <div className="p-5 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Camera / Scanner Column */}
          <div className="lg:col-span-7 space-y-3">
            {kioskMode === 'FACE' ? (
              <>
                <div className="relative rounded-xl overflow-hidden bg-slate-950 border border-slate-200 aspect-[4/3] flex items-center justify-center">
                  <video
                    ref={videoRef}
                    muted
                    playsInline
                    className="w-full h-full object-cover -scale-x-100"
                  />
                  <canvas
                    ref={overlayRef}
                    className="absolute inset-0 w-full h-full object-cover pointer-events-none"
                  />
                  {cameraError && (
                    <div className="absolute inset-0 bg-slate-900/90 p-6 flex flex-col items-center justify-center text-center text-white space-y-3">
                      <Camera className="w-8 h-8 text-amber-400" />
                      <p className="text-sm font-medium max-w-sm">{cameraError}</p>
                      <button
                        type="button"
                        onClick={() => setKioskMode('PIN')}
                        className="px-4 py-2 rounded-lg bg-white text-slate-900 text-xs font-semibold hover:bg-slate-100"
                      >
                        Switch to PIN Fallback
                      </button>
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 rounded-lg bg-slate-50 border border-slate-200 text-xs">
                  <div className="flex items-center gap-2 text-slate-700 font-medium">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        matchedCandidate?.livenessPassed
                          ? 'bg-emerald-500'
                          : matchedCandidate
                            ? 'bg-amber-500'
                            : cameraActive
                              ? 'bg-blue-500 animate-pulse'
                              : 'bg-slate-400'
                      }`}
                    />
                    <span>{scanStatus}</span>
                  </div>

                  {matchedCandidate && !matchedCandidate.livenessPassed && (
                    <button
                      type="button"
                      disabled={submittingPunch}
                      onClick={() => {
                        if (!videoRef.current) return;
                        const snapshotPhoto = captureSnapshotDataUrl(videoRef.current, 240, true);
                        executeClockPunch({
                          employee: matchedCandidate.employee,
                          verificationMethod: 'FACE_SCAN',
                          confidencePct: matchedCandidate.confidencePct,
                          snapshotPhoto,
                        });
                      }}
                      className="px-3 py-1.5 rounded-md bg-slate-900 text-white text-[11px] font-semibold hover:bg-slate-800 whitespace-nowrap"
                    >
                      Confirm &amp; {matchedCandidate.nextAction === 'CLOCK_IN' ? 'Time In' : 'Time Out'} Now
                    </button>
                  )}
                </div>
              </>
            ) : (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const emp = activeEmployees.find((x) => x.id === pinEmployeeId);
                  if (!emp) {
                    setPinErr('Select an employee');
                    return;
                  }
                  const snapshotPhoto =
                    videoRef.current && videoRef.current.readyState >= 2
                      ? captureSnapshotDataUrl(videoRef.current, 240, true)
                      : null;
                  await executeClockPunch({
                    employee: emp,
                    verificationMethod: 'PIN_FALLBACK',
                    snapshotPhoto,
                    pinCode,
                  });
                }}
                className="rounded-xl border border-slate-200 bg-slate-50/70 p-5 space-y-4"
              >
                <div>
                  <h3 className="font-display text-sm font-semibold text-slate-900">Supervisor / Low-Light PIN Fallback</h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Use when grill smoke, caps, or night-market lighting blocks facial matching. Camera snapshot is attached if available.
                  </p>
                </div>

                {pinErr && (
                  <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">
                    {pinErr}
                  </div>
                )}

                <div className="space-y-3 text-xs">
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Crew Member</label>
                    <select
                      value={pinEmployeeId}
                      onChange={(e) => setPinEmployeeId(e.target.value)}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2"
                    >
                      {activeEmployees.map((emp) => {
                        const onShift = openShiftByEmployee.has(emp.id);
                        return (
                          <option key={emp.id} value={emp.id}>
                            {emp.full_name} ({emp.employee_code}) — {onShift ? 'Currently On Shift (Will Clock Out)' : 'Off Shift (Will Clock In)'}
                          </option>
                        );
                      })}
                    </select>
                  </div>

                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Attendance PIN</label>
                    <input
                      type="password"
                      inputMode="numeric"
                      required
                      placeholder="Enter employee Attendance PIN"
                      value={pinCode}
                      onChange={(e) => setPinCode(e.target.value)}
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono tracking-widest"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={submittingPunch || !pinEmployeeId}
                  className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  <Clock className="w-3.5 h-3.5" />
                  {submittingPunch
                    ? 'Recording Punch...'
                    : openShiftByEmployee.has(pinEmployeeId)
                      ? 'Verify PIN & Time Out'
                      : 'Verify PIN & Time In'}
                </button>
              </form>
            )}
          </div>

          {/* Right Status, Biometric Readiness & Last Punch Column */}
          <div className="lg:col-span-5 space-y-4">
            {/* Last Successful Punch Card */}
            {lastPunch ? (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 text-emerald-900">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                    <span className="text-xs font-semibold uppercase tracking-wide">
                      {lastPunch.action === 'CLOCK_IN' ? 'Time In Recorded' : 'Time Out Recorded'}
                    </span>
                  </div>
                  <span className="text-[11px] font-mono text-emerald-800">
                    {new Date(lastPunch.timestamp).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })}
                  </span>
                </div>

                <div className="flex items-center gap-3">
                  {lastPunch.snapshotPhoto ? (
                    <img
                      src={lastPunch.snapshotPhoto}
                      alt={lastPunch.employeeName}
                      className="w-12 h-12 rounded-lg object-cover border border-emerald-200 shrink-0"
                    />
                  ) : (
                    <AvatarBadge name={lastPunch.employeeName} src={lastPunch.avatarUrl} size="md" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-900 truncate">{lastPunch.employeeName}</p>
                    <p className="text-xs text-slate-600">
                      {lastPunch.employeeCode} · {lastPunch.status} ·{' '}
                      {lastPunch.method === 'FACE_SCAN'
                        ? `Face Match${lastPunch.confidencePct ? ` (${lastPunch.confidencePct}%)` : ''}`
                        : 'PIN Fallback'}
                    </p>
                    {lastPunch.action === 'CLOCK_OUT' && (
                      <p className="text-xs font-mono font-semibold text-emerald-800 mt-0.5">
                        Shift: {lastPunch.workedHours ?? 0}h worked
                        {Number(lastPunch.overtimeHours || 0) > 0 ? ` · ${lastPunch.overtimeHours}h OT` : ''}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 text-xs text-slate-600 space-y-1">
                <div className="flex items-center gap-2 font-semibold text-slate-800">
                  <ShieldCheck className="w-4 h-4 text-slate-700" />
                  Ready for Shift Punch
                </div>
                <p className="text-slate-500">
                  Look into the camera for hands-free identification. Employees with an open shift automatically clock out and calculate overtime hours.
                </p>
              </div>
            )}

            {/* Biometric Enrollment Readiness */}
            <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-700">
                    Enrolled Face Profiles
                  </h3>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    {enrolledEmployees.length} of {activeEmployees.length} active crew enrolled on-device
                  </p>
                </div>
                <span className="font-mono text-sm font-bold text-slate-900">
                  {activeEmployees.length ? Math.round((enrolledEmployees.length / activeEmployees.length) * 100) : 0}%
                </span>
              </div>

              {pendingAutoEnroll.length > 0 && canManageEmployees && (
                <div className="rounded-lg border border-blue-200 bg-blue-50/70 p-3 space-y-2">
                  <p className="text-[11px] text-blue-900">
                    <span className="font-semibold">{pendingAutoEnroll.length} crew photo(s)</span> already uploaded can be enrolled for face scanning right now.
                  </p>
                  <button
                    type="button"
                    disabled={enrollingBatch}
                    onClick={handleBatchEnrollPhotos}
                    className="inline-flex items-center gap-1.5 rounded-md bg-blue-700 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
                  >
                    {enrollingBatch ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                    {enrollingBatch ? 'Extracting Face Signatures...' : `Auto-Enroll ${pendingAutoEnroll.length} Crew Photo(s)`}
                  </button>
                </div>
              )}
              {pendingAutoEnroll.length > 0 && !canManageEmployees && (
                <p className="text-[11px] text-slate-500">
                  {pendingAutoEnroll.length} crew photo(s) await Face ID enrollment by an HR Manager or Owner.
                </p>
              )}

              {enrollProgressMsg && (
                <p className="text-[11px] font-medium text-emerald-700">{enrollProgressMsg}</p>
              )}

              <div className="max-h-56 overflow-y-auto divide-y divide-slate-100 border-t border-slate-100 pt-1">
                {activeEmployees.map((emp) => {
                  const isEnrolled = Boolean(parseDescriptorJson(emp.face_descriptor_json));
                  const onShift = openShiftByEmployee.has(emp.id);
                  return (
                    <div key={emp.id} className="py-2 flex items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-2 min-w-0">
                        <AvatarBadge name={emp.full_name} src={emp.avatar_url} size="sm" />
                        <div className="min-w-0">
                          <p className="font-medium text-slate-900 truncate">{emp.full_name}</p>
                          <p className="text-[11px] text-slate-500 truncate">
                            {emp.employee_code} · {onShift ? 'On Shift' : 'Off Shift'}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px] shrink-0">
                        {isEnrolled ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                            <UserCheck className="w-3.5 h-3.5" /> Face Ready
                          </span>
                        ) : (
                          <span className="text-slate-400">Not Enrolled</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-slate-200 bg-slate-50/70">
          <p className="text-[11px] text-slate-500">Press Esc or click outside to close. Camera stops automatically on close.</p>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 hover:text-slate-900 transition-colors"
          >
            <X className="w-3.5 h-3.5" /> Close Kiosk
          </button>
        </div>
      </div>
    </div>
  );
}
