import { getDb } from "../db.server";
import { requireUserId } from "../session.server";

const STORE_SETTING_KEYS = ["storeName", "storeAddress", "storeCity", "storeState", "storeZip", "storePhone", "storeEmail"] as const;

export async function loader({ request, params }: { request: Request; params: { id?: string } }) {
  await requireUserId(request);
  const id = Number(params.id);
  const db = getDb();

  const [invoice, storeSettingRows] = await Promise.all([
    db.invoice.findUnique({
      where: { id },
      include: {
        vendor: true,
        lineItems: { orderBy: { id: "asc" } },
      },
    }),
    db.appSetting.findMany({ where: { key: { in: [...STORE_SETTING_KEYS] } } }),
  ]);

  if (!invoice) throw new Response("Not Found", { status: 404 });

  const storeSettings = Object.fromEntries(STORE_SETTING_KEYS.map((k) => [k, ""])) as Record<
    typeof STORE_SETTING_KEYS[number],
    string
  >;
  for (const row of storeSettingRows) storeSettings[row.key as typeof STORE_SETTING_KEYS[number]] = row.value;

  const lineItems = invoice.lineItems.map((li) => {
    const unitCost = Number(li.unitCost);
    const qty = li.quantityOrdered;
    return {
      id: li.id,
      sku: li.sku ?? "",
      description: li.description,
      qty,
      unitCost,
      lineTotal: qty * unitCost,
    };
  });

  const total = lineItems.reduce((s, li) => s + li.lineTotal, 0);

  return {
    invoice: {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      createdAt: invoice.createdAt.toISOString(),
      invoiceDate: invoice.invoiceDate?.toISOString() ?? null,
      paymentTerms: invoice.paymentTerms ?? null,
      paymentTermsNotes: invoice.paymentTermsNotes ?? null,
    },
    vendor: invoice.vendor
      ? {
          name: invoice.vendor.name,
          contactName: invoice.vendor.contactName,
          email: invoice.vendor.email,
          phone: invoice.vendor.phone,
          address: invoice.vendor.address,
          city: invoice.vendor.city,
          state: invoice.vendor.state,
          zip: invoice.vendor.zip,
          website: invoice.vendor.website,
        }
      : null,
    store: storeSettings,
    lineItems,
    total,
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
  .inv-number {
    font-size: 20px; font-weight: 700; color: #1e293b;
    font-family: ui-monospace, "SF Mono", Consolas, monospace; letter-spacing: -0.5px; line-height: 1;
  }
  .inv-meta { font-size: 11px; color: #64748b; margin-top: 4px; }

  .addr-strip {
    display: grid; grid-template-columns: 1fr 1fr;
    gap: 24px; margin: 24px 0 30px;
  }
  .addr-block { padding: 14px 16px; border: 1px solid #e2e8f0; border-radius: 8px; }
  .addr-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #94a3b8; margin-bottom: 6px; }
  .addr-name { font-size: 14px; font-weight: 700; color: #1e293b; margin-bottom: 2px; }
  .addr-line { font-size: 11px; color: #475569; line-height: 1.5; }
  .addr-dim { color: #cbd5e1; }

  .meta-strip {
    display: grid; grid-template-columns: repeat(3, 1fr);
    border-top: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0; margin-bottom: 30px;
  }
  .meta-cell { padding: 14px 16px; }
  .meta-cell + .meta-cell { border-left: 1px solid #e2e8f0; }
  .meta-cell-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #94a3b8; margin-bottom: 5px; }
  .meta-cell-value { font-size: 14px; font-weight: 600; color: #1e293b; line-height: 1.3; }

  .section-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #94a3b8; margin-bottom: 8px; padding: 0 1px; }

  .table-wrap { margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; }
  thead tr { background: #1e293b; }
  th { padding: 9px 10px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #94a3b8; text-align: left; white-space: nowrap; }
  th.r, td.r { text-align: right; }
  td { padding: 7px 10px; vertical-align: middle; color: #334155; font-size: 12px; border-bottom: 1px solid #f1f5f9; }
  tr.even td { background: #f8fafc; }
  tr.odd td { background: #ffffff; }
  .mono { font-family: ui-monospace, "SF Mono", Consolas, monospace; }
  .sku-cell { font-size: 11px; color: #64748b; }
  .dim { color: #cbd5e1; }
  .fw6 { font-weight: 600; color: #1e293b; }

  .total-row { display: flex; justify-content: flex-end; margin-bottom: 30px; }
  .total-box { border: 1.5px solid #a5b4fc; background: #eef2ff; border-radius: 8px; padding: 14px 20px; min-width: 200px; }
  .total-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #94a3b8; margin-bottom: 4px; text-align: right; }
  .total-value { font-size: 22px; font-weight: 800; color: #4338ca; text-align: right; }

  .notes-box { border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 16px; min-height: 70px; margin-bottom: 24px; }
  .notes-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #94a3b8; margin-bottom: 8px; }

  .doc-footer { margin-top: 28px; border-top: 1px solid #e2e8f0; padding-top: 12px; display: flex; justify-content: space-between; font-size: 10px; color: #94a3b8; }

  @media print {
    .no-print { display: none !important; }
    body { font-size: 10px; }
    .page { padding: 0; max-width: 100%; }
    .doc-header { padding-bottom: 14px; }
    .addr-strip { margin: 16px 0 20px; }
    .meta-strip { margin-bottom: 20px; }
    .table-wrap { margin-bottom: 16px; }

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

export default function PoPrintPage({ loaderData }: { loaderData: LoaderData }) {
  const { invoice, vendor, store, lineItems, total, generatedAt } = loaderData;

  const storeCityStateZip = [store.storeCity, store.storeState].filter(Boolean).join(", ") + (store.storeZip ? ` ${store.storeZip}` : "");
  const vendorCityStateZip = vendor
    ? [vendor.city, vendor.state].filter(Boolean).join(", ") + (vendor.zip ? ` ${vendor.zip}` : "")
    : "";

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Purchase Order — {invoice.invoiceNumber}</title>
        <style>{CSS}</style>
      </head>
      <body>
        {/* ── Screen action bar ── */}
        <div className="print-bar no-print">
          <div className="print-bar-info">
            <span className="print-bar-title">Purchase Order</span>
            <span className="print-bar-sub">
              #{invoice.invoiceNumber} · {vendor?.name ?? "—"}
            </span>
          </div>
          <div className="print-bar-actions">
            <button className="print-btn" onClick={() => window.print()}>
              Print / Save PDF
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
              <div className="doc-subtitle">Purchase Order</div>
            </div>
            <div className="doc-right">
              <div className="inv-number">#{invoice.invoiceNumber}</div>
              <div className="inv-meta">Date: {fmtDate(invoice.invoiceDate ?? invoice.createdAt)}</div>
            </div>
          </div>

          {/* ── From / To ── */}
          <div className="addr-strip">
            <div className="addr-block">
              <div className="addr-label">From</div>
              <div className="addr-name">{store.storeName || "—"}</div>
              {store.storeAddress && <div className="addr-line">{store.storeAddress}</div>}
              {storeCityStateZip.trim() && <div className="addr-line">{storeCityStateZip}</div>}
              {store.storePhone && <div className="addr-line">{store.storePhone}</div>}
              {store.storeEmail && <div className="addr-line">{store.storeEmail}</div>}
              {!store.storeAddress && !store.storePhone && !store.storeEmail && (
                <div className="addr-line addr-dim">Set store info in Settings to show it here.</div>
              )}
            </div>
            <div className="addr-block">
              <div className="addr-label">To</div>
              <div className="addr-name">{vendor?.name ?? "—"}</div>
              {vendor?.contactName && <div className="addr-line">{vendor.contactName}</div>}
              {vendor?.address && <div className="addr-line">{vendor.address}</div>}
              {vendorCityStateZip.trim() && <div className="addr-line">{vendorCityStateZip}</div>}
              {vendor?.phone && <div className="addr-line">{vendor.phone}</div>}
              {vendor?.email && <div className="addr-line">{vendor.email}</div>}
              {vendor?.website && <div className="addr-line">{vendor.website}</div>}
              {vendor && !vendor.address && !vendor.phone && !vendor.email && (
                <div className="addr-line addr-dim">No address on file for this vendor.</div>
              )}
            </div>
          </div>

          {/* ── Meta strip ── */}
          <div className="meta-strip">
            <div className="meta-cell">
              <div className="meta-cell-label">PO Number</div>
              <div className="meta-cell-value mono">{invoice.invoiceNumber}</div>
            </div>
            <div className="meta-cell">
              <div className="meta-cell-label">Date</div>
              <div className="meta-cell-value">{fmtDate(invoice.invoiceDate ?? invoice.createdAt)}</div>
            </div>
            <div className="meta-cell">
              <div className="meta-cell-label">Payment Terms</div>
              <div className="meta-cell-value">{fmtPaymentTerms(invoice.paymentTerms)}</div>
            </div>
          </div>

          {/* ── Line items ── */}
          <div className="table-wrap">
            <div className="section-label">Line Items ({lineItems.length})</div>
            <table>
              <thead>
                <tr>
                  <th style={{ width: "14%" }}>SKU</th>
                  <th style={{ width: "46%" }}>Description</th>
                  <th className="r" style={{ width: "12%" }}>Qty</th>
                  <th className="r" style={{ width: "14%" }}>Unit Cost</th>
                  <th className="r" style={{ width: "14%" }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {lineItems.map((li, i) => (
                  <tr key={li.id} className={i % 2 === 0 ? "even" : "odd"}>
                    <td className="mono sku-cell">{li.sku || <span className="dim">—</span>}</td>
                    <td>{li.description}</td>
                    <td className="r">{li.qty}</td>
                    <td className="r">{fmt$(li.unitCost)}</td>
                    <td className="r fw6">{fmt$(li.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="total-row">
            <div className="total-box">
              <div className="total-label">Total</div>
              <div className="total-value">{fmt$(total)}</div>
            </div>
          </div>

          <div className="notes-box">
            <div className="notes-label">Notes / Special Instructions</div>
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
