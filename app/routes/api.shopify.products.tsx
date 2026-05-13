import { data } from "react-router";
import type { Route } from "./+types/api.shopify.products";
import { requireUserId } from "../session.server";
import { searchProducts } from "../services/shopify.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUserId(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const vendorName = (url.searchParams.get("vendorName") ?? "").trim() || undefined;
  if (q.length < 2) {
    return data([], { status: 200 });
  }
  try {
    const results = await searchProducts(q, vendorName);
    console.log("[api] search results:", JSON.stringify(results.slice(0, 2), null, 2));
    return data(results, { status: 200 });
  } catch {
    return data([], { status: 200 });
  }
}
