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
import type { ProductSearchResult, ShopifyProduct } from "../services/shopify.server";
import { lookupProduct, updateInventoryItemCost, createDraftProduct, createDraftProductWithVariants, updateVariantPrice } from "../services/shopify.server";
import type { DraftProductVariantInput } from "../services/shopify.server";

// Flexible CSV column lookup — checks multiple header name variants
function findCsvColumn(row: Record<string, string>, candidates: string[]): string {
  for (const candidate of candidates) {
    const value = row[candidate];
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return "";
}

// Convert common date formats to YYYY-MM-DD for <input type="date">
function parseDateToInputFormat(dateStr: string): string {
  if (!dateStr) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  const mdySlash = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdySlash) return `${mdySlash[3]}-${mdySlash[1].padStart(2, "0")}-${mdySlash[2].padStart(2, "0")}`;
  const mdyDash = dateStr.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (mdyDash) return `${mdyDash[3]}-${mdyDash[1].padStart(2, "0")}-${mdyDash[2].padStart(2, "0")}`;
  return "";
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const db = getDb();
  const [vendors, suppliers] = await Promise.all([
    db.vendor.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, shopifyVendorName: true, supplierId: true },
    }),
    db.supplier.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  return { vendors, suppliers };
}

export async function action({ request }: Route.ActionArgs) {
  await requireUserId(request);

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "uploadCsv");

  // ── CSV path ──────────────────────────────────────────────────────────────
  if (intent === "uploadCsv") {
    const vendorIdRaw = String(form.get("vendorId") ?? "").trim();
    const vendorId = vendorIdRaw === "0" || vendorIdRaw === "undefined" || vendorIdRaw === "null" ? "" : vendorIdRaw;
    const supplierIdRaw = String(form.get("supplierId") ?? "").trim();
    console.log("[uploadCsv] raw vendorId:", form.get("vendorId"), "→ resolved:", vendorId, "| raw supplierId:", form.get("supplierId"), "→ resolved:", supplierIdRaw);
    const paymentTermsRaw = String(form.get("paymentTerms") ?? "").trim();
    const dueDateRaw = String(form.get("dueDate") ?? "").trim();
    const csvFile = form.get("csvFile");

    const errors: Record<string, string> = {};
    if (!vendorId && !supplierIdRaw) errors.vendorId = "Please select either a Vendor or Supplier.";

    // Parse CSV before validation so we can extract invoice metadata as fallbacks
    type LineItem = { sku: string; description: string; quantity: number; unitCost: number; barcode: string | null };
    let parsedRows: Record<string, string>[] = [];
    if (csvFile instanceof File && csvFile.size > 0) {
      const csvText = await csvFile.text();
      const parsed = Papa.parse<Record<string, string>>(csvText, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (h) => h.trim(),
      });
      parsedRows = parsed.data;
    } else {
      errors.csvFile = "Please select a CSV file.";
    }

    // Use form values, falling back to CSV metadata if fields are blank
    const firstRow = parsedRows[0] ?? {};
    let invoiceNumber = String(form.get("invoiceNumber") ?? "").trim();
    let invoiceDateRaw = String(form.get("invoiceDate") ?? "").trim();
    if (!invoiceNumber) {
      invoiceNumber = findCsvColumn(firstRow, ["Invoice Number", "invoice_number", "Invoice #", "Invoice No"]);
    }
    if (!invoiceDateRaw) {
      invoiceDateRaw = findCsvColumn(firstRow, ["Invoice Date", "invoice_date", "Date"]);
    }

    if (!invoiceNumber) errors.invoiceNumber = "Invoice number is required.";
    if (Object.keys(errors).length > 0) {
      return data({ step: "uploadCsv" as const, errors, general: null }, { status: 400 });
    }

    const lineItems: LineItem[] = [];
    let zeroQtyCount = 0;
    for (const row of parsedRows) {
      const sku = findCsvColumn(row, ["SKU", "sku", "Item Code", "item_code", "Item #"]);
      const description = findCsvColumn(row, ["Product Name", "description", "Description", "product_name", "Item Description", "Name"]);
      const quantityStr = findCsvColumn(row, ["Quantity", "quantity", "Qty", "qty", "QTY"]);
      const unitCostStr = findCsvColumn(row, ["Unit Cost", "unit_cost", "Cost", "Price", "Unit Price", "unit_price"]).replace(/[$,]/g, "");
      const barcode = findCsvColumn(row, ["Barcode", "barcode", "UPC", "EAN", "upc", "ean"]) || null;
      const quantity = parseInt(quantityStr, 10);
      const unitCost = parseFloat(unitCostStr);
      if (!sku || !description || isNaN(quantity) || isNaN(unitCost) || unitCost < 0) continue;
      if (quantity <= 0) { zeroQtyCount++; continue; }
      lineItems.push({ sku, description, quantity, unitCost, barcode });
    }

    if (lineItems.length === 0) {
      return data(
        { step: "uploadCsv" as const, errors: {}, general: "No valid line items found. Check that the CSV has SKU, Product Name, Quantity, and Unit Cost columns with at least one complete row." },
        { status: 400 }
      );
    }

    const total = lineItems.reduce((sum, item) => sum + item.quantity * item.unitCost, 0);
    const invoiceDate = invoiceDateRaw ? new Date(invoiceDateRaw) : null;
    const paymentTerms = paymentTermsRaw || null;
    const dueDate = dueDateRaw ? new Date(dueDateRaw) : null;
    const supplierId = supplierIdRaw ? Number(supplierIdRaw) : null;
    const resolvedVendorId = vendorId ? Number(vendorId) : null;
    const invoice = await getDb().$transaction(async (tx) => {
      const created = await tx.invoice.create({
        data: { invoiceNumber, vendorId: resolvedVendorId, supplierId, status: "ORDERED", invoiceDate, paymentTerms, dueDate, total },
      });
      await tx.invoiceLineItem.createMany({
        data: lineItems.map((item) => ({
          invoiceId: created.id,
          vendorId: resolvedVendorId,
          sku: item.sku,
          description: item.description,
          quantityOrdered: item.quantity,
          unitCost: item.unitCost,
          barcode: item.barcode,
        })),
      });
      return created;
    });

    // Auto-match saved line items against Shopify using multiple SKU strategies + barcode
    const savedItems = await getDb().invoiceLineItem.findMany({
      where: { invoiceId: invoice.id, sku: { not: null } },
      select: { id: true, sku: true, barcode: true, unitCost: true },
    });
    let matchCount = 0;
    let skuMatchCount = 0;
    let barcodeMatchCount = 0;
    let loggedCsvMatches = 0;
    for (const item of savedItems) {
      const raw = item.sku!;
      const stripped = parseInt(raw, 10);
      const skuVariants = [...new Set([
        raw,
        raw.toUpperCase(),
        raw.toLowerCase(),
        isNaN(stripped) ? null : String(stripped),
      ].filter(Boolean) as string[])];

      let matched = false;
      for (const sku of skuVariants) {
        if (matched) break;
        try {
          const result = await lookupProduct({ sku });
          if (result?.product.variants[0]) {
            const { product, matchedBy } = result;
            const variant = product.variants[0];
            await getDb().invoiceLineItem.update({
              where: { id: item.id },
              data: {
                shopifyProductTitle: product.title,
                shopifyVariantId: variant.id,
                shopifyInventoryItemId: variant.inventoryItemId,
                ...(!item.barcode && variant.barcode ? { barcode: variant.barcode } : {}),
                ...(variant.price ? { retailPrice: parseFloat(variant.price) } : {}),
              },
            });
            try {
              await updateInventoryItemCost(variant.inventoryItemId, item.unitCost.toNumber());
            } catch (err) {
              await logFailure("shopify:set-cost", item.sku!, `Cost update failed for inventoryItem ${variant.inventoryItemId}: ${err instanceof Error ? err.message : String(err)}`);
            }
            if (loggedCsvMatches < 5) {
              console.log(`[CSV match] SKU: ${item.sku}, variantId: ${variant.id}, price: ${variant.price ?? "null"}`);
              loggedCsvMatches++;
            }
            matchCount++;
            if (matchedBy === "sku") skuMatchCount++; else barcodeMatchCount++;
            matched = true;
          }
        } catch { /* ignore individual lookup errors */ }
      }

      // Fallback: try item's barcode directly if SKU strategies all missed
      if (!matched && item.barcode) {
        try {
          const result = await lookupProduct({ barcode: item.barcode });
          if (result?.product.variants[0]) {
            const { product } = result;
            const variant = product.variants[0];
            await getDb().invoiceLineItem.update({
              where: { id: item.id },
              data: {
                shopifyProductTitle: product.title,
                shopifyVariantId: variant.id,
                shopifyInventoryItemId: variant.inventoryItemId,
                ...(variant.price ? { retailPrice: parseFloat(variant.price) } : {}),
              },
            });
            try {
              await updateInventoryItemCost(variant.inventoryItemId, item.unitCost.toNumber());
            } catch (err) {
              await logFailure("shopify:set-cost", item.sku!, `Cost update failed for inventoryItem ${variant.inventoryItemId}: ${err instanceof Error ? err.message : String(err)}`);
            }
            if (loggedCsvMatches < 5) {
              console.log(`[CSV match] SKU: ${item.sku} (barcode fallback), variantId: ${variant.id}, price: ${variant.price ?? "null"}`);
              loggedCsvMatches++;
            }
            matchCount++;
            barcodeMatchCount++;
          }
        } catch { /* ignore */ }
      }
    }
    if (savedItems.length > 0) {
      console.log(`CSV import match: ${matchCount} / ${savedItems.length} items linked (${skuMatchCount} by SKU, ${barcodeMatchCount} by barcode)`);
    }

    const importParams = new URLSearchParams({ imported: String(lineItems.length) });
    if (zeroQtyCount > 0) importParams.set("skippedZero", String(zeroQtyCount));
    return redirect(`/invoices/${invoice.id}?${importParams}`);
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
    const supplierIdRaw = String(form.get("supplierId") ?? "").trim();
    const invoiceNumber = String(form.get("invoiceNumber") ?? "").trim();
    const invoiceDateRaw = String(form.get("invoiceDate") ?? "").trim();
    const paymentTermsRaw = String(form.get("paymentTerms") ?? "").trim();
    const dueDateRaw = String(form.get("dueDate") ?? "").trim();
    const itemCount = parseInt(String(form.get("itemCount") ?? "0"), 10);

    const errors: Record<string, string> = {};
    if (!vendorId && !supplierIdRaw) errors.vendorId = "Please select either a Vendor or Supplier.";
    if (!invoiceNumber) errors.invoiceNumber = "Invoice number is required.";

    type LineItem = { sku: string; description: string; quantity: number; unitCost: number; barcode: string | null; retailPrice: number | null };
    const lineItems: LineItem[] = [];
    for (let i = 0; i < itemCount; i++) {
      const sku = String(form.get(`sku_${i}`) ?? "").trim();
      const description = String(form.get(`description_${i}`) ?? "").trim();
      const quantity = parseInt(String(form.get(`quantity_${i}`) ?? ""), 10);
      const unitCost = parseFloat(String(form.get(`unitCost_${i}`) ?? ""));
      const barcode = String(form.get(`barcode_${i}`) ?? "").trim() || null;
      const retailPriceRaw = parseFloat(String(form.get(`retailPrice_${i}`) ?? ""));
      const retailPrice = !isNaN(retailPriceRaw) && retailPriceRaw > 0 ? retailPriceRaw : null;
      if (!sku || !description || isNaN(quantity) || isNaN(unitCost) || quantity <= 0 || unitCost < 0) continue;
      lineItems.push({ sku, description, quantity, unitCost, barcode, retailPrice });
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
    const supplierId = supplierIdRaw ? Number(supplierIdRaw) : null;
    const resolvedVendorId = vendorId ? Number(vendorId) : null;

    const invoice = await getDb().$transaction(async (tx) => {
      const created = await tx.invoice.create({
        data: { invoiceNumber, vendorId: resolvedVendorId, supplierId, status: "ORDERED", invoiceDate, paymentTerms, dueDate, total },
      });
      await tx.invoiceLineItem.createMany({
        data: lineItems.map((item) => ({
          invoiceId: created.id,
          vendorId: resolvedVendorId,
          sku: item.sku,
          description: item.description,
          quantityOrdered: item.quantity,
          unitCost: item.unitCost,
          barcode: item.barcode,
          ...(item.retailPrice !== null ? { retailPrice: item.retailPrice } : {}),
        })),
      });
      return created;
    });

    // Auto-match line items against Shopify using multiple SKU strategies + barcode
    const savedItems = await getDb().invoiceLineItem.findMany({
      where: { invoiceId: invoice.id, sku: { not: null } },
      select: { id: true, sku: true, barcode: true, retailPrice: true, unitCost: true },
    });
    if (savedItems.length > 0) {
      let matchCount = 0;
      let skuMatchCount = 0;
      let barcodeMatchCount = 0;
      let loggedPdfMatches = 0;
      for (const item of savedItems) {
        const raw = item.sku!;

        // Exact-only variants — no truncation applied here
        const exactSkuVariants = [...new Set([raw, raw.toUpperCase(), raw.toLowerCase()])];

        // Stripped numeric is a last-resort fallback: parseInt("14334-359-34R") = 14334,
        // which could match an unrelated BETTS product that happens to have SKU "14334".
        // Only try it after barcode, and reject it if the raw PDF SKU starts with the
        // matched SKU (indicating a prefix/truncation false-positive).
        const strippedInt = parseInt(raw, 10);
        const strippedVariant = !isNaN(strippedInt) && String(strippedInt) !== raw ? String(strippedInt) : null;

        const saveMatch = async (product: ShopifyProduct, matchedBy: "sku" | "barcode") => {
          const variant = product.variants[0];
          await getDb().invoiceLineItem.update({
            where: { id: item.id },
            data: {
              shopifyProductTitle: product.title,
              shopifyVariantId: variant.id,
              shopifyInventoryItemId: variant.inventoryItemId,
              ...(!item.barcode && variant.barcode ? { barcode: variant.barcode } : {}),
              ...(variant.price ? { retailPrice: parseFloat(variant.price) } : {}),
            },
          });
          try {
            await updateInventoryItemCost(variant.inventoryItemId, item.unitCost.toNumber());
          } catch (err) {
            await logFailure("shopify:set-cost", item.sku!, `Cost update failed for inventoryItem ${variant.inventoryItemId}: ${err instanceof Error ? err.message : String(err)}`);
          }
          if (loggedPdfMatches < 5) {
            console.log(`[PDF match] SKU: ${item.sku}, variantId: ${variant.id}, price: ${variant.price ?? "null"}, via: ${matchedBy}`);
            loggedPdfMatches++;
          }
          matchCount++;
          if (matchedBy === "sku") skuMatchCount++; else barcodeMatchCount++;
        };

        let matched = false;

        // 1. Try exact SKU variants (no truncation)
        for (const sku of exactSkuVariants) {
          if (matched) break;
          try {
            const result = await lookupProduct({ sku });
            if (result?.product.variants[0]) {
              await saveMatch(result.product, result.matchedBy);
              matched = true;
            }
          } catch { /* ignore */ }
        }

        // 2. Try barcode before stripped-numeric — barcode is globally unique and reliable
        if (!matched && item.barcode) {
          try {
            const result = await lookupProduct({ barcode: item.barcode });
            if (result?.product.variants[0]) {
              await saveMatch(result.product, "barcode");
              matched = true;
            }
          } catch { /* ignore */ }
        }

        // 3. Stripped-numeric last resort — reject if the raw PDF SKU starts with the
        //    matched variant's SKU (e.g. raw="14334-359-34R", matched="14334" → reject)
        if (!matched && strippedVariant) {
          try {
            const result = await lookupProduct({ sku: strippedVariant });
            if (result?.product.variants[0]) {
              const matchedSku = result.product.variants[0].sku ?? "";
              const isPrefixFalsePositive =
                raw.toLowerCase() !== matchedSku.toLowerCase() &&
                raw.toLowerCase().startsWith(matchedSku.toLowerCase());
              if (!isPrefixFalsePositive) {
                await saveMatch(result.product, result.matchedBy);
                matched = true;
              } else {
                console.log(`[PDF match] rejected stripped-SKU match: raw="${raw}" starts with matched="${matchedSku}" — likely truncation`);
              }
            }
          } catch { /* ignore */ }
        }
      }
      console.log(`PDF import match: ${matchCount} / ${savedItems.length} items linked (${skuMatchCount} by SKU, ${barcodeMatchCount} by barcode)`);
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
    const supplierIdRaw = String(form.get("supplierId") ?? "").trim();
    const invoiceNumber = String(form.get("invoiceNumber") ?? "").trim();
    const invoiceDateRaw = String(form.get("invoiceDate") ?? "").trim();
    const paymentTermsRaw = String(form.get("paymentTerms") ?? "").trim();
    const dueDateRaw = String(form.get("dueDate") ?? "").trim();
    const shippingCostRaw = String(form.get("shippingCost") ?? "0");
    const adjustmentsRaw = String(form.get("adjustments") ?? "0");
    const lineItemsRaw = String(form.get("lineItems") ?? "[]");

    const errors: Record<string, string> = {};
    if (!vendorId && !supplierIdRaw) errors.vendorId = "Please select either a Vendor or Supplier.";
    if (!invoiceNumber) errors.invoiceNumber = "Invoice number is required.";

    type ManualLineItem = {
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
      barcode?: string;
      vendorId?: string;
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

    const shippingCostVal = parseFloat(shippingCostRaw) || 0;
    const adjustmentsVal = parseFloat(adjustmentsRaw) || 0;
    const subtotal = lineItems.reduce((sum, item) => sum + item.quantity * item.unitCost, 0);
    const total = subtotal + shippingCostVal + adjustmentsVal;
    const invoiceDate = invoiceDateRaw ? new Date(invoiceDateRaw) : null;
    const paymentTerms = paymentTermsRaw || null;
    const dueDate = dueDateRaw ? new Date(dueDateRaw) : null;
    const supplierId = supplierIdRaw ? Number(supplierIdRaw) : null;

    // Compute primary vendor: most common per-item vendorId, fallback to form field
    const itemVendorCounts = new Map<number, number>();
    for (const item of lineItems) {
      const vid = item.vendorId ? Number(item.vendorId) : Number(vendorId);
      if (vid) itemVendorCounts.set(vid, (itemVendorCounts.get(vid) ?? 0) + 1);
    }
    const primaryVendorId = itemVendorCounts.size > 0
      ? [...itemVendorCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]
      : (vendorId ? Number(vendorId) : null);

    const { created: invoice, savedLineItems } = await getDb().$transaction(async (tx) => {
      const created = await tx.invoice.create({
        data: {
          invoiceNumber,
          vendorId: primaryVendorId,
          supplierId,
          status: "ORDERED",
          invoiceDate,
          paymentTerms,
          dueDate,
          total,
          shippingCost: shippingCostVal || null,
          adjustments: adjustmentsVal || null,
        },
      });
      const saved = await tx.invoiceLineItem.createManyAndReturn({
        data: lineItems.map((item) => ({
          invoiceId: created.id,
          vendorId: item.vendorId ? Number(item.vendorId) : primaryVendorId,
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

    // Push updated retail prices to Shopify where price differs from original
    const priceUpdateVariantIds = lineItems
      .filter((i) => i.variantId && i.retailPrice != null && i.shopifyPrice != null && i.retailPrice !== i.shopifyPrice)
      .map((i) => i.variantId!);
    const priceUpdateCacheEntries = priceUpdateVariantIds.length
      ? await getDb().productCache.findMany({
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

    // Create skeleton draft products in Shopify for unlinked line items.
    // savedLineItems is parallel to lineItems (same order from createManyAndReturn).
    type SavedRecord = (typeof savedLineItems)[0];
    type UnlinkedEntry = { item: ManualLineItem; saved: SavedRecord };
    const unlinkedEntries: UnlinkedEntry[] = lineItems
      .map((item, i) => ({ item, saved: savedLineItems[i] }))
      .filter(({ item }) => !item.variantId);

    if (unlinkedEntries.length > 0) {
      const vendorRecord = await getDb().vendor.findUnique({
        where: { id: primaryVendorId },
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

type Vendor = { id: number; name: string; shopifyVendorName: string | null; supplierId: number | null };
type Supplier = { id: number; name: string };

type LineItemRow = {
  key: string;
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
  vendorId: string;
};

// Items added via AddItemSection in the PDF review screen
type ReviewAddedItem = {
  key: string;
  sku: string;
  description: string;
  quantity: number;
  unitCost: number;
  retailPrice: number;
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
  onInvoiceDateChange,
  onPaymentTermsChange,
  onDueDateChange,
}: {
  initialInvoiceDate?: string;
  initialPaymentTerms?: string;
  initialDueDate?: string;
  dueDateFlagged?: boolean;
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
    setDueDate(
      `${result.getFullYear()}-${String(result.getMonth() + 1).padStart(2, "0")}-${String(result.getDate()).padStart(2, "0")}`
    );
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
  suppliers,
  errors,
}: {
  vendors: Vendor[];
  suppliers: Supplier[];
  errors: Record<string, string>;
}) {
  const navigation = useNavigation();
  const isImporting = navigation.state === "submitting" && navigation.formData?.get("intent") === "uploadCsv";
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [ptfKey, setPtfKey] = useState(0);
  const [selectedSupplierId, setSelectedSupplierId] = useState("");
  const [selectedVendorId, setSelectedVendorId] = useState("");

  useEffect(() => {
    setSelectedVendorId("");
  }, [selectedSupplierId]);

  function handleCsvChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result;
      if (typeof text !== "string") return;
      const parsed = Papa.parse<Record<string, string>>(text, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (h) => h.trim(),
      });
      const firstRow = parsed.data[0] ?? {};
      const csvNum = findCsvColumn(firstRow, ["Invoice Number", "invoice_number", "Invoice #", "Invoice No"]);
      const csvDate = findCsvColumn(firstRow, ["Invoice Date", "invoice_date", "Date"]);
      const csvSupplier = findCsvColumn(firstRow, ["Supplier", "supplier"]);
      if (csvNum) setInvoiceNumber((prev) => prev || csvNum);
      if (csvDate) {
        const formatted = parseDateToInputFormat(csvDate);
        if (formatted) {
          setInvoiceDate((prev) => {
            if (prev) return prev;
            setPtfKey((k) => k + 1);
            return formatted;
          });
        }
      }
      if (csvSupplier) {
        const match = suppliers.find((s) => s.name.toLowerCase().trim() === csvSupplier.toLowerCase().trim());
        if (match) setSelectedSupplierId((prev) => prev || String(match.id));
      }
    };
    reader.readAsText(file);
  }

  const filteredVendors = selectedSupplierId
    ? vendors.filter((v) => v.supplierId === Number(selectedSupplierId))
    : vendors;

  return (
    <form method="post" encType="multipart/form-data" className="space-y-5">
      <input type="hidden" name="intent" value="uploadCsv" />
      <input type="hidden" name="supplierId" value={selectedSupplierId} />

      {suppliers.length > 0 && (
        <div>
          <label htmlFor="csv-supplierId" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Supplier
          </label>
          <select
            id="csv-supplierId"
            value={selectedSupplierId}
            onChange={(e) => setSelectedSupplierId(e.target.value)}
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
        <label htmlFor="vendorId" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Vendor {!selectedSupplierId && <span className="text-red-500">*</span>}
        </label>
        <select
          id="vendorId"
          name="vendorId"
          value={selectedVendorId}
          onChange={(e) => setSelectedVendorId(e.target.value)}
          className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100"
        >
          <option value="">{selectedSupplierId ? "— None —" : "Select a vendor…"}</option>
          {filteredVendors.map((v) => (
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
          value={invoiceNumber}
          onChange={(e) => setInvoiceNumber(e.target.value)}
          className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100"
        />
        {errors.invoiceNumber && <p className="mt-1 text-xs text-red-600">{errors.invoiceNumber}</p>}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
        <PaymentTermsFields key={ptfKey} initialInvoiceDate={invoiceDate} />
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
          onChange={handleCsvChange}
          className="w-full text-sm text-gray-600 dark:text-gray-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-gray-300 dark:file:border-gray-600 file:text-sm file:font-medium file:bg-gray-50 dark:file:bg-gray-800 dark:file:text-indigo-400 hover:file:bg-gray-100 dark:hover:file:bg-gray-700 file:cursor-pointer"
        />
        {errors.csvFile && <p className="mt-1 text-xs text-red-600">{errors.csvFile}</p>}
        <p className="mt-1.5 text-xs text-gray-400 dark:text-gray-500">
          Accepts common column names: SKU, Product Name, Quantity, Unit Cost, and more. Invoice Number and Date are auto-detected from the CSV when present.
        </p>
      </div>

      <div className="flex gap-3 pt-2">
        <button
          type="submit"
          disabled={isImporting}
          className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-5 py-2 transition-colors"
        >
          {isImporting && (
            <svg className="animate-spin h-4 w-4 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 22 12h-4a8 8 0 01-8-8z" />
            </svg>
          )}
          {isImporting ? "Importing…" : "Import CSV"}
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

const DRAFT_KEY = "draft-invoice";

type DraftData = {
  vendorId: string;
  supplierId: string;
  checkedVendorIds: string[];
  addItemVendorId: string;
  invoiceNumber: string;
  invoiceDate: string;
  paymentTerms: string;
  dueDate: string;
  shippingCost: string;
  adjustments: string;
  lineItems: LineItemRow[];
};

function ManualEntryForm({
  vendors,
  suppliers,
  errors,
}: {
  vendors: Vendor[];
  suppliers: Supplier[];
  errors: Record<string, string>;
}) {
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const keyCounter = useRef(0);

  const [lineItems, setLineItems] = useState<LineItemRow[]>([]);
  const [selectedVendorId, setSelectedVendorId] = useState(""); // no-supplier mode
  const [selectedSupplierId, setSelectedSupplierId] = useState("");
  const [checkedVendorIds, setCheckedVendorIds] = useState<string[]>([]); // supplier mode
  const [addItemVendorId, setAddItemVendorId] = useState(""); // active vendor for new items in supplier mode
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [paymentTerms, setPaymentTerms] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [shippingCost, setShippingCost] = useState("0");
  const [adjustments, setAdjustments] = useState("0");

  // key used to remount PaymentTermsFields when restoring a draft
  const [ptfKey, setPtfKey] = useState(0);
  const [hasDraft, setHasDraft] = useState(false);
  const [pendingDraft, setPendingDraft] = useState<DraftData | null>(null);

  // On mount: check for a saved draft
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw) as DraftData;
      if (draft && (draft.lineItems?.length > 0 || draft.invoiceNumber || draft.vendorId)) {
        setPendingDraft(draft);
        setHasDraft(true);
      }
    } catch { /* ignore */ }
  }, []);

  // Auto-save every 30 seconds when the form has content
  useEffect(() => {
    const hasContent = lineItems.length > 0 || invoiceNumber || selectedVendorId || checkedVendorIds.length > 0;
    if (!hasContent) return;
    const timer = setInterval(() => {
      try {
        const draft: DraftData = { vendorId: selectedVendorId, supplierId: selectedSupplierId, checkedVendorIds, addItemVendorId, invoiceNumber, invoiceDate, paymentTerms, dueDate, shippingCost, adjustments, lineItems };
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      } catch { /* ignore */ }
    }, 30_000);
    return () => clearInterval(timer);
  }, [lineItems, invoiceNumber, selectedVendorId, selectedSupplierId, checkedVendorIds, addItemVendorId, invoiceDate, paymentTerms, dueDate, shippingCost, adjustments]);

  // Clear draft when the form is submitted successfully
  useEffect(() => {
    if (navigation.state === "submitting") {
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
    }
  }, [navigation.state]);

  function resumeDraft() {
    if (!pendingDraft) return;
    setSelectedVendorId(pendingDraft.vendorId ?? "");
    setSelectedSupplierId(pendingDraft.supplierId ?? "");
    setCheckedVendorIds(pendingDraft.checkedVendorIds ?? []);
    setAddItemVendorId(pendingDraft.addItemVendorId ?? "");
    setInvoiceNumber(pendingDraft.invoiceNumber ?? "");
    setInvoiceDate(pendingDraft.invoiceDate ?? "");
    setPaymentTerms(pendingDraft.paymentTerms ?? "");
    setDueDate(pendingDraft.dueDate ?? "");
    setShippingCost(pendingDraft.shippingCost ?? "0");
    setAdjustments(pendingDraft.adjustments ?? "0");
    setLineItems(pendingDraft.lineItems ?? []);
    // Remount PaymentTermsFields so it picks up the restored initial values
    setPtfKey((k) => k + 1);
    setHasDraft(false);
    setPendingDraft(null);
  }

  function discardDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
    setHasDraft(false);
    setPendingDraft(null);
  }

  const supplierVendors = selectedSupplierId
    ? vendors.filter((v) => v.supplierId === Number(selectedSupplierId))
    : [];
  const filteredVendors = selectedSupplierId ? supplierVendors : vendors;

  // When supplier changes, reset checked vendors and auto-check if only one option
  useEffect(() => {
    if (!selectedSupplierId) { setCheckedVendorIds([]); setAddItemVendorId(""); return; }
    const ids = supplierVendors.map((v) => String(v.id));
    if (ids.length === 1) {
      setCheckedVendorIds(ids);
      setAddItemVendorId(ids[0]);
    } else {
      setCheckedVendorIds([]);
      setAddItemVendorId("");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSupplierId]);

  function toggleVendor(id: string) {
    setCheckedVendorIds((prev) => {
      const next = prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id];
      if (!next.includes(addItemVendorId)) setAddItemVendorId(next[0] ?? "");
      return next;
    });
  }

  // Primary vendor for the invoice: most-frequent in items, fallback to first checked / selectedVendorId
  const primaryVendorId = (() => {
    if (!selectedSupplierId) return selectedVendorId;
    if (lineItems.length > 0) {
      const counts = new Map<string, number>();
      for (const item of lineItems) {
        const vid = item.vendorId || checkedVendorIds[0] || "";
        if (vid) counts.set(vid, (counts.get(vid) ?? 0) + 1);
      }
      if (counts.size > 0) return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }
    return checkedVendorIds[0] ?? "";
  })();

  const inSupplierMode = !!selectedSupplierId;
  const multiVendorMode = inSupplierMode && checkedVendorIds.length > 1;

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

  // Add-variant mini-form
  type AddVariantTarget = {
    productId: string;
    productTitle: string;
    productOptions: { id: string; name: string; values: string[] }[];
    suggestedPrice: string;
    suggestedCost: string;
  };
  type CreatedVariantData = { id: string; title: string; price: string; sku: string; barcode: string | null; inventoryItemId: string; unitCost: number | null };
  const variantFetcher = useFetcher<{ variant: CreatedVariantData } | { error: string }>();
  const [addVariantTarget, setAddVariantTarget] = useState<AddVariantTarget | null>(null);
  const [avOptionValues, setAvOptionValues] = useState<Record<string, string>>({});
  const [avPrice, setAvPrice] = useState("");
  const [avCost, setAvCost] = useState("");
  const [avSku, setAvSku] = useState("");
  const [avBarcode, setAvBarcode] = useState("");
  const [avError, setAvError] = useState<string | null>(null);

  // On successful variant creation: add to line items and close mini-form
  useEffect(() => {
    if (!variantFetcher.data || variantFetcher.state !== "idle") return;
    if ("error" in variantFetcher.data) {
      setAvError(variantFetcher.data.error);
      return;
    }
    const { variant } = variantFetcher.data;
    const target = addVariantTarget;
    if (!target) return;
    const variantLabel = variant.title && variant.title !== "Default Title" ? variant.title : null;
    setLineItems((prev) => [
      ...prev,
      {
        key: String(++keyCounter.current),
        sku: variant.sku ?? "",
        description: variantLabel ? `${target.productTitle} — ${variantLabel}` : target.productTitle,
        quantity: 1,
        unitCost: variant.unitCost ?? (avCost ? parseFloat(avCost) : 0),
        retailPrice: variant.price ? parseFloat(variant.price) : null,
        shopifyPrice: variant.price ? parseFloat(variant.price) : null,
        shopifyCost: variant.unitCost,
        updateShopifyCost: false,
        variantId: variant.id,
        inventoryItemId: variant.inventoryItemId,
        productGroupKey: null,
        variantOptions: null,
        productTitle: target.productTitle,
        variantTitle: variantLabel,
        barcode: variant.barcode ?? "",
        vendorId: addItemVendorId || selectedVendorId,
      },
    ]);
    setAddVariantTarget(null);
    setAvOptionValues({});
    setAvPrice("");
    setAvCost("");
    setAvSku("");
    setAvBarcode("");
    setAvError(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variantFetcher.data, variantFetcher.state]);

  // Auto-populate vendor filter when invoice vendor changes
  useEffect(() => {
    if (inSupplierMode) {
      // In multi-vendor mode don't auto-set a search filter
      setSearchVendorFilter("");
    } else {
      setSearchVendorFilter(selectedVendor?.shopifyVendorName ?? "");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVendorId, inSupplierMode]);

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

  // Group results by productId to render "Add variant" option per product
  type ProductGroup = {
    productId: string;
    productTitle: string;
    productOptions: { id: string; name: string; values: string[] }[];
    suggestedPrice: string;
    suggestedCost: string;
    variants: ProductSearchResult[];
  };
  const groupedResults: ProductGroup[] = [];
  const groupMap = new Map<string, ProductGroup>();
  for (const r of searchResults) {
    let group = groupMap.get(r.productId);
    if (!group) {
      group = {
        productId: r.productId,
        productTitle: r.productTitle,
        productOptions: r.productOptions,
        suggestedPrice: r.unitCost != null ? String(r.unitCost) : "",
        suggestedCost: r.unitCost != null ? String(r.unitCost) : "",
        variants: [],
      };
      groupMap.set(r.productId, group);
      groupedResults.push(group);
    }
    group.variants.push(r);
  }
  if (groupedResults.length > 0) {
    console.log('[ManualEntryForm] groupedResults[0]:', {
      productId: groupedResults[0].productId,
      productTitle: groupedResults[0].productTitle,
      variantsCount: groupedResults[0].variants.length,
      productOptions: groupedResults[0].productOptions,
    });
  }

  function openAddVariantForm(group: ProductGroup) {
    setShowDropdown(false);
    setSelectedIds(new Set());
    setAvOptionValues(Object.fromEntries(group.productOptions.map((o) => [o.name, ""])));
    setAvPrice(group.suggestedPrice);
    setAvCost(group.suggestedCost);
    setAvSku("");
    setAvBarcode("");
    setAvError(null);
    setAddVariantTarget({
      productId: group.productId,
      productTitle: group.productTitle,
      productOptions: group.productOptions,
      suggestedPrice: group.suggestedPrice,
      suggestedCost: group.suggestedCost,
    });
  }

  function submitAddVariant() {
    if (!addVariantTarget) return;
    const fd = new FormData();
    fd.set("productId", addVariantTarget.productId);
    fd.set("price", avPrice);
    fd.set("cost", avCost);
    fd.set("sku", avSku);
    fd.set("barcode", avBarcode);
    const optionNames = addVariantTarget.productOptions.map((o) => o.name);
    fd.set("optionNames", JSON.stringify(optionNames));
    for (const name of optionNames) {
      fd.set(`option_${name}`, avOptionValues[name] ?? "");
    }
    setAvError(null);
    variantFetcher.submit(fd, { method: "POST", action: "/api/shopify/variants" });
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
    toAdd.forEach((r) => console.log(`[addSelected] sku=${r.sku} barcode=${r.barcode}`));
    const vid = addItemVendorId || selectedVendorId;
    setLineItems((prev) => [
      ...prev,
      ...toAdd.map((result) => ({
        key: String(++keyCounter.current),
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
        vendorId: vid,
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
        vendorId: addItemVendorId || selectedVendorId,
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
          const vid = addItemVendorId || selectedVendorId;
          setLineItems((prev) => [
            ...prev,
            ...combos.map((combo, idx) => ({
              key: String(++keyCounter.current),
              sku: `${baseSku}-${String(idx + 1).padStart(2, "0")}`,
              description: `${desc} — ${combo.map((c) => c.value).join(" / ")}`,
              quantity: qty,
              unitCost: cost,
              retailPrice: retailVal,
              shopifyPrice: null,
              shopifyCost: null,
              updateShopifyCost: false,
              variantId: null,
              inventoryItemId: null,
              productGroupKey: groupKey,
              variantOptions: combo,
              productTitle: desc,
              variantTitle: null,
              barcode: "",
              vendorId: vid,
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
        shopifyPrice: null,
        shopifyCost: null,
        updateShopifyCost: false,
        variantId: null,
        inventoryItemId: null,
        productGroupKey: null,
        variantOptions: null,
        productTitle: null,
        variantTitle: null,
        barcode: manualBarcode.trim(),
        vendorId: addItemVendorId || selectedVendorId,
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

  function updateItemSku(key: string, value: string) {
    setLineItems((prev) =>
      prev.map((item) => (item.key === key ? { ...item, sku: value } : item))
    );
  }

  function updateItemRetailPrice(key: string, value: number | null) {
    setLineItems((prev) =>
      prev.map((item) => (item.key === key ? { ...item, retailPrice: value } : item))
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
      <input type="hidden" name="vendorId" value={primaryVendorId} />
      <input type="hidden" name="lineItems" value={JSON.stringify(lineItems)} />
      <input type="hidden" name="shippingCost" value={shippingCost} />
      <input type="hidden" name="adjustments" value={adjustments} />
      <input type="hidden" name="supplierId" value={selectedSupplierId} />

      {/* Draft resume banner */}
      {hasDraft && (
        <div className="flex items-center gap-4 rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 px-4 py-3">
          <span className="text-sm text-amber-800 dark:text-amber-300 flex-1">
            You have an unsaved draft from a previous session.
          </span>
          <button
            type="button"
            onClick={resumeDraft}
            className="text-sm font-semibold text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 transition-colors"
          >
            Resume
          </button>
          <button
            type="button"
            onClick={discardDraft}
            className="text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
          >
            Discard
          </button>
        </div>
      )}

      {/* Header fields */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
          {suppliers.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Supplier</label>
              <select
                value={selectedSupplierId}
                onChange={(e) => setSelectedSupplierId(e.target.value)}
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100"
              >
                <option value="">— None —</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={String(s.id)}>{s.name}</option>
                ))}
              </select>
            </div>
          )}

          {inSupplierMode ? (
            <div className={supplierVendors.length > 4 ? "sm:col-span-2" : ""}>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Vendors
              </label>
              {supplierVendors.length === 0 ? (
                <p className="text-xs text-gray-400 dark:text-gray-500 italic">No vendors linked to this supplier.</p>
              ) : (
                <div className="flex flex-wrap gap-x-5 gap-y-1.5 pt-0.5">
                  {supplierVendors.map((v) => (
                    <label key={v.id} className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={checkedVendorIds.includes(String(v.id))}
                        onChange={() => toggleVendor(String(v.id))}
                        className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
                      />
                      <span className="text-sm text-gray-700 dark:text-gray-200">{v.name}</span>
                    </label>
                  ))}
                </div>
              )}
              {errors.vendorId && <p className="mt-1 text-xs text-red-600">{errors.vendorId}</p>}
            </div>
          ) : (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Vendor <span className="text-red-500">*</span>
              </label>
              <select
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
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Invoice Number <span className="text-red-500">*</span>
            </label>
            <input
              name="invoiceNumber"
              type="text"
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:bg-gray-800 dark:text-gray-100 ${
                errors.invoiceNumber ? "border-red-400" : "border-gray-300 dark:border-gray-600"
              }`}
            />
            {errors.invoiceNumber && <p className="mt-1 text-xs text-red-600">{errors.invoiceNumber}</p>}
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
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Line Items</h3>
          {inSupplierMode && checkedVendorIds.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">Adding for:</span>
              <select
                value={addItemVendorId}
                onChange={(e) => setAddItemVendorId(e.target.value)}
                className="border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1 text-xs bg-white dark:bg-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {checkedVendorIds.map((id) => {
                  const v = vendors.find((v) => String(v.id) === id);
                  return <option key={id} value={id}>{v?.name ?? id}</option>;
                })}
              </select>
            </div>
          )}
        </div>

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
                          className="group flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer border-b border-gray-100 dark:border-gray-700 transition-colors"
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
                          <span className="text-gray-300 dark:text-gray-600 shrink-0">|</span>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); openAddVariantForm(group); }}
                            className="shrink-0 text-xs text-indigo-500 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-200 transition-colors"
                          >
                            + Variant
                          </button>
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

        {/* Add-variant mini-form */}
        {addVariantTarget && (
          <div className="mb-4 rounded-xl border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950/30 p-4">
            <div className="flex items-start justify-between mb-3">
              <div>
                <p className="text-xs font-semibold text-indigo-700 dark:text-indigo-300 mb-0.5">Add variant to Shopify</p>
                <p className="text-sm font-medium text-gray-800 dark:text-gray-100">{addVariantTarget.productTitle}</p>
              </div>
              <button
                type="button"
                onClick={() => setAddVariantTarget(null)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xl leading-none ml-3"
              >
                ×
              </button>
            </div>

            {addVariantTarget.productOptions.length > 0 && (
              <div className="grid grid-cols-2 gap-3 mb-3">
                {addVariantTarget.productOptions.map((opt) => (
                  <div key={opt.name}>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                      {opt.name} <span className="text-red-500">*</span>
                    </label>
                    <input
                      list={`av-opt-${opt.name}`}
                      type="text"
                      value={avOptionValues[opt.name] ?? ""}
                      onChange={(e) => setAvOptionValues((prev) => ({ ...prev, [opt.name]: e.target.value }))}
                      placeholder={`e.g. ${opt.values[0] ?? opt.name}`}
                      className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-900 dark:text-gray-100"
                    />
                    <datalist id={`av-opt-${opt.name}`}>
                      {opt.values.map((v) => <option key={v} value={v} />)}
                    </datalist>
                  </div>
                ))}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                  Price <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={avPrice}
                  onChange={(e) => setAvPrice(e.target.value)}
                  placeholder="0.00"
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-900 dark:text-gray-100"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Cost</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={avCost}
                  onChange={(e) => setAvCost(e.target.value)}
                  placeholder="0.00"
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-900 dark:text-gray-100"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">SKU</label>
                <input
                  type="text"
                  value={avSku}
                  onChange={(e) => setAvSku(e.target.value)}
                  placeholder="e.g. PROD-XL-BLK"
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-900 dark:text-gray-100"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                  Barcode <span className="text-xs text-gray-400 font-normal">(optional)</span>
                </label>
                <BarcodeInput
                  value={avBarcode}
                  onChange={setAvBarcode}
                  placeholder="Scan or type…"
                  inputClassName="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-900 dark:text-gray-100"
                />
              </div>
            </div>

            {avError && (
              <p className="mb-3 text-xs text-red-600 dark:text-red-400">{avError}</p>
            )}

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={submitAddVariant}
                disabled={variantFetcher.state === "submitting"}
                className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-xs font-semibold rounded-lg px-4 py-2 transition-colors"
              >
                {variantFetcher.state === "submitting" ? "Creating…" : "Create Variant & Add to PO"}
              </button>
              <button
                type="button"
                onClick={() => setAddVariantTarget(null)}
                className="text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

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
                  {multiVendorMode && <th className="text-left px-4 py-2.5 font-medium text-gray-600 dark:text-gray-400 w-28">Vendor</th>}
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
                      {item.variantTitle && (
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
                      {item.variantId === null && (
                        <span className="mt-0.5 inline-block text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-700 rounded px-1 py-0.5">
                          Manual
                        </span>
                      )}
                    </td>
                    {multiVendorMode && (
                      <td className="px-4 py-2.5">
                        <select
                          value={item.vendorId}
                          onChange={(e) => setLineItems((prev) => prev.map((r) => r.key === item.key ? { ...r, vendorId: e.target.value } : r))}
                          className="border border-gray-200 dark:border-gray-600 rounded px-1.5 py-0.5 text-xs bg-white dark:bg-gray-800 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                        >
                          {checkedVendorIds.map((id) => {
                            const v = vendors.find((v) => String(v.id) === id);
                            return <option key={id} value={id}>{v?.name ?? id}</option>;
                          })}
                        </select>
                      </td>
                    )}
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
        )}

        {errors.lineItems && (
          <p className="mt-2 text-xs text-red-600">{errors.lineItems}</p>
        )}
      </div>

      {/* Totals summary + Submit */}
      {(() => {
        const subtotal = lineItems.reduce((s, i) => s + i.quantity * i.unitCost, 0);
        const shippingVal = parseFloat(shippingCost) || 0;
        const adjustmentsVal = parseFloat(adjustments) || 0;
        const grandTotal = subtotal + shippingVal + adjustmentsVal;
        const showBreakdown = shippingVal !== 0 || adjustmentsVal !== 0;
        return (
          <div className="flex items-start justify-between gap-4">
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
        );
      })()}
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
  const barcodeKeywords = ["barcode", "bar code", "upc", "ean", "gtin"];
  const cols = rows[0] ? Object.keys(rows[0]) : [];
  const barcodeCol = cols.find((c) => barcodeKeywords.some((kw) => c.toLowerCase().includes(kw))) ?? "";
  return rows
    .filter((row) => descCol && row[descCol]?.trim())
    .map((row) => {
      const rawQty = qtyCol ? row[qtyCol] ?? "1" : "1";
      const rawCost = costCol ? row[costCol] ?? "0" : "0";
      const qty = parseInt(rawQty.replace(/[^\d]/g, "") || "1", 10) || 1;
      const cost = parseFloat(rawCost.replace(/[^\d.]/g, "") || "0") || 0;
      const barcodeVal = barcodeCol ? (row[barcodeCol] ?? "").trim() : "";
      return {
        sku: { value: skuCol ? (row[skuCol] ?? "") : "", confidence: 0.95, flagged: false },
        description: { value: row[descCol] ?? "", confidence: 0.95, flagged: false },
        quantity: { value: qty, confidence: 0.95, flagged: false },
        unitCost: { value: cost, confidence: 0.95, flagged: false },
        ...(barcodeVal ? { barcode: { value: barcodeVal, confidence: 0.8, flagged: false } } : {}),
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
    retailPrice?: ExtractionField<number>;
    barcode?: ExtractionField<string>;
  }>;
  addedItems?: ReviewAddedItem[];
  onRemoveAdded?: (key: string) => void;
  onUpdateAdded?: (key: string, field: "quantity" | "unitCost" | "barcode" | "retailPrice", value: string | number) => void;
}) {
  const [values, setValues] = useState(() =>
    items.map((item) => ({ qty: item.quantity.value, unitCost: item.unitCost.value, barcode: item.barcode?.value ?? "", retailPrice: item.retailPrice?.value ?? 0 }))
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
    <div className="overflow-x-auto">
    <table className="w-full text-sm min-w-[820px]">
      <thead>
        <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
          <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">SKU</th>
          <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Description</th>
          <th className="text-right px-3 py-3 font-medium text-gray-600 dark:text-gray-400 w-24">Qty</th>
          <th className="text-right px-3 py-3 font-medium text-gray-600 dark:text-gray-400 w-28">Unit Cost</th>
          <th className="text-right px-3 py-3 font-medium text-gray-600 dark:text-gray-400 w-24">Retail</th>
          <th className="text-right px-3 py-3 font-medium text-gray-600 dark:text-gray-400 w-16">Margin</th>
          <th className="text-left px-3 py-3 font-medium text-gray-600 dark:text-gray-400 w-36">Barcode</th>
          <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-400 w-28">Total</th>
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
                <input
                  name={`retailPrice_${i}`}
                  type="number"
                  min="0"
                  step="0.01"
                  value={values[i]?.retailPrice || ""}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    setValues((prev) => prev.map((v, j) => (j === i ? { ...v, retailPrice: n } : v)));
                  }}
                  className="w-24 text-right border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:text-gray-100 dark:bg-gray-800"
                  placeholder="0.00"
                />
              </td>
              <td className="px-4 py-3 text-right">
                {(() => {
                  const rp = Number(values[i]?.retailPrice ?? 0);
                  const uc = Number(values[i]?.unitCost ?? item.unitCost.value);
                  if (!rp || !uc) return <span className="text-gray-400 dark:text-gray-500 text-sm">—</span>;
                  const pct = ((rp - uc) / rp) * 100;
                  const color = pct >= 40 ? "text-green-600 dark:text-green-400" : pct >= 20 ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400";
                  return <span className={`text-sm font-medium tabular-nums ${color}`}>{pct.toFixed(1)}%</span>;
                })()}
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
                <input
                  name={`retailPrice_${idx}`}
                  type="number"
                  min="0"
                  step="0.01"
                  value={item.retailPrice || ""}
                  onChange={(e) => onUpdateAdded?.(item.key, "retailPrice", Number(e.target.value))}
                  className="w-24 text-right border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100"
                  placeholder="0.00"
                />
              </td>
              <td className="px-4 py-3 text-right">
                {(() => {
                  const rp = Number(item.retailPrice);
                  const uc = Number(item.unitCost);
                  if (!rp || !uc) return <span className="text-gray-400 dark:text-gray-500 text-sm">—</span>;
                  const pct = ((rp - uc) / rp) * 100;
                  const color = pct >= 40 ? "text-green-600 dark:text-green-400" : pct >= 20 ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400";
                  return <span className={`text-sm font-medium tabular-nums ${color}`}>{pct.toFixed(1)}%</span>;
                })()}
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
          <td className="px-4 py-3 text-right text-gray-900 dark:text-gray-100 tabular-nums" colSpan={4}></td>
          <td className="px-4 py-3 text-right text-gray-900 dark:text-gray-100 tabular-nums">${totalAmount.toFixed(2)}</td>
        </tr>
      </tfoot>
    </table>
    </div>
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

  // Group by productId for the "Add variant" entry per product
  type AddItemGroup = {
    productId: string;
    productTitle: string;
    productOptions: { id: string; name: string; values: string[] }[];
    suggestedPrice: string;
    suggestedCost: string;
    variants: ProductSearchResult[];
  };
  const addItemGroups: AddItemGroup[] = [];
  const addItemGroupMap = new Map<string, AddItemGroup>();
  for (const r of searchResults) {
    let g = addItemGroupMap.get(r.productId);
    if (!g) {
      g = { productId: r.productId, productTitle: r.productTitle, productOptions: r.productOptions, suggestedPrice: r.unitCost != null ? String(r.unitCost) : "", suggestedCost: r.unitCost != null ? String(r.unitCost) : "", variants: [] };
      addItemGroupMap.set(r.productId, g);
      addItemGroups.push(g);
    }
    g.variants.push(r);
  }

  // Add-variant mini-form state (within AddItemSection)
  type AddItemVariantTarget = { productId: string; productTitle: string; productOptions: { id: string; name: string; values: string[] }[]; suggestedPrice: string; suggestedCost: string };
  type AddItemCreatedVariant = { id: string; title: string; price: string; sku: string; barcode: string | null; inventoryItemId: string; unitCost: number | null };
  const aiFetcher = useFetcher<{ variant: AddItemCreatedVariant } | { error: string }>();
  const [aiTarget, setAiTarget] = useState<AddItemVariantTarget | null>(null);
  const [aiOptionValues, setAiOptionValues] = useState<Record<string, string>>({});
  const [aiPrice, setAiPrice] = useState("");
  const [aiCost, setAiCost] = useState("");
  const [aiSku, setAiSku] = useState("");
  const [aiBarcode, setAiBarcode] = useState("");
  const [aiError, setAiError] = useState<string | null>(null);

  useEffect(() => {
    if (!aiFetcher.data || aiFetcher.state !== "idle" || !aiTarget) return;
    if ("error" in aiFetcher.data) { setAiError(aiFetcher.data.error); return; }
    const { variant } = aiFetcher.data;
    const variantLabel = variant.title && variant.title !== "Default Title" ? variant.title : null;
    onAdd({
      key: String(++keyCounter.current),
      sku: variant.sku ?? "",
      description: variantLabel ? `${aiTarget.productTitle} — ${variantLabel}` : aiTarget.productTitle,
      quantity: 1,
      unitCost: variant.unitCost ?? (aiCost ? parseFloat(aiCost) : 0),
      retailPrice: aiPrice ? parseFloat(aiPrice) : 0,
      barcode: variant.barcode ?? "",
      variantId: variant.id,
      inventoryItemId: variant.inventoryItemId,
    });
    setAiTarget(null);
    setAiOptionValues({});
    setAiPrice(""); setAiCost(""); setAiSku(""); setAiBarcode(""); setAiError(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiFetcher.data, aiFetcher.state]);

  function openAiForm(g: AddItemGroup) {
    setShowDropdown(false);
    setAiOptionValues(Object.fromEntries(g.productOptions.map((o) => [o.name, ""])));
    setAiPrice(g.suggestedPrice);
    setAiCost(g.suggestedCost);
    setAiSku(""); setAiBarcode(""); setAiError(null);
    setAiTarget({ productId: g.productId, productTitle: g.productTitle, productOptions: g.productOptions, suggestedPrice: g.suggestedPrice, suggestedCost: g.suggestedCost });
  }

  function submitAiVariant() {
    if (!aiTarget) return;
    const fd = new FormData();
    fd.set("productId", aiTarget.productId);
    fd.set("price", aiPrice);
    fd.set("cost", aiCost);
    fd.set("sku", aiSku);
    fd.set("barcode", aiBarcode);
    const optionNames = aiTarget.productOptions.map((o) => o.name);
    fd.set("optionNames", JSON.stringify(optionNames));
    for (const name of optionNames) fd.set(`option_${name}`, aiOptionValues[name] ?? "");
    setAiError(null);
    aiFetcher.submit(fd, { method: "POST", action: "/api/shopify/variants" });
  }

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
      retailPrice: result.price ?? 0,
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
      retailPrice: 0,
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
                  {addItemGroups.length === 0 && !isSearching && (
                    <p className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">No products found.</p>
                  )}
                  {addItemGroups.map((group) => (
                    <div key={group.productId}>
                      {group.variants.map((result) => {
                        const displayName =
                          result.variantTitle && result.variantTitle !== "Default Title"
                            ? `${result.productTitle} — ${result.variantTitle}`
                            : result.productTitle;
                        return (
                          <div
                            key={result.variantId}
                            onClick={() => addFromSearch(result)}
                            className="group flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer border-b border-gray-100 dark:border-gray-700 transition-colors"
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
                            <span className="text-gray-300 dark:text-gray-600 shrink-0">|</span>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); openAiForm(group); }}
                              className="shrink-0 text-xs text-indigo-500 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-200 transition-colors"
                            >
                              + Variant
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Add-variant mini-form */}
          {aiTarget && (
            <div className="mt-3 rounded-xl border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950/30 p-4">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <p className="text-xs font-semibold text-indigo-700 dark:text-indigo-300 mb-0.5">Add variant to Shopify</p>
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-100">{aiTarget.productTitle}</p>
                </div>
                <button type="button" onClick={() => setAiTarget(null)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xl leading-none ml-3">×</button>
              </div>

              {aiTarget.productOptions.length > 0 && (
                <div className="grid grid-cols-2 gap-3 mb-3">
                  {aiTarget.productOptions.map((opt) => (
                    <div key={opt.name}>
                      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{opt.name} <span className="text-red-500">*</span></label>
                      <input
                        list={`ai-opt-${opt.name}`}
                        type="text"
                        value={aiOptionValues[opt.name] ?? ""}
                        onChange={(e) => setAiOptionValues((prev) => ({ ...prev, [opt.name]: e.target.value }))}
                        placeholder={`e.g. ${opt.values[0] ?? opt.name}`}
                        className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-900 dark:text-gray-100"
                      />
                      <datalist id={`ai-opt-${opt.name}`}>
                        {opt.values.map((v) => <option key={v} value={v} />)}
                      </datalist>
                    </div>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Price <span className="text-red-500">*</span></label>
                  <input type="number" min="0" step="0.01" value={aiPrice} onChange={(e) => setAiPrice(e.target.value)} placeholder="0.00" className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-900 dark:text-gray-100" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Cost</label>
                  <input type="number" min="0" step="0.01" value={aiCost} onChange={(e) => setAiCost(e.target.value)} placeholder="0.00" className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-900 dark:text-gray-100" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">SKU</label>
                  <input type="text" value={aiSku} onChange={(e) => setAiSku(e.target.value)} placeholder="e.g. PROD-XL-BLK" className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-900 dark:text-gray-100" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Barcode <span className="text-xs text-gray-400 font-normal">(optional)</span></label>
                  <BarcodeInput value={aiBarcode} onChange={setAiBarcode} placeholder="Scan or type…" inputClassName="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-900 dark:text-gray-100" />
                </div>
              </div>

              {aiError && <p className="mb-3 text-xs text-red-600 dark:text-red-400">{aiError}</p>}

              <div className="flex items-center gap-3">
                <button type="button" onClick={submitAiVariant} disabled={aiFetcher.state === "submitting"} className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-xs font-semibold rounded-lg px-4 py-2 transition-colors">
                  {aiFetcher.state === "submitting" ? "Creating…" : "Create Variant & Add to PO"}
                </button>
                <button type="button" onClick={() => setAiTarget(null)} className="text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors">Cancel</button>
              </div>
            </div>
          )}
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
  suppliers,
}: {
  extraction: ExtendedExtractionResult;
  vendors: Vendor[];
  matchedVendorId: number | null;
  suppliers: Supplier[];
}) {
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const fetcher = useFetcher<{ step: "vendorCreated"; error: string | null; vendor: Vendor | null }>();

  const [vendorsList, setVendorsList] = useState<Vendor[]>(initialVendors);
  const [selectedVendorId, setSelectedVendorId] = useState<string>(
    initialMatchedVendorId !== null ? String(initialMatchedVendorId) : ""
  );
  const [selectedSupplierId, setSelectedSupplierId] = useState("");
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

  function handleUpdateAdded(key: string, field: "quantity" | "unitCost" | "barcode" | "retailPrice", value: string | number) {
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
        <input type="hidden" name="supplierId" value={selectedSupplierId} />

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
            {suppliers.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Supplier</label>
                <select
                  value={selectedSupplierId}
                  onChange={(e) => setSelectedSupplierId(e.target.value)}
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
                Vendor {!selectedSupplierId && <span className="text-red-500">*</span>}
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
  const { vendors, suppliers } = loaderData;
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
          suppliers={suppliers}
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
        <ManualEntryForm vendors={vendors} suppliers={suppliers} errors={manualErrors} />
      )}

      {uploadMode !== "manual" && <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-8">
        {general && (
          <p className="mb-5 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg px-4 py-2">
            {general}
          </p>
        )}

        {/* ── CSV form ── */}
        {uploadMode === "csv" && <CsvUploadForm vendors={vendors} suppliers={suppliers} errors={errors} />}

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
