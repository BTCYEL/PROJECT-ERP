import React, { useEffect, useRef, useState } from 'react';
import { Plus, Pencil, Upload, Trash2, Shield, Users, UserCheck, X } from 'lucide-react';
import { apiFetch, formatPHP } from '../lib/api.ts';
import { AuthUser } from '../types/erp.ts';

interface Props {
  currentUser: AuthUser;
  onProfileUpdated: () => Promise<void>;
}

function getInitials(name: string): string {
  const parts = String(name || '')
    .replace(/\(.*?\)/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return 'U';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function resizeImageToDataUrl(file: File, maxDim = 256): Promise<string> {
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
  const [subTab, setSubTab] = useState<'users' | 'employees'>('users');
  const [data, setData] = useState<{ users: any[]; employees: any[]; roles: any[]; locations: any[] } | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  // User Modal State
  const [userModal, setUserModal] = useState<{ mode: 'create' | 'edit'; id?: string } | null>(null);
  const [userForm, setUserForm] = useState({
    fullName: '',
    email: '',
    password: '',
    roleId: '',
    assignedLocationId: '',
    avatarUrl: '',
    isActive: true,
  });

  // Employee Modal State
  const [empModal, setEmpModal] = useState<{ mode: 'create' | 'edit'; id?: string } | null>(null);
  const [empForm, setEmpForm] = useState({
    employeeCode: '',
    fullName: '',
    department: 'Operations',
    position: 'Food Truck Crew',
    locationId: '',
    payType: 'DAILY',
    baseRate: '650',
    avatarUrl: '',
    isActive: true,
  });

  const [saving, setSaving] = useState(false);
  const userFileRef = useRef<HTMLInputElement>(null);
  const empFileRef = useRef<HTMLInputElement>(null);

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
      roleId: data.roles[0]?.id || '',
      assignedLocationId: '',
      avatarUrl: '',
      isActive: true,
    });
    setUserModal({ mode: 'create' });
  };

  const openEditUser = (u: any) => {
    setErr('');
    setUserForm({
      fullName: u.full_name || '',
      email: u.email || '',
      password: '',
      roleId: u.role_id || data.roles[0]?.id || '',
      assignedLocationId: u.assigned_location_id || '',
      avatarUrl: u.avatar_url || '',
      isActive: u.is_active === 1,
    });
    setUserModal({ mode: 'edit', id: u.id });
  };

  const openCreateEmployee = () => {
    setErr('');
    setEmpForm({
      employeeCode: `EMP-${String(data.employees.length + 1).padStart(3, '0')}`,
      fullName: '',
      department: 'Truck Crew',
      position: 'Grill & Prep Staff',
      locationId: data.locations[0]?.id || '',
      payType: 'DAILY',
      baseRate: '650',
      avatarUrl: '',
      isActive: true,
    });
    setEmpModal({ mode: 'create' });
  };

  const openEditEmployee = (emp: any) => {
    setErr('');
    setEmpForm({
      employeeCode: emp.employee_code || '',
      fullName: emp.full_name || '',
      department: emp.department || '',
      position: emp.position || '',
      locationId: emp.location_id || '',
      payType: emp.pay_type || 'DAILY',
      baseRate: String(emp.base_rate ?? 650),
      avatarUrl: emp.avatar_url || '',
      isActive: emp.is_active === 1,
    });
    setEmpModal({ mode: 'edit', id: emp.id });
  };

  const handlePhotoUpload = async (file: File | undefined, target: 'user' | 'employee') => {
    if (!file) return;
    setErr('');
    try {
      const dataUrl = await resizeImageToDataUrl(file, 256);
      if (target === 'user') setUserForm((f) => ({ ...f, avatarUrl: dataUrl }));
      else setEmpForm((f) => ({ ...f, avatarUrl: dataUrl }));
    } catch (e: any) {
      setErr(e.message || 'Unable to process uploaded image');
    }
  };

  const submitUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userModal) return;
    setErr('');
    setSaving(true);
    try {
      const payload = {
        fullName: userForm.fullName,
        email: userForm.email,
        password: userForm.password || undefined,
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

  const submitEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!empModal) return;
    setErr('');
    setSaving(true);
    try {
      const payload = {
        employeeCode: empForm.employeeCode,
        fullName: empForm.fullName,
        department: empForm.department,
        position: empForm.position,
        locationId: empForm.locationId || null,
        payType: empForm.payType,
        baseRate: Number(empForm.baseRate || 0),
        avatarUrl: empForm.avatarUrl || null,
        isActive: empForm.isActive,
      };
      if (empModal.mode === 'create') {
        await apiFetch('/settings/employees', { method: 'POST', body: JSON.stringify(payload) });
        setMsg(`Added employee "${empForm.fullName.trim()}"`);
      } else {
        await apiFetch(`/settings/employees/${empModal.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        setMsg(`Updated employee "${empForm.fullName.trim()}"`);
      }
      setEmpModal(null);
      await load();
    } catch (e: any) {
      setErr(e.message || 'Unable to save employee');
    } finally {
      setSaving(false);
    }
  };

  const activeUsersCount = data.users.filter((u) => u.is_active === 1).length;
  const adminUsersCount = data.users.filter((u) => u.role_code === 'SUPER_ADMIN' || u.role_code === 'BUSINESS_OWNER').length;
  const withPhotosCount =
    data.users.filter((u) => Boolean(u.avatar_url)).length + data.employees.filter((e) => Boolean(e.avatar_url)).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 flex items-center gap-2">
            <Shield className="w-5 h-5 text-slate-700" />
            User Control &amp; Profile Photos
          </h1>
          <p className="text-sm text-slate-500">
            Exclusive to Company Owner &amp; Super Admin · Manage login accounts, role assignments, and avatars for users and employees
          </p>
        </div>

        <div className="flex items-center gap-2">
          {subTab === 'users' ? (
            <button
              type="button"
              onClick={openCreateUser}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              <Plus className="w-4 h-4" /> Add System User
            </button>
          ) : (
            <button
              type="button"
              onClick={openCreateEmployee}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              <Plus className="w-4 h-4" /> Add Employee
            </button>
          )}
        </div>
      </div>

      {msg && <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 font-medium">{msg}</div>}
      {err && !userModal && !empModal && (
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
          <p className="text-xs font-medium text-slate-500">Employee Directory</p>
          <p className="mt-1 font-mono tabular-nums text-2xl font-semibold text-slate-900">{data.employees.length}</p>
          <p className="mt-0.5 text-xs text-slate-500">Staff &amp; crew profiles</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-medium text-slate-500">Uploaded Photos</p>
          <p className="mt-1 font-mono tabular-nums text-2xl font-semibold text-slate-900">{withPhotosCount}</p>
          <p className="mt-0.5 text-xs text-slate-500">Across users &amp; employees</p>
        </div>
      </div>

      {/* Sub-navigation Tabs */}
      <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg border border-slate-200 w-fit">
        <button
          type="button"
          onClick={() => setSubTab('users')}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap ${
            subTab === 'users' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
          }`}
        >
          <UserCheck className="w-3.5 h-3.5" /> System Users ({data.users.length})
        </button>
        <button
          type="button"
          onClick={() => setSubTab('employees')}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap ${
            subTab === 'employees' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
          }`}
        >
          <Users className="w-3.5 h-3.5" /> Employees &amp; Crew Photos ({data.employees.length})
        </button>
      </div>

      {/* System Users Table */}
      {subTab === 'users' && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr>
                <th className="p-3 font-medium">User</th>
                <th className="p-3 font-medium">Role</th>
                <th className="p-3 font-medium">Assigned Location</th>
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
                    <span className={u.is_active === 1 ? 'font-semibold text-emerald-700' : 'font-semibold text-red-600'}>
                      {u.is_active === 1 ? 'ACTIVE' : 'DISABLED'}
                    </span>
                  </td>
                  <td className="p-3 text-right">
                    <button
                      type="button"
                      onClick={() => openEditUser(u)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                    >
                      <Pencil className="w-3.5 h-3.5" /> Edit / Photo
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Employees Table */}
      {subTab === 'employees' && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr>
                <th className="p-3 font-medium">Employee</th>
                <th className="p-3 font-medium">Department · Position</th>
                <th className="p-3 font-medium">Assigned Truck / Site</th>
                <th className="p-3 font-medium text-right">Pay Rate</th>
                <th className="p-3 font-medium">Status</th>
                <th className="p-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.employees.map((emp) => (
                <tr key={emp.id} className="hover:bg-slate-50">
                  <td className="p-3">
                    <div className="flex items-center gap-3">
                      <AvatarBadge name={emp.full_name} src={emp.avatar_url} />
                      <div>
                        <p className="font-semibold text-slate-900">{emp.full_name}</p>
                        <p className="font-mono text-[11px] text-slate-500">{emp.employee_code}</p>
                      </div>
                    </div>
                  </td>
                  <td className="p-3 text-slate-700">
                    {emp.department} · <span className="text-slate-500">{emp.position}</span>
                  </td>
                  <td className="p-3 text-slate-600">{emp.location_name || 'HQ / Unassigned'}</td>
                  <td className="p-3 text-right font-mono tabular-nums">
                    {formatPHP(emp.base_rate)} <span className="text-[11px] text-slate-400">/{emp.pay_type === 'MONTHLY' ? 'mo' : 'day'}</span>
                  </td>
                  <td className="p-3">
                    <span className={emp.is_active === 1 ? 'font-semibold text-emerald-700' : 'font-semibold text-red-600'}>
                      {emp.is_active === 1 ? 'ACTIVE' : 'INACTIVE'}
                    </span>
                  </td>
                  <td className="p-3 text-right">
                    <button
                      type="button"
                      onClick={() => openEditEmployee(emp)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                    >
                      <Pencil className="w-3.5 h-3.5" /> Edit / Photo
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* User Create / Edit Modal */}
      {userModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form onSubmit={submitUser} className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl bg-white p-5 space-y-4 border border-slate-200">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900">
                  {userModal.mode === 'create' ? 'Create System User' : 'Edit User Access & Avatar'}
                </h3>
                <p className="text-xs text-slate-500">Assign RBAC role, truck location, credentials, and profile photo</p>
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
                      handlePhotoUpload(e.target.files?.[0], 'user');
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
                <input
                  placeholder="Or paste image URL..."
                  value={userForm.avatarUrl.startsWith('data:') ? '' : userForm.avatarUrl}
                  onChange={(e) => setUserForm((f) => ({ ...f, avatarUrl: e.target.value }))}
                  className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs"
                />
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

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                {userModal.mode === 'create' ? 'Password (min. 6 characters)' : 'Reset Password (leave blank to keep current)'}
              </label>
              <input
                type="password"
                required={userModal.mode === 'create'}
                minLength={userModal.mode === 'create' ? 6 : undefined}
                placeholder={userModal.mode === 'create' ? 'Enter password' : '••••••••'}
                value={userForm.password}
                onChange={(e) => setUserForm({ ...userForm, password: e.target.value })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
              />
            </div>

            <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={userForm.isActive}
                onChange={(e) => setUserForm({ ...userForm, isActive: e.target.checked })}
              />
              Account active (allowed to sign in)
            </label>

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

      {/* Employee Create / Edit Modal */}
      {empModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form onSubmit={submitEmployee} className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl bg-white p-5 space-y-4 border border-slate-200">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900">
                  {empModal.mode === 'create' ? 'Add Employee Profile' : 'Edit Employee & Photo'}
                </h3>
                <p className="text-xs text-slate-500">Manage employee directory record, truck assignment, and avatar photo</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setErr('');
                  setEmpModal(null);
                }}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {err && <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">{err}</div>}

            {/* Employee Photo Uploader */}
            <div className="flex items-center gap-4 rounded-lg border border-slate-200 bg-slate-50 p-3.5">
              <AvatarBadge name={empForm.fullName || 'Employee'} src={empForm.avatarUrl} size="lg" />
              <div className="flex-1 min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    ref={empFileRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      handlePhotoUpload(e.target.files?.[0], 'employee');
                      e.target.value = '';
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => empFileRef.current?.click()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                  >
                    <Upload className="w-3.5 h-3.5" /> Upload Photo
                  </button>
                  {empForm.avatarUrl && (
                    <button
                      type="button"
                      onClick={() => setEmpForm((f) => ({ ...f, avatarUrl: '' }))}
                      className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-white px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Remove
                    </button>
                  )}
                </div>
                <input
                  placeholder="Or paste image URL..."
                  value={empForm.avatarUrl.startsWith('data:') ? '' : empForm.avatarUrl}
                  onChange={(e) => setEmpForm((f) => ({ ...f, avatarUrl: e.target.value }))}
                  className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Employee Code</label>
                <input
                  required
                  value={empForm.employeeCode}
                  onChange={(e) => setEmpForm({ ...empForm, employeeCode: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Full Name</label>
                <input
                  required
                  value={empForm.fullName}
                  onChange={(e) => setEmpForm({ ...empForm, fullName: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Department</label>
                <input
                  required
                  value={empForm.department}
                  onChange={(e) => setEmpForm({ ...empForm, department: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Position</label>
                <input
                  required
                  value={empForm.position}
                  onChange={(e) => setEmpForm({ ...empForm, position: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Assigned Location</label>
                <select
                  value={empForm.locationId}
                  onChange={(e) => setEmpForm({ ...empForm, locationId: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs"
                >
                  <option value="">HQ / Unassigned</option>
                  {data.locations.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Pay Type</label>
                  <select
                    value={empForm.payType}
                    onChange={(e) => setEmpForm({ ...empForm, payType: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-xs"
                  >
                    <option value="DAILY">DAILY</option>
                    <option value="MONTHLY">MONTHLY</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Base Rate (PHP)</label>
                  <input
                    type="number"
                    required
                    value={empForm.baseRate}
                    onChange={(e) => setEmpForm({ ...empForm, baseRate: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-xs font-mono"
                  />
                </div>
              </div>
            </div>

            <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={empForm.isActive}
                onChange={(e) => setEmpForm({ ...empForm, isActive: e.target.checked })}
              />
              Employee active in payroll &amp; roster
            </label>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
              <button
                type="button"
                onClick={() => {
                  setErr('');
                  setEmpModal(null);
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
                {saving ? 'Saving...' : empModal.mode === 'create' ? 'Create Employee' : 'Save Employee'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
