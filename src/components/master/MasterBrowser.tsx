"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { CategoryIcon, CheckIcon, ShopIcon } from "@/components/FilterSheet";
import { LanguageToggle } from "@/components/LanguageToggle";
import { Sheet } from "@/components/Sheet";
import { SizeField } from "@/components/SizeField";
import { SizePill } from "@/components/SizePill";
import { Stepper } from "@/components/Stepper";
import {
  createShop,
  deleteCategory,
  deleteMasterItem,
  deleteShop,
  fillTanglishNames,
  fixKnownTranslations,
  renameShop,
  setMasterItemActive,
  updateCategory,
  upsertMasterItem,
} from "@/lib/actions";
import { useAdmin } from "@/lib/admin-context";
import { displayName, useLanguage } from "@/lib/language";
import {
  UNIT_TYPES,
  formatNameWithSize,
  formatPrice,
  formatQty,
  formatQtyWithSize,
  normalizeQty,
  projectPrice,
  sizeOf,
  totalAmount,
  unitOptionLabel,
  type UnitType,
} from "@/lib/units";
import type { CategoryDTO, MasterItemDTO, ShopDTO } from "@/lib/types";

type MasterBrowserProps = {
  items: MasterItemDTO[];
  categories: CategoryDTO[];
  shops: ShopDTO[];
};

type Draft = {
  id?: number;
  nameEn: string;
  nameTa: string;
  nameTl: string;
  categoryId: number;
  unitType: UnitType;
  shopId: number | null;
  defaultQty: number;
  isActive: boolean;
  /** Pack size, for countable items sold in packs. Null when sold loose. */
  sizeValue: number | null;
  sizeUnit: UnitType | null;
};

/**
 * What this item costs at the quantity it is normally bought in, worked out
 * from the last price paid.
 *
 * The raw last price answers a question nobody asked: ₹660 meant three
 * kilos of coriander that month, which tells you nothing about the kilo you
 * put on next month's list. Projected onto the default quantity — the same
 * arithmetic every price comparison uses — it reads as ₹220 for 1 kg.
 *
 * `forDefault` is false when the two cannot be converted (a weight against
 * a count, after someone changed the unit type), in which case the price is
 * the raw one and `amount` says what it actually bought, so the row is
 * never quietly wrong.
 */
function lastPriceAt(
  item: MasterItemDTO,
): { price: number; amount: string; forDefault: boolean } | null {
  if (item.lastPrice === null || item.lastPriceQuantity === null || item.lastPriceUnitType === null) {
    return null;
  }
  const paid = totalAmount(
    item.lastPriceQuantity,
    item.lastPriceUnitType,
    sizeOf(item.lastPriceSizeValue, item.lastPriceSizeUnit),
  );
  const wanted = totalAmount(item.defaultQty, item.unitType, sizeOf(item.sizeValue, item.sizeUnit));
  const projected = projectPrice(
    item.lastPrice,
    paid.quantity,
    paid.unit,
    wanted.quantity,
    wanted.unit,
  );
  if (projected === null) {
    return {
      price: item.lastPrice,
      amount: formatQtyWithSize(
        item.lastPriceQuantity,
        item.lastPriceUnitType,
        sizeOf(item.lastPriceSizeValue, item.lastPriceSizeUnit),
      ),
      forDefault: false,
    };
  }
  return {
    price: Math.round(projected * 100) / 100,
    amount: formatQtyWithSize(item.defaultQty, item.unitType, sizeOf(item.sizeValue, item.sizeUnit)),
    forDefault: true,
  };
}

/** True when the Tamil name was never actually set — it's just a copy of the English name. */
function needsTamil(item: MasterItemDTO): boolean {
  return item.nameTa.trim().toLowerCase() === item.nameEn.trim().toLowerCase();
}

/** True when nobody has supplied a Tanglish name for this item yet. */
function needsTanglish(item: MasterItemDTO): boolean {
  return !item.nameTl?.trim();
}

export function MasterBrowser({ items, categories, shops }: MasterBrowserProps) {
  const router = useRouter();
  const { language } = useLanguage();
  const { isAdmin } = useAdmin();
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [needsTamilOnly, setNeedsTamilOnly] = useState(false);
  const [needsTanglishOnly, setNeedsTanglishOnly] = useState(false);
  const [autoFixMessage, setAutoFixMessage] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false);
  const [viewing, setViewing] = useState<MasterItemDTO | null>(null);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [categoryDrafts, setCategoryDrafts] = useState<
    Record<number, { nameEn: string; nameTa: string }>
  >({});
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [shopsOpen, setShopsOpen] = useState(false);
  const [shopDrafts, setShopDrafts] = useState<Record<number, string>>({});
  const [newShopName, setNewShopName] = useState("");
  const [shopError, setShopError] = useState<string | null>(null);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const trimmed = query.trim();
    const matches = items.filter((item) => {
      if (categoryId && item.categoryId !== categoryId) return false;
      if (needsTamilOnly && !needsTamil(item)) return false;
      if (needsTanglishOnly && !needsTanglish(item)) return false;
      if (!needle) return true;
      return (
        item.nameEn.toLowerCase().includes(needle) ||
        item.nameTa.includes(trimmed) ||
        (item.nameTl ?? "").toLowerCase().includes(needle) ||
        item.categoryName.toLowerCase().includes(needle) ||
        (item.categoryNameTa ?? "").includes(trimmed) ||
        (item.shopName ?? "").toLowerCase().includes(needle)
      );
    });

    // Grouped by category id (stable across a language switch), labeled in
    // whichever language is currently selected.
    const grouped = new Map<number, { label: string; items: MasterItemDTO[] }>();
    for (const item of matches) {
      const label = language === "ta" ? (item.categoryNameTa ?? item.categoryName) : item.categoryName;
      const existing = grouped.get(item.categoryId);
      if (existing) existing.items.push(item);
      else grouped.set(item.categoryId, { label, items: [item] });
    }
    return [...grouped.entries()];
  }, [items, query, categoryId, needsTamilOnly, needsTanglishOnly, language]);

  const categoryLabel = (category: CategoryDTO) =>
    language === "ta" ? (category.nameTa ?? category.nameEn) : category.nameEn;
  const selectedCategory = categories.find((category) => category.id === categoryId) ?? null;
  const shownCount = groups.reduce((sum, [, group]) => sum + group.items.length, 0);

  const needsTamilCount = useMemo(() => items.filter(needsTamil).length, [items]);
  const needsTanglishCount = useMemo(() => items.filter(needsTanglish).length, [items]);

  const categoryItemCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const item of items) {
      counts.set(item.categoryId, (counts.get(item.categoryId) ?? 0) + 1);
    }
    return counts;
  }, [items]);

  const shopItemCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const item of items) {
      if (item.shopId !== null) counts.set(item.shopId, (counts.get(item.shopId) ?? 0) + 1);
    }
    return counts;
  }, [items]);

  const startNew = () =>
    setDraft({
      nameEn: "",
      nameTa: "",
      nameTl: "",
      categoryId: categoryId ?? categories[0]?.id ?? 0,
      unitType: "COUNT",
      shopId: null,
      defaultQty: 1,
      isActive: true,
      sizeValue: null,
      sizeUnit: null,
    });

  const startEdit = (item: MasterItemDTO) =>
    setDraft({
      id: item.id,
      nameEn: item.nameEn,
      nameTa: item.nameTa,
      nameTl: item.nameTl ?? "",
      categoryId: item.categoryId,
      unitType: item.unitType,
      shopId: item.shopId,
      defaultQty: item.defaultQty || 1,
      isActive: item.isActive,
      sizeValue: item.sizeValue,
      sizeUnit: item.sizeUnit,
    });

  const save = () => {
    if (!draft) return;
    setError(null);
    startTransition(async () => {
      const result = await upsertMasterItem(draft);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDraft(null);
      router.refresh();
    });
  };

  const toggleActive = (item: MasterItemDTO) => {
    startTransition(async () => {
      await setMasterItemActive(item.id, !item.isActive);
      router.refresh();
    });
  };

  const remove = (item: MasterItemDTO) => {
    if (!window.confirm(`Delete "${item.nameEn}" from the master list? This can't be undone.`)) {
      return;
    }
    startTransition(async () => {
      const result = await deleteMasterItem(item.id);
      setDraft(null);
      if (result.ok && !result.data.deleted) {
        window.alert(
          `"${item.nameEn}" is used in a past list, so it was hidden from search instead of permanently deleted.`,
        );
      }
      router.refresh();
    });
  };

  const removeCategory = (category: CategoryDTO) => {
    if (!window.confirm(`Delete the "${category.nameEn}" category? This can't be undone.`)) {
      return;
    }
    setCategoryError(null);
    startTransition(async () => {
      const result = await deleteCategory(category.id);
      if (!result.ok) {
        setCategoryError(result.error);
        return;
      }
      router.refresh();
    });
  };

  const openCategories = () => {
    setCategoryError(null);
    setCategoryDrafts(
      Object.fromEntries(
        categories.map((category) => [
          category.id,
          { nameEn: category.nameEn, nameTa: category.nameTa ?? "" },
        ]),
      ),
    );
    setCategoriesOpen(true);
  };

  const openShops = () => {
    setShopError(null);
    setNewShopName("");
    setShopDrafts(Object.fromEntries(shops.map((shop) => [shop.id, shop.name])));
    setShopsOpen(true);
  };

  const addShop = () => {
    const name = newShopName.trim();
    if (!name) return;
    if (shops.some((shop) => shop.name.toLowerCase() === name.toLowerCase())) {
      setShopError(`"${name}" already exists.`);
      return;
    }
    setShopError(null);
    startTransition(async () => {
      const result = await createShop(name);
      if (!result.ok) {
        setShopError(result.error);
        return;
      }
      setNewShopName("");
      setShopDrafts((prev) => ({ ...prev, [result.data.id]: name }));
      router.refresh();
    });
  };

  const saveShop = (shopId: number) => {
    const name = shopDrafts[shopId];
    if (name === undefined) return;
    setShopError(null);
    startTransition(async () => {
      const result = await renameShop({ id: shopId, name });
      if (!result.ok) {
        setShopError(result.error);
        return;
      }
      router.refresh();
    });
  };

  const removeShop = (shop: ShopDTO) => {
    if (!window.confirm(`Delete the shop "${shop.name}"? This can't be undone.`)) return;
    setShopError(null);
    startTransition(async () => {
      const result = await deleteShop(shop.id);
      if (!result.ok) {
        setShopError(result.error);
        return;
      }
      router.refresh();
    });
  };

  const runAutoFix = () => {
    setAutoFixMessage(null);
    startTransition(async () => {
      const result = await fixKnownTranslations();
      if (!result.ok) {
        setAutoFixMessage(result.error);
        return;
      }
      const { fixed, remaining } = result.data;
      setAutoFixMessage(
        remaining > 0
          ? `Fixed ${fixed}. ${remaining} left with no known match — edit those by hand.`
          : `Fixed ${fixed}. All caught up.`,
      );
      router.refresh();
    });
  };

  const runTanglishFill = () => {
    setAutoFixMessage(null);
    startTransition(async () => {
      const result = await fillTanglishNames();
      if (!result.ok) {
        setAutoFixMessage(result.error);
        return;
      }
      const { fromSpreadsheet, transliterated, remaining } = result.data;
      const filled = fromSpreadsheet + transliterated;
      setAutoFixMessage(
        `Filled ${filled} Tanglish name${filled === 1 ? "" : "s"} ` +
          `(${fromSpreadsheet} from the spreadsheet, ${transliterated} transliterated).` +
          (remaining > 0 ? ` ${remaining} still need one by hand.` : ""),
      );
      router.refresh();
    });
  };

  const saveCategory = (categoryId: number) => {
    const categoryDraft = categoryDrafts[categoryId];
    if (!categoryDraft) return;
    setCategoryError(null);
    startTransition(async () => {
      const result = await updateCategory({
        id: categoryId,
        nameEn: categoryDraft.nameEn,
        nameTa: categoryDraft.nameTa,
      });
      if (!result.ok) {
        setCategoryError(result.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="space-y-5">
      {/* Everything that used to sit above the list — a row of category
          pills you had to scroll sideways through, and a full-width "new
          item" button — is an icon up here instead, so the list itself
          starts at the top of the screen. */}
      <header className="flex items-end justify-between gap-3 pt-2">
        <div className="min-w-0">
          <h1 className="truncate text-[34px] font-bold leading-tight tracking-tight">
            Master List
          </h1>
          <p className="truncate text-[15px] text-ios-label-2">
            {selectedCategory
              ? `${shownCount} in ${categoryLabel(selectedCategory)}`
              : `${items.length} items · ${categories.length} categories`}
          </p>
        </div>
        <div className="flex flex-none items-center gap-2">
          <button
            type="button"
            onClick={() => setCategoryPickerOpen(true)}
            aria-label={
              selectedCategory
                ? `Category: ${categoryLabel(selectedCategory)} — change or clear`
                : "Filter by category"
            }
            title="Category"
            className={`flex h-9 w-9 flex-none items-center justify-center rounded-full shadow-ios transition active:scale-95 ${
              selectedCategory ? "bg-ios-blue text-white" : "bg-ios-surface text-ios-blue"
            }`}
          >
            <CategoryIcon />
          </button>
          <button
            type="button"
            onClick={openShops}
            aria-label="Manage shops"
            title="Shops"
            className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-ios-surface text-ios-blue shadow-ios transition active:scale-95"
          >
            <ShopIcon />
          </button>
          <button
            type="button"
            onClick={startNew}
            aria-label="New master item"
            title="New master item"
            className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-ios-blue text-white shadow-ios transition active:scale-95"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
              <path
                d="M12 6v12M6 12h12"
                stroke="currentColor"
                strokeWidth="2.25"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <LanguageToggle />
        </div>
      </header>

      <div className="space-y-3">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search items, categories or shops"
          className="h-11 w-full rounded-ios bg-ios-surface px-4 text-[17px] shadow-ios outline-none focus:ring-2 focus:ring-ios-blue"
        />

        {needsTamilCount > 0 || needsTanglishCount > 0 || isAdmin ? (
          <div className="flex flex-wrap items-center gap-2">
            {needsTamilCount > 0 ? (
              <FilterChip active={needsTamilOnly} onClick={() => setNeedsTamilOnly((v) => !v)} tone="warning">
                Needs Tamil name · {needsTamilCount}
              </FilterChip>
            ) : null}
            {needsTanglishCount > 0 ? (
              <FilterChip
                active={needsTanglishOnly}
                onClick={() => setNeedsTanglishOnly((v) => !v)}
                tone="warning"
              >
                Needs Tanglish · {needsTanglishCount}
              </FilterChip>
            ) : null}
            {isAdmin ? (
              <button
                type="button"
                onClick={runAutoFix}
                disabled={pending}
                title="Also corrects Tamil names that already have text but don't match the spreadsheet"
                className="h-9 flex-none rounded-full bg-ios-surface px-4 text-[14px] font-medium text-ios-blue shadow-ios transition active:scale-95 disabled:opacity-50"
              >
                Auto-fix known names
              </button>
            ) : null}
            {isAdmin && needsTanglishCount > 0 ? (
              <button
                type="button"
                onClick={runTanglishFill}
                disabled={pending}
                title="Uses the spreadsheet's Tanglish column, and transliterates the Tamil name for anything it doesn't cover"
                className="h-9 flex-none rounded-full bg-ios-surface px-4 text-[14px] font-medium text-ios-blue shadow-ios transition active:scale-95 disabled:opacity-50"
              >
                Fill Tanglish names
              </button>
            ) : null}
          </div>
        ) : null}
        {autoFixMessage ? <p className="text-[13px] text-ios-label-2">{autoFixMessage}</p> : null}
      </div>

      {groups.length === 0 ? (
        <p className="ios-card p-6 text-center text-[15px] text-ios-label-2">No items matched.</p>
      ) : (
        groups.map(([categoryId, group]) => (
          <section key={categoryId}>
            <p className="px-1 pb-1.5 text-[13px] font-semibold uppercase tracking-wide text-ios-label-3">
              {group.label} · {group.items.length}
            </p>
            <ul className="ios-card divide-y divide-ios-separator overflow-hidden">
              {group.items.map((item) => {
                const name = displayName(item, language);
                const price = lastPriceAt(item);
                return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => setViewing(item)}
                    className="ios-row w-full text-left active:bg-ios-surface-2"
                  >
                    <span className="min-w-0 flex-1">
                      {/* The size rides with the name, as it does on every
                          list screen — beside it, not in the subtitle, where
                          a long name and a shop push it past the truncation
                          and the one thing you match against the shelf is
                          the first thing to disappear. */}
                      <span className="flex items-center gap-2">
                        <span
                          className={`truncate text-[16px] font-medium ${
                            item.isActive ? "" : "text-ios-label-3 line-through"
                          }`}
                        >
                          {name.primary}
                        </span>
                        <SizePill
                          size={sizeOf(item.sizeValue, item.sizeUnit)}
                          dimmed={!item.isActive}
                        />
                      </span>
                      <span className="block truncate text-[13px] text-ios-label-2">
                        {name.secondary} · {unitOptionLabel(item.unitType)}
                        {item.shopName ? ` · ${item.shopName}` : ""}
                        {needsTamil(item) ? (
                          <span className="ml-1.5 rounded-full bg-ios-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-ios-orange ring-1 ring-inset ring-ios-separator">
                            Needs Tamil
                          </span>
                        ) : null}
                        {needsTanglish(item) ? (
                          <span className="ml-1.5 rounded-full bg-ios-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-ios-orange ring-1 ring-inset ring-ios-separator">
                            Needs Tanglish
                          </span>
                        ) : null}
                      </span>
                    </span>
                    {/* The price of one default quantity — what putting this
                        on next month's list would cost — over the amount it
                        is for, so the figure is never read against the wrong
                        measure. */}
                    {price ? (
                      <span className="flex-none text-right">
                        <span className="block text-[15px] font-semibold tabular-nums">
                          {formatPrice(price.price)}
                        </span>
                        <span className="block text-[12px] text-ios-label-3">{price.amount}</span>
                      </span>
                    ) : (
                      <span className="flex-none text-[12px] text-ios-label-3">Not bought yet</span>
                    )}
                  </button>
                </li>
                );
              })}
            </ul>
          </section>
        ))
      )}

      {/* Opening an item shows it, rather than dropping you into a form:
          most taps are to check what something is, or what it last cost,
          and an editable field invites a change that was never intended.
          Edit is one tap further in. */}
      <Sheet
        open={viewing !== null}
        onClose={() => setViewing(null)}
        title={
          viewing
            ? formatNameWithSize(
                displayName(viewing, language).primary,
                sizeOf(viewing.sizeValue, viewing.sizeUnit),
              )
            : ""
        }
        subtitle={
          viewing
            ? [displayName(viewing, language).secondary, viewing.categoryName]
                .filter(Boolean)
                .join(" · ")
            : undefined
        }
        footer={
          viewing ? (
            <button
              type="button"
              onClick={() => {
                const item = viewing;
                setViewing(null);
                startEdit(item);
              }}
              className="flex h-12 w-full items-center justify-center rounded-ios bg-ios-blue text-[17px] font-semibold text-white transition active:scale-[0.98]"
            >
              Edit item
            </button>
          ) : undefined
        }
      >
        {viewing ? <ItemView item={viewing} /> : null}
      </Sheet>

      {/* One sheet for the whole of "category": pick one to filter by, and
          the door to renaming them, which is the other thing you come to a
          category list to do. */}
      <Sheet
        open={categoryPickerOpen}
        onClose={() => setCategoryPickerOpen(false)}
        title="Category"
      >
        <ul className="divide-y divide-ios-separator pb-2">
          {[null, ...categories].map((category) => {
            const isSelected = (category?.id ?? null) === categoryId;
            return (
              <li key={category?.id ?? "all"}>
                <button
                  type="button"
                  onClick={() => {
                    setCategoryId(category?.id ?? null);
                    setCategoryPickerOpen(false);
                  }}
                  className="ios-row w-full text-left active:bg-ios-surface-2"
                >
                  <span
                    className={`min-w-0 flex-1 truncate text-[16px] ${
                      isSelected ? "font-semibold text-ios-blue" : ""
                    }`}
                  >
                    {category ? categoryLabel(category) : "All categories"}
                  </span>
                  <span className="flex-none text-[14px] tabular-nums text-ios-label-3">
                    {category ? (categoryItemCounts.get(category.id) ?? 0) : items.length}
                  </span>
                  <span className="flex h-5 w-5 flex-none items-center justify-center text-ios-blue">
                    {isSelected ? <CheckIcon /> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          onClick={() => {
            setCategoryPickerOpen(false);
            openCategories();
          }}
          className="mb-2 flex h-11 w-full items-center justify-center rounded-ios bg-ios-surface-2 text-[16px] font-medium text-ios-blue ring-1 ring-inset ring-ios-separator active:scale-[0.99]"
        >
          Manage categories
        </button>
      </Sheet>

      <Sheet
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.id ? "Edit item" : "New master item"}
        subtitle="Stored in your master database and reusable every month."
        footer={
          <button
            type="button"
            onClick={save}
            disabled={pending}
            className="flex h-12 w-full items-center justify-center rounded-ios bg-ios-blue text-[17px] font-semibold text-white transition active:scale-[0.98] disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save item"}
          </button>
        }
      >
        {draft ? (
          <div className="space-y-4 pb-3">
            <Field label="Tamil name (Grocery)">
              <input
                value={draft.nameTa}
                onChange={(event) => setDraft({ ...draft, nameTa: event.target.value })}
                placeholder="துவரம் பருப்பு"
                className="h-12 w-full rounded-ios bg-ios-surface-2 px-4 text-[17px] outline-none ring-1 ring-inset ring-ios-separator focus:ring-2 focus:ring-ios-blue"
              />
            </Field>

            <Field label="Tanglish name (Tamil in English letters)">
              <input
                value={draft.nameTl}
                onChange={(event) => setDraft({ ...draft, nameTl: event.target.value })}
                placeholder="Thuvaram Paruppu"
                className="h-12 w-full rounded-ios bg-ios-surface-2 px-4 text-[17px] outline-none ring-1 ring-inset ring-ios-separator focus:ring-2 focus:ring-ios-blue"
              />
              <p className="pt-1.5 text-[12px] text-ios-label-3">
                Leave blank to keep whatever is already saved — or, on a new item,
                to have one worked out from the Tamil name above.
              </p>
            </Field>

            <Field label="English name (Grocery.1)">
              <input
                value={draft.nameEn}
                onChange={(event) => setDraft({ ...draft, nameEn: event.target.value })}
                placeholder="Toor Dal"
                className="h-12 w-full rounded-ios bg-ios-surface-2 px-4 text-[17px] outline-none ring-1 ring-inset ring-ios-separator focus:ring-2 focus:ring-ios-blue"
              />
            </Field>

            <Field label="Category (Type)">
              <select
                value={draft.categoryId}
                onChange={(event) => setDraft({ ...draft, categoryId: Number(event.target.value) })}
                className="h-12 w-full rounded-ios bg-ios-surface-2 px-3 text-[17px] outline-none ring-1 ring-inset ring-ios-separator focus:ring-2 focus:ring-ios-blue"
              >
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.nameTa ? `${category.nameTa} / ` : ""}
                    {category.nameEn}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Unit type (Qty Type)">
              <div className="flex flex-wrap gap-2">
                {UNIT_TYPES.map((unit) => (
                  <button
                    key={unit}
                    type="button"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        unitType: unit,
                        defaultQty: normalizeQty(draft.defaultQty, unit),
                        // A size only means something when the quantity counts
                        // packs; measured items carry their amount already.
                        ...(unit === "COUNT" ? {} : { sizeValue: null, sizeUnit: null }),
                      })
                    }
                    className={`h-10 rounded-full px-4 text-[15px] font-medium transition active:scale-95 ${
                      draft.unitType === unit
                        ? "bg-ios-blue text-white"
                        : "bg-ios-surface-2 text-ios-label-2 ring-1 ring-inset ring-ios-separator"
                    }`}
                  >
                    {unitOptionLabel(unit)}
                  </button>
                ))}
              </div>
            </Field>

            <Field label={`Default quantity (${formatQty(draft.defaultQty, draft.unitType)})`}>
              <Stepper
                value={draft.defaultQty}
                unit={draft.unitType}
                onChange={(defaultQty, unitType) => setDraft({ ...draft, defaultQty, unitType })}
              />
            </Field>

            <Field
              label={`Size${
                sizeOf(draft.sizeValue, draft.sizeUnit)
                  ? ` (${formatQty(draft.sizeValue as number, draft.sizeUnit as UnitType)})`
                  : ""
              }`}
            >
              {draft.unitType === "COUNT" ? (
                <>
                  <SizeField
                    value={draft.sizeValue}
                    unit={draft.sizeUnit}
                    clearable
                    onChange={(sizeValue, sizeUnit) => setDraft({ ...draft, sizeValue, sizeUnit })}
                    aria-label="Size of one pack"
                  />
                  <p className="pt-1.5 text-[12px] text-ios-label-3">
                    What one comes in — a 200 g paste, a 500 ml bottle. The
                    quantity above stays the number of packs, and the size is
                    what you change while shopping when the shop only has 150 g.
                  </p>
                </>
              ) : (
                <p className="text-[12px] text-ios-label-3">
                  Items measured in {unitOptionLabel(draft.unitType)} carry their
                  amount in the quantity already. Switch Unit type to Countable
                  to give this item a pack size.
                </p>
              )}
            </Field>

            <Field label="Shop by (From)">
              <div className="flex flex-wrap gap-2">
                {shops.map((shop) => (
                  <button
                    key={shop.id}
                    type="button"
                    onClick={() => setDraft({ ...draft, shopId: shop.id })}
                    className={`h-10 rounded-full px-4 text-[15px] font-medium transition active:scale-95 ${
                      draft.shopId === shop.id
                        ? "bg-ios-blue text-white"
                        : "bg-ios-surface-2 text-ios-label-2 ring-1 ring-inset ring-ios-separator"
                    }`}
                  >
                    {shop.name}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, shopId: null })}
                  className={`h-10 rounded-full px-4 text-[15px] font-medium transition active:scale-95 ${
                    draft.shopId === null
                      ? "bg-ios-blue text-white"
                      : "bg-ios-surface-2 text-ios-label-2 ring-1 ring-inset ring-ios-separator"
                  }`}
                >
                  Not set
                </button>
              </div>
            </Field>

            {draft.id ? (
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => {
                    const item = items.find((candidate) => candidate.id === draft.id);
                    if (item) toggleActive(item);
                    setDraft(null);
                  }}
                  className="h-11 text-[16px] font-medium text-ios-blue active:opacity-60"
                >
                  {draft.isActive ? "Hide from search" : "Restore to search"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const item = items.find((candidate) => candidate.id === draft.id);
                    if (item) remove(item);
                  }}
                  className="h-11 text-[16px] font-medium text-ios-red active:opacity-60"
                >
                  Delete item
                </button>
              </div>
            ) : null}

            {error ? <p className="text-[14px] text-ios-red">{error}</p> : null}
          </div>
        ) : null}
      </Sheet>

      <Sheet
        open={categoriesOpen}
        onClose={() => setCategoriesOpen(false)}
        title="Categories"
        subtitle="Tamil and English names shown in filter chips, group headers and PDFs. A blank Tamil name is why a category won't switch when you toggle the language."
      >
        <div className="space-y-3 pb-2">
          {categories.map((category) => {
            const categoryDraft = categoryDrafts[category.id] ?? {
              nameEn: category.nameEn,
              nameTa: category.nameTa ?? "",
            };
            const itemCount = categoryItemCounts.get(category.id) ?? 0;
            return (
              <div key={category.id} className="space-y-2 border-b border-ios-separator pb-3">
                <div className="flex items-end gap-2">
                  <label className="min-w-0 flex-1 block">
                    <span className="text-[12px] font-medium text-ios-label-2">Tamil</span>
                    <input
                      value={categoryDraft.nameTa}
                      onChange={(event) =>
                        setCategoryDrafts((prev) => ({
                          ...prev,
                          [category.id]: { ...categoryDraft, nameTa: event.target.value },
                        }))
                      }
                      placeholder="—"
                      className="mt-1 h-10 w-full rounded-ios bg-ios-surface-2 px-3 text-[15px] outline-none ring-1 ring-inset ring-ios-separator focus:ring-2 focus:ring-ios-blue"
                    />
                  </label>
                  <label className="min-w-0 flex-1 block">
                    <span className="text-[12px] font-medium text-ios-label-2">English</span>
                    <input
                      value={categoryDraft.nameEn}
                      onChange={(event) =>
                        setCategoryDrafts((prev) => ({
                          ...prev,
                          [category.id]: { ...categoryDraft, nameEn: event.target.value },
                        }))
                      }
                      className="mt-1 h-10 w-full rounded-ios bg-ios-surface-2 px-3 text-[15px] outline-none ring-1 ring-inset ring-ios-separator focus:ring-2 focus:ring-ios-blue"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => saveCategory(category.id)}
                    disabled={pending}
                    className="h-10 flex-none rounded-full bg-ios-blue px-3 text-[13px] font-semibold text-white transition active:scale-95 disabled:opacity-50"
                  >
                    Save
                  </button>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-ios-label-2">
                    {itemCount} item{itemCount === 1 ? "" : "s"}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeCategory(category)}
                    disabled={pending || itemCount > 0}
                    title={itemCount > 0 ? "Move or delete its items first" : undefined}
                    className="text-[13px] font-medium text-ios-red active:opacity-60 disabled:opacity-40"
                  >
                    Delete category
                  </button>
                </div>
              </div>
            );
          })}

          {categoryError ? <p className="text-[14px] text-ios-red">{categoryError}</p> : null}
        </div>
      </Sheet>

      <Sheet
        open={shopsOpen}
        onClose={() => setShopsOpen(false)}
        title="Shops"
        subtitle="Where items are bought. A shop can only be deleted when no item, list or price history uses it."
      >
        <div className="space-y-3 pb-2">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              addShop();
            }}
            className="flex items-end gap-2 border-b border-ios-separator pb-3"
          >
            <label className="min-w-0 flex-1 block">
              <span className="text-[12px] font-medium text-ios-label-2">New shop</span>
              <input
                value={newShopName}
                onChange={(event) => setNewShopName(event.target.value)}
                placeholder="Shop name"
                className="mt-1 h-10 w-full rounded-ios bg-ios-surface-2 px-3 text-[15px] outline-none ring-1 ring-inset ring-ios-separator focus:ring-2 focus:ring-ios-blue"
              />
            </label>
            <button
              type="submit"
              disabled={pending || !newShopName.trim()}
              className="h-10 flex-none rounded-full bg-ios-blue px-4 text-[13px] font-semibold text-white transition active:scale-95 disabled:opacity-50"
            >
              Add
            </button>
          </form>

          {shops.length === 0 ? (
            <p className="text-[14px] text-ios-label-2">No shops yet.</p>
          ) : null}

          {shops.map((shop) => {
            const name = shopDrafts[shop.id] ?? shop.name;
            const itemCount = shopItemCounts.get(shop.id) ?? 0;
            const changed = name.trim() !== shop.name;
            return (
              <div key={shop.id} className="space-y-2 border-b border-ios-separator pb-3">
                <div className="flex items-center gap-2">
                  <input
                    value={name}
                    onChange={(event) =>
                      setShopDrafts((prev) => ({ ...prev, [shop.id]: event.target.value }))
                    }
                    aria-label={`Name of ${shop.name}`}
                    className="h-10 min-w-0 flex-1 rounded-ios bg-ios-surface-2 px-3 text-[15px] outline-none ring-1 ring-inset ring-ios-separator focus:ring-2 focus:ring-ios-blue"
                  />
                  <button
                    type="button"
                    onClick={() => saveShop(shop.id)}
                    disabled={pending || !changed || !name.trim()}
                    className="h-10 flex-none rounded-full bg-ios-blue px-3 text-[13px] font-semibold text-white transition active:scale-95 disabled:opacity-50"
                  >
                    Rename
                  </button>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-ios-label-2">
                    {itemCount} item{itemCount === 1 ? "" : "s"}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeShop(shop)}
                    disabled={pending || itemCount > 0}
                    title={itemCount > 0 ? "Change these items to another shop first" : undefined}
                    className="text-[13px] font-medium text-ios-red active:opacity-60 disabled:opacity-40"
                  >
                    Delete shop
                  </button>
                </div>
              </div>
            );
          })}

          {shopError ? <p className="text-[14px] text-ios-red">{shopError}</p> : null}
        </div>
      </Sheet>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="pb-1.5 text-[13px] font-medium text-ios-label-2">{label}</p>
      {children}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
  tone = "default",
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  tone?: "default" | "warning";
}) {
  const activeClass = tone === "warning" ? "bg-ios-orange text-white" : "bg-ios-blue text-white";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-9 flex-none rounded-full px-4 text-[14px] font-medium transition active:scale-95 ${
        active ? activeClass : "bg-ios-surface text-ios-label-2 ring-1 ring-inset ring-ios-separator"
      }`}
    >
      {children}
    </button>
  );
}


/** What an item is, and what it last cost — the read-only half of the form. */
function ItemView({ item }: { item: MasterItemDTO }) {
  const price = lastPriceAt(item);
  const size = sizeOf(item.sizeValue, item.sizeUnit);

  return (
    <div className="space-y-4 pb-3">
      <div className="rounded-ios bg-ios-surface-2 p-4 ring-1 ring-inset ring-ios-separator">
        {price ? (
          <>
            <p className="text-[28px] font-semibold leading-none tabular-nums">
              {formatPrice(price.price)}
            </p>
            <p className="mt-1.5 text-[13px] text-ios-label-2">
              {price.forDefault ? "for " : "last paid, for "}
              {price.amount}
              {item.lastPriceShopName ? ` · ${item.lastPriceShopName}` : ""}
            </p>
          </>
        ) : (
          <p className="text-[15px] text-ios-label-2">Never bought yet — no price on record.</p>
        )}
      </div>

      <dl className="divide-y divide-ios-separator overflow-hidden rounded-ios bg-ios-surface-2 ring-1 ring-inset ring-ios-separator">
        <ViewRow label="Tamil name" value={item.nameTa} />
        <ViewRow label="Tanglish name" value={item.nameTl?.trim() || "—"} />
        <ViewRow label="English name" value={item.nameEn} />
        <ViewRow label="Category" value={item.categoryName} />
        <ViewRow label="Unit type" value={unitOptionLabel(item.unitType)} />
        <ViewRow label="Default quantity" value={formatQtyWithSize(item.defaultQty, item.unitType, size)} />
        {size ? <ViewRow label="Size" value={formatQty(size.value, size.unit)} /> : null}
        <ViewRow label="Shop by" value={item.shopName ?? "Not set"} />
        {item.isActive ? null : <ViewRow label="Status" value="Hidden from search" />}
      </dl>

      <Link
        href={`/grocery/items/${item.id}`}
        className="flex h-11 w-full items-center justify-center rounded-ios bg-ios-surface-2 text-[16px] font-medium text-ios-blue ring-1 ring-inset ring-ios-separator active:scale-[0.99]"
      >
        Price history
      </Link>
    </div>
  );
}

function ViewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-4 py-2.5">
      <dt className="flex-none text-[13px] text-ios-label-2">{label}</dt>
      <dd className="min-w-0 text-right text-[15px]">{value}</dd>
    </div>
  );
}
