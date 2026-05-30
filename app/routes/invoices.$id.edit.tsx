import { redirect, data } from "react-router";
import { Link, Form, useNavigation, useFetcher } from "react-router";
import { useState, useEffect, useRef } from "react";
import type { Route } from "./+types/invoices.$id.edit";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";
import type { ProductSearchResult } from "../services/shopify.server";
import { logFailure } from "../services/failure-log.server";
import { createDraftProduct, createDraftProductWithVariants, updateInventoryItemCost, updateVariantPrice } from "../services/shopify.server";
import type { DraftProductVariantInput } from "../services/shopify.server";

// ── Loader ────────────────────────────────────────────────────────────────────

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
  const id = Number(params.id);
  const db = getDb();
  const [invoice, vendors, suppliers] = await Promise.all([
    db.invoice.findUnique({
      where: { id },
      include: { vendor: true, lineItems: { orderBy: { id: "asc" } } },
    }),
    db.vendor.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, shopifyVendorName: true, supplierId: true } }),
    db.supplier.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);

  if (!invoice) throw new Response("Not Found", { status: 404 });
  if (invoice.status !== "ORDERED") return redirect(`/invoices/${id}`);

  return {
    invoice: {
      ...invoice,
      total: Number(invoice.total),
      shippingCost: invoice.shippingCost !== null ? Number(invoice.shippingCost) : null,
      adjustments: invoice.adjustments !== null ? Number(invoice.adjustments) : null,
      invoiceDate: invoice.invoiceDate ? invoice.invoiceDate.toISOString().slice(0, 10) : null,
      dueDate: invoice.dueDate ? invoice.dueDate.toISOString().slice(0, 10) : null,
      lineItems: invoice.lineItems.map((item) => ({
        ...item,
        unitCost: Number(item.unitCost),
        retailPrice: item.retailPrice !== null ? Number(item.retailPrice) : null,
      })),
    },
    vendors,
    suppliers,
  };
}

// ── Action ────────────────────────────────────────────────────────────────────

export async function action({ request, params }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const id = Number(params.id);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "updateInvoice") {
    const vendorId = Number(String(form.get("vendorId") ?? "").trim());
    const supplierIdRaw = String(form.get("supplierId") ?? "").trim();
    const invoiceNumber = String(form.get("invoiceNumber") ?? "").trim();
    const invoiceDateRaw = String(form.get("invoiceDate") ?? "").trim();
    const paymentTermsRaw = String(form.get("paymentTerms") ?? "").trim();
    const dueDateRaw = String(form.get("dueDate") ?? "").trim();
    const shippingCostRaw = String(form.get("shippingCost") ?? "0");
    const adjustmentsRaw = String(form.get("adjustments") ?? "0");
    const lineItemsRaw = String(form.get("lineItems") ?? "[]");

    type EditLineItem = {
      dbId: number | null;
      sku: string;
      description: string;
      quantity: number;
      unitCost: number;
      retailPrice: number | null;
      shopifyPrice: number | null;
      variantId: string | null;
      inventoryItemId: string | null;
      updateShopifyCost: boolean;
      productGroupKey: string | null;
      variantOptions: { name: string; value: string }[] | null;
      productTitle: string | null;
      variantTitle: string | null;
      barcode: string;
    };

    let lineItems: EditLineItem[] = [];
    try {
      const parsed = JSON.parse(lineItemsRaw);
      if (Array.isArray(parsed)) lineItems = parsed;
    } catch {
      return data({ error: "Invalid line items." }, { status: 400 });
    }

    if (!invoiceNumber || !vendorId || lineItems.length === 0) {
      return data({ error: "Vendor, invoice number, and at least one line item are required." }, { status: 400 });
    }

    const shippingCostVal = parseFloat(shippingCostRaw) || 0;
    const adjustmentsVal = parseFloat(adjustmentsRaw) || 0;
    const subtotal = lineItems.reduce((sum, i) => sum + i.quantity * i.unitCost, 0);
    const total = subtotal + shippingCostVal + adjustmentsVal;
    const invoiceDate = invoiceDateRaw ? new Date(invoiceDateRaw) : null;
    const paymentTerms = paymentTermsRaw || null;
    const dueDate = dueDateRaw ? new Date(dueDateRaw) : null;
    const supplierId = supplierIdRaw ? Number(supplierIdRaw) : null;

    const db = getDb();

    // Determine which existing line item IDs to keep
    const keptDbIds = new Set(lineItems.filter((i) => i.dbId !== null).map((i) => i.dbId as number));

    await db.$transaction(async (tx) => {
      // Update invoice header
      await tx.invoice.update({
        where: { id },
        data: {
          vendorId,
          supplierId,
          invoiceNumber,
          invoiceDate,
          paymentTerms,
          dueDate,
          total,
          shippingCost: shippingCostVal || null,
          adjustments: adjustmentsVal || null,
        },
      });

      // Delete removed line items
      const existingItems = await tx.invoiceLineItem.findMany({ where: { invoiceId: id }, select: { id: true } });
      const toDelete = existingItems.filter((e) => !keptDbIds.has(e.id)).map((e) => e.id);
      if (toDelete.length > 0) {
        await tx.invoiceLineItem.deleteMany({ where: { id: { in: toDelete } } });
      }

      // Update existing, create new
      for (const item of lineItems) {
        if (item.dbId !== null) {
          await tx.invoiceLineItem.update({
            where: { id: item.dbId },
            data: {
              quantityOrdered: item.quantity,
              unitCost: item.unitCost,
              retailPrice: item.retailPrice ?? null,
              sku: item.sku || null,
              barcode: item.barcode || null,
            },
          });
        } else {
          await tx.invoiceLineItem.create({
            data: {
              invoiceId: id,
              vendorId,
              sku: item.sku || null,
              description: item.description,
              quantityOrdered: item.quantity,
              unitCost: item.unitCost,
              retailPrice: item.retailPrice ?? null,
              barcode: item.barcode || null,
              shopifyProductTitle: item.variantTitle || (item.variantId ? item.description : null),
              shopifyVariantId: item.variantId ?? null,
              shopifyInventoryItemId: item.inventoryItemId ?? null,
            },
          });
        }
      }

      await tx.auditLog.create({
        data: { userId, action: "INVOICE_UPDATED", details: `Invoice #${invoiceNumber} updated`, vendorId },
      });
    });

    // Update Shopify costs for items that opted in
    for (const item of lineItems) {
      if (item.updateShopifyCost && item.inventoryItemId) {
        try {
          await updateInventoryItemCost(item.inventoryItemId, item.unitCost);
        } catch (err) {
          await logFailure(
            "shopify:set-cost",
            item.sku || item.description,
            `Cost update failed for inventoryItem ${item.inventoryItemId}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    // Push updated retail prices to Shopify where price differs from original
    const priceUpdateVariantIds = lineItems
      .filter((i) => i.variantId && i.retailPrice != null && i.shopifyPrice != null && i.retailPrice !== i.shopifyPrice)
      .map((i) => i.variantId!);
    const priceUpdateCacheEntries = priceUpdateVariantIds.length
      ? await db.productCache.findMany({
          where: { variantId: { in: priceUpdateVariantIds } },
          select: { variantId: true, productId: true },
        })
      : [];
    const productIdByVariantId = new Map(priceUpdateCacheEntries.map((e) => [e.variantId, e.productId]));
    for (const item of lineItems) {
      if (
        item.variantId &&
        item.retailPrice != null &&
        item.shopifyPrice != null &&
        item.retailPrice !== item.shopifyPrice
      ) {
        try {
          await updateVariantPrice(productIdByVariantId.get(item.variantId) ?? "", item.variantId, item.retailPrice.toFixed(2), null);
        } catch (err) {
          await logFailure(
            "shopify:set-price",
            item.sku || item.description,
            `Price update failed for variant ${item.variantId}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    // Create skeleton Shopify products for new unlinked items
    const newUnlinked = lineItems.filter((i) => i.dbId === null && !i.variantId);
    if (newUnlinked.length > 0) {
      const vendorRecord = await db.vendor.findUnique({ where: { id: vendorId }, select: { name: true } });
      const vendorName = vendorRecord?.name ?? "";

      const groups = new Map<string, EditLineItem[]>();
      for (const item of newUnlinked) {
        const key = item.productGroupKey ?? `__solo__${item.description}`;
        const g = groups.get(key) ?? [];
        g.push(item);
        groups.set(key, g);
      }

      for (const [, groupItems] of groups) {
        const isSingle = groupItems.length === 1 && !groupItems[0].productGroupKey;
        const savedItems = await db.invoiceLineItem.findMany({
          where: { invoiceId: id, description: { in: groupItems.map((i) => i.description) }, shopifyVariantId: null },
          select: { id: true, unitCost: true, retailPrice: true, description: true },
        });

        if (isSingle) {
          const item = groupItems[0];
          const saved = savedItems.find((s) => s.description === item.description);
          if (!saved) continue;
          try {
            const product = await createDraftProduct({
              title: item.description,
              sku: item.sku || undefined,
              vendor: vendorName,
              costPrice: saved.unitCost.toNumber(),
              retailPrice: saved.retailPrice ? saved.retailPrice.toNumber() : undefined,
            });
            const variant = product.variants[0];
            if (variant) {
              await db.invoiceLineItem.update({
                where: { id: saved.id },
                data: { shopifyVariantId: variant.id, shopifyInventoryItemId: variant.inventoryItemId, shopifyProductTitle: product.title },
              });
            }
          } catch (err) {
            await logFailure("shopify:create-product", item.sku || item.description, `Skeleton product creation failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          const productTitle = groupItems[0].productTitle ?? groupItems[0].description;
          const optionNames = [...new Set(groupItems.flatMap((i) => (i.variantOptions ?? []).map((o) => o.name)))];
          const options = optionNames.map((name) => ({
            name,
            values: [...new Set(groupItems.flatMap((i) => (i.variantOptions ?? []).filter((o) => o.name === name).map((o) => o.value)))],
          }));
          const variantInputs: DraftProductVariantInput[] = groupItems.map((item) => {
            const saved = savedItems.find((s) => s.description === item.description);
            return {
              sku: item.sku || undefined,
              optionValues: item.variantOptions ?? [],
              price: saved?.retailPrice ? saved.retailPrice.toNumber() : (item.retailPrice ?? 0),
              costPrice: saved?.unitCost.toNumber() ?? item.unitCost,
            };
          });
          try {
            const product = await createDraftProductWithVariants({ title: productTitle, vendor: vendorName, options, variants: variantInputs });
            for (let vi = 0; vi < product.variants.length; vi++) {
              const shopifyVariant = product.variants[vi];
              const entry = shopifyVariant.sku
                ? groupItems.find((i) => i.sku === shopifyVariant.sku)
                : groupItems[vi];
              if (entry) {
                const saved = savedItems.find((s) => s.description === entry.description);
                if (saved) {
                  await db.invoiceLineItem.update({
                    where: { id: saved.id },
                    data: { shopifyVariantId: shopifyVariant.id, shopifyInventoryItemId: shopifyVariant.inventoryItemId, shopifyProductTitle: product.title },
                  });
                }
              }
            }
          } catch (err) {
            await logFailure("shopify:create-product", productTitle, `Skeleton multi-variant product creation failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }

    return redirect(`/invoices/${id}`);
  }

  return redirect(`/invoices/${id}`);
}

// ── Component helpers ─────────────────────────────────────────────────────────

const PAYMENT_TERMS_LABELS: Record<string, string> = {
  NET30: "Net 30",
  NET60: "Net 60",
  NET90: "Net 90",
  DUE_ON_RECEIPT: "Due on Receipt",
  CUSTOM: "Custom",
};

function PaymentTermsFields({
  initialInvoiceDate = "",
  initialPaymentTerms = "",
  initialDueDate = "",
  onInvoiceDateChange,
  onPaymentTermsChange,
  onDueDateChange,
}: {
  initialInvoiceDate?: string;
  initialPaymentTerms?: string;
  initialDueDate?: string;
  onInvoiceDateChange?: (v: string) => void;
  onPaymentTermsChange?: (v: string) => void;
  onDueDateChange?: (v: string) => void;
}) {
  const [invoiceDate, setInvoiceDate] = useState(initialInvoiceDate);
  const [paymentTerms, setPaymentTerms] = useState(initialPaymentTerms);
  const [dueDate, setDueDate] = useState(initialDueDate);

  useEffect(() => {
    if (!paymentTerms || paymentTerms === "CUSTOM") return;
    if (paymentTerms === "DUE_ON_RECEIPT") {
      const t = new Date();
      const computed = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
      setDueDate(computed);
      return;
    }
    if (!invoiceDate) { setDueDate(""); return; }
    const days = paymentTerms === "NET30" ? 30 : paymentTerms === "NET60" ? 60 : 90;
    const [y, m, d] = invoiceDate.split("-").map(Number);
    const result = new Date(y, m - 1, d + days);
    setDueDate(`${result.getFullYear()}-${String(result.getMonth() + 1).padStart(2, "0")}-${String(result.getDate()).padStart(2, "0")}`);
  }, [paymentTerms, invoiceDate]);

  useEffect(() => { onInvoiceDateChange?.(invoiceDate); }, [invoiceDate]);
  useEffect(() => { onPaymentTermsChange?.(paymentTerms); }, [paymentTerms]);
  useEffect(() => { onDueDateChange?.(dueDate); }, [dueDate]);

  const isAutoDate = ["NET30", "NET60", "NET90", "DUE_ON_RECEIPT"].includes(paymentTerms);

  return (
    <>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Invoice Date</label>
        <input
          name="invoiceDate"
          type="date"
          value={invoiceDate}
          onChange={(e) => setInvoiceDate(e.target.value)}
          className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Payment Terms</label>
        <select
          name="paymentTerms"
          value={paymentTerms}
          onChange={(e) => setPaymentTerms(e.target.value)}
          className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100"
        >
          <option value="">— None —</option>
          <option value="NET30">Net 30</option>
          <option value="NET60">Net 60</option>
          <option value="NET90">Net 90</option>
          <option value="DUE_ON_RECEIPT">Due on Receipt</option>
          <option value="CUSTOM">Custom</option>
        </select>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Due Date</label>
        <input
          name="dueDate"
          type="date"
          value={dueDate}
          onChange={(e) => { if (!isAutoDate) setDueDate(e.target.value); }}
          readOnly={isAutoDate}
          className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
            isAutoDate
              ? "bg-gray-50 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-default border-gray-200 dark:border-gray-600"
              : "border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
          }`}
        />
      </div>
    </>
  );
}

function BarcodeIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="2" y="4" width="3" height="16" rx="0.5" />
      <rect x="7" y="4" width="1.5" height="16" rx="0.5" />
      <rect x="10.5" y="4" width="3" height="16" rx="0.5" />
      <rect x="15.5" y="4" width="1.5" height="16" rx="0.5" />
      <rect x="19" y="4" width="3" height="16" rx="0.5" />
    </svg>
  );
}

function BarcodeInput({
  value,
  onChange,
  placeholder = "Scan or type…",
  inputClassName = "",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  inputClassName?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <BarcodeIcon className="w-3.5 h-3.5 text-gray-400 shrink-0" />
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={inputClassName}
      />
    </div>
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Vendor = { id: number; name: string; shopifyVendorName: string | null; supplierId: number | null };
type Supplier = { id: number; name: string };

type LineItemRow = {
  key: string;
  dbId: number | null;
  sku: string;
  description: string;
  quantity: number;
  unitCost: number;
  retailPrice: number | null;
  shopifyPrice: number | null;
  shopifyCost: number | null;
  updateShopifyCost: boolean;
  variantId: string | null;
  inventoryItemId: string | null;
  productGroupKey: string | null;
  variantOptions: { name: string; value: string }[] | null;
  productTitle: string | null;
  variantTitle: string | null;
  barcode: string;
};

// ── Page component ────────────────────────────────────────────────────────────

export default function InvoiceEditPage({ loaderData }: Route.ComponentProps) {
  const { invoice, vendors, suppliers } = loaderData as { invoice: typeof loaderData.invoice; vendors: Vendor[]; suppliers: Supplier[] };
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const keyCounter = useRef(invoice.lineItems.length);

  // Pre-populate from existing invoice
  const [lineItems, setLineItems] = useState<LineItemRow[]>(() =>
    invoice.lineItems.map((item, i) => ({
      key: String(i),
      dbId: item.id,
      sku: item.sku ?? "",
      description: item.description,
      quantity: item.quantityOrdered,
      unitCost: item.unitCost,
      retailPrice: item.retailPrice,
      shopifyPrice: item.retailPrice,
      shopifyCost: null,
      updateShopifyCost: false,
      variantId: item.shopifyVariantId,
      inventoryItemId: item.shopifyInventoryItemId,
      productGroupKey: null,
      variantOptions: null,
      productTitle: null,
      variantTitle: item.shopifyProductTitle,
      barcode: item.barcode ?? "",
    }))
  );

  const [selectedVendorId, setSelectedVendorId] = useState(String(invoice.vendorId));
  const [selectedSupplierId, setSelectedSupplierId] = useState(invoice.supplierId ? String(invoice.supplierId) : "");
  const [invoiceNumber, setInvoiceNumber] = useState(invoice.invoiceNumber);
  const [invoiceDate, setInvoiceDate] = useState(invoice.invoiceDate ?? "");
  const [paymentTerms, setPaymentTerms] = useState(invoice.paymentTerms ?? "");
  const [dueDate, setDueDate] = useState(invoice.dueDate ?? "");
  const [shippingCost, setShippingCost] = useState(invoice.shippingCost != null ? String(invoice.shippingCost) : "0");
  const [adjustments, setAdjustments] = useState(invoice.adjustments != null ? String(invoice.adjustments) : "0");
  const [ptfKey] = useState(0);

  const filteredVendors = selectedSupplierId
    ? vendors.filter((v) => v.supplierId === Number(selectedSupplierId))
    : vendors;

  const shopifyVendorNames = [...new Set(
    vendors.map((v) => v.shopifyVendorName).filter((n): n is string => !!n)
  )].sort();

  // Shopify product search
  const searchFetcher = useFetcher<ProductSearchResult[]>();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchVendorFilter, setSearchVendorFilter] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const searchResults: ProductSearchResult[] = Array.isArray(searchFetcher.data) ? searchFetcher.data : [];
  const isSearching = searchFetcher.state === "loading";

  useEffect(() => {
    if (searchQuery.length < 2) { setShowDropdown(false); return; }
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: searchQuery });
      if (searchVendorFilter) params.set("vendorName", searchVendorFilter);
      searchFetcher.load(`/api/shopify/products?${params.toString()}`);
      setShowDropdown(true);
    }, 250);
    return () => clearTimeout(timer);
  }, [searchQuery, searchVendorFilter]);

  // Group search results by product
  type GroupedResult = { productId: string; productTitle: string; variants: ProductSearchResult[] };
  const groupedResults: GroupedResult[] = [];
  const seenProducts = new Map<string, GroupedResult>();
  for (const r of searchResults) {
    let g = seenProducts.get(r.productId);
    if (!g) {
      g = { productId: r.productId, productTitle: r.productTitle, variants: [] };
      seenProducts.set(r.productId, g);
      groupedResults.push(g);
    }
    g.variants.push(r);
  }

  function addShopifyItem(result: ProductSearchResult) {
    setLineItems((prev) => [
      ...prev,
      {
        key: String(++keyCounter.current),
        dbId: null,
        sku: result.sku,
        description: result.productTitle,
        quantity: 1,
        unitCost: result.unitCost ?? 0,
        retailPrice: result.price ?? null,
        shopifyPrice: result.price ?? null,
        shopifyCost: result.unitCost,
        updateShopifyCost: false,
        variantId: result.variantId,
        inventoryItemId: result.inventoryItemId,
        productGroupKey: null,
        variantOptions: null,
        productTitle: null,
        variantTitle: result.variantTitle !== "Default Title" ? result.variantTitle : null,
        barcode: result.barcode ?? "",
      },
    ]);
    setSearchQuery("");
    setShowDropdown(false);
  }

  function toggleSelection(variantId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(variantId)) next.delete(variantId);
      else next.add(variantId);
      return next;
    });
  }

  function addSelected() {
    const toAdd = searchResults.filter((r) => selectedIds.has(r.variantId));
    if (toAdd.length === 0) return;
    setLineItems((prev) => [
      ...prev,
      ...toAdd.map((result) => ({
        key: String(++keyCounter.current),
        dbId: null as number | null,
        sku: result.sku,
        description: result.productTitle,
        quantity: 1,
        unitCost: result.unitCost ?? 0,
        retailPrice: result.price ?? null,
        shopifyPrice: result.price ?? null,
        shopifyCost: result.unitCost,
        updateShopifyCost: false,
        variantId: result.variantId,
        inventoryItemId: result.inventoryItemId,
        productGroupKey: null as string | null,
        variantOptions: null as { name: string; value: string }[] | null,
        productTitle: null as string | null,
        variantTitle: result.variantTitle !== "Default Title" ? result.variantTitle : null,
        barcode: result.barcode ?? "",
      })),
    ]);
    setSelectedIds(new Set());
    setSearchQuery("");
    setShowDropdown(false);
  }

  function removeItem(key: string) {
    setLineItems((prev) => prev.filter((item) => item.key !== key));
  }

  function updateItem(key: string, field: "quantity" | "unitCost", value: number) {
    setLineItems((prev) => prev.map((item) => (item.key === key ? { ...item, [field]: value } : item)));
  }

  function updateItemSku(key: string, value: string) {
    setLineItems((prev) => prev.map((item) => (item.key === key ? { ...item, sku: value } : item)));
  }

  function updateItemRetailPrice(key: string, value: number | null) {
    setLineItems((prev) => prev.map((item) => (item.key === key ? { ...item, retailPrice: value } : item)));
  }

  function updateItemBarcode(key: string, value: string) {
    setLineItems((prev) => prev.map((item) => (item.key === key ? { ...item, barcode: value } : item)));
  }

  function toggleUpdateShopifyCost(key: string) {
    setLineItems((prev) =>
      prev.map((item) => (item.key === key ? { ...item, updateShopifyCost: !item.updateShopifyCost } : item))
    );
  }

  const subtotal = lineItems.reduce((s, i) => s + i.quantity * i.unitCost, 0);
  const shippingVal = parseFloat(shippingCost) || 0;
  const adjustmentsVal = parseFloat(adjustments) || 0;
  const grandTotal = subtotal + shippingVal + adjustmentsVal;
  const showBreakdown = shippingVal !== 0 || adjustmentsVal !== 0;

  return (
    <main className="p-8 max-w-5xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link
          to={`/invoices/${invoice.id}`}
          className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100 transition-colors"
        >
          ← {invoice.invoiceNumber}
        </Link>
        <span className="text-gray-300 dark:text-gray-600">/</span>
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Edit Invoice</h2>
      </div>

      <Form method="post" className="space-y-6">
        <input type="hidden" name="intent" value="updateInvoice" />
        <input type="hidden" name="lineItems" value={JSON.stringify(lineItems)} />
        <input type="hidden" name="shippingCost" value={shippingCost} />
        <input type="hidden" name="adjustments" value={adjustments} />

        {/* Header fields */}
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
          <input type="hidden" name="supplierId" value={selectedSupplierId} />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            {suppliers.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Supplier</label>
                <select
                  value={selectedSupplierId}
                  onChange={(e) => {
                    setSelectedSupplierId(e.target.value);
                    setSelectedVendorId("");
                  }}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100"
                >
                  <option value="">— None —</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={String(s.id)}>{s.name}</option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Vendor <span className="text-red-500">*</span>
              </label>
              <select
                name="vendorId"
                value={selectedVendorId}
                onChange={(e) => setSelectedVendorId(e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100"
              >
                <option value="" disabled>Select a vendor…</option>
                {filteredVendors.map((v) => (
                  <option key={v.id} value={String(v.id)}>{v.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Invoice Number <span className="text-red-500">*</span>
              </label>
              <input
                name="invoiceNumber"
                type="text"
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100"
              />
            </div>

            <PaymentTermsFields
              key={ptfKey}
              initialInvoiceDate={invoiceDate}
              initialPaymentTerms={paymentTerms}
              initialDueDate={dueDate}
              onInvoiceDateChange={setInvoiceDate}
              onPaymentTermsChange={setPaymentTerms}
              onDueDateChange={setDueDate}
            />

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Shipping Cost</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={shippingCost}
                onChange={(e) => setShippingCost(e.target.value)}
                placeholder="0.00"
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-right focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Adjustments</label>
              <input
                type="number"
                step="0.01"
                value={adjustments}
                onChange={(e) => setAdjustments(e.target.value)}
                placeholder="0.00"
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm text-right focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100"
              />
              <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">Can be negative (e.g. discounts)</p>
            </div>
          </div>
        </div>

        {/* Line items */}
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-4">Line Items</h3>

          {/* Product search */}
          {shopifyVendorNames.length > 0 && (
            <div className="mb-2">
              <select
                value={searchVendorFilter}
                onChange={(e) => setSearchVendorFilter(e.target.value)}
                className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-200"
              >
                <option value="">All vendors</option>
                {shopifyVendorNames.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </div>
          )}
          <div className="relative mb-4">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onFocus={() => searchQuery.length >= 2 && setShowDropdown(true)}
              onBlur={() => setTimeout(() => { setShowDropdown(false); setSelectedIds(new Set()); }, 150)}
              placeholder="Add Shopify product by name or SKU…"
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100"
            />
            {isSearching && (
              <span className="absolute right-3 top-2.5 text-xs text-gray-400">Searching…</span>
            )}
            {showDropdown && searchQuery.length >= 2 && (
              <div
                className="absolute z-10 mt-1 w-full bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 shadow-lg overflow-hidden"
                onMouseDown={(e) => e.preventDefault()}
              >
                <div className="max-h-64 overflow-y-auto">
                  {groupedResults.length === 0 && !isSearching && (
                    <p className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">No products found.</p>
                  )}
                  {groupedResults.map((group) => (
                    <div key={group.productId}>
                      {group.variants.map((result) => {
                        const displayName =
                          result.variantTitle && result.variantTitle !== "Default Title"
                            ? `${result.productTitle} — ${result.variantTitle}`
                            : result.productTitle;
                        const isChecked = selectedIds.has(result.variantId);
                        return (
                          <div
                            key={result.variantId}
                            onClick={() => addShopifyItem(result)}
                            className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer border-b border-gray-100 dark:border-gray-700 transition-colors"
                          >
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => toggleSelection(result.variantId)}
                              onClick={(e) => e.stopPropagation()}
                              className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500 shrink-0 cursor-pointer"
                            />
                            <div className="flex-1 min-w-0">
                              <span className="text-sm font-medium text-gray-800 dark:text-gray-100">{displayName}</span>
                              {result.sku && (
                                <span className="ml-2 text-gray-400 dark:text-gray-500 font-mono text-xs">{result.sku}</span>
                              )}
                            </div>
                            <span className={`text-xs shrink-0 tabular-nums ${result.inventoryQty === 0 ? "text-red-500" : "text-gray-400 dark:text-gray-500"}`}>
                              {result.inventoryQty !== null ? `${result.inventoryQty} in stock` : ""}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
                {selectedIds.size > 0 && (
                  <div className="border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-4 py-2.5 flex items-center justify-between">
                    <span className="text-xs text-gray-500 dark:text-gray-400">{selectedIds.size} selected</span>
                    <button
                      type="button"
                      onClick={addSelected}
                      className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 transition-colors"
                    >
                      Add selected
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Line items table */}
          {lineItems.length > 0 ? (
            <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                    <th className="text-left px-4 py-2.5 font-medium text-gray-600 dark:text-gray-400">Product / SKU</th>
                    <th className="text-right px-4 py-2.5 font-medium text-gray-600 dark:text-gray-400 w-28">Qty</th>
                    <th className="text-right px-4 py-2.5 font-medium text-gray-600 dark:text-gray-400 w-32">Unit Cost</th>
                    <th className="text-right px-4 py-2.5 font-medium text-gray-600 dark:text-gray-400 w-32">Retail Price</th>
                    <th className="text-right px-4 py-2.5 font-medium text-gray-600 dark:text-gray-400 w-24">Margin</th>
                    <th className="text-left px-4 py-2.5 font-medium text-gray-600 dark:text-gray-400 w-44">Barcode</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {lineItems.map((item, idx) => (
                    <tr key={item.key} className={idx < lineItems.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : ""}>
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-gray-800 dark:text-gray-100">{item.description}</div>
                        {item.variantTitle && item.variantTitle !== item.description && (
                          <div className="text-xs text-gray-500 dark:text-gray-400">{item.variantTitle}</div>
                        )}
                        {item.variantId === null ? (
                          <input
                            type="text"
                            value={item.sku}
                            onChange={(e) => updateItemSku(item.key, e.target.value)}
                            placeholder="SKU"
                            className="mt-0.5 w-full font-mono text-xs border border-gray-300 dark:border-gray-600 rounded px-1.5 py-0.5 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                          />
                        ) : (
                          <div className="text-xs text-gray-400 dark:text-gray-500 font-mono">{item.sku}</div>
                        )}
                        {item.variantId === null && item.dbId === null && (
                          <span className="mt-0.5 inline-block text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-700 rounded px-1 py-0.5">
                            Manual
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <input
                          type="number"
                          min="1"
                          value={item.quantity}
                          onChange={(e) => updateItem(item.key, "quantity", Number(e.target.value))}
                          className="w-20 text-right border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100"
                        />
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={item.unitCost}
                          onChange={(e) => updateItem(item.key, "unitCost", Number(e.target.value))}
                          className="w-24 text-right border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100"
                        />
                        {item.inventoryItemId !== null && item.unitCost !== (item.shopifyCost ?? 0) && item.shopifyCost !== null && (
                          <label className="mt-1 flex items-center justify-end gap-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={item.updateShopifyCost}
                              onChange={() => toggleUpdateShopifyCost(item.key)}
                              className="h-3 w-3 rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
                            />
                            <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">Update Shopify cost</span>
                          </label>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={item.retailPrice ?? ""}
                          onChange={(e) => updateItemRetailPrice(item.key, e.target.value ? Number(e.target.value) : null)}
                          placeholder="—"
                          className="w-24 text-right border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100"
                        />
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {(() => {
                          const rp = item.retailPrice;
                          const uc = item.unitCost;
                          if (!rp || rp === 0 || !uc || uc === 0) return <span className="text-sm text-gray-400 dark:text-gray-500">—</span>;
                          const pct = ((rp - uc) / rp) * 100;
                          const cls = pct >= 40
                            ? "text-green-600 dark:text-green-400 font-medium"
                            : pct >= 20
                            ? "text-amber-600 dark:text-amber-400 font-medium"
                            : "text-red-600 dark:text-red-400 font-medium";
                          return <span className={`text-sm tabular-nums ${cls}`}>{pct.toFixed(1)}%</span>;
                        })()}
                      </td>
                      <td className="px-4 py-2.5">
                        <BarcodeInput
                          value={item.barcode}
                          onChange={(v) => updateItemBarcode(item.key, v)}
                          placeholder="Scan or type…"
                          inputClassName="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100"
                        />
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <button
                          type="button"
                          onClick={() => removeItem(item.key)}
                          aria-label="Remove item"
                          className="text-gray-400 hover:text-red-500 transition-colors text-lg leading-none"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-gray-400 dark:text-gray-500 italic">No line items. Use the search above to add products.</p>
          )}
        </div>

        {/* Submit */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={isSubmitting || lineItems.length === 0}
              className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-5 py-2.5 transition-colors"
            >
              {isSubmitting ? "Saving…" : "Save Changes"}
            </button>
            <Link
              to={`/invoices/${invoice.id}`}
              className="text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-gray-100 rounded-lg px-5 py-2.5 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              Cancel
            </Link>
          </div>
          {lineItems.length > 0 && (
            <div className="text-sm text-right space-y-0.5">
              {showBreakdown && (
                <>
                  <div className="text-gray-500 dark:text-gray-400">
                    Subtotal: <span className="font-mono tabular-nums">${subtotal.toFixed(2)}</span>
                  </div>
                  {shippingVal !== 0 && (
                    <div className="text-gray-500 dark:text-gray-400">
                      Shipping: <span className="font-mono tabular-nums">+${shippingVal.toFixed(2)}</span>
                    </div>
                  )}
                  {adjustmentsVal !== 0 && (
                    <div className="text-gray-500 dark:text-gray-400">
                      Adjustments: <span className="font-mono tabular-nums">{adjustmentsVal >= 0 ? "+" : ""}${adjustmentsVal.toFixed(2)}</span>
                    </div>
                  )}
                </>
              )}
              <div className="font-semibold text-gray-800 dark:text-gray-100">
                Total: <span className="font-mono tabular-nums">${grandTotal.toFixed(2)}</span>
              </div>
            </div>
          )}
        </div>
      </Form>
    </main>
  );
}
