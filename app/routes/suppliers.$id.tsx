import { redirect, data } from "react-router";
import { Link, useActionData, Form } from "react-router";
import { useState, useEffect } from "react";
import type { Route } from "./+types/suppliers.$id";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
  const id = Number(params.id);

  const [supplier, unassignedVendors] = await Promise.all([
    getDb().supplier.findUniqueOrThrow({
      where: { id },
      include: {
        vendors: {
          orderBy: { name: "asc" },
          include: {
            invoices: { orderBy: { createdAt: "desc" } },
            credits: { orderBy: { date: "desc" } },
          },
        },
      },
    }),
    getDb().vendor.findMany({
      where: { supplierId: null },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  const vendors = supplier.vendors.map((v) => {
    const totalInvoices = v.invoices.reduce((sum, inv) => sum + Number(inv.total), 0);
    const totalCredits = v.credits.reduce((sum, c) => sum + Math.abs(Number(c.amount)), 0);
    return {
      id: v.id,
      name: v.name,
      contactName: v.contactName,
      email: v.email,
      phone: v.phone,
      totalInvoices,
      totalCredits,
      netBalance: totalInvoices - totalCredits,
      invoices: v.invoices.map((inv) => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        status: inv.status,
        total: Number(inv.total),
        createdAt: inv.createdAt.toISOString(),
      })),
      credits: v.credits.map((c) => ({
        id: c.id,
        amount: Math.abs(Number(c.amount)),
        invoiceNumber: c.invoiceNumber,
        notes: c.notes,
        date: c.date.toISOString(),
      })),
    };
  });

  const totalInvoices = vendors.reduce((sum, v) => sum + v.totalInvoices, 0);
  const totalCredits = vendors.reduce((sum, v) => sum + v.totalCredits, 0);

  return {
    supplier: {
      id: supplier.id,
      name: supplier.name,
      contactName: supplier.contactName,
      email: supplier.email,
      phone: supplier.phone,
    },
    vendors,
    totalInvoices,
    totalCredits,
    netBalance: totalInvoices - totalCredits,
    unassignedVendors,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  await requireUserId(request);
  const supplierId = Number(params.id);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "addVendor") {
    const vendorId = Number(formData.get("vendorId"));
    if (!vendorId) {
      return data({ error: "Please select a vendor." }, { status: 400 });
    }
    await getDb().vendor.update({
      where: { id: vendorId },
      data: { supplierId },
    });
    return { success: "vendor_added" };
  }

  if (intent === "createVendor") {
    const name = String(formData.get("name") ?? "").trim();
    const contactName = String(formData.get("contactName") ?? "").trim() || null;
    const email = String(formData.get("email") ?? "").trim() || null;
    const phone = String(formData.get("phone") ?? "").trim() || null;

    if (!name) {
      return data({ error: "Vendor name is required." }, { status: 400 });
    }

    await getDb().vendor.create({ data: { name, contactName, email, phone, supplierId } });
    return { success: "vendor_created" };
  }

  if (intent === "deleteSupplier") {
    await getDb().supplier.delete({ where: { id: supplierId } });
    return redirect("/suppliers");
  }

  if (intent === "editSupplier") {
    const name = String(formData.get("name") ?? "").trim();
    const contactName = String(formData.get("contactName") ?? "").trim() || null;
    const email = String(formData.get("email") ?? "").trim() || null;
    const phone = String(formData.get("phone") ?? "").trim() || null;
    if (!name) return { error: "Supplier name is required." };
    await getDb().supplier.update({
      where: { id: supplierId },
      data: { name, contactName, email, phone },
    });
    return { success: "editSupplier" };
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

export default function SupplierDetailPage({ loaderData }: Route.ComponentProps) {
  const { supplier, vendors, totalInvoices, totalCredits, netBalance, unassignedVendors } =
    loaderData;
  const actionData = useActionData() as { error?: string; success?: string } | undefined;
  const [showAddVendor, setShowAddVendor] = useState(false);
  const [showCreateVendor, setShowCreateVendor] = useState(false);
  const [showEditSupplier, setShowEditSupplier] = useState(false);

  useEffect(() => {
    if (actionData?.success === "vendor_created") setShowCreateVendor(false);
    if (actionData?.success === "editSupplier") setShowEditSupplier(false);
  }, [actionData]);

  return (
    <main className="p-8 max-w-5xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link to="/suppliers" className="text-sm text-gray-500 hover:text-gray-800 transition-colors">
            ← Suppliers
          </Link>
          <span className="text-gray-300">/</span>
          <h2 className="text-xl font-semibold text-gray-800">{supplier.name}</h2>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowEditSupplier(!showEditSupplier)}
            className="text-sm font-medium text-gray-600 hover:text-gray-800 rounded-lg px-4 py-2 border border-gray-300 hover:bg-gray-50 transition-colors"
          >
            {showEditSupplier ? "Cancel Edit" : "Edit Supplier"}
          </button>
          <Form
            method="post"
            onSubmit={(e) => {
              if (!confirm(`Delete ${supplier.name}? All vendors will become standalone.`)) {
                e.preventDefault();
              }
            }}
          >
            <input type="hidden" name="intent" value="deleteSupplier" />
            <button
              type="submit"
              className="text-sm text-red-500 hover:text-red-700 transition-colors"
            >
              Delete Supplier
            </button>
          </Form>
        </div>
      </div>

      {showEditSupplier && (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 mb-6">
          <p className="text-sm font-semibold text-gray-700 mb-4">Edit Supplier</p>
          <Form method="post" className="space-y-4">
            <input type="hidden" name="intent" value="editSupplier" />
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Supplier Name <span className="text-red-500">*</span>
                </label>
                <input
                  name="name"
                  type="text"
                  required
                  defaultValue={supplier.name}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Contact Name
                </label>
                <input
                  name="contactName"
                  type="text"
                  defaultValue={supplier.contactName ?? ""}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Email</label>
                <input
                  name="email"
                  type="email"
                  defaultValue={supplier.email ?? ""}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Phone</label>
                <input
                  name="phone"
                  type="tel"
                  defaultValue={supplier.phone ?? ""}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            {actionData?.error && (
              <p className="text-sm text-red-600">{actionData.error}</p>
            )}
            <div className="flex gap-3 pt-1">
              <button
                type="submit"
                className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg px-5 py-2 transition-colors"
              >
                Save Changes
              </button>
              <button
                type="button"
                onClick={() => setShowEditSupplier(false)}
                className="text-sm font-medium text-gray-600 hover:text-gray-800 rounded-lg px-4 py-2 border border-gray-300 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          </Form>
        </div>
      )}

      {/* Contact info */}
      {(supplier.contactName || supplier.email || supplier.phone) && (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 mb-6">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Contact</h3>
          <div className="flex gap-8 text-sm text-gray-600">
            {supplier.contactName && <span>{supplier.contactName}</span>}
            {supplier.email && (
              <a
                href={`mailto:${supplier.email}`}
                className="text-blue-600 hover:text-blue-800 transition-colors"
              >
                {supplier.email}
              </a>
            )}
            {supplier.phone && <span>{supplier.phone}</span>}
          </div>
        </div>
      )}

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-4 mb-8">
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

      {/* Vendor breakdown */}
      <div className="mb-8">
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-4">
          Vendors ({vendors.length})
        </h3>

        {vendors.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 px-6 py-8 text-center text-sm text-gray-400">
            No vendors assigned to this supplier yet.
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {vendors.map((vendor) => (
              <div
                key={vendor.id}
                className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden"
              >
                {/* Vendor header */}
                <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-gray-50">
                  <Link
                    to={`/vendors/${vendor.id}`}
                    className="text-base font-semibold text-blue-600 hover:text-blue-800 transition-colors"
                  >
                    {vendor.name}
                  </Link>
                  {(vendor.contactName || vendor.email || vendor.phone) && (
                    <span className="text-sm text-gray-500">
                      {[vendor.contactName, vendor.email, vendor.phone]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  )}
                </div>

                {/* Vendor stats */}
                <div className="grid grid-cols-3 divide-x divide-gray-100 border-b border-gray-100">
                  <div className="px-6 py-4">
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                      Invoices
                    </p>
                    <p className="text-lg font-bold text-gray-900">
                      {formatDollars(vendor.totalInvoices)}
                    </p>
                  </div>
                  <div className="px-6 py-4">
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                      Credits
                    </p>
                    <p className="text-lg font-bold text-green-600">
                      {formatDollars(vendor.totalCredits)}
                    </p>
                  </div>
                  <div className="px-6 py-4">
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                      Net Balance
                    </p>
                    <p className="text-lg font-bold text-gray-900">
                      {formatDollars(vendor.netBalance)}
                    </p>
                  </div>
                </div>

                {/* Vendor invoices */}
                <div className="border-b border-gray-100">
                  <p className="px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide bg-gray-50 border-b border-gray-100">
                    Purchase Orders
                  </p>
                  {vendor.invoices.length === 0 ? (
                    <p className="px-6 py-4 text-sm text-gray-400">No purchase orders.</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-100">
                          <th className="text-left px-6 py-3 font-medium text-gray-600">Invoice #</th>
                          <th className="text-left px-6 py-3 font-medium text-gray-600">Status</th>
                          <th className="text-left px-6 py-3 font-medium text-gray-600">Date</th>
                          <th className="text-right px-6 py-3 font-medium text-gray-600">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {vendor.invoices.map((inv, i) => (
                          <tr
                            key={inv.id}
                            className={i < vendor.invoices.length - 1 ? "border-b border-gray-100" : ""}
                          >
                            <td className="px-6 py-3">
                              <Link
                                to={`/invoices/${inv.id}`}
                                className="text-blue-600 hover:text-blue-800 font-medium transition-colors"
                              >
                                {inv.invoiceNumber}
                              </Link>
                            </td>
                            <td className="px-6 py-3">
                              <span
                                className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${statusStyles[inv.status]}`}
                              >
                                {statusLabels[inv.status]}
                              </span>
                            </td>
                            <td className="px-6 py-3 text-gray-600">
                              {new Date(inv.createdAt).toLocaleDateString("en-US", {
                                month: "short",
                                day: "numeric",
                                year: "numeric",
                              })}
                            </td>
                            <td className="px-6 py-3 text-right font-medium text-gray-800">
                              {formatDollars(inv.total)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* Vendor credits */}
                <div>
                  <p className="px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide bg-gray-50 border-b border-gray-100">
                    Credits
                  </p>
                  {vendor.credits.length === 0 ? (
                    <p className="px-6 py-4 text-sm text-gray-400">No credits recorded.</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-100">
                          <th className="text-left px-6 py-3 font-medium text-gray-600">Date</th>
                          <th className="text-right px-6 py-3 font-medium text-gray-600">Amount</th>
                          <th className="text-left px-6 py-3 font-medium text-gray-600">Invoice #</th>
                          <th className="text-left px-6 py-3 font-medium text-gray-600">Notes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {vendor.credits.map((credit, i) => (
                          <tr
                            key={credit.id}
                            className={i < vendor.credits.length - 1 ? "border-b border-gray-100" : ""}
                          >
                            <td className="px-6 py-3 text-gray-600">
                              {new Date(credit.date).toLocaleDateString("en-US", {
                                month: "short",
                                day: "numeric",
                                year: "numeric",
                              })}
                            </td>
                            <td className="px-6 py-3 text-right font-medium text-green-600">
                              {formatDollars(credit.amount)}
                            </td>
                            <td className="px-6 py-3 font-mono text-gray-700">
                              {credit.invoiceNumber ?? "—"}
                            </td>
                            <td className="px-6 py-3 text-gray-500">{credit.notes ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add vendor to supplier */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
            Add Vendor to This Supplier
          </h3>
          {!showAddVendor && !showCreateVendor && (
            <div className="flex gap-2">
              {unassignedVendors.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowAddVendor(true)}
                  className="text-sm font-medium text-gray-600 hover:text-gray-800 rounded-lg px-4 py-2 border border-gray-300 hover:bg-gray-50 transition-colors"
                >
                  Add Existing Vendor
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowCreateVendor(true)}
                className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
              >
                Create New Vendor
              </button>
            </div>
          )}
        </div>

        {showAddVendor && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 mb-4">
            <Form method="post">
              <input type="hidden" name="intent" value="addVendor" />
              <div className="flex items-end gap-4">
                <div className="flex-1">
                  <label
                    htmlFor="vendorId"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Select Existing Vendor
                  </label>
                  <select
                    id="vendorId"
                    name="vendorId"
                    required
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                  >
                    <option value="">— Choose a vendor —</option>
                    {unassignedVendors.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="submit"
                  className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg px-5 py-2 transition-colors"
                >
                  Add
                </button>
                <button
                  type="button"
                  onClick={() => setShowAddVendor(false)}
                  className="text-sm font-medium text-gray-600 hover:text-gray-800 rounded-lg px-4 py-2 border border-gray-300 hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
              </div>
              {actionData?.error && (
                <p className="mt-3 text-sm text-red-600">{actionData.error}</p>
              )}
            </Form>
          </div>
        )}

        {showCreateVendor && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
            <p className="text-sm font-medium text-gray-700 mb-4">New Vendor</p>
            <Form method="post" className="space-y-4">
              <input type="hidden" name="intent" value="createVendor" />
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="newName" className="block text-xs font-medium text-gray-600 mb-1">
                    Vendor Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="newName"
                    name="name"
                    type="text"
                    required
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label htmlFor="newContactName" className="block text-xs font-medium text-gray-600 mb-1">
                    Contact Name
                  </label>
                  <input
                    id="newContactName"
                    name="contactName"
                    type="text"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label htmlFor="newEmail" className="block text-xs font-medium text-gray-600 mb-1">
                    Email
                  </label>
                  <input
                    id="newEmail"
                    name="email"
                    type="email"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label htmlFor="newPhone" className="block text-xs font-medium text-gray-600 mb-1">
                    Phone
                  </label>
                  <input
                    id="newPhone"
                    name="phone"
                    type="tel"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              {actionData?.error && (
                <p className="text-sm text-red-600">{actionData.error}</p>
              )}
              <div className="flex gap-3 pt-1">
                <button
                  type="submit"
                  className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg px-5 py-2 transition-colors"
                >
                  Create & Add
                </button>
                <button
                  type="button"
                  onClick={() => setShowCreateVendor(false)}
                  className="text-sm font-medium text-gray-600 hover:text-gray-800 rounded-lg px-4 py-2 border border-gray-300 hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </Form>
          </div>
        )}
      </section>
    </main>
  );
}
