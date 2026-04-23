import { Link, Form, redirect } from "react-router";
import type { Route } from "./+types/invoices.$id";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";
import type { InvoiceStatus } from "@prisma/client";

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
  const id = Number(params.id);
  const invoice = await getDb().invoice.findUnique({
    where: { id },
    include: { vendor: true, lineItems: true },
  });
  if (!invoice) throw new Response("Not Found", { status: 404 });
  return {
    invoice: {
      ...invoice,
      total: Number(invoice.total),
      lineItems: invoice.lineItems.map((item) => ({
        ...item,
        unitCost: Number(item.unitCost),
      })),
    },
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const id = Number(params.id);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "markPaid") {
    const db = getDb();
    const invoice = await db.invoice.findUnique({ where: { id } });
    if (!invoice || invoice.status !== "RECEIVED") {
      throw new Response("Conflict", { status: 409 });
    }
    await db.$transaction([
      db.invoice.update({ where: { id }, data: { status: "PAID" } }),
      db.auditLog.create({
        data: {
          userId,
          action: "INVOICE_MARKED_PAID",
          details: `Invoice #${invoice.invoiceNumber} marked as paid`,
        },
      }),
    ]);
  }

  return redirect(`/invoices/${id}`);
}

const STATUS_LABELS: Record<InvoiceStatus, string> = {
  ORDERED: "Ordered",
  RECEIVED: "Received",
  PAID: "Paid",
};

const STATUS_BADGE: Record<InvoiceStatus, string> = {
  ORDERED: "bg-blue-100 text-blue-700",
  RECEIVED: "bg-green-100 text-green-700",
  PAID: "bg-gray-100 text-gray-600",
};

export default function InvoiceDetailPage({ loaderData }: Route.ComponentProps) {
  const { invoice } = loaderData;
  const { vendor, lineItems } = invoice;

  return (
    <main className="p-8 max-w-5xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link
          to="/invoices"
          className="text-sm text-gray-500 hover:text-gray-800 transition-colors"
        >
          ← Invoices
        </Link>
        <span className="text-gray-300">/</span>
        <h2 className="text-xl font-semibold text-gray-800">{invoice.invoiceNumber}</h2>
      </div>

      {/* Header card */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 mb-6">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-6">
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Vendor</p>
            <p className="text-sm font-medium text-gray-800">{vendor.name}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Status</p>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_BADGE[invoice.status]}`}
            >
              {STATUS_LABELS[invoice.status]}
            </span>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Due Date</p>
            <p className="text-sm text-gray-800">
              {invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString() : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Total</p>
            <p className="text-sm font-semibold text-gray-800">
              ${Number(invoice.total).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-3 mb-6">
        {invoice.status === "ORDERED" && (
          <Link
            to={`/invoices/${invoice.id}/receive`}
            className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
          >
            Begin Receiving
          </Link>
        )}
        {invoice.status === "RECEIVED" && (
          <Form method="post">
            <input type="hidden" name="intent" value="markPaid" />
            <button
              type="submit"
              className="bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
            >
              Mark as Paid
            </button>
          </Form>
        )}
      </div>

      {/* Line items table */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="text-left px-6 py-3 font-medium text-gray-600">SKU</th>
              <th className="text-left px-6 py-3 font-medium text-gray-600">Description</th>
              <th className="text-right px-6 py-3 font-medium text-gray-600">Qty Ordered</th>
              <th className="text-right px-6 py-3 font-medium text-gray-600">Unit Cost</th>
              <th className="text-right px-6 py-3 font-medium text-gray-600">Line Total</th>
            </tr>
          </thead>
          <tbody>
            {lineItems.map((item, i) => {
              const lineTotal = item.quantityOrdered * Number(item.unitCost);
              return (
                <tr
                  key={item.id}
                  className={i < lineItems.length - 1 ? "border-b border-gray-100" : ""}
                >
                  <td className="px-6 py-4 font-mono text-gray-700">{item.sku}</td>
                  <td className="px-6 py-4 text-gray-600">{item.description}</td>
                  <td className="px-6 py-4 text-right text-gray-700">{item.quantityOrdered}</td>
                  <td className="px-6 py-4 text-right text-gray-700">
                    ${Number(item.unitCost).toFixed(2)}
                  </td>
                  <td className="px-6 py-4 text-right font-medium text-gray-800">
                    ${lineTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-gray-200 bg-gray-50">
              <td colSpan={4} className="px-6 py-3 text-sm font-medium text-gray-600 text-right">
                Total
              </td>
              <td className="px-6 py-3 text-right font-semibold text-gray-800">
                ${Number(invoice.total).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </main>
  );
}
