import { Link, useSearchParams } from "react-router";
import { useState, useEffect } from "react";
import type { Route } from "./+types/reports.spend-analysis";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";
import { Prisma } from "@prisma/client";
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, Tooltip, CartesianGrid,
  ResponsiveContainer,
} from "recharts";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const db = getDb();
  const url = new URL(request.url);

  const vendorId = url.searchParams.get("vendorId") ?? "";
  const startDate = url.searchParams.get("startDate") ?? "";
  const endDate = url.searchParams.get("endDate") ?? "";
  const statusFilter = url.searchParams.get("status") ?? "";

  const now = new Date();
  const defaultStart = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const start = startDate ? new Date(startDate) : defaultStart;
  const end = endDate ? new Date(endDate + "T23:59:59") : now;

  const dayRange = Math.ceil((end.getTime() - start.getTime()) / 86400000);
  const truncUnit = dayRange <= 31 ? "day" : dayRange <= 180 ? "week" : "month";

  const vendors = await db.vendor.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  const vendorCond = vendorId
    ? Prisma.sql`AND i."vendorId" = ${parseInt(vendorId)}`
    : Prisma.sql``;
  const statusCond = statusFilter
    ? Prisma.sql`AND i.status = ${statusFilter}`
    : Prisma.sql`AND i.status IN ('RECEIVED','PAID','ORDERED')`;

  const [spendOverTime, spendByVendor, monthlySpend, invoices] = await Promise.all([
    db.$queryRaw<{ bucket: Date; total: number }[]>`
      SELECT DATE_TRUNC(${truncUnit}, i."updatedAt") AS bucket, SUM(i.total)::float AS total
      FROM "Invoice" i
      WHERE i."updatedAt" >= ${start} AND i."updatedAt" <= ${end}
        AND i.status IN ('RECEIVED','PAID')
        ${vendorCond}
      GROUP BY bucket
      ORDER BY bucket ASC
    `,

    db.$queryRaw<{ vendorName: string; total: number }[]>`
      SELECT v.name AS "vendorName", SUM(i.total)::float AS total
      FROM "Invoice" i
      JOIN "Vendor" v ON v.id = i."vendorId"
      WHERE i."updatedAt" >= ${start} AND i."updatedAt" <= ${end}
        AND i.status IN ('RECEIVED','PAID')
        ${vendorCond}
      GROUP BY v.name
      ORDER BY total DESC
      LIMIT 15
    `,

    // Monthly spend for last 24 months for comparison view
    db.$queryRaw<{ month: Date; total: number }[]>`
      SELECT DATE_TRUNC('month', i."updatedAt") AS month, SUM(i.total)::float AS total
      FROM "Invoice" i
      WHERE i."updatedAt" >= ${new Date(now.getFullYear() - 1, now.getMonth() - 11, 1)}
        AND i.status IN ('RECEIVED','PAID')
        ${vendorCond}
      GROUP BY month
      ORDER BY month ASC
    `,

    db.$queryRaw<{
      id: number;
      invoiceNumber: string;
      vendorName: string;
      total: number;
      status: string;
      updatedAt: Date;
      invoiceDate: Date | null;
    }[]>`
      SELECT
        i.id,
        i."invoiceNumber",
        v.name AS "vendorName",
        i.total::float,
        i.status,
        i."updatedAt",
        i."invoiceDate"
      FROM "Invoice" i
      JOIN "Vendor" v ON v.id = i."vendorId"
      WHERE i."updatedAt" >= ${start} AND i."updatedAt" <= ${end}
        ${vendorCond}
        ${statusCond}
      ORDER BY i."updatedAt" DESC
    `,
  ]);

  const totalSpend = invoices
    .filter((r) => ["RECEIVED", "PAID"].includes(r.status))
    .reduce((s, r) => s + r.total, 0);

  return {
    spendOverTime: spendOverTime.map((r) => ({ bucket: r.bucket.toISOString(), total: r.total })),
    spendByVendor: spendByVendor.map((r) => ({ name: r.vendorName, total: r.total })),
    monthlySpend: monthlySpend.map((r) => ({
      month: r.month.toISOString(),
      total: r.total,
      label: r.month.toLocaleDateString("en-US", { month: "short", year: "2-digit" }),
    })),
    invoices: invoices.map((r) => ({
      id: r.id,
      invoiceNumber: r.invoiceNumber,
      vendorName: r.vendorName,
      total: r.total,
      status: r.status,
      updatedAt: r.updatedAt.toISOString(),
      invoiceDate: r.invoiceDate?.toISOString() ?? null,
    })),
    vendors,
    totalSpend,
    truncUnit,
    filters: { vendorId, startDate, endDate, status: statusFilter },
  };
}

function fmt$(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtBucket(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function ClientOnly({ children }: { children: () => React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return <>{children()}</>;
}

function useIsDark() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
    const obs = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains("dark"))
    );
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

const STATUS_PILL: Record<string, string> = {
  ORDERED: "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300",
  RECEIVED: "bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300",
  PAID: "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300",
};

function exportCsv(invoices: { invoiceNumber: string; vendorName: string; total: number; status: string; updatedAt: string }[]) {
  const headers = ["Invoice #", "Vendor", "Amount", "Status", "Date"];
  const rows = invoices.map((r) => [r.invoiceNumber, r.vendorName, r.total.toFixed(2), r.status, fmtDate(r.updatedAt)]);
  const csv = [headers, ...rows].map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "spend-analysis.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export default function SpendAnalysisPage({ loaderData }: Route.ComponentProps) {
  const { spendOverTime, spendByVendor, monthlySpend, invoices, vendors, totalSpend, filters } = loaderData;
  const [, setSearchParams] = useSearchParams();
  const [localVendor, setLocalVendor] = useState(filters.vendorId);
  const [localStart, setLocalStart] = useState(filters.startDate);
  const [localEnd, setLocalEnd] = useState(filters.endDate);
  const [localStatus, setLocalStatus] = useState(filters.status);
  const isDark = useIsDark();

  function applyFilters() {
    const p = new URLSearchParams();
    if (localVendor) p.set("vendorId", localVendor);
    if (localStart) p.set("startDate", localStart);
    if (localEnd) p.set("endDate", localEnd);
    if (localStatus) p.set("status", localStatus);
    setSearchParams(p);
  }

  function clearFilters() {
    setLocalVendor(""); setLocalStart(""); setLocalEnd(""); setLocalStatus("");
    setSearchParams(new URLSearchParams());
  }

  const textColor = isDark ? "#9ca3af" : "#6b7280";
  const gridColor = isDark ? "#374151" : "#e5e7eb";
  const tooltipStyle = { background: isDark ? "#1f2937" : "#fff", border: "none", borderRadius: 8, fontSize: 12 };

  return (
    <main className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link to="/reports" className="text-sm text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300">← Reports</Link>
          <span className="text-gray-300 dark:text-gray-600">/</span>
          <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Spend Analysis</h2>
        </div>
        <ClientOnly>
          {() => (
            <button
              onClick={() => exportCsv(invoices)}
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

      {/* Summary */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-indigo-200 dark:border-indigo-900 shadow-sm p-5">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Total Spend (received/paid)</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">{fmt$(totalSpend)}</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">in selected date range</p>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm p-5">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Invoices</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">{invoices.length}</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">matching current filters</p>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm p-4 mb-6 flex flex-wrap gap-3 items-end">
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
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Status</label>
          <select value={localStatus} onChange={(e) => setLocalStatus(e.target.value)}
            className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100">
            <option value="">All statuses</option>
            <option value="ORDERED">Ordered</option>
            <option value="RECEIVED">Received</option>
            <option value="PAID">Paid</option>
          </select>
        </div>
        <button onClick={applyFilters}
          className="text-sm font-medium px-4 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors">
          Apply
        </button>
        {(filters.vendorId || filters.startDate || filters.endDate || filters.status) && (
          <button onClick={clearFilters}
            className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors">
            Clear
          </button>
        )}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <div className="lg:col-span-2 bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm p-4">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-3">Spend Over Time</p>
          <ClientOnly>
            {() => spendOverTime.length === 0 ? (
              <p className="text-sm text-gray-400 dark:text-gray-500 py-8 text-center">No data in range</p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={spendOverTime} margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                  <defs>
                    <linearGradient id="spendGradSA" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                  <XAxis dataKey="bucket" tickFormatter={fmtBucket} tick={{ fill: textColor, fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} tick={{ fill: textColor, fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(v) => fmt$(Number(v))} labelFormatter={(l) => fmtBucket(String(l))} contentStyle={tooltipStyle} />
                  <Area type="monotone" dataKey="total" stroke="#6366f1" strokeWidth={2} fill="url(#spendGradSA)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </ClientOnly>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm p-4">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-3">By Vendor</p>
          <ClientOnly>
            {() => spendByVendor.length === 0 ? (
              <p className="text-sm text-gray-400 dark:text-gray-500 py-8 text-center">No data</p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={spendByVendor} layout="vertical" margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={gridColor} horizontal={false} />
                  <XAxis type="number" tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} tick={{ fill: textColor, fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="name" width={90} tick={{ fill: textColor, fontSize: 10 }} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(v) => fmt$(Number(v))} contentStyle={tooltipStyle} />
                  <Bar dataKey="total" fill="#6366f1" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </ClientOnly>
        </div>
      </div>

      {/* Monthly Comparison */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm p-4 mb-6">
        <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-3">Monthly Spend (last 24 months)</p>
        <ClientOnly>
          {() => monthlySpend.length === 0 ? (
            <p className="text-sm text-gray-400 dark:text-gray-500 py-8 text-center">No data</p>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={monthlySpend} margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridColor} vertical={false} />
                <XAxis dataKey="label" tick={{ fill: textColor, fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} tick={{ fill: textColor, fontSize: 10 }} axisLine={false} tickLine={false} />
                <Tooltip formatter={(v) => fmt$(Number(v))} contentStyle={tooltipStyle} />
                <Bar dataKey="total" fill="#818cf8" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ClientOnly>
      </div>

      {/* Invoice Table */}
      <section>
        <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
          Invoices in Range ({invoices.length})
        </h3>
        {invoices.length === 0 ? (
          <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm px-6 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
            No invoices match the current filters.
          </div>
        ) : (
          <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                  <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Invoice #</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Vendor</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Status</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Date</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Amount</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv, i) => (
                  <tr key={inv.id} className={i < invoices.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : ""}>
                    <td className="px-5 py-3">
                      <Link to={`/invoices/${inv.id}`} className="text-indigo-600 dark:text-indigo-400 hover:underline font-medium">
                        {inv.invoiceNumber}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-gray-600 dark:text-gray-300">{inv.vendorName}</td>
                    <td className="px-5 py-3">
                      <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_PILL[inv.status] ?? ""}`}>
                        {inv.status}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-gray-500 dark:text-gray-400">{fmtDate(inv.updatedAt)}</td>
                    <td className="px-5 py-3 text-right font-medium text-gray-800 dark:text-gray-100">{fmt$(inv.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
