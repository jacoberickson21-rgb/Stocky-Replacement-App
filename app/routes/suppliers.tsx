import { Link, useNavigate, useFetcher } from "react-router";
import { useState, useRef, useEffect } from "react";
import type { Route } from "./+types/suppliers";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";
import { importSuppliersFromCSV } from "../utils/csv-import.server";

const SUPPLIER_TEMPLATE_HREF =
  "data:text/csv;charset=utf-8,name%2Ccontact_name%2Cemail%2Cphone%0A";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const url = new URL(request.url);
  const searchParam = url.searchParams.get("search");

  const where = searchParam
    ? {
        OR: [
          { name: { contains: searchParam } },
          { contactName: { contains: searchParam } },
          { email: { contains: searchParam } },
          { phone: { contains: searchParam } },
        ],
      }
    : {};

  const suppliers = await getDb().supplier.findMany({
    where,
    orderBy: { name: "asc" },
    include: {
      vendors: {
        include: {
          invoices: true,
          credits: true,
        },
      },
    },
  });

  const suppliersData = suppliers.map((s) => {
    const totalInvoices = s.vendors.reduce(
      (sum, v) => sum + v.invoices.reduce((vs, inv) => vs + Number(inv.total), 0),
      0
    );
    const totalCredits = s.vendors.reduce(
      (sum, v) => sum + v.credits.reduce((vs, c) => vs + Math.abs(Number(c.amount)), 0),
      0
    );
    return {
      id: s.id,
      name: s.name,
      contactName: s.contactName,
      email: s.email,
      phone: s.phone,
      vendorCount: s.vendors.length,
      totalInvoices,
      totalCredits,
      netBalance: totalInvoices - totalCredits,
    };
  });

  return { suppliers: suppliersData, searchParam };
}

export async function action({ request }: Route.ActionArgs) {
  await requireUserId(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "importCSV") {
    const csvFile = form.get("csvFile");
    if (!csvFile || !(csvFile instanceof File) || csvFile.size === 0) {
      return {
        intent: "importCSV" as const,
        fileError: "Please select a CSV file.",
        result: null,
      };
    }
    const csvText = await csvFile.text();
    const result = await importSuppliersFromCSV(csvText);
    return { intent: "importCSV" as const, fileError: null, result };
  }

  if (intent === "bulkDelete") {
    const ids = form.getAll("ids").map(Number).filter((n) => n > 0);
    if (!ids.length) return { intent: "bulkDelete" as const, deleted: 0 };
    await getDb().supplier.deleteMany({ where: { id: { in: ids } } });
    return { intent: "bulkDelete" as const, deleted: ids.length };
  }

  return { intent: "none" as const };
}

function formatDollars(amount: number) {
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });
}

export default function SuppliersPage({ loaderData }: Route.ComponentProps) {
  const { suppliers, searchParam } = loaderData;
  const navigate = useNavigate();
  const [searchValue, setSearchValue] = useState(searchParam ?? "");
  const [showImportPanel, setShowImportPanel] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const csvFetcher = useFetcher<typeof action>();
  const bulkFetcher = useFetcher<typeof action>();

  const allVisibleSelected =
    suppliers.length > 0 && suppliers.every((s) => selectedIds.has(s.id));
  const someVisibleSelected = suppliers.some((s) => selectedIds.has(s.id));
  const selectedCount = selectedIds.size;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someVisibleSelected && !allVisibleSelected;
    }
  }, [someVisibleSelected, allVisibleSelected]);

  useEffect(() => {
    if (bulkFetcher.state === "submitting") {
      setBulkNotice(null);
      return;
    }
    if (bulkFetcher.state === "idle" && bulkFetcher.data) {
      const d = bulkFetcher.data;
      if (d.intent === "bulkDelete") {
        setBulkNotice(`${d.deleted} supplier${d.deleted !== 1 ? "s" : ""} deleted. Their vendors are now unassigned.`);
        setSelectedIds(new Set());
        setConfirmingDelete(false);
      }
    }
  }, [bulkFetcher.state, bulkFetcher.data]);

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
      navigate(`/suppliers?${params.toString()}`);
    }, 300);
  }

  function toggleAll() {
    if (allVisibleSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(suppliers.map((s) => s.id)));
    }
  }

  function toggleOne(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function submitBulkDelete() {
    const fd = new FormData();
    fd.append("intent", "bulkDelete");
    for (const id of selectedIds) fd.append("ids", String(id));
    bulkFetcher.submit(fd, { method: "post" });
  }

  const isImporting = csvFetcher.state !== "idle";
  const importResult =
    csvFetcher.data?.intent === "importCSV" ? csvFetcher.data.result : null;
  const fileError =
    csvFetcher.data?.intent === "importCSV" ? csvFetcher.data.fileError : null;
  const isBulkSubmitting = bulkFetcher.state !== "idle";

  return (
    <main className="p-8 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Suppliers</h2>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowImportPanel((v) => !v)}
            className="border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 text-sm font-medium rounded-lg px-4 py-2 transition-colors"
          >
            Import CSV
          </button>
          <Link
            to="/suppliers/new"
            className="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
          >
            New Supplier
          </Link>
        </div>
      </div>

      <div className="mb-6">
        <input
          type="text"
          placeholder="Search by name, contact, email, or phone..."
          value={searchValue}
          onChange={handleSearchChange}
          className="text-sm border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-80"
        />
      </div>

      {showImportPanel && (
        <div className="mb-6 bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Import Suppliers from CSV</h3>
            <button
              onClick={() => setShowImportPanel(false)}
              className="text-sm text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            >
              Close
            </button>
          </div>
          <div className="px-6 py-4">
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              Columns:{" "}
              {["name", "contact_name", "email", "phone"].map((col) => (
                <span key={col}>
                  <span className="font-mono text-xs bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded text-gray-700 dark:text-gray-300">
                    {col}
                  </span>{" "}
                </span>
              ))}
              &mdash;{" "}
              <span className="font-mono text-xs bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded text-gray-700 dark:text-gray-300">
                name
              </span>{" "}
              is required.{" "}
              <a
                href={SUPPLIER_TEMPLATE_HREF}
                download="supplier_template.csv"
                className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors"
              >
                Download template
              </a>
            </p>
            <csvFetcher.Form
              method="post"
              encType="multipart/form-data"
              className="flex items-center gap-3"
            >
              <input type="hidden" name="intent" value="importCSV" />
              <input
                type="file"
                name="csvFile"
                accept=".csv"
                className="text-sm text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 file:mr-3 file:text-sm file:font-medium file:text-indigo-600 dark:file:text-indigo-400 file:border-0 file:bg-indigo-50 dark:file:bg-indigo-950/40 file:rounded file:px-2 file:py-1 file:cursor-pointer hover:file:bg-indigo-100 dark:hover:file:bg-indigo-950/60 transition-colors"
              />
              <button
                type="submit"
                disabled={isImporting}
                className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
              >
                {isImporting ? "Importing..." : "Import"}
              </button>
            </csvFetcher.Form>

            {fileError && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{fileError}</p>}

            {importResult && (
              <div className="mt-4 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
                <div className="bg-gray-50 dark:bg-gray-800 px-4 py-3 border-b border-gray-200 dark:border-gray-700">
                  <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">Import complete</span>
                </div>
                <div className="px-4 py-3 flex gap-6">
                  <div className="text-sm">
                    <span className="font-medium text-green-600 dark:text-green-400">{importResult.created}</span>{" "}
                    <span className="text-gray-600 dark:text-gray-300">created</span>
                  </div>
                  <div className="text-sm">
                    <span className="font-medium text-gray-500 dark:text-gray-400">{importResult.skipped}</span>{" "}
                    <span className="text-gray-600 dark:text-gray-300">skipped (already exist)</span>
                  </div>
                  {importResult.errors.length > 0 && (
                    <div className="text-sm">
                      <span className="font-medium text-red-500 dark:text-red-400">{importResult.errors.length}</span>{" "}
                      <span className="text-gray-600 dark:text-gray-300">
                        error{importResult.errors.length !== 1 ? "s" : ""}
                      </span>
                    </div>
                  )}
                </div>
                {importResult.errors.length > 0 && (
                  <div className="border-t border-gray-200 dark:border-gray-700">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                          <th className="text-left px-4 py-2 font-medium text-gray-600 dark:text-gray-400 w-20">
                            Row
                          </th>
                          <th className="text-left px-4 py-2 font-medium text-gray-600 dark:text-gray-400">Error</th>
                        </tr>
                      </thead>
                      <tbody>
                        {importResult.errors.map((err, i) => (
                          <tr
                            key={i}
                            className={
                              i < importResult.errors.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : ""
                            }
                          >
                            <td className="px-4 py-2 text-gray-500 dark:text-gray-400">{err.row}</td>
                            <td className="px-4 py-2 text-red-600 dark:text-red-400">{err.message}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {bulkNotice && (
        <div className="mb-4 flex items-center justify-between bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded-xl px-4 py-3">
          <p className="text-sm text-green-800 dark:text-green-300">{bulkNotice}</p>
          <button
            onClick={() => setBulkNotice(null)}
            className="text-sm text-green-600 dark:text-green-400 hover:text-green-800 dark:hover:text-green-200 transition-colors ml-4 shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {selectedCount > 0 && (
        <div className="mb-4 bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 px-6 py-4">
          {confirmingDelete ? (
            <div className="flex items-center gap-4">
              <span className="text-sm text-gray-700 dark:text-gray-200">
                Delete {selectedCount} supplier{selectedCount !== 1 ? "s" : ""}? Their vendors will
                become unassigned.
              </span>
              <button
                onClick={submitBulkDelete}
                disabled={isBulkSubmitting}
                className="bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg px-3 py-1.5 transition-colors"
              >
                {isBulkSubmitting ? "Deleting..." : "Confirm Delete"}
              </button>
              <button
                onClick={() => setConfirmingDelete(false)}
                className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
                {selectedCount} supplier{selectedCount !== 1 ? "s" : ""} selected
              </span>
              <div className="h-4 w-px bg-gray-200 dark:bg-gray-600 shrink-0" />
              <button
                onClick={() => setConfirmingDelete(true)}
                disabled={isBulkSubmitting}
                className="text-sm text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 border border-red-200 dark:border-red-800 rounded-lg px-3 py-1.5 bg-white dark:bg-transparent hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50 transition-colors"
              >
                Delete
              </button>
            </div>
          )}
        </div>
      )}

      {suppliers.length === 0 ? (
        <p className="text-sm text-gray-400 dark:text-gray-500">
          {searchParam
            ? "No suppliers match your search."
            : "No suppliers yet. Add one to get started."}
        </p>
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                <th className="px-4 py-3 w-10">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAll}
                    className="rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                  />
                </th>
                <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Name</th>
                <th className="text-left px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Contact</th>
                <th className="text-right px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Vendors</th>
                <th className="text-right px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Total Invoices</th>
                <th className="text-right px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Total Credits</th>
                <th className="text-right px-6 py-3 font-medium text-gray-600 dark:text-gray-400">Net Balance</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {suppliers.map((s, i) => (
                <tr
                  key={s.id}
                  className={i < suppliers.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : ""}
                >
                  <td className="px-4 py-4">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(s.id)}
                      onChange={() => toggleOne(s.id)}
                      className="rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                    />
                  </td>
                  <td className="px-6 py-4 font-medium text-gray-800 dark:text-gray-100">{s.name}</td>
                  <td className="px-6 py-4 text-gray-600 dark:text-gray-300">{s.contactName ?? "—"}</td>
                  <td className="px-6 py-4 text-right text-gray-600 dark:text-gray-300">{s.vendorCount}</td>
                  <td className="px-6 py-4 text-right text-gray-800 dark:text-gray-100">
                    {formatDollars(s.totalInvoices)}
                  </td>
                  <td className="px-6 py-4 text-right text-green-600 dark:text-green-400">
                    {formatDollars(s.totalCredits)}
                  </td>
                  <td className="px-6 py-4 text-right font-medium text-gray-900 dark:text-gray-100">
                    {formatDollars(s.netBalance)}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <Link
                      to={`/suppliers/${s.id}`}
                      className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors"
                    >
                      View
                    </Link>
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
