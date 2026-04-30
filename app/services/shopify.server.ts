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
  sku: string;
  vendor: string;
  costPrice: number;
  retailPrice: number;
  barcode?: string;
};

export type UpdateInventoryInput = {
  inventoryItemId: string;
  locationId: string;
  quantity: number;
};

// ─── Raw GraphQL Node Types ───────────────────────────────────────────────────

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
  const data = await shopifyGraphQL<{
    productCreate: {
      product: RawProductNode | null;
      userErrors: UserError[];
    };
  }>(
    `mutation CreateProduct($input: ProductInput!) {
      productCreate(input: $input) {
        product { ${PRODUCT_FIELDS} }
        userErrors { field message }
      }
    }`,
    {
      input: {
        title: input.title,
        vendor: input.vendor,
        status: "DRAFT",
        variants: [
          {
            sku: input.sku,
            barcode: input.barcode ?? null,
            price: input.retailPrice.toFixed(2),
          },
        ],
      },
    }
  );

  const { product, userErrors } = data.productCreate;

  if (userErrors.length > 0) {
    const messages = userErrors
      .map((e) => `${e.field.join(".")}: ${e.message}`)
      .join("; ");
    throw new ShopifyUserError(`Product creation failed: ${messages}`);
  }

  if (!product) {
    throw new ShopifyGraphQLError("productCreate returned no product");
  }

  const created = parseProduct(product);

  const inventoryItemId = created.variants[0]?.inventoryItemId;
  if (inventoryItemId && input.costPrice > 0) {
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
        {
          id: inventoryItemId,
          input: { cost: input.costPrice.toFixed(2) },
        }
      );

      const costErrors = costData.inventoryItemUpdate.userErrors;
      if (costErrors.length > 0) {
        const msg = costErrors.map((e) => e.message).join("; ");
        await logFailure(
          "shopify:set-cost",
          input.sku,
          `Cost update userErrors for product ${created.id}: ${msg}`
        );
      }
    } catch (err) {
      await logFailure(
        "shopify:set-cost",
        input.sku,
        `Cost update failed for product ${created.id}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
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
  const data = await shopifyGraphQL<{
    inventorySetQuantities: { userErrors: UserError[] };
  }>(
    `mutation SetInventory($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup { id }
        userErrors { field message }
      }
    }`,
    {
      input: {
        name: "available",
        reason: "correction",
        quantities: [
          {
            inventoryItemId: opts.inventoryItemId,
            locationId: opts.locationId,
            quantity: opts.quantity,
          },
        ],
      },
    }
  );

  const { userErrors } = data.inventorySetQuantities;
  if (userErrors.length > 0) {
    const messages = userErrors
      .map((e) => `${e.field.join(".")}: ${e.message}`)
      .join("; ");
    throw new ShopifyUserError(`Inventory update failed: ${messages}`);
  }
}
