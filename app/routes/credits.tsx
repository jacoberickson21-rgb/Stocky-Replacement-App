import { Link, useNavigate, useActionData, useFetcher, Form } from "react-router";
import { useState, useEffect, useRef } from "react";
import { data, redirect } from "react-router";
import type { Route } from "./+types/credits";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";
import { logFailure } from "../services/failure-log.server";
import {
  lookupProduct,
  getLocationId,
  updateInventoryLevel,
  updateInventoryItemCost,
  updateVariantBarcode,
  getProductIdFromVariant,
} from "../services/shopify.server";
import type { ProductSearchResult } from "../services/shopify.server";
import Papa from "papaparse";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseAmount(val: string | undefined): number {
  if (!val) return 0;
  return Math.abs(parseFloat(val.replace(/[$,]/g, "").trim()) || 0);
}

function parseQty(val: string | undefined): number | null {
  if (!val || !val.trim()) return null;
  const n = parseInt(val.trim(), 10);
  return isNaN(n) ? null : n;
}

function parseDateField(val: string | undefined): Date {
  if (!val || !val.trim()) return new Date();
  const d = new Date(val.trim());
  return isNaN(d.getTime()) ? new Date() : d;
}

function normalizeVendorName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, " ");
}

function fmtCurrency(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

// ─── Types ────────────────────────────────────────────────────────────────────

type BuilderLineItem = {
  key: string;
  sku: string;
  description: string;
  quantity: number;
  unitCost: number;
  variantId: string | null;
  inventoryItemId: string | null;
  productTitle: string | null;
  variantTitle: string | null;
  barcode: string;
};

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const url = new URL(request.url);
  const vendorParam = url.searchParams.get("vendor");
  const searchParam = url.searchParams.get("search");

  const where: Record<string, unknown> = {};
  if (vendorParam) where.vendorId = Number(vendorParam);
  if (searchParam) {
    where.OR = [
      { invoiceNumber: { contains: searchParam } },
      { notes: { contains: searchParam } },
      { sku: { contains: searchParam } },
      { description: { contains: searchParam } },
      { vendor: { name: { contains: searchParam } } },
    ];
  }

  const [credits, vendors, suppliers] = await Promise.all([
    getDb().credit.findMany({
      where,
      include: {
        vendor: true,
        supplier: true,
        _count: { select: { lineItems: true } },
      },
      orderBy: { date: "desc" },
    }),
    getDb().vendor.findMany({ orderBy: { name: "asc" } }),
    getDb().supplier.findMany({ orderBy: { name: "asc" } }),
  ]);

  const total = credits.reduce((sum, c) => sum + Number(c.amount), 0);

  return {
    credits: credits.map((c) => ({
      id: c.id,
      vendorId: c.vendorId,
      amount: Number(c.amount),
      sku: c.sku,
      description: c.description,
      quantity: c.quantity,
      invoiceNumber: c.invoiceNumber,
      notes: c.notes,
      date: c.date,
      vendorName: c.vendor.name,
      supplierName: c.supplier?.name ?? null,
      lineItemCount: c._count.lineItems,
    })),
    vendors,
    suppliers,
    vendorParam,
    searchParam,
    total,
  };
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const db = getDb();
  const formData = await request.formData();
  const intent = formData.get("intent") as string | null;

  // ── Add single dollar-amount credit ───────────────────────────────────────
  if (intent === "addCredit") {
    const vendorId = Number(formData.get("vendorId"));
    const supplierId = formData.get("supplierId") ? Number(formData.get("supplierId")) : null;
    const amountRaw = formData.get("amount") as string | null;
    const amount = parseAmount(amountRaw ?? "");
    const sku = (formData.get("sku") as string | null)?.trim() || null;
    const description = (formData.get("description") as string | null)?.trim() || null;
    const quantityRaw = formData.get("quantity") as string | null;
    const quantity = quantityRaw?.trim() ? parseInt(quantityRaw.trim(), 10) : null;
    const invoiceNumber = (formData.get("invoiceNumber") as string | null)?.trim() || null;
    const notes = (formData.get("notes") as string | null)?.trim() || null;
    const dateRaw = formData.get("date") as string | null;
    const date = parseDateField(dateRaw ?? "");

    if (!vendorId || amount <= 0) {
      return data({ error: "Vendor and a valid credit amount are required.", importResult: null }, { status: 422 });
    }

    try {
      await db.credit.create({
        data: { vendorId, supplierId, amount, sku, description, quantity, invoiceNumber, notes, date },
      });
      await db.auditLog.create({
        data: {
          userId,
          action: "CREDIT_ADDED",
          details: `Credit of ${fmtCurrency(amount)} added for vendor #${vendorId}${sku ? ` (SKU: ${sku})` : ""}`,
          vendorId,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      await logFailure("CREDIT_ADD", `Vendor #${vendorId}`, msg);
      return data({ error: "Failed to save credit.", importResult: null }, { status: 500 });
    }

    // Best-effort inventory deduction for simple SKU credits
    if (sku && quantity) {
      try {
        const locationId = await getLocationId();
        const result = await lookupProduct({ sku });
        if (result) {
          await updateInventoryLevel({
            inventoryItemId: result.product.variants[0].inventoryItemId,
            locationId,
            quantity: -Math.abs(quantity),
            lineItemId: `credit-${sku}-${Date.now()}`,
            reason: "correction",
          });
        }
      } catch (err) {
        await logFailure("INVENTORY_UPDATE", sku, `Credit inventory deduction: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return redirect("/credits");
  }

  // ── Full credit invoice (line items) ──────────────────────────────────────
  if (intent === "createCreditInvoice") {
    const vendorId = Number(formData.get("vendorId"));
    const supplierId = formData.get("supplierId") ? Number(formData.get("supplierId")) : null;
    const invoiceNumber = (formData.get("invoiceNumber") as string | null)?.trim() || null;
    const notes = (formData.get("notes") as string | null)?.trim() || null;
    const dateRaw = formData.get("date") as string | null;
    const date = parseDateField(dateRaw ?? "");
    const lineItemsRaw = formData.get("lineItems") as string | null;

    if (!vendorId) {
      return data({ error: "Vendor is required.", importResult: null }, { status: 422 });
    }

    type CreditLineItemInput = {
      sku: string;
      description: string;
      quantity: number;
      unitCost: number;
      variantId: string | null;
      inventoryItemId: string | null;
      productTitle: string | null;
      variantTitle: string | null;
      barcode: string;
    };

    let lineItems: CreditLineItemInput[] = [];
    try {
      const parsed = JSON.parse(lineItemsRaw ?? "[]");
      if (Array.isArray(parsed)) lineItems = parsed;
    } catch {
      return data({ error: "Invalid line items data.", importResult: null }, { status: 400 });
    }

    if (lineItems.length === 0) {
      return data({ error: "At least one line item is required.", importResult: null }, { status: 422 });
    }

    const amount = lineItems.reduce((sum, i) => sum + i.quantity * i.unitCost, 0);

    let credit: { id: number };
    try {
      credit = await db.$transaction(async (tx) => {
        const created = await tx.credit.create({
          data: { vendorId, supplierId, amount, invoiceNumber, notes, date },
        });
        await tx.creditLineItem.createMany({
          data: lineItems.map((i) => ({
            creditId: created.id,
            sku: i.sku || null,
            description: i.description,
            quantity: i.quantity,
            unitCost: i.unitCost,
            lineTotal: -(i.quantity * i.unitCost),
            shopifyVariantId: i.variantId ?? null,
            shopifyInventoryItemId: i.inventoryItemId ?? null,
            shopifyProductTitle: i.productTitle ?? null,
            barcode: i.barcode || null,
          })),
        });
        await tx.auditLog.create({
          data: {
            userId,
            action: "CREDIT_INVOICE_CREATED",
            details: `Credit invoice${invoiceNumber ? ` #${invoiceNumber}` : ""} created for vendor #${vendorId} — ${lineItems.length} line item${lineItems.length !== 1 ? "s" : ""}, total ${fmtCurrency(amount)}`,
            vendorId,
          },
        });
        return created;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      await logFailure("CREDIT_INVOICE_CREATE", `Vendor #${vendorId}`, msg);
      return data({ error: "Failed to create credit invoice.", importResult: null }, { status: 500 });
    }

    // Best-effort: Shopify inventory deductions + cost/barcode sync
    let locationId: string | null = null;
    try { locationId = await getLocationId(); } catch { /* logged below */ }

    const savedLineItems = await db.creditLineItem.findMany({
      where: { creditId: credit.id },
    });

    for (const item of savedLineItems) {
      if (!item.shopifyInventoryItemId || !locationId) continue;

      // Inventory deduction
      try {
        await updateInventoryLevel({
          inventoryItemId: item.shopifyInventoryItemId,
          locationId,
          quantity: -item.quantity,
          lineItemId: `credit-li-${item.id}`,
          reason: "correction",
        });
        await db.creditLineItem.update({
          where: { id: item.id },
          data: { inventorySynced: true },
        });
      } catch (err) {
        await logFailure("INVENTORY_UPDATE", item.sku ?? item.description, `Credit line item deduction: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Cost sync
      try {
        await updateInventoryItemCost(item.shopifyInventoryItemId, Number(item.unitCost));
      } catch (err) {
        await logFailure("COST_SYNC", item.sku ?? item.description, `Credit cost sync: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Barcode sync (needs productId lookup)
    for (const item of savedLineItems) {
      if (!item.shopifyVariantId || !item.barcode) continue;
      try {
        const cached = await db.productCache.findUnique({
          where: { variantId: item.shopifyVariantId },
          select: { productId: true },
        });
        let productId = cached?.productId ?? null;
        if (!productId) {
          try { productId = await getProductIdFromVariant(item.shopifyVariantId); } catch { /* ignore */ }
        }
        if (productId) {
          await updateVariantBarcode(productId, item.shopifyVariantId, item.barcode);
        }
      } catch (err) {
        await logFailure("BARCODE_SYNC", item.sku ?? item.description, `Credit barcode sync: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return redirect("/credits");
  }

  // ── CSV import ─────────────────────────────────────────────────────────────
  if (intent === "importCsv") {
    const file = formData.get("csv");
    if (!file || !(file instanceof File) || file.size === 0) {
      return data({ error: "Please select a CSV file.", importResult: null }, { status: 400 });
    }

    const csvText = await file.text();
    const parsed = Papa.parse<Record<string, string>>(csvText, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
    });

    const existingVendors = await db.vendor.findMany({ select: { id: true, name: true } });
    const vendorByNorm = new Map(existingVendors.map((v) => [normalizeVendorName(v.name), v.id]));

    let imported = 0;
    let vendorsCreated = 0;
    const errors: { row: number; message: string }[] = [];

    for (let i = 0; i < parsed.data.length; i++) {
      const row = parsed.data[i];
      const rowNum = i + 2;

      try {
        const vendorNameRaw = (row["vendor"] ?? row["Vendor"] ?? row["Vendor Name"] ?? "").trim();
        if (!vendorNameRaw) { errors.push({ row: rowNum, message: "Missing vendor name" }); continue; }

        const norm = normalizeVendorName(vendorNameRaw);
        let vendorId = vendorByNorm.get(norm);
        if (vendorId === undefined) {
          for (const [existing, id] of vendorByNorm.entries()) {
            if (existing.includes(norm) || norm.includes(existing)) { vendorId = id; break; }
          }
        }
        if (vendorId === undefined) {
          const newVendor = await db.vendor.create({ data: { name: vendorNameRaw } });
          vendorId = newVendor.id;
          vendorByNorm.set(norm, vendorId);
          vendorsCreated++;
        }

        const amount = parseAmount(row["amount"] ?? row["Amount"] ?? row["Credit Amount"] ?? "");
        if (amount <= 0) { errors.push({ row: rowNum, message: "Amount is zero or missing" }); continue; }

        const sku = (row["sku"] ?? row["SKU"] ?? "").trim() || null;
        const description = (row["description"] ?? row["Description"] ?? "").trim() || null;
        const quantity = parseQty(row["quantity"] ?? row["Quantity"] ?? row["Qty"]);
        const invoiceNumber = (row["invoice_number"] ?? row["Invoice #"] ?? row["Invoice Number"] ?? "").trim() || null;
        const notes = (row["notes"] ?? row["Notes"] ?? row["reason"] ?? row["Reason"] ?? "").trim() || null;
        const date = parseDateField(row["date"] ?? row["Date"] ?? row["Credit Date"]);

        await db.credit.create({ data: { vendorId, amount, sku, description, quantity, invoiceNumber, notes, date } });

        if (sku && quantity) {
          try {
            const locationId = await getLocationId();
            const result = await lookupProduct({ sku });
            if (result) {
              await updateInventoryLevel({
                inventoryItemId: result.product.variants[0].inventoryItemId,
                locationId,
                quantity: -Math.abs(quantity),
                lineItemId: `credit-csv-${sku}-${rowNum}`,
                reason: "correction",
              });
            }
          } catch (err) {
            await logFailure("INVENTORY_UPDATE", sku ?? `row ${rowNum}`, `CSV credit deduction: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        imported++;
      } catch (err) {
        errors.push({ row: rowNum, message: err instanceof Error ? err.message : "Unknown error" });
      }
    }

    await db.auditLog.create({
      data: {
        userId,
        action: "CREDITS_CSV_IMPORT",
        details: `Imported ${imported} credits from CSV${vendorsCreated > 0 ? `, created ${vendorsCreated} vendors` : ""}${errors.length > 0 ? `, ${errors.length} errors` : ""}`,
      },
    });

    return data({ error: null, importResult: { imported, vendorsCreated, errors } });
  }

  // ── Delete credit ──────────────────────────────────────────────────────────
  if (intent === "deleteCredit") {
    const creditId = Number(formData.get("creditId"));
    if (!creditId) {
      return data({ error: "Missing credit ID.", importResult: null }, { status: 400 });
    }
    const credit = await db.credit.findUnique({
      where: { id: creditId },
      select: { id: true, vendorId: true, invoiceNumber: true },
    });
    if (!credit) {
      return data({ error: "Credit not found.", importResult: null }, { status: 404 });
    }
    await db.$transaction([
      db.credit.delete({ where: { id: creditId } }),
      db.auditLog.create({
        data: {
          userId,
          action: "CREDIT_DELETED",
          details: `Credit #${credit.id}${credit.invoiceNumber ? ` (ref: ${credit.invoiceNumber})` : ""} deleted`,
          vendorId: credit.vendorId,
        },
      }),
    ]);
    return redirect("/credits");
  }

  return data({ error: "Unknown intent.", importResult: null }, { status: 400 });
}

// ─── Credit Invoice Builder component ────────────────────────────────────────

function CreditInvoiceBuilder({
  vendors,
  suppliers,
  onCancel,
}: {
  vendors: { id: number; name: string }[];
  suppliers: { id: number; name: string }[];
  onCancel: () => void;
}) {
  const searchFetcher = useFetcher<ProductSearchResult[]>();
  const [searchQuery, setSearchQuery] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedVendorName, setSelectedVendorName] = useState("");

  const [lineItems, setLineItems] = useState<BuilderLineItem[]>([]);
  const keyCounter = useRef(0);

  const searchResults: ProductSearchResult[] = Array.isArray(searchFetcher.data) ? searchFetcher.data : [];
  const isSearching = searchFetcher.state === "loading";

  useEffect(() => {
    if (searchQuery.length < 2) { setShowDropdown(false); return; }
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: searchQuery });
      if (selectedVendorName) params.set("vendorName", selectedVendorName);
      searchFetcher.load(`/api/shopify/products?${params.toString()}`);
      setShowDropdown(true);
    }, 250);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, selectedVendorName]);

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
        sku: result.sku,
        description: result.productTitle,
        quantity: 1,
        unitCost: result.unitCost ?? 0,
        variantId: result.variantId,
        inventoryItemId: result.inventoryItemId,
        productTitle: result.productTitle,
        variantTitle: result.variantTitle !== "Default Title" ? result.variantTitle : null,
        barcode: result.barcode ?? "",
      },
    ]);
    setSearchQuery("");
    setShowDropdown(false);
    setSelectedIds(new Set());
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
        variantId: result.variantId,
        inventoryItemId: result.inventoryItemId,
        productTitle: result.productTitle,
        variantTitle: result.variantTitle !== "Default Title" ? result.variantTitle : null,
        barcode: result.barcode ?? "",
      })),
    ]);
    setSelectedIds(new Set());
    setSearchQuery("");
    setShowDropdown(false);
  }

  function removeItem(key: string) {
    setLineItems((prev) => prev.filter((i) => i.key !== key));
  }

  function updateQty(key: string, value: number) {
    setLineItems((prev) => prev.map((i) => (i.key === key ? { ...i, quantity: value } : i)));
  }

  function updateCost(key: string, value: number) {
    setLineItems((prev) => prev.map((i) => (i.key === key ? { ...i, unitCost: value } : i)));
  }

  const totalCredit = lineItems.reduce((s, i) => s + i.quantity * i.unitCost, 0);

  const inputCls = "border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-gray-800 dark:text-gray-100";
  const labelCls = "block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1";

  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-6 mb-6">
      <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100 mb-5">New Credit Invoice</h3>

      <form method="post">
        <input type="hidden" name="intent" value="createCreditInvoice" />
        <input type="hidden" name="lineItems" value={JSON.stringify(lineItems)} />

        {/* Header fields */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 mb-6">
          <div>
            <label className={labelCls}>Vendor <span className="text-red-500">*</span></label>
            <select
              name="vendorId"
              required
              className={`${inputCls} w-full`}
              onChange={(e) => {
                const v = vendors.find((v) => v.id === Number(e.target.value));
                setSelectedVendorName(v?.name ?? "");
              }}
            >
              <option value="">Select vendor…</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Supplier</label>
            <select name="supplierId" className={`${inputCls} w-full`}>
              <option value="">None</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Date <span className="text-red-500">*</span></label>
            <input type="date" name="date" required defaultValue={new Date().toISOString().slice(0, 10)} className={`${inputCls} w-full`} />
          </div>
          <div>
            <label className={labelCls}>Reference #</label>
            <input type="text" name="invoiceNumber" placeholder="Optional" className={`${inputCls} w-full`} />
          </div>
          <div>
            <label className={labelCls}>Notes</label>
            <input type="text" name="notes" placeholder="e.g. Damaged goods…" className={`${inputCls} w-full`} />
          </div>
        </div>

        {/* Product search */}
        <div className="mb-4">
          <div className="relative">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onFocus={() => searchQuery.length >= 2 && setShowDropdown(true)}
              onBlur={() => setTimeout(() => { setShowDropdown(false); setSelectedIds(new Set()); }, 150)}
              placeholder="Add product by name or SKU…"
              className={`${inputCls} w-full`}
            />
            {isSearching && (
              <span className="absolute right-3 top-2.5 text-xs text-gray-400 dark:text-gray-500">Searching…</span>
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
                            className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer border-b border-gray-100 dark:border-gray-700 last:border-b-0 transition-colors"
                          >
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => {
                                setSelectedIds((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(result.variantId)) next.delete(result.variantId);
                                  else next.add(result.variantId);
                                  return next;
                                });
                              }}
                              onClick={(e) => e.stopPropagation()}
                              className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 shrink-0 cursor-pointer"
                            />
                            <div className="flex-1 min-w-0">
                              <div>
                                <span className="text-sm font-medium text-gray-800 dark:text-gray-100">{displayName}</span>
                                {result.sku && (
                                  <span className="ml-2 text-gray-400 dark:text-gray-500 font-mono text-xs">{result.sku}</span>
                                )}
                              </div>
                              {result.vendor && (
                                <div className="text-xs text-gray-400 dark:text-gray-500 truncate">{result.vendor}</div>
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
                    <button type="button" onClick={addSelected} className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300">
                      Add selected
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Line items table */}
        {lineItems.length > 0 && (
          <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden mb-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600 dark:text-gray-400">Product / SKU</th>
                  <th className="text-right px-4 py-2.5 font-medium text-gray-600 dark:text-gray-400 w-28">Qty Returned</th>
                  <th className="text-right px-4 py-2.5 font-medium text-gray-600 dark:text-gray-400 w-32">Unit Cost</th>
                  <th className="text-right px-4 py-2.5 font-medium text-gray-600 dark:text-gray-400 w-32">Line Total</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {lineItems.map((item, idx) => {
                  const lineTotal = -(item.quantity * item.unitCost);
                  return (
                    <tr key={item.key} className={idx < lineItems.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : ""}>
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-gray-800 dark:text-gray-100">{item.description}</div>
                        {item.variantTitle && (
                          <div className="text-xs text-gray-500 dark:text-gray-400">{item.variantTitle}</div>
                        )}
                        {item.sku && (
                          <div className="font-mono text-xs text-gray-400 dark:text-gray-500">{item.sku}</div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <input
                          type="number"
                          min="1"
                          step="1"
                          value={item.quantity}
                          onChange={(e) => updateQty(item.key, Math.max(1, parseInt(e.target.value) || 1))}
                          className="w-20 text-right border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                        />
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={item.unitCost}
                          onChange={(e) => updateCost(item.key, parseFloat(e.target.value) || 0)}
                          className="w-24 text-right border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                        />
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium text-red-600 dark:text-red-400 tabular-nums">
                        {fmtCurrency(lineTotal)}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <button
                          type="button"
                          onClick={() => removeItem(item.key)}
                          className="text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors text-lg leading-none"
                          aria-label="Remove"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-4 py-3 flex justify-end">
              <div className="text-sm">
                <span className="text-gray-500 dark:text-gray-400 mr-3">Total Credit</span>
                <span className="font-semibold text-red-600 dark:text-red-400 text-base tabular-nums">
                  {fmtCurrency(-totalCredit)}
                </span>
              </div>
            </div>
          </div>
        )}

        {lineItems.length === 0 && (
          <p className="text-sm text-gray-400 dark:text-gray-500 mb-4 text-center py-6 border border-dashed border-gray-200 dark:border-gray-700 rounded-xl">
            Search for products above to add line items.
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100 px-4 py-2 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={lineItems.length === 0}
            className="text-sm bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 py-2 rounded-lg transition-colors font-medium"
          >
            Create Credit
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── Page component ───────────────────────────────────────────────────────────

export default function CreditsPage({ loaderData }: Route.ComponentProps) {
  const { credits, vendors, suppliers, vendorParam, searchParam, total } = loaderData;
  const actionData = useActionData<typeof action>();
  const navigate = useNavigate();
  const [searchValue, setSearchValue] = useState(searchParam ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // "simple" = dollar-amount form, "builder" = full invoice builder, null = neither
  const [mode, setMode] = useState<null | "simple" | "builder">(null);
  const [addSku, setAddSku] = useState("");

  const csvRef = useRef<HTMLInputElement>(null);
  const csvFormRef = useRef<HTMLFormElement>(null);

  const importResult = (actionData as { importResult?: { imported: number; vendorsCreated: number; errors: { row: number; message: string }[] } | null } | null)?.importResult;
  const actionError = (actionData as { error?: string | null } | null)?.error;

  function handleVendorChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const params = new URLSearchParams(window.location.search);
    if (e.target.value) params.set("vendor", e.target.value);
    else params.delete("vendor");
    navigate(`/credits?${params.toString()}`);
  }

  function handleSearchChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    setSearchValue(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      if (value) params.set("search", value);
      else params.delete("search");
      navigate(`/credits?${params.toString()}`);
    }, 300);
  }

  function handleCsvChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) csvFormRef.current?.requestSubmit();
  }

  const hasFilters = vendorParam || searchParam;
  const inputCls = "text-sm border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500";
  const labelCls = "block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1";

  return (
    <main className="p-8 max-w-6xl mx-auto">
      {/* ── Page header ── */}
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Credits</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setMode(mode === "builder" ? null : "builder")}
            className="text-sm bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg transition-colors font-medium"
          >
            {mode === "builder" ? "Cancel" : "+ New Credit Invoice"}
          </button>
          <button
            onClick={() => setMode(mode === "simple" ? null : "simple")}
            className="text-sm bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 px-4 py-2 rounded-lg transition-colors font-medium"
          >
            {mode === "simple" ? "Cancel" : "+ Quick Credit"}
          </button>
          <form ref={csvFormRef} method="post" encType="multipart/form-data">
            <input type="hidden" name="intent" value="importCsv" />
            <input ref={csvRef} type="file" name="csv" accept=".csv" className="hidden" onChange={handleCsvChange} />
            <button
              type="button"
              onClick={() => csvRef.current?.click()}
              className="text-sm bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 px-4 py-2 rounded-lg transition-colors font-medium"
            >
              Upload CSV
            </button>
          </form>
        </div>
      </div>

      {/* ── Total summary ── */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-6 mb-6">
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">Total Credits</p>
        <p className="text-2xl font-semibold text-green-600 dark:text-green-400">{fmtCurrency(total)}</p>
        {hasFilters && <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Filtered results</p>}
      </div>

      {/* ── Banners ── */}
      {importResult && (
        <div className="mb-4 p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 rounded-xl text-sm text-green-800 dark:text-green-300">
          Imported {importResult.imported} credit{importResult.imported !== 1 ? "s" : ""}
          {importResult.vendorsCreated > 0 && `, created ${importResult.vendorsCreated} new vendor${importResult.vendorsCreated !== 1 ? "s" : ""}`}.
          {importResult.errors.length > 0 && (
            <div className="mt-2 text-yellow-700 dark:text-yellow-400">
              {importResult.errors.length} row{importResult.errors.length !== 1 ? "s" : ""} skipped:
              {importResult.errors.map((e) => <div key={e.row} className="ml-2">Row {e.row}: {e.message}</div>)}
            </div>
          )}
        </div>
      )}
      {actionError && (
        <div className="mb-4 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-xl text-sm text-red-700 dark:text-red-400">
          {actionError}
        </div>
      )}

      {/* ── Full credit invoice builder ── */}
      {mode === "builder" && (
        <CreditInvoiceBuilder vendors={vendors} suppliers={suppliers} onCancel={() => setMode(null)} />
      )}

      {/* ── Quick credit form ── */}
      {mode === "simple" && (
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-6 mb-6">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-4">Quick Credit</h3>
          <form method="post" className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
            <input type="hidden" name="intent" value="addCredit" />
            <div>
              <label className={labelCls}>Vendor *</label>
              <select name="vendorId" required className={`${inputCls} w-full`}>
                <option value="">Select vendor…</option>
                {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Supplier</label>
              <select name="supplierId" className={`${inputCls} w-full`}>
                <option value="">None</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Credit Amount *</label>
              <input type="number" name="amount" step="0.01" min="0" placeholder="0.00" required className={`${inputCls} w-full`} />
            </div>
            <div>
              <label className={labelCls}>Date *</label>
              <input type="date" name="date" defaultValue={new Date().toISOString().slice(0, 10)} required className={`${inputCls} w-full`} />
            </div>
            <div>
              <label className={labelCls}>Invoice / Reference #</label>
              <input type="text" name="invoiceNumber" placeholder="Optional" className={`${inputCls} w-full`} />
            </div>
            <div>
              <label className={labelCls}>SKU (triggers inventory deduction)</label>
              <input type="text" name="sku" placeholder="e.g. ABC-123" value={addSku} onChange={(e) => setAddSku(e.target.value)} className={`${inputCls} w-full`} />
            </div>
            {addSku && (
              <div>
                <label className={labelCls}>Quantity to deduct</label>
                <input type="number" name="quantity" placeholder="e.g. 2" className={`${inputCls} w-full`} />
              </div>
            )}
            <div>
              <label className={labelCls}>Description</label>
              <input type="text" name="description" placeholder="Optional" className={`${inputCls} w-full`} />
            </div>
            <div className="col-span-2 md:col-span-3 lg:col-span-4">
              <label className={labelCls}>Reason / Notes</label>
              <input type="text" name="notes" placeholder="e.g. Damaged goods, price adjustment…" className={`${inputCls} w-full`} />
            </div>
            <div className="col-span-2 md:col-span-3 lg:col-span-4 flex justify-end gap-2">
              <button type="button" onClick={() => setMode(null)} className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100 px-4 py-2 transition-colors">
                Cancel
              </button>
              <button type="submit" className="text-sm bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2 rounded-lg transition-colors font-medium">
                Save Credit
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Filters ── */}
      <div className="flex items-center gap-3 mb-6">
        <select value={vendorParam ?? ""} onChange={handleVendorChange} className={inputCls}>
          <option value="">All Vendors</option>
          {vendors.map((v) => <option key={v.id} value={String(v.id)}>{v.name}</option>)}
        </select>
        <input
          type="text"
          placeholder="Search SKU, notes, vendor…"
          value={searchValue}
          onChange={handleSearchChange}
          className={`${inputCls} w-64`}
        />
        {hasFilters && (
          <Link to="/credits" onClick={() => setSearchValue("")} className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100 transition-colors">
            Clear
          </Link>
        )}
      </div>

      {/* ── Table ── */}
      {credits.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <p className="text-sm text-gray-400 dark:text-gray-500">No credits recorded.</p>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Date</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Vendor</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Supplier</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">SKU / Description</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Lines</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Amount</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Notes / Ref</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {credits.map((credit, i) => (
                <tr key={credit.id} className={i < credits.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : ""}>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <Link
                      to={`/credits/${credit.id}`}
                      className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors text-sm"
                    >
                      {new Date(credit.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-800 dark:text-gray-100">
                    <Link to={`/vendors/${credit.vendorId}`} className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors">
                      {credit.vendorName}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{credit.supplierName ?? "—"}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                    {credit.sku ? (
                      <span className="font-mono text-xs">{credit.sku}</span>
                    ) : credit.description ? (
                      <span className="text-xs">{credit.description}</span>
                    ) : credit.lineItemCount > 0 ? (
                      <span className="text-xs text-gray-400 dark:text-gray-500 italic">see lines</span>
                    ) : "—"}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-500 dark:text-gray-400">
                    {credit.lineItemCount > 0 ? (
                      <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded px-1.5 py-0.5">
                        {credit.lineItemCount}
                      </span>
                    ) : "—"}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-green-600 dark:text-green-400 whitespace-nowrap tabular-nums">
                    {fmtCurrency(credit.amount)}
                  </td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400 max-w-xs truncate">
                    {credit.notes ?? credit.invoiceNumber ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Form
                      method="post"
                      onSubmit={(e) => {
                        if (!window.confirm("Delete this credit permanently?")) e.preventDefault();
                      }}
                    >
                      <input type="hidden" name="intent" value="deleteCredit" />
                      <input type="hidden" name="creditId" value={String(credit.id)} />
                      <button
                        type="submit"
                        className="text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors text-lg leading-none"
                        aria-label="Delete credit"
                        title="Delete credit"
                      >
                        ×
                      </button>
                    </Form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
