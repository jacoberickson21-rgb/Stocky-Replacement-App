import { getDb } from "../db.server";
import { requireUserId } from "../session.server";

// GET /api/sync/debug — temporary debug endpoint to inspect sync state
export async function loader({ request }: { request: Request }) {
  await requireUserId(request);
  const db = getDb();

  const [latest, recent, productCacheCount] = await Promise.all([
    db.syncLog.findFirst({ orderBy: { startedAt: "desc" } }),
    db.syncLog.findMany({ orderBy: { startedAt: "desc" }, take: 5 }),
    db.productCache.count(),
  ]);

  return Response.json({
    productCacheCount,
    latestSync: latest,
    recentSyncs: recent,
  });
}
