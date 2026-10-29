import { Form, Link, redirect, useFetcher, useNavigate, useRevalidator, useSearchParams } from "react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Undo2, Volume2, VolumeX } from "lucide-react";
import type { Route } from "./+types/stocktakes.$id.count";
import type { Prisma } from "@prisma/client";
import { requireUserId } from "../session.server";
import { getDb } from "../db.server";
import { BarcodeInput } from "../components/BarcodeInput";
import { modeLabels } from "../utils/stocktake-labels";
import type { CountItemView, ScanResult, VariantCandidate } from "../services/stocktake-count.server";
import type { ProductSearchResult } from "../services/shopify.server";

const PAGE_SIZE = 50;
const POLL_MS = 4000;
const VIEWS = ["all", "counted", "uncounted", "outside"] as const;
type View = (typeof VIEWS)[number];

export async function loader({ request, params }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const id = Number(params.id);
  const db = getDb();
  const url = new URL(request.url);
  const viewParam = url.searchParams.get("view") as View | null;
  const view: View = viewParam && VIEWS.includes(viewParam) ? viewParam : "all";
  const q = (url.searchParams.get("q") ?? "").trim();
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1") || 1);

  const stocktake = await db.stocktake.findUnique({ where: { id } });
  if (!stocktake) throw new Response("Not Found", { status: 404 });
  if (stocktake.status !== "IN_PROGRESS") throw redirect(`/stocktakes/${id}`);

  const itemWhere: Prisma.StocktakeItemWhereInput = { stocktakeId: id };
  if (view === "counted") itemWhere.countedQty = { not: null };
  if (view === "uncounted") itemWhere.countedQty = null;
  if (view === "outside") itemWhere.outsideScope = true;
  if (q) {
    itemWhere.OR = [
      { title: { contains: q, mode: "insensitive" } },
      { variantTitle: { contains: q, mode: "insensitive" } },
      { sku: { contains: q, mode: "insensitive" } },
      { barcode: { contains: q, mode: "insensitive" } },
    ];
  }

  const [totalItems, countedItems, sums, myScans, myLastScan, recent, unknowns, matching, items] = await Promise.all([
    db.stocktakeItem.count({ where: { stocktakeId: id } }),
    db.stocktakeItem.count({ where: { stocktakeId: id, countedQty: { not: null } } }),
    db.stocktakeItem.aggregate({ where: { stocktakeId: id }, _sum: { countedQty: true } }),
    db.stocktakeScan.count({ where: { stocktakeId: id, scannedById: userId, undoneAt: null } }),
    db.stocktakeScan.findFirst({
      where: { stocktakeId: id, scannedById: userId, undoneAt: null },
      orderBy: [{ scannedAt: "desc" }, { id: "desc" }],
      select: { kind: true, qtyBefore: true, qtyAfter: true, item: { select: { title: true, variantTitle: true } } },
    }),
    db.stocktakeScan.findMany({
      where: { stocktakeId: id },
      orderBy: [{ scannedAt: "desc" }, { id: "desc" }],
      take: 12,
      select: {
        id: true, kind: true, qtyBefore: true, qtyAfter: true, scannedAt: true, undoneAt: true,
        scannedBy: { select: { name: true } },
        item: { select: { title: true, variantTitle: true } },
      },
    }),
    db.stocktakeUnknownBarcode.findMany({
      where: { stocktakeId: id, resolvedAt: null },
      orderBy: { lastScannedAt: "desc" },
      select: { id: true, barcode: true, scanCount: true, lastScannedAt: true, lastScannedBy: { select: { name: true } } },
    }),
    db.stocktakeItem.count({ where: itemWhere }),
    db.stocktakeItem.findMany({
      where: itemWhere,
      orderBy: view === "counted" ? [{ updatedAt: "desc" }] : [{ title: "asc" }, { productId: "asc" }, { variantTitle: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, title: true, variantTitle: true, sku: true, barcode: true,
        expectedQty: true, countedQty: true, outsideScope: true,
      },
    }),
  ]);

  return {
    stocktake: { id: stocktake.id, name: stocktake.name, mode: stocktake.mode },
    totals: {
      totalItems,
      countedItems,
      unitsCounted: sums._sum.countedQty ?? 0,
      myScans,
    },
    myLastScan: myLastScan && {
      kind: myLastScan.kind,
      label: `${myLastScan.item.title} — ${myLastScan.item.variantTitle}`,
      delta: myLastScan.qtyAfter - (myLastScan.qtyBefore ?? 0),
    },
    recent: recent.map((r) => ({
      id: r.id,
      kind: r.kind,
      delta: r.qtyAfter - (r.qtyBefore ?? 0),
      qtyAfter: r.qtyAfter,
      at: r.scannedAt.toISOString(),
      undone: r.undoneAt != null,
      by: r.scannedBy.name,
      label: `${r.item.title} — ${r.item.variantTitle}`,
    })),
    unknowns: unknowns.map((u) => ({
      id: u.id,
      barcode: u.barcode,
      scanCount: u.scanCount,
      lastScannedAt: u.lastScannedAt.toISOString(),
      lastScannedBy: u.lastScannedBy?.name ?? "—",
    })),
    items: items as CountItemView[],
    list: { view, q, page, totalPages: Math.max(1, Math.ceil(matching / PAGE_SIZE)), matching },
  };
}

// ─── Client helpers ────────────────────────────────────────────────────────────

type ApiResult =
  | ScanResult
  | { kind: "set"; item: CountItemView }
  | { kind: "undone"; item: CountItemView; undoneKind: string }
  | { kind: "linked"; item: CountItemView; barcodeSaved: boolean; warning?: string }
  | { kind: "dismissed" };

type Feedback =
  | { tone: "ok"; title: string; item?: CountItemView; note?: string }
  | { tone: "warn" | "err"; title: string; note?: string };

type OutsidePrompt = { candidate: VariantCandidate; barcode: string; scans: number };

type Tone = "ok" | "warn" | "err";

function useBeep(enabled: boolean) {
  const ctxRef = useRef<AudioContext | null>(null);
  return useCallback(
    (tone: Tone) => {
      if (!enabled) return;
      try {
        const ctx = (ctxRef.current ??= new AudioContext());
        if (ctx.state === "suspended") void ctx.resume();
        const tones: [number, number][] =
          tone === "ok" ? [[1046, 0.08]] : tone === "warn" ? [[660, 0.09], [660, 0.09]] : [[220, 0.16], [165, 0.28]];
        let t = ctx.currentTime;
        for (const [freq, dur] of tones) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "square";
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.06, t);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
          osc.connect(gain).connect(ctx.destination);
          osc.start(t);
          osc.stop(t + dur);
          t += dur + 0.05;
        }
      } catch {
        /* audio unavailable — the flash still shows */
      }
    },
    [enabled]
  );
}

const card = "bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700";
const inputCls =
  "text-sm border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500";

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function StocktakeCountPage({ loaderData }: Route.ComponentProps) {
  const { stocktake, totals, myLastScan, recent, unknowns, items, list } = loaderData;
  const revalidator = useRevalidator();
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;

  const [code, setCode] = useState("");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [flash, setFlash] = useState<Tone | null>(null);
  const [outside, setOutside] = useState<OutsidePrompt[]>([]);
  const [pending, setPending] = useState(0);
  const [soundOn, setSoundOn] = useState(true);
  const scanRef = useRef<HTMLInputElement>(null);
  const beep = useBeep(soundOn);

  useEffect(() => {
    try {
      setSoundOn(localStorage.getItem("stocktake-sound") !== "off");
    } catch { /* storage unavailable */ }
  }, []);
  function toggleSound() {
    setSoundOn((on) => {
      try { localStorage.setItem("stocktake-sound", on ? "off" : "on"); } catch { /* ignore */ }
      return !on;
    });
  }

  const focusScan = useCallback(() => {
    const active = document.activeElement;
    if (!active || active === document.body || active === scanRef.current) scanRef.current?.focus();
  }, []);

  const signal = useCallback(
    (tone: Tone) => {
      beep(tone);
      setFlash(tone);
      window.setTimeout(() => setFlash(null), 600);
    },
    [beep]
  );

  // ── One-at-a-time request queue ──
  // Requests are sent strictly in order and never cancelled, so a fast run of
  // USB scans can't drop one. Failed requests are reported, not retried — a
  // retry could double-count if the server saved it but the response was lost.
  const queueRef = useRef<{ fields: Record<string, string>; onResult: (r: ApiResult) => void }[]>([]);
  const busyRef = useRef(false);
  const revalidateTimer = useRef<number | null>(null);

  const scheduleRevalidate = useCallback(() => {
    if (revalidateTimer.current) window.clearTimeout(revalidateTimer.current);
    revalidateTimer.current = window.setTimeout(() => {
      if (!busyRef.current && queueRef.current.length === 0) revalidatorRef.current.revalidate();
    }, 300);
  }, []);

  const pump = useCallback(async () => {
    if (busyRef.current) return;
    const job = queueRef.current.shift();
    if (!job) return;
    busyRef.current = true;
    setPending(queueRef.current.length + 1);

    let result: ApiResult;
    try {
      const body = new FormData();
      for (const [k, v] of Object.entries(job.fields)) body.set(k, v);
      const res = await fetch(`/api/stocktakes/${stocktake.id}/scan`, { method: "POST", body });
      const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
      result = isJson
        ? ((await res.json()) as ApiResult)
        : { kind: "error", message: res.redirected ? "Your session has expired — log in again." : `Server error (${res.status}).` };
    } catch {
      result = { kind: "error", message: "Network error — the server could not be reached." };
    }

    busyRef.current = false;
    setPending(queueRef.current.length);
    job.onResult(result);
    scheduleRevalidate();
    void pump();
  }, [stocktake.id, scheduleRevalidate]);

  const send = useCallback(
    (fields: Record<string, string>, onResult: (r: ApiResult) => void) => {
      queueRef.current.push({ fields, onResult });
      setPending(queueRef.current.length + (busyRef.current ? 1 : 0));
      void pump();
    },
    [pump]
  );

  // ── Live polling so several scanners see each other's counts ──
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (busyRef.current || queueRef.current.length > 0) return;
      if (revalidatorRef.current.state === "idle") revalidatorRef.current.revalidate();
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, []);

  // ── Actions ──
  function submitScan(raw: string) {
    const value = raw.trim();
    setCode("");
    if (!value) return;
    send({ intent: "scan", code: value }, (r) => {
      if (r.kind === "counted") {
        signal("ok");
        setFeedback({ tone: "ok", title: r.created ? "Added and counted" : "Counted", item: r.item });
      } else if (r.kind === "outside_scope") {
        signal("warn");
        setOutside((prev) => {
          const existing = prev.find((p) => p.candidate.variantId === r.candidate.variantId);
          if (existing) return prev.map((p) => (p === existing ? { ...p, scans: p.scans + 1 } : p));
          return [...prev, { candidate: r.candidate, barcode: r.barcode, scans: 1 }];
        });
        setFeedback({ tone: "warn", title: `Outside scope: ${r.candidate.title} — ${r.candidate.variantTitle}`, note: "Not counted yet. Add it below, or ignore it." });
      } else if (r.kind === "unknown") {
        signal("err");
        setFeedback({
          tone: "err",
          title: `${r.reason === "ambiguous" ? "Barcode matches more than one variant" : "Barcode not recognised"}: ${r.barcode}`,
          note: `Added to Needs attention (scanned ${r.scanCount}×). Link it to the right variant to count it.`,
        });
      } else if (r.kind === "error") {
        signal("err");
        setFeedback({ tone: "err", title: `Not counted: ${value}`, note: r.message });
      }
      focusScan();
    });
  }

  function setQty(item: CountItemView, qtyText: string, after?: () => void) {
    const qty = Number(qtyText);
    if (qtyText.trim() === "" || !Number.isInteger(qty) || qty < 0) {
      signal("err");
      setFeedback({ tone: "err", title: "Enter a whole number of 0 or more." });
      return;
    }
    send({ intent: "set", itemId: String(item.id), qty: String(qty) }, (r) => {
      if (r.kind === "set") {
        signal("ok");
        setFeedback({ tone: "ok", title: "Quantity set", item: r.item });
        after?.();
      } else if (r.kind === "error") {
        signal("err");
        setFeedback({ tone: "err", title: "Quantity not saved", note: r.message });
      }
      focusScan();
    });
  }

  function undo() {
    send({ intent: "undo" }, (r) => {
      if (r.kind === "undone") {
        signal("ok");
        setFeedback({
          tone: "ok",
          title: "Undid your last scan",
          item: r.item,
          note: r.item.countedQty == null ? "This item is now back to not counted." : undefined,
        });
      } else if (r.kind === "error") {
        signal("err");
        setFeedback({ tone: "err", title: "Nothing undone", note: r.message });
      }
      scanRef.current?.focus();
    });
  }

  function addOutside(prompt: OutsidePrompt) {
    send(
      { intent: "add-outside", variantId: prompt.candidate.variantId, barcode: prompt.barcode, scans: String(prompt.scans) },
      (r) => {
        if (r.kind === "counted") {
          signal("ok");
          setOutside((prev) => prev.filter((p) => p.candidate.variantId !== prompt.candidate.variantId));
          setFeedback({ tone: "ok", title: "Added to stocktake and counted", item: r.item });
        } else if (r.kind === "error") {
          signal("err");
          setFeedback({ tone: "err", title: "Not added", note: r.message });
        }
        scanRef.current?.focus();
      }
    );
  }

  function ignoreOutside(prompt: OutsidePrompt) {
    setOutside((prev) => prev.filter((p) => p.candidate.variantId !== prompt.candidate.variantId));
    scanRef.current?.focus();
  }

  const progressPct = totals.totalItems > 0 ? Math.round((totals.countedItems / totals.totalItems) * 100) : 0;
  const flashCls =
    flash === "ok"
      ? "ring-4 ring-green-400 bg-green-50 dark:bg-green-900/30"
      : flash === "warn"
        ? "ring-4 ring-amber-400 bg-amber-50 dark:bg-amber-900/30"
        : flash === "err"
          ? "ring-4 ring-red-500 bg-red-50 dark:bg-red-900/30"
          : "";

  return (
    <main className="p-4 md:p-8 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <Link to={`/stocktakes/${stocktake.id}`} className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">← Stocktake details</Link>
          <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">
            Counting: {stocktake.name}
            <span className="ml-2 align-middle text-xs font-medium px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300">
              {modeLabels[stocktake.mode]}
            </span>
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleSound}
            title={soundOn ? "Mute scan sounds" : "Turn scan sounds on"}
            className="p-2 rounded-lg border border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            {soundOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
          </button>
          <Form
            method="post"
            action={`/stocktakes/${stocktake.id}`}
            onSubmit={(e) => {
              if (!window.confirm(`Cancel "${stocktake.name}"? Counts are kept for the record, but nothing will be applied to Shopify and counting stops.`)) {
                e.preventDefault();
              }
            }}
          >
            <input type="hidden" name="intent" value="cancel" />
            <button type="submit" className="text-sm font-medium text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2 hover:bg-red-50 dark:hover:bg-red-900/20">
              Cancel stocktake
            </button>
          </Form>
        </div>
      </div>

      {/* Running totals */}
      <div className={`${card} px-5 py-4 mb-4`}>
        <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
          <Stat label={stocktake.mode === "SCOPED" ? "Items counted" : "Items scanned"} value={stocktake.mode === "SCOPED" ? `${totals.countedItems.toLocaleString()} / ${totals.totalItems.toLocaleString()}` : totals.countedItems.toLocaleString()} />
          <Stat label="Units counted" value={totals.unitsCounted.toLocaleString()} />
          <Stat label="My scans" value={totals.myScans.toLocaleString()} />
          {unknowns.length > 0 && <Stat label="Needs attention" value={String(unknowns.length)} tone="err" />}
        </div>
        {stocktake.mode === "SCOPED" && (
          <div className="mt-3 h-1.5 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
            <div className="h-full bg-indigo-500 transition-[width] duration-500" style={{ width: `${progressPct}%` }} />
          </div>
        )}
      </div>

      {/* Scan panel */}
      <div className={`${card} p-5 mb-4 transition-colors duration-150 ${flashCls}`}>
        <BarcodeInput
          ref={scanRef}
          value={code}
          onChange={setCode}
          onCommit={submitScan}
          autoFocus
          placeholder="Scan a barcode or type a SKU and press Enter"
          inputClassName={`${inputCls} w-full text-lg py-3 font-mono`}
        />
        <div className="mt-2 flex items-center justify-between gap-3 text-xs text-gray-500 dark:text-gray-400">
          <span>{pending > 0 ? `Saving ${pending}…` : "All scans saved"}</span>
          <button
            type="button"
            onClick={undo}
            disabled={!myLastScan}
            title={myLastScan ? `Undo: ${myLastScan.label} (${myLastScan.delta >= 0 ? "+" : ""}${myLastScan.delta})` : "You have no scans to undo"}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-40"
          >
            <Undo2 size={14} /> Undo my last scan
          </button>
        </div>
        {myLastScan && (
          <p className="mt-1 text-right text-xs text-gray-400 dark:text-gray-500 truncate">
            Last: {myLastScan.label} ({myLastScan.kind === "MANUAL_SET" ? "set" : `${myLastScan.delta >= 0 ? "+" : ""}${myLastScan.delta}`})
          </p>
        )}

        {feedback && <FeedbackCard feedback={feedback} onSetQty={setQty} />}
      </div>

      {/* Outside-scope prompts */}
      {outside.length > 0 && (
        <div className="space-y-2 mb-4">
          {outside.map((p) => (
            <div key={p.candidate.variantId} className="rounded-2xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-5 py-4 flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm">
                <div className="font-medium text-amber-900 dark:text-amber-200">Outside scope: add it?</div>
                <div className="text-amber-800 dark:text-amber-300">
                  {p.candidate.title} — {p.candidate.variantTitle}
                  {p.candidate.sku && <span className="ml-2 font-mono text-xs">SKU {p.candidate.sku}</span>}
                  <span className="ml-2 text-xs">scanned {p.scans}×</span>
                </div>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => addOutside(p)} className="text-sm font-medium bg-amber-600 hover:bg-amber-700 text-white rounded-lg px-3 py-1.5">
                  Add and count {p.scans}
                </button>
                <button type="button" onClick={() => ignoreOutside(p)} className="text-sm font-medium text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-700 rounded-lg px-3 py-1.5">
                  Ignore
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Needs attention */}
      {unknowns.length > 0 && (
        <NeedsAttention
          unknowns={unknowns}
          send={send}
          onDone={(tone, f) => { signal(tone); setFeedback(f); scanRef.current?.focus(); }}
        />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Items */}
        <div className="lg:col-span-2">
          <ItemsList items={items} list={list} mode={stocktake.mode} onSetQty={setQty} />
        </div>

        {/* Recent activity */}
        <div className={`${card} p-4 self-start`}>
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">Recent activity</h3>
          {recent.length === 0 ? (
            <p className="text-xs text-gray-400">No scans yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {recent.map((r) => (
                <li key={r.id} className={`text-xs ${r.undone ? "line-through text-gray-400" : "text-gray-600 dark:text-gray-300"}`}>
                  <span className="font-medium">{r.by}</span>{" "}
                  {r.kind === "MANUAL_SET" ? `set to ${r.qtyAfter}` : r.kind === "LINKED" ? `linked +${r.delta}` : `+${r.delta}`}{" "}
                  <span className="text-gray-500 dark:text-gray-400">{r.label}</span>
                  <span className="ml-1 text-gray-400">{new Date(r.at).toLocaleTimeString()}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </main>
  );
}

// ─── Pieces ────────────────────────────────────────────────────────────────────

function Stat({ label, value, tone }: { label: string; value: string; tone?: "err" }) {
  return (
    <div>
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${tone === "err" ? "text-red-600 dark:text-red-400" : "text-gray-800 dark:text-gray-100"}`}>{value}</div>
    </div>
  );
}

function FeedbackCard({ feedback, onSetQty }: {
  feedback: Feedback;
  onSetQty: (item: CountItemView, qty: string) => void;
}) {
  const [qty, setQty] = useState("");
  const item = feedback.tone === "ok" ? feedback.item : undefined;
  useEffect(() => setQty(""), [feedback]);

  const toneCls =
    feedback.tone === "ok"
      ? "border-green-200 dark:border-green-800"
      : feedback.tone === "warn"
        ? "border-amber-300 dark:border-amber-700"
        : "border-red-300 dark:border-red-800";
  const titleCls =
    feedback.tone === "ok"
      ? "text-green-700 dark:text-green-400"
      : feedback.tone === "warn"
        ? "text-amber-700 dark:text-amber-400"
        : "text-red-700 dark:text-red-400";

  return (
    <div className={`mt-4 rounded-xl border ${toneCls} px-4 py-3`}>
      <div className={`text-sm font-semibold ${titleCls}`}>{feedback.title}</div>
      {feedback.note && <div className="text-sm text-gray-600 dark:text-gray-300 mt-0.5">{feedback.note}</div>}
      {item && (
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-base font-medium text-gray-800 dark:text-gray-100">{item.title}</div>
            <div className="text-sm text-gray-600 dark:text-gray-400">
              {item.variantTitle}
              {item.sku && <span className="ml-2 font-mono text-xs">SKU {item.sku}</span>}
              {item.outsideScope && <span className="ml-2 text-xs text-amber-600 dark:text-amber-400">outside scope</span>}
            </div>
          </div>
          <div className="flex items-end gap-6">
            <div className="text-right">
              <div className="text-xs text-gray-500 dark:text-gray-400">Expected (on hand)</div>
              <div className="text-xl tabular-nums text-gray-700 dark:text-gray-300">{item.expectedQty}</div>
            </div>
            <div className="text-right">
              <div className="text-xs text-gray-500 dark:text-gray-400">Counted</div>
              <div className="text-3xl font-bold tabular-nums text-gray-900 dark:text-white">{item.countedQty ?? "—"}</div>
            </div>
            <form
              className="flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                onSetQty(item, qty);
              }}
            >
              <input
                type="text"
                inputMode="numeric"
                value={qty}
                onChange={(e) => setQty(e.target.value.replace(/[^0-9]/g, ""))}
                placeholder="Exact qty"
                className={`${inputCls} w-24`}
              />
              <button type="submit" className="text-sm font-medium bg-gray-800 dark:bg-gray-700 hover:bg-gray-900 text-white rounded-lg px-3 py-2">
                Set
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

type UnknownRow = { id: number; barcode: string; scanCount: number; lastScannedAt: string; lastScannedBy: string };
type Send = (fields: Record<string, string>, onResult: (r: ApiResult) => void) => void;

function NeedsAttention({ unknowns, send, onDone }: {
  unknowns: UnknownRow[];
  send: Send;
  onDone: (tone: Tone, feedback: Feedback) => void;
}) {
  const [openId, setOpenId] = useState<number | null>(null);

  return (
    <div className="rounded-2xl border border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-900/10 p-5 mb-4">
      <h3 className="text-sm font-semibold text-red-800 dark:text-red-300 mb-1">Needs attention ({unknowns.length})</h3>
      <p className="text-xs text-red-700/80 dark:text-red-300/80 mb-3">
        These barcodes didn't match a single tracked variant. Their scans aren't counted until you link them.
      </p>
      <ul className="space-y-2">
        {unknowns.map((u) => (
          <li key={u.id} className={`${card} px-4 py-3`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm">
                <span className="font-mono font-medium text-gray-800 dark:text-gray-100">{u.barcode}</span>
                <span className="ml-2 text-gray-500 dark:text-gray-400">
                  scanned {u.scanCount}× · last by {u.lastScannedBy} at {new Date(u.lastScannedAt).toLocaleTimeString()}
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setOpenId(openId === u.id ? null : u.id)}
                  className="text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                  {openId === u.id ? "Close" : "Link to variant"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!window.confirm(`Dismiss ${u.barcode}? Its ${u.scanCount} scan${u.scanCount === 1 ? "" : "s"} won't be counted.`)) return;
                    send({ intent: "dismiss", unknownId: String(u.id) }, (r) => {
                      if (r.kind === "error") onDone("err", { tone: "err", title: "Not dismissed", note: r.message });
                    });
                  }}
                  className="text-sm text-gray-500 dark:text-gray-400 hover:underline"
                >
                  Dismiss
                </button>
              </div>
            </div>
            {openId === u.id && (
              <LinkPanel
                unknown={u}
                onLink={(result, saveBarcode) => {
                  const label = `${result.productTitle} — ${result.variantTitle}`;
                  send(
                    { intent: "link", unknownId: String(u.id), variantId: result.variantId, saveBarcode: String(saveBarcode) },
                    (r) => {
                      if (r.kind === "linked") {
                        setOpenId(null);
                        onDone(r.warning ? "warn" : "ok", {
                          tone: "ok",
                          title: `Linked ${u.barcode} to ${label}`,
                          item: r.item,
                          note: r.warning ?? (r.barcodeSaved ? "The barcode was also saved to the variant in Shopify." : undefined),
                        });
                      } else if (r.kind === "error") {
                        onDone("err", { tone: "err", title: "Not linked", note: r.message });
                      }
                    }
                  );
                }}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function LinkPanel({ unknown, onLink }: {
  unknown: UnknownRow;
  onLink: (result: ProductSearchResult, saveBarcode: boolean) => void;
}) {
  const searchFetcher = useFetcher<ProductSearchResult[]>();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ProductSearchResult | null>(null);
  const [saveBarcode, setSaveBarcode] = useState(false);

  useEffect(() => {
    if (query.trim().length < 2) return;
    const timer = window.setTimeout(() => {
      searchFetcher.load(`/api/shopify/products?q=${encodeURIComponent(query.trim())}`);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  function select(r: ProductSearchResult) {
    setSelected(r);
    // Default ON only when the variant has no barcode in Shopify.
    setSaveBarcode(!r.barcode);
  }

  const results = searchFetcher.data ?? [];
  const existing = selected?.barcode ?? null;
  const sameBarcode = existing === unknown.barcode;
  const differentBarcode = existing != null && existing !== "" && !sameBarcode;

  function confirmLink() {
    if (!selected) return;
    const label = `${selected.productTitle} — ${selected.variantTitle}`;
    const save = saveBarcode && !sameBarcode;
    if (save) {
      const msg = differentBarcode
        ? `Link ${unknown.barcode} to ${label}, AND REPLACE its Shopify barcode ${existing} with ${unknown.barcode}?`
        : `Link ${unknown.barcode} to ${label}, and save ${unknown.barcode} as its barcode in Shopify?`;
      if (!window.confirm(msg)) return;
    }
    onLink(selected, save);
  }

  return (
    <div className="mt-3 border-t border-gray-100 dark:border-gray-700 pt-3">
      <input
        value={query}
        onChange={(e) => { setQuery(e.target.value); setSelected(null); }}
        placeholder="Search Shopify by product name or SKU…"
        className={`${inputCls} w-full`}
        autoFocus
      />
      {searchFetcher.state !== "idle" && <p className="mt-2 text-xs text-gray-400">Searching…</p>}
      {!selected && results.length > 0 && (
        <ul className="mt-2 max-h-64 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700 border border-gray-100 dark:border-gray-700 rounded-lg">
          {results.map((r) => (
            <li key={r.variantId}>
              <button type="button" onClick={() => select(r)} className="w-full text-left px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800">
                <div className="text-sm text-gray-800 dark:text-gray-100">{r.productTitle} — {r.variantTitle}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                  SKU {r.sku || "—"} · barcode {r.barcode || "none"}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <div className="mt-3 rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-2">
          <div className="text-sm text-gray-800 dark:text-gray-100">
            {selected.productTitle} — {selected.variantTitle}
            <span className="ml-2 text-xs font-mono text-gray-500">SKU {selected.sku || "—"}</span>
          </div>
          {sameBarcode ? (
            <p className="text-xs text-gray-500 dark:text-gray-400">This variant already has barcode {unknown.barcode} in Shopify.</p>
          ) : (
            <>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input type="checkbox" checked={saveBarcode} onChange={(e) => setSaveBarcode(e.target.checked)} className="accent-indigo-600" />
                Also save {unknown.barcode} as this variant's barcode in Shopify
              </label>
              {differentBarcode && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  Warning: this variant already has barcode <span className="font-mono">{existing}</span> in Shopify. Saving would replace it.
                </p>
              )}
            </>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={confirmLink} className="text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg px-3 py-1.5">
              Link and count {unknown.scanCount}
            </button>
            <button type="button" onClick={() => setSelected(null)} className="text-sm text-gray-500 hover:underline">
              Choose another
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ItemsList({ items, list, mode, onSetQty }: {
  items: CountItemView[];
  list: { view: View; q: string; page: number; totalPages: number; matching: number };
  mode: string;
  onSetQty: (item: CountItemView, qty: string, after?: () => void) => void;
}) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState(list.q);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const debounceRef = useRef<number | null>(null);

  function go(next: Partial<{ view: View; q: string; page: number }>) {
    const params = new URLSearchParams(searchParams);
    if (next.view !== undefined) params.set("view", next.view);
    if (next.q !== undefined) {
      if (next.q) params.set("q", next.q);
      else params.delete("q");
    }
    params.set("page", String(next.page ?? 1));
    navigate(`?${params.toString()}`, { replace: true, preventScrollReset: true });
  }

  const views: { key: View; label: string }[] = [
    { key: "all", label: "All" },
    { key: "counted", label: "Counted" },
    ...(mode === "SCOPED"
      ? [{ key: "uncounted" as View, label: "Not counted" }, { key: "outside" as View, label: "Outside scope" }]
      : []),
  ];

  return (
    <div className={card}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-700">
        <div className="flex gap-1">
          {views.map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => go({ view: v.key, q: list.q })}
              className={`text-xs font-medium px-2.5 py-1 rounded-full ${list.view === v.key ? "bg-indigo-600 text-white" : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"}`}
            >
              {v.label}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => {
            const val = e.target.value;
            setSearch(val);
            if (debounceRef.current) window.clearTimeout(debounceRef.current);
            debounceRef.current = window.setTimeout(() => go({ q: val.trim() }), 350);
          }}
          placeholder="Filter items…"
          className={`${inputCls} w-48`}
        />
      </div>
      {items.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-gray-400">No items.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-700">
                <th className="text-left px-4 py-2 font-medium">Item</th>
                <th className="text-left px-4 py-2 font-medium">SKU</th>
                <th className="text-right px-4 py-2 font-medium">Expected</th>
                <th className="text-right px-4 py-2 font-medium">Counted</th>
                <th className="px-4 py-2 w-28"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b border-gray-50 dark:border-gray-800">
                  <td className="px-4 py-2">
                    <div className="text-gray-800 dark:text-gray-100">{item.title}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {item.variantTitle}
                      {item.outsideScope && <span className="ml-2 text-amber-600 dark:text-amber-400">outside scope</span>}
                    </div>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-600 dark:text-gray-400">{item.sku ?? "—"}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-gray-600 dark:text-gray-400">{item.expectedQty}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-semibold text-gray-800 dark:text-gray-100">{item.countedQty ?? "—"}</td>
                  <td className="px-4 py-2 text-right">
                    {editingId === item.id ? (
                      <form
                        className="flex justify-end gap-1"
                        onSubmit={(e) => {
                          e.preventDefault();
                          onSetQty(item, editValue, () => setEditingId(null));
                        }}
                      >
                        <input
                          autoFocus
                          inputMode="numeric"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value.replace(/[^0-9]/g, ""))}
                          onKeyDown={(e) => e.key === "Escape" && setEditingId(null)}
                          className={`${inputCls} w-16 py-1`}
                        />
                        <button type="submit" className="text-xs font-medium text-indigo-600 dark:text-indigo-400">Save</button>
                      </form>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { setEditingId(item.id); setEditValue(item.countedQty != null ? String(item.countedQty) : ""); }}
                        className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
                      >
                        Set qty
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-3 text-sm">
          <div>{list.page > 1 && <button type="button" onClick={() => go({ page: list.page - 1 })} className="text-indigo-600 dark:text-indigo-400 hover:underline">← Previous</button>}</div>
          <span className="text-gray-500 dark:text-gray-400">Page {list.page} of {list.totalPages} · {list.matching.toLocaleString()} items</span>
          <div>{list.page < list.totalPages && <button type="button" onClick={() => go({ page: list.page + 1 })} className="text-indigo-600 dark:text-indigo-400 hover:underline">Next →</button>}</div>
        </div>
      )}
    </div>
  );
}
