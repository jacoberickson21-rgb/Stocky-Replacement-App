import { Link, useSearchParams } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/reports.receiving-history";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";
import { Prisma } from "@prisma/client";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const db = getDb();
  const url = new URL(request.url);

  const vendorId = url.searchParams.get("vendorId") ?? "";
  const staffId = url.searchParams.get("staffId") ?? "";
  const startDate = url.searchParams.get("startDate") ?? "";
  const endDate = url.searchParams.get("endDate") ?? "";

  const now = new Date();
  const defaultStart = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const start = startDate ? new Date(startDate) : defaultStart;
  const end = endDate ? new Date(endDate + "T23:59:59") : now;

  const [vendors, users] = await Promise.all([
    db.vendor.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.user.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);

  const vendorCond = vendorId
    ? Prisma.sql`AND i."vendorId" = ${parseInt(vendorId)}`
    : Prisma.sql``;

  const staffCond = staffId
    ? Prisma.sql`AND EXISTS (
        SELECT 1 FROM "AuditLog" al
        WHERE al.action = 'INVOICE_RECEIVED'
          AND al."userId" = ${parseInt(staffId)}
          AND al.details LIKE 'Invoice #' || i."invoiceNumber" || ' %'
      )`
    : Prisma.sql``;

  const rows = await db.$queryRaw<{
    id: number;
    invoiceNumber: string;
    vendorName: string;
    total: number;
    receivedAt: Date;
    staffName: string | null;
    itemCount: number;
    discrepancyCount: number;
  }[]>`
    SELECT
      i.id,
      i."invoiceNumber",
      v.name AS "vendorName",
      i.total::float,
      i."updatedAt" AS "receivedAt",
      (
        SELECT u.name
        FROM "AuditLog" al
        JOIN "User" u ON u.id = al."userId"
        WHERE al.action = 'INVOICE_RECEIVED'
          AND al.details LIKE 'Invoice #' || i."invoiceNumber" || ' %'
        LIMIT 1
      ) AS "staffName",
      COUNT(DISTINCT li.id)::int AS "itemCount",
      COUNT(DISTINCT dl.id)::int AS "discrepancyCount"
    FROM "Invoice" i
    JOIN "Vendor" v ON v.id = i."vendorId"
    LEFT JOIN "InvoiceLineItem" li ON li."invoiceId" = i.id
    LEFT JOIN "DiscrepancyLog" dl ON dl."invoiceId" = i.id
    WHERE i.status IN ('RECEIVED','PAID')
      AND i."updatedAt" >= ${start}
      AND i."updatedAt" <= ${end}
      ${vendorCond}
      ${staffCond}
    GROUP BY i.id, v.name
    ORDER BY i."updatedAt" DESC
  `;

  const totalValue = rows.reduce((s, r) => s + r.total, 0);
  const totalDiscrepancies = rows.reduce((s, r) => s + r.discrepancyCount, 0);

  return {
    rows: rows.map((r) => ({
      ...r,
      total: r.total,
      receivedAt: r.receivedAt.toISOString(),
    })),
    vendors,
    users,
    summary: { count: rows.length, totalValue, totalDiscrepancies },
    filters: { vendorId, staffId, startDate, endDate },
  };
}

function fmt$(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function ReceivingHistoryPage({ loaderData }: Route.ComponentProps) {
  const { rows, vendors, users, summary, filters } = loaderData;
  const [, setSearchParams] = useSearchParams();
  const [localVendor, setLocalVendor] = useState(filters.vendorId);
  const [localStaff, setLocalStaff] = useState(filters.staffId);
  const [localStart, setLocalStart] = useState(filters.startDate);
  const [localEnd, setLocalEnd] = useState(filters.endDate);

  function applyFilters() {
    const p = new URLSearchParams();
    if (localVendor) p.set("vendorId", localVendor);
    if (localStaff) p.set("staffId", localStaff);
    if (localStart) p.set("startDate", localStart);
    if (localEnd) p.set("endDate", localEnd);
    setSearchParams(p);
  }

  function clearFilters() {
    setLocalVendor(""); setLocalStaff(""); setLocalStart(""); setLocalEnd("");
    setSearchParams(new URLSearchParams());
  }

  return (
    <main className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link to="/reports" className="text-sm text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300">← Reports</Link>
        <span className="text-gray-300 dark:text-gray-600">/</span>
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Receiving History</h2>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-indigo-200 dark:border-indigo-900 shadow-sm p-5">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Shipments</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">{summary.count}</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">received in range</p>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-emerald-200 dark:border-emerald-900 shadow-sm p-5">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Total Value</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">{fmt$(summary.totalValue)}</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">received goods</p>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-amber-200 dark:border-amber-900 shadow-sm p-5">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Total Discrepancies</p>
          <p className={`text-2xl font-bold ${summary.totalDiscrepancies > 0 ? "text-amber-600 dark:text-amber-400" : "text-gray-900 dark:text-white"}`}>
            {summary.totalDiscrepancies}
          </p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">line items flagged</p>
        </div>
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
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Staff member</label>
          <select value={localStaff} onChange={(e) => setLocalStaff(e.target.value)}
            className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100">
            <option value="">All staff</option>
            {users.map((u) => <option key={u.id} value={String(u.id)}>{u.name}</option>)}
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
        {(filters.vendorId || filters.staffId || filters.startDate || filters.endDate) && (
          <button onClick={clearFilters}
            className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors">
            Clear
          </button>
        )}
      </div>

      {/* Table */}
      {rows.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm px-6 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
          No received shipments in this range.
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Date Received</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Invoice #</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Vendor</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Staff</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Items</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Discrepancies</th>
                <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Total Value</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={row.id}
                  className={`hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors ${i < rows.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : ""}`}
                >
                  <td className="px-5 py-3 text-gray-600 dark:text-gray-300">{fmtDate(row.receivedAt)}</td>
                  <td className="px-5 py-3">
                    <Link
                      to={`/invoices/${row.id}`}
                      className="text-indigo-600 dark:text-indigo-400 hover:underline font-medium"
                    >
                      {row.invoiceNumber}
                    </Link>
                  </td>
                  <td className="px-5 py-3 text-gray-700 dark:text-gray-200">{row.vendorName}</td>
                  <td className="px-5 py-3 text-gray-600 dark:text-gray-300">
                    {row.staffName ?? <span className="text-gray-400 dark:text-gray-500">—</span>}
                  </td>
                  <td className="px-5 py-3 text-right text-gray-700 dark:text-gray-200">{row.itemCount}</td>
                  <td className={`px-5 py-3 text-right font-medium ${row.discrepancyCount > 0 ? "text-amber-600 dark:text-amber-400" : "text-gray-400 dark:text-gray-500"}`}>
                    {row.discrepancyCount > 0 ? row.discrepancyCount : "—"}
                  </td>
                  <td className="px-5 py-3 text-right font-medium text-gray-800 dark:text-gray-100">{fmt$(row.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
