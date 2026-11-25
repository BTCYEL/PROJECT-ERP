import React, { useEffect, useState } from 'react';
import { Plus, Lock, AlertTriangle, Pencil, Trash2, Tag, BookOpen, X, Check, Settings2, PlusCircle, RotateCcw } from 'lucide-react';
import { apiFetch, formatNum, formatPHP } from '../lib/api.ts';
import { LocationRow } from '../types/erp.ts';

interface Props {
  mode: 'finance' | 'costing';
  locations: LocationRow[];
  activeLocationId?: string;
  quickAction?: { action: string; nonce: number } | null;
  onQuickActionHandled?: () => void;
}

const getTodayLocalDate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function FinanceAndCostingModule({ mode, locations, activeLocationId = 'ALL', quickAction, onQuickActionHandled }: Props) {
  const [finTab, setFinTab] = useState<'expenses' | 'closing' | 'ledger' | 'statements' | 'tax'>('expenses');
  const [finData, setFinData] = useState<any>(null);
  const [costData, setCostData] = useState<any>(null);

  // Expense modal & state
  const [showExpModal, setShowExpModal] = useState(false);
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null);
  const [deletingExpense, setDeletingExpense] = useState<any | null>(null);
  const [isSubmittingExp, setIsSubmittingExp] = useState(false);
  const [isDeletingExp, setIsDeletingExp] = useState(false);

  const [expForm, setExpForm] = useState({
    locationId: 'loc_truck_1',
    accountId: 'acc_6100',
    category: 'FUEL',
    expenseDate: getTodayLocalDate(),
    amount: '',
    description: '',
    paidFromPettyCash: false,
  });

  // Expense Categories management state
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [editingCatId, setEditingCatId] = useState<string | null>(null);
  const [catForm, setCatForm] = useState({ code: '', name: '', description: '', sortOrder: '1', isActive: true });
  const [catErr, setCatErr] = useState('');
  const [catMsg, setCatMsg] = useState('');
  const [isSubmittingCat, setIsSubmittingCat] = useState(false);

  // GL Accounts management state
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [editingAccId, setEditingAccId] = useState<string | null>(null);
  const [accForm, setAccForm] = useState({ code: '', name: '', type: 'EXPENSE' });
  const [accErr, setAccErr] = useState('');
  const [accMsg, setAccMsg] = useState('');
  const [isSubmittingAcc, setIsSubmittingAcc] = useState(false);

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
    if (mode !== 'finance' || !quickAction) return;
    if (quickAction.action === 'new-expense') {
      setFinTab('expenses');
      handleOpenAddExpense();
      onQuickActionHandled?.();
    } else if (quickAction.action === 'daily-closing') {
      setFinTab('closing');
      onQuickActionHandled?.();
    }
  }, [mode, quickAction]);

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

  const handleOpenAddExpense = () => {
    setErr('');
    setEditingExpenseId(null);
    const defaultCat = finData?.expenseCategories?.[0]?.code || 'FUEL';
    const defaultAcc = finData?.accounts?.find((a: any) => a.type === 'EXPENSE')?.id || 'acc_6100';
    setExpForm({
      locationId: activeLocationId !== 'ALL' && locations.some((l) => l.id === activeLocationId)
        ? activeLocationId
        : locations[0]?.id || 'loc_truck_1',
      accountId: defaultAcc,
      category: defaultCat,
      expenseDate: getTodayLocalDate(),
      amount: '',
      description: '',
      paidFromPettyCash: false,
    });
    setShowExpModal(true);
  };

  const handleStartEditExpense = (ex: any) => {
    setErr('');
    setEditingExpenseId(ex.id);
    setExpForm({
      locationId: ex.location_id || locations[0]?.id || 'loc_truck_1',
      accountId: ex.account_id || finData?.accounts?.find((a: any) => a.type === 'EXPENSE')?.id || 'acc_6100',
      category: ex.category || finData?.expenseCategories?.[0]?.code || 'FUEL',
      expenseDate: String(ex.expense_date || '').slice(0, 10) || getTodayLocalDate(),
      amount: String(ex.amount ?? ''),
      description: ex.description || '',
      paidFromPettyCash: Boolean(ex.paid_from_petty_cash),
    });
    setShowExpModal(true);
  };

  const submitExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setIsSubmittingExp(true);
    try {
      const datePart = expForm.expenseDate || getTodayLocalDate();
      const payload = { ...expForm, expenseDate: `${datePart}T12:00:00.000Z` };

      if (editingExpenseId) {
        await apiFetch(`/finance/expenses/${editingExpenseId}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        setMsg('Operating expense updated successfully and linked journal entry reconciled.');
      } else {
        await apiFetch('/finance/expenses', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        setMsg('Operating expense recorded and balanced Journal Entry posted.');
      }

      setShowExpModal(false);
      setEditingExpenseId(null);
      setExpForm({ ...expForm, expenseDate: getTodayLocalDate(), amount: '', description: '' });
      await loadFinance();
    } catch (e: any) {
      setErr(e.message || 'Error saving operating expense');
    } finally {
      setIsSubmittingExp(false);
    }
  };

  const handleDeleteExpense = async () => {
    if (!deletingExpense) return;
    setErr('');
    setIsDeletingExp(true);
    try {
      await apiFetch(`/finance/expenses/${deletingExpense.id}`, {
        method: 'DELETE',
      });
      setMsg(`Operating expense (${formatPHP(deletingExpense.amount)}) deleted and petty cash float/GL journal adjusted.`);
      setDeletingExpense(null);
      await loadFinance();
    } catch (e: any) {
      setErr(e.message || 'Error deleting operating expense');
    } finally {
      setIsDeletingExp(false);
    }
  };

  // --- Category Management Handlers ---
  const handleOpenCategoryManager = () => {
    setCatErr('');
    setCatMsg('');
    setEditingCatId(null);
    const nextSort = (finData?.expenseCategories?.length || 0) + 1;
    setCatForm({ code: '', name: '', description: '', sortOrder: String(nextSort), isActive: true });
    setShowCategoryModal(true);
  };

  const handleStartEditCategory = (cat: any) => {
    setCatErr('');
    setCatMsg('');
    setEditingCatId(cat.id);
    setCatForm({
      code: cat.code,
      name: cat.name,
      description: cat.description || '',
      sortOrder: String(cat.sort_order ?? 0),
      isActive: Boolean(cat.is_active),
    });
  };

  const handleCancelEditCategory = () => {
    setEditingCatId(null);
    const nextSort = (finData?.expenseCategories?.length || 0) + 1;
    setCatForm({ code: '', name: '', description: '', sortOrder: String(nextSort), isActive: true });
  };

  const handleSubmitCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    setCatErr('');
    setCatMsg('');
    setIsSubmittingCat(true);
    try {
      if (editingCatId) {
        await apiFetch(`/finance/expense-categories/${editingCatId}`, {
          method: 'PUT',
          body: JSON.stringify(catForm),
        });
        setCatMsg(`Expense category "${catForm.name}" updated successfully.`);
      } else {
        await apiFetch('/finance/expense-categories', {
          method: 'POST',
          body: JSON.stringify(catForm),
        });
        setCatMsg(`Expense category "${catForm.name}" created successfully.`);
      }
      handleCancelEditCategory();
      await loadFinance();
    } catch (e: any) {
      setCatErr(e.message || 'Error saving category');
    } finally {
      setIsSubmittingCat(false);
    }
  };

  const handleDeleteCategory = async (cat: any) => {
    if (!confirm(`Delete expense category "${cat.name}"?`)) return;
    setCatErr('');
    setCatMsg('');
    try {
      await apiFetch(`/finance/expense-categories/${cat.id}`, {
        method: 'DELETE',
      });
      setCatMsg(`Expense category "${cat.name}" deleted.`);
      await loadFinance();
    } catch (e: any) {
      setCatErr(e.message || 'Unable to delete category');
    }
  };

  // --- GL Account Management Handlers ---
  const handleOpenAccountManager = () => {
    setAccErr('');
    setAccMsg('');
    setEditingAccId(null);
    setAccForm({ code: '', name: '', type: 'EXPENSE' });
    setShowAccountModal(true);
  };

  const handleStartEditAccount = (acc: any) => {
    setAccErr('');
    setAccMsg('');
    setEditingAccId(acc.id);
    setAccForm({
      code: acc.code,
      name: acc.name,
      type: 'EXPENSE',
    });
  };

  const handleCancelEditAccount = () => {
    setEditingAccId(null);
    setAccForm({ code: '', name: '', type: 'EXPENSE' });
  };

  const handleSubmitAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setAccErr('');
    setAccMsg('');
    setIsSubmittingAcc(true);
    try {
      if (editingAccId) {
        await apiFetch(`/finance/accounts/${editingAccId}`, {
          method: 'PUT',
          body: JSON.stringify(accForm),
        });
        setAccMsg(`GL Expense Account ${accForm.code} updated successfully.`);
      } else {
        await apiFetch('/finance/accounts', {
          method: 'POST',
          body: JSON.stringify({ ...accForm, type: 'EXPENSE' }),
        });
        setAccMsg(`GL Expense Account ${accForm.code} created successfully.`);
      }
      handleCancelEditAccount();
      await loadFinance();
    } catch (e: any) {
      setAccErr(e.message || 'Error saving GL account');
    } finally {
      setIsSubmittingAcc(false);
    }
  };

  const handleDeleteAccount = async (acc: any) => {
    if (!confirm(`Delete GL Account "${acc.code} ${acc.name}"?`)) return;
    setAccErr('');
    setAccMsg('');
    try {
      await apiFetch(`/finance/accounts/${acc.id}`, {
        method: 'DELETE',
      });
      setAccMsg(`GL Account ${acc.code} deleted.`);
      await loadFinance();
    } catch (e: any) {
      setAccErr(e.message || 'Unable to delete account');
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

  const { expenses, closings, journals, accounts, pettyCash, statements, expenseCategories = [] } = finData;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900">Finance, Accounting &amp; Daily Closing</h1>
          <p className="text-sm text-slate-500">Expenses, petty cash, Workflow C cash reconciliation, double-entry ledger, and configurable PH tax</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleOpenCategoryManager}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0 transition-colors"
            title="Manage Expense Categories"
          >
            <Tag className="w-3.5 h-3.5 text-slate-500" /> Expense Categories
          </button>
          <button
            type="button"
            onClick={handleOpenAccountManager}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
            title="Manage GL Expense Accounts"
          >
            <BookOpen className="w-3.5 h-3.5 text-slate-500" /> GL Accounts
          </button>
          <button
            type="button"
            onClick={handleOpenAddExpense}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap shrink-0 transition-colors"
          >
            <Plus className="w-4 h-4" /> Record Operating Expense
          </button>
        </div>
      </div>

      {msg && <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 font-medium">{msg}</div>}
      {err && !showExpModal && !showCategoryModal && !showAccountModal && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">{err}</div>
      )}

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
                  <p className="text-[11px] text-slate-500 font-mono tabular-nums">Float: {formatPHP(pc.float_amount)}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
            <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-display text-sm font-semibold text-slate-900">Operating Expenses Register</h3>
                <p className="text-xs text-slate-500">Add, edit, or delete operating costs and petty cash disbursements</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleOpenAddExpense}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-slate-800 hover:text-slate-950 px-2.5 py-1.5 rounded-md border border-slate-200 hover:bg-slate-50"
                >
                  <Plus className="w-3.5 h-3.5" /> Add Expense
                </button>
              </div>
            </div>
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                <tr>
                  <th className="p-3 font-medium">Date</th>
                  <th className="p-3 font-medium">Location</th>
                  <th className="p-3 font-medium">Category</th>
                  <th className="p-3 font-medium">GL Account</th>
                  <th className="p-3 font-medium">Description</th>
                  <th className="p-3 font-medium text-right">Amount</th>
                  <th className="p-3 font-medium text-right w-20">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {expenses.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-6 text-center text-slate-400">
                      No operating expenses found for the selected truck / location.
                    </td>
                  </tr>
                ) : expenses.map((ex: any) => (
                  <tr key={ex.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="p-3 font-mono text-slate-500 whitespace-nowrap">{String(ex.expense_date).slice(0, 10)}</td>
                    <td className="p-3 font-medium text-slate-800">{ex.location_name}</td>
                    <td className="p-3">
                      <div className="inline-flex items-center gap-1.5">
                        <span className="font-semibold text-slate-800">{ex.category}</span>
                        {ex.paid_from_petty_cash ? (
                          <span className="text-[10px] font-medium text-amber-800 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
                            Petty Cash
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="p-3 text-slate-600 font-mono text-[11px]">{ex.account_name || ex.account_id}</td>
                    <td className="p-3 text-slate-700 max-w-xs truncate">{ex.description}</td>
                    <td className="p-3 text-right font-mono tabular-nums font-semibold text-slate-900">{formatPHP(ex.amount)}</td>
                    <td className="p-3 text-right">
                      <div className="inline-flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => handleStartEditExpense(ex)}
                          title="Edit Operating Expense"
                          className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-md transition-colors"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeletingExpense(ex)}
                          title="Delete Operating Expense"
                          className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
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

      {/* Record or Edit Operating Expense Modal */}
      {showExpModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form onSubmit={submitExpense} className="w-full max-w-md rounded-xl bg-white p-5 space-y-3.5 border border-slate-200 shadow-xl">
            <div className="flex items-center justify-between pb-1 border-b border-slate-100">
              <h3 className="font-display text-base font-semibold text-slate-900">
                {editingExpenseId ? 'Edit Operating Expense' : 'Record Operating Expense'}
              </h3>
              <button
                type="button"
                onClick={() => { setErr(''); setShowExpModal(false); setEditingExpenseId(null); }}
                className="p-1 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {err && <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">{err}</div>}

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Branch / Location *</label>
              <select
                value={expForm.locationId}
                onChange={(e) => setExpForm({ ...expForm, locationId: e.target.value })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs bg-white"
              >
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.name} ({l.type})</option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-slate-600">Expense Category *</label>
                  <button
                    type="button"
                    onClick={() => { setShowCategoryModal(true); }}
                    className="text-[11px] text-slate-500 hover:text-slate-900 font-medium underline"
                  >
                    Manage
                  </button>
                </div>
                <select
                  value={expForm.category}
                  onChange={(e) => setExpForm({ ...expForm, category: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs bg-white font-medium"
                >
                  {(expenseCategories && expenseCategories.length > 0 ? expenseCategories : [
                    { code: 'FUEL', name: 'Fuel' },
                    { code: 'LPG', name: 'LPG' },
                    { code: 'ELECTRICITY', name: 'Electricity' },
                    { code: 'PACKAGING', name: 'Packaging' },
                    { code: 'MAINTENANCE', name: 'Maintenance' },
                    { code: 'PERMITS', name: 'Permits' },
                    { code: 'RENT_PARKING', name: 'Rent & Parking' },
                    { code: 'MARKETING', name: 'Marketing' },
                    { code: 'MISC', name: 'Miscellaneous' },
                  ]).filter((c: any) => c.is_active !== 0).map((c: any) => (
                    <option key={c.id || c.code} value={c.code}>{c.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-slate-600">GL Account *</label>
                  <button
                    type="button"
                    onClick={() => { setShowAccountModal(true); }}
                    className="text-[11px] text-slate-500 hover:text-slate-900 font-medium underline"
                  >
                    Manage
                  </button>
                </div>
                <select
                  value={expForm.accountId}
                  onChange={(e) => setExpForm({ ...expForm, accountId: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs bg-white font-mono"
                >
                  {accounts.filter((a: any) => a.type === 'EXPENSE').map((a: any) => (
                    <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
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
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono bg-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Amount (PHP) *</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  placeholder="e.g. 1850.00"
                  value={expForm.amount}
                  onChange={(e) => setExpForm({ ...expForm, amount: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono bg-white"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Description / Memo *</label>
              <input
                type="text"
                required
                placeholder="e.g. 2x 11kg Solane LPG Tank refill for evening shift"
                value={expForm.description}
                onChange={(e) => setExpForm({ ...expForm, description: e.target.value })}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs bg-white"
              />
            </div>

            <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer pt-1">
              <input
                type="checkbox"
                checked={expForm.paidFromPettyCash}
                onChange={(e) => setExpForm({ ...expForm, paidFromPettyCash: e.target.checked })}
                className="rounded border-slate-300 text-slate-900 focus:ring-slate-900"
              />
              <span>Deduct from Truck Petty Cash Float (reduces on-hand drawer cash)</span>
            </label>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
              <button
                type="button"
                onClick={() => { setErr(''); setShowExpModal(false); setEditingExpenseId(null); }}
                className="px-4 py-2 rounded-lg border border-slate-200 text-xs text-slate-700 hover:bg-slate-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmittingExp}
                className="px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-60 transition-colors"
              >
                {isSubmittingExp ? 'Saving...' : editingExpenseId ? 'Update Operating Expense' : 'Post Expense & GL'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Delete Operating Expense Confirmation Modal */}
      {deletingExpense && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-xl bg-white p-5 space-y-3.5 border border-slate-200 shadow-xl">
            <div className="flex items-center gap-2 text-red-600">
              <AlertTriangle className="w-5 h-5" />
              <h3 className="font-display text-base font-semibold text-slate-900">Delete Operating Expense</h3>
            </div>
            <p className="text-xs text-slate-600">
              Are you sure you want to delete this expense of{' '}
              <strong className="text-slate-900 font-mono">{formatPHP(deletingExpense.amount)}</strong> recorded for{' '}
              <span className="font-medium">{deletingExpense.location_name}</span> ({deletingExpense.category})?
            </p>
            {deletingExpense.paid_from_petty_cash ? (
              <p className="text-xs text-amber-800 bg-amber-50 p-2.5 rounded-lg border border-amber-200">
                This expense was paid from petty cash. Deleting it will restore{' '}
                <strong className="font-mono">{formatPHP(deletingExpense.amount)}</strong> back to the truck's petty cash float and remove the linked journal entry.
              </p>
            ) : (
              <p className="text-xs text-slate-500 bg-slate-50 p-2.5 rounded-lg border border-slate-200">
                The linked general ledger journal entry will also be deleted to maintain double-entry balancing.
              </p>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDeletingExpense(null)}
                className="px-4 py-2 rounded-lg border border-slate-200 text-xs text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isDeletingExp}
                onClick={handleDeleteExpense}
                className="px-4 py-2 rounded-lg bg-red-600 text-white text-xs font-semibold hover:bg-red-700 disabled:opacity-60"
              >
                {isDeletingExp ? 'Deleting...' : 'Confirm Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Manage Expense Categories Modal */}
      {showCategoryModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-2xl rounded-xl bg-white p-5 space-y-4 border border-slate-200 shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-2 border-b border-slate-200">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900 flex items-center gap-2">
                  <Tag className="w-4 h-4 text-slate-700" /> Manage Expense Categories
                </h3>
                <p className="text-xs text-slate-500">Configure operating expense groupings used across food trucks</p>
              </div>
              <button
                type="button"
                onClick={() => setShowCategoryModal(false)}
                className="p-1 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {catErr && <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">{catErr}</div>}
            {catMsg && <div className="p-2.5 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 font-medium">{catMsg}</div>}

            {/* Category Form */}
            <form onSubmit={handleSubmitCategory} className="p-3.5 rounded-lg border border-slate-200 bg-slate-50 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-800">
                  {editingCatId ? 'Edit Category' : 'Add New Category'}
                </span>
                {editingCatId && (
                  <button
                    type="button"
                    onClick={handleCancelEditCategory}
                    className="text-xs text-slate-500 hover:text-slate-800 flex items-center gap-1"
                  >
                    <RotateCcw className="w-3 h-3" /> Cancel Edit
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">Code (Unique) *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. ICE_SUPPLY"
                    value={catForm.code}
                    onChange={(e) => setCatForm({ ...catForm, code: e.target.value.toUpperCase().replace(/\s+/g, '_') })}
                    className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-mono"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">Category Name *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Ice & Cooling Consumables"
                    value={catForm.name}
                    onChange={(e) => setCatForm({ ...catForm, name: e.target.value })}
                    className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
                <div className="sm:col-span-3">
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">Description</label>
                  <input
                    type="text"
                    placeholder="Short description or usage guidance"
                    value={catForm.description}
                    onChange={(e) => setCatForm({ ...catForm, description: e.target.value })}
                    className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">Sort Order</label>
                  <input
                    type="number"
                    value={catForm.sortOrder}
                    onChange={(e) => setCatForm({ ...catForm, sortOrder: e.target.value })}
                    className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-mono"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between pt-1">
                <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={catForm.isActive}
                    onChange={(e) => setCatForm({ ...catForm, isActive: e.target.checked })}
                    className="rounded border-slate-300 text-slate-900"
                  />
                  <span>Active in Expense Dropdown</span>
                </label>
                <button
                  type="submit"
                  disabled={isSubmittingCat}
                  className="px-3.5 py-1.5 rounded-md bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-60 transition-colors"
                >
                  {isSubmittingCat ? 'Saving...' : editingCatId ? 'Save Category' : '+ Add Category'}
                </button>
              </div>
            </form>

            {/* Categories Table */}
            <div className="rounded-lg border border-slate-200 overflow-hidden">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                  <tr>
                    <th className="p-2.5 font-medium">Code</th>
                    <th className="p-2.5 font-medium">Name</th>
                    <th className="p-2.5 font-medium">Description</th>
                    <th className="p-2.5 font-medium text-center">Status</th>
                    <th className="p-2.5 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(expenseCategories || []).map((cat: any) => (
                    <tr key={cat.id || cat.code} className="hover:bg-slate-50">
                      <td className="p-2.5 font-mono font-semibold text-slate-800">{cat.code}</td>
                      <td className="p-2.5 font-medium text-slate-900">{cat.name}</td>
                      <td className="p-2.5 text-slate-500 truncate max-w-[200px]">{cat.description || '—'}</td>
                      <td className="p-2.5 text-center">
                        <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold ${
                          cat.is_active !== 0 ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-slate-100 text-slate-500'
                        }`}>
                          {cat.is_active !== 0 ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="p-2.5 text-right">
                        <div className="inline-flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => handleStartEditCategory(cat)}
                            title="Edit Category"
                            className="p-1 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteCategory(cat)}
                            title="Delete Category"
                            className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={() => setShowCategoryModal(false)}
                className="px-4 py-2 rounded-lg bg-slate-100 text-slate-700 text-xs font-semibold hover:bg-slate-200"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Manage GL Accounts Modal */}
      {showAccountModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-2xl rounded-xl bg-white p-5 space-y-4 border border-slate-200 shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-2 border-b border-slate-200">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900 flex items-center gap-2">
                  <BookOpen className="w-4 h-4 text-slate-700" /> Manage GL Expense Accounts
                </h3>
                <p className="text-xs text-slate-500">Configure General Ledger expense accounts for chart-of-accounts compliance</p>
              </div>
              <button
                type="button"
                onClick={() => setShowAccountModal(false)}
                className="p-1 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {accErr && <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">{accErr}</div>}
            {accMsg && <div className="p-2.5 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 font-medium">{accMsg}</div>}

            {/* Account Form */}
            <form onSubmit={handleSubmitAccount} className="p-3.5 rounded-lg border border-slate-200 bg-slate-50 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-800">
                  {editingAccId ? 'Edit GL Account' : 'Add Custom GL Expense Account'}
                </span>
                {editingAccId && (
                  <button
                    type="button"
                    onClick={handleCancelEditAccount}
                    className="text-xs text-slate-500 hover:text-slate-800 flex items-center gap-1"
                  >
                    <RotateCcw className="w-3 h-3" /> Cancel Edit
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">Account Code *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. 6500"
                    value={accForm.code}
                    onChange={(e) => setAccForm({ ...accForm, code: e.target.value })}
                    className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-mono"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">Account Name *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Staff Meals &amp; Refreshments"
                    value={accForm.name}
                    onChange={(e) => setAccForm({ ...accForm, name: e.target.value })}
                    className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                  />
                </div>
              </div>
              <div className="flex justify-end pt-1">
                <button
                  type="submit"
                  disabled={isSubmittingAcc}
                  className="px-3.5 py-1.5 rounded-md bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-60 transition-colors"
                >
                  {isSubmittingAcc ? 'Saving...' : editingAccId ? 'Save Account' : '+ Add Expense Account'}
                </button>
              </div>
            </form>

            {/* Accounts Table */}
            <div className="rounded-lg border border-slate-200 overflow-hidden">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
                  <tr>
                    <th className="p-2.5 font-medium">Code</th>
                    <th className="p-2.5 font-medium">Account Name</th>
                    <th className="p-2.5 font-medium">Classification</th>
                    <th className="p-2.5 font-medium">Type</th>
                    <th className="p-2.5 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {accounts.filter((a: any) => a.type === 'EXPENSE').map((acc: any) => (
                    <tr key={acc.id} className="hover:bg-slate-50">
                      <td className="p-2.5 font-mono font-semibold text-slate-800">{acc.code}</td>
                      <td className="p-2.5 font-medium text-slate-900">{acc.name}</td>
                      <td className="p-2.5 text-slate-500">
                        {acc.is_system ? (
                          <span className="text-[10px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded font-mono">System</span>
                        ) : (
                          <span className="text-[10px] bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded font-medium">Custom</span>
                        )}
                      </td>
                      <td className="p-2.5 text-slate-500 font-mono text-[11px]">{acc.type}</td>
                      <td className="p-2.5 text-right">
                        {acc.is_system ? (
                          <span className="text-[11px] text-slate-400 italic">Protected</span>
                        ) : (
                          <div className="inline-flex items-center justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => handleStartEditAccount(acc)}
                              title="Edit Account"
                              className="p-1 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteAccount(acc)}
                              title="Delete Account"
                              className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={() => setShowAccountModal(false)}
                className="px-4 py-2 rounded-lg bg-slate-100 text-slate-700 text-xs font-semibold hover:bg-slate-200"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
