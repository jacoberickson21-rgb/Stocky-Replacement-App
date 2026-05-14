import { Form } from "react-router";
import { Prisma } from "@prisma/client";
import type { Route } from "./+types/failures";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";

const OPERATIONS: Record<string, string> = {
  PDF_PARSE: "PDF Parse",
  INVOICE_RECEIVE: "Invoice Receive",
  SHOPIFY_PRODUCT: "Shopify Product",
  INVENTORY_UPDATE: "Inventory Update",
};

type FailureRow = {
  id: number;
  operation: string;
  itemLabel: string;
  errorMessage: string;
  occurredAt: Date;
  resolvedAt: Date | null;
  resolvedByName: string | null;
};

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);

  const url = new URL(request.url);
  const statusFilter = url.searchParams.get("status") ?? "unresolved";
  const operationFilter = url.searchParams.get("operation") ?? "";

  const conditions: Prisma.Sql[] = [];
  if (statusFilter === "unresolved") {
    conditions.push(Prisma.sql`fl."resolvedAt" IS NULL`);
  } else if (statusFilter === "resolved") {
    conditions.push(Prisma.sql`fl."resolvedAt" IS NOT NULL`);
  }
  if (operationFilter) {
    conditions.push(Prisma.sql`fl.operation = ${operationFilter}`);
  }

  const whereClause =
    conditions.length > 0
      ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`
      : Prisma.sql``;

  const rows = await getDb().$queryRaw<FailureRow[]>(
    Prisma.sql`
      SELECT
        fl.id,
        fl.operation,
        fl."itemLabel",
        fl."errorMessage",
        fl."occurredAt",
        fl."resolvedAt",
        u.name AS "resolvedByName"
      FROM "FailureLog" fl
      LEFT JOIN "User" u ON fl."resolvedById" = u.id
      ${whereClause}
      ORDER BY fl."occurredAt" DESC
    `
  );

  return {
    failures: rows.map((r) => ({
      id: r.id,
      operation: r.operation,
      itemLabel: r.itemLabel,
      errorMessage: r.errorMessage,
      occurredAt: new Date(r.occurredAt).toISOString(),
      resolvedAt: r.resolvedAt ? new Date(r.resolvedAt).toISOString() : null,
      resolvedByName: r.resolvedByName ?? null,
    })),
    statusFilter,
    operationFilter,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "resolve") {
    const id = Number(formData.get("id"));
    await getDb().$executeRaw`
      UPDATE "FailureLog"
      SET "resolvedAt" = NOW(), "resolvedById" = ${userId}
      WHERE id = ${id}
    `;
    return { success: true };
  }

  return null;
}

export default function FailuresPage({ loaderData }: Route.ComponentProps) {
  const { failures, statusFilter, operationFilter } = loaderData;

  return (
    <main className="p-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Failure Log</h2>
        <span className="text-sm text-gray-400 dark:text-gray-500">
          {failures.length} {failures.length === 1 ? "entry" : "entries"}
        </span>
      </div>

      {/* Filters */}
      <form method="get" className="flex items-center gap-3 mb-6">
        <select
          name="status"
          defaultValue={statusFilter}
          onChange={(e) => e.currentTarget.form?.submit()}
          className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200"
        >
          <option value="unresolved">Unresolved</option>
          <option value="resolved">Resolved</option>
          <option value="all">All</option>
        </select>
        <select
          name="operation"
          defaultValue={operationFilter}
          onChange={(e) => e.currentTarget.form?.submit()}
          className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200"
        >
          <option value="">All Operations</option>
          {Object.entries(OPERATIONS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-gray-100 rounded-lg px-4 py-2 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
        >
          Apply
        </button>
      </form>

      {failures.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 px-6 py-12 text-center">
          <p className="text-sm text-gray-400 dark:text-gray-500">
            {statusFilter === "unresolved"
              ? "No unresolved failures. All operations are running clean."
              : "No failures match the selected filters."}
          </p>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400 w-36">Operation</th>
                <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Item</th>
                <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Error</th>
                <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400 w-40">When</th>
                <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400 w-32">Status</th>
                <th className="px-6 py-3 w-36"></th>
              </tr>
            </thead>
            <tbody>
              {failures.map((f, i) => (
                <tr
                  key={f.id}
                  className={[
                    i < failures.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : "",
                    !f.resolvedAt ? "bg-red-50 dark:bg-red-950/20" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <td className="px-6 py-4">
                    <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 whitespace-nowrap">
                      {OPERATIONS[f.operation] ?? f.operation}
                    </span>
                  </td>
                  <td className="px-6 py-4 font-medium text-gray-800 dark:text-gray-100">{f.itemLabel}</td>
                  <td className="px-6 py-4 text-gray-500 dark:text-gray-400 max-w-sm">
                    <span className="block whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                      {f.errorMessage}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                    {new Date(f.occurredAt).toLocaleString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </td>
                  <td className="px-6 py-4">
                    {f.resolvedAt ? (
                      <div>
                        <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300">
                          Resolved
                        </span>
                        {f.resolvedByName && (
                          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                            by {f.resolvedByName}
                          </p>
                        )}
                      </div>
                    ) : (
                      <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300">
                        Pending
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right">
                    {!f.resolvedAt && (
                      <Form method="post">
                        <input type="hidden" name="intent" value="resolve" />
                        <input type="hidden" name="id" value={String(f.id)} />
                        <button
                          type="submit"
                          className="text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 transition-colors"
                        >
                          Mark Resolved
                        </button>
                      </Form>
                    )}
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
