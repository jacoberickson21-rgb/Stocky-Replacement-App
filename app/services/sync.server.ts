import { getDb } from "../db.server";
import { getAllProductVariants, getAllOrders } from "./shopify.server";

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

async function syncProducts(syncLogId: string): Promise<number> {
  const db = getDb();

  // Fetch all variants from Shopify, updating progress on each page
  const variants = await getAllProductVariants((count) => {
    db.syncLog
      .update({ where: { id: syncLogId }, data: { currentVariant: count } })
      .catch(() => {});
  });

  await db.syncLog
    .update({ where: { id: syncLogId }, data: { totalVariants: variants.length, currentVariant: 0 } })
    .catch(() => {});

  const now = new Date();

  for (let i = 0; i < variants.length; i += BATCH_SIZE) {
    const batch = variants.slice(i, i + BATCH_SIZE);
    await Promise.all(
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

    await db.syncLog
      .update({
        where: { id: syncLogId },
        data: { currentVariant: Math.min(i + BATCH_SIZE, variants.length) },
      })
      .catch(() => {});
  }

  return variants.length;
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
