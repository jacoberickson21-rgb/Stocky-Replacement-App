import { redirect, data } from "react-router";
import { Link, Form, useNavigation, useFetcher } from "react-router";
import { useState, useEffect, useRef } from "react";
import Papa from "papaparse";
import type { Route } from "./+types/invoices.upload";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";
import { callPdfParser } from "../services/pdf-parser-client.server";
import type { ExtendedExtractionResult } from "../services/pdf-parser-client.server";
import type { ExtractionResult } from "../services/invoice-parser.server";
import { logFailure } from "../services/failure-log.server";
import type { ProductSearchResult } from "../services/shopify.server";
import { lookupProduct, updateInventoryItemCost, createDraftProduct, createDraftProductWithVariants } from "../services/shopify.server";
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

    let extraction: ExtendedExtractionResult;
    try {
      const buffer = await pdfFile.arrayBuffer();
      extraction = await callPdfParser(buffer);
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

    type LineItem = { sku: string; description: string; quantity: number; unitCost: number; barcode: string | null };
    const lineItems: LineItem[] = [];
    for (let i = 0; i < itemCount; i++) {
      const sku = String(form.get(`sku_${i}`) ?? "").trim();
      const description = String(form.get(`description_${i}`) ?? "").trim();
      const quantity = parseInt(String(form.get(`quantity_${i}`) ?? ""), 10);
      const unitCost = parseFloat(String(form.get(`unitCost_${i}`) ?? ""));
      const barcode = String(form.get(`barcode_${i}`) ?? "").trim() || null;
      if (!sku || !description || isNaN(quantity) || isNaN(unitCost) || quantity <= 0 || unitCost < 0) continue;
      lineItems.push({ sku, description, quantity, unitCost, barcode });
    }

    if (lineItems.length === 0) errors.general = "At least one valid line item is required.";
    if (Object.keys(errors).length > 0) {
      return data({ step: "uploadCsv" as const, errors, general: errors.general ?? null }, { status: 400 });
    }

    // Save vendor profile if staff provided column mappings from the mapping UI.
    const skuColumn = String(form.get("skuColumn") ?? "").trim() || null;
    const descColumn = String(form.get("descColumn") ?? "").trim() || null;
    const qtyColumn = String(form.get("qtyColumn") ?? "").trim() || null;
    const costColumn = String(form.get("costColumn") ?? "").trim() || null;
    if (descColumn && vendorId) {
      await getDb().vendorProfile.upsert({
        where: { vendorId: Number(vendorId) },
        create: {
          vendorId: Number(vendorId),
          columnMappings: { sku: skuColumn, description: descColumn, quantity: qtyColumn, unitCost: costColumn },
        },
        update: {
          columnMappings: { sku: skuColumn, description: descColumn, quantity: qtyColumn, unitCost: costColumn },
        },
      });
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
          barcode: item.barcode,
        })),
      });
      return created;
    });

    // Auto-match line items against Shopify by exact SKU (best-effort)
    const savedItems = await getDb().invoiceLineItem.findMany({
      where: { invoiceId: invoice.id, sku: { not: null } },
      select: { id: true, sku: true, barcode: true },
    });
    if (savedItems.length > 0) {
      const matchResults = await Promise.allSettled(
        savedItems.map((item) => lookupProduct({ sku: item.sku! }))
      );
      for (let i = 0; i < savedItems.length; i++) {
        const result = matchResults[i];
        if (result.status === "fulfilled" && result.value) {
          const product = result.value;
          const variant = product.variants[0];
          if (variant) {
            await getDb().invoiceLineItem.update({
              where: { id: savedItems[i].id },
              data: {
                shopifyProductTitle: product.title,
                shopifyVariantId: variant.id,
                shopifyInventoryItemId: variant.inventoryItemId,
                ...(!savedItems[i].barcode && variant.barcode
                  ? { barcode: variant.barcode }
                  : {}),
              },
            });
          }
        }
      }
    }

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
      barcode?: string;
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
          barcode: item.barcode || null,
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
  barcode: string;
};

// Items added via AddItemSection in the PDF review screen
type ReviewAddedItem = {
  key: string;
  sku: string;
  description: string;
  quantity: number;
  unitCost: number;
  barcode: string;
  variantId: string | null;
  inventoryItemId: string | null;
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
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Due Date {dueDateFlagged && <FlagIcon />}
        </label>
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
        <label htmlFor="vendorId" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Vendor <span className="text-red-500">*</span>
        </label>
        <select
          id="vendorId"
          name="vendorId"
          className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100"
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
        <label htmlFor="invoiceNumber" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Invoice Number <span className="text-red-500">*</span>
        </label>
        <input
          id="invoiceNumber"
          name="invoiceNumber"
          type="text"
          className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100"
        />
        {errors.invoiceNumber && <p className="mt-1 text-xs text-red-600">{errors.invoiceNumber}</p>}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
        <PaymentTermsFields />
      </div>

      <div>
        <label htmlFor="csvFile" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          CSV File <span className="text-red-500">*</span>
        </label>
        <input
          id="csvFile"
          name="csvFile"
          type="file"
          accept=".csv"
          className="w-full text-sm text-gray-600 dark:text-gray-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-gray-300 dark:file:border-gray-600 file:text-sm file:font-medium file:bg-gray-50 dark:file:bg-gray-800 dark:file:text-indigo-400 hover:file:bg-gray-100 dark:hover:file:bg-gray-700 file:cursor-pointer"
        />
        {errors.csvFile && <p className="mt-1 text-xs text-red-600">{errors.csvFile}</p>}
        <p className="mt-1.5 text-xs text-gray-400 dark:text-gray-500">
          Required columns: <span className="font-mono">sku, description, quantity, unit_cost</span>
        </p>
      </div>

      <div className="flex gap-3 pt-2">
        <button
          type="submit"
          className="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg px-5 py-2 transition-colors"
        >
          Import CSV
        </button>
        <Link
          to="/invoices"
          className="text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-gray-100 rounded-lg px-5 py-2 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
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
  onCommit,
  name,
  placeholder = "Scan or type barcode…",
  inputClassName = "",
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit?: (v: string) => void;
  name?: string;
  placeholder?: string;
  inputClassName?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <BarcodeIcon className="w-3.5 h-3.5 text-gray-400 shrink-0" />
      <input
        type="text"
        name={name}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onCommit ? onCommit(value) : undefined;
          } else if (e.key === "Tab" && onCommit) {
            onCommit(value);
          }
        }}
        onBlur={() => onCommit && onCommit(value)}
        className={inputClassName}
      />
    </div>
  );
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
    toAdd.forEach((r) => console.log(`[addSelected] sku=${r.sku} barcode=${r.barcode}`));
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
        barcode: result.barcode ?? "",
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
  const [manualBarcode, setManualBarcode] = useState("");
  const [showVariants, setShowVariants] = useState(false);
  const [manualOptions, setManualOptions] = useState<{ name: string; values: string[] }[]>([]);
  const [optionValueInputs, setOptionValueInputs] = useState<string[]>([]);

  function addShopifyItem(result: ProductSearchResult) {
    console.log(`[addShopifyItem] sku=${result.sku} barcode=${result.barcode}`);
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
        barcode: result.barcode ?? "",
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
              barcode: "",
            })),
          ]);
          setManualSku("");
          setManualDesc("");
          setManualQty("1");
          setManualCost("0.00");
          setManualRetailPrice("");
          setManualBarcode("");
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
        barcode: manualBarcode.trim(),
      },
    ]);
    setManualSku("");
    setManualDesc("");
    setManualQty("1");
    setManualCost("0.00");
    setManualRetailPrice("");
    setManualBarcode("");
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

  function updateItemBarcode(key: string, value: string) {
    setLineItems((prev) =>
      prev.map((item) => (item.key === key ? { ...item, barcode: value } : item))
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
    setManualBarcode("");
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
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Vendor <span className="text-red-500">*</span>
            </label>
            <select
              name="vendorId"
              value={selectedVendorId}
              onChange={(e) => setSelectedVendorId(e.target.value)}
              className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:bg-gray-800 dark:text-gray-100 ${
                errors.vendorId ? "border-red-400" : "border-gray-300 dark:border-gray-600"
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
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Invoice Number <span className="text-red-500">*</span>
            </label>
            <input
              name="invoiceNumber"
              type="text"
              className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:bg-gray-800 dark:text-gray-100 ${
                errors.invoiceNumber ? "border-red-400" : "border-gray-300 dark:border-gray-600"
              }`}
            />
            {errors.invoiceNumber && <p className="mt-1 text-xs text-red-600">{errors.invoiceNumber}</p>}
          </div>

          <PaymentTermsFields />
        </div>
      </div>

      {/* Line items */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-4">Line Items</h3>

        {/* Shopify product search */}
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
        <div className="relative mb-3">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onFocus={() => searchQuery.length >= 2 && setShowDropdown(true)}
            onBlur={() => setTimeout(() => { setShowDropdown(false); setSelectedIds(new Set()); }, 150)}
            placeholder="Search Shopify products by name or SKU…"
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
                {searchResults.length === 0 && !isSearching && (
                  <p className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">No products found.</p>
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
                      className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer border-b border-gray-100 dark:border-gray-700 last:border-0 transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleSelection(result.variantId)}
                        onClick={(e) => e.stopPropagation()}
                        className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500 shrink-0 cursor-pointer"
                      />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-gray-800 dark:text-gray-100 leading-snug">{displayName}</span>
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

        {/* Add manually toggle */}
        {!showManualAdd ? (
          <button
            type="button"
            onClick={() => setShowManualAdd(true)}
            className="mb-4 text-xs text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 font-medium transition-colors"
          >
            + Add manually
          </button>
        ) : (
          <div className="mb-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-4">
            <p className="text-xs font-semibold text-gray-700 dark:text-gray-200 mb-3">Add item manually</p>

            {/* Row 1: SKU + Product Title */}
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                  SKU <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={manualSku}
                  onChange={(e) => setManualSku(e.target.value)}
                  placeholder="e.g. SIM-001"
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-900 dark:text-gray-100"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                  Product Title <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={manualDesc}
                  onChange={(e) => setManualDesc(e.target.value)}
                  placeholder="e.g. Simms Waders"
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-900 dark:text-gray-100"
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
                  className="mb-3 text-xs text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 font-medium transition-colors"
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
                          className="w-40 border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-900 dark:text-gray-100"
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
                      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1.5 min-h-[34px]">
                        {opt.values.map((val) => (
                          <span
                            key={val}
                            className="inline-flex items-center gap-0.5 bg-indigo-100 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 text-xs font-medium rounded-full px-2 py-0.5"
                          >
                            {val}
                            <button
                              type="button"
                              onClick={() => removeOptionValue(optIdx, val)}
                              className="text-indigo-400 dark:text-indigo-500 hover:text-indigo-700 dark:hover:text-indigo-300 ml-0.5 leading-none"
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
                          className="flex-1 min-w-[140px] text-xs border-0 outline-none bg-transparent placeholder-gray-400 dark:placeholder-gray-500 py-0.5 dark:text-gray-100"
                        />
                      </div>
                    </div>
                  ))}
                  <div className="flex items-center gap-4">
                    {manualOptions.length < 3 && (
                      <button
                        type="button"
                        onClick={addOption}
                        className="text-xs text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 font-medium transition-colors"
                      >
                        + Add option
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => { setShowVariants(false); setManualOptions([]); setOptionValueInputs([]); }}
                      className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                    >
                      Remove variants
                    </button>
                  </div>
                  {combos.length > 0 && (
                    <p className="text-xs text-gray-600 dark:text-gray-300 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2">
                      Generates <strong>{combos.length}</strong> variant{combos.length !== 1 ? "s" : ""}:{" "}
                      {combos.slice(0, 4).map((c, i) => (
                        <span key={i}>
                          {i > 0 && <span className="text-gray-300 dark:text-gray-600 mx-1">·</span>}
                          {c.map((v) => v.value).join(" / ")}
                        </span>
                      ))}
                      {combos.length > 4 && <span className="text-gray-400 dark:text-gray-500"> +{combos.length - 4} more</span>}
                    </p>
                  )}
                </div>
              );
            })()}

            {/* Row 2: Quantity + Unit Cost */}
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                  Quantity <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  min="1"
                  value={manualQty}
                  onChange={(e) => setManualQty(e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-900 dark:text-gray-100"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                  Unit Cost <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={manualCost}
                  onChange={(e) => setManualCost(e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-900 dark:text-gray-100"
                />
              </div>
            </div>

            {/* Retail Price + Barcode */}
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                  Retail Price <span className="text-xs text-gray-400 dark:text-gray-500 font-normal">(optional)</span>
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={manualRetailPrice}
                  onChange={(e) => setManualRetailPrice(e.target.value)}
                  placeholder="0.00"
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-900 dark:text-gray-100"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                  Barcode <span className="text-xs text-gray-400 dark:text-gray-500 font-normal">(optional)</span>
                </label>
                <BarcodeInput
                  value={manualBarcode}
                  onChange={setManualBarcode}
                  placeholder="Scan or type barcode…"
                  inputClassName="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-900 dark:text-gray-100"
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
                    className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-xs font-medium rounded-lg px-3 py-1.5 transition-colors"
                  >
                    {comboCount > 1 ? `Add ${comboCount} variants` : "Add"}
                  </button>
                  <button
                    type="button"
                    onClick={resetManualForm}
                    className="text-xs font-medium text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-gray-100 rounded-lg px-3 py-1.5 border border-gray-300 dark:border-gray-600 hover:bg-white dark:hover:bg-gray-800 transition-colors"
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
          <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600 dark:text-gray-400">Product / SKU</th>
                  <th className="text-right px-4 py-2.5 font-medium text-gray-600 dark:text-gray-400 w-28">Qty</th>
                  <th className="text-right px-4 py-2.5 font-medium text-gray-600 dark:text-gray-400 w-32">Unit Cost</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600 dark:text-gray-400 w-44">Barcode</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {lineItems.map((item, idx) => (
                  <tr key={item.key} className={idx < lineItems.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : ""}>
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-gray-800 dark:text-gray-100">{item.description}</div>
                      {item.variantTitle && (
                        <div className="text-xs text-gray-500 dark:text-gray-400">{item.variantTitle}</div>
                      )}
                      <div className="text-xs text-gray-400 dark:text-gray-500 font-mono">{item.sku}</div>
                      {item.variantId === null && (
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
                      {item.inventoryItemId !== null &&
                        item.unitCost !== (item.shopifyCost ?? 0) && (
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
          className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-5 py-2.5 transition-colors"
        >
          {isSubmitting ? "Creating…" : "Create Invoice"}
        </button>
        <Link
          to="/invoices"
          className="text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-gray-100 rounded-lg px-5 py-2.5 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
        >
          Cancel
        </Link>
      </div>
    </Form>
  );
}

// ── Column mapping helpers ────────────────────────────────────────────────────

function guessCol(cols: string[], keywords: string[]): string {
  for (const kw of keywords) {
    const found = cols.find((c) => c.toLowerCase().includes(kw.toLowerCase()));
    if (found) return found;
  }
  return "";
}

function applyMapping(
  rows: Record<string, string>[],
  skuCol: string,
  descCol: string,
  qtyCol: string,
  costCol: string
) {
  return rows
    .filter((row) => descCol && row[descCol]?.trim())
    .map((row) => {
      const rawQty = qtyCol ? row[qtyCol] ?? "1" : "1";
      const rawCost = costCol ? row[costCol] ?? "0" : "0";
      const qty = parseInt(rawQty.replace(/[^\d]/g, "") || "1", 10) || 1;
      const cost = parseFloat(rawCost.replace(/[^\d.]/g, "") || "0") || 0;
      return {
        sku: { value: skuCol ? (row[skuCol] ?? "") : "", confidence: 0.95, flagged: false },
        description: { value: row[descCol] ?? "", confidence: 0.95, flagged: false },
        quantity: { value: qty, confidence: 0.95, flagged: false },
        unitCost: { value: cost, confidence: 0.95, flagged: false },
      };
    });
}

// ── LineItemsTable ────────────────────────────────────────────────────────────

type ExtractionField<T> = { value: T; confidence: number; flagged: boolean };

function LineItemsTable({
  items,
  addedItems = [],
  onRemoveAdded,
  onUpdateAdded,
}: {
  items: Array<{
    sku: ExtractionField<string>;
    description: ExtractionField<string>;
    quantity: ExtractionField<number>;
    unitCost: ExtractionField<number>;
  }>;
  addedItems?: ReviewAddedItem[];
  onRemoveAdded?: (key: string) => void;
  onUpdateAdded?: (key: string, field: "quantity" | "unitCost" | "barcode", value: string | number) => void;
}) {
  const [values, setValues] = useState(() =>
    items.map((item) => ({ qty: item.quantity.value, unitCost: item.unitCost.value, barcode: "" }))
  );

  const extractedTotal = values.reduce(
    (sum, v) => sum + (Number(v.qty) || 0) * (Number(v.unitCost) || 0),
    0
  );
  const addedTotal = addedItems.reduce(
    (sum, a) => sum + a.quantity * a.unitCost,
    0
  );
  const totalQty =
    values.reduce((sum, v) => sum + (Number(v.qty) || 0), 0) +
    addedItems.reduce((sum, a) => sum + a.quantity, 0);
  const totalAmount = extractedTotal + addedTotal;

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
          <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">SKU</th>
          <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Description</th>
          <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-400 w-28">Qty</th>
          <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-400 w-32">Unit Cost</th>
          <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400 w-44">Barcode</th>
          <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-400 w-32">Total</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item, i) => {
          const qty = Number(values[i]?.qty ?? item.quantity.value) || 0;
          const cost = Number(values[i]?.unitCost ?? item.unitCost.value) || 0;
          const barcode = values[i]?.barcode ?? "";
          return (
            <tr key={i} className="border-b border-gray-100 dark:border-gray-700">
              <td className="px-4 py-3">
                <div className="flex items-center gap-1">
                  {item.sku.flagged && <FlagIcon />}
                  <input
                    name={`sku_${i}`}
                    type="text"
                    defaultValue={item.sku.value}
                    className={`w-full border rounded-lg px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:text-gray-100 ${item.sku.flagged ? "border-amber-400 bg-amber-50 dark:border-amber-500 dark:bg-amber-950/30" : "border-gray-300 dark:border-gray-600 dark:bg-gray-800"}`}
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
                    className={`w-full border rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:text-gray-100 ${item.description.flagged ? "border-amber-400 bg-amber-50 dark:border-amber-500 dark:bg-amber-950/30" : "border-gray-300 dark:border-gray-600 dark:bg-gray-800"}`}
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
                    value={values[i]?.qty ?? item.quantity.value}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      setValues((prev) => prev.map((v, j) => (j === i ? { ...v, qty: n } : v)));
                    }}
                    className={`w-24 text-right border rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:text-gray-100 ${item.quantity.flagged ? "border-amber-400 bg-amber-50 dark:border-amber-500 dark:bg-amber-950/30" : "border-gray-300 dark:border-gray-600 dark:bg-gray-800"}`}
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
                    value={values[i]?.unitCost ?? item.unitCost.value}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      setValues((prev) => prev.map((v, j) => (j === i ? { ...v, unitCost: n } : v)));
                    }}
                    className={`w-28 text-right border rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:text-gray-100 ${item.unitCost.flagged ? "border-amber-400 bg-amber-50 dark:border-amber-500 dark:bg-amber-950/30" : "border-gray-300 dark:border-gray-600 dark:bg-gray-800"}`}
                  />
                </div>
              </td>
              <td className="px-4 py-3">
                <BarcodeInput
                  name={`barcode_${i}`}
                  value={barcode}
                  onChange={(v) => setValues((prev) => prev.map((val, j) => (j === i ? { ...val, barcode: v } : val)))}
                  placeholder="Scan or type…"
                  inputClassName="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100"
                />
              </td>
              <td className="px-4 py-3 text-right text-gray-600 dark:text-gray-400 tabular-nums">
                ${(qty * cost).toFixed(2)}
              </td>
            </tr>
          );
        })}
        {addedItems.map((item, j) => {
          const idx = items.length + j;
          return (
            <tr key={item.key} className="border-b border-gray-100 dark:border-gray-700 bg-indigo-50/30 dark:bg-indigo-950/20">
              <td className="px-4 py-3">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-indigo-600 dark:text-indigo-300 bg-indigo-100 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-700 rounded px-1 py-0.5 shrink-0">Added</span>
                  <input
                    name={`sku_${idx}`}
                    type="text"
                    defaultValue={item.sku}
                    className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100"
                  />
                </div>
              </td>
              <td className="px-4 py-3">
                <input
                  name={`description_${idx}`}
                  type="text"
                  defaultValue={item.description}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100"
                />
              </td>
              <td className="px-4 py-3">
                <input
                  name={`quantity_${idx}`}
                  type="number"
                  min="1"
                  value={item.quantity}
                  onChange={(e) => onUpdateAdded?.(item.key, "quantity", Number(e.target.value))}
                  className="w-24 text-right border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100"
                />
              </td>
              <td className="px-4 py-3">
                <input
                  name={`unitCost_${idx}`}
                  type="number"
                  min="0"
                  step="0.01"
                  value={item.unitCost}
                  onChange={(e) => onUpdateAdded?.(item.key, "unitCost", Number(e.target.value))}
                  className="w-28 text-right border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100"
                />
              </td>
              <td className="px-4 py-3">
                <BarcodeInput
                  name={`barcode_${idx}`}
                  value={item.barcode}
                  onChange={(v) => onUpdateAdded?.(item.key, "barcode", v)}
                  placeholder="Scan or type…"
                  inputClassName="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100"
                />
              </td>
              <td className="px-4 py-3 text-right text-gray-600 dark:text-gray-400 tabular-nums">
                <div className="flex items-center justify-end gap-2">
                  ${(item.quantity * item.unitCost).toFixed(2)}
                  <button
                    type="button"
                    onClick={() => onRemoveAdded?.(item.key)}
                    aria-label="Remove added item"
                    className="text-gray-400 hover:text-red-500 transition-colors text-lg leading-none"
                  >
                    ×
                  </button>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr className="bg-gray-100 dark:bg-gray-800 border-t-2 border-gray-300 dark:border-gray-600 text-sm font-semibold">
          <td className="px-4 py-3 text-gray-500 dark:text-gray-400" colSpan={2}>Totals</td>
          <td className="px-4 py-3 text-right text-gray-900 dark:text-gray-100 tabular-nums">{totalQty}</td>
          <td className="px-4 py-3 text-right text-gray-900 dark:text-gray-100 tabular-nums" colSpan={2}></td>
          <td className="px-4 py-3 text-right text-gray-900 dark:text-gray-100 tabular-nums">${totalAmount.toFixed(2)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

// ── AddItemSection ────────────────────────────────────────────────────────────

function AddItemSection({
  vendors,
  selectedVendorId,
  onAdd,
}: {
  vendors: Vendor[];
  selectedVendorId: string;
  onAdd: (item: ReviewAddedItem) => void;
}) {
  const [tab, setTab] = useState<"search" | "manual">("search");
  const keyCounter = useRef(0);

  const selectedVendor = vendors.find((v) => String(v.id) === selectedVendorId) ?? null;

  // Search state
  const searchFetcher = useFetcher<ProductSearchResult[]>();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchVendorFilter, setSearchVendorFilter] = useState(selectedVendor?.shopifyVendorName ?? "");
  const [showDropdown, setShowDropdown] = useState(false);

  useEffect(() => {
    setSearchVendorFilter(selectedVendor?.shopifyVendorName ?? "");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVendorId]);

  useEffect(() => {
    if (searchQuery.length < 2) { setShowDropdown(false); return; }
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

  // Manual add state
  const [manualSku, setManualSku] = useState("");
  const [manualDesc, setManualDesc] = useState("");
  const [manualQty, setManualQty] = useState("1");
  const [manualCost, setManualCost] = useState("0.00");
  const [manualBarcode, setManualBarcode] = useState("");

  const shopifyVendorNames = [...new Set(
    vendors.map((v) => v.shopifyVendorName).filter((n): n is string => !!n)
  )].sort();

  function addFromSearch(result: ProductSearchResult) {
    onAdd({
      key: String(++keyCounter.current),
      sku: result.sku,
      description: result.productTitle,
      quantity: 1,
      unitCost: result.unitCost ?? 0,
      barcode: result.barcode ?? "",
      variantId: result.variantId,
      inventoryItemId: result.inventoryItemId,
    });
    setSearchQuery("");
    setShowDropdown(false);
  }

  function addManually() {
    const qty = parseInt(manualQty, 10);
    const cost = parseFloat(manualCost);
    if (!manualSku.trim() || !manualDesc.trim() || isNaN(qty) || qty < 1 || isNaN(cost) || cost < 0) return;
    onAdd({
      key: String(++keyCounter.current),
      sku: manualSku.trim(),
      description: manualDesc.trim(),
      quantity: qty,
      unitCost: cost,
      barcode: manualBarcode.trim(),
      variantId: null,
      inventoryItemId: null,
    });
    setManualSku("");
    setManualDesc("");
    setManualQty("1");
    setManualCost("0.00");
    setManualBarcode("");
  }

  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-6 mb-6">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-4">Add Item</h3>

      <div className="flex gap-1 mb-5 border-b border-gray-200 dark:border-gray-700">
        <button
          type="button"
          onClick={() => setTab("search")}
          className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
            tab === "search" ? "border-indigo-500 text-indigo-600 dark:text-indigo-400" : "border-transparent text-gray-500 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          }`}
        >
          Search Shopify
        </button>
        <button
          type="button"
          onClick={() => setTab("manual")}
          className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
            tab === "manual" ? "border-indigo-500 text-indigo-600 dark:text-indigo-400" : "border-transparent text-gray-500 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          }`}
        >
          Add manually
        </button>
      </div>

      {tab === "search" && (
        <div>
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
          <div className="relative">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onFocus={() => searchQuery.length >= 2 && setShowDropdown(true)}
              onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
              placeholder="Search Shopify products by name or SKU…"
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
                <div className="max-h-56 overflow-y-auto">
                  {searchResults.length === 0 && !isSearching && (
                    <p className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">No products found.</p>
                  )}
                  {searchResults.map((result) => {
                    const displayName =
                      result.variantTitle && result.variantTitle !== "Default Title"
                        ? `${result.productTitle} — ${result.variantTitle}`
                        : result.productTitle;
                    return (
                      <div
                        key={result.variantId}
                        onClick={() => addFromSearch(result)}
                        className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer border-b border-gray-100 dark:border-gray-700 last:border-0 transition-colors"
                      >
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-medium text-gray-800 dark:text-gray-100 leading-snug">{displayName}</span>
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
              </div>
            )}
          </div>
        </div>
      )}

      {tab === "manual" && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">SKU <span className="text-red-500">*</span></label>
              <input
                type="text"
                value={manualSku}
                onChange={(e) => setManualSku(e.target.value)}
                placeholder="e.g. SIM-001"
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Description <span className="text-red-500">*</span></label>
              <input
                type="text"
                value={manualDesc}
                onChange={(e) => setManualDesc(e.target.value)}
                placeholder="e.g. Simms Waders"
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100"
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Qty <span className="text-red-500">*</span></label>
              <input
                type="number"
                min="1"
                value={manualQty}
                onChange={(e) => setManualQty(e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Unit Cost <span className="text-red-500">*</span></label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={manualCost}
                onChange={(e) => setManualCost(e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Barcode</label>
              <BarcodeInput
                value={manualBarcode}
                onChange={setManualBarcode}
                onCommit={() => addManually()}
                placeholder="Scan or type…"
                inputClassName="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100"
              />
            </div>
          </div>
          <button
            type="button"
            onClick={addManually}
            disabled={!manualSku.trim() || !manualDesc.trim()}
            className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-xs font-medium rounded-lg px-3 py-1.5 transition-colors"
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}

// ── ReviewScreen ──────────────────────────────────────────────────────────────

function ReviewScreen({
  extraction,
  vendors: initialVendors,
  matchedVendorId: initialMatchedVendorId,
}: {
  extraction: ExtendedExtractionResult;
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

  // Column mapping — only active when the parser flagged low confidence AND
  // returned raw table data AND there is no saved vendor profile yet.
  const showMapping =
    extraction.requiresManualReview &&
    !extraction.vendorProfileFound &&
    !!extraction.rawTableData?.length;

  const rawCols = extraction.rawTableData?.length
    ? Object.keys(extraction.rawTableData[0])
    : [];

  const [skuCol, setSkuCol] = useState(() =>
    guessCol(rawCols, ["sku", "item #", "item no", "part #", "code", "product #"])
  );
  const [descCol, setDescCol] = useState(() =>
    guessCol(rawCols, ["description", "desc", "product name", "item name", "name"])
  );
  const [qtyCol, setQtyCol] = useState(() =>
    guessCol(rawCols, ["qty", "quantity", "units", "ordered"])
  );
  const [costCol, setCostCol] = useState(() =>
    guessCol(rawCols, ["unit cost", "unit price", "price each", "each", "cost each"])
  );
  // Bumping this key forces the line items table to remount with fresh defaultValues.
  const [mappingVersion, setMappingVersion] = useState(0);

  function updateMapping(
    field: "sku" | "desc" | "qty" | "cost",
    value: string
  ) {
    if (field === "sku") setSkuCol(value);
    else if (field === "desc") setDescCol(value);
    else if (field === "qty") setQtyCol(value);
    else setCostCol(value);
    setMappingVersion((v) => v + 1);
  }

  const activeLineItems =
    showMapping && extraction.rawTableData
      ? applyMapping(extraction.rawTableData, skuCol, descCol, qtyCol, costCol)
      : extraction.lineItems;

  // Items added via AddItemSection
  const [addedItems, setAddedItems] = useState<ReviewAddedItem[]>([]);

  function handleAddItem(item: ReviewAddedItem) {
    setAddedItems((prev) => [...prev, item]);
  }

  function handleRemoveAdded(key: string) {
    setAddedItems((prev) => prev.filter((i) => i.key !== key));
  }

  function handleUpdateAdded(key: string, field: "quantity" | "unitCost" | "barcode", value: string | number) {
    setAddedItems((prev) =>
      prev.map((i) => (i.key === key ? { ...i, [field]: value } : i))
    );
  }

  const isCreating = fetcher.state === "submitting";
  const createError = fetcher.data?.error ?? null;
  const vendorNotMatched = initialMatchedVendorId === null && selectedVendorId === "";

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
        <Link to="/invoices" className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors">
          ← Purchase Orders
        </Link>
        <span className="text-gray-300 dark:text-gray-600">/</span>
        <Link to="/invoices/upload" className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors">
          Upload Invoice
        </Link>
        <span className="text-gray-300 dark:text-gray-600">/</span>
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Review Extraction</h2>
      </div>

      {showMapping && (
        <div className="mb-6 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-xl p-5">
          <p className="text-sm font-semibold text-amber-800 dark:text-amber-300 mb-1">Column mapping required</p>
          <p className="text-xs text-amber-700 dark:text-amber-400 mb-4">
            Low-confidence extraction — tell us which PDF columns map to each field. The line
            items table will update live. This mapping is saved automatically when you confirm.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {(
              [
                { label: "SKU", value: skuCol, onChange: (v: string) => updateMapping("sku", v) },
                { label: "Description *", value: descCol, onChange: (v: string) => updateMapping("desc", v) },
                { label: "Quantity", value: qtyCol, onChange: (v: string) => updateMapping("qty", v) },
                { label: "Unit Cost", value: costCol, onChange: (v: string) => updateMapping("cost", v) },
              ] as { label: string; value: string; onChange: (v: string) => void }[]
            ).map(({ label, value, onChange }) => (
              <div key={label}>
                <label className="block text-xs font-medium text-amber-800 dark:text-amber-300 mb-1">{label}</label>
                <select
                  value={value}
                  onChange={(e) => onChange(e.target.value)}
                  className="w-full border border-amber-300 dark:border-amber-700 rounded-lg px-2 py-1.5 text-sm bg-white dark:bg-amber-950/40 dark:text-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-400"
                >
                  <option value="">— None —</option>
                  {rawCols.map((col) => (
                    <option key={col} value={col}>{col}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      {flagCount > 0 && !showMapping && (
        <div className="mb-6 flex items-center gap-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-xl px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-400 text-white text-xs font-bold">!</span>
          <strong>{flagCount} field{flagCount !== 1 ? "s" : ""} flagged for review.</strong>
          <span className="text-amber-700 dark:text-amber-400">Low-confidence extractions are highlighted. Please verify before saving.</span>
        </div>
      )}

      <Form method="post">
        <input type="hidden" name="intent" value="confirmPdf" />
        <input type="hidden" name="itemCount" value={String(activeLineItems.length + addedItems.length)} />

        {/* Hidden column mapping inputs — saved as vendor profile on submit */}
        {showMapping && (
          <>
            <input type="hidden" name="skuColumn" value={skuCol} />
            <input type="hidden" name="descColumn" value={descCol} />
            <input type="hidden" name="qtyColumn" value={qtyCol} />
            <input type="hidden" name="costColumn" value={costCol} />
          </>
        )}

        {/* Header fields */}
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-6 mb-6">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Vendor <span className="text-red-500">*</span>
                {extraction.vendorName.flagged && <FlagIcon />}
                {!extraction.vendorName.flagged && <ConfidencePct value={extraction.vendorName.confidence} />}
              </label>

              {vendorNotMatched && !showCreateForm && (
                <p className="mb-1.5 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-700 rounded px-2 py-1">
                  "{extraction.vendorName.value}" not found — select or create below.
                </p>
              )}

              <select
                name="vendorId"
                value={selectedVendorId}
                onChange={(e) => setSelectedVendorId(e.target.value)}
                className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:text-gray-100 ${
                  vendorNotMatched && !showCreateForm ? "border-amber-400 bg-amber-50 dark:border-amber-500 dark:bg-amber-950/30" : "border-gray-300 dark:border-gray-600 dark:bg-gray-800"
                }`}
              >
                <option value="" disabled>Select a vendor…</option>
                {vendorsList.map((v) => (
                  <option key={v.id} value={String(v.id)}>{v.name}</option>
                ))}
              </select>

              {!showCreateForm && (
                <button
                  type="button"
                  onClick={() => setShowCreateForm(true)}
                  className="mt-2 text-xs text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 font-medium transition-colors"
                >
                  + Create new vendor
                </button>
              )}

              {showCreateForm && (
                <div className="mt-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-4">
                  <p className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-2">New Vendor Name</p>
                  <div className="flex flex-col gap-2">
                    <input
                      type="text"
                      value={newVendorName}
                      onChange={(e) => setNewVendorName(e.target.value)}
                      placeholder="e.g. Simms Fishing"
                      className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-900 dark:text-gray-100"
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
                        className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-xs font-medium rounded-lg px-3 py-1.5 transition-colors"
                      >
                        {isCreating ? "Creating…" : "Create"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowCreateForm(false)}
                        className="text-xs font-medium text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 rounded-lg px-3 py-1.5 border border-gray-300 dark:border-gray-600 hover:bg-white dark:hover:bg-gray-700 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Invoice Number <span className="text-red-500">*</span>
                {extraction.invoiceNumber.flagged ? <FlagIcon /> : <ConfidencePct value={extraction.invoiceNumber.confidence} />}
              </label>
              <input
                name="invoiceNumber"
                type="text"
                defaultValue={extraction.invoiceNumber.value}
                className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:text-gray-100 ${extraction.invoiceNumber.flagged ? "border-amber-400 bg-amber-50 dark:border-amber-500 dark:bg-amber-950/30" : "border-gray-300 dark:border-gray-600 dark:bg-gray-800"}`}
              />
            </div>

            <PaymentTermsFields
              initialInvoiceDate={extraction.invoiceDate?.value ?? ""}
              initialDueDate={extraction.dueDate.value ?? ""}
              dueDateFlagged={extraction.dueDate.flagged}
            />
          </div>
        </div>

        {/* Line items — key forces remount (and state reset) when column mapping changes */}
        <div key={mappingVersion} className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden mb-6">
          <LineItemsTable
            items={activeLineItems}
            addedItems={addedItems}
            onRemoveAdded={handleRemoveAdded}
            onUpdateAdded={handleUpdateAdded}
          />
        </div>

        <AddItemSection
          vendors={vendorsList}
          selectedVendorId={selectedVendorId}
          onAdd={handleAddItem}
        />

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={isSubmitting}
            className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-5 py-2.5 transition-colors"
          >
            {isSubmitting ? "Saving…" : "Confirm & Save"}
          </button>
          <Link
            to="/invoices/upload"
            className="text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 rounded-lg px-5 py-2.5 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
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
          extraction={actionData.extraction as ExtendedExtractionResult}
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
        <Link to="/invoices" className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors">
          ← Purchase Orders
        </Link>
        <span className="text-gray-300 dark:text-gray-600">/</span>
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Upload Invoice</h2>
      </div>

      {/* Upload type selector */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <button
          type="button"
          onClick={() => setUploadMode("csv")}
          className={`flex flex-col items-center justify-center gap-2 rounded-2xl border-2 px-6 py-8 transition-colors ${
            uploadMode === "csv"
              ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/30 dark:border-indigo-600 cursor-default"
              : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:border-gray-300 dark:hover:border-gray-600 cursor-pointer"
          }`}
        >
          <svg className={`w-8 h-8 ${uploadMode === "csv" ? "text-indigo-600 dark:text-indigo-400" : "text-gray-400 dark:text-gray-500"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <span className={`text-sm font-medium ${uploadMode === "csv" ? "text-indigo-700 dark:text-indigo-400" : "text-gray-600 dark:text-gray-400"}`}>Upload CSV</span>
        </button>

        <button
          type="button"
          onClick={() => setUploadMode("pdf")}
          className={`flex flex-col items-center justify-center gap-2 rounded-2xl border-2 px-6 py-8 transition-colors ${
            uploadMode === "pdf"
              ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/30 dark:border-indigo-600 cursor-default"
              : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:border-gray-300 dark:hover:border-gray-600 cursor-pointer"
          }`}
        >
          <svg className={`w-8 h-8 ${uploadMode === "pdf" ? "text-indigo-600 dark:text-indigo-400" : "text-gray-400 dark:text-gray-500"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
          <span className={`text-sm font-medium ${uploadMode === "pdf" ? "text-indigo-700 dark:text-indigo-400" : "text-gray-600 dark:text-gray-400"}`}>Upload PDF</span>
        </button>

        <button
          type="button"
          onClick={() => setUploadMode("manual")}
          className={`flex flex-col items-center justify-center gap-2 rounded-2xl border-2 px-6 py-8 transition-colors ${
            uploadMode === "manual"
              ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/30 dark:border-indigo-600 cursor-default"
              : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:border-gray-300 dark:hover:border-gray-600 cursor-pointer"
          }`}
        >
          <svg className={`w-8 h-8 ${uploadMode === "manual" ? "text-indigo-600 dark:text-indigo-400" : "text-gray-400 dark:text-gray-500"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          <span className={`text-sm font-medium ${uploadMode === "manual" ? "text-indigo-700 dark:text-indigo-400" : "text-gray-600 dark:text-gray-400"}`}>Manual Entry</span>
        </button>
      </div>

      {uploadMode === "manual" && (
        <ManualEntryForm vendors={vendors} errors={manualErrors} />
      )}

      {uploadMode !== "manual" && <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-8">
        {general && (
          <p className="mb-5 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg px-4 py-2">
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
              <label htmlFor="pdfFile" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                PDF Invoice <span className="text-red-500">*</span>
              </label>
              <input
                id="pdfFile"
                name="pdfFile"
                type="file"
                accept=".pdf"
                className="w-full text-sm text-gray-600 dark:text-gray-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-gray-300 dark:file:border-gray-600 file:text-sm file:font-medium file:bg-gray-50 dark:file:bg-gray-800 dark:file:text-indigo-400 hover:file:bg-gray-100 dark:hover:file:bg-gray-700 file:cursor-pointer"
              />
              {errors.pdfFile && <p className="mt-1 text-xs text-red-600">{errors.pdfFile}</p>}
              <p className="mt-1.5 text-xs text-gray-400 dark:text-gray-500">
                Extracts vendor, invoice number, date, due date, and all line items automatically.
              </p>
            </div>

            <div className="flex gap-3 pt-2">
              <button
                type="submit"
                disabled={isExtracting}
                className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-5 py-2 transition-colors"
              >
                {isExtracting ? "Extracting…" : "Extract Invoice"}
              </button>
              <Link
                to="/invoices"
                className="text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 rounded-lg px-5 py-2 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
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
