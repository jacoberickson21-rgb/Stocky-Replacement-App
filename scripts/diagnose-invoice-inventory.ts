/**
 * Invoice inventory diagnostic — checks Shopify's actual adjustment history
 * per variant instead of comparing current quantities to a meaningless baseline.
 *
 * Usage:
 *   npx tsx scripts/diagnose-invoice-inventory.ts <invoiceNumber>
 *   npx tsx scripts/diagnose-invoice-inventory.ts 295926
 *
 * Required Shopify scope: read_analytics
 *   If you see ACCESS_DENIED, add read_analytics in the Shopify Partner
 *   dashboard → Apps → <your app> → Configuration → API access scopes,
 *   then reinstall / reauthorize the app so the new token includes it.
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

// ─── Shopify auth ─────────────────────────────────────────────────────────────

async function getAccessToken(): Promise<string> {
  const store = process.env.SHOPIFY_STORE!;
  const res = await fetch(
    `https://${store}.myshopify.com/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.SHOPIFY_CLIENT_ID!,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET!,
        grant_type: "client_credentials",
      }),
    }
  );
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("Failed to get Shopify access token");
  return data.access_token;
}

// ─── GraphQL helper ───────────────────────────────────────────────────────────

class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessDeniedError";
  }
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
    errors?: { message: string; extensions?: { code?: string } }[];
  };
  if (result.errors?.length) {
    const msg = result.errors.map((e) => e.message).join("; ");
    const code = result.errors[0]?.extensions?.code ?? "";
    if (code === "ACCESS_DENIED" || msg.toLowerCase().includes("access denied")) {
      throw new AccessDeniedError(msg);
    }
    throw new Error(msg);
  }
  if (!result.data) throw new Error("Empty GraphQL response from Shopify");
  return result.data;
}

// ─── Location ─────────────────────────────────────────────────────────────────

async function getPrimaryLocation(
  token: string
): Promise<{ id: string; name: string }> {
  const data = await shopifyGraphQL<{
    locations: { edges: { node: { id: string; name: string } }[] };
  }>(token, `query { locations(first: 1) { edges { node { id name } } } }`);
  const edge = data.locations.edges[0];
  if (!edge) throw new Error("No Shopify locations found");
  return edge.node;
}

// ─── ShopifyQL adjustment history ─────────────────────────────────────────────

type AdjustmentRow = {
  happened_at: string;
  delta: number;
  reference_document_type: string;
  location_name: string;
};

async function queryAdjustmentHistory(
  token: string,
  sku: string,
  sinceDate: string
): Promise<AdjustmentRow[]> {
  // Single-quote escaping for ShopifyQL string literals
  const safeSku = sku.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

  const shopifyql = `
    FROM inventory_adjustment_history
    SHOW inventory_adjustment_change, happened_at, reference_document_type, location_name
    WHERE product_variant_sku = '${safeSku}'
    SINCE ${sinceDate}
    UNTIL today
    ORDER BY happened_at ASC
  `;

  const data = await shopifyGraphQL<{
    shopifyqlQuery: {
      // Only present when response is a TableResponse
      tableData?: {
        rowData: string[][];
        columns: { name: string }[];
      };
    } | null;
  }>(
    token,
    `query InvAdjHistory($q: String!) {
      shopifyqlQuery(query: $q) {
        ... on TableResponse {
          tableData {
            rowData
            columns { name }
          }
        }
      }
    }`,
    { q: shopifyql }
  );

  const tableData = data.shopifyqlQuery?.tableData;
  if (!tableData || tableData.rowData.length === 0) return [];

  const colIdx = Object.fromEntries(
    tableData.columns.map((c, i) => [c.name, i])
  );

  return tableData.rowData.map((row) => ({
    happened_at: row[colIdx["happened_at"]] ?? "",
    delta: Number(row[colIdx["inventory_adjustment_change"]] ?? 0),
    reference_document_type: row[colIdx["reference_document_type"]] ?? "",
    location_name: row[colIdx["location_name"]] ?? "",
  }));
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function col(
  val: string,
  width: number,
  align: "left" | "right" = "left"
): string {
  const s = String(val).slice(0, width);
  return align === "right" ? s.padStart(width) : s.padEnd(width);
}

function toYMD(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fmtTs(iso: string): string {
  // "2026-06-04T18:23:01.000Z" → "2026-06-04 18:23:01 UTC"
  return iso.replace("T", " ").slice(0, 19) + " UTC";
}

function signedDelta(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const invoiceNumber = process.argv[2];
  if (!invoiceNumber) {
    console.error(
      "Usage: npx tsx scripts/diagnose-invoice-inventory.ts <invoiceNumber>"
    );
    process.exit(1);
  }

  console.log("=".repeat(80));
  console.log(`INVOICE INVENTORY DIAGNOSTIC  —  #${invoiceNumber}`);
  console.log("=".repeat(80));
  console.log("Uses Shopify's inventory_adjustment_history via shopifyqlQuery.");
  console.log("Required scope: read_analytics\n");

  // ── Load invoice ──────────────────────────────────────────────────────────
  const invoice = await db.invoice.findFirst({
    where: { invoiceNumber },
    include: { vendor: true, supplier: true, lineItems: true },
  });
  if (!invoice) {
    console.error(`Invoice "${invoiceNumber}" not found in database.`);
    process.exit(1);
  }

  const vendorName =
    invoice.vendor?.name ?? invoice.supplier?.name ?? "—";

  // Use updatedAt as the receiving timestamp — this is when the DB record
  // transitioned to RECEIVED and the Shopify adjustment was triggered.
  const receivingTs = invoice.updatedAt;
  // Look 2 days back in case of timezone skew or clock differences
  const sinceDate = toYMD(
    new Date(receivingTs.getTime() - 2 * 24 * 60 * 60 * 1000)
  );
  const receivingDateStr = toYMD(receivingTs);

  console.log(`Invoice ID   : ${invoice.id}`);
  console.log(`Invoice #    : ${invoice.invoiceNumber}`);
  console.log(`Vendor       : ${vendorName}`);
  console.log(`Status       : ${invoice.status}`);
  console.log(`Received at  : ${fmtTs(receivingTs.toISOString())}`);
  console.log(`Line items   : ${invoice.lineItems.length}`);
  console.log(`\nQuery window : SINCE ${sinceDate} UNTIL today`);
  console.log(
    `(Adjustments on/after ${receivingDateStr} are treated as part of this receive.)\n`
  );

  // ── Shopify auth + location ───────────────────────────────────────────────
  const token = await getAccessToken();
  const location = await getPrimaryLocation(token);
  console.log(`Shopify location: ${location.id}  "${location.name}"\n`);

  // ─── Per-item query ───────────────────────────────────────────────────────

  type Status =
    | "OK"
    | "MISSING"
    | "PARTIAL"
    | "EXCESS"
    | "NO_SKU"
    | "NO_LINK"
    | "SCOPE_ERROR"
    | "ERROR";

  type ItemResult = {
    id: number;
    sku: string | null;
    quantityReceived: number | null;
    inventorySynced: boolean;
    shopifyInventoryItemId: string | null;
    adjustments: AdjustmentRow[];
    appliedDelta: number;   // sum of positive adjustments on/after receiving date
    status: Status;
    errorMsg?: string;
  };

  const results: ItemResult[] = [];
  let scopeErrorSeen = false;

  console.log("── ADJUSTMENT HISTORY PER LINE ITEM ────────────────────────────────────────");

  for (const item of invoice.lineItems) {
    const rcvd = item.quantityReceived ?? 0;
    let adjustments: AdjustmentRow[] = [];
    let appliedDelta = 0;
    let status: Status = "OK";
    let errorMsg: string | undefined;

    if (!item.sku) {
      status = "NO_SKU";
    } else if (!item.shopifyInventoryItemId) {
      status = "NO_LINK";
    } else {
      process.stdout.write(`  Querying ${item.sku}... `);
      try {
        adjustments = await queryAdjustmentHistory(token, item.sku, sinceDate);

        // Positive adjustments on or after the receiving date are the ones
        // we would have applied via inventoryAdjustQuantities(reason:"received").
        // Negative adjustments (sales, damages) in the window are also shown
        // but are not counted toward the receive delta.
        const receiveAdjs = adjustments.filter(
          (a) =>
            a.delta > 0 &&
            a.happened_at.slice(0, 10) >= receivingDateStr
        );
        appliedDelta = receiveAdjs.reduce((sum, a) => sum + a.delta, 0);

        if (receiveAdjs.length === 0) {
          status = "MISSING";
        } else if (appliedDelta === rcvd) {
          status = "OK";
        } else if (appliedDelta < rcvd) {
          status = "PARTIAL";
        } else {
          status = "EXCESS";
        }

        console.log(
          `${adjustments.length} adjustment(s) found — ${status}`
        );
      } catch (err) {
        if (err instanceof AccessDeniedError) {
          status = "SCOPE_ERROR";
          errorMsg = err.message;
          if (!scopeErrorSeen) {
            scopeErrorSeen = true;
            console.log(); // newline after "Querying..."
            console.error(
              "╔══════════════════════════════════════════════════════════════════════════════╗"
            );
            console.error(
              "║  ACCESS DENIED — Shopify app is missing the read_analytics scope.          ║"
            );
            console.error(
              "║  Go to: Shopify Partner dashboard → Apps → <app> → Configuration          ║"
            );
            console.error(
              "║  Add read_analytics to API access scopes, then reinstall the app.          ║"
            );
            console.error(
              "╚══════════════════════════════════════════════════════════════════════════════╝\n"
            );
          }
        } else {
          status = "ERROR";
          errorMsg = err instanceof Error ? err.message : String(err);
          console.log(`ERROR: ${errorMsg}`);
        }
      }
    }

    results.push({
      id: item.id,
      sku: item.sku,
      quantityReceived: item.quantityReceived,
      inventorySynced: item.inventorySynced,
      shopifyInventoryItemId: item.shopifyInventoryItemId,
      adjustments,
      appliedDelta,
      status,
      errorMsg,
    });
  }

  // ─── Detailed per-item report ─────────────────────────────────────────────

  console.log(
    "\n── DETAIL REPORT ───────────────────────────────────────────────────────────"
  );

  for (const r of results) {
    const rcvd = r.quantityReceived ?? 0;
    const syncedLabel = r.inventorySynced ? "synced=YES" : "synced=NO ";
    const skuLabel = col(r.sku ?? "(no sku)", 20);

    const statusLabel: Record<Status, string> = {
      OK: "✓ OK — adjustment found, qty matches",
      MISSING: "✗ MISSING — NO inventory adjustment found in Shopify",
      PARTIAL: "⚠ PARTIAL — less was applied in Shopify than received",
      EXCESS: "⚠ EXCESS — more was applied in Shopify than received",
      NO_SKU: "– NO SKU — cannot query adjustment history",
      NO_LINK: "– NOT LINKED to a Shopify variant",
      SCOPE_ERROR: "✗ SCOPE ERROR — read_analytics not granted",
      ERROR: `✗ ERROR — ${r.errorMsg ?? "unknown"}`,
    };

    console.log(`\n  ${skuLabel}  rcvd=${rcvd}  ${syncedLabel}`);
    console.log(`  Status: ${statusLabel[r.status]}`);

    if (r.status === "MISSING" || r.status === "PARTIAL" || r.status === "EXCESS") {
      const stillNeeded = rcvd - r.appliedDelta;
      console.log(
        `  Applied in Shopify: +${r.appliedDelta}  Still missing: +${Math.max(0, stillNeeded)}`
      );
      if (r.inventorySynced && r.status === "MISSING") {
        console.log(
          `  *** inventorySynced=true but NO adjustment found — this is the idempotency collision bug ***`
        );
        console.log(
          `  *** The DB was marked synced but Shopify treated it as a duplicate and applied nothing ***`
        );
      }
    }

    if (r.adjustments.length > 0) {
      console.log(`  All adjustments since ${sinceDate}:`);
      for (const adj of r.adjustments) {
        const isReceive =
          adj.delta > 0 && adj.happened_at.slice(0, 10) >= receivingDateStr;
        const marker = isReceive ? " ← receive" : "";
        console.log(
          `    ${fmtTs(adj.happened_at)}  delta=${signedDelta(adj.delta).padStart(5)}  type=${col(adj.reference_document_type, 16)}  loc=${adj.location_name}${marker}`
        );
      }
    } else if (r.status !== "NO_SKU" && r.status !== "NO_LINK" && r.status !== "SCOPE_ERROR" && r.status !== "ERROR") {
      console.log(`  No Shopify adjustments found at all since ${sinceDate}.`);
    }
  }

  // ─── Idempotency key listing ──────────────────────────────────────────────

  console.log(
    "\n── IDEMPOTENCY KEYS (format: adjust-{lineItemId}-{inventoryItemId}-{locationId}) ──"
  );
  console.log(`Location: ${location.id}  "${location.name}"\n`);

  const linked = results.filter((r) => r.shopifyInventoryItemId);
  if (linked.length === 0) {
    console.log("  No linked items.");
  } else {
    for (const r of linked) {
      const key = `adjust-${r.id}-${r.shopifyInventoryItemId}-${location.id}`;
      const flag =
        r.status === "MISSING"
          ? "  ← MISSING (key may have collided with earlier item)"
          : r.status === "OK"
          ? "  ✓"
          : "";
      console.log(`  ${col(r.sku ?? "—", 20)}  ${key}${flag}`);
    }
  }

  // ─── Shared inventoryItemId collision groups ──────────────────────────────

  console.log(
    "\n── SHARED inventoryItemId GROUPS ───────────────────────────────────────────"
  );

  const byItemId = new Map<string, ItemResult[]>();
  for (const r of results) {
    if (!r.shopifyInventoryItemId) continue;
    const existing = byItemId.get(r.shopifyInventoryItemId) ?? [];
    existing.push(r);
    byItemId.set(r.shopifyInventoryItemId, existing);
  }
  const collisions = Array.from(byItemId.entries()).filter(
    ([, items]) => items.length > 1
  );

  if (collisions.length === 0) {
    console.log(
      "  No line items share an inventoryItemId — variant linkage looks correct."
    );
  } else {
    console.log(
      `\n  *** ${collisions.length} COLLISION GROUP(S): multiple SKUs mapped to the same Shopify variant ***`
    );
    console.log(
      `  *** This is the root cause: lookupProduct() always returned variants[0] ***`
    );
    console.log(
      `  *** Fix applied this session: lookupProduct() now finds the exact variant ***\n`
    );

    for (const [itemId, items] of collisions) {
      console.log(`  inventoryItemId: ${itemId}`);
      console.log(
        `  ${items.length} line items incorrectly share this one Shopify variant:`
      );
      for (const r of items) {
        const rcvd = r.quantityReceived ?? 0;
        console.log(
          `    • lineItem #${r.id}  SKU: ${col(r.sku ?? "—", 20)}  rcvd=${rcvd}  synced=${r.inventorySynced ? "YES" : "NO "}  history=${r.status}`
        );
      }

      const totalExpected = items.reduce(
        (s, r) => s + (r.quantityReceived ?? 0),
        0
      );
      const totalApplied = items.reduce((s, r) => s + r.appliedDelta, 0);
      const shortfall = totalExpected - totalApplied;

      console.log(
        `\n  Expected total applied: +${totalExpected}  Actually applied: +${totalApplied}  Shortfall: +${Math.max(0, shortfall)}`
      );
      if (shortfall > 0) {
        console.log(
          `  *** +${shortfall} units were NEVER applied to Shopify for this variant ***`
        );
      }
      console.log();
    }
  }

  // ─── Summary ─────────────────────────────────────────────────────────────

  console.log(
    "── SUMMARY ─────────────────────────────────────────────────────────────────"
  );

  const counts = {
    OK: results.filter((r) => r.status === "OK").length,
    MISSING: results.filter((r) => r.status === "MISSING").length,
    PARTIAL: results.filter((r) => r.status === "PARTIAL").length,
    EXCESS: results.filter((r) => r.status === "EXCESS").length,
    NO_LINK: results.filter((r) => r.status === "NO_LINK").length,
    NO_SKU: results.filter((r) => r.status === "NO_SKU").length,
    ERROR: results.filter(
      (r) => r.status === "ERROR" || r.status === "SCOPE_ERROR"
    ).length,
  };

  console.log(`  Total line items              : ${results.length}`);
  console.log(`  ✓ OK (adjustment confirmed)   : ${counts.OK}`);
  console.log(`  ✗ MISSING (never applied)     : ${counts.MISSING}`);
  console.log(`  ⚠ PARTIAL (under-applied)     : ${counts.PARTIAL}`);
  console.log(`  ⚠ EXCESS (over-applied)       : ${counts.EXCESS}`);
  console.log(`  – Not linked to Shopify       : ${counts.NO_LINK}`);
  console.log(`  – No SKU (can't query)        : ${counts.NO_SKU}`);
  console.log(`  ✗ Query errors                : ${counts.ERROR}`);
  console.log(
    `  Collision groups              : ${collisions.length} (${collisions.reduce((s, [, i]) => s + i.length, 0)} items)`
  );

  const needFix = results.filter(
    (r) => r.status === "MISSING" || r.status === "PARTIAL"
  );
  if (needFix.length > 0) {
    console.log(
      `\n  ITEMS REQUIRING MANUAL SHOPIFY INVENTORY CORRECTION:`
    );
    for (const r of needFix) {
      const rcvd = r.quantityReceived ?? 0;
      const needed = rcvd - r.appliedDelta;
      console.log(
        `    SKU: ${col(r.sku ?? "—", 20)}  rcvd=${rcvd}  applied=+${r.appliedDelta}  need_to_add=+${Math.max(0, needed)}`
      );
      console.log(
        `    inventoryItemId: ${r.shopifyInventoryItemId}`
      );
    }
    console.log(
      `\n  To correct: go to Shopify Admin → Products → (product) → Inventory`
    );
    console.log(
      `  and manually add the missing units listed above for each SKU.`
    );
  }

  if (scopeErrorSeen) {
    console.log(
      `\n  NOTE: Some items could not be queried due to missing read_analytics scope.`
    );
    console.log(
      `  Add the scope and re-run to see complete results.`
    );
  }

  console.log();
}

main()
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
