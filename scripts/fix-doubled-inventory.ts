/**
 * fix-doubled-inventory.ts
 *
 * For each RECEIVED invoice line item where Shopify qty == 2× quantityReceived
 * (i.e., inventory was applied twice from a baseline of 0), this script
 * subtracts quantityReceived from Shopify to bring it back to the correct level.
 *
 * Safety checks before every adjustment:
 *   - Re-reads current Shopify qty immediately before acting
 *   - Skips if current qty is already 0 (nothing to fix)
 *   - Skips if the delta would result in a negative qty
 *   - Skips if current qty no longer matches the doubled signature
 *
 * Run in dry-run mode first (default):
 *   npx tsx scripts/fix-doubled-inventory.ts
 *
 * Apply for real:
 *   npx tsx scripts/fix-doubled-inventory.ts --apply
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const DRY_RUN = !process.argv.includes("--apply");

// ─── Shopify helpers ──────────────────────────────────────────────────────────

async function getAccessToken(): Promise<string> {
  const clientId = process.env.SHOPIFY_CLIENT_ID!;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET!;
  const store = process.env.SHOPIFY_STORE!;

  const res = await fetch(`https://${store}.myshopify.com/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
  });

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
  const res = await fetch(`https://${store}.myshopify.com/admin/api/2026-04/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (result.errors?.length) throw new Error(result.errors.map((e) => e.message).join("; "));
  if (!result.data) throw new Error("Empty response from Shopify");
  return result.data;
}

async function getPrimaryLocationId(token: string): Promise<string> {
  const data = await shopifyGraphQL<{
    locations: { edges: { node: { id: string; name: string } }[] };
  }>(
    token,
    `query GetLocation {
      locations(first: 1) {
        edges { node { id name } }
      }
    }`
  );
  const edge = data.locations.edges[0];
  if (!edge) throw new Error("No locations found in Shopify");
  console.log(`Primary location: ${edge.node.id}  "${edge.node.name}"`);
  return edge.node.id;
}

async function getCurrentQty(
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
    `query GetQty($itemId: ID!, $locationId: ID!) {
      inventoryItem(id: $itemId) {
        inventoryLevel(locationId: $locationId) {
          quantities(names: ["available"]) {
            name
            quantity
          }
        }
      }
    }`,
    { itemId: inventoryItemId, locationId }
  );

  return (
    data.inventoryItem?.inventoryLevel?.quantities.find((q) => q.name === "available")
      ?.quantity ?? null
  );
}

async function applyDelta(
  token: string,
  inventoryItemId: string,
  locationId: string,
  delta: number,
  currentQty: number,
  idempotencyKey: string
): Promise<void> {
  const data = await shopifyGraphQL<{
    inventoryAdjustQuantities: { userErrors: { field: string[]; message: string }[] };
  }>(
    token,
    `mutation AdjustInventory($input: InventoryAdjustQuantitiesInput!, $key: String!) {
      inventoryAdjustQuantities(input: $input) @idempotent(key: $key) {
        inventoryAdjustmentGroup { id }
        userErrors { field message }
      }
    }`,
    {
      input: {
        name: "available",
        reason: "correction",
        changes: [
          {
            inventoryItemId,
            locationId,
            delta,
            changeFromQuantity: currentQty,
          },
        ],
      },
      key: idempotencyKey,
    }
  );

  const { userErrors } = data.inventoryAdjustQuantities;
  if (userErrors.length > 0) {
    throw new Error(userErrors.map((e) => `${e.field.join(".")}: ${e.message}`).join("; "));
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const HARELINE_SKU_PREFIXES = ["SL", "ICE", "SQB", "IH", "BC", "HL", "MFC", "MGS", "MGC"];
const HARELINE_SKU_EXACT = ["SL11", "SL40", "ICE286", "SQB1"];

async function main() {
  console.log("=".repeat(80));
  console.log(`FIX DOUBLED INVENTORY  —  ${DRY_RUN ? "DRY RUN (no changes)" : "*** LIVE MODE ***"}`);
  console.log("=".repeat(80));

  if (DRY_RUN) {
    console.log("\nRunning in dry-run mode. Pass --apply to make real changes.\n");
  } else {
    console.log("\n*** LIVE MODE: Changes will be applied to Shopify. ***\n");
  }

  const token = await getAccessToken();
  const locationId = await getPrimaryLocationId(token);

  const allReceived = await db.invoice.findMany({
    where: { status: "RECEIVED" },
    include: { vendor: true, supplier: true, lineItems: true },
    orderBy: { createdAt: "desc" },
  });

  const matching = allReceived.filter((inv) =>
    inv.lineItems.some((item) => {
      if (!item.sku) return false;
      const upper = item.sku.toUpperCase();
      if (HARELINE_SKU_EXACT.includes(upper)) return true;
      return HARELINE_SKU_PREFIXES.some((p) => upper.startsWith(p));
    })
  );

  console.log(`\nFound ${matching.length} matching invoice(s).`);

  let checked = 0;
  let wouldFix = 0;
  let fixed = 0;
  let skipped = 0;
  let errors = 0;

  for (const invoice of matching) {
    const name = invoice.vendor?.name ?? invoice.supplier?.name ?? "—";
    console.log(`\n── Invoice #${invoice.invoiceNumber}  (${name}) ──`);

    for (const item of invoice.lineItems) {
      if (!item.shopifyInventoryItemId) continue;
      if (item.quantityReceived <= 0) continue;

      checked++;
      const label = `${item.sku ?? item.description} (lineItem ${item.id})`;

      // Step 1: Read current qty from Shopify at the correct location
      let currentQty: number | null;
      try {
        currentQty = await getCurrentQty(token, item.shopifyInventoryItemId, locationId);
      } catch (err) {
        console.log(`  SKIP  ${label} — could not read qty: ${err instanceof Error ? err.message : String(err)}`);
        skipped++;
        continue;
      }

      if (currentQty === null) {
        console.log(`  SKIP  ${label} — item not tracked at this location`);
        skipped++;
        continue;
      }

      const expectedDoubled = item.quantityReceived * 2;

      // Step 2: Confirm this item still shows the doubled signature
      if (currentQty !== expectedDoubled) {
        if (currentQty === item.quantityReceived) {
          console.log(
            `  SKIP  ${label} — qty=${currentQty} matches received (already correct or NEEDS_UPDATE, not doubled)`
          );
        } else {
          console.log(
            `  SKIP  ${label} — qty=${currentQty} does not match doubled signature (expected ${expectedDoubled}); manual review needed`
          );
        }
        skipped++;
        continue;
      }

      // Step 3: Safety check — delta that will be applied
      const delta = -item.quantityReceived;
      const resultQty = currentQty + delta;

      if (currentQty === 0) {
        console.log(`  SKIP  ${label} — current qty is already 0, nothing to fix`);
        skipped++;
        continue;
      }

      if (resultQty < 0) {
        console.log(
          `  WARN  ${label} — delta ${delta} would result in ${resultQty} (negative); skipping`
        );
        skipped++;
        continue;
      }

      wouldFix++;

      if (DRY_RUN) {
        console.log(
          `  [DRY] ${label} — currentQty=${currentQty}, delta=${delta}, resultQty=${resultQty}`
        );
        continue;
      }

      // Step 4: Apply the correction
      const idempotencyKey = `fix-doubled-${item.shopifyInventoryItemId}-${locationId}`;
      try {
        await applyDelta(token, item.shopifyInventoryItemId, locationId, delta, currentQty, idempotencyKey);
        console.log(
          `  FIXED ${label} — ${currentQty} → ${resultQty} (delta ${delta})`
        );
        fixed++;
      } catch (err) {
        console.log(`  ERROR ${label} — ${err instanceof Error ? err.message : String(err)}`);
        errors++;
      }
    }
  }

  console.log(`\n${"=".repeat(80)}`);
  console.log("RESULTS");
  console.log(`${"=".repeat(80)}`);
  console.log(`  Items checked:    ${checked}`);
  if (DRY_RUN) {
    console.log(`  Would fix:        ${wouldFix}`);
    console.log(`  Would skip:       ${skipped}`);
    console.log(`\nRun with --apply to apply these ${wouldFix} correction(s).`);
  } else {
    console.log(`  Fixed:            ${fixed}`);
    console.log(`  Skipped:          ${skipped}`);
    console.log(`  Errors:           ${errors}`);
  }
}

main()
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
