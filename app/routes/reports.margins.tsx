import { Link, useSearchParams } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/reports.margins";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";
import { Prisma } from "@prisma/client";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const db = getDb();
  const url = new URL(request.url);

  const vendorId = url.searchParams.get("vendorId") ?? "";
  const productSearch = url.searchParams.get("productSearch") ?? "";
  const marginFilter = url.searchParams.get("marginFilter") ?? "";
  const marginThresholdRaw = url.searchParams.get("marginThreshold") ?? "";
  const marginThreshold = parseFloat(marginThresholdRaw);

  const [vendors, marginSetting] = await Promise.all([
    db.vendor.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.appSetting.findUnique({ where: { key: "marginFloor" } }),
  ]);

  const marginFloor = parseFloat(marginSetting?.value ?? "40");

  const conditions: Prisma.Sql[] = [
    Prisma.sql`li."retailPrice" IS NOT NULL`,
    Prisma.sql`li."unitCost" IS NOT NULL`,
    Prisma.sql`li."retailPrice" > 0`,
  ];

  if (vendorId) {
    conditions.push(Prisma.sql`i."vendorId" = ${parseInt(vendorId)}`);
  }

  if (productSearch) {
    const pattern = `%${productSearch}%`;
    conditions.push(
      Prisma.sql`(li."shopifyProductTitle" ILIKE ${pattern} OR li.description ILIKE ${pattern} OR li.sku ILIKE ${pattern})`
    );
  }

  if (marginFilter === "below" && !isNaN(marginThreshold)) {
    conditions.push(
      Prisma.sql`((li."retailPrice" - li."unitCost") / NULLIF(li."retailPrice", 0)) * 100 < ${marginThreshold}`
    );
  } else if (marginFilter === "above" && !isNaN(marginThreshold)) {
    conditions.push(
      Prisma.sql`((li."retailPrice" - li."unitCost") / NULLIF(li."retailPrice", 0)) * 100 > ${marginThreshold}`
    );
  }

  const where = Prisma.join(conditions, " AND ");

  const items = await db.$queryRaw<{
    id: number;
    invoiceId: number;
    invoiceNumber: string;
    vendorName: string;
    sku: string | null;
    description: string;
    shopifyProductTitle: string | null;
    unitCost: number;
    retailPrice: number;
    margin: number;
    quantityReceived: number;
  }[]>`
    SELECT
      li.id,
      li."invoiceId",
      i."invoiceNumber",
      v.name AS "vendorName",
      li.sku,
      li.description,
      li."shopifyProductTitle",
      li."unitCost"::float,
      li."retailPrice"::float,
      ROUND(((li."retailPrice" - li."unitCost") / NULLIF(li."retailPrice", 0)) * 100, 1)::float AS margin,
      li."quantityReceived"
    FROM "InvoiceLineItem" li
    JOIN "Invoice" i ON i.id = li."invoiceId"
    JOIN "Vendor" v ON v.id = i."vendorId"
    WHERE ${where}
    ORDER BY margin ASC
  `;

  console.log(`[margins] vendorId filter: "${vendorId}", productSearch: "${productSearch}", marginFilter: "${marginFilter}"`);
  console.log(`[margins] vendors in DB: ${vendors.length}, raw line item rows: ${items.length}`);
  const belowFloor = items.filter((r) => r.margin < marginFloor);
  const avgMargin = items.length > 0
    ? items.reduce((s, r) => s + r.margin, 0) / items.length
    : 0;
  const atRiskValue = belowFloor.reduce(
    (s, r) => s + r.retailPrice * Math.max(r.quantityReceived, 1),
    0
  );

  return {
    items,
    vendors,
    marginFloor,
    summary: { avgMargin, belowFloorCount: belowFloor.length, atRiskValue },
    filters: { vendorId, productSearch, marginFilter, marginThreshold: marginThresholdRaw },
  };
}

function fmt$(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

type MarginItem = {
  shopifyProductTitle: string | null;
  description: string;
  sku: string | null;
  vendorName: string;
  unitCost: number;
  retailPrice: number;
  margin: number;
};

function exportCsv(items: MarginItem[]) {
  const headers = ["Product", "SKU", "Vendor", "Cost", "Retail", "Margin%", "Status"];
  const rows = items.map((r) => [
    r.shopifyProductTitle ?? r.description,
    r.sku ?? "",
    r.vendorName,
    r.unitCost.toFixed(2),
    r.retailPrice.toFixed(2),
    r.margin.toFixed(1) + "%",
    r.margin >= 0 ? "OK" : "NEGATIVE",
  ]);
  const csv = [headers, ...rows].map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "margin-report.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export default function MarginsReport({ loaderData }: Route.ComponentProps) {
  const { items, vendors, marginFloor, summary, filters } = loaderData;
  const [, setSearchParams] = useSearchParams();
  const [localVendor, setLocalVendor] = useState(filters.vendorId);
  const [localSearch, setLocalSearch] = useState(filters.productSearch);
  const [localFilter, setLocalFilter] = useState(filters.marginFilter);
  const [localThreshold, setLocalThreshold] = useState(filters.marginThreshold);

  function applyFilters() {
    const p = new URLSearchParams();
    if (localVendor) p.set("vendorId", localVendor);
    if (localSearch) p.set("productSearch", localSearch);
    if (localFilter) p.set("marginFilter", localFilter);
    if (localThreshold) p.set("marginThreshold", localThreshold);
    setSearchParams(p);
  }

  function clearFilters() {
    setLocalVendor("");
    setLocalSearch("");
    setLocalFilter("");
    setLocalThreshold("");
    setSearchParams(new URLSearchParams());
  }

  return (
    <main className="p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link to="/reports" className="text-sm text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300">
            ← Reports
          </Link>
          <span className="text-gray-300 dark:text-gray-600">/</span>
          <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Margin Report</h2>
        </div>
        <button
          onClick={() => exportCsv(items)}
          className="flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Export CSV
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm p-5">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Avg Margin</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">{summary.avgMargin.toFixed(1)}%</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">across {items.length} line items</p>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-rose-200 dark:border-rose-900 shadow-sm p-5">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Below Floor ({marginFloor}%)</p>
          <p className="text-2xl font-bold text-rose-600 dark:text-rose-400">{summary.belowFloorCount}</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">items need attention</p>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-amber-200 dark:border-amber-900 shadow-sm p-5">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">At-Risk Retail Value</p>
          <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">{fmt$(summary.atRiskValue)}</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">below margin floor</p>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm p-4 mb-4 flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Vendor</label>
          <select
            value={localVendor}
            onChange={(e) => setLocalVendor(e.target.value)}
            className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100"
          >
            <option value="">All vendors</option>
            {vendors.map((v) => <option key={v.id} value={String(v.id)}>{v.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Product search</label>
          <input
            type="text"
            placeholder="Title, SKU, or description…"
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applyFilters()}
            className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 w-52"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Margin range</label>
          <div className="flex items-center gap-1">
            <select
              value={localFilter}
              onChange={(e) => setLocalFilter(e.target.value)}
              className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100"
            >
              <option value="">Any</option>
              <option value="below">Below</option>
              <option value="above">Above</option>
            </select>
            {localFilter && (
              <input
                type="number"
                placeholder="%"
                value={localThreshold}
                onChange={(e) => setLocalThreshold(e.target.value)}
                className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 w-20"
              />
            )}
          </div>
        </div>
        <button
          onClick={applyFilters}
          className="text-sm font-medium px-4 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
        >
          Apply
        </button>
        {(filters.vendorId || filters.productSearch || filters.marginFilter) && (
          <button
            onClick={clearFilters}
            className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {/* Table */}
      {items.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm px-6 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
          No line items match — try adjusting your filters.
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Product</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">SKU</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Vendor</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Invoice</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Cost</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Retail</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Margin%</th>
                <th className="text-center px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => {
                const aboveFloor = item.margin >= marginFloor;
                return (
                  <tr
                    key={item.id}
                    className={[
                      i < items.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : "",
                      !aboveFloor ? "bg-rose-50 dark:bg-rose-950/20" : "",
                    ].join(" ")}
                  >
                    <td className="px-5 py-3 text-gray-800 dark:text-gray-100 max-w-xs truncate">
                      {item.shopifyProductTitle ?? item.description}
                    </td>
                    <td className="px-5 py-3 font-mono text-gray-600 dark:text-gray-300 text-xs">
                      {item.sku ?? "—"}
                    </td>
                    <td className="px-5 py-3 text-gray-600 dark:text-gray-300">{item.vendorName}</td>
                    <td className="px-5 py-3">
                      <Link
                        to={`/invoices/${item.invoiceId}`}
                        className="text-indigo-600 dark:text-indigo-400 hover:underline"
                      >
                        {item.invoiceNumber}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-right text-gray-700 dark:text-gray-200">
                      ${item.unitCost.toFixed(2)}
                    </td>
                    <td className="px-5 py-3 text-right text-gray-700 dark:text-gray-200">
                      ${item.retailPrice.toFixed(2)}
                    </td>
                    <td className={`px-5 py-3 text-right font-bold ${aboveFloor ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                      {item.margin.toFixed(1)}%
                    </td>
                    <td className="px-5 py-3 text-center">
                      <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full ${
                        aboveFloor
                          ? "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300"
                          : "bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300"
                      }`}>
                        {aboveFloor ? "OK" : "Below floor"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
