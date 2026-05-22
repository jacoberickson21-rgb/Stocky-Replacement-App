import { Link, useSearchParams } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/reports.margins";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";
import { getSyncStatus } from "../services/sync.server";

const PAGE_SIZE = 50;

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const db = getDb();
  const url = new URL(request.url);

  const vendor = url.searchParams.get("vendor") ?? "";
  const productType = url.searchParams.get("productType") ?? "";
  const marginFilter = url.searchParams.get("marginFilter") ?? "";
  const marginThresholdRaw = url.searchParams.get("marginThreshold") ?? "";
  const marginThreshold = parseFloat(marginThresholdRaw);
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1"));

  const [marginSetting, lastSync] = await Promise.all([
    db.appSetting.findUnique({ where: { key: "marginFloor" } }),
    getSyncStatus(),
  ]);
  const marginFloor = parseFloat(marginSetting?.value ?? "40");

  // Fetch all variants with cost from cache for computing dropdowns + summary
  const allWithCost = await db.productCache.findMany({
    where: { cost: { not: null, gt: 0 }, price: { gt: 0 } },
    select: { variantId: true, title: true, variantTitle: true, vendor: true, productType: true, sku: true, cost: true, price: true, currentInventory: true },
  });

  const uniqueVendors = [...new Set(allWithCost.map((v) => v.vendor).filter((x): x is string => !!x))].sort();
  const uniqueProductTypes = [...new Set(allWithCost.map((v) => v.productType).filter((x): x is string => !!x))].sort();

  // Apply filters
  const filtered = allWithCost.filter((v) => {
    if (vendor && (v.vendor ?? "").toLowerCase() !== vendor.toLowerCase()) return false;
    if (productType && (v.productType ?? "").toLowerCase() !== productType.toLowerCase()) return false;
    return true;
  });

  const allItems = filtered.map((v) => {
    const cost = Number(v.cost!);
    const price = Number(v.price);
    const margin = Math.round(((price - cost) / price) * 1000) / 10;
    return {
      variantId: v.variantId,
      productTitle: v.title + (v.variantTitle && v.variantTitle !== "Default Title" ? ` — ${v.variantTitle}` : ""),
      vendor: v.vendor ?? "",
      productType: v.productType ?? "",
      sku: v.sku ?? "",
      unitCost: cost,
      retailPrice: price,
      margin,
      inventoryQuantity: v.currentInventory,
    };
  });

  const marginFiltered = allItems
    .filter((r) => {
      if (marginFilter === "below" && !isNaN(marginThreshold)) return r.margin < marginThreshold;
      if (marginFilter === "above" && !isNaN(marginThreshold)) return r.margin > marginThreshold;
      return true;
    })
    .sort((a, b) => a.margin - b.margin);

  const belowFloor = marginFiltered.filter((r) => r.margin < marginFloor);
  const avgMargin = marginFiltered.length > 0 ? marginFiltered.reduce((s, r) => s + r.margin, 0) / marginFiltered.length : 0;
  const atRiskValue = belowFloor.reduce((s, r) => s + r.retailPrice * Math.max(r.inventoryQuantity, 1), 0);

  const totalCount = marginFiltered.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const items = marginFiltered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return {
    items,
    uniqueVendors,
    uniqueProductTypes,
    marginFloor,
    summary: { avgMargin, belowFloorCount: belowFloor.length, atRiskValue },
    filters: { vendor, productType, marginFilter, marginThreshold: marginThresholdRaw },
    pagination: { page, totalPages, totalCount },
    lastSyncTime: lastSync?.completedAt ?? null,
    noSync: !lastSync,
  };
}

function fmt$(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

type MarginItem = { productTitle: string; sku: string; vendor: string; productType: string; unitCost: number; retailPrice: number; margin: number; inventoryQuantity: number };

function exportCsv(items: MarginItem[]) {
  const headers = ["Product", "SKU", "Vendor", "Product Type", "Qty", "Cost", "Retail", "Margin%", "Status"];
  const rows = items.map((r) => [r.productTitle, r.sku ?? "", r.vendor, r.productType, r.inventoryQuantity, r.unitCost.toFixed(2), r.retailPrice.toFixed(2), r.margin.toFixed(1) + "%", r.margin >= 0 ? "OK" : "NEGATIVE"]);
  const csv = [headers, ...rows].map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "margin-report.csv"; a.click();
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

export default function MarginsReport({ loaderData }: Route.ComponentProps) {
  const { items, uniqueVendors, uniqueProductTypes, marginFloor, summary, filters, pagination, lastSyncTime, noSync } = loaderData;
  const [, setSearchParams] = useSearchParams();
  const [localVendor, setLocalVendor] = useState(filters.vendor);
  const [localProductType, setLocalProductType] = useState(filters.productType);
  const [localFilter, setLocalFilter] = useState(filters.marginFilter);
  const [localThreshold, setLocalThreshold] = useState(filters.marginThreshold);

  function applyFilters() {
    const p = new URLSearchParams();
    if (localVendor) p.set("vendor", localVendor);
    if (localProductType) p.set("productType", localProductType);
    if (localFilter) p.set("marginFilter", localFilter);
    if (localThreshold) p.set("marginThreshold", localThreshold);
    setSearchParams(p);
  }

  function clearFilters() {
    setLocalVendor(""); setLocalProductType(""); setLocalFilter(""); setLocalThreshold("");
    setSearchParams(new URLSearchParams());
  }

  function buildPageUrl(p: number) {
    const params = new URLSearchParams();
    if (filters.vendor) params.set("vendor", filters.vendor);
    if (filters.productType) params.set("productType", filters.productType);
    if (filters.marginFilter) params.set("marginFilter", filters.marginFilter);
    if (filters.marginThreshold) params.set("marginThreshold", filters.marginThreshold);
    params.set("page", String(p));
    return `?${params.toString()}`;
  }

  return (
    <main className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link to="/reports" className="text-sm text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300">← Reports</Link>
          <span className="text-gray-300 dark:text-gray-600">/</span>
          <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Margin Report</h2>
          {lastSyncTime && (
            <span className="text-xs text-gray-400 dark:text-gray-500">Data as of {new Date(lastSyncTime).toLocaleString()}</span>
          )}
        </div>
        <button onClick={() => exportCsv(items)}
          className="flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Export CSV
        </button>
      </div>

      {noSync && (
        <div className="mb-6 p-4 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 text-sm text-amber-800 dark:text-amber-300">
          No data synced yet. Click <strong>Sync Data</strong> in the navigation bar to fetch product data from Shopify.
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm p-5">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Avg Margin</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">{summary.avgMargin.toFixed(1)}%</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">across {pagination.totalCount} variants</p>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-rose-200 dark:border-rose-900 shadow-sm p-5">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Below Floor ({marginFloor}%)</p>
          <p className="text-2xl font-bold text-rose-600 dark:text-rose-400">{summary.belowFloorCount}</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">variants need attention</p>
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
          <select value={localVendor} onChange={(e) => setLocalVendor(e.target.value)} className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100">
            <option value="">All vendors</option>
            {uniqueVendors.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Product Type</label>
          <select value={localProductType} onChange={(e) => setLocalProductType(e.target.value)} className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100">
            <option value="">All types</option>
            {uniqueProductTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Margin range</label>
          <div className="flex items-center gap-1">
            <select value={localFilter} onChange={(e) => setLocalFilter(e.target.value)} className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100">
              <option value="">Any</option>
              <option value="below">Below</option>
              <option value="above">Above</option>
            </select>
            {localFilter && (
              <input type="number" placeholder="%" value={localThreshold} onChange={(e) => setLocalThreshold(e.target.value)}
                className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 w-20" />
            )}
          </div>
        </div>
        <button onClick={applyFilters} className="text-sm font-medium px-4 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors">Apply</button>
        {(filters.vendor || filters.productType || filters.marginFilter) && (
          <button onClick={clearFilters} className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors">Clear</button>
        )}
      </div>

      {/* Table */}
      {items.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm px-6 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
          {noSync ? "Run Sync to populate data." : "No variants match — try adjusting your filters."}
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
                <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Vendor</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Type</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Qty</th>
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
                  <tr key={item.variantId} className={[i < items.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : "", !aboveFloor ? "bg-rose-50 dark:bg-rose-950/20" : ""].join(" ")}>
                    <td className="px-5 py-3 text-gray-800 dark:text-gray-100 max-w-xs truncate">{item.productTitle}</td>
                    <td className="px-5 py-3 font-mono text-gray-600 dark:text-gray-300 text-xs">{item.sku || "—"}</td>
                    <td className="px-5 py-3 text-gray-600 dark:text-gray-300">{item.vendor}</td>
                    <td className="px-5 py-3 text-gray-500 dark:text-gray-400">{item.productType || "—"}</td>
                    <td className="px-5 py-3 text-right text-gray-600 dark:text-gray-300">{item.inventoryQuantity}</td>
                    <td className="px-5 py-3 text-right text-gray-700 dark:text-gray-200">${item.unitCost.toFixed(2)}</td>
                    <td className="px-5 py-3 text-right text-gray-700 dark:text-gray-200">${item.retailPrice.toFixed(2)}</td>
                    <td className={`px-5 py-3 text-right font-bold ${aboveFloor ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>{item.margin.toFixed(1)}%</td>
                    <td className="px-5 py-3 text-center">
                      <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full ${aboveFloor ? "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300" : "bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300"}`}>
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
      <Pagination page={pagination.page} totalPages={pagination.totalPages} buildUrl={buildPageUrl} />
    </main>
  );
}
