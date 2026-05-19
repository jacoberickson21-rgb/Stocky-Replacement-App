// WARNING: NEVER run this script against the production (Railway) database.
// It is for local development only. Running it against production will wipe
// and replace data if migrate reset is used.
//
// For production migrations, use: npx prisma migrate deploy
// To run this seed locally: npx prisma db seed
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const dbUrl = process.env.DATABASE_URL ?? "";
if (dbUrl.includes("rlwy.net") || dbUrl.includes("railway")) {
  throw new Error(
    "Refusing to run seed against production database. " +
    "This script is for local development only."
  );
}

const db = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

async function main() {
  const passwordHash = await bcrypt.hash("admin123", 10);

  const user = await db.user.upsert({
    where: { username: "jerickson" },
    update: {},
    create: {
      username: "jerickson",
      passwordHash,
      name: "Jacob Erickson",
    },
  });

  console.log(`Seeded user: ${user.username} (id: ${user.id})`);

  await db.appSetting.upsert({
    where: { key: "marginFloor" },
    update: {},
    create: { key: "marginFloor", value: "40" },
  });

  console.log("Seeded AppSetting: marginFloor = 40");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
