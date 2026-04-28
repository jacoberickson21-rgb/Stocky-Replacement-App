import { Link, useNavigate } from "react-router";
import { useState, useRef } from "react";
import type { Route } from "./+types/suppliers";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";

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
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  return (
    <main className="p-8 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-gray-800">Suppliers</h2>
        <Link
          to="/suppliers/new"
          className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
        >
          New Supplier
        </Link>
      </div>

      <div className="mb-6">
        <input
          type="text"
          placeholder="Search by name, contact, email, or phone..."
          value={searchValue}
          onChange={handleSearchChange}
          className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 w-80"
        />
      </div>

      {suppliers.length === 0 ? (
        <p className="text-sm text-gray-400">
          {searchParam
            ? "No suppliers match your search."
            : "No suppliers yet. Add one to get started."}
        </p>
      ) : (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-6 py-3 font-medium text-gray-600">Name</th>
                <th className="text-left px-6 py-3 font-medium text-gray-600">Contact</th>
                <th className="text-right px-6 py-3 font-medium text-gray-600">Vendors</th>
                <th className="text-right px-6 py-3 font-medium text-gray-600">Total Invoices</th>
                <th className="text-right px-6 py-3 font-medium text-gray-600">Total Credits</th>
                <th className="text-right px-6 py-3 font-medium text-gray-600">Net Balance</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody>
              {suppliers.map((s, i) => (
                <tr
                  key={s.id}
                  className={i < suppliers.length - 1 ? "border-b border-gray-100" : ""}
                >
                  <td className="px-6 py-4 font-medium text-gray-800">{s.name}</td>
                  <td className="px-6 py-4 text-gray-600">{s.contactName ?? "—"}</td>
                  <td className="px-6 py-4 text-right text-gray-600">{s.vendorCount}</td>
                  <td className="px-6 py-4 text-right text-gray-800">
                    {formatDollars(s.totalInvoices)}
                  </td>
                  <td className="px-6 py-4 text-right text-green-600">
                    {formatDollars(s.totalCredits)}
                  </td>
                  <td className="px-6 py-4 text-right font-medium text-gray-900">
                    {formatDollars(s.netBalance)}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <Link
                      to={`/suppliers/${s.id}`}
                      className="text-blue-600 hover:text-blue-800 transition-colors"
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
