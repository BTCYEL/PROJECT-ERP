import { auth } from './firebase.ts';
import { firestoreApiRequest, getActiveErpUserId, setActiveErpUserId } from './firestoreErp.ts';

export function getAuthToken(): string | null {
  return auth.currentUser ? getActiveErpUserId() || 'firebase-session' : null;
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
