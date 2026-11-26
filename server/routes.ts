import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { createHmac, createVerify, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'crypto';
import { readFileSync } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import { db } from './db.ts';
import {
  createNotification,
  deductStockTx,
  getDashboardSummary,
  getFinancialStatements,
  getFoodCostingAnalytics,
  getPredictiveProcurementPlan,
  getProductCostingList,
  getWeeklyFoodCostTrends,
  processSale,
  receiveStockTx,
  refundSale,
  syncItemThresholdAlertsSql,
  writeAuditLog,
} from './erpEngine.ts';
import { AuthUser, PERMISSIONS } from '../src/types/erp.ts';
import { findScheduleCandidateConflicts, formatOverlapDuration, ShiftWindowLike } from '../src/lib/shiftConflicts.ts';
import { evaluateIngredientThreshold } from '../src/lib/inventoryAlerts.ts';

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser;
    }
  }
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const round4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000;

function loadUserWithPermissions(userId: string): AuthUser | null {
  const user = db
    .prepare(`
      SELECT u.id, u.email, u.full_name, u.assigned_location_id, u.avatar_url, u.is_active, r.id AS role_id, r.code AS role_code, r.name AS role_name
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE u.id = ?
    `)
    .get(userId) as any;

  if (!user || !user.is_active) return null;

  const perms = db
    .prepare(`
      SELECT p.key
      FROM role_permissions rp
      JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = ?
    `)
    .all(user.role_id) as Array<{ key: string }>;

  return {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    roleCode: user.role_code,
    roleName: user.role_name,
    permissions: perms.map((p) => p.key),
    assignedLocationId: user.assigned_location_id,
    avatarUrl: user.avatar_url || null,
  };
}

async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '').trim();
    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    let userId: string | undefined;

    // Verify Firebase ID token (JWT) if it has 3 parts and doesn't start with usr_
    if (token.split('.').length === 3 && !token.startsWith('usr_')) {
      const fbUser = await verifyFirebaseBearerToken(token);
      if (fbUser && fbUser.email) {
        const erpUser = db
          .prepare('SELECT id FROM users WHERE lower(email) = lower(?) AND is_active = 1')
          .get(fbUser.email) as { id: string } | undefined;
        if (erpUser) {
          userId = erpUser.id;
        } else if (fbUser.email.toLowerCase() === 'norielescobio@gmail.com') {
          const adminUser = db.prepare("SELECT id FROM users WHERE role_id = 'role_super_admin' AND is_active = 1").get() as { id: string } | undefined;
          userId = adminUser?.id || 'usr_superadmin';
        }
      }
    }

    if (!userId) {
      if (token.startsWith('usr_')) {
        userId = token;
      } else {
        const sess = db
          .prepare("SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')")
          .get(token) as { user_id: string } | undefined;
        if (sess) {
          userId = sess.user_id;
        } else {
          const directUser = db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(token) as any;
          if (directUser) {
            userId = directUser.id;
          }
        }
      }
    }

    if (!userId) {
      res.status(401).json({ error: 'Session expired or invalid authentication token' });
      return;
    }

    const authUser = loadUserWithPermissions(userId);
    if (!authUser) {
      res.status(401).json({ error: 'User inactive' });
      return;
    }

    req.authUser = authUser;
    next();
  } catch (err: any) {
    res.status(401).json({ error: err?.message || 'Invalid authentication token' });
  }
}

function requirePerm(perm: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const u = req.authUser;
    if (!u) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    if (u.roleCode === 'SUPER_ADMIN' || u.roleCode === 'BUSINESS_OWNER' || u.permissions.includes(perm)) {
      next();
      return;
    }
    res.status(403).json({ error: `Permission denied: requires ${perm}` });
  };
}

function requireAnyPerm(...perms: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const u = req.authUser;
    if (!u) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    if (u.roleCode === 'SUPER_ADMIN' || u.roleCode === 'BUSINESS_OWNER' || perms.some((p) => u.permissions.includes(p))) {
      next();
      return;
    }
    res.status(403).json({ error: `Permission denied: requires one of ${perms.join(', ')}` });
  };
}

function requireOwnerOrSuperAdmin(req: Request, res: Response, next: NextFunction) {
  const u = req.authUser;
  if (!u) {
    res.status(401).json({ error: 'Unauthenticated' });
    return;
  }
  if (u.roleCode === 'SUPER_ADMIN' || u.roleCode === 'BUSINESS_OWNER') {
    next();
    return;
  }
  res.status(403).json({ error: 'Restricted: Company Owner or Super Admin access only' });
}

export const apiRouter = Router();

// ==========================================
// 1. AUTHENTICATION & SESSIONS
// ==========================================
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

function checkSqlLockout(user: any): string | null {
  if (!user?.locked_until) return null;
  const until = new Date(user.locked_until).getTime();
  if (!Number.isFinite(until) || until <= Date.now()) return null;
  const secs = Math.max(1, Math.ceil((until - Date.now()) / 1000));
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return mins > 0 ? `${mins}m ${rem}s` : `${rem}s`;
}

function recordSqlFailure(user: any, action: string): { locked: boolean; remaining: number } {
  const next = Number(user.failed_login_attempts || 0) + 1;
  const locked = next >= MAX_FAILED_ATTEMPTS;
  const lockedUntil = locked ? new Date(Date.now() + LOCKOUT_MS).toISOString() : null;
  db.prepare('UPDATE users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?').run(
    locked ? MAX_FAILED_ATTEMPTS : next,
    lockedUntil,
    user.id,
  );
  writeAuditLog(user.id, user.full_name, locked ? 'ACCOUNT_LOCKED' : action, 'User', user.id, {
    attempts: next,
    lockedUntil,
  });
  return { locked, remaining: Math.max(0, MAX_FAILED_ATTEMPTS - next) };
}

function clearSqlFailures(userId: string) {
  db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(userId);
}

apiRouter.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    res.status(400).json({ error: 'Work email and password are required' });
    return;
  }
  const user = db.prepare('SELECT id, password_hash, full_name, failed_login_attempts, locked_until, is_active FROM users WHERE lower(email) = lower(?) AND is_active = 1').get(email) as any;
  if (!user) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }
  const lockLeft = checkSqlLockout(user);
  if (lockLeft) {
    res.status(423).json({ error: `Account temporarily locked. Try again in ${lockLeft} or ask an Owner/Admin to unlock.` });
    return;
  }
  if (!bcrypt.compareSync(password, user.password_hash)) {
    const fail = recordSqlFailure(user, 'LOGIN_FAILED');
    res.status(fail.locked ? 423 : 401).json({
      error: fail.locked
        ? 'Too many failed attempts. Account locked for 5 minutes.'
        : `Invalid email or password. (${fail.remaining} attempt${fail.remaining === 1 ? '' : 's'} left before 5m lockout)`,
    });
    return;
  }
  clearSqlFailures(user.id);
  const token = randomUUID();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+7 days'))").run(token, user.id);
  const authUser = loadUserWithPermissions(user.id);
  writeAuditLog(user.id, user.full_name, 'LOGIN', 'Session', token.slice(0, 8));
  res.json({ token, user: authUser });
});

apiRouter.post('/auth/pin-login', (req, res) => {
  const { userId, pin } = req.body || {};
  if (!userId || !/^\d{4,6}$/.test(String(pin || '').trim())) {
    res.status(400).json({ error: 'Operator and 4–6 digit Shift PIN are required' });
    return;
  }
  const user = db.prepare('SELECT id, full_name, shift_pin_hash, failed_login_attempts, locked_until FROM users WHERE id = ? AND is_active = 1').get(userId) as any;
  if (!user) {
    res.status(404).json({ error: 'Operator account not found or inactive' });
    return;
  }
  const lockLeft = checkSqlLockout(user);
  if (lockLeft) {
    res.status(423).json({ error: `Operator locked for ${lockLeft} due to repeated failed attempts.` });
    return;
  }
  if (!user.shift_pin_hash) {
    res.status(400).json({ error: `No Shift PIN is configured for ${user.full_name}. Use Work Email & Password.` });
    return;
  }
  if (!bcrypt.compareSync(String(pin).trim(), user.shift_pin_hash)) {
    const fail = recordSqlFailure(user, 'PIN_LOGIN_FAILED');
    res.status(fail.locked ? 423 : 401).json({
      error: fail.locked
        ? 'Too many failed attempts. Account locked for 5 minutes.'
        : `Incorrect Shift PIN. (${fail.remaining} attempt${fail.remaining === 1 ? '' : 's'} left before 5m lockout)`,
    });
    return;
  }
  clearSqlFailures(user.id);
  const token = randomUUID();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+7 days'))").run(token, user.id);
  const authUser = loadUserWithPermissions(user.id);
  writeAuditLog(user.id, user.full_name, 'PIN_LOGIN', 'Session', token.slice(0, 8), { role: authUser?.roleCode });
  res.json({ token, user: authUser });
});

apiRouter.post('/auth/unlock', authMiddleware, (req, res) => {
  const { userId, mode, secret } = req.body || {};
  const user = db.prepare('SELECT id, full_name, password_hash, shift_pin_hash, failed_login_attempts, locked_until FROM users WHERE id = ? AND is_active = 1').get(userId || req.authUser?.id) as any;
  if (!user) {
    res.status(404).json({ error: 'Operator account not found' });
    return;
  }
  const lockLeft = checkSqlLockout(user);
  if (lockLeft) {
    res.status(423).json({ error: `Terminal locked for ${lockLeft} due to failed attempts.` });
    return;
  }
  if (mode === 'pin') {
    if (!user.shift_pin_hash) {
      res.status(400).json({ error: 'No Shift PIN configured for this account' });
      return;
    }
    if (!bcrypt.compareSync(String(secret || '').trim(), user.shift_pin_hash)) {
      const fail = recordSqlFailure(user, 'UNLOCK_PIN_FAILED');
      res.status(fail.locked ? 423 : 401).json({
        error: fail.locked ? 'Too many failed attempts. Locked for 5 minutes.' : `Incorrect Shift PIN. (${fail.remaining} attempts left)`,
      });
      return;
    }
  } else {
    if (!secret || !bcrypt.compareSync(String(secret), user.password_hash)) {
      const fail = recordSqlFailure(user, 'UNLOCK_FAILED');
      res.status(fail.locked ? 423 : 401).json({
        error: fail.locked ? 'Too many failed attempts. Locked for 5 minutes.' : `Incorrect password. (${fail.remaining} attempts left)`,
      });
      return;
    }
  }
  clearSqlFailures(user.id);
  const authUser = loadUserWithPermissions(user.id);
  writeAuditLog(user.id, user.full_name, 'SESSION_UNLOCK', 'Session', user.id, { mode });
  res.json({ ok: true, user: authUser });
});

apiRouter.get('/auth/operators', (_req, res) => {
  const rows = db
    .prepare(`
      SELECT u.id, u.full_name, u.avatar_url, u.assigned_location_id, u.shift_pin_hash, u.locked_until,
             r.code AS role_code, r.name AS role_name
      FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.is_active = 1
      ORDER BY CASE r.code WHEN 'SUPER_ADMIN' THEN 0 WHEN 'BUSINESS_OWNER' THEN 1 ELSE 2 END, u.full_name ASC
    `)
    .all() as any[];
  res.json(
    rows.map((u) => {
      const lockLeft = checkSqlLockout(u);
      return {
        id: u.id,
        full_name: u.full_name,
        avatar_url: u.avatar_url,
        role_code: u.role_code,
        role_name: u.role_name,
        assigned_location_id: u.assigned_location_id || null,
        has_pin: Boolean(u.shift_pin_hash),
        is_locked: Boolean(lockLeft),
        locked_until: lockLeft ? u.locked_until : null,
        is_google_owner: false,
      };
    }),
  );
});

apiRouter.get('/auth/me', authMiddleware, (req, res) => {
  res.json(req.authUser);
});

apiRouter.post('/auth/logout', authMiddleware, (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '').trim();
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.json({ ok: true });
});

// ==========================================
// 1B. TERMINAL-MODE DEVICE PAIRING & SILENT AUTH
// ==========================================
const TERMINAL_COOKIE_NAME = 'maximus_terminal_device';
const TERMINAL_COOKIE_TTL_SECS = 60 * 60 * 24 * 30;
const TERMINAL_SIGNING_KEY = process.env.TERMINAL_SIGNING_SECRET || randomBytes(32).toString('hex');

function parseCookieHeader(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

function isTrustedTerminalRequest(req: Request): boolean {
  const xrw = String(req.headers['x-requested-with'] || '');
  if (xrw === 'XMLHttpRequest') return true;
  const origin = String(req.headers.origin || '');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function sanitizeHardwareUuid(raw: unknown): string {
  const val = String(raw || '').trim();
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(val)) return '';
  return val;
}

function signTerminalDeviceToken(hardwareUuid?: string): string {
  const exp = Date.now() + TERMINAL_COOKIE_TTL_SECS * 1000;
  const nonce = randomBytes(16).toString('hex');
  const cleanHw = sanitizeHardwareUuid(hardwareUuid);
  const payload = cleanHw ? `${exp}.${nonce}.${cleanHw}` : `${exp}.${nonce}`;
  const sig = createHmac('sha256', TERMINAL_SIGNING_KEY).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function parseTerminalDeviceToken(token: string | null): { valid: boolean; hardwareUuid: string | null } {
  if (!token) return { valid: false, hardwareUuid: null };
  const parts = token.split('.');
  if (parts.length !== 3 && parts.length !== 4) return { valid: false, hardwareUuid: null };
  const expStr = parts[0];
  const nonce = parts[1];
  const hw = parts.length === 4 ? parts[2] : '';
  const sig = parts[parts.length - 1];
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= Date.now() || !nonce || !sig) {
    return { valid: false, hardwareUuid: null };
  }
  if (parts.length === 4 && !sanitizeHardwareUuid(hw)) {
    return { valid: false, hardwareUuid: null };
  }
  const payload = parts.length === 4 ? `${expStr}.${nonce}.${hw}` : `${expStr}.${nonce}`;
  const expected = createHmac('sha256', TERMINAL_SIGNING_KEY).update(payload).digest('hex');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  const valid = a.length === b.length && timingSafeEqual(a, b);
  return { valid, hardwareUuid: valid && hw ? hw : null };
}

function setTerminalDeviceCookie(res: Response, token: string): void {
  res.setHeader(
    'Set-Cookie',
    `${TERMINAL_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${TERMINAL_COOKIE_TTL_SECS}; HttpOnly; Secure; SameSite=None; Partitioned`,
  );
}

function clearTerminalDeviceCookie(res: Response): void {
  res.setHeader(
    'Set-Cookie',
    `${TERMINAL_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None; Partitioned`,
  );
}

function verifySecretString(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function getClaimedTerminalKeyHash(): string | null {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'terminal_pairing_key_hash'").get() as { value: string } | undefined;
  return row?.value || null;
}

function verifyTerminalPasscode(passcode: string): boolean {
  const envKey = String(process.env.TERMINAL_ACCESS_KEY || '').trim();
  if (envKey) {
    return verifySecretString(passcode, envKey);
  }
  const stored = getClaimedTerminalKeyHash();
  if (!stored || !stored.includes(':')) return false;
  const [salt, hashHex] = stored.split(':');
  if (!salt || !hashHex) return false;
  const derived = scryptSync(passcode, salt, 64).toString('hex');
  return verifySecretString(derived, hashHex);
}

apiRouter.get('/terminal/status', (req, res) => {
  const credentialsConfigured = Boolean(
    String(process.env.TERMINAL_SERVICE_EMAIL || '').trim() &&
    String(process.env.TERMINAL_SERVICE_PASSWORD || '').trim(),
  );
  const hasEnvAccessKey = Boolean(String(process.env.TERMINAL_ACCESS_KEY || '').trim());
  const hasClaimedKey = Boolean(getClaimedTerminalKeyHash());
  const accessKeyConfigured = hasEnvAccessKey || hasClaimedKey;
  const accessKeySource = hasEnvAccessKey ? 'ENV' : hasClaimedKey ? 'SETUP_KEY' : 'NONE';
  const parsedToken = parseTerminalDeviceToken(parseCookieHeader(req, TERMINAL_COOKIE_NAME));
  const devicePaired = parsedToken.valid;
  res.json({
    credentialsConfigured,
    accessKeyConfigured,
    accessKeySource,
    devicePaired,
    pairedHardwareUuid: parsedToken.hardwareUuid || '',
    stationEmail: devicePaired ? String(process.env.TERMINAL_STATION_EMAIL || '').trim().toLowerCase() : '',
    stationLocationId: devicePaired ? String(process.env.TERMINAL_STATION_LOCATION_ID || '').trim() : '',
  });
});

apiRouter.post('/terminal/claim-key', (req, res) => {
  if (!isTrustedTerminalRequest(req)) {
    res.status(403).json({ error: 'Invalid request origin' });
    return;
  }
  if (String(process.env.TERMINAL_ACCESS_KEY || '').trim()) {
    res.status(409).json({ error: 'Terminal pairing passcode is already configured by environment secrets' });
    return;
  }
  const passcode = String(req.body?.passcode || '').trim();
  if (passcode.length < 6 || passcode.length > 128) {
    res.status(400).json({ error: 'Setup passcode must be 6 to 128 characters' });
    return;
  }
  const hardwareUuid = sanitizeHardwareUuid(req.body?.hardwareUuid);
  const salt = randomBytes(16).toString('hex');
  const hashHex = scryptSync(passcode, salt, 64).toString('hex');
  const result = db
    .prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('terminal_pairing_key_hash', ?)")
    .run(`${salt}:${hashHex}`);
  if (result.changes === 0) {
    res.status(409).json({ error: 'Terminal setup passcode has already been claimed. Enter the existing passcode to pair.' });
    return;
  }
  setTerminalDeviceCookie(res, signTerminalDeviceToken(hardwareUuid || undefined));
  res.json({ ok: true, devicePaired: true, hardwareUuid: hardwareUuid || '' });
});

apiRouter.post('/terminal/pair', (req, res) => {
  if (!isTrustedTerminalRequest(req)) {
    res.status(403).json({ error: 'Invalid request origin' });
    return;
  }
  const passcode = String(req.body?.passcode || '').trim();
  const hardwareUuid = sanitizeHardwareUuid(req.body?.hardwareUuid);
  const hasKey = Boolean(String(process.env.TERMINAL_ACCESS_KEY || '').trim() || getClaimedTerminalKeyHash());
  if (!hasKey) {
    res.status(400).json({ error: 'No terminal pairing passcode has been configured yet' });
    return;
  }
  if (!passcode || !verifyTerminalPasscode(passcode)) {
    res.status(401).json({ error: 'Incorrect terminal pairing passcode' });
    return;
  }
  setTerminalDeviceCookie(res, signTerminalDeviceToken(hardwareUuid || undefined));
  res.json({ ok: true, devicePaired: true, hardwareUuid: hardwareUuid || '' });
});

apiRouter.post('/terminal/verify-access-key', (req, res) => {
  if (!isTrustedTerminalRequest(req)) {
    res.status(403).json({ error: 'Invalid request origin' });
    return;
  }
  const hardwareUuid = sanitizeHardwareUuid(req.body?.hardwareUuid);
  if (!hardwareUuid) {
    res.status(400).json({ error: 'Hardware UUID must be 8 to 128 alphanumeric, underscore, or hyphen characters' });
    return;
  }
  const accessKey = String(req.body?.accessKey || req.body?.passcode || '').trim();
  const hasKey = Boolean(String(process.env.TERMINAL_ACCESS_KEY || '').trim() || getClaimedTerminalKeyHash());
  if (!hasKey) {
    res.status(400).json({ error: 'No TERMINAL_ACCESS_KEY has been configured on the server yet' });
    return;
  }
  if (!accessKey || !verifyTerminalPasscode(accessKey)) {
    res.status(401).json({ error: 'Invalid TERMINAL_ACCESS_KEY. Device verification failed.' });
    return;
  }
  const pairCurrentBrowser = Boolean(req.body?.pairCurrentBrowser);
  if (pairCurrentBrowser) {
    setTerminalDeviceCookie(res, signTerminalDeviceToken(hardwareUuid));
  }
  res.json({
    verified: true,
    hardwareUuid,
    verifiedAt: new Date().toISOString(),
    devicePaired: pairCurrentBrowser,
  });
});

apiRouter.post('/terminal/unpair', (req, res) => {
  if (!isTrustedTerminalRequest(req)) {
    res.status(403).json({ error: 'Invalid request origin' });
    return;
  }
  const hasKey = Boolean(String(process.env.TERMINAL_ACCESS_KEY || '').trim() || getClaimedTerminalKeyHash());
  const passcode = String(req.body?.passcode || '').trim();
  const forceByAdmin = Boolean(req.body?.forceRevoke);
  if (!forceByAdmin && hasKey && (!passcode || !verifyTerminalPasscode(passcode))) {
    res.status(401).json({ error: 'Enter the terminal pairing passcode to disconnect this terminal' });
    return;
  }
  clearTerminalDeviceCookie(res);
  res.json({ ok: true, devicePaired: false });
});

apiRouter.post('/terminal/silent-auth', (req, res) => {
  if (!isTrustedTerminalRequest(req)) {
    res.status(403).json({ error: 'Invalid request origin' });
    return;
  }
  const parsedToken = parseTerminalDeviceToken(parseCookieHeader(req, TERMINAL_COOKIE_NAME));
  if (!parsedToken.valid) {
    res.status(401).json({ error: 'Device is not paired for silent terminal sign-in' });
    return;
  }
  const reqHardwareUuid = sanitizeHardwareUuid(req.body?.hardwareUuid);
  if (parsedToken.hardwareUuid && reqHardwareUuid && parsedToken.hardwareUuid !== reqHardwareUuid) {
    res.status(401).json({ error: 'Terminal hardware UUID mismatch. Please re-pair this POS register.' });
    return;
  }
  const email = String(process.env.TERMINAL_SERVICE_EMAIL || '').trim();
  const password = String(process.env.TERMINAL_SERVICE_PASSWORD || '').trim();
  const stationEmail = String(process.env.TERMINAL_STATION_EMAIL || '').trim().toLowerCase();
  const stationLocationId = String(process.env.TERMINAL_STATION_LOCATION_ID || '').trim();

  if (!email || !password) {
    res.json({
      configured: false,
      reason: 'TERMINAL_CREDENTIALS_NOT_CONFIGURED',
      stationEmail,
      stationLocationId,
      hardwareUuid: reqHardwareUuid || parsedToken.hardwareUuid || '',
    });
    return;
  }

  res.json({
    configured: true,
    email,
    password,
    stationEmail,
    stationLocationId,
    hardwareUuid: reqHardwareUuid || parsedToken.hardwareUuid || '',
  });
});

// ==========================================
// 1C. NETWORKED THERMAL RECEIPT PRINTER DISCOVERY & ESC/POS PRINTING
// ==========================================
const FIREBASE_PROJECT_ID = (() => {
  try {
    const cfg = JSON.parse(readFileSync(path.resolve(process.cwd(), 'firebase-applet-config.json'), 'utf8'));
    return String(cfg.projectId || '').trim();
  } catch {
    return '';
  }
})();

let cachedGoogleCerts: { certs: Record<string, string>; expiresAtMs: number } | null = null;

async function fetchGoogleSecureTokenCerts(): Promise<Record<string, string>> {
  if (cachedGoogleCerts && Date.now() < cachedGoogleCerts.expiresAtMs) {
    return cachedGoogleCerts.certs;
  }
  const resp = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
  if (!resp.ok) {
    throw new Error(`Unable to fetch Firebase public keys (${resp.status})`);
  }
  const certs = (await resp.json()) as Record<string, string>;
  const cc = String(resp.headers.get('cache-control') || '');
  const maxAgeMatch = cc.match(/max-age=(\d+)/i);
  const ttlMs = maxAgeMatch ? Math.max(60, Number(maxAgeMatch[1])) * 1000 : 300_000;
  cachedGoogleCerts = { certs, expiresAtMs: Date.now() + ttlMs };
  return certs;
}

function decodeBase64Url(str: string): Buffer {
  const normalized = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${pad}`, 'base64');
}

async function verifyFirebaseBearerToken(token: string): Promise<{ uid: string; email: string }> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed Firebase ID token');
  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(decodeBase64Url(headerB64).toString('utf8'));
  const payload = JSON.parse(decodeBase64Url(payloadB64).toString('utf8'));

  if (header?.alg !== 'RS256' || !header?.kid) {
    throw new Error('Unsupported Firebase token algorithm');
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (!payload?.exp || Number(payload.exp) <= nowSec) {
    throw new Error('Firebase ID token expired');
  }
  if (!payload?.sub || typeof payload.sub !== 'string') {
    throw new Error('Firebase token missing subject');
  }
  if (FIREBASE_PROJECT_ID) {
    if (payload.aud !== FIREBASE_PROJECT_ID) {
      throw new Error('Firebase token audience mismatch');
    }
    if (payload.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`) {
      throw new Error('Firebase token issuer mismatch');
    }
  }
  if (payload.email_verified !== true) {
    throw new Error('Verified email required for printer operations');
  }

  const certs = await fetchGoogleSecureTokenCerts();
  const pem = certs[String(header.kid)];
  if (!pem) {
    throw new Error('Unknown Firebase signing certificate');
  }
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  const valid = verifier.verify(pem, decodeBase64Url(sigB64));
  if (!valid) {
    throw new Error('Invalid Firebase ID token signature');
  }
  return {
    uid: String(payload.sub),
    email: String(payload.email || ''),
  };
}

async function requirePrinterAuth(req: Request, res: Response, next: NextFunction) {
  if (!isTrustedTerminalRequest(req)) {
    res.status(403).json({ error: 'Invalid request origin' });
    return;
  }
  const rawAuth = String(req.headers.authorization || '');
  const bearer = rawAuth.startsWith('Bearer ') ? rawAuth.slice(7).trim() : '';
  if (!bearer) {
    res.status(401).json({ error: 'Firebase authentication token required' });
    return;
  }
  try {
    await verifyFirebaseBearerToken(bearer);
    next();
  } catch (err: any) {
    res.status(401).json({ error: err?.message || 'Unauthorized printer request' });
  }
}

const ALLOWED_THERMAL_PORTS = new Set([9100, 9101, 9102]);

function parseStrictIpv4Octets(ip: string): [number, number, number, number] | null {
  const m = String(ip || '').trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const nums = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return [nums[0], nums[1], nums[2], nums[3]];
}

function isPrivateRfc1918Octets(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isValidPrivateRfc1918Ip(ip: string): boolean {
  const octets = parseStrictIpv4Octets(ip);
  return octets ? isPrivateRfc1918Octets(octets) : false;
}

function octetsToInt(octets: [number, number, number, number]): number {
  return (((octets[0] << 24) >>> 0) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function intToIp(num: number): string {
  return [(num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255].join('.');
}

function detectLocalLanSubnets(): Array<{ name: string; address: string; cidr24: string }> {
  const ifaces = os.networkInterfaces();
  const found: Array<{ name: string; address: string; cidr24: string }> = [];
  const seenCidr = new Set<string>();
  for (const [name, list] of Object.entries(ifaces)) {
    if (!Array.isArray(list)) continue;
    for (const info of list) {
      if (info.family !== 'IPv4' || info.internal) continue;
      const octets = parseStrictIpv4Octets(info.address);
      if (!octets || !isPrivateRfc1918Octets(octets)) continue;
      const cidr24 = `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
      if (!seenCidr.has(cidr24)) {
        seenCidr.add(cidr24);
        found.push({ name, address: info.address, cidr24 });
      }
    }
  }
  return found;
}

function expandPrivateScanTargets(rawTarget?: string): { ips: string[]; description: string } {
  const cleaned = String(rawTarget || '').trim();
  if (!cleaned) {
    const localIfaces = detectLocalLanSubnets();
    if (localIfaces.length === 0) {
      return { ips: [], description: 'No private LAN interface detected on host' };
    }
    const primary = localIfaces[0];
    const octets = parseStrictIpv4Octets(primary.address)!;
    const base = `${octets[0]}.${octets[1]}.${octets[2]}`;
    const ips: string[] = [];
    for (let i = 1; i <= 254; i++) {
      ips.push(`${base}.${i}`);
    }
    return { ips, description: primary.cidr24 };
  }

  if (cleaned.includes('/')) {
    const [ipPart, prefixStr] = cleaned.split('/');
    const octets = parseStrictIpv4Octets(ipPart);
    const prefix = Number(prefixStr);
    if (!octets || !Number.isInteger(prefix) || prefix < 24 || prefix > 32) {
      throw new Error('Subnet CIDR must be an IPv4 private range between /24 and /32 (e.g. 192.168.1.0/24)');
    }
    if (!isPrivateRfc1918Octets(octets)) {
      throw new Error('Only private LAN IPv4 subnets (10.x, 172.16-31.x, 192.168.x) may be scanned');
    }
    const mask = prefix === 0 ? 0 : (~((1 << (32 - prefix)) - 1)) >>> 0;
    const ipInt = octetsToInt(octets);
    const network = (ipInt & mask) >>> 0;
    const size = 1 << (32 - prefix);
    const ips: string[] = [];
    const startOffset = size > 2 ? 1 : 0;
    const endOffset = size > 2 ? size - 2 : size - 1;
    for (let offset = startOffset; offset <= endOffset && ips.length < 254; offset++) {
      const candidateIp = intToIp((network + offset) >>> 0);
      if (isValidPrivateRfc1918Ip(candidateIp)) {
        ips.push(candidateIp);
      }
    }
    return { ips, description: `${intToIp(network)}/${prefix}` };
  }

  const singleOctets = parseStrictIpv4Octets(cleaned);
  if (!singleOctets || !isPrivateRfc1918Octets(singleOctets)) {
    throw new Error('Target IP must be a valid private LAN IPv4 address (10.x, 172.16-31.x, or 192.168.x)');
  }
  return { ips: [cleaned], description: cleaned };
}

interface TcpPrinterProbeResult {
  ip: string;
  port: number;
  reachable: boolean;
  latencyMs: number;
  escPosDetected: boolean;
  paperStatus: 'READY' | 'PAPER_LOW' | 'PAPER_OUT' | 'COVER_OPEN' | 'UNKNOWN';
  statusSummary: string;
  protocol: string;
  suggestedName: string;
}

function probeThermalTcpEndpoint(ip: string, port: number, connectTimeoutMs = 280): Promise<TcpPrinterProbeResult> {
  return new Promise((resolve) => {
    const startMs = Date.now();
    const socket = new net.Socket();
    let settled = false;
    let connected = false;
    const chunks: Buffer[] = [];

    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (!reachable) {
        resolve({
          ip,
          port,
          reachable: false,
          latencyMs: Date.now() - startMs,
          escPosDetected: false,
          paperStatus: 'UNKNOWN',
          statusSummary: 'Unreachable',
          protocol: 'RAW_TCP_ESCPOS',
          suggestedName: `Thermal Printer (${ip})`,
        });
        return;
      }

      const combined = Buffer.concat(chunks);
      let escPosDetected = false;
      let paperStatus: TcpPrinterProbeResult['paperStatus'] = 'UNKNOWN';
      let statusSummary = `TCP ${port} Open · ESC/POS Ready`;

      if (combined.length > 0) {
        const s1 = combined[0];
        if ((s1 & 0x93) === 0x12) {
          escPosDetected = true;
          const offline = (s1 & 0x08) !== 0;
          paperStatus = offline ? 'COVER_OPEN' : 'READY';
          statusSummary = offline ? 'ESC/POS Online (Cover/Offline Flag)' : 'ESC/POS Online & Ready';
        }
        if (combined.length > 1) {
          const s4 = combined[1];
          if ((s4 & 0x93) === 0x12) {
            escPosDetected = true;
            if ((s4 & 0x60) !== 0) {
              paperStatus = 'PAPER_OUT';
              statusSummary = 'ESC/POS Ready · Paper Out';
            } else if ((s4 & 0x0c) !== 0) {
              paperStatus = 'PAPER_LOW';
              statusSummary = 'ESC/POS Ready · Paper Low';
            } else if (paperStatus === 'UNKNOWN') {
              paperStatus = 'READY';
              statusSummary = 'ESC/POS Online & Ready';
            }
          }
        }
      }

      resolve({
        ip,
        port,
        reachable: true,
        latencyMs: Math.max(1, Date.now() - startMs),
        escPosDetected,
        paperStatus,
        statusSummary,
        protocol: 'RAW_TCP_ESCPOS',
        suggestedName: escPosDetected ? `ESC/POS Thermal (${ip})` : `Network Receipt Printer (${ip})`,
      });
    };

    socket.setTimeout(connectTimeoutMs);
    socket.on('connect', () => {
      connected = true;
      socket.setTimeout(160);
      try {
        // Safe ESC/POS real-time status queries: DLE EOT 1 & DLE EOT 4
        socket.write(Buffer.from([0x10, 0x04, 0x01, 0x10, 0x04, 0x04]));
      } catch {
        // ignore write errors on probe
      }
      setTimeout(() => finish(true), 140);
    });
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length >= 2) {
        finish(true);
      }
    });
    socket.on('timeout', () => finish(connected));
    socket.on('error', () => finish(connected));
    socket.on('close', () => finish(connected));

    socket.connect(port, ip);
  });
}

function sanitizeEscPosText(input: unknown, maxLen = 80): string {
  return String(input ?? '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/₱/g, 'PHP ')
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function formatEscPosTwoCol(left: string, right: string, cols: number): string {
  const cleanL = sanitizeEscPosText(left, cols);
  const cleanR = sanitizeEscPosText(right, cols);
  const minGap = 1;
  const maxLeft = Math.max(4, cols - cleanR.length - minGap);
  const clippedLeft = cleanL.slice(0, maxLeft);
  const spaces = Math.max(1, cols - clippedLeft.length - cleanR.length);
  return `${clippedLeft}${' '.repeat(spaces)}${cleanR}`;
}

function buildEscPosTestPageBuffer(params: {
  paperWidthMm: 58 | 80;
  printerName: string;
  ip: string;
  port: number;
  terminalName: string;
  hardwareUuid: string;
}): Buffer {
  const cols = params.paperWidthMm === 58 ? 32 : 42;
  const hr = '-'.repeat(cols);
  const chunks: Buffer[] = [];
  const line = (s = '') => chunks.push(Buffer.from(`${s}\n`, 'ascii'));

  chunks.push(Buffer.from([0x1b, 0x40])); // ESC @ Reset
  chunks.push(Buffer.from([0x1b, 0x61, 0x01])); // Center
  chunks.push(Buffer.from([0x1b, 0x45, 0x01])); // Bold ON
  line('MAXIMUS BARBECUE ERP');
  chunks.push(Buffer.from([0x1b, 0x45, 0x00])); // Bold OFF
  line('THERMAL PRINTER TEST SLIP');
  line(hr);
  chunks.push(Buffer.from([0x1b, 0x61, 0x00])); // Left
  line(formatEscPosTwoCol('Printer:', params.printerName || 'LAN Thermal', cols));
  line(formatEscPosTwoCol('Endpoint:', `${params.ip}:${params.port}`, cols));
  line(formatEscPosTwoCol('Paper Width:', `${params.paperWidthMm}mm (${cols} cols)`, cols));
  line(formatEscPosTwoCol('Terminal:', params.terminalName || 'POS Register', cols));
  line(`UUID: ${sanitizeEscPosText(params.hardwareUuid || 'N/A', cols - 6)}`);
  line(formatEscPosTwoCol('Printed:', new Date().toISOString().slice(0, 19).replace('T', ' '), cols));
  line(hr);
  chunks.push(Buffer.from([0x1b, 0x61, 0x01])); // Center
  line('PRINTER MAPPING VERIFIED');
  line('\n\n');
  chunks.push(Buffer.from([0x1d, 0x56, 0x42, 0x0a])); // GS V 66 10 partial cut
  return Buffer.concat(chunks);
}

function buildEscPosReceiptBuffer(paperWidthMm: 58 | 80, receipt: any): Buffer {
  const cols = paperWidthMm === 58 ? 32 : 42;
  const hr = '-'.repeat(cols);
  const chunks: Buffer[] = [];
  const line = (s = '') => chunks.push(Buffer.from(`${s}\n`, 'ascii'));
  const fmtMoney = (n: unknown) => `PHP ${Number(n || 0).toFixed(2)}`;

  chunks.push(Buffer.from([0x1b, 0x40])); // ESC @
  chunks.push(Buffer.from([0x1b, 0x61, 0x01])); // Center
  chunks.push(Buffer.from([0x1b, 0x45, 0x01])); // Bold ON
  line(sanitizeEscPosText(receipt.businessName || 'MAXIMUS BARBECUE', cols));
  chunks.push(Buffer.from([0x1b, 0x45, 0x00])); // Bold OFF
  if (receipt.locationName) line(sanitizeEscPosText(receipt.locationName, cols));
  if (receipt.locationAddress) line(sanitizeEscPosText(receipt.locationAddress, cols));
  line(hr);

  chunks.push(Buffer.from([0x1b, 0x61, 0x00])); // Left
  line(formatEscPosTwoCol('Receipt:', String(receipt.receiptNumber || ''), cols));
  if (receipt.soldAt) {
    const dt = new Date(String(receipt.soldAt));
    const dtStr = Number.isNaN(dt.getTime()) ? String(receipt.soldAt) : dt.toLocaleString('en-PH');
    line(formatEscPosTwoCol('Date:', dtStr, cols));
  }
  if (receipt.cashierName) line(formatEscPosTwoCol('Cashier:', String(receipt.cashierName), cols));
  if (receipt.orderChannel) line(formatEscPosTwoCol('Channel:', String(receipt.orderChannel), cols));
  if (receipt.buzzerNumber) line(formatEscPosTwoCol('Buzzer:', `#${receipt.buzzerNumber}`, cols));
  if (receipt.customerName) line(formatEscPosTwoCol('Customer:', String(receipt.customerName), cols));
  line(hr);

  const items = Array.isArray(receipt.items) ? receipt.items : [];
  for (const it of items) {
    const qty = Number(it.qty || 0);
    const name = sanitizeEscPosText(it.name || 'Item', cols);
    line(name);
    line(formatEscPosTwoCol(`  ${qty} x ${Number(it.price || 0).toFixed(2)}`, fmtMoney(it.lineTotal), cols));
  }
  line(hr);
  line(formatEscPosTwoCol('Subtotal:', fmtMoney(receipt.subtotal), cols));
  if (Number(receipt.discountAmount || 0) > 0) {
    line(formatEscPosTwoCol('Discount:', `-${fmtMoney(receipt.discountAmount)}`, cols));
  }
  line(formatEscPosTwoCol('VAT / Tax:', fmtMoney(receipt.taxAmount), cols));
  chunks.push(Buffer.from([0x1b, 0x45, 0x01])); // Bold ON
  line(formatEscPosTwoCol('TOTAL DUE:', fmtMoney(receipt.totalAmount), cols));
  chunks.push(Buffer.from([0x1b, 0x45, 0x00])); // Bold OFF

  const payments = Array.isArray(receipt.payments) ? receipt.payments : [];
  if (payments.length > 0) {
    line(hr);
    for (const p of payments) {
      line(formatEscPosTwoCol(`Paid (${String(p.method || 'CASH')}):`, fmtMoney(p.amount), cols));
    }
  }
  line(hr);
  chunks.push(Buffer.from([0x1b, 0x61, 0x01])); // Center
  line('THANK YOU FOR DINING WITH US!');
  if (receipt.shareUrl) {
    line('Digital Receipt Available Online');
  }
  line('\n\n');
  chunks.push(Buffer.from([0x1d, 0x56, 0x42, 0x0a])); // Feed + Partial cut
  return Buffer.concat(chunks);
}

function sendRawEscPosBuffer(ip: string, port: number, data: Buffer, timeoutMs = 3000): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(data.length);
    };

    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => done(new Error(`Timed out connecting to printer ${ip}:${port}`)));
    socket.on('error', (err) => done(new Error(`Unable to reach printer ${ip}:${port} (${err.message})`)));
    socket.connect(port, ip, () => {
      socket.write(data, (writeErr) => {
        if (writeErr) {
          done(new Error(`Failed writing print job to ${ip}:${port}: ${writeErr.message}`));
          return;
        }
        socket.end(() => done());
      });
    });
  });
}

apiRouter.get('/printers/subnets', requirePrinterAuth, (_req, res) => {
  const interfaces = detectLocalLanSubnets();
  const isCloudContainerHint = Boolean(process.env.K_SERVICE || process.env.CLOUD_RUN_JOB || interfaces.length === 0);
  res.json({
    detectedSubnets: interfaces.map((i) => i.cidr24),
    interfaces,
    isCloudContainerHint,
    cloudNetworkNote: isCloudContainerHint
      ? 'This app server is running in a cloud container isolated from your shop Wi-Fi router. LAN scans probe the host network; you can still probe or manually map a known shop printer IP (e.g. 192.168.1.88:9100) to this terminal.'
      : 'Local LAN interface detected. Scan the subnet below to discover ESC/POS thermal receipt printers on TCP port 9100.',
  });
});

apiRouter.post('/printers/scan', requirePrinterAuth, async (req, res) => {
  try {
    const startMs = Date.now();
    const rawPorts = Array.isArray(req.body?.ports) ? req.body.ports : [9100];
    const ports: number[] = Array.from(
      new Set<number>(
        rawPorts
          .map((p: unknown) => Number(p))
          .filter((p: number) => ALLOWED_THERMAL_PORTS.has(p)),
      ),
    );
    const activePorts: number[] = ports.length > 0 ? ports : [9100];
    const { ips, description } = expandPrivateScanTargets(req.body?.target);
    const detectedSubnets = detectLocalLanSubnets().map((i) => i.cidr24);
    const isCloudContainerHint = Boolean(process.env.K_SERVICE || process.env.CLOUD_RUN_JOB || detectedSubnets.length === 0);

    if (ips.length === 0) {
      res.json({
        scannedHosts: 0,
        durationMs: Date.now() - startMs,
        detectedSubnets,
        targetDescription: description,
        printers: [],
        cloudNetworkNote:
          'No private LAN network interface is attached to this server host. Enter a private subnet CIDR (e.g. 192.168.1.0/24) or directly map your shop printer IP.',
      });
      return;
    }

    const targets: Array<{ ip: string; port: number }> = [];
    for (const ip of ips) {
      for (const port of activePorts) {
        targets.push({ ip, port });
      }
    }
    const cappedTargets = targets.slice(0, 510);
    const printers: TcpPrinterProbeResult[] = [];
    const batchSize = 32;

    for (let i = 0; i < cappedTargets.length; i += batchSize) {
      const slice = cappedTargets.slice(i, i + batchSize);
      const results = await Promise.all(slice.map((t) => probeThermalTcpEndpoint(t.ip, t.port, 240)));
      for (const r of results) {
        if (r.reachable) printers.push(r);
      }
    }

    printers.sort((a, b) => Number(b.escPosDetected) - Number(a.escPosDetected) || a.latencyMs - b.latencyMs);

    res.json({
      scannedHosts: ips.length,
      durationMs: Date.now() - startMs,
      detectedSubnets,
      targetDescription: description,
      printers,
      cloudNetworkNote: isCloudContainerHint
        ? 'Server is running in a cloud environment, so local store Wi-Fi printers on your food truck router cannot be reached directly from the cloud host. You can still map your shop printer IP directly below.'
        : '',
    });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Unable to scan network printers' });
  }
});

apiRouter.post('/printers/probe', requirePrinterAuth, async (req, res) => {
  const ip = String(req.body?.ip || '').trim();
  const port = Number(req.body?.port || 9100);
  if (!isValidPrivateRfc1918Ip(ip)) {
    res.status(400).json({ error: 'Printer IP must be a private LAN IPv4 address (10.x, 172.16-31.x, or 192.168.x)' });
    return;
  }
  if (!ALLOWED_THERMAL_PORTS.has(port)) {
    res.status(400).json({ error: 'Printer port must be 9100, 9101, or 9102' });
    return;
  }
  const result = await probeThermalTcpEndpoint(ip, port, 900);
  res.json({
    reachable: result.reachable,
    printer: result.reachable ? result : null,
    error: result.reachable ? undefined : `No thermal printer responded at ${ip}:${port} within 900ms`,
  });
});

apiRouter.post('/printers/test-print', requirePrinterAuth, async (req, res) => {
  const ip = String(req.body?.ip || '').trim();
  const port = Number(req.body?.port || 9100);
  const paperWidthMm: 58 | 80 = Number(req.body?.paperWidthMm) === 58 ? 58 : 80;
  if (!isValidPrivateRfc1918Ip(ip)) {
    res.status(400).json({ error: 'Printer IP must be a private LAN IPv4 address (10.x, 172.16-31.x, or 192.168.x)' });
    return;
  }
  if (!ALLOWED_THERMAL_PORTS.has(port)) {
    res.status(400).json({ error: 'Printer port must be 9100, 9101, or 9102' });
    return;
  }
  try {
    const payload = buildEscPosTestPageBuffer({
      paperWidthMm,
      printerName: String(req.body?.printerName || 'LAN Thermal Printer'),
      ip,
      port,
      terminalName: String(req.body?.terminalName || 'POS Terminal'),
      hardwareUuid: String(req.body?.hardwareUuid || ''),
    });
    const bytesSent = await sendRawEscPosBuffer(ip, port, payload, 2500);
    res.json({
      ok: true,
      bytesSent,
      message: `Sent ${bytesSent}-byte ESC/POS test slip to ${ip}:${port}`,
    });
  } catch (err: any) {
    res.status(502).json({ error: err?.message || `Unable to send test print to ${ip}:${port}` });
  }
});

apiRouter.post('/printers/print-receipt', requirePrinterAuth, async (req, res) => {
  const ip = String(req.body?.ip || '').trim();
  const port = Number(req.body?.port || 9100);
  const paperWidthMm: 58 | 80 = Number(req.body?.paperWidthMm) === 58 ? 58 : 80;
  const receipt = req.body?.receipt;
  if (!isValidPrivateRfc1918Ip(ip)) {
    res.status(400).json({ error: 'Printer IP must be a private LAN IPv4 address (10.x, 172.16-31.x, or 192.168.x)' });
    return;
  }
  if (!ALLOWED_THERMAL_PORTS.has(port)) {
    res.status(400).json({ error: 'Printer port must be 9100, 9101, or 9102' });
    return;
  }
  if (!receipt || typeof receipt !== 'object') {
    res.status(400).json({ error: 'Receipt payload is required' });
    return;
  }
  try {
    const payload = buildEscPosReceiptBuffer(paperWidthMm, receipt);
    const bytesSent = await sendRawEscPosBuffer(ip, port, payload, 3000);
    res.json({
      ok: true,
      bytesSent,
      message: `Printed receipt ${sanitizeEscPosText(receipt.receiptNumber || '', 40)} to ${ip}:${port}`,
    });
  } catch (err: any) {
    res.status(502).json({ error: err?.message || `Unable to print receipt to ${ip}:${port}` });
  }
});

// All routes below require authentication
apiRouter.use(authMiddleware);

// ==========================================
// 2. LOCATIONS, DASHBOARD & NOTIFICATIONS
// ==========================================
apiRouter.get('/locations', (_req, res) => {
  res.json(db.prepare('SELECT * FROM locations WHERE is_active = 1 ORDER BY type ASC, name ASC').all());
});

apiRouter.get('/notifications', (_req, res) => {
  res.json(db.prepare('SELECT * FROM notifications ORDER BY is_read ASC, created_at DESC LIMIT 30').all());
});

apiRouter.post('/notifications/:id/read', (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

apiRouter.get('/dashboard/summary', requirePerm(PERMISSIONS.DASHBOARD_VIEW), (req, res) => {
  const { from, to, locationId, todayFrom, todayTo, yesterdayFrom, yesterdayTo } = req.query as Record<string, string | undefined>;
  res.json(
    getDashboardSummary({
      from,
      to,
      locationId: locationId || undefined,
      todayFrom: todayFrom || undefined,
      todayTo: todayTo || undefined,
      yesterdayFrom: yesterdayFrom || undefined,
      yesterdayTo: yesterdayTo || undefined,
    }),
  );
});

// ==========================================
// 3. POS, OFFLINE SYNC & KITCHEN DISPLAY (KDS)
// ==========================================
apiRouter.get('/pos/catalog', requirePerm(PERMISSIONS.POS_SELL), (_req, res) => {
  const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order ASC').all() as any[];
  const products = getProductCostingList().filter((p) => p.is_available === 1);
  const customers = db.prepare('SELECT id, full_name, phone, loyalty_points, tier FROM customers ORDER BY full_name ASC').all();
  res.json({ categories, products, customers });
});

apiRouter.post('/pos/sales', requirePerm(PERMISSIONS.POS_SELL), (req, res) => {
  try {
    const sale = processSale(req.body, req.authUser!.id, req.authUser!.fullName);
    res.status(201).json(sale);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/pos/sales/sync-offline', requirePerm(PERMISSIONS.POS_SELL), (req, res) => {
  try {
    const sales = Array.isArray(req.body?.sales) ? req.body.sales : [];
    const synced = sales.map((s: any) =>
      processSale({ ...s, isOfflineSynced: true }, req.authUser!.id, req.authUser!.fullName),
    );
    res.json({ syncedCount: synced.length, sales: synced });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.get('/pos/sales', requirePerm(PERMISSIONS.POS_SELL), (req, res) => {
  const locationId = req.query.locationId as string | undefined;
  const sales = db
    .prepare(`
      SELECT s.*, l.name AS location_name, u.full_name AS cashier_name, c.full_name AS customer_name
      FROM sales s
      JOIN locations l ON l.id = s.location_id
      JOIN users u ON u.id = s.cashier_id
      LEFT JOIN customers c ON c.id = s.customer_id
      ${locationId ? 'WHERE s.location_id = ?' : ''}
      ORDER BY s.sold_at DESC
      LIMIT 60
    `)
    .all(...(locationId ? [locationId] : [])) as any[];

  const enriched = sales.map((s) => ({
    ...s,
    items: db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(s.id),
    payments: db.prepare('SELECT * FROM payments WHERE sale_id = ?').all(s.id),
  }));
  res.json(enriched);
});

apiRouter.post('/pos/sales/:id/refund', requirePerm(PERMISSIONS.POS_REFUND), (req, res) => {
  try {
    const updated = refundSale(req.params.id, req.body?.reason || 'Manager authorized refund', req.authUser!.id, req.authUser!.fullName);
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.get('/kds/orders', requirePerm(PERMISSIONS.KDS_MANAGE), (req, res) => {
  const locationId = req.query.locationId as string | undefined;
  const orders = db
    .prepare(`
      SELECT s.*, l.name AS location_name
      FROM sales s
      JOIN locations l ON l.id = s.location_id
      WHERE s.status = 'COMPLETED' AND s.kds_status != 'COMPLETED' AND l.kds_enabled = 1
      ${locationId ? 'AND s.location_id = ?' : ''}
      ORDER BY s.sold_at ASC
    `)
    .all(...(locationId ? [locationId] : [])) as any[];

  res.json(
    orders.map((o) => ({
      ...o,
      items: db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(o.id),
    })),
  );
});

apiRouter.patch('/kds/orders/:id', requirePerm(PERMISSIONS.KDS_MANAGE), (req, res) => {
  const { kdsStatus } = req.body || {};
  const allowed = ['PENDING', 'PREPARING', 'READY', 'COMPLETED'];
  if (!allowed.includes(kdsStatus)) {
    res.status(400).json({ error: 'Invalid KDS status' });
    return;
  }
  db.prepare('UPDATE sales SET kds_status = ? WHERE id = ?').run(kdsStatus, req.params.id);
  writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'KDS_STATUS', 'Sale', req.params.id, { kdsStatus });
  res.json({ ok: true, kdsStatus });
});

// ==========================================
// 4. PRODUCTS, MENUS & BOM RECIPES
// ==========================================
apiRouter.get('/products', requirePerm(PERMISSIONS.PRODUCT_MANAGE), (_req, res) => {
  res.json({
    products: getProductCostingList(),
    categories: db.prepare('SELECT * FROM categories ORDER BY sort_order ASC, name ASC').all(),
    inventoryItems: db.prepare('SELECT i.*, u.code AS uom_code FROM inventory_items i JOIN uoms u ON u.id = i.base_uom_id ORDER BY i.name ASC').all(),
    uoms: db.prepare('SELECT * FROM uoms').all(),
    taxConfigs: db.prepare('SELECT * FROM tax_configs').all(),
  });
});

apiRouter.post('/categories', requirePerm(PERMISSIONS.PRODUCT_MANAGE), (req, res) => {
  try {
    const cleanName = String(req.body?.name || '').trim();
    if (!cleanName) throw new Error('Category name is required');
    const dup = db.prepare('SELECT id FROM categories WHERE lower(name) = lower(?)').get(cleanName);
    if (dup) throw new Error(`Category "${cleanName}" already exists`);

    const maxRow = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS maxSort FROM categories').get() as { maxSort: number };
    const sortOrder = req.body?.sortOrder !== undefined && req.body?.sortOrder !== '' ? Number(req.body.sortOrder) : (maxRow.maxSort || 0) + 1;
    const id = randomUUID();
    db.prepare('INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)').run(id, cleanName, sortOrder);
    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'CREATE_CATEGORY', 'Category', id, { name: cleanName, sortOrder });
    res.status(201).json({ id, name: cleanName, sort_order: sortOrder });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put('/categories/:id', requirePerm(PERMISSIONS.PRODUCT_MANAGE), (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id) as any;
    if (!existing) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }
    const cleanName = String(req.body?.name || '').trim();
    if (!cleanName) throw new Error('Category name is required');
    const dup = db.prepare('SELECT id FROM categories WHERE lower(name) = lower(?) AND id != ?').get(cleanName, req.params.id);
    if (dup) throw new Error(`Category "${cleanName}" already exists`);

    const sortOrder = req.body?.sortOrder !== undefined && req.body?.sortOrder !== '' ? Number(req.body.sortOrder) : existing.sort_order;
    db.prepare('UPDATE categories SET name = ?, sort_order = ? WHERE id = ?').run(cleanName, sortOrder, req.params.id);
    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'UPDATE_CATEGORY', 'Category', req.params.id, { name: cleanName, sortOrder });
    res.json({ id: req.params.id, name: cleanName, sort_order: sortOrder });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/products', requirePerm(PERMISSIONS.PRODUCT_MANAGE), (req, res) => {
  try {
    const { sku, name, description, categoryId, basePrice, packagingCost, directLaborCost, targetFoodCostPct, taxConfigId, expiryDate, ingredients } = req.body || {};
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('Product name is required');
    const cleanCategoryId = String(categoryId || '').trim();
    if (!cleanCategoryId) throw new Error('Category is required');
    const catRow = db.prepare('SELECT id FROM categories WHERE id = ?').get(cleanCategoryId);
    if (!catRow) throw new Error('Selected category does not exist');

    const parsedPrice = Number(basePrice);
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) throw new Error('Valid base price is required');

    const cleanSku = String(sku || '').trim() || `MNU-${Date.now().toString().slice(-5)}`;
    const dupSku = db.prepare('SELECT id FROM products WHERE lower(sku) = lower(?)').get(cleanSku);
    if (dupSku) throw new Error(`SKU "${cleanSku}" is already used by another product`);

    const prodId = randomUUID();
    const recId = randomUUID();
    const cleanExpiry = expiryDate ? String(expiryDate).trim() || null : null;
    db.transaction(() => {
      db.prepare(`
        INSERT INTO products (id, sku, name, description, category_id, base_price, packaging_cost, direct_labor_cost, target_food_cost_pct, tax_config_id, expiry_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        prodId,
        cleanSku,
        cleanName,
        description ? String(description).trim() : '',
        cleanCategoryId,
        parsedPrice,
        Number(packagingCost || 0),
        Number(directLaborCost || 0),
        Number(targetFoodCostPct || 35),
        taxConfigId || 'tax_ph_vat',
        cleanExpiry,
      );

      db.prepare('INSERT INTO recipes (id, product_id, yield_qty) VALUES (?, ?, 1)').run(recId, prodId);
      const insIng = db.prepare('INSERT INTO recipe_ingredients (id, recipe_id, inventory_item_id, quantity, uom_id, waste_factor_pct) VALUES (?, ?, ?, ?, ?, ?)');
      for (const ing of ingredients || []) {
        insIng.run(randomUUID(), recId, ing.inventoryItemId, Number(ing.quantity), ing.uomId, Number(ing.wasteFactorPct || 0));
      }
    })();
    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'CREATE_PRODUCT', 'Product', prodId, { name: cleanName, sku: cleanSku, basePrice: parsedPrice, expiryDate: cleanExpiry });
    res.status(201).json({ id: prodId });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put('/products/:id', requirePerm(PERMISSIONS.PRODUCT_MANAGE), (req, res) => {
  try {
    const productId = req.params.id;
    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as any;
    if (!existing) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }

    const {
      sku,
      name,
      description,
      imageUrl,
      categoryId,
      basePrice,
      packagingCost,
      directLaborCost,
      targetFoodCostPct,
      taxConfigId,
      expiryDate,
      isAvailable,
      variants,
      modifiers,
    } = req.body || {};

    const cleanName = String(name || '').trim();
    const cleanSku = String(sku || '').trim();
    if (!cleanName) throw new Error('Product name is required');
    if (!cleanSku) throw new Error('SKU is required');
    if (!categoryId) throw new Error('Category is required');

    const dupSku = db.prepare('SELECT id FROM products WHERE lower(sku) = lower(?) AND id != ?').get(cleanSku, productId);
    if (dupSku) throw new Error(`SKU "${cleanSku}" is already used by another product`);

    db.transaction(() => {
      db.prepare(`
        UPDATE products
        SET sku = ?, name = ?, description = ?, image_url = ?, category_id = ?,
            base_price = ?, packaging_cost = ?, direct_labor_cost = ?,
            target_food_cost_pct = ?, tax_config_id = ?, expiry_date = ?, is_available = ?
        WHERE id = ?
      `).run(
        cleanSku,
        cleanName,
        description ?? existing.description ?? '',
        imageUrl !== undefined ? (String(imageUrl).trim() || null) : existing.image_url,
        categoryId,
        Number(basePrice),
        Number(packagingCost || 0),
        Number(directLaborCost || 0),
        Number(targetFoodCostPct || 35),
        taxConfigId || existing.tax_config_id || 'tax_ph_vat',
        expiryDate !== undefined ? (String(expiryDate).trim() || null) : existing.expiry_date,
        isAvailable === undefined ? existing.is_available : isAvailable ? 1 : 0,
        productId,
      );

      if (Array.isArray(variants)) {
        const existingVars = db.prepare('SELECT id, name FROM product_variants WHERE product_id = ?').all(productId) as Array<{ id: string; name: string }>;
        const incomingIds = new Set(variants.map((v: any) => v.id).filter(Boolean));
        for (const ev of existingVars) {
          if (!incomingIds.has(ev.id)) {
            const usedInSales = db.prepare('SELECT 1 FROM sale_items WHERE variant_id = ? LIMIT 1').get(ev.id);
            if (usedInSales) {
              throw new Error(`Cannot remove variant "${ev.name}" because it has past POS sales`);
            }
            db.prepare('DELETE FROM product_variants WHERE id = ?').run(ev.id);
          }
        }
        const updVar = db.prepare('UPDATE product_variants SET name = ?, price_delta = ?, portion_multiplier = ? WHERE id = ? AND product_id = ?');
        const insVar = db.prepare('INSERT INTO product_variants (id, product_id, name, price_delta, portion_multiplier) VALUES (?, ?, ?, ?, ?)');
        for (const v of variants) {
          const vName = String(v.name || '').trim();
          if (!vName) continue;
          if (v.id && existingVars.some((ev) => ev.id === v.id)) {
            updVar.run(vName, Number(v.priceDelta || 0), Number(v.portionMultiplier || 1), v.id, productId);
          } else {
            insVar.run(randomUUID(), productId, vName, Number(v.priceDelta || 0), Number(v.portionMultiplier || 1));
          }
        }
      }

      if (Array.isArray(modifiers)) {
        const existingMods = db.prepare('SELECT id FROM modifier_options WHERE product_id = ?').all(productId) as Array<{ id: string }>;
        const incomingModIds = new Set(modifiers.map((m: any) => m.id).filter(Boolean));
        for (const em of existingMods) {
          if (!incomingModIds.has(em.id)) {
            db.prepare('DELETE FROM modifier_options WHERE id = ?').run(em.id);
          }
        }
        const updMod = db.prepare('UPDATE modifier_options SET group_name = ?, name = ?, price_delta = ? WHERE id = ? AND product_id = ?');
        const insMod = db.prepare('INSERT INTO modifier_options (id, product_id, group_name, name, price_delta) VALUES (?, ?, ?, ?, ?)');
        for (const m of modifiers) {
          const mName = String(m.name || '').trim();
          if (!mName) continue;
          const groupName = String(m.groupName || 'Add-ons').trim() || 'Add-ons';
          if (m.id && existingMods.some((em) => em.id === m.id)) {
            updMod.run(groupName, mName, Number(m.priceDelta || 0), m.id, productId);
          } else {
            insMod.run(randomUUID(), productId, groupName, mName, Number(m.priceDelta || 0));
          }
        }
      }
    })();

    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'UPDATE_PRODUCT', 'Product', productId, {
      name: cleanName,
      sku: cleanSku,
      basePrice: Number(basePrice),
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put('/products/:id/recipe', requirePerm(PERMISSIONS.PRODUCT_MANAGE), (req, res) => {
  try {
    const { basePrice, packagingCost, directLaborCost, targetFoodCostPct, prepInstructions, ingredients } = req.body;
    db.transaction(() => {
      db.prepare('UPDATE products SET base_price = ?, packaging_cost = ?, direct_labor_cost = ?, target_food_cost_pct = ? WHERE id = ?')
        .run(Number(basePrice), Number(packagingCost), Number(directLaborCost), Number(targetFoodCostPct), req.params.id);

      let recipe = db.prepare('SELECT id FROM recipes WHERE product_id = ?').get(req.params.id) as { id: string } | undefined;
      if (!recipe) {
        const rid = randomUUID();
        db.prepare('INSERT INTO recipes (id, product_id, yield_qty, prep_instructions) VALUES (?, ?, 1, ?)').run(rid, req.params.id, prepInstructions || '');
        recipe = { id: rid };
      } else {
        db.prepare("UPDATE recipes SET prep_instructions = ?, updated_at = datetime('now') WHERE id = ?").run(prepInstructions || '', recipe.id);
        db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(recipe.id);
      }

      const ins = db.prepare('INSERT INTO recipe_ingredients (id, recipe_id, inventory_item_id, quantity, uom_id, waste_factor_pct) VALUES (?, ?, ?, ?, ?, ?)');
      for (const ing of ingredients || []) {
        ins.run(randomUUID(), recipe.id, ing.inventoryItemId, Number(ing.quantity), ing.uomId, Number(ing.wasteFactorPct || 0));
      }
    })();
    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'UPDATE_RECIPE', 'Product', req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.patch('/products/:id/availability', requirePerm(PERMISSIONS.PRODUCT_MANAGE), (req, res) => {
  db.prepare('UPDATE products SET is_available = ? WHERE id = ?').run(req.body.isAvailable ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

// ==========================================
// 5. INVENTORY, BATCHES, TRANSFERS & WASTE
// ==========================================
apiRouter.get('/inventory', requirePerm(PERMISSIONS.INVENTORY_VIEW), (req, res) => {
  const locationId = req.query.locationId as string | undefined;
  const rawItems = db
    .prepare(`
      SELECT i.*, u.code AS uom_code,
        COALESCE((SELECT SUM(b.remaining_qty) FROM stock_batches b WHERE b.inventory_item_id = i.id ${locationId ? 'AND b.location_id = ?' : ''}), 0) AS on_hand_qty,
        COALESCE((SELECT SUM(b.remaining_qty * b.unit_cost) FROM stock_batches b WHERE b.inventory_item_id = i.id ${locationId ? 'AND b.location_id = ?' : ''}), 0) AS stock_value
      FROM inventory_items i
      JOIN uoms u ON u.id = i.base_uom_id
      ORDER BY i.name ASC
    `)
    .all(...(locationId ? [locationId, locationId] : [])) as any[];

  const items = rawItems.map((item) => {
    const evalRes = evaluateIngredientThreshold({
      onHandQty: Number(item.on_hand_qty || 0),
      safetyStock: Number(item.min_stock_level || 0),
      reorderPoint: Number(item.reorder_point || 0),
    });
    return {
      ...item,
      safety_stock_level: evalRes.safetyStock,
      threshold_status: evalRes.status,
      safety_deficit: evalRes.status === 'BELOW_SAFETY' ? evalRes.deficitQty : 0,
    };
  });

  const batches = db
    .prepare(`
      SELECT b.*, i.name AS item_name, u.code AS uom_code, l.name AS location_name
      FROM stock_batches b
      JOIN inventory_items i ON i.id = b.inventory_item_id
      JOIN uoms u ON u.id = i.base_uom_id
      JOIN locations l ON l.id = b.location_id
      WHERE b.remaining_qty > 0 ${locationId ? 'AND b.location_id = ?' : ''}
      ORDER BY b.expiry_date ASC, b.received_at ASC
    `)
    .all(...(locationId ? [locationId] : []));

  const movements = db
    .prepare(`
      SELECT t.*, i.name AS item_name, u.code AS uom_code, l.name AS location_name
      FROM inventory_transactions t
      JOIN inventory_items i ON i.id = t.inventory_item_id
      JOIN uoms u ON u.id = i.base_uom_id
      JOIN locations l ON l.id = t.location_id
      ${locationId ? 'WHERE t.location_id = ?' : ''}
      ORDER BY t.created_at DESC
      LIMIT 60
    `)
    .all(...(locationId ? [locationId] : []));

  const uoms = db.prepare('SELECT * FROM uoms').all();
  const belowSafetyItems = items.filter((i) => i.threshold_status === 'BELOW_SAFETY');
  const belowReorderItems = items.filter((i) => i.threshold_status === 'BELOW_REORDER');
  const rawBelowSafetyItems = belowSafetyItems.filter((i) => i.item_type === 'RAW_MATERIAL');

  res.json({
    items,
    batches,
    movements,
    uoms,
    alertsSummary: {
      belowSafetyCount: belowSafetyItems.length,
      belowReorderCount: belowReorderItems.length,
      rawBelowSafetyCount: rawBelowSafetyItems.length,
      rawItemsBelowSafety: rawBelowSafetyItems.map((i) => ({
        id: i.id,
        sku: i.sku,
        name: i.name,
        onHandQty: i.on_hand_qty,
        safetyStock: i.safety_stock_level,
        deficitQty: i.safety_deficit,
        uomCode: i.uom_code,
      })),
    },
  });
});

apiRouter.post('/inventory/alerts/scan', requirePerm(PERMISSIONS.INVENTORY_VIEW), (req, res) => {
  try {
    const rawLoc = String(req.body?.locationId || '').trim();
    const locFilterId = rawLoc && rawLoc !== 'ALL' ? rawLoc : '';
    const onlyIfNeverNotified = Boolean(req.body?.onlyIfNeverNotified);
    const rawOnly = req.body?.rawOnly !== false;

    const candidateItems = db
      .prepare(`
        SELECT i.*, u.code AS uom_code
        FROM inventory_items i
        JOIN uoms u ON u.id = i.base_uom_id
        WHERE (i.min_stock_level > 0 OR i.reorder_point > 0)
        ${rawOnly ? "AND i.item_type = 'RAW_MATERIAL'" : ''}
        ORDER BY i.name ASC
      `)
      .all() as any[];

    const activeLocs = db.prepare('SELECT id, name FROM locations WHERE is_active = 1').all() as Array<{ id: string; name: string }>;
    const activeLocMap = new Map(activeLocs.map((l) => [l.id, l.name]));

    let scannedCount = 0;
    let belowSafetyCount = 0;
    let belowReorderCount = 0;
    let createdCount = 0;
    let resolvedCount = 0;
    const alerts: any[] = [];

    for (const item of candidateItems) {
      if (locFilterId) {
        scannedCount++;
        const agg = db
          .prepare('SELECT COALESCE(SUM(remaining_qty), 0) AS qty FROM stock_batches WHERE inventory_item_id = ? AND location_id = ?')
          .get(item.id, locFilterId) as { qty: number };
        const locQty = round2(Number(agg?.qty || 0));
        const syncRes = syncItemThresholdAlertsSql(item, locFilterId, locQty, { onlyIfNeverNotified });
        createdCount += syncRes.createdCount;
        resolvedCount += syncRes.resolvedCount;
        if (syncRes.status === 'BELOW_SAFETY') {
          belowSafetyCount++;
          alerts.push({
            inventoryItemId: item.id,
            sku: item.sku,
            name: item.name,
            itemType: item.item_type,
            locationId: locFilterId,
            locationName: activeLocMap.get(locFilterId) || 'Location',
            onHandQty: locQty,
            safetyStock: Number(item.min_stock_level || 0),
            reorderPoint: Number(item.reorder_point || 0),
            uomCode: item.uom_code,
            status: syncRes.status,
          });
        } else if (syncRes.status === 'BELOW_REORDER') {
          belowReorderCount++;
        }
      } else {
        const stockedRows = db
          .prepare(`
            SELECT DISTINCT location_id FROM stock_batches WHERE inventory_item_id = ?
            UNION
            SELECT DISTINCT location_id FROM inventory_transactions WHERE inventory_item_id = ?
          `)
          .all(item.id, item.id) as Array<{ location_id: string }>;
        const stockedLocIds = stockedRows.map((r) => r.location_id).filter((lid) => activeLocMap.has(lid));

        if (stockedLocIds.length === 0) {
          scannedCount++;
          const syncRes = syncItemThresholdAlertsSql(item, null, 0, { onlyIfNeverNotified });
          createdCount += syncRes.createdCount;
          resolvedCount += syncRes.resolvedCount;
          if (syncRes.status === 'BELOW_SAFETY') {
            belowSafetyCount++;
            alerts.push({
              inventoryItemId: item.id,
              sku: item.sku,
              name: item.name,
              itemType: item.item_type,
              locationId: null,
              locationName: 'All Locations',
              onHandQty: 0,
              safetyStock: Number(item.min_stock_level || 0),
              reorderPoint: Number(item.reorder_point || 0),
              uomCode: item.uom_code,
              status: syncRes.status,
            });
          } else if (syncRes.status === 'BELOW_REORDER') {
            belowReorderCount++;
          }
        } else {
          for (const lid of stockedLocIds) {
            scannedCount++;
            const agg = db
              .prepare('SELECT COALESCE(SUM(remaining_qty), 0) AS qty FROM stock_batches WHERE inventory_item_id = ? AND location_id = ?')
              .get(item.id, lid) as { qty: number };
            const locQty = round2(Number(agg?.qty || 0));
            const syncRes = syncItemThresholdAlertsSql(item, lid, locQty, { onlyIfNeverNotified });
            createdCount += syncRes.createdCount;
            resolvedCount += syncRes.resolvedCount;
            if (syncRes.status === 'BELOW_SAFETY') {
              belowSafetyCount++;
              alerts.push({
                inventoryItemId: item.id,
                sku: item.sku,
                name: item.name,
                itemType: item.item_type,
                locationId: lid,
                locationName: activeLocMap.get(lid) || 'Location',
                onHandQty: locQty,
                safetyStock: Number(item.min_stock_level || 0),
                reorderPoint: Number(item.reorder_point || 0),
                uomCode: item.uom_code,
                status: syncRes.status,
              });
            } else if (syncRes.status === 'BELOW_REORDER') {
              belowReorderCount++;
            }
          }
        }
      }
    }

    res.json({
      scannedCount,
      belowSafetyCount,
      belowReorderCount,
      createdCount,
      resolvedCount,
      alerts,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.get('/inventory/predictive-procurement', requirePerm(PERMISSIONS.INVENTORY_VIEW), (req, res) => {
  try {
    const locationId = req.query.locationId ? String(req.query.locationId) : undefined;
    const lookbackDays = req.query.lookbackDays ? Number(req.query.lookbackDays) : 90;
    const coverageDays = req.query.coverageDays ? Number(req.query.coverageDays) : 14;
    const plan = getPredictiveProcurementPlan({ locationId, lookbackDays, coverageDays });
    res.json(plan);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/inventory/predictive-procurement/auto-po', requirePerm(PERMISSIONS.PO_CREATE), (req, res) => {
  try {
    const { locationId, status, notes, coverageDays, items } = req.body || {};
    const rawLocId = String(locationId || '').trim();
    if (!rawLocId || rawLocId === 'ALL') {
      throw new Error('Select a specific delivery location (e.g., Commissary or Food Truck) before creating auto-restock POs');
    }
    const targetLoc = db.prepare('SELECT id, name FROM locations WHERE id = ? AND is_active = 1').get(rawLocId) as
      | { id: string; name: string }
      | undefined;
    if (!targetLoc) throw new Error('Selected delivery location was not found');

    const requestedStatus = String(status || 'DRAFT').toUpperCase();
    if (requestedStatus !== 'DRAFT' && requestedStatus !== 'PENDING_APPROVAL') {
      throw new Error('Predictive auto-restock POs can only be created as DRAFT or PENDING_APPROVAL');
    }

    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('Select at least one ingredient to generate purchase order(s)');
    }
    if (items.length > 120) {
      throw new Error('Too many line items in a single auto-restock batch');
    }

    const activeSuppliers = db.prepare('SELECT id, name FROM suppliers WHERE is_active = 1').all() as Array<{
      id: string;
      name: string;
    }>;
    const supById = new Map(activeSuppliers.map((s) => [s.id, s]));
    const itemRows = db.prepare('SELECT id, name FROM inventory_items').all() as Array<{ id: string; name: string }>;
    const itemById = new Map(itemRows.map((i) => [i.id, i]));

    const groupedBySup = new Map<
      string,
      {
        supplierId: string;
        supplierName: string;
        leadTimeDays: number;
        lines: Array<{ inventoryItemId: string; orderedQty: number; unitCost: number }>;
      }
    >();

    for (const rawLine of items) {
      const invId = String(rawLine?.inventoryItemId || '').trim();
      const supId = String(rawLine?.supplierId || '').trim();
      const orderedQty = round2(Number(rawLine?.orderedQty || 0));
      const unitCost = round4(Number(rawLine?.unitCost ?? 0));
      const leadTimeDays = Math.max(1, Math.min(30, Math.round(Number(rawLine?.leadTimeDays || 2))));

      const invItem = itemById.get(invId);
      if (!invItem) throw new Error('One or more selected inventory items could not be found');
      const sup = supById.get(supId);
      if (!sup) throw new Error(`Please assign an active supplier for "${invItem.name}"`);
      if (!Number.isFinite(orderedQty) || orderedQty <= 0) {
        throw new Error(`Restock quantity for "${invItem.name}" must be greater than zero`);
      }
      if (!Number.isFinite(unitCost) || unitCost < 0) {
        throw new Error(`Unit cost for "${invItem.name}" cannot be negative`);
      }

      const existingGroup = groupedBySup.get(supId);
      if (existingGroup) {
        const existingLine = existingGroup.lines.find((l) => l.inventoryItemId === invId);
        if (existingLine) {
          existingLine.orderedQty = round2(existingLine.orderedQty + orderedQty);
          existingLine.unitCost = unitCost;
        } else {
          existingGroup.lines.push({ inventoryItemId: invId, orderedQty, unitCost });
        }
        existingGroup.leadTimeDays = Math.max(existingGroup.leadTimeDays, leadTimeDays);
      } else {
        groupedBySup.set(supId, {
          supplierId: supId,
          supplierName: sup.name,
          leadTimeDays,
          lines: [{ inventoryItemId: invId, orderedQty, unitCost }],
        });
      }
    }

    const covDays = Math.min(45, Math.max(3, Math.round(Number(coverageDays || 14) || 14)));
    const noteBase = String(notes || `Predictive 90d restock (${covDays}d target coverage)`).trim().slice(0, 500);

    const createdPos = db.transaction(() => {
      const created: Array<{
        id: string;
        poNumber: string;
        supplierId: string;
        supplierName: string;
        status: string;
        totalAmount: number;
        lineCount: number;
      }> = [];
      let seqIdx = 0;

      const insPo = db.prepare(
        'INSERT INTO purchase_orders (id, po_number, supplier_id, location_id, status, total_amount, approved_by, notes, expected_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)',
      );
      const insLine = db.prepare(
        'INSERT INTO purchase_order_items (id, purchase_order_id, inventory_item_id, ordered_qty, unit_cost) VALUES (?, ?, ?, ?, ?)',
      );

      for (const group of groupedBySup.values()) {
        for (let offset = 0; offset < group.lines.length; offset += 60) {
          const chunk = group.lines.slice(offset, offset + 60);
          seqIdx += 1;
          const poId = randomUUID();
          const poNumber = `PO-${Date.now().toString().slice(-5)}${String(seqIdx).padStart(2, '0')}`;
          const totalAmount = round2(chunk.reduce((s, l) => s + l.orderedQty * l.unitCost, 0));
          const expectedIso = new Date(Date.now() + group.leadTimeDays * 86400000).toISOString().slice(0, 10);

          insPo.run(poId, poNumber, group.supplierId, targetLoc.id, requestedStatus, totalAmount, noteBase, expectedIso);
          for (const l of chunk) {
            insLine.run(randomUUID(), poId, l.inventoryItemId, l.orderedQty, l.unitCost);
          }

          writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'AUTO_CREATE_PREDICTIVE_PO', 'PurchaseOrder', poId, {
            poNumber,
            supplier: group.supplierName,
            location: targetLoc.name,
            totalAmount,
            status: requestedStatus,
            lineCount: chunk.length,
          });

          created.push({
            id: poId,
            poNumber,
            supplierId: group.supplierId,
            supplierName: group.supplierName,
            status: requestedStatus,
            totalAmount,
            lineCount: chunk.length,
          });
        }
      }

      return created;
    })();

    res.status(201).json({ createdPos });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/inventory/items', requireAnyPerm(PERMISSIONS.INVENTORY_ADJUST, PERMISSIONS.PRODUCT_MANAGE), (req, res) => {
  try {
    const { sku, name, itemType, baseUomId, costingMethod, minStockLevel, reorderPoint, lastUnitCost } = req.body || {};
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('Ingredient name is required');
    if (!baseUomId) throw new Error('Base unit (UOM) is required');

    const cleanSku = String(sku || '').trim() || `ING-${Date.now().toString().slice(-4)}`;
    const dupSku = db.prepare('SELECT id FROM inventory_items WHERE lower(sku) = lower(?)').get(cleanSku);
    if (dupSku) throw new Error(`SKU "${cleanSku}" is already used by another ingredient`);
    const dupName = db.prepare('SELECT id FROM inventory_items WHERE lower(name) = lower(?)').get(cleanName);
    if (dupName) throw new Error(`Ingredient "${cleanName}" already exists`);

    const cost = Number(lastUnitCost || 0);
    if (!Number.isFinite(cost) || cost < 0) throw new Error('Unit cost cannot be negative');

    const safety = Math.max(0, Number(minStockLevel || 0));
    const reorder = Math.max(0, Number(reorderPoint || 0));

    const id = randomUUID();
    db.prepare(`
      INSERT INTO inventory_items (id, sku, name, item_type, base_uom_id, costing_method, min_stock_level, reorder_point, last_unit_cost, weighted_avg_cost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      cleanSku,
      cleanName,
      itemType || 'RAW_MATERIAL',
      baseUomId,
      costingMethod || 'FIFO',
      safety,
      reorder,
      cost,
      cost,
    );

    const created = db
      .prepare('SELECT i.*, u.code AS uom_code FROM inventory_items i JOIN uoms u ON u.id = i.base_uom_id WHERE i.id = ?')
      .get(id) as any;

    let alertsCreated = 0;
    if (safety > 0 || reorder > 0) {
      const syncRes = syncItemThresholdAlertsSql(created, null, 0, { onlyIfNeverNotified: false });
      alertsCreated = syncRes.createdCount;
    }

    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'CREATE_INGREDIENT', 'InventoryItem', id, {
      name: cleanName,
      sku: cleanSku,
      safetyStock: safety,
      alertsCreated,
    });
    res.status(201).json({ ...created, alerts_created: alertsCreated });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put('/inventory/items/:id', requireAnyPerm(PERMISSIONS.INVENTORY_ADJUST, PERMISSIONS.PRODUCT_MANAGE), (req, res) => {
  try {
    const itemId = req.params.id;
    const existing = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(itemId) as any;
    if (!existing) {
      res.status(404).json({ error: 'Ingredient not found' });
      return;
    }

    const { sku, name, itemType, baseUomId, costingMethod, minStockLevel, reorderPoint, lastUnitCost } = req.body || {};
    const cleanName = String(name || '').trim();
    const cleanSku = String(sku || '').trim();
    if (!cleanName) throw new Error('Ingredient name is required');
    if (!cleanSku) throw new Error('SKU is required');
    if (!baseUomId) throw new Error('Base unit (UOM) is required');

    const dupSku = db.prepare('SELECT id FROM inventory_items WHERE lower(sku) = lower(?) AND id != ?').get(cleanSku, itemId);
    if (dupSku) throw new Error(`SKU "${cleanSku}" is already used by another ingredient`);
    const dupName = db.prepare('SELECT id FROM inventory_items WHERE lower(name) = lower(?) AND id != ?').get(cleanName, itemId);
    if (dupName) throw new Error(`Ingredient "${cleanName}" already exists`);

    if (baseUomId !== existing.base_uom_id) {
      const hasStockOrRecipe =
        db.prepare('SELECT 1 FROM stock_batches WHERE inventory_item_id = ? LIMIT 1').get(itemId) ||
        db.prepare('SELECT 1 FROM inventory_transactions WHERE inventory_item_id = ? LIMIT 1').get(itemId) ||
        db.prepare('SELECT 1 FROM recipe_ingredients WHERE inventory_item_id = ? LIMIT 1').get(itemId);
      if (hasStockOrRecipe) {
        throw new Error('Cannot change base unit (UOM) because this ingredient is already used in recipes or stock history');
      }
    }

    const cost = Number(lastUnitCost ?? existing.last_unit_cost ?? 0);
    if (!Number.isFinite(cost) || cost < 0) throw new Error('Unit cost cannot be negative');

    const hasBatches = db.prepare('SELECT 1 FROM stock_batches WHERE inventory_item_id = ? AND remaining_qty > 0 LIMIT 1').get(itemId);
    const nextWeightedAvg = hasBatches ? existing.weighted_avg_cost : cost;
    const nextSafety = Math.max(0, Number(minStockLevel ?? existing.min_stock_level ?? 0));
    const nextReorder = Math.max(0, Number(reorderPoint ?? existing.reorder_point ?? 0));

    db.prepare(`
      UPDATE inventory_items
      SET sku = ?, name = ?, item_type = ?, base_uom_id = ?, costing_method = ?,
          min_stock_level = ?, reorder_point = ?, last_unit_cost = ?, weighted_avg_cost = ?
      WHERE id = ?
    `).run(
      cleanSku,
      cleanName,
      itemType || existing.item_type || 'RAW_MATERIAL',
      baseUomId,
      costingMethod || existing.costing_method || 'FIFO',
      nextSafety,
      nextReorder,
      cost,
      nextWeightedAvg,
      itemId,
    );

    const updated = db
      .prepare('SELECT i.*, u.code AS uom_code FROM inventory_items i JOIN uoms u ON u.id = i.base_uom_id WHERE i.id = ?')
      .get(itemId) as any;

    const activeLocs = db.prepare('SELECT id FROM locations WHERE is_active = 1').all() as Array<{ id: string }>;
    const activeLocSet = new Set(activeLocs.map((l) => l.id));
    const stockedRows = db
      .prepare(`
        SELECT DISTINCT location_id FROM stock_batches WHERE inventory_item_id = ?
        UNION
        SELECT DISTINCT location_id FROM inventory_transactions WHERE inventory_item_id = ?
      `)
      .all(itemId, itemId) as Array<{ location_id: string }>;
    const stockedLocIds = stockedRows.map((r) => r.location_id).filter((lid) => activeLocSet.has(lid));

    let alertsCreated = 0;
    if (stockedLocIds.length === 0) {
      const syncRes = syncItemThresholdAlertsSql(updated, null, 0, { onlyIfNeverNotified: false });
      alertsCreated += syncRes.createdCount;
    } else {
      for (const lid of stockedLocIds) {
        const agg = db
          .prepare('SELECT COALESCE(SUM(remaining_qty), 0) AS qty FROM stock_batches WHERE inventory_item_id = ? AND location_id = ?')
          .get(itemId, lid) as { qty: number };
        const syncRes = syncItemThresholdAlertsSql(updated, lid, round2(Number(agg?.qty || 0)), { onlyIfNeverNotified: false });
        alertsCreated += syncRes.createdCount;
      }
    }

    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'UPDATE_INGREDIENT', 'InventoryItem', itemId, {
      name: cleanName,
      sku: cleanSku,
      cost,
      safetyStock: nextSafety,
      alertsCreated,
    });
    res.json({ ...updated, alerts_created: alertsCreated });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.delete('/inventory/items/:id', requireAnyPerm(PERMISSIONS.INVENTORY_ADJUST, PERMISSIONS.PRODUCT_MANAGE), (req, res) => {
  try {
    const itemId = req.params.id;
    const existing = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(itemId) as any;
    if (!existing) {
      res.status(404).json({ error: 'Ingredient not found' });
      return;
    }

    const recipeCount = (db.prepare('SELECT COUNT(*) AS cnt FROM recipe_ingredients WHERE inventory_item_id = ? OR substitute_item_id = ?').get(itemId, itemId) as { cnt: number }).cnt;
    if (recipeCount > 0) {
      throw new Error(`Cannot delete "${existing.name}" because it is used in ${recipeCount} product recipe(s). Remove it from BOM first.`);
    }

    const batchCount = (db.prepare('SELECT COUNT(*) AS cnt FROM stock_batches WHERE inventory_item_id = ?').get(itemId) as { cnt: number }).cnt;
    const txnCount = (db.prepare('SELECT COUNT(*) AS cnt FROM inventory_transactions WHERE inventory_item_id = ?').get(itemId) as { cnt: number }).cnt;
    if (batchCount > 0 || txnCount > 0) {
      throw new Error(`Cannot delete "${existing.name}" because it has stock batches or movement history.`);
    }

    const poCount = (db.prepare('SELECT COUNT(*) AS cnt FROM purchase_order_items WHERE inventory_item_id = ?').get(itemId) as { cnt: number }).cnt;
    const modCount = (db.prepare('SELECT COUNT(*) AS cnt FROM modifier_options WHERE inventory_item_id = ?').get(itemId) as { cnt: number }).cnt;
    if (poCount > 0 || modCount > 0) {
      throw new Error(`Cannot delete "${existing.name}" because it is linked to purchase orders or menu modifiers.`);
    }

    db.transaction(() => {
      db.prepare('DELETE FROM supplier_items WHERE inventory_item_id = ?').run(itemId);
      db.prepare('DELETE FROM inventory_items WHERE id = ?').run(itemId);
    })();

    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'DELETE_INGREDIENT', 'InventoryItem', itemId, { name: existing.name });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/inventory/transfers', requirePerm(PERMISSIONS.INVENTORY_ADJUST), (req, res) => {
  try {
    const { fromLocationId, toLocationId, inventoryItemId, quantity, notes } = req.body;
    if (fromLocationId === toLocationId) throw new Error('Source and destination locations must differ');
    const qty = Number(quantity);
    const result = db.transaction(() => {
      const trfId = randomUUID();
      const trfNo = `TRF-${Date.now().toString().slice(-6)}`;
      const deducted = deductStockTx({
        inventoryItemId,
        locationId: fromLocationId,
        quantity: qty,
        txnType: 'OUT_TRANSFER',
        referenceType: 'TRANSFER',
        referenceId: trfId,
        userId: req.authUser!.id,
        notes: notes || `Transfer to ${toLocationId}`,
        allowNegative: false,
      });

      for (const b of deducted.consumedBatches) {
        receiveStockTx({
          inventoryItemId,
          locationId: toLocationId,
          quantity: b.qty,
          unitCost: b.unitCost,
          batchNumber: trfNo,
          txnType: 'IN_TRANSFER',
          referenceType: 'TRANSFER',
          referenceId: trfId,
          userId: req.authUser!.id,
          notes: `Received from ${fromLocationId}`,
        });
      }

      db.prepare('INSERT INTO stock_transfers (id, transfer_number, from_location_id, to_location_id, status, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(trfId, trfNo, fromLocationId, toLocationId, 'RECEIVED', notes || '', req.authUser!.id);
      db.prepare('INSERT INTO stock_transfer_items (id, transfer_id, inventory_item_id, quantity, total_cost) VALUES (?, ?, ?, ?, ?)')
        .run(randomUUID(), trfId, inventoryItemId, qty, deducted.totalCogs);
      writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'STOCK_TRANSFER', 'StockTransfer', trfId, { trfNo, qty });
      return { trfId, trfNo, totalCost: deducted.totalCogs };
    })();
    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/inventory/waste', requirePerm(PERMISSIONS.INVENTORY_ADJUST), (req, res) => {
  try {
    const { inventoryItemId, locationId, quantity, reason, txnType } = req.body;
    const resDeduct = db.transaction(() => {
      const d = deductStockTx({
        inventoryItemId,
        locationId,
        quantity: Number(quantity),
        txnType: txnType === 'OUT_SPOILAGE' ? 'OUT_SPOILAGE' : 'OUT_WASTE',
        referenceType: 'WASTE_LOG',
        referenceId: `WST-${Date.now()}`,
        userId: req.authUser!.id,
        notes: reason || 'Spoilage / Kitchen waste',
      });
      writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'RECORD_WASTE', 'InventoryItem', inventoryItemId, { quantity, reason });
      return d;
    })();
    res.status(201).json(resDeduct);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/inventory/reconcile', requirePerm(PERMISSIONS.INVENTORY_ADJUST), (req, res) => {
  try {
    const { inventoryItemId, locationId, countedQty, notes } = req.body;
    const result = db.transaction(() => {
      const agg = db
        .prepare('SELECT COALESCE(SUM(remaining_qty), 0) AS qty FROM stock_batches WHERE inventory_item_id = ? AND location_id = ?')
        .get(inventoryItemId, locationId) as { qty: number };
      const sysQty = agg.qty || 0;
      const variance = round2(Number(countedQty) - sysQty);
      if (variance === 0) return { variance: 0, status: 'MATCHED' };
      const item = db.prepare('SELECT * FROM inventory_items WHERE id = ?').get(inventoryItemId) as any;
      if (variance > 0) {
        receiveStockTx({
          inventoryItemId,
          locationId,
          quantity: variance,
          unitCost: item.last_unit_cost,
          batchNumber: `CNT-${Date.now().toString().slice(-5)}`,
          txnType: 'IN_ADJUSTMENT',
          referenceType: 'STOCK_COUNT',
          referenceId: randomUUID(),
          userId: req.authUser!.id,
          notes: notes || 'Physical stock count surplus',
        });
      } else {
        deductStockTx({
          inventoryItemId,
          locationId,
          quantity: Math.abs(variance),
          txnType: 'OUT_ADJUSTMENT',
          referenceType: 'STOCK_COUNT',
          referenceId: randomUUID(),
          userId: req.authUser!.id,
          notes: notes || 'Physical stock count shrinkage',
        });
      }
      writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'STOCK_RECONCILE', 'InventoryItem', inventoryItemId, { sysQty, countedQty, variance });
      return { sysQty, countedQty: Number(countedQty), variance, status: 'ADJUSTED' };
    })();
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// 6. PROCUREMENT & SUPPLIERS (WORKFLOW B)
// ==========================================
apiRouter.get('/procurement', requirePerm(PERMISSIONS.PO_CREATE), (_req, res) => {
  const allSupplierRows = db.prepare('SELECT * FROM suppliers ORDER BY name ASC').all() as any[];
  const supplierNameMap = new Map(allSupplierRows.map((s) => [s.id, s]));
  const supplierAuditRows = db
    .prepare("SELECT * FROM audit_logs WHERE entity_type = 'Supplier' ORDER BY created_at DESC LIMIT 200")
    .all() as any[];

  const latestBySupplier = new Map<string, any>();
  const countBySupplier = new Map<string, number>();
  for (const log of supplierAuditRows) {
    if (!latestBySupplier.has(log.entity_id)) latestBySupplier.set(log.entity_id, log);
    countBySupplier.set(log.entity_id, (countBySupplier.get(log.entity_id) || 0) + 1);
  }

  const suppliers = allSupplierRows
    .filter((s) => Number(s.is_active) === 1)
    .map((s) => {
      const latest = latestBySupplier.get(s.id);
      return {
        ...s,
        updated_at: s.updated_at || latest?.created_at || s.created_at || null,
        updated_by: s.updated_by || latest?.user_id || null,
        updated_by_name: s.updated_by_name || latest?.user_name || 'System Seed',
        created_at: s.created_at || null,
        audit_count: countBySupplier.get(s.id) || 0,
      };
    });

  const supplierAuditLogs = supplierAuditRows.map((log) => {
    const sup = supplierNameMap.get(log.entity_id);
    return {
      id: log.id,
      supplier_id: log.entity_id,
      supplier_name: sup?.name || 'Supplier',
      supplier_code: sup?.code || '',
      action: log.action,
      user_id: log.user_id || null,
      user_name: log.user_name || 'System',
      details: log.details || '',
      logged_at: log.created_at,
    };
  });

  const priceComparison = db
    .prepare(`
      SELECT si.*, s.name AS supplier_name, ii.name AS item_name, u.code AS uom_code
      FROM supplier_items si
      JOIN suppliers s ON s.id = si.supplier_id
      JOIN inventory_items ii ON ii.id = si.inventory_item_id
      JOIN uoms u ON u.id = ii.base_uom_id
      ORDER BY ii.name ASC, si.unit_price ASC
    `)
    .all();

  const purchaseOrders = (
    db
      .prepare(`
        SELECT po.*, s.name AS supplier_name, l.name AS location_name
        FROM purchase_orders po
        JOIN suppliers s ON s.id = po.supplier_id
        JOIN locations l ON l.id = po.location_id
        ORDER BY po.ordered_at DESC
      `)
      .all() as any[]
  ).map((po) => {
    const linkedInvs = db.prepare('SELECT status FROM supplier_invoices WHERE purchase_order_id = ?').all(po.id) as { status: string }[];
    const allLinkedPaid = linkedInvs.length > 0 && linkedInvs.every((x) => x.status === 'PAID');
    return {
      ...po,
      status: po.status === 'RECEIVED' && allLinkedPaid ? 'PAID' : po.status,
      items: db
        .prepare(`
          SELECT poi.*, ii.name AS item_name, u.code AS uom_code
          FROM purchase_order_items poi
          JOIN inventory_items ii ON ii.id = poi.inventory_item_id
          JOIN uoms u ON u.id = ii.base_uom_id
          WHERE poi.purchase_order_id = ?
        `)
        .all(po.id),
    };
  });

  const invoices = db
    .prepare(`
      SELECT inv.*, s.name AS supplier_name
      FROM supplier_invoices inv
      JOIN suppliers s ON s.id = inv.supplier_id
      ORDER BY inv.due_date ASC
    `)
    .all();

  const thresholdRow = db.prepare("SELECT value FROM app_settings WHERE key = 'po_approval_threshold'").get() as { value?: string } | undefined;
  const parsedThreshold = Number(thresholdRow?.value);
  const approvalThreshold = Number.isFinite(parsedThreshold) && parsedThreshold >= 0 ? round2(parsedThreshold) : 10000;

  res.json({ approvalThreshold, suppliers, supplierAuditLogs, priceComparison, purchaseOrders, invoices });
});

apiRouter.put('/procurement/approval-config', requirePerm(PERMISSIONS.PO_APPROVE), (req, res) => {
  try {
    const raw = Number(req.body?.approvalThreshold);
    if (!Number.isFinite(raw) || raw < 0) {
      throw new Error('Approval threshold must be a valid non-negative amount');
    }
    const nextThreshold = round2(raw);
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('po_approval_threshold', ?)").run(String(nextThreshold));
    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'UPDATE_PO_APPROVAL_THRESHOLD', 'PurchaseOrderConfig', 'po_approval_threshold', {
      approvalThreshold: nextThreshold,
    });
    res.json({ ok: true, approvalThreshold: nextThreshold });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/procurement/suppliers', requirePerm(PERMISSIONS.PO_CREATE), (req, res) => {
  try {
    const { code, name, contactPerson, phone, email, address, tin, paymentTerms } = req.body;
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('Supplier name is required');
    const id = randomUUID();
    const cleanCode = String(code || `SUP-${Date.now().toString().slice(-4)}`).trim();
    const nowIso = new Date().toISOString();
    const cleanTerms = Math.max(0, Math.round(Number(paymentTerms || 0)));
    db.prepare('INSERT INTO suppliers (id, code, name, contact_person, phone, email, address, tin, payment_terms, updated_by, updated_by_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, cleanCode, cleanName, contactPerson || '', phone || '', email || '', address || '', tin || '', cleanTerms, req.authUser!.id, req.authUser!.fullName, nowIso, nowIso);
    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'CREATE_SUPPLIER', 'Supplier', id, {
      code: cleanCode,
      name: cleanName,
      paymentTerms: `${cleanTerms} days`,
    });
    res.status(201).json({ id });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put('/procurement/suppliers/:id', requirePerm(PERMISSIONS.PO_CREATE), (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id) as any;
    if (!existing) {
      res.status(404).json({ error: 'Supplier not found' });
      return;
    }
    const { code, name, contactPerson, phone, email, address, tin, paymentTerms } = req.body || {};
    const cleanName = String(name ?? existing.name ?? '').trim();
    const cleanCode = String(code ?? existing.code ?? '').trim();
    if (!cleanName) throw new Error('Supplier name is required');
    if (!cleanCode) throw new Error('Supplier code is required');

    const nextContact = String(contactPerson ?? existing.contact_person ?? '').trim();
    const nextPhone = String(phone ?? existing.phone ?? '').trim();
    const nextEmail = String(email ?? existing.email ?? '').trim();
    const nextAddress = String(address ?? existing.address ?? '').trim();
    const nextTin = String(tin ?? existing.tin ?? '').trim();
    const nextTerms = Math.max(0, Math.round(Number(paymentTerms ?? existing.payment_terms ?? 0)));
    const nowIso = new Date().toISOString();

    const changes: string[] = [];
    if (cleanCode !== String(existing.code || '')) changes.push(`Code: ${existing.code || '—'} -> ${cleanCode}`);
    if (cleanName !== String(existing.name || '')) changes.push(`Name: ${existing.name || '—'} -> ${cleanName}`);
    if (nextContact !== String(existing.contact_person || '')) changes.push(`Contact: ${existing.contact_person || '—'} -> ${nextContact || '—'}`);
    if (nextPhone !== String(existing.phone || '')) changes.push(`Phone: ${existing.phone || '—'} -> ${nextPhone || '—'}`);
    if (nextEmail !== String(existing.email || '')) changes.push(`Email: ${existing.email || '—'} -> ${nextEmail || '—'}`);
    if (nextAddress !== String(existing.address || '')) changes.push(`Address: ${existing.address || '—'} -> ${nextAddress || '—'}`);
    if (nextTin !== String(existing.tin || '')) changes.push(`TIN: ${existing.tin || '—'} -> ${nextTin || '—'}`);
    if (nextTerms !== Number(existing.payment_terms || 0)) changes.push(`Terms: ${existing.payment_terms || 0}d -> ${nextTerms}d`);

    db.prepare(`
      UPDATE suppliers
      SET code = ?, name = ?, contact_person = ?, phone = ?, email = ?, address = ?, tin = ?, payment_terms = ?, updated_by = ?, updated_by_name = ?, updated_at = ?
      WHERE id = ?
    `).run(
      cleanCode,
      cleanName,
      nextContact,
      nextPhone,
      nextEmail,
      nextAddress,
      nextTin,
      nextTerms,
      req.authUser!.id,
      req.authUser!.fullName,
      nowIso,
      existing.id,
    );
    writeAuditLog(
      req.authUser!.id,
      req.authUser!.fullName,
      'UPDATE_SUPPLIER',
      'Supplier',
      existing.id,
      changes.length > 0 ? changes.join(' | ') : `Reviewed supplier profile (${cleanName})`,
    );
    res.json({ ok: true, id: existing.id });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.delete('/procurement/suppliers/:id', requirePerm(PERMISSIONS.PO_CREATE), (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id) as any;
    if (!existing) {
      res.status(404).json({ error: 'Supplier not found' });
      return;
    }
    const poRef = db.prepare('SELECT COUNT(*) AS cnt FROM purchase_orders WHERE supplier_id = ?').get(existing.id) as { cnt: number };
    const invRef = db.prepare('SELECT COUNT(*) AS cnt FROM supplier_invoices WHERE supplier_id = ?').get(existing.id) as { cnt: number };
    const hasHistory = (poRef?.cnt || 0) > 0 || (invRef?.cnt || 0) > 0;
    const nowIso = new Date().toISOString();

    if (hasHistory) {
      db.prepare('UPDATE suppliers SET is_active = 0, updated_by = ?, updated_by_name = ?, updated_at = ? WHERE id = ?')
        .run(req.authUser!.id, req.authUser!.fullName, nowIso, existing.id);
    } else {
      db.prepare('DELETE FROM supplier_items WHERE supplier_id = ?').run(existing.id);
      db.prepare('DELETE FROM suppliers WHERE id = ?').run(existing.id);
    }
    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'DELETE_SUPPLIER', 'Supplier', existing.id, {
      name: existing.name,
      archived: hasHistory,
    });
    res.json({ ok: true, archived: hasHistory });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/procurement/purchase-orders', requirePerm(PERMISSIONS.PO_CREATE), (req, res) => {
  try {
    const { supplierId, locationId, expectedAt, notes, items, status } = req.body;
    if (!items?.length) throw new Error('PO requires at least one item');
    const requestedStatus = String(status || 'PENDING_APPROVAL').toUpperCase();
    if (!['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(requestedStatus)) {
      throw new Error('Invalid initial purchase order status');
    }
    const thresholdRow = db.prepare("SELECT value FROM app_settings WHERE key = 'po_approval_threshold'").get() as { value?: string } | undefined;
    const parsedThreshold = Number(thresholdRow?.value);
    const approvalThreshold = Number.isFinite(parsedThreshold) && parsedThreshold >= 0 ? round2(parsedThreshold) : 10000;
    const totalAmount = round2(items.reduce((s: number, i: any) => s + Number(i.orderedQty) * Number(i.unitCost), 0));

    if (requestedStatus === 'APPROVED') {
      const canApprove =
        req.authUser!.roleCode === 'SUPER_ADMIN' ||
        req.authUser!.roleCode === 'BUSINESS_OWNER' ||
        req.authUser!.permissions.includes(PERMISSIONS.PO_APPROVE);
      if (!canApprove) {
        res.status(403).json({ error: 'Insufficient permission to approve purchase orders' });
        return;
      }
      if (totalAmount > approvalThreshold) {
        throw new Error(
          `Order total (${totalAmount.toFixed(2)}) exceeds the ${approvalThreshold.toFixed(2)} threshold. Submit for Stage 1 verification and Stage 2 Manager Digital Signature.`,
        );
      }
    }

    const poId = randomUUID();
    const poNumber = `PO-${Date.now().toString().slice(-6)}`;

    db.transaction(() => {
      db.prepare('INSERT INTO purchase_orders (id, po_number, supplier_id, location_id, status, total_amount, approved_by, notes, expected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          poId,
          poNumber,
          supplierId,
          locationId,
          requestedStatus,
          totalAmount,
          requestedStatus === 'APPROVED' ? req.authUser!.id : null,
          notes || '',
          expectedAt || null,
        );
      const ins = db.prepare('INSERT INTO purchase_order_items (id, purchase_order_id, inventory_item_id, ordered_qty, unit_cost) VALUES (?, ?, ?, ?, ?)');
      for (const i of items) {
        ins.run(randomUUID(), poId, i.inventoryItemId, Number(i.orderedQty), Number(i.unitCost));
      }
      writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'CREATE_PO', 'PurchaseOrder', poId, {
        poNumber,
        totalAmount,
        status: requestedStatus,
      });
    })();
    res.status(201).json({ id: poId, poNumber, status: requestedStatus });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put('/procurement/purchase-orders/:id', (req, res) => {
  try {
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id) as any;
    if (!po) {
      res.status(404).json({ error: 'Purchase order not found' });
      return;
    }

    const { supplierId, locationId, expectedAt, notes, items, approve, status } = req.body || {};
    const requestedStatus = status ? String(status).toUpperCase() : undefined;

    if (requestedStatus === 'PAID' && (po.status === 'RECEIVED' || po.status === 'PARTIAL' || po.status === 'PARTIALLY_RECEIVED')) {
      const canFinance =
        req.authUser!.roleCode === 'SUPER_ADMIN' ||
        req.authUser!.roleCode === 'BUSINESS_OWNER' ||
        req.authUser!.permissions.includes(PERMISSIONS.FINANCE_VIEW) ||
        req.authUser!.permissions.includes(PERMISSIONS.PO_APPROVE);
      if (!canFinance) {
        res.status(403).json({ error: 'Insufficient permission to mark purchase order as paid' });
        return;
      }
      db.prepare("UPDATE purchase_orders SET status = 'PAID' WHERE id = ?").run(po.id);
      writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'MARK_PO_PAID', 'PurchaseOrder', po.id, { poNumber: po.po_number });
      res.json({ ok: true, id: po.id, poNumber: po.po_number, status: 'PAID', totalAmount: po.total_amount });
      return;
    }

    if (po.status !== 'DRAFT' && po.status !== 'PENDING_APPROVAL') {
      throw new Error('Only draft or pending purchase orders can be edited');
    }
    if (!supplierId || !locationId) throw new Error('Supplier and delivery location are required');
    if (!Array.isArray(items) || items.length === 0) throw new Error('PO requires at least one item');

    const thresholdRow = db.prepare("SELECT value FROM app_settings WHERE key = 'po_approval_threshold'").get() as { value?: string } | undefined;
    const parsedThreshold = Number(thresholdRow?.value);
    const approvalThreshold = Number.isFinite(parsedThreshold) && parsedThreshold >= 0 ? round2(parsedThreshold) : 10000;
    const totalAmount = round2(items.reduce((s: number, i: any) => s + Number(i.orderedQty) * Number(i.unitCost), 0));
    const wantsApproval = Boolean(approve) || requestedStatus === 'APPROVED' || requestedStatus === 'PENDING_MANAGER_SIGNATURE';

    if (wantsApproval) {
      const canApprove =
        req.authUser!.roleCode === 'SUPER_ADMIN' ||
        req.authUser!.roleCode === 'BUSINESS_OWNER' ||
        req.authUser!.permissions.includes(PERMISSIONS.PO_APPROVE);
      if (!canApprove) {
        res.status(403).json({ error: 'Insufficient permission to approve purchase orders' });
        return;
      }
    }

    const requiresSignature = wantsApproval && totalAmount > approvalThreshold;
    const nextStatus = wantsApproval
      ? requiresSignature
        ? 'PENDING_MANAGER_SIGNATURE'
        : 'APPROVED'
      : requestedStatus === 'DRAFT'
        ? 'DRAFT'
        : 'PENDING_APPROVAL';
    const nowIso = new Date().toISOString();

    db.transaction(() => {
      db.prepare(`
        UPDATE purchase_orders
        SET supplier_id = ?, location_id = ?, status = ?, total_amount = ?,
            approved_by = COALESCE(?, approved_by),
            stage1_approved_by = COALESCE(?, stage1_approved_by),
            stage1_approved_by_name = COALESCE(?, stage1_approved_by_name),
            stage1_approved_at = COALESCE(?, stage1_approved_at),
            notes = ?, expected_at = ?
        WHERE id = ?
      `).run(
        supplierId,
        locationId,
        nextStatus,
        totalAmount,
        nextStatus === 'APPROVED' ? req.authUser!.id : null,
        nextStatus === 'PENDING_MANAGER_SIGNATURE' ? req.authUser!.id : null,
        nextStatus === 'PENDING_MANAGER_SIGNATURE' ? req.authUser!.fullName : null,
        nextStatus === 'PENDING_MANAGER_SIGNATURE' ? nowIso : null,
        notes || '',
        expectedAt || null,
        po.id,
      );
      db.prepare('DELETE FROM purchase_order_items WHERE purchase_order_id = ?').run(po.id);
      const ins = db.prepare('INSERT INTO purchase_order_items (id, purchase_order_id, inventory_item_id, ordered_qty, unit_cost) VALUES (?, ?, ?, ?, ?)');
      for (const i of items) {
        ins.run(String(i.id || randomUUID()), po.id, i.inventoryItemId, Number(i.orderedQty), Number(i.unitCost));
      }
      writeAuditLog(
        req.authUser!.id,
        req.authUser!.fullName,
        nextStatus === 'PENDING_MANAGER_SIGNATURE'
          ? 'STAGE1_APPROVE_PO'
          : nextStatus === 'APPROVED'
            ? 'REVIEW_AND_APPROVE_PO'
            : 'EDIT_PO',
        'PurchaseOrder',
        po.id,
        { poNumber: po.po_number, totalAmount, status: nextStatus },
      );
    })();
    res.json({ ok: true, id: po.id, poNumber: po.po_number, status: nextStatus, requiresSignature, totalAmount });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/procurement/purchase-orders/:id/approve', requirePerm(PERMISSIONS.PO_APPROVE), (req, res) => {
  try {
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id) as any;
    if (!po) {
      res.status(404).json({ error: 'Purchase order not found' });
      return;
    }

    const thresholdRow = db.prepare("SELECT value FROM app_settings WHERE key = 'po_approval_threshold'").get() as { value?: string } | undefined;
    const parsedThreshold = Number(thresholdRow?.value);
    const approvalThreshold = Number.isFinite(parsedThreshold) && parsedThreshold >= 0 ? round2(parsedThreshold) : 10000;
    const totalAmount = round2(Number(po.total_amount || 0));
    const nowIso = new Date().toISOString();

    if (po.status === 'DRAFT' || po.status === 'PENDING_APPROVAL') {
      if (totalAmount > approvalThreshold) {
        db.prepare(`
          UPDATE purchase_orders
          SET status = 'PENDING_MANAGER_SIGNATURE', stage1_approved_by = ?, stage1_approved_by_name = ?, stage1_approved_at = ?
          WHERE id = ?
        `).run(req.authUser!.id, req.authUser!.fullName, nowIso, po.id);
        writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'STAGE1_APPROVE_PO', 'PurchaseOrder', po.id, {
          poNumber: po.po_number,
          totalAmount,
          approvalThreshold,
        });
        res.json({ ok: true, status: 'PENDING_MANAGER_SIGNATURE', requiresSignature: true });
        return;
      }

      db.prepare("UPDATE purchase_orders SET status = 'APPROVED', approved_by = ? WHERE id = ?").run(req.authUser!.id, po.id);
      writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'APPROVE_PO', 'PurchaseOrder', po.id, {
        poNumber: po.po_number,
        totalAmount,
      });
      res.json({ ok: true, status: 'APPROVED', requiresSignature: false });
      return;
    }

    if (po.status === 'PENDING_MANAGER_SIGNATURE') {
      const signatureData = String(req.body?.signatureData || '').trim();
      const signerName = String(req.body?.signerName || req.authUser!.fullName || '').trim().slice(0, 150);
      if (!signatureData.startsWith('data:image/') || signatureData.length < 30 || signatureData.length > 200000) {
        throw new Error('A valid drawn manager digital signature is required for this purchase order');
      }
      if (!signerName) {
        throw new Error('Manager signer name is required');
      }
      db.prepare(`
        UPDATE purchase_orders
        SET status = 'APPROVED', approved_by = ?, manager_signature_data = ?, manager_signer_name = ?, signed_at = ?
        WHERE id = ?
      `).run(req.authUser!.id, signatureData, signerName, nowIso, po.id);
      writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'STAGE2_SIGN_APPROVE_PO', 'PurchaseOrder', po.id, {
        poNumber: po.po_number,
        signerName,
        totalAmount,
        signedAt: nowIso,
      });
      res.json({ ok: true, status: 'APPROVED', signedAt: nowIso });
      return;
    }

    res.status(400).json({ error: 'Only draft, pending approval, or signature-pending purchase orders can be approved' });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/procurement/purchase-orders/:id/cancel', requirePerm(PERMISSIONS.PO_CREATE), (req, res) => {
  try {
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id) as any;
    if (!po) {
      res.status(404).json({ error: 'Purchase order not found' });
      return;
    }
    if (po.status !== 'DRAFT' && po.status !== 'PENDING_APPROVAL' && po.status !== 'PENDING_MANAGER_SIGNATURE' && po.status !== 'APPROVED') {
      throw new Error('Only draft, pending, signature-pending, or unreceived approved purchase orders can be cancelled');
    }
    const items = db.prepare('SELECT received_qty FROM purchase_order_items WHERE purchase_order_id = ?').all(po.id) as any[];
    if (items.some((x) => Number(x.received_qty || 0) > 0)) {
      throw new Error('Cannot cancel a purchase order that already has received goods');
    }
    const reason = String(req.body?.reason || '').trim();
    const cancelNote = reason ? `Cancelled: ${reason}` : 'Cancelled by user';
    const nextNotes = po.notes ? `${po.notes} | ${cancelNote}` : cancelNote;
    db.prepare("UPDATE purchase_orders SET status = 'CANCELLED', notes = ? WHERE id = ?").run(nextNotes, po.id);
    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'CANCEL_PO', 'PurchaseOrder', po.id, { poNumber: po.po_number, reason: reason || null });
    res.json({ ok: true, id: po.id, status: 'CANCELLED' });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/procurement/purchase-orders/:id/receive', requirePerm(PERMISSIONS.GRN_RECEIVE), (req, res) => {
  try {
    const { items, notes } = req.body;
    const result = db.transaction(() => {
      const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id) as any;
      if (!po) throw new Error('PO not found');
      if (po.status !== 'APPROVED' && po.status !== 'PARTIAL') throw new Error('PO must be APPROVED or PARTIAL to receive');

      const grnId = randomUUID();
      const grnNumber = `GRN-${Date.now().toString().slice(-6)}`;
      db.prepare('INSERT INTO goods_receipts (id, grn_number, purchase_order_id, received_by, notes) VALUES (?, ?, ?, ?, ?)')
        .run(grnId, grnNumber, po.id, req.authUser!.id, notes || '');

      let totalRecvValue = 0;
      const poItems = db.prepare('SELECT * FROM purchase_order_items WHERE purchase_order_id = ?').all(po.id) as any[];

      for (const line of items) {
        const poItem = poItems.find((x) => x.id === line.poItemId);
        if (!poItem) continue;
        const recvQty = Number(line.receivedQty || 0);
        const rejQty = Number(line.rejectedQty || 0);
        const unitCost = Number(line.unitCost ?? poItem.unit_cost);
        const batchNo = line.batchNumber || `${grnNumber}-${poItem.inventory_item_id.slice(0, 4)}`;

        db.prepare(`
          INSERT INTO goods_receipt_items (id, goods_receipt_id, inventory_item_id, ordered_qty, received_qty, rejected_qty, unit_cost, batch_number, expiry_date, discrepancy_notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), grnId, poItem.inventory_item_id, poItem.ordered_qty, recvQty, rejQty, unitCost, batchNo, line.expiryDate || null, line.discrepancyNotes || null);

        if (recvQty > 0) {
          receiveStockTx({
            inventoryItemId: poItem.inventory_item_id,
            locationId: po.location_id,
            quantity: recvQty,
            unitCost,
            batchNumber: batchNo,
            expiryDate: line.expiryDate || null,
            txnType: 'IN_PURCHASE',
            referenceType: 'GRN',
            referenceId: grnId,
            userId: req.authUser!.id,
            notes: `GRN ${grnNumber} (${po.po_number})`,
          });
          totalRecvValue += round2(recvQty * unitCost);
          db.prepare('UPDATE purchase_order_items SET received_qty = received_qty + ? WHERE id = ?').run(recvQty, poItem.id);
        }
      }

      const refreshed = db.prepare('SELECT ordered_qty, received_qty FROM purchase_order_items WHERE purchase_order_id = ?').all(po.id) as any[];
      const allDone = refreshed.every((x) => x.received_qty >= x.ordered_qty);
      db.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?').run(allDone ? 'RECEIVED' : 'PARTIAL', po.id);

      // Record Supplier Invoice + Accounting JE (DR 1200 Inventory / CR 2000 AP)
      if (totalRecvValue > 0) {
        const invId = randomUUID();
        db.prepare(`
          INSERT INTO supplier_invoices (id, invoice_number, supplier_id, purchase_order_id, total_amount, due_date, status)
          VALUES (?, ?, ?, ?, ?, datetime('now', '+15 days'), 'UNPAID')
        `).run(invId, `SI-${grnNumber}`, po.supplier_id, po.id, round2(totalRecvValue));

        const jeId = randomUUID();
        db.prepare('INSERT INTO journal_entries (id, entry_number, entry_date, description, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?)')
          .run(jeId, `JE-${grnNumber}`, new Date().toISOString(), `Goods Receipt ${grnNumber}`, 'GRN', grnId);
        db.prepare('INSERT INTO journal_lines (id, journal_entry_id, account_id, debit, credit, memo) VALUES (?, ?, ?, ?, ?, ?)')
          .run(randomUUID(), jeId, 'acc_1200', round2(totalRecvValue), 0, 'Inventory Received');
        db.prepare('INSERT INTO journal_lines (id, journal_entry_id, account_id, debit, credit, memo) VALUES (?, ?, ?, ?, ?, ?)')
          .run(randomUUID(), jeId, 'acc_2000', 0, round2(totalRecvValue), 'Supplier Payable');
      }

      writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'RECEIVE_GRN', 'GoodsReceipt', grnId, { poNumber: po.po_number, totalRecvValue });
      return { grnId, grnNumber, totalRecvValue: round2(totalRecvValue) };
    })();
    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/procurement/invoices/:id/pay', requirePerm(PERMISSIONS.FINANCE_VIEW), (req, res) => {
  try {
    const payAmt = round2(Number(req.body.amount));
    db.transaction(() => {
      const inv = db.prepare('SELECT * FROM supplier_invoices WHERE id = ?').get(req.params.id) as any;
      if (!inv) throw new Error('Invoice not found');
      const newPaid = round2(inv.paid_amount + payAmt);
      if (newPaid > inv.total_amount + 0.01) throw new Error('Payment exceeds invoice balance');
      const payNo = `PAY-${Date.now().toString().slice(-6)}`;
      db.prepare('INSERT INTO supplier_payments (id, payment_number, supplier_invoice_id, amount, method, reference_no, paid_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), payNo, inv.id, payAmt, req.body.method || 'BANK_TRANSFER', req.body.referenceNo || '', req.authUser!.id);
      const nextInvStatus = newPaid >= inv.total_amount ? 'PAID' : 'PARTIAL';
      db.prepare('UPDATE supplier_invoices SET paid_amount = ?, status = ? WHERE id = ?')
        .run(newPaid, nextInvStatus, inv.id);

      if (nextInvStatus === 'PAID' && inv.purchase_order_id) {
        const linkedPo = db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(inv.purchase_order_id) as { status: string } | undefined;
        const poInvs = db.prepare('SELECT status FROM supplier_invoices WHERE purchase_order_id = ?').all(inv.purchase_order_id) as { status: string }[];
        if (linkedPo?.status === 'RECEIVED' && poInvs.length > 0 && poInvs.every((x) => x.status === 'PAID')) {
          db.prepare("UPDATE purchase_orders SET status = 'PAID' WHERE id = ?").run(inv.purchase_order_id);
        }
      }

      const jeId = randomUUID();
      db.prepare('INSERT INTO journal_entries (id, entry_number, entry_date, description, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(jeId, `JE-${payNo}`, new Date().toISOString(), `Supplier Payment ${inv.invoice_number}`, 'AP_PAYMENT', inv.id);
      db.prepare('INSERT INTO journal_lines (id, journal_entry_id, account_id, debit, credit, memo) VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), jeId, 'acc_2000', payAmt, 0, 'Accounts Payable Settled');
      db.prepare('INSERT INTO journal_lines (id, journal_entry_id, account_id, debit, credit, memo) VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), jeId, 'acc_1010', 0, payAmt, 'Bank/Cash Disbursement');
    })();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// 7. FINANCE, EXPENSES, CLOSING & ACCOUNTING
// ==========================================
apiRouter.get('/finance/overview', requirePerm(PERMISSIONS.FINANCE_VIEW), (req, res) => {
  const { from, to } = req.query as Record<string, string | undefined>;
  const expenses = db
    .prepare(`
      SELECT e.*, l.name AS location_name, a.name AS account_name
      FROM expenses e
      JOIN locations l ON l.id = e.location_id
      JOIN accounts a ON a.id = e.account_id
      ORDER BY e.expense_date DESC
      LIMIT 60
    `)
    .all();

  const closings = db
    .prepare(`
      SELECT dc.*, l.name AS location_name, u.full_name AS closed_by_name
      FROM daily_closings dc
      JOIN locations l ON l.id = dc.location_id
      JOIN users u ON u.id = dc.closed_by
      ORDER BY dc.business_date DESC
      LIMIT 30
    `)
    .all();

  const journals = (
    db.prepare('SELECT * FROM journal_entries ORDER BY entry_date DESC, created_at DESC LIMIT 40').all() as any[]
  ).map((je) => ({
    ...je,
    lines: db
      .prepare('SELECT jl.*, a.code AS account_code, a.name AS account_name FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE jl.journal_entry_id = ?')
      .all(je.id),
  }));

  const accounts = db.prepare('SELECT * FROM accounts ORDER BY code ASC').all();
  const expenseCategories = db.prepare('SELECT * FROM expense_categories ORDER BY sort_order ASC, name ASC').all();
  const pettyCash = db
    .prepare('SELECT pc.*, l.name AS location_name FROM petty_cash_funds pc JOIN locations l ON l.id = pc.location_id')
    .all();
  const periods = db.prepare('SELECT * FROM financial_periods ORDER BY period_start DESC').all();
  const statements = getFinancialStatements(from, to);

  res.json({ expenses, closings, journals, accounts, pettyCash, periods, statements, expenseCategories });
});

apiRouter.get('/finance/weekly-food-cost', requirePerm(PERMISSIONS.FINANCE_VIEW), (req, res) => {
  try {
    const locationId = typeof req.query.locationId === 'string' ? req.query.locationId.trim() : undefined;
    const rawWeeks = Number(req.query.weeks || 8);
    const weeks = Number.isFinite(rawWeeks) ? Math.min(26, Math.max(2, Math.round(rawWeeks))) : 8;
    res.json(getWeeklyFoodCostTrends({ locationId, weeks }));
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Unable to compute weekly food cost trends' });
  }
});

apiRouter.post('/finance/expenses', requirePerm(PERMISSIONS.FINANCE_VIEW), (req, res) => {
  try {
    const { locationId, accountId, category, amount, description, expenseDate, paidFromPettyCash, isRecurring } = req.body;
    const amt = round2(Number(amount));
    if (amt <= 0) throw new Error('Amount must be positive');

    const expId = randomUUID();
    db.transaction(() => {
      db.prepare(`
        INSERT INTO expenses (id, location_id, account_id, category, amount, description, is_recurring, paid_from_petty_cash, expense_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(expId, locationId, accountId, category, amt, description, isRecurring ? 1 : 0, paidFromPettyCash ? 1 : 0, expenseDate || new Date().toISOString());

      if (paidFromPettyCash) {
        const fund = db.prepare('SELECT * FROM petty_cash_funds WHERE location_id = ?').get(locationId) as any;
        if (!fund || fund.current_balance < amt) throw new Error('Insufficient petty cash balance');
        db.prepare('UPDATE petty_cash_funds SET current_balance = current_balance - ? WHERE id = ?').run(amt, fund.id);
      }

      const jeId = randomUUID();
      db.prepare('INSERT INTO journal_entries (id, entry_number, entry_date, description, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(jeId, `JE-EXP-${Date.now().toString().slice(-6)}`, expenseDate || new Date().toISOString(), `${category}: ${description}`, 'EXPENSE', expId);
      db.prepare('INSERT INTO journal_lines (id, journal_entry_id, account_id, debit, credit, memo) VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), jeId, accountId, amt, 0, description);
      db.prepare('INSERT INTO journal_lines (id, journal_entry_id, account_id, debit, credit, memo) VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), jeId, 'acc_1000', 0, amt, paidFromPettyCash ? 'Petty Cash Disbursement' : 'Cash Disbursement');

      writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'RECORD_EXPENSE', 'Expense', expId, { category, amt });
    })();
    res.status(201).json({ id: expId });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put('/finance/expenses/:id', requirePerm(PERMISSIONS.FINANCE_VIEW), (req, res) => {
  try {
    const expId = req.params.id;
    const { locationId, accountId, category, amount, description, expenseDate, paidFromPettyCash, isRecurring } = req.body;
    const amt = round2(Number(amount));
    if (amt <= 0) throw new Error('Amount must be positive');

    const existing = db.prepare('SELECT * FROM expenses WHERE id = ?').get(expId) as any;
    if (!existing) {
      res.status(404).json({ error: 'Expense not found' });
      return;
    }

    db.transaction(() => {
      // Revert previous petty cash deduction if applicable
      if (existing.paid_from_petty_cash) {
        db.prepare('UPDATE petty_cash_funds SET current_balance = current_balance + ? WHERE location_id = ?')
          .run(existing.amount, existing.location_id);
      }

      // Deduct from new petty cash fund if requested
      if (paidFromPettyCash) {
        const fund = db.prepare('SELECT * FROM petty_cash_funds WHERE location_id = ?').get(locationId) as any;
        if (!fund || fund.current_balance < amt) throw new Error('Insufficient petty cash balance for updated amount');
        db.prepare('UPDATE petty_cash_funds SET current_balance = current_balance - ? WHERE id = ?')
          .run(amt, fund.id);
      }

      db.prepare(`
        UPDATE expenses
        SET location_id = ?, account_id = ?, category = ?, amount = ?, description = ?, is_recurring = ?, paid_from_petty_cash = ?, expense_date = ?
        WHERE id = ?
      `).run(locationId, accountId, category, amt, description, isRecurring ? 1 : 0, paidFromPettyCash ? 1 : 0, expenseDate || existing.expense_date, expId);

      // Re-sync linked journal entry
      const je = db.prepare("SELECT * FROM journal_entries WHERE reference_type = 'EXPENSE' AND reference_id = ?").get(expId) as any;
      if (je) {
        db.prepare('UPDATE journal_entries SET entry_date = ?, description = ? WHERE id = ?')
          .run(expenseDate || existing.expense_date, `${category}: ${description}`, je.id);
        db.prepare('DELETE FROM journal_lines WHERE journal_entry_id = ?').run(je.id);
        db.prepare('INSERT INTO journal_lines (id, journal_entry_id, account_id, debit, credit, memo) VALUES (?, ?, ?, ?, ?, ?)')
          .run(randomUUID(), je.id, accountId, amt, 0, description);
        db.prepare('INSERT INTO journal_lines (id, journal_entry_id, account_id, debit, credit, memo) VALUES (?, ?, ?, ?, ?, ?)')
          .run(randomUUID(), je.id, 'acc_1000', 0, amt, paidFromPettyCash ? 'Petty Cash Disbursement' : 'Cash Disbursement');
      }

      writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'UPDATE_EXPENSE', 'Expense', expId, { category, amt, description });
    })();

    res.json({ ok: true, id: expId });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.delete('/finance/expenses/:id', requirePerm(PERMISSIONS.FINANCE_VIEW), (req, res) => {
  try {
    const expId = req.params.id;
    const existing = db.prepare('SELECT * FROM expenses WHERE id = ?').get(expId) as any;
    if (!existing) {
      res.status(404).json({ error: 'Expense not found' });
      return;
    }

    db.transaction(() => {
      if (existing.paid_from_petty_cash) {
        db.prepare('UPDATE petty_cash_funds SET current_balance = current_balance + ? WHERE location_id = ?')
          .run(existing.amount, existing.location_id);
      }

      const je = db.prepare("SELECT id FROM journal_entries WHERE reference_type = 'EXPENSE' AND reference_id = ?").get(expId) as any;
      if (je) {
        db.prepare('DELETE FROM journal_lines WHERE journal_entry_id = ?').run(je.id);
        db.prepare('DELETE FROM journal_entries WHERE id = ?').run(je.id);
      }

      db.prepare('DELETE FROM expenses WHERE id = ?').run(expId);
      writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'DELETE_EXPENSE', 'Expense', expId, {
        category: existing.category,
        amount: existing.amount,
      });
    })();

    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.get('/finance/expense-categories', requirePerm(PERMISSIONS.FINANCE_VIEW), (_req, res) => {
  const categories = db.prepare('SELECT * FROM expense_categories ORDER BY sort_order ASC, name ASC').all();
  res.json(categories);
});

apiRouter.post('/finance/expense-categories', requirePerm(PERMISSIONS.FINANCE_VIEW), (req, res) => {
  try {
    const { code, name, description, sortOrder, isActive } = req.body;
    const cleanCode = String(code || '').trim().toUpperCase().replace(/\s+/g, '_');
    const cleanName = String(name || '').trim();
    if (!cleanCode || !cleanName) throw new Error('Code and Name are required');

    const id = `cat_${cleanCode.toLowerCase()}`;
    db.prepare(`
      INSERT INTO expense_categories (id, code, name, description, sort_order, is_active)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, cleanCode, cleanName, description || null, Number(sortOrder) || 0, isActive === false ? 0 : 1);

    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'CREATE_EXPENSE_CATEGORY', 'ExpenseCategory', id, { code: cleanCode, name: cleanName });
    res.status(201).json({ id, code: cleanCode, name: cleanName });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put('/finance/expense-categories/:id', requirePerm(PERMISSIONS.FINANCE_VIEW), (req, res) => {
  try {
    const id = req.params.id;
    const { code, name, description, sortOrder, isActive } = req.body;
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('Name is required');

    const existing = db.prepare('SELECT * FROM expense_categories WHERE id = ?').get(id) as any;
    if (!existing) {
      res.status(404).json({ error: 'Expense category not found' });
      return;
    }

    const nextCode = code ? String(code).trim().toUpperCase().replace(/\s+/g, '_') : existing.code;
    db.prepare(`
      UPDATE expense_categories
      SET code = ?, name = ?, description = ?, sort_order = ?, is_active = ?
      WHERE id = ?
    `).run(
      nextCode,
      cleanName,
      description !== undefined ? description : existing.description,
      sortOrder !== undefined ? Number(sortOrder) : existing.sort_order,
      isActive === undefined ? existing.is_active : (isActive ? 1 : 0),
      id,
    );

    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'UPDATE_EXPENSE_CATEGORY', 'ExpenseCategory', id, { code: nextCode, name: cleanName });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.delete('/finance/expense-categories/:id', requirePerm(PERMISSIONS.FINANCE_VIEW), (req, res) => {
  try {
    const id = req.params.id;
    const existing = db.prepare('SELECT * FROM expense_categories WHERE id = ?').get(id) as any;
    if (!existing) {
      res.status(404).json({ error: 'Expense category not found' });
      return;
    }

    const usageCount = db.prepare('SELECT COUNT(*) AS count FROM expenses WHERE category = ? OR category = ?').get(existing.code, existing.name) as { count: number };
    if (usageCount && usageCount.count > 0) {
      throw new Error(`Cannot delete category "${existing.name}" because it is currently linked to ${usageCount.count} operating expense record(s).`);
    }

    db.prepare('DELETE FROM expense_categories WHERE id = ?').run(id);
    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'DELETE_EXPENSE_CATEGORY', 'ExpenseCategory', id, { code: existing.code });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/finance/accounts', requirePerm(PERMISSIONS.FINANCE_VIEW), (req, res) => {
  try {
    const { code, name, type } = req.body;
    const cleanCode = String(code || '').trim();
    const cleanName = String(name || '').trim();
    const accType = type || 'EXPENSE';
    if (!cleanCode || !cleanName) throw new Error('Account Code and Name are required');

    const existingCode = db.prepare('SELECT id FROM accounts WHERE code = ?').get(cleanCode);
    if (existingCode) throw new Error(`GL Account code ${cleanCode} already exists`);

    const id = `acc_${cleanCode}`;
    db.prepare('INSERT INTO accounts (id, code, name, type, is_system) VALUES (?, ?, ?, ?, 0)')
      .run(id, cleanCode, cleanName, accType);

    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'CREATE_ACCOUNT', 'Account', id, { code: cleanCode, name: cleanName, type: accType });
    res.status(201).json({ id, code: cleanCode, name: cleanName, type: accType, is_system: 0 });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put('/finance/accounts/:id', requirePerm(PERMISSIONS.FINANCE_VIEW), (req, res) => {
  try {
    const id = req.params.id;
    const { code, name } = req.body;
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('Account Name is required');

    const existing = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as any;
    if (!existing) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    const nextCode = code ? String(code).trim() : existing.code;
    if (nextCode !== existing.code) {
      if (existing.is_system === 1) throw new Error('System account codes cannot be modified');
      const conflict = db.prepare('SELECT id FROM accounts WHERE code = ? AND id != ?').get(nextCode, id);
      if (conflict) throw new Error(`GL Account code ${nextCode} already exists`);
    }

    db.prepare('UPDATE accounts SET code = ?, name = ? WHERE id = ?').run(nextCode, cleanName, id);
    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'UPDATE_ACCOUNT', 'Account', id, { code: nextCode, name: cleanName });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.delete('/finance/accounts/:id', requirePerm(PERMISSIONS.FINANCE_VIEW), (req, res) => {
  try {
    const id = req.params.id;
    const existing = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as any;
    if (!existing) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    if (existing.is_system === 1) {
      throw new Error(`Cannot delete system account "${existing.name}" (${existing.code})`);
    }

    const usedInJL = db.prepare('SELECT COUNT(*) AS count FROM journal_lines WHERE account_id = ?').get(id) as { count: number };
    if (usedInJL && usedInJL.count > 0) {
      throw new Error(`Cannot delete account "${existing.name}" because it has ${usedInJL.count} posted journal transaction(s).`);
    }

    const usedInExp = db.prepare('SELECT COUNT(*) AS count FROM expenses WHERE account_id = ?').get(id) as { count: number };
    if (usedInExp && usedInExp.count > 0) {
      throw new Error(`Cannot delete account "${existing.name}" because it is linked to ${usedInExp.count} operating expense record(s).`);
    }

    db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'DELETE_ACCOUNT', 'Account', id, { code: existing.code });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// AI-based Inventory Forecasting Endpoint
apiRouter.post('/ai/inventory-forecast', async (req, res) => {
  try {
    const { locationId, horizonDays = 5, truckName, inventorySummary, recentSalesSummary } = req.body || {};
    const days = Math.max(1, Math.min(14, Number(horizonDays) || 5));

    // Fallback algorithmic forecasting logic based on local DB if inventory/sales summaries not fully supplied
    let stockItems = inventorySummary;
    let salesTrends = recentSalesSummary;

    if (!Array.isArray(stockItems) || stockItems.length === 0) {
      stockItems = db.prepare(`
        SELECT i.id, i.sku, i.name, i.category, i.unit_of_measure, i.cost_per_unit, i.reorder_point,
               COALESCE(SUM(b.remaining_qty), 0) AS on_hand
        FROM inventory_items i
        LEFT JOIN stock_batches b ON b.inventory_item_id = i.id AND (b.location_id = ? OR ? IS NULL OR ? = '')
        GROUP BY i.id
        ORDER BY i.category ASC, i.name ASC
      `).all(locationId || null, locationId || null, locationId || null);
    }

    if (!Array.isArray(salesTrends) || salesTrends.length === 0) {
      salesTrends = db.prepare(`
        SELECT si.product_name, SUM(si.quantity) as total_qty, SUM(si.line_total) as total_revenue
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        WHERE s.status = 'COMPLETED' AND s.sold_at >= datetime('now', '-7 days')
          AND (s.location_id = ? OR ? IS NULL OR ? = '')
        GROUP BY si.product_name
        ORDER BY total_qty DESC
      `).all(locationId || null, locationId || null, locationId || null);
    }

    const recipeMap: Record<string, Array<{ ingredientSku: string; name: string; qty: number; uom: string }>> = {
      'Double Wagyu Smash Burger': [
        { ingredientSku: 'ING-BEEF-01', name: 'Wagyu Beef Patties', qty: 2, uom: 'pcs' },
        { ingredientSku: 'ING-BUN-01', name: 'Brioche Burger Buns', qty: 1, uom: 'pcs' },
        { ingredientSku: 'ING-CHEESE-01', name: 'Sharp Cheddar Slices', qty: 2, uom: 'slices' },
      ],
      'Crispy Pork Sisig Tacos (3 pcs)': [
        { ingredientSku: 'ING-PORK-01', name: 'Pork Belly & Jowl (Pre-braised)', qty: 0.15, uom: 'kg' },
        { ingredientSku: 'ING-TORT-01', name: 'Corn Tortillas 6-inch', qty: 3, uom: 'pcs' },
      ],
      'Truffle Parmesan Fries': [
        { ingredientSku: 'ING-FRIES-01', name: 'Shoestring French Fries (Frozen)', qty: 0.25, uom: 'kg' },
        { ingredientSku: 'ING-TRUFFLE-01', name: 'White Truffle Aioli Sauce', qty: 0.045, uom: 'liter' },
      ],
      'Guimaras Mango Graham Shake': [
        { ingredientSku: 'ING-MANGO-01', name: 'Fresh Guimaras Mango Puree', qty: 0.22, uom: 'liter' },
      ],
    };

    // Calculate algorithmic burn rate for each item
    const algorithmicItems = stockItems.map((item: any) => {
      const onHand = Number(item.on_hand ?? item.onHand ?? item.currentQty ?? 0);
      const reorderPt = Number(item.reorder_point ?? item.reorderPoint ?? 10);
      const unitCost = Number(item.cost_per_unit ?? item.costPerUnit ?? item.unitCost ?? 50);
      const uom = item.unit_of_measure ?? item.uom ?? 'units';

      // Estimate daily burn from recent sales
      let estimatedDailyBurn = 0;
      for (const sale of salesTrends) {
        const prodName = sale.product_name || sale.productName || '';
        const qtySold = Number(sale.total_qty || sale.quantity || 0);
        const recipes = recipeMap[prodName];
        if (recipes) {
          for (const ing of recipes) {
            if (ing.ingredientSku === item.sku || ing.name.toLowerCase().includes(item.name.toLowerCase()) || item.name.toLowerCase().includes(ing.name.toLowerCase())) {
              estimatedDailyBurn += (ing.qty * qtySold) / 7;
            }
          }
        }
      }

      // If no direct recipe hit, assign reasonable default baseline consumption based on category
      if (estimatedDailyBurn <= 0) {
        estimatedDailyBurn = Math.max(0.8, round2(reorderPt * 0.18));
      } else {
        estimatedDailyBurn = round2(estimatedDailyBurn);
      }

      const projectedDemand = round2(estimatedDailyBurn * days);
      const daysOfSupply = estimatedDailyBurn > 0 ? round2(onHand / estimatedDailyBurn) : 99;
      const projectedStockAfterHorizon = round2(onHand - projectedDemand);
      
      let riskLevel: 'CRITICAL' | 'HIGH' | 'OPTIMAL' = 'OPTIMAL';
      let suggestedRestock = 0;

      if (projectedStockAfterHorizon <= 0) {
        riskLevel = 'CRITICAL';
        suggestedRestock = Math.ceil(Math.abs(projectedStockAfterHorizon) + reorderPt * 1.5);
      } else if (projectedStockAfterHorizon < reorderPt) {
        riskLevel = 'HIGH';
        suggestedRestock = Math.ceil((reorderPt * 1.4) - projectedStockAfterHorizon);
      }

      return {
        id: item.id,
        sku: item.sku,
        name: item.name,
        category: item.category || 'General',
        uom,
        unitCost,
        onHand,
        reorderPt,
        estimatedDailyBurn,
        daysOfSupply,
        projectedDemand,
        projectedStockAfterHorizon: Math.max(0, projectedStockAfterHorizon),
        riskLevel,
        suggestedRestock,
        estimatedCost: round2(suggestedRestock * unitCost),
        reason: riskLevel === 'CRITICAL'
          ? `Stock depletion expected in ${daysOfSupply} days at current sales velocity (${estimatedDailyBurn} ${uom}/day). Restock urgently.`
          : riskLevel === 'HIGH'
          ? `Stock projected to breach reorder point (${reorderPt} ${uom}) within ${days} days.`
          : `Healthy stock buffer. Safe for ${daysOfSupply} days of continuous operation.`,
      };
    });

    // Try calling Gemini if API key is present
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      try {
        const ai = new GoogleGenAI({
          apiKey,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build',
            },
          },
        });
        const prompt = `You are Maximus Food Truck ERP's Master Supply Chain & Food Safety Intelligence Agent.
Analyze the following food truck location inventory and recent sales:
Location: ${truckName || locationId || 'Food Truck'}
Forecasting Horizon: ${days} days

Current Inventory & Stock Status:
${JSON.stringify(
  stockItems.map((s: any) => ({
    sku: s.sku,
    name: s.name,
    onHand: s.on_hand ?? s.onHand ?? s.currentQty,
    reorderPoint: s.reorder_point ?? s.reorderPoint,
    uom: s.unit_of_measure ?? s.uom,
    unitCost: s.cost_per_unit ?? s.costPerUnit,
  })),
  null,
  2
)}

Recent Sales Trend (Past 7 Days):
${JSON.stringify(salesTrends, null, 2)}

Provide an actionable supply chain forecast. Output strictly valid JSON matching this schema:
{
  "summary": {
    "totalItemsAnalyzed": number,
    "criticalCount": number,
    "highRiskCount": number,
    "totalRecommendedRestockUnits": number,
    "totalEstimatedReplenishmentCostPhp": number,
    "strategicAdvice": string (2-3 sentences of operational recommendations for the commissary manager)
  },
  "items": [
    {
      "sku": string,
      "name": string,
      "riskLevel": "CRITICAL" | "HIGH" | "OPTIMAL",
      "daysOfSupply": number,
      "estimatedDailyBurn": number,
      "suggestedRestock": number,
      "reason": string
    }
  ]
}`;

        const response = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
          },
        });

        const rawText = response.text?.trim() || '{}';
        const parsed = JSON.parse(rawText);

        if (parsed.items && Array.isArray(parsed.items)) {
          // Merge Gemini recommendations with exact stock calculations
          const merged = algorithmicItems.map((algo: any) => {
            const gItem = parsed.items.find((gi: any) => gi.sku === algo.sku || gi.name?.toLowerCase() === algo.name.toLowerCase());
            if (gItem) {
              return {
                ...algo,
                riskLevel: gItem.riskLevel || algo.riskLevel,
                daysOfSupply: Number(gItem.daysOfSupply) || algo.daysOfSupply,
                estimatedDailyBurn: Number(gItem.estimatedDailyBurn) || algo.estimatedDailyBurn,
                suggestedRestock: Number(gItem.suggestedRestock) || algo.suggestedRestock,
                estimatedCost: round2((Number(gItem.suggestedRestock) || algo.suggestedRestock) * algo.unitCost),
                reason: gItem.reason || algo.reason,
              };
            }
            return algo;
          });

          const totalCost = round2(merged.reduce((s: number, i: any) => s + i.estimatedCost, 0));
          const criticalCount = merged.filter((i: any) => i.riskLevel === 'CRITICAL').length;
          const highCount = merged.filter((i: any) => i.riskLevel === 'HIGH').length;

          res.json({
            source: 'gemini',
            horizonDays: days,
            summary: {
              totalItemsAnalyzed: merged.length,
              criticalCount,
              highRiskCount: highCount,
              totalRecommendedRestockUnits: merged.reduce((s: number, i: any) => s + i.suggestedRestock, 0),
              totalEstimatedReplenishmentCostPhp: totalCost,
              strategicAdvice: parsed.summary?.strategicAdvice || `Forecast suggests immediate replenishment for ${criticalCount} critical items to prevent service interruptions during peak operating shifts.`,
            },
            items: merged,
          });
          return;
        }
      } catch (geminiErr: any) {
        console.warn('Gemini API call failed, falling back to algorithmic forecast:', geminiErr?.message || geminiErr);
      }
    }

    // Algorithmic response fallback
    const totalCost = round2(algorithmicItems.reduce((s: number, i: any) => s + i.estimatedCost, 0));
    const criticalCount = algorithmicItems.filter((i: any) => i.riskLevel === 'CRITICAL').length;
    const highCount = algorithmicItems.filter((i: any) => i.riskLevel === 'HIGH').length;

    res.json({
      source: 'algorithmic',
      horizonDays: days,
      summary: {
        totalItemsAnalyzed: algorithmicItems.length,
        criticalCount,
        highRiskCount: highCount,
        totalRecommendedRestockUnits: algorithmicItems.reduce((s: number, i: any) => s + i.suggestedRestock, 0),
        totalEstimatedReplenishmentCostPhp: totalCost,
        strategicAdvice: criticalCount > 0
          ? `Demand projection identified ${criticalCount} ingredient(s) at severe stockout risk within ${days} days based on 7-day sales velocity. Request Commissary Transfer immediately.`
          : `All inventory levels currently maintain adequate safety buffers for the upcoming ${days}-day service cycle.`,
      },
      items: algorithmicItems,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/finance/daily-closing', requirePerm(PERMISSIONS.DAILY_CLOSE), (req, res) => {
  try {
    const { locationId, businessDate, openingFloat, actualCash, notes } = req.body;
    const dateStr = businessDate || new Date().toISOString().slice(0, 10);

    const closing = db.transaction(() => {
      const existing = db.prepare('SELECT id FROM daily_closings WHERE location_id = ? AND business_date = ?').get(locationId, dateStr);
      if (existing) throw new Error(`Business day ${dateStr} is already closed for this location`);

      const salesAgg = db
        .prepare("SELECT COALESCE(SUM(total_amount), 0) AS sales, COALESCE(SUM(total_cogs), 0) AS cogs FROM sales WHERE location_id = ? AND status = 'COMPLETED' AND substr(sold_at, 1, 10) = ?")
        .get(locationId, dateStr) as any;

      const cashSales = (
        db
          .prepare("SELECT COALESCE(SUM(p.amount), 0) AS cash FROM payments p JOIN sales s ON s.id = p.sale_id WHERE s.location_id = ? AND s.status = 'COMPLETED' AND p.method = 'CASH' AND substr(s.sold_at, 1, 10) = ?")
          .get(locationId, dateStr) as any
      ).cash;

      const pettyOut = (
        db
          .prepare("SELECT COALESCE(SUM(amount), 0) AS amt FROM expenses WHERE location_id = ? AND paid_from_petty_cash = 1 AND substr(expense_date, 1, 10) = ?")
          .get(locationId, dateStr) as any
      ).amt;

      const expectedCash = round2(Number(openingFloat || 0) + cashSales - pettyOut);
      const actual = round2(Number(actualCash));
      const variance = round2(actual - expectedCash);
      const grossProfit = round2(salesAgg.sales - salesAgg.cogs);

      const id = randomUUID();
      db.prepare(`
        INSERT INTO daily_closings (id, location_id, business_date, opening_float, expected_cash, actual_cash, variance, total_sales, gross_profit, closed_by, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, locationId, dateStr, Number(openingFloat || 0), expectedCash, actual, variance, round2(salesAgg.sales), grossProfit, req.authUser!.id, notes || '');

      if (variance !== 0) {
        createNotification(
          'CASH_VARIANCE',
          Math.abs(variance) > 200 ? 'CRITICAL' : 'WARNING',
          `Cash Reconciliation Variance (${dateStr})`,
          `Variance of PHP ${variance.toFixed(2)} recorded on closing.`,
        );
      }

      writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'DAILY_CLOSE', 'DailyClosing', id, { dateStr, expectedCash, actual, variance });
      return db.prepare('SELECT * FROM daily_closings WHERE id = ?').get(id);
    })();
    res.status(201).json(closing);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/finance/journals', requirePerm(PERMISSIONS.JOURNAL_POST), (req, res) => {
  try {
    const { entryDate, description, lines } = req.body;
    const totalD = round2((lines || []).reduce((s: number, l: any) => s + Number(l.debit || 0), 0));
    const totalC = round2((lines || []).reduce((s: number, l: any) => s + Number(l.credit || 0), 0));
    if (totalD !== totalC || totalD <= 0) throw new Error(`Unbalanced journal: Debit (${totalD}) must equal Credit (${totalC})`);

    const jeId = randomUUID();
    db.transaction(() => {
      db.prepare('INSERT INTO journal_entries (id, entry_number, entry_date, description, reference_type) VALUES (?, ?, ?, ?, ?)')
        .run(jeId, `JE-MAN-${Date.now().toString().slice(-6)}`, entryDate || new Date().toISOString(), description, 'MANUAL');
      const ins = db.prepare('INSERT INTO journal_lines (id, journal_entry_id, account_id, debit, credit, memo) VALUES (?, ?, ?, ?, ?, ?)');
      for (const l of lines) {
        ins.run(randomUUID(), jeId, l.accountId, round2(Number(l.debit || 0)), round2(Number(l.credit || 0)), l.memo || '');
      }
      writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'MANUAL_JOURNAL', 'JournalEntry', jeId, { description, totalD });
    })();
    res.status(201).json({ id: jeId });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.patch('/finance/tax/:id', requirePerm(PERMISSIONS.FINANCE_VIEW), (req, res) => {
  const { ratePercent, isInclusive, isActive } = req.body;
  db.prepare('UPDATE tax_configs SET rate_percent = ?, is_inclusive = ?, is_active = ? WHERE id = ?')
    .run(Number(ratePercent), isInclusive ? 1 : 0, isActive ? 1 : 0, req.params.id);
  writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'UPDATE_TAX_CONFIG', 'TaxConfiguration', req.params.id, req.body);
  res.json({ ok: true });
});

// ==========================================
// 8. FOOD COSTING & MENU ENGINEERING
// ==========================================
apiRouter.get('/food-costing', requirePerm(PERMISSIONS.DASHBOARD_VIEW), (_req, res) => {
  res.json(getFoodCostingAnalytics());
});

// ==========================================
// 9. FLEET & FOOD TRUCK MANAGEMENT
// ==========================================
apiRouter.get('/fleet', requirePerm(PERMISSIONS.FLEET_MANAGE), (_req, res) => {
  const trucks = db
    .prepare(`
      SELECT ft.*, l.name AS location_name, l.code AS location_code, l.address AS location_address, l.kds_enabled AS kds_enabled,
        COALESCE((SELECT SUM(s.total_amount) FROM sales s WHERE s.location_id = l.id AND s.status = 'COMPLETED'), 0) AS total_sales,
        COALESCE((SELECT SUM(s.total_cogs) FROM sales s WHERE s.location_id = l.id AND s.status = 'COMPLETED'), 0) AS total_cogs,
        COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.location_id = l.id), 0) AS total_expenses
      FROM food_trucks ft
      JOIN locations l ON l.id = ft.location_id
      WHERE l.is_active = 1
    `)
    .all();
  const locations = db
    .prepare(`
      SELECT l.*, ft.id AS truck_id, ft.plate_number, ft.make_model, ft.status, ft.current_site, ft.odometer_km
      FROM locations l
      LEFT JOIN food_trucks ft ON ft.location_id = l.id
      WHERE l.is_active = 1
      ORDER BY l.type ASC, l.name ASC
    `)
    .all();
  const assignments = db
    .prepare('SELECT ta.*, ft.plate_number, l.name AS truck_name FROM truck_assignments ta JOIN food_trucks ft ON ft.id = ta.truck_id JOIN locations l ON l.id = ft.location_id ORDER BY ta.assigned_date DESC LIMIT 20')
    .all();
  const fuelLogs = db
    .prepare('SELECT fl.*, ft.plate_number, l.name AS truck_name FROM fuel_logs fl JOIN food_trucks ft ON ft.id = fl.truck_id JOIN locations l ON l.id = ft.location_id ORDER BY fl.fueled_at DESC LIMIT 20')
    .all();
  const maintenanceLogs = db
    .prepare('SELECT ml.*, ft.plate_number, l.name AS truck_name FROM maintenance_logs ml JOIN food_trucks ft ON ft.id = ml.truck_id JOIN locations l ON l.id = ft.location_id ORDER BY ml.service_date DESC LIMIT 20')
    .all();
  res.json({ trucks, locations, assignments, fuelLogs, maintenanceLogs });
});

apiRouter.post('/fleet/trucks', requirePerm(PERMISSIONS.FLEET_MANAGE), (req, res) => {
  try {
    const { code, name, type, address, plateNumber, makeModel, currentSite, odometerKm, status, kdsEnabled, dailySalesTarget } = req.body;
    const locType = type === 'COMMISSARY' ? 'COMMISSARY' : 'FOOD_TRUCK';
    const nextKds = kdsEnabled !== undefined ? (kdsEnabled ? 1 : 0) : (locType === 'FOOD_TRUCK' ? 1 : 0);
    const nextTarget = Math.max(0, Number(dailySalesTarget ?? (locType === 'FOOD_TRUCK' ? 15000 : 5000)) || 0);
    const locId = randomUUID();
    const trkId = locType === 'FOOD_TRUCK' ? randomUUID() : null;
    db.transaction(() => {
      db.prepare('INSERT INTO locations (id, code, name, type, address, kds_enabled, daily_sales_target) VALUES (?, ?, ?, ?, ?, ?, ?)').run(locId, code, name, locType, address || currentSite || '', nextKds, nextTarget);
      if (locType === 'FOOD_TRUCK' && trkId) {
        db.prepare('INSERT INTO food_trucks (id, location_id, plate_number, make_model, status, current_site, odometer_km) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          trkId,
          locId,
          plateNumber,
          makeModel,
          status || 'ACTIVE',
          currentSite || address || '',
          Number(odometerKm || 0),
        );
      }
      db.prepare('INSERT INTO petty_cash_funds (id, location_id, fund_name, float_amount, current_balance) VALUES (?, ?, ?, 5000, 5000)').run(randomUUID(), locId, `${name} Petty Cash`);
    })();
    res.status(201).json({ id: trkId || locId, locationId: locId });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put('/fleet/locations/:id', requirePerm(PERMISSIONS.FLEET_MANAGE), (req, res) => {
  try {
    const existingLoc = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id) as any;
    if (!existingLoc) {
      res.status(404).json({ error: 'Location not found' });
      return;
    }
    const { code, name, type, address, plateNumber, makeModel, currentSite, odometerKm, status, kdsEnabled, dailySalesTarget } = req.body || {};
    const nextType = type === 'COMMISSARY' || type === 'FOOD_TRUCK' ? type : existingLoc.type;
    const nextKds = kdsEnabled !== undefined ? (kdsEnabled ? 1 : 0) : existingLoc.kds_enabled;
    const nextTarget = dailySalesTarget !== undefined ? Math.max(0, Number(dailySalesTarget) || 0) : Number(existingLoc.daily_sales_target || 0);
    db.transaction(() => {
      db.prepare('UPDATE locations SET code = ?, name = ?, type = ?, address = ?, kds_enabled = ?, daily_sales_target = ? WHERE id = ?')
        .run(code ?? existingLoc.code, name ?? existingLoc.name, nextType, address ?? existingLoc.address ?? '', nextKds, nextTarget, existingLoc.id);
      if (nextType === 'FOOD_TRUCK') {
        const existingTrk = db.prepare('SELECT * FROM food_trucks WHERE location_id = ?').get(existingLoc.id) as any;
        if (existingTrk) {
          db.prepare('UPDATE food_trucks SET plate_number = ?, make_model = ?, status = ?, current_site = ?, odometer_km = ? WHERE id = ?')
            .run(
              plateNumber ?? existingTrk.plate_number,
              makeModel ?? existingTrk.make_model,
              status ?? existingTrk.status,
              currentSite ?? existingTrk.current_site ?? '',
              odometerKm !== undefined ? Number(odometerKm) : existingTrk.odometer_km,
              existingTrk.id,
            );
        }
      }
    })();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.patch('/fleet/locations/:id/kds', requirePerm(PERMISSIONS.FLEET_MANAGE), (req, res) => {
  const existingLoc = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id) as any;
  if (!existingLoc) {
    res.status(404).json({ error: 'Location not found' });
    return;
  }
  const nextKds = req.body?.kdsEnabled ? 1 : 0;
  db.prepare('UPDATE locations SET kds_enabled = ? WHERE id = ?').run(nextKds, existingLoc.id);
  writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'TOGGLE_LOCATION_KDS', 'Location', existingLoc.id, { kdsEnabled: Boolean(nextKds) });
  res.json({ ok: true, id: existingLoc.id, kds_enabled: nextKds });
});

apiRouter.patch('/fleet/locations/:id/target', requirePerm(PERMISSIONS.FLEET_MANAGE), (req, res) => {
  const existingLoc = db.prepare('SELECT * FROM locations WHERE id = ?').get(req.params.id) as any;
  if (!existingLoc) {
    res.status(404).json({ error: 'Location not found' });
    return;
  }
  const rawTarget = Number(req.body?.dailySalesTarget);
  if (!Number.isFinite(rawTarget) || rawTarget < 0) {
    res.status(400).json({ error: 'Daily sales target must be a valid non-negative amount' });
    return;
  }
  const nextTarget = Math.round(rawTarget * 100) / 100;
  db.prepare('UPDATE locations SET daily_sales_target = ? WHERE id = ?').run(nextTarget, existingLoc.id);
  writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'UPDATE_LOCATION_SALES_TARGET', 'Location', existingLoc.id, {
    name: existingLoc.name,
    dailySalesTarget: nextTarget,
  });
  res.json({ ok: true, id: existingLoc.id, daily_sales_target: nextTarget });
});

apiRouter.post('/fleet/assignments', requirePerm(PERMISSIONS.FLEET_MANAGE), (req, res) => {
  const { truckId, siteName, assignedDate, shiftNotes } = req.body;
  db.transaction(() => {
    db.prepare('INSERT INTO truck_assignments (id, truck_id, site_name, assigned_date, shift_notes) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), truckId, siteName, assignedDate || new Date().toISOString().slice(0, 10), shiftNotes || '');
    db.prepare('UPDATE food_trucks SET current_site = ? WHERE id = ?').run(siteName, truckId);
  })();
  res.status(201).json({ ok: true });
});

apiRouter.post('/fleet/fuel', requirePerm(PERMISSIONS.FLEET_MANAGE), (req, res) => {
  const { truckId, liters, totalCost, odometerKm } = req.body;
  db.transaction(() => {
    const trk = db.prepare('SELECT location_id FROM food_trucks WHERE id = ?').get(truckId) as any;
    const expId = randomUUID();
    const cost = round2(Number(totalCost));
    db.prepare('INSERT INTO expenses (id, location_id, account_id, category, amount, description, expense_date) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(expId, trk.location_id, 'acc_6100', 'FUEL', cost, `Fuel log (${liters}L @ ${odometerKm}km)`, new Date().toISOString());
    db.prepare('INSERT INTO fuel_logs (id, truck_id, liters, total_cost, odometer_km, fueled_at, expense_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), truckId, Number(liters), cost, Number(odometerKm || 0), new Date().toISOString(), expId);
    if (odometerKm) db.prepare('UPDATE food_trucks SET odometer_km = ? WHERE id = ?').run(Number(odometerKm), truckId);
  })();
  res.status(201).json({ ok: true });
});

apiRouter.post('/fleet/maintenance', requirePerm(PERMISSIONS.FLEET_MANAGE), (req, res) => {
  const { truckId, title, description, cost, serviceDate, nextDueDate } = req.body;
  db.transaction(() => {
    const trk = db.prepare('SELECT location_id FROM food_trucks WHERE id = ?').get(truckId) as any;
    const amt = round2(Number(cost));
    db.prepare('INSERT INTO maintenance_logs (id, truck_id, title, description, cost, service_date, next_due_date) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), truckId, title, description || '', amt, serviceDate || new Date().toISOString().slice(0, 10), nextDueDate || null);
    if (amt > 0) {
      db.prepare('INSERT INTO expenses (id, location_id, account_id, category, amount, description, expense_date) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), trk.location_id, 'acc_6400', 'MAINTENANCE', amt, `Maintenance: ${title}`, new Date().toISOString());
    }
  })();
  res.status(201).json({ ok: true });
});

// ==========================================
// 10. HR, ATTENDANCE & CONFIGURABLE PH PAYROLL
// ==========================================
apiRouter.get('/attendance/kiosk', (_req, res) => {
  const employees = db
    .prepare(
      `SELECT e.id, e.employee_code, e.full_name, e.department, e.position, e.location_id,
              e.avatar_url, e.face_descriptor_json, e.face_enrolled_at,
              CASE WHEN e.attendance_pin IS NOT NULL AND trim(e.attendance_pin) != '' THEN 1 ELSE 0 END AS has_pin,
              e.is_active, l.name AS location_name
       FROM employees e
       LEFT JOIN locations l ON l.id = e.location_id
       ORDER BY e.employee_code ASC`,
    )
    .all();
  const attendance = db
    .prepare(`
      SELECT a.id, a.employee_id, a.clock_in, a.clock_out, a.worked_hours, a.overtime_hours,
             a.status, a.verification_method, a.match_confidence, a.clock_in_photo, a.clock_out_photo,
             e.full_name, e.employee_code, e.avatar_url AS employee_avatar_url,
             COALESCE(a.location_id, e.location_id) AS resolved_location_id,
             COALESCE(l.name, el.name, 'Commissary HQ') AS location_name
      FROM attendance_logs a
      JOIN employees e ON e.id = a.employee_id
      LEFT JOIN locations l ON l.id = a.location_id
      LEFT JOIN locations el ON el.id = e.location_id
      ORDER BY a.clock_in DESC
      LIMIT 60
    `)
    .all()
    .map((row: any) => ({
      ...row,
      location_id: row.resolved_location_id || null,
    }));
  res.json({ employees, attendance });
});

apiRouter.get('/hr', requirePerm(PERMISSIONS.HR_MANAGE), (_req, res) => {
  const employees = db
    .prepare('SELECT e.*, l.name AS location_name FROM employees e LEFT JOIN locations l ON l.id = e.location_id ORDER BY e.employee_code ASC')
    .all();
  const attendance = db
    .prepare(`
      SELECT a.*, e.full_name, e.employee_code, e.avatar_url AS employee_avatar_url,
             COALESCE(a.location_id, e.location_id) AS resolved_location_id,
             COALESCE(l.name, el.name, 'Commissary HQ') AS location_name
      FROM attendance_logs a
      JOIN employees e ON e.id = a.employee_id
      LEFT JOIN locations l ON l.id = a.location_id
      LEFT JOIN locations el ON el.id = e.location_id
      ORDER BY a.clock_in DESC
      LIMIT 60
    `)
    .all()
    .map((row: any) => ({
      ...row,
      location_id: row.resolved_location_id || null,
    }));
  const rules = db.prepare('SELECT * FROM payroll_rules WHERE is_active = 1').get() as any;
  const payrollRuns = (db.prepare('SELECT * FROM payroll_runs ORDER BY created_at DESC LIMIT 10').all() as any[]).map((pr) => ({
    ...pr,
    items: db
      .prepare('SELECT pi.*, e.full_name, e.employee_code FROM payroll_items pi JOIN employees e ON e.id = pi.employee_id WHERE pi.payroll_run_id = ?')
      .all(pr.id),
  }));
  const rawTemplates = db.prepare('SELECT * FROM shift_templates ORDER BY is_active DESC, start_time ASC, name ASC').all() as any[];
  const shiftTemplates = rawTemplates.map((t) => {
    let daysOfWeek: string[] = [];
    let locationIds: string[] = [];
    try {
      daysOfWeek = JSON.parse(t.days_of_week_json || '[]');
    } catch {
      daysOfWeek = [];
    }
    try {
      locationIds = JSON.parse(t.location_ids_json || '[]');
    } catch {
      locationIds = [];
    }
    return {
      ...t,
      days_of_week: Array.isArray(daysOfWeek) ? daysOfWeek : [],
      location_ids: Array.isArray(locationIds) ? locationIds : [],
    };
  });
  const shiftSchedules = db
    .prepare(`
      SELECT s.*,
             l.name AS location_name,
             l.code AS location_code,
             e.full_name AS employee_name,
             e.employee_code AS employee_code,
             e.position AS employee_position
      FROM shift_schedules s
      LEFT JOIN locations l ON l.id = s.location_id
      LEFT JOIN employees e ON e.id = s.employee_id
      ORDER BY s.shift_date ASC, s.start_time ASC, l.name ASC
      LIMIT 300
    `)
    .all();
  res.json({
    employees,
    attendance,
    payrollRules: rules ? { ...rules, config: JSON.parse(rules.rule_json) } : null,
    payrollRuns,
    shiftTemplates,
    shiftSchedules,
  });
});

apiRouter.post('/hr/employees', requirePerm(PERMISSIONS.HR_MANAGE), (req, res) => {
  try {
    const {
      employeeCode,
      fullName,
      department,
      position,
      locationId,
      payType,
      baseRate,
      avatarUrl,
      faceDescriptorJson,
      faceEnrolledAt,
      attendancePin,
      isActive,
    } = req.body;
    const id = randomUUID();
    const cleanPin = attendancePin ? String(attendancePin).trim().slice(0, 12) : null;
    db.prepare(
      'INSERT INTO employees (id, employee_code, full_name, department, position, location_id, pay_type, base_rate, avatar_url, face_descriptor_json, face_enrolled_at, attendance_pin, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      employeeCode || `EMP-${Date.now().toString().slice(-3)}`,
      fullName,
      department,
      position,
      locationId || null,
      payType || 'DAILY',
      Number(baseRate),
      avatarUrl || null,
      faceDescriptorJson || null,
      faceEnrolledAt || (faceDescriptorJson ? new Date().toISOString() : null),
      cleanPin,
      isActive !== false ? 1 : 0,
    );
    res.status(201).json({ id });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put('/hr/employees/:id', requirePerm(PERMISSIONS.HR_MANAGE), (req, res) => {
  try {
    const empId = req.params.id;
    const existing = db.prepare('SELECT * FROM employees WHERE id = ?').get(empId) as any;
    if (!existing) {
      res.status(404).json({ error: 'Employee not found' });
      return;
    }

    const {
      employeeCode,
      fullName,
      department,
      position,
      locationId,
      payType,
      baseRate,
      avatarUrl,
      faceDescriptorJson,
      faceEnrolledAt,
      attendancePin,
      isActive,
    } = req.body || {};
    const cleanName = String(fullName ?? existing.full_name).trim();
    const cleanCode = String(employeeCode ?? existing.employee_code).trim();
    if (!cleanName) throw new Error('Employee full name is required');
    if (!cleanCode) throw new Error('Employee code is required');

    const dup = db.prepare('SELECT id FROM employees WHERE lower(employee_code) = lower(?) AND id != ?').get(cleanCode, empId);
    if (dup) throw new Error(`Employee code "${cleanCode}" is already used by another employee`);

    const nextAvatar = avatarUrl !== undefined ? (avatarUrl ? String(avatarUrl) : null) : existing.avatar_url;
    const nextDescriptor =
      faceDescriptorJson !== undefined
        ? faceDescriptorJson
          ? String(faceDescriptorJson)
          : null
        : existing.face_descriptor_json;
    const nextEnrolledAt =
      faceEnrolledAt !== undefined
        ? faceEnrolledAt || null
        : faceDescriptorJson !== undefined
          ? faceDescriptorJson
            ? new Date().toISOString()
            : null
          : existing.face_enrolled_at;
    const nextPin =
      attendancePin !== undefined ? (attendancePin ? String(attendancePin).trim().slice(0, 12) : null) : existing.attendance_pin;
    const nextActive = isActive === undefined ? existing.is_active : isActive ? 1 : 0;

    db.prepare(`
      UPDATE employees
      SET employee_code = ?, full_name = ?, department = ?, position = ?, location_id = ?, pay_type = ?, base_rate = ?, avatar_url = ?, face_descriptor_json = ?, face_enrolled_at = ?, attendance_pin = ?, is_active = ?
      WHERE id = ?
    `).run(
      cleanCode,
      cleanName,
      department !== undefined ? String(department).trim() : existing.department,
      position !== undefined ? String(position).trim() : existing.position,
      locationId !== undefined ? (locationId || null) : existing.location_id,
      payType || existing.pay_type,
      Number(baseRate ?? existing.base_rate),
      nextAvatar,
      nextDescriptor,
      nextEnrolledAt,
      nextPin,
      nextActive,
      empId,
    );

    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/hr/attendance/clock', (req, res) => {
  try {
    const {
      employeeId,
      action = 'AUTO',
      overtimeHours,
      locationId,
      verificationMethod = 'MANUAL',
      matchConfidence = null,
      snapshotPhoto = null,
      pinCode,
      status: requestedStatus,
      notes,
    } = req.body || {};

    const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId) as any;
    if (!emp) {
      res.status(404).json({ error: 'Employee not found' });
      return;
    }

    const method = ['FACE_SCAN', 'PIN_FALLBACK', 'MANUAL'].includes(String(verificationMethod).toUpperCase())
      ? String(verificationMethod).toUpperCase()
      : 'MANUAL';

    if (
      method === 'MANUAL' &&
      req.authUser &&
      req.authUser.roleCode !== 'SUPER_ADMIN' &&
      req.authUser.roleCode !== 'BUSINESS_OWNER' &&
      !req.authUser.permissions.includes(PERMISSIONS.HR_MANAGE)
    ) {
      res.status(403).json({ error: 'Manual clock overrides require HR Manager access. Use Face Scan or PIN Fallback.' });
      return;
    }

    if (method === 'PIN_FALLBACK') {
      const configuredPin = String(emp.attendance_pin || '').trim();
      const submittedPin = String(pinCode || '').trim();
      if (!configuredPin) {
        throw new Error(`No Attendance PIN is configured for ${emp.full_name}. Set one in Edit Employee first.`);
      }
      if (!submittedPin || submittedPin !== configuredPin) {
        throw new Error('Incorrect Attendance PIN');
      }
    }

    const openLog = db
      .prepare('SELECT * FROM attendance_logs WHERE employee_id = ? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1')
      .get(employeeId) as any;

    const resolvedAction = action === 'AUTO' ? (openLog ? 'CLOCK_OUT' : 'CLOCK_IN') : action;
    const nowIso = new Date().toISOString();
    const confidenceVal =
      matchConfidence !== null && matchConfidence !== undefined && Number.isFinite(Number(matchConfidence))
        ? Math.max(0, Math.min(100, Math.round(Number(matchConfidence))))
        : null;

    if (resolvedAction === 'CLOCK_IN') {
      if (openLog) {
        throw new Error(`${emp.full_name} is already clocked in (since ${openLog.clock_in})`);
      }
      const id = randomUUID();
      const nextStatus = requestedStatus === 'LATE' ? 'LATE' : 'PRESENT';
      const resolvedLoc = locationId || emp.location_id || null;
      db.prepare(`
        INSERT INTO attendance_logs (id, employee_id, location_id, clock_in, status, verification_method, match_confidence, clock_in_photo, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        employeeId,
        resolvedLoc,
        nowIso,
        nextStatus,
        method,
        confidenceVal,
        snapshotPhoto || null,
        notes || (method === 'PIN_FALLBACK' ? 'PIN fallback punch' : null),
      );
      writeAuditLog(req.authUser!.id, req.authUser!.fullName, `${method}_CLOCK_IN`, 'AttendanceLog', id, {
        employeeName: emp.full_name,
        employeeCode: emp.employee_code,
        locationId: resolvedLoc,
        confidence: confidenceVal,
        status: nextStatus,
      });
      res.status(201).json({
        id,
        action: 'CLOCK_IN',
        employeeId: emp.id,
        employeeName: emp.full_name,
        employeeCode: emp.employee_code,
        clockIn: nowIso,
        clockOut: null,
        workedHours: 0,
        overtimeHours: 0,
        status: nextStatus,
        verificationMethod: method,
        matchConfidence: confidenceVal,
      });
      return;
    }

    if (!openLog) {
      res.status(400).json({ error: `No active clock-in found for ${emp.full_name}` });
      return;
    }

    const elapsedHrs = Math.max(0, round2((new Date(nowIso).getTime() - new Date(openLog.clock_in).getTime()) / 3600000));
    const resolvedOt =
      overtimeHours !== undefined && overtimeHours !== null
        ? Math.max(0, round2(Number(overtimeHours)))
        : Math.max(0, round2(elapsedHrs - 8));

    db.prepare(`
      UPDATE attendance_logs
      SET clock_out = ?, worked_hours = ?, overtime_hours = ?, clock_out_photo = COALESCE(?, clock_out_photo), notes = COALESCE(?, notes)
      WHERE id = ?
    `).run(nowIso, elapsedHrs, resolvedOt, snapshotPhoto || null, notes || null, openLog.id);

    writeAuditLog(req.authUser!.id, req.authUser!.fullName, `${method}_CLOCK_OUT`, 'AttendanceLog', openLog.id, {
      employeeName: emp.full_name,
      employeeCode: emp.employee_code,
      workedHours: elapsedHrs,
      overtimeHours: resolvedOt,
      confidence: confidenceVal,
    });

    res.json({
      id: openLog.id,
      action: 'CLOCK_OUT',
      employeeId: emp.id,
      employeeName: emp.full_name,
      employeeCode: emp.employee_code,
      clockIn: openLog.clock_in,
      clockOut: nowIso,
      workedHours: elapsedHrs,
      overtimeHours: resolvedOt,
      status: openLog.status,
      verificationMethod: method,
      matchConfidence: confidenceVal,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put('/hr/payroll-rules', requirePerm(PERMISSIONS.PAYROLL_RUN), (req, res) => {
  db.prepare('UPDATE payroll_rules SET rule_json = ? WHERE code = ?')
    .run(JSON.stringify(req.body.config), 'PH_STATUTORY_2026');
  writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'UPDATE_PAYROLL_RULES', 'PayrollRule', 'PH_STATUTORY_2026', req.body.config);
  res.json({ ok: true });
});

apiRouter.post('/hr/payroll/run', requirePerm(PERMISSIONS.PAYROLL_RUN), (req, res) => {
  const { periodStart, periodEnd, daysPerEmployee, useAttendanceDays } = req.body;
  const rulesRow = db.prepare('SELECT rule_json FROM payroll_rules WHERE is_active = 1').get() as any;
  const cfg = JSON.parse(rulesRow.rule_json);

  const run = db.transaction(() => {
    const employees = db.prepare('SELECT * FROM employees WHERE is_active = 1').all() as any[];
    const runId = randomUUID();
    let totalGross = 0;
    let totalDed = 0;
    let totalNet = 0;

    const items: any[] = [];
    for (const emp of employees) {
      const empLogs = db.prepare('SELECT * FROM attendance_logs WHERE employee_id = ?').all(emp.id) as any[];
      const periodLogs = empLogs.filter((a) => {
        const d = String(a.clock_in || '').slice(0, 10);
        return (!periodStart || d >= periodStart) && (!periodEnd || d <= periodEnd);
      });
      const uniqueAttendanceDays = new Set(periodLogs.map((a) => String(a.clock_in || '').slice(0, 10))).size;
      const days = useAttendanceDays ? uniqueAttendanceDays : Number(daysPerEmployee ?? 13);
      const otHours = periodLogs.reduce((s, a) => s + Number(a.overtime_hours || 0), 0);

      const dailyRate = emp.pay_type === 'HOURLY' ? emp.base_rate * 8 : emp.pay_type === 'MONTHLY' ? emp.base_rate / 26 : emp.base_rate;
      const hourlyRate = dailyRate / 8;
      const otPay = round2(otHours * hourlyRate * (cfg.overtimeMultiplier || 1.25));
      const gross = round2(days * dailyRate + otPay);

      const sss = round2(gross * ((cfg.sssEmployeeRatePct || 4.5) / 100));
      const phic = round2(gross * ((cfg.philhealthEmployeeRatePct || 2.5) / 100));
      const pagibig = round2((cfg.pagibigFixedEmployeePhp || 200) / 2); // Semi-monthly share
      const semiMonthlyCeiling = (cfg.taxExemptMonthlyCeilingPhp || 20833) / 2;
      const taxableExcess = Math.max(0, gross - (sss + phic + pagibig) - semiMonthlyCeiling);
      const tax = round2(taxableExcess * ((cfg.withholdingRateAboveCeilingPct || 15) / 100));

      const ded = round2(sss + phic + pagibig + tax);
      const net = round2(gross - ded);

      totalGross += gross;
      totalDed += ded;
      totalNet += net;

      items.push({ id: randomUUID(), empId: emp.id, days, otPay, gross, sss, phic, pagibig, tax, net });
    }

    db.prepare('INSERT INTO payroll_runs (id, period_start, period_end, status, total_gross, total_deductions, total_net) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(runId, periodStart, periodEnd, 'APPROVED', round2(totalGross), round2(totalDed), round2(totalNet));

    const insPI = db.prepare(`
      INSERT INTO payroll_items (id, payroll_run_id, employee_id, days_worked, overtime_pay, gross_pay, sss_deduction, philhealth_deduction, pagibig_deduction, tax_deduction, net_pay)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const i of items) {
      insPI.run(i.id, runId, i.empId, i.days, i.otPay, i.gross, i.sss, i.phic, i.pagibig, i.tax, i.net);
    }

    // Post Payroll Expense Journal Entry
    const jeId = randomUUID();
    db.prepare('INSERT INTO journal_entries (id, entry_number, entry_date, description, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(jeId, `JE-PAY-${Date.now().toString().slice(-6)}`, new Date().toISOString(), `Payroll ${periodStart} to ${periodEnd}`, 'PAYROLL', runId);
    db.prepare('INSERT INTO journal_lines (id, journal_entry_id, account_id, debit, credit, memo) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), jeId, 'acc_6300', round2(totalGross), 0, 'Salaries & Wages');
    db.prepare('INSERT INTO journal_lines (id, journal_entry_id, account_id, debit, credit, memo) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), jeId, 'acc_1010', 0, round2(totalNet), 'Net Payroll Disbursement');
    if (totalDed > 0) {
      db.prepare('INSERT INTO journal_lines (id, journal_entry_id, account_id, debit, credit, memo) VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), jeId, 'acc_2000', 0, round2(totalDed), 'Statutory & Tax Remittances Payable');
    }

    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'RUN_PAYROLL', 'PayrollRun', runId, { totalGross, totalNet });
    return { runId, totalGross: round2(totalGross), totalNet: round2(totalNet) };
  })();
  res.status(201).json(run);
});

const VALID_WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const VALID_SHIFT_STATUSES = ['SCHEDULED', 'CONFIRMED', 'COMPLETED', 'CANCELLED'];

function normalizeWeekdays(raw: any): string[] {
  if (!Array.isArray(raw)) return ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  const cleaned = raw
    .map((d) => String(d).trim().toUpperCase())
    .filter((d) => VALID_WEEKDAYS.includes(d));
  return Array.from(new Set(cleaned)).slice(0, 7);
}

function normalizeTimeStr(raw: any, fallback: string): string {
  const val = String(raw || '').trim();
  if (/^\d{2}:\d{2}$/.test(val)) return val;
  return fallback;
}

apiRouter.post('/hr/shift-templates', requirePerm(PERMISSIONS.HR_MANAGE), (req, res) => {
  try {
    const {
      code,
      name,
      startTime,
      endTime,
      breakMinutes = 60,
      daysOfWeek,
      locationIds = [],
      defaultRole = null,
      headcountNeeded = 2,
      notes = null,
      isActive = true,
    } = req.body || {};

    const cleanName = String(name || '').trim().slice(0, 120);
    const cleanCode = String(code || '').trim().toUpperCase().slice(0, 32);
    if (!cleanName) throw new Error('Shift template name is required');
    if (!cleanCode) throw new Error('Shift template code is required');

    const dup = db.prepare('SELECT id FROM shift_templates WHERE lower(code) = lower(?)').get(cleanCode);
    if (dup) throw new Error(`Shift template code "${cleanCode}" already exists`);

    const cleanStart = normalizeTimeStr(startTime, '07:00');
    const cleanEnd = normalizeTimeStr(endTime, '15:00');
    const cleanBreak = Math.max(0, Math.min(480, Math.round(Number(breakMinutes ?? 60))));
    const cleanHeadcount = Math.max(1, Math.min(100, Math.round(Number(headcountNeeded ?? 2))));
    const cleanDays = normalizeWeekdays(daysOfWeek);
    const cleanLocs = Array.isArray(locationIds)
      ? Array.from(new Set(locationIds.map((l) => String(l).trim()).filter(Boolean))).slice(0, 25)
      : [];
    const cleanRole = defaultRole ? String(defaultRole).trim().slice(0, 120) : null;
    const cleanNotes = notes ? String(notes).trim().slice(0, 400) : null;
    const id = randomUUID();

    db.prepare(`
      INSERT INTO shift_templates (
        id, code, name, start_time, end_time, break_minutes, days_of_week_json,
        location_ids_json, default_role, headcount_needed, notes, is_active,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      id,
      cleanCode,
      cleanName,
      cleanStart,
      cleanEnd,
      cleanBreak,
      JSON.stringify(cleanDays),
      JSON.stringify(cleanLocs),
      cleanRole,
      cleanHeadcount,
      cleanNotes,
      isActive === false ? 0 : 1,
    );

    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'CREATE_SHIFT_TEMPLATE', 'ShiftTemplate', id, {
      code: cleanCode,
      name: cleanName,
      locationsCount: cleanLocs.length,
    });
    res.status(201).json({ id });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put('/hr/shift-templates/:id', requirePerm(PERMISSIONS.HR_MANAGE), (req, res) => {
  try {
    const id = req.params.id;
    const existing = db.prepare('SELECT * FROM shift_templates WHERE id = ?').get(id) as any;
    if (!existing) {
      res.status(404).json({ error: 'Shift template not found' });
      return;
    }

    const {
      code,
      name,
      startTime,
      endTime,
      breakMinutes,
      daysOfWeek,
      locationIds,
      defaultRole,
      headcountNeeded,
      notes,
      isActive,
    } = req.body || {};

    const cleanName = String(name ?? existing.name).trim().slice(0, 120);
    const cleanCode = String(code ?? existing.code).trim().toUpperCase().slice(0, 32);
    if (!cleanName) throw new Error('Shift template name is required');
    if (!cleanCode) throw new Error('Shift template code is required');

    const dup = db.prepare('SELECT id FROM shift_templates WHERE lower(code) = lower(?) AND id != ?').get(cleanCode, id);
    if (dup) throw new Error(`Shift template code "${cleanCode}" is already used by another template`);

    const cleanStart = startTime !== undefined ? normalizeTimeStr(startTime, existing.start_time) : existing.start_time;
    const cleanEnd = endTime !== undefined ? normalizeTimeStr(endTime, existing.end_time) : existing.end_time;
    const cleanBreak = breakMinutes !== undefined
      ? Math.max(0, Math.min(480, Math.round(Number(breakMinutes))))
      : existing.break_minutes;
    const cleanHeadcount = headcountNeeded !== undefined
      ? Math.max(1, Math.min(100, Math.round(Number(headcountNeeded))))
      : existing.headcount_needed;
    const cleanDays = daysOfWeek !== undefined ? normalizeWeekdays(daysOfWeek) : JSON.parse(existing.days_of_week_json || '[]');
    const cleanLocs = locationIds !== undefined
      ? (Array.isArray(locationIds) ? Array.from(new Set(locationIds.map((l) => String(l).trim()).filter(Boolean))).slice(0, 25) : [])
      : JSON.parse(existing.location_ids_json || '[]');
    const cleanRole = defaultRole !== undefined ? (defaultRole ? String(defaultRole).trim().slice(0, 120) : null) : existing.default_role;
    const cleanNotes = notes !== undefined ? (notes ? String(notes).trim().slice(0, 400) : null) : existing.notes;
    const nextActive = isActive === undefined ? existing.is_active : isActive ? 1 : 0;

    db.prepare(`
      UPDATE shift_templates
      SET code = ?, name = ?, start_time = ?, end_time = ?, break_minutes = ?,
          days_of_week_json = ?, location_ids_json = ?, default_role = ?,
          headcount_needed = ?, notes = ?, is_active = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      cleanCode,
      cleanName,
      cleanStart,
      cleanEnd,
      cleanBreak,
      JSON.stringify(cleanDays),
      JSON.stringify(cleanLocs),
      cleanRole,
      cleanHeadcount,
      cleanNotes,
      nextActive,
      id,
    );

    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'UPDATE_SHIFT_TEMPLATE', 'ShiftTemplate', id, {
      code: cleanCode,
      name: cleanName,
      isActive: Boolean(nextActive),
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.delete('/hr/shift-templates/:id', requirePerm(PERMISSIONS.HR_MANAGE), (req, res) => {
  try {
    const id = req.params.id;
    const existing = db.prepare('SELECT * FROM shift_templates WHERE id = ?').get(id) as any;
    if (!existing) {
      res.status(404).json({ error: 'Shift template not found' });
      return;
    }
    db.prepare('DELETE FROM shift_templates WHERE id = ?').run(id);
    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'DELETE_SHIFT_TEMPLATE', 'ShiftTemplate', id, {
      code: existing.code,
      name: existing.name,
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

function loadActiveScheduleWindowsSql(): ShiftWindowLike[] {
  const rows = db
    .prepare(`
      SELECT s.id, s.template_id, s.template_name, s.location_id, s.employee_id,
             s.shift_date, s.start_time, s.end_time, s.status,
             l.name AS location_name, e.full_name AS employee_name, e.employee_code AS employee_code
      FROM shift_schedules s
      LEFT JOIN locations l ON l.id = s.location_id
      LEFT JOIN employees e ON e.id = s.employee_id
      WHERE s.status != 'CANCELLED'
    `)
    .all() as any[];
  return rows.map((r) => ({
    id: r.id,
    templateId: r.template_id,
    templateName: r.template_name,
    locationId: r.location_id,
    locationName: r.location_name || r.location_id,
    employeeId: r.employee_id,
    employeeName: r.employee_name || null,
    employeeCode: r.employee_code || null,
    shiftDate: r.shift_date,
    startTime: r.start_time,
    endTime: r.end_time,
    status: r.status,
  }));
}

apiRouter.post('/hr/shift-schedules', requirePerm(PERMISSIONS.HR_MANAGE), (req, res) => {
  try {
    const {
      templateId = null,
      templateName,
      locationId,
      employeeId = null,
      shiftDate,
      startTime,
      endTime,
      breakMinutes = 60,
      status = 'SCHEDULED',
      notes = null,
      conflictPolicy = 'PROMPT',
    } = req.body || {};

    const cleanLocId = String(locationId || '').trim();
    const loc = db.prepare('SELECT id, name FROM locations WHERE id = ?').get(cleanLocId) as any;
    if (!loc) throw new Error('Valid location is required');

    const dateStr = String(shiftDate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new Error('Valid shiftDate (YYYY-MM-DD) is required');

    const tpl = templateId ? (db.prepare('SELECT * FROM shift_templates WHERE id = ?').get(String(templateId)) as any) : null;
    const cleanTplName = String(templateName || tpl?.name || 'Custom Shift').trim().slice(0, 120);
    const cleanStart = normalizeTimeStr(startTime || tpl?.start_time, '07:00');
    const cleanEnd = normalizeTimeStr(endTime || tpl?.end_time, '15:00');
    const cleanBreak = Math.max(0, Math.min(480, Math.round(Number(breakMinutes ?? tpl?.break_minutes ?? 60))));
    const cleanStatus = VALID_SHIFT_STATUSES.includes(String(status).toUpperCase()) ? String(status).toUpperCase() : 'SCHEDULED';
    const cleanEmpId = employeeId ? String(employeeId).trim() : null;
    const emp = cleanEmpId ? (db.prepare('SELECT id, full_name, employee_code FROM employees WHERE id = ?').get(cleanEmpId) as any) : null;
    if (cleanEmpId && !emp) throw new Error('Selected employee not found');

    const newId = randomUUID();
    const candidate: ShiftWindowLike = {
      id: newId,
      templateId: tpl?.id || null,
      templateName: cleanTplName,
      locationId: loc.id,
      locationName: loc.name,
      employeeId: emp?.id || null,
      employeeName: emp?.full_name || null,
      employeeCode: emp?.employee_code || null,
      shiftDate: dateStr,
      startTime: cleanStart,
      endTime: cleanEnd,
      status: cleanStatus,
    };

    const existingWindows = loadActiveScheduleWindowsSql();
    const conflicts = findScheduleCandidateConflicts([candidate], existingWindows);
    const policy = String(conflictPolicy || 'PROMPT').toUpperCase();

    if (conflicts.length > 0 && policy === 'PROMPT') {
      res.json({ saved: false, requiresConfirmation: true, createdCount: 0, conflicts });
      return;
    }

    const cleanNotes = notes ? String(notes).trim().slice(0, 400) : null;
    db.prepare(`
      INSERT INTO shift_schedules (
        id, template_id, template_name, location_id, employee_id, shift_date,
        start_time, end_time, break_minutes, status, notes, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(newId, tpl?.id || null, cleanTplName, loc.id, emp?.id || null, dateStr, cleanStart, cleanEnd, cleanBreak, cleanStatus, cleanNotes);

    if (conflicts.length > 0) {
      const c = conflicts[0];
      createNotification(
        'SHIFT_CONFLICT',
        'WARNING',
        `Overlapping Shift Conflict: ${c.employeeName}`,
        `${c.newTemplateName} (${c.newTimeRange} at ${c.newLocationName}) on ${c.shiftDate} overlaps ${c.existingTemplateName} (${c.existingTimeRange} at ${c.existingLocationName}) by ${formatOverlapDuration(c.overlapMinutes)}.`,
      );
    }

    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'CREATE_SHIFT_SCHEDULE', 'ShiftSchedule', newId, {
      templateName: cleanTplName,
      locationId: loc.id,
      employeeId: emp?.id || null,
      shiftDate: dateStr,
      conflictCount: conflicts.length,
    });

    res.status(201).json({
      saved: true,
      requiresConfirmation: false,
      id: newId,
      createdCount: 1,
      conflicts,
      createdIds: [newId],
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/hr/shift-schedules/generate', requirePerm(PERMISSIONS.HR_MANAGE), (req, res) => {
  try {
    const {
      templateId,
      locationIds,
      startDate,
      endDate,
      daysOfWeek,
      assignmentMode = 'OPEN_SLOTS',
      employeeIds = [],
      headcountPerLocation,
      notes = null,
      conflictPolicy = 'PROMPT',
    } = req.body || {};

    const tpl = db.prepare('SELECT * FROM shift_templates WHERE id = ?').get(templateId) as any;
    if (!tpl) {
      res.status(404).json({ error: 'Shift template not found' });
      return;
    }

    const startStr = String(startDate || '').slice(0, 10);
    const endStr = String(endDate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startStr) || !/^\d{4}-\d{2}-\d{2}$/.test(endStr)) {
      throw new Error('Valid startDate and endDate (YYYY-MM-DD) are required');
    }
    if (startStr > endStr) {
      throw new Error('Start date must be on or before end date');
    }

    const parseUtc = (isoDate: string) => {
      const [y, m, d] = isoDate.split('-').map(Number);
      return Date.UTC(y, m - 1, d);
    };
    const startMs = parseUtc(startStr);
    const endMs = parseUtc(endStr);
    const spanDays = Math.round((endMs - startMs) / 86400000) + 1;
    if (spanDays > 62) {
      throw new Error('Schedule generation range cannot exceed 62 days at once');
    }

    const tplDays = normalizeWeekdays(daysOfWeek !== undefined ? daysOfWeek : JSON.parse(tpl.days_of_week_json || '[]'));
    if (tplDays.length === 0) {
      throw new Error('Select at least one recurring day of the week');
    }

    const allLocRows = db.prepare('SELECT id, name FROM locations').all() as any[];
    const locNameMap = new Map(allLocRows.map((l) => [l.id, l.name]));
    const allLocs = allLocRows.map((l) => l.id);
    const rawTargetLocs = Array.isArray(locationIds) && locationIds.length > 0
      ? locationIds
      : JSON.parse(tpl.location_ids_json || '[]');
    const targetLocs: string[] = (rawTargetLocs.length > 0 ? rawTargetLocs : allLocs)
      .map((l: any) => String(l).trim())
      .filter((l: string) => allLocs.includes(l));

    if (targetLocs.length === 0) {
      throw new Error('Select at least one valid location for schedule generation');
    }

    const activeEmployees = db.prepare('SELECT id, location_id, full_name, employee_code FROM employees WHERE is_active = 1').all() as any[];
    const empMap = new Map(activeEmployees.map((e) => [e.id, e]));
    const selectedEmpSet = new Set(Array.isArray(employeeIds) ? employeeIds.map((e: any) => String(e)) : []);
    const headcount = Math.max(1, Math.min(20, Math.round(Number(headcountPerLocation ?? tpl.headcount_needed ?? 1))));
    const cleanNotes = notes ? String(notes).trim().slice(0, 400) : (tpl.notes || null);
    const policy = String(conflictPolicy || 'PROMPT').toUpperCase();

    const existingWindows = loadActiveScheduleWindowsSql();
    const candidates: Array<ShiftWindowLike & { breakMinutes: number; notes: string | null }> = [];
    let skippedCount = 0;

    for (let t = startMs; t <= endMs; t += 86400000) {
      const dt = new Date(t);
      const dayCode = VALID_WEEKDAYS[dt.getUTCDay()];
      if (!tplDays.includes(dayCode)) continue;
      const dateStr = dt.toISOString().slice(0, 10);

      for (const locId of targetLocs) {
        const existingForSlot = existingWindows.filter(
          (s) => s.templateId === tpl.id && s.locationId === locId && s.shiftDate === dateStr,
        );

        if (assignmentMode === 'SELECTED_EMPLOYEES' && selectedEmpSet.size > 0) {
          for (const empId of selectedEmpSet) {
            if (existingForSlot.some((s) => s.employeeId === empId)) {
              skippedCount++;
              continue;
            }
            const emp = empMap.get(empId);
            candidates.push({
              id: randomUUID(),
              templateId: tpl.id,
              templateName: tpl.name,
              locationId: locId,
              locationName: locNameMap.get(locId) || locId,
              employeeId: empId,
              employeeName: emp?.full_name || null,
              employeeCode: emp?.employee_code || null,
              shiftDate: dateStr,
              startTime: tpl.start_time,
              endTime: tpl.end_time,
              breakMinutes: tpl.break_minutes,
              status: 'SCHEDULED',
              notes: cleanNotes,
            });
          }
        } else if (assignmentMode === 'AUTO_BY_LOCATION') {
          const locEmployees = activeEmployees.filter((e) => e.location_id === locId).slice(0, headcount);
          let addedHere = 0;
          for (const emp of locEmployees) {
            if (existingForSlot.some((s) => s.employeeId === emp.id)) {
              skippedCount++;
              continue;
            }
            candidates.push({
              id: randomUUID(),
              templateId: tpl.id,
              templateName: tpl.name,
              locationId: locId,
              locationName: locNameMap.get(locId) || locId,
              employeeId: emp.id,
              employeeName: emp.full_name,
              employeeCode: emp.employee_code,
              shiftDate: dateStr,
              startTime: tpl.start_time,
              endTime: tpl.end_time,
              breakMinutes: tpl.break_minutes,
              status: 'SCHEDULED',
              notes: cleanNotes,
            });
            addedHere++;
          }
          const totalNow = existingForSlot.length + addedHere;
          const remainingOpen = Math.max(0, headcount - totalNow);
          for (let k = 0; k < remainingOpen; k++) {
            candidates.push({
              id: randomUUID(),
              templateId: tpl.id,
              templateName: tpl.name,
              locationId: locId,
              locationName: locNameMap.get(locId) || locId,
              employeeId: null,
              employeeName: null,
              employeeCode: null,
              shiftDate: dateStr,
              startTime: tpl.start_time,
              endTime: tpl.end_time,
              breakMinutes: tpl.break_minutes,
              status: 'SCHEDULED',
              notes: cleanNotes,
            });
          }
        } else {
          const toCreate = Math.max(0, headcount - existingForSlot.length);
          if (toCreate === 0) {
            skippedCount++;
            continue;
          }
          for (let k = 0; k < toCreate; k++) {
            candidates.push({
              id: randomUUID(),
              templateId: tpl.id,
              templateName: tpl.name,
              locationId: locId,
              locationName: locNameMap.get(locId) || locId,
              employeeId: null,
              employeeName: null,
              employeeCode: null,
              shiftDate: dateStr,
              startTime: tpl.start_time,
              endTime: tpl.end_time,
              breakMinutes: tpl.break_minutes,
              status: 'SCHEDULED',
              notes: cleanNotes,
            });
          }
        }
      }
    }

    const detectedConflicts = findScheduleCandidateConflicts(candidates, existingWindows);
    if (detectedConflicts.length > 0 && policy === 'PROMPT') {
      res.json({
        saved: false,
        requiresConfirmation: true,
        createdCount: 0,
        skippedCount,
        conflicts: detectedConflicts,
        createdIds: [],
      });
      return;
    }

    const conflictingCandidateIds = new Set(detectedConflicts.map((c) => c.newScheduleId));
    const rowsToInsert =
      policy === 'SKIP_CONFLICTS'
        ? candidates.filter((c) => !conflictingCandidateIds.has(c.id))
        : candidates;
    const finalSkippedCount =
      skippedCount + (policy === 'SKIP_CONFLICTS' ? candidates.length - rowsToInsert.length : 0);
    const savedConflicts = policy === 'SKIP_CONFLICTS' ? [] : detectedConflicts;

    const insSchedule = db.prepare(`
      INSERT INTO shift_schedules (
        id, template_id, template_name, location_id, employee_id, shift_date,
        start_time, end_time, break_minutes, status, notes, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'SCHEDULED', ?, datetime('now'), datetime('now'))
    `);

    const tx = db.transaction(() => {
      for (const row of rowsToInsert) {
        insSchedule.run(
          row.id,
          row.templateId,
          row.templateName,
          row.locationId,
          row.employeeId || null,
          row.shiftDate,
          row.startTime,
          row.endTime,
          row.breakMinutes,
          row.notes,
        );
      }
      return {
        saved: true,
        requiresConfirmation: false,
        createdCount: rowsToInsert.length,
        skippedCount: finalSkippedCount,
        conflicts: savedConflicts,
        createdIds: rowsToInsert.map((r) => r.id),
      };
    });

    const result = tx();
    if (savedConflicts.length > 0) {
      createNotification(
        'SHIFT_CONFLICT',
        'WARNING',
        `${savedConflicts.length} Overlapping Shift Conflict(s) Saved`,
        `Schedule generation for ${tpl.name} (${startStr} to ${endStr}) contains ${savedConflicts.length} overlapping crew shift(s). Review the HR Shift Roster to reassign.`,
      );
    }

    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'GENERATE_SHIFT_SCHEDULES', 'ShiftTemplate', tpl.id, {
      templateName: tpl.name,
      startDate: startStr,
      endDate: endStr,
      locationsCount: targetLocs.length,
      createdCount: result.createdCount,
      skippedCount: result.skippedCount,
      conflictCount: savedConflicts.length,
      conflictPolicy: policy,
    });
    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.patch('/hr/shift-schedules/:id', requirePerm(PERMISSIONS.HR_MANAGE), (req, res) => {
  try {
    const id = req.params.id;
    const existing = db.prepare('SELECT * FROM shift_schedules WHERE id = ?').get(id) as any;
    if (!existing) {
      res.status(404).json({ error: 'Shift schedule entry not found' });
      return;
    }

    const { locationId, employeeId, shiftDate, startTime, endTime, breakMinutes, status, notes } = req.body || {};
    const nextStatus = status !== undefined ? String(status).trim().toUpperCase() : existing.status;
    if (!VALID_SHIFT_STATUSES.includes(nextStatus)) {
      throw new Error('Invalid shift status');
    }

    const nextLoc = locationId !== undefined ? String(locationId).trim() : existing.location_id;
    const nextEmp = employeeId !== undefined ? (employeeId ? String(employeeId).trim() : null) : existing.employee_id;
    const nextDate = shiftDate !== undefined ? String(shiftDate).slice(0, 10) : existing.shift_date;
    const nextStart = startTime !== undefined ? normalizeTimeStr(startTime, existing.start_time) : existing.start_time;
    const nextEnd = endTime !== undefined ? normalizeTimeStr(endTime, existing.end_time) : existing.end_time;
    const nextBreak = breakMinutes !== undefined
      ? Math.max(0, Math.min(480, Math.round(Number(breakMinutes))))
      : existing.break_minutes;
    const nextNotes = notes !== undefined ? (notes ? String(notes).trim().slice(0, 400) : null) : existing.notes;

    db.prepare(`
      UPDATE shift_schedules
      SET location_id = ?, employee_id = ?, shift_date = ?, start_time = ?, end_time = ?,
          break_minutes = ?, status = ?, notes = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(nextLoc, nextEmp, nextDate, nextStart, nextEnd, nextBreak, nextStatus, nextNotes, id);

    const locRow = db.prepare('SELECT name FROM locations WHERE id = ?').get(nextLoc) as any;
    const empRow = nextEmp ? (db.prepare('SELECT full_name, employee_code FROM employees WHERE id = ?').get(nextEmp) as any) : null;
    const updatedWindow: ShiftWindowLike = {
      id,
      templateId: existing.template_id,
      templateName: existing.template_name,
      locationId: nextLoc,
      locationName: locRow?.name || nextLoc,
      employeeId: nextEmp,
      employeeName: empRow?.full_name || null,
      employeeCode: empRow?.employee_code || null,
      shiftDate: nextDate,
      startTime: nextStart,
      endTime: nextEnd,
      status: nextStatus,
    };
    const otherWindows = loadActiveScheduleWindowsSql().filter((w) => w.id !== id);
    const conflicts = findScheduleCandidateConflicts([updatedWindow], otherWindows);

    if (conflicts.length > 0) {
      const c = conflicts[0];
      createNotification(
        'SHIFT_CONFLICT',
        'WARNING',
        `Overlapping Shift Conflict: ${c.employeeName}`,
        `${c.newTemplateName} (${c.newTimeRange} at ${c.newLocationName}) on ${c.shiftDate} overlaps ${c.existingTemplateName} (${c.existingTimeRange} at ${c.existingLocationName}) by ${formatOverlapDuration(c.overlapMinutes)}.`,
      );
    }

    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'UPDATE_SHIFT_SCHEDULE', 'ShiftSchedule', id, {
      status: nextStatus,
      employeeId: nextEmp,
      locationId: nextLoc,
      conflictCount: conflicts.length,
    });
    res.json({ ok: true, conflicts });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.delete('/hr/shift-schedules/:id', requirePerm(PERMISSIONS.HR_MANAGE), (req, res) => {
  try {
    const id = req.params.id;
    const existing = db.prepare('SELECT * FROM shift_schedules WHERE id = ?').get(id) as any;
    if (!existing) {
      res.status(404).json({ error: 'Shift schedule entry not found' });
      return;
    }
    db.prepare('DELETE FROM shift_schedules WHERE id = ?').run(id);
    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'DELETE_SHIFT_SCHEDULE', 'ShiftSchedule', id, {
      templateName: existing.template_name,
      shiftDate: existing.shift_date,
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ==========================================
// 11. CRM, REPORTS & GOVERNANCE
// ==========================================
apiRouter.get('/crm/customers', requirePerm(PERMISSIONS.CRM_MANAGE), (_req, res) => {
  const customers = db
    .prepare(`
      SELECT c.*,
        COALESCE((SELECT COUNT(*) FROM sales s WHERE s.customer_id = c.id AND s.status = 'COMPLETED'), 0) AS total_orders,
        COALESCE((SELECT SUM(s.total_amount) FROM sales s WHERE s.customer_id = c.id AND s.status = 'COMPLETED'), 0) AS lifetime_spend
      FROM customers c
      ORDER BY lifetime_spend DESC
    `)
    .all();
  res.json(customers);
});

apiRouter.post('/crm/customers', requirePerm(PERMISSIONS.CRM_MANAGE), (req, res) => {
  try {
    const { fullName, phone, email, preferences } = req.body;
    const id = randomUUID();
    db.prepare('INSERT INTO customers (id, full_name, phone, email, preferences) VALUES (?, ?, ?, ?, ?)')
      .run(id, fullName, phone || null, email || null, preferences || '');
    res.status(201).json({ id });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.get('/reports/:type', requirePerm(PERMISSIONS.REPORTS_VIEW), (req, res) => {
  const { type } = req.params;
  const from = typeof req.query.from === 'string' && req.query.from.trim() ? req.query.from.trim().slice(0, 10) : '';
  const to = typeof req.query.to === 'string' && req.query.to.trim() ? req.query.to.trim().slice(0, 10) : '';

  const buildDateFilter = (expr: string) => {
    const clauses: string[] = [];
    const args: string[] = [];
    if (from) {
      clauses.push(`${expr} >= ?`);
      args.push(from);
    }
    if (to) {
      clauses.push(`${expr} <= ?`);
      args.push(to);
    }
    return { clauses, args };
  };

  if (type === 'sales') {
    const { clauses, args } = buildDateFilter('substr(s.sold_at, 1, 10)');
    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    res.json(
      db.prepare(`
        SELECT s.receipt_number, substr(s.sold_at, 1, 19) AS sold_at, l.name AS truck, s.channel, s.status, s.subtotal, s.tax_amount, s.total_amount, s.total_cogs, (s.total_amount - s.total_cogs) AS gross_profit
        FROM sales s JOIN locations l ON l.id = s.location_id
        ${whereSql}
        ORDER BY s.sold_at DESC
      `).all(...args),
    );
    return;
  }
  if (type === 'inventory') {
    const { clauses, args } = buildDateFilter('substr(b.received_at, 1, 10)');
    const joinFilter = clauses.length ? `AND ${clauses.join(' AND ')}` : '';
    res.json(
      db.prepare(`
        SELECT i.sku, i.name, u.code AS uom, i.costing_method, i.reorder_point,
          COALESCE(SUM(b.remaining_qty), 0) AS on_hand,
          COALESCE(SUM(b.remaining_qty * b.unit_cost), 0) AS total_value
        FROM inventory_items i JOIN uoms u ON u.id = i.base_uom_id
        LEFT JOIN stock_batches b ON b.inventory_item_id = i.id ${joinFilter}
        GROUP BY i.id
      `).all(...args),
    );
    return;
  }
  if (type === 'expenses') {
    const { clauses, args } = buildDateFilter('substr(e.expense_date, 1, 10)');
    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    res.json(
      db.prepare(`
        SELECT substr(e.expense_date, 1, 10) AS date, l.name AS location, e.category, e.description, e.amount
        FROM expenses e JOIN locations l ON l.id = e.location_id
        ${whereSql}
        ORDER BY e.expense_date DESC
      `).all(...args),
    );
    return;
  }
  if (type === 'waste') {
    const { clauses, args } = buildDateFilter('substr(t.created_at, 1, 10)');
    const extraWhere = clauses.length ? `AND ${clauses.join(' AND ')}` : '';
    res.json(
      db.prepare(`
        SELECT substr(t.created_at, 1, 19) AS date, l.name AS location, i.name AS ingredient, ABS(t.quantity_delta) AS qty, u.code AS uom, t.total_cost AS cost_php, t.notes AS reason
        FROM inventory_transactions t
        JOIN inventory_items i ON i.id = t.inventory_item_id
        JOIN uoms u ON u.id = i.base_uom_id
        JOIN locations l ON l.id = t.location_id
        WHERE t.txn_type IN ('OUT_WASTE', 'OUT_SPOILAGE') ${extraWhere}
        ORDER BY t.created_at DESC
      `).all(...args),
    );
    return;
  }
  res.json([]);
});

apiRouter.get('/admin/governance', requirePerm(PERMISSIONS.DASHBOARD_VIEW), (req, res) => {
  const from = typeof req.query.from === 'string' && req.query.from.trim() ? req.query.from.trim().slice(0, 10) : '';
  const to = typeof req.query.to === 'string' && req.query.to.trim() ? req.query.to.trim().slice(0, 10) : '';

  const roles = (db.prepare('SELECT * FROM roles ORDER BY name ASC').all() as any[]).map((r) => ({
    ...r,
    permissions: db
      .prepare('SELECT p.key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?')
      .all(r.id)
      .map((x: any) => x.key),
  }));

  const clauses: string[] = [];
  const args: string[] = [];
  if (from) {
    clauses.push('substr(created_at, 1, 10) >= ?');
    args.push(from);
  }
  if (to) {
    clauses.push('substr(created_at, 1, 10) <= ?');
    args.push(to);
  }
  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = clauses.length ? 200 : 100;
  const auditLogs = db.prepare(`SELECT * FROM audit_logs ${whereSql} ORDER BY created_at DESC LIMIT ${limit}`).all(...args);
  res.json({ roles, auditLogs });
});

// ==========================================
// 12. USER CONTROL SETTINGS (OWNER & SUPER_ADMIN ONLY)
// ==========================================
apiRouter.get('/settings/users-control', requireOwnerOrSuperAdmin, (_req, res) => {
  const rawUsers = db
    .prepare(`
      SELECT u.id, u.email, u.full_name, u.role_id, u.assigned_location_id, u.avatar_url,
             u.shift_pin_hash, u.failed_login_attempts, u.locked_until, u.is_active, u.created_at,
             r.code AS role_code, r.name AS role_name, l.name AS location_name
      FROM users u
      JOIN roles r ON r.id = u.role_id
      LEFT JOIN locations l ON l.id = u.assigned_location_id
      ORDER BY u.is_active DESC, u.full_name ASC
    `)
    .all() as any[];

  const users = rawUsers.map((u) => {
    const lockLeft = checkSqlLockout(u);
    return {
      id: u.id,
      email: u.email,
      full_name: u.full_name,
      role_id: u.role_id,
      assigned_location_id: u.assigned_location_id,
      avatar_url: u.avatar_url,
      has_pin: Boolean(u.shift_pin_hash),
      failed_login_attempts: Number(u.failed_login_attempts || 0),
      is_locked: Boolean(lockLeft),
      locked_until: lockLeft ? u.locked_until : null,
      is_active: u.is_active,
      created_at: u.created_at,
      role_code: u.role_code,
      role_name: u.role_name,
      location_name: u.location_name,
    };
  });

  const employees = db
    .prepare(`
      SELECT e.*, l.name AS location_name
      FROM employees e
      LEFT JOIN locations l ON l.id = e.location_id
      ORDER BY e.is_active DESC, e.employee_code ASC
    `)
    .all();

  const roles = db.prepare('SELECT id, code, name, description FROM roles ORDER BY name ASC').all();
  const locations = db.prepare('SELECT id, code, name, type FROM locations WHERE is_active = 1 ORDER BY type ASC, name ASC').all();

  res.json({ users, employees, roles, locations });
});

apiRouter.post('/settings/users', requireOwnerOrSuperAdmin, (req, res) => {
  try {
    const { email, password, shiftPin, fullName, roleId, assignedLocationId, avatarUrl, isActive } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanName = String(fullName || '').trim();
    if (!cleanEmail) throw new Error('Email is required');
    if (!cleanName) throw new Error('Full name is required');
    if (!password || String(password).length < 6) throw new Error('Password must be at least 6 characters');
    if (!roleId) throw new Error('Role is required');
    const cleanPin = String(shiftPin || '').trim();
    if (cleanPin && !/^\d{4,6}$/.test(cleanPin)) throw new Error('Shift PIN must be 4 to 6 numeric digits');

    const dup = db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(cleanEmail);
    if (dup) throw new Error(`A user with email "${cleanEmail}" already exists`);

    const roleRow = db.prepare('SELECT id, code, name FROM roles WHERE id = ?').get(roleId) as any;
    if (!roleRow) throw new Error('Selected role does not exist');

    const id = randomUUID();
    const hash = bcrypt.hashSync(String(password), 10);
    const pinHash = cleanPin ? bcrypt.hashSync(cleanPin, 10) : null;
    db.prepare(`
      INSERT INTO users (id, email, password_hash, shift_pin_hash, full_name, role_id, assigned_location_id, avatar_url, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, cleanEmail, hash, pinHash, cleanName, roleId, assignedLocationId || null, avatarUrl || null, isActive === false ? 0 : 1);

    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'CREATE_USER', 'User', id, {
      email: cleanEmail,
      fullName: cleanName,
      roleCode: roleRow.code,
      hasPin: Boolean(pinHash),
    });
    res.status(201).json({ id });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put('/settings/users/:id', (req, res) => {
  try {
    const authUser = req.authUser;
    if (!authUser) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    const targetId = req.params.id;
    const isOwnerOrSuperAdmin = authUser.roleCode === 'SUPER_ADMIN' || authUser.roleCode === 'BUSINESS_OWNER';
    const isSelfUpdate = targetId === authUser.id;
    if (!isOwnerOrSuperAdmin && !isSelfUpdate) {
      res.status(403).json({ error: 'Restricted: Company Owner, Super Admin, or account owner access required' });
      return;
    }

    const existing = db
      .prepare('SELECT u.*, r.code AS role_code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?')
      .get(targetId) as any;
    if (!existing) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const { email, password, shiftPin, clearPin, unlockAccount, fullName, roleId, assignedLocationId, avatarUrl, isActive } = req.body || {};
    const cleanEmail = String(email ?? existing.email).trim().toLowerCase();
    const cleanName = String(fullName ?? existing.full_name).trim();

    if (!isOwnerOrSuperAdmin) {
      if (roleId !== undefined && roleId !== existing.role_id) {
        res.status(403).json({ error: 'Permission denied: only Company Owner or Super Admin can change user roles' });
        return;
      }
      if (isActive !== undefined && (isActive ? 1 : 0) !== existing.is_active) {
        res.status(403).json({ error: 'Permission denied: only Company Owner or Super Admin can change account active status' });
        return;
      }
      if (assignedLocationId !== undefined && (assignedLocationId || null) !== (existing.assigned_location_id || null)) {
        res.status(403).json({ error: 'Permission denied: only Company Owner or Super Admin can change assigned location' });
        return;
      }
      if (unlockAccount) {
        res.status(403).json({ error: 'Permission denied: only Company Owner or Super Admin can unlock accounts' });
        return;
      }
    }

    const nextRoleId = isOwnerOrSuperAdmin ? (roleId || existing.role_id) : existing.role_id;
    const nextActive = isOwnerOrSuperAdmin ? (isActive === undefined ? existing.is_active : isActive ? 1 : 0) : existing.is_active;
    const nextAssignedLocationId = isOwnerOrSuperAdmin
      ? (assignedLocationId !== undefined ? (assignedLocationId || null) : existing.assigned_location_id)
      : existing.assigned_location_id;

    if (!cleanEmail) throw new Error('Email is required');
    if (!cleanName) throw new Error('Full name is required');
    const cleanPin = String(shiftPin || '').trim();
    if (cleanPin && !/^\d{4,6}$/.test(cleanPin)) throw new Error('Shift PIN must be 4 to 6 numeric digits');

    const dup = db.prepare('SELECT id FROM users WHERE lower(email) = lower(?) AND id != ?').get(cleanEmail, targetId);
    if (dup) throw new Error(`Email "${cleanEmail}" is already used by another account`);

    const nextRole = db.prepare('SELECT id, code FROM roles WHERE id = ?').get(nextRoleId) as any;
    if (!nextRole) throw new Error('Selected role does not exist');

    if (targetId === authUser.id && isOwnerOrSuperAdmin) {
      if (nextActive === 0) throw new Error('You cannot deactivate your own active session account');
      if (nextRole.code !== 'SUPER_ADMIN' && nextRole.code !== 'BUSINESS_OWNER') {
        throw new Error('You cannot remove your own Owner/Super Admin access while signed in');
      }
    }

    const nextAvatar = avatarUrl !== undefined ? (avatarUrl ? String(avatarUrl) : null) : existing.avatar_url;
    const nextPwdHash =
      password && String(password).trim().length > 0
        ? (() => {
            if (String(password).length < 6) throw new Error('New password must be at least 6 characters');
            return bcrypt.hashSync(String(password), 10);
          })()
        : existing.password_hash;
    const nextPinHash = clearPin ? null : cleanPin ? bcrypt.hashSync(cleanPin, 10) : existing.shift_pin_hash;
    const nextFails = unlockAccount ? 0 : Number(existing.failed_login_attempts || 0);
    const nextLock = unlockAccount ? null : existing.locked_until;

    db.prepare(`
      UPDATE users
      SET email = ?, password_hash = ?, shift_pin_hash = ?, failed_login_attempts = ?, locked_until = ?, full_name = ?, role_id = ?, assigned_location_id = ?, avatar_url = ?, is_active = ?
      WHERE id = ?
    `).run(cleanEmail, nextPwdHash, nextPinHash, nextFails, nextLock, cleanName, nextRoleId, nextAssignedLocationId, nextAvatar, nextActive, targetId);

    if (nextActive === 0) {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
    }

    writeAuditLog(req.authUser!.id, req.authUser!.fullName, unlockAccount ? 'UNLOCK_USER' : 'UPDATE_USER', 'User', targetId, {
      email: cleanEmail,
      fullName: cleanName,
      roleCode: nextRole.code,
      isActive: nextActive === 1,
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.post('/settings/employees', requireOwnerOrSuperAdmin, (req, res) => {
  try {
    const { employeeCode, fullName, department, position, locationId, payType, baseRate, avatarUrl, isActive } = req.body || {};
    const cleanName = String(fullName || '').trim();
    if (!cleanName) throw new Error('Employee full name is required');
    const code = String(employeeCode || `EMP-${Date.now().toString().slice(-3)}`).trim();
    const dup = db.prepare('SELECT id FROM employees WHERE lower(employee_code) = lower(?)').get(code);
    if (dup) throw new Error(`Employee code "${code}" already exists`);

    const id = randomUUID();
    db.prepare(`
      INSERT INTO employees (id, employee_code, full_name, department, position, location_id, pay_type, base_rate, avatar_url, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      code,
      cleanName,
      String(department || 'Operations').trim(),
      String(position || 'Crew').trim(),
      locationId || null,
      payType || 'DAILY',
      Number(baseRate || 650),
      avatarUrl || null,
      isActive === false ? 0 : 1,
    );
    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'CREATE_EMPLOYEE', 'Employee', id, { code, fullName: cleanName });
    res.status(201).json({ id });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put('/settings/employees/:id', requireOwnerOrSuperAdmin, (req, res) => {
  try {
    const empId = req.params.id;
    const existing = db.prepare('SELECT * FROM employees WHERE id = ?').get(empId) as any;
    if (!existing) {
      res.status(404).json({ error: 'Employee not found' });
      return;
    }

    const { employeeCode, fullName, department, position, locationId, payType, baseRate, avatarUrl, isActive } = req.body || {};
    const cleanName = String(fullName ?? existing.full_name).trim();
    const cleanCode = String(employeeCode ?? existing.employee_code).trim();
    if (!cleanName) throw new Error('Employee full name is required');
    if (!cleanCode) throw new Error('Employee code is required');

    const dup = db.prepare('SELECT id FROM employees WHERE lower(employee_code) = lower(?) AND id != ?').get(cleanCode, empId);
    if (dup) throw new Error(`Employee code "${cleanCode}" is already used by another employee`);

    const nextAvatar = avatarUrl !== undefined ? (avatarUrl ? String(avatarUrl) : null) : existing.avatar_url;
    const nextActive = isActive === undefined ? existing.is_active : isActive ? 1 : 0;

    db.prepare(`
      UPDATE employees
      SET employee_code = ?, full_name = ?, department = ?, position = ?, location_id = ?, pay_type = ?, base_rate = ?, avatar_url = ?, is_active = ?
      WHERE id = ?
    `).run(
      cleanCode,
      cleanName,
      String(department ?? existing.department).trim(),
      String(position ?? existing.position).trim(),
      locationId !== undefined ? (locationId || null) : existing.location_id,
      payType || existing.pay_type,
      Number(baseRate ?? existing.base_rate),
      nextAvatar,
      nextActive,
      empId,
    );

    writeAuditLog(req.authUser!.id, req.authUser!.fullName, 'UPDATE_EMPLOYEE', 'Employee', empId, {
      code: cleanCode,
      fullName: cleanName,
      isActive: nextActive === 1,
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
