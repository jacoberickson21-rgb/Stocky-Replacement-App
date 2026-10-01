import {
  Link,
  Form,
  redirect,
  data,
  useNavigation,
  useActionData,
  useFetcher,
} from "react-router";
import { useState, useEffect } from "react";
import type { Route } from "./+types/invoices.$id.receive";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";
import { logFailure } from "../services/failure-log.server";
import {
  lookupProduct,
  getInventoryQuantitiesByVariant,
} from "../services/shopify.server";
import type { ProductSearchResult } from "../services/shopify.server";
import { syncInvoiceToShopify } from "../services/invoice-shopify-sync.server";
import type { InvoiceStatus } from "@prisma/client";

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
  const id = Number(params.id);
  const db = getDb();
  const invoice = await db.invoice.findUnique({
    where: { id },
    include: { vendor: true, lineItems: true },
  });
  if (!invoice) throw new Response("Not Found", { status: 404 });
  if (!["ORDERED", "DRAFT_RECEIVING"].includes(invoice.status)) return redirect(`/invoices/${id}`);

  // Auto-match unlinked items against Shopify by SKU (with barcode fallback)
  const unlinked = invoice.lineItems.filter((item) => !item.shopifyVariantId);
  if (unlinked.length > 0) {
    const matchResults = await Promise.allSettled(
      unlinked.map((item) => lookupProduct({ sku: item.sku ?? undefined }))
    );
    for (let i = 0; i < unlinked.length; i++) {
      const skuResult = matchResults[i];
      let lookupResult = skuResult.status === "fulfilled" ? skuResult.value : null;
      // Barcode fallback if SKU lookup found nothing
      if (!lookupResult && unlinked[i].barcode) {
        try {
          lookupResult = await lookupProduct({ barcode: unlinked[i].barcode! });
        } catch { /* ignore */ }
      }
      if (lookupResult) {
        const { product } = lookupResult;
        const variant = product.variants[0];
        if (variant) {
          const barcodeUpdate =
            !unlinked[i].barcode && variant.barcode
              ? { barcode: variant.barcode }
              : {};
          await db.invoiceLineItem.update({
            where: { id: unlinked[i].id },
            data: {
              shopifyProductTitle: product.title,
              shopifyVariantId: variant.id,
              shopifyInventoryItemId: variant.inventoryItemId,
              ...barcodeUpdate,
              ...(variant.price && !unlinked[i].retailPrice ? { retailPrice: parseFloat(variant.price) } : {}),
            },
          });
          Object.assign(unlinked[i], {
            shopifyProductTitle: product.title,
            shopifyVariantId: variant.id,
            shopifyInventoryItemId: variant.inventoryItemId,
            ...barcodeUpdate,
          });
        }
      }
    }
  }

  // Fetch current Shopify inventory for all linked variants (best-effort)
  const linkedVariantIds = invoice.lineItems
    .map((item) => item.shopifyVariantId)
    .filter((id): id is string => id !== null);
  let currentInventory: Record<string, number | null> = {};
  if (linkedVariantIds.length > 0) {
    console.log(`[receive] fetching inventory for ${linkedVariantIds.length} variantIds:`, linkedVariantIds);
    try {
      const qtyMap = await getInventoryQuantitiesByVariant(linkedVariantIds);
      currentInventory = Object.fromEntries(qtyMap);
      console.log(`[receive] got ${qtyMap.size} quantities back:`, currentInventory);
    } catch (err) {
      console.error("[receive] getInventoryQuantitiesByVariant failed:", err);
      // Non-fatal — page still works, column shows "—"
    }
  }

  return {
    invoice: {
      ...invoice,
      total: Number(invoice.total),
      lineItems: invoice.lineItems.map((item) => ({
        ...item,
        unitCost: Number(item.unitCost),
      })),
    },
    currentInventory,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const id = Number(params.id);
  const db = getDb();

  const invoice = await db.invoice.findUnique({
    where: { id },
    include: { lineItems: true },
  });
  if (!invoice || !["ORDERED", "DRAFT_RECEIVING"].includes(invoice.status)) {
    throw new Response("Conflict", { status: 409 });
  }

  const formData = await request.formData();
  const intent = formData.get("intent") as string | null;

  // ── Save as Draft ──────────────────────────────────────────────────────────
  if (intent === "saveDraft") {
    try {
      await db.$transaction([
        ...invoice.lineItems.map((item) => {
          const val = formData.get(`qty_${item.id}`);
          const received =
            val !== null && val !== "" && !isNaN(Number(val)) ? Number(val) : 0;
          const note = (formData.get(`note_${item.id}`) as string | null) ?? "";
          const hasDiscrepancy =
            val !== null && val !== "" && !isNaN(Number(val)) && received !== item.quantityOrdered;
          return db.invoiceLineItem.update({
            where: { id: item.id },
            data: { quantityReceived: received, receivingNote: note || null, hasDiscrepancy },
          });
        }),
        db.invoice.update({ where: { id }, data: { status: "DRAFT_RECEIVING" } }),
        db.auditLog.create({
          data: {
            userId,
            action: "INVOICE_RECEIVING_DRAFT",
            details: `Invoice #${invoice.invoiceNumber} receiving saved as draft`,
          },
        }),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      await logFailure("INVOICE_RECEIVE_DRAFT", `Invoice #${invoice.invoiceNumber}`, msg);
      return data(
        { error: "Failed to save draft. The error has been logged." },
        { status: 500 }
      );
    }
    return redirect(`/invoices/${id}`);
  }

  // ── Complete Receiving — require all fields filled ─────────────────────────
  for (const item of invoice.lineItems) {
    const val = formData.get(`qty_${item.id}`);
    if (val === null || val === "" || isNaN(Number(val))) {
      return data(
        { error: "All quantity fields must be filled in before submitting." },
        { status: 422 }
      );
    }
  }

  const discrepancies: string[] = [];

  const discrepancyCreates: ReturnType<typeof db.discrepancyLog.create>[] = [];

  try {
    await db.$transaction([
      ...invoice.lineItems.map((item) => {
        const received = Number(formData.get(`qty_${item.id}`));
        const note = (formData.get(`note_${item.id}`) as string | null) ?? "";
        const hasDiscrepancy = received !== item.quantityOrdered;
        if (hasDiscrepancy) {
          discrepancies.push(
            `${item.sku}: expected ${item.quantityOrdered}, received ${received}`
          );
          discrepancyCreates.push(
            db.discrepancyLog.create({
              data: {
                invoiceLineItemId: item.id,
                invoiceId: id,
                vendorId: invoice.vendorId ?? item.vendorId ?? null,
                sku: item.sku,
                expectedQty: item.quantityOrdered,
                actualQty: received,
                note: note || null,
                staffId: userId,
              },
            })
          );
        }
        return db.invoiceLineItem.update({
          where: { id: item.id },
          data: {
            quantityReceived: received,
            hasDiscrepancy,
            receivingNote: note || null,
            vendorId: invoice.vendorId ?? item.vendorId ?? null,
          },
        });
      }),
      ...discrepancyCreates,
      db.invoice.update({ where: { id }, data: { status: "RECEIVED" } }),
      db.auditLog.create({
        data: {
          userId,
          action: "INVOICE_RECEIVED",
          details:
            discrepancies.length > 0
              ? `Invoice #${invoice.invoiceNumber} received with discrepancies: ${discrepancies.join("; ")}`
              : `Invoice #${invoice.invoiceNumber} received — all quantities matched`,
        },
      }),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    await logFailure("INVOICE_RECEIVE", `Invoice #${invoice.invoiceNumber}`, msg);
    return data(
      { error: "Failed to complete receiving. The error has been logged." },
      { status: 500 }
    );
  }

  // Shopify sync (inventory, price, barcode) — fire-and-forget in the background.
  // The DB transaction above already committed the receive; don't make staff wait
  // on Shopify round-trips before they can move on.
  syncInvoiceToShopify(id).catch((err) => {
    console.error("[receive] background Shopify sync failed:", err);
  });

  return redirect(`/invoices/${id}`);
}

// ─── Types ────────────────────────────────────────────────────────────────────

type LineItem = {
  id: number;
  sku: string | null;
  description: string;
  quantityOrdered: number;
  quantityReceived: number;
  receivingNote: string | null;
  unitCost: number;
  shopifyProductTitle: string | null;
  shopifyVariantId: string | null;
  shopifyInventoryItemId: string | null;
};

// ─── ProductCell ──────────────────────────────────────────────────────────────

function ProductCell({ item }: { item: LineItem }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [linked, setLinked] = useState<{
    title: string | null;
    variantId: string | null;
    inventoryItemId: string | null;
  }>({
    title: item.shopifyProductTitle,
    variantId: item.shopifyVariantId,
    inventoryItemId: item.shopifyInventoryItemId,
  });

  const searchFetcher = useFetcher<ProductSearchResult[]>();
  const linkFetcher = useFetcher();

  useEffect(() => {
    if (query.trim().length < 2) return;
    const timer = setTimeout(() => {
      searchFetcher.load(
        `/api/shopify/products?q=${encodeURIComponent(query.trim())}`
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleSelect(result: ProductSearchResult) {
    linkFetcher.submit(
      {
        variantId: result.variantId,
        productTitle: result.productTitle,
        inventoryItemId: result.inventoryItemId,
      },
      { method: "POST", action: `/api/line-items/${item.id}/link` }
    );
    setLinked({
      title: result.productTitle,
      variantId: result.variantId,
      inventoryItemId: result.inventoryItemId,
    });
    setSearchOpen(false);
    setQuery("");
  }

  const showResults =
    searchFetcher.state === "idle" &&
    searchFetcher.data !== undefined &&
    query.trim().length >= 2;

  return (
    <div className="min-w-0">
      <span className="block font-mono text-gray-700 dark:text-gray-300 whitespace-nowrap">
        {item.sku}
      </span>

      {linked.title ? (
        <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" />
          <span className="text-xs text-gray-400 dark:text-gray-500 leading-tight truncate">
            {linked.title}
          </span>
        </div>
      ) : searchOpen ? (
        <div className="relative mt-1">
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name or SKU…"
            className="w-48 border border-indigo-300 dark:border-indigo-600 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100"
          />
          {searchFetcher.state === "loading" && query.trim().length >= 2 && (
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Searching…</p>
          )}
          {showResults && (
            <div className="absolute left-0 top-full mt-1 z-20 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl w-72 max-h-56 overflow-y-auto">
              {searchFetcher.data!.length === 0 ? (
                <p className="px-3 py-2 text-xs text-gray-400 dark:text-gray-500">
                  No products found
                </p>
              ) : (
                searchFetcher.data!.map((result) => (
                  <button
                    key={result.variantId}
                    type="button"
                    onClick={() => handleSelect(result)}
                    className="w-full text-left px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 border-b border-gray-100 dark:border-gray-700 last:border-0 transition-colors"
                  >
                    <div className="text-xs font-medium text-gray-800 dark:text-gray-100 truncate">
                      {result.productTitle}
                    </div>
                    <div className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                      SKU: {result.sku || "—"} · On hand:{" "}
                      {result.inventoryQty ?? "–"}
                    </div>
                  </button>
                ))
              )}
            </div>
          )}
          <button
            type="button"
            onClick={() => {
              setSearchOpen(false);
              setQuery("");
            }}
            className="block text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 mt-1"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="block mt-0.5 text-xs text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 hover:underline underline-offset-2"
        >
          Link Product
        </button>
      )}
    </div>
  );
}

// ─── Status badge map ─────────────────────────────────────────────────────────

const STATUS_BADGE: Record<InvoiceStatus, string> = {
  ORDERED: "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300",
  DRAFT_RECEIVING: "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300",
  RECEIVED: "bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300",
  PAID: "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300",
};

const STATUS_LABEL: Record<InvoiceStatus, string> = {
  ORDERED: "Ordered",
  DRAFT_RECEIVING: "Receiving Draft",
  RECEIVED: "Received",
  PAID: "Paid",
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ReceivingPage({ loaderData }: Route.ComponentProps) {
  const { invoice, currentInventory } = loaderData;
  const { vendor, lineItems } = invoice;
  const navigation = useNavigation();
  const actionData = useActionData() as { error?: string } | undefined;
  const isSubmitting = navigation.state === "submitting";

  const [quantities, setQuantities] = useState<Record<number, string>>(() =>
    Object.fromEntries(
      lineItems.map((item) => [
        item.id,
        invoice.status === "DRAFT_RECEIVING"
          ? String(item.quantityReceived)
          : String(item.quantityOrdered),
      ])
    )
  );

  const allFilled = lineItems.every(
    (item) => quantities[item.id] !== "" && quantities[item.id] !== undefined
  );

  return (
    <main className="p-8 max-w-5xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-3 mb-6">
        <Link
          to={`/invoices/${invoice.id}`}
          className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100 transition-colors"
        >
          ← {invoice.invoiceNumber}
        </Link>
        <span className="text-gray-300 dark:text-gray-600">/</span>
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">
          Receive Shipment
        </h2>
      </div>

      {/* Header card */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-6 mb-6">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-6">
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
              Vendor
            </p>
            <p className="text-sm font-medium text-gray-800 dark:text-gray-100">{vendor?.name ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
              Invoice
            </p>
            <p className="text-sm font-medium text-gray-800 dark:text-gray-100">
              {invoice.invoiceNumber}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
              Status
            </p>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_BADGE[invoice.status]}`}
            >
              {STATUS_LABEL[invoice.status]}
            </span>
          </div>
        </div>
      </div>

      {/* Receiving form */}
      <Form method="post">
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-x-auto mb-6">
          <table className="w-full text-sm min-w-[1200px]">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400 w-64">
                  SKU / Product
                </th>
                <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">
                  Description
                </th>
                <th className="text-center px-4 py-3 font-medium text-gray-600 dark:text-gray-400 w-20">
                  Expected
                </th>
                <th className="text-center px-4 py-3 font-medium text-gray-600 dark:text-gray-400 w-24">
                  Current Qty
                </th>
                <th className="text-right px-6 py-3 font-medium text-gray-600 dark:text-gray-400 w-36">
                  Received
                </th>
                <th className="text-right px-6 py-3 font-medium text-gray-600 dark:text-gray-400 w-24">
                  Line Total
                </th>
                <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400 w-64">
                  Note
                </th>
                <th className="px-4 py-3 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {lineItems.map((item, i) => {
                const rawQty = quantities[item.id];
                const parsedQty = rawQty !== "" ? Number(rawQty) : null;
                const hasDiscrepancy =
                  parsedQty !== null && parsedQty !== item.quantityOrdered;

                return (
                  <tr
                    key={item.id}
                    className={[
                      i < lineItems.length - 1
                        ? "border-b border-gray-100 dark:border-gray-700"
                        : "",
                      hasDiscrepancy ? "bg-amber-50 dark:bg-amber-950/30" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <td className="px-6 py-4 align-top">
                      <ProductCell item={item} />
                    </td>
                    <td className="px-6 py-4 text-gray-600 dark:text-gray-300 align-top">
                      {item.description}
                    </td>
                    <td className="px-4 py-4 text-center text-gray-700 dark:text-gray-300 tabular-nums align-top">
                      {item.quantityOrdered}
                    </td>
                    <td className="px-4 py-4 text-center tabular-nums align-top">
                      {item.shopifyVariantId && item.shopifyVariantId in currentInventory ? (
                        <span className="text-gray-400 dark:text-gray-500">
                          {currentInventory[item.shopifyVariantId] ?? "—"}
                        </span>
                      ) : (
                        <span className="text-gray-300 dark:text-gray-600">—</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-right align-top">
                      <div>
                        <input
                          type="number"
                          name={`qty_${item.id}`}
                          required
                          value={rawQty}
                          onChange={(e) =>
                            setQuantities((prev) => ({
                              ...prev,
                              [item.id]: e.target.value,
                            }))
                          }
                          className={[
                            "w-24 text-right border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 transition-colors dark:text-gray-100",
                            hasDiscrepancy
                              ? "border-amber-400 dark:border-amber-600 focus:ring-amber-300 bg-white dark:bg-gray-800"
                              : parsedQty !== null && parsedQty < 0
                              ? "border-red-300 dark:border-red-700 focus:ring-red-300 bg-white dark:bg-gray-800 text-red-600 dark:text-red-400"
                              : "border-gray-300 dark:border-gray-600 focus:ring-indigo-300 bg-white dark:bg-gray-800",
                          ].join(" ")}
                          placeholder="0"
                        />
                        {parsedQty !== null && parsedQty < 0 && (
                          <div className="text-xs text-red-600 dark:text-red-400 mt-1 font-medium text-right">
                            (return)
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right tabular-nums align-top">
                      {parsedQty !== null ? (
                        <span
                          className={
                            parsedQty < 0
                              ? "text-red-600 dark:text-red-400 font-medium"
                              : "text-gray-700 dark:text-gray-300"
                          }
                        >
                          {(parsedQty * item.unitCost).toLocaleString("en-US", {
                            style: "currency",
                            currency: "USD",
                            minimumFractionDigits: 2,
                          })}
                        </span>
                      ) : (
                        <span className="text-gray-400 dark:text-gray-500">—</span>
                      )}
                    </td>
                    <td className="px-6 py-4 align-top">
                      <input
                        type="text"
                        name={`note_${item.id}`}
                        placeholder="Optional note"
                        defaultValue={item.receivingNote ?? ""}
                        className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 transition-colors bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500"
                      />
                    </td>
                    <td className="px-4 py-4 align-top">
                      {hasDiscrepancy && (
                        <span
                          title="Quantity discrepancy"
                          className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-400 text-white text-xs font-bold"
                        >
                          !
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {actionData?.error
              ? actionData.error
              : !allFilled
              ? "All quantity fields are required to complete receiving."
              : ""}
          </p>
          <div className="flex items-center gap-3">
            <button
              type="submit"
              name="intent"
              value="saveDraft"
              disabled={isSubmitting}
              className="inline-flex items-center gap-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium rounded-lg px-5 py-2.5 transition-colors"
            >
              {isSubmitting && navigation.formData?.get("intent") === "saveDraft" && (
                <svg className="animate-spin h-4 w-4 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 22 12h-4a8 8 0 01-8-8z" />
                </svg>
              )}
              {isSubmitting && navigation.formData?.get("intent") === "saveDraft"
                ? "Saving…"
                : "Save as Draft"}
            </button>
            <button
              type="submit"
              name="intent"
              value="complete"
              disabled={!allFilled || isSubmitting}
              className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-5 py-2.5 transition-colors"
            >
              {isSubmitting && navigation.formData?.get("intent") === "complete" && (
                <svg className="animate-spin h-4 w-4 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 22 12h-4a8 8 0 01-8-8z" />
                </svg>
              )}
              {isSubmitting && navigation.formData?.get("intent") === "complete"
                ? "Processing…"
                : "Complete Receiving"}
            </button>
          </div>
        </div>
      </Form>
    </main>
  );
}
