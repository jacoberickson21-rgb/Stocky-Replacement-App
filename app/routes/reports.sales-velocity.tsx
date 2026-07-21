import { Link, useSearchParams, useFetcher } from "react-router";
import { Fragment, useState, useEffect } from "react";
import type { Route } from "./+types/reports.sales-velocity";
import { requireUserId } from "../session.server";
import { getDb } from "../db.server";
import { getVariantSalesVelocity, type SalesVelocityPeriod } from "../services/sales-velocity.server";
import { getSyncStatus } from "../services/sync.server";
import type { SyncLogData } from "../services/sync.server";

const PAGE_SIZE = 50;

const PERIOD_OPTIONS: { value: SalesVelocityPeriod; label: string }[] = [
  { value: "1w", label: "1W" },
  { value: "2w", label: "2W" },
  { value: "1m", label: "1M" },
  { value: "3m", label: "3M" },
  { value: "6m", label: "6M" },
  { value: "12m", label: "12M" },
  { value: "lifetime", label: "Lifetime" },
];
const VALID_PERIODS = new Set(PERIOD_OPTIONS.map((p) => p.value));

type VariantRow = {
  sku: string;
  variantTitle: string;
  price: number;
  unitsSold: number;
  revenue: number;
  currentStock: number;
  avgDaily: number;
  daysRemaining: number | null;
};

type ProductGroup = {
  productTitle: string;
  vendor: string;
  variants: VariantRow[];
  totalUnitsSold: number;
  totalRevenue: number;
  totalStock: number;
  avgDaily: number;
  daysRemaining: number | null;
};

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const db = getDb();
  const url = new URL(request.url);

  const vendorFilter = url.searchParams.get("vendor") ?? "";
  const productTypeFilter = url.searchParams.get("productType") ?? "";
  const periodParam = url.searchParams.get("period") ?? "1m";
  const period: SalesVelocityPeriod = VALID_PERIODS.has(periodParam as SalesVelocityPeriod)
    ? (periodParam as SalesVelocityPeriod)
    : "1m";
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1"));

  const [{ rows: velocityRows, dayRange }, vendors, distinctTypes, lastSync] = await Promise.all([
    getVariantSalesVelocity(period),
    db.vendor.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.productCache.findMany({
      distinct: ["productType"],
      where: { productType: { not: null } },
      select: { productType: true },
      orderBy: { productType: "asc" },
    }),
    getSyncStatus(),
  ]);

  const vendorNeedle = vendorFilter.toLowerCase();
  const typeNeedle = productTypeFilter.toLowerCase();

  const filtered = velocityRows
    .filter((r) => (vendorNeedle ? r.vendor.toLowerCase().includes(vendorNeedle) : true))
    .filter((r) => (typeNeedle ? r.productType.toLowerCase().includes(typeNeedle) : true));

  // Group by product; parent row shows aggregated totals, child rows are the
  // real per-variant SalesCache numbers (no distribution/estimation).
  const groupMap = new Map<string, { vendor: string; variants: VariantRow[] }>();
  for (const r of filtered) {
    const entry = groupMap.get(r.productTitle) ?? { vendor: r.vendor, variants: [] };
    entry.variants.push({
      sku: r.sku,
      variantTitle: r.variantTitle,
      price: r.price,
      unitsSold: r.unitsSold,
      revenue: r.revenue,
      currentStock: r.currentStock,
      avgDaily: r.avgDailySales,
      daysRemaining: r.daysRemaining,
    });
    groupMap.set(r.productTitle, entry);
  }

  let groups: ProductGroup[] = Array.from(groupMap.entries()).map(([productTitle, { vendor, variants }]) => {
    variants.sort((a, b) => (a.daysRemaining ?? Infinity) - (b.daysRemaining ?? Infinity));
    const totalUnitsSold = variants.reduce((s, v) => s + v.unitsSold, 0);
    const totalRevenue = variants.reduce((s, v) => s + v.revenue, 0);
    const totalStock = variants.reduce((s, v) => s + v.currentStock, 0);
    const avgDaily = totalUnitsSold / dayRange;
    const daysRemaining = avgDaily > 0 ? Math.floor(totalStock / avgDaily) : null;
    return { productTitle, vendor, variants, totalUnitsSold, totalRevenue, totalStock, avgDaily, daysRemaining };
  });

  groups = groups.sort((a, b) => (a.daysRemaining ?? Infinity) - (b.daysRemaining ?? Infinity));

  const totalCount = groups.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const pageGroups = groups.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return {
    groups: pageGroups,
    vendors,
    distinctTypes: distinctTypes.map((r) => r.productType!).filter(Boolean),
    dayRange,
    filters: {
      vendor: vendorFilter,
      productType: productTypeFilter,
      period,
    },
    pagination: { page, totalPages, totalCount },
    lastSync,
  };
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins !== 1 ? "s" : ""} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs !== 1 ? "s" : ""} ago`;
  return `${Math.floor(hrs / 24)} day${Math.floor(hrs / 24) !== 1 ? "s" : ""} ago`;
}

function fmt$(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function SyncProgressBar({ status }: { status: SyncLogData | null }) {
  if (!status || status.status !== "RUNNING") return null;
  const hasTotal = !!status.totalVariants && status.totalVariants > 0;
  const pct = hasTotal ? Math.min(100, Math.round(((status.currentVariant ?? 0) / status.totalVariants!) * 100)) : null;
  return (
    <div className="mb-4">
      <div className="h-1.5 w-full rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden relative">
        {pct !== null ? (
          <div className="h-full bg-indigo-500 rounded-full transition-[width] duration-500 ease-out" style={{ width: `${pct}%` }} />
        ) : (
          <div
            className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-indigo-500"
            style={{ animation: "sync-indeterminate 1.2s ease-in-out infinite" }}
          />
        )}
      </div>
      <div className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">
        {pct !== null ? `${pct}% · ${(status.currentVariant ?? 0).toLocaleString()} / ${status.totalVariants!.toLocaleString()} variants` : (status.errorMessage ?? "Syncing…")}
      </div>
    </div>
  );
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
  const { groups, vendors, distinctTypes, filters, pagination, lastSync: initialLastSync } = loaderData;
  const [, setSearchParams] = useSearchParams();
  const syncFetcher = useFetcher<SyncLogData>();
  const [lastSync, setLastSync] = useState<SyncLogData | null>(initialLastSync);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const isSyncing = lastSync?.status === "RUNNING" || syncFetcher.state !== "idle";

  useEffect(() => {
    if (syncFetcher.data) setLastSync(syncFetcher.data);
  }, [syncFetcher.data]);

  useEffect(() => {
    if (!isSyncing) return;
    const id = setInterval(() => {
      fetch("/api/sync")
        .then((r) => r.json())
        .then((d) => setLastSync(d as SyncLogData))
        .catch(() => {});
    }, 3000);
    return () => clearInterval(id);
  }, [isSyncing]);

  function triggerSync() {
    syncFetcher.submit({}, { method: "POST", action: "/api/sync" });
  }

  function toggleExpand(productTitle: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(productTitle)) next.delete(productTitle);
      else next.add(productTitle);
      return next;
    });
  }

  function expandAll() {
    setExpanded(new Set(groups.map((g) => g.productTitle)));
  }

  function collapseAll() {
    setExpanded(new Set());
  }

  function setFilter(key: "vendor" | "productType" | "period", value: string) {
    const params = new URLSearchParams();
    const next = { ...filters, [key]: value };
    if (next.vendor) params.set("vendor", next.vendor);
    if (next.productType) params.set("productType", next.productType);
    params.set("period", next.period);
    setSearchParams(params);
  }

  function clearFilters() {
    setSearchParams(new URLSearchParams({ period: filters.period }));
  }

  function buildPageUrl(p: number) {
    const params = new URLSearchParams();
    if (filters.vendor) params.set("vendor", filters.vendor);
    if (filters.productType) params.set("productType", filters.productType);
    params.set("period", filters.period);
    params.set("page", String(p));
    return `?${params.toString()}`;
  }

  return (
    <main className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center gap-3 mb-2">
        <Link to="/reports" className="text-sm text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300">← Reports</Link>
        <span className="text-gray-300 dark:text-gray-600">/</span>
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Sales Velocity</h2>
        <span className="text-xs text-gray-400 dark:text-gray-500 ml-2">Sorted by urgency · most urgent first</span>
        <button
          onClick={triggerSync}
          disabled={isSyncing}
          className="ml-auto text-sm font-medium px-4 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isSyncing ? "Syncing…" : "Resync"}
        </button>
      </div>
      <div className="mb-2 text-xs text-gray-400 dark:text-gray-500">
        {!lastSync
          ? "No sync has run yet."
          : lastSync.status === "RUNNING"
          ? "Sync in progress…"
          : lastSync.status === "ERROR"
          ? "Last sync failed."
          : lastSync.completedAt
          ? `Last synced ${timeAgo(lastSync.completedAt)}`
          : "Last sync status unknown."}
      </div>
      <SyncProgressBar status={lastSync} />

      {/* Period presets */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {PERIOD_OPTIONS.map((p) => (
          <button
            key={p.value}
            onClick={() => setFilter("period", p.value)}
            className={`text-sm font-medium px-3 py-1.5 rounded-lg border transition-colors ${
              filters.period === p.value
                ? "bg-indigo-600 border-indigo-600 text-white"
                : "border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm p-4 mb-6 flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Vendor</label>
          <select value={filters.vendor} onChange={(e) => setFilter("vendor", e.target.value)} className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100">
            <option value="">All vendors</option>
            {vendors.map((v) => <option key={v.id} value={v.name}>{v.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Product Type</label>
          <select value={filters.productType} onChange={(e) => setFilter("productType", e.target.value)} className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100">
            <option value="">All types</option>
            {distinctTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <button onClick={clearFilters} className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors">Reset</button>
      </div>

      {/* Table */}
      {groups.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm px-6 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
          No sales data for this period.
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden">
          <div className="px-5 py-3 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400 flex items-center gap-4">
            <span>{pagination.totalCount} products · Page {pagination.page} of {pagination.totalPages}</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-rose-500 inline-block" /> &lt;7 days — critical</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-orange-400 inline-block" /> &lt;14 — low</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-yellow-400 inline-block" /> &lt;30 — watch</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" /> 30+ — healthy</span>
            <span className="ml-auto flex gap-2">
              <button onClick={expandAll} className="font-medium text-indigo-600 dark:text-indigo-400 hover:underline">Expand All</button>
              <button onClick={collapseAll} className="font-medium text-indigo-600 dark:text-indigo-400 hover:underline">Collapse All</button>
            </span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Product</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Vendor</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">SKU</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Price</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Units Sold</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Revenue</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Avg/Day</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Stock</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Days Left</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group, gi) => {
                const isExpanded = expanded.has(group.productTitle);
                const isLastGroup = gi === groups.length - 1;
                const hasVariants = group.variants.length > 0;
                return (
                  <Fragment key={`${group.productTitle}-${gi}`}>
                    <tr className={!isLastGroup || isExpanded ? "border-b border-gray-100 dark:border-gray-700" : ""}>
                      <td className="px-5 py-3 text-gray-800 dark:text-gray-100 max-w-xs truncate">
                        <button
                          onClick={() => toggleExpand(group.productTitle)}
                          disabled={!hasVariants}
                          aria-label={isExpanded ? "Collapse" : "Expand"}
                          className="mr-2 w-4 inline-block text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-0"
                        >
                          {isExpanded ? "▼" : "▶"}
                        </button>
                        {group.productTitle}
                      </td>
                      <td className="px-5 py-3 text-gray-600 dark:text-gray-300 text-xs">{group.vendor || "—"}</td>
                      <td className="px-5 py-3 font-mono text-gray-600 dark:text-gray-300 text-xs">
                        {group.variants.length === 0 ? "—" : group.variants.length === 1 ? group.variants[0].sku : `${group.variants.length} SKUs`}
                      </td>
                      <td className="px-5 py-3 text-right text-gray-400 dark:text-gray-500 text-xs">—</td>
                      <td className="px-5 py-3 text-right text-gray-700 dark:text-gray-200">{group.totalUnitsSold}</td>
                      <td className="px-5 py-3 text-right text-gray-700 dark:text-gray-200">{fmt$(group.totalRevenue)}</td>
                      <td className="px-5 py-3 text-right text-gray-600 dark:text-gray-300">{group.avgDaily.toFixed(2)}</td>
                      <td className="px-5 py-3 text-right text-gray-700 dark:text-gray-200">{group.totalStock}</td>
                      <td className="px-5 py-3 text-right">
                        <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full ${daysBadgeBg(group.daysRemaining)}`}>
                          {group.daysRemaining === null ? "∞" : group.daysRemaining + "d"}
                        </span>
                      </td>
                    </tr>
                    {isExpanded &&
                      group.variants.map((v, vi) => {
                        const isLastVariant = vi === group.variants.length - 1;
                        return (
                          <tr
                            key={`${group.productTitle}-${gi}-variant-${vi}`}
                            className={`bg-gray-50/70 dark:bg-gray-800/40 ${!isLastGroup || !isLastVariant ? "border-b border-gray-100 dark:border-gray-700" : ""}`}
                          >
                            <td className="pl-12 pr-5 py-2 text-gray-500 dark:text-gray-400 text-xs truncate max-w-xs">
                              {v.variantTitle && v.variantTitle !== "Default Title" ? v.variantTitle : <span className="italic">—</span>}
                            </td>
                            <td className="px-5 py-2 text-gray-400 dark:text-gray-500 text-xs">—</td>
                            <td className="px-5 py-2 font-mono text-gray-500 dark:text-gray-400 text-xs">{v.sku || "—"}</td>
                            <td className="px-5 py-2 text-right text-gray-500 dark:text-gray-400 text-xs">{fmt$(v.price)}</td>
                            <td className="px-5 py-2 text-right text-gray-500 dark:text-gray-400 text-xs">{v.unitsSold}</td>
                            <td className="px-5 py-2 text-right text-gray-500 dark:text-gray-400 text-xs">{fmt$(v.revenue)}</td>
                            <td className="px-5 py-2 text-right text-gray-500 dark:text-gray-400 text-xs">{v.avgDaily.toFixed(2)}</td>
                            <td className="px-5 py-2 text-right text-gray-500 dark:text-gray-400 text-xs">{v.currentStock}</td>
                            <td className="px-5 py-2 text-right">
                              <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full ${daysBadgeBg(v.daysRemaining)}`}>
                                {v.daysRemaining === null ? "∞" : v.daysRemaining + "d"}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                  </Fragment>
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
