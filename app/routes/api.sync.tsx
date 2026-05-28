import { requireUserId } from "../session.server";
import { startSync, getSyncStatus } from "../services/sync.server";

// GET /api/sync — return latest sync status
export async function loader({ request }: { request: Request }) {
  await requireUserId(request);
  const status = await getSyncStatus();
  return Response.json(status);
}

// POST /api/sync — trigger a new sync (non-blocking, returns 202)
// Pass forceFull=true in form data to bypass incremental and run a full sync.
export async function action({ request }: { request: Request }) {
  await requireUserId(request);
  const formData = await request.formData();
  const forceFull = formData.get("forceFull") === "true";
  const syncLogId = await startSync(forceFull);
  const status = await getSyncStatus();
  return Response.json({ syncLogId, ...status }, { status: 202 });
}
