import { randomUUID } from "node:crypto";
import { getDb } from "../db.server";
import {
  startBulkProductSync,
  pollBulkOperation,
  downloadAndParseJSONL,
  getAllOrders,
} from "./shopify.server";

const BATCH_SIZE = 50;
const UPSERT_TIMEOUT_MS = 30_000;    // 30s per individual upsert
const MAX_SYNC_MS = 15 * 60_000;     // 15 minutes total runtime
const STALE_SYNC_MINUTES = 30;       // mark RUNNING syncs older than this as ERROR

// In-process lock — prevents concurrent startSync calls racing through the DB check.
// Safe because the JS event loop is single-threaded between awaits: the check-and-set
// is atomic from the perspective of any other concurrent async call.
let syncStartLock = false;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms (${label})`)), ms)
    ),
  ]);
}

export async function cleanupStaleSyncs(): Promise<void> {
  const db = getDb();
  const cutoff = new Date(Date.now() - STALE_SYNC_MINUTES * 60_000);
  const ts = new Date().toISOString().slice(11, 19);
  const result = await db.syncLog.updateMany({
    where: { status: "RUNNING", startedAt: { lt: cutoff } },
    data: {
      status: "ERROR",
      completedAt: new Date(),
      errorMessage: `[${ts}] Force-stopped: exceeded ${STALE_SYNC_MINUTES}-minute stale timeout`,
    },
  });
  if (result.count > 0) {
    console.warn(`[sync] cleaned up ${result.count} stale RUNNING sync(s) older than ${STALE_SYNC_MINUTES} min`);
  }
}

export async function resetRunningSyncs(): Promise<number> {
  const db = getDb();
  const ts = new Date().toISOString().slice(11, 19);
  const result = await db.syncLog.updateMany({
    where: { status: "RUNNING" },
    data: {
      status: "ERROR",
      completedAt: new Date(),
      errorMessage: `[${ts}] Manually reset`,
    },
  });
  return result.count;
}

async function updateProgress(
  db: ReturnType<typeof getDb>,
  syncLogId: string,
  msg: string
) {
  const ts = new Date().toISOString().slice(11, 19);
  await db.syncLog
    .update({ where: { id: syncLogId }, data: { errorMessage: `[${ts}] ${msg}` } })
    .catch(() => {});
}

export type SyncLogData = {
  id: string;
  status: "RUNNING" | "COMPLETE" | "ERROR";
  syncType: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  variantsSynced: number | null;
  salesDaysSynced: number | null;
  totalVariants: number | null;
  currentVariant: number | null;
  errorMessage: string | null;
};

export async function getSyncStatus(): Promise<SyncLogData | null> {
  const db = getDb();
  const log = await db.syncLog.findFirst({ orderBy: { startedAt: "desc" } });
  if (!log) return null;
  return {
    id: log.id,
    status: log.status as "RUNNING" | "COMPLETE" | "ERROR",
    syncType: log.syncType,
    startedAt: log.startedAt.toISOString(),
    completedAt: log.completedAt?.toISOString() ?? null,
    durationMs: log.durationMs,
    variantsSynced: log.variantsSynced,
    salesDaysSynced: log.salesDaysSynced,
    totalVariants: log.totalVariants,
    currentVariant: log.currentVariant,
    errorMessage: log.errorMessage,
  };
}

export async function startSync(forceFull = false): Promise<string> {
  // Synchronous check-and-set before any await — blocks concurrent callers instantly.
  if (syncStartLock) {
    console.log("[sync] startSync blocked by in-process lock, skipping duplicate start");
    const db = getDb();
    const running = await db.syncLog.findFirst({
      where: { status: "RUNNING" },
      orderBy: { startedAt: "desc" },
    });
    return running?.id ?? "locked";
  }
  syncStartLock = true;

  const db = getDb();
  try {
    // Clean up zombie syncs before checking for an active one
    await cleanupStaleSyncs();

    const running = await db.syncLog.findFirst({
      where: { status: "RUNNING" },
      orderBy: { startedAt: "desc" },
    });
    if (running) return running.id;

    // Determine sync type: incremental if a prior COMPLETE sync exists and not forcing full.
    // Use the prior sync's startedAt (not completedAt) so products updated during that sync
    // window are still captured.
    let lastSyncDate: Date | null = null;
    if (!forceFull) {
      const lastComplete = await db.syncLog.findFirst({
        where: { status: "COMPLETE" },
        orderBy: { startedAt: "desc" },
      });
      if (lastComplete) {
        lastSyncDate = lastComplete.startedAt;
      }
    }
    const syncType = lastSyncDate ? "INCREMENTAL" : "FULL";
    console.log(`[sync] starting ${syncType} sync${lastSyncDate ? ` (since ${lastSyncDate.toISOString().slice(0, 16)})` : ""}`);

    const logId = randomUUID();
    await db.$executeRaw`
      INSERT INTO "SyncLog" (id, status, "syncType", "startedAt")
      VALUES (${logId}, 'RUNNING'::"SyncStatus", ${syncType}, NOW())
    `;

    // Fire and forget — must not be awaited
    runSync(logId, lastSyncDate).catch((err) => {
      console.error("[sync] unhandled runSync error:", err);
    });

    return logId;
  } finally {
    syncStartLock = false;
  }
}

async function runSync(syncLogId: string, lastSyncDate: Date | null): Promise<void> {
  const start = Date.now();
  const db = getDb();

  try {
    const variantsSynced = await syncProducts(syncLogId, start, lastSyncDate);
    const salesDaysSynced = await syncSales(syncLogId);

    await db.syncLog.update({
      where: { id: syncLogId },
      data: {
        status: "COMPLETE",
        completedAt: new Date(),
        durationMs: Date.now() - start,
        variantsSynced,
        salesDaysSynced,
        errorMessage: null,
      },
    });

    console.log(
      `[sync] complete: ${variantsSynced} variants, ${salesDaysSynced} sales-days in ${Date.now() - start}ms`
    );
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error("[sync] error:", errMsg);
    await db.syncLog
      .update({
        where: { id: syncLogId },
        data: {
          status: "ERROR",
          completedAt: new Date(),
          durationMs: Date.now() - start,
          errorMessage: errMsg,
        },
      })
      .catch(console.error);
  }
}

const UPSERT_BATCH_SIZE = 250;
const POLL_INTERVAL_MS = 5000;
const MAX_POLLS = 120; // 10 minutes

async function syncProducts(syncLogId: string, syncStart: number, lastSyncDate: Date | null): Promise<number> {
  const db = getDb();

  const progressPrefix = lastSyncDate
    ? `Starting incremental Shopify bulk product export (since ${lastSyncDate.toISOString().slice(0, 10)})...`
    : "Starting full Shopify bulk product export...";
  await updateProgress(db, syncLogId, progressPrefix);
  const operationId = await startBulkProductSync(lastSyncDate ?? undefined);
  console.log(`[sync] bulk operation started: ${operationId}`);

  let downloadUrl: string | null = null;
  for (let poll = 0; poll < MAX_POLLS; poll++) {
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const op = await pollBulkOperation(operationId);

    await db.syncLog
      .update({
        where: { id: syncLogId },
        data: {
          currentVariant: op.objectCount,
          errorMessage: `[${new Date().toISOString().slice(11, 19)}] Shopify bulk export running: ${op.objectCount.toLocaleString()} objects (poll ${poll + 1}/${MAX_POLLS})`,
        },
      })
      .catch(() => {});

    if (op.status === "COMPLETED") {
      downloadUrl = op.url;
      console.log(`[sync] bulk operation complete (${op.objectCount} objects). Downloading...`);
      break;
    }
    if (["FAILED", "CANCELED", "ACCESS_DENIED"].includes(op.status)) {
      throw new Error(`Bulk operation ${op.status}${op.errorCode ? `: ${op.errorCode}` : ""}`);
    }
    console.log(`[sync] bulk ${op.status} (${op.objectCount} so far), poll ${poll + 1}/${MAX_POLLS}`);
  }

  if (!downloadUrl) {
    throw new Error("Bulk operation timed out after 10 minutes");
  }

  await updateProgress(db, syncLogId, "Downloading and parsing variant data from Shopify...");
  const variants = await downloadAndParseJSONL(downloadUrl);
  console.log(`[sync:products] Downloaded ${variants.length.toLocaleString()} variants from Shopify`);

  await db.syncLog
    .update({ where: { id: syncLogId }, data: { totalVariants: variants.length, currentVariant: 0 } })
    .catch(() => {});

  const now = new Date();
  let totalFailed = 0;

  for (let i = 0; i < variants.length; i += UPSERT_BATCH_SIZE) {
    // Abort if we've been running too long
    const elapsed = Date.now() - syncStart;
    if (elapsed > MAX_SYNC_MS) {
      throw new Error(
        `Sync aborted: exceeded ${MAX_SYNC_MS / 60_000}-minute max runtime at variant ${i + 1} of ${variants.length}`
      );
    }

    const batch = variants.slice(i, i + UPSERT_BATCH_SIZE);
    const batchEnd = Math.min(i + UPSERT_BATCH_SIZE, variants.length);
    const batchNum = Math.floor(i / UPSERT_BATCH_SIZE) + 1;
    const firstV = batch[0];

    // DEBUG: log every batch so we can identify which one fails
    console.log(
      `[sync] batch ${batchNum}: variants ${i + 1}–${batchEnd} of ${variants.length}` +
      ` | first: SKU="${firstV?.sku ?? "(none)"}" title="${firstV?.title}" variantId="${firstV?.variantId}"`
    );

    if (i % 1000 === 0) {
      const failNote = totalFailed > 0 ? ` (${totalFailed} failed)` : "";
      await updateProgress(
        db,
        syncLogId,
        `Upserting variants: ${batchEnd.toLocaleString()} / ${variants.length.toLocaleString()}${failNote}`
      );
    }

    // DEBUG: process one at a time so the exact failing variant is visible in logs
    for (const v of batch) {
      try {
        // Pre-upsert validation — catch bad data before it hits the DB
        if (!v.variantId || typeof v.variantId !== "string") {
          console.error(`[sync] SKIP invalid variantId: ${JSON.stringify(v.variantId)}`);
          totalFailed++;
          continue;
        }
        if (v.price === null || v.price === undefined || isNaN(v.price as number)) {
          console.error(
            `[sync] SKIP bad price: variantId=${v.variantId} SKU="${v.sku}" price=${v.price}`
          );
          totalFailed++;
          continue;
        }

        await withTimeout(
          db.productCache.upsert({
            where: { variantId: v.variantId },
            create: {
              variantId: v.variantId,
              productId: v.productId,
              title: v.title,
              variantTitle: v.variantTitle,
              sku: v.sku,
              barcode: v.barcode,
              vendor: v.vendor,
              productType: v.productType,
              tags: v.tags,
              price: v.price,
              cost: v.cost,
              currentInventory: v.currentInventory,
              imageUrl: v.imageUrl,
              status: v.status,
              syncedAt: now,
            },
            update: {
              productId: v.productId,
              title: v.title,
              variantTitle: v.variantTitle,
              sku: v.sku,
              barcode: v.barcode,
              vendor: v.vendor,
              productType: v.productType,
              tags: v.tags,
              price: v.price,
              cost: v.cost,
              currentInventory: v.currentInventory,
              imageUrl: v.imageUrl,
              status: v.status,
              syncedAt: now,
            },
          }),
          UPSERT_TIMEOUT_MS,
          `variantId=${v.variantId} SKU="${v.sku}"`
        );
      } catch (err) {
        totalFailed++;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(
          `[sync] UPSERT FAILED` +
          ` | variantId=${v.variantId}` +
          ` | SKU="${v.sku}"` +
          ` | title="${v.title}"` +
          ` | variantTitle="${v.variantTitle}"` +
          ` | price=${v.price}` +
          ` | cost=${v.cost}` +
          ` | inventory=${v.currentInventory}` +
          ` | tagsCount=${v.tags?.length ?? 0}` +
          ` | imageUrl=${v.imageUrl ? "yes" : "null"}` +
          ` | error: ${errMsg}`
        );
        if (err instanceof Error && err.stack) {
          console.error(`[sync] error stack:`, err.stack);
        }
      }
    }

    await db.syncLog
      .update({
        where: { id: syncLogId },
        data: { currentVariant: batchEnd },
      })
      .catch(() => {});
  }

  if (totalFailed > 0) {
    console.warn(`[sync] product upsert complete: ${variants.length - totalFailed} succeeded, ${totalFailed} failed`);
  }

  if (lastSyncDate) {
    // Incremental: report variants fetched/updated this run (not total DB count)
    const updated = variants.length - totalFailed;
    console.log(
      `[sync:products] Incremental sync: ${updated} variants updated` +
      (totalFailed > 0 ? `, ${totalFailed} failures` : "")
    );
    await updateProgress(
      db,
      syncLogId,
      `Products done: ${updated.toLocaleString()} variants updated from Shopify${totalFailed > 0 ? ` (${totalFailed} failures)` : ""}`
    );
    return updated;
  } else {
    // Full sync: report total DB count
    const dbTotal = await db.productCache.count();
    console.log(
      `[sync:products] ProductCache now has ${dbTotal.toLocaleString()} rows` +
      ` (${variants.length.toLocaleString()} fetched from Shopify, ${totalFailed} upsert failures this run)`
    );
    await updateProgress(
      db,
      syncLogId,
      `Products done: ProductCache has ${dbTotal.toLocaleString()} rows (${variants.length.toLocaleString()} from Shopify${totalFailed > 0 ? `, ${totalFailed} failures` : ""})`
    );
    return dbTotal;
  }
}

async function syncSales(syncLogId: string): Promise<number> {
  const db = getDb();

  const setting = await db.appSetting.findUnique({ where: { key: "salesHistoryDays" } });
  const daysCutoff = parseInt(setting?.value ?? "90");

  console.log(`[sync:sales] starting — fetching ${daysCutoff} days of order history`);
  await updateProgress(db, syncLogId, `Fetching ${daysCutoff} days of order history from Shopify...`);
  const syncStart = Date.now();

  const lineItems = await getAllOrders(daysCutoff);

  console.log(`[sync:sales] getAllOrders returned ${lineItems.length} line items in ${Date.now() - syncStart}ms`);

  if (lineItems.length === 0) {
    console.warn("[sync:sales] ⚠ zero line items returned — SalesCache will be empty. Check getAllOrders logs above.");
  }

  // Aggregate units and revenue by (variantId, calendar date)
  const agg = new Map<
    string,
    { variantId: string; sku: string | null; date: Date; unitsSold: number; revenue: number }
  >();

  for (const item of lineItems) {
    const dateStr = item.orderDate.slice(0, 10);
    const key = `${item.variantId}::${dateStr}`;
    const entry = agg.get(key) ?? {
      variantId: item.variantId,
      sku: item.sku,
      date: new Date(dateStr + "T00:00:00.000Z"),
      unitsSold: 0,
      revenue: 0,
    };
    entry.unitsSold += item.quantity;
    entry.revenue += item.quantity * item.price;
    agg.set(key, entry);
  }

  const rows = Array.from(agg.values());
  console.log(`[sync:sales] aggregated into ${rows.length} (variantId, date) rows across ${agg.size > 0 ? new Set(Array.from(agg.values()).map((r) => r.variantId)).size : 0} unique variants`);

  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map((r) =>
        db.salesCache.upsert({
          where: { variantId_date: { variantId: r.variantId, date: r.date } },
          create: { variantId: r.variantId, sku: r.sku, date: r.date, unitsSold: r.unitsSold, revenue: r.revenue },
          update: { sku: r.sku, unitsSold: r.unitsSold, revenue: r.revenue },
        })
      )
    );
    written += batch.length;
    if (i === 0 || written % 500 === 0 || written === rows.length) {
      console.log(`[sync:sales] upserted ${written}/${rows.length} rows into SalesCache`);
    }
  }

  console.log(`[sync:sales] done — ${written} SalesCache rows in ${Date.now() - syncStart}ms`);
  return written;
}
