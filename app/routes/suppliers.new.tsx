import { redirect, data } from "react-router";
import { Link } from "react-router";
import type { Route } from "./+types/suppliers.new";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  await requireUserId(request);

  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  const contactName = String(form.get("contactName") ?? "").trim() || null;
  const email = String(form.get("email") ?? "").trim() || null;
  const phone = String(form.get("phone") ?? "").trim() || null;

  if (!name) {
    return data({ error: "Supplier name is required." }, { status: 400 });
  }

  const supplier = await getDb().supplier.create({ data: { name, contactName, email, phone } });

  return redirect(`/suppliers/${supplier.id}`);
}

export default function NewSupplierPage({ actionData }: Route.ComponentProps) {
  return (
    <main className="p-8 max-w-lg mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link to="/suppliers" className="text-sm text-gray-500 hover:text-gray-800 transition-colors">
          ← Suppliers
        </Link>
        <span className="text-gray-300">/</span>
        <h2 className="text-xl font-semibold text-gray-800">New Supplier</h2>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
        {actionData?.error && (
          <p className="mb-5 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">
            {actionData.error}
          </p>
        )}

        <form method="post" className="space-y-5">
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
              Supplier Name <span className="text-red-500">*</span>
            </label>
            <input
              id="name"
              name="name"
              type="text"
              required
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label htmlFor="contactName" className="block text-sm font-medium text-gray-700 mb-1">
              Contact Name
            </label>
            <input
              id="contactName"
              name="contactName"
              type="text"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label htmlFor="phone" className="block text-sm font-medium text-gray-700 mb-1">
              Phone
            </label>
            <input
              id="phone"
              name="phone"
              type="tel"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg px-5 py-2 transition-colors"
            >
              Save Supplier
            </button>
            <Link
              to="/suppliers"
              className="text-sm font-medium text-gray-600 hover:text-gray-800 rounded-lg px-5 py-2 border border-gray-300 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </main>
  );
}
