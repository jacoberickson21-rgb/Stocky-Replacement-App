import { Link, useNavigate, useSearchParams } from "react-router";
import { useRef, useState } from "react";
import type { StocktakeStatus } from "@prisma/client";
import type { Route } from "./+types/stocktakes";
import { requireUserId } from "../session.server";
import { listStocktakes } from "../services/stocktake-report.server";
import { modeLabels, statusLabels, statusStyles } from "../utils/stocktake-labels";

const STATUSES: StocktakeStatus[] = ["PREPARING", "IN_PROGRESS", "REVIEW", "APPLYING", "COMPLETED", "CANCELLED"];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1") || 1);
  const statusParam = url.searchParams.get("status") as StocktakeStatus | null;
  const status = statusParam && STATUSES.includes(statusParam) ? statusParam : null;
  const q = (url.searchParams.get("q") ?? "").trim();

  const result = await listStocktakes({ status, q, page });
  return { ...result, page, status, q };
}

const money = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: "USD" });
const signed = (n: number) => (n > 0 ? `+${n.toLocaleString()}` : n.toLocaleString());
const signedMoney = (n: number) => (n > 0 ? `+${money(n)}` : money(n));
const tone = (n: number) => (n > 0 ? "text-green-600 dark:text-green-400" : n < 0 ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-gray-400");

export default function StocktakesPage({ loaderData }: Route.ComponentProps) {
  const { rows, total, totalPages, page, status, q } = loaderData;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState(q);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function go(next: { status?: string; q?: string; page?: number }) {
    const params = new URLSearchParams(searchParams);
    if (next.status !== undefined) {
      if (next.status) params.set("status", next.status);
      else params.delete("status");
    }
    if (next.q !== undefined) {
      if (next.q) params.set("q", next.q);
      else params.delete("q");
    }
    params.set("page", String(next.page ?? 1));
    navigate(`/stocktakes?${params.toString()}`);
  }

  const filtered = status != null || q !== "";

  return (
    <main className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Stocktakes</h2>
        <Link to="/stocktakes/new" className="text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg px-4 py-2">
          New stocktake
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select
          value={status ?? ""}
          onChange={(e) => go({ status: e.target.value })}
          className="text-sm border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{statusLabels[s]}</option>)}
        </select>
        <input
          value={search}
          onChange={(e) => {
            const val = e.target.value;
            setSearch(val);
            if (debounceRef.current) clearTimeout(debounceRef.current);
            debounceRef.current = setTimeout(() => go({ q: val.trim() }), 350);
          }}
          placeholder="Search by name…"
          className="text-sm border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 placeholder-gray-400 w-64"
        />
        <span className="text-xs text-gray-400 dark:text-gray-500">{total.toLocaleString()} stocktake{total === 1 ? "" : "s"}</span>
      </div>

      {rows.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 px-6 py-12 text-center">
          {filtered ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">No stocktakes match these filters.</p>
          ) : (
            <>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">No stocktakes yet.</p>
              <p className="text-xs text-gray-400 dark:text-gray-500">
                Start a scoped count of a filtered set of products, or a free scan of whatever you pick up.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400">
                <th className="text-left px-4 py-3 font-medium">Date</th>
                <th className="text-left px-4 py-3 font-medium">Name</th>
                <th className="text-left px-4 py-3 font-medium">Mode</th>
                <th className="text-left px-4 py-3 font-medium">Run by</th>
                <th className="text-right px-4 py-3 font-medium">Items counted</th>
                <th className="text-right px-4 py-3 font-medium">Variance units</th>
                <th className="text-right px-4 py-3 font-medium">Variance value</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s, i) => (
                <tr key={s.id} className={`hover:bg-gray-50 dark:hover:bg-gray-800 ${i < rows.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : ""}`}>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">{new Date(s.startedAt).toLocaleDateString()}</td>
                  <td className="px-4 py-3">
                    <Link to={`/stocktakes/${s.id}`} className="font-medium text-indigo-600 dark:text-indigo-400 hover:underline">{s.name}</Link>
                  </td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{modeLabels[s.mode]}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                    {s.startedBy}
                    {s.completedBy && s.completedBy !== s.startedBy && <span className="text-xs text-gray-400"> · applied by {s.completedBy}</span>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-700 dark:text-gray-300">{s.itemsCounted.toLocaleString()}</td>
                  <td className={`px-4 py-3 text-right tabular-nums ${tone(s.varianceUnits)}`}>{signed(s.varianceUnits)}</td>
                  <td className={`px-4 py-3 text-right tabular-nums ${tone(s.varianceValue)}`}>{signedMoney(s.varianceValue)}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusStyles[s.status]}`}>{statusLabels[s.status]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
        Variance = counted − expected on hand at the start of the count, at cost. Items without a cost count toward units but not value.
      </p>

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <div>{page > 1 && <button type="button" onClick={() => go({ page: page - 1 })} className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">← Previous</button>}</div>
          <span className="text-sm text-gray-500 dark:text-gray-400">Page {page} of {totalPages}</span>
          <div>{page < totalPages && <button type="button" onClick={() => go({ page: page + 1 })} className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">Next →</button>}</div>
        </div>
      )}
    </main>
  );
}
