import { createHash } from "node:crypto";
import { getDb } from "../db.server";
import { logFailure } from "./failure-log.server";
import {
  fetchLiveInventoryLevels,
  setInventoryQuantities,
  type SetQuantitiesInput,
  type SetQuantitiesResponse,
  type SetQuantitiesUserError,
} from "./shopify.server";
import { readFiltersJson, type ReviewIssue } from "./stocktake.server";
import { computeReviewItem, isDriftCheckRunning, withReviewLock } from "./stocktake-review.server";
import { APPLY_CHUNK_SIZE, APPLY_REASON, DRIFT_CHECK_MAX_AGE_MS } from "../utils/stocktake-apply-constants";

export { APPLY_CHUNK_SIZE, APPLY_REASON, DRIFT_CHECK_MAX_AGE_MS };

// Applying a stocktake: absolute on_hand values via inventorySetQuantities with
// compare-and-set (changeFromQuantity) and an idempotency key on every call.
// An item is marked applied only after Shopify confirms it. Nothing here can
// double-count: re-sending an absolute value is harmless, and compare-and-set
// refuses any item that moved since review.

export const FALLBACK_REASON = "correction";
const HEARTBEAT_STALE_MS = 5 * 60 * 1000;
const LARGE_CHANGE_ITEM_SHARE = 0.1;
const LARGE_CHANGE_VALUE = 5000;
const NOTHING_TO_CHANGE = "No quantities would change.";

export class StocktakeApplyError extends Error {}

// ─── Plan ──────────────────────────────────────────────────────────────────────

export type ApplyPlanItem = {
  itemId: number;
  variantId: string;
  inventoryItemId: string;
  title: string;
  variantTitle: string;
  sku: string | null;
  changeFromQuantity: number;
  targetQty: number;
  change: number;
  cost: number | null;
  stale: boolean;
  applyError: string | null;
};

export type ExcludedItem = {
  itemId: number;
  title: string;
  variantTitle: string;
  sku: string | null;
  reason: ReviewIssue;
  targetQty: number | null;
  counted: number | null;
  excludedBy?: string | null;
  excludedAt?: string | null;
  excludeReason?: string | null;
};

export type ApplyPlan = {
  stocktake: {
    id: number; name: string; mode: string; status: string; locationId: string; applyAttempt: number;
    applyReason: string | null; applyTestResult: string | null; applyError: string | null;
    applyTotal: number | null; applyDone: number | null; applyHeartbeatAt: string | null;
  };
  checkedAt: string | null;
  totalItems: number;
  // Unapplied items whose quantity changes (including any flagged stale)
  eligible: ApplyPlanItem[];
  // The subset that would actually be sent now
  sendable: ApplyPlanItem[];
  stale: ApplyPlanItem[];
  failed: ApplyPlanItem[];
  needsActivation: ExcludedItem[];
  unsettable: ExcludedItem[];
  excluded: ExcludedItem[];
  alreadyApplied: number;
  totals: { itemsChanging: number; unitsUp: number; unitsDown: number; net: number; netValue: number; changingNoCost: number };
  requiresNameConfirm: boolean;
  blockers: string[];
};

// Builds the plan and checks every precondition on the server. Called on page
// load and again immediately before every write.
export async function getApplyPlan(
  stocktakeId: number,
  opts: { expectStatus?: "REVIEW" | "APPLYING" } = {}
): Promise<ApplyPlan> {
  const expectStatus = opts.expectStatus ?? "REVIEW";
  const db = getDb();
  const stocktake = await db.stocktake.findUnique({ where: { id: stocktakeId } });
  if (!stocktake) throw new StocktakeApplyError("Stocktake not found.");

  const review = readFiltersJson(stocktake.filters).review;
  const running = isDriftCheckRunning(stocktakeId);
  const checked = review?.checkedAt != null && !running;

  const items = await db.stocktakeItem.findMany({
    where: { stocktakeId },
    orderBy: [{ title: "asc" }, { productId: "asc" }, { variantTitle: "asc" }],
    select: {
      id: true, variantId: true, inventoryItemId: true, title: true, variantTitle: true, sku: true, cost: true,
      expectedQty: true, countedQty: true, liveQtyAtReview: true, drifted: true, driftResolution: true,
      targetQty: true, applied: true, applyError: true, applyStale: true,
      excludedAt: true, excludeReason: true, excludedBy: { select: { name: true } },
    },
  });

  const eligible: ApplyPlanItem[] = [];
  const needsActivation: ExcludedItem[] = [];
  const unsettable: ExcludedItem[] = [];
  const excluded: ExcludedItem[] = [];
  let alreadyApplied = 0;
  let pendingDrift = 0;
  let negative = 0;

  for (const item of items) {
    if (item.applied) {
      alreadyApplied++;
      continue;
    }
    const issue = review?.issues[String(item.id)] ?? null;
    const o = computeReviewItem(item, {
      zeroUnscanned: stocktake.zeroUnscanned,
      scoped: stocktake.mode === "SCOPED",
      issue,
      checked,
    });
    if (o.pendingDrift) pendingDrift++;
    if (o.negative || (item.targetQty != null && item.targetQty < 0)) negative++;

    const listed = (reason: ReviewIssue): ExcludedItem => ({
      itemId: item.id, title: item.title, variantTitle: item.variantTitle, sku: item.sku,
      reason, targetQty: item.targetQty, counted: o.effectiveCount,
      excludedBy: item.excludedBy?.name ?? null,
      excludedAt: item.excludedAt?.toISOString() ?? null,
      excludeReason: item.excludeReason,
    });
    if (issue === "NOT_STOCKED") {
      if (o.included) needsActivation.push(listed(issue));
      continue;
    }
    if (issue === "UNTRACKED" || issue === "MISSING") {
      if (!o.included) continue;
      if (item.excludedAt) excluded.push(listed(issue));
      else unsettable.push(listed(issue));
      continue;
    }

    // Only the stored target is ever sent, and only when it truly changes
    // Shopify. changeFromQuantity is always a real number, never null.
    if (item.targetQty == null || item.liveQtyAtReview == null) continue;
    if (item.targetQty === item.liveQtyAtReview) continue;
    eligible.push({
      itemId: item.id,
      variantId: item.variantId,
      inventoryItemId: item.inventoryItemId,
      title: item.title,
      variantTitle: item.variantTitle,
      sku: item.sku,
      changeFromQuantity: item.liveQtyAtReview,
      targetQty: item.targetQty,
      change: item.targetQty - item.liveQtyAtReview,
      cost: item.cost == null ? null : Number(item.cost),
      stale: item.applyStale,
      applyError: item.applyError,
    });
  }

  const stale = eligible.filter((e) => e.stale);
  const sendable = eligible.filter((e) => !e.stale);
  const failed = sendable.filter((e) => e.applyError != null);

  let unitsUp = 0, unitsDown = 0, netValue = 0, changingNoCost = 0;
  for (const e of eligible) {
    if (e.change > 0) unitsUp += e.change;
    else unitsDown += -e.change;
    if (e.cost == null) changingNoCost++;
    else netValue += e.change * e.cost;
  }

  const blockers: string[] = [];
  if (stocktake.status !== expectStatus) {
    blockers.push(
      stocktake.status === "APPLYING"
        ? "An apply is already running for this stocktake."
        : `The stocktake is ${stocktake.status}, not ${expectStatus}.`
    );
  }
  if (running) blockers.push("A drift check is running.");
  if (review?.error) blockers.push("The last drift check failed. Re-run it.");
  if (!review?.checkedAt) {
    if (!running) blockers.push("The live drift check hasn't completed. Re-run it.");
  } else if (Date.now() - new Date(review.checkedAt).getTime() > DRIFT_CHECK_MAX_AGE_MS) {
    blockers.push("The drift check is more than 60 minutes old. Re-run it on the review screen.");
  }
  if (pendingDrift > 0) blockers.push(`${pendingDrift} drifted item${pendingDrift === 1 ? " needs" : "s need"} a decision.`);
  if (negative > 0) blockers.push(`${negative} item${negative === 1 ? " has" : "s have"} a target below zero.`);
  if (unsettable.length > 0) {
    blockers.push(`${unsettable.length} item${unsettable.length === 1 ? " is" : "s are"} flagged as unsettable (tracking off or gone from Shopify). Exclude ${unsettable.length === 1 ? "it" : "them"} from apply to continue.`);
  }
  if (stale.length > 0) {
    blockers.push(`${stale.length} item${stale.length === 1 ? "" : "s"} changed in Shopify since review. Re-run the drift check and decide on ${stale.length === 1 ? "it" : "them"}.`);
  }
  if (sendable.length === 0) blockers.push(NOTHING_TO_CHANGE);

  const requiresNameConfirm =
    (items.length > 0 && sendable.length / items.length > LARGE_CHANGE_ITEM_SHARE) || Math.abs(netValue) > LARGE_CHANGE_VALUE;

  return {
    stocktake: {
      id: stocktake.id, name: stocktake.name, mode: stocktake.mode, status: stocktake.status,
      locationId: stocktake.locationId, applyAttempt: stocktake.applyAttempt,
      applyReason: stocktake.applyReason, applyTestResult: stocktake.applyTestResult, applyError: stocktake.applyError,
      applyTotal: stocktake.applyTotal, applyDone: stocktake.applyDone,
      applyHeartbeatAt: stocktake.applyHeartbeatAt?.toISOString() ?? null,
    },
    checkedAt: review?.checkedAt ?? null,
    totalItems: items.length,
    eligible,
    sendable,
    stale,
    failed,
    needsActivation,
    unsettable,
    excluded,
    alreadyApplied,
    totals: { itemsChanging: eligible.length, unitsUp, unitsDown, net: unitsUp - unitsDown, netValue, changingNoCost },
    requiresNameConfirm,
    blockers,
  };
}

// ─── Payload ───────────────────────────────────────────────────────────────────

export function chunkItems<T>(items: T[], size = APPLY_CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// "stocktake-{id}-a{applyAttempt}-{sha256 of sorted itemId:target:changeFrom}".
// applyAttempt is incremented in the database before every new attempt
// (each run, each per-item fallback, each reason switch), so a key is never
// reused after a failure.
export function buildIdempotencyKey(
  stocktakeId: number,
  attempt: number,
  items: Pick<ApplyPlanItem, "itemId" | "targetQty" | "changeFromQuantity">[]
): string {
  const digest = createHash("sha256")
    .update(items.map((i) => `${i.itemId}:${i.targetQty}:${i.changeFromQuantity}`).sort().join("|"))
    .digest("hex");
  return `stocktake-${stocktakeId}-a${attempt}-${digest}`;
}

export function buildSetQuantitiesInput(
  stocktakeId: number,
  locationId: string,
  items: ApplyPlanItem[],
  reason = APPLY_REASON
): SetQuantitiesInput {
  return {
    name: "on_hand",
    reason,
    referenceDocumentUri: `app://stocktake/${stocktakeId}`,
    quantities: items.map((i) => ({
      inventoryItemId: i.inventoryItemId,
      locationId,
      quantity: i.targetQty,
      changeFromQuantity: i.changeFromQuantity,
    })),
  };
}

export type DryRunChunk = { index: number; idempotencyKey: string; input: SetQuantitiesInput };

// Exactly what the next apply attempt would send, chunk by chunk. No Shopify calls.
export function buildDryRun(plan: ApplyPlan): { attempt: number; reason: string; chunks: DryRunChunk[] } {
  const attempt = plan.stocktake.applyAttempt + 1;
  const reason = plan.stocktake.applyReason ?? APPLY_REASON;
  const chunks = chunkItems(plan.sendable).map((items, index) => ({
    index,
    idempotencyKey: buildIdempotencyKey(plan.stocktake.id, attempt, items),
    input: buildSetQuantitiesInput(plan.stocktake.id, plan.stocktake.locationId, items, reason),
  }));
  return { attempt, reason, chunks };
}

// ─── Exclude from apply ────────────────────────────────────────────────────────

export async function excludeItem(opts: { stocktakeId: number; itemId: number; userId: number; reason: string }): Promise<void> {
  const reason = opts.reason.trim();
  if (reason.length < 3) throw new StocktakeApplyError("Give a reason for excluding this item.");
  await withReviewLock(opts.stocktakeId, async (tx, st) => {
    const issue = readFiltersJson(st.filters).review?.issues[String(opts.itemId)] ?? null;
    if (issue !== "UNTRACKED" && issue !== "MISSING") {
      throw new StocktakeApplyError("Only items flagged tracking off or gone from Shopify can be excluded.");
    }
    const item = await tx.stocktakeItem.findFirst({ where: { id: opts.itemId, stocktakeId: opts.stocktakeId, applied: false } });
    if (!item) throw new StocktakeApplyError("Item not found, or already applied.");
    await tx.stocktakeItem.update({
      where: { id: item.id },
      data: { excludedAt: new Date(), excludedById: opts.userId, excludeReason: reason },
    });
    await tx.auditLog.create({
      data: {
        userId: opts.userId,
        action: "STOCKTAKE_ITEM_EXCLUDED",
        details: `Stocktake #${opts.stocktakeId} "${st.name}": excluded ${item.title} — ${item.variantTitle} (SKU ${item.sku ?? "none"}, ${issue === "UNTRACKED" ? "tracking off" : "gone from Shopify"}) from apply. Reason: ${reason}`,
      },
    });
  });
}

export async function includeItem(opts: { stocktakeId: number; itemId: number; userId: number }): Promise<void> {
  await withReviewLock(opts.stocktakeId, async (tx, st) => {
    const applied = await tx.stocktakeItem.count({ where: { stocktakeId: opts.stocktakeId, applied: true } });
    if (applied > 0) throw new StocktakeApplyError("Items have already been applied, so exclusions can no longer be reversed.");
    const item = await tx.stocktakeItem.findFirst({ where: { id: opts.itemId, stocktakeId: opts.stocktakeId, excludedAt: { not: null } } });
    if (!item) throw new StocktakeApplyError("That item isn't excluded.");
    await tx.stocktakeItem.update({ where: { id: item.id }, data: { excludedAt: null, excludedById: null, excludeReason: null } });
    await tx.auditLog.create({
      data: {
        userId: opts.userId,
        action: "STOCKTAKE_ITEM_INCLUDED",
        details: `Stocktake #${opts.stocktakeId} "${st.name}": ${item.title} — ${item.variantTitle} (SKU ${item.sku ?? "none"}) included again (was excluded: ${item.excludeReason ?? "no reason"})`,
      },
    });
  });
}

// ─── Run state ─────────────────────────────────────────────────────────────────

// Applies running in this server process.
const runningApplies = new Set<number>();

export function isApplyRunning(stocktakeId: number): boolean {
  return runningApplies.has(stocktakeId);
}

export function isHeartbeatStale(heartbeatAt: string | null): boolean {
  return heartbeatAt == null || Date.now() - new Date(heartbeatAt).getTime() > HEARTBEAT_STALE_MS;
}

type RunKind = "test" | "full" | "retry" | "resume";

// Moves REVIEW → APPLYING (or claims a stalled APPLYING run for resume) in one
// conditional UPDATE and bumps applyAttempt. Two clicks can't both succeed.
async function claimRun(stocktakeId: number, kind: RunKind, total: number): Promise<number> {
  const db = getDb();
  const rows =
    kind === "resume"
      ? await db.$queryRaw<{ applyAttempt: number }[]>`
          UPDATE "Stocktake"
          SET "applyAttempt" = "applyAttempt" + 1, "applyHeartbeatAt" = NOW(), "applyError" = NULL
          WHERE id = ${stocktakeId} AND status = 'APPLYING'
            AND ("applyHeartbeatAt" IS NULL OR "applyHeartbeatAt" < NOW() - INTERVAL '5 minutes')
          RETURNING "applyAttempt"
        `
      : await db.$queryRaw<{ applyAttempt: number }[]>`
          UPDATE "Stocktake"
          SET status = 'APPLYING', "applyAttempt" = "applyAttempt" + 1, "applyStartedAt" = NOW(),
              "applyHeartbeatAt" = NOW(), "applyEndedAt" = NULL, "applyError" = NULL,
              "applyTotal" = ${total}, "applyDone" = 0
          WHERE id = ${stocktakeId} AND status = 'REVIEW'
          RETURNING "applyAttempt"
        `;
  if (rows.length === 0) {
    throw new StocktakeApplyError(
      kind === "resume"
        ? "This apply is still making progress, or has already finished. Reload the page."
        : "An apply has already started for this stocktake, or it is no longer in review. Reload the page."
    );
  }
  // A drift check that started in the gap would rewrite targets: back out.
  if (isDriftCheckRunning(stocktakeId)) {
    await releaseToReview(stocktakeId, "A drift check started at the same time. Nothing was sent; try again.");
    throw new StocktakeApplyError("A drift check is running. Nothing was sent; try again when it finishes.");
  }
  return rows[0].applyAttempt;
}

async function nextAttempt(stocktakeId: number): Promise<number> {
  const rows = await getDb().$queryRaw<{ applyAttempt: number }[]>`
    UPDATE "Stocktake" SET "applyAttempt" = "applyAttempt" + 1 WHERE id = ${stocktakeId} RETURNING "applyAttempt"
  `;
  return rows[0].applyAttempt;
}

async function heartbeat(stocktakeId: number, done?: number): Promise<boolean> {
  const n = done == null
    ? await getDb().$executeRaw`
        UPDATE "Stocktake" SET "applyHeartbeatAt" = NOW() WHERE id = ${stocktakeId} AND status = 'APPLYING'`
    : await getDb().$executeRaw`
        UPDATE "Stocktake" SET "applyHeartbeatAt" = NOW(), "applyDone" = ${done} WHERE id = ${stocktakeId} AND status = 'APPLYING'`;
  return n > 0;
}

async function releaseToReview(stocktakeId: number, applyError: string | null): Promise<void> {
  await getDb().$executeRaw`
    UPDATE "Stocktake" SET status = 'REVIEW', "applyEndedAt" = NOW(), "applyError" = ${applyError}
    WHERE id = ${stocktakeId} AND status = 'APPLYING'
  `;
}

// ─── Sending ───────────────────────────────────────────────────────────────────

type RunCtx = {
  stocktakeId: number;
  locationId: string;
  attempt: number;
  reason: string;
  reasonFallbackUsed: boolean;
  keysUsed: string[];
  applied: number;
  reconciled: number;
  stale: number;
  failed: number;
  errors: string[];
};

function errorText(errors: SetQuantitiesUserError[]): string {
  return errors.map((e) => `${e.code ?? "ERROR"}: ${e.message}`).join("; ");
}

function hasCode(errors: SetQuantitiesUserError[], code: string): boolean {
  return errors.some((e) => e.code === code);
}

// Writes Shopify's live available into ProductCache so reports reflect the
// count straight away. Never fails the apply.
async function refreshProductCache(items: ApplyPlanItem[], locationId: string): Promise<void> {
  if (items.length === 0) return;
  try {
    const levels = await fetchLiveInventoryLevels(items.map((i) => i.inventoryItemId), locationId);
    const byAvailable = new Map<number, string[]>();
    for (const i of items) {
      const available = levels.get(i.inventoryItemId)?.available;
      if (available == null) continue;
      byAvailable.set(available, [...(byAvailable.get(available) ?? []), i.variantId]);
    }
    const db = getDb();
    for (const [available, variantIds] of byAvailable) {
      await db.productCache.updateMany({ where: { variantId: { in: variantIds } }, data: { currentInventory: available } });
    }
  } catch (err) {
    await logFailure("STOCKTAKE_CACHE_UPDATE", `${items.length} applied items`, err instanceof Error ? err.message : String(err));
  }
}

// Marks items applied. Only called for items Shopify confirmed, or whose live
// on_hand was read back equal to the target (reconcile).
async function markApplied(ctx: RunCtx, items: ApplyPlanItem[], via: "shopify" | "reconciled"): Promise<void> {
  if (items.length === 0) return;
  const { count } = await getDb().stocktakeItem.updateMany({
    where: { id: { in: items.map((i) => i.itemId) }, applied: false },
    data: { applied: true, appliedAt: new Date(), applyError: null, applyStale: false },
  });
  if (via === "shopify") ctx.applied += count;
  else ctx.reconciled += count;
  await refreshProductCache(items, ctx.locationId);
}

async function markStale(ctx: RunCtx, item: ApplyPlanItem, live: number | null): Promise<void> {
  const message = `Changed in Shopify since review: on hand is now ${live ?? "unknown"}, review saw ${item.changeFromQuantity}. Not applied. Re-run the drift check and decide again.`;
  await getDb().stocktakeItem.updateMany({
    where: { id: item.itemId, applied: false },
    data: { applyStale: true, applyError: message },
  });
  ctx.stale++;
  ctx.errors.push(`${item.sku ?? item.title}: changed since review`);
  await logFailure("STOCKTAKE_APPLY", item.sku ?? item.title, message);
}

async function markFailed(ctx: RunCtx, item: ApplyPlanItem, message: string): Promise<void> {
  await getDb().stocktakeItem.updateMany({ where: { id: item.itemId, applied: false }, data: { applyError: message } });
  ctx.failed++;
  ctx.errors.push(`${item.sku ?? item.title}: ${message}`);
  await logFailure("STOCKTAKE_APPLY", item.sku ?? item.title, message);
}

// Reads live on_hand for items whose outcome is unknown (retry, resume, or a
// lost response). live == target → applied, without calling Shopify.
// live == changeFrom → still to send. Anything else → changed since review.
async function reconcile(ctx: RunCtx, items: ApplyPlanItem[]): Promise<ApplyPlanItem[]> {
  if (items.length === 0) return [];
  const levels = await fetchLiveInventoryLevels(items.map((i) => i.inventoryItemId), ctx.locationId);
  const done: ApplyPlanItem[] = [];
  const pending: ApplyPlanItem[] = [];
  for (const item of items) {
    const level = levels.get(item.inventoryItemId);
    if (!level || !level.tracked || level.onHand == null) {
      await markFailed(ctx, item, "Not settable any more (tracking off, gone, or not stocked at the location). Re-run the drift check.");
    } else if (level.onHand === item.targetQty) {
      done.push(item);
    } else if (level.onHand === item.changeFromQuantity) {
      pending.push(item);
    } else {
      await markStale(ctx, item, level.onHand);
    }
  }
  await markApplied(ctx, done, "reconciled");
  return pending;
}

// Applies Shopify's successful response: items it lists are confirmed; any it
// doesn't list are read back live and only marked applied if they now hold the target.
async function confirmFromResponse(ctx: RunCtx, items: ApplyPlanItem[], res: SetQuantitiesResponse): Promise<void> {
  const confirmed: ApplyPlanItem[] = [];
  const unconfirmed: ApplyPlanItem[] = [];
  for (const item of items) {
    const after = res.changedItems.get(item.inventoryItemId);
    if (res.changedItems.has(item.inventoryItemId) && (after == null || after === item.targetQty)) confirmed.push(item);
    else unconfirmed.push(item);
  }
  await markApplied(ctx, confirmed, "shopify");
  if (unconfirmed.length === 0) return;

  const levels = await fetchLiveInventoryLevels(unconfirmed.map((i) => i.inventoryItemId), ctx.locationId);
  const readBack: ApplyPlanItem[] = [];
  for (const item of unconfirmed) {
    const live = levels.get(item.inventoryItemId)?.onHand ?? null;
    if (live === item.targetQty) readBack.push(item);
    else await markFailed(ctx, item, `Shopify accepted the request but did not confirm this item (on hand now ${live ?? "unknown"}). Not marked applied.`);
  }
  await markApplied(ctx, readBack, "reconciled");
}

async function switchToFallbackReason(ctx: RunCtx): Promise<void> {
  ctx.reason = FALLBACK_REASON;
  ctx.reasonFallbackUsed = true;
  await getDb().stocktake.update({ where: { id: ctx.stocktakeId }, data: { applyReason: FALLBACK_REASON } });
  ctx.attempt = await nextAttempt(ctx.stocktakeId);
}

async function call(ctx: RunCtx, items: ApplyPlanItem[]): Promise<SetQuantitiesResponse> {
  const key = buildIdempotencyKey(ctx.stocktakeId, ctx.attempt, items);
  ctx.keysUsed.push(key);
  await heartbeat(ctx.stocktakeId);
  return setInventoryQuantities(buildSetQuantitiesInput(ctx.stocktakeId, ctx.locationId, items, ctx.reason), key);
}

async function sendSingle(ctx: RunCtx, item: ApplyPlanItem): Promise<void> {
  let res: SetQuantitiesResponse;
  try {
    res = await call(ctx, [item]);
  } catch (err) {
    // Outcome unknown: never resend blindly. Read back and decide.
    const msg = err instanceof Error ? err.message : String(err);
    const pending = await reconcile(ctx, [item]);
    if (pending.length > 0) await markFailed(ctx, item, `Request failed (${msg}). Shopify still shows the review quantity, so it was not applied. Retry will reconcile first.`);
    return;
  }
  if (res.userErrors.length === 0) return confirmFromResponse(ctx, [item], res);
  if (hasCode(res.userErrors, "INVALID_REASON") && ctx.reason !== FALLBACK_REASON) {
    await switchToFallbackReason(ctx);
    return sendSingle(ctx, item);
  }
  if (hasCode(res.userErrors, "CHANGE_FROM_QUANTITY_STALE")) {
    // Double-check before flagging: if it already holds the target, it's done.
    const live = (await fetchLiveInventoryLevels([item.inventoryItemId], ctx.locationId)).get(item.inventoryItemId)?.onHand ?? null;
    if (live === item.targetQty) return markApplied(ctx, [item], "reconciled");
    return markStale(ctx, item, live);
  }
  return markFailed(ctx, item, errorText(res.userErrors));
}

async function sendChunk(ctx: RunCtx, items: ApplyPlanItem[]): Promise<void> {
  if (items.length === 1) return sendSingle(ctx, items[0]);
  let res: SetQuantitiesResponse;
  try {
    res = await call(ctx, items);
  } catch (err) {
    // Outcome unknown: reconcile, then send what's still pending one by one
    // under a new attempt (new keys).
    ctx.errors.push(`Batch request failed: ${err instanceof Error ? err.message : String(err)}`);
    const pending = await reconcile(ctx, items);
    if (pending.length === 0) return;
    ctx.attempt = await nextAttempt(ctx.stocktakeId);
    for (const item of pending) await sendSingle(ctx, item);
    return;
  }
  if (res.userErrors.length === 0) return confirmFromResponse(ctx, items, res);
  if (hasCode(res.userErrors, "INVALID_REASON") && ctx.reason !== FALLBACK_REASON) {
    await switchToFallbackReason(ctx);
    return sendChunk(ctx, items);
  }
  // Shopify rejected the batch as a whole. One call per item so one bad item
  // can't block the rest — under a new attempt, so no key is reused.
  ctx.attempt = await nextAttempt(ctx.stocktakeId);
  for (const item of items) await sendSingle(ctx, item);
}

// ─── Completion ────────────────────────────────────────────────────────────────

async function finishRun(ctx: RunCtx, opts: { userId: number; kind: RunKind; stocktakeName: string }): Promise<"COMPLETED" | "REVIEW"> {
  const db = getDb();
  const plan = await getApplyPlan(ctx.stocktakeId, { expectStatus: "APPLYING" });
  const remaining = plan.eligible.length;

  if (remaining === 0) {
    await db.$executeRaw`
      UPDATE "Stocktake"
      SET status = 'COMPLETED', "completedById" = ${opts.userId}, "completedAt" = NOW(),
          "applyEndedAt" = NOW(), "applyError" = NULL
      WHERE id = ${ctx.stocktakeId} AND status = 'APPLYING'
    `;
    const applied = await db.stocktakeItem.findMany({
      where: { stocktakeId: ctx.stocktakeId, applied: true },
      select: { targetQty: true, liveQtyAtReview: true, cost: true },
    });
    let up = 0, down = 0, value = 0;
    for (const a of applied) {
      const change = (a.targetQty ?? 0) - (a.liveQtyAtReview ?? 0);
      if (change > 0) up += change;
      else down += -change;
      if (a.cost != null) value += change * Number(a.cost);
    }
    await db.auditLog.create({
      data: {
        userId: opts.userId,
        action: "STOCKTAKE_APPLIED",
        details:
          `Stocktake #${ctx.stocktakeId} "${opts.stocktakeName}" completed: ${applied.length} items set in Shopify ` +
          `(+${up} / −${down} units, net ${up - down >= 0 ? "+" : ""}${up - down}, net $${value.toFixed(2)} at cost). ` +
          `Reason used: ${ctx.reason}${ctx.reasonFallbackUsed ? ` (fell back from ${APPLY_REASON})` : ""}. ` +
          `This run: ${ctx.applied} confirmed by Shopify, ${ctx.reconciled} reconciled. ` +
          `${plan.needsActivation.length} not applied (needs activation), ${plan.excluded.length} excluded.`,
      },
    });
    return "COMPLETED";
  }

  const summary =
    opts.kind === "test" && ctx.failed === 0 && ctx.stale === 0
      ? null
      : `${remaining} item${remaining === 1 ? "" : "s"} not applied` +
        (ctx.stale ? `, ${ctx.stale} changed since review` : "") +
        (ctx.failed ? `, ${ctx.failed} failed` : "") +
        (ctx.errors.length ? `. ${ctx.errors.slice(0, 3).join("; ")}` : "");
  await releaseToReview(ctx.stocktakeId, summary);
  if (opts.kind !== "test") {
    await db.auditLog.create({
      data: {
        userId: opts.userId,
        action: "STOCKTAKE_APPLY_FAILED",
        details:
          `Stocktake #${ctx.stocktakeId} "${opts.stocktakeName}" ${opts.kind} run ended with ${remaining} items unapplied. ` +
          `This run: ${ctx.applied} confirmed, ${ctx.reconciled} reconciled, ${ctx.stale} changed since review, ${ctx.failed} failed. ` +
          `Reason: ${ctx.reason}. First errors: ${ctx.errors.slice(0, 5).join("; ") || "none"}`,
      },
    });
  }
  return "REVIEW";
}

// ─── Entry points ──────────────────────────────────────────────────────────────

type WriteOpts = { stocktakeId: number; userId: number; understood: boolean; typedName?: string };


// A retry/resume with nothing left to send (e.g. a run that stopped right after
// its last batch) is allowed through so it can complete the stocktake.
function writeBlockers(plan: ApplyPlan, kind: RunKind): string[] {
  const canFinish = (kind === "retry" || kind === "resume") && plan.alreadyApplied > 0 && plan.eligible.length === 0;
  return canFinish ? plan.blockers.filter((b) => b !== NOTHING_TO_CHANGE) : plan.blockers;
}

// Every write starts here: the full plan and every blocker, re-checked on the
// server right now (including the 60-minute drift check limit).
async function assertCanWrite(kind: RunKind, opts: WriteOpts): Promise<ApplyPlan> {
  if (!opts.understood) throw new StocktakeApplyError("Tick “I understand this writes to live Shopify inventory” first.");
  if (isApplyRunning(opts.stocktakeId)) throw new StocktakeApplyError("An apply is already running for this stocktake.");
  const plan = await getApplyPlan(opts.stocktakeId, { expectStatus: kind === "resume" ? "APPLYING" : "REVIEW" });
  const blockers = writeBlockers(plan, kind);
  if (blockers.length > 0) throw new StocktakeApplyError(blockers.join(" "));
  if (kind !== "test" && plan.stocktake.applyTestResult !== "PASSED" && plan.stocktake.applyTestResult !== "SKIPPED") {
    throw new StocktakeApplyError("Apply the test item first, or choose to skip the test.");
  }
  if (kind === "resume" && !isHeartbeatStale(plan.stocktake.applyHeartbeatAt)) {
    throw new StocktakeApplyError("This apply made progress in the last 5 minutes. Wait before resuming.");
  }
  if (kind !== "test" && plan.requiresNameConfirm && (opts.typedName ?? "").trim() !== plan.stocktake.name.trim()) {
    throw new StocktakeApplyError("This is a large change. Type the stocktake name exactly to confirm.");
  }
  return plan;
}

function newCtx(plan: ApplyPlan, attempt: number): RunCtx {
  return {
    stocktakeId: plan.stocktake.id,
    locationId: plan.stocktake.locationId,
    attempt,
    reason: plan.stocktake.applyReason ?? APPLY_REASON,
    reasonFallbackUsed: false,
    keysUsed: [],
    applied: 0, reconciled: 0, stale: 0, failed: 0,
    errors: [],
  };
}

export type TestResult = {
  outcome: "applied" | "stale" | "failed";
  item: ApplyPlanItem;
  reasonUsed: string;
  reasonFallbackUsed: boolean;
  keysUsed: string[];
  message: string | null;
  status: "COMPLETED" | "REVIEW";
};

// Sends exactly one item, synchronously, and reports what happened. Verifies
// that the reason is accepted with name "on_hand" (falls back to "correction").
export async function applyTestItem(opts: WriteOpts): Promise<TestResult> {
  const plan = await assertCanWrite("test", opts);
  const chosen = plan.sendable[0];
  const attempt = await claimRun(opts.stocktakeId, "test", 1);
  runningApplies.add(opts.stocktakeId);
  try {
    // Re-plan under APPLYING: this is what is actually sent.
    const locked = await getApplyPlan(opts.stocktakeId, { expectStatus: "APPLYING" });
    const item = locked.sendable.find((i) => i.itemId === chosen.itemId);
    if (locked.blockers.length > 0 || !item || item.targetQty !== chosen.targetQty || item.changeFromQuantity !== chosen.changeFromQuantity) {
      await releaseToReview(opts.stocktakeId, null);
      throw new StocktakeApplyError("The stocktake changed while starting the test. Nothing was sent. Reload and try again.");
    }

    const ctx = newCtx(locked, attempt);
    const payload = buildSetQuantitiesInput(ctx.stocktakeId, ctx.locationId, [item], ctx.reason);
    await getDb().auditLog.create({
      data: {
        userId: opts.userId,
        action: "STOCKTAKE_APPLY_STARTED",
        details: `Stocktake #${ctx.stocktakeId} "${locked.stocktake.name}" test item (1 of ${locked.sendable.length}), attempt ${attempt}. ` +
          `Key ${buildIdempotencyKey(ctx.stocktakeId, attempt, [item])}. Payload: ${JSON.stringify(payload)}`,
      },
    });

    try {
      await sendSingle(ctx, item);
    } catch (err) {
      // Shopify unreachable even for the read-back: outcome unknown.
      await markFailed(ctx, item, `Test could not be confirmed: ${err instanceof Error ? err.message : String(err)}. Retry will reconcile first.`);
    }

    const after = await getDb().stocktakeItem.findUnique({ where: { id: item.itemId }, select: { applied: true, applyStale: true, applyError: true } });
    const outcome: TestResult["outcome"] = after?.applied ? "applied" : after?.applyStale ? "stale" : "failed";
    if (outcome === "applied") {
      await getDb().stocktake.update({ where: { id: ctx.stocktakeId }, data: { applyTestResult: "PASSED", applyReason: ctx.reason } });
    }
    await getDb().auditLog.create({
      data: {
        userId: opts.userId,
        action: "STOCKTAKE_APPLY_TEST_ITEM",
        details:
          `Stocktake #${ctx.stocktakeId} "${locked.stocktake.name}" test item ${item.title} — ${item.variantTitle} (SKU ${item.sku ?? "none"}): ` +
          `${outcome.toUpperCase()}. on_hand ${item.changeFromQuantity} → ${item.targetQty}. ` +
          `Reason used: ${ctx.reason}${ctx.reasonFallbackUsed ? ` (Shopify rejected ${APPLY_REASON}, fell back to ${FALLBACK_REASON})` : " (accepted with name on_hand)"}. ` +
          `Keys: ${ctx.keysUsed.join(", ")}.${after?.applyError ? ` Error: ${after.applyError}` : ""}`,
      },
    });

    const status = await finishRun(ctx, { userId: opts.userId, kind: "test", stocktakeName: locked.stocktake.name });
    return {
      outcome, item, reasonUsed: ctx.reason, reasonFallbackUsed: ctx.reasonFallbackUsed,
      keysUsed: ctx.keysUsed, message: after?.applyError ?? null, status,
    };
  } catch (err) {
    if (!(err instanceof StocktakeApplyError)) {
      await logFailure("STOCKTAKE_APPLY", `Stocktake #${opts.stocktakeId} test`, err instanceof Error ? err.message : String(err));
      await releaseToReview(opts.stocktakeId, `Test item run failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    throw err;
  } finally {
    runningApplies.delete(opts.stocktakeId);
  }
}

export async function skipTestItem(opts: { stocktakeId: number; userId: number }): Promise<void> {
  await withReviewLock(opts.stocktakeId, async (tx, st) => {
    await tx.stocktake.update({ where: { id: opts.stocktakeId }, data: { applyTestResult: "SKIPPED" } });
    await tx.auditLog.create({
      data: {
        userId: opts.userId,
        action: "STOCKTAKE_APPLY_TEST_ITEM",
        details: `Stocktake #${opts.stocktakeId} "${st.name}": test item SKIPPED by explicit choice. Full apply will use reason ${APPLY_REASON} (falls back to ${FALLBACK_REASON} if Shopify rejects it).`,
      },
    });
  });
}

// Full apply, retry, or resume: validated and claimed in the request, then run
// in the background (same fire-and-forget pattern as the receiving sync).
export async function startApplyRun(kind: "full" | "retry" | "resume", opts: WriteOpts): Promise<void> {
  const plan = await assertCanWrite(kind, opts);
  const attempt = await claimRun(opts.stocktakeId, kind, plan.sendable.length);
  runningApplies.add(opts.stocktakeId);
  executeRun(kind, opts.userId, opts.stocktakeId, attempt)
    .catch((err) => console.error("[stocktake] apply run failed:", err))
    .finally(() => runningApplies.delete(opts.stocktakeId));
}

async function executeRun(kind: "full" | "retry" | "resume", userId: number, stocktakeId: number, attempt: number): Promise<void> {
  const db = getDb();
  let name = `#${stocktakeId}`;
  try {
    const plan = await getApplyPlan(stocktakeId, { expectStatus: "APPLYING" });
    name = plan.stocktake.name;
    const blockers = writeBlockers(plan, kind);
    if (blockers.length > 0) {
      await releaseToReview(stocktakeId, `Not started: ${blockers.join(" ")}`);
      return;
    }
    const ctx = newCtx(plan, attempt);
    const total = plan.sendable.length;

    // Retry and resume never trust earlier outcomes: read back first.
    let toSend = plan.sendable;
    if (kind !== "full") toSend = await reconcile(ctx, toSend);
    let done = total - toSend.length;

    const chunks = chunkItems(toSend);
    const first = chunks[0];
    await db.$executeRaw`UPDATE "Stocktake" SET "applyTotal" = ${total}, "applyDone" = ${done} WHERE id = ${stocktakeId} AND status = 'APPLYING'`;
    await db.auditLog.create({
      data: {
        userId,
        action: "STOCKTAKE_APPLY_STARTED",
        details:
          `Stocktake #${stocktakeId} "${name}" ${kind} run, attempt ${attempt}: ${toSend.length} items to send in ${chunks.length} batch${chunks.length === 1 ? "" : "es"}` +
          `${kind !== "full" ? ` (${ctx.reconciled} already at target, ${ctx.stale} changed since review)` : ""}. ` +
          `Totals: +${plan.totals.unitsUp} / −${plan.totals.unitsDown} units, net $${plan.totals.netValue.toFixed(2)}. Reason ${ctx.reason}. ` +
          (first
            ? `First batch key ${buildIdempotencyKey(stocktakeId, ctx.attempt, first)}. First batch payload: ${JSON.stringify(buildSetQuantitiesInput(stocktakeId, ctx.locationId, first, ctx.reason))}`
            : "Nothing to send."),
      },
    });

    for (const chunk of chunks) {
      if (!(await heartbeat(stocktakeId, done))) break; // no longer APPLYING
      await sendChunk(ctx, chunk);
      done += chunk.length;
      await heartbeat(stocktakeId, done);
    }

    await finishRun(ctx, { userId, kind, stocktakeName: name });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logFailure("STOCKTAKE_APPLY", `Stocktake #${stocktakeId} ${kind}`, msg);
    await releaseToReview(stocktakeId, `Apply stopped: ${msg}. Use "Retry unapplied items" — it reconciles with Shopify first.`).catch(() => {});
    await db.auditLog.create({
      data: { userId, action: "STOCKTAKE_APPLY_FAILED", details: `Stocktake #${stocktakeId} "${name}": ${kind} run stopped: ${msg}` },
    }).catch(() => {});
  }
}

// A run whose process died (no heartbeat for 5 minutes) can be handed back to
// review instead of resumed — e.g. when the drift check has expired.
export async function returnStalledRunToReview(opts: { stocktakeId: number; userId: number }): Promise<void> {
  if (isApplyRunning(opts.stocktakeId)) throw new StocktakeApplyError("This apply is still running.");
  const n = await getDb().$executeRaw`
    UPDATE "Stocktake"
    SET status = 'REVIEW', "applyEndedAt" = NOW(),
        "applyError" = 'Apply was interrupted. "Retry unapplied items" reconciles with Shopify before sending anything.'
    WHERE id = ${opts.stocktakeId} AND status = 'APPLYING'
      AND ("applyHeartbeatAt" IS NULL OR "applyHeartbeatAt" < NOW() - INTERVAL '5 minutes')
  `;
  if (n === 0) throw new StocktakeApplyError("This apply made progress in the last 5 minutes, or has finished. Reload the page.");
  const st = await getDb().stocktake.findUnique({ where: { id: opts.stocktakeId }, select: { name: true } });
  await getDb().auditLog.create({
    data: {
      userId: opts.userId,
      action: "STOCKTAKE_APPLY_FAILED",
      details: `Stocktake #${opts.stocktakeId} "${st?.name ?? ""}": interrupted apply returned to review (no progress for 5 minutes).`,
    },
  });
}
