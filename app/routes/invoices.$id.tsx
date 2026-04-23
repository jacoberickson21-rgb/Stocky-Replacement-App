import { Link } from "react-router";
import type { Route } from "./+types/invoices.$id";
import { getDb } from "../db.server";
import { requireUserId } from "../session.server";

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
  const id = Number(params.id);
  const invoice = await getDb().invoice.findUniqueOrThrow({
    where: { id },
    include: { vendor: true },
  });
  return { invoice };
}

export default function InvoiceDetailPage({ loaderData }: Route.ComponentProps) {
  const { invoice } = loaderData;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-800">Stocky — Invoices</h1>
        <form method="post" action="/logout">
          <button
            type="submit"
            className="text-sm text-gray-500 hover:text-gray-800 transition-colors"
          >
            Sign out
          </button>
        </form>
      </header>

      <main className="p-8 max-w-lg mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <Link to="/invoices" className="text-sm text-gray-500 hover:text-gray-800 transition-colors">
            ← Invoices
          </Link>
          <span className="text-gray-300">/</span>
          <h2 className="text-xl font-semibold text-gray-800">{invoice.invoiceNumber}</h2>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          <p className="text-sm text-gray-400">Invoice detail coming soon.</p>
        </div>
      </main>
    </div>
  );
}
