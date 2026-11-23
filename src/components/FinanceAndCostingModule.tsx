import React, { useEffect, useState } from 'react';
import { Plus, Lock, AlertTriangle } from 'lucide-react';
import { apiFetch, formatNum, formatPHP } from '../lib/api.ts';
import { LocationRow } from '../types/erp.ts';

interface Props {
  mode: 'finance' | 'costing';
  locations: LocationRow[];
  activeLocationId?: string;
}

const getTodayLocalDate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function FinanceAndCostingModule({ mode, locations, activeLocationId = 'ALL' }: Props) {
  const [finTab, setFinTab] = useState<'expenses' | 'closing' | 'ledger' | 'statements' | 'tax'>('expenses');
  const [finData, setFinData] = useState<any>(null);
  const [costData, setCostData] = useState<any>(null);
  const [showExpModal, setShowExpModal] = useState(false);
  const [expForm, setExpForm] = useState({
    locationId: 'loc_truck_1',
    accountId: 'acc_6100',
    category: 'LPG',
    expenseDate: getTodayLocalDate(),
    amount: '',
    description: '',
    paidFromPettyCash: false,
  });
  const [closingForm, setClosingForm] = useState({
    locationId: 'loc_truck_1',
    businessDate: new Date().toISOString().slice(0, 10),
    openingFloat: '3000',
    actualCash: '',
    notes: '',
  });
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const locQuery = activeLocationId && activeLocationId !== 'ALL' ? `?locationId=${encodeURIComponent(activeLocationId)}` : '';

  const loadFinance = async () => {
    try {
      setErr('');
      const res = await apiFetch(`/finance/overview${locQuery}`);
      setFinData(res);
    } catch (e: any) {
      setErr(e.message || 'Unable to load financial data');
    }
  };

  const loadCosting = async () => {
    try {
      setErr('');
      const res = await apiFetch(`/food-costing${locQuery}`);
      setCostData(res);
    } catch (e: any) {
      setErr(e.message || 'Unable to load food costing data');
    }
  };

  useEffect(() => {
    if (mode === 'finance') loadFinance();
    else loadCosting();
  }, [mode, activeLocationId]);

  useEffect(() => {
    if (activeLocationId && activeLocationId !== 'ALL') {
      if (locations.some((l) => l.id === activeLocationId)) {
        setExpForm((f) => ({ ...f, locationId: activeLocationId }));
      }
      if (locations.some((l) => l.id === activeLocationId && l.type === 'FOOD_TRUCK')) {
        setClosingForm((f) => ({ ...f, locationId: activeLocationId }));
      }
    }
  }, [activeLocationId, locations]);

  const submitExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      const datePart = expForm.expenseDate || getTodayLocalDate();
      await apiFetch('/finance/expenses', {
        method: 'POST',
        body: JSON.stringify({ ...expForm, expenseDate: `${datePart}T12:00:00.000Z` }),
      });
      setShowExpModal(false);
      setExpForm({ ...expForm, expenseDate: getTodayLocalDate(), amount: '', description: '' });
      setMsg('Expense recorded and balanced Journal Entry posted.');
      await loadFinance();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const submitClosing = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      const r = await apiFetch('/finance/daily-closing', {
        method: 'POST',
        body: JSON.stringify(closingForm),
      });
      setMsg(`Closed ${r.business_date} · Expected: ${formatPHP(r.expected_cash)} · Actual: ${formatPHP(r.actual_cash)} · Variance: ${formatPHP(r.variance)}`);
      await loadFinance();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const toggleTaxActive = async (tc: any) => {
    setErr('');
    try {
      await apiFetch(`/finance/tax/${tc.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ratePercent: tc.rate_percent, isInclusive: tc.is_inclusive === 1, isActive: tc.is_active !== 1 }),
      });
      setMsg(`Updated tax configuration: ${tc.name}`);
      await loadFinance();
    } catch (e: any) {
      setErr(e.message || 'Unable to update tax configuration');
    }
  };

  // ==========================================
  // FOOD COSTING & MENU ENGINEERING VIEW
  // ==========================================
  if (mode === 'costing') {
    if (err && !costData) return <div className="p-4 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700 font-medium">{err}</div>;
    if (!costData) return <div className="h-64 rounded-xl border bg-white animate-pulse" />;
    const alerts = costData.menuEngineering.filter((m: any) => m.isMarginAlert);

    return (
      <div className="space-y-6">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900">Food Costing &amp; Menu Engineering</h1>
          <p className="text-sm text-slate-500">
            Theoretical vs. actual ingredient consumption (AvT), waste loss, and profitability quadrants
          </p>
        </div>

        {alerts.length > 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
            <div className="text-xs text-amber-900">
              <p className="font-semibold">Margin Erosion Alert ({alerts.length} item(s) above target food cost %)</p>
              <p className="mt-0.5">
                {alerts.map((a: any) => `${a.name} (${formatNum(a.foodCostPct, 1)}% vs ${a.targetFoodCostPct}% target)`).join(' · ')}
              </p>
            </div>
          </div>
        )}

        <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
          <div className="p-4 border-b border-slate-200 text-sm font-semibold text-slate-900">
            Menu Engineering Matrix (Popularity vs. Contribution Margin)
          </div>
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr>
                <th className="p-3 font-medium">Menu Item</th>
                <th className="p-3 font-medium text-right">Price</th>
                <th className="p-3 font-medium text-right">Direct Cost</th>
                <th className="p-3 font-medium text-right">Food Cost %</th>
                <th className="p-3 font-medium text-right">GP / Unit</th>
                <th className="p-3 font-medium text-right">Units Sold</th>
                <th className="p-3 font-medium text-right">Total Contribution</th>
                <th className="p-3 font-medium">Classification</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {costData.menuEngineering.map((m: any) => (
                <tr key={m.id} className="hover:bg-slate-50">
                  <td className="p-3 font-semibold text-slate-900">{m.name}</td>
                  <td className="p-3 text-right font-mono tabular-nums">{formatPHP(m.sellingPrice)}</td>
                  <td className="p-3 text-right font-mono tabular-nums">{formatPHP(m.theoreticalCost)}</td>
                  <td className={`p-3 text-right font-mono tabular-nums font-semibold ${m.isMarginAlert ? 'text-amber-700' : 'text-slate-800'}`}>
                    {formatNum(m.foodCostPct, 1)}%
                  </td>
                  <td className="p-3 text-right font-mono tabular-nums text-emerald-700 font-semibold">{formatPHP(m.grossProfitPerUnit)}</td>
                  <td className="p-3 text-right font-mono tabular-nums">{m.unitsSold}</td>
                  <td className="p-3 text-right font-mono tabular-nums font-semibold">{formatPHP(m.totalContribution)}</td>
                  <td className="p-3 font-semibold text-slate-800">{m.quadrant}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
          <div className="p-4 border-b border-slate-200 text-sm font-semibold text-slate-900">
            Actual vs. Theoretical (AvT) Ingredient Consumption &amp; Waste
          </div>
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr>
                <th className="p-3 font-medium">Ingredient</th>
                <th className="p-3 font-medium text-right">Theoretical BOM Qty</th>
                <th className="p-3 font-medium text-right">Actual Deducted Qty</th>
                <th className="p-3 font-medium text-right">Variance Qty</th>
                <th className="p-3 font-medium text-right">Variance Cost</th>
                <th className="p-3 font-medium text-right">Recorded Waste Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {costData.avtReport.map((r: any) => (
                <tr key={r.id}>
                  <td className="p-3 font-semibold text-slate-900">{r.name}</td>
                  <td className="p-3 text-right font-mono tabular-nums">{formatNum(r.theoreticalQty, 1)} {r.uom}</td>
                  <td className="p-3 text-right font-mono tabular-nums">{formatNum(r.actualQty, 1)} {r.uom}</td>
                  <td className={`p-3 text-right font-mono tabular-nums font-semibold ${r.varianceQty > 0 ? 'text-red-700' : 'text-emerald-700'}`}>
                    {r.varianceQty > 0 ? '+' : ''}{formatNum(r.varianceQty, 1)} {r.uom}
                  </td>
                  <td className="p-3 text-right font-mono tabular-nums">{formatPHP(r.varianceCost)}</td>
                  <td className="p-3 text-right font-mono tabular-nums text-amber-700">{formatPHP(r.wasteCost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // ==========================================
  // FINANCIAL MANAGEMENT & ACCOUNTING VIEW
  // ==========================================
  if (err && !finData) return <div className="p-4 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700 font-medium">{err}</div>;
  if (!finData) return <div className="h-64 rounded-xl border bg-white animate-pulse" />;

  const { expenses, closings, journals, accounts, pettyCash, statements } = finData;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900">Finance, Accounting &amp; Daily Closing</h1>
          <p className="text-sm text-slate-500">Expenses, petty cash, Workflow C cash reconciliation, double-entry ledger, and configurable PH tax</p>
        </div>
        <button
          onClick={() => {
            setErr('');
            setExpForm((f) => ({
              ...f,
              locationId:
                activeLocationId !== 'ALL' && locations.some((l) => l.id === activeLocationId)
                  ? activeLocationId
                  : locations.some((l) => l.id === f.locationId)
                    ? f.locationId
                    : locations[0]?.id || f.locationId,
              expenseDate: f.expenseDate || getTodayLocalDate(),
            }));
            setShowExpModal(true);
          }}
          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap shrink-0"
        >
          <Plus className="w-4 h-4" /> Record Expense
        </button>
      </div>

      {msg && <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 font-medium">{msg}</div>}
      {err && !showExpModal && <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">{err}</div>}

      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg border border-slate-200 w-fit">
        {([
          { id: 'expenses', label: 'Expenses & Petty Cash' },
          { id: 'closing', label: 'Daily Closing (Workflow C)' },
          { id: 'statements', label: 'P&L & Balance Sheet' },
          { id: 'ledger', label: 'General Ledger' },
          { id: 'tax', label: 'PH Tax & BIR Settings' },
        ] as const).map((t) => (
          <button
            key={t.id}
            onClick={() => setFinTab(t.id)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 ${
              finTab === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {finTab === 'expenses' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {pettyCash.map((pc: any) => (
              <div key={pc.id} className="rounded-xl border border-slate-200 bg-white p-4 flex items-center justify-between">
                <div>
                  <p className="text-xs text-slate-500">{pc.location_name}</p>
                  <p className="font-display font-semibold text-sm text-slate-900">{pc.fund_name}</p>
                </div>
                <div className="text-right">
                  <p className="font-mono tabular-nums text-lg font-bold text-slate-900">{formatPHP(pc.current_balance)}</p>
                  <p className="text-[11px] text-slate-500">Float: {formatPHP(pc.float_amount)}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                <tr>
                  <th className="p-3 font-medium">Date</th>
                  <th className="p-3 font-medium">Location</th>
                  <th className="p-3 font-medium">Category</th>
                  <th className="p-3 font-medium">GL Account</th>
                  <th className="p-3 font-medium">Description</th>
                  <th className="p-3 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {expenses.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-6 text-center text-slate-400">
                      No operating expenses found for the selected truck / location.
                    </td>
                  </tr>
                ) : expenses.map((ex: any) => (
                  <tr key={ex.id}>
                    <td className="p-3 font-mono text-slate-500">{String(ex.expense_date).slice(0, 10)}</td>
                    <td className="p-3">{ex.location_name}</td>
                    <td className="p-3 font-semibold">{ex.category}</td>
                    <td className="p-3 text-slate-600">{ex.account_name}</td>
                    <td className="p-3 text-slate-700">{ex.description}</td>
                    <td className="p-3 text-right font-mono tabular-nums font-semibold text-slate-900">{formatPHP(ex.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {finTab === 'closing' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <form onSubmit={submitClosing} className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-5 space-y-3">
            <h2 className="font-display text-base font-semibold text-slate-900 flex items-center gap-2">
              <Lock className="w-4 h-4 text-slate-700" /> Close Business Day (Cash Reconciliation)
            </h2>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Food Truck / Location</label>
              <select value={closingForm.locationId} onChange={(e) => setClosingForm({ ...closingForm, locationId: e.target.value })} className="w-full rounded border px-3 py-2 text-xs">
                {locations.filter((l) => l.type === 'FOOD_TRUCK').map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Business Date</label>
                <input type="date" value={closingForm.businessDate} onChange={(e) => setClosingForm({ ...closingForm, businessDate: e.target.value })} className="w-full rounded border px-3 py-2 text-xs font-mono" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Opening Drawer Float</label>
                <input type="number" required value={closingForm.openingFloat} onChange={(e) => setClosingForm({ ...closingForm, openingFloat: e.target.value })} className="w-full rounded border px-3 py-2 text-xs font-mono" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Actual Counted Cash in Drawer (PHP)</label>
              <input type="number" required placeholder="e.g. 5450" value={closingForm.actualCash} onChange={(e) => setClosingForm({ ...closingForm, actualCash: e.target.value })} className="w-full rounded border px-3 py-2 text-xs font-mono" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Closing Remarks / Notes</label>
              <input type="text" placeholder="Closing remarks" value={closingForm.notes} onChange={(e) => setClosingForm({ ...closingForm, notes: e.target.value })} className="w-full rounded border px-3 py-2 text-xs" />
            </div>
            <button type="submit" className="w-full rounded-lg bg-slate-900 py-2.5 text-xs font-semibold text-white hover:bg-slate-800">
              Reconcile &amp; Close Business Day
            </button>
          </form>

          <div className="lg:col-span-7 rounded-xl border border-slate-200 bg-white overflow-x-auto">
            <div className="p-4 border-b border-slate-200 text-xs font-semibold text-slate-700">Daily Closing History</div>
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-100 text-slate-500">
                <tr>
                  <th className="p-3 font-medium">Date</th>
                  <th className="p-3 font-medium">Truck</th>
                  <th className="p-3 font-medium text-right">Expected Cash</th>
                  <th className="p-3 font-medium text-right">Actual Cash</th>
                  <th className="p-3 font-medium text-right">Variance</th>
                  <th className="p-3 font-medium text-right">Gross Profit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {closings.length === 0 ? (
                  <tr><td colSpan={6} className="p-6 text-center text-slate-400">No days closed yet. Submit form on left to close today.</td></tr>
                ) : closings.map((c: any) => (
                  <tr key={c.id}>
                    <td className="p-3 font-mono">{c.business_date}</td>
                    <td className="p-3">{c.location_name}</td>
                    <td className="p-3 text-right font-mono tabular-nums">{formatPHP(c.expected_cash)}</td>
                    <td className="p-3 text-right font-mono tabular-nums">{formatPHP(c.actual_cash)}</td>
                    <td className={`p-3 text-right font-mono tabular-nums font-semibold ${c.variance !== 0 ? 'text-amber-700' : 'text-emerald-700'}`}>
                      {formatPHP(c.variance)}
                    </td>
                    <td className="p-3 text-right font-mono tabular-nums font-semibold">{formatPHP(c.gross_profit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {finTab === 'statements' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
            <h2 className="font-display text-base font-semibold text-slate-900">Profit &amp; Loss Statement (Income Statement)</h2>
            <div className="space-y-1.5 text-xs">
              <p className="font-semibold text-slate-600">Revenue</p>
              {statements.profitAndLoss.revenues.map((r: any) => (
                <div key={r.id} className="flex justify-between py-1 border-b border-slate-100">
                  <span>{r.code} · {r.name}</span>
                  <span className="font-mono tabular-nums">{formatPHP(r.balance)}</span>
                </div>
              ))}
              <p className="font-semibold text-slate-600 pt-3">Cost of Goods Sold &amp; Operating Expenses</p>
              {statements.profitAndLoss.expenses.map((e: any) => (
                <div key={e.id} className="flex justify-between py-1 border-b border-slate-100">
                  <span>{e.code} · {e.name}</span>
                  <span className="font-mono tabular-nums">{formatPHP(e.balance)}</span>
                </div>
              ))}
              <div className="flex justify-between pt-3 text-sm font-bold text-slate-900">
                <span>Net Income</span>
                <span className={`font-mono tabular-nums ${statements.profitAndLoss.netIncome >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                  {formatPHP(statements.profitAndLoss.netIncome)}
                </span>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
            <h2 className="font-display text-base font-semibold text-slate-900">Balance Sheet</h2>
            <div className="space-y-1.5 text-xs">
              <p className="font-semibold text-slate-600">Assets</p>
              {statements.balanceSheet.assets.map((a: any) => (
                <div key={a.id} className="flex justify-between py-1 border-b border-slate-100">
                  <span>{a.code} · {a.name}</span>
                  <span className="font-mono tabular-nums">{formatPHP(a.balance)}</span>
                </div>
              ))}
              <p className="font-semibold text-slate-600 pt-3">Liabilities</p>
              {statements.balanceSheet.liabilities.map((l: any) => (
                <div key={l.id} className="flex justify-between py-1 border-b border-slate-100">
                  <span>{l.code} · {l.name}</span>
                  <span className="font-mono tabular-nums">{formatPHP(l.balance)}</span>
                </div>
              ))}
              <div className="flex justify-between py-1 border-b border-slate-100">
                <span>Current Period Retained Earnings</span>
                <span className="font-mono tabular-nums">{formatPHP(statements.balanceSheet.retainedEarningsCurrent)}</span>
              </div>
              <div className="flex justify-between pt-3 text-sm font-bold text-slate-900">
                <span>Total Assets / Total L&amp;E</span>
                <span className="font-mono tabular-nums">
                  {formatPHP(statements.balanceSheet.totalAssets)} / {formatPHP(statements.balanceSheet.totalLiabilitiesAndEquity)}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {finTab === 'ledger' && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr>
                <th className="p-3 font-medium">Entry #</th>
                <th className="p-3 font-medium">Date</th>
                <th className="p-3 font-medium">Description</th>
                <th className="p-3 font-medium">Double-Entry Lines (DR / CR)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {journals.length === 0 ? (
                <tr>
                  <td colSpan={4} className="p-6 text-center text-slate-400">
                    No journal entries match the selected truck / location.
                  </td>
                </tr>
              ) : journals.map((je: any) => (
                <tr key={je.id} className={je.is_reversed ? 'opacity-50' : ''}>
                  <td className="p-3 font-mono font-semibold text-slate-900">{je.entry_number}</td>
                  <td className="p-3 font-mono text-slate-500">{String(je.entry_date).slice(0, 10)}</td>
                  <td className="p-3">{je.description}</td>
                  <td className="p-3 space-y-0.5">
                    {je.lines.map((l: any) => (
                      <div key={l.id} className="flex justify-between gap-4 font-mono text-[11px]">
                        <span>{l.account_code} {l.account_name}</span>
                        <span>
                          {l.debit > 0 ? `DR ${formatPHP(l.debit)}` : `CR ${formatPHP(l.credit)}`}
                        </span>
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {finTab === 'tax' && (
        <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-5">
          <div>
            <h2 className="font-display text-base font-semibold text-slate-900">Configurable Philippine Tax &amp; BIR Summary</h2>
            <p className="text-xs text-slate-500">Tax rates are never hardcoded; update configurations as required by your accountant.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="p-4 rounded-lg border border-slate-200 bg-slate-50">
              <p className="text-xs text-slate-500">Net VATable Sales (Period)</p>
              <p className="font-mono tabular-nums text-xl font-bold text-slate-900 mt-1">{formatPHP(statements.taxSummary.vatableSales)}</p>
            </div>
            <div className="p-4 rounded-lg border border-slate-200 bg-slate-50">
              <p className="text-xs text-slate-500">Output Tax Payable (BIR Form 2550M/Q)</p>
              <p className="font-mono tabular-nums text-xl font-bold text-slate-900 mt-1">{formatPHP(statements.taxSummary.outputTax)}</p>
            </div>
          </div>
          <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
            {statements.taxSummary.taxConfigs.map((tc: any) => (
              <div key={tc.id} className="p-3.5 flex items-center justify-between text-xs">
                <div>
                  <p className="font-semibold text-slate-900">{tc.name}</p>
                  <p className="text-slate-500 font-mono">{tc.code} · {tc.rate_percent}% · {tc.is_inclusive ? 'Tax Inclusive' : 'Tax Exclusive'}</p>
                </div>
                <button
                  onClick={() => toggleTaxActive(tc)}
                  className={`px-3 py-1.5 rounded-md font-semibold ${tc.is_active ? 'bg-emerald-600 text-white' : 'border border-slate-300 text-slate-700'}`}
                >
                  {tc.is_active ? 'Active' : 'Inactive'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {showExpModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form onSubmit={submitExpense} className="w-full max-w-md rounded-xl bg-white p-5 space-y-3 border border-slate-200">
            <h3 className="font-display text-base font-semibold text-slate-900">Record Operating Expense</h3>
            {err && <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">{err}</div>}
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Branch / Location</label>
              <select value={expForm.locationId} onChange={(e) => setExpForm({ ...expForm, locationId: e.target.value })} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs">
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Expense Category</label>
                <select value={expForm.category} onChange={(e) => setExpForm({ ...expForm, category: e.target.value })} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs">
                  <option value="FUEL">Fuel</option>
                  <option value="LPG">LPG</option>
                  <option value="ELECTRICITY">Electricity / Water</option>
                  <option value="PACKAGING">Packaging</option>
                  <option value="MAINTENANCE">Vehicle Repairs</option>
                  <option value="PERMITS">Permits &amp; Licenses</option>
                  <option value="RENT_PARKING">Rent &amp; Parking</option>
                  <option value="MARKETING">Marketing</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">GL Expense Account</label>
                <select value={expForm.accountId} onChange={(e) => setExpForm({ ...expForm, accountId: e.target.value })} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs">
                  {accounts.filter((a: any) => a.type === 'EXPENSE').map((a: any) => (
                    <option key={a.id} value={a.id}>{a.code} {a.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Expense Date *</label>
                <input
                  type="date"
                  required
                  value={expForm.expenseDate}
                  onChange={(e) => setExpForm({ ...expForm, expenseDate: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Amount (PHP) *</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  placeholder="e.g. 1850"
                  value={expForm.amount}
                  onChange={(e) => setExpForm({ ...expForm, amount: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Description *</label>
              <input type="text" required placeholder="e.g. 2x Solane LPG" value={expForm.description} onChange={(e) => setExpForm({ ...expForm, description: e.target.value })} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs" />
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input type="checkbox" checked={expForm.paidFromPettyCash} onChange={(e) => setExpForm({ ...expForm, paidFromPettyCash: e.target.checked })} />
              Deduct from Truck Petty Cash Float
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => { setErr(''); setShowExpModal(false); }} className="px-4 py-2 rounded-lg border text-xs">Cancel</button>
              <button type="submit" className="px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold">Post Expense &amp; GL</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
