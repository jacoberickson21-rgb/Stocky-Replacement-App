import { data } from "react-router";
import type { Route } from "./+types/api.shopify.variants";
import { requireUserId } from "../session.server";
import { productVariantsBulkCreate, updateInventoryItemCost } from "../services/shopify.server";
import { logFailure } from "../services/failure-log.server";

export async function action({ request }: Route.ActionArgs) {
  await requireUserId(request);

  const form = await request.formData();
  const productId = String(form.get("productId") ?? "").trim();
  const price = String(form.get("price") ?? "").trim();
  const costRaw = String(form.get("cost") ?? "").trim();
  const sku = String(form.get("sku") ?? "").trim();
  const barcode = String(form.get("barcode") ?? "").trim();
  const optionNamesRaw = String(form.get("optionNames") ?? "[]");

  if (!productId) return data({ error: "Product ID is required." }, { status: 400 });
  if (!price || isNaN(parseFloat(price))) return data({ error: "Price is required." }, { status: 400 });

  let optionNames: string[] = [];
  try { optionNames = JSON.parse(optionNamesRaw); } catch { /* ignore */ }

  const optionValues = optionNames
    .map((name) => ({ optionName: name, name: String(form.get(`option_${name}`) ?? "").trim() }))
    .filter((ov) => ov.name);

  if (optionNames.length > 0 && optionValues.length !== optionNames.length) {
    return data({ error: "Please fill in all option values." }, { status: 400 });
  }

  try {
    const created = await productVariantsBulkCreate(productId, [{
      optionValues,
      price: parseFloat(price).toFixed(2),
      sku,
      barcode,
    }]);

    const newVar = created[0];
    if (!newVar) throw new Error("No variant returned from Shopify.");

    const cost = costRaw && !isNaN(parseFloat(costRaw)) ? parseFloat(costRaw) : null;
    if (cost !== null) {
      await updateInventoryItemCost(newVar.inventoryItemId, cost);
    }

    return data({
      variant: {
        id: newVar.id,
        title: newVar.title,
        price: newVar.price,
        sku: newVar.sku,
        barcode: newVar.barcode,
        inventoryItemId: newVar.inventoryItemId,
        unitCost: cost,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logFailure("shopify:add-variant-from-po", sku || productId, msg);
    return data({ error: msg }, { status: 500 });
  }
}
