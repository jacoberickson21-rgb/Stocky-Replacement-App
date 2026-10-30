import { Prisma, type StocktakeItem, type StocktakeScanKind } from "@prisma/client";
import { getDb } from "../db.server";
import { logFailure } from "./failure-log.server";
import {
  fetchLiveInventoryLevels,
  fetchVariantForStocktake,
  findVariantsByCode,
  getInventoryItemIdsByVariant,
  updateVariantBarcode,
} from "./shopify.server";
import { readFiltersJson } from "./stocktake.server";

// Everything here writes only to the local database, except linkUnknownBarcode's
// optional variant barcode save. Nothing touches Shopify inventory.

const SCAN_AUDIT_EVERY = 50;
const MAX_MANUAL_QTY = 100_000;

type Tx = Prisma.TransactionClient;

export type CountItemView = {
  id: number;
  title: string;
  variantTitle: string;
  sku: string | null;
  barcode: string | null;
  expectedQty: number;
  countedQty: number | null;
  outsideScope: boolean;
};

export type VariantCandidate = {
  variantId: string;
  productId: string;
  inventoryItemId: string | null;
  title: string;
  variantTitle: string;
  sku: string | null;
  barcode: string | null;
  vendor: string | null;
  cost: number | null;
};

export type ScanResult =
  | { kind: "counted"; item: CountItemView; created: boolean; message?: string }
  | { kind: "outside_scope"; barcode: string; candidate: VariantCandidate }
  | { kind: "unknown"; barcode: string; scanCount: number; reason: "not_found" | "ambiguous" }
  | { kind: "error"; message: string };

export class StocktakeCountError extends Error {}

export function toView(item: StocktakeItem): CountItemView {
  return {
    id: item.id,
    title: item.title,
    variantTitle: item.variantTitle,
    sku: item.sku,
    barcode: item.barcode,
    expectedQty: item.expectedQty,
    countedQty: item.countedQty,
    outsideScope: item.outsideScope,
  };
}

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

// Takes a shared lock on the stocktake row and checks it's still countable.
// Cancel takes an exclusive lock on the same row, so a scan and a cancel can
// never interleave.
export async function lockCountable(tx: Tx, stocktakeId: number) {
  const rows = await tx.$queryRaw<{ status: string; name: string }[]>`
    SELECT status, name FROM "Stocktake" WHERE id = ${stocktakeId} FOR SHARE
  `;
  if (rows.length === 0) throw new StocktakeCountError("Stocktake not found.");
  if (rows[0].status !== "IN_PROGRESS") {
    throw new StocktakeCountError("This stocktake is no longer accepting counts.");
  }
  return rows[0];
}

export async function lockItem(tx: Tx, itemId: number, stocktakeId: number) {
  const rows = await tx.$queryRaw<{ countedQty: number | null; applied: boolean }[]>`
    SELECT "countedQty", applied FROM "StocktakeItem"
    WHERE id = ${itemId} AND "stocktakeId" = ${stocktakeId} FOR UPDATE
  `;
  if (rows.length === 0) throw new StocktakeCountError("Item not found in this stocktake.");
  if (rows[0].applied) throw new StocktakeCountError("This item has already been applied to Shopify.");
  return rows[0];
}

// ─── Count changes (each one a single transaction) ─────────────────────────────

// Adds `delta` to the item's count and records one scan row with before/after.
async function addToCount(opts: {
  stocktakeId: number;
  itemId: number;
  userId: number;
  barcode: string | null;
  kind: StocktakeScanKind;
  delta: number;
}): Promise<StocktakeItem> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    const stocktake = await lockCountable(tx, opts.stocktakeId);
    const locked = await lockItem(tx, opts.itemId, opts.stocktakeId);
    const qtyAfter = (locked.countedQty ?? 0) + opts.delta;
    const item = await tx.stocktakeItem.update({
      where: { id: opts.itemId },
      data: { countedQty: qtyAfter },
    });
    await tx.stocktakeScan.create({
      data: {
        stocktakeId: opts.stocktakeId,
        itemId: opts.itemId,
        kind: opts.kind,
        barcode: opts.barcode,
        qtyBefore: locked.countedQty,
        qtyAfter,
        scannedById: opts.userId,
      },
    });
    if (opts.kind === "SCAN") {
      const scans = await tx.stocktakeScan.count({
        where: { stocktakeId: opts.stocktakeId, scannedById: opts.userId, kind: "SCAN" },
      });
      if (scans % SCAN_AUDIT_EVERY === 0) {
        await tx.auditLog.create({
          data: {
            userId: opts.userId,
            action: "STOCKTAKE_SCANS",
            details: `Stocktake #${opts.stocktakeId} "${stocktake.name}": ${SCAN_AUDIT_EVERY} more scans (${scans} scans by this user so far)`,
          },
        });
      }
    }
    return item;
  });
}

export async function setExactQty(opts: {
  stocktakeId: number;
  itemId: number;
  userId: number;
  qty: number;
}): Promise<CountItemView> {
  if (!Number.isInteger(opts.qty) || opts.qty < 0 || opts.qty > MAX_MANUAL_QTY) {
    throw new StocktakeCountError(`Quantity must be a whole number from 0 to ${MAX_MANUAL_QTY.toLocaleString()}.`);
  }
  const db = getDb();
  const item = await db.$transaction(async (tx) => {
    await lockCountable(tx, opts.stocktakeId);
    const locked = await lockItem(tx, opts.itemId, opts.stocktakeId);
    const updated = await tx.stocktakeItem.update({
      where: { id: opts.itemId },
      data: { countedQty: opts.qty },
    });
    if (locked.countedQty !== opts.qty) {
      await tx.stocktakeScan.create({
        data: {
          stocktakeId: opts.stocktakeId,
          itemId: opts.itemId,
          kind: "MANUAL_SET",
          qtyBefore: locked.countedQty,
          qtyAfter: opts.qty,
          scannedById: opts.userId,
        },
      });
    }
    return updated;
  });
  return toView(item);
}

export type UndoResult =
  | { mode: "single"; item: CountItemView; undoneKind: StocktakeScanKind }
  | { mode: "batch"; undone: CountItemView[]; skipped: { label: string; reason: string }[] };

// Bulk actions whose remaining rows can't be undone (every variant left in them
// was scanned since) and have already been reported. Undo moves past them, so
// one superseded zero can never block undoing earlier scans.
const exhaustedBatches = new Set<string>();

// Reverses the user's most recent action that hasn't been undone. Scan rows are
// kept (undoneAt is set), never deleted.
// - A single scan: its own change is reversed as a delta, so other people's
//   scans on the same item since then are preserved. If no live scans remain on
//   the item it goes back to "not counted" (null), not 0.
// - A bulk action (batchId): only this user's rows in that batch are reversed,
//   in one transaction. A variant scanned since the bulk action is skipped and
//   reported, never overwritten.
export async function undoLastScan(opts: {
  stocktakeId: number;
  userId: number;
}): Promise<UndoResult> {
  const db = getDb();
  return db.$transaction(
    async (tx) => {
      const st = await lockCountable(tx, opts.stocktakeId);
      const recent = await tx.stocktakeScan.findMany({
        where: { stocktakeId: opts.stocktakeId, scannedById: opts.userId, undoneAt: null },
        orderBy: [{ scannedAt: "desc" }, { id: "desc" }],
        select: { id: true, batchId: true },
        take: 1000,
      });
      if (recent.length === 0) throw new StocktakeCountError("You have no scans to undo.");

      const seen = new Set<string>();
      for (const candidate of recent) {
        if (!candidate.batchId) return undoSingle(tx, opts.stocktakeId, candidate.id);
        if (seen.has(candidate.batchId) || exhaustedBatches.has(candidate.batchId)) continue;
        seen.add(candidate.batchId);
        return undoBatch(tx, { stocktakeId: opts.stocktakeId, userId: opts.userId, batchId: candidate.batchId, stocktakeName: st.name });
      }
      throw new StocktakeCountError("You have no scans left that can be undone.");
    },
    { timeout: 30_000 }
  );
}

async function undoSingle(tx: Tx, stocktakeId: number, scanId: number): Promise<UndoResult> {
  const scan = await tx.stocktakeScan.findUniqueOrThrow({ where: { id: scanId } });
  const locked = await lockItem(tx, scan.itemId, stocktakeId);

  await tx.stocktakeScan.update({ where: { id: scan.id }, data: { undoneAt: new Date() } });
  const remaining = await tx.stocktakeScan.count({ where: { itemId: scan.itemId, undoneAt: null } });

  const delta = scan.qtyAfter - (scan.qtyBefore ?? 0);
  const reversed = Math.max(0, (locked.countedQty ?? 0) - delta);
  const item = await tx.stocktakeItem.update({
    where: { id: scan.itemId },
    data: { countedQty: remaining === 0 ? null : reversed },
  });
  return { mode: "single", item: toView(item), undoneKind: scan.kind };
}

async function undoBatch(
  tx: Tx,
  opts: { stocktakeId: number; userId: number; batchId: string; stocktakeName: string }
): Promise<UndoResult> {
  const rows = await tx.stocktakeScan.findMany({
    where: { stocktakeId: opts.stocktakeId, scannedById: opts.userId, batchId: opts.batchId, undoneAt: null },
    orderBy: { id: "asc" },
    include: { item: { select: { title: true, variantTitle: true, sku: true } } },
  });

  const undone: CountItemView[] = [];
  const skipped: { label: string; reason: string }[] = [];
  const now = new Date();
  for (const row of rows) {
    const label = `${row.item.title} — ${row.item.variantTitle}`;
    const locked = await lockItem(tx, row.itemId, opts.stocktakeId);
    const newer = await tx.stocktakeScan.count({ where: { itemId: row.itemId, undoneAt: null, id: { gt: row.id } } });
    if (newer > 0) {
      skipped.push({ label, reason: `scanned since (now counted ${locked.countedQty ?? 0})` });
      continue;
    }
    await tx.stocktakeScan.update({ where: { id: row.id }, data: { undoneAt: now } });
    const remaining = await tx.stocktakeScan.count({ where: { itemId: row.itemId, undoneAt: null } });
    const delta = row.qtyAfter - (row.qtyBefore ?? 0);
    const reversed = Math.max(0, (locked.countedQty ?? 0) - delta);
    const item = await tx.stocktakeItem.update({
      where: { id: row.itemId },
      data: { countedQty: remaining === 0 ? null : reversed },
    });
    undone.push(toView(item));
  }

  if (undone.length === 0) {
    exhaustedBatches.add(opts.batchId);
    throw new StocktakeCountError(
      `Nothing undone: every variant in your last bulk action (${rows.length}) has been scanned since. Press Undo again to undo your action before that.`
    );
  }
  // What's left in this batch can't be undone, so the next Undo moves past it.
  if (skipped.length > 0) exhaustedBatches.add(opts.batchId);

  await tx.auditLog.create({
    data: {
      userId: opts.userId,
      action: "STOCKTAKE_ZERO_UNDONE",
      details:
        `Stocktake #${opts.stocktakeId} "${opts.stocktakeName}": undid bulk action ${opts.batchId} — ${undone.length} variant${undone.length === 1 ? "" : "s"} back to not counted` +
        (skipped.length ? `; ${skipped.length} skipped because scanned since: ${skipped.map((s) => s.label).slice(0, 20).join("; ")}` : ""),
    },
  });
  return { mode: "batch", undone, skipped };
}

// ─── Lookup and item creation ──────────────────────────────────────────────────

type CodeResolution =
  | { kind: "found"; candidate: VariantCandidate }
  | { kind: "untracked"; label: string }
  | { kind: "ambiguous" }
  | { kind: "not_found" };

async function resolveCode(code: string): Promise<CodeResolution> {
  const db = getDb();

  // ProductCache by barcode, then by SKU.
  for (const where of [
    { barcode: code },
    { sku: { equals: code, mode: "insensitive" as const } },
  ]) {
    const rows = await db.productCache.findMany({ where, take: 5 });
    if (rows.length === 0) continue;
    const tracked = rows.filter((r) => r.tracked);
    if (tracked.length === 1) {
      const r = tracked[0];
      return {
        kind: "found",
        candidate: {
          variantId: r.variantId,
          productId: r.productId,
          inventoryItemId: r.inventoryItemId,
          title: r.title,
          variantTitle: r.variantTitle,
          sku: r.sku,
          barcode: r.barcode,
          vendor: r.vendor,
          cost: r.cost == null ? null : Number(r.cost),
        },
      };
    }
    if (tracked.length === 0) return { kind: "untracked", label: `${rows[0].title} — ${rows[0].variantTitle}` };
    return { kind: "ambiguous" };
  }

  // Live Shopify fallback (tracked only).
  const live = await findVariantsByCode(code);
  if (live.length === 0) return { kind: "not_found" };
  const tracked = live.filter((v) => v.tracked);
  if (tracked.length === 0) return { kind: "untracked", label: `${live[0].productTitle} — ${live[0].variantTitle}` };
  if (tracked.length > 1) return { kind: "ambiguous" };
  const v = tracked[0];
  return {
    kind: "found",
    candidate: {
      variantId: v.variantId,
      productId: v.productId,
      inventoryItemId: v.inventoryItemId,
      title: v.productTitle,
      variantTitle: v.variantTitle,
      sku: v.sku,
      barcode: v.barcode,
      vendor: v.vendor,
      cost: v.unitCost,
    },
  };
}

// Creates the StocktakeItem with a live on_hand snapshot of this one variant.
// If someone else created it a moment earlier, the unique (stocktakeId,
// variantId) index rejects ours and we use theirs.
async function getOrCreateItem(opts: {
  stocktakeId: number;
  locationId: string;
  candidate: VariantCandidate;
  outsideScope: boolean;
}): Promise<{ item: StocktakeItem; created: boolean }> {
  const db = getDb();
  const key = { stocktakeId_variantId: { stocktakeId: opts.stocktakeId, variantId: opts.candidate.variantId } };
  const existing = await db.stocktakeItem.findUnique({ where: key });
  if (existing) return { item: existing, created: false };

  const c = opts.candidate;
  let inventoryItemId = c.inventoryItemId;
  if (!inventoryItemId) {
    inventoryItemId = (await getInventoryItemIdsByVariant([c.variantId])).get(c.variantId) ?? null;
  }
  if (!inventoryItemId) throw new StocktakeCountError(`${c.title} — ${c.variantTitle} no longer exists in Shopify.`);

  const level = (await fetchLiveInventoryLevels([inventoryItemId], opts.locationId)).get(inventoryItemId);
  if (!level) throw new StocktakeCountError(`${c.title} — ${c.variantTitle} no longer exists in Shopify.`);
  if (!level.tracked) {
    await db.productCache.updateMany({ where: { variantId: c.variantId }, data: { tracked: false } });
    throw new StocktakeCountError(`${c.title} — ${c.variantTitle} has inventory tracking turned off, so it can't be counted.`);
  }

  try {
    const item = await db.stocktakeItem.create({
      data: {
        stocktakeId: opts.stocktakeId,
        variantId: c.variantId,
        productId: c.productId,
        inventoryItemId,
        sku: c.sku,
        barcode: c.barcode,
        title: c.title,
        variantTitle: c.variantTitle,
        vendor: c.vendor,
        expectedQty: level.onHand ?? 0,
        cost: level.unitCost ?? c.cost,
        outsideScope: opts.outsideScope,
      },
    });
    return { item, created: true };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const winner = await db.stocktakeItem.findUnique({ where: key });
    if (!winner) throw err;
    return { item: winner, created: false };
  }
}

async function candidateFromVariantId(variantId: string): Promise<VariantCandidate & { tracked: boolean; liveBarcode: string | null }> {
  const v = await fetchVariantForStocktake(variantId);
  if (!v) throw new StocktakeCountError("That variant no longer exists in Shopify.");
  return {
    variantId: v.variantId,
    productId: v.productId,
    inventoryItemId: v.inventoryItemId,
    title: v.productTitle,
    variantTitle: v.variantTitle,
    sku: v.sku,
    barcode: v.barcode,
    vendor: v.vendor,
    cost: v.unitCost,
    tracked: v.tracked,
    liveBarcode: v.barcode,
  };
}

type UnknownOutcome = { kind: "recorded"; scanCount: number } | { kind: "linked"; itemId: number };

// Adds one scan to the "Needs attention" row for this barcode. Every update is
// conditional on the row still being unlinked, so a scan racing a link either
// lands before the link (and is carried over by it) or is counted on the
// linked item — never lost.
async function recordUnknown(stocktakeId: number, barcode: string, userId: number): Promise<UnknownOutcome> {
  const db = getDb();
  const key = { stocktakeId_barcode: { stocktakeId, barcode } };
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await db.stocktakeUnknownBarcode.findUnique({ where: key });
    if (existing?.resolvedItemId) return { kind: "linked", itemId: existing.resolvedItemId };
    if (existing) {
      // A dismissed barcode scanned again re-opens with a fresh count.
      const reopened = existing.resolvedAt != null;
      const { count } = await db.stocktakeUnknownBarcode.updateMany({
        where: { id: existing.id, resolvedItemId: null, resolvedAt: existing.resolvedAt },
        data: {
          scanCount: reopened ? 1 : { increment: 1 },
          resolvedAt: null,
          lastScannedById: userId,
          lastScannedAt: new Date(),
        },
      });
      if (count === 0) continue;
      const row = await db.stocktakeUnknownBarcode.findUniqueOrThrow({ where: key });
      return { kind: "recorded", scanCount: row.scanCount };
    }
    try {
      await db.stocktakeUnknownBarcode.create({
        data: { stocktakeId, barcode, lastScannedById: userId },
      });
      return { kind: "recorded", scanCount: 1 };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new StocktakeCountError("Could not record the unknown barcode. Scan it again.");
}

// ─── Scan entry points ─────────────────────────────────────────────────────────

export async function scanBarcode(opts: {
  stocktakeId: number;
  code: string;
  userId: number;
}): Promise<ScanResult> {
  const db = getDb();
  const code = opts.code.trim();
  if (!code) return { kind: "error", message: "Empty scan." };

  const stocktake = await db.stocktake.findUnique({ where: { id: opts.stocktakeId } });
  if (!stocktake) return { kind: "error", message: "Stocktake not found." };
  if (stocktake.status !== "IN_PROGRESS") return { kind: "error", message: "This stocktake is no longer accepting counts." };

  const count = async (itemId: number, created = false): Promise<ScanResult> => {
    const item = await addToCount({
      stocktakeId: opts.stocktakeId, itemId, userId: opts.userId, barcode: code, kind: "SCAN", delta: 1,
    });
    return { kind: "counted", item: toView(item), created };
  };

  const needsAttention = async (reason: "ambiguous" | "not_found"): Promise<ScanResult> => {
    const outcome = await recordUnknown(opts.stocktakeId, code, opts.userId);
    if (outcome.kind === "linked") return count(outcome.itemId);
    return { kind: "unknown", barcode: code, reason, scanCount: outcome.scanCount };
  };

  // 1. An item already in this stocktake with this barcode.
  const byBarcode = await db.stocktakeItem.findMany({
    where: { stocktakeId: opts.stocktakeId, barcode: code },
    select: { id: true },
    take: 2,
  });
  if (byBarcode.length === 1) return count(byBarcode[0].id);
  if (byBarcode.length > 1) return needsAttention("ambiguous");

  // 2. A barcode staff already linked to an item in this stocktake.
  const linked = await db.stocktakeUnknownBarcode.findUnique({
    where: { stocktakeId_barcode: { stocktakeId: opts.stocktakeId, barcode: code } },
    select: { resolvedItemId: true },
  });
  if (linked?.resolvedItemId) return count(linked.resolvedItemId);

  // 3. An item already in this stocktake with this SKU.
  const bySku = await db.stocktakeItem.findMany({
    where: { stocktakeId: opts.stocktakeId, sku: { equals: code, mode: "insensitive" } },
    select: { id: true },
    take: 2,
  });
  if (bySku.length === 1) return count(bySku[0].id);

  // 4. Look the code up: ProductCache barcode → SKU → live Shopify.
  const resolution = await resolveCode(code);
  if (resolution.kind === "untracked") {
    return { kind: "error", message: `${resolution.label} has inventory tracking turned off, so it can't be counted.` };
  }
  if (resolution.kind === "ambiguous" || resolution.kind === "not_found") return needsAttention(resolution.kind);

  const existing = await db.stocktakeItem.findUnique({
    where: { stocktakeId_variantId: { stocktakeId: opts.stocktakeId, variantId: resolution.candidate.variantId } },
    select: { id: true },
  });
  if (existing) return count(existing.id);

  if (stocktake.mode === "SCOPED") {
    return { kind: "outside_scope", barcode: code, candidate: resolution.candidate };
  }

  const { item, created } = await getOrCreateItem({
    stocktakeId: opts.stocktakeId,
    locationId: stocktake.locationId,
    candidate: resolution.candidate,
    outsideScope: false,
  });
  return count(item.id, created);
}

// Staff confirmed "Outside scope: add it?". `scans` is how many times it was
// scanned while the prompt was waiting; each becomes its own scan row.
export async function addOutsideScopeItem(opts: {
  stocktakeId: number;
  variantId: string;
  barcode: string;
  scans: number;
  userId: number;
}): Promise<ScanResult> {
  const db = getDb();
  const stocktake = await db.stocktake.findUnique({ where: { id: opts.stocktakeId } });
  if (!stocktake) return { kind: "error", message: "Stocktake not found." };
  if (stocktake.status !== "IN_PROGRESS") return { kind: "error", message: "This stocktake is no longer accepting counts." };

  const candidate = await candidateFromVariantId(opts.variantId);
  if (!candidate.tracked) {
    return { kind: "error", message: `${candidate.title} — ${candidate.variantTitle} has inventory tracking turned off, so it can't be counted.` };
  }
  const { item, created } = await getOrCreateItem({
    stocktakeId: opts.stocktakeId,
    locationId: stocktake.locationId,
    candidate,
    outsideScope: stocktake.mode === "SCOPED",
  });
  if (created) {
    await db.auditLog.create({
      data: {
        userId: opts.userId,
        action: "STOCKTAKE_ITEM_ADDED",
        details: `Stocktake #${stocktake.id} "${stocktake.name}": added outside-scope item ${item.title} — ${item.variantTitle} (SKU ${item.sku ?? "none"}, expected on hand ${item.expectedQty})`,
      },
    });
  }

  let latest = item;
  const n = Math.min(Math.max(1, Math.floor(opts.scans)), 50);
  for (let i = 0; i < n; i++) {
    latest = await addToCount({
      stocktakeId: opts.stocktakeId, itemId: item.id, userId: opts.userId, barcode: opts.barcode, kind: "SCAN", delta: 1,
    });
  }
  return { kind: "counted", item: toView(latest), created };
}

// ─── Needs attention ───────────────────────────────────────────────────────────

export async function linkUnknownBarcode(opts: {
  stocktakeId: number;
  unknownId: number;
  variantId: string;
  saveBarcodeToShopify: boolean;
  userId: number;
}): Promise<{ item: CountItemView; barcodeSaved: boolean; warning?: string }> {
  const db = getDb();
  const stocktake = await db.stocktake.findUnique({ where: { id: opts.stocktakeId } });
  if (!stocktake) throw new StocktakeCountError("Stocktake not found.");
  if (stocktake.status !== "IN_PROGRESS") throw new StocktakeCountError("This stocktake is no longer accepting counts.");

  const unknown = await db.stocktakeUnknownBarcode.findFirst({
    where: { id: opts.unknownId, stocktakeId: opts.stocktakeId, resolvedAt: null },
  });
  if (!unknown) throw new StocktakeCountError("That barcode has already been linked or dismissed.");

  const candidate = await candidateFromVariantId(opts.variantId);
  if (!candidate.tracked) {
    throw new StocktakeCountError(`${candidate.title} — ${candidate.variantTitle} has inventory tracking turned off, so it can't be counted.`);
  }

  const scopeIds = readFiltersJson(stocktake.filters).scopeVariantIds ?? [];
  const { item } = await getOrCreateItem({
    stocktakeId: opts.stocktakeId,
    locationId: stocktake.locationId,
    candidate,
    outsideScope: stocktake.mode === "SCOPED" && !scopeIds.includes(candidate.variantId),
  });

  const updated = await db.$transaction(async (tx) => {
    await lockCountable(tx, opts.stocktakeId);
    const locked = await lockItem(tx, item.id, opts.stocktakeId);
    // Claim the row first, then read its final scanCount — any scan that raced
    // us is either already in that count or will be redirected to the item.
    const claimed = await tx.stocktakeUnknownBarcode.updateMany({
      where: { id: unknown.id, resolvedAt: null },
      data: { resolvedItemId: item.id, resolvedAt: new Date() },
    });
    if (claimed.count === 0) throw new StocktakeCountError("That barcode has already been linked or dismissed.");
    const fresh = await tx.stocktakeUnknownBarcode.findUniqueOrThrow({ where: { id: unknown.id } });

    const qtyAfter = (locked.countedQty ?? 0) + fresh.scanCount;
    const result = await tx.stocktakeItem.update({ where: { id: item.id }, data: { countedQty: qtyAfter } });
    await tx.stocktakeScan.create({
      data: {
        stocktakeId: opts.stocktakeId,
        itemId: item.id,
        kind: "LINKED",
        barcode: unknown.barcode,
        qtyBefore: locked.countedQty,
        qtyAfter,
        scannedById: opts.userId,
      },
    });
    await tx.auditLog.create({
      data: {
        userId: opts.userId,
        action: "STOCKTAKE_BARCODE_LINKED",
        details: `Stocktake #${stocktake.id} "${stocktake.name}": barcode ${unknown.barcode} linked to ${item.title} — ${item.variantTitle} (SKU ${item.sku ?? "none"}), ${fresh.scanCount} scan${fresh.scanCount === 1 ? "" : "s"} counted`,
      },
    });
    return result;
  });

  // Optional, explicitly confirmed by staff: the only Shopify write in counting.
  let barcodeSaved = false;
  let warning: string | undefined;
  if (opts.saveBarcodeToShopify && candidate.liveBarcode !== unknown.barcode) {
    try {
      await updateVariantBarcode(candidate.productId, candidate.variantId, unknown.barcode);
      barcodeSaved = true;
      await db.productCache.updateMany({ where: { variantId: candidate.variantId }, data: { barcode: unknown.barcode } });
      await db.stocktakeItem.update({ where: { id: item.id }, data: { barcode: unknown.barcode } });
      await db.auditLog.create({
        data: {
          userId: opts.userId,
          action: "STOCKTAKE_BARCODE_SAVED",
          details: `Stocktake #${stocktake.id} "${stocktake.name}": Shopify barcode for ${item.title} — ${item.variantTitle} (SKU ${item.sku ?? "none"}) changed from ${candidate.liveBarcode ?? "(none)"} to ${unknown.barcode}`,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logFailure("BARCODE_SYNC", item.sku ?? item.title, msg);
      warning = "The barcode was linked for this stocktake, but saving it to Shopify failed. The error has been logged.";
    }
  }

  return { item: toView({ ...updated, barcode: barcodeSaved ? unknown.barcode : updated.barcode }), barcodeSaved, warning };
}

export async function dismissUnknownBarcode(opts: { stocktakeId: number; unknownId: number }): Promise<void> {
  const db = getDb();
  await db.stocktakeUnknownBarcode.updateMany({
    where: { id: opts.unknownId, stocktakeId: opts.stocktakeId, resolvedAt: null },
    data: { resolvedAt: new Date(), resolvedItemId: null },
  });
}

// ─── Cancel ────────────────────────────────────────────────────────────────────

export async function cancelStocktake(opts: { stocktakeId: number; userId: number }): Promise<void> {
  const db = getDb();
  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ status: string; name: string }[]>`
      SELECT status, name FROM "Stocktake" WHERE id = ${opts.stocktakeId} FOR UPDATE
    `;
    if (rows.length === 0) throw new StocktakeCountError("Stocktake not found.");
    if (!["PREPARING", "IN_PROGRESS", "REVIEW"].includes(rows[0].status)) {
      throw new StocktakeCountError("Only a stocktake that is preparing, in progress or in review can be cancelled.");
    }
    const applied = await tx.stocktakeItem.count({ where: { stocktakeId: opts.stocktakeId, applied: true } });
    if (applied > 0) {
      throw new StocktakeCountError(`${applied} item${applied === 1 ? " has" : "s have"} already been applied to Shopify, so this stocktake can't be cancelled.`);
    }
    const [items, counted, scans] = await Promise.all([
      tx.stocktakeItem.count({ where: { stocktakeId: opts.stocktakeId } }),
      tx.stocktakeItem.count({ where: { stocktakeId: opts.stocktakeId, countedQty: { not: null } } }),
      tx.stocktakeScan.count({ where: { stocktakeId: opts.stocktakeId, undoneAt: null } }),
    ]);
    await tx.stocktake.update({ where: { id: opts.stocktakeId }, data: { status: "CANCELLED" } });
    await tx.auditLog.create({
      data: {
        userId: opts.userId,
        action: "STOCKTAKE_CANCELLED",
        details: `Stocktake #${opts.stocktakeId} "${rows[0].name}" cancelled (was ${rows[0].status}; ${counted} of ${items} items counted, ${scans} scans). Nothing was applied to Shopify.`,
      },
    });
  });
}
