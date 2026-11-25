import React, { useEffect, useState } from 'react';
import {
  Plus,
  Lock,
  AlertTriangle,
  Pencil,
  Trash2,
  Tag,
  BookOpen,
  X,
  Check,
  Settings2,
  PlusCircle,
  RotateCcw,
  Download,
  Search,
  Flame,
  Utensils,
  Package,
  Trash,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { apiFetch, downloadCsv, formatNum, formatPHP } from '../lib/api.ts';
import { LocationRow } from '../types/erp.ts';
import { FinanceWeeklyCostChart } from './FinanceWeeklyCostChart.tsx';
import { getWasteReasonLabel } from '../lib/wasteManagement.ts';

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
  const [costingTab, setCostingTab] = useState<'recipes' | 'ingredients' | 'waste-logs' | 'engineering'>('recipes');
  const [costingSearch, setCostingSearch] = useState('');
  const [expandedRecipeId, setExpandedRecipeId] = useState<string | null>(null);

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
    if (err && !costData) return <div className="p-4 rounded-lg border border-red-200 dark:border-red-800/80 bg-red-50 dark:bg-red-950/50 text-xs text-red-700 dark:text-red-300 font-medium">{err}</div>;
    if (!costData) return <div className="h-64 rounded-xl border bg-white dark:bg-slate-900 animate-pulse" />;

    const recipeReports = costData.recipeUsageReport || [];
    const avtReport = costData.avtReport || [];
    const recentWasteLogs = costData.recentWasteLogs || [];
    const menuEngineering = costData.menuEngineering || [];
    const wasteSummary = costData.wasteSummary || {
      totalTheoreticalIngredientCost: 0,
      totalActualCostWithWaste: 0,
      totalNetVarianceCost: 0,
      totalRecordedWasteCost: 0,
      recipeLinkedWasteCost: 0,
      recipeLinkedWasteEvents: 0,
    };

    const marginAlerts = recipeReports.filter(
      (r: any) => (r.actualFoodCostPct > 0 && r.actualFoodCostPct > r.targetFoodCostPct) || r.varianceCost > 100,
    );

    const term = costingSearch.trim().toLowerCase();
    const filteredRecipes = recipeReports.filter(
      (r: any) => !term || r.name.toLowerCase().includes(term) || (r.categoryName || '').toLowerCase().includes(term) || (r.sku || '').toLowerCase().includes(term),
    );
    const filteredIngredients = avtReport.filter(
      (i: any) => !term || i.name.toLowerCase().includes(term) || (i.uom || '').toLowerCase().includes(term) || (i.linkedRecipes || []).some((lr: string) => lr.toLowerCase().includes(term)),
    );
    const filteredWasteLogs = recentWasteLogs.filter(
      (w: any) =>
        !term ||
        (w.productName || '').toLowerCase().includes(term) ||
        (w.primaryItemName || '').toLowerCase().includes(term) ||
        (w.reasonNotes || '').toLowerCase().includes(term) ||
        (w.loggedByName || '').toLowerCase().includes(term) ||
        (w.reasonCategory || '').toLowerCase().includes(term),
    );
    const filteredMenuEng = menuEngineering.filter(
      (m: any) => !term || m.name.toLowerCase().includes(term) || (m.quadrant || '').toLowerCase().includes(term),
    );

    const handleExportCostingCsv = () => {
      const ts = new Date().toISOString().slice(0, 10);
      if (costingTab === 'recipes') {
        const rows = filteredRecipes.map((r: any) => ({
          'Recipe / Item': r.name,
          'Category': r.categoryName || '',
          'Units Sold': r.unitsSold,
          'Sales Revenue (PHP)': Number(r.salesRevenue || 0).toFixed(2),
          'Theoretical BOM Cost (PHP)': Number(r.theoreticalIngredientCost || 0).toFixed(2),
          'Actual Sales COGS (PHP)': Number(r.actualSaleCogs || 0).toFixed(2),
          'Linked Waste Cost (PHP)': Number(r.linkedWasteCost || 0).toFixed(2),
          'Linked Waste Servings': r.linkedWasteServings,
          'Total Actual Cost (PHP)': Number(r.totalActualCost || 0).toFixed(2),
          'Variance Cost (PHP)': Number(r.varianceCost || 0).toFixed(2),
          'Variance %': `${r.variancePct}%`,
          'Theoretical Food Cost %': `${r.theoreticalFoodCostPct}%`,
          'Actual Food Cost %': `${r.actualFoodCostPct}%`,
          'Target Food Cost %': `${r.targetFoodCostPct}%`,
        }));
        downloadCsv(`recipe-avt-foodcosting-${ts}.csv`, rows);
      } else if (costingTab === 'ingredients') {
        const rows = filteredIngredients.map((i: any) => ({
          'Ingredient': i.name,
          'UOM': i.uom,
          'Theoretical BOM Qty': i.theoreticalQty,
          'Actual Deducted Qty': i.actualQty,
          'Sales Out Qty': i.saleOutQty,
          'Prep Waste Qty': i.wasteQty,
          'Spoilage Qty': i.spoilageQty,
          'Adjustment Qty': i.adjustmentQty,
          'Variance Qty': i.varianceQty,
          'Variance %': `${i.variancePct}%`,
          'Variance Cost (PHP)': Number(i.varianceCost || 0).toFixed(2),
          'Recorded Waste Cost (PHP)': Number(i.wasteCost || 0).toFixed(2),
          'Linked Recipes': (i.linkedRecipes || []).join('; '),
        }));
        downloadCsv(`ingredient-avt-usage-${ts}.csv`, rows);
      } else if (costingTab === 'waste-logs') {
        const rows = filteredWasteLogs.map((w: any) => ({
          'Date / Time': w.wastedAt ? new Date(w.wastedAt).toLocaleString('en-PH') : '',
          'Location': w.locationName || '',
          'Type': w.txnType === 'OUT_SPOILAGE' ? 'Spoilage' : 'Prep Waste',
          'Mode': w.entryMode,
          'Cause Category': getWasteReasonLabel(w.reasonCategory),
          'Recipe / Raw Item': w.productName || w.primaryItemName || 'Item',
          'Servings Wasted': w.servingsWasted,
          'Total Loss (PHP)': Number(w.totalLossCost || 0).toFixed(2),
          'Logged By': w.loggedByName || '',
          'Notes': w.reasonNotes || '',
        }));
        downloadCsv(`kitchen-waste-logs-${ts}.csv`, rows);
      } else {
        const rows = filteredMenuEng.map((m: any) => ({
          'Menu Item': m.name,
          'Price (PHP)': Number(m.sellingPrice || 0).toFixed(2),
          'Theoretical Cost (PHP)': Number(m.theoreticalCost || 0).toFixed(2),
          'Food Cost %': `${m.foodCostPct}%`,
          'Target Food Cost %': `${m.targetFoodCostPct}%`,
          'Gross Profit / Unit (PHP)': Number(m.grossProfitPerUnit || 0).toFixed(2),
          'Units Sold': m.unitsSold,
          'Total Contribution (PHP)': Number(m.totalContribution || 0).toFixed(2),
          'Classification': m.quadrant,
        }));
        downloadCsv(`menu-engineering-${ts}.csv`, rows);
      }
    };

    return (
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-semibold text-slate-900 dark:text-slate-50">Food Costing, AvT &amp; Waste Management</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Theoretical vs. actual ingredient consumption (AvT), recipe-linked kitchen waste attribution, margin erosion alerts, and menu engineering matrix
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleExportCostingCsv}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
            >
              <Download className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
              Export {costingTab === 'recipes' ? 'Recipe AvT' : costingTab === 'ingredients' ? 'Ingredient AvT' : costingTab === 'waste-logs' ? 'Waste Logs' : 'Engineering'} CSV
            </button>
            <button
              type="button"
              onClick={loadCosting}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              title="Refresh Food Costing Data"
            >
              <RotateCcw className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
              Refresh
            </button>
          </div>
        </div>

        {/* 4 Summary KPI Cards */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Theoretical BOM Cost</span>
              <Utensils className="w-4 h-4 text-slate-500 dark:text-slate-400" />
            </div>
            <p className="mt-2 text-xl font-bold font-mono text-slate-900 dark:text-slate-50 tabular-nums">
              {formatPHP(wasteSummary.totalTheoreticalIngredientCost)}
            </p>
            <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">Expected recipe usage based on POS sales</p>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Actual Cost (COGS + Waste)</span>
              <Package className="w-4 h-4 text-slate-500 dark:text-slate-400" />
            </div>
            <p className="mt-2 text-xl font-bold font-mono text-slate-900 dark:text-slate-50 tabular-nums">
              {formatPHP(wasteSummary.totalActualCostWithWaste)}
            </p>
            <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">POS sales deductions + kitchen prep &amp; spoilage</p>
          </div>

          <div className="rounded-xl border border-red-200 dark:border-red-800/80 bg-red-50/50 dark:bg-red-950/50 p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-red-700 dark:text-red-300">Recipe-Linked Waste Loss</span>
              <Trash className="w-4 h-4 text-red-500" />
            </div>
            <p className="mt-2 text-xl font-bold font-mono text-red-700 dark:text-red-300 tabular-nums">
              {formatPHP(wasteSummary.recipeLinkedWasteCost)}
            </p>
            <p className="mt-1 text-[11px] text-red-600 dark:text-red-300 font-medium">
              {wasteSummary.recipeLinkedWasteEvents} logged waste event(s) across recipes
            </p>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Net Cost Variance</span>
              <Flame className="w-4 h-4 text-slate-500 dark:text-slate-400" />
            </div>
            <p
              className={`mt-2 text-xl font-bold font-mono tabular-nums ${
                wasteSummary.totalNetVarianceCost > 0 ? 'text-red-700 dark:text-red-300' : 'text-emerald-700 dark:text-emerald-300'
              }`}
            >
              {wasteSummary.totalNetVarianceCost > 0 ? '+' : ''}
              {formatPHP(wasteSummary.totalNetVarianceCost)}
            </p>
            <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
              {wasteSummary.totalNetVarianceCost > 0 ? 'Loss / over-consumption vs BOM' : 'On track with standard yield'}
            </p>
          </div>
        </div>

        {/* Margin Alert Banner */}
        {marginAlerts.length > 0 && (
          <div className="rounded-xl border border-amber-200 dark:border-amber-700/80 bg-amber-50 dark:bg-amber-950/45 p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-700 dark:text-amber-300 shrink-0 mt-0.5" />
            <div className="text-xs text-amber-900 dark:text-amber-300 flex-1">
              <p className="font-semibold">
                Kitchen Waste Margin Erosion Alert ({marginAlerts.length} recipe(s) exceeding target food cost or incurring heavy waste)
              </p>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-amber-800 dark:text-amber-300">
                {marginAlerts.slice(0, 4).map((r: any) => (
                  <span key={r.id}>
                    <strong className="font-semibold text-amber-950 dark:text-amber-300">{r.name}</strong>: Actual {formatNum(r.actualFoodCostPct, 1)}% vs {r.targetFoodCostPct}% target
                    {r.linkedWasteCost > 0 && <span className="text-red-700 dark:text-red-300 font-medium"> (Waste loss: {formatPHP(r.linkedWasteCost)})</span>}
                  </span>
                ))}
                {marginAlerts.length > 4 && <span>+{marginAlerts.length - 4} more recipes</span>}
              </div>
            </div>
          </div>
        )}

        {/* Navigation Tabs and Search */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCostingTab('recipes')}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                costingTab === 'recipes' ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
              }`}
            >
              Recipe AvT &amp; Waste Impact ({recipeReports.length})
            </button>
            <button
              type="button"
              onClick={() => setCostingTab('ingredients')}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                costingTab === 'ingredients' ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
              }`}
            >
              Ingredient AvT Usage ({avtReport.length})
            </button>
            <button
              type="button"
              onClick={() => setCostingTab('waste-logs')}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                costingTab === 'waste-logs' ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
              }`}
            >
              Recent Waste &amp; Spoilage Logs ({recentWasteLogs.length})
            </button>
            <button
              type="button"
              onClick={() => setCostingTab('engineering')}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                costingTab === 'engineering' ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
              }`}
            >
              Menu Engineering Matrix ({menuEngineering.length})
            </button>
          </div>

          <div className="relative w-64">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400" />
            <input
              type="text"
              value={costingSearch}
              onChange={(e) => setCostingSearch(e.target.value)}
              placeholder="Search by recipe, ingredient, or staff..."
              className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 py-1.5 pl-9 pr-3 text-xs text-slate-900 dark:text-slate-50 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
          </div>
        </div>

        {/* Tab 1: Recipe AvT & Waste Impact */}
        {costingTab === 'recipes' && (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Recipe AvT &amp; Kitchen Waste Attribution</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Compares Theoretical BOM cost against Actual POS COGS + Recipe-Linked Waste &amp; Spoilage loss
                </p>
              </div>
              <span className="text-xs text-slate-500 dark:text-slate-400">{filteredRecipes.length} item(s)</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
                  <tr>
                    <th className="p-3 font-medium">Recipe / Item</th>
                    <th className="p-3 font-medium text-right">Units Sold</th>
                    <th className="p-3 font-medium text-right">Theoretical BOM Cost</th>
                    <th className="p-3 font-medium text-right">Actual Sales COGS</th>
                    <th className="p-3 font-medium text-right">Linked Waste Loss</th>
                    <th className="p-3 font-medium text-right">Total Actual Cost</th>
                    <th className="p-3 font-medium text-right">Variance</th>
                    <th className="p-3 font-medium text-right">Food Cost % (Theo vs Act)</th>
                    <th className="p-3 font-medium text-center">Breakdown</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {filteredRecipes.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="p-8 text-center text-slate-500 dark:text-slate-400">
                        No recipe usage data found matching search criteria
                      </td>
                    </tr>
                  ) : (
                    filteredRecipes.map((r: any) => {
                      const isExpanded = expandedRecipeId === r.id;
                      const hasWaste = r.linkedWasteCost > 0;
                      const exceedsTarget = r.actualFoodCostPct > r.targetFoodCostPct;

                      return (
                        <React.Fragment key={r.id}>
                          <tr className={`hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors ${hasWaste ? 'bg-amber-50/20 dark:bg-amber-950/45' : ''}`}>
                            <td className="p-3">
                              <div className="font-semibold text-slate-900 dark:text-slate-50">{r.name}</div>
                              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                                {r.categoryName || 'General'} · SKU: {r.sku || 'N/A'}
                              </div>
                            </td>
                            <td className="p-3 text-right font-mono tabular-nums text-slate-700 dark:text-slate-200">{r.unitsSold}</td>
                            <td className="p-3 text-right font-mono tabular-nums text-slate-800 dark:text-slate-100">
                              {formatPHP(r.theoreticalIngredientCost)}
                            </td>
                            <td className="p-3 text-right font-mono tabular-nums text-slate-800 dark:text-slate-100">
                              {formatPHP(r.actualSaleCogs)}
                            </td>
                            <td className="p-3 text-right font-mono tabular-nums">
                              {r.linkedWasteCost > 0 ? (
                                <div>
                                  <span className="font-semibold text-red-700 dark:text-red-300">{formatPHP(r.linkedWasteCost)}</span>
                                  <div className="text-[10px] text-red-600 dark:text-red-300 font-sans">
                                    {r.linkedWasteEvents} log(s) · {formatNum(r.linkedWasteServings, 1)} svgs
                                  </div>
                                </div>
                              ) : (
                                <span className="text-slate-500 dark:text-slate-400">₱0.00</span>
                              )}
                            </td>
                            <td className="p-3 text-right font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-50">
                              {formatPHP(r.totalActualCost)}
                            </td>
                            <td className="p-3 text-right font-mono tabular-nums">
                              <div
                                className={`font-semibold ${
                                  r.varianceCost > 0 ? 'text-red-700 dark:text-red-300' : r.varianceCost < 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-600 dark:text-slate-300'
                                }`}
                              >
                                {r.varianceCost > 0 ? '+' : ''}
                                {formatPHP(r.varianceCost)}
                              </div>
                              <div className="text-[10px] text-slate-500 dark:text-slate-400 font-sans">
                                {r.varianceCost > 0 ? '+' : ''}
                                {formatNum(r.variancePct, 1)}%
                              </div>
                            </td>
                            <td className="p-3 text-right font-mono tabular-nums">
                              <div className="flex items-center justify-end gap-1">
                                <span className="text-slate-600 dark:text-slate-300">{formatNum(r.theoreticalFoodCostPct, 1)}%</span>
                                <span className="text-slate-500 dark:text-slate-400">→</span>
                                <span
                                  className={`font-semibold ${
                                    exceedsTarget ? 'text-red-700 dark:text-red-300 font-bold' : 'text-slate-900 dark:text-slate-50'
                                  }`}
                                >
                                  {formatNum(r.actualFoodCostPct, 1)}%
                                </span>
                              </div>
                              <div className="text-[10px] text-slate-500 dark:text-slate-400 font-sans">
                                Target: {r.targetFoodCostPct}%
                              </div>
                            </td>
                            <td className="p-3 text-center">
                              {r.wasteIngredients && r.wasteIngredients.length > 0 ? (
                                <button
                                  type="button"
                                  onClick={() => setExpandedRecipeId(isExpanded ? null : r.id)}
                                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-amber-800 dark:text-amber-300 bg-amber-100 dark:bg-amber-950/75 hover:bg-amber-200 transition-colors"
                                  title="View ingredient waste breakdown"
                                >
                                  {r.wasteIngredients.length} item(s)
                                  {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                                </button>
                              ) : (
                                <span className="text-[11px] text-slate-500 dark:text-slate-400">No waste</span>
                              )}
                            </td>
                          </tr>

                          {/* Expandable row: Ingredient waste breakdown */}
                          {isExpanded && r.wasteIngredients && (
                            <tr className="bg-amber-50/50 dark:bg-amber-950/45">
                              <td colSpan={9} className="p-3 pl-8">
                                <div className="rounded-lg border border-amber-200 dark:border-amber-700/80 bg-white dark:bg-slate-900 p-3 space-y-2">
                                  <div className="flex items-center justify-between text-xs font-semibold text-amber-900 dark:text-amber-300">
                                    <span>Kitchen Waste Breakdown for {r.name}:</span>
                                    <span>Total Attributed Loss: {formatPHP(r.linkedWasteCost)}</span>
                                  </div>
                                  <table className="w-full text-xs">
                                    <thead>
                                      <tr className="border-b border-amber-100 text-left text-[11px] text-amber-800 dark:text-amber-300">
                                        <th className="py-1">Raw Ingredient</th>
                                        <th className="py-1 text-right">Quantity Wasted</th>
                                        <th className="py-1 text-right">UOM</th>
                                        <th className="py-1 text-right">Loss Cost</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-amber-50">
                                      {r.wasteIngredients.map((wi: any, idx: number) => (
                                        <tr key={idx}>
                                          <td className="py-1 text-slate-800 dark:text-slate-100 font-medium">{wi.name}</td>
                                          <td className="py-1 text-right font-mono tabular-nums text-slate-700 dark:text-slate-200">{formatNum(wi.qty, 2)}</td>
                                          <td className="py-1 text-right text-slate-500 dark:text-slate-400">{wi.uom}</td>
                                          <td className="py-1 text-right font-mono tabular-nums font-semibold text-red-700 dark:text-red-300">
                                            {formatPHP(wi.cost)}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Tab 2: Ingredient AvT Usage */}
        {costingTab === 'ingredients' && (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Actual vs. Theoretical (AvT) Ingredient Consumption &amp; Loss</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Delineates standard sales deductions from recorded prep-waste, spoilage, and physical adjustments
                </p>
              </div>
              <span className="text-xs text-slate-500 dark:text-slate-400">{filteredIngredients.length} ingredient(s)</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
                  <tr>
                    <th className="p-3 font-medium">Ingredient</th>
                    <th className="p-3 font-medium text-right">Theoretical BOM Qty</th>
                    <th className="p-3 font-medium text-right">Actual Deducted Qty</th>
                    <th className="p-3 font-medium text-right">Sales Deduction</th>
                    <th className="p-3 font-medium text-right">Prep Waste</th>
                    <th className="p-3 font-medium text-right">Spoilage</th>
                    <th className="p-3 font-medium text-right">Variance Qty</th>
                    <th className="p-3 font-medium text-right">Recorded Waste Cost</th>
                    <th className="p-3 font-medium text-right">Variance Cost</th>
                    <th className="p-3 font-medium">Linked Recipes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {filteredIngredients.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="p-8 text-center text-slate-500 dark:text-slate-400">
                        No ingredient consumption data found matching search criteria
                      </td>
                    </tr>
                  ) : (
                    filteredIngredients.map((r: any) => (
                      <tr key={r.id} className="hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                        <td className="p-3">
                          <div className="font-semibold text-slate-900 dark:text-slate-50">{r.name}</div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400">{r.uom}</div>
                        </td>
                        <td className="p-3 text-right font-mono tabular-nums text-slate-700 dark:text-slate-200">
                          {formatNum(r.theoreticalQty, 2)} {r.uom}
                        </td>
                        <td className="p-3 text-right font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-50">
                          {formatNum(r.actualQty, 2)} {r.uom}
                        </td>
                        <td className="p-3 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                          {formatNum(r.saleOutQty, 2)}
                        </td>
                        <td className="p-3 text-right font-mono tabular-nums text-amber-700 dark:text-amber-300 font-medium">
                          {r.wasteQty > 0 ? formatNum(r.wasteQty, 2) : '-'}
                        </td>
                        <td className="p-3 text-right font-mono tabular-nums text-red-700 dark:text-red-300 font-medium">
                          {r.spoilageQty > 0 ? formatNum(r.spoilageQty, 2) : '-'}
                        </td>
                        <td className="p-3 text-right font-mono tabular-nums">
                          <span
                            className={`font-semibold ${
                              r.varianceQty > 0 ? 'text-red-700 dark:text-red-300' : r.varianceQty < 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-600 dark:text-slate-300'
                            }`}
                          >
                            {r.varianceQty > 0 ? '+' : ''}
                            {formatNum(r.varianceQty, 2)} {r.uom}
                          </span>
                          <div className="text-[10px] text-slate-500 dark:text-slate-400 font-sans">
                            {r.varianceQty > 0 ? '+' : ''}
                            {formatNum(r.variancePct, 1)}%
                          </div>
                        </td>
                        <td className="p-3 text-right font-mono tabular-nums text-amber-700 dark:text-amber-300 font-semibold">
                          {r.wasteCost > 0 ? formatPHP(r.wasteCost) : <span className="text-slate-500 dark:text-slate-400">₱0.00</span>}
                        </td>
                        <td className="p-3 text-right font-mono tabular-nums font-semibold">
                          <span className={r.varianceCost > 0 ? 'text-red-700 dark:text-red-300' : 'text-emerald-700 dark:text-emerald-300'}>
                            {r.varianceCost > 0 ? '+' : ''}
                            {formatPHP(r.varianceCost)}
                          </span>
                        </td>
                        <td className="p-3">
                          {r.linkedRecipes && r.linkedRecipes.length > 0 ? (
                            <div className="text-[11px] text-slate-700 dark:text-slate-200 max-w-[200px] truncate" title={r.linkedRecipes.join(', ')}>
                              {r.linkedRecipes.join(', ')}
                            </div>
                          ) : (
                            <span className="text-slate-500 dark:text-slate-400 text-[11px]">Unlinked</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Tab 3: Recent Waste & Spoilage Logs */}
        {costingTab === 'waste-logs' && (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Recent Kitchen Spoilage &amp; Prep Waste Logs</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Direct ledger from the Inventory Waste Management interface with recipe and cost attribution
                </p>
              </div>
              <span className="text-xs text-slate-500 dark:text-slate-400">{filteredWasteLogs.length} record(s)</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
                  <tr>
                    <th className="p-3 font-medium">Logged Date</th>
                    <th className="p-3 font-medium">Location</th>
                    <th className="p-3 font-medium">Type</th>
                    <th className="p-3 font-medium">Cause Category</th>
                    <th className="p-3 font-medium">Recipe / Ingredient</th>
                    <th className="p-3 font-medium text-right">Servings / Quantity</th>
                    <th className="p-3 font-medium text-right">Loss Cost</th>
                    <th className="p-3 font-medium">Logged By</th>
                    <th className="p-3 font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {filteredWasteLogs.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="p-8 text-center text-slate-500 dark:text-slate-400">
                        No kitchen waste logs recorded yet. Use Inventory &gt; Waste Management to log prep-waste or spoilage.
                      </td>
                    </tr>
                  ) : (
                    filteredWasteLogs.map((w: any) => (
                      <tr key={w.id} className="hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                        <td className="p-3 text-slate-600 dark:text-slate-300 font-mono text-[11px] whitespace-nowrap">
                          {w.wastedAt ? new Date(w.wastedAt).toLocaleString('en-PH', { dateStyle: 'short', timeStyle: 'short' }) : '-'}
                        </td>
                        <td className="p-3 text-slate-700 dark:text-slate-200 font-medium">{w.locationName}</td>
                        <td className="p-3">
                          <span
                            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                              w.txnType === 'OUT_SPOILAGE' ? 'bg-red-100 dark:bg-red-950/80 text-red-800 dark:text-red-300' : 'bg-amber-100 dark:bg-amber-950/75 text-amber-800 dark:text-amber-300'
                            }`}
                          >
                            {w.txnType === 'OUT_SPOILAGE' ? 'Spoilage' : 'Prep Waste'}
                          </span>
                        </td>
                        <td className="p-3 text-slate-800 dark:text-slate-100 font-medium">{getWasteReasonLabel(w.reasonCategory)}</td>
                        <td className="p-3 font-semibold text-slate-900 dark:text-slate-50">
                          {w.productName ? (
                            <div>
                              <span>{w.productName}</span>
                              <span className="block text-[10px] text-amber-700 dark:text-amber-300 font-normal">Recipe Prep Waste</span>
                            </div>
                          ) : (
                            w.primaryItemName || 'Raw Ingredient'
                          )}
                        </td>
                        <td className="p-3 text-right font-mono tabular-nums text-slate-800 dark:text-slate-100">
                          {w.servingsWasted > 0 ? `${formatNum(w.servingsWasted, 1)} svgs` : '-'}
                        </td>
                        <td className="p-3 text-right font-mono tabular-nums font-semibold text-red-700 dark:text-red-300">
                          {formatPHP(w.totalLossCost)}
                        </td>
                        <td className="p-3 text-slate-600 dark:text-slate-300">{w.loggedByName}</td>
                        <td className="p-3 text-slate-500 dark:text-slate-400 italic max-w-xs truncate" title={w.reasonNotes}>
                          {w.reasonNotes || '-'}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Tab 4: Menu Engineering Matrix */}
        {costingTab === 'engineering' && (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Menu Engineering Matrix (Popularity vs. Contribution Margin)</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Categorizes menu items into Stars (High Pop, High Margin), Plowhorses (High Pop, Low Margin), Puzzles (Low Pop, High Margin), and Dogs
                </p>
              </div>
              <span className="text-xs text-slate-500 dark:text-slate-400">{filteredMenuEng.length} item(s)</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
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
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {filteredMenuEng.map((m: any) => (
                    <tr key={m.id} className="hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                      <td className="p-3 font-semibold text-slate-900 dark:text-slate-50">{m.name}</td>
                      <td className="p-3 text-right font-mono tabular-nums">{formatPHP(m.sellingPrice)}</td>
                      <td className="p-3 text-right font-mono tabular-nums">{formatPHP(m.theoreticalCost)}</td>
                      <td className={`p-3 text-right font-mono tabular-nums font-semibold ${m.isMarginAlert ? 'text-amber-700 dark:text-amber-300' : 'text-slate-800 dark:text-slate-100'}`}>
                        {formatNum(m.foodCostPct, 1)}%
                      </td>
                      <td className="p-3 text-right font-mono tabular-nums text-emerald-700 dark:text-emerald-300 font-semibold">{formatPHP(m.grossProfitPerUnit)}</td>
                      <td className="p-3 text-right font-mono tabular-nums">{m.unitsSold}</td>
                      <td className="p-3 text-right font-mono tabular-nums font-semibold">{formatPHP(m.totalContribution)}</td>
                      <td className="p-3">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold ${
                            m.quadrant === 'Star'
                              ? 'bg-emerald-100 dark:bg-emerald-950/75 text-emerald-800 dark:text-emerald-300'
                              : m.quadrant === 'Plowhorse'
                              ? 'bg-blue-100 dark:bg-blue-950/75 text-blue-800 dark:text-blue-300'
                              : m.quadrant === 'Puzzle'
                              ? 'bg-purple-100 text-purple-800'
                              : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200'
                          }`}
                        >
                          {m.quadrant}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ==========================================
  // FINANCIAL MANAGEMENT & ACCOUNTING VIEW
  // ==========================================
  if (err && !finData) return <div className="p-4 rounded-lg border border-red-200 dark:border-red-800/80 bg-red-50 dark:bg-red-950/50 text-xs text-red-700 dark:text-red-300 font-medium">{err}</div>;
  if (!finData) return <div className="h-64 rounded-xl border bg-white dark:bg-slate-900 animate-pulse" />;

  const { expenses, closings, journals, accounts, pettyCash, statements, expenseCategories = [] } = finData;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 dark:text-slate-50">Finance, Accounting &amp; Daily Closing</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">Expenses, petty cash, Workflow C cash reconciliation, double-entry ledger, and configurable PH tax</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleOpenCategoryManager}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0 transition-colors"
            title="Manage Expense Categories"
          >
            <Tag className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" /> Expense Categories
          </button>
          <button
            type="button"
            onClick={handleOpenAccountManager}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
            title="Manage GL Expense Accounts"
          >
            <BookOpen className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" /> GL Accounts
          </button>
          <button
            type="button"
            onClick={handleOpenAddExpense}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-4 py-2 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white whitespace-nowrap shrink-0 transition-colors"
          >
            <Plus className="w-4 h-4" /> Record Operating Expense
          </button>
        </div>
      </div>

      {msg && <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/45 border border-emerald-200 dark:border-emerald-700/80 text-xs text-emerald-800 dark:text-emerald-300 font-medium">{msg}</div>}
      {err && !showExpModal && !showCategoryModal && !showAccountModal && (
        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">{err}</div>
      )}

      <FinanceWeeklyCostChart locations={locations} activeLocationId={activeLocationId} />

      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-800 w-fit">
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
              finTab === t.id ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-50 shadow-sm' : 'text-slate-600 dark:text-slate-300'
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
              <div key={pc.id} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex items-center justify-between">
                <div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{pc.location_name}</p>
                  <p className="font-display font-semibold text-sm text-slate-900 dark:text-slate-50">{pc.fund_name}</p>
                </div>
                <div className="text-right">
                  <p className="font-mono tabular-nums text-lg font-bold text-slate-900 dark:text-slate-50">{formatPHP(pc.current_balance)}</p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">Float: {formatPHP(pc.float_amount)}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
            <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-50">Operating Expenses Register</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">Add, edit, or delete operating costs and petty cash disbursements</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleOpenAddExpense}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:text-slate-950 dark:hover:text-white px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <Plus className="w-3.5 h-3.5" /> Add Expense
                </button>
              </div>
            </div>
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
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
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {expenses.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-6 text-center text-slate-500 dark:text-slate-400">
                      No operating expenses found for the selected truck / location.
                    </td>
                  </tr>
                ) : expenses.map((ex: any) => (
                  <tr key={ex.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/70 transition-colors">
                    <td className="p-3 font-mono text-slate-500 dark:text-slate-400 whitespace-nowrap">{String(ex.expense_date).slice(0, 10)}</td>
                    <td className="p-3 font-medium text-slate-800 dark:text-slate-100">{ex.location_name}</td>
                    <td className="p-3">
                      <div className="inline-flex items-center gap-1.5">
                        <span className="font-semibold text-slate-800 dark:text-slate-100">{ex.category}</span>
                        {ex.paid_from_petty_cash ? (
                          <span className="text-[10px] font-medium text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/45 border border-amber-200 dark:border-amber-700/80 px-1.5 py-0.5 rounded">
                            Petty Cash
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="p-3 text-slate-600 dark:text-slate-300 font-mono text-[11px]">{ex.account_name || ex.account_id}</td>
                    <td className="p-3 text-slate-700 dark:text-slate-200 max-w-xs truncate">{ex.description}</td>
                    <td className="p-3 text-right font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-50">{formatPHP(ex.amount)}</td>
                    <td className="p-3 text-right">
                      <div className="inline-flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => handleStartEditExpense(ex)}
                          title="Edit Operating Expense"
                          className="p-1.5 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeletingExpense(ex)}
                          title="Delete Operating Expense"
                          className="p-1.5 text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/70 rounded-md transition-colors"
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
          <form onSubmit={submitClosing} className="lg:col-span-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50 flex items-center gap-2">
              <Lock className="w-4 h-4 text-slate-700 dark:text-slate-200" /> Close Business Day (Cash Reconciliation)
            </h2>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Food Truck / Location</label>
              <select value={closingForm.locationId} onChange={(e) => setClosingForm({ ...closingForm, locationId: e.target.value })} className="w-full rounded border px-3 py-2 text-xs">
                {locations.filter((l) => l.type === 'FOOD_TRUCK').map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Business Date</label>
                <input type="date" value={closingForm.businessDate} onChange={(e) => setClosingForm({ ...closingForm, businessDate: e.target.value })} className="w-full rounded border px-3 py-2 text-xs font-mono" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Opening Drawer Float</label>
                <input type="number" required value={closingForm.openingFloat} onChange={(e) => setClosingForm({ ...closingForm, openingFloat: e.target.value })} className="w-full rounded border px-3 py-2 text-xs font-mono" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Actual Counted Cash in Drawer (PHP)</label>
              <input type="number" required placeholder="e.g. 5450" value={closingForm.actualCash} onChange={(e) => setClosingForm({ ...closingForm, actualCash: e.target.value })} className="w-full rounded border px-3 py-2 text-xs font-mono" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Closing Remarks / Notes</label>
              <input type="text" placeholder="Closing remarks" value={closingForm.notes} onChange={(e) => setClosingForm({ ...closingForm, notes: e.target.value })} className="w-full rounded border px-3 py-2 text-xs" />
            </div>
            <button type="submit" className="w-full rounded-lg bg-slate-900 dark:bg-slate-100 py-2.5 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white">
              Reconcile &amp; Close Business Day
            </button>
          </form>

          <div className="lg:col-span-7 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
            <div className="p-4 border-b border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-700 dark:text-slate-200">Daily Closing History</div>
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-100 dark:border-slate-800/80 text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="p-3 font-medium">Date</th>
                  <th className="p-3 font-medium">Truck</th>
                  <th className="p-3 font-medium text-right">Expected Cash</th>
                  <th className="p-3 font-medium text-right">Actual Cash</th>
                  <th className="p-3 font-medium text-right">Variance</th>
                  <th className="p-3 font-medium text-right">Gross Profit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {closings.length === 0 ? (
                  <tr><td colSpan={6} className="p-6 text-center text-slate-500 dark:text-slate-400">No days closed yet. Submit form on left to close today.</td></tr>
                ) : closings.map((c: any) => (
                  <tr key={c.id}>
                    <td className="p-3 font-mono">{c.business_date}</td>
                    <td className="p-3">{c.location_name}</td>
                    <td className="p-3 text-right font-mono tabular-nums">{formatPHP(c.expected_cash)}</td>
                    <td className="p-3 text-right font-mono tabular-nums">{formatPHP(c.actual_cash)}</td>
                    <td className={`p-3 text-right font-mono tabular-nums font-semibold ${c.variance !== 0 ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'}`}>
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
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">Profit &amp; Loss Statement (Income Statement)</h2>
            <div className="space-y-1.5 text-xs">
              <p className="font-semibold text-slate-600 dark:text-slate-300">Revenue</p>
              {statements.profitAndLoss.revenues.map((r: any) => (
                <div key={r.id} className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-800/80">
                  <span>{r.code} · {r.name}</span>
                  <span className="font-mono tabular-nums">{formatPHP(r.balance)}</span>
                </div>
              ))}
              <p className="font-semibold text-slate-600 dark:text-slate-300 pt-3">Cost of Goods Sold &amp; Operating Expenses</p>
              {statements.profitAndLoss.expenses.map((e: any) => (
                <div key={e.id} className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-800/80">
                  <span>{e.code} · {e.name}</span>
                  <span className="font-mono tabular-nums">{formatPHP(e.balance)}</span>
                </div>
              ))}
              <div className="flex justify-between pt-3 text-sm font-bold text-slate-900 dark:text-slate-50">
                <span>Net Income</span>
                <span className={`font-mono tabular-nums ${statements.profitAndLoss.netIncome >= 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'}`}>
                  {formatPHP(statements.profitAndLoss.netIncome)}
                </span>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">Balance Sheet</h2>
            <div className="space-y-1.5 text-xs">
              <p className="font-semibold text-slate-600 dark:text-slate-300">Assets</p>
              {statements.balanceSheet.assets.map((a: any) => (
                <div key={a.id} className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-800/80">
                  <span>{a.code} · {a.name}</span>
                  <span className="font-mono tabular-nums">{formatPHP(a.balance)}</span>
                </div>
              ))}
              <p className="font-semibold text-slate-600 dark:text-slate-300 pt-3">Liabilities</p>
              {statements.balanceSheet.liabilities.map((l: any) => (
                <div key={l.id} className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-800/80">
                  <span>{l.code} · {l.name}</span>
                  <span className="font-mono tabular-nums">{formatPHP(l.balance)}</span>
                </div>
              ))}
              <div className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-800/80">
                <span>Current Period Retained Earnings</span>
                <span className="font-mono tabular-nums">{formatPHP(statements.balanceSheet.retainedEarningsCurrent)}</span>
              </div>
              <div className="flex justify-between pt-3 text-sm font-bold text-slate-900 dark:text-slate-50">
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
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
              <tr>
                <th className="p-3 font-medium">Entry #</th>
                <th className="p-3 font-medium">Date</th>
                <th className="p-3 font-medium">Description</th>
                <th className="p-3 font-medium">Double-Entry Lines (DR / CR)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {journals.length === 0 ? (
                <tr>
                  <td colSpan={4} className="p-6 text-center text-slate-500 dark:text-slate-400">
                    No journal entries match the selected truck / location.
                  </td>
                </tr>
              ) : journals.map((je: any) => (
                <tr key={je.id} className={je.is_reversed ? 'opacity-50' : ''}>
                  <td className="p-3 font-mono font-semibold text-slate-900 dark:text-slate-50">{je.entry_number}</td>
                  <td className="p-3 font-mono text-slate-500 dark:text-slate-400">{String(je.entry_date).slice(0, 10)}</td>
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
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-5">
          <div>
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">Configurable Philippine Tax &amp; BIR Summary</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">Tax rates are never hardcoded; update configurations as required by your accountant.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70">
              <p className="text-xs text-slate-500 dark:text-slate-400">Net VATable Sales (Period)</p>
              <p className="font-mono tabular-nums text-xl font-bold text-slate-900 dark:text-slate-50 mt-1">{formatPHP(statements.taxSummary.vatableSales)}</p>
            </div>
            <div className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70">
              <p className="text-xs text-slate-500 dark:text-slate-400">Output Tax Payable (BIR Form 2550M/Q)</p>
              <p className="font-mono tabular-nums text-xl font-bold text-slate-900 dark:text-slate-50 mt-1">{formatPHP(statements.taxSummary.outputTax)}</p>
            </div>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg">
            {statements.taxSummary.taxConfigs.map((tc: any) => (
              <div key={tc.id} className="p-3.5 flex items-center justify-between text-xs">
                <div>
                  <p className="font-semibold text-slate-900 dark:text-slate-50">{tc.name}</p>
                  <p className="text-slate-500 dark:text-slate-400 font-mono">{tc.code} · {tc.rate_percent}% · {tc.is_inclusive ? 'Tax Inclusive' : 'Tax Exclusive'}</p>
                </div>
                <button
                  onClick={() => toggleTaxActive(tc)}
                  className={`px-3 py-1.5 rounded-md font-semibold ${tc.is_active ? 'bg-emerald-600 text-white' : 'border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200'}`}
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
          <form onSubmit={submitExpense} className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 p-5 space-y-3.5 border border-slate-200 dark:border-slate-800 shadow-xl">
            <div className="flex items-center justify-between pb-1 border-b border-slate-100 dark:border-slate-800/80">
              <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">
                {editingExpenseId ? 'Edit Operating Expense' : 'Record Operating Expense'}
              </h3>
              <button
                type="button"
                onClick={() => { setErr(''); setShowExpModal(false); setEditingExpenseId(null); }}
                className="p-1 rounded text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {err && <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">{err}</div>}

            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Branch / Location *</label>
              <select
                value={expForm.locationId}
                onChange={(e) => setExpForm({ ...expForm, locationId: e.target.value })}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs bg-white dark:bg-slate-900"
              >
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.name} ({l.type})</option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">Expense Category *</label>
                  <button
                    type="button"
                    onClick={() => { setShowCategoryModal(true); }}
                    className="text-[11px] text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white font-medium underline"
                  >
                    Manage
                  </button>
                </div>
                <select
                  value={expForm.category}
                  onChange={(e) => setExpForm({ ...expForm, category: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs bg-white dark:bg-slate-900 font-medium"
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
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">GL Account *</label>
                  <button
                    type="button"
                    onClick={() => { setShowAccountModal(true); }}
                    className="text-[11px] text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white font-medium underline"
                  >
                    Manage
                  </button>
                </div>
                <select
                  value={expForm.accountId}
                  onChange={(e) => setExpForm({ ...expForm, accountId: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs bg-white dark:bg-slate-900 font-mono"
                >
                  {accounts.filter((a: any) => a.type === 'EXPENSE').map((a: any) => (
                    <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Expense Date *</label>
                <input
                  type="date"
                  required
                  value={expForm.expenseDate}
                  onChange={(e) => setExpForm({ ...expForm, expenseDate: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono bg-white dark:bg-slate-900"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Amount (PHP) *</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  placeholder="e.g. 1850.00"
                  value={expForm.amount}
                  onChange={(e) => setExpForm({ ...expForm, amount: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono bg-white dark:bg-slate-900"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Description / Memo *</label>
              <input
                type="text"
                required
                placeholder="e.g. 2x 11kg Solane LPG Tank refill for evening shift"
                value={expForm.description}
                onChange={(e) => setExpForm({ ...expForm, description: e.target.value })}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs bg-white dark:bg-slate-900"
              />
            </div>

            <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-200 cursor-pointer pt-1">
              <input
                type="checkbox"
                checked={expForm.paidFromPettyCash}
                onChange={(e) => setExpForm({ ...expForm, paidFromPettyCash: e.target.checked })}
                className="rounded border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-50 focus:ring-slate-900 dark:focus:ring-slate-200"
              />
              <span>Deduct from Truck Petty Cash Float (reduces on-hand drawer cash)</span>
            </label>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-100 dark:border-slate-800/80">
              <button
                type="button"
                onClick={() => { setErr(''); setShowExpModal(false); setEditingExpenseId(null); }}
                className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmittingExp}
                className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 text-xs font-semibold hover:bg-slate-800 dark:hover:bg-white disabled:opacity-60 transition-colors"
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
          <div className="w-full max-w-sm rounded-xl bg-white dark:bg-slate-900 p-5 space-y-3.5 border border-slate-200 dark:border-slate-800 shadow-xl">
            <div className="flex items-center gap-2 text-red-600 dark:text-red-300">
              <AlertTriangle className="w-5 h-5" />
              <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">Delete Operating Expense</h3>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-300">
              Are you sure you want to delete this expense of{' '}
              <strong className="text-slate-900 dark:text-slate-50 font-mono">{formatPHP(deletingExpense.amount)}</strong> recorded for{' '}
              <span className="font-medium">{deletingExpense.location_name}</span> ({deletingExpense.category})?
            </p>
            {deletingExpense.paid_from_petty_cash ? (
              <p className="text-xs text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/45 p-2.5 rounded-lg border border-amber-200 dark:border-amber-700/80">
                This expense was paid from petty cash. Deleting it will restore{' '}
                <strong className="font-mono">{formatPHP(deletingExpense.amount)}</strong> back to the truck's petty cash float and remove the linked journal entry.
              </p>
            ) : (
              <p className="text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/70 p-2.5 rounded-lg border border-slate-200 dark:border-slate-800">
                The linked general ledger journal entry will also be deleted to maintain double-entry balancing.
              </p>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDeletingExpense(null)}
                className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
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
          <div className="w-full max-w-2xl rounded-xl bg-white dark:bg-slate-900 p-5 space-y-4 border border-slate-200 dark:border-slate-800 shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-2 border-b border-slate-200 dark:border-slate-800">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50 flex items-center gap-2">
                  <Tag className="w-4 h-4 text-slate-700 dark:text-slate-200" /> Manage Expense Categories
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">Configure operating expense groupings used across food trucks</p>
              </div>
              <button
                type="button"
                onClick={() => setShowCategoryModal(false)}
                className="p-1 rounded text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {catErr && <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">{catErr}</div>}
            {catMsg && <div className="p-2.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/45 border border-emerald-200 dark:border-emerald-700/80 text-xs text-emerald-800 dark:text-emerald-300 font-medium">{catMsg}</div>}

            {/* Category Form */}
            <form onSubmit={handleSubmitCategory} className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                  {editingCatId ? 'Edit Category' : 'Add New Category'}
                </span>
                {editingCatId && (
                  <button
                    type="button"
                    onClick={handleCancelEditCategory}
                    className="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100 flex items-center gap-1"
                  >
                    <RotateCcw className="w-3 h-3" /> Cancel Edit
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Code (Unique) *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. ICE_SUPPLY"
                    value={catForm.code}
                    onChange={(e) => setCatForm({ ...catForm, code: e.target.value.toUpperCase().replace(/\s+/g, '_') })}
                    className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-mono"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Category Name *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Ice & Cooling Consumables"
                    value={catForm.name}
                    onChange={(e) => setCatForm({ ...catForm, name: e.target.value })}
                    className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
                <div className="sm:col-span-3">
                  <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Description</label>
                  <input
                    type="text"
                    placeholder="Short description or usage guidance"
                    value={catForm.description}
                    onChange={(e) => setCatForm({ ...catForm, description: e.target.value })}
                    className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Sort Order</label>
                  <input
                    type="number"
                    value={catForm.sortOrder}
                    onChange={(e) => setCatForm({ ...catForm, sortOrder: e.target.value })}
                    className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-mono"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between pt-1">
                <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={catForm.isActive}
                    onChange={(e) => setCatForm({ ...catForm, isActive: e.target.checked })}
                    className="rounded border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-50"
                  />
                  <span>Active in Expense Dropdown</span>
                </label>
                <button
                  type="submit"
                  disabled={isSubmittingCat}
                  className="px-3.5 py-1.5 rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 text-xs font-semibold hover:bg-slate-800 dark:hover:bg-white disabled:opacity-60 transition-colors"
                >
                  {isSubmittingCat ? 'Saving...' : editingCatId ? 'Save Category' : '+ Add Category'}
                </button>
              </div>
            </form>

            {/* Categories Table */}
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
                  <tr>
                    <th className="p-2.5 font-medium">Code</th>
                    <th className="p-2.5 font-medium">Name</th>
                    <th className="p-2.5 font-medium">Description</th>
                    <th className="p-2.5 font-medium text-center">Status</th>
                    <th className="p-2.5 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {(expenseCategories || []).map((cat: any) => (
                    <tr key={cat.id || cat.code} className="hover:bg-slate-50 dark:hover:bg-slate-800">
                      <td className="p-2.5 font-mono font-semibold text-slate-800 dark:text-slate-100">{cat.code}</td>
                      <td className="p-2.5 font-medium text-slate-900 dark:text-slate-50">{cat.name}</td>
                      <td className="p-2.5 text-slate-500 dark:text-slate-400 truncate max-w-[200px]">{cat.description || '—'}</td>
                      <td className="p-2.5 text-center">
                        <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold ${
                          cat.is_active !== 0 ? 'bg-emerald-50 dark:bg-emerald-950/45 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-700/80' : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'
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
                            className="p-1 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 rounded"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteCategory(cat)}
                            title="Delete Category"
                            className="p-1 text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/70 rounded"
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
                className="px-4 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-semibold hover:bg-slate-200 dark:hover:bg-slate-700"
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
          <div className="w-full max-w-2xl rounded-xl bg-white dark:bg-slate-900 p-5 space-y-4 border border-slate-200 dark:border-slate-800 shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-2 border-b border-slate-200 dark:border-slate-800">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50 flex items-center gap-2">
                  <BookOpen className="w-4 h-4 text-slate-700 dark:text-slate-200" /> Manage GL Expense Accounts
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">Configure General Ledger expense accounts for chart-of-accounts compliance</p>
              </div>
              <button
                type="button"
                onClick={() => setShowAccountModal(false)}
                className="p-1 rounded text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {accErr && <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">{accErr}</div>}
            {accMsg && <div className="p-2.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/45 border border-emerald-200 dark:border-emerald-700/80 text-xs text-emerald-800 dark:text-emerald-300 font-medium">{accMsg}</div>}

            {/* Account Form */}
            <form onSubmit={handleSubmitAccount} className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                  {editingAccId ? 'Edit GL Account' : 'Add Custom GL Expense Account'}
                </span>
                {editingAccId && (
                  <button
                    type="button"
                    onClick={handleCancelEditAccount}
                    className="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100 flex items-center gap-1"
                  >
                    <RotateCcw className="w-3 h-3" /> Cancel Edit
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Account Code *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. 6500"
                    value={accForm.code}
                    onChange={(e) => setAccForm({ ...accForm, code: e.target.value })}
                    className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-mono"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Account Name *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Staff Meals &amp; Refreshments"
                    value={accForm.name}
                    onChange={(e) => setAccForm({ ...accForm, name: e.target.value })}
                    className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs"
                  />
                </div>
              </div>
              <div className="flex justify-end pt-1">
                <button
                  type="submit"
                  disabled={isSubmittingAcc}
                  className="px-3.5 py-1.5 rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 text-xs font-semibold hover:bg-slate-800 dark:hover:bg-white disabled:opacity-60 transition-colors"
                >
                  {isSubmittingAcc ? 'Saving...' : editingAccId ? 'Save Account' : '+ Add Expense Account'}
                </button>
              </div>
            </form>

            {/* Accounts Table */}
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
                  <tr>
                    <th className="p-2.5 font-medium">Code</th>
                    <th className="p-2.5 font-medium">Account Name</th>
                    <th className="p-2.5 font-medium">Classification</th>
                    <th className="p-2.5 font-medium">Type</th>
                    <th className="p-2.5 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {accounts.filter((a: any) => a.type === 'EXPENSE').map((acc: any) => (
                    <tr key={acc.id} className="hover:bg-slate-50 dark:hover:bg-slate-800">
                      <td className="p-2.5 font-mono font-semibold text-slate-800 dark:text-slate-100">{acc.code}</td>
                      <td className="p-2.5 font-medium text-slate-900 dark:text-slate-50">{acc.name}</td>
                      <td className="p-2.5 text-slate-500 dark:text-slate-400">
                        {acc.is_system ? (
                          <span className="text-[10px] bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 px-2 py-0.5 rounded font-mono">System</span>
                        ) : (
                          <span className="text-[10px] bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-700/80 px-2 py-0.5 rounded font-medium">Custom</span>
                        )}
                      </td>
                      <td className="p-2.5 text-slate-500 dark:text-slate-400 font-mono text-[11px]">{acc.type}</td>
                      <td className="p-2.5 text-right">
                        {acc.is_system ? (
                          <span className="text-[11px] text-slate-500 dark:text-slate-400 italic">Protected</span>
                        ) : (
                          <div className="inline-flex items-center justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => handleStartEditAccount(acc)}
                              title="Edit Account"
                              className="p-1 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 rounded"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteAccount(acc)}
                              title="Delete Account"
                              className="p-1 text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/70 rounded"
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
                className="px-4 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-semibold hover:bg-slate-200 dark:hover:bg-slate-700"
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
