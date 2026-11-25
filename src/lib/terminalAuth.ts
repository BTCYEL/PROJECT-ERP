import { signInWithEmailAndPassword } from 'firebase/auth';
import { auth } from './firebase.ts';

export const TERMINAL_MODE_STORAGE_KEY = 'maximus_bbq_terminal_mode';
export const TERMINAL_STATION_EMAIL_STORAGE_KEY = 'maximus_bbq_terminal_station_email';
export const TERMINAL_LOCATION_ID_STORAGE_KEY = 'maximus_bbq_terminal_location_id';
export const TERMINAL_HARDWARE_UUID_STORAGE_KEY = 'maximus_bbq_hardware_uuid';

export interface TerminalServerStatus {
  credentialsConfigured: boolean;
  accessKeyConfigured: boolean;
  accessKeySource?: 'ENV' | 'SETUP_KEY' | 'NONE';
  devicePaired: boolean;
  pairedHardwareUuid?: string;
  stationEmail: string;
  stationLocationId: string;
}

export interface SilentTerminalAuthResult {
  ok: boolean;
  status: 'signed_in' | 'not_paired' | 'not_configured' | 'unverified' | 'error';
  message?: string;
  stationEmail?: string;
  stationLocationId?: string;
}

export function isValidHardwareUuid(raw: string): boolean {
  return /^[a-zA-Z0-9_-]{8,128}$/.test(String(raw || '').trim());
}

export function getOrCreateHardwareUuid(): string {
  try {
    const existing = String(localStorage.getItem(TERMINAL_HARDWARE_UUID_STORAGE_KEY) || '').trim();
    if (isValidHardwareUuid(existing)) return existing;
    const generated =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `hw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(TERMINAL_HARDWARE_UUID_STORAGE_KEY, generated);
    return generated;
  } catch {
    return 'browser-session-device';
  }
}

export function getBrowserDeviceSummary(): string {
  try {
    const ua = navigator.userAgent || '';
    const os = /iPad/i.test(ua)
      ? 'iPadOS'
      : /Android/i.test(ua)
        ? 'Android Tablet'
        : /iPhone/i.test(ua)
          ? 'iOS'
          : /Windows/i.test(ua)
            ? 'Windows POS'
            : /Mac/i.test(ua)
              ? 'macOS'
              : /Linux/i.test(ua)
                ? 'Linux'
                : 'Web Terminal';
    const browser = /Edg\//i.test(ua)
      ? 'Edge'
      : /Chrome\//i.test(ua)
        ? 'Chrome'
        : /Safari\//i.test(ua)
          ? 'Safari'
          : /Firefox\//i.test(ua)
            ? 'Firefox'
            : 'Browser';
    return `${os} · ${browser}`.slice(0, 160);
  } catch {
    return 'Web Terminal';
  }
}

export function isEnvForcedTerminalMode(): boolean {
  try {
    return String(import.meta.env.VITE_TERMINAL_MODE || '').toLowerCase() === 'true';
  } catch {
    return false;
  }
}

export function isTerminalModeDevice(): boolean {
  if (isEnvForcedTerminalMode()) return true;
  try {
    const params = new URLSearchParams(window.location.search);
    const paramVal = params.get('terminal');
    if (paramVal === '1' || paramVal === 'true') {
      localStorage.setItem(TERMINAL_MODE_STORAGE_KEY, 'true');
      return true;
    }
    if (paramVal === '0' || paramVal === 'false') {
      localStorage.removeItem(TERMINAL_MODE_STORAGE_KEY);
      return false;
    }
    return localStorage.getItem(TERMINAL_MODE_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setTerminalModeEnabled(
  enabled: boolean,
  opts?: { stationEmail?: string; locationId?: string },
): void {
  try {
    if (enabled) {
      localStorage.setItem(TERMINAL_MODE_STORAGE_KEY, 'true');
      if (opts?.stationEmail !== undefined) {
        const cleanEmail = opts.stationEmail.trim().toLowerCase();
        if (cleanEmail) localStorage.setItem(TERMINAL_STATION_EMAIL_STORAGE_KEY, cleanEmail);
        else localStorage.removeItem(TERMINAL_STATION_EMAIL_STORAGE_KEY);
      }
      if (opts?.locationId !== undefined) {
        const cleanLoc = opts.locationId.trim();
        if (cleanLoc && cleanLoc !== 'ALL') localStorage.setItem(TERMINAL_LOCATION_ID_STORAGE_KEY, cleanLoc);
        else localStorage.removeItem(TERMINAL_LOCATION_ID_STORAGE_KEY);
      }
    } else {
      localStorage.removeItem(TERMINAL_MODE_STORAGE_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

export function getTerminalStationConfig(): { stationEmail: string; locationId: string } {
  try {
    return {
      stationEmail: localStorage.getItem(TERMINAL_STATION_EMAIL_STORAGE_KEY) || '',
      locationId: localStorage.getItem(TERMINAL_LOCATION_ID_STORAGE_KEY) || '',
    };
  } catch {
    return { stationEmail: '', locationId: '' };
  }
}

export function updateTerminalStationConfig(opts: { stationEmail?: string; locationId?: string }): void {
  try {
    if (opts.stationEmail !== undefined) {
      const cleanEmail = opts.stationEmail.trim().toLowerCase();
      if (cleanEmail) localStorage.setItem(TERMINAL_STATION_EMAIL_STORAGE_KEY, cleanEmail);
      else localStorage.removeItem(TERMINAL_STATION_EMAIL_STORAGE_KEY);
    }
    if (opts.locationId !== undefined) {
      const cleanLoc = opts.locationId.trim();
      if (cleanLoc && cleanLoc !== 'ALL') localStorage.setItem(TERMINAL_LOCATION_ID_STORAGE_KEY, cleanLoc);
      else localStorage.removeItem(TERMINAL_LOCATION_ID_STORAGE_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

async function terminalApiCall<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text || res.statusText };
  }
  if (!res.ok) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data as T;
}

export async function fetchTerminalStatus(): Promise<TerminalServerStatus> {
  try {
    return await terminalApiCall<TerminalServerStatus>('/terminal/status', { method: 'GET' });
  } catch {
    return {
      credentialsConfigured: false,
      accessKeyConfigured: false,
      accessKeySource: 'NONE',
      devicePaired: false,
      pairedHardwareUuid: '',
      stationEmail: '',
      stationLocationId: '',
    };
  }
}

export async function claimTerminalPasscode(passcode: string): Promise<{ ok: boolean; devicePaired: boolean; hardwareUuid?: string }> {
  return terminalApiCall('/terminal/claim-key', {
    method: 'POST',
    body: JSON.stringify({ passcode, hardwareUuid: getOrCreateHardwareUuid() }),
  });
}

export async function pairTerminalDevice(passcode: string): Promise<{ ok: boolean; devicePaired: boolean; hardwareUuid?: string }> {
  return terminalApiCall('/terminal/pair', {
    method: 'POST',
    body: JSON.stringify({ passcode, hardwareUuid: getOrCreateHardwareUuid() }),
  });
}

export async function verifyTerminalAccessKey(params: {
  accessKey: string;
  hardwareUuid: string;
  pairCurrentBrowser?: boolean;
}): Promise<{ verified: boolean; hardwareUuid: string; verifiedAt: string; devicePaired: boolean }> {
  return terminalApiCall('/terminal/verify-access-key', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function unpairTerminalDevice(
  passcode?: string,
  opts?: { forceRevoke?: boolean },
): Promise<{ ok: boolean; devicePaired: boolean }> {
  return terminalApiCall('/terminal/unpair', {
    method: 'POST',
    body: JSON.stringify({
      ...(passcode ? { passcode } : {}),
      ...(opts?.forceRevoke ? { forceRevoke: true } : {}),
    }),
  });
}

export async function attemptSilentTerminalFirebaseSignIn(): Promise<SilentTerminalAuthResult> {
  try {
    const hardwareUuid = getOrCreateHardwareUuid();
    const res = await fetch('/api/v1/terminal/silent-auth', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({ hardwareUuid }),
    });

    const data = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        status: 'not_paired',
        message: data?.error || 'This terminal device must be paired with the setup passcode first.',
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: 'error',
        message: data?.error || 'Unable to verify terminal session.',
      };
    }

    if (data?.stationEmail || data?.stationLocationId) {
      updateTerminalStationConfig({
        stationEmail: data.stationEmail || undefined,
        locationId: data.stationLocationId || undefined,
      });
    }

    if (!data?.configured || !data?.email || !data?.password) {
      return {
        ok: false,
        status: 'not_configured',
        message: 'Background terminal Firebase credentials are not configured on the server yet.',
        stationEmail: data?.stationEmail || '',
        stationLocationId: data?.stationLocationId || '',
      };
    }

    const cred = await signInWithEmailAndPassword(auth, String(data.email), String(data.password));
    if (!cred.user.emailVerified) {
      return {
        ok: false,
        status: 'unverified',
        message:
          'The Terminal Firebase service user email is not marked verified yet. Verify the email in Firebase Auth before using this terminal.',
        stationEmail: data?.stationEmail || '',
        stationLocationId: data?.stationLocationId || '',
      };
    }

    return {
      ok: true,
      status: 'signed_in',
      stationEmail: data?.stationEmail || '',
      stationLocationId: data?.stationLocationId || '',
    };
  } catch (err: any) {
    return {
      ok: false,
      status: 'error',
      message: err?.message || 'Silent terminal authentication failed.',
    };
  }
}
