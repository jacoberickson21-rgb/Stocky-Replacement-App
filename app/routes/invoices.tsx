import { Link, useNavigate, Form } from "react-router";
import { useState, useRef } from "react";
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

const PAGE_SIZE = 50;

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const url = new URL(request.url);
  const vendorParam = url.searchParams.get("vendor");
  const supplierParam = url.searchParams.get("supplier");
  const statusParam = url.searchParams.get("status") as InvoiceStatus | null;
  const searchParam = url.searchParams.get("search");
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1"));

  const where: Record<string, unknown> = {};
  if (vendorParam) where.vendorId = Number(vendorParam);
  if (supplierParam) where.supplierId = Number(supplierParam);
  if (statusParam && ["ORDERED", "RECEIVED", "PAID"].includes(statusParam)) {
    where.status = statusParam;
  }
  if (searchParam) {
    where.OR = [
      { invoiceNumber: { contains: searchParam } },
      { vendor: { name: { contains: searchParam } } },
    ];
  }

  const db = getDb();
  const [totalCount, invoices, vendors, suppliers] = await Promise.all([
    db.invoice.count({ where }),
    db.invoice.findMany({
      where,
      include: { vendor: true, supplier: true },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    db.vendor.findMany({ orderBy: { name: "asc" } }),
    db.supplier.findMany({ orderBy: { name: "asc" } }),
  ]);

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return {
    invoices: invoices.map((inv) => ({ ...inv, total: Number(inv.total) })),
    vendors,
    suppliers,
    vendorParam,
    supplierParam,
    statusParam,
    searchParam,
    pagination: { page, totalPages, totalCount },
  };
}

const STATUS_LABELS: Record<InvoiceStatus, string> = {
  ORDERED: "Ordered",
  RECEIVED: "Received",
  PAID: "Paid",
};

const STATUS_BADGE: Record<InvoiceStatus, string> = {
  ORDERED: "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300",
  RECEIVED: "bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300",
  PAID: "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300",
};

function buildInvoicePageUrl(
  page: number,
  vendorParam: string | null,
  supplierParam: string | null,
  statusParam: string | null,
  searchParam: string | null
) {
  const params = new URLSearchParams();
  if (vendorParam) params.set("vendor", vendorParam);
  if (supplierParam) params.set("supplier", supplierParam);
  if (statusParam) params.set("status", statusParam);
  if (searchParam) params.set("search", searchParam);
  params.set("page", String(page));
  return `/invoices?${params.toString()}`;
}

export default function InvoicesPage({ loaderData }: Route.ComponentProps) {
  const { invoices, vendors, suppliers, vendorParam, supplierParam, statusParam, searchParam, pagination } = loaderData;
  const navigate = useNavigate();
  const [searchValue, setSearchValue] = useState(searchParam ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleVendorChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const params = new URLSearchParams(window.location.search);
    if (e.target.value) {
      params.set("vendor", e.target.value);
    } else {
      params.delete("vendor");
    }
    navigate(`/invoices?${params.toString()}`);
  }

  function handleSupplierChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const params = new URLSearchParams(window.location.search);
    if (e.target.value) {
      params.set("supplier", e.target.value);
    } else {
      params.delete("supplier");
    }
    navigate(`/invoices?${params.toString()}`);
  }

  function handleStatusChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const params = new URLSearchParams(window.location.search);
    if (e.target.value) {
      params.set("status", e.target.value);
    } else {
      params.delete("status");
    }
    navigate(`/invoices?${params.toString()}`);
  }

  function handleSearchChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    setSearchValue(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      if (value) {
        params.set("search", value);
      } else {
        params.delete("search");
      }
      navigate(`/invoices?${params.toString()}`);
    }, 300);
  }

  const hasFilters = vendorParam || supplierParam || statusParam || searchParam;
  const hasAnySupplier = invoices.some((inv) => (inv as typeof inv & { supplier: { name: string } | null }).supplier);

  return (
    <main className="p-8 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Purchase Orders</h2>
        <button
          type="button"
          onClick={() => navigate("/invoices/upload")}
          className="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
        >
          Upload Invoice
        </button>
      </div>

      <div className="flex items-center gap-3 mb-6 flex-wrap">
        {suppliers.length > 0 && (
          <select
            value={supplierParam ?? ""}
            onChange={handleSupplierChange}
            className="text-sm border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="">All Suppliers</option>
            {suppliers.map((s) => (
              <option key={s.id} value={String(s.id)}>
                {s.name}
              </option>
            ))}
          </select>
        )}

        <select
          value={vendorParam ?? ""}
          onChange={handleVendorChange}
          className="text-sm border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="">All Vendors</option>
          {vendors.map((v) => (
            <option key={v.id} value={String(v.id)}>
              {v.name}
            </option>
          ))}
        </select>

        <select
          value={statusParam ?? ""}
          onChange={handleStatusChange}
          className="text-sm border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="">All Statuses</option>
          <option value="ORDERED">Ordered</option>
          <option value="RECEIVED">Received</option>
          <option value="PAID">Paid</option>
        </select>

        <input
          type="text"
          placeholder="Search invoice # or vendor..."
          value={searchValue}
          onChange={handleSearchChange}
          className="text-sm border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-64"
        />

        {hasFilters && (
          <Link
            to="/invoices"
            onClick={() => setSearchValue("")}
            className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-100 transition-colors"
          >
            Clear
          </Link>
        )}
      </div>

      {invoices.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <p className="text-sm text-gray-400 dark:text-gray-500">No invoices match your filters.</p>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Invoice #</th>
                <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Vendor</th>
                {hasAnySupplier && <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Supplier</th>}
                <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Status</th>
                <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Due Date</th>
                <th className="text-right px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Total</th>
                <th className="text-center px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Paid?</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice, i) => (
                <tr
                  key={invoice.id}
                  className={i < invoices.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : ""}
                >
                  <td className="px-6 py-4 font-medium text-gray-800 dark:text-gray-100">
                    <Link
                      to={`/invoices/${invoice.id}`}
                      className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors"
                    >
                      {invoice.invoiceNumber}
                    </Link>
                  </td>
                  <td className="px-6 py-4 text-gray-600 dark:text-gray-300">{invoice.vendor.name}</td>
                  {hasAnySupplier && (
                    <td className="px-6 py-4 text-gray-500 dark:text-gray-400">
                      {(invoice as typeof invoice & { supplier: { name: string } | null }).supplier?.name ?? "—"}
                    </td>
                  )}
                  <td className="px-6 py-4">
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_BADGE[invoice.status]}`}
                    >
                      {STATUS_LABELS[invoice.status]}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-gray-600 dark:text-gray-300">
                    {invoice.dueDate
                      ? new Date(invoice.dueDate).toLocaleDateString()
                      : "—"}
                  </td>
                  <td className="px-6 py-4 text-right text-gray-800 dark:text-gray-100 font-medium">
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

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <div>
            {pagination.page > 1 && (
              <Link
                to={buildInvoicePageUrl(pagination.page - 1, vendorParam, supplierParam, statusParam, searchParam)}
                className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
              >
                ← Previous
              </Link>
            )}
          </div>
          <span className="text-sm text-gray-500 dark:text-gray-400">
            Page {pagination.page} of {pagination.totalPages} · {pagination.totalCount} invoices
          </span>
          <div>
            {pagination.page < pagination.totalPages && (
              <Link
                to={buildInvoicePageUrl(pagination.page + 1, vendorParam, supplierParam, statusParam, searchParam)}
                className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
              >
                Next →
              </Link>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
