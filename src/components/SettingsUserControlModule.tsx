import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus,
  Pencil,
  Upload,
  Trash2,
  Shield,
  UserCheck,
  X,
  KeyRound,
  Lock,
  Unlock,
  Tablet,
  Copy,
  Check,
  ShieldCheck,
  ShieldAlert,
  RefreshCw,
  Eye,
  EyeOff,
  Monitor,
  MapPin,
  Printer,
  Wifi,
  Bluetooth,
  Search,
  Send,
  Unlink,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { ThemeToggle } from './ThemeToggle.tsx';
import { apiFetch } from '../lib/api.ts';
import {
  BluetoothCapabilitiesInfo,
  clearTerminalPrinterConfig,
  DiscoveredBluetoothPrinter,
  DiscoveredThermalPrinter,
  fetchDetectedPrinterSubnets,
  getBluetoothCapabilities,
  getSavedTerminalPrinterConfig,
  isValidPrivateLanIp,
  listPreviouslyAuthorizedBluetoothPrinters,
  PrinterConnectionType,
  printerMappingFromDeviceRow,
  PrinterScanResponse,
  PrinterSubnetsResponse,
  probeSingleThermalPrinter,
  reconnectBluetoothPrinter,
  saveTerminalPrinterConfig,
  scanAndPairBluetoothPrinter,
  scanNetworkThermalPrinters,
  sendBluetoothTestPrint,
  sendThermalTestPrint,
  ThermalPaperWidthMm,
} from '../lib/printerDiscovery.ts';
import {
  claimTerminalPasscode,
  fetchTerminalStatus,
  getBrowserDeviceSummary,
  getOrCreateHardwareUuid,
  isEnvForcedTerminalMode,
  isTerminalModeDevice,
  isValidHardwareUuid,
  setTerminalModeEnabled,
  TerminalServerStatus,
  unpairTerminalDevice,
  updateTerminalStationConfig,
  verifyTerminalAccessKey,
} from '../lib/terminalAuth.ts';
import { AuthUser } from '../types/erp.ts';

interface Props {
  currentUser: AuthUser;
  onProfileUpdated: () => Promise<void>;
  terminalStatus?: TerminalServerStatus | null;
  onTerminalStateChanged?: (retrySilentAuth?: boolean) => Promise<void> | void;
}

interface RegisteredDeviceRow {
  id: string;
  hardware_uuid: string;
  device_name: string;
  location_id: string | null;
  location_name: string | null;
  station_email: string | null;
  status: 'AUTHORIZED' | 'REVOKED';
  paired_by_user_id: string;
  paired_by_name: string;
  paired_at: string;
  last_seen_at: string;
  user_agent_summary: string | null;
  printer_connection_type?: PrinterConnectionType | null;
  printer_name?: string | null;
  printer_ip?: string | null;
  printer_port?: number | null;
  printer_bt_device_id?: string | null;
  printer_bt_service_uuid?: string | null;
  printer_bt_characteristic_uuid?: string | null;
  printer_paper_width_mm?: 58 | 80 | null;
  printer_auto_print?: boolean;
  created_at: string;
  updated_at: string;
}

export function getInitials(name: string): string {
  const parts = String(name || '')
    .replace(/\(.*?\)/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return 'U';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function resizeImageToDataUrl(file: File, maxDim = 256): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read image file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Invalid image file'));
      img.onload = () => {
        const size = Math.min(img.width, img.height);
        const sx = (img.width - size) / 2;
        const sy = (img.height - size) / 2;
        const canvas = document.createElement('canvas');
        canvas.width = maxDim;
        canvas.height = maxDim;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Canvas context unavailable'));
          return;
        }
        ctx.drawImage(img, sx, sy, size, size, 0, 0, maxDim, maxDim);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export function AvatarBadge({ name, src, size = 'md' }: { name: string; src?: string | null; size?: 'sm' | 'md' | 'lg' }) {
  const dims = size === 'lg' ? 'w-14 h-14 text-base' : size === 'sm' ? 'w-7 h-7 text-[11px]' : 'w-9 h-9 text-xs';
  if (src) {
    return (
      <img
        src={src}
        alt={name}
        referrerPolicy="no-referrer"
        className={`${dims} rounded-full object-cover border border-slate-200 dark:border-slate-800 shrink-0 bg-slate-100 dark:bg-slate-800`}
      />
    );
  }
  return (
    <div
      className={`${dims} rounded-full bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 font-semibold flex items-center justify-center shrink-0 select-none`}
    >
      {getInitials(name)}
    </div>
  );
}

export function SettingsUserControlModule({
  currentUser,
  onProfileUpdated,
  terminalStatus: propTerminalStatus = null,
  onTerminalStateChanged,
}: Props) {
  const canManageUsers = currentUser.roleCode === 'SUPER_ADMIN' || currentUser.roleCode === 'BUSINESS_OWNER';
  const canManageAllDevices =
    canManageUsers ||
    currentUser.roleCode === 'OPERATIONS_MANAGER' ||
    currentUser.roleCode === 'FOOD_TRUCK_MANAGER';
  const [activeSection, setActiveSection] = useState<'users' | 'devices'>(() => (canManageUsers ? 'users' : 'devices'));

  const [data, setData] = useState<{ users: any[]; roles: any[]; locations: any[] } | null>(null);
  const [devicesData, setDevicesData] = useState<{ devices: RegisteredDeviceRow[]; locations: any[] } | null>(null);
  const [localTerminalStatus, setLocalTerminalStatus] = useState<TerminalServerStatus | null>(propTerminalStatus);
  const [currentHardwareUuid] = useState<string>(() => getOrCreateHardwareUuid());
  const [browserSummary] = useState<string>(() => getBrowserDeviceSummary());
  const [localTerminalMode, setLocalTerminalMode] = useState<boolean>(() => isTerminalModeDevice());
  const [copiedUuid, setCopiedUuid] = useState(false);

  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  // User Modal State
  const [userModal, setUserModal] = useState<{
    mode: 'create' | 'edit';
    id?: string;
    hasExistingPin?: boolean;
    isLocked?: boolean;
    failedAttempts?: number;
  } | null>(null);
  const [userForm, setUserForm] = useState({
    fullName: '',
    email: '',
    phone: '',
    address: '',
    password: '',
    shiftPin: '',
    clearPin: false,
    unlockAccount: false,
    roleId: '',
    assignedLocationId: '',
    avatarUrl: '',
    isActive: true,
  });

  // Device Pairing / Edit / Re-Authorize Modal State
  const [deviceModal, setDeviceModal] = useState<{
    mode: 'pair' | 'edit' | 'reauthorize';
    id?: string;
  } | null>(null);
  const [deviceForm, setDeviceForm] = useState({
    deviceName: '',
    hardwareUuid: '',
    locationId: '',
    stationEmail: '',
    accessKey: '',
    activateCurrentBrowser: false,
  });
  const [showAccessKey, setShowAccessKey] = useState(false);
  const [deviceActionId, setDeviceActionId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  // Thermal Printer Discovery (Bluetooth & Network) & Mapping State
  const [printerConnectionTab, setPrinterConnectionTab] = useState<PrinterConnectionType>(() => {
    const saved = getSavedTerminalPrinterConfig();
    return saved?.connectionType === 'NETWORK' ? 'NETWORK' : 'BLUETOOTH';
  });
  const [subnetInfo, setSubnetInfo] = useState<PrinterSubnetsResponse | null>(null);
  const [scanTarget, setScanTarget] = useState('192.168.1.0/24');
  const [scanPort, setScanPort] = useState<number>(9100);
  const [scanningPrinters, setScanningPrinters] = useState(false);
  const [probingPrinter, setProbingPrinter] = useState(false);
  const [scanResult, setScanResult] = useState<PrinterScanResponse | null>(null);
  const [discoveredPrinters, setDiscoveredPrinters] = useState<DiscoveredThermalPrinter[]>([]);

  const [btCapabilities, setBtCapabilities] = useState<BluetoothCapabilitiesInfo | null>(null);
  const [scanningBluetooth, setScanningBluetooth] = useState(false);
  const [discoveredBtPrinters, setDiscoveredBtPrinters] = useState<DiscoveredBluetoothPrinter[]>([]);
  const [reconnectingBtId, setReconnectingBtId] = useState<string | null>(null);

  const [printerFeedback, setPrinterFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [printerForm, setPrinterForm] = useState<{
    connectionType: PrinterConnectionType;
    printerName: string;
    printerIp: string;
    printerPort: number;
    btDeviceId: string;
    btServiceUuid: string;
    btCharacteristicUuid: string;
    paperWidthMm: ThermalPaperWidthMm;
    autoPrint: boolean;
  }>(() => {
    const saved = getSavedTerminalPrinterConfig();
    return {
      connectionType: saved?.connectionType || 'BLUETOOTH',
      printerName: saved?.printerName || '',
      printerIp: saved?.printerIp || '',
      printerPort: saved?.printerPort || 9100,
      btDeviceId: saved?.btDeviceId || '',
      btServiceUuid: saved?.btServiceUuid || '',
      btCharacteristicUuid: saved?.btCharacteristicUuid || '',
      paperWidthMm: saved?.paperWidthMm || 58,
      autoPrint: saved?.autoPrint ?? true,
    };
  });
  const [savingPrinter, setSavingPrinter] = useState(false);
  const [testingPrinterEndpoint, setTestingPrinterEndpoint] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [unlockingId, setUnlockingId] = useState<string | null>(null);
  const userFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (propTerminalStatus) {
      setLocalTerminalStatus(propTerminalStatus);
    }
  }, [propTerminalStatus]);

  const load = useCallback(async () => {
    try {
      setErr('');
      const [usersRes, devicesRes, termStat] = await Promise.all([
        canManageUsers ? apiFetch<{ users: any[]; roles: any[]; locations: any[] }>('/settings/users-control') : Promise.resolve(null),
        canManageAllDevices
          ? apiFetch<{ devices: RegisteredDeviceRow[]; locations: any[] }>('/settings/devices')
          : apiFetch<{ device: RegisteredDeviceRow | null; locations: any[] }>(
              `/settings/devices/current?hardwareUuid=${encodeURIComponent(currentHardwareUuid)}`,
            ).then((res) => ({
              devices: res.device ? [res.device] : [],
              locations: res.locations,
            })),
        fetchTerminalStatus(),
      ]);
      if (usersRes) setData(usersRes);
      setDevicesData(devicesRes);
      setLocalTerminalStatus(termStat);
      setLocalTerminalMode(isTerminalModeDevice());
    } catch (e: any) {
      setErr(e.message || 'Unable to load Settings data');
    }
  }, [canManageUsers, canManageAllDevices, currentHardwareUuid]);

  useEffect(() => {
    void load();
  }, [load]);

  const currentDeviceRecord = useMemo(
    () => devicesData?.devices.find((d) => d.hardware_uuid === currentHardwareUuid) || null,
    [devicesData, currentHardwareUuid],
  );

  // Sync local terminal printer config & form when currentDeviceRecord updates
  useEffect(() => {
    if (!currentDeviceRecord) return;
    const mapped = printerMappingFromDeviceRow(currentDeviceRecord, currentDeviceRecord.hardware_uuid);
    if (mapped) {
      saveTerminalPrinterConfig(mapped);
      setPrinterConnectionTab(mapped.connectionType);
      setPrinterForm({
        connectionType: mapped.connectionType,
        printerName: mapped.printerName,
        printerIp: mapped.printerIp || '',
        printerPort: mapped.printerPort || 9100,
        btDeviceId: mapped.btDeviceId || '',
        btServiceUuid: mapped.btServiceUuid || '',
        btCharacteristicUuid: mapped.btCharacteristicUuid || '',
        paperWidthMm: mapped.paperWidthMm,
        autoPrint: mapped.autoPrint,
      });
    } else if (
      currentDeviceRecord.status === 'REVOKED' ||
      (!currentDeviceRecord.printer_ip && !currentDeviceRecord.printer_bt_device_id)
    ) {
      clearTerminalPrinterConfig();
    }
  }, [currentDeviceRecord]);

  // Fetch detected network interfaces & Bluetooth capabilities when Devices & Printers section is active
  useEffect(() => {
    if (activeSection !== 'devices') return;
    let cancelled = false;
    fetchDetectedPrinterSubnets()
      .then((info) => {
        if (cancelled) return;
        setSubnetInfo(info);
        if (info.detectedSubnets.length > 0) {
          setScanTarget((prev) => (prev === '192.168.1.0/24' ? info.detectedSubnets[0] : prev));
        }
      })
      .catch(() => {
        // Ignore if not signed into Firebase yet
      });

    getBluetoothCapabilities()
      .then((caps) => {
        if (!cancelled) setBtCapabilities(caps);
      })
      .catch(() => {});

    listPreviouslyAuthorizedBluetoothPrinters()
      .then((paired) => {
        if (cancelled || paired.length === 0) return;
        setDiscoveredBtPrinters((prev) => {
          const map = new Map<string, DiscoveredBluetoothPrinter>();
          for (const p of prev) map.set(p.btDeviceId, p);
          for (const p of paired) {
            if (!map.has(p.btDeviceId)) map.set(p.btDeviceId, p);
          }
          return Array.from(map.values());
        });
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [activeSection]);

  const availableLocations = useMemo(
    () => devicesData?.locations || data?.locations || [],
    [devicesData, data],
  );

  if (err && ((canManageUsers && !data && !devicesData) || (!canManageUsers && !devicesData))) {
    return <div className="p-4 rounded-lg border border-red-200 dark:border-red-800/80 bg-red-50 dark:bg-red-950/50 text-xs text-red-700 dark:text-red-300 font-medium">{err}</div>;
  }
  if ((canManageUsers && !data && activeSection === 'users') || !devicesData) {
    return <div className="h-64 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 animate-pulse" />;
  }

  const openCreateUser = () => {
    setErr('');
    setUserForm({
      fullName: '',
      email: '',
      phone: '',
      address: '',
      password: '',
      shiftPin: '',
      clearPin: false,
      unlockAccount: false,
      roleId: data?.roles[0]?.id || '',
      assignedLocationId: '',
      avatarUrl: '',
      isActive: true,
    });
    setUserModal({ mode: 'create', hasExistingPin: false, isLocked: false, failedAttempts: 0 });
  };

  const openEditUser = (u: any) => {
    setErr('');
    setUserForm({
      fullName: u.full_name || '',
      email: u.email || '',
      phone: u.phone || '',
      address: u.address || '',
      password: '',
      shiftPin: '',
      clearPin: false,
      unlockAccount: Boolean(u.is_locked),
      roleId: u.role_id || data?.roles[0]?.id || '',
      assignedLocationId: u.assigned_location_id || '',
      avatarUrl: u.avatar_url || '',
      isActive: u.is_active === 1,
    });
    setUserModal({
      mode: 'edit',
      id: u.id,
      hasExistingPin: Boolean(u.has_pin),
      isLocked: Boolean(u.is_locked),
      failedAttempts: Number(u.failed_login_attempts || 0),
    });
  };

  const handleQuickUnlock = async (u: any) => {
    setErr('');
    setMsg('');
    setUnlockingId(u.id);
    try {
      await apiFetch(`/settings/users/${u.id}`, {
        method: 'PUT',
        body: JSON.stringify({ unlockAccount: true }),
      });
      setMsg(`Unlocked account for "${u.full_name}"`);
      await load();
    } catch (e: any) {
      setErr(e.message || 'Unable to unlock account');
    } finally {
      setUnlockingId(null);
    }
  };

  const handlePhotoUpload = async (file: File | undefined) => {
    if (!file) return;
    setErr('');
    try {
      const dataUrl = await resizeImageToDataUrl(file, 256);
      setUserForm((f) => ({ ...f, avatarUrl: dataUrl }));
    } catch (e: any) {
      setErr(e.message || 'Unable to process uploaded image');
    }
  };

  const submitUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userModal) return;
    setErr('');
    const cleanPin = userForm.shiftPin.trim();
    if (cleanPin && !/^\d{4,6}$/.test(cleanPin)) {
      setErr('Shift PIN must be 4 to 6 numeric digits');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        fullName: userForm.fullName,
        email: userForm.email,
        phone: userForm.phone.trim() || null,
        address: userForm.address.trim() || null,
        password: userForm.password || undefined,
        shiftPin: userForm.clearPin ? undefined : cleanPin || undefined,
        clearPin: userModal.mode === 'edit' ? userForm.clearPin : false,
        unlockAccount: userModal.mode === 'edit' ? userForm.unlockAccount : false,
        roleId: userForm.roleId,
        assignedLocationId: userForm.assignedLocationId || null,
        avatarUrl: userForm.avatarUrl || null,
        isActive: userForm.isActive,
      };
      if (userModal.mode === 'create') {
        await apiFetch('/settings/users', { method: 'POST', body: JSON.stringify(payload) });
        setMsg(`Created user account "${userForm.fullName.trim()}"`);
      } else {
        await apiFetch(`/settings/users/${userModal.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        setMsg(`Updated user account "${userForm.fullName.trim()}"`);
        if (userModal.id === currentUser.id) {
          await onProfileUpdated();
        }
      }
      setUserModal(null);
      await load();
    } catch (e: any) {
      setErr(e.message || 'Unable to save user');
    } finally {
      setSaving(false);
    }
  };

  const handleCopyHardwareUuid = async () => {
    try {
      await navigator.clipboard.writeText(currentHardwareUuid);
      setCopiedUuid(true);
      window.setTimeout(() => setCopiedUuid(false), 1800);
    } catch {
      // ignore clipboard restriction
    }
  };

  const openPairModal = (prefillCurrentDevice = false) => {
    setErr('');
    setShowAccessKey(false);
    setDeviceForm({
      deviceName: prefillCurrentDevice ? `POS Register — ${browserSummary.split('·')[0].trim()}` : '',
      hardwareUuid: prefillCurrentDevice ? currentHardwareUuid : '',
      locationId: currentUser.assignedLocationId || '',
      stationEmail: '',
      accessKey: '',
      activateCurrentBrowser: prefillCurrentDevice,
    });
    setDeviceModal({ mode: 'pair' });
  };

  const openEditDeviceModal = (d: RegisteredDeviceRow) => {
    setErr('');
    setShowAccessKey(false);
    setDeviceForm({
      deviceName: d.device_name,
      hardwareUuid: d.hardware_uuid,
      locationId: d.location_id || '',
      stationEmail: d.station_email || '',
      accessKey: '',
      activateCurrentBrowser: d.hardware_uuid === currentHardwareUuid && localTerminalMode,
    });
    setDeviceModal({ mode: 'edit', id: d.id });
  };

  const openReauthorizeModal = (d: RegisteredDeviceRow) => {
    setErr('');
    setShowAccessKey(false);
    setDeviceForm({
      deviceName: d.device_name,
      hardwareUuid: d.hardware_uuid,
      locationId: d.location_id || '',
      stationEmail: d.station_email || '',
      accessKey: '',
      activateCurrentBrowser: d.hardware_uuid === currentHardwareUuid,
    });
    setDeviceModal({ mode: 'reauthorize', id: d.id });
  };

  const submitDeviceModal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deviceModal) return;
    setErr('');
    const cleanUuid = deviceForm.hardwareUuid.trim();
    const cleanName = deviceForm.deviceName.trim();
    if (!cleanName) {
      setErr('Device / Register name is required');
      return;
    }
    if (!isValidHardwareUuid(cleanUuid)) {
      setErr('Hardware UUID must be 8 to 128 alphanumeric, underscore, or hyphen characters');
      return;
    }

    const isCurrentDevice = cleanUuid === currentHardwareUuid;
    const shouldActivateBrowser = isCurrentDevice && deviceForm.activateCurrentBrowser;

    setSaving(true);
    try {
      if (deviceModal.mode === 'pair' || deviceModal.mode === 'reauthorize') {
        const cleanKey = deviceForm.accessKey.trim();
        if (!cleanKey) {
          throw new Error('Enter the TERMINAL_ACCESS_KEY to authorize and link this device');
        }
        if (!localTerminalStatus?.accessKeyConfigured) {
          if (cleanKey.length < 6) {
            throw new Error('Initial setup key must be at least 6 characters');
          }
          await claimTerminalPasscode(cleanKey);
        } else {
          await verifyTerminalAccessKey({
            accessKey: cleanKey,
            hardwareUuid: cleanUuid,
            pairCurrentBrowser: shouldActivateBrowser,
          });
        }
      }

      if (deviceModal.mode === 'pair') {
        await apiFetch('/settings/devices', {
          method: 'POST',
          body: JSON.stringify({
            hardwareUuid: cleanUuid,
            deviceName: cleanName,
            locationId: deviceForm.locationId || null,
            stationEmail: deviceForm.stationEmail.trim().toLowerCase() || null,
            userAgentSummary: isCurrentDevice ? browserSummary : null,
          }),
        });
        setMsg(`Paired & authorized POS device "${cleanName}" (${cleanUuid})`);
      } else {
        await apiFetch(`/settings/devices/${deviceModal.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            deviceName: cleanName,
            locationId: deviceForm.locationId || null,
            stationEmail: deviceForm.stationEmail.trim().toLowerCase() || null,
            status: deviceModal.mode === 'reauthorize' ? 'AUTHORIZED' : undefined,
            ...(isCurrentDevice ? { userAgentSummary: browserSummary } : {}),
          }),
        });
        setMsg(
          deviceModal.mode === 'reauthorize'
            ? `Re-authorized POS device "${cleanName}"`
            : `Updated POS device "${cleanName}"`,
        );
      }

      if (isCurrentDevice) {
        if (shouldActivateBrowser) {
          setTerminalModeEnabled(true, {
            stationEmail: deviceForm.stationEmail.trim().toLowerCase(),
            locationId: deviceForm.locationId || undefined,
          });
        } else {
          updateTerminalStationConfig({
            stationEmail: deviceForm.stationEmail.trim().toLowerCase(),
            locationId: deviceForm.locationId || undefined,
          });
        }
        await onTerminalStateChanged?.(false);
      }

      setDeviceModal(null);
      await load();
    } catch (e: any) {
      setErr(e.message || 'Unable to save device pairing');
    } finally {
      setSaving(false);
    }
  };

  const handleRevokeDevice = async (d: RegisteredDeviceRow) => {
    setErr('');
    setMsg('');
    setDeviceActionId(d.id);
    try {
      await apiFetch(`/settings/devices/${d.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'REVOKED' }),
      });
      if (d.hardware_uuid === currentHardwareUuid) {
        if (!isEnvForcedTerminalMode()) {
          setTerminalModeEnabled(false);
        }
        await unpairTerminalDevice(undefined, { forceRevoke: true }).catch(() => {});
        await onTerminalStateChanged?.(false);
      }
      setMsg(`Revoked POS terminal authorization for "${d.device_name}"`);
      await load();
    } catch (e: any) {
      setErr(e.message || 'Unable to revoke terminal authorization');
    } finally {
      setDeviceActionId(null);
    }
  };

  const handleRemoveDevice = async (d: RegisteredDeviceRow) => {
    setErr('');
    setMsg('');
    setDeviceActionId(d.id);
    try {
      await apiFetch(`/settings/devices/${d.id}`, { method: 'DELETE' });
      if (d.hardware_uuid === currentHardwareUuid) {
        if (!isEnvForcedTerminalMode()) {
          setTerminalModeEnabled(false);
        }
        await unpairTerminalDevice(undefined, { forceRevoke: true }).catch(() => {});
        await onTerminalStateChanged?.(false);
      }
      setConfirmRemoveId(null);
      setMsg(`Removed POS device "${d.device_name}" from authorized registers`);
      await load();
    } catch (e: any) {
      setErr(e.message || 'Unable to remove POS device');
    } finally {
      setDeviceActionId(null);
    }
  };

  const formatTimestamp = (iso?: string | null) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-PH', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const handleScanPrinters = async () => {
    setPrinterFeedback(null);
    const target = scanTarget.trim();
    if (!target) {
      setPrinterFeedback({ type: 'err', text: 'Enter a private LAN subnet (e.g. 192.168.1.0/24) or single IP.' });
      return;
    }
    setScanningPrinters(true);
    try {
      const res = await scanNetworkThermalPrinters({
        target,
        ports: [scanPort],
      });
      setScanResult(res);
      setDiscoveredPrinters(res.printers);
      if (res.printers.length > 0) {
        setPrinterFeedback({
          type: 'ok',
          text: `Discovered ${res.printers.length} networked printer endpoint${res.printers.length === 1 ? '' : 's'} across ${res.scannedHosts} hosts (${res.durationMs}ms).`,
        });
      } else {
        setPrinterFeedback({
          type: 'err',
          text: `Scanned ${res.scannedHosts} hosts on port ${scanPort} (${res.durationMs}ms) — no responsive TCP receipt printers found on this host network. You can still probe or enter your LAN printer IP below.`,
        });
      }
    } catch (e: any) {
      setPrinterFeedback({ type: 'err', text: e.message || 'Unable to scan network for thermal printers.' });
    } finally {
      setScanningPrinters(false);
    }
  };

  const handleProbeSingleIp = async () => {
    setPrinterFeedback(null);
    const candidateIp = (printerForm.printerIp || scanTarget.split('/')[0] || '').trim();
    if (!isValidPrivateLanIp(candidateIp)) {
      setPrinterFeedback({
        type: 'err',
        text: 'Enter a valid private LAN IPv4 address (10.x, 172.16-31.x, or 192.168.x) to probe.',
      });
      return;
    }
    setProbingPrinter(true);
    try {
      const res = await probeSingleThermalPrinter({
        ip: candidateIp,
        port: Number(printerForm.printerPort) || scanPort,
      });
      if (res.reachable && res.printer) {
        const found = res.printer;
        setDiscoveredPrinters((prev) => {
          const filtered = prev.filter((p) => !(p.ip === found.ip && p.port === found.port));
          return [found, ...filtered];
        });
        setPrinterForm((f) => ({
          ...f,
          printerIp: found.ip,
          printerPort: found.port,
          printerName: f.printerName.trim() || found.suggestedName,
        }));
        setPrinterFeedback({
          type: 'ok',
          text: `Printer responded at ${found.ip}:${found.port} (${found.latencyMs}ms · ${found.statusSummary}).`,
        });
      } else {
        setPrinterFeedback({
          type: 'err',
          text: res.error || `No ESC/POS printer responded at ${candidateIp}:${Number(printerForm.printerPort) || scanPort}.`,
        });
      }
    } catch (e: any) {
      setPrinterFeedback({ type: 'err', text: e.message || 'Printer probe failed.' });
    } finally {
      setProbingPrinter(false);
    }
  };

  const handleScanBluetoothPrinters = async () => {
    setPrinterFeedback(null);
    setScanningBluetooth(true);
    try {
      const discovered = await scanAndPairBluetoothPrinter();
      setDiscoveredBtPrinters((prev) => {
        const filtered = prev.filter((p) => p.btDeviceId !== discovered.btDeviceId);
        return [discovered, ...filtered];
      });
      setPrinterConnectionTab('BLUETOOTH');
      setPrinterForm((f) => ({
        ...f,
        connectionType: 'BLUETOOTH',
        printerName: discovered.name,
        btDeviceId: discovered.btDeviceId,
        btServiceUuid: discovered.btServiceUuid || '',
        btCharacteristicUuid: discovered.btCharacteristicUuid || '',
      }));
      setPrinterFeedback({
        type: 'ok',
        text: `Discovered Bluetooth printer "${discovered.name}" (${discovered.statusSummary}). Review roll width and click "Map to This Terminal".`,
      });
    } catch (e: any) {
      const msgText = String(e?.message || '');
      if (msgText.toLowerCase().includes('cancelled') || msgText.toLowerCase().includes('canceled')) {
        setPrinterFeedback({
          type: 'err',
          text: 'Bluetooth device chooser was closed before selecting a printer.',
        });
      } else {
        setPrinterFeedback({
          type: 'err',
          text: msgText || 'Unable to scan Bluetooth printers on this device.',
        });
      }
    } finally {
      setScanningBluetooth(false);
    }
  };

  const handleRefreshPairedBluetooth = async () => {
    setPrinterFeedback(null);
    const paired = await listPreviouslyAuthorizedBluetoothPrinters();
    setDiscoveredBtPrinters((prev) => {
      const map = new Map<string, DiscoveredBluetoothPrinter>();
      for (const p of prev) map.set(p.btDeviceId, p);
      for (const p of paired) {
        if (!map.has(p.btDeviceId)) map.set(p.btDeviceId, p);
      }
      return Array.from(map.values());
    });
    if (paired.length === 0) {
      setPrinterFeedback({
        type: 'err',
        text: 'No previously authorized Web Bluetooth printers found. Click "Scan & Pair Bluetooth" to search nearby BLE printers.',
      });
    } else {
      setPrinterFeedback({
        type: 'ok',
        text: `Loaded ${paired.length} previously paired Bluetooth printer${paired.length === 1 ? '' : 's'}.`,
      });
    }
  };

  const handleReconnectBluetooth = async (btPrinter: DiscoveredBluetoothPrinter) => {
    setPrinterFeedback(null);
    setReconnectingBtId(btPrinter.btDeviceId);
    try {
      const updated = await reconnectBluetoothPrinter({
        btDeviceId: btPrinter.btDeviceId,
        btServiceUuid: btPrinter.btServiceUuid || undefined,
        btCharacteristicUuid: btPrinter.btCharacteristicUuid || undefined,
      });
      setDiscoveredBtPrinters((prev) => {
        const filtered = prev.filter((p) => p.btDeviceId !== updated.btDeviceId);
        return [updated, ...filtered];
      });
      setPrinterForm((f) => ({
        ...f,
        connectionType: 'BLUETOOTH',
        printerName: f.printerName.trim() || updated.name,
        btDeviceId: updated.btDeviceId,
        btServiceUuid: updated.btServiceUuid || f.btServiceUuid,
        btCharacteristicUuid: updated.btCharacteristicUuid || f.btCharacteristicUuid,
      }));
      setPrinterFeedback({ type: 'ok', text: `Connected to "${updated.name}" (${updated.statusSummary}).` });
    } catch (e: any) {
      setPrinterFeedback({ type: 'err', text: e.message || 'Unable to connect to Bluetooth printer.' });
    } finally {
      setReconnectingBtId(null);
    }
  };

  const handleSelectDiscoveredBtPrinter = (printer: DiscoveredBluetoothPrinter) => {
    setPrinterFeedback(null);
    setPrinterConnectionTab('BLUETOOTH');
    setPrinterForm((f) => ({
      ...f,
      connectionType: 'BLUETOOTH',
      printerName: printer.name,
      btDeviceId: printer.btDeviceId,
      btServiceUuid: printer.btServiceUuid || f.btServiceUuid,
      btCharacteristicUuid: printer.btCharacteristicUuid || f.btCharacteristicUuid,
    }));
    setPrinterFeedback({
      type: 'ok',
      text: `Selected Bluetooth printer "${printer.name}". Review paper width (58mm/80mm) and click "Map to This Terminal" to save.`,
    });
  };

  const handleBluetoothTestPrint = async (params?: {
    btDeviceId?: string;
    btServiceUuid?: string;
    btCharacteristicUuid?: string;
    printerName?: string;
  }) => {
    setPrinterFeedback(null);
    const btId = (params?.btDeviceId ?? printerForm.btDeviceId).trim();
    if (!btId) {
      setPrinterFeedback({
        type: 'err',
        text: 'Pair or enter a Bluetooth printer Device ID before sending a Bluetooth test print.',
      });
      return;
    }
    const key = `bt:${btId}`;
    setTestingPrinterEndpoint(key);
    try {
      const res = await sendBluetoothTestPrint({
        btDeviceId: btId,
        btServiceUuid: (params?.btServiceUuid ?? printerForm.btServiceUuid).trim() || undefined,
        btCharacteristicUuid: (params?.btCharacteristicUuid ?? printerForm.btCharacteristicUuid).trim() || undefined,
        paperWidthMm: printerForm.paperWidthMm,
        printerName: params?.printerName ?? (printerForm.printerName.trim() || undefined),
        terminalName: currentDeviceRecord?.device_name || browserSummary,
        hardwareUuid: currentHardwareUuid,
      });
      setPrinterFeedback({ type: 'ok', text: res.message });
    } catch (e: any) {
      setPrinterFeedback({
        type: 'err',
        text: e.message || 'Bluetooth test print failed. Ensure the printer is powered on and paired via Scan & Pair Bluetooth.',
      });
    } finally {
      setTestingPrinterEndpoint(null);
    }
  };

  const handleSelectDiscoveredPrinter = (printer: DiscoveredThermalPrinter) => {
    setPrinterFeedback(null);
    setPrinterConnectionTab('NETWORK');
    setPrinterForm((f) => ({
      ...f,
      connectionType: 'NETWORK',
      printerIp: printer.ip,
      printerPort: printer.port,
      printerName:
        !f.printerName.trim() || f.printerName.startsWith('Thermal Printer') || f.printerName.startsWith('Bluetooth')
          ? printer.suggestedName
          : f.printerName,
    }));
    setPrinterFeedback({
      type: 'ok',
      text: `Selected ${printer.ip}:${printer.port}. Review paper width and click "Map to This Terminal" to save.`,
    });
  };

  const handleTestPrint = async (targetIp?: string, targetPort?: number, targetName?: string) => {
    setPrinterFeedback(null);
    const ip = (targetIp ?? printerForm.printerIp).trim();
    const port = Number(targetPort ?? printerForm.printerPort) || 9100;
    if (!isValidPrivateLanIp(ip)) {
      setPrinterFeedback({
        type: 'err',
        text: 'Enter a valid private LAN IPv4 address (10.x, 172.16-31.x, or 192.168.x) before sending a test print.',
      });
      return;
    }
    const key = `${ip}:${port}`;
    setTestingPrinterEndpoint(key);
    try {
      const res = await sendThermalTestPrint({
        ip,
        port,
        paperWidthMm: printerForm.paperWidthMm,
        printerName: targetName ?? (printerForm.printerName.trim() || undefined),
        terminalName: currentDeviceRecord?.device_name || browserSummary,
        hardwareUuid: currentHardwareUuid,
      });
      setPrinterFeedback({ type: 'ok', text: res.message || `Sent ${res.bytesSent} ESC/POS test bytes to ${key}.` });
    } catch (e: any) {
      setPrinterFeedback({ type: 'err', text: e.message || `Test print failed for ${key}.` });
    } finally {
      setTestingPrinterEndpoint(null);
    }
  };

  const handleSavePrinterMapping = async (e: React.FormEvent) => {
    e.preventDefault();
    setPrinterFeedback(null);
    const activeConnType: PrinterConnectionType = printerConnectionTab;

    if (activeConnType === 'BLUETOOTH') {
      const cleanBtId = printerForm.btDeviceId.trim().slice(0, 160);
      if (!cleanBtId) {
        setPrinterFeedback({
          type: 'err',
          text: 'Scan a Bluetooth printer or enter its paired Bluetooth Device ID / MAC address first.',
        });
        return;
      }
      const cleanName = (printerForm.printerName.trim() || 'Bluetooth Thermal Printer').slice(0, 120);
      const cleanService = printerForm.btServiceUuid.trim().slice(0, 128) || undefined;
      const cleanChar = printerForm.btCharacteristicUuid.trim().slice(0, 128) || undefined;

      setSavingPrinter(true);
      try {
        if (currentDeviceRecord && currentDeviceRecord.status === 'AUTHORIZED') {
          await apiFetch('/settings/devices/current-printer', {
            method: 'POST',
            body: JSON.stringify({
              hardwareUuid: currentHardwareUuid,
              printerConnectionType: 'BLUETOOTH',
              printerName: cleanName,
              printerBtDeviceId: cleanBtId,
              printerBtServiceUuid: cleanService || null,
              printerBtCharacteristicUuid: cleanChar || null,
              printerPaperWidthMm: printerForm.paperWidthMm,
              printerAutoPrint: printerForm.autoPrint,
            }),
          });
          saveTerminalPrinterConfig({
            connectionType: 'BLUETOOTH',
            printerName: cleanName,
            btDeviceId: cleanBtId,
            btServiceUuid: cleanService,
            btCharacteristicUuid: cleanChar,
            paperWidthMm: printerForm.paperWidthMm,
            autoPrint: printerForm.autoPrint,
            hardwareUuid: currentHardwareUuid,
          });
          setPrinterFeedback({
            type: 'ok',
            text: `Mapped Bluetooth printer "${cleanName}" to terminal "${currentDeviceRecord.device_name}".`,
          });
          await load();
        } else if (currentDeviceRecord && currentDeviceRecord.status === 'REVOKED') {
          setPrinterFeedback({
            type: 'err',
            text: 'This Terminal device is revoked. Re-authorize it before mapping a thermal printer.',
          });
        } else {
          saveTerminalPrinterConfig({
            connectionType: 'BLUETOOTH',
            printerName: cleanName,
            btDeviceId: cleanBtId,
            btServiceUuid: cleanService,
            btCharacteristicUuid: cleanChar,
            paperWidthMm: printerForm.paperWidthMm,
            autoPrint: printerForm.autoPrint,
            hardwareUuid: currentHardwareUuid,
          });
          setPrinterFeedback({
            type: 'ok',
            text: `Saved Bluetooth printer "${cleanName}" to this browser. Pair this tablet's UUID in Settings to sync across cloud sessions.`,
          });
        }
      } catch (e: any) {
        setPrinterFeedback({ type: 'err', text: e.message || 'Unable to save Bluetooth printer mapping.' });
      } finally {
        setSavingPrinter(false);
      }
      return;
    }

    const cleanIp = printerForm.printerIp.trim();
    if (!isValidPrivateLanIp(cleanIp)) {
      setPrinterFeedback({
        type: 'err',
        text: 'Printer IP must be a private LAN IPv4 address (e.g. 192.168.1.88, 10.0.1.50).',
      });
      return;
    }
    const cleanPort = [9100, 9101, 9102].includes(Number(printerForm.printerPort)) ? Number(printerForm.printerPort) : 9100;
    const cleanName = printerForm.printerName.trim() || `Thermal Printer (${cleanIp})`;

    setSavingPrinter(true);
    try {
      if (currentDeviceRecord && currentDeviceRecord.status === 'AUTHORIZED') {
        await apiFetch('/settings/devices/current-printer', {
          method: 'POST',
          body: JSON.stringify({
            hardwareUuid: currentHardwareUuid,
            printerConnectionType: 'NETWORK',
            printerName: cleanName,
            printerIp: cleanIp,
            printerPort: cleanPort,
            printerPaperWidthMm: printerForm.paperWidthMm,
            printerAutoPrint: printerForm.autoPrint,
          }),
        });
        saveTerminalPrinterConfig({
          connectionType: 'NETWORK',
          printerName: cleanName,
          printerIp: cleanIp,
          printerPort: cleanPort,
          paperWidthMm: printerForm.paperWidthMm,
          autoPrint: printerForm.autoPrint,
          hardwareUuid: currentHardwareUuid,
        });
        setPrinterFeedback({
          type: 'ok',
          text: `Mapped "${cleanName}" (${cleanIp}:${cleanPort}) to terminal "${currentDeviceRecord.device_name}".`,
        });
        await load();
      } else if (currentDeviceRecord && currentDeviceRecord.status === 'REVOKED') {
        setPrinterFeedback({
          type: 'err',
          text: 'This Terminal device is revoked. Re-authorize it before mapping a thermal printer.',
        });
      } else {
        saveTerminalPrinterConfig({
          connectionType: 'NETWORK',
          printerName: cleanName,
          printerIp: cleanIp,
          printerPort: cleanPort,
          paperWidthMm: printerForm.paperWidthMm,
          autoPrint: printerForm.autoPrint,
          hardwareUuid: currentHardwareUuid,
        });
        setPrinterFeedback({
          type: 'ok',
          text: `Saved "${cleanName}" (${cleanIp}:${cleanPort}) to this browser. Pair this tablet's UUID in Settings to sync across cloud sessions.`,
        });
      }
    } catch (e: any) {
      setPrinterFeedback({ type: 'err', text: e.message || 'Unable to save thermal printer mapping.' });
    } finally {
      setSavingPrinter(false);
    }
  };

  const handleUnmapPrinter = async () => {
    setPrinterFeedback(null);
    setSavingPrinter(true);
    try {
      if (currentDeviceRecord && currentDeviceRecord.status === 'AUTHORIZED') {
        await apiFetch('/settings/devices/current-printer', {
          method: 'POST',
          body: JSON.stringify({
            hardwareUuid: currentHardwareUuid,
            clearPrinter: true,
          }),
        });
      }
      clearTerminalPrinterConfig();
      setPrinterForm((prev) => ({
        connectionType: printerConnectionTab,
        printerName: '',
        printerIp: '',
        printerPort: 9100,
        btDeviceId: '',
        btServiceUuid: '',
        btCharacteristicUuid: '',
        paperWidthMm: prev.paperWidthMm,
        autoPrint: true,
      }));
      setPrinterFeedback({ type: 'ok', text: 'Unmapped thermal receipt printer from this terminal hardware.' });
      await load();
    } catch (e: any) {
      setPrinterFeedback({ type: 'err', text: e.message || 'Unable to unmap thermal printer.' });
    } finally {
      setSavingPrinter(false);
    }
  };

  const usersList = data?.users || [];
  const activeUsersCount = usersList.filter((u) => u.is_active === 1).length;
  const adminUsersCount = usersList.filter((u) => u.role_code === 'SUPER_ADMIN' || u.role_code === 'BUSINESS_OWNER').length;
  const pinEnabledCount = usersList.filter((u) => Boolean(u.has_pin)).length;
  const lockedUsersCount = usersList.filter((u) => Boolean(u.is_locked)).length;

  const devicesList = devicesData?.devices || [];
  const authorizedDevicesCount = devicesList.filter((d) => d.status === 'AUTHORIZED').length;
  const revokedDevicesCount = devicesList.filter((d) => d.status === 'REVOKED').length;
  const savedLocalPrinter = getSavedTerminalPrinterConfig();
  const cloudMapped = currentDeviceRecord ? printerMappingFromDeviceRow(currentDeviceRecord, currentDeviceRecord.hardware_uuid) : null;
  const activeMappedPrinter = cloudMapped
    ? { ...cloudMapped, syncedToCloud: true }
    : savedLocalPrinter
      ? { ...savedLocalPrinter, syncedToCloud: false }
      : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 dark:text-slate-50 flex items-center gap-2">
            {activeSection === 'users' ? (
              <>
                <Shield className="w-5 h-5 text-slate-700 dark:text-slate-200" />
                User Control &amp; Role Permissions
              </>
            ) : (
              <>
                <Tablet className="w-5 h-5 text-slate-700 dark:text-slate-200" />
                {canManageAllDevices ? 'Device Pairing & Thermal Printers' : 'Terminal Hardware & Receipt Printer'}
              </>
            )}
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {activeSection === 'users'
              ? 'Exclusive to Company Owner & Super Admin · Manage login credentials, Operator Shift PINs, lockouts, and role avatars'
              : canManageAllDevices
                ? 'Link POS tablets by hardware UUID and scan/map networked ESC/POS thermal receipt printers'
                : 'Scan your local network and map a networked ESC/POS thermal receipt printer to this POS terminal'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canManageUsers && (
            <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-1">
              <button
                type="button"
                onClick={() => {
                  setErr('');
                  setMsg('');
                  setActiveSection('users');
                }}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                  activeSection === 'users' ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950' : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <Shield className="w-3.5 h-3.5" /> System Users ({usersList.length})
              </button>
              <button
                type="button"
                onClick={() => {
                  setErr('');
                  setMsg('');
                  setActiveSection('devices');
                }}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                  activeSection === 'devices' ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950' : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <Tablet className="w-3.5 h-3.5" /> Devices &amp; Printers ({devicesList.length})
              </button>
            </div>
          )}

          {activeSection === 'users' && canManageUsers ? (
            <button
              type="button"
              onClick={openCreateUser}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-4 py-2 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white whitespace-nowrap shrink-0"
            >
              <Plus className="w-4 h-4" /> Add System User
            </button>
          ) : canManageAllDevices ? (
            <button
              type="button"
              onClick={() => openPairModal(false)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-4 py-2 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white whitespace-nowrap shrink-0"
            >
              <Plus className="w-4 h-4" /> Pair POS Device
            </button>
          ) : null}
        </div>
      </div>

      {msg && <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/45 border border-emerald-200 dark:border-emerald-700/80 text-xs text-emerald-800 dark:text-emerald-300 font-medium">{msg}</div>}
      {err && !userModal && !deviceModal && (
        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">{err}</div>
      )}

      {/* Terminal Display & Outdoor Sunlight High-Contrast Preferences */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50">
            Terminal Display &amp; Outdoor Contrast
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Switch between Light and Dark mode for night service, or enable Outdoor High Contrast for bright food truck sunlight.
          </p>
        </div>
        <ThemeToggle variant="full" />
      </div>

      {activeSection === 'users' && canManageUsers && data && (
        <>
          {/* Summary Metrics */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">System Users</p>
              <p className="mt-1 font-mono tabular-nums text-2xl font-semibold text-slate-900 dark:text-slate-50">{usersList.length}</p>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{activeUsersCount} active accounts</p>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Owner &amp; Super Admins</p>
              <p className="mt-1 font-mono tabular-nums text-2xl font-semibold text-slate-900 dark:text-slate-50">{adminUsersCount}</p>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Privileged control access</p>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Shift PIN Enabled</p>
              <p className="mt-1 font-mono tabular-nums text-2xl font-semibold text-slate-900 dark:text-slate-50">{pinEnabledCount}</p>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Ready for truck keypad login</p>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Locked Accounts</p>
              <p className={`mt-1 font-mono tabular-nums text-2xl font-semibold ${lockedUsersCount > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-slate-900 dark:text-slate-50'}`}>
                {lockedUsersCount}
              </p>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                {lockedUsersCount > 0 ? '5-attempt lockout triggered' : 'No security lockouts'}
              </p>
            </div>
          </div>

      {/* System Users Table */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <UserCheck className="w-4 h-4 text-slate-700 dark:text-slate-200" />
            <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">Configured System Users ({data.users.length})</span>
          </div>
          <span className="text-[11px] text-slate-500 dark:text-slate-400">Role-Based Access Control (RBAC) &amp; Shift PIN Access</span>
        </div>
        <table className="w-full text-left text-xs">
          <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
            <tr>
              <th className="p-3 font-medium">User</th>
              <th className="p-3 font-medium">Role</th>
              <th className="p-3 font-medium">Assigned Location</th>
              <th className="p-3 font-medium">Terminal Access</th>
              <th className="p-3 font-medium">Status</th>
              <th className="p-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {data.users.map((u) => (
              <tr key={u.id} className="hover:bg-slate-50 dark:hover:bg-slate-800">
                <td className="p-3">
                  <div className="flex items-center gap-3">
                    <AvatarBadge name={u.full_name} src={u.avatar_url} />
                    <div>
                      <p className="font-semibold text-slate-900 dark:text-slate-50">{u.full_name}</p>
                      <p className="font-mono text-[11px] text-slate-500 dark:text-slate-400">{u.email}</p>
                    </div>
                  </div>
                </td>
                <td className="p-3">
                  <p className="font-medium text-slate-800 dark:text-slate-100">{u.role_name}</p>
                  <p className="font-mono text-[11px] text-slate-500 dark:text-slate-400">{u.role_code}</p>
                </td>
                <td className="p-3 text-slate-600 dark:text-slate-300">{u.location_name || 'All Locations'}</td>
                <td className="p-3">
                  <span
                    className={`inline-flex items-center gap-1 font-medium ${
                      u.has_pin ? 'text-slate-900 dark:text-slate-50' : 'text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    <KeyRound className={`w-3.5 h-3.5 ${u.has_pin ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400'}`} />
                    {u.has_pin ? 'Shift PIN + Password' : 'Password Only'}
                  </span>
                </td>
                <td className="p-3">
                  <div className="space-y-0.5">
                    <span className={u.is_active === 1 ? 'font-semibold text-emerald-700 dark:text-emerald-300' : 'font-semibold text-red-600 dark:text-red-300'}>
                      {u.is_active === 1 ? 'ACTIVE' : 'DISABLED'}
                    </span>
                    {u.is_locked && (
                      <p className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
                        <Lock className="w-3 h-3" /> LOCKED
                      </p>
                    )}
                  </div>
                </td>
                <td className="p-3 text-right">
                  <div className="inline-flex items-center justify-end gap-1.5">
                    {u.is_locked && (
                      <button
                        type="button"
                        disabled={unlockingId === u.id}
                        onClick={() => handleQuickUnlock(u)}
                        className="inline-flex items-center gap-1 rounded-lg border border-amber-300 dark:border-amber-700/80 bg-amber-50 dark:bg-amber-950/45 px-2.5 py-1.5 text-xs font-medium text-amber-800 dark:text-amber-300 hover:bg-amber-100 whitespace-nowrap shrink-0"
                      >
                        <Unlock className="w-3.5 h-3.5" />
                        {unlockingId === u.id ? 'Unlocking...' : 'Unlock'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => openEditUser(u)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                    >
                      <Pencil className="w-3.5 h-3.5" /> Edit / PIN
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
        </>
      )}

      {activeSection === 'devices' && (
        <>
          {/* Current Tablet / Browser Hardware Identity Card */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div className="space-y-1.5 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Monitor className="w-4 h-4 text-slate-700 dark:text-slate-200 shrink-0" />
                <span className="text-xs font-semibold text-slate-900 dark:text-slate-50">This Device&apos;s Hardware UUID</span>
                {currentDeviceRecord ? (
                  <span
                    className={`rounded-md px-2 py-0.5 text-[11px] font-semibold border ${
                      currentDeviceRecord.status === 'AUTHORIZED'
                        ? 'bg-emerald-50 dark:bg-emerald-950/45 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-700/80'
                        : 'bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800/80'
                    }`}
                  >
                    {currentDeviceRecord.status === 'AUTHORIZED' ? 'REGISTERED · AUTHORIZED' : 'REVOKED'}
                  </span>
                ) : (
                  <span className="rounded-md px-2 py-0.5 text-[11px] font-semibold border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-600 dark:text-slate-300">
                    NOT REGISTERED
                  </span>
                )}
                {localTerminalMode && localTerminalStatus?.devicePaired && (
                  <span className="rounded-md px-2 py-0.5 text-[11px] font-semibold border border-slate-300 dark:border-slate-700 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950">
                    TERMINAL MODE ACTIVE
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <code className="font-mono text-xs text-slate-800 dark:text-slate-100 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg px-2.5 py-1 break-all">
                  {currentHardwareUuid}
                </code>
                <button
                  type="button"
                  onClick={handleCopyHardwareUuid}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                >
                  {copiedUuid ? <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedUuid ? 'Copied' : 'Copy UUID'}
                </button>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Detected platform: <span className="font-medium text-slate-700 dark:text-slate-200">{browserSummary}</span>
                {currentDeviceRecord?.location_name ? ` · Assigned to ${currentDeviceRecord.location_name}` : ''}
              </p>

              {/* Active Receipt Printer Summary Strip */}
              <div className="pt-1 flex flex-wrap items-center gap-2">
                {activeMappedPrinter ? (
                  <div className="inline-flex flex-wrap items-center gap-2 rounded-lg border border-emerald-200 dark:border-emerald-700/80 bg-emerald-50/70 dark:bg-emerald-950/45 px-2.5 py-1.5 text-xs">
                    {activeMappedPrinter.connectionType === 'BLUETOOTH' ? (
                      <Bluetooth className="w-3.5 h-3.5 text-blue-700 dark:text-blue-300 shrink-0" />
                    ) : (
                      <Printer className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-300 shrink-0" />
                    )}
                    <span className="font-semibold text-emerald-950 dark:text-emerald-200">{activeMappedPrinter.printerName}</span>
                    <span className="font-mono text-[11px] text-emerald-800 dark:text-emerald-300">
                      {activeMappedPrinter.connectionType === 'BLUETOOTH'
                        ? `BT · ${activeMappedPrinter.btDeviceId?.slice(0, 14) || 'Paired'}`
                        : `${activeMappedPrinter.printerIp}:${activeMappedPrinter.printerPort || 9100}`}
                    </span>
                    <span className="rounded border border-emerald-300 dark:border-emerald-700/80 bg-white dark:bg-slate-900 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 dark:text-emerald-300">
                      {activeMappedPrinter.paperWidthMm}mm
                    </span>
                    {activeMappedPrinter.autoPrint && (
                      <span className="rounded border border-emerald-300 dark:border-emerald-700/80 bg-white dark:bg-slate-900 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 dark:text-emerald-300">
                        Auto-Print
                      </span>
                    )}
                    <span className="text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                      {activeMappedPrinter.syncedToCloud ? 'Cloud Synced' : 'Browser Local'}
                    </span>
                  </div>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 px-2.5 py-1 text-[11px] text-slate-600 dark:text-slate-300">
                    <Printer className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
                    No thermal receipt printer mapped to this terminal yet
                  </span>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {activeMappedPrinter && (
                <>
                  <button
                    type="button"
                    disabled={
                      activeMappedPrinter.connectionType === 'BLUETOOTH'
                        ? testingPrinterEndpoint === `bt:${activeMappedPrinter.btDeviceId}`
                        : testingPrinterEndpoint === `${activeMappedPrinter.printerIp}:${activeMappedPrinter.printerPort}`
                    }
                    onClick={() => {
                      if (activeMappedPrinter.connectionType === 'BLUETOOTH') {
                        void handleBluetoothTestPrint({
                          btDeviceId: activeMappedPrinter.btDeviceId,
                          btServiceUuid: activeMappedPrinter.btServiceUuid,
                          btCharacteristicUuid: activeMappedPrinter.btCharacteristicUuid,
                          printerName: activeMappedPrinter.printerName,
                        });
                      } else {
                        void handleTestPrint(
                          activeMappedPrinter.printerIp,
                          activeMappedPrinter.printerPort,
                          activeMappedPrinter.printerName,
                        );
                      }
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap disabled:opacity-50"
                  >
                    <Send className="w-3.5 h-3.5" />
                    {testingPrinterEndpoint ? 'Testing...' : 'Test Print'}
                  </button>
                  <button
                    type="button"
                    disabled={savingPrinter}
                    onClick={() => void handleUnmapPrinter()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 dark:border-red-800/80 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-semibold text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/70 whitespace-nowrap disabled:opacity-50"
                  >
                    <Unlink className="w-3.5 h-3.5" /> Unmap
                  </button>
                </>
              )}

              {canManageAllDevices && (
                !currentDeviceRecord ? (
                  <button
                    type="button"
                    onClick={() => openPairModal(true)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-3.5 py-2 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white whitespace-nowrap"
                  >
                    <ShieldCheck className="w-4 h-4" /> Pair This Tablet
                  </button>
                ) : currentDeviceRecord.status === 'REVOKED' ? (
                  <button
                    type="button"
                    onClick={() => openReauthorizeModal(currentDeviceRecord)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-800 whitespace-nowrap"
                  >
                    <RefreshCw className="w-4 h-4" /> Re-Authorize This Device
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => openEditDeviceModal(currentDeviceRecord)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                  >
                    <Pencil className="w-3.5 h-3.5" /> Configure This Register
                  </button>
                )
              )}
            </div>
          </div>

          {/* Thermal Receipt Printers (Bluetooth & Network LAN) Discovery & Terminal Mapping Panel */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 bg-slate-50/60 dark:bg-slate-800/60">
              <div className="flex items-center gap-2">
                {printerConnectionTab === 'BLUETOOTH' ? (
                  <Bluetooth className="w-4 h-4 text-blue-700 dark:text-blue-300" />
                ) : (
                  <Printer className="w-4 h-4 text-slate-800 dark:text-slate-100" />
                )}
                <div>
                  <h2 className="text-xs font-semibold text-slate-900 dark:text-slate-50">
                    Thermal Receipt Printers ({printerConnectionTab === 'BLUETOOTH' ? 'Bluetooth BLE · ESC/POS' : 'Network LAN · TCP/IP'})
                  </h2>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    {printerConnectionTab === 'BLUETOOTH'
                      ? 'Scan & pair portable Bluetooth thermal printers directly from this tablet/register and map to this terminal'
                      : 'Scan your counter or food truck router subnet (ports 9100–9102) and map a printer to this terminal hardware'}
                  </p>
                </div>
              </div>

              <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-0.5">
                <button
                  type="button"
                  onClick={() => {
                    setPrinterFeedback(null);
                    setPrinterConnectionTab('BLUETOOTH');
                    setPrinterForm((f) => ({ ...f, connectionType: 'BLUETOOTH' }));
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                    printerConnectionTab === 'BLUETOOTH'
                      ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950'
                      : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  <Bluetooth className="w-3.5 h-3.5" /> Bluetooth Printers
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPrinterFeedback(null);
                    setPrinterConnectionTab('NETWORK');
                    setPrinterForm((f) => ({ ...f, connectionType: 'NETWORK' }));
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                    printerConnectionTab === 'NETWORK'
                      ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950'
                      : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  <Wifi className="w-3.5 h-3.5" /> Network (LAN IP)
                </button>
              </div>
            </div>

            <div className="p-4 space-y-4">
              {printerConnectionTab === 'BLUETOOTH' && btCapabilities && !btCapabilities.supported && (
                <div className="rounded-lg border border-amber-200 dark:border-amber-700/80 bg-amber-50 dark:bg-amber-950/45 px-3 py-2 text-[11px] text-amber-900 dark:text-amber-300 flex items-start gap-2">
                  <Bluetooth className="w-4 h-4 text-amber-700 dark:text-amber-300 shrink-0 mt-0.5" />
                  <span>{btCapabilities.reason}</span>
                </div>
              )}

              {printerConnectionTab === 'NETWORK' && subnetInfo?.cloudNetworkNote && (
                <div className="rounded-lg border border-amber-200 dark:border-amber-700/80 bg-amber-50 dark:bg-amber-950/45 px-3 py-2 text-[11px] text-amber-900 dark:text-amber-300 flex items-start gap-2">
                  <Wifi className="w-4 h-4 text-amber-700 dark:text-amber-300 shrink-0 mt-0.5" />
                  <span>{subnetInfo.cloudNetworkNote}</span>
                </div>
              )}

              {printerFeedback && (
                <div
                  className={`rounded-lg border px-3 py-2 text-xs font-medium flex items-start gap-2 ${
                    printerFeedback.type === 'ok'
                      ? 'border-emerald-200 dark:border-emerald-700/80 bg-emerald-50 dark:bg-emerald-950/45 text-emerald-900 dark:text-emerald-300'
                      : 'border-red-200 dark:border-red-800/80 bg-red-50 dark:bg-red-950/50 text-red-800 dark:text-red-300'
                  }`}
                >
                  {printerFeedback.type === 'ok' ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-700 dark:text-emerald-300 shrink-0 mt-0.5" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-300 shrink-0 mt-0.5" />
                  )}
                  <span>{printerFeedback.text}</span>
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                {/* Left Column: Discovery (Bluetooth OR Network) */}
                {printerConnectionTab === 'BLUETOOTH' ? (
                  <div className="lg:col-span-7 space-y-3">
                    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/70 p-3 flex flex-wrap items-center justify-between gap-3">
                      <div className="space-y-0.5">
                        <p className="text-xs font-semibold text-slate-900 dark:text-slate-50">Bluetooth Thermal Printer Discovery</p>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400">
                          Supports portable BLE ESC/POS printers (Epson TM-P, Star SM-L, Bixolon, Xprinter, Goojprt, Munbyn, Rongta)
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={scanningBluetooth}
                          onClick={() => void handleScanBluetoothPrinters()}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-3.5 py-2 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50 whitespace-nowrap"
                        >
                          <Bluetooth className="w-3.5 h-3.5" />
                          {scanningBluetooth ? 'Scanning Nearby...' : 'Scan & Pair Bluetooth'}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleRefreshPairedBluetooth()}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
                        >
                          <RefreshCw className="w-3.5 h-3.5" /> Check Paired
                        </button>
                      </div>
                    </div>

                    <div className="rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden">
                      <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 flex items-center justify-between text-[11px]">
                        <span className="font-semibold text-slate-700 dark:text-slate-200">
                          Discovered Bluetooth Printers ({discoveredBtPrinters.length})
                        </span>
                        <span className="text-slate-500 dark:text-slate-400">Web Bluetooth GATT ESC/POS</span>
                      </div>
                      {discoveredBtPrinters.length === 0 ? (
                        <div className="p-5 text-center space-y-1.5">
                          <Bluetooth className="w-6 h-6 text-slate-400 dark:text-slate-500 mx-auto" />
                          <p className="text-xs font-medium text-slate-700 dark:text-slate-200">No Bluetooth printers discovered in this session</p>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                            Power on your Bluetooth thermal printer, click <span className="font-semibold">Scan &amp; Pair Bluetooth</span> to discover nearby printers, or enter an already paired printer ID on the right.
                          </p>
                        </div>
                      ) : (
                        <div className="divide-y divide-slate-100 dark:divide-slate-800">
                          {discoveredBtPrinters.map((bt) => {
                            const endpointKey = `bt:${bt.btDeviceId}`;
                            const isMapped =
                              activeMappedPrinter?.connectionType === 'BLUETOOTH' &&
                              activeMappedPrinter.btDeviceId === bt.btDeviceId;
                            return (
                              <div key={bt.btDeviceId} className="p-3 flex flex-wrap items-center justify-between gap-2 hover:bg-slate-50 dark:hover:bg-slate-800">
                                <div className="space-y-0.5 min-w-0">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="text-xs font-semibold text-slate-900 dark:text-slate-50">{bt.name}</span>
                                    <span
                                      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold border ${
                                        bt.writableReady
                                          ? 'bg-emerald-50 dark:bg-emerald-950/45 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-700/80'
                                          : bt.connected
                                            ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-700/80'
                                            : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-800'
                                      }`}
                                    >
                                      {bt.writableReady ? 'GATT ESC/POS Ready' : bt.connected ? 'Connected' : 'Paired'}
                                    </span>
                                    {isMapped && (
                                      <span className="rounded bg-slate-900 dark:bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-white dark:text-slate-950">
                                        MAPPED HERE
                                      </span>
                                    )}
                                  </div>
                                  <p className="font-mono text-[11px] text-slate-500 dark:text-slate-400 truncate max-w-md">
                                    ID: {bt.btDeviceId}
                                    {bt.btCharacteristicUuid ? ` · Char: ${bt.btCharacteristicUuid.slice(0, 8)}` : ''}
                                  </p>
                                  <p className="text-[11px] text-slate-500 dark:text-slate-400">{bt.statusSummary}</p>
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  {!bt.writableReady && (
                                    <button
                                      type="button"
                                      disabled={reconnectingBtId === bt.btDeviceId}
                                      onClick={() => void handleReconnectBluetooth(bt)}
                                      className="inline-flex items-center gap-1 rounded-md border border-blue-200 dark:border-blue-700/80 bg-blue-50 dark:bg-blue-950/50 px-2.5 py-1 text-[11px] font-medium text-blue-800 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/60 disabled:opacity-50"
                                    >
                                      <RefreshCw className="w-3 h-3" />
                                      {reconnectingBtId === bt.btDeviceId ? 'Connecting...' : 'Connect'}
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    disabled={testingPrinterEndpoint === endpointKey}
                                    onClick={() =>
                                      void handleBluetoothTestPrint({
                                        btDeviceId: bt.btDeviceId,
                                        btServiceUuid: bt.btServiceUuid || undefined,
                                        btCharacteristicUuid: bt.btCharacteristicUuid || undefined,
                                        printerName: bt.name,
                                      })
                                    }
                                    className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
                                  >
                                    <Send className="w-3 h-3" />
                                    {testingPrinterEndpoint === endpointKey ? 'Printing...' : 'Test'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleSelectDiscoveredBtPrinter(bt)}
                                    className="inline-flex items-center gap-1 rounded-md bg-slate-900 dark:bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white"
                                  >
                                    Select
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="lg:col-span-7 space-y-3">
                    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/70 p-3 space-y-3">
                      <div className="flex flex-wrap items-end gap-2">
                        <div className="flex-1 min-w-[180px]">
                          <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
                            Target Private LAN Subnet (CIDR) or Single IP
                          </label>
                          <input
                            type="text"
                            value={scanTarget}
                            onChange={(e) => setScanTarget(e.target.value)}
                            placeholder="e.g. 192.168.1.0/24 or 192.168.1.88"
                            className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-mono"
                          />
                        </div>
                        <div className="w-28">
                          <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">TCP Port</label>
                          <select
                            value={scanPort}
                            onChange={(e) => setScanPort(Number(e.target.value))}
                            className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-mono"
                          >
                            <option value={9100}>9100 (Raw)</option>
                            <option value={9101}>9101</option>
                            <option value={9102}>9102</option>
                          </select>
                        </div>
                        <button
                          type="button"
                          disabled={scanningPrinters}
                          onClick={() => void handleScanPrinters()}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-3.5 py-1.5 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50 whitespace-nowrap"
                        >
                          <Search className="w-3.5 h-3.5" />
                          {scanningPrinters ? 'Scanning...' : 'Scan Network'}
                        </button>
                        <button
                          type="button"
                          disabled={probingPrinter}
                          onClick={() => void handleProbeSingleIp()}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
                        >
                          <Wifi className="w-3.5 h-3.5" />
                          {probingPrinter ? 'Probing...' : 'Probe IP'}
                        </button>
                      </div>
                      {subnetInfo && subnetInfo.detectedSubnets.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px] text-slate-500 dark:text-slate-400">Detected LAN:</span>
                          {subnetInfo.detectedSubnets.map((cidr) => (
                            <button
                              key={cidr}
                              type="button"
                              onClick={() => setScanTarget(cidr)}
                              className={`rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors ${
                                scanTarget === cidr
                                  ? 'border-slate-900 dark:border-slate-100 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950'
                                  : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                              }`}
                            >
                              {cidr}
                            </button>
                          ))}
                        </div>
                      )}
                      {scanResult && (
                        <p className="text-[11px] text-slate-500 dark:text-slate-400">
                          Last scan: <span className="font-mono text-slate-700 dark:text-slate-200">{scanResult.targetDescription}</span> ·{' '}
                          {scanResult.scannedHosts} hosts checked in {scanResult.durationMs}ms
                        </p>
                      )}
                    </div>

                    {/* Discovered Network Printers List */}
                    <div className="rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden">
                      <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 flex items-center justify-between text-[11px]">
                        <span className="font-semibold text-slate-700 dark:text-slate-200">
                          Discovered Network Printers ({discoveredPrinters.length})
                        </span>
                        <span className="text-slate-500 dark:text-slate-400">ESC/POS Raw Socket (DLE EOT)</span>
                      </div>
                      {discoveredPrinters.length === 0 ? (
                        <div className="p-5 text-center space-y-1.5">
                          <Printer className="w-6 h-6 text-slate-400 dark:text-slate-500 mx-auto" />
                          <p className="text-xs font-medium text-slate-700 dark:text-slate-200">No discovered printers in current scan</p>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                            Run <span className="font-semibold">Scan Network</span> on your local store LAN or enter a printer&apos;s static LAN IP directly on the right.
                          </p>
                        </div>
                      ) : (
                        <div className="divide-y divide-slate-100 dark:divide-slate-800">
                          {discoveredPrinters.map((p) => {
                            const endpoint = `${p.ip}:${p.port}`;
                            const isMapped =
                              activeMappedPrinter?.connectionType === 'NETWORK' &&
                              activeMappedPrinter.printerIp === p.ip &&
                              activeMappedPrinter.printerPort === p.port;
                            return (
                              <div key={endpoint} className="p-3 flex flex-wrap items-center justify-between gap-2 hover:bg-slate-50 dark:hover:bg-slate-800">
                                <div className="space-y-0.5 min-w-0">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="font-mono text-xs font-semibold text-slate-900 dark:text-slate-50">{endpoint}</span>
                                    <span
                                      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold border ${
                                        p.escPosDetected
                                          ? 'bg-emerald-50 dark:bg-emerald-950/45 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-700/80'
                                          : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-800'
                                      }`}
                                    >
                                      {p.escPosDetected ? 'ESC/POS Ready' : 'TCP 9100 Open'}
                                    </span>
                                    {isMapped && (
                                      <span className="rounded bg-slate-900 dark:bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-white dark:text-slate-950">
                                        MAPPED HERE
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                                    {p.statusSummary} · {p.latencyMs}ms · {p.protocol}
                                  </p>
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <button
                                    type="button"
                                    disabled={testingPrinterEndpoint === endpoint}
                                    onClick={() => void handleTestPrint(p.ip, p.port, p.suggestedName)}
                                    className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
                                  >
                                    <Send className="w-3 h-3" />
                                    {testingPrinterEndpoint === endpoint ? 'Printing...' : 'Test'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleSelectDiscoveredPrinter(p)}
                                    className="inline-flex items-center gap-1 rounded-md bg-slate-900 dark:bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white"
                                  >
                                    Select
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Right Column: Map Printer to Current Terminal Hardware */}
                <form onSubmit={handleSavePrinterMapping} className="lg:col-span-5 rounded-lg border border-slate-200 dark:border-slate-800 p-3.5 space-y-3 bg-white dark:bg-slate-900">
                  <div className="border-b border-slate-100 dark:border-slate-800/80 pb-2">
                    <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-50">
                      Map {printerConnectionTab === 'BLUETOOTH' ? 'Bluetooth' : 'Network'} Printer to Current Terminal
                    </h3>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      Target Hardware:{' '}
                      <span className="font-mono text-slate-700 dark:text-slate-200">
                        {currentDeviceRecord ? currentDeviceRecord.device_name : currentHardwareUuid.slice(0, 14) + '...'}
                      </span>
                    </p>
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">Printer Label</label>
                    <input
                      type="text"
                      maxLength={120}
                      placeholder={
                        printerConnectionTab === 'BLUETOOTH'
                          ? 'e.g. Truck 01 Bluetooth PT-210'
                          : 'e.g. Front Counter Epson TM-T82'
                      }
                      value={printerForm.printerName}
                      onChange={(e) => setPrinterForm({ ...printerForm, printerName: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-1.5 text-xs"
                    />
                  </div>

                  {printerConnectionTab === 'BLUETOOTH' ? (
                    <div className="space-y-2.5">
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
                          Bluetooth Device ID / Paired MAC
                        </label>
                        <input
                          type="text"
                          required
                          maxLength={160}
                          placeholder="Auto-filled via Scan & Pair or enter BT ID / MAC"
                          value={printerForm.btDeviceId}
                          onChange={(e) => setPrinterForm({ ...printerForm, btDeviceId: e.target.value })}
                          className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-1.5 text-xs font-mono"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
                            GATT Service UUID <span className="font-normal text-slate-500 dark:text-slate-400">(opt.)</span>
                          </label>
                          <input
                            type="text"
                            maxLength={128}
                            placeholder="000018f0-..."
                            value={printerForm.btServiceUuid}
                            onChange={(e) => setPrinterForm({ ...printerForm, btServiceUuid: e.target.value })}
                            className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-1.5 text-[11px] font-mono"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">
                            Write Char UUID <span className="font-normal text-slate-500 dark:text-slate-400">(opt.)</span>
                          </label>
                          <input
                            type="text"
                            maxLength={128}
                            placeholder="00002af1-..."
                            value={printerForm.btCharacteristicUuid}
                            onChange={(e) => setPrinterForm({ ...printerForm, btCharacteristicUuid: e.target.value })}
                            className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-1.5 text-[11px] font-mono"
                          />
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 gap-2">
                      <div className="col-span-2">
                        <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">Private LAN IP</label>
                        <input
                          type="text"
                          required
                          placeholder="192.168.1.88"
                          value={printerForm.printerIp}
                          onChange={(e) => setPrinterForm({ ...printerForm, printerIp: e.target.value })}
                          className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-1.5 text-xs font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">Port</label>
                        <select
                          value={printerForm.printerPort}
                          onChange={(e) => setPrinterForm({ ...printerForm, printerPort: Number(e.target.value) })}
                          className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-2 py-1.5 text-xs font-mono"
                        >
                          <option value={9100}>9100</option>
                          <option value={9101}>9101</option>
                          <option value={9102}>9102</option>
                        </select>
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1">Thermal Paper Roll Width</label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setPrinterForm({ ...printerForm, paperWidthMm: 80 })}
                        className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                          printerForm.paperWidthMm === 80
                            ? 'border-slate-900 dark:border-slate-100 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950'
                            : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800'
                        }`}
                      >
                        80mm (Counter)
                      </button>
                      <button
                        type="button"
                        onClick={() => setPrinterForm({ ...printerForm, paperWidthMm: 58 })}
                        className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                          printerForm.paperWidthMm === 58
                            ? 'border-slate-900 dark:border-slate-100 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950'
                            : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800'
                        }`}
                      >
                        58mm (Mobile Truck)
                      </button>
                    </div>
                  </div>

                  <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-200 cursor-pointer pt-0.5">
                    <input
                      type="checkbox"
                      checked={printerForm.autoPrint}
                      onChange={(e) => setPrinterForm({ ...printerForm, autoPrint: e.target.checked })}
                    />
                    Auto-print ESC/POS receipt immediately after POS checkout
                  </label>

                  {!currentDeviceRecord && (
                    <p className="text-[11px] text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/45 border border-amber-200 dark:border-amber-700/80 rounded-lg px-2.5 py-1.5">
                      This browser&apos;s hardware UUID is not yet paired in Firestore. Saving now stores the printer locally on this terminal; pair the tablet to sync across shifts.
                    </p>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100 dark:border-slate-800/80">
                    {printerConnectionTab === 'BLUETOOTH' ? (
                      <button
                        type="button"
                        disabled={!printerForm.btDeviceId.trim() || testingPrinterEndpoint === `bt:${printerForm.btDeviceId.trim()}`}
                        onClick={() => void handleBluetoothTestPrint()}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
                      >
                        <Send className="w-3.5 h-3.5" /> Test BT Print
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={!printerForm.printerIp.trim() || testingPrinterEndpoint === `${printerForm.printerIp.trim()}:${printerForm.printerPort}`}
                        onClick={() => void handleTestPrint()}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
                      >
                        <Send className="w-3.5 h-3.5" /> Test Print
                      </button>
                    )}
                    <button
                      type="submit"
                      disabled={savingPrinter}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-3.5 py-1.5 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50"
                    >
                      {printerConnectionTab === 'BLUETOOTH' ? (
                        <Bluetooth className="w-3.5 h-3.5" />
                      ) : (
                        <Printer className="w-3.5 h-3.5" />
                      )}
                      {savingPrinter
                        ? 'Saving...'
                        : currentDeviceRecord?.status === 'AUTHORIZED'
                          ? 'Map to This Terminal'
                          : 'Save on This Terminal'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>

          {canManageAllDevices && (
            <>
              {/* Device Metrics */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
                  <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Linked POS Devices</p>
                  <p className="mt-1 font-mono tabular-nums text-2xl font-semibold text-slate-900 dark:text-slate-50">{devicesList.length}</p>
                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Hardware UUIDs on record</p>
                </div>
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
                  <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Authorized Registers</p>
                  <p className="mt-1 font-mono tabular-nums text-2xl font-semibold text-emerald-700 dark:text-emerald-300">{authorizedDevicesCount}</p>
                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Active counter &amp; truck tablets</p>
                </div>
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
                  <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Revoked / Blocked</p>
                  <p className={`mt-1 font-mono tabular-nums text-2xl font-semibold ${revokedDevicesCount > 0 ? 'text-red-600 dark:text-red-300' : 'text-slate-900 dark:text-slate-50'}`}>
                    {revokedDevicesCount}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    {revokedDevicesCount > 0 ? 'Blocked from silent auth' : 'All linked devices active'}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
                  <p className="text-xs font-medium text-slate-500 dark:text-slate-400">TERMINAL_ACCESS_KEY</p>
                  <p className={`mt-1 text-sm font-semibold ${localTerminalStatus?.accessKeyConfigured ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}`}>
                    {localTerminalStatus?.accessKeySource === 'ENV'
                      ? 'ENV KEY ACTIVE'
                      : localTerminalStatus?.accessKeySource === 'SETUP_KEY'
                        ? 'SETUP KEY ACTIVE'
                        : 'NOT SET YET'}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    {localTerminalStatus?.credentialsConfigured
                      ? 'Silent Firebase auth ready'
                      : 'Set TERMINAL_SERVICE_* in env'}
                  </p>
                </div>
              </div>

              {/* Authorized POS Registers Table */}
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
                <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Tablet className="w-4 h-4 text-slate-700 dark:text-slate-200" />
                    <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">Authorized POS Registers ({devicesList.length})</span>
                  </div>
                  <span className="text-[11px] text-slate-500 dark:text-slate-400">Tracked via Hardware UUID &amp; Server Key Verification</span>
                </div>

                {devicesList.length === 0 ? (
                  <div className="p-8 text-center space-y-2">
                    <Tablet className="w-7 h-7 text-slate-400 dark:text-slate-500 mx-auto" />
                    <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">No POS devices registered yet</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                      Link shared counter tablets or food truck registers by registering their hardware UUID with <span className="font-mono">TERMINAL_ACCESS_KEY</span> verification.
                    </p>
                    <div className="pt-2">
                      <button
                        type="button"
                        onClick={() => openPairModal(true)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-3.5 py-2 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white"
                      >
                        <Plus className="w-3.5 h-3.5" /> Pair Current Tablet
                      </button>
                    </div>
                  </div>
                ) : (
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
                      <tr>
                        <th className="p-3 font-medium">POS Register / Hardware UUID</th>
                        <th className="p-3 font-medium">Location &amp; Station</th>
                        <th className="p-3 font-medium">Receipt Printer</th>
                        <th className="p-3 font-medium">Status</th>
                        <th className="p-3 font-medium">Paired By / Last Seen</th>
                        <th className="p-3 font-medium text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {devicesList.map((d) => {
                        const isThisDevice = d.hardware_uuid === currentHardwareUuid;
                        const busy = deviceActionId === d.id;
                        return (
                          <tr key={d.id} className="hover:bg-slate-50 dark:hover:bg-slate-800">
                            <td className="p-3">
                              <div className="space-y-0.5">
                                <div className="flex items-center gap-1.5">
                                  <span className="font-semibold text-slate-900 dark:text-slate-50">{d.device_name}</span>
                                  {isThisDevice && (
                                    <span className="rounded-md bg-slate-900 dark:bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-white dark:text-slate-950">
                                      THIS DEVICE
                                    </span>
                                  )}
                                </div>
                                <p className="font-mono text-[11px] text-slate-500 dark:text-slate-400">{d.hardware_uuid}</p>
                                {d.user_agent_summary && (
                                  <p className="text-[11px] text-slate-500 dark:text-slate-400">{d.user_agent_summary}</p>
                                )}
                              </div>
                            </td>
                            <td className="p-3">
                              <div className="space-y-0.5">
                                <p className="inline-flex items-center gap-1 font-medium text-slate-800 dark:text-slate-100">
                                  <MapPin className="w-3 h-3 text-slate-500 dark:text-slate-400" />
                                  {d.location_name || 'All Locations'}
                                </p>
                                {d.station_email && (
                                  <p className="font-mono text-[11px] text-slate-500 dark:text-slate-400">{d.station_email}</p>
                                )}
                              </div>
                            </td>
                            <td className="p-3">
                              {d.printer_bt_device_id ? (
                                <div className="space-y-0.5">
                                  <p className="inline-flex items-center gap-1 font-medium text-slate-800 dark:text-slate-100">
                                    <Bluetooth className="w-3 h-3 text-blue-600 dark:text-blue-300" />
                                    {d.printer_name || 'Bluetooth Printer'}
                                  </p>
                                  <p className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                                    BT · {d.printer_bt_device_id.slice(0, 12)} · {d.printer_paper_width_mm || 58}mm
                                    {d.printer_auto_print ? ' · Auto' : ''}
                                  </p>
                                </div>
                              ) : d.printer_ip ? (
                                <div className="space-y-0.5">
                                  <p className="inline-flex items-center gap-1 font-medium text-slate-800 dark:text-slate-100">
                                    <Printer className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                                    {d.printer_name || 'Thermal Printer'}
                                  </p>
                                  <p className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                                    {d.printer_ip}:{d.printer_port || 9100} · {d.printer_paper_width_mm || 80}mm
                                    {d.printer_auto_print ? ' · Auto' : ''}
                                  </p>
                                </div>
                              ) : (
                                <span className="text-[11px] text-slate-500 dark:text-slate-400">Not mapped</span>
                              )}
                            </td>
                            <td className="p-3">
                              <span
                                className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold border ${
                                  d.status === 'AUTHORIZED'
                                    ? 'bg-emerald-50 dark:bg-emerald-950/45 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-700/80'
                                    : 'bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800/80'
                                }`}
                              >
                                {d.status === 'AUTHORIZED' ? (
                                  <ShieldCheck className="w-3 h-3" />
                                ) : (
                                  <ShieldAlert className="w-3 h-3" />
                                )}
                                {d.status}
                              </span>
                            </td>
                            <td className="p-3 text-slate-600 dark:text-slate-300">
                              <p className="font-medium text-slate-800 dark:text-slate-100">{d.paired_by_name}</p>
                              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                                Paired {formatTimestamp(d.paired_at)} · Seen {formatTimestamp(d.last_seen_at)}
                              </p>
                            </td>
                            <td className="p-3 text-right">
                              <div className="inline-flex items-center justify-end gap-1.5">
                                {d.status === 'AUTHORIZED' ? (
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => handleRevokeDevice(d)}
                                    className="inline-flex items-center gap-1 rounded-lg border border-amber-300 dark:border-amber-700/80 bg-amber-50 dark:bg-amber-950/45 px-2.5 py-1.5 text-xs font-medium text-amber-800 dark:text-amber-300 hover:bg-amber-100 whitespace-nowrap shrink-0 disabled:opacity-50"
                                  >
                                    <Lock className="w-3.5 h-3.5" />
                                    {busy ? 'Revoking...' : 'Revoke'}
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => openReauthorizeModal(d)}
                                    className="inline-flex items-center gap-1 rounded-lg border border-emerald-300 dark:border-emerald-700/80 bg-emerald-50 dark:bg-emerald-950/45 px-2.5 py-1.5 text-xs font-medium text-emerald-800 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/60 whitespace-nowrap shrink-0 disabled:opacity-50"
                                  >
                                    <RefreshCw className="w-3.5 h-3.5" /> Authorize
                                  </button>
                                )}
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => openEditDeviceModal(d)}
                                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                                >
                                  <Pencil className="w-3.5 h-3.5" /> Edit
                                </button>
                                {confirmRemoveId === d.id ? (
                                  <div className="inline-flex items-center gap-1">
                                    <button
                                      type="button"
                                      disabled={busy}
                                      onClick={() => handleRemoveDevice(d)}
                                      className="rounded-lg bg-red-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-red-700 whitespace-nowrap"
                                    >
                                      Confirm
                                    </button>
                                    <button
                                      type="button"
                                      disabled={busy}
                                      onClick={() => setConfirmRemoveId(null)}
                                      className="rounded-lg border border-slate-200 dark:border-slate-800 px-2 py-1.5 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => setConfirmRemoveId(d.id)}
                                    className="inline-flex items-center gap-1 rounded-lg border border-red-200 dark:border-red-800/80 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/70 whitespace-nowrap shrink-0"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" /> Remove
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </>
      )}

      {/* User Create / Edit Modal */}
      {userModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form onSubmit={submitUser} className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl bg-white dark:bg-slate-900 p-5 space-y-4 border border-slate-200 dark:border-slate-800">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800/80 pb-3">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">
                  {userModal.mode === 'create' ? 'Create System User' : 'Edit User Access & Credentials'}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">Assign RBAC role, location, password, Shift PIN, and profile photo</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setErr('');
                  setUserModal(null);
                }}
                className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {err && <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">{err}</div>}

            {/* Avatar Uploader */}
            <div className="flex items-center gap-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 p-3.5">
              <AvatarBadge name={userForm.fullName || 'User'} src={userForm.avatarUrl} size="lg" />
              <div className="flex-1 min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    ref={userFileRef}
                    type="file"
                    accept="image/*"
                    className="hidden bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                    onChange={(e) => {
                      handlePhotoUpload(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => userFileRef.current?.click()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    <Upload className="w-3.5 h-3.5" /> Upload Photo
                  </button>
                  {userForm.avatarUrl && (
                    <button
                      type="button"
                      onClick={() => setUserForm((f) => ({ ...f, avatarUrl: '' }))}
                      className="inline-flex items-center gap-1 rounded-lg border border-red-200 dark:border-red-800/80 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/70"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Remove
                    </button>
                  )}
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Or Image URL</label>
                  <input
                    placeholder="Or paste image URL..."
                    value={userForm.avatarUrl.startsWith('data:') ? '' : userForm.avatarUrl}
                    onChange={(e) => setUserForm((f) => ({ ...f, avatarUrl: e.target.value }))}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs"
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Full Name</label>
                <input
                  required
                  value={userForm.fullName}
                  onChange={(e) => setUserForm({ ...userForm, fullName: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Work Email</label>
                <input
                  type="email"
                  required
                  value={userForm.email}
                  onChange={(e) => setUserForm({ ...userForm, email: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Mobile Number</label>
                <input
                  placeholder="e.g. +63 917 555 1234"
                  value={userForm.phone}
                  onChange={(e) => setUserForm({ ...userForm, phone: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Role</label>
                <select
                  value={userForm.roleId}
                  onChange={(e) => setUserForm({ ...userForm, roleId: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                >
                  {(data?.roles || []).map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({r.code})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Assigned Location</label>
                <select
                  value={userForm.assignedLocationId}
                  onChange={(e) => setUserForm({ ...userForm, assignedLocationId: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                >
                  <option value="">All Locations</option>
                  {(data?.locations || []).map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Home Address</label>
                <input
                  placeholder="e.g. 123 Maharlika St, Makati City"
                  value={userForm.address}
                  onChange={(e) => setUserForm({ ...userForm, address: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                  {userModal.mode === 'create' ? 'Password (min. 6 characters)' : 'Reset Password (optional)'}
                </label>
                <input
                  type="password"
                  required={userModal.mode === 'create'}
                  minLength={userModal.mode === 'create' ? 6 : undefined}
                  placeholder={userModal.mode === 'create' ? 'Enter password' : 'Leave blank to keep current'}
                  value={userForm.password}
                  onChange={(e) => setUserForm({ ...userForm, password: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                  Operator Shift PIN (4–6 digits)
                </label>
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  disabled={userForm.clearPin}
                  placeholder={
                    userForm.clearPin
                      ? 'PIN will be cleared'
                      : userModal.hasExistingPin
                        ? 'Enter 4–6 digits to replace'
                        : 'Optional 4–6 digit PIN'
                  }
                  value={userForm.shiftPin}
                  onChange={(e) =>
                    setUserForm({ ...userForm, shiftPin: e.target.value.replace(/\D/g, '').slice(0, 6) })
                  }
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono tracking-widest disabled:bg-slate-50 dark:disabled:bg-slate-900"
                />
              </div>
            </div>

            <div className="space-y-2 pt-1">
              <label className="flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={userForm.isActive}
                  onChange={(e) => setUserForm({ ...userForm, isActive: e.target.checked })}
                />
                Account active (allowed to sign in)
              </label>

              {userModal.mode === 'edit' && userModal.hasExistingPin && (
                <label className="flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={userForm.clearPin}
                    onChange={(e) =>
                      setUserForm({
                        ...userForm,
                        clearPin: e.target.checked,
                        shiftPin: e.target.checked ? '' : userForm.shiftPin,
                      })
                    }
                  />
                  Clear existing Operator Shift PIN (require password only)
                </label>
              )}

              {userModal.mode === 'edit' && (userModal.isLocked || (userModal.failedAttempts ?? 0) > 0) && (
                <label className="flex items-center gap-2 text-xs font-medium text-amber-800 dark:text-amber-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={userForm.unlockAccount}
                    onChange={(e) => setUserForm({ ...userForm, unlockAccount: e.target.checked })}
                  />
                  Unlock account &amp; clear failed attempts ({userModal.failedAttempts} failed)
                </label>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-100 dark:border-slate-800/80">
              <button
                type="button"
                onClick={() => {
                  setErr('');
                  setUserModal(null);
                }}
                className="px-4 py-2 rounded-lg border text-xs"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 text-xs font-semibold hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50"
              >
                {saving ? 'Saving...' : userModal.mode === 'create' ? 'Create User' : 'Save User'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Device Pairing / Edit / Re-Authorize Modal */}
      {deviceModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form onSubmit={submitDeviceModal} className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl bg-white dark:bg-slate-900 p-5 space-y-4 border border-slate-200 dark:border-slate-800">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800/80 pb-3">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">
                  {deviceModal.mode === 'pair'
                    ? 'Pair & Authorize POS Device'
                    : deviceModal.mode === 'reauthorize'
                      ? 'Re-Authorize POS Device'
                      : 'Edit POS Register Assignment'}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {deviceModal.mode === 'edit'
                    ? 'Update register label, assigned food truck, or fixed station email'
                    : 'Register hardware UUID with server-side TERMINAL_ACCESS_KEY verification'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setErr('');
                  setDeviceModal(null);
                }}
                className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {err && <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">{err}</div>}

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Register / Tablet Name</label>
                <input
                  required
                  maxLength={120}
                  placeholder="e.g. Truck 01 — Front Counter iPad"
                  value={deviceForm.deviceName}
                  onChange={(e) => setDeviceForm({ ...deviceForm, deviceName: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">Hardware UUID</label>
                  {deviceModal.mode === 'pair' && deviceForm.hardwareUuid !== currentHardwareUuid && (
                    <button
                      type="button"
                      onClick={() =>
                        setDeviceForm((f) => ({
                          ...f,
                          hardwareUuid: currentHardwareUuid,
                          activateCurrentBrowser: true,
                        }))
                      }
                      className="text-[11px] font-semibold text-slate-700 dark:text-slate-200 underline hover:text-slate-900 dark:hover:text-white"
                    >
                      Use This Device&apos;s UUID
                    </button>
                  )}
                </div>
                <input
                  required
                  readOnly={deviceModal.mode !== 'pair'}
                  placeholder="e.g. 550e8400-e29b-41d4-a716-446655440000"
                  value={deviceForm.hardwareUuid}
                  onChange={(e) => setDeviceForm({ ...deviceForm, hardwareUuid: e.target.value })}
                  className={`w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono ${
                    deviceModal.mode !== 'pair' ? 'bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400' : ''
                  }`}
                />
                <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                  8–128 alphanumeric, hyphen, or underscore characters identifying this physical POS tablet.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Assigned Truck / Site</label>
                  <select
                    value={deviceForm.locationId}
                    onChange={(e) => setDeviceForm({ ...deviceForm, locationId: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                  >
                    <option value="">All Locations</option>
                    {availableLocations.map((l) => (
                      <option key={l.id} value={l.id}>{l.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Fixed Station Email (optional)</label>
                  <input
                    type="email"
                    placeholder="cashier.truck01@maximusbbq.ph"
                    value={deviceForm.stationEmail}
                    onChange={(e) => setDeviceForm({ ...deviceForm, stationEmail: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                  />
                </div>
              </div>

              {(deviceModal.mode === 'pair' || deviceModal.mode === 'reauthorize') && (
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 p-3.5 space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="block text-xs font-semibold text-slate-800 dark:text-slate-100">
                      {localTerminalStatus?.accessKeyConfigured
                        ? 'TERMINAL_ACCESS_KEY Verification'
                        : 'Set Initial Terminal Access Key'}
                    </label>
                    <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                      {localTerminalStatus?.accessKeySource === 'ENV'
                        ? 'Server ENV Key'
                        : localTerminalStatus?.accessKeySource === 'SETUP_KEY'
                          ? 'Server Setup Key'
                          : 'First-Time Claim'}
                    </span>
                  </div>
                  <div className="relative">
                    <input
                      type={showAccessKey ? 'text' : 'password'}
                      required
                      autoComplete="off"
                      placeholder={
                        localTerminalStatus?.accessKeyConfigured
                          ? 'Enter server TERMINAL_ACCESS_KEY'
                          : 'Create terminal access key (min. 6 chars)'
                      }
                      value={deviceForm.accessKey}
                      onChange={(e) => setDeviceForm({ ...deviceForm, accessKey: e.target.value })}
                      className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 pl-3 pr-9 py-2 text-xs font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setShowAccessKey((prev) => !prev)}
                      aria-label={showAccessKey ? 'Hide access key' : 'Show access key'}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                    >
                      {showAccessKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    Verified against the server&apos;s <span className="font-mono">TERMINAL_ACCESS_KEY</span> before linking this UUID to Firestore.
                  </p>
                </div>
              )}

              {deviceForm.hardwareUuid.trim() === currentHardwareUuid && deviceModal.mode !== 'edit' && (
                <label className="flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-200 cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    checked={deviceForm.activateCurrentBrowser}
                    onChange={(e) => setDeviceForm({ ...deviceForm, activateCurrentBrowser: e.target.checked })}
                  />
                  Enable Terminal Mode &amp; bind silent sign-in cookie on this browser
                </label>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-100 dark:border-slate-800/80">
              <button
                type="button"
                onClick={() => {
                  setErr('');
                  setDeviceModal(null);
                }}
                className="px-4 py-2 rounded-lg border text-xs"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 text-xs font-semibold hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50"
              >
                {saving
                  ? 'Verifying & Saving...'
                  : deviceModal.mode === 'pair'
                    ? 'Verify Key & Pair Device'
                    : deviceModal.mode === 'reauthorize'
                      ? 'Verify Key & Authorize'
                      : 'Save Device'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
