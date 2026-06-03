import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

async function main() {
  console.log('Adding "inventorySynced" column to InvoiceLineItem...');

  await db.$executeRawUnsafe(`
    ALTER TABLE "InvoiceLineItem"
    ADD COLUMN IF NOT EXISTS "inventorySynced" BOOLEAN NOT NULL DEFAULT false;
  `);

  console.log("Done. Run: npx prisma generate");
}

main()
  .catch(console.error)
  .finally(() => db.$disconnect());
