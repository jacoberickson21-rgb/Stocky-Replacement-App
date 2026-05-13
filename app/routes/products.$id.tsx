import { useState, useEffect, useRef } from "react";
import { Link, useActionData, useFetcher, useRevalidator } from "react-router";
import type { Route } from "./+types/products.$id";
import { requireUserId } from "../session.server";
import { logFailure } from "../services/failure-log.server";
import {
  getProductById,
  getProductTypes,
  getVendors,
  getProductTags,
  getPublications,
  getProductPublicationIds,
  updateProductMetadata,
  updateVariantPrice,
  updateInventoryItemCost,
  updateInventoryItemSku,
  updateVariantBarcode,
  assignVariantImage,
  stagedUploadCreate,
  createProductMedia,
  deleteProductImage,
  reorderProductImages,
  publishProduct,
  unpublishProduct,
} from "../services/shopify.server";
import type { Publication } from "../services/shopify.server";

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUserId(request);
  const rawId = decodeURIComponent(params.id);
  const [product, productTypes, vendors, allTags, publications, publishedIds] =
    await Promise.all([
      getProductById(rawId),
      getProductTypes(),
      getVendors(),
      getProductTags(),
      getPublications(),
      getProductPublicationIds(rawId),
    ]);
  if (!product) throw new Response("Product not found", { status: 404 });
  return { product, productTypes, vendors, allTags, publications, publishedIds };
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request, params }: Route.ActionArgs) {
  await requireUserId(request);
  const rawId = decodeURIComponent(params.id);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "updateProduct") {
    const title = String(formData.get("title") ?? "").trim();
    if (!title) return { intent, error: "Title is required." };

    const plainText = String(formData.get("descriptionText") ?? "").trim();
    const descriptionHtml = plainText
      ? plainText
          .split(/\n{2,}/)
          .map((para) => `<p>${para.replace(/\n/g, "<br>")}</p>`)
          .join("")
      : "";

    const productType = String(formData.get("productType") ?? "").trim();
    const vendor = String(formData.get("vendor") ?? "").trim();
    const tagsRaw = String(formData.get("tags") ?? "").trim();
    const tags = tagsRaw ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean) : [];
    const status = String(formData.get("status") ?? "").trim();

    try {
      await updateProductMetadata(rawId, { title, descriptionHtml, productType, vendor, tags, status });
      return { intent, success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logFailure("shopify:update-product", title, msg);
      return { intent, error: msg };
    }
  }

  if (intent === "updateVariantPrice") {
    const variantId = String(formData.get("variantId") ?? "");
    const label = String(formData.get("label") ?? variantId);
    const price = String(formData.get("price") ?? "").trim();
    const compareAtPrice = String(formData.get("compareAtPrice") ?? "").trim() || null;
    if (!price || isNaN(parseFloat(price))) return { intent, variantId, error: "Invalid price." };
    try {
      await updateVariantPrice(variantId, parseFloat(price).toFixed(2), compareAtPrice ? parseFloat(compareAtPrice).toFixed(2) : null);
      return { intent, variantId, success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logFailure("shopify:update-variant-price", label, msg);
      return { intent, variantId, error: msg };
    }
  }

  if (intent === "updateVariantCost") {
    const inventoryItemId = String(formData.get("inventoryItemId") ?? "");
    const label = String(formData.get("label") ?? inventoryItemId);
    const cost = parseFloat(String(formData.get("cost") ?? "").trim());
    if (isNaN(cost) || cost < 0) return { intent, inventoryItemId, error: "Invalid cost." };
    try {
      await updateInventoryItemCost(inventoryItemId, cost);
      return { intent, inventoryItemId, success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logFailure("shopify:update-variant-cost", label, msg);
      return { intent, inventoryItemId, error: msg };
    }
  }

  if (intent === "updateVariantSku") {
    const inventoryItemId = String(formData.get("inventoryItemId") ?? "");
    const label = String(formData.get("label") ?? inventoryItemId);
    const sku = String(formData.get("sku") ?? "").trim();
    try {
      await updateInventoryItemSku(inventoryItemId, sku);
      return { intent, inventoryItemId, success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logFailure("shopify:update-variant-sku", label, msg);
      return { intent, inventoryItemId, error: msg };
    }
  }

  if (intent === "updateVariantBarcode") {
    const variantId = String(formData.get("variantId") ?? "");
    const label = String(formData.get("label") ?? variantId);
    const barcode = String(formData.get("barcode") ?? "").trim();
    try {
      await updateVariantBarcode(variantId, barcode);
      return { intent, variantId, success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logFailure("shopify:update-variant-barcode", label, msg);
      return { intent, variantId, error: msg };
    }
  }

  if (intent === "assignVariantImage") {
    const variantId = String(formData.get("variantId") ?? "");
    const imageId = String(formData.get("imageId") ?? "");
    const label = String(formData.get("label") ?? variantId);
    try {
      await assignVariantImage(variantId, imageId);
      return { intent, variantId, success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logFailure("shopify:assign-variant-image", label, msg);
      return { intent, variantId, error: msg };
    }
  }

  if (intent === "uploadImage") {
    const file = formData.get("image");
    if (!(file instanceof File) || file.size === 0) return { intent, error: "No file provided." };
    try {
      const staged = await stagedUploadCreate(file.name, file.type, file.size);
      const uploadForm = new FormData();
      for (const p of staged.parameters) uploadForm.append(p.name, p.value);
      uploadForm.append("file", file);
      const uploadResp = await fetch(staged.url, { method: "POST", body: uploadForm });
      if (!uploadResp.ok) throw new Error(`Staged upload failed: ${uploadResp.status}`);
      const stagedPath = staged.parameters.find((p) => p.name === "key")?.value ?? file.name;
      await createProductMedia(rawId, stagedPath, file.name);
      return { intent, success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logFailure("shopify:upload-image", rawId, msg);
      return { intent, error: msg };
    }
  }

  if (intent === "deleteImage") {
    const imageId = String(formData.get("imageId") ?? "");
    try {
      await deleteProductImage(rawId, imageId);
      return { intent, imageId, success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logFailure("shopify:delete-image", rawId, msg);
      return { intent, imageId, error: msg };
    }
  }

  if (intent === "reorderImages") {
    const orderedIds = String(formData.get("orderedIds") ?? "").split(",").filter(Boolean);
    const moves = orderedIds.map((id, idx) => ({ id, newPosition: String(idx + 1) }));
    try {
      await reorderProductImages(rawId, moves);
      return { intent, success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logFailure("shopify:reorder-images", rawId, msg);
      return { intent, error: msg };
    }
  }

  if (intent === "toggleChannel") {
    const publicationId = String(formData.get("publicationId") ?? "");
    const publish = formData.get("publish") === "true";
    try {
      if (publish) {
        await publishProduct(rawId, [publicationId]);
      } else {
        await unpublishProduct(rawId, [publicationId]);
      }
      return { intent, publicationId, success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logFailure("shopify:toggle-channel", publicationId, msg);
      return { intent, publicationId, error: msg };
    }
  }

  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

// ─── Shared styles ────────────────────────────────────────────────────────────

const inputClass =
  "border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white";

const btnPrimary =
  "bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors disabled:opacity-50";

// ─── Shared types ─────────────────────────────────────────────────────────────

type ActionResult = {
  intent?: string;
  success?: boolean;
  error?: string;
  variantId?: string;
  inventoryItemId?: string;
  imageId?: string;
  publicationId?: string;
} | null | undefined;

// ─── SaveFeedback ─────────────────────────────────────────────────────────────

function SaveFeedback({ success, error }: { success?: boolean; error?: string }) {
  if (success) return <span className="text-sm text-green-600 font-medium">Saved</span>;
  if (error) return <span className="text-sm text-red-600">{error}</span>;
  return null;
}

// ─── ComboboxField ────────────────────────────────────────────────────────────

function ComboboxField({
  name,
  label,
  defaultValue,
  options,
}: {
  name: string;
  label: string;
  defaultValue: string;
  options: string[];
}) {
  const [inputValue, setInputValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = options.filter((o) =>
    o.toLowerCase().includes(inputValue.toLowerCase())
  );

  function select(val: string) {
    setInputValue(val);
    setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative">
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      <input type="hidden" name={name} value={inputValue} />
      <input
        type="text"
        value={inputValue}
        onChange={(e) => { setInputValue(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className={`${inputClass} w-full`}
        autoComplete="off"
      />
      {open && filtered.length > 0 && (
        <ul className="absolute z-20 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
          {filtered.map((opt) => (
            <li
              key={opt}
              onMouseDown={() => select(opt)}
              className="px-3 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-700 cursor-pointer"
            >
              {opt}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── TagInput ─────────────────────────────────────────────────────────────────

function TagInput({
  initialTags,
  allTags,
}: {
  initialTags: string[];
  allTags: string[];
}) {
  const [chips, setChips] = useState<string[]>(initialTags);
  const [inputValue, setInputValue] = useState("");
  const [open, setOpen] = useState(false);

  const available = allTags.filter(
    (t) => !chips.includes(t) && t.toLowerCase().includes(inputValue.toLowerCase())
  );

  function addTag(tag: string) {
    const trimmed = tag.trim();
    if (trimmed && !chips.includes(trimmed)) {
      setChips((prev) => [...prev, trimmed]);
    }
    setInputValue("");
    setOpen(false);
  }

  function removeTag(tag: string) {
    setChips((prev) => prev.filter((t) => t !== tag));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (inputValue.trim()) addTag(inputValue);
    } else if (e.key === "Backspace" && !inputValue && chips.length > 0) {
      setChips((prev) => prev.slice(0, -1));
    }
  }

  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">Tags</label>
      <input type="hidden" name="tags" value={chips.join(",")} />
      <div className={`${inputClass} w-full min-h-[42px] flex flex-wrap gap-1.5 items-center cursor-text`}>
        {chips.map((chip) => (
          <span
            key={chip}
            className="inline-flex items-center gap-1 bg-blue-50 text-blue-700 text-xs font-medium rounded-full px-2.5 py-1"
          >
            {chip}
            <button
              type="button"
              onClick={() => removeTag(chip)}
              className="text-blue-400 hover:text-blue-700 leading-none"
              aria-label={`Remove ${chip}`}
            >
              ×
            </button>
          </span>
        ))}
        <div className="relative flex-1 min-w-[120px]">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => { setInputValue(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={handleKeyDown}
            placeholder={chips.length === 0 ? "Add tags…" : ""}
            className="w-full bg-transparent outline-none text-sm text-gray-800 placeholder-gray-400"
            autoComplete="off"
          />
          {open && available.length > 0 && (
            <ul className="absolute z-20 top-full mt-1 left-0 w-56 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
              {available.map((tag) => (
                <li
                  key={tag}
                  onMouseDown={() => addTag(tag)}
                  className="px-3 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-700 cursor-pointer"
                >
                  {tag}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <p className="mt-1 text-xs text-gray-400">Type and press Enter or comma to add. Click × to remove.</p>
    </div>
  );
}

// ─── BasicInfoSection ─────────────────────────────────────────────────────────

function BasicInfoSection({
  product,
  productTypes,
  vendors,
  allTags,
  actionData,
}: {
  product: {
    title: string;
    descriptionHtml: string;
    productType: string;
    vendor: string;
    tags: string[];
    status: string;
  };
  productTypes: string[];
  vendors: string[];
  allTags: string[];
  actionData: ActionResult;
}) {
  const isMyResult = actionData?.intent === "updateProduct";
  const plainDescription = stripHtml(product.descriptionHtml);

  return (
    <section className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 mb-6">
      <h3 className="text-sm font-semibold text-gray-700 mb-4">Basic Info</h3>
      <form method="post" className="space-y-4">
        <input type="hidden" name="intent" value="updateProduct" />

        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Title <span className="text-red-500">*</span>
            </label>
            <input
              name="title"
              type="text"
              required
              defaultValue={product.title}
              className={`${inputClass} w-full`}
            />
          </div>

          <div className="col-span-2">
            <label className="block text-xs font-medium text-gray-600 mb-1">Description</label>
            <textarea
              name="descriptionText"
              rows={5}
              defaultValue={plainDescription}
              className={`${inputClass} w-full resize-y`}
              placeholder="Plain text description"
            />
          </div>

          <ComboboxField
            name="productType"
            label="Product Type"
            defaultValue={product.productType}
            options={productTypes}
          />

          <ComboboxField
            name="vendor"
            label="Vendor"
            defaultValue={product.vendor}
            options={vendors}
          />

          <div className="col-span-2">
            <TagInput initialTags={product.tags} allTags={allTags} />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Status</label>
            <select name="status" defaultValue={product.status} className={`${inputClass} w-full`}>
              <option value="ACTIVE">Active</option>
              <option value="DRAFT">Draft</option>
              <option value="ARCHIVED">Archived</option>
            </select>
          </div>
        </div>

        <div className="flex items-center gap-3 pt-1">
          <button type="submit" className={btnPrimary}>Save</button>
          {isMyResult && <SaveFeedback success={actionData?.success} error={actionData?.error} />}
        </div>
      </form>
    </section>
  );
}

// ─── VariantRow ───────────────────────────────────────────────────────────────

type Variant = {
  id: string;
  title: string;
  price: string;
  compareAtPrice: string | null;
  sku: string;
  barcode: string | null;
  inventoryQuantity: number;
  inventoryItemId: string;
  cost: number | null;
  imageUrl: string | null;
  imageId: string | null;
};

function VariantRow({ variant }: { variant: Variant }) {
  const priceFetcher = useFetcher<ActionResult>();
  const costFetcher = useFetcher<ActionResult>();
  const skuFetcher = useFetcher<ActionResult>();
  const barcodeFetcher = useFetcher<ActionResult>();

  const priceResult = priceFetcher.data as ActionResult;
  const costResult = costFetcher.data as ActionResult;
  const skuResult = skuFetcher.data as ActionResult;
  const barcodeResult = barcodeFetcher.data as ActionResult;

  const label = `${variant.title} (${variant.sku || variant.id})`;

  return (
    <div className="border border-gray-100 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {variant.imageUrl ? (
            <img
              src={variant.imageUrl}
              alt={variant.title}
              className="w-9 h-9 rounded-lg object-cover border border-gray-100 shrink-0"
            />
          ) : (
            <div className="w-9 h-9 rounded-lg bg-gray-100 border border-gray-200 shrink-0" />
          )}
          <span className="text-sm font-medium text-gray-700">{variant.title}</span>
        </div>
        <span className="text-xs text-gray-400 shrink-0">
          Inventory:{" "}
          <span className="font-medium text-gray-600">{variant.inventoryQuantity}</span>
          <span className="text-gray-300 ml-1">(updated via receiving)</span>
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Price</label>
          <priceFetcher.Form method="post" className="flex gap-1">
            <input type="hidden" name="intent" value="updateVariantPrice" />
            <input type="hidden" name="variantId" value={variant.id} />
            <input type="hidden" name="label" value={label} />
            <input type="hidden" name="compareAtPrice" value={variant.compareAtPrice ?? ""} />
            <input name="price" type="number" step="0.01" min="0" defaultValue={variant.price} className={`${inputClass} w-full`} />
            <button type="submit" className={btnPrimary} disabled={priceFetcher.state !== "idle"}>
              {priceFetcher.state !== "idle" ? "…" : "Save"}
            </button>
          </priceFetcher.Form>
          {priceResult?.intent === "updateVariantPrice" && priceResult.variantId === variant.id && (
            <SaveFeedback success={priceResult.success} error={priceResult.error} />
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Cost</label>
          <costFetcher.Form method="post" className="flex gap-1">
            <input type="hidden" name="intent" value="updateVariantCost" />
            <input type="hidden" name="inventoryItemId" value={variant.inventoryItemId} />
            <input type="hidden" name="label" value={label} />
            <input name="cost" type="number" step="0.01" min="0" defaultValue={variant.cost ?? ""} placeholder="0.00" className={`${inputClass} w-full`} />
            <button type="submit" className={btnPrimary} disabled={costFetcher.state !== "idle"}>
              {costFetcher.state !== "idle" ? "…" : "Save"}
            </button>
          </costFetcher.Form>
          {costResult?.intent === "updateVariantCost" && costResult.inventoryItemId === variant.inventoryItemId && (
            <SaveFeedback success={costResult.success} error={costResult.error} />
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">SKU</label>
          <skuFetcher.Form method="post" className="flex gap-1">
            <input type="hidden" name="intent" value="updateVariantSku" />
            <input type="hidden" name="inventoryItemId" value={variant.inventoryItemId} />
            <input type="hidden" name="label" value={label} />
            <input name="sku" type="text" defaultValue={variant.sku} className={`${inputClass} w-full`} />
            <button type="submit" className={btnPrimary} disabled={skuFetcher.state !== "idle"}>
              {skuFetcher.state !== "idle" ? "…" : "Save"}
            </button>
          </skuFetcher.Form>
          {skuResult?.intent === "updateVariantSku" && skuResult.inventoryItemId === variant.inventoryItemId && (
            <SaveFeedback success={skuResult.success} error={skuResult.error} />
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Barcode</label>
          <barcodeFetcher.Form method="post" className="flex gap-1">
            <input type="hidden" name="intent" value="updateVariantBarcode" />
            <input type="hidden" name="variantId" value={variant.id} />
            <input type="hidden" name="label" value={label} />
            <input name="barcode" type="text" defaultValue={variant.barcode ?? ""} className={`${inputClass} w-full`} />
            <button type="submit" className={btnPrimary} disabled={barcodeFetcher.state !== "idle"}>
              {barcodeFetcher.state !== "idle" ? "…" : "Save"}
            </button>
          </barcodeFetcher.Form>
          {barcodeResult?.intent === "updateVariantBarcode" && barcodeResult.variantId === variant.id && (
            <SaveFeedback success={barcodeResult.success} error={barcodeResult.error} />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── VariantsSection ──────────────────────────────────────────────────────────

function VariantsSection({ variants }: { variants: Variant[] }) {
  return (
    <section className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 mb-6">
      <h3 className="text-sm font-semibold text-gray-700 mb-4">Variants</h3>
      <div className="space-y-3">
        {variants.map((v) => (
          <VariantRow key={v.id} variant={v} />
        ))}
      </div>
    </section>
  );
}

// ─── ImagesSection ────────────────────────────────────────────────────────────

type ProductImage = { id: string; url: string; altText: string | null; position: number };

function ImagesSection({
  initialImages,
  variants,
}: {
  initialImages: ProductImage[];
  variants: Variant[];
}) {
  const [images, setImages] = useState<ProductImage[]>(() =>
    [...initialImages].sort((a, b) => a.position - b.position)
  );
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [assigningImageId, setAssigningImageId] = useState<string | null>(null);
  const uploadFetcher = useFetcher<ActionResult>();
  const deleteFetcher = useFetcher<ActionResult>();
  const reorderFetcher = useFetcher<ActionResult>();
  const assignFetcher = useFetcher<ActionResult>();
  const fileRef = useRef<HTMLInputElement>(null);
  const revalidator = useRevalidator();

  useEffect(() => {
    setImages([...initialImages].sort((a, b) => a.position - b.position));
  }, [initialImages]);

  useEffect(() => {
    if (uploadFetcher.state === "idle" && (uploadFetcher.data as ActionResult)?.success) {
      if (fileRef.current) fileRef.current.value = "";
      revalidator.revalidate();
    }
  }, [uploadFetcher.state, uploadFetcher.data]);

  useEffect(() => {
    if (deleteFetcher.state === "idle" && (deleteFetcher.data as ActionResult)?.success) {
      revalidator.revalidate();
    }
  }, [deleteFetcher.state, deleteFetcher.data]);

  useEffect(() => {
    if (assignFetcher.state === "idle" && (assignFetcher.data as ActionResult)?.success) {
      setAssigningImageId(null);
      revalidator.revalidate();
    }
  }, [assignFetcher.state, assignFetcher.data]);

  useEffect(() => {
    if (!assigningImageId) return;
    function handleMouseDown(e: MouseEvent) {
      if (!(e.target as Element).closest("[data-variant-picker]")) {
        setAssigningImageId(null);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [assigningImageId]);

  function handleDragOver(e: React.DragEvent, targetId: string) {
    e.preventDefault();
    if (!draggingId || draggingId === targetId) return;
    setImages((prev) => {
      const next = [...prev];
      const fromIdx = next.findIndex((img) => img.id === draggingId);
      const toIdx = next.findIndex((img) => img.id === targetId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  }

  function handleDrop() {
    setDraggingId(null);
    const fd = new FormData();
    fd.append("intent", "reorderImages");
    fd.append("orderedIds", images.map((img) => img.id).join(","));
    reorderFetcher.submit(fd, { method: "post" });
  }

  function submitAssign(variantId: string, imageId: string, label: string) {
    const fd = new FormData();
    fd.append("intent", "assignVariantImage");
    fd.append("variantId", variantId);
    fd.append("imageId", imageId);
    fd.append("label", label);
    assignFetcher.submit(fd, { method: "post" });
  }

  const uploadResult = uploadFetcher.data as ActionResult;
  const deleteResult = deleteFetcher.data as ActionResult;
  const reorderResult = reorderFetcher.data as ActionResult;
  const assignResult = assignFetcher.data as ActionResult;

  return (
    <section className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 mb-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-700">Images</h3>
        {reorderResult?.intent === "reorderImages" && (
          <SaveFeedback success={reorderResult.success} error={reorderResult.error} />
        )}
      </div>

      {images.length === 0 && (
        <p className="text-sm text-gray-400 mb-4">No images. Add one below.</p>
      )}

      {images.length > 0 && (
        <div
          className="grid grid-cols-4 gap-3 mb-4"
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
        >
          {images.map((img, idx) => (
            <div
              key={img.id}
              draggable
              onDragStart={() => setDraggingId(img.id)}
              onDragOver={(e) => handleDragOver(e, img.id)}
              className={`relative group rounded-xl overflow-hidden border-2 cursor-grab ${
                draggingId === img.id ? "border-blue-400 opacity-50" : "border-gray-200"
              }`}
            >
              <img src={img.url} alt={img.altText ?? ""} className="w-full aspect-square object-cover" />

              {idx === 0 && (
                <span className="absolute top-2 left-2 bg-green-500 text-white text-xs font-semibold px-2 py-0.5 rounded-full shadow-sm">
                  Main
                </span>
              )}

              <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-2 p-2">
                {variants.length > 0 && (
                  <button
                    type="button"
                    data-variant-picker
                    onClick={() => setAssigningImageId(assigningImageId === img.id ? null : img.id)}
                    className="w-full bg-white text-gray-800 text-xs font-medium rounded-lg px-2 py-1.5 hover:bg-gray-100 transition-colors text-center"
                  >
                    Assign to variant
                  </button>
                )}
                <deleteFetcher.Form method="post" className="w-full">
                  <input type="hidden" name="intent" value="deleteImage" />
                  <input type="hidden" name="imageId" value={img.id} />
                  <button
                    type="submit"
                    disabled={deleteFetcher.state !== "idle"}
                    onClick={(e) => { if (!confirm("Delete this image?")) e.preventDefault(); }}
                    className="w-full bg-red-600 hover:bg-red-700 text-white text-xs font-medium rounded-lg px-2 py-1.5 transition-colors disabled:opacity-50"
                  >
                    Delete
                  </button>
                </deleteFetcher.Form>
              </div>

              {assigningImageId === img.id && (
                <div data-variant-picker className="absolute inset-x-0 bottom-0 bg-white border-t border-gray-200 rounded-b-xl p-2 z-10">
                  <div className="flex items-center justify-between mb-1.5">
                    <p className="text-xs font-medium text-gray-600">Assign to:</p>
                    <button
                      type="button"
                      onClick={() => setAssigningImageId(null)}
                      className="text-gray-400 hover:text-gray-600 text-sm leading-none px-1"
                      aria-label="Close"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="space-y-1 max-h-32 overflow-y-auto">
                    {variants.map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        disabled={assignFetcher.state !== "idle"}
                        onClick={() => submitAssign(v.id, img.id, `${v.title} (${v.sku})`)}
                        className="w-full text-left text-xs text-gray-700 hover:text-blue-700 hover:bg-blue-50 rounded px-2 py-1 transition-colors disabled:opacity-50 flex items-center gap-2"
                      >
                        {v.imageId === img.id && (
                          <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
                        )}
                        {v.title}
                      </button>
                    ))}
                  </div>
                  {assignResult?.intent === "assignVariantImage" && assignResult.error && (
                    <p className="text-xs text-red-600 mt-1">{assignResult.error}</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <uploadFetcher.Form method="post" encType="multipart/form-data" className="flex items-center gap-3">
        <input type="hidden" name="intent" value="uploadImage" />
        <input
          ref={fileRef}
          type="file"
          name="image"
          accept="image/*"
          className="text-sm text-gray-600 border border-gray-200 rounded-lg px-3 py-2 bg-white file:mr-3 file:text-sm file:font-medium file:text-blue-600 file:border-0 file:bg-blue-50 file:rounded file:px-2 file:py-1 file:cursor-pointer hover:file:bg-blue-100 transition-colors"
        />
        <button type="submit" disabled={uploadFetcher.state !== "idle"} className={btnPrimary}>
          {uploadFetcher.state !== "idle" ? "Uploading…" : "Upload"}
        </button>
        {uploadResult?.intent === "uploadImage" && (
          <SaveFeedback success={uploadResult.success} error={uploadResult.error} />
        )}
      </uploadFetcher.Form>

      {deleteResult?.intent === "deleteImage" && deleteResult.error && (
        <p className="mt-2 text-sm text-red-600">{deleteResult.error}</p>
      )}

      {images.length > 1 && (
        <p className="mt-2 text-xs text-gray-400">Drag images to reorder. Changes save automatically on drop.</p>
      )}
    </section>
  );
}

// ─── SalesChannelsSection ─────────────────────────────────────────────────────

function SalesChannelsSection({
  publications,
  initialPublishedIds,
}: {
  publications: Publication[];
  initialPublishedIds: string[];
}) {
  const fetcher = useFetcher<ActionResult>();
  const result = fetcher.data as ActionResult;

  // Optimistically track which channel is toggling and in what direction
  const [optimistic, setOptimistic] = useState<{ id: string; publish: boolean } | null>(null);

  const toggling = fetcher.state !== "idle" && optimistic !== null;

  const publishedSet = new Set(initialPublishedIds);
  if (optimistic) {
    if (optimistic.publish) publishedSet.add(optimistic.id);
    else publishedSet.delete(optimistic.id);
  }

  function toggle(publicationId: string, currentlyPublished: boolean) {
    const publish = !currentlyPublished;
    setOptimistic({ id: publicationId, publish });
    const fd = new FormData();
    fd.append("intent", "toggleChannel");
    fd.append("publicationId", publicationId);
    fd.append("publish", String(publish));
    fetcher.submit(fd, { method: "post" });
  }

  useEffect(() => {
    if (fetcher.state === "idle") setOptimistic(null);
  }, [fetcher.state]);

  if (publications.length === 0) return null;

  return (
    <section className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 mb-6">
      <h3 className="text-sm font-semibold text-gray-700 mb-4">Sales Channels</h3>
      <div className="space-y-2">
        {publications.map((pub) => {
          const isPublished = publishedSet.has(pub.id);
          const isThisToggling = toggling && optimistic?.id === pub.id;
          return (
            <div key={pub.id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
              <span className="text-sm text-gray-700">{pub.name}</span>
              <div className="flex items-center gap-3">
                {result?.intent === "toggleChannel" && result.publicationId === pub.id && result.error && (
                  <span className="text-xs text-red-600">{result.error}</span>
                )}
                <button
                  type="button"
                  disabled={isThisToggling}
                  onClick={() => toggle(pub.id, isPublished)}
                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none disabled:opacity-50 ${
                    isPublished ? "bg-blue-600" : "bg-gray-200"
                  }`}
                  aria-label={isPublished ? `Unpublish from ${pub.name}` : `Publish to ${pub.name}`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      isPublished ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                </button>
                <span className={`text-xs font-medium w-16 ${isPublished ? "text-blue-600" : "text-gray-400"}`}>
                  {isPublished ? "Published" : "Hidden"}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ProductDetailPage({ loaderData }: Route.ComponentProps) {
  const { product, productTypes, vendors, allTags, publications, publishedIds } = loaderData;
  const actionData = useActionData() as ActionResult;

  return (
    <main className="p-8 max-w-5xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link to="/products" className="text-sm text-gray-500 hover:text-gray-800 transition-colors">
          ← Products
        </Link>
        <span className="text-gray-300">/</span>
        <h2 className="text-xl font-semibold text-gray-800">{product.title}</h2>
        <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">
          {product.status.charAt(0) + product.status.slice(1).toLowerCase()}
        </span>
      </div>

      <BasicInfoSection
        product={product}
        productTypes={productTypes}
        vendors={vendors}
        allTags={allTags}
        actionData={actionData}
      />
      <VariantsSection variants={product.variants} />
      <ImagesSection initialImages={product.images} variants={product.variants} />
      <SalesChannelsSection publications={publications} initialPublishedIds={publishedIds} />
    </main>
  );
}
