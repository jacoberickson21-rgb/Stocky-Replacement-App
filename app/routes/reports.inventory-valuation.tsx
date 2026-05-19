import { Link, useSearchParams } from "react-router";
import { useState, useEffect } from "react";
import type { Route } from "./+types/reports.inventory-valuation";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";
import {
  getInventoryValuationData,
  getProductTypes,
} from "../services/shopify.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const db = getDb();
  const url = new URL(request.url);

  const vendorFilter = url.searchParams.get("vendor") ?? "";
  const productTypeFilter = url.searchParams.get("productType") ?? "";

  const [shopifyVariants, vendors, shopifyProductTypes] = await Promise.all([
    getInventoryValuationData({
      vendor: vendorFilter || undefined,
      productType: productTypeFilter || undefined,
    }),
    db.vendor.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    getProductTypes(),
  ]);

  // Most recent unit cost per SKU (or variantId) from InvoiceLineItem
  const costRows = await db.$queryRaw<{ sku: string | null; shopifyVariantId: string | null; unitCost: number }[]>`
    SELECT DISTINCT ON (COALESCE(li."shopifyVariantId", li.sku))
      li.sku,
      li."shopifyVariantId",
      li."unitCost"::float AS "unitCost"
    FROM "InvoiceLineItem" li
    WHERE li."unitCost" IS NOT NULL AND li."unitCost" > 0
    ORDER BY COALESCE(li."shopifyVariantId", li.sku), li.id DESC
  `;

  const costByVariantId = new Map<string, number>();
  const costBySku = new Map<string, number>();
  for (const r of costRows) {
    if (r.shopifyVariantId) costByVariantId.set(r.shopifyVariantId, r.unitCost);
    if (r.sku) costBySku.set(r.sku, r.unitCost);
  }

  const rows = shopifyVariants.map((v) => {
    const cost = costByVariantId.get(v.variantId) ?? costBySku.get(v.sku) ?? null;
    const costValue = cost != null ? cost * v.inventoryQuantity : null;
    const retailValue = v.price * v.inventoryQuantity;
    const margin =
      cost != null && v.price > 0
        ? ((v.price - cost) / v.price) * 100
        : null;
    return {
      variantId: v.variantId,
      productTitle: v.productTitle,
      vendor: v.vendor,
      productType: v.productType,
      sku: v.sku,
      qty: v.inventoryQuantity,
      cost,
      price: v.price,
      costValue,
      retailValue,
      margin,
    };
  });

  const withCost = rows.filter((r) => r.costValue != null);
  const totalCostValue = withCost.reduce((s, r) => s + (r.costValue ?? 0), 0);
  const totalRetailValue = rows.reduce((s, r) => s + r.retailValue, 0);
  const avgMargin =
    withCost.length > 0
      ? withCost.reduce((s, r) => s + (r.margin ?? 0), 0) / withCost.length
      : 0;

  return {
    rows,
    vendors,
    shopifyProductTypes,
    summary: { totalCostValue, totalRetailValue, avgMargin },
    filters: { vendor: vendorFilter, productType: productTypeFilter },
    totalVariants: shopifyVariants.length,
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
  productTitle: string;
  sku: string;
  vendor: string;
  productType: string;
  qty: number;
  cost: number | null;
  price: number;
  costValue: number | null;
  retailValue: number;
  margin: number | null;
};

function exportCsv(rows: InvRow[]) {
  const headers = ["Product", "SKU", "Vendor", "Product Type", "Qty", "Cost", "Retail", "Cost Value", "Retail Value", "Margin%"];
  const data = rows.map((r) => [
    r.productTitle,
    r.sku,
    r.vendor,
    r.productType,
    r.qty,
    r.cost?.toFixed(2) ?? "",
    r.price.toFixed(2),
    r.costValue?.toFixed(2) ?? "",
    r.retailValue.toFixed(2),
    r.margin?.toFixed(1) ?? "",
  ]);
  const csv = [headers, ...data].map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "inventory-valuation.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export default function InventoryValuationPage({ loaderData }: Route.ComponentProps) {
  const { rows, vendors, shopifyProductTypes, summary, filters } = loaderData;
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

  return (
    <main className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link to="/reports" className="text-sm text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300">← Reports</Link>
          <span className="text-gray-300 dark:text-gray-600">/</span>
          <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Inventory Valuation</h2>
        </div>
        <ClientOnly>
          {() => (
            <button
              onClick={() => exportCsv(rows)}
              className="flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export CSV
            </button>
          )}
        </ClientOnly>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-emerald-200 dark:border-emerald-900 shadow-sm p-5">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Total Cost Value</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">{fmt$(summary.totalCostValue)}</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">at most recent invoice cost</p>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-indigo-200 dark:border-indigo-900 shadow-sm p-5">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Total Retail Value</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">{fmt$(summary.totalRetailValue)}</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">at current Shopify prices</p>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-amber-200 dark:border-amber-900 shadow-sm p-5">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Avg Potential Margin</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">{summary.avgMargin.toFixed(1)}%</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">on items with known cost</p>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm p-4 mb-4 flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Vendor (Shopify)</label>
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
        <button onClick={applyFilters}
          className="text-sm font-medium px-4 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors">
          Apply
        </button>
        {(filters.vendor || filters.productType) && (
          <button onClick={clearFilters}
            className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors">
            Clear
          </button>
        )}
      </div>

      {/* Table */}
      {rows.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm px-6 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
          No products found.
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden">
          <div className="px-5 py-3 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
            {rows.length} variants · Cost data from most recent received invoice per SKU
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
    </main>
  );
}
