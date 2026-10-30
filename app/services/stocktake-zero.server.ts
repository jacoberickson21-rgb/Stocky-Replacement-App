import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { getDb } from "../db.server";
import { logFailure } from "./failure-log.server";
import { fetchLiveInventoryLevels, getInventoryItemIdsByVariant } from "./shopify.server";
import { StocktakeCountError, isUniqueViolation, lockCountable, toView, type CountItemView } from "./stocktake-count.server";

// "Not scanned" flags for variants in products that have at least one count,
// and zeroing them. Zeroing records a count of 0 as MANUAL_SET scans sharing a
// batchId (one undo reverses it). Nothing here writes to Shopify — reads only.

const SIBLING_TTL_MS = 10 * 60 * 1000;
const SIBLING_RETRY_MS = 60 * 1000;
const MAX_ZERO_VARIANTS = 1000;

export type FlaggedVariant = {
  variantId: string;
  itemId: number | null; // null = free-scan sibling that isn't a stocktake item yet
  variantTitle: string;
  sku: string | null;
  onHand: number;
};

export type FlaggedProduct = {
  productId: string;
  title: string;
  vendor: string | null;
  variants: FlaggedVariant[];
  units: number;
  // Free scan: live quantities for this product's siblings are still loading
  checking: boolean;
};

export type FlaggedSummary = {
  products: FlaggedProduct[];
  totalVariants: number;
  totalUnits: number;
  checking: boolean;
};

// ─── Free-scan sibling quantities (in memory, never in the database) ───────────

type SiblingLevel = { onHand: number | null; tracked: boolean; fetchedAt: number };
const siblingLevels = new Map<number, Map<string, SiblingLevel>>();
const siblingLoading = new Map<number, Set<string>>();
const siblingRetryAfter = new Map<string, number>();

type SiblingRow = { variantId: string; productId: string; inventoryItemId: string | null };

function levelsFor(stocktakeId: number) {
  let m = siblingLevels.get(stocktakeId);
  if (!m) siblingLevels.set(stocktakeId, (m = new Map()));
  return m;
}

// Live on_hand for many variants: resolves missing inventory item ids, then
// reads levels — both chunked at 200 inside the Shopify helpers.
async function readLiveOnHand(rows: SiblingRow[], locationId: string) {
  const missing = rows.filter((r) => !r.inventoryItemId).map((r) => r.variantId);
  const resolved = await getInventoryItemIdsByVariant(missing);
  const invByVariant = new Map<string, string>();
  for (const r of rows) {
    const inv = r.inventoryItemId ?? resolved.get(r.variantId) ?? null;
    if (inv) invByVariant.set(r.variantId, inv);
  }
  const levels = await fetchLiveInventoryLevels([...new Set(invByVariant.values())], locationId);
  const out = new Map<string, { inventoryItemId: string | null; onHand: number | null; tracked: boolean; exists: boolean }>();
  for (const r of rows) {
    const inv = invByVariant.get(r.variantId) ?? null;
    const level = inv ? levels.get(inv) : undefined;
    out.set(r.variantId, {
      inventoryItemId: inv,
      onHand: level?.onHand ?? null,
      tracked: level?.tracked ?? false,
      exists: level != null,
    });
  }
  return out;
}

// Background refresh for products that need it; one combined read per call.
function refreshSiblings(stocktakeId: number, locationId: string, productIds: string[], rows: SiblingRow[]) {
  const loading = siblingLoading.get(stocktakeId) ?? new Set<string>();
  siblingLoading.set(stocktakeId, loading);
  for (const p of productIds) loading.add(p);
  readLiveOnHand(rows, locationId)
    .then((live) => {
      const m = levelsFor(stocktakeId);
      const now = Date.now();
      for (const [variantId, l] of live) m.set(variantId, { onHand: l.onHand, tracked: l.tracked && l.exists, fetchedAt: now });
    })
    .catch(async (err) => {
      for (const p of productIds) siblingRetryAfter.set(`${stocktakeId}:${p}`, Date.now() + SIBLING_RETRY_MS);
      await logFailure("STOCKTAKE_SIBLINGS", `Stocktake #${stocktakeId}`, err instanceof Error ? err.message : String(err));
    })
    .finally(() => {
      for (const p of productIds) loading.delete(p);
    });
}

// ─── Flags ─────────────────────────────────────────────────────────────────────

// Products "in play": at least one item with a count (a counted 0 included;
// undone scans that leave an item uncounted don't count).
async function inPlayProducts(stocktakeId: number) {
  return getDb().$queryRaw<{ productId: string; title: string; vendor: string | null }[]>`
    SELECT DISTINCT ON ("productId") "productId", title, vendor
    FROM "StocktakeItem"
    WHERE "stocktakeId" = ${stocktakeId} AND "countedQty" IS NOT NULL AND "productId" IS NOT NULL
    ORDER BY "productId", id
  `;
}

export async function getFlaggedSiblings(stocktakeId: number): Promise<FlaggedSummary> {
  const db = getDb();
  const stocktake = await db.stocktake.findUnique({ where: { id: stocktakeId }, select: { mode: true, locationId: true, status: true } });
  if (!stocktake) return { products: [], totalVariants: 0, totalUnits: 0, checking: false };

  // Items already in the stocktake, uncounted, expected on hand > 0, in an in-play product.
  const itemRows = await db.$queryRaw<
    { id: number; variantId: string; productId: string; title: string; vendor: string | null; variantTitle: string; sku: string | null; expectedQty: number }[]
  >`
    SELECT i.id, i."variantId", i."productId", i.title, i.vendor, i."variantTitle", i.sku, i."expectedQty"
    FROM "StocktakeItem" i
    WHERE i."stocktakeId" = ${stocktakeId}
      AND i."countedQty" IS NULL AND i.applied = false AND i."expectedQty" > 0
      AND i."productId" IN (
        SELECT "productId" FROM "StocktakeItem"
        WHERE "stocktakeId" = ${stocktakeId} AND "countedQty" IS NOT NULL AND "productId" IS NOT NULL
      )
    ORDER BY i.title, i."productId", i."variantTitle"
  `;

  const byProduct = new Map<string, FlaggedProduct>();
  const productFor = (productId: string, title: string, vendor: string | null) => {
    let p = byProduct.get(productId);
    if (!p) byProduct.set(productId, (p = { productId, title, vendor, variants: [], units: 0, checking: false }));
    return p;
  };
  for (const r of itemRows) {
    productFor(r.productId, r.title, r.vendor).variants.push({
      variantId: r.variantId, itemId: r.id, variantTitle: r.variantTitle, sku: r.sku, onHand: r.expectedQty,
    });
  }

  // Free scan: siblings that aren't items yet, from ProductCache + live on_hand.
  if (stocktake.mode === "FREE_SCAN" && (stocktake.status === "IN_PROGRESS" || stocktake.status === "REVIEW")) {
    const inPlay = await inPlayProducts(stocktakeId);
    if (inPlay.length > 0) {
      const productIds = inPlay.map((p) => p.productId);
      const existing = await db.stocktakeItem.findMany({
        where: { stocktakeId, productId: { in: productIds } },
        select: { variantId: true },
      });
      const isItem = new Set(existing.map((e) => e.variantId));
      const siblings = (
        await db.productCache.findMany({
          where: { productId: { in: productIds }, tracked: true },
          select: { variantId: true, productId: true, inventoryItemId: true, variantTitle: true, sku: true },
          orderBy: { variantTitle: "asc" },
        })
      ).filter((s) => !isItem.has(s.variantId));

      const levels = levelsFor(stocktakeId);
      const loading = siblingLoading.get(stocktakeId) ?? new Set<string>();
      const now = Date.now();
      const needRefresh: string[] = [];
      const meta = new Map(inPlay.map((p) => [p.productId, p]));

      for (const productId of productIds) {
        const rows = siblings.filter((s) => s.productId === productId);
        if (rows.length === 0) continue;
        const stale = rows.some((r) => {
          const l = levels.get(r.variantId);
          return !l || now - l.fetchedAt > SIBLING_TTL_MS;
        });
        const p = meta.get(productId)!;
        if (stale && !loading.has(productId) && (siblingRetryAfter.get(`${stocktakeId}:${productId}`) ?? 0) < now) {
          needRefresh.push(productId);
        }
        const product = productFor(productId, p.title, p.vendor);
        product.checking = loading.has(productId) || needRefresh.includes(productId);
        for (const r of rows) {
          const l = levels.get(r.variantId);
          if (!l || !l.tracked || l.onHand == null || l.onHand <= 0) continue;
          product.variants.push({ variantId: r.variantId, itemId: null, variantTitle: r.variantTitle, sku: r.sku, onHand: l.onHand });
        }
      }
      if (needRefresh.length > 0) {
        refreshSiblings(stocktakeId, stocktake.locationId, needRefresh, siblings.filter((s) => needRefresh.includes(s.productId)));
      }
    }
  }

  const products = [...byProduct.values()]
    .map((p) => ({ ...p, units: p.variants.reduce((s, v) => s + v.onHand, 0) }))
    .filter((p) => p.variants.length > 0 || p.checking)
    .sort((a, b) => a.title.localeCompare(b.title));
  return {
    products,
    totalVariants: products.reduce((s, p) => s + p.variants.length, 0),
    totalUnits: products.reduce((s, p) => s + p.units, 0),
    checking: products.some((p) => p.checking),
  };
}

// ─── Eligibility (shared by preview and zero) ──────────────────────────────────

type Candidate = {
  variantId: string;
  itemId: number | null;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  vendor: string | null;
  snapshotOnHand: number | null; // item expectedQty, or null for a free-scan sibling
  inventoryItemId: string | null;
  cost: number | null;
};

// Resolves the requested variants against the rules: the product must have a
// count in this stocktake, the variant must belong to that product, and must
// have no count at all. Anything else is returned as skipped with a reason.
async function resolveCandidates(stocktakeId: number, productId: string, variantIds: string[]) {
  const db = getDb();
  const stocktake = await db.stocktake.findUnique({ where: { id: stocktakeId } });
  if (!stocktake) throw new StocktakeCountError("Stocktake not found.");
  if (stocktake.status !== "IN_PROGRESS") throw new StocktakeCountError("This stocktake is no longer accepting counts.");
  const ids = [...new Set(variantIds)].slice(0, MAX_ZERO_VARIANTS);
  if (ids.length === 0) throw new StocktakeCountError("No variants selected.");

  const inPlay = await db.stocktakeItem.count({ where: { stocktakeId, productId, countedQty: { not: null } } });
  if (inPlay === 0) throw new StocktakeCountError("This product has no scans in this stocktake, so nothing in it can be zeroed.");

  const items = await db.stocktakeItem.findMany({ where: { stocktakeId, variantId: { in: ids } } });
  const itemByVariant = new Map(items.map((i) => [i.variantId, i]));
  const cacheRows = stocktake.mode === "FREE_SCAN"
    ? await db.productCache.findMany({ where: { variantId: { in: ids.filter((id) => !itemByVariant.has(id)) } } })
    : [];
  const cacheByVariant = new Map(cacheRows.map((c) => [c.variantId, c]));

  const candidates: Candidate[] = [];
  const skipped: { label: string; reason: string }[] = [];
  for (const variantId of ids) {
    const item = itemByVariant.get(variantId);
    if (item) {
      const label = `${item.title} — ${item.variantTitle}`;
      if (item.productId !== productId) skipped.push({ label, reason: "belongs to a different product" });
      else if (item.countedQty != null) skipped.push({ label, reason: `already counted (${item.countedQty})` });
      else if (item.applied) skipped.push({ label, reason: "already applied" });
      else if (item.expectedQty <= 0) skipped.push({ label, reason: "expected on hand is 0" });
      else candidates.push({
        variantId, itemId: item.id, productTitle: item.title, variantTitle: item.variantTitle, sku: item.sku,
        vendor: item.vendor, snapshotOnHand: item.expectedQty, inventoryItemId: item.inventoryItemId,
        cost: item.cost == null ? null : Number(item.cost),
      });
      continue;
    }
    const cache = cacheByVariant.get(variantId);
    if (stocktake.mode !== "FREE_SCAN" || !cache) {
      skipped.push({ label: variantId, reason: "not part of this stocktake" });
    } else if (cache.productId !== productId) {
      skipped.push({ label: `${cache.title} — ${cache.variantTitle}`, reason: "belongs to a different product" });
    } else if (!cache.tracked) {
      skipped.push({ label: `${cache.title} — ${cache.variantTitle}`, reason: "inventory tracking is off" });
    } else {
      candidates.push({
        variantId, itemId: null, productTitle: cache.title, variantTitle: cache.variantTitle, sku: cache.sku,
        vendor: cache.vendor, snapshotOnHand: null, inventoryItemId: cache.inventoryItemId,
        cost: cache.cost == null ? null : Number(cache.cost),
      });
    }
  }
  return { stocktake, candidates, skipped };
}

// ─── Preview (read-only) ───────────────────────────────────────────────────────

export type ZeroPreviewRow = {
  variantId: string;
  variantTitle: string;
  sku: string | null;
  snapshotOnHand: number | null;
  liveOnHand: number | null; // informational only
  note: string | null;
};

export async function previewZero(opts: { stocktakeId: number; productId: string; variantIds: string[] }) {
  const { stocktake, candidates, skipped } = await resolveCandidates(opts.stocktakeId, opts.productId, opts.variantIds);
  const live = await readLiveOnHand(
    candidates.map((c) => ({ variantId: c.variantId, productId: opts.productId, inventoryItemId: c.inventoryItemId })),
    stocktake.locationId
  );
  const rows: ZeroPreviewRow[] = candidates.map((c) => {
    const l = live.get(c.variantId);
    let note: string | null = null;
    if (!l?.exists) note = "no longer in Shopify — will be skipped";
    else if (!l.tracked) note = "tracking is now off — will be skipped";
    else if (c.itemId == null && (l.onHand ?? 0) <= 0) note = "nothing on hand now — will be skipped";
    else if (c.snapshotOnHand != null && l.onHand != null && l.onHand !== c.snapshotOnHand) note = "on hand changed since the snapshot; review's drift check will flag it";
    return { variantId: c.variantId, variantTitle: c.variantTitle, sku: c.sku, snapshotOnHand: c.snapshotOnHand, liveOnHand: l?.onHand ?? null, note };
  });
  return {
    productTitle: candidates[0]?.productTitle ?? null,
    rows,
    skipped,
    units: rows.reduce((s, r) => s + (r.snapshotOnHand ?? r.liveOnHand ?? 0), 0),
  };
}

// ─── Zero ──────────────────────────────────────────────────────────────────────

export type ZeroResult = {
  batchId: string;
  zeroed: CountItemView[];
  units: number;
  skipped: { label: string; reason: string }[];
};

export async function zeroUnscanned(opts: {
  stocktakeId: number;
  userId: number;
  productId: string;
  variantIds: string[];
}): Promise<ZeroResult> {
  const db = getDb();
  const { stocktake, candidates, skipped } = await resolveCandidates(opts.stocktakeId, opts.productId, opts.variantIds);

  // Free scan: create items for siblings only now, each with a live on_hand
  // snapshot taken at this moment (read-only against Shopify).
  const toCreate = candidates.filter((c) => c.itemId == null);
  if (toCreate.length > 0) {
    const live = await readLiveOnHand(
      toCreate.map((c) => ({ variantId: c.variantId, productId: opts.productId, inventoryItemId: c.inventoryItemId })),
      stocktake.locationId
    );
    const data: Prisma.StocktakeItemCreateManyInput[] = [];
    for (const c of toCreate) {
      const l = live.get(c.variantId);
      const label = `${c.productTitle} — ${c.variantTitle}`;
      if (!l?.exists || !l.inventoryItemId) { skipped.push({ label, reason: "no longer in Shopify" }); continue; }
      if (!l.tracked) {
        await db.productCache.updateMany({ where: { variantId: c.variantId }, data: { tracked: false } });
        skipped.push({ label, reason: "inventory tracking is off" });
        continue;
      }
      if ((l.onHand ?? 0) <= 0) { skipped.push({ label, reason: "nothing on hand now" }); continue; }
      data.push({
        stocktakeId: opts.stocktakeId, variantId: c.variantId, productId: opts.productId,
        inventoryItemId: l.inventoryItemId, sku: c.sku, barcode: null, title: c.productTitle,
        variantTitle: c.variantTitle, vendor: c.vendor, expectedQty: l.onHand ?? 0, cost: c.cost,
      });
    }
    if (data.length > 0) {
      try {
        await db.stocktakeItem.createMany({ data, skipDuplicates: true });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
  }

  const targetVariantIds = candidates.map((c) => c.variantId);
  const batchId = randomUUID();

  return db.$transaction(
    async (tx) => {
      const st = await lockCountable(tx, opts.stocktakeId);
      // Re-check under lock: product still in play; each variant still uncounted.
      const inPlay = await tx.stocktakeItem.count({
        where: { stocktakeId: opts.stocktakeId, productId: opts.productId, countedQty: { not: null } },
      });
      if (inPlay === 0) throw new StocktakeCountError("This product no longer has any scans, so nothing in it was zeroed.");

      const locked = targetVariantIds.length
        ? await tx.$queryRaw<{ id: number; variantId: string; productId: string | null; countedQty: number | null; applied: boolean; expectedQty: number; title: string; variantTitle: string; sku: string | null }[]>`
            SELECT id, "variantId", "productId", "countedQty", applied, "expectedQty", title, "variantTitle", sku
            FROM "StocktakeItem"
            WHERE "stocktakeId" = ${opts.stocktakeId} AND "variantId" = ANY(${targetVariantIds})
            ORDER BY id
            FOR UPDATE
          `
        : [];

      const eligible = locked.filter((i) => {
        const label = `${i.title} — ${i.variantTitle}`;
        if (i.productId !== opts.productId) { skipped.push({ label, reason: "belongs to a different product" }); return false; }
        if (i.countedQty != null) { skipped.push({ label, reason: `scanned meanwhile (now ${i.countedQty})` }); return false; }
        if (i.applied) { skipped.push({ label, reason: "already applied" }); return false; }
        if (i.expectedQty <= 0) { skipped.push({ label, reason: "expected on hand is 0" }); return false; }
        return true;
      });
      if (eligible.length === 0) throw new StocktakeCountError(`Nothing zeroed. ${skipped.map((s) => `${s.label}: ${s.reason}`).slice(0, 5).join("; ")}`);

      const now = new Date();
      await tx.stocktakeItem.updateMany({ where: { id: { in: eligible.map((i) => i.id) }, countedQty: null }, data: { countedQty: 0 } });
      await tx.stocktakeScan.createMany({
        data: eligible.map((i) => ({
          stocktakeId: opts.stocktakeId, itemId: i.id, kind: "MANUAL_SET" as const,
          qtyBefore: null, qtyAfter: 0, scannedById: opts.userId, scannedAt: now, batchId,
        })),
      });

      const units = eligible.reduce((s, i) => s + i.expectedQty, 0);
      const product = eligible[0].title;
      const listed = eligible.slice(0, 50).map((i) => `${i.variantTitle}${i.sku ? ` (${i.sku})` : ""}: ${i.expectedQty}`);
      await tx.auditLog.create({
        data: {
          userId: opts.userId,
          action: "STOCKTAKE_PRODUCT_ZEROED",
          details:
            `Stocktake #${opts.stocktakeId} "${st.name}": ${product} — ${eligible.length} unscanned variant${eligible.length === 1 ? "" : "s"} counted as 0 ` +
            `(${units} unit${units === 1 ? "" : "s"} expected on hand). Batch ${batchId}. ` +
            `Variants: ${listed.join("; ")}${eligible.length > 50 ? `; +${eligible.length - 50} more` : ""}.` +
            (skipped.length ? ` Skipped ${skipped.length}: ${skipped.slice(0, 10).map((s) => `${s.label} (${s.reason})`).join("; ")}.` : "") +
            " No Shopify changes until apply.",
        },
      });

      const zeroed = await tx.stocktakeItem.findMany({ where: { id: { in: eligible.map((i) => i.id) } } });
      return { batchId, zeroed: zeroed.map(toView), units, skipped };
    },
    { timeout: 30_000 }
  );
}
