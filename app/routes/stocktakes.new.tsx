import { Form, Link, data, redirect, useActionData, useFetcher, useNavigation } from "react-router";
import type { ShouldRevalidateFunctionArgs } from "react-router";
import { useEffect, useRef, useState } from "react";
import { ClipboardList, ScanLine } from "lucide-react";
import type { Route } from "./+types/stocktakes.new";
import { requireUserId } from "../session.server";
import { logFailure } from "../services/failure-log.server";
import { EMPTY_SCOPE, type StocktakeScope } from "../utils/stocktake-scope";
import {
  StocktakeStartError,
  getScopeFilterOptions,
  getScopePreview,
  parseScope,
  startFreeScanStocktake,
  startScopedStocktake,
  type ScopePreview,
  type ScopePreviewRow,
} from "../services/stocktake.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  return { options: await getScopeFilterOptions() };
}

// Preview requests are fetcher POSTs — don't re-run the (relatively heavy)
// filter-options loader after each one.
export function shouldRevalidate({ formData, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (formData?.get("intent") === "preview") return false;
  return defaultShouldRevalidate;
}

type ActionResult = { preview: ScopePreview; error?: undefined } | { error: string; preview?: undefined };

function parseScopeField(raw: FormDataEntryValue | null): StocktakeScope {
  try {
    return parseScope(JSON.parse(String(raw ?? "{}")));
  } catch {
    return parseScope({});
  }
}

export async function action({ request }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "preview") {
    const scope = parseScopeField(form.get("scope"));
    const page = parseInt(String(form.get("page") ?? "1")) || 1;
    const result: ActionResult = { preview: await getScopePreview(scope, page) };
    return result;
  }

  if (intent === "start") {
    const mode = form.get("mode");
    const name = String(form.get("name") ?? "").trim();
    const notes = String(form.get("notes") ?? "").trim() || null;
    if (!name) return data<ActionResult>({ error: "Give the stocktake a name." }, { status: 400 });

    try {
      const id =
        mode === "FREE_SCAN"
          ? await startFreeScanStocktake({ name, notes, userId })
          : await startScopedStocktake({ name, notes, userId, scope: parseScopeField(form.get("scope")) });
      return redirect(`/stocktakes/${id}`);
    } catch (err) {
      if (err instanceof StocktakeStartError) {
        return data<ActionResult>({ error: err.message }, { status: 400 });
      }
      const msg = err instanceof Error ? err.message : String(err);
      await logFailure("STOCKTAKE_START", name, msg);
      return data<ActionResult>({ error: "Could not start the stocktake. The error has been logged." }, { status: 500 });
    }
  }

  return data<ActionResult>({ error: "Unknown action." }, { status: 400 });
}

const inputCls =
  "text-sm border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500";

const money = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: "USD" });

function todayLabel() {
  return new Date().toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function NewStocktakePage({ loaderData }: Route.ComponentProps) {
  const { options } = loaderData;
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const starting = navigation.state === "submitting" && navigation.formData?.get("intent") === "start";

  const [mode, setMode] = useState<"SCOPED" | "FREE_SCAN">("SCOPED");
  const [name, setName] = useState(`Stocktake ${todayLabel()}`);
  const [notes, setNotes] = useState("");
  const [scope, setScope] = useState<StocktakeScope>(EMPTY_SCOPE);
  const [searchText, setSearchText] = useState("");
  const [page, setPage] = useState(1);

  const previewFetcher = useFetcher<typeof action>();
  const preview = previewFetcher.data?.preview;
  const loadingPreview = previewFetcher.state !== "idle";

  // Debounce the name/SKU search box into the scope.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function handleSearch(val: string) {
    setSearchText(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setScope((s) => ({ ...s, q: val.trim() }));
      setPage(1);
    }, 350);
  }

  useEffect(() => {
    if (mode !== "SCOPED") return;
    previewFetcher.submit(
      { intent: "preview", scope: JSON.stringify(scope), page: String(page) },
      { method: "post" }
    );
  }, [scope, page, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  function setFilter<K extends keyof StocktakeScope>(key: K, value: StocktakeScope[K]) {
    setScope((s) => ({ ...s, [key]: value }));
    setPage(1);
  }

  function toggleVariant(variantId: string) {
    setScope((s) => ({
      ...s,
      excludedVariantIds: s.excludedVariantIds.includes(variantId)
        ? s.excludedVariantIds.filter((id) => id !== variantId)
        : [...s.excludedVariantIds, variantId],
    }));
  }

  function toggleProduct(productId: string) {
    setScope((s) => ({
      ...s,
      excludedProductIds: s.excludedProductIds.includes(productId)
        ? s.excludedProductIds.filter((id) => id !== productId)
        : [...s.excludedProductIds, productId],
    }));
  }

  function clearExclusions() {
    setScope((s) => ({ ...s, excludedVariantIds: [], excludedProductIds: [] }));
  }

  const removedCount = scope.excludedVariantIds.length + scope.excludedProductIds.length;
  const canStart = mode === "FREE_SCAN" || (preview != null && preview.totals.variants > 0 && !loadingPreview);

  return (
    <main className="p-8 max-w-6xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link to="/stocktakes" className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">← Stocktakes</Link>
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">New stocktake</h2>
      </div>

      {/* Mode */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <ModeCard
          active={mode === "SCOPED"}
          onClick={() => setMode("SCOPED")}
          icon={<ClipboardList size={20} />}
          title="Scoped count"
          body="Pick a set of products with filters. Expected quantities are snapshotted live from Shopify when you start."
        />
        <ModeCard
          active={mode === "FREE_SCAN"}
          onClick={() => setMode("FREE_SCAN")}
          icon={<ScanLine size={20} />}
          title="Free scan"
          body="No preloaded list. Each scanned item is added on the fly with its live Shopify quantity. Only scanned items are ever adjusted."
        />
      </div>

      {/* Name + notes */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-5 mb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="block">
          <span className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputCls} w-full`} />
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Notes (optional)</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className={`${inputCls} w-full`} />
        </label>
      </div>

      {mode === "SCOPED" && (
        <>
          {/* Filters */}
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-5 mb-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <FilterSelect label="Vendor" value={scope.vendor} onChange={(v) => setFilter("vendor", v)} options={options.vendors} />
              <FilterSelect label="Product type" value={scope.productType} onChange={(v) => setFilter("productType", v)} options={options.productTypes} />
              <label className="block">
                <span className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Tag</span>
                <input
                  list="stocktake-tags"
                  value={scope.tag}
                  onChange={(e) => setFilter("tag", e.target.value)}
                  placeholder="Any tag"
                  className={`${inputCls} w-full`}
                />
                <datalist id="stocktake-tags">
                  {options.tags.map((t) => <option key={t} value={t} />)}
                </datalist>
              </label>
              <FilterSelect label="Status" value={scope.status} onChange={(v) => setFilter("status", v)} options={options.statuses} />
              <label className="block">
                <span className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Stock level</span>
                <select value={scope.stock} onChange={(e) => setFilter("stock", e.target.value as StocktakeScope["stock"])} className={`${inputCls} w-full`}>
                  <option value="all">All</option>
                  <option value="in_stock">In stock</option>
                  <option value="zero_or_negative">Zero or negative</option>
                </select>
              </label>
              <label className="block">
                <span className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Barcode</span>
                <select value={scope.barcode} onChange={(e) => setFilter("barcode", e.target.value as StocktakeScope["barcode"])} className={`${inputCls} w-full`}>
                  <option value="all">All</option>
                  <option value="has">Has barcode</option>
                  <option value="missing">Missing barcode</option>
                </select>
              </label>
              <label className="block col-span-2">
                <span className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Name / SKU / barcode search</span>
                <input value={searchText} onChange={(e) => handleSearch(e.target.value)} placeholder="Search…" className={`${inputCls} w-full`} />
              </label>
            </div>
            <p className="mt-3 text-xs text-gray-400 dark:text-gray-500">
              Only variants with inventory tracking turned on are included.
            </p>
          </div>

          {/* Totals */}
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 px-5 py-4 mb-4">
            <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
              <Stat label="Variants to count" value={preview ? preview.totals.variants.toLocaleString() : "—"} />
              <Stat label="Products" value={preview ? preview.totals.products.toLocaleString() : "—"} />
              <Stat label="Units on hand (available)" value={preview ? preview.totals.units.toLocaleString() : "—"} />
              <Stat label="Cost value" value={preview ? money(preview.totals.costValue) : "—"} />
              {loadingPreview && <span className="text-xs text-gray-400">Updating…</span>}
            </div>
            <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
              Totals are as of last sync
              {options.lastSyncAt ? ` (${new Date(options.lastSyncAt).toLocaleString()})` : ""}. Expected quantities are re-read live from Shopify when you start.
              {preview && preview.totals.missingCost > 0 && ` ${preview.totals.missingCost.toLocaleString()} variants have no cost and are excluded from the cost value.`}
            </p>
            {removedCount > 0 && (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                Removed from scope: {scope.excludedProductIds.length} product{scope.excludedProductIds.length === 1 ? "" : "s"}, {scope.excludedVariantIds.length} variant{scope.excludedVariantIds.length === 1 ? "" : "s"}.{" "}
                <button type="button" onClick={clearExclusions} className="underline">Restore all</button>
              </p>
            )}
          </div>

          {/* Preview table */}
          <PreviewTable
            rows={preview?.rows ?? []}
            loading={loadingPreview && !preview}
            excludedProductIds={scope.excludedProductIds}
            onToggleVariant={toggleVariant}
            onToggleProduct={toggleProduct}
          />

          {preview && preview.totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <div>
                {preview.page > 1 && (
                  <button type="button" onClick={() => setPage(preview.page - 1)} className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">← Previous</button>
                )}
              </div>
              <span className="text-sm text-gray-500 dark:text-gray-400">
                Page {preview.page} of {preview.totalPages} · {preview.matchingVariants.toLocaleString()} matching variants
              </span>
              <div>
                {preview.page < preview.totalPages && (
                  <button type="button" onClick={() => setPage(preview.page + 1)} className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">Next →</button>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* Start */}
      <Form method="post" className="mt-6 flex items-center justify-end gap-4">
        <input type="hidden" name="intent" value="start" />
        <input type="hidden" name="mode" value={mode} />
        <input type="hidden" name="name" value={name} />
        <input type="hidden" name="notes" value={notes} />
        <input type="hidden" name="scope" value={JSON.stringify(scope)} />
        {actionData?.error && <p className="text-sm text-red-600 dark:text-red-400">{actionData.error}</p>}
        <button
          type="submit"
          disabled={!canStart || starting}
          className="text-sm font-medium bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg px-5 py-2.5"
        >
          {starting
            ? "Starting…"
            : mode === "FREE_SCAN"
              ? "Start free scan"
              : `Start stocktake${preview ? ` (${preview.totals.variants.toLocaleString()} variants)` : ""}`}
        </button>
      </Form>
    </main>
  );
}

function ModeCard({ active, onClick, icon, title, body }: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "text-left rounded-2xl border p-5 transition-colors",
        active
          ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20 ring-1 ring-indigo-500"
          : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:border-gray-300 dark:hover:border-gray-600",
      ].join(" ")}
    >
      <div className="flex items-center gap-2 mb-1 text-gray-800 dark:text-gray-100 font-medium">
        <span className={active ? "text-indigo-600 dark:text-indigo-400" : "text-gray-400"}>{icon}</span>
        {title}
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400">{body}</p>
    </button>
  );
}

function FilterSelect({ label, value, onChange, options }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={`${inputCls} w-full`}>
        <option value="">All</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className="text-lg font-semibold tabular-nums text-gray-800 dark:text-gray-100">{value}</div>
    </div>
  );
}

function PreviewTable({ rows, loading, excludedProductIds, onToggleVariant, onToggleProduct }: {
  rows: ScopePreviewRow[];
  loading: boolean;
  excludedProductIds: string[];
  onToggleVariant: (variantId: string) => void;
  onToggleProduct: (productId: string) => void;
}) {
  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 px-6 py-12 text-center text-sm text-gray-400">
        Loading preview…
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 px-6 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
        No tracked variants match these filters.
      </div>
    );
  }

  // Rows arrive ordered by product, so consecutive rows form each family.
  const groups: { productId: string; title: string; vendor: string | null; rows: ScopePreviewRow[] }[] = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last && last.productId === r.productId) last.rows.push(r);
    else groups.push({ productId: r.productId, title: r.title, vendor: r.vendor, rows: [r] });
  }

  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
            <th className="w-10 px-4 py-3"></th>
            <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Variant</th>
            <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">SKU</th>
            <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Barcode</th>
            <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Status</th>
            <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Qty</th>
            <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Cost</th>
            <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Value</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const familyRemoved = excludedProductIds.includes(g.productId);
            return [
              <tr key={`p-${g.productId}`} className="bg-gray-50/60 dark:bg-gray-800/50 border-y border-gray-100 dark:border-gray-700">
                <td colSpan={8} className="px-4 py-2">
                  <div className="flex items-center justify-between gap-4">
                    <div className={familyRemoved ? "line-through text-gray-400" : ""}>
                      <span className="font-medium text-gray-800 dark:text-gray-100">{g.title}</span>
                      {g.vendor && <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">{g.vendor}</span>}
                    </div>
                    <button
                      type="button"
                      onClick={() => onToggleProduct(g.productId)}
                      className={`text-xs font-medium whitespace-nowrap ${familyRemoved ? "text-indigo-600 dark:text-indigo-400" : "text-red-600 dark:text-red-400"} hover:underline`}
                    >
                      {familyRemoved ? "Restore family" : "Remove family"}
                    </button>
                  </div>
                </td>
              </tr>,
              ...g.rows.map((r) => {
                const value = r.cost != null ? r.cost * r.currentInventory : null;
                return (
                  <tr key={r.variantId} className={`border-b border-gray-100 dark:border-gray-700 ${r.excluded ? "opacity-40" : ""}`}>
                    <td className="px-4 py-2">
                      <input
                        type="checkbox"
                        checked={!r.excluded}
                        disabled={familyRemoved}
                        onChange={() => onToggleVariant(r.variantId)}
                        title={r.excluded ? "Add back to scope" : "Remove from scope"}
                        className="accent-indigo-600"
                      />
                    </td>
                    <td className="px-4 py-2 text-gray-700 dark:text-gray-300">{r.variantTitle}</td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-600 dark:text-gray-400">{r.sku ?? "—"}</td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-600 dark:text-gray-400">{r.barcode || "—"}</td>
                    <td className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400">{r.status}</td>
                    <td className={`px-4 py-2 text-right tabular-nums ${r.currentInventory < 0 ? "text-red-600 dark:text-red-400" : "text-gray-700 dark:text-gray-300"}`}>
                      {r.currentInventory}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-600 dark:text-gray-400">{r.cost != null ? money(r.cost) : "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-600 dark:text-gray-400">{value != null ? money(value) : "—"}</td>
                  </tr>
                );
              }),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
