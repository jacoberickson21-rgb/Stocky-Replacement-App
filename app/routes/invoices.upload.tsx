import { redirect, data } from "react-router";
import { Link } from "react-router";
import Papa from "papaparse";
import type { Route } from "./+types/invoices.upload";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const vendors = await getDb().vendor.findMany({ orderBy: { name: "asc" } });
  return { vendors };
}

export async function action({ request }: Route.ActionArgs) {
  await requireUserId(request);

  const form = await request.formData();
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
    return data({ errors, general: null }, { status: 400 });
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

    if (!sku || !description || isNaN(quantity) || isNaN(unitCost) || quantity <= 0 || unitCost < 0) {
      continue;
    }

    lineItems.push({ sku, description, quantity, unitCost });
  }

  if (lineItems.length === 0) {
    return data(
      {
        errors: {},
        general:
          "No valid line items found. Ensure the CSV has columns: sku, description, quantity, unit_cost — with at least one complete row.",
      },
      { status: 400 }
    );
  }

  const total = lineItems.reduce((sum, item) => sum + item.quantity * item.unitCost, 0);
  const dueDate = dueDateRaw ? new Date(dueDateRaw) : null;

  const invoice = await getDb().$transaction(async (tx) => {
    const created = await tx.invoice.create({
      data: {
        invoiceNumber,
        vendorId: Number(vendorId),
        status: "ORDERED",
        dueDate,
        total,
      },
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

export default function InvoiceUploadPage({ loaderData, actionData }: Route.ComponentProps) {
  const { vendors } = loaderData;
  const errors = actionData?.errors ?? {};
  const general = actionData?.general ?? null;

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
        <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-blue-500 bg-blue-50 px-6 py-8 cursor-default">
          <svg className="w-8 h-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <span className="text-sm font-medium text-blue-700">Upload CSV</span>
        </div>
        <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-gray-200 bg-gray-50 px-6 py-8 cursor-not-allowed opacity-50">
          <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
          <span className="text-sm font-medium text-gray-400">Upload PDF</span>
          <span className="text-xs text-gray-400">Coming soon</span>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
        {general && (
          <p className="mb-5 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">
            {general}
          </p>
        )}

        <form method="post" encType="multipart/form-data" className="space-y-5">
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
              {vendors.map((v: { id: number; name: string }) => (
                <option key={v.id} value={String(v.id)}>
                  {v.name}
                </option>
              ))}
            </select>
            {errors.vendorId && (
              <p className="mt-1 text-xs text-red-600">{errors.vendorId}</p>
            )}
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
            {errors.invoiceNumber && (
              <p className="mt-1 text-xs text-red-600">{errors.invoiceNumber}</p>
            )}
          </div>

          <div>
            <label htmlFor="dueDate" className="block text-sm font-medium text-gray-700 mb-1">
              Due Date
            </label>
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
            {errors.csvFile && (
              <p className="mt-1 text-xs text-red-600">{errors.csvFile}</p>
            )}
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
      </div>
    </main>
  );
}
