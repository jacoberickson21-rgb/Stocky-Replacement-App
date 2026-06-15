import { Link, Form, redirect } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/credits.$id";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";

function fmtCurrency(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
  const id = Number(params.id);
  if (!id) throw new Response("Not Found", { status: 404 });

  const credit = await getDb().credit.findUnique({
    where: { id },
    include: { vendor: true, supplier: true, lineItems: true },
  });
  if (!credit) throw new Response("Not Found", { status: 404 });

  return {
    credit: {
      id: credit.id,
      vendorId: credit.vendorId,
      vendorName: credit.vendor.name,
      supplierName: credit.supplier?.name ?? null,
      amount: Number(credit.amount),
      sku: credit.sku,
      description: credit.description,
      quantity: credit.quantity,
      invoiceNumber: credit.invoiceNumber,
      notes: credit.notes,
      date: credit.date.toISOString(),
      lineItems: credit.lineItems.map((item) => ({
        id: item.id,
        sku: item.sku,
        description: item.description,
        quantity: item.quantity,
        unitCost: Number(item.unitCost),
        lineTotal: Number(item.lineTotal),
        shopifyVariantId: item.shopifyVariantId,
        shopifyInventoryItemId: item.shopifyInventoryItemId,
        shopifyProductTitle: item.shopifyProductTitle,
        barcode: item.barcode,
        inventorySynced: item.inventorySynced,
      })),
    },
  };
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request, params }: Route.ActionArgs) {
  const userId = await requireUserId(request);
  const id = Number(params.id);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "deleteCredit") {
    const db = getDb();
    const credit = await db.credit.findUnique({
      where: { id },
      select: { id: true, vendorId: true, invoiceNumber: true },
    });
    if (!credit) throw new Response("Not Found", { status: 404 });
    await db.$transaction([
      db.credit.delete({ where: { id } }),
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

  throw new Response("Unknown intent", { status: 400 });
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function CreditDetailPage({ loaderData }: Route.ComponentProps) {
  const { credit } = loaderData;
  const [confirming, setConfirming] = useState(false);

  const hasLineItems = credit.lineItems.length > 0;
  const metaLabel = "text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1";
  const metaValue = "text-sm font-medium text-gray-800 dark:text-gray-100";

  return (
    <main className="p-8 max-w-5xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-3 mb-6">
        <Link
          to="/credits"
          className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100 transition-colors"
        >
          ← Credits
        </Link>
        <span className="text-gray-300 dark:text-gray-600">/</span>
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">
          Credit #{credit.id}
          {credit.invoiceNumber && (
            <span className="text-base font-normal text-gray-500 dark:text-gray-400 ml-2">
              ({credit.invoiceNumber})
            </span>
          )}
        </h2>
      </div>

      {/* Header card */}
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-6 mb-6">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-6">
          <div>
            <p className={metaLabel}>Vendor</p>
            <Link
              to={`/vendors/${credit.vendorId}`}
              className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors"
            >
              {credit.vendorName}
            </Link>
          </div>
          {credit.supplierName && (
            <div>
              <p className={metaLabel}>Supplier</p>
              <p className={metaValue}>{credit.supplierName}</p>
            </div>
          )}
          <div>
            <p className={metaLabel}>Date</p>
            <p className={metaValue}>
              {new Date(credit.date).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </p>
          </div>
          {credit.invoiceNumber && (
            <div>
              <p className={metaLabel}>Reference #</p>
              <p className={metaValue}>{credit.invoiceNumber}</p>
            </div>
          )}
          {credit.notes && (
            <div className="col-span-2 sm:col-span-1">
              <p className={metaLabel}>Notes</p>
              <p className={metaValue}>{credit.notes}</p>
            </div>
          )}
          <div>
            <p className={metaLabel}>Total Credit</p>
            <p className="text-sm font-semibold text-green-600 dark:text-green-400">
              {fmtCurrency(credit.amount)}
            </p>
          </div>
        </div>
      </div>

      {/* Delete action */}
      <div className="flex items-center gap-3 mb-6">
        {confirming ? (
          <>
            <span className="text-sm text-gray-600 dark:text-gray-300">
              Delete this credit permanently?
            </span>
            <Form method="post">
              <input type="hidden" name="intent" value="deleteCredit" />
              <button
                type="submit"
                className="text-sm bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg font-medium transition-colors"
              >
                Yes, delete
              </button>
            </Form>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100 px-4 py-2 transition-colors"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="text-sm border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 px-4 py-2 rounded-lg transition-colors font-medium"
          >
            Delete Credit
          </button>
        )}
      </div>

      {/* Line items or simple credit detail */}
      {hasLineItems ? (
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Line Items</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                  <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">
                    Product / SKU
                  </th>
                  <th className="text-right px-6 py-3 font-medium text-gray-600 dark:text-gray-400 w-24">
                    Qty
                  </th>
                  <th className="text-right px-6 py-3 font-medium text-gray-600 dark:text-gray-400 w-32">
                    Unit Cost
                  </th>
                  <th className="text-right px-6 py-3 font-medium text-gray-600 dark:text-gray-400 w-32">
                    Line Total
                  </th>
                  <th className="text-center px-6 py-3 font-medium text-gray-600 dark:text-gray-400 w-24">
                    Synced
                  </th>
                </tr>
              </thead>
              <tbody>
                {credit.lineItems.map((item, idx) => (
                  <tr
                    key={item.id}
                    className={
                      idx < credit.lineItems.length - 1
                        ? "border-b border-gray-100 dark:border-gray-700"
                        : ""
                    }
                  >
                    <td className="px-6 py-3">
                      <div className="font-medium text-gray-800 dark:text-gray-100">
                        {item.description}
                      </div>
                      {item.sku && (
                        <div className="font-mono text-xs text-gray-400 dark:text-gray-500">
                          {item.sku}
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-3 text-right text-gray-700 dark:text-gray-300 tabular-nums">
                      {item.quantity}
                    </td>
                    <td className="px-6 py-3 text-right text-gray-700 dark:text-gray-300 tabular-nums">
                      {fmtCurrency(item.unitCost)}
                    </td>
                    <td className="px-6 py-3 text-right font-medium text-red-600 dark:text-red-400 tabular-nums">
                      {fmtCurrency(item.lineTotal)}
                    </td>
                    <td className="px-6 py-3 text-center">
                      {item.inventorySynced ? (
                        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                          Synced
                        </span>
                      ) : item.shopifyInventoryItemId ? (
                        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400">
                          Pending
                        </span>
                      ) : (
                        <span className="text-gray-400 dark:text-gray-500">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
                  <td
                    colSpan={3}
                    className="px-6 py-3 text-right text-sm text-gray-500 dark:text-gray-400 font-medium"
                  >
                    Total Credit
                  </td>
                  <td className="px-6 py-3 text-right font-semibold text-red-600 dark:text-red-400 tabular-nums">
                    {fmtCurrency(credit.amount)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-4">
            Credit Details
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-6">
            {credit.sku && (
              <div>
                <p className={metaLabel}>SKU</p>
                <p className="text-sm font-mono text-gray-800 dark:text-gray-100">{credit.sku}</p>
              </div>
            )}
            {credit.description && (
              <div>
                <p className={metaLabel}>Description</p>
                <p className={metaValue}>{credit.description}</p>
              </div>
            )}
            {credit.quantity !== null && (
              <div>
                <p className={metaLabel}>Quantity</p>
                <p className={metaValue}>{credit.quantity}</p>
              </div>
            )}
            <div>
              <p className={metaLabel}>Amount</p>
              <p className="text-sm font-semibold text-green-600 dark:text-green-400">
                {fmtCurrency(credit.amount)}
              </p>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
