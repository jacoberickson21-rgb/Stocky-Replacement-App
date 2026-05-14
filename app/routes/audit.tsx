import { Link } from "react-router";
import { Prisma } from "@prisma/client";
import type { Route } from "./+types/audit";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";

const PAGE_SIZE = 50;

type AuditRow = {
  id: number;
  timestamp: Date;
  action: string;
  details: string | null;
  vendorId: number | null;
  userName: string;
  vendorName: string | null;
};

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);

  const url = new URL(request.url);
  const userIdParam = url.searchParams.get("userId") ?? "";
  const actionParam = url.searchParams.get("action") ?? "";
  const dateFrom = url.searchParams.get("dateFrom") ?? "";
  const dateTo = url.searchParams.get("dateTo") ?? "";
  const vendorIdParam = url.searchParams.get("vendorId") ?? "";
  const invoiceNumber = url.searchParams.get("invoiceNumber") ?? "";
  const search = url.searchParams.get("search") ?? "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1"));

  const conditions: Prisma.Sql[] = [];
  if (userIdParam) conditions.push(Prisma.sql`al."userId" = ${parseInt(userIdParam)}`);
  if (actionParam) conditions.push(Prisma.sql`al.action = ${actionParam}`);
  if (vendorIdParam) conditions.push(Prisma.sql`al."vendorId" = ${parseInt(vendorIdParam)}`);
  if (dateFrom) conditions.push(Prisma.sql`al.timestamp >= ${new Date(dateFrom)}`);
  if (dateTo) conditions.push(Prisma.sql`al.timestamp <= ${new Date(dateTo + "T23:59:59.999Z")}`);
  if (invoiceNumber) conditions.push(Prisma.sql`al.details ILIKE ${`%${invoiceNumber}%`}`);
  if (search) conditions.push(Prisma.sql`al.details ILIKE ${`%${search}%`}`);

  const whereClause =
    conditions.length > 0
      ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`
      : Prisma.sql``;

  const db = getDb();

  const [rows, countResult, users, vendors, actionRows] = await Promise.all([
    db.$queryRaw<AuditRow[]>(
      Prisma.sql`
        SELECT
          al.id,
          al.timestamp,
          al.action,
          al.details,
          al."vendorId",
          u.name AS "userName",
          v.name AS "vendorName"
        FROM "AuditLog" al
        INNER JOIN "User" u ON al."userId" = u.id
        LEFT JOIN "Vendor" v ON al."vendorId" = v.id
        ${whereClause}
        ORDER BY al.timestamp DESC
        LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}
      `
    ),
    db.$queryRaw<[{ count: bigint }]>(
      Prisma.sql`
        SELECT COUNT(*) AS count
        FROM "AuditLog" al
        ${whereClause}
      `
    ),
    db.user.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.vendor.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.$queryRaw<{ action: string }[]>(
      Prisma.sql`SELECT DISTINCT action FROM "AuditLog" ORDER BY action ASC`
    ),
  ]);

  const total = Number(countResult[0]?.count ?? 0);

  return {
    logs: rows.map((r) => ({
      id: r.id,
      timestamp: new Date(r.timestamp).toISOString(),
      action: r.action,
      details: r.details ?? null,
      userName: r.userName,
      vendorName: r.vendorName ?? null,
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    users,
    vendors,
    actionTypes: actionRows.map((r) => r.action),
    filters: { userIdParam, actionParam, dateFrom, dateTo, vendorIdParam, invoiceNumber, search },
  };
}

export default function AuditPage({ loaderData }: Route.ComponentProps) {
  const { logs, total, page, pageCount, users, vendors, actionTypes, filters } = loaderData;

  function buildPageUrl(p: number) {
    const params = new URLSearchParams();
    if (filters.userIdParam) params.set("userId", filters.userIdParam);
    if (filters.actionParam) params.set("action", filters.actionParam);
    if (filters.dateFrom) params.set("dateFrom", filters.dateFrom);
    if (filters.dateTo) params.set("dateTo", filters.dateTo);
    if (filters.vendorIdParam) params.set("vendorId", filters.vendorIdParam);
    if (filters.invoiceNumber) params.set("invoiceNumber", filters.invoiceNumber);
    if (filters.search) params.set("search", filters.search);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return `/audit${qs ? `?${qs}` : ""}`;
  }

  const hasFilters = Object.values(filters).some(Boolean);

  return (
    <main className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Audit Log</h2>
        <span className="text-sm text-gray-400 dark:text-gray-500">
          {total} {total === 1 ? "entry" : "entries"}
        </span>
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-4 mb-6">
        <form method="get" className="flex flex-wrap gap-3 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Staff Member</label>
            <select
              name="userId"
              defaultValue={filters.userIdParam}
              className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 min-w-[150px]"
            >
              <option value="">All Staff</option>
              {users.map((u) => (
                <option key={u.id} value={String(u.id)}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Action Type</label>
            <select
              name="action"
              defaultValue={filters.actionParam}
              className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 min-w-[180px]"
            >
              <option value="">All Actions</option>
              {actionTypes.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Vendor</label>
            <select
              name="vendorId"
              defaultValue={filters.vendorIdParam}
              className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 min-w-[150px]"
            >
              <option value="">All Vendors</option>
              {vendors.map((v) => (
                <option key={v.id} value={String(v.id)}>
                  {v.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">From Date</label>
            <input
              type="date"
              name="dateFrom"
              defaultValue={filters.dateFrom}
              className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">To Date</label>
            <input
              type="date"
              name="dateTo"
              defaultValue={filters.dateTo}
              className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Invoice #</label>
            <input
              type="text"
              name="invoiceNumber"
              defaultValue={filters.invoiceNumber}
              placeholder="e.g. 1042"
              className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 w-28"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Search Details</label>
            <input
              type="text"
              name="search"
              defaultValue={filters.search}
              placeholder="Search..."
              className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 w-44"
            />
          </div>

          <div className="flex items-end gap-2 pb-0">
            <button
              type="submit"
              className="border border-gray-300 dark:border-gray-600 rounded-lg px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              Apply
            </button>
            {hasFilters && (
              <Link
                to="/audit"
                className="border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-2 text-sm font-medium text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                Clear
              </Link>
            )}
          </div>
        </form>
      </div>

      {/* Table */}
      {logs.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 px-6 py-12 text-center">
          <p className="text-sm text-gray-400 dark:text-gray-500">
            {hasFilters
              ? "No audit log entries match the selected filters."
              : "No audit log entries yet."}
          </p>
        </div>
      ) : (
        <>
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                  <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400 w-44">Timestamp</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400 w-36">Staff Member</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400 w-52">Action</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400 w-36">Vendor</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Details</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log, i) => (
                  <tr
                    key={log.id}
                    className={i < logs.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : ""}
                  >
                    <td className="px-6 py-4 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                      {new Date(log.timestamp).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="px-6 py-4 font-medium text-gray-800 dark:text-gray-100">{log.userName}</td>
                    <td className="px-6 py-4">
                      <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300 whitespace-nowrap">
                        {log.action}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-gray-500 dark:text-gray-400">
                      {log.vendorName ?? <span className="text-gray-300 dark:text-gray-600">—</span>}
                    </td>
                    <td className="px-6 py-4 text-gray-500 dark:text-gray-400">
                      {log.details ?? <span className="text-gray-300 dark:text-gray-600">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {pageCount > 1 && (
            <div className="flex items-center justify-between mt-4">
              <Link
                to={buildPageUrl(page - 1)}
                aria-disabled={page <= 1}
                className={[
                  "text-sm font-medium px-4 py-2 rounded-lg border transition-colors",
                  page <= 1
                    ? "border-gray-100 dark:border-gray-800 text-gray-300 dark:text-gray-600 pointer-events-none"
                    : "border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-800",
                ].join(" ")}
              >
                ← Previous
              </Link>
              <span className="text-sm text-gray-500 dark:text-gray-400">
                Page {page} of {pageCount}
              </span>
              <Link
                to={buildPageUrl(page + 1)}
                aria-disabled={page >= pageCount}
                className={[
                  "text-sm font-medium px-4 py-2 rounded-lg border transition-colors",
                  page >= pageCount
                    ? "border-gray-100 dark:border-gray-800 text-gray-300 dark:text-gray-600 pointer-events-none"
                    : "border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-800",
                ].join(" ")}
              >
                Next →
              </Link>
            </div>
          )}
        </>
      )}
    </main>
  );
}
