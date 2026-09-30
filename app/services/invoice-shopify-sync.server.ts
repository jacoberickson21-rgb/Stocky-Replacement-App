import { getDb } from "../db.server";
import { logFailure } from "./failure-log.server";
import {
  lookupProduct,
  getLocationId,
  updateVariantBarcode,
  getProductIdFromVariant,
  getVariantPrice,
  getInventoryItemIdFromVariant,
  batchUpdateInventory,
  mapWithConcurrency,
  type BatchInventoryChange,
} from "./shopify.server";

// Bounded concurrency for the price/barcode sweeps — Shopify's GraphQL endpoint
// is rate-limited and shopifyGraphQL has no built-in retry/backoff, so this stays
// well under the point at which we'd start seeing THROTTLED errors.
const SYNC_CONCURRENCY = 6;

// Resolves a variant's inventoryItemId from ProductCache first (populated by the
// background sync) and only falls back to a live Shopify call on a cache miss —
// avoids a per-item Shopify round trip for the common case.
export async function resolveInventoryItemId(variantId: string): Promise<string | null> {
  const cached = await getDb().productCache.findUnique({
    where: { variantId },
    select: { inventoryItemId: true },
  });
  if (cached?.inventoryItemId) return cached.inventoryItemId;
  return getInventoryItemIdFromVariant(variantId);
}

export type InvoiceSyncResult = {
  invoiceId: number;
  itemsSynced: number;
  itemsFailed: number;
};

// The single place that pushes a received invoice's quantities, prices, and
// barcodes to Shopify. Called fire-and-forget right after the receive action
// commits, and again (awaited) from the "Retry Shopify Sync" button — both
// paths only touch items where inventorySynced is still false, so re-running
// this is always safe.
export async function syncInvoiceToShopify(invoiceId: number): Promise<InvoiceSyncResult> {
  const db = getDb();

  await db.invoice.update({
    where: { id: invoiceId },
    data: { shopifySyncStatus: "SYNCING", shopifySyncStartedAt: new Date(), shopifySyncError: null },
  });

  const invoice = await db.invoice.findUnique({
    where: { id: invoiceId },
    include: { lineItems: true },
  });

  if (!invoice) {
    return { invoiceId, itemsSynced: 0, itemsFailed: 0 };
  }

  let locationId: string | null = null;
  try {
    locationId = await getLocationId();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const affected = invoice.lineItems.filter((i) => !i.inventorySynced);
    for (const item of affected) {
      await logFailure(
        "INVENTORY_UPDATE",
        item.sku ?? item.description,
        `Could not fetch Shopify location: ${msg}`
      );
    }
    await db.invoice.update({
      where: { id: invoiceId },
      data: {
        shopifySyncStatus: "FAILED",
        shopifySyncEndedAt: new Date(),
        shopifySyncError: `Could not fetch Shopify location: ${msg}`,
      },
    });
    return { invoiceId, itemsSynced: 0, itemsFailed: affected.length };
  }

  const pendingItems = invoice.lineItems.filter((item) => !item.inventorySynced);
  const itemById = new Map(pendingItems.map((item) => [item.id, item]));

  let itemsFailed = 0;
  const errors: string[] = [];

  // Resolve a Shopify inventoryItemId for every pending item (fresh SKU lookup
  // when we don't already have one), building the batch mutation input.
  const changes: BatchInventoryChange[] = [];
  for (const item of pendingItems) {
    let inventoryItemId = item.shopifyInventoryItemId;
    let freshVariantId: string | null = null;
    let freshInventoryItemId: string | null = null;
    let freshTitle: string | null = null;
    let freshPrice: string | null = null;

    if (!inventoryItemId && item.sku) {
      try {
        const freshResult = await lookupProduct({ sku: item.sku });
        const v = freshResult?.product.variants[0];
        if (v?.inventoryItemId) {
          freshVariantId = v.id;
          freshInventoryItemId = v.inventoryItemId;
          freshTitle = freshResult!.product.title;
          freshPrice = v.price;
          inventoryItemId = v.inventoryItemId;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await logFailure(
          "INVENTORY_UPDATE",
          item.sku,
          `Fresh SKU lookup failed, falling back to stored inventoryItemId: ${msg}`
        );
      }
    }

    if (!inventoryItemId) {
      await logFailure(
        "INVENTORY_UPDATE",
        item.sku ?? item.description,
        "No Shopify product linked — inventory update skipped"
      );
      itemsFailed++;
      errors.push(`${item.sku ?? item.description}: no Shopify product linked`);
      continue;
    }

    if (freshInventoryItemId != null || (freshPrice && !item.retailPrice)) {
      await db.invoiceLineItem.update({
        where: { id: item.id },
        data: {
          ...(freshInventoryItemId != null && {
            shopifyInventoryItemId: freshInventoryItemId,
            shopifyVariantId: freshVariantId,
            ...(freshTitle && { shopifyProductTitle: freshTitle }),
          }),
          ...(freshPrice && !item.retailPrice ? { retailPrice: parseFloat(freshPrice) } : {}),
        },
      });
    }

    changes.push({
      inventoryItemId,
      locationId,
      delta: item.quantityReceived,
      lineItemId: item.id,
      reason: item.quantityReceived < 0 ? "correction" : "received",
    });
  }

  let itemsSynced = 0;
  if (changes.length > 0) {
    const outcome = await batchUpdateInventory(changes);
    if (outcome.succeeded.length > 0) {
      await db.invoiceLineItem.updateMany({
        where: { id: { in: outcome.succeeded.map((id) => Number(id)) } },
        data: { inventorySynced: true },
      });
      itemsSynced += outcome.succeeded.length;
    }
    for (const f of outcome.failed) {
      const item = itemById.get(Number(f.lineItemId));
      await logFailure("INVENTORY_UPDATE", item?.sku ?? item?.description ?? String(f.lineItemId), f.error);
      errors.push(f.error);
      itemsFailed++;
    }
  }

  // Retail price capture — parallel, bounded concurrency.
  await mapWithConcurrency(invoice.lineItems, SYNC_CONCURRENCY, async (item) => {
    if (!item.shopifyVariantId) return;
    try {
      const price = await getVariantPrice(item.shopifyVariantId);
      if (price !== null) {
        await db.invoiceLineItem.update({ where: { id: item.id }, data: { retailPrice: parseFloat(price) } });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logFailure("RETAIL_PRICE_FETCH", item.sku ?? item.description, msg);
    }
  });

  // Barcode sync — parallel, bounded concurrency.
  await mapWithConcurrency(invoice.lineItems, SYNC_CONCURRENCY, async (item) => {
    if (!item.shopifyVariantId || !item.barcode) return;
    try {
      const cached = await db.productCache.findUnique({
        where: { variantId: item.shopifyVariantId },
        select: { productId: true },
      });
      let productId = cached?.productId ?? null;
      if (!productId) {
        try {
          productId = await getProductIdFromVariant(item.shopifyVariantId);
        } catch { /* ignore */ }
      }
      if (productId) {
        await updateVariantBarcode(productId, item.shopifyVariantId, item.barcode);
      } else {
        await logFailure(
          "BARCODE_SYNC",
          item.sku ?? item.description,
          `Could not resolve productId for variant ${item.shopifyVariantId}`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logFailure("BARCODE_SYNC", item.sku ?? item.description, msg);
    }
  });

  const finalStatus = itemsFailed > 0 ? "FAILED" : "SYNCED";
  await db.invoice.update({
    where: { id: invoiceId },
    data: {
      shopifySyncStatus: finalStatus,
      shopifySyncEndedAt: new Date(),
      shopifySyncError: errors.length > 0 ? errors.slice(0, 5).join("; ") : null,
    },
  });

  return { invoiceId, itemsSynced, itemsFailed };
}
