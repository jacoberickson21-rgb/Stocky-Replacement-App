import type { Route } from "./+types/stocktakes.$id.export-csv";
import { requireUserId } from "../session.server";
import { getStocktakeReport, itemStatusLabels } from "../services/stocktake-report.server";

// The rollback record: every item in the stocktake, not just variances. To
// reverse an applied item, set its on_hand back to "Live at review (on hand)".
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
  const report = await getStocktakeReport(Number(params.id));
  if (!report) throw new Response("Not Found", { status: 404 });

  const headers = [
    "SKU",
    "Product",
    "Variant",
    "Barcode",
    "Expected on hand (start)",
    "Counted",
    "Live on hand at review",
    "Target qty",
    "Variance units",
    "Variance value",
    "Applied",
    "Applied at",
    "Status",
    "Error / exclusion / notes",
    "Unit cost",
    "Outside scope",
    "Variant ID",
    "Inventory item ID",
    "Location ID",
  ];

  const rows = report.items.map((i) => [
    text(i.sku),
    text(i.title),
    text(i.variantTitle),
    text(i.barcode),
    i.expected,
    i.counted ?? "",
    i.liveAtReview ?? "",
    i.target ?? "",
    i.variance ?? "",
    i.varianceValue != null ? i.varianceValue.toFixed(2) : "",
    i.applied ? "Yes" : "No",
    i.appliedAt ?? "",
    itemStatusLabels[i.status],
    text(i.notes.join(" | ")),
    i.cost != null ? i.cost.toFixed(2) : "",
    i.outsideScope ? "Yes" : "No",
    i.variantId,
    i.inventoryItemId,
    report.stocktake.locationId,
  ]);

  const csv =
    "﻿" + // lets Excel open it as UTF-8
    [headers, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") +
    "\r\n";

  const slug = report.stocktake.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "stocktake";
  const date = (report.stocktake.completedAt ?? report.stocktake.startedAt).slice(0, 10);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="stocktake-${report.stocktake.id}-${slug}-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

// Text cells that a spreadsheet would read as a formula get a leading apostrophe.
function text(v: string | null): string {
  if (!v) return "";
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

function cell(v: string | number): string {
  return `"${String(v).replace(/"/g, '""')}"`;
}
