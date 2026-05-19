import { Link, useSearchParams } from "react-router";
import { useState } from "react";
import React from "react";
import type { Route } from "./+types/reports.vendor-performance";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";
import { Prisma } from "@prisma/client";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const db = getDb();
  const url = new URL(request.url);

  const vendorId = url.searchParams.get("vendorId") ?? "";
  const startDate = url.searchParams.get("startDate") ?? "";
  const endDate = url.searchParams.get("endDate") ?? "";

  const now = new Date();
  const defaultStart = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const start = startDate ? new Date(startDate) : defaultStart;
  const end = endDate ? new Date(endDate + "T23:59:59") : now;

  const vendors = await db.vendor.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  const vendorConditions: Prisma.Sql[] = [];
  if (vendorId) {
    vendorConditions.push(Prisma.sql`AND v.id = ${parseInt(vendorId)}`);
  }
  const vendorWhere = vendorConditions.length
    ? vendorConditions[0]
    : Prisma.sql``;

  const metrics = await db.$queryRaw<{
    vendorId: number;
    vendorName: string;
    totalSpend: number;
    invoiceCount: number;
    avgOrderCycleDays: number;
    outstandingBalance: number;
    totalCredits: number;
    discrepancyCount: number;
    totalLineItems: number;
  }[]>`
    WITH spend AS (
      SELECT
        v.id,
        v.name,
        COALESCE(SUM(i.total) FILTER (WHERE i.status IN ('RECEIVED','PAID')), 0)::float AS total_spend,
        COUNT(DISTINCT i.id) FILTER (WHERE i."updatedAt" >= ${start} AND i."updatedAt" <= ${end})::int AS invoice_count,
        COALESCE(
          AVG(EXTRACT(epoch FROM (i."updatedAt" - i."invoiceDate")) / 86400.0)
          FILTER (WHERE i.status IN ('RECEIVED','PAID') AND i."invoiceDate" IS NOT NULL
                    AND i."updatedAt" >= ${start} AND i."updatedAt" <= ${end}),
          0
        )::float AS avg_cycle,
        COALESCE(SUM(i.total) FILTER (WHERE i.status = 'RECEIVED'), 0)::float AS outstanding
      FROM "Vendor" v
      LEFT JOIN "Invoice" i ON i."vendorId" = v.id
        AND i."updatedAt" >= ${start} AND i."updatedAt" <= ${end}
      GROUP BY v.id, v.name
    ),
    credits AS (
      SELECT "vendorId", COALESCE(SUM(amount), 0)::float AS total_credits
      FROM "Credit"
      GROUP BY "vendorId"
    ),
    disc AS (
      SELECT
        dl."vendorId",
        COUNT(DISTINCT dl.id)::int AS disc_count,
        COUNT(DISTINCT li.id)::int AS line_count
      FROM "DiscrepancyLog" dl
      JOIN "Invoice" i ON i.id = dl."invoiceId"
        AND i."updatedAt" >= ${start} AND i."updatedAt" <= ${end}
      JOIN "InvoiceLineItem" li ON li."invoiceId" = i.id
      GROUP BY dl."vendorId"
    )
    SELECT
      s.id AS "vendorId",
      s.name AS "vendorName",
      s.total_spend AS "totalSpend",
      s.invoice_count AS "invoiceCount",
      s.avg_cycle AS "avgOrderCycleDays",
      GREATEST(s.outstanding - COALESCE(c.total_credits, 0), 0) AS "outstandingBalance",
      COALESCE(c.total_credits, 0) AS "totalCredits",
      COALESCE(d.disc_count, 0) AS "discrepancyCount",
      COALESCE(d.line_count, 0) AS "totalLineItems"
    FROM spend s
    LEFT JOIN credits c ON c."vendorId" = s.id
    LEFT JOIN disc d ON d."vendorId" = s.id
    WHERE s.invoice_count > 0
    ${vendorWhere}
    ORDER BY s.total_spend DESC
  `;

  // Per-vendor invoice breakdown for expanded rows
  const invoiceRows = await db.$queryRaw<{
    invoiceId: number;
    vendorId: number;
    invoiceNumber: string;
    status: string;
    total: number;
    invoiceDate: Date | null;
    updatedAt: Date;
    discrepancyCount: number;
  }[]>`
    SELECT
      i.id AS "invoiceId",
      i."vendorId",
      i."invoiceNumber",
      i.status,
      i.total::float,
      i."invoiceDate",
      i."updatedAt",
      COUNT(dl.id)::int AS "discrepancyCount"
    FROM "Invoice" i
    LEFT JOIN "DiscrepancyLog" dl ON dl."invoiceId" = i.id
    WHERE i."updatedAt" >= ${start} AND i."updatedAt" <= ${end}
      ${vendorId ? Prisma.sql`AND i."vendorId" = ${parseInt(vendorId)}` : Prisma.sql``}
    GROUP BY i.id
    ORDER BY i."updatedAt" DESC
  `;

  const invoicesByVendor = new Map<number, typeof invoiceRows>();
  for (const row of invoiceRows) {
    const existing = invoicesByVendor.get(row.vendorId) ?? [];
    existing.push(row);
    invoicesByVendor.set(row.vendorId, existing);
  }

  return {
    metrics,
    invoicesByVendor: Object.fromEntries(
      Array.from(invoicesByVendor.entries()).map(([k, v]) => [
        k,
        v.map((r) => ({
          ...r,
          invoiceDate: r.invoiceDate?.toISOString() ?? null,
          updatedAt: r.updatedAt.toISOString(),
        })),
      ])
    ),
    vendors,
    filters: { vendorId, startDate, endDate },
    dateRange: { start: start.toISOString(), end: end.toISOString() },
  };
}

function fmt$(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const STATUS_PILL: Record<string, string> = {
  ORDERED: "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300",
  RECEIVED: "bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300",
  PAID: "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300",
};

type SortKey = "totalSpend" | "invoiceCount" | "discrepancyRate" | "avgOrderCycleDays" | "outstandingBalance";

export default function VendorPerformancePage({ loaderData }: Route.ComponentProps) {
  const { metrics, invoicesByVendor, vendors, filters } = loaderData;
  const [, setSearchParams] = useSearchParams();
  const [localVendor, setLocalVendor] = useState(filters.vendorId);
  const [localStart, setLocalStart] = useState(filters.startDate);
  const [localEnd, setLocalEnd] = useState(filters.endDate);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("totalSpend");
  const [sortAsc, setSortAsc] = useState(false);

  function applyFilters() {
    const p = new URLSearchParams();
    if (localVendor) p.set("vendorId", localVendor);
    if (localStart) p.set("startDate", localStart);
    if (localEnd) p.set("endDate", localEnd);
    setSearchParams(p);
  }

  function clearFilters() {
    setLocalVendor(""); setLocalStart(""); setLocalEnd("");
    setSearchParams(new URLSearchParams());
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(false); }
  }

  function toggleExpand(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const sorted = [...metrics].sort((a, b) => {
    let av = 0, bv = 0;
    if (sortKey === "totalSpend") { av = a.totalSpend; bv = b.totalSpend; }
    else if (sortKey === "invoiceCount") { av = a.invoiceCount; bv = b.invoiceCount; }
    else if (sortKey === "discrepancyRate") {
      av = a.totalLineItems > 0 ? a.discrepancyCount / a.totalLineItems : 0;
      bv = b.totalLineItems > 0 ? b.discrepancyCount / b.totalLineItems : 0;
    }
    else if (sortKey === "avgOrderCycleDays") { av = a.avgOrderCycleDays; bv = b.avgOrderCycleDays; }
    else if (sortKey === "outstandingBalance") { av = a.outstandingBalance; bv = b.outstandingBalance; }
    return sortAsc ? av - bv : bv - av;
  });

  function Th({ label, k }: { label: string; k: SortKey }) {
    const active = sortKey === k;
    return (
      <th
        onClick={() => toggleSort(k)}
        className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400 cursor-pointer select-none hover:text-gray-800 dark:hover:text-gray-200"
      >
        {label} {active ? (sortAsc ? "↑" : "↓") : ""}
      </th>
    );
  }

  return (
    <main className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link to="/reports" className="text-sm text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300">← Reports</Link>
        <span className="text-gray-300 dark:text-gray-600">/</span>
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Vendor Performance</h2>
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm p-4 mb-4 flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Vendor</label>
          <select value={localVendor} onChange={(e) => setLocalVendor(e.target.value)}
            className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100">
            <option value="">All vendors</option>
            {vendors.map((v) => <option key={v.id} value={String(v.id)}>{v.name}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">From</label>
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
        {(filters.vendorId || filters.startDate || filters.endDate) && (
          <button onClick={clearFilters}
            className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors">
            Clear
          </button>
        )}
      </div>

      {sorted.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm px-6 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
          No vendor activity in this date range.
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Vendor</th>
                <Th label="Total Spend" k="totalSpend" />
                <Th label="Invoices" k="invoiceCount" />
                <Th label="Disc. Rate" k="discrepancyRate" />
                <Th label="Avg Cycle (days)" k="avgOrderCycleDays" />
                <Th label="Outstanding" k="outstandingBalance" />
                <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Credits</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((row, i) => {
                const discRate = row.totalLineItems > 0
                  ? ((row.discrepancyCount / row.totalLineItems) * 100).toFixed(1) + "%"
                  : "0%";
                const isExpanded = expanded.has(row.vendorId);
                const invoices = invoicesByVendor[row.vendorId] ?? [];
                return (
                  <React.Fragment key={row.vendorId}>
                    <tr
                      onClick={() => toggleExpand(row.vendorId)}
                      className={[
                        "cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors",
                        i < sorted.length - 1 && !isExpanded ? "border-b border-gray-100 dark:border-gray-700" : "",
                      ].join(" ")}
                    >
                      <td className="px-5 py-3 font-medium text-gray-800 dark:text-gray-100">{row.vendorName}</td>
                      <td className="px-5 py-3 text-right text-gray-700 dark:text-gray-200">{fmt$(row.totalSpend)}</td>
                      <td className="px-5 py-3 text-right text-gray-600 dark:text-gray-300">{row.invoiceCount}</td>
                      <td className={`px-5 py-3 text-right font-medium ${
                        row.discrepancyCount > 0 ? "text-amber-600 dark:text-amber-400" : "text-gray-500 dark:text-gray-400"
                      }`}>{discRate}</td>
                      <td className="px-5 py-3 text-right text-gray-600 dark:text-gray-300">
                        {row.avgOrderCycleDays > 0 ? row.avgOrderCycleDays.toFixed(1) : "—"}
                      </td>
                      <td className={`px-5 py-3 text-right font-medium ${
                        row.outstandingBalance > 0 ? "text-rose-600 dark:text-rose-400" : "text-gray-500 dark:text-gray-400"
                      }`}>{fmt$(row.outstandingBalance)}</td>
                      <td className="px-5 py-3 text-right text-emerald-600 dark:text-emerald-400">
                        {row.totalCredits > 0 ? fmt$(row.totalCredits) : "—"}
                      </td>
                      <td className="px-5 py-3 text-gray-400 dark:text-gray-500 text-right">
                        {isExpanded ? "▲" : "▼"}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="border-b border-gray-100 dark:border-gray-700">
                        <td colSpan={8} className="px-6 py-4 bg-gray-50 dark:bg-gray-800/40">
                          {invoices.length === 0 ? (
                            <p className="text-sm text-gray-400 dark:text-gray-500">No invoices in this range.</p>
                          ) : (
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-gray-500 dark:text-gray-400">
                                  <th className="text-left pb-2 pr-4">Invoice #</th>
                                  <th className="text-left pb-2 pr-4">Status</th>
                                  <th className="text-left pb-2 pr-4">Invoice Date</th>
                                  <th className="text-left pb-2 pr-4">Received</th>
                                  <th className="text-right pb-2 pr-4">Total</th>
                                  <th className="text-right pb-2">Discrepancies</th>
                                </tr>
                              </thead>
                              <tbody>
                                {invoices.map((inv) => (
                                  <tr key={inv.invoiceId} className="border-t border-gray-200 dark:border-gray-700">
                                    <td className="py-1.5 pr-4">
                                      <Link to={`/invoices/${inv.invoiceId}`} className="text-indigo-600 dark:text-indigo-400 hover:underline">
                                        {inv.invoiceNumber}
                                      </Link>
                                    </td>
                                    <td className="py-1.5 pr-4">
                                      <span className={`inline-block px-1.5 py-0.5 rounded-full text-xs font-medium ${STATUS_PILL[inv.status] ?? ""}`}>
                                        {inv.status}
                                      </span>
                                    </td>
                                    <td className="py-1.5 pr-4 text-gray-600 dark:text-gray-300">{fmtDate(inv.invoiceDate)}</td>
                                    <td className="py-1.5 pr-4 text-gray-600 dark:text-gray-300">{fmtDate(inv.updatedAt)}</td>
                                    <td className="py-1.5 pr-4 text-right text-gray-700 dark:text-gray-200">{fmt$(inv.total)}</td>
                                    <td className={`py-1.5 text-right font-medium ${inv.discrepancyCount > 0 ? "text-amber-600 dark:text-amber-400" : "text-gray-400 dark:text-gray-500"}`}>
                                      {inv.discrepancyCount > 0 ? inv.discrepancyCount : "—"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
