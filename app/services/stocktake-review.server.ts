import type { Prisma, StocktakeDriftResolution } from "@prisma/client";
import { getDb } from "../db.server";
import { logFailure } from "./failure-log.server";
import { fetchLiveInventoryLevels } from "./shopify.server";
import {
  readFiltersJson,
  type ReviewIssue,
  type StocktakeFiltersJson,
  type StocktakeReviewJson,
} from "./stocktake.server";

// Review never writes to Shopify. It reads live quantities and stores the
// decisions (targetQty) that the apply step will later send.

const DRIFT_CHUNK_SIZE = 200;
const SCAN_AUDIT_EVERY = 50;

type Tx = Prisma.TransactionClient;

export class StocktakeReviewError extends Error {}

function emptyReview(): StocktakeReviewJson {
  return { total: 0, done: 0, startedAt: null, checkedAt: null, error: null, issues: {}, loggedScans: {} };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Read-modify-write of filters.review under a row lock, so the drift check,
// the review transition and the toggles never clobber each other's JSON.
async function updateReviewJson(
  stocktakeId: number,
  fn: (review: StocktakeReviewJson, filters: StocktakeFiltersJson) => StocktakeReviewJson,
  tx?: Tx
): Promise<void> {
  const run = async (t: Tx) => {
    const rows = await t.$queryRaw<{ filters: Prisma.JsonValue }[]>`
      SELECT filters FROM "Stocktake" WHERE id = ${stocktakeId} FOR UPDATE
    `;
    if (rows.length === 0) return;
    const filters = readFiltersJson(rows[0].filters);
    const review = fn({ ...emptyReview(), ...filters.review }, filters);
    await t.stocktake.update({
      where: { id: stocktakeId },
      data: { filters: { ...filters, review } as Prisma.InputJsonValue },
    });
  };
  if (tx) await run(tx);
  else await getDb().$transaction(run);
}

// ─── Per-item review math (shared by target storage and the review screen) ─────

export type ReviewItemInput = {
  countedQty: number | null;
  expectedQty: number;
  liveQtyAtReview: number | null;
  drifted: boolean;
  driftResolution: StocktakeDriftResolution | null;
};

export type ReviewItemOutcome = {
  // Part of this review (counted, or unscanned with "set unscanned to 0" on)
  included: boolean;
  zeroedUnscanned: boolean;
  effectiveCount: number | null;
  issue: ReviewIssue | null;
  pendingDrift: boolean;
  // Raw computed target, may be negative (then `negative` is set and nothing is stored)
  target: number | null;
  negative: boolean;
  // Quantity Shopify would change by (target − live on_hand); 0 when not changing
  change: number;
  changing: boolean;
};

export function computeReviewItem(
  item: ReviewItemInput,
  ctx: { zeroUnscanned: boolean; scoped: boolean; issue: ReviewIssue | null; checked: boolean }
): ReviewItemOutcome {
  const zeroedUnscanned = item.countedQty == null && ctx.zeroUnscanned && ctx.scoped;
  const included = item.countedQty != null || zeroedUnscanned;
  const effectiveCount = item.countedQty ?? (zeroedUnscanned ? 0 : null);
  const base: ReviewItemOutcome = {
    included, zeroedUnscanned, effectiveCount, issue: ctx.issue,
    pendingDrift: false, target: null, negative: false, change: 0, changing: false,
  };
  // Not part of the review, not checked yet, or can't be set at all.
  if (!included || effectiveCount == null || !ctx.checked) return base;
  if (ctx.issue === "UNTRACKED" || ctx.issue === "MISSING") return base;

  let target: number | null;
  if (!item.drifted) {
    target = effectiveCount;
  } else if (item.driftResolution === "KEEP_COUNT") {
    target = effectiveCount;
  } else if (item.driftResolution === "ADJUST_FOR_MOVEMENT") {
    target = effectiveCount + ((item.liveQtyAtReview ?? 0) - item.expectedQty);
  } else if (item.driftResolution === "SKIP") {
    target = null;
  } else {
    return { ...base, pendingDrift: true };
  }
  if (target == null) return base;

  // Not stocked at the location means Shopify currently holds 0 there.
  const live = item.liveQtyAtReview ?? 0;
  if (target < 0) return { ...base, target, negative: true };
  const change = target - live;
  return { ...base, target, change, changing: change !== 0 };
}

// Recomputes and stores targetQty for every item: the absolute on_hand value to
// send, set only when the quantity actually changes, else null. Writes are
// grouped by target value so a large stocktake is a handful of statements.
export async function recomputeTargets(stocktakeId: number): Promise<void> {
  const db = getDb();
  const stocktake = await db.stocktake.findUnique({ where: { id: stocktakeId } });
  if (!stocktake) return;
  const review = readFiltersJson(stocktake.filters).review;
  const checked = review?.checkedAt != null;
  const items = await db.stocktakeItem.findMany({
    where: { stocktakeId, applied: false },
    select: {
      id: true, countedQty: true, expectedQty: true, liveQtyAtReview: true,
      drifted: true, driftResolution: true, targetQty: true,
    },
  });

  const groups = new Map<number | null, number[]>();
  for (const item of items) {
    const outcome = computeReviewItem(item, {
      zeroUnscanned: stocktake.zeroUnscanned,
      scoped: stocktake.mode === "SCOPED",
      issue: review?.issues[String(item.id)] ?? null,
      checked,
    });
    const stored = outcome.changing && !outcome.negative ? outcome.target : null;
    if (stored === item.targetQty) continue;
    const ids = groups.get(stored) ?? [];
    ids.push(item.id);
    groups.set(stored, ids);
  }
  if (groups.size === 0) return;
  await db.$transaction(
    [...groups.entries()].map(([targetQty, ids]) =>
      db.stocktakeItem.updateMany({ where: { id: { in: ids }, applied: false }, data: { targetQty } })
    )
  );
}

// ─── Drift check (background) ──────────────────────────────────────────────────

const runningChecks = new Set<number>();

export function isDriftCheckRunning(stocktakeId: number): boolean {
  return runningChecks.has(stocktakeId);
}

// Reads live on_hand + available for every item in the review (counted items,
// plus unscanned ones when "set unscanned to 0" is on) and flags drift against
// the expected snapshot. Read-only against Shopify.
export async function runDriftCheck(stocktakeId: number): Promise<void> {
  if (runningChecks.has(stocktakeId)) return;
  runningChecks.add(stocktakeId);
  const db = getDb();
  try {
    const stocktake = await db.stocktake.findUnique({ where: { id: stocktakeId } });
    if (!stocktake || stocktake.status !== "REVIEW") return;

    const items = await db.stocktakeItem.findMany({
      where: { stocktakeId, applied: false },
      select: {
        id: true, inventoryItemId: true, countedQty: true, expectedQty: true,
        liveQtyAtReview: true, driftResolution: true,
      },
    });
    const includeUnscanned = stocktake.zeroUnscanned && stocktake.mode === "SCOPED";
    const toCheck = items.filter((i) => i.countedQty != null || includeUnscanned);
    const notChecked = items.filter((i) => !(i.countedQty != null || includeUnscanned));

    await updateReviewJson(stocktakeId, (r) => ({
      ...r, total: toCheck.length, done: 0, error: null, checkedAt: null,
      startedAt: new Date().toISOString(),
    }));
    // No target survives from an earlier check — if this one fails partway,
    // there is nothing stale for apply to pick up.
    await db.stocktakeItem.updateMany({ where: { stocktakeId, applied: false }, data: { targetQty: null } });

    const issues: Record<string, ReviewIssue> = {};
    try {
      let done = 0;
      for (const batch of chunk(toCheck, DRIFT_CHUNK_SIZE)) {
        const levels = await fetchLiveInventoryLevels(batch.map((i) => i.inventoryItemId), stocktake.locationId);

        const updates = batch.map((item) => {
          const level = levels.get(item.inventoryItemId);
          let live: number | null = null;
          let available: number | null = null;
          if (!level) issues[item.id] = "MISSING";
          else if (!level.tracked) issues[item.id] = "UNTRACKED";
          else if (level.onHand == null) issues[item.id] = "NOT_STOCKED";
          else {
            live = level.onHand;
            available = level.available;
          }
          // Not stocked counts as 0 on hand for drift purposes.
          const comparable = level && level.tracked ? (live ?? 0) : null;
          const drifted = comparable != null && comparable !== item.expectedQty;
          // A drift decision only stands if Shopify's number hasn't moved since.
          const keepResolution = drifted && item.liveQtyAtReview === live && item.driftResolution != null;
          return db.stocktakeItem.update({
            where: { id: item.id },
            data: {
              liveQtyAtReview: live,
              liveAvailableAtReview: available,
              drifted,
              driftResolution: keepResolution ? item.driftResolution : null,
            },
          });
        });
        await db.$transaction(updates);

        done += batch.length;
        const current = await db.stocktake.findUnique({ where: { id: stocktakeId }, select: { status: true } });
        if (current?.status !== "REVIEW") return;
        await updateReviewJson(stocktakeId, (r) => ({ ...r, done }));
      }

      if (notChecked.length > 0) {
        await db.stocktakeItem.updateMany({
          where: { id: { in: notChecked.map((i) => i.id) } },
          data: { liveQtyAtReview: null, liveAvailableAtReview: null, drifted: false, driftResolution: null, targetQty: null },
        });
      }

      await updateReviewJson(stocktakeId, (r) => ({ ...r, issues, checkedAt: new Date().toISOString(), error: null }));
      await recomputeTargets(stocktakeId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logFailure("STOCKTAKE_DRIFT_CHECK", `Stocktake #${stocktakeId} "${stocktake.name}"`, msg);
      await updateReviewJson(stocktakeId, (r) => ({ ...r, error: msg })).catch(() => {});
    }
  } finally {
    runningChecks.delete(stocktakeId);
  }
}

// ─── Status transitions ────────────────────────────────────────────────────────

async function lockForUpdate(tx: Tx, stocktakeId: number) {
  const rows = await tx.$queryRaw<{ status: string; name: string; filters: Prisma.JsonValue }[]>`
    SELECT status, name, filters FROM "Stocktake" WHERE id = ${stocktakeId} FOR UPDATE
  `;
  if (rows.length === 0) throw new StocktakeReviewError("Stocktake not found.");
  return rows[0];
}

// IN_PROGRESS → REVIEW. Logs any scans not yet covered by a STOCKTAKE_SCANS
// audit entry, then starts the live drift check.
export async function startReview(opts: { stocktakeId: number; userId: number }): Promise<void> {
  const db = getDb();
  await db.$transaction(async (tx) => {
    const st = await lockForUpdate(tx, opts.stocktakeId);
    if (st.status !== "IN_PROGRESS") throw new StocktakeReviewError("Only a stocktake that is being counted can move to review.");

    const perUser = await tx.stocktakeScan.groupBy({
      by: ["scannedById"],
      where: { stocktakeId: opts.stocktakeId, kind: "SCAN" },
      _count: { _all: true },
    });
    const filters = readFiltersJson(st.filters);
    const loggedScans = { ...(filters.review?.loggedScans ?? {}) };
    for (const row of perUser) {
      const total = row._count._all;
      const key = String(row.scannedById);
      const alreadyLogged = Math.max(Math.floor(total / SCAN_AUDIT_EVERY) * SCAN_AUDIT_EVERY, loggedScans[key] ?? 0);
      if (total > alreadyLogged) {
        await tx.auditLog.create({
          data: {
            userId: row.scannedById,
            action: "STOCKTAKE_SCANS",
            details: `Stocktake #${opts.stocktakeId} "${st.name}": ${total - alreadyLogged} more scans (${total} scans by this user so far), logged on moving to review`,
          },
        });
      }
      loggedScans[key] = Math.max(total, loggedScans[key] ?? 0);
    }

    await tx.stocktake.update({ where: { id: opts.stocktakeId }, data: { status: "REVIEW" } });
    await updateReviewJson(
      opts.stocktakeId,
      (r) => ({ ...r, loggedScans, total: 0, done: 0, error: null, checkedAt: null, startedAt: null }),
      tx
    );
  });

  runDriftCheck(opts.stocktakeId).catch((err) => console.error("[stocktake] drift check failed:", err));
}

export async function backToCounting(opts: { stocktakeId: number }): Promise<void> {
  if (isDriftCheckRunning(opts.stocktakeId)) {
    throw new StocktakeReviewError("Wait for the drift check to finish first.");
  }
  const db = getDb();
  await db.$transaction(async (tx) => {
    const st = await lockForUpdate(tx, opts.stocktakeId);
    if (st.status !== "REVIEW") throw new StocktakeReviewError("This stocktake is not in review.");
    const applied = await tx.stocktakeItem.count({ where: { stocktakeId: opts.stocktakeId, applied: true } });
    if (applied > 0) throw new StocktakeReviewError("Items have already been applied, so counting can't be reopened.");
    await tx.stocktake.update({ where: { id: opts.stocktakeId }, data: { status: "IN_PROGRESS" } });
    // Counts can change now, so the review must be re-checked before any apply.
    await tx.stocktakeItem.updateMany({ where: { stocktakeId: opts.stocktakeId, applied: false }, data: { targetQty: null } });
    await updateReviewJson(opts.stocktakeId, (r) => ({ ...r, checkedAt: null }), tx);
  });
}

export async function rerunDriftCheck(opts: { stocktakeId: number }): Promise<void> {
  const st = await getDb().stocktake.findUnique({ where: { id: opts.stocktakeId }, select: { status: true } });
  if (st?.status !== "REVIEW") throw new StocktakeReviewError("This stocktake is not in review.");
  runDriftCheck(opts.stocktakeId).catch((err) => console.error("[stocktake] drift check failed:", err));
}

async function requireEditableReview(stocktakeId: number) {
  if (isDriftCheckRunning(stocktakeId)) throw new StocktakeReviewError("Wait for the drift check to finish first.");
  const st = await getDb().stocktake.findUnique({ where: { id: stocktakeId } });
  if (!st) throw new StocktakeReviewError("Stocktake not found.");
  if (st.status !== "REVIEW") throw new StocktakeReviewError("This stocktake is not in review.");
  return st;
}

// ─── Decisions ─────────────────────────────────────────────────────────────────

export type ResolutionTarget = { itemIds: number[] } | { allDrifted: true; onlyUnresolved: boolean };

export async function setDriftResolution(opts: {
  stocktakeId: number;
  userId: number;
  target: ResolutionTarget;
  resolution: StocktakeDriftResolution | null;
}): Promise<number> {
  const st = await requireEditableReview(opts.stocktakeId);
  const db = getDb();
  const where: Prisma.StocktakeItemWhereInput = { stocktakeId: opts.stocktakeId, drifted: true, applied: false };
  if ("itemIds" in opts.target) where.id = { in: opts.target.itemIds };
  else if (opts.target.onlyUnresolved) where.driftResolution = null;

  const { count } = await db.stocktakeItem.updateMany({ where, data: { driftResolution: opts.resolution } });
  await recomputeTargets(opts.stocktakeId);

  if (count > 0 && !("itemIds" in opts.target && opts.target.itemIds.length === 1)) {
    await db.auditLog.create({
      data: {
        userId: opts.userId,
        action: "STOCKTAKE_DRIFT_RESOLVED",
        details: `Stocktake #${st.id} "${st.name}": ${count} drifted item${count === 1 ? "" : "s"} set to ${opts.resolution ?? "undecided"}`,
      },
    });
  }
  return count;
}

export async function setZeroUnscanned(opts: {
  stocktakeId: number;
  userId: number;
  on: boolean;
  confirmedCount: number | null;
}): Promise<void> {
  const st = await requireEditableReview(opts.stocktakeId);
  if (st.mode !== "SCOPED") throw new StocktakeReviewError("Only a scoped stocktake has unscanned items.");
  const db = getDb();
  const unscanned = await db.stocktakeItem.count({ where: { stocktakeId: opts.stocktakeId, countedQty: null, applied: false } });
  // The confirmation the staff saw must match what is about to happen.
  if (opts.on && opts.confirmedCount !== unscanned) {
    throw new StocktakeReviewError(
      `The number of unscanned items has changed to ${unscanned}. Review the new number and confirm again.`
    );
  }
  await db.stocktake.update({ where: { id: opts.stocktakeId }, data: { zeroUnscanned: opts.on } });
  await db.auditLog.create({
    data: {
      userId: opts.userId,
      action: opts.on ? "STOCKTAKE_ZERO_UNSCANNED_ON" : "STOCKTAKE_ZERO_UNSCANNED_OFF",
      details: opts.on
        ? `Stocktake #${st.id} "${st.name}": "set unscanned items to 0" turned ON for ${unscanned} unscanned items`
        : `Stocktake #${st.id} "${st.name}": "set unscanned items to 0" turned OFF`,
    },
  });
  // Re-check live so unscanned items get (or lose) their live quantity and target.
  runDriftCheck(opts.stocktakeId).catch((err) => console.error("[stocktake] drift check failed:", err));
}
