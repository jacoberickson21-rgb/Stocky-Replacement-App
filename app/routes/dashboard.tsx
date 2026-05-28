import { Link, useSearchParams } from "react-router";
import { useEffect, useState } from "react";
import type { Route } from "./+types/dashboard";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";
import { getProductTypes } from "../services/shopify.server";
import { Prisma } from "@prisma/client";

// ─── Loader ───────────────────────────────────────────────────────────────────

type Period = "week" | "month" | "quarter" | "year";

function periodStart(period: Period): Date {
  const now = new Date();
  switch (period) {
    case "week":
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case "month":
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    case "quarter":
      return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    case "year":
      return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  }
}

function truncUnit(period: Period): string {
  if (period === "week") return "day";
  if (period === "month") return "week";
  return "month";
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const db = getDb();
  const url = new URL(request.url);
  const period = (url.searchParams.get("period") ?? "month") as Period;
  const _parsedThreshold = parseInt(url.searchParams.get("lowStockThreshold") ?? "5", 10);
  const lowStockThreshold = isNaN(_parsedThreshold) ? 5 : _parsedThreshold;
  const lowStockVendor = url.searchParams.get("lowStockVendor") ?? "";
  const lowStockProductType = url.searchParams.get("lowStockProductType") ?? "";
  const since = periodStart(period);
  const now = new Date();
  const soon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const [
    receivedUnpaidRaw,
    pendingCount,
    receivedThisPeriod,
    spentThisPeriod,
    spendByVendor,
    statusCounts,
    spendOverTime,
    overdueAndUpcoming,
    recentAudit,
    marginAlertItems,
    marginSetting,
    lowStock,
    vendorRows,
    productTypes,
  ] = await Promise.all([
    // Awaiting payment vs overdue (both from RECEIVED invoices)
    db.$queryRaw<{ awaiting: number; overdue: number }[]>`
      SELECT
        COALESCE(SUM(CASE WHEN ("dueDate" IS NULL OR "dueDate" >= NOW()) THEN total ELSE 0 END), 0)::float AS awaiting,
        COALESCE(SUM(CASE WHEN "dueDate" < NOW() THEN total ELSE 0 END), 0)::float AS overdue
      FROM "Invoice" WHERE status = 'RECEIVED'
    `,

    // Pending (ORDERED) count
    db.invoice.count({ where: { status: "ORDERED" } }),

    // Received this period: count
    db.invoice.count({
      where: { status: { in: ["RECEIVED", "PAID"] }, updatedAt: { gte: since } },
    }),

    // Spent this period: sum of received/paid invoices
    db.$queryRaw<{ total: number }[]>`
      SELECT COALESCE(SUM(total), 0)::float AS total
      FROM "Invoice"
      WHERE status IN ('RECEIVED','PAID') AND "updatedAt" >= ${since}
    `,

    // Spend by vendor (top 8, period)
    db.$queryRaw<{ vendorName: string; total: number }[]>`
      SELECT v.name AS "vendorName", SUM(i.total)::float AS total
      FROM "Invoice" i
      JOIN "Vendor" v ON v.id = i."vendorId"
      WHERE i.status IN ('RECEIVED','PAID') AND i."updatedAt" >= ${since}
      GROUP BY v.name
      ORDER BY total DESC
      LIMIT 8
    `,

    // Status breakdown (all invoices)
    db.$queryRaw<{ status: string; count: number }[]>`
      SELECT status, COUNT(*)::int AS count FROM "Invoice" GROUP BY status
    `,

    // Spend over time (DATE_TRUNC by period granularity)
    db.$queryRaw<{ bucket: Date; total: number }[]>`
      SELECT DATE_TRUNC(${truncUnit(period)}, "updatedAt") AS bucket,
             SUM(total)::float AS total
      FROM "Invoice"
      WHERE status IN ('RECEIVED','PAID') AND "updatedAt" >= ${since}
      GROUP BY bucket
      ORDER BY bucket ASC
    `,

    // Overdue & upcoming (dueDate <= now+7d, status ORDERED or RECEIVED)
    db.invoice.findMany({
      where: {
        dueDate: { lte: soon },
        status: { in: ["ORDERED", "RECEIVED"] },
      },
      include: { vendor: true },
      orderBy: { dueDate: "asc" },
      take: 10,
    }),

    // Recent activity (last 8 audit logs)
    db.auditLog.findMany({
      include: { user: true, vendor: true },
      orderBy: { timestamp: "desc" },
      take: 8,
    }),

    // Margin alert items (retailPrice and unitCost both set, received this period)
    db.$queryRaw<{
      id: number;
      invoiceId: number;
      invoiceNumber: string;
      vendorName: string;
      sku: string | null;
      description: string;
      unitCost: number;
      retailPrice: number;
      margin: number;
    }[]>`
      SELECT
        li.id,
        li."invoiceId",
        i."invoiceNumber",
        v.name AS "vendorName",
        li.sku,
        li.description,
        li."unitCost"::float,
        li."retailPrice"::float,
        ROUND(((li."retailPrice" - li."unitCost") / NULLIF(li."retailPrice", 0)) * 100, 1)::float AS margin
      FROM "InvoiceLineItem" li
      JOIN "Invoice" i ON i.id = li."invoiceId"
      JOIN "Vendor" v ON v.id = li."vendorId"
      WHERE li."retailPrice" IS NOT NULL
        AND li."unitCost" IS NOT NULL
        AND li."retailPrice" > 0
      ORDER BY margin ASC
      LIMIT 20
    `,

    // Margin floor setting
    db.appSetting.findUnique({ where: { key: "marginFloor" } }),

    // Low stock snapshot from ProductCache + SalesCache (30-day velocity window)
    (() => {
      const lsVendorCond = lowStockVendor ? Prisma.sql`AND p.vendor ILIKE ${lowStockVendor}` : Prisma.sql``;
      const lsTypeCond = lowStockProductType ? Prisma.sql`AND p."productType" ILIKE ${lowStockProductType}` : Prisma.sql``;
      return db.$queryRaw<{
        variantId: string;
        productTitle: string;
        sku: string | null;
        vendor: string;
        productType: string;
        currentInventory: number;
        unitsSold: bigint;
      }[]>`
        SELECT
          p."variantId",
          p.title AS "productTitle",
          p.sku,
          COALESCE(p.vendor, '') AS vendor,
          COALESCE(p."productType", '') AS "productType",
          p."currentInventory",
          COALESCE(SUM(s."unitsSold"), 0)::bigint AS "unitsSold"
        FROM "ProductCache" p
        LEFT JOIN "SalesCache" s ON s."variantId" = p."variantId"
          AND s.date >= NOW() - INTERVAL '30 days'
        WHERE p."currentInventory" <= ${lowStockThreshold}
          ${lsVendorCond}
          ${lsTypeCond}
        GROUP BY p."variantId", p.title, p.sku, p.vendor, p."productType", p."currentInventory"
        ORDER BY p."currentInventory" ASC
        LIMIT 50
      `;
    })(),

    // Vendor list from local DB for filter dropdown
    db.vendor.findMany({ orderBy: { name: "asc" }, select: { name: true } }),

    // Product types from Shopify for filter dropdown
    getProductTypes(),
  ]);

  const marginFloor = parseFloat(marginSetting?.value ?? "40");
  const belowMargin = marginAlertItems.filter((r) => r.margin < marginFloor);

  // Compute velocity for low-stock items and split into urgent vs. no-data buckets
  const VELOCITY_DAYS = 30;
  const processedLowStock = lowStock.map((r) => {
    const unitsSold = Number(r.unitsSold);
    const avgDailySales = unitsSold / VELOCITY_DAYS;
    const daysRemaining = avgDailySales > 0 ? r.currentInventory / avgDailySales : null;
    return {
      variantId: r.variantId,
      productTitle: r.productTitle,
      sku: r.sku ?? "",
      vendor: r.vendor,
      productType: r.productType,
      currentInventory: r.currentInventory,
      avgDailySales,
      daysRemaining,
    };
  });

  const lowStockUrgent = processedLowStock
    .filter((r) => r.daysRemaining !== null)
    .sort((a, b) => a.daysRemaining! - b.daysRemaining!)
    .slice(0, 20);

  const lowStockNoVelocity = processedLowStock
    .filter((r) => r.daysRemaining === null)
    .slice(0, 10);

  return {
    period,
    kpis: {
      overdueBalance: receivedUnpaidRaw[0]?.overdue ?? 0,
      awaitingPayment: receivedUnpaidRaw[0]?.awaiting ?? 0,
      pendingCount,
      receivedThisPeriod,
      spentThisPeriod: spentThisPeriod[0]?.total ?? 0,
    },
    charts: {
      spendByVendor: spendByVendor.map((r) => ({ name: r.vendorName, value: r.total })),
      statusBreakdown: statusCounts.map((r) => ({ name: r.status, value: r.count })),
      spendOverTime: spendOverTime.map((r) => ({
        bucket: r.bucket.toISOString(),
        total: r.total,
      })),
    },
    tables: {
      overdueAndUpcoming: overdueAndUpcoming.map((inv) => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        vendorName: inv.vendor.name,
        status: inv.status,
        dueDate: inv.dueDate?.toISOString() ?? null,
        total: Number(inv.total),
      })),
      recentAudit: recentAudit.map((log) => ({
        id: log.id,
        action: log.action,
        details: log.details,
        userName: log.user.name,
        vendorName: log.vendor?.name ?? null,
        timestamp: log.timestamp.toISOString(),
      })),
      lowStock: lowStockUrgent,
      lowStockNoVelocity,
    },
    marginAlerts: { items: belowMargin, marginFloor },
    lowStockFilters: {
      threshold: lowStockThreshold,
      vendor: lowStockVendor,
      productType: lowStockProductType,
      vendors: vendorRows.map((v) => v.name),
      productTypes,
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt$(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function urgencyBg(days: number | null): string {
  if (days === null) return "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400";
  if (days < 7) return "bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300";
  if (days < 14) return "bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300";
  if (days < 30) return "bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300";
  return "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300";
}

function fmtBucket(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const STATUS_COLORS: Record<string, string> = {
  ORDERED: "#f59e0b",
  RECEIVED: "#6366f1",
  PAID: "#22c55e",
};

// ─── ClientOnly wrapper (SSR safety for recharts) ─────────────────────────────

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

// ─── KPI Card ─────────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  sub,
  color,
  to,
}: {
  label: string;
  value: string;
  sub?: string;
  color: string;
  to: string;
}) {
  return (
    <Link
      to={to}
      className={`block bg-white dark:bg-gray-900 rounded-2xl border ${color} shadow-sm p-5 hover:shadow-md transition-shadow`}
    >
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">{label}</p>
      <p className="text-2xl font-bold text-gray-900 dark:text-white">{value}</p>
      {sub && <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">{sub}</p>}
    </Link>
  );
}

// ─── Section wrapper ──────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">{title}</h3>
      {children}
    </section>
  );
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 ${className}`}>
      {children}
    </div>
  );
}

function Empty({ msg }: { msg: string }) {
  return (
    <Card className="px-6 py-8 text-center text-sm text-gray-400 dark:text-gray-500">{msg}</Card>
  );
}

// ─── Charts ───────────────────────────────────────────────────────────────────

import {
  BarChart, Bar, XAxis, YAxis, Tooltip,
  PieChart, Pie, Cell,
  AreaChart, Area,
  ResponsiveContainer, CartesianGrid, Legend,
} from "recharts";

function SpendByVendorChart({ data, dark }: { data: { name: string; value: number }[]; dark: boolean }) {
  const textColor = dark ? "#9ca3af" : "#6b7280";
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={dark ? "#374151" : "#e5e7eb"} horizontal={false} />
        <XAxis type="number" tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} tick={{ fill: textColor, fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis type="category" dataKey="name" width={110} tick={{ fill: textColor, fontSize: 11 }} axisLine={false} tickLine={false} />
        <Tooltip formatter={(v) => fmt$(Number(v))} contentStyle={{ background: dark ? "#1f2937" : "#fff", border: "none", borderRadius: 8, fontSize: 12 }} />
        <Bar dataKey="value" fill="#6366f1" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function StatusPieChart({ data, dark }: { data: { name: string; value: number }[]; dark: boolean }) {
  const textColor = dark ? "#9ca3af" : "#6b7280";
  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={55}
          outerRadius={85}
          paddingAngle={3}
          dataKey="value"
          label={({ name, value }) => `${name} (${value})`}
          labelLine={false}
        >
          {data.map((entry) => (
            <Cell key={entry.name} fill={STATUS_COLORS[entry.name] ?? "#94a3b8"} />
          ))}
        </Pie>
        <Tooltip contentStyle={{ background: dark ? "#1f2937" : "#fff", border: "none", borderRadius: 8, fontSize: 12 }} />
        <Legend wrapperStyle={{ fontSize: 12, color: textColor }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

function SpendAreaChart({ data, dark }: { data: { bucket: string; total: number }[]; dark: boolean }) {
  const textColor = dark ? "#9ca3af" : "#6b7280";
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
        <defs>
          <linearGradient id="spendGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={dark ? "#374151" : "#e5e7eb"} />
        <XAxis dataKey="bucket" tickFormatter={fmtBucket} tick={{ fill: textColor, fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} tick={{ fill: textColor, fontSize: 11 }} axisLine={false} tickLine={false} />
        <Tooltip formatter={(v) => fmt$(Number(v))} labelFormatter={(label) => fmtBucket(String(label))} contentStyle={{ background: dark ? "#1f2937" : "#fff", border: "none", borderRadius: 8, fontSize: 12 }} />
        <Area type="monotone" dataKey="total" stroke="#6366f1" strokeWidth={2} fill="url(#spendGrad)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const PERIODS: { label: string; value: Period }[] = [
  { label: "7 days", value: "week" },
  { label: "30 days", value: "month" },
  { label: "90 days", value: "quarter" },
  { label: "1 year", value: "year" },
];

export default function DashboardPage({ loaderData }: Route.ComponentProps) {
  const { period, kpis, charts, tables, marginAlerts, lowStockFilters } = loaderData;
  const [searchParams, setSearchParams] = useSearchParams();
  const isDark = useIsDark();

  const [localLsVendor, setLocalLsVendor] = useState(lowStockFilters.vendor);
  const [localLsProductType, setLocalLsProductType] = useState(lowStockFilters.productType);
  const [localLsThreshold, setLocalLsThreshold] = useState(String(lowStockFilters.threshold));

  const uniqueLsVendors = lowStockFilters.vendors;
  const uniqueLsProductTypes = lowStockFilters.productTypes;

  function applyLowStockFilters() {
    const p = new URLSearchParams(searchParams);
    p.set("lowStockThreshold", localLsThreshold !== "" ? localLsThreshold : "5");
    if (localLsVendor) p.set("lowStockVendor", localLsVendor);
    else p.delete("lowStockVendor");
    if (localLsProductType) p.set("lowStockProductType", localLsProductType);
    else p.delete("lowStockProductType");
    setSearchParams(p);
  }

  function clearLowStockFilters() {
    setLocalLsVendor("");
    setLocalLsProductType("");
    setLocalLsThreshold("5");
    const p = new URLSearchParams(searchParams);
    p.delete("lowStockVendor");
    p.delete("lowStockProductType");
    p.delete("lowStockThreshold");
    setSearchParams(p);
  }

  return (
    <main className="p-8 max-w-6xl mx-auto">
      {/* Header + period filter */}
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Dashboard</h2>
        <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-800 rounded-xl p-1">
          {PERIODS.map((p) => {
            const params = new URLSearchParams(searchParams);
            params.set("period", p.value);
            return (
              <Link
                key={p.value}
                to={`?${params}`}
                className={`text-xs font-medium px-3 py-1.5 rounded-lg transition-colors ${
                  period === p.value
                    ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm"
                    : "text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
                }`}
              >
                {p.label}
              </Link>
            );
          })}
        </div>
      </div>

      {/* KPI Cards */}
      <Section title="Overview">
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <KpiCard
            label="Overdue Balance"
            value={fmt$(kpis.overdueBalance)}
            sub="past due, unpaid"
            color="border-rose-300 dark:border-rose-800"
            to="/invoices?status=RECEIVED&overdue=true"
          />
          <KpiCard
            label="Awaiting Payment"
            value={fmt$(kpis.awaitingPayment)}
            sub="received, not yet due"
            color="border-amber-200 dark:border-amber-800"
            to="/invoices?status=RECEIVED"
          />
          <KpiCard
            label="Pending Receiving"
            value={String(kpis.pendingCount)}
            sub="orders placed"
            color="border-yellow-200 dark:border-yellow-800"
            to="/invoices?status=ORDERED"
          />
          <KpiCard
            label="Received This Period"
            value={String(kpis.receivedThisPeriod)}
            sub="invoices"
            color="border-green-200 dark:border-green-900"
            to="/invoices"
          />
          <KpiCard
            label="Spent This Period"
            value={fmt$(kpis.spentThisPeriod)}
            color="border-indigo-200 dark:border-indigo-900"
            to="/invoices"
          />
        </div>
      </Section>

      {/* Charts */}
      <Section title="Analytics">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="p-4">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-3">Spend by Vendor</p>
            <ClientOnly>
              {() =>
                charts.spendByVendor.length === 0 ? (
                  <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-8">No data</p>
                ) : (
                  <SpendByVendorChart data={charts.spendByVendor} dark={isDark} />
                )
              }
            </ClientOnly>
          </Card>
          <Card className="p-4">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-3">Order Status</p>
            <ClientOnly>
              {() =>
                charts.statusBreakdown.length === 0 ? (
                  <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-8">No data</p>
                ) : (
                  <StatusPieChart data={charts.statusBreakdown} dark={isDark} />
                )
              }
            </ClientOnly>
          </Card>
          <Card className="p-4">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-3">Spend Over Time</p>
            <ClientOnly>
              {() =>
                charts.spendOverTime.length === 0 ? (
                  <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-8">No data</p>
                ) : (
                  <SpendAreaChart data={charts.spendOverTime} dark={isDark} />
                )
              }
            </ClientOnly>
          </Card>
        </div>
      </Section>

      {/* Overdue & Upcoming */}
      <Section title="Overdue & Upcoming (next 7 days)">
        {tables.overdueAndUpcoming.length === 0 ? (
          <Empty msg="No invoices due soon." />
        ) : (
          <Card className="overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                  <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Invoice #</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Vendor</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Status</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Due</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Total</th>
                </tr>
              </thead>
              <tbody>
                {tables.overdueAndUpcoming.map((inv, i) => {
                  const overdue = inv.dueDate && new Date(inv.dueDate) < new Date();
                  return (
                    <tr key={inv.id} className={i < tables.overdueAndUpcoming.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : ""}>
                      <td className="px-5 py-3">
                        <Link to={`/invoices/${inv.id}`} className="text-indigo-600 dark:text-indigo-400 hover:underline font-medium">
                          {inv.invoiceNumber}
                        </Link>
                      </td>
                      <td className="px-5 py-3 text-gray-600 dark:text-gray-300">{inv.vendorName}</td>
                      <td className="px-5 py-3">
                        <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full ${
                          inv.status === "ORDERED" ? "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300" : "bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300"
                        }`}>{inv.status}</span>
                      </td>
                      <td className={`px-5 py-3 font-medium ${overdue ? "text-red-600 dark:text-red-400" : "text-gray-600 dark:text-gray-300"}`}>
                        {fmtDate(inv.dueDate)}
                      </td>
                      <td className="px-5 py-3 text-right text-gray-800 dark:text-gray-100 font-medium">{fmt$(inv.total)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}
      </Section>

      {/* Low Stock */}
      <Section title={`Low Stock Alert (≤${lowStockFilters.threshold} units)`}>
        {/* Filter bar */}
        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm p-4 mb-3 flex flex-wrap gap-3 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Threshold</label>
            <input
              type="number"
              max={100}
              value={localLsThreshold}
              onChange={(e) => setLocalLsThreshold(e.target.value)}
              className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 w-20"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Vendor</label>
            <select
              value={localLsVendor}
              onChange={(e) => setLocalLsVendor(e.target.value)}
              className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100"
            >
              <option value="">All vendors</option>
              {uniqueLsVendors.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Product Type</label>
            <select
              value={localLsProductType}
              onChange={(e) => setLocalLsProductType(e.target.value)}
              className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100"
            >
              <option value="">All types</option>
              {uniqueLsProductTypes.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <button
            onClick={applyLowStockFilters}
            className="text-sm font-medium px-4 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
          >
            Apply
          </button>
          {(lowStockFilters.vendor || lowStockFilters.productType || lowStockFilters.threshold !== 5) && (
            <button
              onClick={clearLowStockFilters}
              className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
            >
              Clear
            </button>
          )}
        </div>
        {tables.lowStock.length === 0 && tables.lowStockNoVelocity.length === 0 ? (
          <Empty msg="No low-stock variants found. Run a sync or adjust the threshold." />
        ) : (
          <>
            {tables.lowStock.length > 0 && (
              <Card className="overflow-hidden mb-4">
                <div className="px-5 py-2.5 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400 flex gap-4">
                  <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-rose-500 inline-block" /> &lt;7 days</span>
                  <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-orange-400 inline-block" /> &lt;14 days</span>
                  <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-yellow-400 inline-block" /> &lt;30 days</span>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                      <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Product</th>
                      <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">SKU</th>
                      <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Vendor</th>
                      <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Qty</th>
                      <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Avg/Day</th>
                      <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Days Left</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tables.lowStock.map((v, i) => (
                      <tr key={v.variantId} className={i < tables.lowStock.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : ""}>
                        <td className="px-5 py-3 text-gray-800 dark:text-gray-100 max-w-xs truncate">{v.productTitle}</td>
                        <td className="px-5 py-3 font-mono text-gray-600 dark:text-gray-300 text-xs">{v.sku || "—"}</td>
                        <td className="px-5 py-3 text-gray-600 dark:text-gray-300">{v.vendor || "—"}</td>
                        <td className="px-5 py-3 text-right font-bold text-gray-700 dark:text-gray-200">{v.currentInventory}</td>
                        <td className="px-5 py-3 text-right text-gray-600 dark:text-gray-300">{v.avgDailySales.toFixed(2)}</td>
                        <td className="px-5 py-3 text-right">
                          <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full ${urgencyBg(v.daysRemaining)}`}>
                            {v.daysRemaining !== null ? Math.floor(v.daysRemaining) + "d" : "—"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}

            {tables.lowStockNoVelocity.length > 0 && (
              <div className="mb-4">
                <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">No Velocity Data</p>
                <Card className="overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                        <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Product</th>
                        <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">SKU</th>
                        <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Vendor</th>
                        <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Qty</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tables.lowStockNoVelocity.map((v, i) => (
                        <tr key={v.variantId} className={i < tables.lowStockNoVelocity.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : ""}>
                          <td className="px-5 py-3 text-gray-800 dark:text-gray-100 max-w-xs truncate">{v.productTitle}</td>
                          <td className="px-5 py-3 font-mono text-gray-600 dark:text-gray-300 text-xs">{v.sku || "—"}</td>
                          <td className="px-5 py-3 text-gray-600 dark:text-gray-300">{v.vendor || "—"}</td>
                          <td className="px-5 py-3 text-right font-bold text-amber-600 dark:text-amber-400">{v.currentInventory}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              </div>
            )}

            <div className="mt-2 text-right">
              <Link to="/reports/inventory-valuation" className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline">
                View all low stock →
              </Link>
            </div>
          </>
        )}
      </Section>

      {/* Recent Activity */}
      <Section title="Recent Activity">
        {tables.recentAudit.length === 0 ? (
          <Empty msg="No recent activity." />
        ) : (
          <Card className="overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                  <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Action</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">User</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Vendor</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">When</th>
                </tr>
              </thead>
              <tbody>
                {tables.recentAudit.map((log, i) => (
                  <tr key={log.id} className={i < tables.recentAudit.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : ""}>
                    <td className="px-5 py-3">
                      <span className="text-gray-800 dark:text-gray-100 font-medium">{log.action}</span>
                      {log.details && <span className="text-gray-400 dark:text-gray-500 ml-2">{log.details}</span>}
                    </td>
                    <td className="px-5 py-3 text-gray-600 dark:text-gray-300">{log.userName}</td>
                    <td className="px-5 py-3 text-gray-500 dark:text-gray-400">{log.vendorName ?? "—"}</td>
                    <td className="px-5 py-3 text-right text-gray-400 dark:text-gray-500">{timeAgo(log.timestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </Section>

      {/* Margin Alerts */}
      {marginAlerts.items.length > 0 && (
        <Section title={`Margin Alerts (below ${marginAlerts.marginFloor}%)`}>
          <Card className="overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                  <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Invoice</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Vendor</th>
                  <th className="text-left px-5 py-3 font-medium text-gray-500 dark:text-gray-400">SKU / Description</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Cost</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Retail</th>
                  <th className="text-right px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Margin</th>
                </tr>
              </thead>
              <tbody>
                {marginAlerts.items.map((item, i) => (
                  <tr key={item.id} className={[i < marginAlerts.items.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : "", "bg-red-50 dark:bg-red-950/20"].join(" ")}>
                    <td className="px-5 py-3">
                      <Link to={`/invoices/${item.invoiceId}`} className="text-indigo-600 dark:text-indigo-400 hover:underline">
                        {item.invoiceNumber}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-gray-600 dark:text-gray-300">{item.vendorName}</td>
                    <td className="px-5 py-3">
                      {item.sku && <span className="font-mono text-gray-700 dark:text-gray-200 mr-2">{item.sku}</span>}
                      <span className="text-gray-500 dark:text-gray-400">{item.description}</span>
                    </td>
                    <td className="px-5 py-3 text-right text-gray-700 dark:text-gray-200">${item.unitCost.toFixed(2)}</td>
                    <td className="px-5 py-3 text-right text-gray-700 dark:text-gray-200">${item.retailPrice.toFixed(2)}</td>
                    <td className="px-5 py-3 text-right font-bold text-red-600 dark:text-red-400">{item.margin.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </Section>
      )}
    </main>
  );
}
