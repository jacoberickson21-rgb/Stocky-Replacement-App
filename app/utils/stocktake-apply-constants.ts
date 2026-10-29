// Shared by the apply service and the apply screen — keep free of server-only imports.

// inventorySetQuantities quantities per call (Shopify's limit is higher; we stay well under).
export const APPLY_CHUNK_SIZE = 200;
// Reason sent with every stocktake apply. Verified by the first test item.
export const APPLY_REASON = "cycle_count_available";
// A drift check older than this must be re-run before applying.
export const DRIFT_CHECK_MAX_AGE_MS = 60 * 60 * 1000;
