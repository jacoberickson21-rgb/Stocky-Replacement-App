import { Link } from "react-router";
import type { Route } from "./+types/dashboard";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const db = getDb();

  const [receivedInvoices, discrepantItems] = await Promise.all([
    db.invoice.findMany({
      where: { status: "RECEIVED" },
      include: { vendor: true },
      orderBy: { updatedAt: "desc" },
    }),
    db.invoiceLineItem.findMany({
      where: { hasDiscrepancy: true },
      include: { invoice: { include: { vendor: true } } },
      orderBy: { invoiceId: "desc" },
    }),
  ]);

  const totalOutstanding = receivedInvoices.reduce(
    (sum, inv) => sum + Number(inv.total),
    0
  );

  // Group by vendor
  const byVendor = new Map<number, { vendorName: string; count: number; total: number }>();
  for (const inv of receivedInvoices) {
    const existing = byVendor.get(inv.vendorId);
    if (existing) {
      existing.count += 1;
      existing.total += Number(inv.total);
    } else {
      byVendor.set(inv.vendorId, {
        vendorName: inv.vendor.name,
        count: 1,
        total: Number(inv.total),
      });
    }
  }
  const vendorBreakdown = Array.from(byVendor.values()).sort(
    (a, b) => b.total - a.total
  );

  return {
    totalOutstanding,
    vendorsWithBalance: byVendor.size,
    vendorBreakdown,
    receivedInvoices: receivedInvoices.map((inv) => ({
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      vendorName: inv.vendor.name,
      receivedAt: inv.updatedAt.toISOString(),
      total: Number(inv.total),
    })),
    discrepantItems: discrepantItems.map((item) => ({
      id: item.id,
      invoiceId: item.invoiceId,
      invoiceNumber: item.invoice.invoiceNumber,
      vendorName: item.invoice.vendor.name,
      sku: item.sku,
      description: item.description,
      quantityOrdered: item.quantityOrdered,
      quantityReceived: item.quantityReceived,
      receivingNote: item.receivingNote,
    })),
  };
}

function formatDollars(amount: number) {
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });
}

export default function DashboardPage({ loaderData }: Route.ComponentProps) {
  const {
    totalOutstanding,
    vendorsWithBalance,
    vendorBreakdown,
    receivedInvoices,
    discrepantItems,
  } = loaderData;

  return (
    <main className="p-8 max-w-5xl mx-auto">
      <h2 className="text-xl font-semibold text-gray-800 mb-6">Dashboard</h2>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
            Total Outstanding Balance
          </p>
          <p className="text-3xl font-bold text-gray-900">
            {formatDollars(totalOutstanding)}
          </p>
        </div>
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
            Vendors with Balance
          </p>
          <p className="text-3xl font-bold text-gray-900">{vendorsWithBalance}</p>
        </div>
      </div>

      {/* Outstanding balance by vendor */}
      <section className="mb-8">
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
          Balance by Vendor
        </h3>
        {vendorBreakdown.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 px-6 py-8 text-center text-sm text-gray-400">
            No outstanding balances.
          </div>
        ) : (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Vendor</th>
                  <th className="text-right px-6 py-3 font-medium text-gray-600">Invoices</th>
                  <th className="text-right px-6 py-3 font-medium text-gray-600">Amount Owed</th>
                </tr>
              </thead>
              <tbody>
                {vendorBreakdown.map((row, i) => (
                  <tr
                    key={row.vendorName}
                    className={i < vendorBreakdown.length - 1 ? "border-b border-gray-100" : ""}
                  >
                    <td className="px-6 py-4 text-gray-800 font-medium">{row.vendorName}</td>
                    <td className="px-6 py-4 text-right text-gray-600">{row.count}</td>
                    <td className="px-6 py-4 text-right font-semibold text-gray-800">
                      {formatDollars(row.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Received but unpaid invoices */}
      <section className="mb-8">
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
          Received — Awaiting Payment
        </h3>
        {receivedInvoices.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 px-6 py-8 text-center text-sm text-gray-400">
            No invoices awaiting payment.
          </div>
        ) : (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Invoice #</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Vendor</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Date Received</th>
                  <th className="text-right px-6 py-3 font-medium text-gray-600">Amount</th>
                </tr>
              </thead>
              <tbody>
                {receivedInvoices.map((inv, i) => (
                  <tr
                    key={inv.id}
                    className={i < receivedInvoices.length - 1 ? "border-b border-gray-100" : ""}
                  >
                    <td className="px-6 py-4">
                      <Link
                        to={`/invoices/${inv.id}`}
                        className="text-blue-600 hover:text-blue-800 font-medium transition-colors"
                      >
                        {inv.invoiceNumber}
                      </Link>
                    </td>
                    <td className="px-6 py-4 text-gray-600">{inv.vendorName}</td>
                    <td className="px-6 py-4 text-gray-600">
                      {new Date(inv.receivedAt).toLocaleDateString("en-US", {
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

      {/* Receiving discrepancies */}
      <section>
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">
          Receiving Discrepancies
        </h3>
        {discrepantItems.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 px-6 py-8 text-center text-sm text-gray-400">
            No discrepancies recorded.
          </div>
        ) : (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Invoice #</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Vendor</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600">SKU</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Description</th>
                  <th className="text-right px-6 py-3 font-medium text-gray-600">Expected</th>
                  <th className="text-right px-6 py-3 font-medium text-gray-600">Received</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Note</th>
                </tr>
              </thead>
              <tbody>
                {discrepantItems.map((item, i) => (
                  <tr
                    key={item.id}
                    className={[
                      i < discrepantItems.length - 1 ? "border-b border-gray-100" : "",
                      "bg-amber-50",
                    ].join(" ")}
                  >
                    <td className="px-6 py-4">
                      <Link
                        to={`/invoices/${item.invoiceId}`}
                        className="text-blue-600 hover:text-blue-800 font-medium transition-colors"
                      >
                        {item.invoiceNumber}
                      </Link>
                    </td>
                    <td className="px-6 py-4 text-gray-600">{item.vendorName}</td>
                    <td className="px-6 py-4 font-mono text-gray-700">{item.sku}</td>
                    <td className="px-6 py-4 text-gray-600">{item.description}</td>
                    <td className="px-6 py-4 text-right text-gray-700">{item.quantityOrdered}</td>
                    <td className="px-6 py-4 text-right font-semibold text-amber-700">
                      {item.quantityReceived}
                    </td>
                    <td className="px-6 py-4 text-gray-500 italic">
                      {item.receivingNote ?? "—"}
                    </td>
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
