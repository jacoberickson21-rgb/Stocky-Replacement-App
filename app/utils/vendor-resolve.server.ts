import { getDb } from "../db.server";

export type VendorResolution = { vendorId: number; created: boolean };

// Resolves a raw Shopify vendor string to a local Vendor record:
// exact match on shopifyVendorName, then exact match on name, then creates a new Vendor.
export async function resolveVendorId(vendorName: string): Promise<VendorResolution> {
  const db = getDb();
  const trimmed = vendorName.trim();

  const byShopifyName = await db.vendor.findFirst({
    where: { shopifyVendorName: { equals: trimmed, mode: "insensitive" } },
  });
  if (byShopifyName) return { vendorId: byShopifyName.id, created: false };

  const byName = await db.vendor.findFirst({
    where: { name: { equals: trimmed, mode: "insensitive" } },
  });
  if (byName) return { vendorId: byName.id, created: false };

  const created = await db.vendor.create({
    data: { name: trimmed, shopifyVendorName: trimmed },
  });
  return { vendorId: created.id, created: true };
}
