import React, { useEffect, useRef, useState } from 'react';
import { Plus, Pencil, Upload, Trash2, Shield, UserCheck, X, KeyRound, Lock, Unlock } from 'lucide-react';
import { apiFetch } from '../lib/api.ts';
import { AuthUser } from '../types/erp.ts';

interface Props {
  currentUser: AuthUser;
  onProfileUpdated: () => Promise<void>;
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
        className={`${dims} rounded-full object-cover border border-slate-200 shrink-0 bg-slate-100`}
      />
    );
  }
  return (
    <div
      className={`${dims} rounded-full bg-slate-900 text-white font-semibold flex items-center justify-center shrink-0 select-none`}
    >
      {getInitials(name)}
    </div>
  );
}

export function SettingsUserControlModule({ currentUser, onProfileUpdated }: Props) {
  const [data, setData] = useState<{ users: any[]; roles: any[]; locations: any[] } | null>(null);
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
    password: '',
    shiftPin: '',
    clearPin: false,
    unlockAccount: false,
    roleId: '',
    assignedLocationId: '',
    avatarUrl: '',
    isActive: true,
  });

  const [saving, setSaving] = useState(false);
  const [unlockingId, setUnlockingId] = useState<string | null>(null);
  const userFileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      setErr('');
      const res = await apiFetch('/settings/users-control');
      setData(res);
    } catch (e: any) {
      setErr(e.message || 'Unable to load User Control settings');
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (err && !data) {
    return <div className="p-4 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700 font-medium">{err}</div>;
  }
  if (!data) {
    return <div className="h-64 rounded-xl border border-slate-200 bg-white animate-pulse" />;
  }

  const openCreateUser = () => {
    setErr('');
    setUserForm({
      fullName: '',
      email: '',
      password: '',
      shiftPin: '',
      clearPin: false,
      unlockAccount: false,
      roleId: data.roles[0]?.id || '',
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
      password: '',
      shiftPin: '',
      clearPin: false,
      unlockAccount: Boolean(u.is_locked),
      roleId: u.role_id || data.roles[0]?.id || '',
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

  const activeUsersCount = data.users.filter((u) => u.is_active === 1).length;
  const adminUsersCount = data.users.filter((u) => u.role_code === 'SUPER_ADMIN' || u.role_code === 'BUSINESS_OWNER').length;
  const pinEnabledCount = data.users.filter((u) => Boolean(u.has_pin)).length;
  const lockedUsersCount = data.users.filter((u) => Boolean(u.is_locked)).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 flex items-center gap-2">
            <Shield className="w-5 h-5 text-slate-700" />
            User Control &amp; Role Permissions
          </h1>
          <p className="text-sm text-slate-500">
            Exclusive to Company Owner &amp; Super Admin · Manage login credentials, Operator Shift PINs, lockouts, and role avatars
          </p>
        </div>

        <button
          type="button"
          onClick={openCreateUser}
          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap shrink-0"
        >
          <Plus className="w-4 h-4" /> Add System User
        </button>
      </div>

      {msg && <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 font-medium">{msg}</div>}
      {err && !userModal && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">{err}</div>
      )}

      {/* Summary Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">System Users</p>
          <p className="mt-1 font-mono tabular-nums text-2xl font-semibold text-slate-900">{data.users.length}</p>
          <p className="mt-0.5 text-xs text-slate-500">{activeUsersCount} active accounts</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">Owner &amp; Super Admins</p>
          <p className="mt-1 font-mono tabular-nums text-2xl font-semibold text-slate-900">{adminUsersCount}</p>
          <p className="mt-0.5 text-xs text-slate-500">Privileged control access</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">Shift PIN Enabled</p>
          <p className="mt-1 font-mono tabular-nums text-2xl font-semibold text-slate-900">{pinEnabledCount}</p>
          <p className="mt-0.5 text-xs text-slate-500">Ready for truck keypad login</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">Locked Accounts</p>
          <p className={`mt-1 font-mono tabular-nums text-2xl font-semibold ${lockedUsersCount > 0 ? 'text-amber-700' : 'text-slate-900'}`}>
            {lockedUsersCount}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            {lockedUsersCount > 0 ? '5-attempt lockout triggered' : 'No security lockouts'}
          </p>
        </div>
      </div>

      {/* System Users Table */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <UserCheck className="w-4 h-4 text-slate-700" />
            <span className="text-xs font-semibold text-slate-800">Configured System Users ({data.users.length})</span>
          </div>
          <span className="text-[11px] text-slate-500">Role-Based Access Control (RBAC) &amp; Shift PIN Access</span>
        </div>
        <table className="w-full text-left text-xs">
          <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
            <tr>
              <th className="p-3 font-medium">User</th>
              <th className="p-3 font-medium">Role</th>
              <th className="p-3 font-medium">Assigned Location</th>
              <th className="p-3 font-medium">Terminal Access</th>
              <th className="p-3 font-medium">Status</th>
              <th className="p-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.users.map((u) => (
              <tr key={u.id} className="hover:bg-slate-50">
                <td className="p-3">
                  <div className="flex items-center gap-3">
                    <AvatarBadge name={u.full_name} src={u.avatar_url} />
                    <div>
                      <p className="font-semibold text-slate-900">{u.full_name}</p>
                      <p className="font-mono text-[11px] text-slate-500">{u.email}</p>
                    </div>
                  </div>
                </td>
                <td className="p-3">
                  <p className="font-medium text-slate-800">{u.role_name}</p>
                  <p className="font-mono text-[11px] text-slate-400">{u.role_code}</p>
                </td>
                <td className="p-3 text-slate-600">{u.location_name || 'All Locations'}</td>
                <td className="p-3">
                  <span
                    className={`inline-flex items-center gap-1 font-medium ${
                      u.has_pin ? 'text-slate-900' : 'text-slate-500'
                    }`}
                  >
                    <KeyRound className={`w-3.5 h-3.5 ${u.has_pin ? 'text-emerald-600' : 'text-slate-400'}`} />
                    {u.has_pin ? 'Shift PIN + Password' : 'Password Only'}
                  </span>
                </td>
                <td className="p-3">
                  <div className="space-y-0.5">
                    <span className={u.is_active === 1 ? 'font-semibold text-emerald-700' : 'font-semibold text-red-600'}>
                      {u.is_active === 1 ? 'ACTIVE' : 'DISABLED'}
                    </span>
                    {u.is_locked && (
                      <p className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700">
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
                        className="inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100 whitespace-nowrap shrink-0"
                      >
                        <Unlock className="w-3.5 h-3.5" />
                        {unlockingId === u.id ? 'Unlocking...' : 'Unlock'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => openEditUser(u)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap shrink-0"
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

      {/* User Create / Edit Modal */}
      {userModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form onSubmit={submitUser} className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl bg-white p-5 space-y-4 border border-slate-200">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900">
                  {userModal.mode === 'create' ? 'Create System User' : 'Edit User Access & Credentials'}
                </h3>
                <p className="text-xs text-slate-500">Assign RBAC role, location, password, Shift PIN, and profile photo</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setErr('');
                  setUserModal(null);
                }}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {err && <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">{err}</div>}

            {/* Avatar Uploader */}
            <div className="flex items-center gap-4 rounded-lg border border-slate-200 bg-slate-50 p-3.5">
              <AvatarBadge name={userForm.fullName || 'User'} src={userForm.avatarUrl} size="lg" />
              <div className="flex-1 min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    ref={userFileRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      handlePhotoUpload(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => userFileRef.current?.click()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                  >
                    <Upload className="w-3.5 h-3.5" /> Upload Photo
                  </button>
                  {userForm.avatarUrl && (
                    <button
                      type="button"
                      onClick={() => setUserForm((f) => ({ ...f, avatarUrl: '' }))}
                      className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-white px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Remove
                    </button>
                  )}
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">Or Image URL</label>
                  <input
                    placeholder="Or paste image URL..."
                    value={userForm.avatarUrl.startsWith('data:') ? '' : userForm.avatarUrl}
                    onChange={(e) => setUserForm((f) => ({ ...f, avatarUrl: e.target.value }))}
                    className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs"
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Full Name</label>
                <input
                  required
                  value={userForm.fullName}
                  onChange={(e) => setUserForm({ ...userForm, fullName: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Work Email</label>
                <input
                  type="email"
                  required
                  value={userForm.email}
                  onChange={(e) => setUserForm({ ...userForm, email: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Role</label>
                <select
                  value={userForm.roleId}
                  onChange={(e) => setUserForm({ ...userForm, roleId: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
                >
                  {data.roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({r.code})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Assigned Location</label>
                <select
                  value={userForm.assignedLocationId}
                  onChange={(e) => setUserForm({ ...userForm, assignedLocationId: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
                >
                  <option value="">All Locations</option>
                  {data.locations.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  {userModal.mode === 'create' ? 'Password (min. 6 characters)' : 'Reset Password (optional)'}
                </label>
                <input
                  type="password"
                  required={userModal.mode === 'create'}
                  minLength={userModal.mode === 'create' ? 6 : undefined}
                  placeholder={userModal.mode === 'create' ? 'Enter password' : 'Leave blank to keep current'}
                  value={userForm.password}
                  onChange={(e) => setUserForm({ ...userForm, password: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
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
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono tracking-widest disabled:bg-slate-50"
                />
              </div>
            </div>

            <div className="space-y-2 pt-1">
              <label className="flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={userForm.isActive}
                  onChange={(e) => setUserForm({ ...userForm, isActive: e.target.checked })}
                />
                Account active (allowed to sign in)
              </label>

              {userModal.mode === 'edit' && userModal.hasExistingPin && (
                <label className="flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
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
                <label className="flex items-center gap-2 text-xs font-medium text-amber-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={userForm.unlockAccount}
                    onChange={(e) => setUserForm({ ...userForm, unlockAccount: e.target.checked })}
                  />
                  Unlock account &amp; clear failed attempts ({userModal.failedAttempts} failed)
                </label>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
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
                className="px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-50"
              >
                {saving ? 'Saving...' : userModal.mode === 'create' ? 'Create User' : 'Save User'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
