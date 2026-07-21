import { redirect, data, Link, Form, useSearchParams, useActionData, useNavigation, useFetcher } from "react-router";
import { Fragment, useState, useEffect, useMemo } from "react";
import Papa from "papaparse";
import type { Route } from "./+types/reorder";
import { requireUserId } from "../session.server";
import { getDb } from "../db.server";
import { getVariantSalesVelocity, type SalesVelocityPeriod } from "../services/sales-velocity.server";
import { getSyncStatus } from "../services/sync.server";
import type { SyncLogData } from "../services/sync.server";
import { resolveVendorId } from "../utils/vendor-resolve.server";
import { getInventoryItemIdsByVariant } from "../services/shopify.server";

const PAGE_SIZE = 50;

const PERIOD_OPTIONS: { value: SalesVelocityPeriod; label: string }[] = [
  { value: "1w", label: "1W" },
  { value: "2w", label: "2W" },
  { value: "1m", label: "1M" },
  { value: "2m", label: "2M" },
  { value: "3m", label: "3M" },
  { value: "6m", label: "6M" },
  { value: "12m", label: "12M" },
  { value: "lifetime", label: "Lifetime" },
];
const VALID_PERIODS = new Set(PERIOD_OPTIONS.map((p) => p.value));

const COVERAGE_OPTIONS = [30, 60, 90, 120, 180] as const;
const DEFAULT_COVERAGE_DAYS = 90;

// Recommended sales-velocity lookback for a given coverage target — the two are
// independently overridable, but changing coverage re-syncs the period by default.
function coverageToPeriod(coverageDays: number): SalesVelocityPeriod {
  if (coverageDays <= 30) return "1m";
  if (coverageDays <= 60) return "2m";
  return "3m"; // 90+ days caps at a 90-day lookback
}

function suggestedQtyBreakdown(coverageDays: number, avgDaily: number, currentStock: number, suggestedQty: number): string {
  return `(${coverageDays}d × ${avgDaily.toFixed(2)}/day) − ${currentStock} on hand = ${suggestedQty} suggested`;
}

type ReorderRow = {
  sku: string;
  productTitle: string;
  variantTitle: string;
  vendor: string;
  variantId: string;
  price: number;
  currentStock: number;
  unitsSold: number;
  avgDaily: number;
  daysRemaining: number | null;
  suggestedQty: number;
};

type ReorderProductGroup = {
  productTitle: string;
  vendor: string;
  variants: ReorderRow[];
  totalCurrentStock: number;
  totalUnitsSold: number;
  avgDaily: number;
  daysRemaining: number | null;
  totalSuggestedQty: number;
};

type PreseasonComparisonRow = {
  sku: string;
  productTitle: string;
  variantTitle: string;
  variantId: string | null;
  price: number;
  preseasonQty: number;
  currentStock: number | null;
  avgDailySales: number;
  daysOfStock: number | null;
  suggestedQty: number;
  gap: number;
};

// ─── Loader ─────────────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const db = getDb();
  const url = new URL(request.url);

  const vendorFilter = url.searchParams.get("vendor") ?? "";
  const productTypeFilter = url.searchParams.get("productType") ?? "";
  const coverageDaysRaw = parseInt(url.searchParams.get("coverageDays") ?? "", 10);
  const coverageDays: number = (COVERAGE_OPTIONS as readonly number[]).includes(coverageDaysRaw)
    ? coverageDaysRaw
    : DEFAULT_COVERAGE_DAYS;
  const periodParam = url.searchParams.get("period");
  const period: SalesVelocityPeriod =
    periodParam && VALID_PERIODS.has(periodParam as SalesVelocityPeriod)
      ? (periodParam as SalesVelocityPeriod)
      : coverageToPeriod(coverageDays);
  const maxDays = Math.max(1, parseInt(url.searchParams.get("maxDays") ?? "30"));
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

  let rows: ReorderRow[] = velocityRows
    .filter((r) => r.daysRemaining !== null && r.daysRemaining < maxDays)
    .filter((r) => (vendorNeedle ? r.vendor.toLowerCase().includes(vendorNeedle) : true))
    .filter((r) => (typeNeedle ? r.productType.toLowerCase().includes(typeNeedle) : true))
    .map((r) => ({
      sku: r.sku,
      productTitle: r.productTitle,
      variantTitle: r.variantTitle,
      vendor: r.vendor,
      variantId: r.variantId,
      price: r.price,
      currentStock: r.currentStock,
      unitsSold: r.unitsSold,
      avgDaily: r.avgDailySales,
      daysRemaining: r.daysRemaining,
      suggestedQty: Math.max(0, Math.ceil(r.avgDailySales * coverageDays - r.currentStock)),
    }));

  rows = rows.sort((a, b) => (a.daysRemaining ?? Infinity) - (b.daysRemaining ?? Infinity));

  // Group the (already-filtered) variants by product; parent rows show
  // aggregated totals, matching the sales-velocity report's grouping pattern.
  const groupMap = new Map<string, { vendor: string; variants: ReorderRow[] }>();
  for (const r of rows) {
    const entry = groupMap.get(r.productTitle) ?? { vendor: r.vendor, variants: [] };
    entry.variants.push(r);
    groupMap.set(r.productTitle, entry);
  }

  let groups: ReorderProductGroup[] = Array.from(groupMap.entries()).map(([productTitle, { vendor, variants }]) => {
    const totalCurrentStock = variants.reduce((s, v) => s + v.currentStock, 0);
    const totalUnitsSold = variants.reduce((s, v) => s + v.unitsSold, 0);
    const avgDaily = totalUnitsSold / dayRange;
    const daysRemaining = avgDaily > 0 ? Math.floor(totalCurrentStock / avgDaily) : null;
    const totalSuggestedQty = variants.reduce((s, v) => s + v.suggestedQty, 0);
    return { productTitle, vendor, variants, totalCurrentStock, totalUnitsSold, avgDaily, daysRemaining, totalSuggestedQty };
  });

  groups = groups.sort((a, b) => (a.daysRemaining ?? Infinity) - (b.daysRemaining ?? Infinity));

  const totalCount = groups.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const pageGroups = groups.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return {
    groups: pageGroups,
    vendors,
    distinctTypes: distinctTypes.map((r) => r.productType!).filter(Boolean),
    filters: { vendor: vendorFilter, productType: productTypeFilter, period, maxDays, coverageDays },
    pagination: { page, totalPages, totalCount },
    lastSync,
  };
}

// ─── Action ─────────────────────────────────────────────────────────────────

type CheckedItem = {
  sku: string;
  productTitle: string;
  variantTitle: string;
  vendor: string;
  variantId: string | null;
  price: number;
  qty: number;
};

function lineDescription(productTitle: string, variantTitle: string): string {
  return variantTitle && variantTitle !== "Default Title" ? `${productTitle} — ${variantTitle}` : productTitle;
}

function generateInvoiceNumber(prefix: string, vendorId: number): string {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${prefix}-${dateStr}-${vendorId}-${suffix}`;
}

async function resolveInventoryItemIds(variantIds: (string | null)[]): Promise<Map<string, string | null>> {
  const ids = Array.from(new Set(variantIds.filter((v): v is string => !!v)));
  return getInventoryItemIdsByVariant(ids);
}

export async function action({ request }: Route.ActionArgs) {
  await requireUserId(request);
  const db = getDb();
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  // ── Generate draft POs from checked reorder rows, grouped by vendor ──
  if (intent === "generatePOs") {
    let items: CheckedItem[] = [];
    try {
      const parsed = JSON.parse(String(form.get("items") ?? "[]"));
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      return data({ error: "Invalid selection." }, { status: 400 });
    }
    if (items.length === 0) {
      return data({ error: "No items selected." }, { status: 400 });
    }

    const inventoryItemIdMap = await resolveInventoryItemIds(items.map((i) => i.variantId));

    const byVendor = new Map<string, CheckedItem[]>();
    for (const item of items) {
      const key = item.vendor || "Unknown Vendor";
      const list = byVendor.get(key) ?? [];
      list.push(item);
      byVendor.set(key, list);
    }

    for (const [vendorName, vendorItems] of byVendor) {
      const { vendorId } = await resolveVendorId(vendorName);
      const invoiceNumber = generateInvoiceNumber("RO", vendorId);
      await db.$transaction(async (tx) => {
        const created = await tx.invoice.create({
          data: { invoiceNumber, vendorId, status: "ORDERED", total: 0 },
        });
        await tx.invoiceLineItem.createMany({
          data: vendorItems.map((item) => ({
            invoiceId: created.id,
            sku: item.sku || null,
            description: lineDescription(item.productTitle, item.variantTitle),
            quantityOrdered: item.qty,
            unitCost: 0,
            retailPrice: item.price || null,
            shopifyProductTitle: item.productTitle,
            shopifyVariantId: item.variantId,
            shopifyInventoryItemId: item.variantId ? inventoryItemIdMap.get(item.variantId) ?? null : null,
          })),
        });
      });
    }

    return redirect("/invoices");
  }

  // ── Import preseason CSV, build comparison table ──
  if (intent === "importPreseasonCsv") {
    const vendorIdRaw = String(form.get("vendorId") ?? "").trim();
    const period = (String(form.get("period") ?? "1m")) as SalesVelocityPeriod;
    const coverageDaysRaw = parseInt(String(form.get("coverageDays") ?? ""), 10);
    const coverageDays = (COVERAGE_OPTIONS as readonly number[]).includes(coverageDaysRaw) ? coverageDaysRaw : DEFAULT_COVERAGE_DAYS;
    const file = form.get("csv");

    if (!vendorIdRaw) return data({ csvError: "Please select a vendor." }, { status: 400 });
    if (!file || !(file instanceof File) || file.size === 0) {
      return data({ csvError: "Please select a CSV file." }, { status: 400 });
    }

    const csvText = await file.text();
    const parsed = Papa.parse<Record<string, string>>(csvText, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
    });

    const errors: { row: number; message: string }[] = [];
    const csvRows: { sku: string; qty: number }[] = [];
    for (let i = 0; i < parsed.data.length; i++) {
      const row = parsed.data[i];
      const rowNum = i + 2;
      const sku = (row["SKU"] ?? "").trim();
      const qtyRaw = (row["Quantity"] ?? "").trim();
      const qty = parseInt(qtyRaw, 10);
      if (!sku) {
        errors.push({ row: rowNum, message: "Missing SKU" });
        continue;
      }
      if (!qtyRaw || isNaN(qty)) {
        errors.push({ row: rowNum, message: `Invalid quantity for SKU ${sku}` });
        continue;
      }
      csvRows.push({ sku, qty });
    }

    if (csvRows.length === 0) {
      return data({ csvError: "No valid rows found in CSV.", csvErrors: errors }, { status: 400 });
    }

    const skus = csvRows.map((r) => r.sku);
    const [productCacheRows, { rows: velocityRows }, vendor] = await Promise.all([
      db.productCache.findMany({
        where: { sku: { in: skus } },
        select: { sku: true, title: true, variantTitle: true, currentInventory: true, variantId: true, price: true },
      }),
      getVariantSalesVelocity(period),
      db.vendor.findUnique({ where: { id: Number(vendorIdRaw) } }),
    ]);
    const pcBySku = new Map(productCacheRows.map((p) => [p.sku!, p]));
    const velocityBySku = new Map(velocityRows.map((v) => [v.sku, v]));

    const comparison: PreseasonComparisonRow[] = csvRows.map((row) => {
      const pc = pcBySku.get(row.sku);
      const vel = velocityBySku.get(row.sku);
      const currentStock = pc?.currentInventory ?? null;
      const avgDailySales = vel?.avgDailySales ?? 0;
      const daysOfStock = currentStock !== null && avgDailySales > 0 ? Math.floor(currentStock / avgDailySales) : null;
      const suggestedQty = Math.max(0, Math.ceil(avgDailySales * coverageDays - (currentStock ?? 0)));
      const price = (pc?.price !== undefined && pc?.price !== null ? Number(pc.price) : vel?.price) ?? 0;
      return {
        sku: row.sku,
        productTitle: pc?.title ?? vel?.productTitle ?? row.sku,
        variantTitle: pc?.variantTitle ?? vel?.variantTitle ?? "",
        variantId: pc?.variantId ?? vel?.variantId ?? null,
        price,
        preseasonQty: row.qty,
        currentStock,
        avgDailySales,
        daysOfStock,
        suggestedQty,
        gap: row.qty - (currentStock ?? 0),
      };
    });

    return data({
      comparison,
      vendorId: vendorIdRaw,
      vendorName: vendor?.name ?? "",
      csvErrors: errors,
    });
  }

  // ── Create a draft PO from a preseason comparison analysis ──
  if (intent === "createPreseasonPO") {
    const vendorIdRaw = String(form.get("vendorId") ?? "").trim();
    let items: PreseasonComparisonRow[] = [];
    try {
      const parsed = JSON.parse(String(form.get("items") ?? "[]"));
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      return data({ error: "Invalid analysis data." }, { status: 400 });
    }
    if (!vendorIdRaw || items.length === 0) {
      return data({ error: "Missing vendor or items." }, { status: 400 });
    }

    const vendorId = Number(vendorIdRaw);
    const invoiceNumber = generateInvoiceNumber("PRE", vendorId);
    const inventoryItemIdMap = await resolveInventoryItemIds(items.map((i) => i.variantId));

    await db.$transaction(async (tx) => {
      const created = await tx.invoice.create({
        data: { invoiceNumber, vendorId, status: "ORDERED", total: 0 },
      });
      await tx.invoiceLineItem.createMany({
        data: items.map((item) => ({
          invoiceId: created.id,
          sku: item.sku || null,
          description: lineDescription(item.productTitle, item.variantTitle),
          quantityOrdered: item.preseasonQty,
          unitCost: 0,
          retailPrice: item.price || null,
          shopifyProductTitle: item.productTitle,
          shopifyVariantId: item.variantId,
          shopifyInventoryItemId: item.variantId ? inventoryItemIdMap.get(item.variantId) ?? null : null,
        })),
      });
    });

    return redirect("/invoices");
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins !== 1 ? "s" : ""} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs !== 1 ? "s" : ""} ago`;
  return `${Math.floor(hrs / 24)} day${Math.floor(hrs / 24) !== 1 ? "s" : ""} ago`;
}

function daysBadgeBg(days: number | null): string {
  if (days === null) return "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400";
  if (days < 7) return "bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300";
  if (days < 14) return "bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300";
  if (days < 30) return "bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300";
  return "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300";
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

type ActionData =
  | { error: string }
  | { csvError: string; csvErrors?: { row: number; message: string }[] }
  | { comparison: PreseasonComparisonRow[]; vendorId: string; vendorName: string; csvErrors: { row: number; message: string }[] };

// ─── Component ──────────────────────────────────────────────────────────────

export default function ReorderPage({ loaderData }: Route.ComponentProps) {
  const { groups, vendors, distinctTypes, filters, pagination, lastSync: initialLastSync } = loaderData;
  const [, setSearchParams] = useSearchParams();
  const navigation = useNavigation();
  const actionData = useActionData() as ActionData | undefined;
  const syncFetcher = useFetcher<SyncLogData>();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [qtyOverrides, setQtyOverrides] = useState<Record<string, number>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showImport, setShowImport] = useState(false);
  const [importVendorId, setImportVendorId] = useState("");
  const [comparison, setComparison] = useState<{ rows: PreseasonComparisonRow[]; vendorId: string; vendorName: string } | null>(null);
  const [lastSync, setLastSync] = useState<SyncLogData | null>(initialLastSync);

  const allVariantRows = useMemo(() => groups.flatMap((g) => g.variants), [groups]);

  // Reset selection when the underlying row set changes (filters/page/period),
  // pre-checking critical items: out of stock, or under a week of stock left.
  useEffect(() => {
    const critical = allVariantRows.filter(
      (r) => r.currentStock === 0 || (r.daysRemaining !== null && r.daysRemaining < 7)
    );
    setSelected(new Set(critical.map((r) => r.sku)));
    setQtyOverrides({});
  }, [allVariantRows]);

  useEffect(() => {
    if (actionData && "comparison" in actionData) {
      setComparison({ rows: actionData.comparison, vendorId: actionData.vendorId, vendorName: actionData.vendorName });
      setShowImport(false);
    }
  }, [actionData]);

  const isSubmitting = navigation.state === "submitting";
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

  function setFilter(key: "vendor" | "productType" | "period" | "maxDays", value: string) {
    const params = new URLSearchParams();
    const next = { ...filters, [key]: value };
    if (next.vendor) params.set("vendor", String(next.vendor));
    if (next.productType) params.set("productType", String(next.productType));
    params.set("period", String(next.period));
    params.set("maxDays", String(next.maxDays));
    params.set("coverageDays", String(next.coverageDays));
    setSearchParams(params);
  }

  function setCoverage(value: string) {
    const params = new URLSearchParams();
    const coverageDays = parseInt(value, 10) || DEFAULT_COVERAGE_DAYS;
    if (filters.vendor) params.set("vendor", filters.vendor);
    if (filters.productType) params.set("productType", filters.productType);
    params.set("period", coverageToPeriod(coverageDays));
    params.set("maxDays", String(filters.maxDays));
    params.set("coverageDays", String(coverageDays));
    setSearchParams(params);
  }

  function buildPageUrl(p: number) {
    const params = new URLSearchParams();
    if (filters.vendor) params.set("vendor", filters.vendor);
    if (filters.productType) params.set("productType", filters.productType);
    params.set("period", filters.period);
    params.set("maxDays", String(filters.maxDays));
    params.set("coverageDays", String(filters.coverageDays));
    params.set("page", String(p));
    return `?${params.toString()}`;
  }

  function toggleRow(sku: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku);
      else next.add(sku);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === allVariantRows.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(allVariantRows.map((r) => r.sku)));
    }
  }

  function toggleGroupVariants(group: ReorderProductGroup) {
    const groupSkus = group.variants.map((v) => v.sku);
    const allSelected = groupSkus.every((sku) => selected.has(sku));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const sku of groupSkus) next.delete(sku);
      } else {
        for (const sku of groupSkus) next.add(sku);
      }
      return next;
    });
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

  const selectedItems = useMemo(
    () =>
      allVariantRows
        .filter((r) => selected.has(r.sku))
        .map((r) => ({
          sku: r.sku,
          productTitle: r.productTitle,
          variantTitle: r.variantTitle,
          vendor: r.vendor,
          variantId: r.variantId,
          price: r.price,
          qty: qtyOverrides[r.sku] ?? r.suggestedQty,
        })),
    [allVariantRows, selected, qtyOverrides]
  );

  function exportComparisonPdf() {
    if (!comparison) return;
    sessionStorage.setItem(
      "preseasonAnalysis",
      JSON.stringify({ rows: comparison.rows, vendorName: comparison.vendorName, generatedAt: new Date().toISOString() })
    );
    window.open("/reorder/preseason-print", "_blank");
  }

  return (
    <main className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center gap-3 mb-2">
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Reorder</h2>
        <span className="text-xs text-gray-400 dark:text-gray-500">Items below your stock threshold, most urgent first</span>
        <button
          onClick={triggerSync}
          disabled={isSyncing}
          className="ml-auto text-sm font-medium px-4 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isSyncing ? "Syncing…" : "Resync"}
        </button>
        <button
          onClick={() => setShowImport((v) => !v)}
          className="text-sm font-medium px-4 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
        >
          Import Preseason CSV
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

      {/* Coverage period */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <label htmlFor="coverageDays" className="text-sm font-medium text-gray-600 dark:text-gray-300">
          Order enough stock to cover:
        </label>
        <select
          id="coverageDays"
          value={filters.coverageDays}
          onChange={(e) => setCoverage(e.target.value)}
          className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100"
        >
          {COVERAGE_OPTIONS.map((d) => (
            <option key={d} value={d}>{d} days</option>
          ))}
        </select>
        <span className="text-xs text-gray-400 dark:text-gray-500">
          Days of stock you want on hand after the order arrives · velocity lookback auto-set to {PERIOD_OPTIONS.find((p) => p.value === filters.period)?.label ?? filters.period} (override below)
        </span>
      </div>

      {/* Preseason CSV import panel */}
      {showImport && (
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm p-5 mb-6">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-3">Import Preseason Order</h3>
          <Form method="post" encType="multipart/form-data" className="flex flex-wrap gap-3 items-end">
            <input type="hidden" name="intent" value="importPreseasonCsv" />
            <input type="hidden" name="period" value={filters.period} />
            <input type="hidden" name="coverageDays" value={filters.coverageDays} />
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Vendor <span className="text-red-500">*</span></label>
              <select
                name="vendorId"
                required
                value={importVendorId}
                onChange={(e) => setImportVendorId(e.target.value)}
                className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100"
              >
                <option value="">Select vendor…</option>
                {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400">CSV File (columns: SKU, Quantity) <span className="text-red-500">*</span></label>
              <input type="file" name="csv" accept=".csv" required className="text-sm text-gray-600 dark:text-gray-300" />
            </div>
            <button type="submit" disabled={isSubmitting} className="text-sm font-medium px-4 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors disabled:opacity-50">
              {isSubmitting ? "Uploading…" : "Upload & Compare"}
            </button>
          </Form>
          {actionData && "csvError" in actionData && (
            <p className="mt-3 text-sm text-rose-600 dark:text-rose-400">{actionData.csvError}</p>
          )}
        </div>
      )}

      {/* Preseason comparison table */}
      {comparison && (
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden mb-6">
          <div className="px-5 py-3 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">
              Preseason Comparison — {comparison.vendorName} ({comparison.rows.length} SKUs)
            </span>
            <div className="flex gap-2">
              <button onClick={exportComparisonPdf} className="text-sm font-medium px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800">
                Export as PDF
              </button>
              <button onClick={() => setComparison(null)} className="text-sm text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300">
                Close
              </button>
            </div>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Product</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">SKU</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Preseason Qty</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Current Stock</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Avg Daily Sales</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Days of Stock</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Suggested Qty</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Gap</th>
              </tr>
            </thead>
            <tbody>
              {comparison.rows.map((row, i) => (
                <tr key={`${row.sku}-${i}`} className={i < comparison.rows.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : ""}>
                  <td className="px-5 py-3 text-gray-800 dark:text-gray-100 max-w-xs truncate">{row.productTitle}</td>
                  <td className="px-5 py-3 font-mono text-gray-600 dark:text-gray-300 text-xs">{row.sku}</td>
                  <td className="px-5 py-3 text-right text-gray-700 dark:text-gray-200">{row.preseasonQty}</td>
                  <td className="px-5 py-3 text-right text-gray-700 dark:text-gray-200">{row.currentStock ?? "—"}</td>
                  <td className="px-5 py-3 text-right text-gray-600 dark:text-gray-300">{row.avgDailySales.toFixed(2)}</td>
                  <td className="px-5 py-3 text-right">
                    <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full ${daysBadgeBg(row.daysOfStock)}`}>
                      {row.daysOfStock === null ? "∞" : row.daysOfStock + "d"}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right text-gray-700 dark:text-gray-200">{row.suggestedQty}</td>
                  <td className={`px-5 py-3 text-right font-medium ${row.gap > 0 ? "text-rose-600 dark:text-rose-400" : "text-gray-500 dark:text-gray-400"}`}>
                    {row.gap > 0 ? `+${row.gap}` : row.gap}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-5 py-3 border-t border-gray-200 dark:border-gray-700 flex justify-end">
            <Form method="post">
              <input type="hidden" name="intent" value="createPreseasonPO" />
              <input type="hidden" name="vendorId" value={comparison.vendorId} />
              <input type="hidden" name="items" value={JSON.stringify(comparison.rows)} />
              <button type="submit" disabled={isSubmitting} className="text-sm font-medium px-4 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors disabled:opacity-50">
                Create PO from this analysis
              </button>
            </Form>
          </div>
        </div>
      )}

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
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Below X days of stock</label>
          <input
            type="number"
            min={1}
            value={filters.maxDays}
            onChange={(e) => setFilter("maxDays", e.target.value || "30")}
            className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 w-24"
          />
        </div>
      </div>

      {/* Reorder table */}
      <Form method="post">
        <input type="hidden" name="intent" value="generatePOs" />
        <input type="hidden" name="items" value={JSON.stringify(selectedItems)} />

        {groups.length === 0 ? (
          <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm px-6 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
            No items below the selected stock threshold.
          </div>
        ) : (
          <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden">
            <div className="px-5 py-3 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400 flex items-center gap-4">
              <span>{pagination.totalCount} products · Page {pagination.page} of {pagination.totalPages}</span>
              <span className="ml-auto flex gap-2">
                <button type="button" onClick={expandAll} className="font-medium text-indigo-600 dark:text-indigo-400 hover:underline">Expand All</button>
                <button type="button" onClick={collapseAll} className="font-medium text-indigo-600 dark:text-indigo-400 hover:underline">Collapse All</button>
              </span>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                  <th className="px-5 py-3 w-8">
                    <input type="checkbox" checked={allVariantRows.length > 0 && selected.size === allVariantRows.length} onChange={toggleAll} />
                  </th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Product</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">SKU</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Vendor</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Current Stock</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Units Sold</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Avg Daily Sales</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Days of Stock</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Suggested Qty</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Qty Override</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group, gi) => {
                  const isExpanded = expanded.has(group.productTitle);
                  const isLastGroup = gi === groups.length - 1;
                  const groupSkus = group.variants.map((v) => v.sku);
                  const groupSelectedCount = groupSkus.filter((sku) => selected.has(sku)).length;
                  const groupAllSelected = groupSkus.length > 0 && groupSelectedCount === groupSkus.length;
                  const groupSomeSelected = groupSelectedCount > 0 && !groupAllSelected;
                  return (
                    <Fragment key={`${group.productTitle}-${gi}`}>
                      <tr className={!isLastGroup || isExpanded ? "border-b border-gray-100 dark:border-gray-700" : ""}>
                        <td className="px-5 py-3">
                          <input
                            type="checkbox"
                            checked={groupAllSelected}
                            ref={(el) => { if (el) el.indeterminate = groupSomeSelected; }}
                            onChange={() => toggleGroupVariants(group)}
                            aria-label="Select all variants"
                          />
                        </td>
                        <td className="px-5 py-3 text-gray-800 dark:text-gray-100 max-w-xs truncate">
                          <button
                            type="button"
                            onClick={() => toggleExpand(group.productTitle)}
                            aria-label={isExpanded ? "Collapse" : "Expand"}
                            className="mr-2 w-4 inline-block text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
                          >
                            {isExpanded ? "▼" : "▶"}
                          </button>
                          {group.productTitle}
                        </td>
                        <td className="px-5 py-3 font-mono text-gray-600 dark:text-gray-300 text-xs">
                          {group.variants.length === 1 ? group.variants[0].sku : `${group.variants.length} SKUs`}
                        </td>
                        <td className="px-5 py-3 text-gray-600 dark:text-gray-300">{group.vendor || "—"}</td>
                        <td className="px-5 py-3 text-right text-gray-700 dark:text-gray-200">{group.totalCurrentStock}</td>
                        <td className="px-5 py-3 text-right text-gray-700 dark:text-gray-200">{group.totalUnitsSold}</td>
                        <td className="px-5 py-3 text-right text-gray-600 dark:text-gray-300">{group.avgDaily.toFixed(2)}</td>
                        <td className="px-5 py-3 text-right">
                          <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full ${daysBadgeBg(group.daysRemaining)}`}>
                            {group.daysRemaining === null ? "∞" : group.daysRemaining + "d"}
                          </span>
                        </td>
                        <td className={`px-5 py-3 text-right ${group.totalSuggestedQty === 0 ? "text-gray-300 dark:text-gray-600" : "text-gray-700 dark:text-gray-200"}`}>{group.totalSuggestedQty}</td>
                        <td className="px-5 py-3 text-right text-gray-300 dark:text-gray-600">—</td>
                      </tr>
                      {isExpanded &&
                        group.variants.map((row, vi) => {
                          const isLastVariant = vi === group.variants.length - 1;
                          const breakdown = suggestedQtyBreakdown(filters.coverageDays, row.avgDaily, row.currentStock, row.suggestedQty);
                          return (
                            <tr
                              key={`${group.productTitle}-${gi}-variant-${vi}`}
                              className={`bg-gray-50/70 dark:bg-gray-800/40 ${!isLastGroup || !isLastVariant ? "border-b border-gray-100 dark:border-gray-700" : ""}`}
                            >
                              <td className="px-5 py-2">
                                <input type="checkbox" checked={selected.has(row.sku)} onChange={() => toggleRow(row.sku)} />
                              </td>
                              <td className="pl-12 pr-5 py-2 text-gray-600 dark:text-gray-300 text-xs truncate max-w-xs">
                                {row.variantTitle && row.variantTitle !== "Default Title" ? row.variantTitle : <span className="italic text-gray-400 dark:text-gray-500">—</span>}
                              </td>
                              <td className="px-5 py-2 font-mono text-gray-500 dark:text-gray-400 text-xs">{row.sku || "—"}</td>
                              <td className="px-5 py-2 text-gray-500 dark:text-gray-400 text-xs">—</td>
                              <td className="px-5 py-2 text-right text-gray-600 dark:text-gray-300 text-xs">{row.currentStock ?? "—"}</td>
                              <td className="px-5 py-2 text-right text-gray-600 dark:text-gray-300 text-xs">{row.unitsSold}</td>
                              <td className="px-5 py-2 text-right text-gray-500 dark:text-gray-400 text-xs">{row.avgDaily.toFixed(2)}</td>
                              <td className="px-5 py-2 text-right">
                                <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full ${daysBadgeBg(row.daysRemaining)}`}>
                                  {row.daysRemaining === null ? "∞" : row.daysRemaining + "d"}
                                </span>
                              </td>
                              <td className="px-5 py-2 text-right text-xs" title={breakdown}>
                                <span
                                  className={`cursor-help border-b border-dotted ${row.suggestedQty === 0 ? "text-gray-300 dark:text-gray-600 border-gray-300 dark:border-gray-600" : "text-gray-600 dark:text-gray-300 border-gray-400 dark:border-gray-500"}`}
                                >
                                  {row.suggestedQty}
                                </span>
                              </td>
                              <td className="px-5 py-2 text-right">
                                <input
                                  type="number"
                                  min={0}
                                  value={qtyOverrides[row.sku] ?? row.suggestedQty}
                                  onChange={(e) =>
                                    setQtyOverrides((prev) => ({ ...prev, [row.sku]: parseInt(e.target.value, 10) || 0 }))
                                  }
                                  className="w-20 text-sm text-right border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100"
                                />
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

        <div className="flex items-center justify-between mt-6">
          {actionData && "error" in actionData && (
            <p className="text-sm text-rose-600 dark:text-rose-400">{actionData.error}</p>
          )}
          <button
            type="submit"
            disabled={selected.size === 0 || isSubmitting}
            className="ml-auto text-sm font-medium px-5 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isSubmitting ? "Generating…" : `Generate Purchase Orders${selected.size > 0 ? ` (${selected.size})` : ""}`}
          </button>
        </div>
      </Form>
    </main>
  );
}
