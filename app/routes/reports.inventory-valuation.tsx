import { Link, useSearchParams } from "react-router";
import { useState, useEffect } from "react";
import type { Route } from "./+types/reports.inventory-valuation";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";
import { getSyncStatus } from "../services/sync.server";

const PAGE_SIZE = 50;

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const db = getDb();
  const url = new URL(request.url);

  const vendorFilter = url.searchParams.get("vendor") ?? "";
  const productTypeFilter = url.searchParams.get("productType") ?? "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1"));

  const [lastSync, vendors] = await Promise.all([
    getSyncStatus(),
    db.vendor.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);

  // Build where clause
  const where: Record<string, unknown> = {};
  if (vendorFilter) where.vendor = { equals: vendorFilter, mode: "insensitive" };
  if (productTypeFilter) where.productType = { equals: productTypeFilter, mode: "insensitive" };

  // Distinct vendors and product types from cache for filter dropdowns
  const [distinctVendors, distinctTypes, totalCount, pageRows] = await Promise.all([
    db.productCache.findMany({ distinct: ["vendor"], where: { vendor: { not: null } }, select: { vendor: true }, orderBy: { vendor: "asc" } }),
    db.productCache.findMany({ distinct: ["productType"], where: { productType: { not: null } }, select: { productType: true }, orderBy: { productType: "asc" } }),
    db.productCache.count({ where }),
    db.productCache.findMany({
      where,
      orderBy: [{ title: "asc" }, { variantTitle: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  // Summary aggregates across ALL filtered rows (not just this page)
  const allForSummary = await db.productCache.findMany({
    where,
    select: { variantId: true, title: true, variantTitle: true, vendor: true, productType: true, sku: true, price: true, cost: true, currentInventory: true },
  });

  let totalCostValue = 0;
  let totalRetailValue = 0;
  let marginsSum = 0;
  let withCostCount = 0;
  const costErrors: Array<{ variantId: string; productTitle: string; vendor: string; sku: string; cost: number; price: number }> = [];

  for (const r of allForSummary) {
    const price = Number(r.price);
    const cost = r.cost != null ? Number(r.cost) : null;
    const qty = r.currentInventory;
    if (qty > 0) {
      totalRetailValue += price * qty;
      if (cost != null) {
        totalCostValue += cost * qty;
      }
    }
    if (cost != null && price > 0) {
      if (cost > price) {
        costErrors.push({
          variantId: r.variantId,
          productTitle: r.title + (r.variantTitle && r.variantTitle !== "Default Title" ? ` — ${r.variantTitle}` : ""),
          vendor: r.vendor ?? "",
          sku: r.sku ?? "",
          cost,
          price,
        });
      } else {
        marginsSum += ((price - cost) / price) * 100;
        withCostCount++;
      }
    }
  }
  const avgMargin = withCostCount > 0 ? marginsSum / withCostCount : 0;

  const rows = pageRows.map((v) => {
    const price = Number(v.price);
    const cost = v.cost != null ? Number(v.cost) : null;
    const costValue = cost != null ? cost * v.currentInventory : null;
    const retailValue = price * v.currentInventory;
    const margin = cost != null && price > 0 ? ((price - cost) / price) * 100 : null;
    return {
      variantId: v.variantId,
      productTitle: v.title + (v.variantTitle && v.variantTitle !== "Default Title" ? ` — ${v.variantTitle}` : ""),
      vendor: v.vendor ?? "",
      productType: v.productType ?? "",
      sku: v.sku ?? "",
      qty: v.currentInventory,
      cost,
      price,
      costValue,
      retailValue,
      margin,
    };
  });

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return {
    rows,
    vendors,
    distinctVendors: distinctVendors.map((r) => r.vendor!).filter(Boolean),
    distinctTypes: distinctTypes.map((r) => r.productType!).filter(Boolean),
    summary: { totalCostValue, totalRetailValue, avgMargin, costErrorCount: costErrors.length },
    costErrors,
    filters: { vendor: vendorFilter, productType: productTypeFilter },
    pagination: { page, totalPages, totalCount },
    lastSyncTime: lastSync?.completedAt ?? null,
    hasCachedData: totalCount > 0 || (vendorFilter === "" && productTypeFilter === ""),
    noSync: !lastSync,
  };
}

function fmt$(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function ClientOnly({ children }: { children: () => React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return <>{children()}</>;
}

type InvRow = {
  productTitle: string; sku: string; vendor: string; productType: string;
  qty: number; cost: number | null; price: number; costValue: number | null; retailValue: number; margin: number | null;
};

function exportCsv(rows: InvRow[]) {
  const headers = ["Product", "SKU", "Vendor", "Product Type", "Qty", "Cost", "Retail", "Cost Value", "Retail Value", "Margin%"];
  const csvData = rows.map((r) => [r.productTitle, r.sku, r.vendor, r.productType, r.qty, r.cost?.toFixed(2) ?? "", r.price.toFixed(2), r.costValue?.toFixed(2) ?? "", r.retailValue.toFixed(2), r.margin?.toFixed(1) ?? ""]);
  const csv = [headers, ...csvData].map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "inventory-valuation.csv"; a.click();
  URL.revokeObjectURL(url);
}

function Pagination({ page, totalPages, buildUrl }: { page: number; totalPages: number; buildUrl: (p: number) => string }) {
  if (totalPages <= 1) return null;
  const btnBase = "text-sm font-medium px-3 py-1.5 rounded-lg border transition-colors";
  const btnOn = "border-gray-200 dark:border-gray-700 text-indigo-600 dark:text-indigo-400 hover:bg-gray-50 dark:hover:bg-gray-800";
  const btnOff = "border-gray-100 dark:border-gray-800 text-gray-300 dark:text-gray-600 pointer-events-none select-none";
  return (
    <div className="flex items-center justify-between mt-4">
      <Link to={page > 1 ? buildUrl(page - 1) : "#"} aria-disabled={page <= 1} className={`${btnBase} ${page > 1 ? btnOn : btnOff}`}>← Previous</Link>
      <span className="text-sm text-gray-500 dark:text-gray-400">Page {page} of {totalPages}</span>
      <Link to={page < totalPages ? buildUrl(page + 1) : "#"} aria-disabled={page >= totalPages} className={`${btnBase} ${page < totalPages ? btnOn : btnOff}`}>Next →</Link>
    </div>
  );
}

export default function InventoryValuationPage({ loaderData }: Route.ComponentProps) {
  const { rows, vendors, distinctVendors, distinctTypes, summary, filters, pagination, lastSyncTime, noSync, costErrors } = loaderData;
  const [, setSearchParams] = useSearchParams();
  const [localVendor, setLocalVendor] = useState(filters.vendor);
  const [localType, setLocalType] = useState(filters.productType);

  function applyFilters() {
    const p = new URLSearchParams();
    if (localVendor) p.set("vendor", localVendor);
    if (localType) p.set("productType", localType);
    setSearchParams(p);
  }

  function clearFilters() {
    setLocalVendor(""); setLocalType("");
    setSearchParams(new URLSearchParams());
  }

  function buildPageUrl(p: number) {
    const params = new URLSearchParams();
    if (filters.vendor) params.set("vendor", filters.vendor);
    if (filters.productType) params.set("productType", filters.productType);
    params.set("page", String(p));
    return `?${params.toString()}`;
  }

  return (
    <main className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link to="/reports" className="text-sm text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300">← Reports</Link>
          <span className="text-gray-300 dark:text-gray-600">/</span>
          <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Inventory Valuation</h2>
          {lastSyncTime && (
            <span className="text-xs text-gray-400 dark:text-gray-500">
              Data as of {new Date(lastSyncTime).toLocaleString()}
            </span>
          )}
        </div>
        <ClientOnly>
          {() => (
            <button onClick={() => exportCsv(rows)}
              className="flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-colors">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export CSV
            </button>
          )}
        </ClientOnly>
      </div>

      {noSync && (
        <div className="mb-6 p-4 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 text-sm text-amber-800 dark:text-amber-300">
          No data synced yet. Click <strong>Sync Data</strong> in the navigation bar to fetch product data from Shopify.
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-emerald-200 dark:border-emerald-900 shadow-sm p-5">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Total Cost Value</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">{fmt$(summary.totalCostValue)}</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">at Shopify cost</p>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-indigo-200 dark:border-indigo-900 shadow-sm p-5">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Total Retail Value</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">{fmt$(summary.totalRetailValue)}</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">at current prices</p>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-amber-200 dark:border-amber-900 shadow-sm p-5">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Avg Potential Margin</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">{summary.avgMargin.toFixed(1)}%</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
            on items with known cost
            {summary.costErrorCount > 0 && (
              <span className="text-amber-500 dark:text-amber-400"> · excluding {summary.costErrorCount} with cost &gt; price</span>
            )}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm p-4 mb-4 flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Vendor</label>
          <select value={localVendor} onChange={(e) => setLocalVendor(e.target.value)}
            className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100">
            <option value="">All vendors</option>
            {distinctVendors.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Product Type</label>
          <select value={localType} onChange={(e) => setLocalType(e.target.value)}
            className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100">
            <option value="">All types</option>
            {distinctTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <button onClick={applyFilters} className="text-sm font-medium px-4 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors">Apply</button>
        {(filters.vendor || filters.productType) && (
          <button onClick={clearFilters} className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors">Clear</button>
        )}
      </div>

      {/* Table */}
      {rows.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm px-6 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
          {noSync ? "Run Sync to populate data." : "No products found."}
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden">
          <div className="px-5 py-3 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
            {pagination.totalCount} variants · Page {pagination.page} of {pagination.totalPages}
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Product</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">SKU</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Qty</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Cost</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Retail</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Cost Value</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Retail Value</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Margin%</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.variantId} className={i < rows.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : ""}>
                  <td className="px-5 py-3 text-gray-800 dark:text-gray-100 max-w-xs truncate">{row.productTitle}</td>
                  <td className="px-5 py-3 font-mono text-gray-600 dark:text-gray-300 text-xs">{row.sku || "—"}</td>
                  <td className="px-5 py-3 text-right text-gray-700 dark:text-gray-200">{row.qty}</td>
                  <td className="px-5 py-3 text-right text-gray-600 dark:text-gray-300">
                    {row.cost != null ? `$${row.cost.toFixed(2)}` : <span className="text-gray-400 dark:text-gray-500">—</span>}
                  </td>
                  <td className="px-5 py-3 text-right text-gray-600 dark:text-gray-300">${row.price.toFixed(2)}</td>
                  <td className="px-5 py-3 text-right text-gray-700 dark:text-gray-200">
                    {row.costValue != null ? fmt$(row.costValue) : <span className="text-gray-400 dark:text-gray-500">—</span>}
                  </td>
                  <td className="px-5 py-3 text-right text-gray-700 dark:text-gray-200">{fmt$(row.retailValue)}</td>
                  <td className={`px-5 py-3 text-right font-medium ${
                    row.margin == null ? "text-gray-400 dark:text-gray-500" :
                    row.margin >= 40 ? "text-emerald-600 dark:text-emerald-400" :
                    "text-rose-600 dark:text-rose-400"
                  }`}>
                    {row.margin != null ? `${row.margin.toFixed(1)}%` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={pagination.page} totalPages={pagination.totalPages} buildUrl={buildPageUrl} />

      {costErrors.length > 0 && (
        <div className="mt-10">
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">Data Quality Issues</h3>
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">{costErrors.length} items</span>
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">These variants have cost greater than retail price — likely data entry errors in Shopify. Fix them in Shopify to improve report accuracy.</p>
          <div className="bg-white dark:bg-gray-900 rounded-2xl border border-amber-200 dark:border-amber-800 shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-800">
                  <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Product</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">SKU</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Vendor</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Cost</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Price</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Overage</th>
                </tr>
              </thead>
              <tbody>
                {costErrors.map((err, i) => (
                  <tr key={err.variantId} className={i < costErrors.length - 1 ? "border-b border-amber-100 dark:border-amber-900/40" : ""}>
                    <td className="px-5 py-3 text-gray-800 dark:text-gray-100 max-w-xs truncate">{err.productTitle}</td>
                    <td className="px-5 py-3 font-mono text-gray-600 dark:text-gray-300 text-xs">{err.sku || "—"}</td>
                    <td className="px-5 py-3 text-gray-600 dark:text-gray-300">{err.vendor || "—"}</td>
                    <td className="px-5 py-3 text-right text-rose-600 dark:text-rose-400 font-medium">${err.cost.toFixed(2)}</td>
                    <td className="px-5 py-3 text-right text-gray-700 dark:text-gray-200">${err.price.toFixed(2)}</td>
                    <td className="px-5 py-3 text-right text-rose-600 dark:text-rose-400 font-medium">+${(err.cost - err.price).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </main>
  );
}
