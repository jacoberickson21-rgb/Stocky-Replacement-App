import type { Route } from "./+types/api.stocktakes.$id.scan";
import { requireUserId } from "../session.server";
import { logFailure } from "../services/failure-log.server";
import {
  StocktakeCountError,
  addOutsideScopeItem,
  dismissUnknownBarcode,
  linkUnknownBarcode,
  scanBarcode,
  setExactQty,
  undoLastScan,
} from "../services/stocktake-count.server";
import { previewZero, zeroUnscanned } from "../services/stocktake-zero.server";

// JSON endpoint for the counting screen, called with plain fetch() from a
// one-at-a-time queue. Every call is saved to the database before it responds —
// the browser never holds a count on its own.
export async function action({ request, params }: Route.ActionArgs) {
  return Response.json(...(await handle(request, params)));
}

async function handle(request: Request, params: { id: string }): Promise<[unknown, ResponseInit?]> {
  const userId = await requireUserId(request);
  const stocktakeId = Number(params.id);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    switch (intent) {
      case "scan":
        return [await scanBarcode({ stocktakeId, userId, code: String(form.get("code") ?? "") })];

      case "add-outside":
        return [await addOutsideScopeItem({
          stocktakeId,
          userId,
          variantId: String(form.get("variantId") ?? ""),
          barcode: String(form.get("barcode") ?? ""),
          scans: Number(form.get("scans") ?? 1),
        })];

      case "set": {
        const raw = String(form.get("qty") ?? "").trim();
        const item = await setExactQty({
          stocktakeId,
          userId,
          itemId: Number(form.get("itemId")),
          qty: raw === "" ? NaN : Number(raw),
        });
        return [{ kind: "set", item }];
      }

      case "undo": {
        const result = await undoLastScan({ stocktakeId, userId });
        return [{ kind: "undone", ...result }];
      }

      case "link": {
        const result = await linkUnknownBarcode({
          stocktakeId,
          userId,
          unknownId: Number(form.get("unknownId")),
          variantId: String(form.get("variantId") ?? ""),
          saveBarcodeToShopify: form.get("saveBarcode") === "true",
        });
        return [{ kind: "linked", ...result }];
      }

      case "zero-preview": {
        // Read-only: lists what would be zeroed, with live on hand for information.
        const preview = await previewZero({
          stocktakeId,
          productId: String(form.get("productId") ?? ""),
          variantIds: form.getAll("variantId").map(String),
        });
        return [{ kind: "zero-preview", ...preview }];
      }

      case "zero": {
        const result = await zeroUnscanned({
          stocktakeId,
          userId,
          productId: String(form.get("productId") ?? ""),
          variantIds: form.getAll("variantId").map(String),
        });
        return [{ kind: "zeroed", ...result }];
      }

      case "dismiss":
        await dismissUnknownBarcode({ stocktakeId, unknownId: Number(form.get("unknownId")) });
        return [{ kind: "dismissed" }];

      default:
        return [{ kind: "error", message: "Unknown action." }, { status: 400 }];
    }
  } catch (err) {
    if (err instanceof StocktakeCountError) {
      return [{ kind: "error", message: err.message }, { status: 400 }];
    }
    const msg = err instanceof Error ? err.message : String(err);
    await logFailure("STOCKTAKE_COUNT", `Stocktake #${stocktakeId} ${intent}`, msg);
    return [{ kind: "error", message: "Not saved — something went wrong. The error has been logged." }, { status: 500 }];
  }
}
