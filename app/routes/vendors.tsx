import { Link, useNavigate } from "react-router";
import { useState, useRef } from "react";
import type { Route } from "./+types/vendors";
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

  const vendors = await getDb().vendor.findMany({ where, orderBy: { name: "asc" } });
  return { vendors, searchParam };
}

export default function VendorsPage({ loaderData }: Route.ComponentProps) {
  const { vendors, searchParam } = loaderData;
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
      navigate(`/vendors?${params.toString()}`);
    }, 300);
  }

  return (
    <main className="p-8 max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold text-gray-800">Vendors</h2>
          <Link
            to="/vendors/new"
            className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
          >
            Add Vendor
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

        {vendors.length === 0 ? (
          <p className="text-sm text-gray-400">{searchParam ? "No vendors match your search." : "No vendors yet. Add one to get started."}</p>
        ) : (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Name</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Email</th>
                  <th className="text-left px-6 py-3 font-medium text-gray-600">Phone</th>
                  <th className="px-6 py-3" />
                </tr>
              </thead>
              <tbody>
                {vendors.map((vendor, i) => (
                  <tr
                    key={vendor.id}
                    className={i < vendors.length - 1 ? "border-b border-gray-100" : ""}
                  >
                    <td className="px-6 py-4 font-medium text-gray-800">{vendor.name}</td>
                    <td className="px-6 py-4 text-gray-600">{vendor.email ?? "—"}</td>
                    <td className="px-6 py-4 text-gray-600">{vendor.phone ?? "—"}</td>
                    <td className="px-6 py-4 text-right">
                      <Link
                        to={`/vendors/${vendor.id}`}
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
