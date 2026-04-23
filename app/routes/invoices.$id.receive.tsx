import { Link, Form, redirect, data, useNavigation } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/invoices.$id.receive";
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
  if (invoice.status !== "ORDERED") return redirect(`/invoices/${id}`);
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
  const db = getDb();

  const invoice = await db.invoice.findUnique({
    where: { id },
    include: { lineItems: true },
  });
  if (!invoice || invoice.status !== "ORDERED") {
    throw new Response("Conflict", { status: 409 });
  }

  const formData = await request.formData();

  // Validate all quantity fields are present and numeric
  for (const item of invoice.lineItems) {
    const val = formData.get(`qty_${item.id}`);
    if (val === null || val === "" || isNaN(Number(val))) {
      return data(
        { error: "All quantity fields must be filled in before submitting." },
        { status: 422 }
      );
    }
  }

  const discrepancies: string[] = [];

  await db.$transaction([
    ...invoice.lineItems.map((item) => {
      const received = Number(formData.get(`qty_${item.id}`));
      const note = (formData.get(`note_${item.id}`) as string | null) ?? "";
      const hasDiscrepancy = received !== item.quantityOrdered;
      if (hasDiscrepancy) {
        discrepancies.push(
          `${item.sku}: expected ${item.quantityOrdered}, received ${received}`
        );
      }
      return db.invoiceLineItem.update({
        where: { id: item.id },
        data: {
          quantityReceived: received,
          hasDiscrepancy,
          receivingNote: note || null,
        },
      });
    }),
    db.invoice.update({ where: { id }, data: { status: "RECEIVED" } }),
    db.auditLog.create({
      data: {
        userId,
        action: "INVOICE_RECEIVED",
        details:
          discrepancies.length > 0
            ? `Invoice #${invoice.invoiceNumber} received with discrepancies: ${discrepancies.join("; ")}`
            : `Invoice #${invoice.invoiceNumber} received — all quantities matched`,
      },
    }),
  ]);

  return redirect(`/invoices/${id}`);
}

const STATUS_BADGE: Record<InvoiceStatus, string> = {
  ORDERED: "bg-blue-100 text-blue-700",
  RECEIVED: "bg-green-100 text-green-700",
  PAID: "bg-gray-100 text-gray-600",
};

export default function ReceivingPage({ loaderData }: Route.ComponentProps) {
  const { invoice } = loaderData;
  const { vendor, lineItems } = invoice;
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [quantities, setQuantities] = useState<Record<number, string>>(() =>
    Object.fromEntries(lineItems.map((item) => [item.id, String(item.quantityOrdered)]))
  );

  const allFilled = lineItems.every(
    (item) => quantities[item.id] !== "" && quantities[item.id] !== undefined
  );

  return (
    <main className="p-8 max-w-5xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-3 mb-6">
        <Link
          to={`/invoices/${invoice.id}`}
          className="text-sm text-gray-500 hover:text-gray-800 transition-colors"
        >
          ← {invoice.invoiceNumber}
        </Link>
        <span className="text-gray-300">/</span>
        <h2 className="text-xl font-semibold text-gray-800">Receive Shipment</h2>
      </div>

      {/* Header card */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 mb-6">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-6">
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Vendor</p>
            <p className="text-sm font-medium text-gray-800">{vendor.name}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Invoice</p>
            <p className="text-sm font-medium text-gray-800">{invoice.invoiceNumber}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Status</p>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_BADGE[invoice.status]}`}
            >
              Ordered
            </span>
          </div>
        </div>
      </div>

      {/* Receiving form */}
      <Form method="post">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden mb-6">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-6 py-3 font-medium text-gray-600">SKU</th>
                <th className="text-left px-6 py-3 font-medium text-gray-600">Description</th>
                <th className="text-right px-6 py-3 font-medium text-gray-600">Expected</th>
                <th className="text-right px-6 py-3 font-medium text-gray-600 w-36">Received</th>
                <th className="text-left px-6 py-3 font-medium text-gray-600">Note</th>
                <th className="px-4 py-3 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {lineItems.map((item, i) => {
                const rawQty = quantities[item.id];
                const parsedQty = rawQty !== "" ? Number(rawQty) : null;
                const hasDiscrepancy =
                  parsedQty !== null && parsedQty !== item.quantityOrdered;

                return (
                  <tr
                    key={item.id}
                    className={[
                      i < lineItems.length - 1 ? "border-b border-gray-100" : "",
                      hasDiscrepancy ? "bg-amber-50" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <td className="px-6 py-4 font-mono text-gray-700">{item.sku}</td>
                    <td className="px-6 py-4 text-gray-600">{item.description}</td>
                    <td className="px-6 py-4 text-right text-gray-700 tabular-nums">
                      {item.quantityOrdered}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <input
                        type="number"
                        name={`qty_${item.id}`}
                        min="0"
                        required
                        value={rawQty}
                        onChange={(e) =>
                          setQuantities((prev) => ({
                            ...prev,
                            [item.id]: e.target.value,
                          }))
                        }
                        className={[
                          "w-24 text-right border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 transition-colors",
                          hasDiscrepancy
                            ? "border-amber-400 focus:ring-amber-300 bg-white"
                            : "border-gray-300 focus:ring-blue-300",
                        ].join(" ")}
                        placeholder="0"
                      />
                    </td>
                    <td className="px-6 py-4">
                      <input
                        type="text"
                        name={`note_${item.id}`}
                        placeholder="Optional note"
                        className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300 transition-colors"
                      />
                    </td>
                    <td className="px-4 py-4">
                      {hasDiscrepancy && (
                        <span
                          title="Quantity discrepancy"
                          className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-400 text-white text-xs font-bold"
                        >
                          !
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-500">
            {!allFilled && "All quantity fields are required."}
          </p>
          <button
            type="submit"
            disabled={!allFilled || isSubmitting}
            className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg px-5 py-2.5 transition-colors"
          >
            {isSubmitting ? "Saving…" : "Complete Receiving"}
          </button>
        </div>
      </Form>
    </main>
  );
}
