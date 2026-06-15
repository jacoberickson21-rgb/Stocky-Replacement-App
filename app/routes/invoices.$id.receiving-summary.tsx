import { getDb } from "../db.server";
import { requireUserId } from "../session.server";

export async function loader({ request, params }: { request: Request; params: { id?: string } }) {
  await requireUserId(request);
  const id = Number(params.id);
  const db = getDb();

  const invoice = await db.invoice.findUnique({
    where: { id },
    include: {
      vendor: true,
      lineItems: {
        include: { discrepancyLogs: true },
        orderBy: { id: "asc" },
      },
    },
  });

  if (!invoice) throw new Response("Not Found", { status: 404 });
  if (!["RECEIVED", "PAID"].includes(invoice.status)) {
    throw new Response("Invoice not yet received", { status: 400 });
  }

  const receiveLog = await db.auditLog.findFirst({
    where: {
      action: "INVOICE_RECEIVED",
      details: { startsWith: `Invoice #${invoice.invoiceNumber}` },
    },
    include: { user: { select: { name: true } } },
    orderBy: { timestamp: "desc" },
  });

  const lineItems = invoice.lineItems.map((li) => {
    const unitCost = Number(li.unitCost);
    const qtyOrdered = li.quantityOrdered;
    const qtyReceived = li.quantityReceived;
    const lineTotal = qtyReceived * unitCost;
    const diff = qtyReceived - qtyOrdered;
    const discrepancy = li.hasDiscrepancy
      ? { expected: qtyOrdered, actual: qtyReceived, diff, note: li.receivingNote ?? "" }
      : null;
    const shopifyTitle = li.shopifyProductTitle ?? "";
    const product = shopifyTitle || li.description;
    const variant = shopifyTitle && shopifyTitle !== li.description ? li.description : "";
    return {
      id: li.id,
      sku: li.sku ?? "",
      product,
      variant,
      barcode: li.barcode ?? "",
      qtyOrdered,
      qtyReceived,
      unitCost,
      lineTotal,
      discrepancy,
    };
  });

  const totalOrdered = lineItems.reduce((s, li) => s + li.qtyOrdered, 0);
  const totalReceived = lineItems.reduce((s, li) => s + li.qtyReceived, 0);
  const totalDiscrepancies = lineItems.filter((li) => li.discrepancy !== null).length;
  const lineSubtotal = lineItems.reduce((s, li) => s + li.lineTotal, 0);
  const invoiceTotal = parseFloat(String(invoice.total ?? 0)) || 0;
  const shippingCost = parseFloat(String(invoice.shippingCost ?? 0)) || 0;
  const adjustments = parseFloat(String(invoice.adjustments ?? 0)) || 0;

  console.log(`[receiving-summary] invoice #${invoice.invoiceNumber} — raw shippingCost:`, invoice.shippingCost, "→", shippingCost, "| raw adjustments:", invoice.adjustments, "→", adjustments);

  return {
    invoice: {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      invoiceDate: invoice.invoiceDate?.toISOString() ?? null,
      dueDate: invoice.dueDate?.toISOString() ?? null,
      paymentTerms: invoice.paymentTerms ?? null,
      receivedAt: receiveLog?.timestamp.toISOString() ?? invoice.updatedAt.toISOString(),
      receivedBy: receiveLog?.user?.name ?? "—",
    },
    vendor: { name: invoice.vendor?.name ?? "—" },
    lineItems,
    summary: { totalOrdered, totalReceived, totalDiscrepancies, lineSubtotal, invoiceTotal, shippingCost, adjustments },
    generatedAt: new Date().toISOString(),
  };
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmt$(n: number) {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function fmtPaymentTerms(terms: string | null) {
  if (!terms) return "—";
  const map: Record<string, string> = {
    NET30: "Net 30",
    NET60: "Net 60",
    DUE_ON_RECEIPT: "Due on Receipt",
    CUSTOM: "Custom",
  };
  return map[terms] ?? terms;
}

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

// ─── Styles ───────────────────────────────────────────────────────────────────

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

  /* ── Print action bar ─────────────────────────────────────────────────────── */
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
    background: #4f46e5;
    color: #fff;
    border: none;
    border-radius: 7px;
    padding: 8px 20px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    letter-spacing: -0.1px;
    transition: background 0.15s;
  }
  .print-btn:hover { background: #4338ca; }
  .csv-btn {
    background: #fff;
    color: #374151;
    border: 1.5px solid #d1d5db;
    border-radius: 7px;
    padding: 8px 20px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    letter-spacing: -0.1px;
    transition: background 0.15s, border-color 0.15s;
  }
  .csv-btn:hover { background: #f9fafb; border-color: #9ca3af; }
  .close-btn {
    background: #fff;
    color: #6b7280;
    border: 1.5px solid #e5e7eb;
    border-radius: 7px;
    padding: 8px 16px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s;
  }
  .close-btn:hover { background: #f3f4f6; }

  /* ── Page wrapper ─────────────────────────────────────────────────────────── */
  .page { max-width: 720px; margin: 0 auto; padding: 40px; }

  /* ── Document header ──────────────────────────────────────────────────────── */
  .doc-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    padding-bottom: 18px;
    border-bottom: 2.5px solid #1e293b;
  }
  .brand {
    font-size: 28px;
    font-weight: 800;
    color: #4f46e5;
    letter-spacing: -1.5px;
    line-height: 1;
  }
  .doc-subtitle {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: #64748b;
    margin-top: 7px;
  }
  .doc-right { text-align: right; }
  .inv-number {
    font-size: 20px;
    font-weight: 700;
    color: #1e293b;
    font-family: ui-monospace, "SF Mono", Consolas, monospace;
    letter-spacing: -0.5px;
    line-height: 1;
  }
  .inv-meta { font-size: 11px; color: #64748b; margin-top: 4px; }

  /* ── Info strip ───────────────────────────────────────────────────────────── */
  .info-strip {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    border-bottom: 1px solid #e2e8f0;
    margin-bottom: 30px;
  }
  .info-cell { padding: 14px 16px; }
  .info-cell + .info-cell { border-left: 1px solid #e2e8f0; }
  .info-cell:nth-child(n+4) { border-top: 1px solid #e2e8f0; }
  .info-cell:nth-child(4) { border-left: none; }
  .info-cell-label {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: #94a3b8;
    margin-bottom: 5px;
  }
  .info-cell-value {
    font-size: 14px;
    font-weight: 600;
    color: #1e293b;
    line-height: 1.3;
  }
  .info-cell-value-lg {
    font-size: 17px;
    font-weight: 700;
    color: #4338ca;
  }

  /* ── Section label ────────────────────────────────────────────────────────── */
  .section-label {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: #94a3b8;
    margin-bottom: 8px;
    padding: 0 1px;
  }

  /* ── Line items table ─────────────────────────────────────────────────────── */
  .table-wrap { margin-bottom: 30px; }
  table { width: 100%; border-collapse: collapse; }
  thead tr { background: #1e293b; }
  th {
    padding: 9px 10px;
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #94a3b8;
    text-align: left;
    white-space: nowrap;
  }
  th.r, td.r { text-align: right; }
  th.c, td.c { text-align: center; }

  td {
    padding: 7px 10px;
    vertical-align: middle;
    color: #334155;
    font-size: 12px;
    border-bottom: 1px solid #f1f5f9;
  }
  tr.even td { background: #f8fafc; }
  tr.odd  td { background: #ffffff; }
  tr.disc td { background: #fffbeb !important; border-bottom-color: #fde68a; }

  .mono { font-family: ui-monospace, "SF Mono", Consolas, monospace; }
  .sku-cell  { font-size: 11px; color: #64748b; }
  .bar-cell  { font-size: 10px; color: #94a3b8; }
  .prod-cell { font-weight: 500; color: #1e293b; }
  .var-cell  { font-size: 11px; color: #64748b; }
  .dim       { color: #cbd5e1; }
  .qty-disc  { font-weight: 700; color: #b45309; }
  .fw6       { font-weight: 600; color: #1e293b; }

  .ok-badge {
    color: #16a34a;
    font-weight: 700;
    font-size: 14px;
  }
  .return-badge {
    display: inline-block;
    background: #fee2e2;
    color: #991b1b;
    font-size: 10px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 99px;
    border: 1px solid #fca5a5;
    white-space: nowrap;
  }
  .neg { color: #dc2626; font-weight: 600; }
  .disc-badge {
    display: inline-block;
    background: #fef3c7;
    color: #92400e;
    font-size: 10px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 99px;
    border: 1px solid #fcd34d;
    white-space: nowrap;
  }
  .disc-note-inline {
    font-size: 10px;
    color: #92400e;
    margin-top: 3px;
    font-style: italic;
  }

  /* ── Summary cards ────────────────────────────────────────────────────────── */
  .summary-wrap { margin-bottom: 24px; }
  .summary-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    margin-bottom: 16px;
  }
  .stat {
    border: 1.5px solid #e2e8f0;
    border-radius: 8px;
    padding: 14px 16px;
    background: #fff;
  }
  .stat-warn  { border-color: #fcd34d; background: #fffbeb; }
  .stat-total { border-color: #a5b4fc; background: #eef2ff; }
  .stat-label {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #94a3b8;
    margin-bottom: 6px;
  }
  .stat-value { font-size: 26px; font-weight: 800; color: #1e293b; line-height: 1; }
  .stat-value-warn  { color: #92400e; }
  .stat-ok-tick     { font-size: 18px; color: #16a34a; margin-left: 4px; }
  .stat-value-total { font-size: 19px; color: #4338ca; }

  /* ── Discrepancy notes ────────────────────────────────────────────────────── */
  .disc-notes {
    background: #fffbeb;
    border: 1px solid #fcd34d;
    border-radius: 8px;
    padding: 14px 18px;
  }
  .disc-notes-heading {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #92400e;
    margin-bottom: 10px;
  }
  .disc-note-row {
    display: grid;
    grid-template-columns: 90px 1fr auto;
    gap: 16px;
    padding: 6px 0;
    border-top: 1px solid #fde68a;
    font-size: 11px;
    color: #78350f;
    align-items: baseline;
  }
  .disc-note-row:first-of-type { border-top: none; }
  .disc-note-sku    { font-family: ui-monospace, monospace; font-size: 10px; font-weight: 600; }
  .disc-note-prod   { font-weight: 500; }
  .disc-note-status { white-space: nowrap; font-weight: 600; }
  .disc-note-memo   { grid-column: 2 / -1; font-style: italic; color: #92400e; font-size: 10px; padding-bottom: 4px; }

  /* ── Footer ───────────────────────────────────────────────────────────────── */
  .doc-footer {
    margin-top: 28px;
    border-top: 1px solid #e2e8f0;
    padding-top: 12px;
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: #94a3b8;
  }

  /* ── Print overrides ──────────────────────────────────────────────────────── */
  @media print {
    .no-print { display: none !important; }
    body { font-size: 10px; }
    .page { padding: 0; max-width: 100%; }
    .doc-header { padding-bottom: 14px; }
    .info-strip { margin-bottom: 20px; }
    .table-wrap { margin-bottom: 20px; }
    .summary-wrap { margin-bottom: 20px; }

    @page {
      size: letter portrait;
      margin: 1.2cm 1.5cm;
    }

    thead, tr.disc, tr.even {
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
  }
`;

// ─── Component ────────────────────────────────────────────────────────────────

type LoaderData = Awaited<ReturnType<typeof loader>>;

function exportCsv(invoice: LoaderData["invoice"], vendor: LoaderData["vendor"], lineItems: LoaderData["lineItems"]) {
  const headers = ["SKU", "Product", "Variant", "Barcode", "Qty Ordered", "Qty Received", "Unit Cost", "Line Total", "Discrepancy", "Note"];
  const rows = lineItems.map((li) => [
    li.sku,
    li.product,
    li.variant,
    li.barcode,
    li.qtyOrdered,
    li.qtyReceived,
    li.unitCost.toFixed(2),
    li.lineTotal.toFixed(2),
    li.discrepancy
      ? (li.discrepancy.diff < 0 ? `Short ${Math.abs(li.discrepancy.diff)}` : `Over ${li.discrepancy.diff}`)
      : "OK",
    li.discrepancy?.note ?? "",
  ]);

  const csv = [headers, ...rows]
    .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
    .join("\r\n");

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `receiving-summary-${invoice.invoiceNumber}-${vendor.name.replace(/\s+/g, "-")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ReceivingSummaryPage({ loaderData }: { loaderData: LoaderData }) {
  const { invoice, vendor, lineItems, summary, generatedAt } = loaderData;

  const discrepantItems = lineItems.filter((li) => li.discrepancy !== null);

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Receiving Summary — {invoice.invoiceNumber}</title>
        <style>{CSS}</style>
      </head>
      <body>
        {/* ── Screen action bar ── */}
        <div className="print-bar no-print">
          <div className="print-bar-info">
            <span className="print-bar-title">Receiving Summary</span>
            <span className="print-bar-sub">
              Invoice #{invoice.invoiceNumber} · {vendor.name}
            </span>
          </div>
          <div className="print-bar-actions">
            <button className="print-btn" onClick={() => window.print()}>
              Print / Save PDF
            </button>
            <button className="csv-btn" onClick={() => exportCsv(invoice, vendor, lineItems)}>
              Export CSV
            </button>
            <button className="close-btn" onClick={() => window.close()}>
              Close
            </button>
          </div>
        </div>

        <div className="page">
          {/* ── Document header ── */}
          <div className="doc-header">
            <div>
              <div className="brand">Receively</div>
              <div className="doc-subtitle">Receiving Summary</div>
            </div>
            <div className="doc-right">
              <div className="inv-number">#{invoice.invoiceNumber}</div>
              <div className="inv-meta">Received {fmtDate(invoice.receivedAt)}</div>
              {invoice.invoiceDate && (
                <div className="inv-meta">Invoice Date: {fmtDate(invoice.invoiceDate)}</div>
              )}
            </div>
          </div>

          {/* ── Info strip ── */}
          <div className="info-strip">
            <div className="info-cell">
              <div className="info-cell-label">Vendor</div>
              <div className="info-cell-value">{vendor.name}</div>
            </div>
            <div className="info-cell">
              <div className="info-cell-label">Received By</div>
              <div className="info-cell-value">{invoice.receivedBy}</div>
            </div>
            <div className="info-cell">
              <div className="info-cell-label">Date Received</div>
              <div className="info-cell-value">{fmtDate(invoice.receivedAt)}</div>
            </div>
            <div className="info-cell">
              <div className="info-cell-label">Due Date</div>
              <div className="info-cell-value">{fmtDate(invoice.dueDate)}</div>
            </div>
            <div className="info-cell">
              <div className="info-cell-label">Payment Terms</div>
              <div className="info-cell-value">{fmtPaymentTerms(invoice.paymentTerms)}</div>
            </div>
            <div className="info-cell">
              <div className="info-cell-label">Invoice Total</div>
              <div className="info-cell-value info-cell-value-lg">{fmt$(summary.invoiceTotal)}</div>
            </div>
          </div>

          {/* ── Line items ── */}
          <div className="table-wrap">
            <div className="section-label">Line Items ({lineItems.length})</div>
            <table>
              <thead>
                <tr>
                  <th style={{ width: "10%" }}>SKU</th>
                  <th style={{ width: "28%" }}>Product</th>
                  <th style={{ width: "16%" }}>Variant</th>
                  <th className="r" style={{ width: "7%" }}>Ordered</th>
                  <th className="r" style={{ width: "7%" }}>Received</th>
                  <th className="r" style={{ width: "11%" }}>Cost</th>
                  <th className="r" style={{ width: "11%" }}>Total</th>
                  <th className="c" style={{ width: "10%" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {lineItems.map((li, i) => {
                  const isDisc = li.discrepancy !== null;
                  const isReturn = li.qtyReceived < 0;
                  const rowClass = isDisc ? "disc" : i % 2 === 0 ? "even" : "odd";
                  const diff = isDisc ? li.discrepancy!.diff : 0;
                  return (
                    <tr key={li.id} className={rowClass}>
                      <td className="mono sku-cell">{li.sku || <span className="dim">—</span>}</td>
                      <td className="prod-cell">{li.product}</td>
                      <td className="var-cell">
                        {li.variant || <span className="dim">—</span>}
                      </td>
                      <td className={`r${isReturn ? " neg" : ""}`}>{li.qtyOrdered}</td>
                      <td className={`r${isDisc ? " qty-disc" : isReturn ? " neg" : ""}`}>{li.qtyReceived}</td>
                      <td className="r">{fmt$(li.unitCost)}</td>
                      <td className={`r fw6${li.lineTotal < 0 ? " neg" : ""}`}>{fmt$(li.lineTotal)}</td>
                      <td className="c">
                        {isDisc ? (
                          <div>
                            <span className="disc-badge">
                              {diff < 0 ? `⚠ Short ${Math.abs(diff)}` : `⚠ Over ${diff}`}
                            </span>
                            {li.discrepancy!.note && (
                              <div className="disc-note-inline">{li.discrepancy!.note}</div>
                            )}
                          </div>
                        ) : isReturn ? (
                          <span className="return-badge">↩ Return</span>
                        ) : (
                          <span className="ok-badge">✓</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* ── Summary ── */}
          <div className="summary-wrap">
            <div className="section-label">Summary</div>
            <div className="summary-grid">
              <div className="stat">
                <div className="stat-label">Items Ordered</div>
                <div className="stat-value">{summary.totalOrdered}</div>
              </div>
              <div className="stat">
                <div className="stat-label">Items Received</div>
                <div className="stat-value">{summary.totalReceived}</div>
              </div>
              <div className={`stat${summary.totalDiscrepancies > 0 ? " stat-warn" : ""}`}>
                <div className="stat-label">Discrepancies</div>
                <div className={`stat-value${summary.totalDiscrepancies > 0 ? " stat-value-warn" : ""}`}>
                  {summary.totalDiscrepancies}
                  {summary.totalDiscrepancies === 0 && (
                    <span className="stat-ok-tick">✓</span>
                  )}
                </div>
              </div>
              <div className="stat stat-total">
                <div className="stat-label">Invoice Total</div>
                <div className="stat-value stat-value-total">
                  {(summary.shippingCost !== 0 || summary.adjustments !== 0) ? (
                    <table style={{ fontSize: "0.78em", width: "100%", borderCollapse: "collapse", marginTop: "2px" }}>
                      <tbody>
                        <tr>
                          <td style={{ textAlign: "left", fontWeight: "normal", paddingBottom: "2px" }}>Subtotal</td>
                          <td style={{ textAlign: "right", fontWeight: "normal", paddingBottom: "2px" }}>{fmt$(summary.lineSubtotal)}</td>
                        </tr>
                        {summary.shippingCost !== 0 && (
                          <tr>
                            <td style={{ textAlign: "left", fontWeight: "normal", paddingBottom: "2px" }}>Shipping</td>
                            <td style={{ textAlign: "right", fontWeight: "normal", paddingBottom: "2px" }}>{fmt$(summary.shippingCost)}</td>
                          </tr>
                        )}
                        {summary.adjustments !== 0 && (
                          <tr>
                            <td style={{ textAlign: "left", fontWeight: "normal", paddingBottom: "2px" }}>Adjustments</td>
                            <td style={{ textAlign: "right", fontWeight: "normal", paddingBottom: "2px" }}>{fmt$(summary.adjustments)}</td>
                          </tr>
                        )}
                        <tr style={{ borderTop: "1px solid currentColor" }}>
                          <td style={{ textAlign: "left", paddingTop: "3px" }}>Total</td>
                          <td style={{ textAlign: "right", paddingTop: "3px" }}>{fmt$(summary.invoiceTotal)}</td>
                        </tr>
                      </tbody>
                    </table>
                  ) : fmt$(summary.invoiceTotal)}
                </div>
              </div>
            </div>

            {discrepantItems.length > 0 && (
              <div className="disc-notes">
                <div className="disc-notes-heading">
                  Discrepancy Notes — {discrepantItems.length} line item{discrepantItems.length !== 1 ? "s" : ""}
                </div>
                {discrepantItems.map((li) => {
                  const diff = li.discrepancy!.diff;
                  return (
                    <div key={li.id}>
                      <div className="disc-note-row">
                        <span className="disc-note-sku mono">{li.sku || "—"}</span>
                        <span className="disc-note-prod">{li.product}</span>
                        <span className="disc-note-status">
                          {diff < 0
                            ? `Short ${Math.abs(diff)}`
                            : `Over ${diff}`}
                          {" · "}ordered {li.discrepancy!.expected}, received {li.discrepancy!.actual}
                        </span>
                      </div>
                      {li.discrepancy!.note && (
                        <div className="disc-note-memo">"{li.discrepancy!.note}"</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ── Footer ── */}
          <div className="doc-footer">
            <span>Generated by Receively</span>
            <span>{fmtDateTime(generatedAt)}</span>
          </div>
        </div>
      </body>
    </html>
  );
}
