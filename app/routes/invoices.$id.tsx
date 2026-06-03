import { Link, Form, redirect, useFetcher, useSearchParams } from "react-router";
import { useState, useEffect, useRef } from "react";
import type { Route } from "./+types/invoices.$id";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";
import { logFailure } from "../services/failure-log.server";
import {
  updateInventoryItemSku,
  updateInventoryLevel,
  updateInventoryItemCost,
  getLocationId,
  updateVariantBarcode,
  createDraftProduct,
  getProductIdFromVariant,
} from "../services/shopify.server";
import type { ProductSearchResult } from "../services/shopify.server";
import type { InvoiceStatus } from "@prisma/client";

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
  const id = Number(params.id);
  const invoice = await getDb().invoice.findUnique({
    where: { id },
    include: { vendor: true, supplier: true, lineItems: true },
  });
  if (!invoice) throw new Response("Not Found", { status: 404 });
  return {
    invoice: {
      ...invoice,
      total: Number(invoice.total),
      shippingCost: invoice.shippingCost !== null ? Number(invoice.shippingCost) : null,
      adjustments: invoice.adjustments !== null ? Number(invoice.adjustments) : null,
      invoiceDate: invoice.invoiceDate ? invoice.invoiceDate.toISOString() : null,
      dueDate: invoice.dueDate ? invoice.dueDate.toISOString() : null,
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
      const cached = await db.productCache.findUnique({
        where: { variantId: lineItem.shopifyVariantId },
        select: { productId: true },
      });
      let productId = cached?.productId ?? null;
      if (!productId) {
        try {
          productId = await getProductIdFromVariant(lineItem.shopifyVariantId);
        } catch { /* ignore */ }
      }
      if (productId) {
        try {
          await updateVariantBarcode(productId, lineItem.shopifyVariantId, barcode);
        } catch (err) {
          await logFailure(
            "shopify:set-barcode",
            lineItem.sku || `lineItem:${lineItemId}`,
            `Barcode sync failed for variant ${lineItem.shopifyVariantId}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    return { success: true, intent: "updateBarcode" as const, lineItemId, barcode };
  }

  if (intent === "skipItem") {
    const lineItemId = Number(formData.get("lineItemId"));
    await getDb().invoiceLineItem.update({ where: { id: lineItemId }, data: { skipped: true } });
    return { ok: true, intent: "skipItem" as const, lineItemId };
  }

  if (intent === "createSkeletonProduct") {
    const lineItemId = Number(formData.get("lineItemId"));
    const db = getDb();

    const lineItem = await db.invoiceLineItem.findUnique({
      where: { id: lineItemId },
      select: { sku: true, description: true, unitCost: true, retailPrice: true, invoiceId: true },
    });
    if (!lineItem) return { ok: false, intent: "createSkeletonProduct" as const, lineItemId, error: "Line item not found" };

    const inv = await db.invoice.findUnique({
      where: { id: lineItem.invoiceId },
      select: { vendor: { select: { name: true } } },
    });

    try {
      const product = await createDraftProduct({
        title: lineItem.description,
        sku: lineItem.sku || undefined,
        vendor: inv?.vendor?.name ?? "",
        costPrice: Number(lineItem.unitCost),
        retailPrice: lineItem.retailPrice ? Number(lineItem.retailPrice) : undefined,
      });
      const variant = product.variants[0];
      if (variant) {
        await db.invoiceLineItem.update({
          where: { id: lineItemId },
          data: {
            shopifyVariantId: variant.id,
            shopifyInventoryItemId: variant.inventoryItemId,
            shopifyProductTitle: product.title,
          },
        });
      }
      return { ok: true, intent: "createSkeletonProduct" as const, lineItemId };
    } catch (err) {
      await logFailure(
        "shopify:create-product",
        lineItem.sku || lineItem.description,
        `Skeleton creation failed from invoice detail: ${err instanceof Error ? err.message : String(err)}`
      );
      return { ok: false, intent: "createSkeletonProduct" as const, lineItemId, error: "Product creation failed — check the failure log" };
    }
  }

  if (intent === "markSynced") {
    const lineItemId = Number(formData.get("lineItemId"));
    await getDb().invoiceLineItem.update({
      where: { id: lineItemId },
      data: { inventorySynced: true },
    });
    return { ok: true, intent: "markSynced" as const, lineItemId };
  }

  if (intent === "retryShopifySync") {
    const db = getDb();
    const invoice = await db.invoice.findUnique({
      where: { id },
      include: { lineItems: true },
    });
    if (!invoice || invoice.status !== "RECEIVED") {
      return { ok: false, intent: "retryShopifySync" as const, error: "Invoice is not in RECEIVED state" };
    }

    let barcodeCount = 0;
    let costCount = 0;
    let inventoryCount = 0;

    for (const item of invoice.lineItems) {
      if (item.shopifyVariantId && item.barcode) {
        const cached = await db.productCache.findUnique({
          where: { variantId: item.shopifyVariantId },
          select: { productId: true },
        });
        let productId = cached?.productId ?? null;
        if (!productId) {
          try {
            productId = await getProductIdFromVariant(item.shopifyVariantId);
          } catch { /* ignore */ }
        }
        if (productId) {
          try {
            await updateVariantBarcode(productId, item.shopifyVariantId, item.barcode);
            barcodeCount++;
          } catch (err) {
            await logFailure("BARCODE_SYNC", item.sku ?? item.description, err instanceof Error ? err.message : String(err));
          }
        }
      }

      if (item.shopifyInventoryItemId && Number(item.unitCost) > 0) {
        try {
          await updateInventoryItemCost(item.shopifyInventoryItemId, Number(item.unitCost));
          costCount++;
        } catch (err) {
          await logFailure("shopify:set-cost", item.sku ?? item.description, err instanceof Error ? err.message : String(err));
        }
      }
    }

    // Sync inventory for unsynced items only
    try {
      const locationId = await getLocationId();
      for (const item of invoice.lineItems) {
        if (item.shopifyInventoryItemId && item.quantityReceived > 0 && !item.inventorySynced) {
          try {
            await updateInventoryLevel({
              inventoryItemId: item.shopifyInventoryItemId,
              locationId,
              quantity: item.quantityReceived,
            });
            await db.invoiceLineItem.update({
              where: { id: item.id },
              data: { inventorySynced: true },
            });
            inventoryCount++;
          } catch (err) {
            await logFailure("INVENTORY_UPDATE", item.sku ?? item.description, err instanceof Error ? err.message : String(err));
          }
        }
      }
    } catch (err) {
      await logFailure("INVENTORY_UPDATE", `Invoice #${invoice.invoiceNumber}`, `Could not fetch location: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { ok: true, intent: "retryShopifySync" as const, barcodeCount, costCount, inventoryCount };
  }

  if (intent === "reverseInventory") {
    const db = getDb();
    const invoice = await db.invoice.findUnique({
      where: { id },
      include: { lineItems: true },
    });
    if (!invoice) throw new Response("Not Found", { status: 404 });

    let locationId: string;
    try {
      locationId = await getLocationId();
    } catch (err) {
      return { ok: false, intent: "reverseInventory" as const, error: "Could not fetch Shopify location ID" };
    }

    let reversedCount = 0;
    const errors: string[] = [];

    for (const item of invoice.lineItems) {
      if (!item.shopifyInventoryItemId) continue;
      const qtyStr = formData.get(`reverseQty_${item.id}`);
      const qty = qtyStr ? Number(qtyStr) : 0;
      if (!qty || qty <= 0) continue;
      try {
        await updateInventoryLevel({
          inventoryItemId: item.shopifyInventoryItemId,
          locationId,
          quantity: -qty,
          keySuffix: "-rev",
        });
        reversedCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(item.sku ?? item.description ?? String(item.id));
        await logFailure("INVENTORY_REVERSE", item.sku ?? item.description, msg);
      }
    }

    return { ok: true, intent: "reverseInventory" as const, reversedCount, errors };
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
  const [searchParams] = useSearchParams();

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

  // ── Retry Shopify sync ───────────────────────────────────────────────────
  const retrySyncFetcher = useFetcher<{ ok: boolean; intent: "retryShopifySync"; barcodeCount?: number; costCount?: number; inventoryCount?: number; error?: string }>();
  const isRetrying = retrySyncFetcher.state !== "idle";
  const retrySyncResult =
    retrySyncFetcher.state === "idle" && retrySyncFetcher.data?.intent === "retryShopifySync"
      ? retrySyncFetcher.data
      : null;

  // ── Reverse inventory panel ───────────────────────────────────────────────
  const reverseFetcher = useFetcher<{ ok: boolean; intent: "reverseInventory"; reversedCount?: number; errors?: string[]; error?: string }>();
  const isReversing = reverseFetcher.state !== "idle";
  const reverseResult =
    reverseFetcher.state === "idle" && reverseFetcher.data?.intent === "reverseInventory"
      ? reverseFetcher.data
      : null;
  const [showReversePanel, setShowReversePanel] = useState(false);
  const linkedItems = lineItems.filter((item) => item.shopifyInventoryItemId);
  const [reverseQtys, setReverseQtys] = useState<Record<number, string>>(() =>
    Object.fromEntries(
      linkedItems.map((item) => [item.id, String(item.quantityReceived ?? item.quantityOrdered)])
    )
  );

  function handleApplyReversals() {
    const fd = new FormData();
    fd.append("intent", "reverseInventory");
    for (const [itemId, qty] of Object.entries(reverseQtys)) {
      fd.append(`reverseQty_${itemId}`, qty);
    }
    reverseFetcher.submit(fd, { method: "post" });
  }

  // ── Mark as synced ────────────────────────────────────────────────────────
  const markSyncedFetcher = useFetcher<{ ok: boolean; intent: "markSynced"; lineItemId: number }>();
  const [localSynced, setLocalSynced] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (markSyncedFetcher.state === "idle" && markSyncedFetcher.data?.ok && markSyncedFetcher.data.intent === "markSynced") {
      setLocalSynced((prev) => new Set(prev).add(markSyncedFetcher.data!.lineItemId));
    }
  }, [markSyncedFetcher.state, markSyncedFetcher.data]);

  // ── Unlinked items management ─────────────────────────────────────────────
  const skipFetcher = useFetcher<{ ok: boolean; intent: "skipItem"; lineItemId: number }>();
  const createProductFetcher = useFetcher<{ ok: boolean; intent: "createSkeletonProduct"; lineItemId: number; error?: string }>();
  const linkFetcher = useFetcher<{ ok: boolean }>();
  const searchFetcher = useFetcher<ProductSearchResult[]>();

  const [openSearchItemId, setOpenSearchItemId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [linkingItemId, setLinkingItemId] = useState<number | null>(null);
  const [hiddenItemIds, setHiddenItemIds] = useState<Set<number>>(new Set());
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (skipFetcher.state === "idle" && skipFetcher.data?.ok && skipFetcher.data.intent === "skipItem") {
      setHiddenItemIds((prev) => new Set(prev).add(skipFetcher.data!.lineItemId));
    }
  }, [skipFetcher.state, skipFetcher.data]);

  useEffect(() => {
    if (createProductFetcher.state === "idle" && createProductFetcher.data?.ok && createProductFetcher.data.intent === "createSkeletonProduct") {
      setHiddenItemIds((prev) => new Set(prev).add(createProductFetcher.data!.lineItemId));
    }
  }, [createProductFetcher.state, createProductFetcher.data]);

  useEffect(() => {
    if (linkFetcher.state === "idle" && linkFetcher.data?.ok && linkingItemId !== null) {
      setHiddenItemIds((prev) => new Set(prev).add(linkingItemId));
      setLinkingItemId(null);
      setOpenSearchItemId(null);
      setSearchQuery("");
    }
  }, [linkFetcher.state, linkFetcher.data, linkingItemId]);

  function handleSelectVariant(itemId: number, variant: ProductSearchResult["variants"][0], productTitle: string) {
    setLinkingItemId(itemId);
    const fd = new FormData();
    fd.append("variantId", variant.id);
    fd.append("productTitle", productTitle);
    fd.append("inventoryItemId", variant.inventoryItemId);
    if (variant.barcode) fd.append("barcode", variant.barcode);
    linkFetcher.submit(fd, { method: "post", action: `/api/line-items/${itemId}/link` });
  }

  const unlinkedItems = lineItems.filter(
    (item) => !item.shopifyVariantId && !item.skipped && !hiddenItemIds.has(item.id)
  );

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

      {/* CSV import summary banner */}
      {searchParams.has("imported") && (() => {
        const imported = Number(searchParams.get("imported"));
        const skippedZero = Number(searchParams.get("skippedZero") ?? 0);
        const parts = [`${imported} imported`];
        if (skippedZero > 0) parts.push(`${skippedZero} skipped (zero quantity)`);
        return (
          <div className="mb-4 px-4 py-3 rounded-lg bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 text-sm text-blue-800 dark:text-blue-200">
            CSV import complete: {parts.join(", ")}.
          </div>
        );
      })()}

      {/* Header card */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-6 mb-6">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-6">
          {vendor && (
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Vendor</p>
            <p className="text-sm font-medium text-gray-800 dark:text-gray-100">{vendor.name}</p>
          </div>
          )}
          {invoice.supplier && (
            <div>
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Supplier</p>
              <p className="text-sm font-medium text-gray-800 dark:text-gray-100">{invoice.supplier.name}</p>
            </div>
          )}
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
          {(invoice.shippingCost !== null && invoice.shippingCost !== 0) && (
            <div>
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Shipping</p>
              <p className="text-sm text-gray-800 dark:text-gray-100">
                ${Number(invoice.shippingCost).toFixed(2)}
              </p>
            </div>
          )}
          {(invoice.adjustments !== null && invoice.adjustments !== 0) && (
            <div>
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Adjustments</p>
              <p className="text-sm text-gray-800 dark:text-gray-100">
                {Number(invoice.adjustments) >= 0 ? "+" : ""}${Number(invoice.adjustments).toFixed(2)}
              </p>
            </div>
          )}
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
        {invoice.status === "ORDERED" && (
          <Link
            to={`/invoices/${invoice.id}/edit`}
            className="text-sm font-medium px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            Edit Invoice
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
        {(invoice.status === "RECEIVED" || invoice.status === "PAID") && (
          <a
            href={`/invoices/${invoice.id}/receiving-summary`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-lg border border-indigo-200 dark:border-indigo-800 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Receiving Summary
          </a>
        )}
        {invoice.status === "RECEIVED" && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const fd = new FormData();
                fd.append("intent", "retryShopifySync");
                retrySyncFetcher.submit(fd, { method: "post" });
              }}
              disabled={isRetrying}
              className="flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
            >
              {isRetrying ? (
                <>
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Syncing…
                </>
              ) : "Retry Shopify Sync"}
            </button>
            {retrySyncResult?.ok && (
              <span className="text-xs text-green-600 dark:text-green-400">
                {retrySyncResult.inventoryCount} inventory, {retrySyncResult.barcodeCount} barcodes, {retrySyncResult.costCount} costs synced
              </span>
            )}
            {retrySyncResult?.ok === false && (
              <span className="text-xs text-red-500 dark:text-red-400">{retrySyncResult.error}</span>
            )}
          </div>
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
              <th className="text-center px-4 py-3 font-medium text-gray-600 dark:text-gray-400 w-20">Inv Sync</th>
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
                  <td className="px-4 py-4 text-center">
                    {(() => {
                      const isSynced = localSynced.has(item.id) || item.inventorySynced;
                      const isReceived = item.quantityReceived > 0;
                      const isLinked = !!item.shopifyInventoryItemId;
                      const isMarkingThis =
                        markSyncedFetcher.state !== "idle" &&
                        Number(markSyncedFetcher.formData?.get("lineItemId")) === item.id;

                      if (!isLinked) {
                        return <span className="text-gray-300 dark:text-gray-600 text-sm">—</span>;
                      }
                      if (isSynced) {
                        return <span className="text-green-500 text-base" title="Inventory synced to Shopify">✓</span>;
                      }
                      if (!isReceived) {
                        return <span className="text-gray-400 dark:text-gray-500 text-sm" title="Not yet received">—</span>;
                      }
                      return (
                        <div className="flex flex-col items-center gap-0.5">
                          <span className="text-red-500 text-base" title="Inventory not synced">✗</span>
                          <button
                            type="button"
                            onClick={() => {
                              const fd = new FormData();
                              fd.append("intent", "markSynced");
                              fd.append("lineItemId", String(item.id));
                              markSyncedFetcher.submit(fd, { method: "post" });
                            }}
                            disabled={isMarkingThis}
                            className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 underline underline-offset-1 disabled:opacity-50 leading-tight"
                            title="Mark as synced — inventory was updated manually in Shopify"
                          >
                            {isMarkingThis ? "…" : "Mark"}
                          </button>
                        </div>
                      );
                    })()}
                  </td>
                  <td className="px-6 py-4 text-right font-medium text-gray-800 dark:text-gray-100">
                    ${lineTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            {(() => {
              const subtotal = lineItems.reduce((s, i) => s + i.quantityOrdered * i.unitCost, 0);
              const shipping = invoice.shippingCost ?? 0;
              const adj = invoice.adjustments ?? 0;
              const showBreakdown = shipping !== 0 || adj !== 0;
              return (
                <>
                  {showBreakdown && (
                    <>
                      <tr className="border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
                        <td colSpan={6} className="px-6 py-2 text-sm text-gray-500 dark:text-gray-400 text-right">Subtotal</td>
                        <td className="px-6 py-2 text-right text-sm text-gray-600 dark:text-gray-300 tabular-nums">${subtotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      </tr>
                      {shipping !== 0 && (
                        <tr className="bg-gray-50 dark:bg-gray-800">
                          <td colSpan={6} className="px-6 py-2 text-sm text-gray-500 dark:text-gray-400 text-right">Shipping</td>
                          <td className="px-6 py-2 text-right text-sm text-gray-600 dark:text-gray-300 tabular-nums">+${shipping.toFixed(2)}</td>
                        </tr>
                      )}
                      {adj !== 0 && (
                        <tr className="bg-gray-50 dark:bg-gray-800">
                          <td colSpan={6} className="px-6 py-2 text-sm text-gray-500 dark:text-gray-400 text-right">Adjustments</td>
                          <td className="px-6 py-2 text-right text-sm text-gray-600 dark:text-gray-300 tabular-nums">{adj >= 0 ? "+" : ""}${adj.toFixed(2)}</td>
                        </tr>
                      )}
                    </>
                  )}
                  <tr className="border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
                    <td colSpan={6} className="px-6 py-3 text-sm font-medium text-gray-600 dark:text-gray-400 text-right">
                      Total
                    </td>
                    <td className="px-6 py-3 text-right font-semibold text-gray-800 dark:text-gray-100">
                      ${Number(invoice.total).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                  </tr>
                </>
              );
            })()}
          </tfoot>
        </table>
      </div>

      {/* Unlinked Items - Action Required */}
      {unlinkedItems.length > 0 && (
        <div className="mt-6 rounded-2xl border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/20 overflow-hidden">
          <div className="flex items-center gap-2 px-6 py-3 border-b border-amber-200 dark:border-amber-700 bg-amber-100/60 dark:bg-amber-900/20">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-400 text-white text-xs font-bold shrink-0">!</span>
            <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
              Unlinked Items — Action Required
              <span className="ml-1.5 font-normal text-amber-600 dark:text-amber-400">({unlinkedItems.length})</span>
            </h3>
          </div>

          <div className="divide-y divide-amber-100 dark:divide-amber-800/40">
            {unlinkedItems.map((item) => {
              const isCreating =
                createProductFetcher.state !== "idle" &&
                Number(createProductFetcher.formData?.get("lineItemId")) === item.id;
              const isSkipping =
                skipFetcher.state !== "idle" &&
                Number(skipFetcher.formData?.get("lineItemId")) === item.id;
              const isLinking = linkFetcher.state !== "idle" && linkingItemId === item.id;
              const createFailed =
                createProductFetcher.state === "idle" &&
                createProductFetcher.data?.ok === false &&
                createProductFetcher.data.lineItemId === item.id;

              return (
                <div key={item.id}>
                  <div className="flex items-center gap-4 px-6 py-3">
                    {/* Item info */}
                    <div className="flex-1 min-w-0 grid grid-cols-4 gap-3 text-sm">
                      <div>
                        <p className="text-xs font-medium text-amber-600 dark:text-amber-400 uppercase tracking-wide mb-0.5">SKU</p>
                        <p className="font-mono text-gray-700 dark:text-gray-200 truncate">{item.sku || <span className="italic text-gray-400">—</span>}</p>
                      </div>
                      <div className="col-span-2">
                        <p className="text-xs font-medium text-amber-600 dark:text-amber-400 uppercase tracking-wide mb-0.5">Description</p>
                        <p className="text-gray-700 dark:text-gray-200 truncate">{item.description}</p>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-amber-600 dark:text-amber-400 uppercase tracking-wide mb-0.5">Qty / Cost</p>
                        <p className="text-gray-700 dark:text-gray-200">{item.quantityOrdered} × ${Number(item.unitCost).toFixed(2)}</p>
                      </div>
                    </div>

                    {/* Action buttons */}
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          if (openSearchItemId === item.id) {
                            setOpenSearchItemId(null);
                            setSearchQuery("");
                          } else {
                            setOpenSearchItemId(item.id);
                            setSearchQuery(item.sku || item.description.split(" ").slice(0, 3).join(" "));
                          }
                        }}
                        disabled={isLinking}
                        className="text-xs font-medium px-3 py-1.5 rounded-lg border border-indigo-300 dark:border-indigo-700 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 transition-colors disabled:opacity-50"
                      >
                        {isLinking ? "Linking…" : openSearchItemId === item.id ? "Close Search" : "Search Shopify"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const fd = new FormData();
                          fd.append("intent", "createSkeletonProduct");
                          fd.append("lineItemId", String(item.id));
                          createProductFetcher.submit(fd, { method: "post" });
                        }}
                        disabled={isCreating}
                        className="text-xs font-medium px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
                      >
                        {isCreating ? "Creating…" : "Create Product"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const fd = new FormData();
                          fd.append("intent", "skipItem");
                          fd.append("lineItemId", String(item.id));
                          skipFetcher.submit(fd, { method: "post" });
                        }}
                        disabled={isSkipping}
                        className="text-xs font-medium px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
                      >
                        {isSkipping ? "Skipping…" : "Skip"}
                      </button>
                    </div>
                  </div>

                  {/* Create product error */}
                  {createFailed && (
                    <p className="px-6 pb-2 text-xs text-red-600 dark:text-red-400">
                      {createProductFetcher.data?.error ?? "Product creation failed — check the failure log"}
                    </p>
                  )}

                  {/* Inline Shopify search */}
                  {openSearchItemId === item.id && (
                    <div className="px-6 pb-4">
                      <div className="relative">
                        <input
                          autoFocus
                          type="text"
                          value={searchQuery}
                          onChange={(e) => {
                            const q = e.target.value;
                            setSearchQuery(q);
                            if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
                            if (q.length >= 2) {
                              searchDebounceRef.current = setTimeout(() => {
                                searchFetcher.load(`/api/shopify/products?q=${encodeURIComponent(q)}`);
                              }, 300);
                            }
                          }}
                          placeholder="Search by name or SKU…"
                          className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                        />
                        {searchFetcher.state === "loading" && (
                          <span className="absolute right-3 top-2 text-xs text-gray-400 pointer-events-none">Searching…</span>
                        )}
                      </div>
                      {searchFetcher.data !== undefined && searchQuery.length >= 2 && (
                        <div className="mt-1 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden shadow-sm bg-white dark:bg-gray-900">
                          {searchFetcher.data.length === 0 ? (
                            <p className="px-3 py-2 text-xs text-gray-400">No results found</p>
                          ) : (
                            <div className="max-h-52 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700">
                              {searchFetcher.data.flatMap((product) =>
                                product.variants.map((variant) => (
                                  <button
                                    key={variant.id}
                                    type="button"
                                    onClick={() => handleSelectVariant(item.id, variant, product.title)}
                                    className="w-full text-left px-3 py-2 text-xs hover:bg-indigo-50 dark:hover:bg-indigo-950/30 transition-colors"
                                  >
                                    <span className="font-medium text-gray-800 dark:text-gray-100">{product.title}</span>
                                    {variant.title !== "Default Title" && (
                                      <span className="text-gray-500 dark:text-gray-400 ml-1">— {variant.title}</span>
                                    )}
                                    {variant.sku && (
                                      <span className="font-mono text-gray-400 dark:text-gray-500 ml-1.5">({variant.sku})</span>
                                    )}
                                  </button>
                                ))
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {/* Reverse Inventory Adjustment */}
      {invoice.status === "RECEIVED" && linkedItems.length > 0 && (
        <div className="mt-6">
          <button
            type="button"
            onClick={() => setShowReversePanel((v) => !v)}
            className="flex items-center gap-2 text-sm font-medium text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path fillRule="evenodd" d="M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
            </svg>
            {showReversePanel ? "Hide" : "Reverse Inventory Adjustment"}
          </button>

          {showReversePanel && (
            <div className="mt-3 rounded-2xl border border-red-200 dark:border-red-800 bg-white dark:bg-gray-900 overflow-hidden shadow-sm">
              <div className="px-6 py-4 border-b border-red-200 dark:border-red-700 bg-red-50 dark:bg-red-950/20">
                <p className="text-sm font-semibold text-red-800 dark:text-red-200 mb-1">Reverse Inventory Adjustment</p>
                <p className="text-xs text-red-700 dark:text-red-300">
                  Subtracts the specified quantity from Shopify inventory for each item. Set quantity to 0 to skip an item.
                  Each reversal is idempotent — re-applying the same quantities will not double-subtract.
                </p>
              </div>

              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                    <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">SKU</th>
                    <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Description</th>
                    <th className="text-right px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Qty Received</th>
                    <th className="text-right px-6 py-3 font-medium text-gray-600 dark:text-gray-400 w-36">Qty to Reverse</th>
                  </tr>
                </thead>
                <tbody>
                  {linkedItems.map((item, i) => (
                    <tr key={item.id} className={i < linkedItems.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : ""}>
                      <td className="px-6 py-3 font-mono text-gray-700 dark:text-gray-200">{item.sku || <span className="italic text-gray-400">—</span>}</td>
                      <td className="px-6 py-3 text-gray-600 dark:text-gray-300">{item.description}</td>
                      <td className="px-6 py-3 text-right text-gray-700 dark:text-gray-200 tabular-nums">
                        {item.quantityReceived ?? item.quantityOrdered}
                      </td>
                      <td className="px-6 py-3 text-right">
                        <input
                          type="number"
                          min="0"
                          value={reverseQtys[item.id] ?? "0"}
                          onChange={(e) =>
                            setReverseQtys((prev) => ({ ...prev, [item.id]: e.target.value }))
                          }
                          className="w-24 text-right border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-300 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex items-center gap-4">
                <button
                  type="button"
                  onClick={handleApplyReversals}
                  disabled={isReversing}
                  className="flex items-center gap-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
                >
                  {isReversing ? (
                    <>
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Applying…
                    </>
                  ) : "Apply Reversals"}
                </button>
                {reverseResult?.ok && (
                  <span className="text-sm text-green-600 dark:text-green-400 font-medium">
                    {reverseResult.reversedCount} item{reverseResult.reversedCount !== 1 ? "s" : ""} reversed
                    {reverseResult.errors && reverseResult.errors.length > 0 && (
                      <span className="text-red-500 dark:text-red-400 ml-2">
                        ({reverseResult.errors.length} failed: {reverseResult.errors.join(", ")})
                      </span>
                    )}
                  </span>
                )}
                {reverseResult?.ok === false && (
                  <span className="text-sm text-red-500 dark:text-red-400">{reverseResult.error}</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
