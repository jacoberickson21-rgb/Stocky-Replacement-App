import { useState, useEffect } from "react";
import { Link, useActionData } from "react-router";
import type { Route } from "./+types/vendors.$id";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
  const id = Number(params.id);
  const vendor = await getDb().vendor.findUniqueOrThrow({
    where: { id },
    include: {
      invoices: { orderBy: { createdAt: "desc" } },
      credits: { orderBy: { date: "desc" } },
    },
  });

  const totalInvoices = vendor.invoices.reduce((sum, inv) => sum + Number(inv.total), 0);
  const totalCredits = vendor.credits.reduce((sum, c) => sum + Math.abs(Number(c.amount)), 0);
  const netBalance = totalInvoices - totalCredits;

  return {
    vendor: {
      id: vendor.id,
      name: vendor.name,
      contactName: vendor.contactName,
      email: vendor.email,
      phone: vendor.phone,
    },
    invoices: vendor.invoices.map((inv) => ({
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      status: inv.status,
      total: Number(inv.total),
      createdAt: inv.createdAt.toISOString(),
    })),
    credits: vendor.credits.map((c) => ({
      id: c.id,
      amount: Math.abs(Number(c.amount)),
      invoiceNumber: c.invoiceNumber,
      notes: c.notes,
      date: c.date.toISOString(),
    })),
    totalInvoices,
    totalCredits,
    netBalance,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  await requireUserId(request);
  const vendorId = Number(params.id);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "addCredit") {
    const amountRaw = (formData.get("amount") as string) ?? "";
    const dateRaw = (formData.get("date") as string) ?? "";
    const invoiceNumber = ((formData.get("invoiceNumber") as string) ?? "").trim() || null;
    const notes = ((formData.get("notes") as string) ?? "").trim() || null;

    const amount = parseFloat(amountRaw);
    if (!amountRaw || isNaN(amount) || amount <= 0) {
      return { error: "Amount must be a positive number." };
    }
    if (!dateRaw) {
      return { error: "Date is required." };
    }
    const date = new Date(dateRaw + "T00:00:00");
    if (isNaN(date.getTime())) {
      return { error: "Invalid date." };
    }

    await getDb().credit.create({
      data: { vendorId, amount: -amount, date, invoiceNumber, notes },
    });
    return { success: true };
  }

  return null;
}

function formatDollars(amount: number) {
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });
}

function todayString() {
  return new Date().toISOString().split("T")[0];
}

const statusStyles: Record<string, string> = {
  ORDERED: "bg-gray-100 text-gray-600",
  RECEIVED: "bg-amber-100 text-amber-700",
  PAID: "bg-green-100 text-green-700",
};

const statusLabels: Record<string, string> = {
  ORDERED: "Ordered",
  RECEIVED: "Received",
  PAID: "Paid",
};

const inputClass =
  "border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white";

export default function VendorDetailPage({ loaderData }: Route.ComponentProps) {
  const { vendor, invoices, credits, totalInvoices, totalCredits, netBalance } = loaderData;
  const actionData = useActionData() as { error?: string; success?: boolean } | undefined;
  const [showAddCredit, setShowAddCredit] = useState(false);

  useEffect(() => {
    if (actionData?.success) {
      setShowAddCredit(false);
    }
  }, [actionData]);

  return (
    <main className="p-8 max-w-5xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-3 mb-6">
        <Link
          to="/vendors"
          className="text-sm text-gray-500 hover:text-gray-800 transition-colors"
        >
          ← Vendors
        </Link>
        <span className="text-gray-300">/</span>
        <h2 className="text-xl font-semibold text-gray-800">{vendor.name}</h2>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
            Total Invoices
          </p>
          <p className="text-2xl font-bold text-gray-900">{formatDollars(totalInvoices)}</p>
        </div>
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
            Total Credits
          </p>
          <p className="text-2xl font-bold text-green-600">{formatDollars(totalCredits)}</p>
        </div>
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
            Net Balance
          </p>
          <p className="text-2xl font-bold text-gray-900">{formatDollars(netBalance)}</p>
        </div>
      </div>

      {/* Contact info */}
      {(vendor.contactName || vendor.email || vendor.phone) && (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 mb-6">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Contact</h3>
          <div className="flex gap-8 text-sm text-gray-600">
            {vendor.contactName && <span>{vendor.contactName}</span>}
            {vendor.email && (
              <a
                href={`mailto:${vendor.email}`}
                className="text-blue-600 hover:text-blue-800 transition-colors"
              >
                {vendor.email}
              </a>
            )}
            {vendor.phone && <span>{vendor.phone}</span>}
          </div>
        </div>
      )}

      {/* Invoices */}
      <section className="mb-6">
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
          Invoices
        </h3>
        {invoices.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 px-6 py-8 text-center text-sm text-gray-400">
            No invoices yet.
          </div>
        ) : (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Invoice #</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Status</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Date</th>
                  <th className="text-right px-6 py-3 font-medium text-gray-600">Amount</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv, i) => (
                  <tr
                    key={inv.id}
                    className={i < invoices.length - 1 ? "border-b border-gray-100" : ""}
                  >
                    <td className="px-6 py-4">
                      <Link
                        to={`/invoices/${inv.id}`}
                        className="text-blue-600 hover:text-blue-800 font-medium transition-colors"
                      >
                        {inv.invoiceNumber}
                      </Link>
                    </td>
                    <td className="px-6 py-4">
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${statusStyles[inv.status]}`}
                      >
                        {statusLabels[inv.status]}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-gray-600">
                      {new Date(inv.createdAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </td>
                    <td className="px-6 py-4 text-right font-medium text-gray-800">
                      {formatDollars(inv.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Credits */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
            Credits
          </h3>
          <button
            type="button"
            onClick={() => setShowAddCredit(!showAddCredit)}
            className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
          >
            {showAddCredit ? "Cancel" : "Add Credit"}
          </button>
        </div>

        {showAddCredit && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 mb-4">
            <form method="post">
              <input type="hidden" name="intent" value="addCredit" />
              <div className="flex flex-col gap-3">
                <div className="flex gap-4">
                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-gray-600">Amount ($)</label>
                    <input
                      name="amount"
                      type="number"
                      min="0.01"
                      step="0.01"
                      placeholder="0.00"
                      className={`${inputClass} w-36`}
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-gray-600">Invoice # (optional)</label>
                    <input
                      name="invoiceNumber"
                      type="text"
                      placeholder="e.g. INV-1234"
                      className={`${inputClass} w-36`}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-gray-600">Date</label>
                    <input
                      name="date"
                      type="date"
                      defaultValue={todayString()}
                      className={`${inputClass} w-44`}
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-1 flex-1">
                    <label className="text-xs font-medium text-gray-600">Notes (optional)</label>
                    <input
                      name="notes"
                      type="text"
                      placeholder="e.g. Pricing discrepancy on order #1234"
                      className={`${inputClass} w-full`}
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  {actionData?.error ? (
                    <p className="text-sm text-red-600">{actionData.error}</p>
                  ) : (
                    <span />
                  )}
                  <button
                    type="submit"
                    className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
                  >
                    Save Credit
                  </button>
                </div>
              </div>
            </form>
          </div>
        )}

        {credits.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 px-6 py-8 text-center text-sm text-gray-400">
            No credits recorded.
          </div>
        ) : (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Date</th>
                  <th className="text-right px-6 py-3 font-medium text-gray-600">Amount</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Invoice #</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Notes</th>
                </tr>
              </thead>
              <tbody>
                {credits.map((credit, i) => (
                  <tr
                    key={credit.id}
                    className={i < credits.length - 1 ? "border-b border-gray-100" : ""}
                  >
                    <td className="px-6 py-4 text-gray-600">
                      {new Date(credit.date).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </td>
                    <td className="px-6 py-4 text-right font-medium text-green-600">
                      {formatDollars(credit.amount)}
                    </td>
                    <td className="px-6 py-4 font-mono text-gray-700 text-sm">{credit.invoiceNumber ?? "—"}</td>
                    <td className="px-6 py-4 text-gray-500">{credit.notes ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
