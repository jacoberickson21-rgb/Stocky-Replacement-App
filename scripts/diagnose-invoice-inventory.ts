import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

// ─── Shopify helpers ──────────────────────────────────────────────────────────

async function getAccessToken(): Promise<string> {
  const clientId = process.env.SHOPIFY_CLIENT_ID!;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET!;
  const store = process.env.SHOPIFY_STORE!;

  const res = await fetch(
    `https://${store}.myshopify.com/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      }),
    }
  );
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("Failed to get Shopify access token");
  return data.access_token;
}

async function shopifyGraphQL<T>(
  token: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const store = process.env.SHOPIFY_STORE!;
  const res = await fetch(
    `https://${store}.myshopify.com/admin/api/2026-04/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  const result = (await res.json()) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (result.errors?.length)
    throw new Error(result.errors.map((e) => e.message).join("; "));
  if (!result.data) throw new Error("Empty response from Shopify");
  return result.data;
}

async function getPrimaryLocationId(
  token: string
): Promise<{ id: string; name: string }> {
  const data = await shopifyGraphQL<{
    locations: { edges: { node: { id: string; name: string } }[] };
  }>(
    token,
    `query { locations(first: 1) { edges { node { id name } } } }`
  );
  const edge = data.locations.edges[0];
  if (!edge) throw new Error("No locations found in Shopify");
  return edge.node;
}

async function getInventoryAtLocation(
  token: string,
  inventoryItemId: string,
  locationId: string
): Promise<number | null> {
  const data = await shopifyGraphQL<{
    inventoryItem: {
      inventoryLevel: {
        quantities: { name: string; quantity: number }[];
      } | null;
    } | null;
  }>(
    token,
    `query GetInventory($itemId: ID!, $locationId: ID!) {
      inventoryItem(id: $itemId) {
        inventoryLevel(locationId: $locationId) {
          quantities(names: ["available"]) { name quantity }
        }
      }
    }`,
    { itemId: inventoryItemId, locationId }
  );
  return (
    data.inventoryItem?.inventoryLevel?.quantities.find(
      (q) => q.name === "available"
    )?.quantity ?? null
  );
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function col(val: string, width: number, align: "left" | "right" = "left"): string {
  const s = String(val).slice(0, width);
  return align === "right" ? s.padStart(width) : s.padEnd(width);
}

function yn(val: boolean | null | undefined): string {
  return val ? "YES" : "NO";
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const invoiceNumber = process.argv[2];
  if (!invoiceNumber) {
    console.error("Usage: npx tsx scripts/diagnose-invoice-inventory.ts <invoiceNumber>");
    console.error("Example: npx tsx scripts/diagnose-invoice-inventory.ts 295926");
    process.exit(1);
  }

  console.log("=".repeat(80));
  console.log(`INVOICE INVENTORY DIAGNOSTIC — #${invoiceNumber}`);
  console.log("=".repeat(80));

  // ── Load invoice from DB ──────────────────────────────────────────────────
  const invoice = await db.invoice.findFirst({
    where: { invoiceNumber },
    include: { vendor: true, supplier: true, lineItems: true },
  });

  if (!invoice) {
    console.error(`\nNo invoice found with invoiceNumber "${invoiceNumber}"`);
    process.exit(1);
  }

  const vendorName = invoice.vendor?.name ?? invoice.supplier?.name ?? "—";
  console.log(`\nInvoice ID   : ${invoice.id}`);
  console.log(`Invoice #    : ${invoice.invoiceNumber}`);
  console.log(`Vendor       : ${vendorName}`);
  console.log(`Status       : ${invoice.status}`);
  console.log(`Line items   : ${invoice.lineItems.length}`);

  // ── Get Shopify location ──────────────────────────────────────────────────
  console.log("\n── SHOPIFY LOCATION ────────────────────────────────────────────────────────");
  const token = await getAccessToken();
  const location = await getPrimaryLocationId(token);
  console.log(`Using: ${location.id}  "${location.name}"`);

  // ── Per-item table ────────────────────────────────────────────────────────
  console.log("\n── LINE ITEMS ──────────────────────────────────────────────────────────────");
  console.log(
    `${col("SKU", 18)} | ${col("RcvdQty", 7, "right")} | ${col("Synced", 6)} | ${col("ItemId?", 7)} | ${col("ShopifyQty", 10, "right")} | ${col("Diff", 6, "right")} | Notes`
  );
  console.log("-".repeat(90));

  type ItemRow = {
    id: number;
    sku: string | null;
    quantityReceived: number | null;
    inventorySynced: boolean;
    shopifyInventoryItemId: string | null;
    shopifyQty: number | null;
    fetchError: string | null;
  };

  const rows: ItemRow[] = [];

  for (const item of invoice.lineItems) {
    let shopifyQty: number | null = null;
    let fetchError: string | null = null;

    if (item.shopifyInventoryItemId) {
      try {
        shopifyQty = await getInventoryAtLocation(
          token,
          item.shopifyInventoryItemId,
          location.id
        );
      } catch (err) {
        fetchError = err instanceof Error ? err.message : String(err);
      }
    }

    const row: ItemRow = {
      id: item.id,
      sku: item.sku,
      quantityReceived: item.quantityReceived,
      inventorySynced: item.inventorySynced,
      shopifyInventoryItemId: item.shopifyInventoryItemId,
      shopifyQty,
      fetchError,
    };
    rows.push(row);

    const rcvd = item.quantityReceived ?? 0;
    const diff =
      shopifyQty !== null ? shopifyQty - rcvd : null;

    let notes = "";
    if (!item.shopifyInventoryItemId) {
      notes = "NO SHOPIFY LINK";
    } else if (fetchError) {
      notes = `ERROR: ${fetchError}`;
    } else if (shopifyQty === null) {
      notes = "NOT AT THIS LOCATION";
    } else if (diff === 0) {
      notes = item.inventorySynced ? "synced, qty matches" : "UNSYNCED — qty matches (was 0?)";
    } else if (diff === rcvd && !item.inventorySynced) {
      notes = "NOT APPLIED — shopify unchanged from before receive";
    } else if (diff !== null && diff < 0) {
      notes = "SHOPIFY LOWER THAN RECEIVED";
    } else {
      notes = item.inventorySynced ? "OK" : "UNSYNCED";
    }

    console.log(
      `${col(item.sku ?? "—", 18)} | ${col(String(rcvd), 7, "right")} | ${col(yn(item.inventorySynced), 6)} | ${col(item.shopifyInventoryItemId ? "YES" : "NO", 7)} | ${col(shopifyQty !== null ? String(shopifyQty) : "—", 10, "right")} | ${col(diff !== null ? String(diff) : "—", 6, "right")} | ${notes}`
    );
  }

  // ── Group by inventoryItemId ──────────────────────────────────────────────
  console.log("\n── SHARED INVENTORY ITEM IDs ───────────────────────────────────────────────");

  const byItemId = new Map<string, ItemRow[]>();
  for (const row of rows) {
    if (!row.shopifyInventoryItemId) continue;
    const key = row.shopifyInventoryItemId;
    if (!byItemId.has(key)) byItemId.set(key, []);
    byItemId.get(key)!.push(row);
  }

  const shared = [...byItemId.entries()].filter(([, items]) => items.length > 1);

  if (shared.length === 0) {
    console.log("No line items share an inventoryItemId — no collision possible.");
  } else {
    console.log(
      `\n${shared.length} inventoryItemId(s) shared by multiple line items:\n`
    );
    for (const [itemId, items] of shared) {
      console.log(`  inventoryItemId: ${itemId}`);
      console.log(`  Shared by ${items.length} line items:`);
      for (const row of items) {
        const rcvd = row.quantityReceived ?? 0;
        console.log(
          `    • lineItem #${row.id}  SKU: ${row.sku ?? "—"}  rcvd=${rcvd}  synced=${yn(row.inventorySynced)}  shopifyQty=${row.shopifyQty ?? "—"}`
        );
      }

      // Idempotency key analysis
      console.log(`\n  Idempotency keys that WERE generated (format: adjust-{lineItemId}-{inventoryItemId}-{locationId}):`);
      for (const row of items) {
        const key = `adjust-${row.id}-${itemId}-${location.id}`;
        console.log(`    ${key}`);
      }

      const totalExpected = items.reduce(
        (sum, r) => sum + (r.quantityReceived ?? 0),
        0
      );
      const currentShopify = items[0].shopifyQty;
      console.log(`\n  Sum of all received qtys : ${totalExpected}`);
      console.log(
        `  Current Shopify qty      : ${currentShopify ?? "—"}`
      );
      if (currentShopify !== null) {
        const missing = totalExpected - currentShopify;
        if (missing > 0) {
          console.log(
            `  *** SHORTFALL: Shopify is missing ${missing} units compared to total received ***`
          );
        } else if (missing < 0) {
          console.log(
            `  *** EXCESS: Shopify has ${Math.abs(missing)} more units than total received ***`
          );
        } else {
          console.log(`  Qty matches total received — no shortfall detected.`);
        }
      }
      console.log();
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("── SUMMARY ─────────────────────────────────────────────────────────────────");

  const withLink = rows.filter((r) => r.shopifyInventoryItemId);
  const noLink = rows.filter((r) => !r.shopifyInventoryItemId);
  const synced = rows.filter((r) => r.inventorySynced);
  const unsynced = rows.filter((r) => !r.inventorySynced && r.shopifyInventoryItemId);
  const sharedItemIds = new Set(shared.flatMap(([id]) => [id]));
  const inCollisionGroup = rows.filter(
    (r) => r.shopifyInventoryItemId && sharedItemIds.has(r.shopifyInventoryItemId)
  );

  console.log(`  Total line items          : ${rows.length}`);
  console.log(`  Linked to Shopify         : ${withLink.length}`);
  console.log(`  No Shopify link           : ${noLink.length}`);
  console.log(`  inventorySynced = true    : ${synced.length}`);
  console.log(`  inventorySynced = false   : ${unsynced.length}`);
  console.log(`  Shared inventoryItemIds   : ${shared.length} group(s) involving ${inCollisionGroup.length} line item(s)`);

  if (unsynced.length > 0) {
    console.log(`\n  UNSYNCED items (need manual Shopify correction):`);
    for (const row of unsynced) {
      console.log(
        `    • lineItem #${row.id}  SKU: ${row.sku ?? "—"}  rcvd=${row.quantityReceived ?? 0}  shopifyQty=${row.shopifyQty ?? "—"}`
      );
    }
  }

  if (synced.length > 0 && shared.length > 0) {
    console.log(`\n  WARNING: ${synced.length} item(s) marked inventorySynced=true, but ${shared.length} shared`);
    console.log(`  inventoryItemId group(s) exist. If invoice was received before commit 275b820,`);
    console.log(`  items after the first in each group were silently skipped by Shopify idempotency`);
    console.log(`  but still marked synced. Check the shortfall lines above for the real impact.`);
  }

  console.log();
}

main()
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
