import React, { useEffect, useState } from 'react';
import { Download, Printer, Plus, Clock, Truck, ShieldCheck } from 'lucide-react';
import { apiFetch, downloadCsv, formatNum, formatPHP } from '../lib/api.ts';
import { AvatarBadge } from './SettingsUserControlModule.tsx';

interface Props {
  mode: 'fleet' | 'hr' | 'crm' | 'reports';
}

export function OperationsHrCrmModule({ mode }: Props) {
  const [fleetData, setFleetData] = useState<any>(null);
  const [hrData, setHrData] = useState<any>(null);
  const [customers, setCustomers] = useState<any[]>([]);
  const [reportType, setReportType] = useState<'sales' | 'inventory' | 'expenses' | 'waste'>('sales');
  const [reportRows, setReportRows] = useState<any[]>([]);
  const [governance, setGovernance] = useState<any>(null);
  const [reportTab, setReportTab] = useState<'exports' | 'rbac' | 'audit'>('exports');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  // Quick forms
  const [fuelForm, setFuelForm] = useState({ truckId: 'trk_1', liters: '35', totalCost: '2100', odometerKm: '43100' });
  const [siteForm, setSiteForm] = useState({ truckId: 'trk_1', siteName: 'BGC High Street South', shiftNotes: 'Weekend Night Market' });
  const [custForm, setCustForm] = useState({ fullName: '', phone: '', email: '', preferences: '' });
  const [ruleCfg, setRuleCfg] = useState<any>(null);

  const loadFleet = async () => {
    try {
      setErr('');
      setFleetData(await apiFetch('/fleet'));
    } catch (e: any) {
      setErr(e.message || 'Unable to load fleet data');
    }
  };
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
  const loadCrm = async () => {
    try {
      setErr('');
      setCustomers(await apiFetch('/crm/customers'));
    } catch (e: any) {
      setErr(e.message || 'Unable to load customer CRM data');
    }
  };
  const loadReports = async (type = reportType) => {
    try {
      setErr('');
      const [rows, gov] = await Promise.all([
        apiFetch(`/reports/${type}`),
        apiFetch('/admin/governance').catch(() => null),
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
    if (mode === 'reports') loadReports(reportType);
  }, [mode, reportType]);

  // ==========================================
  // FLEET & FOOD TRUCKS
  // ==========================================
  if (mode === 'fleet') {
    if (err && !fleetData) return <div className="p-4 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700 font-medium">{err}</div>;
    if (!fleetData) return <div className="h-64 rounded-xl border bg-white animate-pulse" />;
    return (
      <div className="space-y-6">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900">Food Trucks &amp; Locations</h1>
          <p className="text-sm text-slate-500">Per-truck profitability, daily site dispatch, fuel consumption, and preventive maintenance</p>
        </div>
        {msg && <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 font-medium">{msg}</div>}
        {err && <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">{err}</div>}

        <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr>
                <th className="p-3 font-medium">Truck / Plate</th>
                <th className="p-3 font-medium">Current Location</th>
                <th className="p-3 font-medium text-right">Odometer</th>
                <th className="p-3 font-medium text-right">Total Sales</th>
                <th className="p-3 font-medium text-right">COGS</th>
                <th className="p-3 font-medium text-right">Expenses</th>
                <th className="p-3 font-medium text-right">Net Contribution</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {fleetData.trucks.map((t: any) => {
                const net = t.total_sales - t.total_cogs - t.total_expenses;
                return (
                  <tr key={t.id}>
                    <td className="p-3">
                      <p className="font-semibold text-slate-900 flex items-center gap-1.5">
                        <Truck className="w-3.5 h-3.5 text-slate-500" /> {t.location_name}
                      </p>
                      <p className="text-[11px] font-mono text-slate-500">{t.plate_number} · {t.make_model}</p>
                    </td>
                    <td className="p-3 text-slate-700">{t.current_site}</td>
                    <td className="p-3 text-right font-mono tabular-nums">{t.odometer_km.toLocaleString()} km</td>
                    <td className="p-3 text-right font-mono tabular-nums">{formatPHP(t.total_sales)}</td>
                    <td className="p-3 text-right font-mono tabular-nums">{formatPHP(t.total_cogs)}</td>
                    <td className="p-3 text-right font-mono tabular-nums">{formatPHP(t.total_expenses)}</td>
                    <td className={`p-3 text-right font-mono tabular-nums font-bold ${net >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                      {formatPHP(net)}
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
            <select value={siteForm.truckId} onChange={(e) => setSiteForm({ ...siteForm, truckId: e.target.value })} className="w-full rounded border px-3 py-2 text-xs">
              {fleetData.trucks.map((t: any) => <option key={t.id} value={t.id}>{t.location_name}</option>)}
            </select>
            <input required placeholder="Pop-up / Park Site Name" value={siteForm.siteName} onChange={(e) => setSiteForm({ ...siteForm, siteName: e.target.value })} className="w-full rounded border px-3 py-2 text-xs" />
            <input placeholder="Shift Notes" value={siteForm.shiftNotes} onChange={(e) => setSiteForm({ ...siteForm, shiftNotes: e.target.value })} className="w-full rounded border px-3 py-2 text-xs" />
            <button type="submit" className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white">Save Site Assignment</button>
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
            <select value={fuelForm.truckId} onChange={(e) => setFuelForm({ ...fuelForm, truckId: e.target.value })} className="w-full rounded border px-3 py-2 text-xs">
              {fleetData.trucks.map((t: any) => <option key={t.id} value={t.id}>{t.location_name}</option>)}
            </select>
            <div className="grid grid-cols-3 gap-2">
              <input type="number" placeholder="Liters" value={fuelForm.liters} onChange={(e) => setFuelForm({ ...fuelForm, liters: e.target.value })} className="rounded border px-3 py-2 text-xs font-mono" />
              <input type="number" placeholder="Cost (PHP)" value={fuelForm.totalCost} onChange={(e) => setFuelForm({ ...fuelForm, totalCost: e.target.value })} className="rounded border px-3 py-2 text-xs font-mono" />
              <input type="number" placeholder="Odometer" value={fuelForm.odometerKm} onChange={(e) => setFuelForm({ ...fuelForm, odometerKm: e.target.value })} className="rounded border px-3 py-2 text-xs font-mono" />
            </div>
            <button type="submit" className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white">Record Fuel Log</button>
          </form>
        </div>
      </div>
    );
  }

  // ==========================================
  // HR, ATTENDANCE & CONFIGURABLE PH PAYROLL
  // ==========================================
  if (mode === 'hr') {
    if (err && !hrData) return <div className="p-4 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700 font-medium">{err}</div>;
    if (!hrData) return <div className="h-64 rounded-xl border bg-white animate-pulse" />;

    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-semibold text-slate-900">Employees, Attendance &amp; PH Payroll</h1>
            <p className="text-sm text-slate-500">Time tracking, overtime, and configurable Philippine statutory deductions (SSS, PhilHealth, Pag-IBIG, Tax)</p>
          </div>
          <button
            onClick={async () => {
              try {
                setErr('');
                const r = await apiFetch('/hr/payroll/run', {
                  method: 'POST',
                  body: JSON.stringify({ periodStart: '2026-11-01', periodEnd: '2026-11-15', daysPerEmployee: 13 }),
                });
                setMsg(`Payroll Run posted · Gross: ${formatPHP(r.totalGross)} · Net: ${formatPHP(r.totalNet)} (Journal Entry created)`);
                await loadHr();
              } catch (e: any) {
                setErr(e.message);
              }
            }}
            className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            Run Semi-Monthly Payroll
          </button>
        </div>

        {msg && <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 font-medium">{msg}</div>}
        {err && <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">{err}</div>}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-7 rounded-xl border border-slate-200 bg-white overflow-x-auto">
            <div className="p-4 border-b border-slate-200 text-xs font-semibold text-slate-700">Employee Roster &amp; Time Clock</div>
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-100 text-slate-500">
                <tr>
                  <th className="p-3 font-medium">Employee</th>
                  <th className="p-3 font-medium">Position · Truck</th>
                  <th className="p-3 font-medium text-right">Daily Rate</th>
                  <th className="p-3 font-medium text-right">Time Clock</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {hrData.employees.map((emp: any) => (
                  <tr key={emp.id}>
                    <td className="p-3 font-semibold text-slate-900">
                      <div className="flex items-center gap-2.5">
                        <AvatarBadge name={emp.full_name} src={emp.avatar_url} size="sm" />
                        <div>
                          <p>{emp.full_name}</p>
                          <p className="font-mono text-[11px] font-normal text-slate-500">{emp.employee_code}</p>
                        </div>
                      </div>
                    </td>
                    <td className="p-3 text-slate-600">{emp.position} · {emp.location_name || 'HQ'}</td>
                    <td className="p-3 text-right font-mono tabular-nums">{formatPHP(emp.base_rate)}</td>
                    <td className="p-3 text-right space-x-1.5">
                      <button
                        onClick={async () => {
                          try {
                            setErr('');
                            await apiFetch('/hr/attendance/clock', { method: 'POST', body: JSON.stringify({ employeeId: emp.id, action: 'CLOCK_IN' }) });
                            setMsg(`${emp.full_name} clocked in.`);
                            await loadHr();
                          } catch (e: any) {
                            setErr(e.message);
                          }
                        }}
                        className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-[11px] font-medium hover:bg-slate-50"
                      >
                        <Clock className="w-3 h-3" /> In
                      </button>
                      <button
                        onClick={async () => {
                          try {
                            setErr('');
                            await apiFetch('/hr/attendance/clock', { method: 'POST', body: JSON.stringify({ employeeId: emp.id, action: 'CLOCK_OUT', overtimeHours: 1 }) });
                            setMsg(`${emp.full_name} clocked out.`);
                            await loadHr();
                          } catch (e: any) {
                            setErr(e.message);
                          }
                        }}
                        className="rounded border border-slate-200 px-2 py-1 text-[11px] font-medium hover:bg-slate-50"
                      >
                        Out
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {ruleCfg && (
            <div className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-5 space-y-3">
              <h2 className="font-display text-sm font-semibold text-slate-900">Configurable PH Statutory Rules</h2>
              <p className="text-xs text-slate-500">Update rates whenever DOLE / BIR / SSS / PhilHealth circulars change.</p>
              <div className="grid grid-cols-2 gap-2.5 text-xs">
                <div>
                  <label className="text-slate-600">SSS EE Rate %</label>
                  <input type="number" step="0.1" value={ruleCfg.sssEmployeeRatePct} onChange={(e) => setRuleCfg({ ...ruleCfg, sssEmployeeRatePct: Number(e.target.value) })} className="w-full rounded border px-2.5 py-1.5 font-mono" />
                </div>
                <div>
                  <label className="text-slate-600">PhilHealth EE %</label>
                  <input type="number" step="0.1" value={ruleCfg.philhealthEmployeeRatePct} onChange={(e) => setRuleCfg({ ...ruleCfg, philhealthEmployeeRatePct: Number(e.target.value) })} className="w-full rounded border px-2.5 py-1.5 font-mono" />
                </div>
                <div>
                  <label className="text-slate-600">Pag-IBIG Monthly (PHP)</label>
                  <input type="number" value={ruleCfg.pagibigFixedEmployeePhp} onChange={(e) => setRuleCfg({ ...ruleCfg, pagibigFixedEmployeePhp: Number(e.target.value) })} className="w-full rounded border px-2.5 py-1.5 font-mono" />
                </div>
                <div>
                  <label className="text-slate-600">Tax Exempt Ceiling / Mo</label>
                  <input type="number" value={ruleCfg.taxExemptMonthlyCeilingPhp} onChange={(e) => setRuleCfg({ ...ruleCfg, taxExemptMonthlyCeilingPhp: Number(e.target.value) })} className="w-full rounded border px-2.5 py-1.5 font-mono" />
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
                {hrData.payrollRuns[0].items.map((pi: any) => (
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
      </div>
    );
  }

  // ==========================================
  // CRM & LOYALTY
  // ==========================================
  if (mode === 'crm') {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900">Customer CRM &amp; Loyalty</h1>
          <p className="text-sm text-slate-500">Repeat customer profiles, purchase frequency, dietary preferences, and loyalty points</p>
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
                setCustForm({ fullName: '', phone: '', email: '', preferences: '' });
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
            <input required placeholder="Full Name" value={custForm.fullName} onChange={(e) => setCustForm({ ...custForm, fullName: e.target.value })} className="w-full rounded border px-3 py-2 text-xs" />
            <input placeholder="Mobile Number" value={custForm.phone} onChange={(e) => setCustForm({ ...custForm, phone: e.target.value })} className="w-full rounded border px-3 py-2 text-xs" />
            <input type="email" placeholder="Email" value={custForm.email} onChange={(e) => setCustForm({ ...custForm, email: e.target.value })} className="w-full rounded border px-3 py-2 text-xs" />
            <input placeholder="Food Preferences / Allergies" value={custForm.preferences} onChange={(e) => setCustForm({ ...custForm, preferences: e.target.value })} className="w-full rounded border px-3 py-2 text-xs" />
            <button type="submit" className="w-full rounded-lg bg-slate-900 py-2 text-xs font-semibold text-white">Save Profile</button>
          </form>

          <div className="lg:col-span-8 rounded-xl border border-slate-200 bg-white overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                <tr>
                  <th className="p-3 font-medium">Customer</th>
                  <th className="p-3 font-medium">Tier</th>
                  <th className="p-3 font-medium text-right">Points</th>
                  <th className="p-3 font-medium text-right">Orders</th>
                  <th className="p-3 font-medium text-right">Lifetime Spend</th>
                  <th className="p-3 font-medium">Preferences</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {customers.map((c) => (
                  <tr key={c.id}>
                    <td className="p-3 font-semibold text-slate-900">{c.full_name}<p className="font-normal text-slate-500">{c.phone}</p></td>
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
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900">Reports, Exports &amp; RBAC Audit</h1>
          <p className="text-sm text-slate-500">Exportable operational reports, 10-role permission matrix, and immutable audit trail</p>
        </div>
        <div className="flex items-center gap-2 no-print">
          <button
            onClick={() => downloadCsv(`maximus_barbecue_${reportType}_report.csv`, reportRows)}
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

      <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg border border-slate-200 w-fit no-print">
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

      {reportTab === 'exports' && (
        <div className="space-y-4">
          <div className="flex gap-2 no-print">
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

          <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
            {reportRows.length === 0 ? (
              <p className="p-8 text-center text-xs text-slate-400">No rows recorded for this report yet.</p>
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
        <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr>
                <th className="p-3 font-medium">Role</th>
                <th className="p-3 font-medium">Granted Permissions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {governance.roles.map((r: any) => (
                <tr key={r.id}>
                  <td className="p-3 font-semibold text-slate-900 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5">
                      <ShieldCheck className="w-3.5 h-3.5 text-slate-500" /> {r.name}
                    </span>
                    <p className="font-mono text-[11px] font-normal text-slate-500">{r.code}</p>
                  </td>
                  <td className="p-3 font-mono text-[11px] text-slate-600">{r.permissions.join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {reportTab === 'audit' && governance && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr>
                <th className="p-3 font-medium">Timestamp</th>
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
                  <td className="p-3 font-medium text-slate-900">{log.user_name || 'System'}</td>
                  <td className="p-3 font-mono font-semibold text-slate-800">{log.action}</td>
                  <td className="p-3 text-slate-600">{log.entity_type} · {log.entity_id.slice(0, 8)}</td>
                  <td className="p-3 font-mono text-[11px] text-slate-500 truncate max-w-xs">{log.details}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
