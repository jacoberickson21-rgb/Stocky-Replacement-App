import { Prisma, type StocktakeMode, type StocktakeStatus } from "@prisma/client";
import { getDb } from "../db.server";
import { readFiltersJson, type ReviewIssue } from "./stocktake.server";
import { itemStatusLabels, type ItemStatus } from "../utils/stocktake-labels";

// Read-only reporting for stocktakes: the list page, the detail page, the
// printable summary and the CSV rollback record all read from here, so they
// always agree. Variance = counted − expected snapshot (on_hand). Applied
// change = target − live on_hand at review, for items Shopify confirmed.

// ─── List ──────────────────────────────────────────────────────────────────────

export const LIST_PAGE_SIZE = 50;

export type StocktakeListRow = {
  id: number;
  name: string;
  mode: StocktakeMode;
  status: StocktakeStatus;
  startedAt: string;
  completedAt: string | null;
  startedBy: string;
  completedBy: string | null;
  itemsCounted: number;
  varianceUnits: number;
  varianceValue: number;
};

export async function listStocktakes(opts: { status: StocktakeStatus | null; q: string; page: number }) {
  const db = getDb();
  const conditions: Prisma.Sql[] = [];
  if (opts.status) conditions.push(Prisma.sql`s.status = ${opts.status}::"StocktakeStatus"`);
  if (opts.q) conditions.push(Prisma.sql`s.name ILIKE ${`%${opts.q}%`}`);
  const where = conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}` : Prisma.empty;

  // An unscanned item only has a count (0) when "set unscanned to 0" was on in a scoped stocktake.
  const effectiveCount = Prisma.sql`COALESCE(i."countedQty", CASE WHEN s."zeroUnscanned" AND s.mode = 'SCOPED' THEN 0 END)`;

  const [rows, countRows] = await Promise.all([
    db.$queryRaw<StocktakeListRow[]>(Prisma.sql`
      SELECT s.id, s.name, s.mode, s.status,
             s."startedAt", s."completedAt",
             su.name AS "startedBy", cu.name AS "completedBy",
             COUNT(i.id) FILTER (WHERE i."countedQty" IS NOT NULL)::int AS "itemsCounted",
             COALESCE(SUM(${effectiveCount} - i."expectedQty"), 0)::int AS "varianceUnits",
             COALESCE(SUM((${effectiveCount} - i."expectedQty") * i.cost), 0)::float8 AS "varianceValue"
      FROM "Stocktake" s
      JOIN "User" su ON su.id = s."startedById"
      LEFT JOIN "User" cu ON cu.id = s."completedById"
      LEFT JOIN "StocktakeItem" i ON i."stocktakeId" = s.id
      ${where}
      GROUP BY s.id, su.name, cu.name
      ORDER BY s."startedAt" DESC
      LIMIT ${LIST_PAGE_SIZE} OFFSET ${(opts.page - 1) * LIST_PAGE_SIZE}
    `),
    db.$queryRaw<{ total: number }[]>(Prisma.sql`SELECT COUNT(*)::int AS total FROM "Stocktake" s ${where}`),
  ]);

  const total = countRows[0]?.total ?? 0;
  return {
    rows: rows.map((r) => ({
      ...r,
      startedAt: new Date(r.startedAt).toISOString(),
      completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
    })),
    total,
    totalPages: Math.max(1, Math.ceil(total / LIST_PAGE_SIZE)),
  };
}

// ─── One stocktake ─────────────────────────────────────────────────────────────

export { itemStatusLabels };
export type { ItemStatus };

export type ReportItem = {
  id: number;
  sku: string | null;
  title: string;
  variantTitle: string;
  barcode: string | null;
  variantId: string;
  inventoryItemId: string;
  cost: number | null;
  outsideScope: boolean;
  expected: number;
  counted: number | null;
  zeroedUnscanned: boolean;
  liveAtReview: number | null;
  availableAtReview: number | null;
  target: number | null;
  variance: number | null;
  varianceValue: number | null;
  applied: boolean;
  appliedAt: string | null;
  appliedChange: number | null;
  status: ItemStatus;
  // Human-readable: errors, exclusion reason, drift decision, scope notes
  notes: string[];
};

function issueNote(issue: ReviewIssue): string {
  if (issue === "NOT_STOCKED") return "Not stocked at the location at review";
  if (issue === "UNTRACKED") return "Inventory tracking was off at review";
  return "No longer existed in Shopify at review";
}

export async function getStocktakeReport(stocktakeId: number, opts: { includeItems?: boolean } = {}) {
  const db = getDb();
  const stocktake = await db.stocktake.findUnique({
    where: { id: stocktakeId },
    include: {
      startedBy: { select: { name: true } },
      completedBy: { select: { name: true } },
    },
  });
  if (!stocktake) return null;

  const review = readFiltersJson(stocktake.filters).review;
  const zeroes = stocktake.zeroUnscanned && stocktake.mode === "SCOPED";

  const rows = opts.includeItems === false ? [] : await db.stocktakeItem.findMany({
    where: { stocktakeId },
    orderBy: [{ title: "asc" }, { productId: "asc" }, { variantTitle: "asc" }],
    include: { excludedBy: { select: { name: true } } },
  });

  const items: ReportItem[] = rows.map((r) => {
    const cost = r.cost == null ? null : Number(r.cost);
    const zeroedUnscanned = r.countedQty == null && zeroes;
    const effective = r.countedQty ?? (zeroedUnscanned ? 0 : null);
    const variance = effective != null ? effective - r.expectedQty : null;
    const issue = review?.issues[String(r.id)] ?? null;

    const notes: string[] = [];
    if (r.outsideScope) notes.push("Added outside scope");
    if (zeroedUnscanned) notes.push("Unscanned, set to 0");
    if (r.drifted) notes.push(`Drifted during count${r.driftResolution ? ` — ${r.driftResolution.replace(/_/g, " ").toLowerCase()}` : ""}`);
    if (issue) notes.push(issueNote(issue));
    if (r.excludedAt) {
      notes.push(`Excluded by ${r.excludedBy?.name ?? "unknown"} on ${r.excludedAt.toISOString().slice(0, 10)}: ${r.excludeReason ?? "no reason"}`);
    }
    if (r.applyError && !r.applied) notes.push(r.applyError);

    let status: ItemStatus;
    if (r.applied) status = "APPLIED";
    else if (r.excludedAt) status = "EXCLUDED";
    else if (r.applyStale) status = "CHANGED_SINCE_REVIEW";
    else if (r.applyError) status = "FAILED";
    else if (issue === "NOT_STOCKED" && effective != null) status = "NEEDS_ACTIVATION";
    else if ((issue === "UNTRACKED" || issue === "MISSING") && effective != null) status = "NOT_SETTABLE";
    else if (r.targetQty != null) status = "PENDING";
    else if (effective == null) status = "NOT_COUNTED";
    else if (r.drifted && r.driftResolution === "SKIP") status = "SKIPPED_DRIFT";
    else status = "NO_CHANGE";

    return {
      id: r.id,
      sku: r.sku,
      title: r.title,
      variantTitle: r.variantTitle,
      barcode: r.barcode,
      variantId: r.variantId,
      inventoryItemId: r.inventoryItemId,
      cost,
      outsideScope: r.outsideScope,
      expected: r.expectedQty,
      counted: r.countedQty,
      zeroedUnscanned,
      liveAtReview: r.liveQtyAtReview,
      availableAtReview: r.liveAvailableAtReview,
      target: r.targetQty,
      variance,
      varianceValue: variance != null && cost != null ? Math.round(variance * cost * 100) / 100 : null,
      applied: r.applied,
      appliedAt: r.appliedAt?.toISOString() ?? null,
      appliedChange: r.applied && r.targetQty != null && r.liveQtyAtReview != null ? r.targetQty - r.liveQtyAtReview : null,
      status,
      notes,
    };
  });

  let varianceUnits = 0, varianceValue = 0, unitsUp = 0, unitsDown = 0, netAppliedValue = 0;
  let itemsCounted = 0, itemsWithVariance = 0, itemsApplied = 0, varianceNoCost = 0;
  for (const i of items) {
    if (i.counted != null) itemsCounted++;
    if (i.variance != null && i.variance !== 0) {
      itemsWithVariance++;
      varianceUnits += i.variance;
      if (i.varianceValue == null) varianceNoCost++;
      else varianceValue += i.varianceValue;
    }
    if (i.applied) {
      itemsApplied++;
      const change = i.appliedChange ?? 0;
      if (change > 0) unitsUp += change;
      else unitsDown += -change;
      if (i.cost != null) netAppliedValue += change * i.cost;
    }
  }

  return {
    stocktake: {
      id: stocktake.id,
      name: stocktake.name,
      mode: stocktake.mode,
      status: stocktake.status,
      notes: stocktake.notes,
      zeroUnscanned: stocktake.zeroUnscanned,
      locationId: stocktake.locationId,
      startedBy: stocktake.startedBy.name,
      startedAt: stocktake.startedAt.toISOString(),
      completedBy: stocktake.completedBy?.name ?? null,
      completedAt: stocktake.completedAt?.toISOString() ?? null,
      applyReason: stocktake.applyReason,
      applyTestResult: stocktake.applyTestResult,
      applyError: stocktake.applyError,
      reviewCheckedAt: review?.checkedAt ?? null,
    },
    items,
    totals: {
      items: items.length,
      itemsCounted,
      itemsWithVariance,
      varianceUnits,
      varianceValue: Math.round(varianceValue * 100) / 100,
      varianceNoCost,
      itemsApplied,
      unitsUp,
      unitsDown,
      netAppliedUnits: unitsUp - unitsDown,
      netAppliedValue: Math.round(netAppliedValue * 100) / 100,
    },
  };
}

export type StocktakeReport = NonNullable<Awaited<ReturnType<typeof getStocktakeReport>>>;

// Audit log search that matches this stocktake's entries ("Stocktake #12 "…)
// without also matching #120.
export function auditSearchHref(stocktakeId: number): string {
  return `/audit?search=${encodeURIComponent(`Stocktake #${stocktakeId} "`)}`;
}
