import React, { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Save, AlertTriangle, Pencil, X, Upload, Utensils, Tag, BarChart3 } from 'lucide-react';
import { apiFetch, formatNum, formatPHP } from '../lib/api.ts';
import { MenuEngineeringDashboard } from './MenuEngineeringDashboard.tsx';

function resizeProductPhotoToDataUrl(file: File, maxDim = 560): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read image file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Invalid image file'));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const targetW = Math.max(1, Math.round(img.width * scale));
        const targetH = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Canvas context unavailable'));
          return;
        }
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, targetW, targetH);
        ctx.drawImage(img, 0, 0, targetW, targetH);

        let quality = 0.82;
        let dataUrl = canvas.toDataURL('image/jpeg', quality);
        while (dataUrl.length > 220000 && quality > 0.4) {
          quality -= 0.12;
          dataUrl = canvas.toDataURL('image/jpeg', quality);
        }
        if (dataUrl.length > 245000) {
          reject(new Error('Image is still too large after compression. Please choose a smaller photo.'));
          return;
        }
        resolve(dataUrl);
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export function ProductsBomModule({
  locations = [],
  activeLocationId,
}: {
  locations?: any[];
  activeLocationId?: string;
} = {}) {
  const [activeView, setActiveView] = useState<'bom' | 'menu-engineering'>('bom');
  const [menuRefreshTick, setMenuRefreshTick] = useState(0);
  const [products, setProducts] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [inventoryItems, setInventoryItems] = useState<any[]>([]);
  const [uoms, setUoms] = useState<any[]>([]);
  const [taxConfigs, setTaxConfigs] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [recipeLines, setRecipeLines] = useState<any[]>([]);
  const [editMeta, setEditMeta] = useState({ basePrice: 0, packagingCost: 0, directLaborCost: 0, targetFoodCostPct: 35, prepInstructions: '' });
  const [showCreate, setShowCreate] = useState(false);
  const [newProd, setNewProd] = useState({ name: '', sku: '', categoryId: '', basePrice: '180', packagingCost: '10', directLaborCost: '15', expiryDate: '', imageUrl: '' });
  const [editingProd, setEditingProd] = useState<any>(null);
  const [editProdForm, setEditProdForm] = useState({
    name: '',
    sku: '',
    description: '',
    imageUrl: '',
    categoryId: '',
    taxConfigId: 'tax_ph_vat',
    basePrice: '0',
    packagingCost: '0',
    directLaborCost: '0',
    targetFoodCostPct: '35',
    expiryDate: '',
    isAvailable: true,
    variants: [] as Array<{ id?: string; name: string; priceDelta: string; portionMultiplier: string }>,
    modifiers: [] as Array<{ id?: string; groupName: string; name: string; priceDelta: string }>,
  });
  const [savingEdit, setSavingEdit] = useState(false);
  const [showCategoriesModal, setShowCategoriesModal] = useState(false);
  const [catEditor, setCatEditor] = useState<{ mode: 'add' | 'edit'; target: 'editModal' | 'createModal' | 'categoriesModal'; id?: string; name: string; sortOrder: string; showInPos: boolean } | null>(null);
  const [savingCat, setSavingCat] = useState(false);
  const [bomModal, setBomModal] = useState<{ mode: 'add' | 'edit'; index?: number } | null>(null);
  const [bomForm, setBomForm] = useState({ inventoryItemId: '', quantity: '50', uomId: '', wasteFactorPct: '0' });
  const [savingBom, setSavingBom] = useState(false);
  const [ingEditor, setIngEditor] = useState<{
    mode: 'add' | 'edit' | 'delete';
    id?: string;
    name: string;
    sku: string;
    itemType: string;
    baseUomId: string;
    costingMethod: string;
    lastUnitCost: string;
    reorderPoint: string;
  } | null>(null);
  const [savingIng, setSavingIng] = useState(false);
  const [creatingProd, setCreatingProd] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const createPhotoInputRef = useRef<HTMLInputElement>(null);
  const editPhotoInputRef = useRef<HTMLInputElement>(null);

  const load = async (selectProductId?: string) => {
    try {
      setErr('');
      const data = await apiFetch('/products');
      setProducts(data.products || []);
      setCategories(data.categories || []);
      setInventoryItems(data.inventoryItems || []);
      setUoms(data.uoms || []);
      setTaxConfigs(data.taxConfigs || []);
      setMenuRefreshTick((n) => n + 1);
      if (!newProd.categoryId && data.categories?.[0]?.id) {
        setNewProd((p) => ({ ...p, categoryId: data.categories[0].id }));
      }
      const targetId = selectProductId || selected?.id;
      if (targetId) {
        const updated = (data.products || []).find((p: any) => p.id === targetId);
        if (updated) {
          selectProduct(updated);
          return;
        }
      }
      if (data.products?.[0]) {
        selectProduct(data.products[0]);
      }
    } catch (e: any) {
      setErr(e.message || 'Unable to load products');
    }
  };

  useEffect(() => {
    load();
  }, []);

  const selectProduct = (p: any) => {
    setSelected(p);
    setEditMeta({
      basePrice: p.base_price,
      packagingCost: p.packaging_cost,
      directLaborCost: p.direct_labor_cost,
      targetFoodCostPct: p.target_food_cost_pct,
      prepInstructions: p.recipe?.prep_instructions || '',
    });
    setRecipeLines(
      (p.recipe?.ingredients || []).map((ri: any) => ({
        inventoryItemId: ri.inventory_item_id,
        quantity: ri.quantity,
        uomId: ri.uom_id,
        wasteFactorPct: ri.waste_factor_pct,
      })),
    );
  };

  const saveRecipe = async () => {
    if (!selected) return;
    setErr('');
    try {
      await apiFetch(`/products/${selected.id}/recipe`, {
        method: 'PUT',
        body: JSON.stringify({ ...editMeta, ingredients: recipeLines }),
      });
      setMsg(`Saved BOM recipe & costing for ${selected.name}`);
      await load();
    } catch (e: any) {
      setErr(e.message || 'Unable to save recipe');
    }
  };

  const persistBomLines = async (nextLines: any[], successMessage: string) => {
    if (!selected) return;
    setErr('');
    setSavingBom(true);
    try {
      await apiFetch(`/products/${selected.id}/recipe`, {
        method: 'PUT',
        body: JSON.stringify({ ...editMeta, ingredients: nextLines }),
      });
      setRecipeLines(nextLines);
      setMsg(successMessage);
      await load();
    } catch (e: any) {
      setErr(e.message || 'Unable to update recipe ingredients');
      throw e;
    } finally {
      setSavingBom(false);
    }
  };

  const getCompatibleUoms = (inventoryItemId: string) => {
    const item = inventoryItems.find((it) => it.id === inventoryItemId);
    if (!item) return uoms;
    const baseCode = String(item.uom_code || '').toLowerCase();
    if (baseCode === 'g' || baseCode === 'kg') {
      return uoms.filter((u) => ['g', 'kg'].includes(String(u.code).toLowerCase()));
    }
    if (baseCode === 'ml' || baseCode === 'l') {
      return uoms.filter((u) => ['ml', 'l'].includes(String(u.code).toLowerCase()));
    }
    return uoms.filter((u) => u.id === item.base_uom_id);
  };

  const openAddBomIngredient = () => {
    setErr('');
    setIngEditor(null);
    const defaultItem = inventoryItems[0];
    setBomForm({
      inventoryItemId: defaultItem?.id || '',
      quantity: '50',
      uomId: defaultItem?.base_uom_id || uoms[0]?.id || '',
      wasteFactorPct: '0',
    });
    setBomModal({ mode: 'add' });
  };

  const openEditBomIngredient = (idx: number) => {
    const line = recipeLines[idx];
    if (!line) return;
    setErr('');
    setIngEditor(null);
    setBomForm({
      inventoryItemId: line.inventoryItemId,
      quantity: String(line.quantity ?? 0),
      uomId: line.uomId,
      wasteFactorPct: String(line.wasteFactorPct ?? 0),
    });
    setBomModal({ mode: 'edit', index: idx });
  };

  const openIngAdd = () => {
    setErr('');
    setIngEditor({
      mode: 'add',
      name: '',
      sku: '',
      itemType: 'RAW_MATERIAL',
      baseUomId: uoms[0]?.id || '',
      costingMethod: 'FIFO',
      lastUnitCost: '0',
      reorderPoint: '0',
    });
  };

  const openIngEdit = (inventoryItemId: string) => {
    const item = inventoryItems.find((it) => it.id === inventoryItemId);
    if (!item) return;
    setErr('');
    setIngEditor({
      mode: 'edit',
      id: item.id,
      name: item.name || '',
      sku: item.sku || '',
      itemType: item.item_type || 'RAW_MATERIAL',
      baseUomId: item.base_uom_id || uoms[0]?.id || '',
      costingMethod: item.costing_method || 'FIFO',
      lastUnitCost: String(item.last_unit_cost ?? 0),
      reorderPoint: String(item.reorder_point ?? 0),
    });
  };

  const openIngDelete = (inventoryItemId: string) => {
    const item = inventoryItems.find((it) => it.id === inventoryItemId);
    if (!item) return;
    setErr('');
    setIngEditor({
      mode: 'delete',
      id: item.id,
      name: item.name || '',
      sku: item.sku || '',
      itemType: item.item_type || 'RAW_MATERIAL',
      baseUomId: item.base_uom_id || '',
      costingMethod: item.costing_method || 'FIFO',
      lastUnitCost: String(item.last_unit_cost ?? 0),
      reorderPoint: String(item.reorder_point ?? 0),
    });
  };

  const saveIngEditor = async () => {
    if (!ingEditor) return;
    setErr('');
    setSavingIng(true);
    try {
      if (ingEditor.mode === 'delete' && ingEditor.id) {
        await apiFetch(`/inventory/items/${ingEditor.id}`, { method: 'DELETE' });
        const deletedId = ingEditor.id;
        const deletedName = ingEditor.name;
        const remaining = inventoryItems.filter((it) => it.id !== deletedId);
        setBomForm((f) => ({
          ...f,
          inventoryItemId: remaining[0]?.id || '',
          uomId: remaining[0]?.base_uom_id || f.uomId,
        }));
        setIngEditor(null);
        setMsg(`Deleted ingredient "${deletedName}"`);
        await load();
        return;
      }

      const payload = {
        name: ingEditor.name,
        sku: ingEditor.sku,
        itemType: ingEditor.itemType,
        baseUomId: ingEditor.baseUomId,
        costingMethod: ingEditor.costingMethod,
        lastUnitCost: Number(ingEditor.lastUnitCost || 0),
        reorderPoint: Number(ingEditor.reorderPoint || 0),
        minStockLevel: Number(ingEditor.reorderPoint || 0),
      };

      let savedItem: any;
      if (ingEditor.mode === 'add') {
        savedItem = await apiFetch('/inventory/items', { method: 'POST', body: JSON.stringify(payload) });
        setMsg(`Added ingredient "${savedItem.name}"`);
      } else {
        savedItem = await apiFetch(`/inventory/items/${ingEditor.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        setMsg(`Updated ingredient "${savedItem.name}"`);
      }

      setBomForm((f) => ({
        ...f,
        inventoryItemId: savedItem.id,
        uomId: savedItem.base_uom_id || f.uomId,
      }));
      setIngEditor(null);
      await load();
    } catch (e: any) {
      setErr(e.message || 'Unable to save ingredient');
    } finally {
      setSavingIng(false);
    }
  };

  const submitBomIngredient = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bomModal) return;
    const qty = Number(bomForm.quantity);
    if (!bomForm.inventoryItemId) {
      setErr('Please select an ingredient');
      return;
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      setErr('Quantity must be greater than zero');
      return;
    }
    const nextEntry = {
      inventoryItemId: bomForm.inventoryItemId,
      quantity: qty,
      uomId: bomForm.uomId,
      wasteFactorPct: Number(bomForm.wasteFactorPct || 0),
    };
    const nextLines =
      bomModal.mode === 'add'
        ? [...recipeLines, nextEntry]
        : recipeLines.map((x, i) => (i === bomModal.index ? nextEntry : x));

    const itemName = inventoryItems.find((it) => it.id === bomForm.inventoryItemId)?.name || 'ingredient';
    try {
      await persistBomLines(
        nextLines,
        bomModal.mode === 'add'
          ? `Added "${itemName}" to ${selected.name} BOM and recalculated cost.`
          : `Updated "${itemName}" in ${selected.name} BOM and recalculated cost.`,
      );
      setBomModal(null);
    } catch {
      // error already shown in err banner
    }
  };

  const deleteBomIngredient = async (idx: number) => {
    const target = recipeLines[idx];
    if (!target) return;
    const itemName = inventoryItems.find((it) => it.id === target.inventoryItemId)?.name || 'ingredient';
    const nextLines = recipeLines.filter((_, i) => i !== idx);
    try {
      await persistBomLines(nextLines, `Removed "${itemName}" from ${selected.name} BOM and recalculated cost.`);
    } catch {
      // error already shown in err banner
    }
  };

  const handleProductPhotoUpload = async (file: File | undefined, target: 'create' | 'edit') => {
    if (!file) return;
    setErr('');
    try {
      const dataUrl = await resizeProductPhotoToDataUrl(file);
      if (target === 'create') {
        setNewProd((p) => ({ ...p, imageUrl: dataUrl }));
      } else {
        setEditProdForm((f) => ({ ...f, imageUrl: dataUrl }));
      }
    } catch (e: any) {
      setErr(e.message || 'Unable to process uploaded product photo');
    }
  };

  const openCreateProduct = () => {
    setErr('');
    setCatEditor(null);
    setNewProd((p) => ({
      ...p,
      categoryId: p.categoryId || categories[0]?.id || '',
      imageUrl: '',
    }));
    setShowCreate(true);
  };

  const createProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setCreatingProd(true);
    try {
      const created = await apiFetch<{ id: string }>('/products', {
        method: 'POST',
        body: JSON.stringify({
          ...newProd,
          imageUrl: newProd.imageUrl || null,
          categoryId: newProd.categoryId || categories[0]?.id || '',
          ingredients: inventoryItems[0]
            ? [{ inventoryItemId: inventoryItems[0].id, quantity: 100, uomId: inventoryItems[0].base_uom_id, wasteFactorPct: 2 }]
            : [],
        }),
      });
      const createdName = newProd.name.trim();
      setShowCreate(false);
      setCatEditor(null);
      setNewProd({ name: '', sku: '', categoryId: categories[0]?.id || '', basePrice: '180', packagingCost: '10', directLaborCost: '15', expiryDate: '', imageUrl: '' });
      setMsg(`Created new menu product "${createdName}".`);
      await load(created.id);
    } catch (e: any) {
      setErr(e.message || 'Unable to create product');
    } finally {
      setCreatingProd(false);
    }
  };

  const toggleAvailability = async (p: any) => {
    setErr('');
    try {
      await apiFetch(`/products/${p.id}/availability`, {
        method: 'PATCH',
        body: JSON.stringify({ isAvailable: p.is_available !== 1 }),
      });
      await load();
    } catch (e: any) {
      setErr(e.message || 'Unable to update availability');
    }
  };

  const openEditProduct = (p: any) => {
    setErr('');
    setCatEditor(null);
    selectProduct(p);
    setEditingProd(p);
    setEditProdForm({
      name: p.name || '',
      sku: p.sku || '',
      description: p.description || '',
      imageUrl: p.image_url || '',
      categoryId: p.category_id || categories[0]?.id || '',
      taxConfigId: p.tax_config_id || taxConfigs[0]?.id || 'tax_ph_vat',
      basePrice: String(p.base_price ?? 0),
      packagingCost: String(p.packaging_cost ?? 0),
      directLaborCost: String(p.direct_labor_cost ?? 0),
      targetFoodCostPct: String(p.target_food_cost_pct ?? 35),
      expiryDate: p.expiry_date ? String(p.expiry_date).slice(0, 10) : '',
      isAvailable: p.is_available === 1,
      variants: (p.variants || []).map((v: any) => ({
        id: v.id,
        name: v.name || '',
        priceDelta: String(v.price_delta ?? 0),
        portionMultiplier: String(v.portion_multiplier ?? 1),
      })),
      modifiers: (p.modifiers || []).map((m: any) => ({
        id: m.id,
        groupName: m.group_name || 'Add-ons',
        name: m.name || '',
        priceDelta: String(m.price_delta ?? 0),
      })),
    });
  };

  const submitEditProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingProd) return;
    setErr('');
    setSavingEdit(true);
    try {
      await apiFetch(`/products/${editingProd.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editProdForm.name,
          sku: editProdForm.sku,
          description: editProdForm.description,
          imageUrl: editProdForm.imageUrl || null,
          categoryId: editProdForm.categoryId,
          taxConfigId: editProdForm.taxConfigId,
          basePrice: Number(editProdForm.basePrice),
          packagingCost: Number(editProdForm.packagingCost || 0),
          directLaborCost: Number(editProdForm.directLaborCost || 0),
          targetFoodCostPct: Number(editProdForm.targetFoodCostPct || 35),
          expiryDate: editProdForm.expiryDate || null,
          isAvailable: editProdForm.isAvailable,
          variants: editProdForm.variants.map((v) => ({
            id: v.id,
            name: v.name,
            priceDelta: Number(v.priceDelta || 0),
            portionMultiplier: Number(v.portionMultiplier || 1),
          })),
          modifiers: editProdForm.modifiers.map((m) => ({
            id: m.id,
            groupName: m.groupName,
            name: m.name,
            priceDelta: Number(m.priceDelta || 0),
          })),
        }),
      });
      const updatedName = editProdForm.name.trim();
      setEditingProd(null);
      setMsg(`Updated menu product "${updatedName}"`);
      await load();
    } catch (e: any) {
      setErr(e.message || 'Unable to update product');
    } finally {
      setSavingEdit(false);
    }
  };

  const openCatAdd = (target: 'editModal' | 'createModal' | 'categoriesModal') => {
    setErr('');
    setCatEditor({ mode: 'add', target, name: '', sortOrder: String((categories.length || 0) + 1), showInPos: true });
  };

  const openCatEdit = (target: 'editModal' | 'createModal' | 'categoriesModal', categoryId: string) => {
    const cat = categories.find((c) => c.id === categoryId);
    if (!cat) return;
    setErr('');
    setCatEditor({
      mode: 'edit',
      target,
      id: cat.id,
      name: cat.name,
      sortOrder: String(cat.sort_order ?? 0),
      showInPos: cat.show_in_pos !== false,
    });
  };

  const saveCategory = async () => {
    if (!catEditor) return;
    setErr('');
    setSavingCat(true);
    try {
      const payload = {
        name: catEditor.name,
        sortOrder: catEditor.sortOrder === '' ? undefined : Number(catEditor.sortOrder),
        showInPos: catEditor.showInPos,
      };
      let savedCat: any;
      if (catEditor.mode === 'add') {
        savedCat = await apiFetch('/categories', { method: 'POST', body: JSON.stringify(payload) });
        setMsg(`Added category "${savedCat.name}"`);
      } else {
        savedCat = await apiFetch(`/categories/${catEditor.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        setMsg(`Updated category "${savedCat.name}"`);
      }

      if (catEditor.target === 'editModal') {
        setEditProdForm((f) => ({ ...f, categoryId: savedCat.id }));
      } else if (catEditor.target === 'createModal') {
        setNewProd((p) => ({ ...p, categoryId: savedCat.id }));
      }
      setCatEditor(null);
      await load();
    } catch (e: any) {
      setErr(e.message || 'Unable to save category');
    } finally {
      setSavingCat(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 dark:text-slate-50">Products, Menus &amp; Recipe BOM</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {activeView === 'menu-engineering'
              ? 'Analyze contribution margin vs POS menu popularity to classify Stars, Plowhorses, Puzzles, and Dogs'
              : 'Every menu item links to a Bill of Materials that auto-deducts ingredients on POS checkout'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 p-0.5">
            <button
              type="button"
              onClick={() => setActiveView('bom')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                activeView === 'bom'
                  ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950'
                  : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Utensils className="w-3.5 h-3.5" />
              BOM &amp; Recipes
            </button>
            <button
              type="button"
              onClick={() => setActiveView('menu-engineering')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                activeView === 'menu-engineering'
                  ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950'
                  : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <BarChart3 className="w-3.5 h-3.5" />
              Menu Engineering
            </button>
          </div>
          {activeView === 'bom' && (
            <>
              <button
                type="button"
                onClick={() => {
                  setErr('');
                  setCatEditor(null);
                  setShowCategoriesModal(true);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                <Tag className="w-3.5 h-3.5" />
                Categories ({categories.length})
              </button>
              <button
                onClick={openCreateProduct}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-4 py-2 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white whitespace-nowrap shrink-0"
              >
                <Plus className="w-4 h-4" />
                New Menu Product
              </button>
            </>
          )}
        </div>
      </div>

      {msg && <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/45 border border-emerald-200 dark:border-emerald-700/80 text-xs text-emerald-800 dark:text-emerald-300 font-medium">{msg}</div>}
      {err && !showCreate && !editingProd && !bomModal && !showCategoriesModal && (
        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">{err}</div>
      )}

      {activeView === 'menu-engineering' ? (
        <MenuEngineeringDashboard
          locations={locations}
          activeLocationId={activeLocationId}
          refreshTrigger={menuRefreshTick}
          onSelectProductForEdit={(productId) => {
            const found = products.find((p) => p.id === productId);
            if (found) selectProduct(found);
            setActiveView('bom');
          }}
        />
      ) : (
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Product List */}
        <div className="lg:col-span-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="p-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-xs font-semibold text-slate-600 dark:text-slate-300">
            Menu Items ({products.length})
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {products.map((p) => (
              <div
                key={p.id}
                onClick={() => selectProduct(p)}
                className={`p-3.5 cursor-pointer flex items-center justify-between gap-3 transition-colors ${
                  selected?.id === p.id ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950' : 'hover:bg-slate-50 dark:hover:bg-slate-800'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-lg overflow-hidden bg-slate-100 dark:bg-slate-800 border border-slate-200/70 flex items-center justify-center shrink-0">
                    {p.image_url ? (
                      <img src={p.image_url} alt={p.name} referrerPolicy="no-referrer" className="w-full h-full object-cover" />
                    ) : (
                      <Utensils className="w-4 h-4 text-slate-500 dark:text-slate-400" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">{p.name}</p>
                    <p className={`text-xs mt-0.5 truncate ${selected?.id === p.id ? 'text-slate-500 dark:text-slate-500' : 'text-slate-500 dark:text-slate-400'}`}>
                      {p.category_name}{p.category_show_in_pos === 0 ? ' (Hidden in POS)' : ''} · Food Cost {formatNum(p.costing.foodCostPct, 1)}% · Margin {formatNum(p.costing.marginPct, 1)}%
                      {p.expiry_date ? ` · Exp: ${String(p.expiry_date).slice(0, 10)}` : ''}
                    </p>
                  </div>
                </div>
                <div className="text-right shrink-0 flex items-center gap-2.5">
                  <div>
                    <p className="font-mono tabular-nums text-sm font-semibold">{formatPHP(p.base_price)}</p>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleAvailability(p);
                      }}
                      className={`text-[11px] font-medium underline ${
                        p.is_available === 1
                          ? selected?.id === p.id ? 'text-emerald-300' : 'text-emerald-700 dark:text-emerald-300'
                          : 'text-red-500'
                      }`}
                    >
                      {p.is_available === 1 ? 'Available' : '86 / Unavailable'}
                    </button>
                  </div>
                  <button
                    type="button"
                    title={`Edit ${p.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      openEditProduct(p);
                    }}
                    className={`p-1.5 rounded-md border transition-colors ${
                      selected?.id === p.id
                        ? 'border-slate-700 text-slate-200 hover:bg-slate-800 dark:hover:bg-white'
                        : 'border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* BOM & Costing Editor */}
        {selected && (
          <div className="lg:col-span-7 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 dark:border-slate-800/80 pb-4">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-lg overflow-hidden bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-800 flex items-center justify-center shrink-0">
                  {selected.image_url ? (
                    <img src={selected.image_url} alt={selected.name} referrerPolicy="no-referrer" className="w-full h-full object-cover" />
                  ) : (
                    <Utensils className="w-5 h-5 text-slate-500 dark:text-slate-400" />
                  )}
                </div>
                <div>
                  <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-50">{selected.name}</h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {selected.sku} · {selected.category_name}{selected.category_show_in_pos === 0 ? ' (Hidden in POS)' : ''} · {selected.tax_code}
                    {selected.expiry_date ? ` · Expiry: ${String(selected.expiry_date).slice(0, 10)}` : ''}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2.5">
                {selected.costing.isMarginAlert && (
                  <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="w-4 h-4" />
                    Food cost exceeds {selected.target_food_cost_pct}% target
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => openEditProduct(selected)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                >
                  <Pencil className="w-3.5 h-3.5" />
                  Edit Product
                </button>
              </div>
            </div>

            {/* Live Costing Summary */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-slate-50 dark:bg-slate-800/70 p-3.5 rounded-lg border border-slate-200 dark:border-slate-800">
              <div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">Ingredient Cost</p>
                <p className="font-mono tabular-nums text-base font-semibold text-slate-900 dark:text-slate-50">{formatPHP(selected.costing.ingredientCost)}</p>
              </div>
              <div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">Total Direct Cost</p>
                <p className="font-mono tabular-nums text-base font-semibold text-slate-900 dark:text-slate-50">{formatPHP(selected.costing.directCost)}</p>
              </div>
              <div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">Food Cost %</p>
                <p className={`font-mono tabular-nums text-base font-semibold ${selected.costing.isMarginAlert ? 'text-amber-700 dark:text-amber-300' : 'text-slate-900 dark:text-slate-50'}`}>
                  {formatNum(selected.costing.foodCostPct, 1)}%
                </p>
              </div>
              <div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">Gross Profit / Unit</p>
                <p className="font-mono tabular-nums text-base font-semibold text-emerald-700 dark:text-emerald-300">{formatPHP(selected.costing.grossProfit)}</p>
              </div>
            </div>

            {/* Pricing & Overhead Allocation */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Selling Price (PHP)</label>
                <input
                  type="number"
                  value={editMeta.basePrice}
                  onChange={(e) => setEditMeta({ ...editMeta, basePrice: Number(e.target.value) })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Packaging Cost</label>
                <input
                  type="number"
                  value={editMeta.packagingCost}
                  onChange={(e) => setEditMeta({ ...editMeta, packagingCost: Number(e.target.value) })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Direct Labor</label>
                <input
                  type="number"
                  value={editMeta.directLaborCost}
                  onChange={(e) => setEditMeta({ ...editMeta, directLaborCost: Number(e.target.value) })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Target Food Cost %</label>
                <input
                  type="number"
                  value={editMeta.targetFoodCostPct}
                  onChange={(e) => setEditMeta({ ...editMeta, targetFoodCostPct: Number(e.target.value) })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                />
              </div>
            </div>

            {/* Recipe Ingredients */}
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-200">Recipe Ingredients (Bill of Materials)</h3>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">Add, edit, or delete ingredients deducted on every POS sale</p>
                </div>
                <button
                  type="button"
                  disabled={savingBom || inventoryItems.length === 0}
                  onClick={openAddBomIngredient}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-3 py-1.5 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" /> Add Ingredient
                </button>
              </div>

              <div className="rounded-lg border border-slate-200 dark:border-slate-800 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
                    <tr>
                      <th className="p-2.5 font-medium">Ingredient</th>
                      <th className="p-2.5 font-medium text-right">Quantity</th>
                      <th className="p-2.5 font-medium text-right">Waste %</th>
                      <th className="p-2.5 font-medium text-right">Est. Cost</th>
                      <th className="p-2.5 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {recipeLines.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="p-6 text-center text-slate-500 dark:text-slate-400">
                          No recipe ingredients yet. Click Add Ingredient to build the Bill of Materials.
                        </td>
                      </tr>
                    ) : (
                      recipeLines.map((line, idx) => {
                        const ingItem = inventoryItems.find((it) => it.id === line.inventoryItemId);
                        const uomObj = uoms.find((u) => u.id === line.uomId);
                        const lineUomCode = String(uomObj?.code || ingItem?.uom_code || '').toLowerCase();
                        const baseUomCode = String(ingItem?.uom_code || '').toLowerCase();
                        let factor = 1;
                        if (lineUomCode === 'kg' && baseUomCode === 'g') factor = 1000;
                        else if (lineUomCode === 'g' && baseUomCode === 'kg') factor = 0.001;
                        else if (lineUomCode === 'l' && baseUomCode === 'ml') factor = 1000;
                        else if (lineUomCode === 'ml' && baseUomCode === 'l') factor = 0.001;
                        const unitCost =
                          ingItem?.costing_method === 'WEIGHTED_AVERAGE'
                            ? Number(ingItem?.weighted_avg_cost || 0)
                            : Number(ingItem?.last_unit_cost || 0);
                        const estCost = Number(line.quantity || 0) * factor * (1 + Number(line.wasteFactorPct || 0) / 100) * unitCost;

                        return (
                          <tr key={`${line.inventoryItemId}-${idx}`} className="hover:bg-slate-50 dark:hover:bg-slate-800">
                            <td className="p-2.5 font-medium text-slate-900 dark:text-slate-50">
                              {ingItem?.name || 'Unknown Ingredient'}
                              {ingItem?.sku && <span className="ml-1.5 font-mono text-[11px] text-slate-500 dark:text-slate-400">{ingItem.sku}</span>}
                            </td>
                            <td className="p-2.5 text-right font-mono tabular-nums text-slate-800 dark:text-slate-100">
                              {formatNum(line.quantity, 2)} {uomObj?.code || ''}
                            </td>
                            <td className="p-2.5 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                              {formatNum(line.wasteFactorPct, 1)}%
                            </td>
                            <td className="p-2.5 text-right font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-50">
                              {formatPHP(estCost)}
                            </td>
                            <td className="p-2.5 text-right">
                              <div className="inline-flex items-center justify-end gap-1.5">
                                <button
                                  type="button"
                                  disabled={savingBom}
                                  onClick={() => openEditBomIngredient(idx)}
                                  className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
                                >
                                  <Pencil className="w-3 h-3" /> Edit
                                </button>
                                <button
                                  type="button"
                                  disabled={savingBom}
                                  onClick={() => deleteBomIngredient(idx)}
                                  className="inline-flex items-center gap-1 rounded border border-red-200 dark:border-red-800/80 bg-white dark:bg-slate-900 px-2 py-1 text-[11px] font-medium text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/70 disabled:opacity-40"
                                >
                                  <Trash2 className="w-3 h-3" /> Delete
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
              {(Number(editMeta.basePrice) !== Number(selected.base_price) ||
                Number(editMeta.packagingCost) !== Number(selected.packaging_cost) ||
                Number(editMeta.directLaborCost) !== Number(selected.direct_labor_cost) ||
                Number(editMeta.targetFoodCostPct) !== Number(selected.target_food_cost_pct)) ? (
                <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
                  Unsaved price/cost edits — click Save Recipe &amp; Recalculate Cost to persist
                </span>
              ) : (
                <span />
              )}
              <button
                onClick={saveRecipe}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-4 py-2 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white"
              >
                <Save className="w-3.5 h-3.5" />
                Save Recipe &amp; Recalculate Cost
              </button>
            </div>
          </div>
        )}
      </div>
      )}

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form onSubmit={createProduct} className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-xl bg-white dark:bg-slate-900 p-5 space-y-3 border border-slate-200 dark:border-slate-800">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800/80 pb-2.5">
              <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">Create Menu Product</h3>
              <button
                type="button"
                onClick={() => {
                  setErr('');
                  setCatEditor(null);
                  setShowCreate(false);
                }}
                className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {err && <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">{err}</div>}
            <div className="flex items-center gap-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 p-3">
              <div className="w-16 h-16 rounded-lg overflow-hidden bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-center shrink-0">
                {newProd.imageUrl ? (
                  <img src={newProd.imageUrl} alt={newProd.name || 'Product preview'} className="w-full h-full object-cover" />
                ) : (
                  <Utensils className="w-6 h-6 text-slate-400 dark:text-slate-500" />
                )}
              </div>
              <div className="flex-1 min-w-0 space-y-1.5">
                <p className="text-xs font-medium text-slate-700 dark:text-slate-200">Product Photo</p>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    ref={createPhotoInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                    onChange={(e) => {
                      handleProductPhotoUpload(e.target.files?.[0], 'create');
                      e.target.value = '';
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => createPhotoInputRef.current?.click()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    <Upload className="w-3.5 h-3.5" /> {newProd.imageUrl ? 'Change Photo' : 'Upload Photo'}
                  </button>
                  {newProd.imageUrl && (
                    <button
                      type="button"
                      onClick={() => setNewProd((p) => ({ ...p, imageUrl: '' }))}
                      className="inline-flex items-center gap-1 rounded-lg border border-red-200 dark:border-red-800/80 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/70"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Remove
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Product Name *</label>
              <input
                required
                placeholder="e.g. Smoked Beef Brisket Platter"
                value={newProd.name}
                onChange={(e) => setNewProd({ ...newProd, name: e.target.value })}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
              />
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">SKU (optional)</label>
                <input
                  placeholder="Auto if blank"
                  value={newProd.sku}
                  onChange={(e) => setNewProd({ ...newProd, sku: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Category</label>
                <div className="flex items-center gap-1.5">
                  <select
                    value={newProd.categoryId}
                    onChange={(e) => setNewProd({ ...newProd, categoryId: e.target.value })}
                    className="flex-1 min-w-0 rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                  >
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}{c.show_in_pos === false ? ' (Hidden in POS)' : ''}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    title="Add Category"
                    onClick={() => openCatAdd('createModal')}
                    className="p-2 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white shrink-0"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    title="Edit Category"
                    disabled={!newProd.categoryId}
                    onClick={() => openCatEdit('createModal', newProd.categoryId)}
                    className="p-2 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white disabled:opacity-40 shrink-0"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
            {catEditor && catEditor.target === 'createModal' && (
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 p-3 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">
                    {catEditor.mode === 'add' ? 'New Category' : 'Edit Category'}
                  </span>
                  <button type="button" onClick={() => setCatEditor(null)} className="text-[11px] text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100">Cancel</button>
                </div>
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Category Name</label>
                    <input
                      placeholder="Category Name"
                      value={catEditor.name}
                      onChange={(e) => setCatEditor({ ...catEditor, name: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs"
                    />
                  </div>
                  <div className="w-16">
                    <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Order</label>
                    <input
                      type="number"
                      placeholder="Order"
                      title="Sort Order"
                      value={catEditor.sortOrder}
                      onChange={(e) => setCatEditor({ ...catEditor, sortOrder: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-1.5 text-xs font-mono text-right"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={savingCat || !catEditor.name.trim()}
                    onClick={saveCategory}
                    className="rounded-lg bg-slate-900 dark:bg-slate-100 px-3 py-1.5 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white disabled:opacity-40"
                  >
                    {savingCat ? 'Saving...' : 'Save'}
                  </button>
                </div>
                <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={catEditor.showInPos}
                    onChange={(e) => setCatEditor({ ...catEditor, showInPos: e.target.checked })}
                  />
                  Available to view in POS
                </label>
              </div>
            )}
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Price (PHP)</label>
                <input
                  type="number"
                  required
                  placeholder="Price"
                  value={newProd.basePrice}
                  onChange={(e) => setNewProd({ ...newProd, basePrice: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Packaging</label>
                <input
                  type="number"
                  placeholder="Packaging"
                  value={newProd.packagingCost}
                  onChange={(e) => setNewProd({ ...newProd, packagingCost: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Labor</label>
                <input
                  type="number"
                  placeholder="Labor"
                  value={newProd.directLaborCost}
                  onChange={(e) => setNewProd({ ...newProd, directLaborCost: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">Expiry Date (optional)</label>
                {newProd.expiryDate && (
                  <button
                    type="button"
                    onClick={() => setNewProd({ ...newProd, expiryDate: '' })}
                    className="text-[11px] text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100 underline"
                  >
                    Clear date
                  </button>
                )}
              </div>
              <input
                type="date"
                value={newProd.expiryDate}
                onChange={(e) => setNewProd({ ...newProd, expiryDate: e.target.value })}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  setErr('');
                  setCatEditor(null);
                  setShowCreate(false);
                }}
                className="px-4 py-2 rounded-lg border text-xs"
              >
                Cancel
              </button>
              <button type="submit" disabled={creatingProd} className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 text-xs font-semibold hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50">
                {creatingProd ? 'Creating...' : 'Create Product'}
              </button>
            </div>
          </form>
        </div>
      )}

      {editingProd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form onSubmit={submitEditProduct} className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl bg-white dark:bg-slate-900 p-5 space-y-4 border border-slate-200 dark:border-slate-800">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800/80 pb-3">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">Edit Menu Product</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">Update menu item details, pricing, sizes/variants, and add-ons</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setErr('');
                  setEditingProd(null);
                }}
                className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {err && <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">{err}</div>}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Product Name</label>
                <input
                  required
                  value={editProdForm.name}
                  onChange={(e) => setEditProdForm({ ...editProdForm, name: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">SKU</label>
                <input
                  required
                  value={editProdForm.sku}
                  onChange={(e) => setEditProdForm({ ...editProdForm, sku: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">Category</label>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => openCatAdd('editModal')}
                      className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      <Plus className="w-3 h-3" /> Add
                    </button>
                    <button
                      type="button"
                      disabled={!editProdForm.categoryId}
                      onClick={() => openCatEdit('editModal', editProdForm.categoryId)}
                      className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40"
                    >
                      <Pencil className="w-3 h-3" /> Edit
                    </button>
                  </div>
                </div>
                <select
                  value={editProdForm.categoryId}
                  onChange={(e) => setEditProdForm({ ...editProdForm, categoryId: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                >
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}{c.show_in_pos === false ? ' (Hidden in POS)' : ''}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Tax Configuration</label>
                <select
                  value={editProdForm.taxConfigId}
                  onChange={(e) => setEditProdForm({ ...editProdForm, taxConfigId: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                >
                  {taxConfigs.map((t) => (
                    <option key={t.id} value={t.id}>{t.name} ({t.rate_percent}%)</option>
                  ))}
                </select>
              </div>
            </div>

            {catEditor && catEditor.target === 'editModal' && (
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 p-3 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                    {catEditor.mode === 'add' ? 'Add New Category' : 'Edit Selected Category'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setCatEditor(null)}
                    className="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100"
                  >
                    Cancel
                  </button>
                </div>
                <div className="flex flex-wrap sm:flex-nowrap items-end gap-2">
                  <div className="flex-1 min-w-[160px]">
                    <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Category Name</label>
                    <input
                      placeholder="Category Name (e.g. Grilled Platters)"
                      value={catEditor.name}
                      onChange={(e) => setCatEditor({ ...catEditor, name: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs"
                    />
                  </div>
                  <div className="w-20">
                    <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Sort Order</label>
                    <input
                      type="number"
                      placeholder="Sort"
                      title="Sort Order"
                      value={catEditor.sortOrder}
                      onChange={(e) => setCatEditor({ ...catEditor, sortOrder: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-mono text-right"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={savingCat || !catEditor.name.trim()}
                    onClick={saveCategory}
                    className="rounded-lg bg-slate-900 dark:bg-slate-100 px-3.5 py-1.5 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white disabled:opacity-40 whitespace-nowrap"
                  >
                    {savingCat ? 'Saving...' : catEditor.mode === 'add' ? 'Create Category' : 'Save Category'}
                  </button>
                </div>
                <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={catEditor.showInPos}
                    onChange={(e) => setCatEditor({ ...catEditor, showInPos: e.target.checked })}
                  />
                  Available to view in POS
                </label>
              </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Selling Price (PHP)</label>
                <input
                  type="number"
                  step="0.01"
                  required
                  value={editProdForm.basePrice}
                  onChange={(e) => setEditProdForm({ ...editProdForm, basePrice: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Packaging Cost</label>
                <input
                  type="number"
                  step="0.01"
                  value={editProdForm.packagingCost}
                  onChange={(e) => setEditProdForm({ ...editProdForm, packagingCost: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Direct Labor</label>
                <input
                  type="number"
                  step="0.01"
                  value={editProdForm.directLaborCost}
                  onChange={(e) => setEditProdForm({ ...editProdForm, directLaborCost: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Target Food Cost %</label>
                <input
                  type="number"
                  step="0.1"
                  value={editProdForm.targetFoodCostPct}
                  onChange={(e) => setEditProdForm({ ...editProdForm, targetFoodCostPct: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Description</label>
                <input
                  placeholder="Short menu description"
                  value={editProdForm.description}
                  onChange={(e) => setEditProdForm({ ...editProdForm, description: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">Expiry Date</label>
                  {editProdForm.expiryDate && (
                    <button
                      type="button"
                      onClick={() => setEditProdForm({ ...editProdForm, expiryDate: '' })}
                      className="text-[11px] text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100 underline"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <input
                  type="date"
                  value={editProdForm.expiryDate}
                  onChange={(e) => setEditProdForm({ ...editProdForm, expiryDate: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono"
                />
              </div>
            </div>

            <div className="flex items-center gap-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 p-3.5">
              <div className="w-16 h-16 rounded-lg overflow-hidden bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 flex items-center justify-center shrink-0">
                {editProdForm.imageUrl ? (
                  <img
                    src={editProdForm.imageUrl}
                    alt={editProdForm.name || 'Product photo'}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <Utensils className="w-6 h-6 text-slate-400 dark:text-slate-500" />
                )}
              </div>
              <div className="flex-1 min-w-0 space-y-1.5">
                <p className="text-xs font-medium text-slate-700 dark:text-slate-200">Product Photo</p>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    ref={editPhotoInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                    onChange={(e) => {
                      handleProductPhotoUpload(e.target.files?.[0], 'edit');
                      e.target.value = '';
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => editPhotoInputRef.current?.click()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    <Upload className="w-3.5 h-3.5" /> {editProdForm.imageUrl ? 'Change Photo' : 'Upload Photo'}
                  </button>
                  {editProdForm.imageUrl && (
                    <button
                      type="button"
                      onClick={() => setEditProdForm((f) => ({ ...f, imageUrl: '' }))}
                      className="inline-flex items-center gap-1 rounded-lg border border-red-200 dark:border-red-800/80 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/70"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Remove
                    </button>
                  )}
                </div>
              </div>
            </div>

            <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-200 cursor-pointer">
              <input
                type="checkbox"
                checked={editProdForm.isAvailable}
                onChange={(e) => setEditProdForm({ ...editProdForm, isAvailable: e.target.checked })}
              />
              Available for sale in POS
            </label>

            {/* Variants / Sizes */}
            <div className="border-t border-slate-100 dark:border-slate-800/80 pt-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">Sizes &amp; Variants</span>
                <button
                  type="button"
                  onClick={() =>
                    setEditProdForm((f) => ({
                      ...f,
                      variants: [...f.variants, { name: '', priceDelta: '0', portionMultiplier: '1' }],
                    }))
                  }
                  className="text-xs font-medium text-slate-900 dark:text-slate-50 hover:underline"
                >
                  + Add Variant
                </button>
              </div>
              {editProdForm.variants.length === 0 ? (
                <p className="text-[11px] text-slate-500 dark:text-slate-400">No variants configured (uses standard single size).</p>
              ) : (
                <div className="space-y-1.5">
                  <div className="grid grid-cols-12 gap-2 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                    <span className="col-span-5">Variant / Size Name</span>
                    <span className="col-span-3 text-right">+Price (PHP)</span>
                    <span className="col-span-3 text-right">Portion Multiplier</span>
                    <span className="col-span-1" />
                  </div>
                  {editProdForm.variants.map((v, idx) => (
                    <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                      <input
                        aria-label="Variant Name"
                        placeholder="Variant Name (e.g. Large)"
                        value={v.name}
                        onChange={(e) =>
                          setEditProdForm((f) => ({
                            ...f,
                            variants: f.variants.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x)),
                          }))
                        }
                        className="col-span-5 rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-1.5 text-xs"
                      />
                      <input
                        type="number"
                        step="0.01"
                        aria-label="Price Delta (PHP)"
                        placeholder="+Price (PHP)"
                        title="Price Delta (PHP)"
                        value={v.priceDelta}
                        onChange={(e) =>
                          setEditProdForm((f) => ({
                            ...f,
                            variants: f.variants.map((x, i) => (i === idx ? { ...x, priceDelta: e.target.value } : x)),
                          }))
                        }
                        className="col-span-3 rounded-lg border border-slate-200 dark:border-slate-800 px-2 py-1.5 text-xs font-mono text-right"
                      />
                      <input
                        type="number"
                        step="0.1"
                        aria-label="BOM Portion Multiplier"
                        placeholder="Portion x"
                        title="BOM Portion Multiplier"
                        value={v.portionMultiplier}
                        onChange={(e) =>
                          setEditProdForm((f) => ({
                            ...f,
                            variants: f.variants.map((x, i) => (i === idx ? { ...x, portionMultiplier: e.target.value } : x)),
                          }))
                        }
                        className="col-span-3 rounded-lg border border-slate-200 dark:border-slate-800 px-2 py-1.5 text-xs font-mono text-right"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setEditProdForm((f) => ({
                            ...f,
                            variants: f.variants.filter((_, i) => i !== idx),
                          }))
                        }
                        className="col-span-1 flex justify-center text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-300"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Modifiers / Add-ons */}
            <div className="border-t border-slate-100 dark:border-slate-800/80 pt-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">Add-ons &amp; Modifiers</span>
                <button
                  type="button"
                  onClick={() =>
                    setEditProdForm((f) => ({
                      ...f,
                      modifiers: [...f.modifiers, { groupName: 'Add-ons', name: '', priceDelta: '0' }],
                    }))
                  }
                  className="text-xs font-medium text-slate-900 dark:text-slate-50 hover:underline"
                >
                  + Add Modifier
                </button>
              </div>
              {editProdForm.modifiers.length === 0 ? (
                <p className="text-[11px] text-slate-500 dark:text-slate-400">No modifiers configured.</p>
              ) : (
                <div className="space-y-1.5">
                  <div className="grid grid-cols-12 gap-2 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                    <span className="col-span-4">Group</span>
                    <span className="col-span-5">Modifier Name</span>
                    <span className="col-span-2 text-right">+Price</span>
                    <span className="col-span-1" />
                  </div>
                  {editProdForm.modifiers.map((m, idx) => (
                    <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                      <input
                        aria-label="Modifier Group"
                        placeholder="Group (e.g. Add-ons)"
                        value={m.groupName}
                        onChange={(e) =>
                          setEditProdForm((f) => ({
                            ...f,
                            modifiers: f.modifiers.map((x, i) => (i === idx ? { ...x, groupName: e.target.value } : x)),
                          }))
                        }
                        className="col-span-4 rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-1.5 text-xs"
                      />
                      <input
                        aria-label="Modifier Name"
                        placeholder="Modifier Name"
                        value={m.name}
                        onChange={(e) =>
                          setEditProdForm((f) => ({
                            ...f,
                            modifiers: f.modifiers.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x)),
                          }))
                        }
                        className="col-span-5 rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-1.5 text-xs"
                      />
                      <input
                        type="number"
                        step="0.01"
                        aria-label="Modifier Price Delta"
                        placeholder="+Price"
                        value={m.priceDelta}
                        onChange={(e) =>
                          setEditProdForm((f) => ({
                            ...f,
                            modifiers: f.modifiers.map((x, i) => (i === idx ? { ...x, priceDelta: e.target.value } : x)),
                          }))
                        }
                        className="col-span-2 rounded-lg border border-slate-200 dark:border-slate-800 px-2 py-1.5 text-xs font-mono text-right"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setEditProdForm((f) => ({
                            ...f,
                            modifiers: f.modifiers.filter((_, i) => i !== idx),
                          }))
                        }
                        className="col-span-1 flex justify-center text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-300"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-100 dark:border-slate-800/80">
              <button
                type="button"
                onClick={() => {
                  setErr('');
                  setCatEditor(null);
                  setEditingProd(null);
                }}
                className="px-4 py-2 rounded-lg border text-xs"
              >
                Cancel
              </button>
              <button type="submit" disabled={savingEdit} className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 text-xs font-semibold hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50">
                {savingEdit ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </form>
        </div>
      )}

      {bomModal && selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form onSubmit={submitBomIngredient} className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 p-5 space-y-4 border border-slate-200 dark:border-slate-800">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800/80 pb-3">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">
                  {bomModal.mode === 'add' ? 'Add Recipe Ingredient' : 'Edit Recipe Ingredient'}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">Bill of Materials for {selected.name}</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setErr('');
                  setIngEditor(null);
                  setBomModal(null);
                }}
                className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {err && <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">{err}</div>}

            <div>
              <div className="flex items-center justify-between gap-2 mb-1">
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">Ingredient / Raw Material</label>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={openIngAdd}
                    className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    <Plus className="w-3 h-3" /> Add
                  </button>
                  <button
                    type="button"
                    disabled={!bomForm.inventoryItemId}
                    onClick={() => openIngEdit(bomForm.inventoryItemId)}
                    className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40"
                  >
                    <Pencil className="w-3 h-3" /> Edit
                  </button>
                  <button
                    type="button"
                    disabled={!bomForm.inventoryItemId}
                    onClick={() => openIngDelete(bomForm.inventoryItemId)}
                    className="inline-flex items-center gap-1 rounded border border-red-200 dark:border-red-800/80 bg-white dark:bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/70 disabled:opacity-40"
                  >
                    <Trash2 className="w-3 h-3" /> Delete
                  </button>
                </div>
              </div>
              <select
                value={bomForm.inventoryItemId}
                onChange={(e) => {
                  const nextItem = inventoryItems.find((it) => it.id === e.target.value);
                  setBomForm((f) => ({
                    ...f,
                    inventoryItemId: e.target.value,
                    uomId: nextItem?.base_uom_id || f.uomId,
                  }));
                }}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
              >
                {inventoryItems.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.name} ({it.uom_code})
                  </option>
                ))}
              </select>
            </div>

            {ingEditor && (
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 p-3 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                    {ingEditor.mode === 'add'
                      ? 'Add New Ingredient / Raw Material'
                      : ingEditor.mode === 'edit'
                      ? 'Edit Selected Ingredient / Raw Material'
                      : `Delete "${ingEditor.name}"?`}
                  </span>
                  <button
                    type="button"
                    onClick={() => setIngEditor(null)}
                    className="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100"
                  >
                    Cancel
                  </button>
                </div>

                {ingEditor.mode === 'delete' ? (
                  <div className="space-y-2">
                    <p className="text-[11px] text-slate-600 dark:text-slate-300">
                      This permanently removes the raw material from inventory master data if it is not used in recipes or stock history.
                    </p>
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setIngEditor(null)}
                        className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs text-slate-700 dark:text-slate-200"
                      >
                        Keep
                      </button>
                      <button
                        type="button"
                        disabled={savingIng}
                        onClick={saveIngEditor}
                        className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-40"
                      >
                        {savingIng ? 'Deleting...' : 'Confirm Delete'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-0.5">Name</label>
                        <input
                          placeholder="e.g. Pork Belly Slab"
                          value={ingEditor.name}
                          onChange={(e) => setIngEditor({ ...ingEditor, name: e.target.value })}
                          className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-0.5">SKU</label>
                        <input
                          placeholder="Auto if blank"
                          value={ingEditor.sku}
                          onChange={(e) => setIngEditor({ ...ingEditor, sku: e.target.value })}
                          className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-mono"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-0.5">Base UOM</label>
                        <select
                          value={ingEditor.baseUomId}
                          onChange={(e) => setIngEditor({ ...ingEditor, baseUomId: e.target.value })}
                          className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-1.5 text-xs"
                        >
                          {uoms.map((u) => (
                            <option key={u.id} value={u.id}>{u.code}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-0.5">Unit Cost (PHP)</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={ingEditor.lastUnitCost}
                          onChange={(e) => setIngEditor({ ...ingEditor, lastUnitCost: e.target.value })}
                          className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-mono text-right"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-0.5">Type</label>
                        <select
                          value={ingEditor.itemType}
                          onChange={(e) => setIngEditor({ ...ingEditor, itemType: e.target.value })}
                          className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-1.5 text-xs"
                        >
                          <option value="RAW_MATERIAL">Raw Material</option>
                          <option value="PACKAGING">Packaging</option>
                          <option value="FINISHED_GOOD">Finished Good</option>
                        </select>
                      </div>
                    </div>
                    <div className="flex justify-end">
                      <button
                        type="button"
                        disabled={savingIng || !ingEditor.name.trim()}
                        onClick={saveIngEditor}
                        className="rounded-lg bg-slate-900 dark:bg-slate-100 px-3.5 py-1.5 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white disabled:opacity-40"
                      >
                        {savingIng ? 'Saving...' : ingEditor.mode === 'add' ? 'Create Ingredient' : 'Save Ingredient'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Quantity</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  value={bomForm.quantity}
                  onChange={(e) => setBomForm({ ...bomForm, quantity: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono text-right"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Unit (UOM)</label>
                <select
                  value={bomForm.uomId}
                  onChange={(e) => setBomForm({ ...bomForm, uomId: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-2.5 py-2 text-xs"
                >
                  {getCompatibleUoms(bomForm.inventoryItemId).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.code}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Waste %</label>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  value={bomForm.wasteFactorPct}
                  onChange={(e) => setBomForm({ ...bomForm, wasteFactorPct: e.target.value })}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-mono text-right"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800/80">
              <button
                type="button"
                onClick={() => {
                  setErr('');
                  setIngEditor(null);
                  setBomModal(null);
                }}
                className="px-4 py-2 rounded-lg border text-xs"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingBom}
                className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-950 text-xs font-semibold hover:bg-slate-800 dark:hover:bg-white disabled:opacity-50"
              >
                {savingBom ? 'Saving...' : bomModal.mode === 'add' ? 'Add to BOM' : 'Save Ingredient'}
              </button>
            </div>
          </form>
        </div>
      )}
      {showCategoriesModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl bg-white dark:bg-slate-900 p-5 space-y-4 border border-slate-200 dark:border-slate-800">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800/80 pb-3">
              <div>
                <h3 className="font-display text-base font-semibold text-slate-900 dark:text-slate-50">Menu Categories</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">Create or edit categories and control POS menu visibility</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setErr('');
                  setCatEditor(null);
                  setShowCategoriesModal(false);
                }}
                className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {err && <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/80 text-xs text-red-700 dark:text-red-300 font-medium">{err}</div>}

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => openCatAdd('categoriesModal')}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-slate-100 px-3 py-1.5 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white"
              >
                <Plus className="w-3.5 h-3.5" /> Add Category
              </button>
            </div>

            {catEditor && catEditor.target === 'categoriesModal' && (
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 p-3.5 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                    {catEditor.mode === 'add' ? 'Create Category' : 'Edit Category'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setCatEditor(null)}
                    className="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100"
                  >
                    Cancel
                  </button>
                </div>
                <div className="flex flex-wrap sm:flex-nowrap items-end gap-2">
                  <div className="flex-1 min-w-[160px]">
                    <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Category Name *</label>
                    <input
                      placeholder="e.g. Grilled Platters"
                      value={catEditor.name}
                      onChange={(e) => setCatEditor({ ...catEditor, name: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs"
                    />
                  </div>
                  <div className="w-20">
                    <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Sort Order</label>
                    <input
                      type="number"
                      placeholder="Order"
                      value={catEditor.sortOrder}
                      onChange={(e) => setCatEditor({ ...catEditor, sortOrder: e.target.value })}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-mono text-right"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={savingCat || !catEditor.name.trim()}
                    onClick={saveCategory}
                    className="rounded-lg bg-slate-900 dark:bg-slate-100 px-3.5 py-1.5 text-xs font-semibold text-white dark:text-slate-950 hover:bg-slate-800 dark:hover:bg-white disabled:opacity-40 whitespace-nowrap"
                  >
                    {savingCat ? 'Saving...' : catEditor.mode === 'add' ? 'Create' : 'Save'}
                  </button>
                </div>
                <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={catEditor.showInPos}
                    onChange={(e) => setCatEditor({ ...catEditor, showInPos: e.target.checked })}
                  />
                  Available to view in POS
                </label>
              </div>
            )}

            <div className="rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/70 text-slate-500 dark:text-slate-400">
                  <tr>
                    <th className="p-2.5 font-medium">Category Name</th>
                    <th className="p-2.5 font-medium text-right">Order</th>
                    <th className="p-2.5 font-medium">POS Visibility</th>
                    <th className="p-2.5 font-medium text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {categories.map((c) => (
                    <tr key={c.id} className="hover:bg-slate-50 dark:hover:bg-slate-800">
                      <td className="p-2.5 font-semibold text-slate-900 dark:text-slate-50">{c.name}</td>
                      <td className="p-2.5 text-right font-mono text-slate-600 dark:text-slate-300">{c.sort_order}</td>
                      <td className="p-2.5">
                        <span className={`font-semibold ${c.show_in_pos !== false ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-500 dark:text-slate-400'}`}>
                          {c.show_in_pos !== false ? 'Visible in POS' : 'Hidden in POS'}
                        </span>
                      </td>
                      <td className="p-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => openCatEdit('categoriesModal', c.id)}
                          className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <Pencil className="w-3 h-3" /> Edit
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={() => {
                  setErr('');
                  setCatEditor(null);
                  setShowCategoriesModal(false);
                }}
                className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
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
