import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { getVendors } from "../app/services/shopify.server";

const db = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

async function main() {
  console.log("Fetching vendors from Shopify...");
  const shopifyVendors = await getVendors();
  console.log(`Found ${shopifyVendors.length} vendors in Shopify.`);

  let created = 0;
  let skipped = 0;

  for (const vendorName of shopifyVendors) {
    const existing = await db.vendor.findFirst({
      where: {
        OR: [
          { shopifyVendorName: vendorName },
          { name: vendorName },
        ],
      },
    });

    if (existing) {
      console.log(`  SKIP  ${vendorName}`);
      skipped++;
    } else {
      await db.vendor.create({
        data: {
          name: vendorName,
          shopifyVendorName: vendorName,
        },
      });
      console.log(`  CREATE ${vendorName}`);
      created++;
    }
  }

  console.log(`\nDone. Created: ${created}, Skipped: ${skipped}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
