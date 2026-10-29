import { Form, Link, data, redirect, useActionData, useFetcher, useNavigation, useRevalidator, useSearchParams } from "react-router";
import { useEffect, useState } from "react";
import type { StocktakeDriftResolution } from "@prisma/client";
import type { Route } from "./+types/stocktakes.$id.review";
import { requireUserId } from "../session.server";
import { getDb } from "../db.server";
import { logFailure } from "../services/failure-log.server";
import { readFiltersJson, type ReviewIssue } from "../services/stocktake.server";
import {
  StocktakeReviewError,
  backToCounting,
  computeReviewItem,
  isDriftCheckRunning,
  rerunDriftCheck,
  setDriftResolution,
  setZeroUnscanned,
  startReview,
} from "../services/stocktake-review.server";
import { modeLabels, statusLabels, statusStyles } from "../utils/stocktake-labels";

const PAGE_SIZE = 50;
const VIEWS = ["all", "changing", "variances", "drifted", "uncounted", "flagged"] as const;
type View = (typeof VIEWS)[number];
const RESOLUTIONS: StocktakeDriftResolution[] = ["KEEP_COUNT", "ADJUST_FOR_MOVEMENT", "SKIP"];

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
  const id = Number(params.id);
  const db = getDb();
  const url = new URL(request.url);
  const viewParam = url.searchParams.get("view") as View | null;
  const view: View = viewParam && VIEWS.includes(viewParam) ? viewParam : "all";
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1") || 1);

  const stocktake = await db.stocktake.findUnique({ where: { id }, include: { startedBy: { select: { name: true } } } });
  if (!stocktake) throw new Response("Not Found", { status: 404 });
  if (stocktake.status === "IN_PROGRESS") throw redirect(`/stocktakes/${id}/count`);
  if (stocktake.status !== "REVIEW") throw redirect(`/stocktakes/${id}`);

  const review = readFiltersJson(stocktake.filters).review;
  const checking = isDriftCheckRunning(id);
  const checked = review?.checkedAt != null && !checking;

  const [items, openUnknowns] = await Promise.all([
    db.stocktakeItem.findMany({
      where: { stocktakeId: id },
      orderBy: [{ title: "asc" }, { productId: "asc" }, { variantTitle: "asc" }],
      select: {
        id: true, title: true, variantTitle: true, sku: true, expectedQty: true, countedQty: true, cost: true,
        liveQtyAtReview: true, liveAvailableAtReview: true, drifted: true, driftResolution: true,
        targetQty: true, outsideScope: true, applied: true,
      },
    }),
    db.stocktakeUnknownBarcode.count({ where: { stocktakeId: id, resolvedAt: null } }),
  ]);

  const ctxBase = { zeroUnscanned: stocktake.zeroUnscanned, scoped: stocktake.mode === "SCOPED", checked };
  const rows = items.map((item) => {
    const cost = item.cost == null ? null : Number(item.cost);
    const issue: ReviewIssue | null = review?.issues[String(item.id)] ?? null;
    const o = computeReviewItem(item, { ...ctxBase, issue });
    const variance = o.effectiveCount != null ? o.effectiveCount - item.expectedQty : null;
    // What each drift option would set, so staff can see before choosing.
    const options =
      item.drifted && o.effectiveCount != null
        ? {
            KEEP_COUNT: o.effectiveCount,
            ADJUST_FOR_MOVEMENT: o.effectiveCount + ((item.liveQtyAtReview ?? 0) - item.expectedQty),
          }
        : null;
    return {
      id: item.id,
      title: item.title,
      variantTitle: item.variantTitle,
      sku: item.sku,
      outsideScope: item.outsideScope,
      expected: item.expectedQty,
      live: item.liveQtyAtReview,
      available: item.liveAvailableAtReview,
      counted: item.countedQty,
      cost,
      drifted: item.drifted,
      resolution: item.driftResolution,
      variance,
      varianceValue: variance != null && cost != null ? variance * cost : null,
      options,
      ...o,
    };
  });

  let unitsUp = 0, unitsDown = 0, netValue = 0, changingNoCost = 0;
  const counts = { all: rows.length, changing: 0, variances: 0, drifted: 0, uncounted: 0, flagged: 0, pendingDrift: 0, negative: 0 };
  for (const r of rows) {
    if (r.changing && !r.negative) {
      counts.changing++;
      if (r.change > 0) unitsUp += r.change;
      else unitsDown += -r.change;
      if (r.cost == null) changingNoCost++;
      else netValue += r.change * r.cost;
    }
    if (r.variance != null && r.variance !== 0) counts.variances++;
    if (r.drifted) counts.drifted++;
    if (r.counted == null) counts.uncounted++;
    if (r.issue || r.negative) counts.flagged++;
    if (r.pendingDrift) counts.pendingDrift++;
    if (r.negative) counts.negative++;
  }

  const filtered = rows.filter((r) => {
    switch (view) {
      case "changing": return r.changing && !r.negative;
      case "variances": return r.variance != null && r.variance !== 0;
      case "drifted": return r.drifted;
      case "uncounted": return r.counted == null;
      case "flagged": return r.issue != null || r.negative;
      default: return true;
    }
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  // "Set unscanned to 0" preview, from the start snapshot (re-checked live once turned on).
  const unscanned = rows.filter((r) => r.counted == null);
  const zeroPreview = {
    items: unscanned.length,
    unitsRemoved: unscanned.reduce((s, r) => s + r.expected, 0),
    valueRemoved: unscanned.reduce((s, r) => s + (r.cost ?? 0) * r.expected, 0),
  };

  const blockers: string[] = [];
  if (checking) blockers.push("The live drift check is still running.");
  else if (review?.error) blockers.push("The last drift check failed. Re-run it.");
  else if (!checked) blockers.push("The live drift check hasn't completed.");
  if (counts.pendingDrift > 0) blockers.push(`${counts.pendingDrift} drifted item${counts.pendingDrift === 1 ? " needs" : "s need"} a decision.`);
  if (counts.negative > 0) blockers.push(`${counts.negative} item${counts.negative === 1 ? " has" : "s have"} a target below zero.`);
  if (checked && counts.changing === 0) blockers.push("No quantities would change.");

  return {
    stocktake: {
      id: stocktake.id, name: stocktake.name, mode: stocktake.mode, status: stocktake.status,
      zeroUnscanned: stocktake.zeroUnscanned, startedBy: stocktake.startedBy.name,
    },
    check: {
      running: checking,
      total: review?.total ?? 0,
      done: review?.done ?? 0,
      error: review?.error ?? null,
      checkedAt: review?.checkedAt ?? null,
    },
    totals: { itemsChanging: counts.changing, unitsUp, unitsDown, net: unitsUp - unitsDown, netValue, changingNoCost },
    counts,
    zeroPreview,
    openUnknowns,
    blockers,
    rows: filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    list: { view, page: safePage, totalPages, matching: filtered.length },
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const stocktakeId = Number(params.id);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const parseResolution = (v: FormDataEntryValue | null): StocktakeDriftResolution | null =>
    RESOLUTIONS.includes(String(v) as StocktakeDriftResolution) ? (String(v) as StocktakeDriftResolution) : null;

  try {
    switch (intent) {
      case "start-review":
        await startReview({ stocktakeId, userId });
        return redirect(`/stocktakes/${stocktakeId}/review`);
      case "back-to-counting":
        await backToCounting({ stocktakeId });
        return redirect(`/stocktakes/${stocktakeId}/count`);
      case "rerun-check":
        await rerunDriftCheck({ stocktakeId });
        return { ok: true };
      case "resolve":
        await setDriftResolution({
          stocktakeId, userId,
          target: { itemIds: [Number(form.get("itemId"))] },
          resolution: parseResolution(form.get("resolution")),
        });
        return { ok: true };
      case "resolve-bulk":
        await setDriftResolution({
          stocktakeId, userId,
          target: { allDrifted: true, onlyUnresolved: form.get("scope") !== "all" },
          resolution: parseResolution(form.get("resolution")),
        });
        return { ok: true };
      case "zero-on":
        await setZeroUnscanned({ stocktakeId, userId, on: true, confirmedCount: Number(form.get("confirmedCount")) });
        return { ok: true };
      case "zero-off":
        await setZeroUnscanned({ stocktakeId, userId, on: false, confirmedCount: null });
        return { ok: true };
      default:
        return data({ error: "Unknown action." }, { status: 400 });
    }
  } catch (err) {
    if (err instanceof StocktakeReviewError) return data({ error: err.message }, { status: 400 });
    const msg = err instanceof Error ? err.message : String(err);
    await logFailure("STOCKTAKE_REVIEW", `Stocktake #${stocktakeId} ${intent}`, msg);
    return data({ error: "Something went wrong. The error has been logged." }, { status: 500 });
  }
}

// ─── UI ────────────────────────────────────────────────────────────────────────

const card = "bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700";
const money = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: "USD" });
const signed = (n: number) => (n > 0 ? `+${n.toLocaleString()}` : n.toLocaleString());
const signedMoney = (n: number) => (n > 0 ? `+${money(n)}` : money(n));

const resolutionLabels: Record<StocktakeDriftResolution, string> = {
  KEEP_COUNT: "Keep count",
  ADJUST_FOR_MOVEMENT: "Adjust for movement",
  SKIP: "Skip",
};

const issueText: Record<ReviewIssue, { short: string; long: string }> = {
  NOT_STOCKED: {
    short: "Not stocked here",
    long: "This item has no inventory level at this location. It must be activated at the location before its quantity can be set.",
  },
  UNTRACKED: { short: "Tracking off", long: "Inventory tracking is now off in Shopify. This item will not be applied." },
  MISSING: { short: "Gone from Shopify", long: "This item no longer exists in Shopify. It will not be applied." },
};

export default function StocktakeReviewPage({ loaderData }: Route.ComponentProps) {
  const { stocktake, check, totals, counts, zeroPreview, openUnknowns, blockers, rows, list } = loaderData;
  const actionData = useActionData<typeof action>();
  const actionError = actionData && "error" in actionData ? actionData.error : null;
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();
  const editable = !check.running;

  useEffect(() => {
    if (!check.running) return;
    const t = window.setInterval(() => revalidator.revalidate(), 2000);
    return () => window.clearInterval(t);
  }, [check.running]); // eslint-disable-line react-hooks/exhaustive-deps

  function setView(view: View) {
    const p = new URLSearchParams(searchParams);
    p.set("view", view);
    p.set("page", "1");
    setSearchParams(p, { preventScrollReset: true });
  }
  function setPage(page: number) {
    const p = new URLSearchParams(searchParams);
    p.set("page", String(page));
    setSearchParams(p, { preventScrollReset: true });
  }

  const pct = check.total > 0 ? Math.round((check.done / check.total) * 100) : 0;
  const viewLabels: { key: View; label: string; count: number }[] = [
    { key: "all", label: "All", count: counts.all },
    { key: "changing", label: "Changing", count: counts.changing },
    { key: "variances", label: "Variances only", count: counts.variances },
    { key: "drifted", label: "Drifted only", count: counts.drifted },
    ...(stocktake.mode === "SCOPED" ? [{ key: "uncounted" as View, label: "Not counted", count: counts.uncounted }] : []),
    { key: "flagged", label: "Flagged", count: counts.flagged },
  ];

  return (
    <main className="p-4 md:p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <Link to={`/stocktakes/${stocktake.id}`} className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">← Stocktake details</Link>
          <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100 flex flex-wrap items-center gap-2">
            Review: {stocktake.name}
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusStyles[stocktake.status]}`}>{statusLabels[stocktake.status]}</span>
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">{modeLabels[stocktake.mode]}</span>
          </h2>
        </div>
        <Form method="post">
          <input type="hidden" name="intent" value="back-to-counting" />
          <button
            type="submit"
            disabled={busy || check.running}
            className="text-sm font-medium border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-lg px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
          >
            ← Back to counting
          </button>
        </Form>
      </div>

      {actionError && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl px-4 py-3 mb-4 text-sm text-red-700 dark:text-red-300">{actionError}</div>
      )}

      {/* Drift check status */}
      <div className={`${card} px-5 py-4 mb-4`}>
        {check.running ? (
          <>
            <div className="flex items-center justify-between mb-2 text-sm">
              <span className="font-medium text-gray-700 dark:text-gray-200">Checking live Shopify quantities for drift…</span>
              <span className="tabular-nums text-gray-500 dark:text-gray-400">{check.done.toLocaleString()} / {check.total.toLocaleString()} ({pct}%)</span>
            </div>
            <div className="h-2 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
              <div className="h-full bg-indigo-500 transition-[width] duration-500" style={{ width: `${pct}%` }} />
            </div>
          </>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <span className={check.error ? "text-red-600 dark:text-red-400" : "text-gray-600 dark:text-gray-300"}>
              {check.error
                ? `The drift check failed: ${check.error}`
                : check.checkedAt
                  ? `Live quantities checked ${new Date(check.checkedAt).toLocaleString()} (${check.total.toLocaleString()} items). ${counts.drifted} drifted.`
                  : "The drift check hasn't run (the server may have restarted)."}
            </span>
            <Form method="post">
              <input type="hidden" name="intent" value="rerun-check" />
              <button type="submit" disabled={busy} className="text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-50">
                Re-run drift check
              </button>
            </Form>
          </div>
        )}
      </div>

      {openUnknowns > 0 && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl px-4 py-3 mb-4 text-sm text-amber-800 dark:text-amber-300">
          {openUnknowns} unrecognised barcode{openUnknowns === 1 ? " is" : "s are"} still in Needs attention. Their scans aren't counted. Go back to counting to link them.
        </div>
      )}

      {/* Totals */}
      <div className={`${card} px-5 py-4 mb-4`}>
        <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
          <Stat label="Items changing" value={totals.itemsChanging.toLocaleString()} />
          <Stat label="Units up" value={`+${totals.unitsUp.toLocaleString()}`} tone="up" />
          <Stat label="Units down" value={`−${totals.unitsDown.toLocaleString()}`} tone="down" />
          <Stat label="Net units" value={signed(totals.net)} />
          <Stat label="Net dollar impact (at cost)" value={signedMoney(totals.netValue)} />
        </div>
        <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
          Changes are measured against live Shopify on-hand at review time (target − live).
          {totals.changingNoCost > 0 && ` ${totals.changingNoCost} changing item${totals.changingNoCost === 1 ? " has" : "s have"} no cost and ${totals.changingNoCost === 1 ? "is" : "are"} left out of the dollar figure.`}
        </p>
      </div>

      {/* Set unscanned to 0 */}
      {stocktake.mode === "SCOPED" && (
        <ZeroUnscannedPanel on={stocktake.zeroUnscanned} preview={zeroPreview} disabled={busy || check.running} />
      )}

      {/* Bulk drift decisions */}
      {counts.drifted > 0 && (
        <div className="rounded-2xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-5 py-4 mb-4">
          <p className="text-sm text-amber-900 dark:text-amber-200 mb-2">
            <span className="font-semibold">{counts.drifted} item{counts.drifted === 1 ? "" : "s"} drifted</span> — Shopify's on-hand changed since the count started
            (sold or received during the count). {counts.pendingDrift > 0 ? `${counts.pendingDrift} still need a decision.` : "All have a decision."}
          </p>
          <p className="text-xs text-amber-800/80 dark:text-amber-300/80 mb-3">
            Keep count: set Shopify to exactly what was counted. Adjust for movement: counted + (live − expected), which keeps sales or receipts that happened during the count. Skip: leave Shopify unchanged.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-amber-900 dark:text-amber-200">Set all undecided to:</span>
            {RESOLUTIONS.map((r) => (
              <Form method="post" key={r}>
                <input type="hidden" name="intent" value="resolve-bulk" />
                <input type="hidden" name="scope" value="unresolved" />
                <input type="hidden" name="resolution" value={r} />
                <button type="submit" disabled={busy || !editable || counts.pendingDrift === 0} className="text-xs font-medium bg-white dark:bg-gray-900 border border-amber-300 dark:border-amber-700 text-amber-900 dark:text-amber-200 rounded-lg px-2.5 py-1 disabled:opacity-50">
                  {resolutionLabels[r]}
                </button>
              </Form>
            ))}
            <Form
              method="post"
              onSubmit={(e) => { if (!window.confirm("Clear the decision on every drifted item?")) e.preventDefault(); }}
            >
              <input type="hidden" name="intent" value="resolve-bulk" />
              <input type="hidden" name="scope" value="all" />
              <input type="hidden" name="resolution" value="" />
              <button type="submit" disabled={busy || !editable} className="text-xs text-amber-800 dark:text-amber-300 hover:underline disabled:opacity-50 ml-2">
                Clear all decisions
              </button>
            </Form>
          </div>
        </div>
      )}

      {/* Table */}
      <div className={card}>
        <div className="flex flex-wrap gap-1 px-4 py-3 border-b border-gray-100 dark:border-gray-700">
          {viewLabels.map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => setView(v.key)}
              className={`text-xs font-medium px-2.5 py-1 rounded-full ${list.view === v.key ? "bg-indigo-600 text-white" : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"}`}
            >
              {v.label} <span className="opacity-70">{v.count}</span>
            </button>
          ))}
        </div>
        {rows.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-gray-400">No items in this view.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
                  <th className="text-left px-3 py-2 font-medium">Product / SKU</th>
                  <th className="text-right px-3 py-2 font-medium">Expected</th>
                  <th className="text-right px-3 py-2 font-medium">Live</th>
                  <th className="text-right px-3 py-2 font-medium" title="Shopify available at review time, for reference only">Available</th>
                  <th className="text-right px-3 py-2 font-medium">Counted</th>
                  <th className="text-right px-3 py-2 font-medium">Variance</th>
                  <th className="text-right px-3 py-2 font-medium">Variance $</th>
                  <th className="text-left px-3 py-2 font-medium">Drift decision</th>
                  <th className="text-right px-3 py-2 font-medium">Set Shopify to</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => <ReviewRow key={r.id} row={r} editable={editable} />)}
              </tbody>
            </table>
          </div>
        )}
        {list.totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 text-sm">
            <div>{list.page > 1 && <button type="button" onClick={() => setPage(list.page - 1)} className="text-indigo-600 dark:text-indigo-400 hover:underline">← Previous</button>}</div>
            <span className="text-gray-500 dark:text-gray-400">Page {list.page} of {list.totalPages} · {list.matching.toLocaleString()} items</span>
            <div>{list.page < list.totalPages && <button type="button" onClick={() => setPage(list.page + 1)} className="text-indigo-600 dark:text-indigo-400 hover:underline">Next →</button>}</div>
          </div>
        )}
      </div>

      {/* Readiness */}
      <div className={`${card} px-5 py-4 mt-4 flex flex-wrap items-center justify-between gap-3`}>
        {blockers.length > 0 ? (
          <ul className="text-sm text-gray-600 dark:text-gray-300 list-disc pl-5 space-y-0.5">
            {blockers.map((b) => <li key={b}>{b}</li>)}
          </ul>
        ) : (
          <p className="text-sm text-green-700 dark:text-green-400">Ready to apply: {totals.itemsChanging.toLocaleString()} items will be set in Shopify.</p>
        )}
        <button type="button" disabled title="The apply step is built in the next phase" className="text-sm font-medium bg-indigo-600 text-white rounded-lg px-4 py-2 opacity-50 cursor-not-allowed">
          Continue to apply
        </button>
      </div>
    </main>
  );
}

type Row = Route.ComponentProps["loaderData"]["rows"][number];

function ReviewRow({ row: r, editable }: { row: Row; editable: boolean }) {
  const fetcher = useFetcher();
  const saving = fetcher.state !== "idle";
  const flag = r.issue ? issueText[r.issue] : null;

  let setTo: React.ReactNode;
  if (r.negative) setTo = <span className="text-red-600 dark:text-red-400" title="Targets can't be negative. Choose Keep count or Skip, or fix the count.">Would be {r.target} ✕</span>;
  else if (r.issue === "UNTRACKED" || r.issue === "MISSING") setTo = <span className="text-gray-400">Won't apply</span>;
  else if (!r.included) setTo = <span className="text-gray-400">Unchanged</span>;
  else if (r.pendingDrift) setTo = <span className="text-amber-600 dark:text-amber-400">Decide</span>;
  else if (r.drifted && r.resolution === "SKIP") setTo = <span className="text-gray-400">Skipped</span>;
  else if (r.changing) setTo = <span className="font-semibold text-gray-900 dark:text-white">{r.target} <span className={`text-xs ${r.change > 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>({signed(r.change)})</span></span>;
  else if (r.target != null) setTo = <span className="text-gray-400">No change</span>;
  else setTo = <span className="text-gray-400">—</span>;

  return (
    <tr className={`border-b border-gray-50 dark:border-gray-800 ${r.drifted ? "bg-amber-50/50 dark:bg-amber-900/10" : ""}`}>
      <td className="px-3 py-2">
        <div className="text-gray-800 dark:text-gray-100">{r.title}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400">
          {r.variantTitle}
          {r.sku && <span className="ml-2 font-mono">{r.sku}</span>}
          {r.outsideScope && <span className="ml-2 text-amber-600 dark:text-amber-400">outside scope</span>}
          {r.zeroedUnscanned && <span className="ml-2 text-red-600 dark:text-red-400">unscanned → 0</span>}
        </div>
        {flag && <div className="text-xs text-red-600 dark:text-red-400 mt-0.5" title={flag.long}>⚠ {flag.short}: {flag.long}</div>}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-gray-600 dark:text-gray-400">{r.expected}</td>
      <td className={`px-3 py-2 text-right tabular-nums ${r.drifted ? "font-semibold text-amber-700 dark:text-amber-400" : "text-gray-600 dark:text-gray-400"}`}>
        {r.live ?? (r.issue === "NOT_STOCKED" ? "0*" : "—")}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-gray-400">{r.available ?? "—"}</td>
      <td className="px-3 py-2 text-right tabular-nums font-semibold text-gray-800 dark:text-gray-100">{r.counted ?? (r.zeroedUnscanned ? "0" : "—")}</td>
      <td className={`px-3 py-2 text-right tabular-nums ${r.variance ? (r.variance > 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400") : "text-gray-400"}`}>
        {r.variance != null ? signed(r.variance) : "—"}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-gray-600 dark:text-gray-400">
        {r.varianceValue != null ? signedMoney(r.varianceValue) : r.variance != null ? "no cost" : "—"}
      </td>
      <td className="px-3 py-2">
        {r.drifted && r.options ? (
          <select
            value={r.resolution ?? ""}
            disabled={!editable || saving}
            onChange={(e) => fetcher.submit({ intent: "resolve", itemId: String(r.id), resolution: e.target.value }, { method: "post" })}
            className={`text-xs border rounded-lg px-2 py-1 bg-white dark:bg-gray-800 dark:text-gray-200 ${r.resolution ? "border-gray-200 dark:border-gray-600" : "border-amber-400"}`}
          >
            <option value="">Decide…</option>
            <option value="KEEP_COUNT">Keep count (→ {r.options.KEEP_COUNT})</option>
            <option value="ADJUST_FOR_MOVEMENT">Adjust for movement (→ {r.options.ADJUST_FOR_MOVEMENT})</option>
            <option value="SKIP">Skip (leave at {r.live ?? 0})</option>
          </select>
        ) : (
          <span className="text-xs text-gray-400">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{setTo}</td>
    </tr>
  );
}

function ZeroUnscannedPanel({ on, preview, disabled }: {
  on: boolean;
  preview: { items: number; unitsRemoved: number; valueRemoved: number };
  disabled: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  if (on) {
    return (
      <div className="rounded-2xl border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-5 py-4 mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-red-800 dark:text-red-300">
          <span className="font-semibold">Set unscanned items to 0 is ON.</span> {preview.items.toLocaleString()} unscanned item{preview.items === 1 ? "" : "s"} will be set to 0 in Shopify when applied.
        </p>
        <Form method="post">
          <input type="hidden" name="intent" value="zero-off" />
          <button type="submit" disabled={disabled} className="text-sm font-medium border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 rounded-lg px-3 py-1.5 disabled:opacity-50">
            Turn off
          </button>
        </Form>
      </div>
    );
  }

  return (
    <div className={`${card} px-5 py-4 mb-4`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-600 dark:text-gray-300">
          {preview.items.toLocaleString()} item{preview.items === 1 ? " was" : "s were"} not scanned and will be left unchanged in Shopify.
        </p>
        {!confirming && preview.items > 0 && (
          <button type="button" onClick={() => setConfirming(true)} disabled={disabled} className="text-sm font-medium text-red-600 dark:text-red-400 hover:underline disabled:opacity-50">
            Set unscanned items to 0…
          </button>
        )}
      </div>
      {confirming && (
        <Form method="post" className="mt-3 rounded-xl border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4 space-y-3">
          <input type="hidden" name="intent" value="zero-on" />
          <input type="hidden" name="confirmedCount" value={preview.items} />
          <p className="text-sm text-red-800 dark:text-red-300">
            This will set <span className="font-semibold">{preview.items.toLocaleString()} unscanned items</span> to 0 in Shopify when the stocktake is applied.
            Based on the start snapshot that removes <span className="font-semibold">{preview.unitsRemoved.toLocaleString()} units</span> worth{" "}
            <span className="font-semibold">{money(preview.valueRemoved)}</span> at cost. Live quantities are re-checked as soon as you turn this on.
          </p>
          <label className="flex items-center gap-2 text-sm text-red-800 dark:text-red-300">
            <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="accent-red-600" />
            I understand {preview.items.toLocaleString()} items I did not scan will be set to 0.
          </label>
          <div className="flex gap-2">
            <button type="submit" disabled={!acknowledged || disabled} className="text-sm font-medium bg-red-600 hover:bg-red-700 text-white rounded-lg px-3 py-1.5 disabled:opacity-50">
              Turn on and re-check
            </button>
            <button type="button" onClick={() => { setConfirming(false); setAcknowledged(false); }} className="text-sm text-gray-600 dark:text-gray-300 hover:underline">
              Cancel
            </button>
          </div>
        </Form>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  const cls = tone === "up" ? "text-green-600 dark:text-green-400" : tone === "down" ? "text-red-600 dark:text-red-400" : "text-gray-800 dark:text-gray-100";
  return (
    <div>
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${cls}`}>{value}</div>
    </div>
  );
}
