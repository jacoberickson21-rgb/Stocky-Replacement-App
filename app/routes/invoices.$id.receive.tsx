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
  getLocationId,
  updateInventoryLevel,
} from "../services/shopify.server";
import type { ProductSearchResult } from "../services/shopify.server";
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
  if (invoice.status !== "ORDERED") return redirect(`/invoices/${id}`);

  // Auto-match unlinked items against Shopify by exact SKU
  const unlinked = invoice.lineItems.filter((item) => !item.shopifyVariantId);
  if (unlinked.length > 0) {
    const matchResults = await Promise.allSettled(
      unlinked.map((item) => lookupProduct({ sku: item.sku ?? undefined }))
    );
    for (let i = 0; i < unlinked.length; i++) {
      const result = matchResults[i];
      if (result.status === "fulfilled" && result.value) {
        const product = result.value;
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

  return {
    invoice: {
      ...invoice,
      total: Number(invoice.total),
      lineItems: invoice.lineItems.map((item) => ({
        ...item,
        unitCost: Number(item.unitCost),
      })),
    },
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
  if (!invoice || invoice.status !== "ORDERED") {
    throw new Response("Conflict", { status: 409 });
  }

  const formData = await request.formData();

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
        }
        return db.invoiceLineItem.update({
          where: { id: item.id },
          data: {
            quantityReceived: received,
            hasDiscrepancy,
            receivingNote: note || null,
          },
        });
      }),
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

  // Shopify inventory update — best-effort after DB commit
  let locationId: string | null = null;
  try {
    locationId = await getLocationId();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    for (const item of invoice.lineItems.filter(
      (i) => i.shopifyInventoryItemId
    )) {
      await logFailure(
        "INVENTORY_UPDATE",
        item.sku ?? item.description,
        `Could not fetch Shopify location: ${msg}`
      );
    }
  }

  if (locationId) {
    for (const item of invoice.lineItems) {
      const received = Number(formData.get(`qty_${item.id}`));
      if (item.shopifyInventoryItemId) {
        try {
          await updateInventoryLevel({
            inventoryItemId: item.shopifyInventoryItemId,
            locationId,
            quantity: received,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await logFailure("INVENTORY_UPDATE", item.sku ?? item.description, msg);
        }
      } else {
        await logFailure(
          "INVENTORY_UPDATE",
          item.sku ?? item.description,
          "No Shopify product linked — inventory update skipped"
        );
      }
    }
  }

  return redirect(`/invoices/${id}`);
}

// ─── Types ────────────────────────────────────────────────────────────────────

type LineItem = {
  id: number;
  sku: string | null;
  description: string;
  quantityOrdered: number;
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
    <div>
      <span className="font-mono text-gray-700 dark:text-gray-300">{item.sku}</span>

      {linked.title ? (
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" />
          <span className="text-xs text-green-700 dark:text-green-400 leading-tight">
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
  RECEIVED: "bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300",
  PAID: "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300",
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ReceivingPage({ loaderData }: Route.ComponentProps) {
  const { invoice } = loaderData;
  const { vendor, lineItems } = invoice;
  const navigation = useNavigation();
  const actionData = useActionData() as { error?: string } | undefined;
  const isSubmitting = navigation.state === "submitting";

  const [quantities, setQuantities] = useState<Record<number, string>>(() =>
    Object.fromEntries(
      lineItems.map((item) => [item.id, String(item.quantityOrdered)])
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
            <p className="text-sm font-medium text-gray-800 dark:text-gray-100">{vendor.name}</p>
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
              Ordered
            </span>
          </div>
        </div>
      </div>

      {/* Receiving form */}
      <Form method="post">
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-visible mb-6">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">
                  SKU / Product
                </th>
                <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">
                  Description
                </th>
                <th className="text-right px-6 py-3 font-medium text-gray-600 dark:text-gray-400">
                  Expected
                </th>
                <th className="text-right px-6 py-3 font-medium text-gray-600 dark:text-gray-400 w-36">
                  Received
                </th>
                <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">
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
                    <td className="px-6 py-4 text-right text-gray-700 dark:text-gray-300 tabular-nums align-top">
                      {item.quantityOrdered}
                    </td>
                    <td className="px-6 py-4 text-right align-top">
                      <input
                        type="number"
                        name={`qty_${item.id}`}
                        min="0"
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
                            : "border-gray-300 dark:border-gray-600 focus:ring-indigo-300 bg-white dark:bg-gray-800",
                        ].join(" ")}
                        placeholder="0"
                      />
                    </td>
                    <td className="px-6 py-4 align-top">
                      <input
                        type="text"
                        name={`note_${item.id}`}
                        placeholder="Optional note"
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
              ? "All quantity fields are required."
              : ""}
          </p>
          <button
            type="submit"
            disabled={!allFilled || isSubmitting}
            className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-5 py-2.5 transition-colors"
          >
            {isSubmitting ? "Saving…" : "Complete Receiving"}
          </button>
        </div>
      </Form>
    </main>
  );
}
