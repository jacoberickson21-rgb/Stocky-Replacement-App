import { Link, useNavigate } from "react-router";
import { useState, useRef } from "react";
import type { Route } from "./+types/products";
import { requireUserId } from "../session.server";
import { getProductList } from "../services/shopify.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const cursor = url.searchParams.get("cursor") ?? null;

  const page = await getProductList(q, cursor);
  return { products: page.products, hasNextPage: page.hasNextPage, endCursor: page.endCursor, q, cursor };
}

const statusStyles: Record<string, string> = {
  ACTIVE: "bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300",
  DRAFT: "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400",
  ARCHIVED: "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300",
};

const statusLabels: Record<string, string> = {
  ACTIVE: "Active",
  DRAFT: "Draft",
  ARCHIVED: "Archived",
};

export default function ProductsPage({ loaderData }: Route.ComponentProps) {
  const { products, hasNextPage, endCursor, q, cursor } = loaderData;
  const navigate = useNavigate();
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

  return (
    <main className="p-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">Products</h2>
      </div>

      <div className="mb-6">
        <input
          type="text"
          value={searchValue}
          onChange={handleSearch}
          placeholder="Search by title, vendor, or SKU..."
          className="text-sm border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-96"
        />
      </div>

      {products.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 px-6 py-12 text-center text-sm text-gray-400 dark:text-gray-500">
          {q ? "No products match your search." : "No products found in your Shopify store."}
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400 w-14"></th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Title</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Vendor</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Status</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600 dark:text-gray-400">Variants</th>
                <th className="px-4 py-3 w-20"></th>
              </tr>
            </thead>
            <tbody>
              {products.map((product, i) => {
                const encodedId = encodeURIComponent(product.id);
                return (
                  <tr
                    key={product.id}
                    className={`hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors cursor-pointer ${i < products.length - 1 ? "border-b border-gray-100 dark:border-gray-700" : ""}`}
                    onClick={() => navigate(`/products/${encodedId}`)}
                  >
                    <td className="px-4 py-3">
                      {product.featuredImageUrl ? (
                        <img
                          src={product.featuredImageUrl}
                          alt={product.title}
                          className="w-10 h-10 object-cover rounded-lg border border-gray-100 dark:border-gray-700"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-lg bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 flex items-center justify-center">
                          <span className="text-gray-300 dark:text-gray-500 text-lg">&#9974;</span>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-800 dark:text-gray-100">{product.title}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{product.vendor || "—"}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${statusStyles[product.status] ?? "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400"}`}>
                        {statusLabels[product.status] ?? product.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-600 dark:text-gray-300">{product.totalVariants}</td>
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

      {(cursor || hasNextPage) && (
        <div className="flex items-center justify-between mt-4">
          <div>
            {cursor && (
              <Link
                to={`/products?${q ? `q=${encodeURIComponent(q)}&` : ""}cursor=`}
                className="text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors"
              >
                ← Previous
              </Link>
            )}
          </div>
          <div>
            {hasNextPage && endCursor && (
              <Link
                to={`/products?${q ? `q=${encodeURIComponent(q)}&` : ""}cursor=${encodeURIComponent(endCursor)}`}
                className="text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors"
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
