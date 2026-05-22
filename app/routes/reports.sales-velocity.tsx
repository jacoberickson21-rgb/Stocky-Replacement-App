import { Link, useSearchParams } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/reports.sales-velocity";
import { requireUserId } from "../session.server";
import { getDb } from "../db.server";
import { getSyncStatus } from "../services/sync.server";
import { Prisma } from "@prisma/client";

const PAGE_SIZE = 50;

type VelocityRow = {
  variantId: string;
  productTitle: string;
  sku: string;
  vendor: string;
  productType: string;
  unitsSold: number;
  revenue: number;
  currentStock: number;
  avgDaily: number;
  daysRemaining: number | null;
  sellThrough: number;
};

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const db = getDb();
  const url = new URL(request.url);

  const vendorFilter = url.searchParams.get("vendor") ?? "";
  const productTypeFilter = url.searchParams.get("productType") ?? "";
  const startDateStr = url.searchParams.get("startDate") ?? "";
  const endDateStr = url.searchParams.get("endDate") ?? "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1"));

  const now = new Date();
  const defaultStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const start = startDateStr ? new Date(startDateStr) : defaultStart;
  const end = endDateStr ? new Date(endDateStr + "T23:59:59") : now;
  const dayRange = Math.max(Math.ceil((end.getTime() - start.getTime()) / 86400000), 1);

  const [vendors, distinctTypes, lastSync, productCacheCount, salesCacheCount] = await Promise.all([
    db.vendor.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.productCache.findMany({ distinct: ["productType"], where: { productType: { not: null } }, select: { productType: true }, orderBy: { productType: "asc" } }),
    getSyncStatus(),
    db.productCache.count(),
    db.salesCache.count(),
  ]);

  console.log(`[sales-velocity] ProductCache rows: ${productCacheCount}, SalesCache rows: ${salesCacheCount}`);
  console.log(`[sales-velocity] date range: ${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)} (${dayRange} days)`);

  // Build optional filter conditions
  const vendorCond = vendorFilter ? Prisma.sql`AND p.vendor ILIKE ${vendorFilter}` : Prisma.sql``;
  const typeCond = productTypeFilter ? Prisma.sql`AND p."productType" ILIKE ${productTypeFilter}` : Prisma.sql``;

  // Join SalesCache with ProductCache, aggregate by variant
  type RawRow = {
    variantId: string;
    productTitle: string;
    sku: string | null;
    vendor: string | null;
    productType: string | null;
    unitsSold: bigint;
    revenue: string;
    currentStock: number;
  };

  const rawRows = await db.$queryRaw<RawRow[]>`
    SELECT
      p."variantId",
      p.title AS "productTitle",
      p.sku,
      p.vendor,
      p."productType",
      SUM(s."unitsSold")::bigint AS "unitsSold",
      SUM(s.revenue::float)::text AS revenue,
      p."currentInventory" AS "currentStock"
    FROM "SalesCache" s
    JOIN "ProductCache" p ON p."variantId" = s."variantId"
    WHERE s.date >= ${start} AND s.date <= ${end}
    ${vendorCond}
    ${typeCond}
    GROUP BY p."variantId", p.title, p.sku, p.vendor, p."productType", p."currentInventory"
  `;

  console.log(`[sales-velocity] raw JOIN query returned ${rawRows.length} rows`);
  if (rawRows.length === 0 && salesCacheCount > 0) {
    const scSample = await db.salesCache.findFirst({ select: { variantId: true, date: true } });
    const pcSample = await db.productCache.findFirst({ select: { variantId: true } });
    console.log(`[sales-velocity] EMPTY RESULT but SalesCache has data — possible variantId mismatch`);
    console.log(`[sales-velocity] SalesCache sample variantId: ${scSample?.variantId}, date: ${scSample?.date?.toISOString()}`);
    console.log(`[sales-velocity] ProductCache sample variantId: ${pcSample?.variantId}`);
  }

  const allRows: VelocityRow[] = rawRows.map((r) => {
    const unitsSold = Number(r.unitsSold);
    const revenue = parseFloat(r.revenue);
    const avgDaily = unitsSold / dayRange;
    const daysRemaining = avgDaily > 0 ? Math.floor(r.currentStock / avgDaily) : null;
    const sellThrough = unitsSold + r.currentStock > 0
      ? Math.round((unitsSold / (unitsSold + r.currentStock)) * 1000) / 10
      : 0;
    return {
      variantId: r.variantId,
      productTitle: r.productTitle,
      sku: r.sku ?? "",
      vendor: r.vendor ?? "",
      productType: r.productType ?? "",
      unitsSold,
      revenue,
      currentStock: r.currentStock,
      avgDaily,
      daysRemaining,
      sellThrough,
    };
  });

  // Sort by daysRemaining ASC (most urgent first); items with no velocity go last
  allRows.sort((a, b) => {
    if (a.daysRemaining === null && b.daysRemaining === null) return 0;
    if (a.daysRemaining === null) return 1;
    if (b.daysRemaining === null) return -1;
    return a.daysRemaining - b.daysRemaining;
  });

  const totalCount = allRows.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const rows = allRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return {
    rows,
    vendors,
    distinctTypes: distinctTypes.map((r) => r.productType!).filter(Boolean),
    dayRange,
    filters: {
      vendor: vendorFilter,
      productType: productTypeFilter,
      startDate: startDateStr || defaultStart.toISOString().slice(0, 10),
      endDate: endDateStr || now.toISOString().slice(0, 10),
    },
    pagination: { page, totalPages, totalCount },
    lastSyncTime: lastSync?.completedAt ?? null,
    noSync: !lastSync,
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

export default function SalesVelocityPage({ loaderData }: Route.ComponentProps) {
  const { rows, vendors, distinctTypes, dayRange, filters, pagination, lastSyncTime, noSync } = loaderData;
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
    setLocalVendor(""); setLocalType("");
    setLocalStart(d30.toISOString().slice(0, 10));
    setLocalEnd(now.toISOString().slice(0, 10));
    setSearchParams(new URLSearchParams());
  }

  function buildPageUrl(p: number) {
    const params = new URLSearchParams();
    if (filters.vendor) params.set("vendor", filters.vendor);
    if (filters.productType) params.set("productType", filters.productType);
    if (filters.startDate) params.set("startDate", filters.startDate);
    if (filters.endDate) params.set("endDate", filters.endDate);
    params.set("page", String(p));
    return `?${params.toString()}`;
  }

  return (
    <main className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link to="/reports" className="text-sm text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300">← Reports</Link>
        <span className="text-gray-300 dark:text-gray-600">/</span>
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Sales Velocity</h2>
        {lastSyncTime && (
          <span className="text-xs text-gray-400 dark:text-gray-500">Data as of {new Date(lastSyncTime).toLocaleString()}</span>
        )}
        <span className="text-xs text-gray-400 dark:text-gray-500 ml-2">Sorted by urgency · most urgent first</span>
      </div>

      {noSync && (
        <div className="mb-6 p-4 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 text-sm text-amber-800 dark:text-amber-300">
          No data synced yet. Click <strong>Sync Data</strong> in the navigation bar to fetch sales data from Shopify.
        </div>
      )}

      {/* Filters */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm p-4 mb-6 flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Vendor</label>
          <select value={localVendor} onChange={(e) => setLocalVendor(e.target.value)} className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100">
            <option value="">All vendors</option>
            {vendors.map((v) => <option key={v.id} value={v.name}>{v.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Product Type</label>
          <select value={localType} onChange={(e) => setLocalType(e.target.value)} className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100">
            <option value="">All types</option>
            {distinctTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">From</label>
          <input type="date" value={localStart} onChange={(e) => setLocalStart(e.target.value)} className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">To</label>
          <input type="date" value={localEnd} onChange={(e) => setLocalEnd(e.target.value)} className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100" />
        </div>
        <button onClick={applyFilters} className="text-sm font-medium px-4 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors">Apply</button>
        <button onClick={clearFilters} className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors">Reset</button>
      </div>

      {/* Table */}
      {rows.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm px-6 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
          {noSync ? "Run Sync to populate data." : "No sales data for this date range."}
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden">
          <div className="px-5 py-3 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400 flex gap-4">
            <span>{pagination.totalCount} variants · Page {pagination.page} of {pagination.totalPages}</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-rose-500 inline-block" /> &lt;7 days — critical</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-orange-400 inline-block" /> &lt;14 — low</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-yellow-400 inline-block" /> &lt;30 — watch</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" /> 30+ — healthy</span>
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
                <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Sell-Through</th>
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
                  <td className="px-5 py-3 text-right text-gray-600 dark:text-gray-300">{row.sellThrough.toFixed(1)}%</td>
                  <td className="px-5 py-3 text-right">
                    <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full ${daysBadgeBg(row.daysRemaining)}`}>
                      {row.daysRemaining === null ? "∞" : row.daysRemaining + "d"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={pagination.page} totalPages={pagination.totalPages} buildUrl={buildPageUrl} />
    </main>
  );
}
