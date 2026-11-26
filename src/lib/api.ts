import { auth } from './firebase.ts';
import { firestoreApiRequest, getActiveErpUserId, setActiveErpUserId } from './firestoreErp.ts';

export async function getAuthToken(): Promise<string | null> {
  if (!auth.currentUser) return null;
  try {
    return await auth.currentUser.getIdToken();
  } catch {
    return null;
  }
}

export function setAuthToken(token: string | null) {
  if (!token) {
    setActiveErpUserId(null);
  }
}

export async function apiFetch<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  if (!auth.currentUser) {
    throw new Error('Authentication required. Please sign in with Google.');
  }
  const idToken = await auth.currentUser.getIdToken();

  if (
    path.startsWith('/ai/') ||
    path.startsWith('/api/v1/') ||
    path.startsWith('/printers/') ||
    path.startsWith('/terminal') ||
    path.startsWith('/terminals')
  ) {
    const url = path.startsWith('/api/v1') ? path : `/api/v1${path}`;
    const res = await fetch(url, {
      ...options,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Authorization: `Bearer ${idToken}`,
        ...(options.headers || {}),
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
      throw new Error(data?.error || `API request failed (${res.status})`);
    }
    return data as T;
  }

  return firestoreApiRequest<T>(path, options);
}

export function formatPHP(value: number | string | null | undefined): string {
  const num = Number(value || 0);
  return new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency: 'PHP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
}

export function formatNum(value: number | string | null | undefined, digits = 2): string {
  const num = Number(value || 0);
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(num);
}

export function downloadCsv(filename: string, rows: Array<Record<string, any>>) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const csvLines = [
    headers.join(','),
    ...rows.map((r) =>
      headers
        .map((h) => {
          const val = String(r[h] ?? '').replace(/"/g, '""');
          return `"${val}"`;
        })
        .join(','),
    ),
  ];
  const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
