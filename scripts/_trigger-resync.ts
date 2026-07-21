import "dotenv/config";
import { getDb } from "../app/db.server";
import { startSync, getSyncStatus } from "../app/services/sync.server";

async function main() {
  const db = getDb();

  await db.$transaction([
    db.appSetting.upsert({
      where: { key: "salesHistoryDays" },
      update: { value: "400" },
      create: { key: "salesHistoryDays", value: "400" },
    }),
    db.appSetting.upsert({
      where: { key: "autoSyncEnabled" },
      update: { value: "true" },
      create: { key: "autoSyncEnabled", value: "true" },
    }),
  ]);
  console.log("[trigger-resync] settings updated: salesHistoryDays=400, autoSyncEnabled=true");

  const logId = await startSync();
  console.log("[trigger-resync] sync started, logId:", logId);

  let lastMsg = "";
  while (true) {
    await new Promise((r) => setTimeout(r, 5000));
    const status = await getSyncStatus();
    if (!status) continue;
    if (status.errorMessage && status.errorMessage !== lastMsg) {
      lastMsg = status.errorMessage;
      console.log(`[trigger-resync] ${status.status}: ${lastMsg}`);
    }
    if (status.status !== "RUNNING") {
      console.log("[trigger-resync] FINAL STATUS:", JSON.stringify(status, null, 2));
      break;
    }
  }

  const [salesCacheCount, distinctVariants, dateRange, productCacheCount] = await Promise.all([
    db.salesCache.count(),
    db.$queryRaw<{ count: bigint }[]>`SELECT COUNT(DISTINCT "variantId") as count FROM "SalesCache"`,
    db.$queryRaw<{ min: Date | null; max: Date | null }[]>`SELECT MIN(date) as min, MAX(date) as max FROM "SalesCache"`,
    db.productCache.count(),
  ]);
  console.log("=== Post-sync SalesCache ===");
  console.log("Total rows:", salesCacheCount);
  console.log("Distinct variantId count:", distinctVariants[0]?.count?.toString());
  console.log("Date range:", dateRange[0]);
  console.log("ProductCache rows:", productCacheCount);

  await db.$disconnect();
}

main().catch((e) => {
  console.error("[trigger-resync] FAILED:", e);
  process.exit(1);
});
