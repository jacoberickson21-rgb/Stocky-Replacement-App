import { Link } from "react-router";
import type { Route } from "./+types/dashboard";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const db = getDb();

  const [receivedInvoices, discrepantItems, allCredits] = await Promise.all([
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
    db.credit.findMany({ select: { vendorId: true, amount: true } }),
  ]);

  const creditByVendor = new Map<number, number>();
  for (const credit of allCredits) {
    const existing = creditByVendor.get(credit.vendorId) ?? 0;
    creditByVendor.set(credit.vendorId, existing + Math.abs(Number(credit.amount)));
  }

  const byVendor = new Map<number, { vendorName: string; count: number; total: number; netBalance: number }>();
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
        netBalance: 0,
      });
    }
  }
  for (const [vendorId, data] of byVendor) {
    data.netBalance = data.total - (creditByVendor.get(vendorId) ?? 0);
  }
  const vendorBreakdown = Array.from(byVendor.values()).sort(
    (a, b) => b.netBalance - a.netBalance
  );
  const totalOutstanding = vendorBreakdown.reduce(
    (sum, row) => sum + row.netBalance,
    0
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
      <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100 mb-6">Dashboard</h2>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
            Total Outstanding Balance
          </p>
          <p className="text-3xl font-bold text-gray-900 dark:text-white">
            {formatDollars(totalOutstanding)}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
            Vendors with Balance
          </p>
          <p className="text-3xl font-bold text-gray-900 dark:text-white">{vendorsWithBalance}</p>
        </div>
      </div>

      {/* Outstanding balance by vendor */}
      <section className="mb-8">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-3">
          Balance by Vendor
        </h3>
        {vendorBreakdown.length === 0 ? (
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 px-6 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
            No outstanding balances.
          </div>
        ) : (
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                  <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Vendor</th>
                  <th className="text-right px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Invoices</th>
                  <th className="text-right px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Net Balance</th>
                </tr>
              </thead>
              <tbody>
                {vendorBreakdown.map((row, i) => (
                  <tr
                    key={row.vendorName}
                    className={i < vendorBreakdown.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : ""}
                  >
                    <td className="px-6 py-4 text-gray-800 dark:text-gray-100 font-medium">{row.vendorName}</td>
                    <td className="px-6 py-4 text-right text-gray-600 dark:text-gray-300">{row.count}</td>
                    <td className="px-6 py-4 text-right font-semibold text-gray-800 dark:text-gray-100">
                      {formatDollars(row.netBalance)}
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
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-3">
          Received — Awaiting Payment
        </h3>
        {receivedInvoices.length === 0 ? (
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 px-6 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
            No invoices awaiting payment.
          </div>
        ) : (
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                  <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Invoice #</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Vendor</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Date Received</th>
                  <th className="text-right px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Amount</th>
                </tr>
              </thead>
              <tbody>
                {receivedInvoices.map((inv, i) => (
                  <tr
                    key={inv.id}
                    className={i < receivedInvoices.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : ""}
                  >
                    <td className="px-6 py-4">
                      <Link
                        to={`/invoices/${inv.id}`}
                        className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 font-medium transition-colors"
                      >
                        {inv.invoiceNumber}
                      </Link>
                    </td>
                    <td className="px-6 py-4 text-gray-600 dark:text-gray-300">{inv.vendorName}</td>
                    <td className="px-6 py-4 text-gray-600 dark:text-gray-300">
                      {new Date(inv.receivedAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </td>
                    <td className="px-6 py-4 text-right font-medium text-gray-800 dark:text-gray-100">
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
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-3">
          Receiving Discrepancies
        </h3>
        {discrepantItems.length === 0 ? (
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 px-6 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
            No discrepancies recorded.
          </div>
        ) : (
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                  <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Invoice #</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Vendor</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">SKU</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Description</th>
                  <th className="text-right px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Expected</th>
                  <th className="text-right px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Received</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Note</th>
                </tr>
              </thead>
              <tbody>
                {discrepantItems.map((item, i) => (
                  <tr
                    key={item.id}
                    className={[
                      i < discrepantItems.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : "",
                      "bg-amber-50 dark:bg-amber-950/30",
                    ].join(" ")}
                  >
                    <td className="px-6 py-4">
                      <Link
                        to={`/invoices/${item.invoiceId}`}
                        className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 font-medium transition-colors"
                      >
                        {item.invoiceNumber}
                      </Link>
                    </td>
                    <td className="px-6 py-4 text-gray-600 dark:text-gray-300">{item.vendorName}</td>
                    <td className="px-6 py-4 font-mono text-gray-700 dark:text-gray-200">{item.sku}</td>
                    <td className="px-6 py-4 text-gray-600 dark:text-gray-300">{item.description}</td>
                    <td className="px-6 py-4 text-right text-gray-700 dark:text-gray-200">{item.quantityOrdered}</td>
                    <td className="px-6 py-4 text-right font-semibold text-amber-700 dark:text-amber-300">
                      {item.quantityReceived}
                    </td>
                    <td className="px-6 py-4 text-gray-500 dark:text-gray-400 italic">
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
