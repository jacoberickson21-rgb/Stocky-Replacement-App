import { getDb } from "../db.server";
import { requireUserId } from "../session.server";

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request, params }: { request: Request; params: { id?: string } }) {
  await requireUserId(request);
  const id = Number(params.id);
  const db = getDb();

  const credit = await db.credit.findUnique({
    where: { id },
    include: {
      vendor: true,
      supplier: true,
      lineItems: { orderBy: { id: "asc" } },
    },
  });
  if (!credit) throw new Response("Not Found", { status: 404 });

  // Best-effort: find the user who created this credit
  const createdLog = await db.auditLog.findFirst({
    where: {
      vendorId: credit.vendorId,
      action: { in: ["CREDIT_INVOICE_CREATED", "CREDIT_ADDED"] },
    },
    include: { user: { select: { name: true } } },
    orderBy: { timestamp: "desc" },
  });

  const lineItems = credit.lineItems.map((li) => ({
    id: li.id,
    sku: li.sku ?? "",
    description: li.description,
    quantity: li.quantity,
    unitCost: Number(li.unitCost),
    lineTotal: Number(li.lineTotal),
    shopifyVariantId: li.shopifyVariantId,
    shopifyInventoryItemId: li.shopifyInventoryItemId,
    inventorySynced: li.inventorySynced,
  }));

  const totalQty = lineItems.reduce((s, li) => s + li.quantity, 0);

  return {
    credit: {
      id: credit.id,
      vendorId: credit.vendorId,
      vendorName: credit.vendor.name,
      supplierName: credit.supplier?.name ?? null,
      amount: Number(credit.amount),
      sku: credit.sku,
      description: credit.description,
      quantity: credit.quantity,
      invoiceNumber: credit.invoiceNumber,
      notes: credit.notes,
      date: credit.date.toISOString(),
    },
    lineItems,
    totalQty,
    createdBy: createdLog?.user?.name ?? "—",
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

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
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
  .credit-id {
    font-size: 20px;
    font-weight: 700;
    color: #1e293b;
    font-family: ui-monospace, "SF Mono", Consolas, monospace;
    letter-spacing: -0.5px;
    line-height: 1;
  }
  .credit-meta { font-size: 11px; color: #64748b; margin-top: 4px; }

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
  .info-cell-value-credit {
    font-size: 17px;
    font-weight: 700;
    color: #dc2626;
  }
  .info-cell-value-dim {
    font-size: 14px;
    font-weight: 400;
    color: #94a3b8;
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

  .mono { font-family: ui-monospace, "SF Mono", Consolas, monospace; }
  .sku-cell  { font-size: 11px; color: #64748b; }
  .prod-cell { font-weight: 500; color: #1e293b; }
  .dim       { color: #cbd5e1; }
  .neg       { color: #dc2626; font-weight: 600; }
  .fw6       { font-weight: 600; color: #1e293b; }

  .synced-badge {
    display: inline-block;
    background: #dcfce7;
    color: #166534;
    font-size: 10px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 99px;
    border: 1px solid #86efac;
    white-space: nowrap;
  }
  .pending-badge {
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

  /* ── Summary totals ───────────────────────────────────────────────────────── */
  .totals-row {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 30px;
  }
  .totals-box {
    border: 1.5px solid #fca5a5;
    border-radius: 8px;
    background: #fff5f5;
    padding: 16px 24px;
    min-width: 220px;
  }
  .totals-line {
    display: flex;
    justify-content: space-between;
    gap: 32px;
    font-size: 12px;
    color: #64748b;
    padding: 2px 0;
  }
  .totals-line-total {
    display: flex;
    justify-content: space-between;
    gap: 32px;
    font-size: 15px;
    font-weight: 700;
    color: #dc2626;
    padding-top: 6px;
    margin-top: 6px;
    border-top: 1.5px solid #fca5a5;
  }

  /* ── Simple credit detail ─────────────────────────────────────────────────── */
  .simple-card {
    border: 1.5px solid #e2e8f0;
    border-radius: 8px;
    padding: 20px 24px;
    margin-bottom: 30px;
  }
  .simple-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 20px;
  }
  .simple-field-label {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: #94a3b8;
    margin-bottom: 4px;
  }
  .simple-field-value {
    font-size: 13px;
    font-weight: 600;
    color: #1e293b;
  }
  .simple-field-value-credit {
    font-size: 17px;
    font-weight: 700;
    color: #dc2626;
  }
  .simple-field-mono {
    font-family: ui-monospace, "SF Mono", Consolas, monospace;
    font-size: 12px;
    color: #64748b;
  }

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

// ─── Component ────────────────────────────────────────────────────────────────

type LoaderData = Awaited<ReturnType<typeof loader>>;

function exportCsv(data: LoaderData) {
  const { credit, lineItems } = data;

  let csv: string;
  if (lineItems.length > 0) {
    const headers = ["SKU", "Description", "Qty Returned", "Unit Cost", "Line Total", "Shopify Synced"];
    const rows = lineItems.map((li) => [
      li.sku,
      li.description,
      li.quantity,
      li.unitCost.toFixed(2),
      li.lineTotal.toFixed(2),
      li.inventorySynced ? "Yes" : li.shopifyInventoryItemId ? "Pending" : "No",
    ]);
    csv = [headers, ...rows]
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");
  } else {
    const headers = ["Field", "Value"];
    const rows: (string | number | null)[][] = [
      ["Vendor", credit.vendorName],
      ["Supplier", credit.supplierName ?? ""],
      ["Date", fmtDate(credit.date)],
      ["Reference #", credit.invoiceNumber ?? ""],
      ["SKU", credit.sku ?? ""],
      ["Description", credit.description ?? ""],
      ["Quantity", credit.quantity ?? ""],
      ["Amount", credit.amount.toFixed(2)],
      ["Notes", credit.notes ?? ""],
    ];
    csv = [headers, ...rows]
      .map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","))
      .join("\r\n");
  }

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `credit-summary-${credit.id}-${credit.vendorName.replace(/\s+/g, "-")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function CreditSummaryPage({ loaderData }: { loaderData: LoaderData }) {
  const { credit, lineItems, totalQty, createdBy, generatedAt } = loaderData;
  const hasLineItems = lineItems.length > 0;
  const lineSubtotal = lineItems.reduce((s, li) => s + li.lineTotal, 0);

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Credit Summary — Credit #{credit.id}</title>
        <style>{CSS}</style>
      </head>
      <body>
        {/* ── Screen action bar ── */}
        <div className="print-bar no-print">
          <div className="print-bar-info">
            <span className="print-bar-title">Credit Summary</span>
            <span className="print-bar-sub">
              Credit #{credit.id}
              {credit.invoiceNumber ? ` · Ref: ${credit.invoiceNumber}` : ""}
              {" · "}{credit.vendorName}
            </span>
          </div>
          <div className="print-bar-actions">
            <button className="print-btn" onClick={() => window.print()}>
              Print / Save PDF
            </button>
            <button className="csv-btn" onClick={() => exportCsv(loaderData)}>
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
              <div className="doc-subtitle">Credit Summary</div>
            </div>
            <div className="doc-right">
              <div className="credit-id">Credit #{credit.id}</div>
              {credit.invoiceNumber && (
                <div className="credit-meta">Ref: {credit.invoiceNumber}</div>
              )}
              <div className="credit-meta">{fmtDate(credit.date)}</div>
            </div>
          </div>

          {/* ── Info strip ── */}
          <div className="info-strip">
            <div className="info-cell">
              <div className="info-cell-label">Vendor</div>
              <div className="info-cell-value">{credit.vendorName}</div>
            </div>
            <div className="info-cell">
              <div className="info-cell-label">Supplier</div>
              {credit.supplierName ? (
                <div className="info-cell-value">{credit.supplierName}</div>
              ) : (
                <div className="info-cell-value-dim">—</div>
              )}
            </div>
            <div className="info-cell">
              <div className="info-cell-label">Reference #</div>
              {credit.invoiceNumber ? (
                <div className="info-cell-value">{credit.invoiceNumber}</div>
              ) : (
                <div className="info-cell-value-dim">—</div>
              )}
            </div>
            <div className="info-cell">
              <div className="info-cell-label">Date</div>
              <div className="info-cell-value">{fmtDate(credit.date)}</div>
            </div>
            <div className="info-cell">
              <div className="info-cell-label">Created By</div>
              <div className="info-cell-value">{createdBy}</div>
            </div>
            <div className="info-cell">
              <div className="info-cell-label">Total Credit</div>
              <div className="info-cell-value-credit">{fmt$(credit.amount)}</div>
            </div>
          </div>

          {hasLineItems ? (
            <>
              {/* ── Line items table ── */}
              <div className="table-wrap">
                <div className="section-label">
                  Line Items ({lineItems.length} item{lineItems.length !== 1 ? "s" : ""}, {totalQty} unit{totalQty !== 1 ? "s" : ""} returned)
                </div>
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: "12%" }}>SKU</th>
                      <th style={{ width: "36%" }}>Description</th>
                      <th className="r" style={{ width: "8%" }}>Qty</th>
                      <th className="r" style={{ width: "14%" }}>Unit Cost</th>
                      <th className="r" style={{ width: "14%" }}>Line Total</th>
                      <th className="c" style={{ width: "16%" }}>Synced</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lineItems.map((li, i) => (
                      <tr key={li.id} className={i % 2 === 0 ? "even" : "odd"}>
                        <td className="mono sku-cell">{li.sku || <span className="dim">—</span>}</td>
                        <td className="prod-cell">{li.description}</td>
                        <td className="r neg">{li.quantity}</td>
                        <td className="r">{fmt$(li.unitCost)}</td>
                        <td className="r neg">{fmt$(li.lineTotal)}</td>
                        <td className="c">
                          {li.inventorySynced ? (
                            <span className="synced-badge">✓ Synced</span>
                          ) : li.shopifyInventoryItemId ? (
                            <span className="pending-badge">Pending</span>
                          ) : (
                            <span className="dim">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* ── Totals ── */}
              <div className="totals-row">
                <div className="totals-box">
                  <div className="totals-line">
                    <span>Items returned</span>
                    <span>{totalQty} unit{totalQty !== 1 ? "s" : ""}</span>
                  </div>
                  <div className="totals-line">
                    <span>Line subtotal</span>
                    <span>{fmt$(lineSubtotal)}</span>
                  </div>
                  <div className="totals-line-total">
                    <span>Total Credit</span>
                    <span>{fmt$(credit.amount)}</span>
                  </div>
                </div>
              </div>
            </>
          ) : (
            /* ── Simple credit ── */
            <>
              <div className="section-label">Credit Details</div>
              <div className="simple-card">
                <div className="simple-grid">
                  {credit.sku && (
                    <div>
                      <div className="simple-field-label">SKU</div>
                      <div className="simple-field-mono">{credit.sku}</div>
                    </div>
                  )}
                  {credit.description && (
                    <div>
                      <div className="simple-field-label">Description</div>
                      <div className="simple-field-value">{credit.description}</div>
                    </div>
                  )}
                  {credit.quantity !== null && (
                    <div>
                      <div className="simple-field-label">Quantity</div>
                      <div className="simple-field-value">{credit.quantity}</div>
                    </div>
                  )}
                  {credit.notes && (
                    <div style={{ gridColumn: "1 / -1" }}>
                      <div className="simple-field-label">Notes</div>
                      <div className="simple-field-value" style={{ fontWeight: 400, color: "#475569" }}>
                        {credit.notes}
                      </div>
                    </div>
                  )}
                  <div>
                    <div className="simple-field-label">Credit Amount</div>
                    <div className="simple-field-value-credit">{fmt$(credit.amount)}</div>
                  </div>
                </div>
              </div>
            </>
          )}

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
