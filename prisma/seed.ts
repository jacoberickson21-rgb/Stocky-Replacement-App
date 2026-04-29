import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

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
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
