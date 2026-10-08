import { getDb } from "../db.server";

export type SalesVelocityPeriod = "1w" | "2w" | "1m" | "2m" | "3m" | "6m" | "12m" | "lifetime";

export const PERIOD_DAYS: Record<Exclude<SalesVelocityPeriod, "lifetime">, number> = {
  "1w": 7,
  "2w": 14,
  "1m": 30,
  "2m": 60,
  "3m": 90,
  "6m": 180,
  "12m": 365,
};

export type VariantVelocityRow = {
  variantId: string;
  sku: string;
  productTitle: string;
  variantTitle: string;
  vendor: string;
  productType: string;
  currentStock: number;
  price: number;
  unitsSold: number;
  revenue: number;
  avgDailySales: number;
  daysRemaining: number | null;
};

export type VariantVelocityResult = {
  rows: VariantVelocityRow[];
  dayRange: number;
};

type RawRow = {
  variantId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  vendor: string | null;
  productType: string | null;
  currentStock: number;
  price: string;
  unitsSold: bigint;
  revenue: string;
};

// Accurate per-variant sales velocity, sourced from SalesCache (populated by the
// background order sync) joined to ProductCache for current stock/vendor/type.
// ShopifyQL's `sales` dataset can't group by variant, so this is the only path
// that supports real per-SKU numbers.
export async function getVariantSalesVelocity(period: SalesVelocityPeriod): Promise<VariantVelocityResult> {
  const db = getDb();
  const now = new Date();

  let start: Date;
  let dayRange: number;
  if (period === "lifetime") {
    const range = await db.$queryRaw<{ min: Date | null }[]>`SELECT MIN(date) as min FROM "SalesCache"`;
    start = range[0]?.min ?? new Date(now.getTime() - 365 * 86_400_000);
    dayRange = Math.max(1, Math.ceil((now.getTime() - start.getTime()) / 86_400_000));
  } else {
    dayRange = PERIOD_DAYS[period];
    start = new Date(now.getTime() - dayRange * 86_400_000);
  }

  const rawRows = await db.$queryRaw<RawRow[]>`
    SELECT
      p."variantId",
      p.title AS "productTitle",
      p."variantTitle",
      p.sku,
      p.vendor,
      p."productType",
      p."currentInventory" AS "currentStock",
      p.price::text AS price,
      SUM(s."unitsSold")::bigint AS "unitsSold",
      SUM(s.revenue::float)::text AS revenue
    FROM "SalesCache" s
    JOIN "ProductCache" p ON p."variantId" = s."variantId"
    WHERE s.date >= ${start} AND s.date <= ${now}
    GROUP BY p."variantId", p.title, p."variantTitle", p.sku, p.vendor, p."productType", p."currentInventory", p.price
  `;

  const rows: VariantVelocityRow[] = rawRows.map((r) => {
    const unitsSold = Number(r.unitsSold);
    const revenue = parseFloat(r.revenue);
    const avgDailySales = unitsSold / dayRange;
    const daysRemaining = avgDailySales > 0 ? Math.floor(r.currentStock / avgDailySales) : null;
    return {
      variantId: r.variantId,
      sku: r.sku ?? "",
      productTitle: r.productTitle,
      variantTitle: r.variantTitle,
      vendor: r.vendor ?? "",
      productType: r.productType ?? "",
      currentStock: r.currentStock,
      price: parseFloat(r.price) || 0,
      unitsSold,
      revenue,
      avgDailySales,
      daysRemaining,
    };
  });

  return { rows, dayRange };
}

// Exact-date-range units sold per variant, sourced directly from SalesCache —
// used for "compare to a historical period" (e.g. same window last year),
// independent of the rolling lookback periods above.
export async function getHistoricalUnitsSoldByVariant(
  variantIds: string[],
  from: Date,
  toExclusive: Date
): Promise<Map<string, number>> {
  if (variantIds.length === 0) return new Map();
  const db = getDb();
  const rows = await db.salesCache.groupBy({
    by: ["variantId"],
    where: { variantId: { in: variantIds }, date: { gte: from, lt: toExclusive } },
    _sum: { unitsSold: true },
  });
  console.log(
    `[reorder:historical] queried SalesCache for ${variantIds.length} variants, ` +
    `date >= ${from.toISOString().slice(0, 10)} AND date < ${toExclusive.toISOString().slice(0, 10)} ` +
    `(i.e. through ${new Date(toExclusive.getTime() - 86_400_000).toISOString().slice(0, 10)}) ` +
    `→ ${rows.length} variant(s) with matching SalesCache rows`
  );
  return new Map(rows.map((r) => [r.variantId, r._sum.unitsSold ?? 0]));
}

// Earliest/latest calendar date present in SalesCache — used to warn staff when
// a requested historical comparison window falls outside the data the
// background sync has actually collected.
export async function getSalesCacheDateRange(): Promise<{ min: Date | null; max: Date | null }> {
  const db = getDb();
  const range = await db.$queryRaw<{ min: Date | null; max: Date | null }[]>`
    SELECT MIN(date) as min, MAX(date) as max FROM "SalesCache"
  `;
  return { min: range[0]?.min ?? null, max: range[0]?.max ?? null };
}
