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
    const discrepancy = li.hasDiscrepancy
      ? { expected: qtyOrdered, actual: qtyReceived, note: li.receivingNote ?? "" }
      : null;
    return {
      id: li.id,
      sku: li.sku ?? "",
      description: li.description,
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
  const invoiceTotal = Number(invoice.total);

  return {
    invoice: {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      invoiceDate: invoice.invoiceDate?.toISOString() ?? null,
      receivedAt: receiveLog?.timestamp.toISOString() ?? invoice.updatedAt.toISOString(),
      receivedBy: receiveLog?.user?.name ?? "—",
    },
    vendor: { name: invoice.vendor.name },
    lineItems,
    summary: { totalOrdered, totalReceived, totalDiscrepancies, invoiceTotal },
    generatedAt: new Date().toISOString(),
  };
}

function fmt$(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

type LoaderData = Awaited<ReturnType<typeof loader>>;

export default function ReceivingSummaryPage({ loaderData }: { loaderData: LoaderData }) {
  const { invoice, vendor, lineItems, summary, generatedAt } = loaderData;

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Receiving Summary — {invoice.invoiceNumber}</title>
        <style>{`
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 13px; color: #111; background: #fff; padding: 40px; }
          .page { max-width: 900px; margin: 0 auto; }
          .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; border-bottom: 2px solid #111; padding-bottom: 16px; }
          .brand { font-size: 22px; font-weight: 700; letter-spacing: -0.5px; color: #4f46e5; }
          .doc-title { font-size: 18px; font-weight: 600; color: #374151; margin-top: 4px; }
          .meta-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 28px; }
          .meta-item .label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; margin-bottom: 3px; }
          .meta-item .value { font-size: 13px; font-weight: 500; color: #111; }
          table { width: 100%; border-collapse: collapse; margin-bottom: 28px; }
          thead { background: #f3f4f6; }
          th { text-align: left; padding: 8px 10px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #6b7280; border-bottom: 1px solid #d1d5db; }
          th.right, td.right { text-align: right; }
          th.center, td.center { text-align: center; }
          td { padding: 8px 10px; border-bottom: 1px solid #e5e7eb; color: #374151; vertical-align: top; }
          tr.discrepancy-row td { background: #fff7ed; }
          .disc-badge { display: inline-block; background: #fef3c7; color: #92400e; font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 9999px; border: 1px solid #fcd34d; }
          .disc-note { font-size: 11px; color: #92400e; margin-top: 3px; }
          .summary-box { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 28px; }
          .summary-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px; }
          .summary-card .s-label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; margin-bottom: 4px; }
          .summary-card .s-value { font-size: 20px; font-weight: 700; color: #111; }
          .summary-card.highlight { border-color: #4f46e5; }
          .summary-card.warn { border-color: #f59e0b; }
          .footer { border-top: 1px solid #e5e7eb; padding-top: 12px; display: flex; justify-content: space-between; color: #9ca3af; font-size: 11px; }
          .mono { font-family: ui-monospace, "Cascadia Code", monospace; font-size: 12px; }
          @media print {
            body { padding: 20px; }
            .no-print { display: none !important; }
            @page { margin: 1.5cm; }
          }
        `}</style>
      </head>
      <body>
        <div className="page">
          {/* Header */}
          <div className="header">
            <div>
              <div className="brand">Receively</div>
              <div className="doc-title">Receiving Summary</div>
            </div>
            <button
              onClick={() => window.print()}
              className="no-print"
              style={{ padding: "8px 16px", background: "#4f46e5", color: "#fff", border: "none", borderRadius: "8px", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}
            >
              Print / Save PDF
            </button>
          </div>

          {/* Invoice Metadata */}
          <div className="meta-grid">
            <div className="meta-item">
              <div className="label">Invoice #</div>
              <div className="value mono">{invoice.invoiceNumber}</div>
            </div>
            <div className="meta-item">
              <div className="label">Vendor</div>
              <div className="value">{vendor.name}</div>
            </div>
            <div className="meta-item">
              <div className="label">Date Received</div>
              <div className="value">{fmtDate(invoice.receivedAt)}</div>
            </div>
            <div className="meta-item">
              <div className="label">Received By</div>
              <div className="value">{invoice.receivedBy}</div>
            </div>
          </div>

          {/* Summary Cards */}
          <div className="summary-box">
            <div className="summary-card">
              <div className="s-label">Items Ordered</div>
              <div className="s-value">{summary.totalOrdered}</div>
            </div>
            <div className="summary-card">
              <div className="s-label">Items Received</div>
              <div className="s-value">{summary.totalReceived}</div>
            </div>
            <div className={`summary-card ${summary.totalDiscrepancies > 0 ? "warn" : ""}`}>
              <div className="s-label">Discrepancies</div>
              <div className="s-value" style={{ color: summary.totalDiscrepancies > 0 ? "#d97706" : "#111" }}>
                {summary.totalDiscrepancies}
              </div>
            </div>
            <div className="summary-card highlight">
              <div className="s-label">Invoice Total</div>
              <div className="s-value" style={{ fontSize: "16px" }}>{fmt$(summary.invoiceTotal)}</div>
            </div>
          </div>

          {/* Line Items */}
          <table>
            <thead>
              <tr>
                <th style={{ width: "12%" }}>SKU</th>
                <th style={{ width: "34%" }}>Description</th>
                <th className="right" style={{ width: "10%" }}>Qty Ordered</th>
                <th className="right" style={{ width: "10%" }}>Qty Received</th>
                <th className="right" style={{ width: "11%" }}>Unit Cost</th>
                <th className="right" style={{ width: "11%" }}>Line Total</th>
                <th className="center" style={{ width: "12%" }}>Discrepancy</th>
              </tr>
            </thead>
            <tbody>
              {lineItems.map((li) => (
                <tr key={li.id} className={li.discrepancy ? "discrepancy-row" : ""}>
                  <td className="mono">{li.sku || "—"}</td>
                  <td>{li.description}</td>
                  <td className="right">{li.qtyOrdered}</td>
                  <td className="right">{li.qtyReceived}</td>
                  <td className="right">{fmt$(li.unitCost)}</td>
                  <td className="right">{fmt$(li.lineTotal)}</td>
                  <td className="center">
                    {li.discrepancy ? (
                      <div>
                        <span className="disc-badge">
                          {li.discrepancy.actual < li.discrepancy.expected ? "Short" : "Over"}{" "}
                          {Math.abs(li.discrepancy.actual - li.discrepancy.expected)}
                        </span>
                        {li.discrepancy.note && <div className="disc-note">{li.discrepancy.note}</div>}
                      </div>
                    ) : (
                      <span style={{ color: "#9ca3af" }}>—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Footer */}
          <div className="footer">
            <span>Generated by Receively</span>
            <span>{new Date(generatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</span>
          </div>
        </div>

        <script
          dangerouslySetInnerHTML={{
            __html: "if (window.location.search !== '?noprint') { window.addEventListener('load', () => window.print()); }",
          }}
        />
      </body>
    </html>
  );
}
