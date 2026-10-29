import { Link } from "react-router";
import type { Route } from "./+types/stocktakes";
import { requireUserId } from "../session.server";
import { getDb } from "../db.server";
import { modeLabels, statusLabels, statusStyles } from "../utils/stocktake-labels";

const PAGE_SIZE = 50;

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const db = getDb();
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1") || 1);

  const [totalCount, stocktakes] = await Promise.all([
    db.stocktake.count(),
    db.stocktake.findMany({
      orderBy: { startedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        name: true,
        mode: true,
        status: true,
        startedAt: true,
        startedBy: { select: { name: true } },
        _count: { select: { items: true } },
      },
    }),
  ]);

  return {
    stocktakes: stocktakes.map((s) => ({
      id: s.id,
      name: s.name,
      mode: s.mode,
      status: s.status,
      startedAt: s.startedAt.toISOString(),
      startedBy: s.startedBy.name,
      itemCount: s._count.items,
    })),
    pagination: { page, totalPages: Math.max(1, Math.ceil(totalCount / PAGE_SIZE)), totalCount },
  };
}

export default function StocktakesPage({ loaderData }: Route.ComponentProps) {
  const { stocktakes, pagination } = loaderData;

  return (
    <main className="p-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Stocktakes</h2>
        <Link
          to="/stocktakes/new"
          className="text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg px-4 py-2"
        >
          New stocktake
        </Link>
      </div>

      {stocktakes.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 px-6 py-12 text-center">
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">No stocktakes yet.</p>
          <p className="text-xs text-gray-400 dark:text-gray-500">
            Start a scoped count of a filtered set of products, or a free scan of whatever you pick up.
          </p>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Date</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Name</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Mode</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Started by</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Items</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Status</th>
              </tr>
            </thead>
            <tbody>
              {stocktakes.map((s, i) => (
                <tr
                  key={s.id}
                  className={`hover:bg-gray-50 dark:hover:bg-gray-800 ${i < stocktakes.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : ""}`}
                >
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">
                    {new Date(s.startedAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    <Link to={`/stocktakes/${s.id}`} className="font-medium text-indigo-600 dark:text-indigo-400 hover:underline">
                      {s.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{modeLabels[s.mode]}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{s.startedBy}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-700 dark:text-gray-300">{s.itemCount.toLocaleString()}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusStyles[s.status]}`}>
                      {statusLabels[s.status]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <div>
            {pagination.page > 1 && (
              <Link to={`/stocktakes?page=${pagination.page - 1}`} className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">← Previous</Link>
            )}
          </div>
          <span className="text-sm text-gray-500 dark:text-gray-400">Page {pagination.page} of {pagination.totalPages}</span>
          <div>
            {pagination.page < pagination.totalPages && (
              <Link to={`/stocktakes?page=${pagination.page + 1}`} className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">Next →</Link>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
