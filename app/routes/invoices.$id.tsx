import { Link, Form, redirect, useFetcher } from "react-router";
import { useState, useEffect } from "react";
import type { Route } from "./+types/invoices.$id";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";
import { logFailure } from "../services/failure-log.server";
import { updateInventoryItemSku, updateVariantBarcode } from "../services/shopify.server";
import type { InvoiceStatus } from "@prisma/client";

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
  const id = Number(params.id);
  const invoice = await getDb().invoice.findUnique({
    where: { id },
    include: { vendor: true, lineItems: true },
  });
  if (!invoice) throw new Response("Not Found", { status: 404 });
  return {
    invoice: {
      ...invoice,
      total: Number(invoice.total),
      invoiceDate: invoice.invoiceDate ? invoice.invoiceDate.toISOString() : null,
      paymentTerms: invoice.paymentTerms ?? null,
      lineItems: invoice.lineItems.map((item) => ({
        ...item,
        unitCost: Number(item.unitCost),
        retailPrice: item.retailPrice !== null ? Number(item.retailPrice) : null,
      })),
    },
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const id = Number(params.id);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "markPaid") {
    const db = getDb();
    const invoice = await db.invoice.findUnique({ where: { id } });
    if (!invoice || invoice.status !== "RECEIVED") {
      throw new Response("Conflict", { status: 409 });
    }
    await db.$transaction([
      db.invoice.update({ where: { id }, data: { status: "PAID" } }),
      db.auditLog.create({
        data: {
          userId,
          action: "INVOICE_MARKED_PAID",
          details: `Invoice #${invoice.invoiceNumber} marked as paid`,
        },
      }),
    ]);
    return redirect(`/invoices/${id}`);
  }

  if (intent === "deleteInvoice") {
    const db = getDb();
    const invoice = await db.invoice.findUnique({ where: { id } });
    if (!invoice) throw new Response("Not Found", { status: 404 });
    await db.$transaction([
      db.invoice.delete({ where: { id } }),
      db.auditLog.create({
        data: {
          userId,
          action: "INVOICE_DELETED",
          details: `Invoice #${invoice.invoiceNumber} deleted`,
          vendorId: invoice.vendorId,
        },
      }),
    ]);
    return redirect("/invoices");
  }

  if (intent === "updateLineSku") {
    const db = getDb();
    const lineItemId = Number(formData.get("lineItemId"));
    const sku = String(formData.get("sku") ?? "").trim();

    const lineItem = await db.invoiceLineItem.findUnique({
      where: { id: lineItemId },
      select: { shopifyInventoryItemId: true },
    });

    await db.invoiceLineItem.update({ where: { id: lineItemId }, data: { sku } });

    if (lineItem?.shopifyInventoryItemId) {
      try {
        await updateInventoryItemSku(lineItem.shopifyInventoryItemId, sku);
      } catch (err) {
        await logFailure(
          "shopify:set-sku",
          sku || `lineItem:${lineItemId}`,
          `SKU sync failed for inventoryItem ${lineItem.shopifyInventoryItemId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return { success: true, intent: "updateLineSku" as const, lineItemId, sku };
  }

  if (intent === "updateBarcode") {
    const db = getDb();
    const lineItemId = Number(formData.get("lineItemId"));
    const barcode = String(formData.get("barcode") ?? "").trim();

    const lineItem = await db.invoiceLineItem.findUnique({
      where: { id: lineItemId },
      select: { shopifyVariantId: true, sku: true },
    });

    await db.invoiceLineItem.update({
      where: { id: lineItemId },
      data: { barcode: barcode || null },
    });

    if (lineItem?.shopifyVariantId && barcode) {
      try {
        await updateVariantBarcode(lineItem.shopifyVariantId, barcode);
      } catch (err) {
        await logFailure(
          "shopify:set-barcode",
          lineItem.sku || `lineItem:${lineItemId}`,
          `Barcode sync failed for variant ${lineItem.shopifyVariantId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return { success: true, intent: "updateBarcode" as const, lineItemId, barcode };
  }

  return redirect(`/invoices/${id}`);
}

const PAYMENT_TERMS_LABELS: Record<string, string> = {
  NET30: "Net 30",
  NET60: "Net 60",
  NET90: "Net 90",
  DUE_ON_RECEIPT: "Due on Receipt",
  CUSTOM: "Custom",
};

const STATUS_LABELS: Record<InvoiceStatus, string> = {
  ORDERED: "Ordered",
  RECEIVED: "Received",
  PAID: "Paid",
};

const STATUS_BADGE: Record<InvoiceStatus, string> = {
  ORDERED: "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300",
  RECEIVED: "bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300",
  PAID: "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300",
};

export default function InvoiceDetailPage({ loaderData }: Route.ComponentProps) {
  const { invoice } = loaderData;
  const { vendor, lineItems } = invoice;

  // SKU inline edit
  const skuFetcher = useFetcher<{ success: boolean; intent: string; lineItemId: number; sku: string }>();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [skuDraft, setSkuDraft] = useState("");
  const [savedSkuId, setSavedSkuId] = useState<number | null>(null);
  const [skuOverrides, setSkuOverrides] = useState<Map<number, string>>(new Map());

  useEffect(() => {
    if (skuFetcher.state === "idle" && skuFetcher.data?.success && skuFetcher.data.intent === "updateLineSku") {
      const { lineItemId, sku } = skuFetcher.data;
      setSkuOverrides((prev) => new Map(prev).set(lineItemId, sku));
      setEditingId(null);
      setSavedSkuId(lineItemId);
      const timer = setTimeout(() => setSavedSkuId(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [skuFetcher.state, skuFetcher.data]);

  function handleSaveSku(lineItemId: number) {
    const fd = new FormData();
    fd.append("intent", "updateLineSku");
    fd.append("lineItemId", String(lineItemId));
    fd.append("sku", skuDraft);
    skuFetcher.submit(fd, { method: "post" });
  }

  // Barcode inline edit
  const barcodeFetcher = useFetcher<{ success: boolean; intent: string; lineItemId: number; barcode: string }>();
  const [editingBarcodeId, setEditingBarcodeId] = useState<number | null>(null);
  const [barcodeDraft, setBarcodeDraft] = useState("");
  const [savedBarcodeId, setSavedBarcodeId] = useState<number | null>(null);
  const [barcodeOverrides, setBarcodeOverrides] = useState<Map<number, string | null>>(new Map());

  useEffect(() => {
    if (barcodeFetcher.state === "idle" && barcodeFetcher.data?.success && barcodeFetcher.data.intent === "updateBarcode") {
      const { lineItemId, barcode } = barcodeFetcher.data;
      setBarcodeOverrides((prev) => new Map(prev).set(lineItemId, barcode || null));
      setEditingBarcodeId(null);
      setSavedBarcodeId(lineItemId);
      const timer = setTimeout(() => setSavedBarcodeId(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [barcodeFetcher.state, barcodeFetcher.data]);

  function handleSaveBarcode(lineItemId: number) {
    const fd = new FormData();
    fd.append("intent", "updateBarcode");
    fd.append("lineItemId", String(lineItemId));
    fd.append("barcode", barcodeDraft);
    barcodeFetcher.submit(fd, { method: "post" });
  }

  return (
    <main className="p-8 max-w-5xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link
          to="/invoices"
          className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100 transition-colors"
        >
          ← Invoices
        </Link>
        <span className="text-gray-300 dark:text-gray-600">/</span>
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">{invoice.invoiceNumber}</h2>
      </div>

      {/* Header card */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-6 mb-6">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-6">
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Vendor</p>
            <p className="text-sm font-medium text-gray-800 dark:text-gray-100">{vendor.name}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Invoice Date</p>
            <p className="text-sm text-gray-800 dark:text-gray-100">
              {invoice.invoiceDate ? new Date(invoice.invoiceDate).toLocaleDateString() : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Due Date</p>
            <p className="text-sm text-gray-800 dark:text-gray-100">
              {invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString() : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Payment Terms</p>
            <p className="text-sm text-gray-800 dark:text-gray-100">
              {invoice.paymentTerms ? (PAYMENT_TERMS_LABELS[invoice.paymentTerms] ?? invoice.paymentTerms) : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Status</p>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_BADGE[invoice.status]}`}
            >
              {STATUS_LABELS[invoice.status]}
            </span>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Total</p>
            <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">
              ${Number(invoice.total).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-3 mb-6">
        {invoice.status === "ORDERED" && (
          <Link
            to={`/invoices/${invoice.id}/receive`}
            className="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
          >
            Begin Receiving
          </Link>
        )}
        {invoice.status === "RECEIVED" && (
          <Form method="post">
            <input type="hidden" name="intent" value="markPaid" />
            <button
              type="submit"
              className="bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
            >
              Mark as Paid
            </button>
          </Form>
        )}
        <Form
          method="post"
          className="ml-auto"
          onSubmit={(e) => {
            if (!window.confirm(`Delete invoice #${invoice.invoiceNumber} and all its line items? This cannot be undone.`)) {
              e.preventDefault();
            }
          }}
        >
          <input type="hidden" name="intent" value="deleteInvoice" />
          <button
            type="submit"
            className="border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 text-sm font-medium rounded-lg px-4 py-2 transition-colors"
          >
            Delete Invoice
          </button>
        </Form>
      </div>

      {/* Unlinked Shopify products notice */}
      {lineItems.some((li) => !li.shopifyVariantId) && (
        <div className="mb-6 flex items-start gap-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-xl px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-400 text-white text-xs font-bold shrink-0 mt-0.5">!</span>
          <span>
            <strong>{lineItems.filter((li) => !li.shopifyVariantId).length} line item{lineItems.filter((li) => !li.shopifyVariantId).length !== 1 ? "s" : ""}</strong> {lineItems.filter((li) => !li.shopifyVariantId).length !== 1 ? "have" : "has"} no linked Shopify product.
            {" "}Skeleton creation may still be pending — check the <Link to="/failures" className="underline hover:text-amber-900 dark:hover:text-amber-200">failure log</Link> if this persists.
          </span>
        </div>
      )}

      {/* Line items table */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">SKU</th>
              <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Description</th>
              <th className="text-right px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Qty Ordered</th>
              <th className="text-right px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Unit Cost</th>
              <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Barcode</th>
              <th className="text-right px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Line Total</th>
            </tr>
          </thead>
          <tbody>
            {lineItems.map((item, i) => {
              const lineTotal = item.quantityOrdered * Number(item.unitCost);
              return (
                <tr
                  key={item.id}
                  className={`group ${i < lineItems.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : ""}`}
                >
                  <td className="px-6 py-4 min-w-[140px]">
                    {editingId === item.id ? (
                      <div className="flex items-center gap-1.5">
                        <input
                          autoFocus
                          type="text"
                          value={skuDraft}
                          onChange={(e) => setSkuDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleSaveSku(item.id);
                            if (e.key === "Escape") setEditingId(null);
                          }}
                          className="font-mono text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-0.5 w-28 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          placeholder="SKU"
                        />
                        <button
                          type="button"
                          onClick={() => handleSaveSku(item.id)}
                          disabled={skuFetcher.state !== "idle"}
                          className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 disabled:text-gray-400"
                        >
                          {skuFetcher.state !== "idle" ? "Saving…" : "Save"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <span className={`font-mono ${(skuOverrides.get(item.id) ?? item.sku) ? "text-gray-700 dark:text-gray-200" : "text-gray-400 dark:text-gray-500 italic"}`}>
                          {(skuOverrides.get(item.id) ?? item.sku) || "— no SKU"}
                        </span>
                        {savedSkuId === item.id ? (
                          <span className="text-green-600 dark:text-green-400 text-xs font-medium">✓</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingId(item.id);
                              setSkuDraft(skuOverrides.get(item.id) ?? item.sku ?? "");
                            }}
                            className={`text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors ${(skuOverrides.get(item.id) ?? item.sku) ? "opacity-0 group-hover:opacity-100" : ""}`}
                            title="Edit SKU"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                              <path d="M13.488 2.513a1.75 1.75 0 0 0-2.475 0L6.75 6.774a2.75 2.75 0 0 0-.596.892l-.68 1.865a.25.25 0 0 0 .32.32l1.865-.68c.341-.125.65-.318.892-.596l4.261-4.263a1.75 1.75 0 0 0 0-2.475ZM3.75 12.5a.25.25 0 0 0-.25.25v.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-.5a.25.25 0 0 0-.25-.25h-8.5Z" />
                            </svg>
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-6 py-4 text-gray-600 dark:text-gray-300">
                    <div>{item.description}</div>
                    {item.shopifyProductTitle && item.shopifyProductTitle !== item.description && (
                      <div className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{item.shopifyProductTitle}</div>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right text-gray-700 dark:text-gray-200">{item.quantityOrdered}</td>
                  <td className="px-6 py-4 text-right text-gray-700 dark:text-gray-200">
                    ${Number(item.unitCost).toFixed(2)}
                  </td>
                  <td className="px-6 py-4 min-w-[160px]">
                    {editingBarcodeId === item.id ? (
                      <div className="flex items-center gap-1.5">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500 shrink-0" aria-hidden="true">
                          <rect x="2" y="4" width="3" height="16" rx="0.5" />
                          <rect x="7" y="4" width="1.5" height="16" rx="0.5" />
                          <rect x="10.5" y="4" width="3" height="16" rx="0.5" />
                          <rect x="15.5" y="4" width="1.5" height="16" rx="0.5" />
                          <rect x="19" y="4" width="3" height="16" rx="0.5" />
                        </svg>
                        <input
                          autoFocus
                          type="text"
                          value={barcodeDraft}
                          onChange={(e) => setBarcodeDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); handleSaveBarcode(item.id); }
                            if (e.key === "Escape") setEditingBarcodeId(null);
                          }}
                          className="font-mono text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-0.5 w-32 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          placeholder="Barcode"
                        />
                        <button
                          type="button"
                          onClick={() => handleSaveBarcode(item.id)}
                          disabled={barcodeFetcher.state !== "idle"}
                          className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 disabled:text-gray-400"
                        >
                          {barcodeFetcher.state !== "idle" ? "Saving…" : "Save"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingBarcodeId(null)}
                          className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        {savedBarcodeId === item.id ? (
                          <span className="text-green-600 dark:text-green-400 text-xs font-medium">✓</span>
                        ) : null}
                        <span
                          className={`font-mono text-sm ${(barcodeOverrides.has(item.id) ? barcodeOverrides.get(item.id) : item.barcode) ? "text-gray-700 dark:text-gray-200" : "text-gray-400 dark:text-gray-500 italic"}`}
                        >
                          {(barcodeOverrides.has(item.id) ? barcodeOverrides.get(item.id) : item.barcode) || "— no barcode"}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingBarcodeId(item.id);
                            setBarcodeDraft((barcodeOverrides.has(item.id) ? barcodeOverrides.get(item.id) : item.barcode) ?? "");
                          }}
                          className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors opacity-0 group-hover:opacity-100"
                          title="Edit barcode"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                            <path d="M13.488 2.513a1.75 1.75 0 0 0-2.475 0L6.75 6.774a2.75 2.75 0 0 0-.596.892l-.68 1.865a.25.25 0 0 0 .32.32l1.865-.68c.341-.125.65-.318.892-.596l4.261-4.263a1.75 1.75 0 0 0 0-2.475ZM3.75 12.5a.25.25 0 0 0-.25.25v.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-.5a.25.25 0 0 0-.25-.25h-8.5Z" />
                          </svg>
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right font-medium text-gray-800 dark:text-gray-100">
                    ${lineTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
              <td colSpan={5} className="px-6 py-3 text-sm font-medium text-gray-600 dark:text-gray-400 text-right">
                Total
              </td>
              <td className="px-6 py-3 text-right font-semibold text-gray-800 dark:text-gray-100">
                ${Number(invoice.total).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </main>
  );
}
