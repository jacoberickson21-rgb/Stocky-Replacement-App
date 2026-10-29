import { Form, Link, data, redirect, useActionData, useNavigation, useRevalidator, useSearchParams } from "react-router";
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
import { auditSearchHref, getStocktakeReport } from "../services/stocktake-report.server";
import { itemStatusLabels, modeLabels, statusLabels, statusStyles, type ItemStatus } from "../utils/stocktake-labels";

const PAGE_SIZE = 50;
const VIEWS = ["all", "variances", "applied", "not_applied", "issues"] as const;
type View = (typeof VIEWS)[number];
const NOT_APPLIED: ItemStatus[] = ["PENDING", "FAILED", "CHANGED_SINCE_REVIEW", "NEEDS_ACTIVATION", "NOT_SETTABLE"];
const ISSUES: ItemStatus[] = ["FAILED", "CHANGED_SINCE_REVIEW", "EXCLUDED", "NEEDS_ACTIVATION", "NOT_SETTABLE"];

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
  const id = Number(params.id);
  const db = getDb();
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1") || 1);
  const viewParam = url.searchParams.get("view") as View | null;
  const view: View = viewParam && VIEWS.includes(viewParam) ? viewParam : "all";

  const stocktake = await db.stocktake.findUnique({ where: { id }, select: { status: true, filters: true, snapshotTotal: true, snapshotDone: true } });
  if (!stocktake) throw new Response("Not Found", { status: 404 });

  const snapshot = readFiltersJson(stocktake.filters).snapshot ?? null;
  // While the snapshot is still filling items (and this page polls), skip the item list.
  const report = await getStocktakeReport(id, { includeItems: stocktake.status !== "PREPARING" });
  if (!report) throw new Response("Not Found", { status: 404 });

  const counts: Record<View, number> = { all: report.items.length, variances: 0, applied: 0, not_applied: 0, issues: 0 };
  const inView = (v: View, i: (typeof report.items)[number]) =>
    v === "all" ||
    (v === "variances" && i.variance != null && i.variance !== 0) ||
    (v === "applied" && i.status === "APPLIED") ||
    (v === "not_applied" && NOT_APPLIED.includes(i.status)) ||
    (v === "issues" && ISSUES.includes(i.status));
  for (const i of report.items) for (const v of VIEWS) if (v !== "all" && inView(v, i)) counts[v]++;

  const filtered = report.items.filter((i) => inView(view, i));
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  return {
    stocktake: {
      ...report.stocktake,
      snapshotTotal: stocktake.snapshotTotal,
      snapshotDone: stocktake.snapshotDone,
    },
    totals: report.totals,
    snapshot: snapshot && {
      droppedUntracked: snapshot.droppedUntracked.length,
      droppedMissing: snapshot.droppedMissing.length,
      notStockedAtLocation: snapshot.notStockedAtLocation,
      error: snapshot.error,
      finishedAt: snapshot.finishedAt,
    },
    snapshotRunning: isSnapshotRunning(id),
    auditHref: auditSearchHref(id),
    items: filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    list: { view, page: safePage, totalPages, matching: filtered.length, counts },
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
const signed = (n: number) => (n > 0 ? `+${n.toLocaleString()}` : n.toLocaleString());
const signedMoney = (n: number) => (n > 0 ? `+${money(n)}` : money(n));
const tone = (n: number | null) => (n == null || n === 0 ? "text-gray-500 dark:text-gray-400" : n > 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400");

const statusBadge: Record<ItemStatus, string> = {
  APPLIED: "bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300",
  PENDING: "bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300",
  FAILED: "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300",
  CHANGED_SINCE_REVIEW: "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300",
  EXCLUDED: "bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300",
  NEEDS_ACTIVATION: "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300",
  NOT_SETTABLE: "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300",
  SKIPPED_DRIFT: "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400",
  NO_CHANGE: "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400",
  NOT_COUNTED: "bg-gray-100 dark:bg-gray-800 text-gray-400",
};

const viewLabels: Record<View, string> = {
  all: "All",
  variances: "Variances",
  applied: "Applied",
  not_applied: "Not applied",
  issues: "Errors & exclusions",
};

export default function StocktakeDetailPage({ loaderData }: Route.ComponentProps) {
  const { stocktake, totals, snapshot, snapshotRunning, auditHref, items, list } = loaderData;
  const [searchParams, setSearchParams] = useSearchParams();
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
        <div className="text-sm text-gray-500 dark:text-gray-400 space-y-0.5">
          <p>
            {modeLabels[stocktake.mode]} · started by {stocktake.startedBy} on {new Date(stocktake.startedAt).toLocaleString()}
            {stocktake.notes && <> · {stocktake.notes}</>}
          </p>
          {stocktake.completedAt && (
            <p>Completed by {stocktake.completedBy ?? "—"} on {new Date(stocktake.completedAt).toLocaleString()}</p>
          )}
          {stocktake.applyReason && <p>Applied to Shopify with reason <span className="font-mono">{stocktake.applyReason}</span> (on_hand, absolute quantities)</p>}
          {stocktake.status !== "PREPARING" && (
            <p className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
              <a href={`/stocktakes/${stocktake.id}/summary`} target="_blank" rel="noreferrer" className="text-indigo-600 dark:text-indigo-400 hover:underline">Printable summary ↗</a>
              <a href={`/stocktakes/${stocktake.id}/export.csv`} className="text-indigo-600 dark:text-indigo-400 hover:underline">Download CSV (all items)</a>
              <Link to={auditHref} className="text-indigo-600 dark:text-indigo-400 hover:underline">Audit entries</Link>
            </p>
          )}
        </div>
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
          <div className="flex gap-2">
            <Link to={`/stocktakes/${stocktake.id}/count`} className="text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg px-4 py-2">
              Open counting screen
            </Link>
            <Form
              method="post"
              action={`/stocktakes/${stocktake.id}/review`}
              onSubmit={(e) => {
                if (!window.confirm("Finish counting and move to review? Counting pauses for everyone until someone goes back to counting.")) e.preventDefault();
              }}
            >
              <input type="hidden" name="intent" value="start-review" />
              <button type="submit" className="text-sm font-medium border border-indigo-300 dark:border-indigo-700 text-indigo-700 dark:text-indigo-300 rounded-lg px-4 py-2 hover:bg-indigo-100/50 dark:hover:bg-indigo-900/30">
                Finish counting → Review
              </button>
            </Form>
          </div>
        </div>
      )}

      {stocktake.status === "APPLYING" && (
        <div className="bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded-xl px-4 py-3 mb-6 flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-purple-800 dark:text-purple-300">Applying counts to Shopify.</span>
          <Link to={`/stocktakes/${stocktake.id}/apply`} className="text-sm font-medium bg-purple-600 hover:bg-purple-700 text-white rounded-lg px-4 py-2">
            View progress
          </Link>
        </div>
      )}

      {stocktake.status === "REVIEW" && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl px-4 py-3 mb-6 flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-amber-800 dark:text-amber-300">Counting is finished. Check variances and drift before applying.</span>
          <Link to={`/stocktakes/${stocktake.id}/review`} className="text-sm font-medium bg-amber-600 hover:bg-amber-700 text-white rounded-lg px-4 py-2">
            Open review
          </Link>
        </div>
      )}

      {!preparing && (
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 px-5 py-4 mb-4">
          <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
            <Stat label="Items counted" value={`${totals.itemsCounted.toLocaleString()} / ${totals.items.toLocaleString()}`} />
            <Stat label="Variance units" value={signed(totals.varianceUnits)} cls={tone(totals.varianceUnits)} />
            <Stat label="Variance value (at cost)" value={signedMoney(totals.varianceValue)} cls={tone(totals.varianceValue)} />
            <Stat label="Items applied" value={totals.itemsApplied.toLocaleString()} />
            <Stat label="Applied units" value={`+${totals.unitsUp.toLocaleString()} / −${totals.unitsDown.toLocaleString()}`} />
            <Stat label="Net dollar impact" value={signedMoney(totals.netAppliedValue)} cls={tone(totals.netAppliedValue)} />
          </div>
          <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
            Variance = counted − expected on hand at the start. Applied change = target − live on hand at review, for items Shopify confirmed.
            {totals.varianceNoCost > 0 && ` ${totals.varianceNoCost} item${totals.varianceNoCost === 1 ? " has" : "s have"} no cost and ${totals.varianceNoCost === 1 ? "is" : "are"} left out of the dollar figures.`}
          </p>
        </div>
      )}

      {!preparing && list.counts.all > 0 ? (
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700">
          <div className="flex flex-wrap gap-1 px-4 py-3 border-b border-gray-100 dark:border-gray-700">
            {(Object.keys(viewLabels) as View[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => {
                  const p = new URLSearchParams(searchParams);
                  p.set("view", v);
                  p.set("page", "1");
                  setSearchParams(p, { preventScrollReset: true });
                }}
                className={`text-xs font-medium px-2.5 py-1 rounded-full ${list.view === v ? "bg-indigo-600 text-white" : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"}`}
              >
                {viewLabels[v]} <span className="opacity-70">{list.counts[v]}</span>
              </button>
            ))}
          </div>
          {items.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-gray-400">No items in this view.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 border-b border-gray-100 dark:border-gray-700">
                    <th className="text-left px-3 py-2 font-medium">Product / SKU</th>
                    <th className="text-right px-3 py-2 font-medium">Expected</th>
                    <th className="text-right px-3 py-2 font-medium">Counted</th>
                    <th className="text-right px-3 py-2 font-medium">Live at review</th>
                    <th className="text-right px-3 py-2 font-medium">Target</th>
                    <th className="text-right px-3 py-2 font-medium">Variance</th>
                    <th className="text-right px-3 py-2 font-medium">Variance $</th>
                    <th className="text-left px-3 py-2 font-medium">Applied</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id} className="border-b border-gray-50 dark:border-gray-800 align-top">
                      <td className="px-3 py-2">
                        <div className="text-gray-800 dark:text-gray-100">{i.title}</div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {i.variantTitle}
                          {i.sku && <span className="ml-2 font-mono">{i.sku}</span>}
                        </div>
                        {i.notes.map((n) => (
                          <div key={n} className={`text-xs mt-0.5 ${i.status === "FAILED" || i.status === "CHANGED_SINCE_REVIEW" ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-gray-400"}`}>{n}</div>
                        ))}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-600 dark:text-gray-400">{i.expected}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold text-gray-800 dark:text-gray-100">{i.counted ?? (i.zeroedUnscanned ? "0" : "—")}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-600 dark:text-gray-400">{i.liveAtReview ?? "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-800 dark:text-gray-100">{i.target ?? "—"}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${tone(i.variance)}`}>{i.variance != null ? signed(i.variance) : "—"}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${tone(i.varianceValue)}`}>{i.varianceValue != null ? signedMoney(i.varianceValue) : "—"}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusBadge[i.status]}`}>{itemStatusLabels[i.status]}</span>
                        {i.appliedAt && <div className="text-xs text-gray-400 mt-0.5">{new Date(i.appliedAt).toLocaleString()}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {list.totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 text-sm">
              <div>
                {list.page > 1 && (
                  <Link to={`?view=${list.view}&page=${list.page - 1}`} preventScrollReset className="text-indigo-600 dark:text-indigo-400 hover:underline">← Previous</Link>
                )}
              </div>
              <span className="text-gray-500 dark:text-gray-400">Page {list.page} of {list.totalPages} · {list.matching.toLocaleString()} items</span>
              <div>
                {list.page < list.totalPages && (
                  <Link to={`?view=${list.view}&page=${list.page + 1}`} preventScrollReset className="text-indigo-600 dark:text-indigo-400 hover:underline">Next →</Link>
                )}
              </div>
            </div>
          )}
        </div>
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

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div>
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${cls ?? "text-gray-800 dark:text-gray-100"}`}>{value}</div>
    </div>
  );
}
