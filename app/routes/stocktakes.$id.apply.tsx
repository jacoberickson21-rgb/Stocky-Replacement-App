import { Link, data, redirect, useFetcher, useRevalidator } from "react-router";
import { useEffect, useState } from "react";
import type { Route } from "./+types/stocktakes.$id.apply";
import { requireUserId } from "../session.server";
import { getDb } from "../db.server";
import { logFailure } from "../services/failure-log.server";
import { getLocationName } from "../services/shopify.server";
import { StocktakeReviewError } from "../services/stocktake-review.server";
import { APPLY_CHUNK_SIZE, APPLY_REASON } from "../utils/stocktake-apply-constants";
import {
  StocktakeApplyError,
  buildDryRun,
  excludeItem,
  getApplyPlan,
  includeItem,
  isApplyRunning,
  isHeartbeatStale,
  returnStalledRunToReview,
  startApplyRun,
  type ApplyPlanItem,
  type DryRunChunk,
  type ExcludedItem,
} from "../services/stocktake-apply.server";

const PAGE_SIZE = 50;

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
  const id = Number(params.id);
  const st = await getDb().stocktake.findUnique({ where: { id }, select: { status: true } });
  if (!st) throw new Response("Not Found", { status: 404 });
  if (st.status !== "REVIEW" && st.status !== "APPLYING") throw redirect(`/stocktakes/${id}`);

  const plan = await getApplyPlan(id, { expectStatus: st.status === "APPLYING" ? "APPLYING" : "REVIEW" });
  let locationName: string | null = null;
  try {
    locationName = await getLocationName(plan.stocktake.locationId);
  } catch {
    /* shown as the ID only */
  }
  const running = isApplyRunning(id);
  return {
    plan,
    locationName,
    running,
    stalled: st.status === "APPLYING" && !running && isHeartbeatStale(plan.stocktake.applyHeartbeatAt),
  };
}

type DryRunResult = {
  generatedAt: string;
  attempt: number;
  reason: string;
  blockers: string[];
  items: ApplyPlanItem[];
  chunks: DryRunChunk[];
};

type ActionResult =
  | { ok: true; dryRun?: DryRunResult; message?: string }
  | { ok: false; error: string };

export async function action({ request, params }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const stocktakeId = Number(params.id);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const understood = form.get("understood") === "yes";
  const typedName = String(form.get("typedName") ?? "");
  const result = (r: ActionResult, status = 200) => data(r, { status });

  try {
    switch (intent) {
      case "dry-run": {
        // Re-planned from the database right now. Builds the payload only — no Shopify calls.
        const plan = await getApplyPlan(stocktakeId);
        const dry = buildDryRun(plan);
        return result({
          ok: true,
          dryRun: {
            generatedAt: new Date().toISOString(),
            attempt: dry.attempt,
            reason: dry.reason,
            blockers: plan.blockers,
            items: plan.sendable,
            chunks: dry.chunks,
          },
        });
      }
      case "exclude":
        await excludeItem({ stocktakeId, userId, itemId: Number(form.get("itemId")), reason: String(form.get("reason") ?? "") });
        return result({ ok: true, message: "Item excluded from apply." });
      case "include":
        await includeItem({ stocktakeId, userId, itemId: Number(form.get("itemId")) });
        return result({ ok: true, message: "Item included again." });
      case "apply":
        await startApplyRun(form.get("kind") === "retry" ? "retry" : "full", { stocktakeId, userId, understood, typedName });
        return result({ ok: true, message: "Apply started." });
      case "resume":
        await startApplyRun("resume", { stocktakeId, userId, understood, typedName });
        return result({ ok: true, message: "Resumed. Items are reconciled with Shopify before anything is sent." });
      case "return-to-review":
        await returnStalledRunToReview({ stocktakeId, userId });
        return result({ ok: true, message: "Returned to review." });
      default:
        return result({ ok: false, error: "Unknown action." }, 400);
    }
  } catch (err) {
    if (err instanceof StocktakeApplyError || err instanceof StocktakeReviewError) {
      return result({ ok: false, error: err.message }, 400);
    }
    const msg = err instanceof Error ? err.message : String(err);
    await logFailure("STOCKTAKE_APPLY", `Stocktake #${stocktakeId} ${intent}`, msg);
    return result({ ok: false, error: "Something went wrong. The error has been logged." }, 500);
  }
}

// ─── UI ────────────────────────────────────────────────────────────────────────

const card = "bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700";
const inputCls =
  "text-sm border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500";
const money = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: "USD" });
const signed = (n: number) => (n > 0 ? `+${n.toLocaleString()}` : n.toLocaleString());
const signedMoney = (n: number) => (n > 0 ? `+${money(n)}` : money(n));

export default function StocktakeApplyPage({ loaderData }: Route.ComponentProps) {
  const { plan, locationName, running, stalled } = loaderData;
  const { stocktake, totals, blockers } = plan;
  const fetcher = useFetcher<typeof action>();
  const dryFetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const [understood, setUnderstood] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);

  const busy = fetcher.state !== "idle";
  const last = fetcher.data;
  const applying = stocktake.status === "APPLYING";

  useEffect(() => {
    if (!applying) return;
    const t = window.setInterval(() => revalidator.revalidate(), 2000);
    return () => window.clearInterval(t);
  }, [applying]); // eslint-disable-line react-hooks/exhaustive-deps

  const dryRun = dryFetcher.data && dryFetcher.data.ok ? dryFetcher.data.dryRun ?? null : null;
  const dryError = dryFetcher.data && !dryFetcher.data.ok ? dryFetcher.data.error : null;

  const retryMode = stocktake.applyError != null;
  const nameOk = !plan.requiresNameConfirm || typedName.trim() === stocktake.name.trim();
  const canWrite = understood && blockers.length === 0 && !busy && !applying;

  function submit(intent: string, extra: Record<string, string> = {}) {
    fetcher.submit(
      { intent, understood: understood ? "yes" : "no", typedName, ...extra },
      { method: "post" }
    );
  }

  return (
    <main className="p-4 md:p-8 max-w-6xl mx-auto">
      <Link to={`/stocktakes/${stocktake.id}/review`} className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">← Back to review</Link>
      <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100 mb-4">Apply: {stocktake.name}</h2>

      {last && !last.ok && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl px-4 py-3 mb-4 text-sm text-red-800 dark:text-red-300">{last.error}</div>
      )}
      {last && last.ok && last.message && (
        <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl px-4 py-3 mb-4 text-sm text-green-800 dark:text-green-300">{last.message}</div>
      )}

      {applying && (
        <ApplyProgress
          plan={plan}
          running={running}
          stalled={stalled}
          busy={busy}
          understood={understood}
          setUnderstood={setUnderstood}
          typedName={typedName}
          setTypedName={setTypedName}
          onResume={() => submit("resume")}
          onReturn={() => submit("return-to-review")}
        />
      )}

      {!applying && stocktake.applyError && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700 rounded-xl px-4 py-3 mb-4 text-sm text-amber-900 dark:text-amber-200">
          <p className="font-semibold">The last apply left items unapplied.</p>
          <p className="mt-0.5">{stocktake.applyError}</p>
        </div>
      )}

      {!applying && blockers.length > 0 && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl px-4 py-3 mb-4 text-sm text-red-800 dark:text-red-300">
          <p className="font-semibold mb-1">Apply is blocked:</p>
          <ul className="list-disc pl-5 space-y-0.5">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
          <Link to={`/stocktakes/${stocktake.id}/review`} className="inline-block mt-2 underline">Go to the review screen</Link>
        </div>
      )}

      {/* What will happen */}
      <div className={`${card} px-5 py-4 mb-4`}>
        <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
          <Stat label="Items changing" value={totals.itemsChanging.toLocaleString()} />
          <Stat label="Units up" value={`+${totals.unitsUp.toLocaleString()}`} tone="up" />
          <Stat label="Units down" value={`−${totals.unitsDown.toLocaleString()}`} tone="down" />
          <Stat label="Net units" value={signed(totals.net)} />
          <Stat label="Net dollar impact (at cost)" value={signedMoney(totals.netValue)} />
        </div>
        <dl className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
          <div><dt className="inline font-medium">Location: </dt><dd className="inline">{locationName ?? "(name unavailable)"} <span className="font-mono">{stocktake.locationId}</span></dd></div>
          <div><dt className="inline font-medium">Drift check: </dt><dd className="inline">{plan.checkedAt ? new Date(plan.checkedAt).toLocaleString() : "not run"}</dd></div>
          <div><dt className="inline font-medium">Sets: </dt><dd className="inline">on_hand (absolute quantities), reason <span className="font-mono">{stocktake.applyReason ?? APPLY_REASON}</span>{stocktake.applyReason ? " (accepted by Shopify)" : " (switches to correction automatically if Shopify rejects it)"}</dd></div>
          <div><dt className="inline font-medium">Batches: </dt><dd className="inline">{Math.ceil(plan.sendable.length / APPLY_CHUNK_SIZE)} of up to {APPLY_CHUNK_SIZE}</dd></div>
          {plan.alreadyApplied > 0 && <div><dt className="inline font-medium">Already applied: </dt><dd className="inline">{plan.alreadyApplied} (never sent again)</dd></div>}
        </dl>
        <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
          Change = target − live on_hand at review. Each item is only set if Shopify still holds the live value seen at review.
          {totals.changingNoCost > 0 && ` ${totals.changingNoCost} changing item${totals.changingNoCost === 1 ? " has" : "s have"} no cost and ${totals.changingNoCost === 1 ? "is" : "are"} left out of the dollar figure.`}
        </p>
      </div>

      {/* Item lists */}
      {plan.unsettable.length > 0 && (
        <ItemList tone="red" title={`${plan.unsettable.length} flagged as unsettable — blocking`} body="Tracking is off for these, or they no longer exist in Shopify. Exclude each one, with a reason, to continue." items={plan.unsettable} defaultOpen>
          {(i) => <ExcludeForm item={i} fetcher={fetcher} disabled={busy || applying} />}
        </ItemList>
      )}
      {plan.excluded.length > 0 && (
        <ItemList tone="gray" title={`${plan.excluded.length} excluded`} body="Excluded from apply. They are not in the totals or the payload." items={plan.excluded}>
          {(i) => (
            <span className="inline-flex items-center gap-2">
              <span className="opacity-80">by {i.excludedBy ?? "—"} {i.excludedAt ? new Date(i.excludedAt).toLocaleString() : ""}: “{i.excludeReason}”</span>
              {plan.alreadyApplied === 0 && !applying && (
                <button type="button" disabled={busy} onClick={() => submit("include", { itemId: String(i.itemId) })} className="underline disabled:opacity-50">Include again</button>
              )}
            </span>
          )}
        </ItemList>
      )}
      {plan.needsActivation.length > 0 && (
        <ItemList tone="amber" title={`${plan.needsActivation.length} not applied — needs activation`} body="No inventory level at this location, so the quantity can't be set yet. These are left out of this apply. Activate them at the location in Shopify, then re-run the drift check." items={plan.needsActivation} />
      )}
      {plan.stale.length > 0 && (
        <SimpleList tone="red" title={`${plan.stale.length} changed in Shopify since review`} items={plan.stale} />
      )}
      {plan.failed.length > 0 && (
        <SimpleList tone="amber" title={`${plan.failed.length} failed on the last attempt — will be retried`} items={plan.failed} />
      )}

      {/* Apply to Shopify */}
      {!applying && (
        <div className={`${card} px-5 py-4 space-y-4`}>
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Apply to Shopify</h3>

          <label className="flex items-start gap-2 text-sm text-gray-800 dark:text-gray-100 rounded-lg border border-red-200 dark:border-red-800 bg-red-50/60 dark:bg-red-900/10 px-3 py-2">
            <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} className="mt-0.5 accent-red-600" />
            <span>I understand this writes to <strong>live Shopify inventory</strong> at {locationName ?? "this location"}.</span>
          </label>

          <div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {retryMode
                ? "Only items not yet applied are touched. Each one's live quantity is read back first: items already at their target are marked applied without sending anything."
                : `Sends ${plan.sendable.length.toLocaleString()} items in batches of ${APPLY_CHUNK_SIZE} in the background. You can leave this page.`}
            </p>
            {plan.requiresNameConfirm && (
              <label className="block mt-2 text-xs text-gray-600 dark:text-gray-300">
                This changes more than 10% of the stocktake's items or more than {money(5000)} net. Type the stocktake name to confirm:
                <input value={typedName} onChange={(e) => setTypedName(e.target.value)} placeholder={stocktake.name} className={`${inputCls} w-full mt-1`} />
              </label>
            )}
            <button
              type="button"
              disabled={!canWrite || !nameOk}
              onClick={() => {
                const msg = `${retryMode ? "Retry" : "Apply"} ${plan.sendable.length} items to live Shopify inventory?\n\n+${totals.unitsUp} / −${totals.unitsDown} units, net ${signedMoney(totals.netValue)} at cost.`;
                if (window.confirm(msg)) submit("apply", { kind: retryMode ? "retry" : "full" });
              }}
              className="mt-3 text-sm font-medium bg-red-600 hover:bg-red-700 text-white rounded-lg px-4 py-2 disabled:opacity-50"
            >
              {retryMode ? "Retry unapplied items" : `Apply ${plan.sendable.length.toLocaleString()} items to Shopify`}
            </button>
          </div>
        </div>
      )}

      {/* Optional payload preview — never required */}
      <div className="mt-3 text-xs text-gray-500 dark:text-gray-400">
        <button
          type="button"
          onClick={() => {
            const next = !previewOpen;
            setPreviewOpen(next);
            if (next) dryFetcher.submit({ intent: "dry-run" }, { method: "post" });
          }}
          className="hover:underline"
        >
          {previewOpen ? "Hide payload preview" : "Preview payload (no Shopify calls)"}
        </button>
        {previewOpen && (
          <div className={`${card} px-5 py-4 mt-2`}>
            {dryFetcher.state !== "idle" && <p className="text-xs text-gray-400">Building…</p>}
            {dryError && <p className="text-sm text-red-600 dark:text-red-400">{dryError}</p>}
            {dryRun && dryFetcher.state === "idle" && <DryRunView dryRun={dryRun} stocktakeId={stocktake.id} />}
          </div>
        )}
      </div>
    </main>
  );
}

type AnyFetcher = ReturnType<typeof useFetcher<typeof action>>;
type Plan = Route.ComponentProps["loaderData"]["plan"];

function ApplyProgress(props: {
  plan: Plan; running: boolean; stalled: boolean; busy: boolean;
  understood: boolean; setUnderstood: (v: boolean) => void;
  typedName: string; setTypedName: (v: string) => void;
  onResume: () => void; onReturn: () => void;
}) {
  const { plan, running, stalled } = props;
  const total = plan.stocktake.applyTotal ?? 0;
  const done = Math.min(plan.stocktake.applyDone ?? 0, total);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className={`${card} px-5 py-4 mb-4`}>
      <div className="flex items-center justify-between mb-2 text-sm">
        <span className="font-medium text-gray-700 dark:text-gray-200">{stalled ? "The apply stopped making progress." : "Applying to Shopify…"}</span>
        <span className="tabular-nums text-gray-500 dark:text-gray-400">{done.toLocaleString()} / {total.toLocaleString()} ({pct}%)</span>
      </div>
      <div className="h-2 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
        <div className={`h-full transition-[width] duration-500 ${stalled ? "bg-amber-500" : "bg-indigo-500"}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
        Last progress {plan.stocktake.applyHeartbeatAt ? new Date(plan.stocktake.applyHeartbeatAt).toLocaleTimeString() : "—"}.
        {running ? " Running on this server." : ""}
      </p>
      {stalled && (
        <div className="mt-3 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-3 py-3 space-y-2 text-sm text-amber-900 dark:text-amber-200">
          <p>No progress for 5 minutes (the server may have restarted). Resuming reads every unapplied item back from Shopify first — anything already at its target is marked applied without being sent.</p>
          {plan.blockers.length > 0 && (
            <p className="text-red-700 dark:text-red-300">Resume is blocked: {plan.blockers.join(" ")} Return to review, re-run the drift check, then use Retry.</p>
          )}
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={props.understood} onChange={(e) => props.setUnderstood(e.target.checked)} className="accent-red-600" />
            I understand this writes to live Shopify inventory.
          </label>
          {plan.requiresNameConfirm && (
            <input value={props.typedName} onChange={(e) => props.setTypedName(e.target.value)} placeholder={`Type “${plan.stocktake.name}” to confirm`} className={`${inputCls} w-full`} />
          )}
          <div className="flex gap-2">
            <button type="button" disabled={props.busy || !props.understood || plan.blockers.length > 0} onClick={props.onResume} className="text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg px-3 py-1.5 disabled:opacity-50">
              Resume
            </button>
            <button type="button" disabled={props.busy} onClick={props.onReturn} className="text-sm font-medium border border-amber-400 rounded-lg px-3 py-1.5 disabled:opacity-50">
              Return to review
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ExcludeForm({ item, fetcher, disabled }: { item: ExcludedItem; fetcher: AnyFetcher; disabled: boolean }) {
  const [reason, setReason] = useState("");
  return (
    <form
      className="inline-flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        fetcher.submit({ intent: "exclude", itemId: String(item.itemId), reason }, { method: "post" });
      }}
    >
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" className="text-xs border border-red-200 dark:border-red-800 rounded px-2 py-1 bg-white dark:bg-gray-900 w-52" />
      <button type="submit" disabled={disabled || reason.trim().length < 3} className="text-xs font-medium underline disabled:opacity-50">Exclude from apply</button>
    </form>
  );
}

const toneCls = {
  amber: "border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200",
  red: "border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-red-900 dark:text-red-200",
  gray: "border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 text-gray-800 dark:text-gray-200",
};

function ItemList({ tone, title, body, items, defaultOpen = false, children }: {
  tone: keyof typeof toneCls; title: string; body: string; items: ExcludedItem[]; defaultOpen?: boolean;
  children?: (item: ExcludedItem) => React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`rounded-2xl border px-5 py-4 mb-4 ${toneCls[tone]}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">{title}</p>
        <button type="button" onClick={() => setOpen(!open)} className="text-xs underline">{open ? "Hide" : "Show items"}</button>
      </div>
      <p className="text-xs mt-1 opacity-80">{body}</p>
      {open && (
        <ul className="mt-2 text-xs space-y-1.5 max-h-80 overflow-y-auto">
          {items.map((i) => (
            <li key={i.itemId} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {i.title} — {i.variantTitle} {i.sku && <span className="font-mono">({i.sku})</span>} · counted {i.counted ?? "—"}
                {i.targetQty != null && <> · target {i.targetQty}</>}
              </span>
              {children?.(i)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SimpleList({ tone, title, items }: { tone: keyof typeof toneCls; title: string; items: ApplyPlanItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`rounded-2xl border px-5 py-4 mb-4 ${toneCls[tone]}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">{title}</p>
        <button type="button" onClick={() => setOpen(!open)} className="text-xs underline">{open ? "Hide" : "Show items"}</button>
      </div>
      {open && (
        <ul className="mt-2 text-xs space-y-1 max-h-80 overflow-y-auto">
          {items.map((i) => (
            <li key={i.itemId}>
              {i.title} — {i.variantTitle} {i.sku && <span className="font-mono">({i.sku})</span>}: {i.changeFromQuantity} → {i.targetQty}
              {i.applyError && <div className="opacity-80">{i.applyError}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DryRunView({ dryRun, stocktakeId }: { dryRun: DryRunResult; stocktakeId: number }) {
  const [page, setPage] = useState(1);
  const [chunkIndex, setChunkIndex] = useState(0);
  const totalPages = Math.max(1, Math.ceil(dryRun.items.length / PAGE_SIZE));
  const rows = dryRun.items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const chunk = dryRun.chunks[chunkIndex];

  function download() {
    const body = JSON.stringify(
      dryRun.chunks.map((c) => ({ mutation: "inventorySetQuantities", idempotencyKey: c.idempotencyKey, input: c.input })),
      null,
      2
    );
    const url = URL.createObjectURL(new Blob([body], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `stocktake-${stocktakeId}-dry-run-attempt-${dryRun.attempt}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="rounded-lg bg-gray-50 dark:bg-gray-800 px-3 py-2 text-xs text-gray-600 dark:text-gray-300 flex flex-wrap items-center justify-between gap-2">
        <span>
          Built {new Date(dryRun.generatedAt).toLocaleTimeString()} · attempt {dryRun.attempt} · {dryRun.items.length} items in {dryRun.chunks.length} batch{dryRun.chunks.length === 1 ? "" : "es"} · reason <span className="font-mono">{dryRun.reason}</span> · no Shopify calls made
          {dryRun.blockers.length > 0 && <span className="text-red-600 dark:text-red-400"> · would currently be blocked</span>}
        </span>
        <button type="button" onClick={download} disabled={dryRun.chunks.length === 0} className="text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-50">
          Download full payload (JSON)
        </button>
      </div>

      {dryRun.items.length > 0 && (
        <div className="overflow-x-auto border border-gray-100 dark:border-gray-700 rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 border-b border-gray-100 dark:border-gray-700">
                <th className="text-left px-3 py-2 font-medium">Item</th>
                <th className="text-left px-3 py-2 font-medium">SKU</th>
                <th className="text-left px-3 py-2 font-medium">Inventory item</th>
                <th className="text-right px-3 py-2 font-medium">changeFromQuantity</th>
                <th className="text-right px-3 py-2 font-medium">quantity (target)</th>
                <th className="text-right px-3 py-2 font-medium">Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.itemId} className="border-b border-gray-50 dark:border-gray-800">
                  <td className="px-3 py-1.5">
                    <div className="text-gray-800 dark:text-gray-100">{r.title}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">{r.variantTitle}</div>
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs text-gray-600 dark:text-gray-400">{r.sku ?? "—"}</td>
                  <td className="px-3 py-1.5 font-mono text-xs text-gray-500 dark:text-gray-400">{r.inventoryItemId.replace("gid://shopify/InventoryItem/", "")}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-600 dark:text-gray-400">{r.changeFromQuantity}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums font-semibold text-gray-900 dark:text-white">{r.targetQty}</td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${r.change > 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>{signed(r.change)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-3 py-2 text-xs">
              <div>{page > 1 && <button type="button" onClick={() => setPage(page - 1)} className="text-indigo-600 dark:text-indigo-400 hover:underline">← Previous</button>}</div>
              <span className="text-gray-500">Page {page} of {totalPages}</span>
              <div>{page < totalPages && <button type="button" onClick={() => setPage(page + 1)} className="text-indigo-600 dark:text-indigo-400 hover:underline">Next →</button>}</div>
            </div>
          )}
        </div>
      )}

      {chunk && (
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-1 text-xs text-gray-600 dark:text-gray-300">
            <span className="font-medium">Raw request, batch</span>
            <select value={chunkIndex} onChange={(e) => setChunkIndex(Number(e.target.value))} className="text-xs border border-gray-200 dark:border-gray-600 rounded px-1 py-0.5 bg-white dark:bg-gray-800">
              {dryRun.chunks.map((c) => <option key={c.index} value={c.index}>{c.index + 1} of {dryRun.chunks.length} ({c.input.quantities.length} items)</option>)}
            </select>
          </div>
          <pre className="text-xs bg-gray-900 text-gray-100 rounded-lg p-3 overflow-x-auto max-h-96">
{`mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
  inventorySetQuantities(input: $input) @idempotent(key: "${chunk.idempotencyKey}") { … }
}

variables.input = ${JSON.stringify(chunk.input, null, 2)}`}
          </pre>
        </div>
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
