import { Link, useNavigate } from "react-router";
import { useState, useRef } from "react";
import type { Route } from "./+types/credits";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const url = new URL(request.url);
  const vendorParam = url.searchParams.get("vendor");
  const searchParam = url.searchParams.get("search");

  const where: Record<string, unknown> = {};
  if (vendorParam) where.vendorId = Number(vendorParam);
  if (searchParam) {
    where.OR = [
      { invoiceNumber: { contains: searchParam } },
      { notes: { contains: searchParam } },
      { vendor: { name: { contains: searchParam } } },
    ];
  }

  const credits = await getDb().credit.findMany({
    where,
    include: { vendor: true },
    orderBy: { date: "desc" },
  });

  const vendors = await getDb().vendor.findMany({ orderBy: { name: "asc" } });
  const total = credits.reduce((sum, c) => sum + Number(c.amount), 0);

  return {
    credits: credits.map((c) => ({ ...c, amount: Number(c.amount) })),
    vendors,
    vendorParam,
    searchParam,
    total,
  };
}

export default function CreditsPage({ loaderData }: Route.ComponentProps) {
  const { credits, vendors, vendorParam, searchParam, total } = loaderData;
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
    navigate(`/credits?${params.toString()}`);
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
      navigate(`/credits?${params.toString()}`);
    }, 300);
  }

  const hasFilters = vendorParam || searchParam;

  return (
    <main className="p-8 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-gray-800">Credits</h2>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 mb-6">
        <p className="text-sm text-gray-500 mb-1">Total Credits</p>
        <p className="text-2xl font-semibold text-green-600">
          {total.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 })}
        </p>
        {hasFilters && (
          <p className="text-xs text-gray-400 mt-1">Filtered results</p>
        )}
      </div>

      <div className="flex items-center gap-3 mb-6">
        <select
          value={vendorParam ?? ""}
          onChange={handleVendorChange}
          className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All Vendors</option>
          {vendors.map((v) => (
            <option key={v.id} value={String(v.id)}>
              {v.name}
            </option>
          ))}
        </select>

        <input
          type="text"
          placeholder="Search invoice # or notes..."
          value={searchValue}
          onChange={handleSearchChange}
          className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 w-64"
        />

        {hasFilters && (
          <Link
            to="/credits"
            onClick={() => setSearchValue("")}
            className="text-sm text-gray-500 hover:text-gray-800 transition-colors"
          >
            Clear
          </Link>
        )}
      </div>

      {credits.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <p className="text-sm text-gray-400">No credits recorded.</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-6 py-3 font-medium text-gray-600">Date</th>
                <th className="text-left px-6 py-3 font-medium text-gray-600">Vendor</th>
                <th className="text-left px-6 py-3 font-medium text-gray-600">Invoice #</th>
                <th className="text-left px-6 py-3 font-medium text-gray-600">Notes</th>
                <th className="text-right px-6 py-3 font-medium text-gray-600">Amount</th>
              </tr>
            </thead>
            <tbody>
              {credits.map((credit, i) => (
                <tr
                  key={credit.id}
                  className={i < credits.length - 1 ? "border-b border-gray-100" : ""}
                >
                  <td className="px-6 py-4 text-gray-600">
                    {new Date(credit.date).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </td>
                  <td className="px-6 py-4 text-gray-800">
                    <Link
                      to={`/vendors/${credit.vendorId}`}
                      className="text-blue-600 hover:text-blue-800 transition-colors"
                    >
                      {credit.vendor.name}
                    </Link>
                  </td>
                  <td className="px-6 py-4 text-gray-600">
                    {credit.invoiceNumber ?? "—"}
                  </td>
                  <td className="px-6 py-4 text-gray-600">
                    {credit.notes ?? "—"}
                  </td>
                  <td className="px-6 py-4 text-right font-medium text-green-600">
                    {credit.amount.toLocaleString("en-US", {
                      style: "currency",
                      currency: "USD",
                      minimumFractionDigits: 2,
                    })}
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
