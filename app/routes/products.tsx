import { Link, useNavigate, useSearchParams } from "react-router";
import { useState, useRef } from "react";
import type { Route } from "./+types/products";
import { requireUserId } from "../session.server";
import { getDb } from "../db.server";

const PAGE_SIZE = 50;

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const db = getDb();
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1"));

  const where = q
    ? {
        OR: [
          { title: { contains: q, mode: "insensitive" as const } },
          { vendor: { contains: q, mode: "insensitive" as const } },
          { sku: { contains: q, mode: "insensitive" as const } },
          { barcode: { contains: q, mode: "insensitive" as const } },
        ],
      }
    : {};

  const [totalCount, products] = await Promise.all([
    db.productCache.count({ where }),
    db.productCache.findMany({
      where,
      orderBy: [{ title: "asc" }, { variantTitle: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        variantId: true, productId: true, title: true, variantTitle: true,
        sku: true, vendor: true, imageUrl: true, status: true, currentInventory: true,
      },
    }),
  ]);

  const noCache = totalCount === 0 && q === "";
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return { products, q, pagination: { page, totalPages, totalCount }, noCache };
}

const statusStyles: Record<string, string> = {
  ACTIVE: "bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300",
  DRAFT: "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400",
  ARCHIVED: "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300",
};
const statusLabels: Record<string, string> = { ACTIVE: "Active", DRAFT: "Draft", ARCHIVED: "Archived" };

function Pagination({ page, totalPages, buildUrl }: { page: number; totalPages: number; buildUrl: (p: number) => string }) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between mt-4">
      <div>{page > 1 && <Link to={buildUrl(page - 1)} className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">← Previous</Link>}</div>
      <span className="text-sm text-gray-500 dark:text-gray-400">Page {page} of {totalPages}</span>
      <div>{page < totalPages && <Link to={buildUrl(page + 1)} className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">Next →</Link>}</div>
    </div>
  );
}

export default function ProductsPage({ loaderData }: Route.ComponentProps) {
  const { products, q, pagination, noCache } = loaderData;
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const [searchValue, setSearchValue] = useState(q);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleSearch(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setSearchValue(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const params = new URLSearchParams();
      if (val) params.set("q", val);
      navigate(`/products?${params.toString()}`);
    }, 350);
  }

  function buildPageUrl(p: number) {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    params.set("page", String(p));
    return `/products?${params.toString()}`;
  }

  return (
    <main className="p-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Products</h2>
        {!noCache && (
          <span className="text-xs text-gray-400 dark:text-gray-500">{pagination.totalCount} variants cached</span>
        )}
      </div>

      {noCache ? (
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 px-6 py-12 text-center">
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">No product data cached yet.</p>
          <p className="text-xs text-gray-400 dark:text-gray-500">Click <strong>Sync Data</strong> in the navigation bar to fetch products from Shopify.</p>
        </div>
      ) : (
        <>
          <div className="mb-6">
            <input
              type="text"
              value={searchValue}
              onChange={handleSearch}
              placeholder="Search by title, vendor, SKU, or barcode..."
              className="text-sm border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-96"
            />
          </div>

          {products.length === 0 ? (
            <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 px-6 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
              No products match your search.
            </div>
          ) : (
            <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                    <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400 w-14"></th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Title</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Variant</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Vendor</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Status</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Stock</th>
                    <th className="px-4 py-3 w-20"></th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((product, i) => {
                    const encodedId = encodeURIComponent(product.productId);
                    return (
                      <tr
                        key={product.variantId}
                        className={`hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors cursor-pointer ${i < products.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : ""}`}
                        onClick={() => navigate(`/products/${encodedId}`)}
                      >
                        <td className="px-4 py-3">
                          {product.imageUrl ? (
                            <img src={product.imageUrl} alt={product.title} className="w-10 h-10 object-cover rounded-lg border border-gray-100 dark:border-gray-700" />
                          ) : (
                            <div className="w-10 h-10 rounded-lg bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 flex items-center justify-center">
                              <span className="text-gray-300 dark:text-gray-500 text-lg">&#9974;</span>
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 font-medium text-gray-800 dark:text-gray-100">{product.title}</td>
                        <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-xs">
                          {product.variantTitle && product.variantTitle !== "Default Title" ? product.variantTitle : "—"}
                        </td>
                        <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{product.vendor || "—"}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${statusStyles[product.status] ?? "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400"}`}>
                            {statusLabels[product.status] ?? product.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right text-gray-600 dark:text-gray-300">{product.currentInventory}</td>
                        <td className="px-4 py-3 text-right">
                          <Link
                            to={`/products/${encodedId}`}
                            className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors"
                            onClick={(e) => e.stopPropagation()}
                          >
                            Edit
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <Pagination page={pagination.page} totalPages={pagination.totalPages} buildUrl={buildPageUrl} />
        </>
      )}
    </main>
  );
}
