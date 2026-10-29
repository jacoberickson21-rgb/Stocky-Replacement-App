import type { Prisma } from "@prisma/client";
import { getDb } from "../db.server";
import { logFailure } from "./failure-log.server";
import {
  fetchLiveInventoryLevels,
  getInventoryItemIdsByVariant,
  getLocationId,
} from "./shopify.server";

// Every nodes()/batch call in the stocktake flow is chunked at this size.
const SNAPSHOT_CHUNK_SIZE = 200;
const PREVIEW_PAGE_SIZE = 50;

// ─── Scope ─────────────────────────────────────────────────────────────────────

export type StockLevelFilter = "all" | "in_stock" | "zero_or_negative";
export type BarcodeFilter = "all" | "has" | "missing";

export type StocktakeScope = {
  vendor: string;
  productType: string;
  tag: string;
  status: string;
  stock: StockLevelFilter;
  barcode: BarcodeFilter;
  q: string;
  excludedVariantIds: string[];
  excludedProductIds: string[];
};

export const EMPTY_SCOPE: StocktakeScope = {
  vendor: "",
  productType: "",
  tag: "",
  status: "",
  stock: "all",
  barcode: "all",
  q: "",
  excludedVariantIds: [],
  excludedProductIds: [],
};

// What gets stored in Stocktake.filters. The scope the staff chose, plus the
// exact variant list resolved at start (so a resumed snapshot covers the same
// variants even if ProductCache changes) and the snapshot outcome.
export type StocktakeFiltersJson = {
  scope?: StocktakeScope;
  scopeVariantIds?: string[];
  snapshot?: {
    droppedUntracked: string[];
    droppedMissing: string[];
    notStockedAtLocation: number;
    error: string | null;
    finishedAt: string | null;
  };
};

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function parseScope(raw: unknown): StocktakeScope {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const stock = str(o.stock);
  const barcode = str(o.barcode);
  return {
    vendor: str(o.vendor),
    productType: str(o.productType),
    tag: str(o.tag),
    status: str(o.status),
    stock: stock === "in_stock" || stock === "zero_or_negative" ? stock : "all",
    barcode: barcode === "has" || barcode === "missing" ? barcode : "all",
    q: str(o.q),
    excludedVariantIds: strArray(o.excludedVariantIds),
    excludedProductIds: strArray(o.excludedProductIds),
  };
}

export function readFiltersJson(raw: Prisma.JsonValue | null): StocktakeFiltersJson {
  return (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as StocktakeFiltersJson;
}

// Filters only — exclusions are applied separately so the preview can still
// show excluded rows (greyed out) and let staff restore them.
function buildFilterWhere(scope: StocktakeScope): Prisma.ProductCacheWhereInput {
  const and: Prisma.ProductCacheWhereInput[] = [{ tracked: true }];
  if (scope.vendor) and.push({ vendor: scope.vendor });
  if (scope.productType) and.push({ productType: scope.productType });
  if (scope.tag) and.push({ tags: { has: scope.tag } });
  if (scope.status) and.push({ status: scope.status });
  if (scope.stock === "in_stock") and.push({ currentInventory: { gt: 0 } });
  if (scope.stock === "zero_or_negative") and.push({ currentInventory: { lte: 0 } });
  if (scope.barcode === "has") and.push({ barcode: { not: null } }, { NOT: { barcode: "" } });
  if (scope.barcode === "missing") and.push({ OR: [{ barcode: null }, { barcode: "" }] });
  if (scope.q) {
    and.push({
      OR: [
        { title: { contains: scope.q, mode: "insensitive" } },
        { variantTitle: { contains: scope.q, mode: "insensitive" } },
        { sku: { contains: scope.q, mode: "insensitive" } },
        { barcode: { contains: scope.q, mode: "insensitive" } },
      ],
    });
  }
  return { AND: and };
}

function buildIncludedWhere(scope: StocktakeScope): Prisma.ProductCacheWhereInput {
  const and: Prisma.ProductCacheWhereInput[] = [buildFilterWhere(scope)];
  if (scope.excludedVariantIds.length > 0) and.push({ variantId: { notIn: scope.excludedVariantIds } });
  if (scope.excludedProductIds.length > 0) and.push({ productId: { notIn: scope.excludedProductIds } });
  return { AND: and };
}

export type ScopeFilterOptions = {
  vendors: string[];
  productTypes: string[];
  tags: string[];
  statuses: string[];
  lastSyncAt: string | null;
};

export async function getScopeFilterOptions(): Promise<ScopeFilterOptions> {
  const db = getDb();
  const [vendors, productTypes, statuses, tags, lastSync] = await Promise.all([
    db.productCache.findMany({
      where: { tracked: true, vendor: { not: null } },
      distinct: ["vendor"],
      select: { vendor: true },
      orderBy: { vendor: "asc" },
    }),
    db.productCache.findMany({
      where: { tracked: true, productType: { not: null } },
      distinct: ["productType"],
      select: { productType: true },
      orderBy: { productType: "asc" },
    }),
    db.productCache.findMany({
      where: { tracked: true },
      distinct: ["status"],
      select: { status: true },
      orderBy: { status: "asc" },
    }),
    db.$queryRaw<{ tag: string }[]>`
      SELECT DISTINCT unnest(tags) AS tag FROM "ProductCache" WHERE tracked = true ORDER BY 1
    `,
    db.syncLog.findFirst({
      where: { status: "COMPLETE" },
      orderBy: { completedAt: "desc" },
      select: { completedAt: true },
    }),
  ]);
  return {
    vendors: vendors.map((v) => v.vendor!).filter(Boolean),
    productTypes: productTypes.map((p) => p.productType!).filter(Boolean),
    tags: tags.map((t) => t.tag).filter(Boolean),
    statuses: statuses.map((s) => s.status),
    lastSyncAt: lastSync?.completedAt?.toISOString() ?? null,
  };
}

export type ScopePreviewRow = {
  variantId: string;
  productId: string;
  title: string;
  variantTitle: string;
  sku: string | null;
  barcode: string | null;
  vendor: string | null;
  status: string;
  currentInventory: number;
  cost: number | null;
  excluded: boolean;
};

export type ScopePreview = {
  rows: ScopePreviewRow[];
  page: number;
  totalPages: number;
  matchingVariants: number;
  totals: {
    variants: number;
    products: number;
    units: number;
    costValue: number;
    missingCost: number;
  };
};

export async function getScopePreview(scope: StocktakeScope, page: number): Promise<ScopePreview> {
  const db = getDb();
  const filterWhere = buildFilterWhere(scope);
  const matchingVariants = await db.productCache.count({ where: filterWhere });
  const totalPages = Math.max(1, Math.ceil(matchingVariants / PREVIEW_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);

  const [pageRows, included] = await Promise.all([
    db.productCache.findMany({
      where: filterWhere,
      // productId as a tiebreak keeps each product family contiguous
      orderBy: [{ title: "asc" }, { productId: "asc" }, { variantTitle: "asc" }],
      skip: (safePage - 1) * PREVIEW_PAGE_SIZE,
      take: PREVIEW_PAGE_SIZE,
      select: {
        variantId: true, productId: true, title: true, variantTitle: true, sku: true,
        barcode: true, vendor: true, status: true, currentInventory: true, cost: true,
      },
    }),
    db.productCache.findMany({
      where: buildIncludedWhere(scope),
      select: { productId: true, currentInventory: true, cost: true },
    }),
  ]);

  const excludedVariants = new Set(scope.excludedVariantIds);
  const excludedProducts = new Set(scope.excludedProductIds);

  // Same math as the inventory valuation report: cost × cached quantity.
  let units = 0;
  let costValue = 0;
  let missingCost = 0;
  const products = new Set<string>();
  for (const r of included) {
    units += r.currentInventory;
    products.add(r.productId);
    if (r.cost == null) missingCost++;
    else costValue += Number(r.cost) * r.currentInventory;
  }

  return {
    rows: pageRows.map((r) => ({
      ...r,
      cost: r.cost == null ? null : Number(r.cost),
      excluded: excludedVariants.has(r.variantId) || excludedProducts.has(r.productId),
    })),
    page: safePage,
    totalPages,
    matchingVariants,
    totals: {
      variants: included.length,
      products: products.size,
      units,
      costValue: Math.round(costValue * 100) / 100,
      missingCost,
    },
  };
}

// ─── Start ─────────────────────────────────────────────────────────────────────

function describeScope(scope: StocktakeScope): string {
  const parts: string[] = [];
  if (scope.vendor) parts.push(`vendor=${scope.vendor}`);
  if (scope.productType) parts.push(`type=${scope.productType}`);
  if (scope.tag) parts.push(`tag=${scope.tag}`);
  if (scope.status) parts.push(`status=${scope.status}`);
  if (scope.stock !== "all") parts.push(`stock=${scope.stock}`);
  if (scope.barcode !== "all") parts.push(`barcode=${scope.barcode}`);
  if (scope.q) parts.push(`search="${scope.q}"`);
  if (scope.excludedProductIds.length) parts.push(`${scope.excludedProductIds.length} products removed`);
  if (scope.excludedVariantIds.length) parts.push(`${scope.excludedVariantIds.length} variants removed`);
  return parts.length ? parts.join(", ") : "no filters";
}

export class StocktakeStartError extends Error {}

export async function startScopedStocktake(opts: {
  name: string;
  notes: string | null;
  scope: StocktakeScope;
  userId: number;
}): Promise<number> {
  const db = getDb();
  const variants = await db.productCache.findMany({
    where: buildIncludedWhere(opts.scope),
    select: { variantId: true },
    orderBy: [{ title: "asc" }, { productId: "asc" }, { variantTitle: "asc" }],
  });
  if (variants.length === 0) {
    throw new StocktakeStartError("The scope has no variants to count.");
  }

  let locationId: string;
  try {
    locationId = await getLocationId();
  } catch (err) {
    throw new StocktakeStartError(
      `Could not fetch the Shopify location: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const filters: StocktakeFiltersJson = {
    scope: opts.scope,
    scopeVariantIds: variants.map((v) => v.variantId),
  };

  const stocktake = await db.$transaction(async (tx) => {
    const created = await tx.stocktake.create({
      data: {
        name: opts.name,
        mode: "SCOPED",
        status: "PREPARING",
        filters: filters as Prisma.InputJsonValue,
        locationId,
        notes: opts.notes,
        startedById: opts.userId,
        snapshotTotal: variants.length,
        snapshotDone: 0,
      },
    });
    await tx.auditLog.create({
      data: {
        userId: opts.userId,
        action: "STOCKTAKE_STARTED",
        details: `Stocktake #${created.id} "${opts.name}" started — scoped count of ${variants.length} variants (${describeScope(opts.scope)})`,
      },
    });
    return created;
  });

  runStocktakeSnapshot(stocktake.id).catch((err) => {
    console.error("[stocktake] background snapshot failed:", err);
  });

  return stocktake.id;
}

export async function startFreeScanStocktake(opts: {
  name: string;
  notes: string | null;
  userId: number;
}): Promise<number> {
  const db = getDb();
  let locationId: string;
  try {
    locationId = await getLocationId();
  } catch (err) {
    throw new StocktakeStartError(
      `Could not fetch the Shopify location: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const stocktake = await db.$transaction(async (tx) => {
    const created = await tx.stocktake.create({
      data: {
        name: opts.name,
        mode: "FREE_SCAN",
        status: "IN_PROGRESS",
        locationId,
        notes: opts.notes,
        startedById: opts.userId,
      },
    });
    await tx.auditLog.create({
      data: {
        userId: opts.userId,
        action: "STOCKTAKE_STARTED",
        details: `Stocktake #${created.id} "${opts.name}" started — free scan`,
      },
    });
    return created;
  });
  return stocktake.id;
}

// ─── Live Snapshot (background) ────────────────────────────────────────────────

// Snapshots running in this server process. Used to stop a double-start and to
// tell the detail page whether a PREPARING stocktake needs a manual Resume
// (e.g. the server restarted mid-snapshot).
const runningSnapshots = new Set<number>();

export function isSnapshotRunning(stocktakeId: number): boolean {
  return runningSnapshots.has(stocktakeId);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Reads expected quantities live from Shopify (never ProductCache, which can be
// a day stale) and creates the StocktakeItem rows. Read-only against Shopify.
// Resumable: variants that already have an item, or were already dropped, are
// skipped, and the unique (stocktakeId, variantId) index stops duplicates.
export async function runStocktakeSnapshot(stocktakeId: number): Promise<void> {
  // Registered before any await so a concurrent call/poll sees it immediately.
  if (runningSnapshots.has(stocktakeId)) return;
  runningSnapshots.add(stocktakeId);

  const db = getDb();
  try {
    const stocktake = await db.stocktake.findUnique({ where: { id: stocktakeId } });
    if (!stocktake || stocktake.status !== "PREPARING") return;

    const filters = readFiltersJson(stocktake.filters);
    const scopeVariantIds = filters.scopeVariantIds ?? [];
    const snapshot = {
      droppedUntracked: filters.snapshot?.droppedUntracked ?? [],
      droppedMissing: filters.snapshot?.droppedMissing ?? [],
      notStockedAtLocation: filters.snapshot?.notStockedAtLocation ?? 0,
      error: null as string | null,
      finishedAt: null as string | null,
    };

    const saveProgress = async (extra: Prisma.StocktakeUpdateInput = {}) => {
      const done = await db.stocktakeItem.count({ where: { stocktakeId } });
      await db.stocktake.update({
        where: { id: stocktakeId },
        data: {
          snapshotDone: done + snapshot.droppedUntracked.length + snapshot.droppedMissing.length,
          filters: { ...filters, snapshot } as Prisma.InputJsonValue,
          ...extra,
        },
      });
    };

    try {
      const existing = await db.stocktakeItem.findMany({
        where: { stocktakeId },
        select: { variantId: true },
      });
      const skip = new Set([
        ...existing.map((e) => e.variantId),
        ...snapshot.droppedUntracked,
        ...snapshot.droppedMissing,
      ]);
      const remaining = scopeVariantIds.filter((id) => !skip.has(id));
      await saveProgress();

      for (const variantIds of chunk(remaining, SNAPSHOT_CHUNK_SIZE)) {
        const cacheRows = await db.productCache.findMany({ where: { variantId: { in: variantIds } } });
        const cacheByVariant = new Map(cacheRows.map((r) => [r.variantId, r]));

        // Resolve any inventoryItemIds the cache doesn't have (live, read-only).
        const missingInvIds = variantIds.filter((id) => !cacheByVariant.get(id)?.inventoryItemId);
        const resolvedInvIds = await getInventoryItemIdsByVariant(missingInvIds);
        const invIdByVariant = new Map<string, string>();
        for (const id of variantIds) {
          const invId = cacheByVariant.get(id)?.inventoryItemId ?? resolvedInvIds.get(id) ?? null;
          if (invId) invIdByVariant.set(id, invId);
        }

        const levels = await fetchLiveInventoryLevels([...invIdByVariant.values()], stocktake.locationId);

        const items: Prisma.StocktakeItemCreateManyInput[] = [];
        const nowUntracked: string[] = [];
        for (const variantId of variantIds) {
          const cache = cacheByVariant.get(variantId);
          const invId = invIdByVariant.get(variantId);
          const level = invId ? levels.get(invId) : undefined;
          if (!cache || !invId || !level) {
            snapshot.droppedMissing.push(variantId);
            continue;
          }
          if (!level.tracked) {
            snapshot.droppedUntracked.push(variantId);
            nowUntracked.push(variantId);
            continue;
          }
          if (level.onHand === null) snapshot.notStockedAtLocation++;
          const cost = level.unitCost ?? (cache.cost == null ? null : Number(cache.cost));
          items.push({
            stocktakeId,
            variantId,
            productId: cache.productId,
            inventoryItemId: invId,
            sku: cache.sku,
            barcode: cache.barcode,
            title: cache.title,
            variantTitle: cache.variantTitle,
            vendor: cache.vendor,
            expectedQty: level.onHand ?? 0,
            cost,
          });
        }

        if (items.length > 0) {
          await db.stocktakeItem.createMany({ data: items, skipDuplicates: true });
        }
        // Correct the local cache so these stop appearing in future scopes.
        if (nowUntracked.length > 0) {
          await db.productCache.updateMany({
            where: { variantId: { in: nowUntracked } },
            data: { tracked: false },
          });
        }
        await saveProgress();
      }

      snapshot.finishedAt = new Date().toISOString();
      await saveProgress({ status: "IN_PROGRESS" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      snapshot.error = msg;
      await logFailure("STOCKTAKE_SNAPSHOT", `Stocktake #${stocktakeId} "${stocktake.name}"`, msg);
      await saveProgress().catch(() => {});
    }
  } finally {
    runningSnapshots.delete(stocktakeId);
  }
}
