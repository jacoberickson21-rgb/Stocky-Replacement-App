import { Form, Link, data, redirect, useActionData, useNavigation, useRevalidator } from "react-router";
import { useEffect } from "react";
import type { Route } from "./+types/stocktakes.$id";
import { requireUserId } from "../session.server";
import { getDb } from "../db.server";
import {
  isSnapshotRunning,
  readFiltersJson,
  runStocktakeSnapshot,
} from "../services/stocktake.server";
import { StocktakeCountError, cancelStocktake } from "../services/stocktake-count.server";
import { logFailure } from "../services/failure-log.server";
import { modeLabels, statusLabels, statusStyles } from "../utils/stocktake-labels";

const PAGE_SIZE = 50;

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
  const id = Number(params.id);
  const db = getDb();
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1") || 1);

  const stocktake = await db.stocktake.findUnique({
    where: { id },
    include: { startedBy: { select: { name: true } } },
  });
  if (!stocktake) throw new Response("Not Found", { status: 404 });

  const [itemCount, items] = await Promise.all([
    db.stocktakeItem.count({ where: { stocktakeId: id } }),
    db.stocktakeItem.findMany({
      where: { stocktakeId: id },
      orderBy: [{ title: "asc" }, { productId: "asc" }, { variantTitle: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, title: true, variantTitle: true, sku: true, barcode: true,
        expectedQty: true, countedQty: true, cost: true, outsideScope: true,
      },
    }),
  ]);

  const filters = readFiltersJson(stocktake.filters);
  const snapshot = filters.snapshot ?? null;

  return {
    stocktake: {
      id: stocktake.id,
      name: stocktake.name,
      mode: stocktake.mode,
      status: stocktake.status,
      notes: stocktake.notes,
      startedBy: stocktake.startedBy.name,
      startedAt: stocktake.startedAt.toISOString(),
      snapshotTotal: stocktake.snapshotTotal,
      snapshotDone: stocktake.snapshotDone,
    },
    snapshot: snapshot && {
      droppedUntracked: snapshot.droppedUntracked.length,
      droppedMissing: snapshot.droppedMissing.length,
      notStockedAtLocation: snapshot.notStockedAtLocation,
      error: snapshot.error,
      finishedAt: snapshot.finishedAt,
    },
    snapshotRunning: isSnapshotRunning(id),
    items: items.map((i) => ({ ...i, cost: i.cost == null ? null : Number(i.cost) })),
    pagination: { page, totalPages: Math.max(1, Math.ceil(itemCount / PAGE_SIZE)), itemCount },
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const id = Number(params.id);
  const form = await request.formData();

  if (form.get("intent") === "cancel") {
    try {
      await cancelStocktake({ stocktakeId: id, userId });
    } catch (err) {
      if (err instanceof StocktakeCountError) return data({ error: err.message }, { status: 400 });
      const msg = err instanceof Error ? err.message : String(err);
      await logFailure("STOCKTAKE_CANCEL", `Stocktake #${id}`, msg);
      return data({ error: "Could not cancel the stocktake. The error has been logged." }, { status: 500 });
    }
    return redirect(`/stocktakes/${id}`);
  }

  if (form.get("intent") === "resume-snapshot") {
    const stocktake = await getDb().stocktake.findUnique({ where: { id }, select: { status: true } });
    if (stocktake?.status !== "PREPARING") {
      return data({ error: "This stocktake is not preparing." }, { status: 400 });
    }
    if (!isSnapshotRunning(id)) {
      runStocktakeSnapshot(id).catch((err) => {
        console.error("[stocktake] resumed snapshot failed:", err);
      });
    }
    return { ok: true };
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

const money = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: "USD" });

export default function StocktakeDetailPage({ loaderData }: Route.ComponentProps) {
  const { stocktake, snapshot, snapshotRunning, items, pagination } = loaderData;
  const revalidator = useRevalidator();
  const navigation = useNavigation();
  const actionData = useActionData<typeof action>();
  const actionError = actionData && "error" in actionData ? actionData.error : null;
  const cancellable = ["PREPARING", "IN_PROGRESS", "REVIEW"].includes(stocktake.status);
  const resuming = navigation.state !== "idle" && navigation.formData?.get("intent") === "resume-snapshot";

  const preparing = stocktake.status === "PREPARING";

  useEffect(() => {
    if (!preparing || !snapshotRunning) return;
    const t = setInterval(() => revalidator.revalidate(), 2000);
    return () => clearInterval(t);
  }, [preparing, snapshotRunning]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = stocktake.snapshotTotal ?? 0;
  const done = Math.min(stocktake.snapshotDone ?? 0, total);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <main className="p-8 max-w-6xl mx-auto">
      <div className="flex items-center gap-3 mb-1">
        <Link to="/stocktakes" className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">← Stocktakes</Link>
      </div>
      <div className="flex flex-wrap items-center gap-3 mb-1">
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">{stocktake.name}</h2>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusStyles[stocktake.status]}`}>
          {statusLabels[stocktake.status]}
        </span>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {modeLabels[stocktake.mode]} · started by {stocktake.startedBy} on {new Date(stocktake.startedAt).toLocaleString()}
          {stocktake.notes && <> · {stocktake.notes}</>}
        </p>
        {cancellable && (
          <Form
            method="post"
            onSubmit={(e) => {
              if (!window.confirm(`Cancel "${stocktake.name}"? Counts are kept for the record, but nothing will be applied to Shopify and counting stops.`)) {
                e.preventDefault();
              }
            }}
          >
            <input type="hidden" name="intent" value="cancel" />
            <button type="submit" className="text-sm font-medium text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 rounded-lg px-3 py-1.5 hover:bg-red-50 dark:hover:bg-red-900/20">
              Cancel stocktake
            </button>
          </Form>
        )}
      </div>

      {actionError && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl px-4 py-3 mb-6 text-sm text-red-700 dark:text-red-300">
          {actionError}
        </div>
      )}

      {preparing && (
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-5 mb-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
              Reading live quantities from Shopify…
            </span>
            <span className="text-sm tabular-nums text-gray-500 dark:text-gray-400">
              {done.toLocaleString()} / {total.toLocaleString()} ({pct}%)
            </span>
          </div>
          <div className="h-2 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
            <div className="h-full bg-indigo-500 transition-[width] duration-500" style={{ width: `${pct}%` }} />
          </div>

          {!snapshotRunning && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <p className="text-sm text-amber-700 dark:text-amber-400">
                {snapshot?.error
                  ? `The snapshot stopped: ${snapshot.error}`
                  : "The snapshot isn't running (the server may have restarted)."}{" "}
                Resuming only reads the variants that haven't been snapshotted yet.
              </p>
              <Form method="post">
                <input type="hidden" name="intent" value="resume-snapshot" />
                <button
                  type="submit"
                  disabled={resuming}
                  className="text-sm font-medium bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg px-4 py-2"
                >
                  {resuming ? "Resuming…" : "Resume snapshot"}
                </button>
              </Form>
            </div>
          )}
        </div>
      )}

      {snapshot && (snapshot.droppedUntracked > 0 || snapshot.droppedMissing > 0 || snapshot.notStockedAtLocation > 0) && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl px-4 py-3 mb-6 text-sm text-amber-800 dark:text-amber-300 space-y-1">
          {snapshot.droppedUntracked > 0 && (
            <p>{snapshot.droppedUntracked.toLocaleString()} variants were left out because inventory tracking is now off in Shopify.</p>
          )}
          {snapshot.droppedMissing > 0 && (
            <p>{snapshot.droppedMissing.toLocaleString()} variants were left out because they no longer exist in Shopify.</p>
          )}
          {snapshot.notStockedAtLocation > 0 && (
            <p>{snapshot.notStockedAtLocation.toLocaleString()} variants aren't stocked at this location yet; their expected quantity is 0.</p>
          )}
        </div>
      )}

      {stocktake.status === "IN_PROGRESS" && (
        <div className="bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800 rounded-xl px-4 py-3 mb-6 flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-indigo-800 dark:text-indigo-300">Ready to count. Several people can scan into this stocktake at once.</span>
          <Link to={`/stocktakes/${stocktake.id}/count`} className="text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg px-4 py-2">
            Open counting screen
          </Link>
        </div>
      )}

      {items.length > 0 ? (
        <>
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                  <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Product</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Variant</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">SKU</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Barcode</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Expected (on hand)</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Counted</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Cost</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, i) => (
                  <tr key={item.id} className={i < items.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : ""}>
                    <td className="px-4 py-2 text-gray-800 dark:text-gray-100">{item.title}</td>
                    <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{item.variantTitle}</td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-600 dark:text-gray-400">{item.sku ?? "—"}</td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-600 dark:text-gray-400">{item.barcode || "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-700 dark:text-gray-300">{item.expectedQty}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-700 dark:text-gray-300">{item.countedQty ?? "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-600 dark:text-gray-400">{item.cost != null ? money(item.cost) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pagination.totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <div>
                {pagination.page > 1 && (
                  <Link to={`?page=${pagination.page - 1}`} className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">← Previous</Link>
                )}
              </div>
              <span className="text-sm text-gray-500 dark:text-gray-400">
                Page {pagination.page} of {pagination.totalPages} · {pagination.itemCount.toLocaleString()} items
              </span>
              <div>
                {pagination.page < pagination.totalPages && (
                  <Link to={`?page=${pagination.page + 1}`} className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">Next →</Link>
                )}
              </div>
            </div>
          )}
        </>
      ) : (
        !preparing && (
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 px-6 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
            {stocktake.mode === "FREE_SCAN" ? "No items scanned yet." : "No items in this stocktake."}
          </div>
        )
      )}
    </main>
  );
}
