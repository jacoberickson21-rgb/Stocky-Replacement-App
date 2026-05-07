import { data } from "react-router";
import type { Route } from "./+types/api.line-items.$id.link";
import { requireUserId } from "../session.server";
import { getDb } from "../db.server";

export async function action({ request, params }: Route.ActionArgs) {
  await requireUserId(request);
  const id = Number(params.id);
  if (isNaN(id)) {
    return data({ error: "Invalid line item id" }, { status: 400 });
  }

  const formData = await request.formData();
  const variantId = (formData.get("variantId") as string | null) ?? "";
  const productTitle = (formData.get("productTitle") as string | null) ?? "";
  const inventoryItemId =
    (formData.get("inventoryItemId") as string | null) ?? "";

  if (!variantId || !productTitle || !inventoryItemId) {
    return data({ error: "Missing required fields" }, { status: 400 });
  }

  await getDb().invoiceLineItem.update({
    where: { id },
    data: {
      shopifyVariantId: variantId,
      shopifyProductTitle: productTitle,
      shopifyInventoryItemId: inventoryItemId,
    },
  });

  return data({ ok: true });
}
