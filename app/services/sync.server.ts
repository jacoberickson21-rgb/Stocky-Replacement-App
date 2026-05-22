import { getDb } from "../db.server";
import {
  startBulkProductSync,
  pollBulkOperation,
  downloadAndParseJSONL,
  getAllOrders,
} from "./shopify.server";

const BATCH_SIZE = 50;

export type SyncLogData = {
  id: string;
  status: "RUNNING" | "COMPLETE" | "ERROR";
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

export async function startSync(): Promise<string> {
  const db = getDb();

  const existing = await db.syncLog.findFirst({ orderBy: { startedAt: "desc" } });
  if (existing?.status === "RUNNING") return existing.id;

  const log = await db.syncLog.create({ data: { status: "RUNNING" } });

  // Fire and forget — must not be awaited
  runSync(log.id).catch((err) => {
    console.error("[sync] unhandled runSync error:", err);
  });

  return log.id;
}

async function runSync(syncLogId: string): Promise<void> {
  const start = Date.now();
  const db = getDb();

  try {
    const variantsSynced = await syncProducts(syncLogId);
    const salesDaysSynced = await syncSales(syncLogId);

    await db.syncLog.update({
      where: { id: syncLogId },
      data: {
        status: "COMPLETE",
        completedAt: new Date(),
        durationMs: Date.now() - start,
        variantsSynced,
        salesDaysSynced,
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

async function syncProducts(syncLogId: string): Promise<number> {
  const db = getDb();

  const operationId = await startBulkProductSync();
  console.log(`[sync] bulk operation started: ${operationId}`);

  let downloadUrl: string | null = null;
  for (let poll = 0; poll < MAX_POLLS; poll++) {
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const op = await pollBulkOperation(operationId);

    await db.syncLog
      .update({ where: { id: syncLogId }, data: { currentVariant: op.objectCount } })
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

  const variants = await downloadAndParseJSONL(downloadUrl);

  await db.syncLog
    .update({ where: { id: syncLogId }, data: { totalVariants: variants.length, currentVariant: 0 } })
    .catch(() => {});

  const now = new Date();
  let totalFailed = 0;

  for (let i = 0; i < variants.length; i += UPSERT_BATCH_SIZE) {
    const batch = variants.slice(i, i + UPSERT_BATCH_SIZE);
    const batchEnd = Math.min(i + UPSERT_BATCH_SIZE, variants.length);

    if (i % 1000 === 0) {
      console.log(`[sync] upserting variants ${i + 1}–${batchEnd} of ${variants.length}${totalFailed > 0 ? ` (${totalFailed} failed so far)` : ""}`);
    }

    const results = await Promise.allSettled(
      batch.map((v) =>
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
        })
      )
    );

    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed.length > 0) {
      totalFailed += failed.length;
      console.error(
        `[sync] batch ${i}–${batchEnd}: ${failed.length} upsert(s) failed:`,
        failed.map((r) => r.reason?.message ?? String(r.reason)).join(" | ")
      );
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

  return variants.length - totalFailed;
}

async function syncSales(syncLogId: string): Promise<number> {
  const db = getDb();

  const setting = await db.appSetting.findUnique({ where: { key: "salesHistoryDays" } });
  const daysCutoff = parseInt(setting?.value ?? "90");

  const lineItems = await getAllOrders(daysCutoff);

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
  }

  return rows.length;
}
