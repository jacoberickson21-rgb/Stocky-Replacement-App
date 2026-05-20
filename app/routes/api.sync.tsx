import { requireUserId } from "../session.server";
import { startSync, getSyncStatus } from "../services/sync.server";

// GET /api/sync — return latest sync status
export async function loader({ request }: { request: Request }) {
  await requireUserId(request);
  const status = await getSyncStatus();
  return Response.json(status);
}

// POST /api/sync — trigger a new sync (non-blocking, returns 202)
export async function action({ request }: { request: Request }) {
  await requireUserId(request);
  const syncLogId = await startSync();
  const status = await getSyncStatus();
  return Response.json({ syncLogId, ...status }, { status: 202 });
}
