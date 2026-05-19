import { Link, useSearchParams, Await } from "react-router";
import { useState, useEffect, Suspense } from "react";
import type { Route } from "./+types/reports.sales-velocity";
import { requireUserId } from "../session.server";
import { getDb } from "../db.server";
import {
  getSalesVelocityData,
  getProductTypes,
} from "../services/shopify.server";
import type { SalesVelocityVariant } from "../services/shopify.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const url = new URL(request.url);

  const vendorFilter = url.searchParams.get("vendor") ?? "";
  const productTypeFilter = url.searchParams.get("productType") ?? "";
  const startDate = url.searchParams.get("startDate") ?? "";
  const endDate = url.searchParams.get("endDate") ?? "";

  const now = new Date();
  const defaultStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const start = startDate ? new Date(startDate) : defaultStart;
  const end = endDate ? new Date(endDate + "T23:59:59") : now;
  const dayRange = Math.max(
    Math.ceil((end.getTime() - start.getTime()) / 86400000),
    1
  );

  // Fast: taxonomy dropdowns load immediately
  const db = getDb();
  const [vendors, shopifyProductTypes] = await Promise.all([
    db.vendor.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    getProductTypes(),
  ]);

  // Slow: Shopify orders call is deferred — page renders while this resolves
  const velocityData = getSalesVelocityData(start, end);

  return {
    vendors,
    shopifyProductTypes,
    velocityData,
    dayRange,
    filters: {
      vendor: vendorFilter,
      productType: productTypeFilter,
      startDate: startDate || defaultStart.toISOString().slice(0, 10),
      endDate: endDate || now.toISOString().slice(0, 10),
    },
  };
}

function fmt$(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function daysBadgeBg(days: number | null): string {
  if (days === null) return "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400";
  if (days < 7) return "bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300";
  if (days < 14) return "bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300";
  if (days < 30) return "bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300";
  return "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300";
}

function LoadingSpinner() {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-4">
      <svg
        className="animate-spin h-10 w-10 text-indigo-500"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
      >
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
        />
      </svg>
      <div className="text-center">
        <p className="text-sm font-medium text-gray-600 dark:text-gray-300">Fetching sales data from Shopify…</p>
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">This may take a few seconds depending on order volume.</p>
      </div>
    </div>
  );
}

function VelocityTable({
  data,
  dayRange,
  vendorFilter,
  productTypeFilter,
}: {
  data: SalesVelocityVariant[];
  dayRange: number;
  vendorFilter: string;
  productTypeFilter: string;
}) {
  const filtered = data.filter((v) => {
    if (vendorFilter && v.vendor !== vendorFilter) return false;
    if (productTypeFilter && v.productType !== productTypeFilter) return false;
    return true;
  });

  const rows = filtered.map((v) => {
    const avgDaily = v.unitsSold / dayRange;
    const daysRemaining =
      avgDaily > 0 ? Math.floor(v.currentStock / avgDaily) : null;
    return { ...v, avgDaily, daysRemaining };
  });

  rows.sort((a, b) => {
    if (a.daysRemaining === null && b.daysRemaining === null) return 0;
    if (a.daysRemaining === null) return 1;
    if (b.daysRemaining === null) return -1;
    return a.daysRemaining - b.daysRemaining;
  });

  if (rows.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm px-6 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
        No products sold in this date range.
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden">
      <div className="px-5 py-3 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400 flex gap-4">
        <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-rose-500 inline-block" /> &lt;7 days — critical</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-orange-400 inline-block" /> &lt;14 days — low</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-yellow-400 inline-block" /> &lt;30 days — watch</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" /> 30+ days — healthy</span>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
            <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Product</th>
            <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">SKU</th>
            <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Units Sold</th>
            <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Revenue</th>
            <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Avg/Day</th>
            <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Stock</th>
            <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Days Left</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.variantId} className={i < rows.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : ""}>
              <td className="px-5 py-3 text-gray-800 dark:text-gray-100 max-w-xs truncate">{row.productTitle}</td>
              <td className="px-5 py-3 font-mono text-gray-600 dark:text-gray-300 text-xs">{row.sku || "—"}</td>
              <td className="px-5 py-3 text-right text-gray-700 dark:text-gray-200">{row.unitsSold}</td>
              <td className="px-5 py-3 text-right text-gray-700 dark:text-gray-200">{fmt$(row.revenue)}</td>
              <td className="px-5 py-3 text-right text-gray-600 dark:text-gray-300">{row.avgDaily.toFixed(2)}</td>
              <td className="px-5 py-3 text-right text-gray-700 dark:text-gray-200">{row.currentStock}</td>
              <td className="px-5 py-3 text-right">
                <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full ${daysBadgeBg(row.daysRemaining)}`}>
                  {row.daysRemaining === null ? "∞" : `${row.daysRemaining}d`}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function SalesVelocityPage({ loaderData }: Route.ComponentProps) {
  const { vendors, shopifyProductTypes, velocityData, dayRange, filters } = loaderData;
  const [, setSearchParams] = useSearchParams();
  const [localVendor, setLocalVendor] = useState(filters.vendor);
  const [localType, setLocalType] = useState(filters.productType);
  const [localStart, setLocalStart] = useState(filters.startDate);
  const [localEnd, setLocalEnd] = useState(filters.endDate);

  function applyFilters() {
    const p = new URLSearchParams();
    if (localVendor) p.set("vendor", localVendor);
    if (localType) p.set("productType", localType);
    if (localStart) p.set("startDate", localStart);
    if (localEnd) p.set("endDate", localEnd);
    setSearchParams(p);
  }

  function clearFilters() {
    const now = new Date();
    const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    setLocalVendor("");
    setLocalType("");
    setLocalStart(d30.toISOString().slice(0, 10));
    setLocalEnd(now.toISOString().slice(0, 10));
    setSearchParams(new URLSearchParams());
  }

  return (
    <main className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link to="/reports" className="text-sm text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300">← Reports</Link>
        <span className="text-gray-300 dark:text-gray-600">/</span>
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Sales Velocity</h2>
        <span className="text-xs text-gray-400 dark:text-gray-500 ml-2">Sorted by days of stock remaining (urgent first)</span>
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm p-4 mb-6 flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Vendor</label>
          <select value={localVendor} onChange={(e) => setLocalVendor(e.target.value)}
            className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100">
            <option value="">All vendors</option>
            {vendors.map((v) => <option key={v.id} value={v.name}>{v.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Product Type</label>
          <select value={localType} onChange={(e) => setLocalType(e.target.value)}
            className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100">
            <option value="">All types</option>
            {shopifyProductTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">From (default: last 30 days)</label>
          <input type="date" value={localStart} onChange={(e) => setLocalStart(e.target.value)}
            className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">To</label>
          <input type="date" value={localEnd} onChange={(e) => setLocalEnd(e.target.value)}
            className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100" />
        </div>
        <button onClick={applyFilters}
          className="text-sm font-medium px-4 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors">
          Apply
        </button>
        <button onClick={clearFilters}
          className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors">
          Reset
        </button>
      </div>

      {/* Deferred table with loading state */}
      <Suspense fallback={<LoadingSpinner />}>
        <Await resolve={velocityData}>
          {(data) => (
            <VelocityTable
              data={data}
              dayRange={dayRange}
              vendorFilter={filters.vendor}
              productTypeFilter={filters.productType}
            />
          )}
        </Await>
      </Suspense>
    </main>
  );
}
