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

// Returns the primary location ID — same query the app uses in getLocationId()
async function getPrimaryLocationId(token: string): Promise<{ id: string; name: string }> {
  const data = await shopifyGraphQL<{
    locations: { edges: { node: { id: string; name: string } }[] };
  }>(
    token,
    `query GetLocations {
      locations(first: 10) {
        edges {
          node { id name }
        }
      }
    }`
  );

  const edges = data.locations.edges;
  if (!edges.length) throw new Error("No locations found in Shopify");

  console.log(`\nAll Shopify locations (${edges.length}):`);
  for (const e of edges) {
    console.log(`  ${e.node.id}  ${e.node.name}`);
  }
  console.log(`\nPrimary location (first: 1) → ${edges[0].node.id}  "${edges[0].node.name}"`);
  return edges[0].node;
}

// Full dump: all locations + all quantity types for one inventory item
type LocationLevel = {
  locationId: string;
  locationName: string;
  quantities: { name: string; quantity: number }[];
};

async function getAllLocationsForItem(
  token: string,
  inventoryItemId: string
): Promise<LocationLevel[]> {
  const data = await shopifyGraphQL<{
    inventoryItem: {
      sku: string | null;
      inventoryLevels: {
        edges: {
          node: {
            location: { id: string; name: string };
            quantities: { name: string; quantity: number }[];
          };
        }[];
      };
    } | null;
  }>(
    token,
    `query GetAllLocations($id: ID!) {
      inventoryItem(id: $id) {
        sku
        inventoryLevels(first: 20) {
          edges {
            node {
              location { id name }
              quantities(names: ["available", "incoming", "committed", "on_hand"]) {
                name
                quantity
              }
            }
          }
        }
      }
    }`,
    { id: inventoryItemId }
  );

  return (data.inventoryItem?.inventoryLevels.edges ?? []).map((e) => ({
    locationId: e.node.location.id,
    locationName: e.node.location.name,
    quantities: e.node.quantities,
  }));
}

// Read available qty at a specific location
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
    `query GetInventoryAtLocation($itemId: ID!, $locationId: ID!) {
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

// ─── Formatting ───────────────────────────────────────────────────────────────

function col(val: string, width: number, align: "left" | "right" = "left"): string {
  const s = val.slice(0, width);
  return align === "right" ? s.padStart(width) : s.padEnd(width);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const HARELINE_SKU_PREFIXES = ["SL", "ICE", "SQB", "IH", "BC", "HL", "MFC", "MGS", "MGC"];
const HARELINE_SKU_EXACT = ["SL11", "SL40", "ICE286", "SQB1"];

async function main() {
  console.log("=".repeat(80));
  console.log("INVENTORY DIAGNOSTIC");
  console.log("=".repeat(80));

  const token = await getAccessToken();
  console.log("Shopify token acquired.");

  // ── Step 1: Confirm which location the app uses ───────────────────────────
  console.log("\n── LOCATION CHECK ──────────────────────────────────────────────────────────");
  const primaryLocation = await getPrimaryLocationId(token);
  console.log(`\nApp will use location: ${primaryLocation.id}  "${primaryLocation.name}"`);

  // ── Step 2: Find matching invoices ────────────────────────────────────────
  console.log("\n── DATABASE SEARCH ─────────────────────────────────────────────────────────");
  const allReceived = await db.invoice.findMany({
    where: { status: "RECEIVED" },
    include: { vendor: true, supplier: true, lineItems: true },
    orderBy: { createdAt: "desc" },
  });

  console.log(`Total RECEIVED invoices: ${allReceived.length}`);

  const matching = allReceived.filter((inv) =>
    inv.lineItems.some((item) => {
      if (!item.sku) return false;
      const upper = item.sku.toUpperCase();
      if (HARELINE_SKU_EXACT.includes(upper)) return true;
      return HARELINE_SKU_PREFIXES.some((p) => upper.startsWith(p));
    })
  );

  if (matching.length === 0) {
    console.log("\nNo RECEIVED invoices found with Hareline-type SKUs.");
    for (const inv of allReceived) {
      const name = inv.vendor?.name ?? inv.supplier?.name ?? "—";
      console.log(`  #${inv.invoiceNumber} — ${name} — ${inv.lineItems.length} items`);
    }
    return;
  }

  console.log(`Matching invoices: ${matching.length}`);
  for (const inv of matching) {
    const name = inv.vendor?.name ?? inv.supplier?.name ?? "—";
    console.log(`  #${inv.invoiceNumber} — ${name} — ${inv.lineItems.length} line items`);
  }

  // ── Step 3: Raw dump for first 3 SL items ────────────────────────────────
  console.log("\n── RAW LOCATION DUMP (first 3 SL items) ────────────────────────────────────");
  let rawDumpCount = 0;

  for (const invoice of matching) {
    for (const item of invoice.lineItems) {
      if (rawDumpCount >= 3) break;
      if (!item.sku?.toUpperCase().startsWith("SL")) continue;
      if (!item.shopifyInventoryItemId) continue;

      rawDumpCount++;
      console.log(`\n[${rawDumpCount}] SKU: ${item.sku}  |  inventoryItemId: ${item.shopifyInventoryItemId}`);
      console.log(`    DB quantityReceived: ${item.quantityReceived}`);

      try {
        const levels = await getAllLocationsForItem(token, item.shopifyInventoryItemId);
        if (levels.length === 0) {
          console.log("    → No inventory levels found at any location");
        } else {
          for (const lvl of levels) {
            const isPrimary = lvl.locationId === primaryLocation.id;
            const qtyStr = lvl.quantities.map((q) => `${q.name}=${q.quantity}`).join(", ");
            console.log(
              `    ${isPrimary ? "★" : " "} Location: ${lvl.locationId}  "${lvl.locationName}"`
            );
            console.log(`      Quantities: ${qtyStr}`);
          }
        }
      } catch (err) {
        console.log(`    ERROR: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (rawDumpCount >= 3) break;
  }

  if (rawDumpCount === 0) {
    console.log("No SL items with a Shopify link found for raw dump.");
  }

  // ── Step 4: Main table using the correct location ─────────────────────────
  console.log("\n── INVENTORY TABLE (using primary location) ─────────────────────────────────");
  console.log(`Location: ${primaryLocation.id}  "${primaryLocation.name}"\n`);

  const counts = { OK: 0, NEEDS_UPDATE: 0, DOUBLED: 0, NO_LINK: 0, NOT_AT_LOC: 0, OTHER: 0 };

  for (const invoice of matching) {
    const name = invoice.vendor?.name ?? invoice.supplier?.name ?? "—";
    console.log(`\n${"=".repeat(80)}`);
    console.log(`Invoice #${invoice.invoiceNumber}  |  ${name}  |  ${invoice.lineItems.length} items`);
    console.log(`${"=".repeat(80)}`);
    console.log(
      `${col("SKU", 14)} | ${col("Rcvd", 6, "right")} | ${col("Shopify@loc", 11, "right")} | ${col("Diff", 6, "right")} | Status`
    );
    console.log("-".repeat(70));

    for (const item of invoice.lineItems) {
      const sku = col(item.sku ?? "—", 14);
      const received = item.quantityReceived;

      if (!item.shopifyInventoryItemId) {
        counts.NO_LINK++;
        console.log(
          `${sku} | ${col(String(received), 6, "right")} | ${col("no link", 11, "right")} | ${col("—", 6, "right")} | NO SHOPIFY LINK`
        );
        continue;
      }

      let shopifyQty: number | null;
      try {
        shopifyQty = await getInventoryAtLocation(token, item.shopifyInventoryItemId, primaryLocation.id);
      } catch (err) {
        console.log(
          `${sku} | ${col(String(received), 6, "right")} | ${col("ERROR", 11, "right")} | ${col("—", 6, "right")} | ${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }

      if (shopifyQty === null) {
        counts.NOT_AT_LOC++;
        console.log(
          `${sku} | ${col(String(received), 6, "right")} | ${col("—", 11, "right")} | ${col("—", 6, "right")} | NOT AT THIS LOCATION`
        );
        continue;
      }

      const diff = shopifyQty - received;
      let status: string;

      if (received === 0) {
        status = "NOT RECEIVED";
      } else if (diff === 0) {
        status = "NEEDS UPDATE";
        counts.NEEDS_UPDATE++;
      } else if (shopifyQty === received * 2) {
        status = "DOUBLED";
        counts.DOUBLED++;
      } else if (diff > 0) {
        status = "OK";
        counts.OK++;
      } else {
        status = `CHECK (negative diff)`;
        counts.OTHER++;
      }

      console.log(
        `${sku} | ${col(String(received), 6, "right")} | ${col(String(shopifyQty), 11, "right")} | ${col(String(diff), 6, "right")} | ${status}`
      );
    }
  }

  console.log(`\n${"=".repeat(80)}`);
  console.log("SUMMARY");
  console.log(`${"=".repeat(80)}`);
  console.log(`  OK                        ${counts.OK}`);
  console.log(`  NEEDS UPDATE (diff=0)     ${counts.NEEDS_UPDATE}`);
  console.log(`  DOUBLED (current=2×rcvd)  ${counts.DOUBLED}`);
  console.log(`  NOT AT THIS LOCATION      ${counts.NOT_AT_LOC}`);
  console.log(`  NO SHOPIFY LINK           ${counts.NO_LINK}`);
  console.log(`  OTHER / CHECK             ${counts.OTHER}`);
  console.log(
    `\nTo fix DOUBLED items, run: npx tsx scripts/fix-doubled-inventory.ts`
  );
}

main()
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
