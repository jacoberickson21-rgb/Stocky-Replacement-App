import { requireUserId } from "../session.server";
import { resetRunningSyncs } from "../services/sync.server";

// POST /api/sync/reset — marks all RUNNING SyncLog entries as ERROR
export async function action({ request }: { request: Request }) {
  await requireUserId(request);
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const count = await resetRunningSyncs();
  console.log(`[sync] manual reset: ${count} RUNNING sync(s) marked as ERROR`);
  return Response.json({ reset: count });
}
