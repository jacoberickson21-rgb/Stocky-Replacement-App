import { getDb } from "../db.server";

export async function logFailure(
  operation: string,
  itemLabel: string,
  errorMessage: string
): Promise<void> {
  try {
    await getDb().$executeRaw`
      INSERT INTO "FailureLog" (operation, "itemLabel", "errorMessage", "occurredAt")
      VALUES (${operation}, ${itemLabel}, ${errorMessage}, NOW())
    `;
  } catch {
    console.error("[failure-log] Failed to write failure log:", operation, itemLabel);
  }
}
