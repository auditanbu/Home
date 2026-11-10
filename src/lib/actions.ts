"use server";

import { revalidatePath } from "next/cache";

import { PrismaClientKnownRequestError } from "@/generated/prisma/internal/prismaNamespace";
import masterData from "../../prisma/data/master-data.json";
import { isAdminSession } from "./admin";
import { prisma } from "./prisma";
import { COPYABLE_ITEM, getCopySource } from "./queries";
import { listNameFor, monthKeyOf } from "./dates";
import { hasTamilScript, toTanglish } from "./tanglish";
import { normalizeQty, roundSize, type UnitType } from "./units";

export type ActionResult<T = undefined> =
  | ({ ok: true } & (T extends undefined ? object : { data: T }))
  | { ok: false; error: string };

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function revalidateList(listId: number) {
  revalidatePath("/grocery");
  revalidatePath("/grocery/history");
  revalidatePath(`/grocery/lists/${listId}`);
  revalidatePath(`/grocery/lists/${listId}/view`);
  revalidatePath(`/grocery/lists/${listId}/shop`);
}

/**
 * Starts a monthly list. Defaults to the current month with a `MMM YYYY`
 * name. A month can hold several lists as long as their names differ —
 * submitting the exact same month + name again just reopens that list
 * instead of creating a duplicate.
 */
export async function createList(input: {
  name?: string;
  monthKey?: string;
}): Promise<ActionResult<{ id: number; existed: boolean }>> {
  const monthKey = input.monthKey?.trim() || monthKeyOf();
  if (!/^\d{4}-\d{2}$/.test(monthKey)) return fail("Month must look like 2026-07.");

  const [year, month] = monthKey.split("-").map(Number);
  const name = input.name?.trim() || listNameFor(new Date(year, month - 1, 1));

  const existing = await prisma.groceryList.findUnique({ where: { monthKey_name: { monthKey, name } } });
  if (existing) {
    return { ok: true, data: { id: existing.id, existed: true } };
  }

  const list = await prisma.groceryList.create({ data: { name, monthKey } });
  revalidatePath("/grocery");
  return { ok: true, data: { id: list.id, existed: false } };
}

export async function renameList(listId: number, name: string): Promise<ActionResult> {
  const trimmed = name.trim();
  if (!trimmed) return fail("Name cannot be empty.");

  const list = await prisma.groceryList.findUnique({ where: { id: listId }, select: { monthKey: true } });
  if (!list) return fail("List not found.");

  const clash = await prisma.groceryList.findFirst({
    where: { monthKey: list.monthKey, name: trimmed, NOT: { id: listId } },
    select: { id: true },
  });
  if (clash) return fail(`"${trimmed}" already exists for this month.`);

  await prisma.groceryList.update({ where: { id: listId }, data: { name: trimmed } });
  revalidateList(listId);
  return { ok: true };
}

/**
 * Admin only — a closed list is a shared family record, not something anyone
 * can erase.
 *
 * The prices recorded on the list go with it, by the cascade on
 * PriceHistory.listId. That is the point: a deleted list should stop
 * influencing what the app says an item costs, and detaching its price rows
 * instead left them quoting prices from a list nobody can look at.
 */
export async function deleteList(listId: number): Promise<ActionResult> {
  if (!(await isAdminSession())) return fail("Admin only.");
  await prisma.groceryList.delete({ where: { id: listId } });
  revalidatePath("/grocery");
  revalidatePath("/grocery/history");
  return { ok: true };
}

/**
 * Adds a master item to a list. Allowed on a DRAFT list (the Add items
 * page) and on a FINALIZED one — you routinely spot something at the shop
 * that never made it onto the list, and reopening to a draft just to add it
 * would throw away the shopping progress. A COMPLETED list is a closed
 * record and stays closed.
 */
export async function addListItem(input: {
  listId: number;
  itemId: number;
  quantity?: number;
  /** Overrides the master item's unit — used when a stepper promoted g/ml to kg/L. */
  unitType?: UnitType;
  shopId?: number | null;
  /**
   * Set only by the shopping view after the user has explicitly tapped "Edit"
   * on a closed list. A completed list stays closed to every other caller.
   */
  allowClosed?: boolean;
}): Promise<ActionResult<{ listItemId: number }>> {
  const list = await prisma.groceryList.findUnique({ where: { id: input.listId } });
  if (!list) return fail("List not found.");
  if (list.status === "COMPLETED" && !input.allowClosed) return fail("This list is closed.");

  const item = await prisma.item.findUnique({ where: { id: input.itemId } });
  if (!item) return fail("Item not found.");

  const unitType = input.unitType ?? (item.unitType as UnitType);
  const quantity = normalizeQty(input.quantity ?? Number(item.defaultQty), unitType);
  const shopId = input.shopId === undefined ? item.shopId : input.shopId;
  // The size is the master item's today, not forever: the row keeps its own
  // copy so re-sizing at the shop, or re-sizing the master item next month,
  // leaves the other alone.
  const sizeValue = item.sizeValue === null ? null : Number(item.sizeValue);
  const sizeUnit = item.sizeUnit;

  const existing = await prisma.groceryListItem.findFirst({
    where: { listId: input.listId, itemId: input.itemId, shopId },
  });

  if (existing) {
    // Same item + same shop already on the list: bump the quantity instead
    // of creating a duplicate row.
    const updated = await prisma.groceryListItem.update({
      where: { id: existing.id },
      data: { quantity: normalizeQty(Number(existing.quantity) + quantity, unitType) },
    });
    revalidateList(input.listId);
    return { ok: true, data: { listItemId: updated.id } };
  }

  const count = await prisma.groceryListItem.count({ where: { listId: input.listId } });
  const created = await prisma.groceryListItem.create({
    data: {
      listId: input.listId,
      itemId: input.itemId,
      quantity,
      unitType,
      sizeValue,
      sizeUnit,
      shopId,
      sortOrder: count,
    },
  });

  revalidateList(input.listId);
  return { ok: true, data: { listItemId: created.id } };
}

/**
 * Seeds a draft from last month — the single most repetitive part of planning
 * a monthly list, since the staples barely change.
 *
 * Copies quantity, unit and shop as they stood at the end of the source list,
 * so an amount corrected mid-shop ("actually, 2 kg") is what carries forward,
 * not what was originally planned. It is additive and safe to re-run: anything
 * already on the draft is left exactly as it is.
 */
export async function copyPreviousList(input: {
  listId: number;
  /** Defaults to the newest earlier list — pass an id to copy a specific one. */
  sourceListId?: number;
}): Promise<ActionResult<{ copied: number; skipped: number; sourceName: string }>> {
  const list = await prisma.groceryList.findUnique({ where: { id: input.listId } });
  if (!list) return fail("List not found.");
  if (list.status !== "DRAFT") return fail("Only a draft can be filled from an earlier list.");

  const source =
    input.sourceListId === undefined
      ? await getCopySource(list.monthKey)
      : await prisma.groceryList.findUnique({ where: { id: input.sourceListId } });

  if (!source) return fail("No earlier list to copy from.");
  if (source.id === list.id) return fail("A list cannot be copied onto itself.");

  const sourceItems = await prisma.groceryListItem.findMany({
    where: { listId: source.id, ...COPYABLE_ITEM },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    select: {
      itemId: true,
      quantity: true,
      unitType: true,
      sizeValue: true,
      sizeUnit: true,
      shopId: true,
    },
  });

  const existing = await prisma.groceryListItem.findMany({
    where: { listId: list.id },
    select: { itemId: true, shopId: true },
  });

  // Same key addListItem dedupes on, so copying twice can't double a row.
  const taken = new Set(existing.map((row) => `${row.itemId}:${row.shopId}`));
  const rows: {
    listId: number;
    itemId: number;
    quantity: number;
    unitType: UnitType;
    sizeValue: number | null;
    sizeUnit: UnitType | null;
    shopId: number | null;
    sortOrder: number;
  }[] = [];

  for (const row of sourceItems) {
    const key = `${row.itemId}:${row.shopId}`;
    if (taken.has(key)) continue;
    taken.add(key);
    rows.push({
      listId: list.id,
      itemId: row.itemId,
      quantity: normalizeQty(Number(row.quantity), row.unitType as UnitType),
      unitType: row.unitType as UnitType,
      // The size last month's shopping ended on — same reasoning as the
      // quantity: what you walked out with is what to plan for.
      sizeValue: row.sizeValue === null ? null : Number(row.sizeValue),
      sizeUnit: row.sizeUnit as UnitType | null,
      shopId: row.shopId,
      sortOrder: existing.length + rows.length,
    });
  }

  if (rows.length > 0) {
    await prisma.groceryListItem.createMany({ data: rows });
    revalidateList(list.id);
  }

  return {
    ok: true,
    data: {
      copied: rows.length,
      skipped: sourceItems.length - rows.length,
      sourceName: source.name,
    },
  };
}

export async function updateListItem(input: {
  listItemId: number;
  quantity?: number;
  /** Set alongside quantity when a stepper promoted g/ml to kg/L. */
  unitType?: UnitType;
  /**
   * The pack size bought instead of the planned one — the shop had 150 g,
   * not 200 g. Pass both fields together; null on either clears the size.
   */
  sizeValue?: number | null;
  sizeUnit?: UnitType | null;
  shopId?: number | null;
  /** See addListItem — the "Edit" button on a closed list sets this. */
  allowClosed?: boolean;
}): Promise<ActionResult> {
  const row = await prisma.groceryListItem.findUnique({
    where: { id: input.listItemId },
    include: { list: true, item: { select: { sizeValue: true, unitType: true } } },
  });
  if (!row) return fail("Item not found on this list.");
  if (row.list.status === "COMPLETED" && !input.allowClosed) return fail("This list is closed.");

  const unitType = input.unitType ?? (row.unitType as UnitType);
  const data: {
    quantity?: number;
    unitType?: UnitType;
    sizeValue?: number | null;
    sizeUnit?: UnitType | null;
    shopId?: number | null;
  } = {};
  if (input.quantity !== undefined) {
    data.quantity = normalizeQty(input.quantity, unitType);
  }
  if (input.unitType !== undefined) data.unitType = input.unitType;
  if (input.sizeValue !== undefined) {
    // A size is whatever the packet says, so it is only sanity-checked and
    // rounded — never snapped onto the quantity stepper's grid, which would
    // turn a 75 g soap into 100 g.
    const value =
      input.sizeValue !== null && Number.isFinite(input.sizeValue) && input.sizeValue > 0
        ? roundSize(input.sizeValue)
        : null;
    const unit = value === null ? null : (input.sizeUnit ?? (row.sizeUnit as UnitType | null));
    if (value !== null && !unit) return fail("Pick a unit for the size.");
    data.sizeValue = value;
    data.sizeUnit = unit;

    // A size filled in on a master item that has none is not a correction
    // for this month, it is the fact nobody had recorded — a 125 g soap is
    // 125 g next month too. So it seeds the master, and every later list
    // starts with it. Never an overwrite: a master item that already has a
    // size keeps it, because then the row really is the one-off (the shop
    // only had the 150 g tube).
    if (
      value !== null &&
      unit !== null &&
      row.item.sizeValue === null &&
      row.item.unitType === "COUNT"
    ) {
      await prisma.item.update({
        where: { id: row.itemId },
        data: { sizeValue: value, sizeUnit: unit },
      });
      revalidatePath("/grocery/master");
    }
  }
  if (input.shopId !== undefined && input.shopId !== row.shopId) {
    // One row per (list, item, shop), so moving a row onto a shop that
    // already has this item would collide. Say so rather than letting the
    // unique index surface as a crash.
    const clash = await prisma.groceryListItem.findFirst({
      where: { listId: row.listId, itemId: row.itemId, shopId: input.shopId },
      include: { shop: true },
    });
    if (clash) {
      return fail(
        `This item is already on the list under ${clash.shop?.name ?? "no shop"}.`,
      );
    }
    data.shopId = input.shopId;
  }

  await prisma.groceryListItem.update({ where: { id: input.listItemId }, data });
  revalidateList(row.listId);
  return { ok: true };
}

export async function removeListItem(listItemId: number): Promise<ActionResult> {
  const row = await prisma.groceryListItem.findUnique({
    where: { id: listItemId },
    include: { list: true },
  });
  if (!row) return fail("Item not found on this list.");
  if (row.list.status === "COMPLETED") return fail("This list is closed.");

  await prisma.groceryListItem.delete({ where: { id: listItemId } });
  await prisma.priceHistory.deleteMany({ where: { listId: row.listId, itemId: row.itemId } });
  revalidateList(row.listId);
  return { ok: true };
}

/**
 * Items still at quantity 0 ("check availability") are draft-only — a
 * shopping list can't send you to buy zero of something, so they're dropped
 * here rather than carried into the finalized/shopping view or the PDF.
 *
 * Checked before anything is deleted, and the drop + status flip run in one
 * transaction, so a rejected finalize (every item still at 0) leaves the
 * draft completely untouched rather than silently wiping the placeholders.
 */
export async function finalizeList(listId: number): Promise<ActionResult> {
  const keepable = await prisma.groceryListItem.count({ where: { listId, NOT: { quantity: 0 } } });
  if (keepable === 0) return fail("Add at least one item with a quantity before finalizing.");

  await prisma.$transaction([
    prisma.groceryListItem.deleteMany({ where: { listId, quantity: 0 } }),
    prisma.groceryList.update({
      where: { id: listId },
      data: { status: "FINALIZED", finalizedAt: new Date() },
    }),
  ]);
  revalidateList(listId);
  return { ok: true };
}

/**
 * Only a list still being shopped (FINALIZED) can be reopened for edits.
 * A COMPLETED list is a closed historical record — its spend and price
 * history are already final, so editing it back open is not allowed.
 */
export async function reopenList(listId: number): Promise<ActionResult> {
  const list = await prisma.groceryList.findUnique({ where: { id: listId }, select: { status: true } });
  if (!list) return fail("List not found.");
  if (list.status !== "FINALIZED") return fail("Completed lists can't be edited.");

  await prisma.groceryList.update({
    where: { id: listId },
    data: { status: "DRAFT", finalizedAt: null, completedAt: null },
  });
  revalidateList(listId);
  return { ok: true };
}

export async function completeList(listId: number): Promise<ActionResult> {
  await prisma.groceryList.update({
    where: { id: listId },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  revalidateList(listId);
  return { ok: true };
}

/**
 * Checks an item off while shopping. Records what was actually paid and
 * snapshots the previous price so the up/down indicator stays stable even
 * after later months are added.
 */
export async function recordPurchase(input: {
  listItemId: number;
  price: number;
}): Promise<ActionResult<{ previousPrice: number | null }>> {
  if (!Number.isFinite(input.price) || input.price < 0) {
    return fail("Enter a valid price.");
  }
  const price = Math.round(input.price * 100) / 100;

  const row = await prisma.groceryListItem.findUnique({
    where: { id: input.listItemId },
    include: { list: true },
  });
  if (!row) return fail("Item not found on this list.");
  if (row.list.status === "DRAFT") return fail("Finalize the list before shopping.");

  const previous = await prisma.priceHistory.findFirst({
    where: { itemId: row.itemId, NOT: { listId: row.listId } },
    orderBy: { purchasedAt: "desc" },
    select: { price: true, quantity: true, unitType: true, sizeValue: true, sizeUnit: true },
  });
  const previousPrice = previous ? Number(previous.price) : null;
  const previousQuantity = previous ? Number(previous.quantity) : null;
  const previousUnitType = previous?.unitType ?? null;
  // The size that price was paid for — without it, "₹95 last time" and
  // "₹95 today" look identical even when the tube shrank from 200 g to 150 g.
  const previousSizeValue =
    previous?.sizeValue === null || previous?.sizeValue === undefined
      ? null
      : Number(previous.sizeValue);
  const previousSizeUnit = previous?.sizeUnit ?? null;
  const purchasedAt = new Date();

  await prisma.$transaction([
    prisma.groceryListItem.update({
      where: { id: row.id },
      data: {
        isPurchased: true,
        purchasePrice: price,
        previousPrice,
        previousQuantity,
        previousUnitType,
        previousSizeValue,
        previousSizeUnit,
        purchasedAt,
      },
    }),
    // One history row per item per list — re-entering a price replaces it.
    prisma.priceHistory.deleteMany({ where: { listId: row.listId, itemId: row.itemId } }),
    prisma.priceHistory.create({
      data: {
        itemId: row.itemId,
        listId: row.listId,
        shopId: row.shopId,
        price,
        quantity: row.quantity,
        unitType: row.unitType,
        sizeValue: row.sizeValue,
        sizeUnit: row.sizeUnit,
        purchasedAt,
      },
    }),
  ]);

  revalidateList(row.listId);
  return { ok: true, data: { previousPrice } };
}

/**
 * Removes one recorded price — a row left behind by testing, or a figure
 * typed against the wrong item. Price history is otherwise append-only, and
 * stays that way: this is the one door, and it is deliberately narrow.
 *
 * A price recorded on a list is refused, because the list row still says
 * what was paid for it. Unchecking the item there removes both together
 * (`undoPurchase`), which is the only way the two stay in step.
 */
export async function deletePriceEntry(entryId: number): Promise<ActionResult> {
  const entry = await prisma.priceHistory.findUnique({
    where: { id: entryId },
    include: { list: true },
  });
  if (!entry) return fail("That price has already been removed.");
  if (entry.listId !== null) {
    return fail(
      `This price was recorded on ${entry.list?.name ?? "a list"} — uncheck the item there to remove it.`,
    );
  }

  await prisma.priceHistory.delete({ where: { id: entryId } });
  revalidatePath(`/grocery/items/${entry.itemId}`);
  revalidatePath("/grocery/history");
  return { ok: true };
}

export async function undoPurchase(listItemId: number): Promise<ActionResult> {
  const row = await prisma.groceryListItem.findUnique({ where: { id: listItemId } });
  if (!row) return fail("Item not found on this list.");

  await prisma.$transaction([
    prisma.groceryListItem.update({
      where: { id: listItemId },
      data: {
        isPurchased: false,
        purchasePrice: null,
        previousPrice: null,
        previousQuantity: null,
        previousUnitType: null,
        previousSizeValue: null,
        previousSizeUnit: null,
        purchasedAt: null,
      },
    }),
    prisma.priceHistory.deleteMany({ where: { listId: row.listId, itemId: row.itemId } }),
  ]);

  revalidateList(row.listId);
  return { ok: true };
}

export async function upsertMasterItem(input: {
  id?: number;
  nameEn: string;
  nameTa: string;
  /** Tanglish. Blank derives one from the Tamil name rather than storing nothing. */
  nameTl?: string;
  categoryId: number;
  unitType: UnitType;
  shopId: number | null;
  defaultQty?: number;
  isActive?: boolean;
  /**
   * Pack size — what one of this item comes in (a 200 g tube). Only
   * countable items have one; null on either field means "sold loose",
   * where the quantity is already the measure.
   */
  sizeValue?: number | null;
  sizeUnit?: UnitType | null;
}): Promise<ActionResult<{ id: number }>> {
  const nameEn = input.nameEn.trim();
  if (!nameEn) return fail("English name is required.");
  if (!input.categoryId) return fail("Pick a category.");

  // A blank Tamil field on a brand-new item falls back to the English name
  // (better than truly empty). On an EDIT, though, that same fallback would
  // silently overwrite a real Tamil name whenever the field is left blank —
  // keep whatever's already stored instead of destroying it.
  let nameTa = input.nameTa.trim();
  if (!nameTa) {
    if (input.id) {
      const existing = await prisma.item.findUnique({ where: { id: input.id }, select: { nameTa: true } });
      nameTa = existing?.nameTa || nameEn;
    } else {
      nameTa = nameEn;
    }
  }

  // Same reasoning as nameTa above: a blank field must not wipe a Tanglish
  // name that's already stored. When there's nothing to preserve, one is
  // transliterated from the Tamil name so the field is never left empty.
  let nameTl = input.nameTl?.trim() ?? "";
  if (!nameTl) {
    if (input.id) {
      const existing = await prisma.item.findUnique({
        where: { id: input.id },
        select: { nameTl: true },
      });
      nameTl = existing?.nameTl?.trim() || "";
    }
    if (!nameTl) nameTl = hasTamilScript(nameTa) ? toTanglish(nameTa) : nameEn;
  }

  const defaultQty = normalizeQty(input.defaultQty ?? 1, input.unitType);

  // A size only means something when the quantity counts packs: "2 kg, each
  // 200 g" is nonsense, and silently keeping one would quietly skew every
  // unit price for the item.
  const sizeValue =
    input.unitType === "COUNT" &&
    input.sizeValue !== null &&
    input.sizeValue !== undefined &&
    Number.isFinite(input.sizeValue) &&
    input.sizeValue > 0
      ? roundSize(input.sizeValue)
      : null;
  const sizeUnit = sizeValue === null ? null : (input.sizeUnit ?? null);
  if (sizeValue !== null && sizeUnit === null) return fail("Pick a unit for the size.");

  const clash = await prisma.item.findFirst({
    where: {
      nameEn,
      categoryId: input.categoryId,
      ...(input.id ? { NOT: { id: input.id } } : {}),
    },
    select: { id: true },
  });
  if (clash) return fail(`"${nameEn}" already exists in this category.`);

  const data = {
    nameEn,
    nameTa,
    nameTl,
    categoryId: input.categoryId,
    unitType: input.unitType,
    shopId: input.shopId,
    defaultQty,
    isActive: input.isActive ?? true,
    sizeValue,
    sizeUnit,
  };

  const item = input.id
    ? await prisma.item.update({ where: { id: input.id }, data })
    : await prisma.item.create({ data });

  revalidatePath("/grocery/master");
  return { ok: true, data: { id: item.id } };
}

/**
 * Lets the "last paid" panel on the Add items page tweak an item's default
 * unit and shop right there, without the full master-item form (no name/
 * category to re-validate).
 */
export async function updateMasterItemQuick(input: {
  itemId: number;
  unitType?: UnitType;
  shopId?: number | null;
}): Promise<ActionResult> {
  const data: {
    unitType?: UnitType;
    shopId?: number | null;
    defaultQty?: number;
    sizeValue?: number | null;
    sizeUnit?: UnitType | null;
  } = {};
  if (input.unitType !== undefined) {
    const current = await prisma.item.findUnique({ where: { id: input.itemId }, select: { defaultQty: true } });
    data.unitType = input.unitType;
    data.defaultQty = normalizeQty(Number(current?.defaultQty ?? 1), input.unitType);
    // Same rule as the full form: a pack size only means something while the
    // quantity counts packs.
    if (input.unitType !== "COUNT") {
      data.sizeValue = null;
      data.sizeUnit = null;
    }
  }
  if (input.shopId !== undefined) data.shopId = input.shopId;

  await prisma.item.update({ where: { id: input.itemId }, data });
  revalidatePath("/grocery/master");
  return { ok: true };
}

export async function setMasterItemActive(
  itemId: number,
  isActive: boolean,
): Promise<ActionResult> {
  await prisma.item.update({ where: { id: itemId }, data: { isActive } });
  revalidatePath("/grocery/master");
  return { ok: true };
}

/**
 * Permanently removes a master item. If it's referenced by a past list
 * (Item→GroceryListItem is onDelete: Restrict), the hard delete is
 * rejected by the database — fall back to deactivating it so it at
 * least disappears from search and stays out of new lists.
 */
export async function deleteMasterItem(itemId: number): Promise<ActionResult<{ deleted: boolean }>> {
  try {
    await prisma.item.delete({ where: { id: itemId } });
    revalidatePath("/grocery/master");
    return { ok: true, data: { deleted: true } };
  } catch (err) {
    if (err instanceof PrismaClientKnownRequestError && err.code === "P2003") {
      await prisma.item.update({ where: { id: itemId }, data: { isActive: false } });
      revalidatePath("/grocery/master");
      return { ok: true, data: { deleted: false } };
    }
    throw err;
  }
}

/** Only removable when empty — Item→Category is onDelete: Restrict. */
export async function deleteCategory(categoryId: number): Promise<ActionResult> {
  const count = await prisma.item.count({ where: { categoryId } });
  if (count > 0) return fail("This category still has items — move or delete them first.");

  await prisma.category.delete({ where: { id: categoryId } });
  revalidatePath("/grocery/master");
  return { ok: true };
}

export async function createShop(name: string): Promise<ActionResult<{ id: number }>> {
  const trimmed = name.trim();
  if (!trimmed) return fail("Shop name is required.");

  const existing = await prisma.shop.findUnique({ where: { name: trimmed } });
  if (existing) return { ok: true, data: { id: existing.id } };

  const count = await prisma.shop.count();
  const shop = await prisma.shop.create({ data: { name: trimmed, sortOrder: count } });
  revalidatePath("/grocery/master");
  return { ok: true, data: { id: shop.id } };
}

export async function renameShop(input: { id: number; name: string }): Promise<ActionResult> {
  const name = input.name.trim();
  if (!name) return fail("Shop name is required.");

  const clash = await prisma.shop.findFirst({
    where: { name, NOT: { id: input.id } },
    select: { id: true },
  });
  if (clash) return fail(`"${name}" already exists.`);

  await prisma.shop.update({ where: { id: input.id }, data: { name } });
  revalidatePath("/grocery", "layout");
  return { ok: true };
}

/**
 * Only removable when nothing points at it. The foreign keys are
 * onDelete: SetNull, so the database would happily delete a shop that past
 * lists and price history still name — and silently blank the shop out of
 * that history. Refuse instead, the same way an in-use category is refused.
 */
export async function deleteShop(shopId: number): Promise<ActionResult> {
  const [items, listRows, prices] = await Promise.all([
    prisma.item.count({ where: { shopId } }),
    prisma.groceryListItem.count({ where: { shopId } }),
    prisma.priceHistory.count({ where: { shopId } }),
  ]);
  if (items > 0) {
    return fail(
      `${items} item${items === 1 ? " still uses" : "s still use"} this shop — change their shop first.`,
    );
  }
  if (listRows > 0 || prices > 0) {
    return fail("This shop appears in your grocery lists or price history, so it can't be deleted.");
  }

  await prisma.shop.delete({ where: { id: shopId } });
  revalidatePath("/grocery", "layout");
  return { ok: true };
}

export async function createCategory(input: {
  nameEn: string;
  nameTa?: string;
}): Promise<ActionResult<{ id: number }>> {
  const nameEn = input.nameEn.trim();
  if (!nameEn) return fail("Category name is required.");

  const existing = await prisma.category.findUnique({ where: { nameEn } });
  if (existing) return { ok: true, data: { id: existing.id } };

  const count = await prisma.category.count();
  const category = await prisma.category.create({
    data: { nameEn, nameTa: input.nameTa?.trim() || null, sortOrder: count },
  });
  revalidatePath("/grocery/master");
  return { ok: true, data: { id: category.id } };
}

export async function updateCategory(input: {
  id: number;
  nameEn: string;
  nameTa?: string | null;
}): Promise<ActionResult> {
  const nameEn = input.nameEn.trim();
  if (!nameEn) return fail("English name is required.");
  const nameTa = input.nameTa?.trim() || null;

  const clash = await prisma.category.findFirst({
    where: { nameEn, NOT: { id: input.id } },
    select: { id: true },
  });
  if (clash) return fail(`"${nameEn}" already exists.`);

  await prisma.category.update({ where: { id: input.id }, data: { nameEn, nameTa } });
  revalidatePath("/grocery/master");
  return { ok: true };
}

type KnownTranslationRow = { grocery: string; groceryEn: string; tanglish?: string };

/**
 * Fills in Tanglish names for every item still missing one. The
 * spreadsheet's hand-written `tanglish` column wins where it has an entry;
 * anything else (items typed in by hand, at the shop or in the master
 * list) is transliterated from its Tamil name.
 *
 * `overwrite` re-derives names that are already stored too — useful after
 * the spreadsheet gains better spellings, but it discards manual edits, so
 * it isn't the default.
 */
export async function fillTanglishNames(
  options?: { overwrite?: boolean },
): Promise<ActionResult<{ fromSpreadsheet: number; transliterated: number; remaining: number }>> {
  if (!(await isAdminSession())) return fail("Admin only.");

  const lookup = new Map<string, string>();
  for (const row of (masterData.items as KnownTranslationRow[]) ?? []) {
    const key = row.groceryEn.trim().toLowerCase();
    const value = row.tanglish?.trim();
    if (key && value && !lookup.has(key)) lookup.set(key, value);
  }

  const items = await prisma.item.findMany({
    select: { id: true, nameEn: true, nameTa: true, nameTl: true },
  });

  let fromSpreadsheet = 0;
  let transliterated = 0;
  let remaining = 0;
  for (const item of items) {
    const current = item.nameTl?.trim() ?? "";
    if (current && !options?.overwrite) continue;

    const known = lookup.get(item.nameEn.trim().toLowerCase());
    const derived = known ?? (hasTamilScript(item.nameTa) ? toTanglish(item.nameTa) : null);
    if (!derived) {
      // Nothing in the spreadsheet and no Tamil script to work from — the
      // name has to be typed in by hand.
      if (!current) remaining += 1;
      continue;
    }
    if (derived === current) continue;

    await prisma.item.update({ where: { id: item.id }, data: { nameTl: derived } });
    if (known) fromSpreadsheet += 1;
    else transliterated += 1;
  }

  revalidatePath("/grocery/master");
  return { ok: true, data: { fromSpreadsheet, transliterated, remaining } };
}

/**
 * Fixes two kinds of Tamil drift against the original spreadsheet (bundled
 * at build time), which is treated as ground truth for anything that came
 * from it:
 *
 *  - "Needs Tamil" items (nameTa === nameEn) that just weren't translated
 *    when created — often manually, outside a spreadsheet import.
 *  - Items that already have *some* Tamil name, but it doesn't match the
 *    spreadsheet's spelling (a typo introduced by hand-editing, or a stale
 *    import from before the spreadsheet was corrected).
 *
 * Only the first kind counts against `remaining` — the second kind is
 * always resolvable from the spreadsheet by definition, so it's silently
 * corrected rather than reported as needing manual entry.
 */
export async function fixKnownTranslations(): Promise<
  ActionResult<{ fixed: number; remaining: number }>
> {
  if (!(await isAdminSession())) return fail("Admin only.");

  const lookup = new Map<string, string>();
  for (const row of (masterData.items as KnownTranslationRow[]) ?? []) {
    const key = row.groceryEn.trim().toLowerCase();
    if (key && !lookup.has(key)) lookup.set(key, row.grocery.trim());
  }

  const items = await prisma.item.findMany({ select: { id: true, nameEn: true, nameTa: true } });

  let fixed = 0;
  let remaining = 0;
  for (const item of items) {
    const nameTa = item.nameTa.trim();
    const nameEn = item.nameEn.trim();
    const translation = lookup.get(nameEn.toLowerCase());
    if (translation && translation !== nameTa) {
      await prisma.item.update({ where: { id: item.id }, data: { nameTa: translation } });
      fixed += 1;
    } else if (!translation && nameTa.toLowerCase() === nameEn.toLowerCase()) {
      remaining += 1;
    }
  }

  revalidatePath("/grocery/master");
  return { ok: true, data: { fixed, remaining } };
}

/** Powers the search field in the "add item" sheet. */
export async function searchMasterItems(query: string) {
  const { getMasterItems } = await import("./queries");
  return getMasterItems({ search: query, take: 40 });
}

/** Powers the inline price-history preview in the purchase sheet. */
export async function getItemPriceHistory(itemId: number) {
  const { getPriceHistory } = await import("./queries");
  return getPriceHistory(itemId);
}
