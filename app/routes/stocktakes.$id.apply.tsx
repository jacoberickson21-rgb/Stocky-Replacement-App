import { Link, data, redirect, useFetcher } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/stocktakes.$id.apply";
import { requireUserId } from "../session.server";
import { getDb } from "../db.server";
import { getLocationName } from "../services/shopify.server";
import { APPLY_CHUNK_SIZE, APPLY_REASON } from "../utils/stocktake-apply-constants";
import {
  StocktakeApplyError,
  buildDryRun,
  getApplyPlan,
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
  if (st.status !== "REVIEW") throw redirect(`/stocktakes/${id}`);

  const plan = await getApplyPlan(id);
  let locationName: string | null = null;
  try {
    locationName = await getLocationName(plan.stocktake.locationId);
  } catch {
    /* shown as the ID only */
  }
  return { plan, locationName };
}

type DryRunResult = {
  generatedAt: string;
  attempt: number;
  reason: string;
  blockers: string[];
  items: ApplyPlanItem[];
  chunks: DryRunChunk[];
};

export async function action({ request, params }: Route.ActionArgs) {
  await requireUserId(request);
  const id = Number(params.id);
  const form = await request.formData();

  if (form.get("intent") === "dry-run") {
    try {
      // Re-planned from the database right now — exactly what would be sent.
      // Builds the payload only. No Shopify calls.
      const plan = await getApplyPlan(id);
      const dry = buildDryRun(plan);
      const result: DryRunResult = {
        generatedAt: new Date().toISOString(),
        attempt: dry.attempt,
        reason: APPLY_REASON,
        blockers: plan.blockers,
        items: plan.eligible,
        chunks: dry.chunks,
      };
      return { dryRun: result };
    } catch (err) {
      if (err instanceof StocktakeApplyError) return data({ error: err.message }, { status: 400 });
      throw err;
    }
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

const card = "bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700";
const money = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: "USD" });
const signed = (n: number) => (n > 0 ? `+${n.toLocaleString()}` : n.toLocaleString());
const signedMoney = (n: number) => (n > 0 ? `+${money(n)}` : money(n));

export default function StocktakeApplyPage({ loaderData }: Route.ComponentProps) {
  const { plan, locationName } = loaderData;
  const { stocktake, totals, blockers } = plan;
  const dryFetcher = useFetcher<typeof action>();
  const dryRun = dryFetcher.data && "dryRun" in dryFetcher.data ? dryFetcher.data.dryRun : null;
  const dryError = dryFetcher.data && "error" in dryFetcher.data ? dryFetcher.data.error : null;

  return (
    <main className="p-4 md:p-8 max-w-6xl mx-auto">
      <Link to={`/stocktakes/${stocktake.id}/review`} className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">← Back to review</Link>
      <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100 mb-4">Apply: {stocktake.name}</h2>

      {blockers.length > 0 && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl px-4 py-3 mb-4 text-sm text-red-800 dark:text-red-300">
          <p className="font-semibold mb-1">Apply is blocked:</p>
          <ul className="list-disc pl-5 space-y-0.5">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
          <Link to={`/stocktakes/${stocktake.id}/review`} className="inline-block mt-2 underline">Fix on the review screen</Link>
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
          <div><dt className="inline font-medium">Sets: </dt><dd className="inline">on_hand (absolute quantities), reason <span className="font-mono">{APPLY_REASON}</span></dd></div>
          <div><dt className="inline font-medium">Batches: </dt><dd className="inline">{Math.ceil(totals.itemsChanging / APPLY_CHUNK_SIZE)} of up to {APPLY_CHUNK_SIZE}</dd></div>
        </dl>
        <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
          Change = target − live on_hand at review. Each item is only set if Shopify still holds the live value seen at review (changeFromQuantity).
          {totals.changingNoCost > 0 && ` ${totals.changingNoCost} changing item${totals.changingNoCost === 1 ? " has" : "s have"} no cost and ${totals.changingNoCost === 1 ? "is" : "are"} left out of the dollar figure.`}
          {plan.alreadyApplied > 0 && ` ${plan.alreadyApplied} item${plan.alreadyApplied === 1 ? " was" : "s were"} already applied and won't be sent again.`}
        </p>
      </div>

      {plan.needsActivation.length > 0 && (
        <ExcludedList
          tone="amber"
          title={`${plan.needsActivation.length} not applied — needs activation`}
          body="These items have no inventory level at this location, so their quantity can't be set yet. They are left out of this apply. Activate them at the location in Shopify, then re-run the drift check."
          items={plan.needsActivation}
        />
      )}
      {plan.unsettable.length > 0 && (
        <ExcludedList
          tone="red"
          title={`${plan.unsettable.length} flagged as unsettable`}
          body="Tracking is off for these, or they no longer exist in Shopify. They block apply."
          items={plan.unsettable}
        />
      )}

      {/* Dry run */}
      <div className={`${card} px-5 py-4 mb-4`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Dry run</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">Builds the exact payload per item and per batch. Makes no Shopify calls.</p>
          </div>
          <dryFetcher.Form method="post">
            <input type="hidden" name="intent" value="dry-run" />
            <button type="submit" disabled={dryFetcher.state !== "idle"} className="text-sm font-medium bg-gray-800 dark:bg-gray-700 hover:bg-gray-900 text-white rounded-lg px-4 py-2 disabled:opacity-50">
              {dryFetcher.state !== "idle" ? "Building…" : dryRun ? "Rebuild dry run" : "Dry run"}
            </button>
          </dryFetcher.Form>
        </div>
        {dryError && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{dryError}</p>}
        {dryRun && <DryRunView dryRun={dryRun} stocktakeId={stocktake.id} />}
      </div>

      {/* Real apply — not built at checkpoint 1 */}
      <div className={`${card} px-5 py-4 opacity-70`}>
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Apply to Shopify</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Not available yet. Writing to Shopify is built after the dry run has been reviewed.
        </p>
      </div>
    </main>
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
      dryRun.chunks.map((c) => ({
        mutation: "inventorySetQuantities",
        idempotencyKey: c.idempotencyKey,
        input: c.input,
      })),
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

function ExcludedList({ tone, title, body, items }: { tone: "amber" | "red"; title: string; body: string; items: ExcludedItem[] }) {
  const [open, setOpen] = useState(false);
  const cls = tone === "amber"
    ? "border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200"
    : "border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-red-900 dark:text-red-200";
  return (
    <div className={`rounded-2xl border px-5 py-4 mb-4 ${cls}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">{title}</p>
        <button type="button" onClick={() => setOpen(!open)} className="text-xs underline">{open ? "Hide" : "Show items"}</button>
      </div>
      <p className="text-xs mt-1 opacity-80">{body}</p>
      {open && (
        <ul className="mt-2 text-xs space-y-0.5 max-h-64 overflow-y-auto">
          {items.map((i) => (
            <li key={i.itemId}>
              {i.title} — {i.variantTitle} {i.sku && <span className="font-mono">({i.sku})</span>} · counted {i.counted ?? "—"}
              {i.targetQty != null && <> · target {i.targetQty}</>}
            </li>
          ))}
        </ul>
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
