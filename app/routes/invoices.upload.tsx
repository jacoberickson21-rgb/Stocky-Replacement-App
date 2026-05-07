import { redirect, data } from "react-router";
import { Link, Form, useNavigation, useFetcher } from "react-router";
import { useState, useEffect, useRef } from "react";
import Papa from "papaparse";
import type { Route } from "./+types/invoices.upload";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";
import { parsePdfInvoice } from "../services/invoice-parser.server";
import type { ExtractionResult } from "../services/invoice-parser.server";
import { logFailure } from "../services/failure-log.server";
import type { ProductSearchResult } from "../services/shopify.server";
import { updateInventoryItemCost, createDraftProduct, createDraftProductWithVariants } from "../services/shopify.server";
import type { DraftProductVariantInput } from "../services/shopify.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const vendors = await getDb().vendor.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true, shopifyVendorName: true },
  });
  return { vendors };
}

export async function action({ request }: Route.ActionArgs) {
  await requireUserId(request);

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "uploadCsv");

  // ── CSV path ──────────────────────────────────────────────────────────────
  if (intent === "uploadCsv") {
    const vendorId = String(form.get("vendorId") ?? "").trim();
    const invoiceNumber = String(form.get("invoiceNumber") ?? "").trim();
    const invoiceDateRaw = String(form.get("invoiceDate") ?? "").trim();
    const paymentTermsRaw = String(form.get("paymentTerms") ?? "").trim();
    const dueDateRaw = String(form.get("dueDate") ?? "").trim();
    const csvFile = form.get("csvFile");

    const errors: Record<string, string> = {};
    if (!vendorId) errors.vendorId = "Vendor is required.";
    if (!invoiceNumber) errors.invoiceNumber = "Invoice number is required.";
    if (!csvFile || !(csvFile instanceof File) || csvFile.size === 0) {
      errors.csvFile = "Please select a CSV file.";
    }
    if (Object.keys(errors).length > 0) {
      return data({ step: "uploadCsv" as const, errors, general: null }, { status: 400 });
    }

    const csvText = await (csvFile as File).text();
    const parsed = Papa.parse<Record<string, string>>(csvText, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLowerCase(),
    });

    type LineItem = { sku: string; description: string; quantity: number; unitCost: number };
    const lineItems: LineItem[] = [];
    for (const row of parsed.data) {
      const sku = (row["sku"] ?? "").trim();
      const description = (row["description"] ?? "").trim();
      const quantity = parseInt(row["quantity"] ?? "", 10);
      const unitCost = parseFloat(row["unit_cost"] ?? "");
      if (!sku || !description || isNaN(quantity) || isNaN(unitCost) || quantity <= 0 || unitCost < 0) continue;
      lineItems.push({ sku, description, quantity, unitCost });
    }

    if (lineItems.length === 0) {
      return data(
        { step: "uploadCsv" as const, errors: {}, general: "No valid line items found. Ensure the CSV has columns: sku, description, quantity, unit_cost — with at least one complete row." },
        { status: 400 }
      );
    }

    const total = lineItems.reduce((sum, item) => sum + item.quantity * item.unitCost, 0);
    const invoiceDate = invoiceDateRaw ? new Date(invoiceDateRaw) : null;
    const paymentTerms = paymentTermsRaw || null;
    const dueDate = dueDateRaw ? new Date(dueDateRaw) : null;
    const invoice = await getDb().$transaction(async (tx) => {
      const created = await tx.invoice.create({
        data: { invoiceNumber, vendorId: Number(vendorId), status: "ORDERED", invoiceDate, paymentTerms, dueDate, total },
      });
      await tx.invoiceLineItem.createMany({
        data: lineItems.map((item) => ({
          invoiceId: created.id,
          sku: item.sku,
          description: item.description,
          quantityOrdered: item.quantity,
          unitCost: item.unitCost,
        })),
      });
      return created;
    });

    return redirect(`/invoices/${invoice.id}`);
  }

  // ── PDF extract path ──────────────────────────────────────────────────────
  if (intent === "extractPdf") {
    const pdfFile = form.get("pdfFile");
    if (!pdfFile || !(pdfFile instanceof File) || pdfFile.size === 0) {
      return data(
        { step: "uploadPdf" as const, errors: { pdfFile: "Please select a PDF file." }, general: null, extraction: null, vendors: null, matchedVendorId: null },
        { status: 400 }
      );
    }

    const vendors = await getDb().vendor.findMany({ orderBy: { name: "asc" } });

    let extraction: ExtractionResult;
    try {
      const buffer = await pdfFile.arrayBuffer();
      extraction = await parsePdfInvoice(buffer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      await logFailure("PDF_PARSE", pdfFile.name || "Unknown PDF", msg);
      return data(
        { step: "uploadPdf" as const, errors: {}, general: `PDF extraction failed: ${msg}`, extraction: null, vendors: null, matchedVendorId: null },
        { status: 500 }
      );
    }

    const vendorNameRaw = extraction.vendorName.value.toLowerCase().trim();
    const match = vendors.find((v) => v.name.toLowerCase().trim() === vendorNameRaw);

    return data({
      step: "reviewPdf" as const,
      errors: {},
      general: null,
      extraction,
      vendors,
      matchedVendorId: match ? match.id : null,
    });
  }

  // ── PDF confirm path ──────────────────────────────────────────────────────
  if (intent === "confirmPdf") {
    const vendorId = String(form.get("vendorId") ?? "").trim();
    const invoiceNumber = String(form.get("invoiceNumber") ?? "").trim();
    const invoiceDateRaw = String(form.get("invoiceDate") ?? "").trim();
    const paymentTermsRaw = String(form.get("paymentTerms") ?? "").trim();
    const dueDateRaw = String(form.get("dueDate") ?? "").trim();
    const itemCount = parseInt(String(form.get("itemCount") ?? "0"), 10);

    const errors: Record<string, string> = {};
    if (!vendorId) errors.vendorId = "Vendor is required.";
    if (!invoiceNumber) errors.invoiceNumber = "Invoice number is required.";

    type LineItem = { sku: string; description: string; quantity: number; unitCost: number };
    const lineItems: LineItem[] = [];
    for (let i = 0; i < itemCount; i++) {
      const sku = String(form.get(`sku_${i}`) ?? "").trim();
      const description = String(form.get(`description_${i}`) ?? "").trim();
      const quantity = parseInt(String(form.get(`quantity_${i}`) ?? ""), 10);
      const unitCost = parseFloat(String(form.get(`unitCost_${i}`) ?? ""));
      if (!sku || !description || isNaN(quantity) || isNaN(unitCost) || quantity <= 0 || unitCost < 0) continue;
      lineItems.push({ sku, description, quantity, unitCost });
    }

    if (lineItems.length === 0) errors.general = "At least one valid line item is required.";
    if (Object.keys(errors).length > 0) {
      return data({ step: "uploadCsv" as const, errors, general: errors.general ?? null }, { status: 400 });
    }

    const total = lineItems.reduce((sum, item) => sum + item.quantity * item.unitCost, 0);
    const invoiceDate = invoiceDateRaw ? new Date(invoiceDateRaw) : null;
    const paymentTerms = paymentTermsRaw || null;
    const dueDate = dueDateRaw ? new Date(dueDateRaw) : null;

    const invoice = await getDb().$transaction(async (tx) => {
      const created = await tx.invoice.create({
        data: { invoiceNumber, vendorId: Number(vendorId), status: "ORDERED", invoiceDate, paymentTerms, dueDate, total },
      });
      await tx.invoiceLineItem.createMany({
        data: lineItems.map((item) => ({
          invoiceId: created.id,
          sku: item.sku,
          description: item.description,
          quantityOrdered: item.quantity,
          unitCost: item.unitCost,
        })),
      });
      return created;
    });

    return redirect(`/invoices/${invoice.id}`);
  }

  // ── Create vendor path ────────────────────────────────────────────────────
  if (intent === "createVendor") {
    const name = String(form.get("vendorName") ?? "").trim();
    if (!name) {
      return data({ step: "vendorCreated" as const, error: "Vendor name is required.", vendor: null });
    }
    const vendor = await getDb().vendor.create({ data: { name } });
    return data({ step: "vendorCreated" as const, error: null, vendor: { id: vendor.id, name: vendor.name } });
  }

  // ── Manual entry path ────────────────────────────────────────────────────
  if (intent === "createManual") {
    const vendorId = String(form.get("vendorId") ?? "").trim();
    const invoiceNumber = String(form.get("invoiceNumber") ?? "").trim();
    const invoiceDateRaw = String(form.get("invoiceDate") ?? "").trim();
    const paymentTermsRaw = String(form.get("paymentTerms") ?? "").trim();
    const dueDateRaw = String(form.get("dueDate") ?? "").trim();
    const lineItemsRaw = String(form.get("lineItems") ?? "[]");

    const errors: Record<string, string> = {};
    if (!vendorId) errors.vendorId = "Vendor is required.";
    if (!invoiceNumber) errors.invoiceNumber = "Invoice number is required.";

    type ManualLineItem = {
      sku: string;
      description: string;
      quantity: number;
      unitCost: number;
      retailPrice: number | null;
      variantId: string | null;
      inventoryItemId: string | null;
      updateShopifyCost: boolean;
      productGroupKey: string | null;
      variantOptions: { name: string; value: string }[] | null;
      productTitle: string | null;
      variantTitle: string | null;
    };

    let lineItems: ManualLineItem[] = [];
    try {
      const parsed = JSON.parse(lineItemsRaw);
      if (Array.isArray(parsed)) lineItems = parsed;
    } catch {
      errors.lineItems = "Invalid line items.";
    }

    if (!errors.lineItems) {
      if (lineItems.length === 0) {
        errors.lineItems = "At least one line item is required.";
      } else {
        for (const item of lineItems) {
          if ((!item.sku && !item.variantId) || !item.description || item.quantity < 1 || item.unitCost < 0) {
            errors.lineItems = "One or more line items have invalid data.";
            break;
          }
        }
      }
    }

    if (Object.keys(errors).length > 0) {
      return data({ step: "manualEntry" as const, errors, general: null }, { status: 400 });
    }

    const total = lineItems.reduce((sum, item) => sum + item.quantity * item.unitCost, 0);
    const invoiceDate = invoiceDateRaw ? new Date(invoiceDateRaw) : null;
    const paymentTerms = paymentTermsRaw || null;
    const dueDate = dueDateRaw ? new Date(dueDateRaw) : null;

    const { created: invoice, savedLineItems } = await getDb().$transaction(async (tx) => {
      const created = await tx.invoice.create({
        data: { invoiceNumber, vendorId: Number(vendorId), status: "ORDERED", invoiceDate, paymentTerms, dueDate, total },
      });
      const saved = await tx.invoiceLineItem.createManyAndReturn({
        data: lineItems.map((item) => ({
          invoiceId: created.id,
          sku: item.sku || null,
          description: item.description,
          quantityOrdered: item.quantity,
          unitCost: item.unitCost,
          retailPrice: item.retailPrice ?? null,
          shopifyProductTitle: item.variantTitle || (item.variantId ? item.description : null),
          shopifyVariantId: item.variantId ?? null,
          shopifyInventoryItemId: item.inventoryItemId ?? null,
        })),
        select: { id: true, unitCost: true, retailPrice: true },
      });
      return { created, savedLineItems: saved };
    });

    // Push updated cost prices back to Shopify for items where staff opted in
    for (const item of lineItems) {
      if (item.updateShopifyCost && item.inventoryItemId) {
        try {
          await updateInventoryItemCost(item.inventoryItemId, item.unitCost);
        } catch (err) {
          await logFailure(
            "shopify:set-cost",
            item.sku || item.description,
            `Cost update failed for inventoryItem ${item.inventoryItemId}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    }

    // Create skeleton draft products in Shopify for unlinked line items.
    // savedLineItems is parallel to lineItems (same order from createManyAndReturn).
    type SavedRecord = (typeof savedLineItems)[0];
    type UnlinkedEntry = { item: ManualLineItem; saved: SavedRecord };
    const unlinkedEntries: UnlinkedEntry[] = lineItems
      .map((item, i) => ({ item, saved: savedLineItems[i] }))
      .filter(({ item }) => !item.variantId);

    if (unlinkedEntries.length > 0) {
      const vendorRecord = await getDb().vendor.findUnique({
        where: { id: Number(vendorId) },
        select: { name: true },
      });
      const vendorName = vendorRecord?.name ?? "";

      // Group by productGroupKey; use DB id as solo key so null-SKU items stay separate
      const groups = new Map<string, UnlinkedEntry[]>();
      for (const entry of unlinkedEntries) {
        const key = entry.item.productGroupKey ?? `__solo__${entry.saved.id}`;
        const g = groups.get(key) ?? [];
        g.push(entry);
        groups.set(key, g);
      }

      for (const [, groupEntries] of groups) {
        const isSingle = groupEntries.length === 1 && !groupEntries[0].item.productGroupKey;

        if (isSingle) {
          const { item, saved } = groupEntries[0];
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
              await getDb().invoiceLineItem.update({
                where: { id: saved.id },
                data: {
                  shopifyVariantId: variant.id,
                  shopifyInventoryItemId: variant.inventoryItemId,
                  shopifyProductTitle: product.title,
                },
              });
            }
          } catch (err) {
            await logFailure("shopify:create-product", item.sku || item.description, `Skeleton product creation failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          // Multi-variant product — one Shopify product, N variants
          const productTitle = groupEntries[0].item.productTitle ?? groupEntries[0].item.description;
          const optionNames = [...new Set(groupEntries.flatMap(({ item }) => (item.variantOptions ?? []).map((o) => o.name)))];
          const options = optionNames.map((name) => ({
            name,
            values: [...new Set(groupEntries.flatMap(({ item }) => (item.variantOptions ?? []).filter((o) => o.name === name).map((o) => o.value)))],
          }));
          const variantInputs: DraftProductVariantInput[] = groupEntries.map(({ item, saved }) => ({
            sku: item.sku || undefined,
            optionValues: item.variantOptions ?? [],
            price: saved.retailPrice ? saved.retailPrice.toNumber() : (item.retailPrice ?? 0),
            costPrice: saved.unitCost.toNumber(),
          }));
          const skuLabel = `${productTitle} [${groupEntries.map(({ item }) => item.sku || item.description).join(", ")}]`;
          try {
            const product = await createDraftProductWithVariants({
              title: productTitle,
              vendor: vendorName,
              options,
              variants: variantInputs,
            });
            // Match created Shopify variants back to DB records by SKU, fall back to index
            for (let vi = 0; vi < product.variants.length; vi++) {
              const shopifyVariant = product.variants[vi];
              const entry = shopifyVariant.sku
                ? groupEntries.find(({ item }) => item.sku === shopifyVariant.sku)
                : groupEntries[vi];
              if (entry) {
                await getDb().invoiceLineItem.update({
                  where: { id: entry.saved.id },
                  data: {
                    shopifyVariantId: shopifyVariant.id,
                    shopifyInventoryItemId: shopifyVariant.inventoryItemId,
                    shopifyProductTitle: product.title,
                  },
                });
              }
            }
          } catch (err) {
            await logFailure("shopify:create-product", skuLabel, `Skeleton multi-variant product creation failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }

    return redirect(`/invoices/${invoice.id}`);
  }

  return redirect("/invoices/upload");
}

// ── Component ─────────────────────────────────────────────────────────────

type Vendor = { id: number; name: string; shopifyVendorName: string | null };

type LineItemRow = {
  key: string;
  sku: string;
  description: string;
  quantity: number;
  unitCost: number;
  retailPrice: number | null;
  shopifyCost: number | null;
  updateShopifyCost: boolean;
  variantId: string | null;
  inventoryItemId: string | null;
  productGroupKey: string | null;
  variantOptions: { name: string; value: string }[] | null;
  productTitle: string | null;
  variantTitle: string | null;
};

function cartesian<T>(arrays: T[][]): T[][] {
  return arrays.reduce<T[][]>(
    (acc, arr) => acc.flatMap((combo) => arr.map((val) => [...combo, val])),
    [[]]
  );
}

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
  dueDateFlagged = false,
}: {
  initialInvoiceDate?: string;
  initialPaymentTerms?: string;
  initialDueDate?: string;
  dueDateFlagged?: boolean;
}) {
  const [invoiceDate, setInvoiceDate] = useState(initialInvoiceDate);
  const [paymentTerms, setPaymentTerms] = useState(initialPaymentTerms);
  const [dueDate, setDueDate] = useState(initialDueDate);

  useEffect(() => {
    if (!paymentTerms || paymentTerms === "CUSTOM") return;
    if (paymentTerms === "DUE_ON_RECEIPT") {
      const t = new Date();
      setDueDate(
        `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`
      );
      return;
    }
    if (!invoiceDate) { setDueDate(""); return; }
    const days = paymentTerms === "NET30" ? 30 : paymentTerms === "NET60" ? 60 : 90;
    const [y, m, d] = invoiceDate.split("-").map(Number);
    const result = new Date(y, m - 1, d + days);
    setDueDate(
      `${result.getFullYear()}-${String(result.getMonth() + 1).padStart(2, "0")}-${String(result.getDate()).padStart(2, "0")}`
    );
  }, [paymentTerms, invoiceDate]);

  const isAutoDate = ["NET30", "NET60", "NET90", "DUE_ON_RECEIPT"].includes(paymentTerms);

  return (
    <>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Invoice Date</label>
        <input
          name="invoiceDate"
          type="date"
          value={invoiceDate}
          onChange={(e) => setInvoiceDate(e.target.value)}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Payment Terms</label>
        <select
          name="paymentTerms"
          value={paymentTerms}
          onChange={(e) => setPaymentTerms(e.target.value)}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
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
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Due Date {dueDateFlagged && <FlagIcon />}
        </label>
        <input
          name="dueDate"
          type="date"
          value={dueDate}
          onChange={(e) => { if (!isAutoDate) setDueDate(e.target.value); }}
          readOnly={isAutoDate}
          className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            isAutoDate
              ? "bg-gray-50 text-gray-500 cursor-default border-gray-200"
              : "border-gray-300"
          }`}
        />
      </div>
    </>
  );
}

function CsvUploadForm({
  vendors,
  errors,
}: {
  vendors: Vendor[];
  errors: Record<string, string>;
}) {
  return (
    <form method="post" encType="multipart/form-data" className="space-y-5">
      <input type="hidden" name="intent" value="uploadCsv" />
      <div>
        <label htmlFor="vendorId" className="block text-sm font-medium text-gray-700 mb-1">
          Vendor <span className="text-red-500">*</span>
        </label>
        <select
          id="vendorId"
          name="vendorId"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          defaultValue=""
        >
          <option value="" disabled>Select a vendor…</option>
          {vendors.map((v) => (
            <option key={v.id} value={String(v.id)}>{v.name}</option>
          ))}
        </select>
        {errors.vendorId && <p className="mt-1 text-xs text-red-600">{errors.vendorId}</p>}
      </div>

      <div>
        <label htmlFor="invoiceNumber" className="block text-sm font-medium text-gray-700 mb-1">
          Invoice Number <span className="text-red-500">*</span>
        </label>
        <input
          id="invoiceNumber"
          name="invoiceNumber"
          type="text"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {errors.invoiceNumber && <p className="mt-1 text-xs text-red-600">{errors.invoiceNumber}</p>}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
        <PaymentTermsFields />
      </div>

      <div>
        <label htmlFor="csvFile" className="block text-sm font-medium text-gray-700 mb-1">
          CSV File <span className="text-red-500">*</span>
        </label>
        <input
          id="csvFile"
          name="csvFile"
          type="file"
          accept=".csv"
          className="w-full text-sm text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-gray-300 file:text-sm file:font-medium file:bg-gray-50 hover:file:bg-gray-100 file:cursor-pointer"
        />
        {errors.csvFile && <p className="mt-1 text-xs text-red-600">{errors.csvFile}</p>}
        <p className="mt-1.5 text-xs text-gray-400">
          Required columns: <span className="font-mono">sku, description, quantity, unit_cost</span>
        </p>
      </div>

      <div className="flex gap-3 pt-2">
        <button
          type="submit"
          className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg px-5 py-2 transition-colors"
        >
          Import CSV
        </button>
        <Link
          to="/invoices"
          className="text-sm font-medium text-gray-600 hover:text-gray-800 rounded-lg px-5 py-2 border border-gray-300 hover:bg-gray-50 transition-colors"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}

function FlagIcon() {
  return (
    <span title="Low confidence — please verify" className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-amber-400 text-white text-xs font-bold ml-1">!</span>
  );
}

function ConfidencePct({ value }: { value: number }) {
  return <span className="text-xs text-gray-400 ml-1">({Math.round(value * 100)}%)</span>;
}

function ManualEntryForm({
  vendors,
  errors,
}: {
  vendors: Vendor[];
  errors: Record<string, string>;
}) {
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const keyCounter = useRef(0);

  const [lineItems, setLineItems] = useState<LineItemRow[]>([]);
  const [selectedVendorId, setSelectedVendorId] = useState("");

  const selectedVendor = vendors.find((v) => String(v.id) === selectedVendorId) ?? null;

  const shopifyVendorNames = [...new Set(
    vendors.map((v) => v.shopifyVendorName).filter((n): n is string => !!n)
  )].sort();

  // Shopify product search
  const searchFetcher = useFetcher<ProductSearchResult[]>();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchVendorFilter, setSearchVendorFilter] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Auto-populate vendor filter when invoice vendor changes
  useEffect(() => {
    setSearchVendorFilter(selectedVendor?.shopifyVendorName ?? "");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVendorId]);

  useEffect(() => {
    if (searchQuery.length < 2) {
      setShowDropdown(false);
      return;
    }
    const timer = setTimeout(() => {
      let url = `/api/shopify/products?q=${encodeURIComponent(searchQuery)}`;
      if (searchVendorFilter) url += `&vendorName=${encodeURIComponent(searchVendorFilter)}`;
      searchFetcher.load(url);
      setShowDropdown(true);
    }, 300);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, searchVendorFilter]);

  const rawResults: ProductSearchResult[] = Array.isArray(searchFetcher.data) ? searchFetcher.data : [];
  const isSearching = searchFetcher.state === "loading";

  // Sort by relevance: exact match > starts-with > partial
  const searchResults = [...rawResults].sort((a, b) => {
    const q = searchQuery.toLowerCase();
    function score(r: ProductSearchResult) {
      const title = (r.productTitle ?? "").toLowerCase();
      const sku = (r.sku ?? "").toLowerCase();
      if (title === q || sku === q) return 3;
      if (title.startsWith(q) || sku.startsWith(q)) return 2;
      return 1;
    }
    return score(b) - score(a);
  });

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
        sku: result.sku,
        description: result.productTitle,
        quantity: 1,
        unitCost: result.unitCost ?? 0,
        retailPrice: null,
        shopifyCost: result.unitCost,
        updateShopifyCost: false,
        variantId: result.variantId,
        inventoryItemId: result.inventoryItemId,
        productGroupKey: null,
        variantOptions: null,
        productTitle: null,
        variantTitle: result.variantTitle !== "Default Title" ? result.variantTitle : null,
      })),
    ]);
    setSelectedIds(new Set());
    setSearchQuery("");
    setShowDropdown(false);
  }

  // Manual add sub-form
  const [showManualAdd, setShowManualAdd] = useState(false);
  const [manualSku, setManualSku] = useState("");
  const [manualDesc, setManualDesc] = useState("");
  const [manualQty, setManualQty] = useState("1");
  const [manualCost, setManualCost] = useState("0.00");
  const [manualRetailPrice, setManualRetailPrice] = useState("");
  const [showVariants, setShowVariants] = useState(false);
  const [manualOptions, setManualOptions] = useState<{ name: string; values: string[] }[]>([]);
  const [optionValueInputs, setOptionValueInputs] = useState<string[]>([]);

  function addShopifyItem(result: ProductSearchResult) {
    setLineItems((prev) => [
      ...prev,
      {
        key: String(++keyCounter.current),
        sku: result.sku,
        description: result.productTitle,
        quantity: 1,
        unitCost: result.unitCost ?? 0,
        retailPrice: null,
        shopifyCost: result.unitCost,
        updateShopifyCost: false,
        variantId: result.variantId,
        inventoryItemId: result.inventoryItemId,
        productGroupKey: null,
        variantOptions: null,
        productTitle: null,
        variantTitle: result.variantTitle !== "Default Title" ? result.variantTitle : null,
      },
    ]);
    setSearchQuery("");
    setShowDropdown(false);
  }

  function addOption() {
    if (manualOptions.length >= 3) return;
    setManualOptions((prev) => [...prev, { name: "", values: [] }]);
    setOptionValueInputs((prev) => [...prev, ""]);
  }

  function removeOption(idx: number) {
    setManualOptions((prev) => prev.filter((_, i) => i !== idx));
    setOptionValueInputs((prev) => prev.filter((_, i) => i !== idx));
  }

  function setOptionName(idx: number, name: string) {
    setManualOptions((prev) => prev.map((o, i) => (i === idx ? { ...o, name } : o)));
  }

  function addOptionValue(optIdx: number) {
    const val = (optionValueInputs[optIdx] ?? "").trim();
    if (!val) return;
    setManualOptions((prev) =>
      prev.map((o, i) =>
        i === optIdx && !o.values.includes(val) ? { ...o, values: [...o.values, val] } : o
      )
    );
    setOptionValueInputs((prev) => prev.map((v, i) => (i === optIdx ? "" : v)));
  }

  function setOptionValueInput(optIdx: number, val: string) {
    setOptionValueInputs((prev) => prev.map((v, i) => (i === optIdx ? val : v)));
  }

  function removeOptionValue(optIdx: number, val: string) {
    setManualOptions((prev) =>
      prev.map((o, i) => (i === optIdx ? { ...o, values: o.values.filter((v) => v !== val) } : o))
    );
  }

  function addManualItem() {
    const qty = parseInt(manualQty, 10);
    const cost = parseFloat(manualCost);
    const retail = manualRetailPrice.trim() ? parseFloat(manualRetailPrice) : null;
    if (!manualSku.trim() || !manualDesc.trim() || isNaN(qty) || qty < 1 || isNaN(cost) || cost < 0) return;

    const baseSku = manualSku.trim();
    const desc = manualDesc.trim();
    const retailVal = retail != null && !isNaN(retail) ? retail : null;

    if (showVariants) {
      const validOptions = manualOptions.filter((o) => o.name.trim() && o.values.length > 0);
      if (validOptions.length > 0) {
        const combos = cartesian(validOptions.map((o) => o.values.map((v) => ({ name: o.name.trim(), value: v }))));
        if (combos.length > 0) {
          const groupKey = crypto.randomUUID();
          setLineItems((prev) => [
            ...prev,
            ...combos.map((combo, idx) => ({
              key: String(++keyCounter.current),
              sku: `${baseSku}-${String(idx + 1).padStart(2, "0")}`,
              description: `${desc} — ${combo.map((c) => c.value).join(" / ")}`,
              quantity: qty,
              unitCost: cost,
              retailPrice: retailVal,
              shopifyCost: null,
              updateShopifyCost: false,
              variantId: null,
              inventoryItemId: null,
              productGroupKey: groupKey,
              variantOptions: combo,
              productTitle: desc,
              variantTitle: null,
            })),
          ]);
          setManualSku("");
          setManualDesc("");
          setManualQty("1");
          setManualCost("0.00");
          setManualRetailPrice("");
          setShowVariants(false);
          setManualOptions([]);
          setOptionValueInputs([]);
          setShowManualAdd(false);
          return;
        }
      }
    }

    setLineItems((prev) => [
      ...prev,
      {
        key: String(++keyCounter.current),
        sku: baseSku,
        description: desc,
        quantity: qty,
        unitCost: cost,
        retailPrice: retailVal,
        shopifyCost: null,
        updateShopifyCost: false,
        variantId: null,
        inventoryItemId: null,
        productGroupKey: null,
        variantOptions: null,
        productTitle: null,
        variantTitle: null,
      },
    ]);
    setManualSku("");
    setManualDesc("");
    setManualQty("1");
    setManualCost("0.00");
    setManualRetailPrice("");
    setShowManualAdd(false);
  }

  function removeItem(key: string) {
    setLineItems((prev) => prev.filter((item) => item.key !== key));
  }

  function updateItem(key: string, field: "quantity" | "unitCost", value: number) {
    setLineItems((prev) =>
      prev.map((item) => (item.key === key ? { ...item, [field]: value } : item))
    );
  }

  function toggleUpdateShopifyCost(key: string) {
    setLineItems((prev) =>
      prev.map((item) =>
        item.key === key ? { ...item, updateShopifyCost: !item.updateShopifyCost } : item
      )
    );
  }

  function resetManualForm() {
    setManualSku("");
    setManualDesc("");
    setManualQty("1");
    setManualCost("0.00");
    setManualRetailPrice("");
    setShowVariants(false);
    setManualOptions([]);
    setOptionValueInputs([]);
    setShowManualAdd(false);
  }

  return (
    <Form method="post" className="space-y-6">
      <input type="hidden" name="intent" value="createManual" />
      <input type="hidden" name="lineItems" value={JSON.stringify(lineItems)} />

      {/* Header fields */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Vendor <span className="text-red-500">*</span>
            </label>
            <select
              name="vendorId"
              value={selectedVendorId}
              onChange={(e) => setSelectedVendorId(e.target.value)}
              className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                errors.vendorId ? "border-red-400" : "border-gray-300"
              }`}
            >
              <option value="" disabled>Select a vendor…</option>
              {vendors.map((v) => (
                <option key={v.id} value={String(v.id)}>{v.name}</option>
              ))}
            </select>
            {errors.vendorId && <p className="mt-1 text-xs text-red-600">{errors.vendorId}</p>}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Invoice Number <span className="text-red-500">*</span>
            </label>
            <input
              name="invoiceNumber"
              type="text"
              className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                errors.invoiceNumber ? "border-red-400" : "border-gray-300"
              }`}
            />
            {errors.invoiceNumber && <p className="mt-1 text-xs text-red-600">{errors.invoiceNumber}</p>}
          </div>

          <PaymentTermsFields />
        </div>
      </div>

      {/* Line items */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-4">Line Items</h3>

        {/* Shopify product search */}
        {shopifyVendorNames.length > 0 && (
          <div className="mb-2">
            <select
              value={searchVendorFilter}
              onChange={(e) => setSearchVendorFilter(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            >
              <option value="">All vendors</option>
              {shopifyVendorNames.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </div>
        )}
        <div className="relative mb-3">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onFocus={() => searchQuery.length >= 2 && setShowDropdown(true)}
            onBlur={() => setTimeout(() => { setShowDropdown(false); setSelectedIds(new Set()); }, 150)}
            placeholder="Search Shopify products by name or SKU…"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {isSearching && (
            <span className="absolute right-3 top-2.5 text-xs text-gray-400">Searching…</span>
          )}
          {showDropdown && searchQuery.length >= 2 && (
            <div
              className="absolute z-10 mt-1 w-full bg-white rounded-lg border border-gray-200 shadow-lg overflow-hidden"
              onMouseDown={(e) => e.preventDefault()}
            >
              <div className="max-h-64 overflow-y-auto">
                {searchResults.length === 0 && !isSearching && (
                  <p className="px-4 py-3 text-sm text-gray-500">No products found.</p>
                )}
                {searchResults.map((result) => {
                  const displayName =
                    result.variantTitle && result.variantTitle !== "Default Title"
                      ? `${result.productTitle} — ${result.variantTitle}`
                      : result.productTitle;
                  const isChecked = selectedIds.has(result.variantId);
                  return (
                    <div
                      key={result.variantId}
                      onClick={() => addShopifyItem(result)}
                      className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 cursor-pointer border-b border-gray-100 last:border-0 transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleSelection(result.variantId)}
                        onClick={(e) => e.stopPropagation()}
                        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 shrink-0 cursor-pointer"
                      />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-gray-800 leading-snug">{displayName}</span>
                        {result.sku && (
                          <span className="ml-2 text-gray-400 font-mono text-xs">{result.sku}</span>
                        )}
                      </div>
                      <span className={`text-xs shrink-0 tabular-nums ${result.inventoryQty === 0 ? "text-red-500" : "text-gray-400"}`}>
                        {result.inventoryQty !== null ? `${result.inventoryQty} in stock` : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
              {selectedIds.size > 0 && (
                <div className="border-t border-gray-200 bg-gray-50 px-4 py-2.5 flex items-center justify-between">
                  <span className="text-xs text-gray-500">{selectedIds.size} selected</span>
                  <button
                    type="button"
                    onClick={addSelected}
                    className="text-xs font-semibold text-blue-600 hover:text-blue-800 transition-colors"
                  >
                    Add selected
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Add manually toggle */}
        {!showManualAdd ? (
          <button
            type="button"
            onClick={() => setShowManualAdd(true)}
            className="mb-4 text-xs text-blue-600 hover:text-blue-800 font-medium transition-colors"
          >
            + Add manually
          </button>
        ) : (
          <div className="mb-4 rounded-xl border border-gray-200 bg-gray-50 p-4">
            <p className="text-xs font-semibold text-gray-700 mb-3">Add item manually</p>

            {/* Row 1: SKU + Product Title */}
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  SKU <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={manualSku}
                  onChange={(e) => setManualSku(e.target.value)}
                  placeholder="e.g. SIM-001"
                  className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Product Title <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={manualDesc}
                  onChange={(e) => setManualDesc(e.target.value)}
                  placeholder="e.g. Simms Waders"
                  className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            {/* Variant options */}
            {(() => {
              const validOptions = manualOptions.filter((o) => o.name.trim() && o.values.length > 0);
              const combos = showVariants && validOptions.length > 0
                ? cartesian(validOptions.map((o) => o.values.map((v) => ({ name: o.name.trim(), value: v }))))
                : [];
              return !showVariants ? (
                <button
                  type="button"
                  onClick={() => { setShowVariants(true); addOption(); }}
                  className="mb-3 text-xs text-blue-600 hover:text-blue-800 font-medium transition-colors"
                >
                  + Add variants (Size, Color, etc.)
                </button>
              ) : (
                <div className="mb-3 space-y-2.5">
                  {manualOptions.map((opt, optIdx) => (
                    <div key={optIdx}>
                      <div className="flex items-center gap-2 mb-1.5">
                        <input
                          type="text"
                          placeholder="Option name (e.g. Size)"
                          value={opt.name}
                          onChange={(e) => setOptionName(optIdx, e.target.value)}
                          className="w-40 border border-gray-300 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        {manualOptions.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeOption(optIdx)}
                            className="text-gray-400 hover:text-red-500 text-lg leading-none"
                          >
                            ×
                          </button>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2 py-1.5 min-h-[34px]">
                        {opt.values.map((val) => (
                          <span
                            key={val}
                            className="inline-flex items-center gap-0.5 bg-blue-100 text-blue-700 text-xs font-medium rounded-full px-2 py-0.5"
                          >
                            {val}
                            <button
                              type="button"
                              onClick={() => removeOptionValue(optIdx, val)}
                              className="text-blue-400 hover:text-blue-700 ml-0.5 leading-none"
                            >
                              ×
                            </button>
                          </span>
                        ))}
                        <input
                          type="text"
                          placeholder={opt.values.length === 0 ? "Type a value + Enter (e.g. S, M, L)" : "Add value…"}
                          value={optionValueInputs[optIdx] ?? ""}
                          onChange={(e) => setOptionValueInput(optIdx, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === ",") {
                              e.preventDefault();
                              addOptionValue(optIdx);
                            }
                          }}
                          className="flex-1 min-w-[140px] text-xs border-0 outline-none bg-transparent placeholder-gray-400 py-0.5"
                        />
                      </div>
                    </div>
                  ))}
                  <div className="flex items-center gap-4">
                    {manualOptions.length < 3 && (
                      <button
                        type="button"
                        onClick={addOption}
                        className="text-xs text-blue-600 hover:text-blue-800 font-medium transition-colors"
                      >
                        + Add option
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => { setShowVariants(false); setManualOptions([]); setOptionValueInputs([]); }}
                      className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
                    >
                      Remove variants
                    </button>
                  </div>
                  {combos.length > 0 && (
                    <p className="text-xs text-gray-600 bg-white border border-gray-200 rounded-lg px-3 py-2">
                      Generates <strong>{combos.length}</strong> variant{combos.length !== 1 ? "s" : ""}:{" "}
                      {combos.slice(0, 4).map((c, i) => (
                        <span key={i}>
                          {i > 0 && <span className="text-gray-300 mx-1">·</span>}
                          {c.map((v) => v.value).join(" / ")}
                        </span>
                      ))}
                      {combos.length > 4 && <span className="text-gray-400"> +{combos.length - 4} more</span>}
                    </p>
                  )}
                </div>
              );
            })()}

            {/* Row 2: Quantity + Unit Cost */}
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Quantity <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  min="1"
                  value={manualQty}
                  onChange={(e) => setManualQty(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Unit Cost <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={manualCost}
                  onChange={(e) => setManualCost(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            {/* Retail Price */}
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Retail Price <span className="text-xs text-gray-400 font-normal">(optional)</span>
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={manualRetailPrice}
                  onChange={(e) => setManualRetailPrice(e.target.value)}
                  placeholder="0.00"
                  className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            {(() => {
              const validOptions = manualOptions.filter((o) => o.name.trim() && o.values.length > 0);
              const comboCount = showVariants && validOptions.length > 0
                ? cartesian(validOptions.map((o) => o.values.map((v) => ({ name: o.name.trim(), value: v })))).length
                : 0;
              return (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={addManualItem}
                    disabled={!manualSku.trim() || !manualDesc.trim()}
                    className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-xs font-medium rounded-lg px-3 py-1.5 transition-colors"
                  >
                    {comboCount > 1 ? `Add ${comboCount} variants` : "Add"}
                  </button>
                  <button
                    type="button"
                    onClick={resetManualForm}
                    className="text-xs font-medium text-gray-600 hover:text-gray-800 rounded-lg px-3 py-1.5 border border-gray-300 hover:bg-white transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              );
            })()}
          </div>
        )}

        {/* Line items table */}
        {lineItems.length > 0 && (
          <div className="border border-gray-200 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">Product / SKU</th>
                  <th className="text-right px-4 py-2.5 font-medium text-gray-600 w-28">Qty</th>
                  <th className="text-right px-4 py-2.5 font-medium text-gray-600 w-32">Unit Cost</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {lineItems.map((item, idx) => (
                  <tr key={item.key} className={idx < lineItems.length - 1 ? "border-b border-gray-100" : ""}>
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-gray-800">{item.description}</div>
                      {item.variantTitle && (
                        <div className="text-xs text-gray-500">{item.variantTitle}</div>
                      )}
                      <div className="text-xs text-gray-400 font-mono">{item.sku}</div>
                      {item.variantId === null && (
                        <span className="mt-0.5 inline-block text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 py-0.5">
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
                        className="w-20 text-right border border-gray-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={item.unitCost}
                        onChange={(e) => updateItem(item.key, "unitCost", Number(e.target.value))}
                        className="w-24 text-right border border-gray-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      {item.inventoryItemId !== null &&
                        item.unitCost !== (item.shopifyCost ?? 0) && (
                          <label className="mt-1 flex items-center justify-end gap-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={item.updateShopifyCost}
                              onChange={() => toggleUpdateShopifyCost(item.key)}
                              className="h-3 w-3 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                            />
                            <span className="text-xs text-gray-500 whitespace-nowrap">Update Shopify cost</span>
                          </label>
                        )}
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
        )}

        {errors.lineItems && (
          <p className="mt-2 text-xs text-red-600">{errors.lineItems}</p>
        )}
      </div>

      {/* Submit */}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={isSubmitting}
          className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-5 py-2.5 transition-colors"
        >
          {isSubmitting ? "Creating…" : "Create Invoice"}
        </button>
        <Link
          to="/invoices"
          className="text-sm font-medium text-gray-600 hover:text-gray-800 rounded-lg px-5 py-2.5 border border-gray-300 hover:bg-gray-50 transition-colors"
        >
          Cancel
        </Link>
      </div>
    </Form>
  );
}

function ReviewScreen({
  extraction,
  vendors: initialVendors,
  matchedVendorId: initialMatchedVendorId,
}: {
  extraction: ExtractionResult;
  vendors: Vendor[];
  matchedVendorId: number | null;
}) {
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const fetcher = useFetcher<{ step: "vendorCreated"; error: string | null; vendor: Vendor | null }>();

  const [vendorsList, setVendorsList] = useState<Vendor[]>(initialVendors);
  const [selectedVendorId, setSelectedVendorId] = useState<string>(
    initialMatchedVendorId !== null ? String(initialMatchedVendorId) : ""
  );
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newVendorName, setNewVendorName] = useState(
    initialMatchedVendorId === null ? extraction.vendorName.value : ""
  );

  const isCreating = fetcher.state === "submitting";
  const createError = fetcher.data?.error ?? null;
  const vendorNotMatched = initialMatchedVendorId === null && selectedVendorId === "";

  // When fetcher returns a new vendor, append it and auto-select it
  useEffect(() => {
    if (fetcher.data?.step === "vendorCreated" && fetcher.data.vendor) {
      const newVendor = fetcher.data.vendor;
      setVendorsList((prev) =>
        prev.some((v) => v.id === newVendor.id) ? prev : [...prev, newVendor].sort((a, b) => a.name.localeCompare(b.name))
      );
      setSelectedVendorId(String(newVendor.id));
      setShowCreateForm(false);
    }
  }, [fetcher.data]);

  const flagCount =
    [extraction.vendorName, extraction.invoiceNumber, extraction.dueDate].filter((f) => f.flagged).length +
    extraction.lineItems.reduce(
      (n, item) => n + [item.sku, item.description, item.quantity, item.unitCost].filter((f) => f.flagged).length,
      0
    );

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link to="/invoices" className="text-sm text-gray-500 hover:text-gray-800 transition-colors">
          ← Purchase Orders
        </Link>
        <span className="text-gray-300">/</span>
        <Link to="/invoices/upload" className="text-sm text-gray-500 hover:text-gray-800 transition-colors">
          Upload Invoice
        </Link>
        <span className="text-gray-300">/</span>
        <h2 className="text-xl font-semibold text-gray-800">Review Extraction</h2>
      </div>

      {flagCount > 0 && (
        <div className="mb-6 flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-400 text-white text-xs font-bold">!</span>
          <strong>{flagCount} field{flagCount !== 1 ? "s" : ""} flagged for review.</strong>
          <span className="text-amber-700">Low-confidence extractions are highlighted. Please verify before saving.</span>
        </div>
      )}

      <Form method="post">
        <input type="hidden" name="intent" value="confirmPdf" />
        <input type="hidden" name="itemCount" value={String(extraction.lineItems.length)} />

        {/* Header fields */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 mb-6">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Vendor <span className="text-red-500">*</span>
                {extraction.vendorName.flagged && <FlagIcon />}
                {!extraction.vendorName.flagged && <ConfidencePct value={extraction.vendorName.confidence} />}
              </label>

              {vendorNotMatched && !showCreateForm && (
                <p className="mb-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                  "{extraction.vendorName.value}" not found — select or create below.
                </p>
              )}

              <select
                name="vendorId"
                value={selectedVendorId}
                onChange={(e) => setSelectedVendorId(e.target.value)}
                className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  vendorNotMatched && !showCreateForm ? "border-amber-400 bg-amber-50" : "border-gray-300"
                }`}
              >
                <option value="" disabled>Select a vendor…</option>
                {vendorsList.map((v) => (
                  <option key={v.id} value={String(v.id)}>{v.name}</option>
                ))}
              </select>

              {/* Create new vendor toggle */}
              {!showCreateForm && (
                <button
                  type="button"
                  onClick={() => setShowCreateForm(true)}
                  className="mt-2 text-xs text-blue-600 hover:text-blue-800 font-medium transition-colors"
                >
                  + Create new vendor
                </button>
              )}

              {/* Inline create vendor form — plain div avoids nesting inside the outer <Form> */}
              {showCreateForm && (
                <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50 p-4">
                  <p className="text-xs font-medium text-gray-700 mb-2">New Vendor Name</p>
                  <div className="flex flex-col gap-2">
                    <input
                      type="text"
                      value={newVendorName}
                      onChange={(e) => setNewVendorName(e.target.value)}
                      placeholder="e.g. Simms Fishing"
                      className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      autoFocus
                    />
                    {createError && (
                      <p className="text-xs text-red-600">{createError}</p>
                    )}
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={isCreating || !newVendorName.trim()}
                        onClick={() => {
                          const fd = new FormData();
                          fd.append("intent", "createVendor");
                          fd.append("vendorName", newVendorName.trim());
                          fetcher.submit(fd, { method: "post" });
                        }}
                        className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-xs font-medium rounded-lg px-3 py-1.5 transition-colors"
                      >
                        {isCreating ? "Creating…" : "Create"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowCreateForm(false)}
                        className="text-xs font-medium text-gray-600 hover:text-gray-800 rounded-lg px-3 py-1.5 border border-gray-300 hover:bg-white transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Invoice Number <span className="text-red-500">*</span>
                {extraction.invoiceNumber.flagged ? <FlagIcon /> : <ConfidencePct value={extraction.invoiceNumber.confidence} />}
              </label>
              <input
                name="invoiceNumber"
                type="text"
                defaultValue={extraction.invoiceNumber.value}
                className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${extraction.invoiceNumber.flagged ? "border-amber-400 bg-amber-50" : "border-gray-300"}`}
              />
            </div>

            <PaymentTermsFields
              initialDueDate={extraction.dueDate.value ?? ""}
              dueDateFlagged={extraction.dueDate.flagged}
            />
          </div>
        </div>

        {/* Line items */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden mb-6">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-3 font-medium text-gray-600">SKU</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Description</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600 w-28">Qty</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600 w-32">Unit Cost</th>
              </tr>
            </thead>
            <tbody>
              {extraction.lineItems.map((item, i) => (
                <tr key={i} className={i < extraction.lineItems.length - 1 ? "border-b border-gray-100" : ""}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      {item.sku.flagged && <FlagIcon />}
                      <input
                        name={`sku_${i}`}
                        type="text"
                        defaultValue={item.sku.value}
                        className={`w-full border rounded-lg px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 ${item.sku.flagged ? "border-amber-400 bg-amber-50" : "border-gray-300"}`}
                      />
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      {item.description.flagged && <FlagIcon />}
                      <input
                        name={`description_${i}`}
                        type="text"
                        defaultValue={item.description.value}
                        className={`w-full border rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${item.description.flagged ? "border-amber-400 bg-amber-50" : "border-gray-300"}`}
                      />
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      {item.quantity.flagged && <FlagIcon />}
                      <input
                        name={`quantity_${i}`}
                        type="number"
                        min="1"
                        defaultValue={item.quantity.value}
                        className={`w-24 text-right border rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${item.quantity.flagged ? "border-amber-400 bg-amber-50" : "border-gray-300"}`}
                      />
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      {item.unitCost.flagged && <FlagIcon />}
                      <input
                        name={`unitCost_${i}`}
                        type="number"
                        min="0"
                        step="0.01"
                        defaultValue={item.unitCost.value}
                        className={`w-28 text-right border rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${item.unitCost.flagged ? "border-amber-400 bg-amber-50" : "border-gray-300"}`}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={isSubmitting}
            className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-5 py-2.5 transition-colors"
          >
            {isSubmitting ? "Saving…" : "Confirm & Save"}
          </button>
          <Link
            to="/invoices/upload"
            className="text-sm font-medium text-gray-600 hover:text-gray-800 rounded-lg px-5 py-2.5 border border-gray-300 hover:bg-gray-50 transition-colors"
          >
            Start Over
          </Link>
        </div>
      </Form>
    </div>
  );
}

export default function InvoiceUploadPage({ loaderData, actionData }: Route.ComponentProps) {
  const { vendors } = loaderData;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ad = actionData as any;
  const [uploadMode, setUploadMode] = useState<"csv" | "pdf" | "manual">(
    ad?.step === "manualEntry" ? "manual" : "csv"
  );
  const navigation = useNavigation();
  const isExtracting = navigation.state === "submitting";

  // Show review screen after successful PDF extraction
  if (actionData?.step === "reviewPdf" && actionData.extraction) {
    return (
      <main className="p-8">
        <ReviewScreen
          extraction={actionData.extraction as ExtractionResult}
          vendors={(actionData.vendors ?? vendors) as Vendor[]}
          matchedVendorId={actionData.matchedVendorId as number | null}
        />
      </main>
    );
  }

  const errors = ad?.step !== "reviewPdf" && ad?.step !== "manualEntry" ? (ad?.errors ?? {}) : {};
  const general = ad?.step !== "reviewPdf" && ad?.step !== "manualEntry" ? (ad?.general ?? null) : null;
  const manualErrors: Record<string, string> = ad?.step === "manualEntry" ? (ad?.errors ?? {}) : {};

  return (
    <main className={`p-8 mx-auto ${uploadMode === "manual" ? "max-w-5xl" : "max-w-xl"}`}>
      <div className="flex items-center gap-3 mb-6">
        <Link to="/invoices" className="text-sm text-gray-500 hover:text-gray-800 transition-colors">
          ← Purchase Orders
        </Link>
        <span className="text-gray-300">/</span>
        <h2 className="text-xl font-semibold text-gray-800">Upload Invoice</h2>
      </div>

      {/* Upload type selector */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <button
          type="button"
          onClick={() => setUploadMode("csv")}
          className={`flex flex-col items-center justify-center gap-2 rounded-2xl border-2 px-6 py-8 transition-colors ${
            uploadMode === "csv"
              ? "border-blue-500 bg-blue-50 cursor-default"
              : "border-gray-200 bg-white hover:border-gray-300 cursor-pointer"
          }`}
        >
          <svg className={`w-8 h-8 ${uploadMode === "csv" ? "text-blue-600" : "text-gray-400"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <span className={`text-sm font-medium ${uploadMode === "csv" ? "text-blue-700" : "text-gray-600"}`}>Upload CSV</span>
        </button>

        <button
          type="button"
          onClick={() => setUploadMode("pdf")}
          className={`flex flex-col items-center justify-center gap-2 rounded-2xl border-2 px-6 py-8 transition-colors ${
            uploadMode === "pdf"
              ? "border-blue-500 bg-blue-50 cursor-default"
              : "border-gray-200 bg-white hover:border-gray-300 cursor-pointer"
          }`}
        >
          <svg className={`w-8 h-8 ${uploadMode === "pdf" ? "text-blue-600" : "text-gray-400"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
          <span className={`text-sm font-medium ${uploadMode === "pdf" ? "text-blue-700" : "text-gray-600"}`}>Upload PDF</span>
        </button>

        <button
          type="button"
          onClick={() => setUploadMode("manual")}
          className={`flex flex-col items-center justify-center gap-2 rounded-2xl border-2 px-6 py-8 transition-colors ${
            uploadMode === "manual"
              ? "border-blue-500 bg-blue-50 cursor-default"
              : "border-gray-200 bg-white hover:border-gray-300 cursor-pointer"
          }`}
        >
          <svg className={`w-8 h-8 ${uploadMode === "manual" ? "text-blue-600" : "text-gray-400"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          <span className={`text-sm font-medium ${uploadMode === "manual" ? "text-blue-700" : "text-gray-600"}`}>Manual Entry</span>
        </button>
      </div>

      {uploadMode === "manual" && (
        <ManualEntryForm vendors={vendors} errors={manualErrors} />
      )}

      {uploadMode !== "manual" && <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
        {general && (
          <p className="mb-5 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">
            {general}
          </p>
        )}

        {/* ── CSV form ── */}
        {uploadMode === "csv" && <CsvUploadForm vendors={vendors} errors={errors} />}

        {/* ── PDF form ── */}
        {uploadMode === "pdf" && (
          <form method="post" encType="multipart/form-data" className="space-y-5">
            <input type="hidden" name="intent" value="extractPdf" />
            <div>
              <label htmlFor="pdfFile" className="block text-sm font-medium text-gray-700 mb-1">
                PDF Invoice <span className="text-red-500">*</span>
              </label>
              <input
                id="pdfFile"
                name="pdfFile"
                type="file"
                accept=".pdf"
                className="w-full text-sm text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-gray-300 file:text-sm file:font-medium file:bg-gray-50 hover:file:bg-gray-100 file:cursor-pointer"
              />
              {errors.pdfFile && <p className="mt-1 text-xs text-red-600">{errors.pdfFile}</p>}
              <p className="mt-1.5 text-xs text-gray-400">
                Claude AI will extract vendor, invoice number, due date, and all line items.
              </p>
            </div>

            <div className="flex gap-3 pt-2">
              <button
                type="submit"
                disabled={isExtracting}
                className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-5 py-2 transition-colors"
              >
                {isExtracting ? "Extracting…" : "Extract Invoice"}
              </button>
              <Link
                to="/invoices"
                className="text-sm font-medium text-gray-600 hover:text-gray-800 rounded-lg px-5 py-2 border border-gray-300 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </Link>
            </div>
          </form>
        )}
      </div>}
    </main>
  );
}
