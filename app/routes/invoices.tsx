import { Link, useNavigate, Form } from "react-router";
import type { Route } from "./+types/invoices";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";
import type { InvoiceStatus } from "@prisma/client";

export async function action({ request }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const formData = await request.formData();
  const invoiceId = Number(formData.get("invoiceId"));
  const db = getDb();
  const invoice = await db.invoice.findUnique({ where: { id: invoiceId } });
  const intent = formData.get("intent");

  if (intent === "markPaid") {
    if (!invoice || invoice.status !== "RECEIVED") throw new Response("Conflict", { status: 409 });
    await db.$transaction([
      db.invoice.update({ where: { id: invoiceId }, data: { status: "PAID" } }),
      db.auditLog.create({
        data: { userId, action: "INVOICE_MARKED_PAID", details: `Invoice #${invoice.invoiceNumber} marked as paid` },
      }),
    ]);
  } else if (intent === "unmarkPaid") {
    if (!invoice || invoice.status !== "PAID") throw new Response("Conflict", { status: 409 });
    await db.$transaction([
      db.invoice.update({ where: { id: invoiceId }, data: { status: "RECEIVED" } }),
      db.auditLog.create({
        data: { userId, action: "INVOICE_UNMARKED_PAID", details: `Invoice #${invoice.invoiceNumber} payment mark reversed` },
      }),
    ]);
  }

  return null;
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const url = new URL(request.url);
  const vendorParam = url.searchParams.get("vendor");
  const statusParam = url.searchParams.get("status") as InvoiceStatus | null;

  const where: Record<string, unknown> = {};
  if (vendorParam) where.vendorId = Number(vendorParam);
  if (statusParam && ["ORDERED", "RECEIVED", "PAID"].includes(statusParam)) {
    where.status = statusParam;
  }

  const invoices = await getDb().invoice.findMany({
    where,
    include: { vendor: true },
    orderBy: { createdAt: "desc" },
  });

  const vendors = await getDb().vendor.findMany({ orderBy: { name: "asc" } });

  return {
    invoices: invoices.map((inv) => ({ ...inv, total: Number(inv.total) })),
    vendors,
    vendorParam,
    statusParam,
  };
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

export default function InvoicesPage({ loaderData }: Route.ComponentProps) {
  const { invoices, vendors, vendorParam, statusParam } = loaderData;
  const navigate = useNavigate();

  return (
    <main className="p-8 max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold text-gray-800">Purchase Orders</h2>
          <button
            type="button"
            onClick={() => navigate("/invoices/upload")}
            className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
          >
            Upload Invoice
          </button>
        </div>

        <form method="get" className="flex items-center gap-3 mb-6">
          <select
            name="vendor"
            defaultValue={vendorParam ?? ""}
            className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All Vendors</option>
            {vendors.map((v) => (
              <option key={v.id} value={String(v.id)}>
                {v.name}
              </option>
            ))}
          </select>

          <select
            name="status"
            defaultValue={statusParam ?? ""}
            className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All Statuses</option>
            <option value="ORDERED">Ordered</option>
            <option value="RECEIVED">Received</option>
            <option value="PAID">Paid</option>
          </select>

          <button
            type="submit"
            className="text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium rounded-lg px-4 py-2 transition-colors"
          >
            Filter
          </button>

          {(vendorParam || statusParam) && (
            <Link
              to="/invoices"
              className="text-sm text-gray-500 hover:text-gray-800 transition-colors"
            >
              Clear
            </Link>
          )}
        </form>

        {invoices.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <p className="text-sm text-gray-400">No invoices match your filters.</p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Invoice #</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Vendor</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Status</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Due Date</th>
                  <th className="text-right px-6 py-3 font-medium text-gray-600">Total</th>
                  <th className="text-center px-6 py-3 font-medium text-gray-600">Paid?</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice, i) => (
                  <tr
                    key={invoice.id}
                    className={i < invoices.length - 1 ? "border-b border-gray-100" : ""}
                  >
                    <td className="px-6 py-4 font-medium text-gray-800">
                      <Link
                        to={`/invoices/${invoice.id}`}
                        className="text-blue-600 hover:text-blue-800 transition-colors"
                      >
                        {invoice.invoiceNumber}
                      </Link>
                    </td>
                    <td className="px-6 py-4 text-gray-600">{invoice.vendor.name}</td>
                    <td className="px-6 py-4">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_BADGE[invoice.status]}`}
                      >
                        {STATUS_LABELS[invoice.status]}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-gray-600">
                      {invoice.dueDate
                        ? new Date(invoice.dueDate).toLocaleDateString()
                        : "—"}
                    </td>
                    <td className="px-6 py-4 text-right text-gray-800 font-medium">
                      ${Number(invoice.total).toFixed(2)}
                    </td>
                    <td className="px-6 py-4 text-center">
                      {invoice.status === "PAID" ? (
                        <Form method="post">
                          <input type="hidden" name="invoiceId" value={invoice.id} />
                          <input type="hidden" name="intent" value="unmarkPaid" />
                          <input
                            type="checkbox"
                            defaultChecked
                            onChange={(e) => { if (!e.target.checked) e.target.form?.requestSubmit(); }}
                            className="w-4 h-4 accent-green-600 cursor-pointer"
                          />
                        </Form>
                      ) : invoice.status === "RECEIVED" ? (
                        <Form method="post">
                          <input type="hidden" name="invoiceId" value={invoice.id} />
                          <input type="hidden" name="intent" value="markPaid" />
                          <input
                            type="checkbox"
                            onChange={(e) => { if (e.target.checked) e.target.form?.requestSubmit(); }}
                            className="w-4 h-4 accent-green-600 cursor-pointer"
                          />
                        </Form>
                      ) : null}
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
