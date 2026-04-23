import { redirect, data } from "react-router";
import { Link, Form, useNavigation, useFetcher } from "react-router";
import { useState, useEffect } from "react";
import Papa from "papaparse";
import type { Route } from "./+types/invoices.upload";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";
import { parsePdfInvoice } from "../services/invoice-parser.server";
import type { ExtractionResult } from "../services/invoice-parser.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const vendors = await getDb().vendor.findMany({ orderBy: { name: "asc" } });
  return { vendors };
}

export async function action({ request }: Route.ActionArgs) {
  await requireUserId(request);

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "uploadCsv");

  // ── CSV path (unchanged) ──────────────────────────────────────────────────
  if (intent === "uploadCsv") {
    const vendorId = String(form.get("vendorId") ?? "").trim();
    const invoiceNumber = String(form.get("invoiceNumber") ?? "").trim();
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
    const dueDate = dueDateRaw ? new Date(dueDateRaw) : null;
    const invoice = await getDb().$transaction(async (tx) => {
      const created = await tx.invoice.create({
        data: { invoiceNumber, vendorId: Number(vendorId), status: "ORDERED", dueDate, total },
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
    const dueDate = dueDateRaw ? new Date(dueDateRaw) : null;

    const invoice = await getDb().$transaction(async (tx) => {
      const created = await tx.invoice.create({
        data: { invoiceNumber, vendorId: Number(vendorId), status: "ORDERED", dueDate, total },
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

  return redirect("/invoices/upload");
}

// ── Component ─────────────────────────────────────────────────────────────

type Vendor = { id: number; name: string };

function FlagIcon() {
  return (
    <span title="Low confidence — please verify" className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-amber-400 text-white text-xs font-bold ml-1">!</span>
  );
}

function ConfidencePct({ value }: { value: number }) {
  return <span className="text-xs text-gray-400 ml-1">({Math.round(value * 100)}%)</span>;
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

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Due Date
                {extraction.dueDate.flagged ? <FlagIcon /> : <ConfidencePct value={extraction.dueDate.confidence} />}
              </label>
              <input
                name="dueDate"
                type="date"
                defaultValue={extraction.dueDate.value ?? ""}
                className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${extraction.dueDate.flagged ? "border-amber-400 bg-amber-50" : "border-gray-300"}`}
              />
            </div>
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
  const [uploadMode, setUploadMode] = useState<"csv" | "pdf">("csv");
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

  const errors = actionData?.step !== "reviewPdf" ? (actionData?.errors ?? {}) : {};
  const general = actionData?.step !== "reviewPdf" ? (actionData?.general ?? null) : null;

  return (
    <main className="p-8 max-w-xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link to="/invoices" className="text-sm text-gray-500 hover:text-gray-800 transition-colors">
          ← Purchase Orders
        </Link>
        <span className="text-gray-300">/</span>
        <h2 className="text-xl font-semibold text-gray-800">Upload Invoice</h2>
      </div>

      {/* Upload type selector */}
      <div className="grid grid-cols-2 gap-4 mb-8">
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
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
        {general && (
          <p className="mb-5 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">
            {general}
          </p>
        )}

        {/* ── CSV form ── */}
        {uploadMode === "csv" && (
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
                {vendors.map((v: Vendor) => (
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

            <div>
              <label htmlFor="dueDate" className="block text-sm font-medium text-gray-700 mb-1">Due Date</label>
              <input
                id="dueDate"
                name="dueDate"
                type="date"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
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
        )}

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
      </div>
    </main>
  );
}
