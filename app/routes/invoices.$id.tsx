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
  );
}
