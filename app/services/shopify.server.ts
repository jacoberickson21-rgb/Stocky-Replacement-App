import { logFailure } from "./failure-log.server";

// ─── Error Types ──────────────────────────────────────────────────────────────

export class ShopifyAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopifyAuthError";
  }
}

export class ShopifyAPIError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
    this.name = "ShopifyAPIError";
  }
}

export class ShopifyGraphQLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopifyGraphQLError";
  }
}

export class ShopifyUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopifyUserError";
  }
}

// ─── Public Types ─────────────────────────────────────────────────────────────

export type ShopifyVariant = {
  id: string;
  sku: string;
  barcode: string | null;
  price: string;
  inventoryItemId: string;
};

export type ShopifyProduct = {
  id: string;
  title: string;
  vendor: string;
  status: string;
  variants: ShopifyVariant[];
};

export type CreateDraftProductInput = {
  title: string;
  sku?: string;
  vendor: string;
  costPrice: number;
  retailPrice?: number;
  barcode?: string;
};

export type UpdateInventoryInput = {
  inventoryItemId: string;
  locationId: string;
  quantity: number;
};

export type ProductSearchResult = {
  productTitle: string;
  variantTitle: string;
  variantId: string;
  sku: string;
  inventoryItemId: string;
  inventoryQty: number | null;
  unitCost: number | null;
};

// ─── Raw GraphQL Node Types ───────────────────────────────────────────────────

type RawSearchVariantNode = {
  id: string;
  title: string;
  sku: string;
  inventoryItem: {
    id: string;
    unitCost: { amount: string } | null;
    inventoryLevels: {
      edges: {
        node: {
          quantities: { name: string; quantity: number }[];
        };
      }[];
    };
  };
};

type RawSearchProductNode = {
  title: string;
  variants: { edges: { node: RawSearchVariantNode }[] };
};

type RawVariantNode = {
  id: string;
  sku: string;
  barcode: string | null;
  price: string;
  inventoryItem: { id: string };
};

type RawProductNode = {
  id: string;
  title: string;
  vendor: string;
  status: string;
  variants: { edges: { node: RawVariantNode }[] };
};

type UserError = { field: string[]; message: string };

// ─── Token Cache ──────────────────────────────────────────────────────────────

interface TokenCache {
  accessToken: string;
  /** Timestamp (ms) after which this token should be considered expired. Includes a 30-min buffer. */
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new ShopifyAuthError(`Missing environment variable: ${key}`);
  return val;
}

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now) {
    return tokenCache.accessToken;
  }

  const clientId = requireEnv("SHOPIFY_CLIENT_ID");
  const clientSecret = requireEnv("SHOPIFY_CLIENT_SECRET");
  const store = requireEnv("SHOPIFY_STORE");

  const response = await fetch(
    `https://${store}.myshopify.com/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new ShopifyAuthError(
      `Shopify token request failed (${response.status}): ${text}`
    );
  }

  const data = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };

  if (!data.access_token) {
    throw new ShopifyAuthError("Shopify token response missing access_token");
  }

  const expiresInMs = (data.expires_in ?? 86400) * 1000;
  tokenCache = {
    accessToken: data.access_token,
    expiresAt: now + expiresInMs - 30 * 60 * 1000,
  };

  return tokenCache.accessToken;
}

// ─── GraphQL Helper ───────────────────────────────────────────────────────────

async function shopifyGraphQL<T>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const token = await getAccessToken();
  const store = requireEnv("SHOPIFY_STORE");

  const response = await fetch(
    `https://${store}.myshopify.com/admin/api/2026-04/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (!response.ok) {
    throw new ShopifyAPIError(
      `Shopify API request failed (${response.status})`,
      response.status
    );
  }

  const result = (await response.json()) as {
    data?: T;
    errors?: { message: string }[];
  };

  if (result.errors?.length) {
    const messages = result.errors.map((e) => e.message).join("; ");
    throw new ShopifyGraphQLError(`Shopify GraphQL errors: ${messages}`);
  }

  if (!result.data) {
    throw new ShopifyGraphQLError("Shopify returned empty data");
  }

  return result.data;
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

function parseVariant(node: RawVariantNode): ShopifyVariant {
  return {
    id: node.id,
    sku: node.sku,
    barcode: node.barcode,
    price: node.price,
    inventoryItemId: node.inventoryItem.id,
  };
}

function parseProduct(node: RawProductNode): ShopifyProduct {
  return {
    id: node.id,
    title: node.title,
    vendor: node.vendor,
    status: node.status,
    variants: node.variants.edges.map((e) => parseVariant(e.node)),
  };
}

// ─── Shared Fragment ──────────────────────────────────────────────────────────

const PRODUCT_FIELDS = `
  id
  title
  vendor
  status
  variants(first: 10) {
    edges {
      node {
        id
        sku
        barcode
        price
        inventoryItem {
          id
        }
      }
    }
  }
`;

// ─── Exported Operations ──────────────────────────────────────────────────────

export async function lookupProduct(opts: {
  sku?: string;
  barcode?: string;
}): Promise<ShopifyProduct | null> {
  if (!opts.sku && !opts.barcode) {
    throw new Error("lookupProduct requires sku or barcode");
  }

  const queryStr = opts.sku ? `sku:${opts.sku}` : `barcode:${opts.barcode}`;

  const data = await shopifyGraphQL<{
    products: { edges: { node: RawProductNode }[] };
  }>(
    `query LookupProduct($query: String!) {
      products(first: 1, query: $query) {
        edges {
          node { ${PRODUCT_FIELDS} }
        }
      }
    }`,
    { query: queryStr }
  );

  const edge = data.products.edges[0];
  return edge ? parseProduct(edge.node) : null;
}

export async function createDraftProduct(
  input: CreateDraftProductInput
): Promise<ShopifyProduct> {
  // Step 1: Create product, get back the auto-created default variant ID
  type RawCreatedProduct = {
    id: string;
    title: string;
    vendor: string;
    status: string;
    variants: { edges: { node: { id: string; inventoryItem: { id: string } } }[] };
  };
  const createData = await shopifyGraphQL<{
    productCreate: { product: RawCreatedProduct | null; userErrors: UserError[] };
  }>(
    `mutation CreateProduct($input: ProductInput!) {
      productCreate(input: $input) {
        product {
          id title vendor status
          variants(first: 1) { edges { node { id inventoryItem { id } } } }
        }
        userErrors { field message }
      }
    }`,
    { input: { title: input.title, vendor: input.vendor, status: "DRAFT" } }
  );

  const { product: createdProduct, userErrors: createErrors } = createData.productCreate;
  if (createErrors.length > 0) {
    const messages = createErrors.map((e) => `${e.field.join(".")}: ${e.message}`).join("; ");
    throw new ShopifyUserError(`Product creation failed: ${messages}`);
  }
  if (!createdProduct) throw new ShopifyGraphQLError("productCreate returned no product");

  const defaultVariantNode = createdProduct.variants.edges[0]?.node;
  if (!defaultVariantNode) throw new ShopifyGraphQLError("productCreate returned no default variant");

  // Step 2: Update the existing default variant instead of creating a new one
  type RawBulkVariant = {
    id: string;
    sku: string;
    barcode: string | null;
    price: string;
    inventoryItem: { id: string };
  };
  const updateData = await shopifyGraphQL<{
    productVariantsBulkUpdate: { productVariants: RawBulkVariant[]; userErrors: UserError[] };
  }>(
    `mutation UpdateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id sku barcode price inventoryItem { id } }
        userErrors { field message }
      }
    }`,
    {
      productId: createdProduct.id,
      variants: [
        {
          id: defaultVariantNode.id,
          price: (input.retailPrice ?? 0).toFixed(2),
          barcode: input.barcode ?? null,
          inventoryItem: { sku: input.sku, tracked: true },
        },
      ],
    }
  );

  const { productVariants, userErrors: updateErrors } = updateData.productVariantsBulkUpdate;
  if (updateErrors.length > 0) {
    const messages = updateErrors.map((e) => `${e.field.join(".")}: ${e.message}`).join("; ");
    throw new ShopifyUserError(`Variant update failed: ${messages}`);
  }

  const variant = productVariants[0];
  if (!variant) throw new ShopifyGraphQLError("productVariantsBulkUpdate returned no variants");

  const created: ShopifyProduct = {
    id: createdProduct.id,
    title: createdProduct.title,
    vendor: createdProduct.vendor,
    status: createdProduct.status,
    variants: [
      {
        id: variant.id,
        sku: variant.sku,
        barcode: variant.barcode,
        price: variant.price,
        inventoryItemId: variant.inventoryItem.id,
      },
    ],
  };

  // Step 3: Update inventory item cost
  if (variant.inventoryItem.id && input.costPrice > 0) {
    try {
      const costData = await shopifyGraphQL<{
        inventoryItemUpdate: { userErrors: UserError[] };
      }>(
        `mutation UpdateInventoryItemCost($id: ID!, $input: InventoryItemInput!) {
          inventoryItemUpdate(id: $id, input: $input) {
            inventoryItem { id }
            userErrors { field message }
          }
        }`,
        { id: variant.inventoryItem.id, input: { cost: input.costPrice.toFixed(2) } }
      );
      const costErrors = costData.inventoryItemUpdate.userErrors;
      if (costErrors.length > 0) {
        await logFailure("shopify:set-cost", input.sku ?? input.title, `Cost update userErrors for product ${created.id}: ${costErrors.map((e) => e.message).join("; ")}`);
      }
    } catch (err) {
      await logFailure("shopify:set-cost", input.sku ?? input.title, `Cost update failed for product ${created.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return created;
}

export async function getLocationId(): Promise<string> {
  const data = await shopifyGraphQL<{
    locations: { edges: { node: { id: string } }[] };
  }>(
    `query GetLocation {
      locations(first: 1) {
        edges {
          node { id }
        }
      }
    }`
  );

  const edge = data.locations.edges[0];
  if (!edge) {
    throw new ShopifyGraphQLError("No locations found in Shopify store");
  }

  return edge.node.id;
}

export async function updateInventoryLevel(
  opts: UpdateInventoryInput
): Promise<void> {
  // 2026-04 API requires changeFromQuantity for optimistic concurrency.
  // Query the current available quantity first; default to 0 if not yet stocked at this location.
  const levelData = await shopifyGraphQL<{
    inventoryItem: {
      inventoryLevel: {
        quantities: { name: string; quantity: number }[];
      } | null;
    } | null;
  }>(
    `query GetInventoryLevel($itemId: ID!, $locationId: ID!) {
      inventoryItem(id: $itemId) {
        inventoryLevel(locationId: $locationId) {
          quantities(names: ["available"]) {
            name
            quantity
          }
        }
      }
    }`,
    { itemId: opts.inventoryItemId, locationId: opts.locationId }
  );

  const currentQty =
    levelData.inventoryItem?.inventoryLevel?.quantities.find(
      (q) => q.name === "available"
    )?.quantity ?? 0;

  const data = await shopifyGraphQL<{
    inventoryAdjustQuantities: { userErrors: UserError[] };
  }>(
    `mutation AdjustInventory($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) {
        inventoryAdjustmentGroup { id }
        userErrors { field message }
      }
    }`,
    {
      input: {
        name: "available",
        reason: "received",
        changes: [
          {
            inventoryItemId: opts.inventoryItemId,
            locationId: opts.locationId,
            delta: opts.quantity,
            changeFromQuantity: currentQty,
          },
        ],
      },
    }
  );

  const { userErrors } = data.inventoryAdjustQuantities;
  if (userErrors.length > 0) {
    const messages = userErrors
      .map((e) => `${e.field.join(".")}: ${e.message}`)
      .join("; ");
    throw new ShopifyUserError(`Inventory update failed: ${messages}`);
  }
}

export async function updateInventoryItemCost(
  inventoryItemId: string,
  cost: number
): Promise<void> {
  const data = await shopifyGraphQL<{
    inventoryItemUpdate: { userErrors: UserError[] };
  }>(
    `mutation UpdateInventoryItemCost($id: ID!, $input: InventoryItemInput!) {
      inventoryItemUpdate(id: $id, input: $input) {
        inventoryItem { id }
        userErrors { field message }
      }
    }`,
    { id: inventoryItemId, input: { cost: cost.toFixed(2) } }
  );
  const { userErrors } = data.inventoryItemUpdate;
  if (userErrors.length > 0) {
    const messages = userErrors.map((e) => e.message).join("; ");
    throw new ShopifyUserError(`Inventory item cost update failed: ${messages}`);
  }
}

export async function updateInventoryItemSku(
  inventoryItemId: string,
  sku: string
): Promise<void> {
  const data = await shopifyGraphQL<{
    inventoryItemUpdate: { userErrors: UserError[] };
  }>(
    `mutation UpdateInventoryItemSku($id: ID!, $input: InventoryItemInput!) {
      inventoryItemUpdate(id: $id, input: $input) {
        inventoryItem { id }
        userErrors { field message }
      }
    }`,
    { id: inventoryItemId, input: { sku } }
  );
  const { userErrors } = data.inventoryItemUpdate;
  if (userErrors.length > 0) {
    const messages = userErrors.map((e) => e.message).join("; ");
    throw new ShopifyUserError(`Inventory item SKU update failed: ${messages}`);
  }
}

// ─── Multi-variant Draft Product ─────────────────────────────────────────────

export type DraftProductVariantInput = {
  sku?: string;
  optionValues: { name: string; value: string }[];
  price: number;
  barcode?: string;
  costPrice: number;
};

export type CreateDraftProductWithVariantsInput = {
  title: string;
  vendor: string;
  options: { name: string; values: string[] }[];
  variants: DraftProductVariantInput[];
};

function optionKey(opts: { name: string; value: string }[]): string {
  return opts
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((o) => `${o.name}:${o.value}`)
    .join("|");
}

export async function createDraftProductWithVariants(
  input: CreateDraftProductWithVariantsInput
): Promise<ShopifyProduct> {
  // Step 1: Create the product, capture default variant ID
  type RawCreatedProduct = {
    id: string;
    title: string;
    vendor: string;
    status: string;
    variants: { edges: { node: { id: string } }[] };
  };
  const createData = await shopifyGraphQL<{
    productCreate: { product: RawCreatedProduct | null; userErrors: UserError[] };
  }>(
    `mutation CreateProduct($input: ProductInput!) {
      productCreate(input: $input) {
        product {
          id title vendor status
          variants(first: 1) { edges { node { id } } }
        }
        userErrors { field message }
      }
    }`,
    { input: { title: input.title, vendor: input.vendor, status: "DRAFT" } }
  );

  const { product: createdProduct, userErrors: createErrors } = createData.productCreate;
  if (createErrors.length > 0) {
    throw new ShopifyUserError(`Product creation failed: ${createErrors.map((e) => `${e.field.join(".")}: ${e.message}`).join("; ")}`);
  }
  if (!createdProduct) throw new ShopifyGraphQLError("productCreate returned no product");

  const defaultVariantId = createdProduct.variants.edges[0]?.node.id;
  if (!defaultVariantId) throw new ShopifyGraphQLError("productCreate returned no default variant");

  // Step 2: Add options — Shopify creates one variant per combination
  type RawOptionVariant = {
    id: string;
    selectedOptions: { name: string; value: string }[];
    inventoryItem: { id: string };
  };
  const optionsData = await shopifyGraphQL<{
    productOptionsCreate: {
      product: { variants: { edges: { node: RawOptionVariant }[] } } | null;
      userErrors: UserError[];
    };
  }>(
    `mutation ProductOptionsCreate($productId: ID!, $options: [OptionCreateInput!]!) {
      productOptionsCreate(productId: $productId, options: $options, variantsStrategy: CREATE) {
        product {
          variants(first: 50) {
            edges { node { id selectedOptions { name value } inventoryItem { id } } }
          }
        }
        userErrors { field message }
      }
    }`,
    {
      productId: createdProduct.id,
      options: input.options.map((opt) => ({
        name: opt.name,
        values: opt.values.map((v) => ({ name: v })),
      })),
    }
  );

  const { product: optionProduct, userErrors: optionErrors } = optionsData.productOptionsCreate;
  if (optionErrors.length > 0) {
    throw new ShopifyUserError(`Options creation failed: ${optionErrors.map((e) => `${e.field.join(".")}: ${e.message}`).join("; ")}`);
  }
  if (!optionProduct) throw new ShopifyGraphQLError("productOptionsCreate returned no product");

  const allVariantNodes = optionProduct.variants.edges.map((e) => e.node);
  const customOptionNames = new Set(input.options.map((o) => o.name));

  // Separate real variants (have our custom options) from any leftover default
  const realVariants = allVariantNodes.filter((v) =>
    v.selectedOptions.some((o) => customOptionNames.has(o.name))
  );
  const legacyVariants = allVariantNodes.filter((v) =>
    !v.selectedOptions.some((o) => customOptionNames.has(o.name))
  );

  // Step 3: Delete any leftover legacy "Default Title" variant (non-fatal if it fails)
  if (legacyVariants.length > 0) {
    try {
      await shopifyGraphQL<{ productVariantsBulkDelete: { userErrors: UserError[] } }>(
        `mutation DeleteVariants($productId: ID!, $variantsIds: [ID!]!) {
          productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
            product { id }
            userErrors { field message }
          }
        }`,
        { productId: createdProduct.id, variantsIds: legacyVariants.map((v) => v.id) }
      );
    } catch {
      // Non-fatal: Shopify may have already cleaned it up
    }
  }

  // Step 4: Update each real variant with its specific SKU, price, barcode
  const shopifyByKey = new Map<string, RawOptionVariant>(
    realVariants.map((v) => [optionKey(v.selectedOptions), v])
  );

  const updateInputs = input.variants.map((cv) => {
    const sv = shopifyByKey.get(optionKey(cv.optionValues));
    if (!sv) throw new ShopifyGraphQLError(`No Shopify variant found for option key: ${optionKey(cv.optionValues)}`);
    return {
      id: sv.id,
      price: cv.price.toFixed(2),
      barcode: cv.barcode ?? null,
      inventoryItem: { sku: cv.sku, tracked: true },
    };
  });

  type RawUpdatedVariant = {
    id: string;
    sku: string;
    barcode: string | null;
    price: string;
    selectedOptions: { name: string; value: string }[];
    inventoryItem: { id: string };
  };
  const bulkUpdateData = await shopifyGraphQL<{
    productVariantsBulkUpdate: { productVariants: RawUpdatedVariant[]; userErrors: UserError[] };
  }>(
    `mutation BulkUpdateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id sku barcode price selectedOptions { name value } inventoryItem { id } }
        userErrors { field message }
      }
    }`,
    { productId: createdProduct.id, variants: updateInputs }
  );

  const { productVariants: updatedVariants, userErrors: updateErrors } = bulkUpdateData.productVariantsBulkUpdate;
  if (updateErrors.length > 0) {
    throw new ShopifyUserError(`Variant update failed: ${updateErrors.map((e) => `${e.field.join(".")}: ${e.message}`).join("; ")}`);
  }

  // Step 5: Set cost for each variant
  for (const cv of input.variants) {
    if (cv.costPrice <= 0) continue;
    const sv = shopifyByKey.get(optionKey(cv.optionValues));
    if (!sv) continue;
    try {
      const costData = await shopifyGraphQL<{ inventoryItemUpdate: { userErrors: UserError[] } }>(
        `mutation UpdateCost($id: ID!, $input: InventoryItemInput!) {
          inventoryItemUpdate(id: $id, input: $input) { inventoryItem { id } userErrors { field message } }
        }`,
        { id: sv.inventoryItem.id, input: { cost: cv.costPrice.toFixed(2) } }
      );
      const costErrors = costData.inventoryItemUpdate.userErrors;
      if (costErrors.length > 0) {
        await logFailure("shopify:set-cost", cv.sku ?? input.title, `Cost update userErrors: ${costErrors.map((e) => e.message).join("; ")}`);
      }
    } catch (err) {
      await logFailure("shopify:set-cost", cv.sku ?? input.title, `Cost update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    id: createdProduct.id,
    title: createdProduct.title,
    vendor: createdProduct.vendor,
    status: createdProduct.status,
    variants: updatedVariants.map((v) => ({
      id: v.id,
      sku: v.sku,
      barcode: v.barcode,
      price: v.price,
      inventoryItemId: v.inventoryItem.id,
    })),
  };
}

function buildShopifyQuery(input: string, vendorFilter?: string): string {
  const normalized = input.replace(/[-–—/\\|]+/g, " ");
  const words = normalized.trim().split(/\s+/).filter((w) => w.length > 1);
  let q: string;
  if (words.length === 0) {
    q = input;
  } else if (words.length === 1) {
    q = `(title:*${words[0]}* OR sku:*${words[0]}*)`;
  } else {
    q = words.map((w) => `(title:*${w}* OR sku:*${w}*)`).join(" AND ");
  }
  if (vendorFilter) {
    q = `(${q}) AND vendor:"${vendorFilter}"`;
  }
  return q;
}

export async function searchProducts(
  query: string,
  vendorFilter?: string
): Promise<ProductSearchResult[]> {
  const builtQuery = buildShopifyQuery(query, vendorFilter);
  console.log("[Shopify search] query:", builtQuery);

  const data = await shopifyGraphQL<{
    products: { edges: { node: RawSearchProductNode }[] };
  }>(
    `query SearchProducts($query: String!) {
      products(first: 15, query: $query) {
        edges {
          node {
            title
            variants(first: 50) {
              edges {
                node {
                  id
                  title
                  sku
                  inventoryItem {
                    id
                    unitCost {
                      amount
                    }
                    inventoryLevels(first: 1) {
                      edges {
                        node {
                          quantities(names: ["available"]) {
                            name
                            quantity
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }`,
    { query: builtQuery }
  );

  const results: ProductSearchResult[] = [];
  for (const productEdge of data.products.edges) {
    const product = productEdge.node;
    for (const variantEdge of product.variants.edges) {
      const variant = variantEdge.node;
      const levelNode =
        variant.inventoryItem.inventoryLevels.edges[0]?.node ?? null;
      const inventoryQty =
        levelNode?.quantities.find((q) => q.name === "available")?.quantity ??
        null;
      const unitCostRaw = variant.inventoryItem.unitCost?.amount;
      const unitCost = unitCostRaw != null ? parseFloat(unitCostRaw) : null;
      results.push({
        productTitle: product.title,
        variantTitle: variant.title,
        variantId: variant.id,
        sku: variant.sku,
        inventoryItemId: variant.inventoryItem.id,
        inventoryQty,
        unitCost,
      });
    }
  }
  return results;
}
