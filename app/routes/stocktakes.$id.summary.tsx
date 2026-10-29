import type { Route } from "./+types/stocktakes.$id.summary";
import { requireUserId } from "../session.server";
import { getStocktakeReport } from "../services/stocktake-report.server";
import { itemStatusLabels, type ItemStatus } from "../utils/stocktake-labels";

const NOT_APPLIED: ItemStatus[] = ["FAILED", "CHANGED_SINCE_REVIEW", "EXCLUDED", "NEEDS_ACTIVATION", "NOT_SETTABLE", "PENDING"];

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
  const report = await getStocktakeReport(Number(params.id));
  if (!report) throw new Response("Not Found", { status: 404 });
  if (report.stocktake.status === "PREPARING") throw new Response("Stocktake is still preparing", { status: 400 });

  return {
    stocktake: report.stocktake,
    totals: report.totals,
    variances: report.items.filter((i) => i.variance != null && i.variance !== 0),
    notApplied: report.items.filter((i) => NOT_APPLIED.includes(i.status)),
    generatedAt: new Date().toISOString(),
  };
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmt$(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function signed(n: number) {
  return n > 0 ? `+${n.toLocaleString("en-US")}` : n.toLocaleString("en-US");
}
function signed$(n: number) {
  return n > 0 ? `+${fmt$(n)}` : fmt$(n);
}
function fmtDateTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

const statusText: Record<string, string> = {
  PREPARING: "Preparing", IN_PROGRESS: "In progress", REVIEW: "In review",
  APPLYING: "Applying", COMPLETED: "Completed", CANCELLED: "Cancelled",
};

// ─── Styles ───────────────────────────────────────────────────────────────────

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 12px; line-height: 1.5; color: #1e293b; background: #fff;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }

  .print-bar {
    position: sticky; top: 0; z-index: 10; background: #f8fafc; border-bottom: 1px solid #e2e8f0;
    padding: 10px 32px; display: flex; align-items: center; justify-content: space-between; gap: 12px;
  }
  .print-bar-info { display: flex; flex-direction: column; gap: 1px; }
  .print-bar-title { font-size: 13px; font-weight: 600; color: #1e293b; }
  .print-bar-sub { font-size: 11px; color: #64748b; }
  .print-bar-actions { display: flex; gap: 8px; align-items: center; }
  .print-btn {
    background: #4f46e5; color: #fff; border: none; border-radius: 7px; padding: 8px 20px;
    font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .print-btn:hover { background: #4338ca; }
  .csv-btn {
    background: #fff; color: #374151; border: 1.5px solid #d1d5db; border-radius: 7px; padding: 7px 20px;
    font-size: 13px; font-weight: 600; cursor: pointer; text-decoration: none;
  }
  .csv-btn:hover { background: #f9fafb; border-color: #9ca3af; }
  .close-btn {
    background: #fff; color: #6b7280; border: 1.5px solid #e5e7eb; border-radius: 7px; padding: 8px 16px;
    font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .close-btn:hover { background: #f3f4f6; }

  /* Narrow enough for letter portrait (8.5in minus margins). */
  .page { max-width: 720px; margin: 0 auto; padding: 40px; }

  .doc-header {
    display: flex; justify-content: space-between; align-items: flex-end;
    padding-bottom: 18px; border-bottom: 2.5px solid #1e293b;
  }
  .brand { font-size: 28px; font-weight: 800; color: #4f46e5; letter-spacing: -1.5px; line-height: 1; }
  .doc-subtitle {
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #64748b; margin-top: 7px;
  }
  .doc-right { text-align: right; max-width: 60%; }
  .doc-name { font-size: 18px; font-weight: 700; color: #1e293b; line-height: 1.2; }
  .doc-meta { font-size: 11px; color: #64748b; margin-top: 4px; }

  .info-strip { display: grid; grid-template-columns: repeat(3, 1fr); border-bottom: 1px solid #e2e8f0; margin-bottom: 24px; }
  .info-cell { padding: 12px 14px; }
  .info-cell:not(:nth-child(3n+1)) { border-left: 1px solid #e2e8f0; }
  .info-cell:nth-child(n+4) { border-top: 1px solid #e2e8f0; }
  .info-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #94a3b8; margin-bottom: 4px; }
  .info-value { font-size: 13px; font-weight: 600; color: #1e293b; line-height: 1.3; word-break: break-word; }
  .mono { font-family: ui-monospace, "SF Mono", Consolas, monospace; }

  .totals { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 28px; }
  .total-box { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; }
  .total-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #94a3b8; }
  .total-value { font-size: 18px; font-weight: 700; color: #1e293b; margin-top: 2px; font-variant-numeric: tabular-nums; }
  .total-sub { font-size: 10px; color: #64748b; }
  .pos { color: #15803d; }
  .neg { color: #b91c1c; }

  .section-label {
    font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #94a3b8; margin-bottom: 8px;
  }
  .table-wrap { margin-bottom: 26px; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  thead tr { background: #1e293b; }
  th {
    padding: 8px 8px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    color: #94a3b8; text-align: left; white-space: nowrap;
  }
  td { padding: 6px 8px; vertical-align: top; color: #334155; font-size: 11px; border-bottom: 1px solid #f1f5f9; }
  th.r, td.r { text-align: right; }
  th.c, td.c { text-align: center; }
  td { font-variant-numeric: tabular-nums; }
  tr.even td { background: #f8fafc; }
  .col-sku { width: 92px; }
  .col-num { width: 52px; }
  .col-val { width: 78px; }
  .col-app { width: 58px; }
  .sku { font-family: ui-monospace, monospace; font-size: 10px; color: #64748b; word-break: break-all; }
  .prod { font-weight: 500; color: #1e293b; }
  .var { font-size: 10px; color: #64748b; }
  .note { font-size: 10px; color: #92400e; }
  .yes { color: #16a34a; font-weight: 700; }
  .no  { color: #b91c1c; font-weight: 600; font-size: 10px; }
  .empty { padding: 14px; text-align: center; color: #94a3b8; border: 1px dashed #e2e8f0; border-radius: 8px; }

  .doc-footer {
    margin-top: 24px; border-top: 1px solid #e2e8f0; padding-top: 10px;
    display: flex; justify-content: space-between; gap: 12px; font-size: 10px; color: #94a3b8;
  }

  @media print {
    .no-print { display: none !important; }
    body { font-size: 10px; }
    .page { padding: 0; max-width: 100%; }
    td { font-size: 10px; }
    thead { display: table-header-group; }
    tr { break-inside: avoid; }
    @page { size: letter portrait; margin: 1.2cm 1.5cm; }
  }
`;

// ─── Component ────────────────────────────────────────────────────────────────

type LoaderData = Awaited<ReturnType<typeof loader>>;

export default function StocktakeSummaryPage({ loaderData }: { loaderData: LoaderData }) {
  const { stocktake, totals, variances, notApplied, generatedAt } = loaderData;
  const sign = (n: number) => (n > 0 ? "pos" : n < 0 ? "neg" : "");

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Stocktake Summary — {stocktake.name}</title>
        <style>{CSS}</style>
      </head>
      <body>
        <div className="print-bar no-print">
          <div className="print-bar-info">
            <span className="print-bar-title">Stocktake Summary</span>
            <span className="print-bar-sub">#{stocktake.id} · {stocktake.name}</span>
          </div>
          <div className="print-bar-actions">
            <button className="print-btn" onClick={() => window.print()}>Print / Save PDF</button>
            <a className="csv-btn" href={`/stocktakes/${stocktake.id}/export.csv`}>Export CSV</a>
            <button className="close-btn" onClick={() => window.close()}>Close</button>
          </div>
        </div>

        <div className="page">
          <div className="doc-header">
            <div>
              <div className="brand">Receively</div>
              <div className="doc-subtitle">Stocktake Summary</div>
            </div>
            <div className="doc-right">
              <div className="doc-name">{stocktake.name}</div>
              <div className="doc-meta">#{stocktake.id} · {statusText[stocktake.status] ?? stocktake.status}</div>
              <div className="doc-meta">{fmtDate(stocktake.completedAt ?? stocktake.startedAt)}</div>
            </div>
          </div>

          <div className="info-strip">
            <Info label="Mode" value={stocktake.mode === "SCOPED" ? "Scoped count" : "Free scan"} />
            <Info label="Started by" value={stocktake.startedBy} />
            <Info label="Started" value={fmtDateTime(stocktake.startedAt)} />
            <Info label="Status" value={statusText[stocktake.status] ?? stocktake.status} />
            <Info label="Completed by" value={stocktake.completedBy ?? "—"} />
            <Info label="Completed" value={fmtDateTime(stocktake.completedAt)} />
            <Info label="Apply reason" value={stocktake.applyReason ?? "—"} mono />
            <Info label="Drift check" value={fmtDateTime(stocktake.reviewCheckedAt)} />
            <Info label="Unscanned items" value={stocktake.mode === "SCOPED" ? (stocktake.zeroUnscanned ? "Set to 0" : "Left unchanged") : "n/a (free scan)"} />
          </div>

          <div className="totals">
            <div className="total-box">
              <div className="total-label">Items counted</div>
              <div className="total-value">{totals.itemsCounted.toLocaleString("en-US")}</div>
              <div className="total-sub">of {totals.items.toLocaleString("en-US")} in the stocktake</div>
            </div>
            <div className="total-box">
              <div className="total-label">Variance units</div>
              <div className={`total-value ${sign(totals.varianceUnits)}`}>{signed(totals.varianceUnits)}</div>
              <div className="total-sub">{totals.itemsWithVariance} items · {signed$(totals.varianceValue)} at cost</div>
            </div>
            <div className="total-box">
              <div className="total-label">Net dollar impact</div>
              <div className={`total-value ${sign(totals.netAppliedValue)}`}>{signed$(totals.netAppliedValue)}</div>
              <div className="total-sub">{totals.itemsApplied} applied · +{totals.unitsUp} / −{totals.unitsDown} units</div>
            </div>
          </div>

          <div className="table-wrap">
            <div className="section-label">Variances ({variances.length})</div>
            {variances.length === 0 ? (
              <div className="empty">Every counted item matched its expected quantity.</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th className="col-sku">SKU</th>
                    <th>Item</th>
                    <th className="col-num r">Exp.</th>
                    <th className="col-num r">Count</th>
                    <th className="col-num r">Var.</th>
                    <th className="col-val r">Var. $</th>
                    <th className="col-app c">Applied</th>
                  </tr>
                </thead>
                <tbody>
                  {variances.map((i, idx) => (
                    <tr key={i.id} className={idx % 2 ? "even" : ""}>
                      <td className="sku">{i.sku ?? "—"}</td>
                      <td>
                        <div className="prod">{i.title}</div>
                        <div className="var">{i.variantTitle}{i.zeroedUnscanned ? " · unscanned, set to 0" : ""}{i.outsideScope ? " · outside scope" : ""}</div>
                      </td>
                      <td className="r">{i.expected}</td>
                      <td className="r">{i.counted ?? (i.zeroedUnscanned ? 0 : "—")}</td>
                      <td className={`r ${sign(i.variance ?? 0)}`}>{signed(i.variance ?? 0)}</td>
                      <td className={`r ${sign(i.varianceValue ?? 0)}`}>{i.varianceValue != null ? signed$(i.varianceValue) : "no cost"}</td>
                      <td className="c">{i.applied ? <span className="yes">✓</span> : <span className="no">{i.status === "NO_CHANGE" || i.status === "SKIPPED_DRIFT" ? "—" : "No"}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {notApplied.length > 0 && (
            <div className="table-wrap">
              <div className="section-label">Not applied ({notApplied.length})</div>
              <table>
                <thead>
                  <tr>
                    <th className="col-sku">SKU</th>
                    <th>Item</th>
                    <th style={{ width: 150 }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {notApplied.map((i, idx) => (
                    <tr key={i.id} className={idx % 2 ? "even" : ""}>
                      <td className="sku">{i.sku ?? "—"}</td>
                      <td>
                        <div className="prod">{i.title}</div>
                        <div className="var">{i.variantTitle}</div>
                        {i.notes.length > 0 && <div className="note">{i.notes.join(" · ")}</div>}
                      </td>
                      <td>{itemStatusLabels[i.status]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="doc-footer">
            <span>Variance = counted − expected on hand at the start of the count. Net dollar impact = applied change (target − live on hand at review) × cost.</span>
            <span style={{ whiteSpace: "nowrap" }}>Generated {fmtDateTime(generatedAt)}</span>
          </div>
        </div>
      </body>
    </html>
  );
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="info-cell">
      <div className="info-label">{label}</div>
      <div className={`info-value${mono ? " mono" : ""}`}>{value}</div>
    </div>
  );
}
