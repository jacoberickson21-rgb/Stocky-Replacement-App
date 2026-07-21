import { useEffect, useState } from "react";
import type { Route } from "./+types/reorder.preseason-print";
import { requireUserId } from "../session.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  return {};
}

type PreseasonRow = {
  sku: string;
  productTitle: string;
  variantTitle: string;
  preseasonQty: number;
  currentStock: number | null;
  avgDailySales: number;
  daysOfStock: number | null;
  suggestedQty: number;
  gap: number;
};

type Analysis = {
  rows: PreseasonRow[];
  vendorName: string;
  generatedAt: string;
};

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function exportCsv(analysis: Analysis) {
  const headers = ["Product", "Variant", "SKU", "Preseason Qty", "Current Stock", "Avg Daily Sales", "Days of Stock", "Suggested Qty", "Gap"];
  const rows = analysis.rows.map((r) => [
    r.productTitle,
    r.variantTitle,
    r.sku,
    r.preseasonQty,
    r.currentStock ?? "",
    r.avgDailySales.toFixed(2),
    r.daysOfStock ?? "",
    r.suggestedQty,
    r.gap,
  ]);
  const csv = [headers, ...rows]
    .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
    .join("\r\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `preseason-analysis-${analysis.vendorName.replace(/\s+/g, "-")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 12px;
    line-height: 1.5;
    color: #1e293b;
    background: #fff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  .print-bar {
    position: sticky;
    top: 0;
    z-index: 10;
    background: #f8fafc;
    border-bottom: 1px solid #e2e8f0;
    padding: 10px 32px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .print-bar-info { display: flex; flex-direction: column; gap: 1px; }
  .print-bar-title { font-size: 13px; font-weight: 600; color: #1e293b; }
  .print-bar-sub { font-size: 11px; color: #64748b; }
  .print-bar-actions { display: flex; gap: 8px; align-items: center; }
  .print-btn {
    background: #4f46e5; color: #fff; border: none; border-radius: 7px;
    padding: 8px 20px; font-size: 13px; font-weight: 600; cursor: pointer;
    letter-spacing: -0.1px; transition: background 0.15s;
  }
  .print-btn:hover { background: #4338ca; }
  .csv-btn {
    background: #fff; color: #374151; border: 1.5px solid #d1d5db; border-radius: 7px;
    padding: 8px 20px; font-size: 13px; font-weight: 600; cursor: pointer;
    letter-spacing: -0.1px; transition: background 0.15s, border-color 0.15s;
  }
  .csv-btn:hover { background: #f9fafb; border-color: #9ca3af; }
  .close-btn {
    background: #fff; color: #6b7280; border: 1.5px solid #e5e7eb; border-radius: 7px;
    padding: 8px 16px; font-size: 13px; font-weight: 600; cursor: pointer; transition: background 0.15s;
  }
  .close-btn:hover { background: #f3f4f6; }

  .page { max-width: 720px; margin: 0 auto; padding: 40px; }

  .doc-header {
    display: flex; justify-content: space-between; align-items: flex-end;
    padding-bottom: 18px; border-bottom: 2.5px solid #1e293b;
  }
  .brand { font-size: 28px; font-weight: 800; color: #4f46e5; letter-spacing: -1.5px; line-height: 1; }
  .doc-subtitle { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #64748b; margin-top: 7px; }
  .doc-right { text-align: right; }
  .inv-meta { font-size: 11px; color: #64748b; margin-top: 4px; }

  .info-strip {
    display: grid; grid-template-columns: repeat(3, 1fr);
    border-bottom: 1px solid #e2e8f0; margin-bottom: 30px;
  }
  .info-cell { padding: 14px 16px; }
  .info-cell + .info-cell { border-left: 1px solid #e2e8f0; }
  .info-cell-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #94a3b8; margin-bottom: 5px; }
  .info-cell-value { font-size: 14px; font-weight: 600; color: #1e293b; line-height: 1.3; }
  .info-cell-value-lg { font-size: 17px; font-weight: 700; color: #4338ca; }

  .section-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #94a3b8; margin-bottom: 8px; padding: 0 1px; }

  .table-wrap { margin-bottom: 30px; }
  table { width: 100%; border-collapse: collapse; }
  thead tr { background: #1e293b; }
  th { padding: 9px 10px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #94a3b8; text-align: left; white-space: nowrap; }
  th.r, td.r { text-align: right; }
  td { padding: 7px 10px; vertical-align: middle; color: #334155; font-size: 12px; border-bottom: 1px solid #f1f5f9; }
  tr.even td { background: #f8fafc; }
  tr.odd td { background: #ffffff; }
  .mono { font-family: ui-monospace, "SF Mono", Consolas, monospace; }
  .sku-cell { font-size: 11px; color: #64748b; }
  .prod-cell { font-weight: 500; color: #1e293b; }
  .var-cell { font-size: 11px; color: #64748b; }
  .dim { color: #cbd5e1; }
  .fw6 { font-weight: 600; color: #1e293b; }
  .gap-pos { color: #b45309; font-weight: 700; }

  .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
  .stat { border: 1.5px solid #e2e8f0; border-radius: 8px; padding: 14px 16px; background: #fff; }
  .stat-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #94a3b8; margin-bottom: 6px; }
  .stat-value { font-size: 26px; font-weight: 800; color: #1e293b; line-height: 1; }

  .doc-footer { margin-top: 28px; border-top: 1px solid #e2e8f0; padding-top: 12px; display: flex; justify-content: space-between; font-size: 10px; color: #94a3b8; }

  @media print {
    .no-print { display: none !important; }
    body { font-size: 10px; }
    .page { padding: 0; max-width: 100%; }
    .doc-header { padding-bottom: 14px; }
    .info-strip { margin-bottom: 20px; }
    .table-wrap { margin-bottom: 20px; }

    @page {
      size: letter portrait;
      margin: 1.2cm 1.5cm;
    }

    thead, tr.even {
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
  }
`;

export default function PreseasonPrintPage() {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("preseasonAnalysis");
      if (raw) setAnalysis(JSON.parse(raw));
    } catch {
      setAnalysis(null);
    }
  }, []);

  if (!analysis) {
    return (
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <title>Preseason Order Analysis</title>
          <style>{CSS}</style>
        </head>
        <body>
          <div className="page">
            <p>No analysis data found. Return to the Reorder page and run the import again.</p>
          </div>
        </body>
      </html>
    );
  }

  const totalPreseasonQty = analysis.rows.reduce((s, r) => s + r.preseasonQty, 0);
  const totalCurrentStock = analysis.rows.reduce((s, r) => s + (r.currentStock ?? 0), 0);
  const totalGap = analysis.rows.reduce((s, r) => s + r.gap, 0);

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Preseason Order Analysis — {analysis.vendorName}</title>
        <style>{CSS}</style>
      </head>
      <body>
        <div className="print-bar no-print">
          <div className="print-bar-info">
            <span className="print-bar-title">Preseason Order Analysis</span>
            <span className="print-bar-sub">{analysis.vendorName} · {analysis.rows.length} SKUs</span>
          </div>
          <div className="print-bar-actions">
            <button className="print-btn" onClick={() => window.print()}>Print / Save PDF</button>
            <button className="csv-btn" onClick={() => exportCsv(analysis)}>Export CSV</button>
            <button className="close-btn" onClick={() => window.close()}>Close</button>
          </div>
        </div>

        <div className="page">
          <div className="doc-header">
            <div>
              <div className="brand">Receively</div>
              <div className="doc-subtitle">Preseason Order Analysis</div>
            </div>
            <div className="doc-right">
              <div className="inv-meta">Generated {fmtDateTime(analysis.generatedAt)}</div>
            </div>
          </div>

          <div className="info-strip">
            <div className="info-cell">
              <div className="info-cell-label">Vendor</div>
              <div className="info-cell-value">{analysis.vendorName}</div>
            </div>
            <div className="info-cell">
              <div className="info-cell-label">SKUs Analyzed</div>
              <div className="info-cell-value">{analysis.rows.length}</div>
            </div>
            <div className="info-cell">
              <div className="info-cell-label">Total Gap</div>
              <div className="info-cell-value info-cell-value-lg">{totalGap > 0 ? `+${totalGap}` : totalGap}</div>
            </div>
          </div>

          <div className="table-wrap">
            <div className="section-label">Line Items ({analysis.rows.length})</div>
            <table>
              <thead>
                <tr>
                  <th style={{ width: "10%" }}>SKU</th>
                  <th style={{ width: "28%" }}>Product</th>
                  <th className="r" style={{ width: "10%" }}>Preseason</th>
                  <th className="r" style={{ width: "10%" }}>Stock</th>
                  <th className="r" style={{ width: "12%" }}>Avg/Day</th>
                  <th className="r" style={{ width: "10%" }}>Days</th>
                  <th className="r" style={{ width: "10%" }}>Suggested</th>
                  <th className="r" style={{ width: "10%" }}>Gap</th>
                </tr>
              </thead>
              <tbody>
                {analysis.rows.map((r, i) => (
                  <tr key={`${r.sku}-${i}`} className={i % 2 === 0 ? "even" : "odd"}>
                    <td className="mono sku-cell">{r.sku || <span className="dim">—</span>}</td>
                    <td className="prod-cell">
                      {r.productTitle}
                      {r.variantTitle && r.variantTitle !== "Default Title" && <span className="var-cell"> — {r.variantTitle}</span>}
                    </td>
                    <td className="r">{r.preseasonQty}</td>
                    <td className="r">{r.currentStock ?? <span className="dim">—</span>}</td>
                    <td className="r">{r.avgDailySales.toFixed(2)}</td>
                    <td className="r">{r.daysOfStock ?? "∞"}</td>
                    <td className="r">{r.suggestedQty}</td>
                    <td className={`r fw6${r.gap > 0 ? " gap-pos" : ""}`}>{r.gap > 0 ? `+${r.gap}` : r.gap}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="summary-grid">
            <div className="stat">
              <div className="stat-label">Preseason Qty</div>
              <div className="stat-value">{totalPreseasonQty}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Current Stock</div>
              <div className="stat-value">{totalCurrentStock}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Total Gap</div>
              <div className="stat-value">{totalGap > 0 ? `+${totalGap}` : totalGap}</div>
            </div>
          </div>

          <div className="doc-footer">
            <span>Generated by Receively</span>
            <span>{fmtDateTime(analysis.generatedAt)}</span>
          </div>
        </div>
      </body>
    </html>
  );
}
