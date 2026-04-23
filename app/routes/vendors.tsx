import { Link } from "react-router";
import type { Route } from "./+types/vendors";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const vendors = await getDb().vendor.findMany({ orderBy: { name: "asc" } });
  return { vendors };
}

export default function VendorsPage({ loaderData }: Route.ComponentProps) {
  const { vendors } = loaderData;

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

        {vendors.length === 0 ? (
          <p className="text-sm text-gray-400">No vendors yet. Add one to get started.</p>
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
