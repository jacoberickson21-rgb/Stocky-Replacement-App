import { createHash } from "node:crypto";
import { getDb } from "../db.server";
import { readFiltersJson, type ReviewIssue } from "./stocktake.server";
import { computeReviewItem, isDriftCheckRunning } from "./stocktake-review.server";
import { APPLY_CHUNK_SIZE, APPLY_REASON, DRIFT_CHECK_MAX_AGE_MS } from "../utils/stocktake-apply-constants";

// Checkpoint 1: this file only plans the apply and builds the exact payload it
// would send. It makes no Shopify calls of any kind.

export { APPLY_CHUNK_SIZE, APPLY_REASON, DRIFT_CHECK_MAX_AGE_MS };

export type ApplyPlanItem = {
  itemId: number;
  inventoryItemId: string;
  title: string;
  variantTitle: string;
  sku: string | null;
  changeFromQuantity: number;
  targetQty: number;
  change: number;
  cost: number | null;
};

export type ExcludedItem = {
  itemId: number;
  title: string;
  variantTitle: string;
  sku: string | null;
  reason: ReviewIssue;
  targetQty: number | null;
  counted: number | null;
};

export type ApplyPlan = {
  stocktake: { id: number; name: string; mode: string; status: string; locationId: string; applyAttempt: number };
  checkedAt: string | null;
  eligible: ApplyPlanItem[];
  needsActivation: ExcludedItem[];
  unsettable: ExcludedItem[];
  alreadyApplied: number;
  totals: { itemsChanging: number; unitsUp: number; unitsDown: number; net: number; netValue: number; changingNoCost: number };
  blockers: string[];
};

export class StocktakeApplyError extends Error {}

// Builds the apply plan and checks every precondition on the server. The UI
// only displays the blockers — the real apply re-runs this before writing.
export async function getApplyPlan(stocktakeId: number): Promise<ApplyPlan> {
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
      id: true, inventoryItemId: true, title: true, variantTitle: true, sku: true, cost: true,
      expectedQty: true, countedQty: true, liveQtyAtReview: true, drifted: true, driftResolution: true,
      targetQty: true, applied: true,
    },
  });

  const eligible: ApplyPlanItem[] = [];
  const needsActivation: ExcludedItem[] = [];
  const unsettable: ExcludedItem[] = [];
  let alreadyApplied = 0;
  let pendingDrift = 0;
  let negative = 0;
  let storedNegative = 0;

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
    if (o.negative) negative++;
    if (item.targetQty != null && item.targetQty < 0) storedNegative++;

    const excluded = (reason: ReviewIssue): ExcludedItem => ({
      itemId: item.id, title: item.title, variantTitle: item.variantTitle, sku: item.sku,
      reason, targetQty: item.targetQty, counted: o.effectiveCount,
    });
    if (issue === "NOT_STOCKED") {
      if (o.included) needsActivation.push(excluded(issue));
      continue;
    }
    if (issue === "UNTRACKED" || issue === "MISSING") {
      if (o.included) unsettable.push(excluded(issue));
      continue;
    }

    // Only the stored target is ever sent, and only when it truly changes
    // Shopify. changeFromQuantity must be a real number, never null.
    if (item.targetQty == null || item.liveQtyAtReview == null) continue;
    if (item.targetQty === item.liveQtyAtReview) continue;
    const cost = item.cost == null ? null : Number(item.cost);
    eligible.push({
      itemId: item.id,
      inventoryItemId: item.inventoryItemId,
      title: item.title,
      variantTitle: item.variantTitle,
      sku: item.sku,
      changeFromQuantity: item.liveQtyAtReview,
      targetQty: item.targetQty,
      change: item.targetQty - item.liveQtyAtReview,
      cost,
    });
  }

  let unitsUp = 0, unitsDown = 0, netValue = 0, changingNoCost = 0;
  for (const e of eligible) {
    if (e.change > 0) unitsUp += e.change;
    else unitsDown += -e.change;
    if (e.cost == null) changingNoCost++;
    else netValue += e.change * e.cost;
  }

  const blockers: string[] = [];
  if (stocktake.status !== "REVIEW") blockers.push(`The stocktake is ${stocktake.status}, not in review.`);
  if (running) blockers.push("A drift check is running.");
  if (review?.error) blockers.push("The last drift check failed. Re-run it.");
  if (!review?.checkedAt) {
    if (!running) blockers.push("The live drift check hasn't completed. Re-run it.");
  } else if (Date.now() - new Date(review.checkedAt).getTime() > DRIFT_CHECK_MAX_AGE_MS) {
    blockers.push("The drift check is more than 60 minutes old. Re-run it on the review screen.");
  }
  if (pendingDrift > 0) blockers.push(`${pendingDrift} drifted item${pendingDrift === 1 ? " needs" : "s need"} a decision.`);
  if (negative > 0 || storedNegative > 0) blockers.push(`${negative + storedNegative} item${negative + storedNegative === 1 ? " has" : "s have"} a target below zero.`);
  if (unsettable.length > 0) {
    blockers.push(`${unsettable.length} item${unsettable.length === 1 ? " is" : "s are"} flagged as unsettable (tracking off or gone from Shopify).`);
  }
  if (eligible.length === 0) blockers.push("No quantities would change.");

  return {
    stocktake: {
      id: stocktake.id, name: stocktake.name, mode: stocktake.mode, status: stocktake.status,
      locationId: stocktake.locationId, applyAttempt: stocktake.applyAttempt,
    },
    checkedAt: review?.checkedAt ?? null,
    eligible,
    needsActivation,
    unsettable,
    alreadyApplied,
    totals: { itemsChanging: eligible.length, unitsUp, unitsDown, net: unitsUp - unitsDown, netValue, changingNoCost },
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
// The attempt number changes before every new attempt, so a key is never
// reused after a failure; identical parameters within one attempt give the
// same key, so a replayed request can't apply twice.
export function buildIdempotencyKey(stocktakeId: number, attempt: number, items: ApplyPlanItem[]): string {
  const digest = createHash("sha256")
    .update(items.map((i) => `${i.itemId}:${i.targetQty}:${i.changeFromQuantity}`).sort().join("|"))
    .digest("hex");
  return `stocktake-${stocktakeId}-a${attempt}-${digest}`;
}

export function buildSetQuantitiesInput(stocktakeId: number, locationId: string, items: ApplyPlanItem[], reason = APPLY_REASON) {
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

export type DryRunChunk = {
  index: number;
  idempotencyKey: string;
  input: ReturnType<typeof buildSetQuantitiesInput>;
};

// Exactly what the next apply attempt would send, chunk by chunk. No Shopify calls.
export function buildDryRun(plan: ApplyPlan): { attempt: number; chunks: DryRunChunk[] } {
  const attempt = plan.stocktake.applyAttempt + 1;
  const chunks = chunkItems(plan.eligible).map((items, index) => ({
    index,
    idempotencyKey: buildIdempotencyKey(plan.stocktake.id, attempt, items),
    input: buildSetQuantitiesInput(plan.stocktake.id, plan.stocktake.locationId, items),
  }));
  return { attempt, chunks };
}
