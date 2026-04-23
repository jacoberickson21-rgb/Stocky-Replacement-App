import { PrismaClient } from "@prisma/client";

console.log("DB DEBUG:", {
  DATABASE_URL_EXISTS: !!process.env.DATABASE_URL,
  DATABASE_URL_LENGTH: process.env.DATABASE_URL?.length ?? 0,
  ALL_ENV_KEYS: Object.keys(process.env).filter(
    (k) => k.includes("DATABASE") || k.includes("POSTGRES") || k.includes("PG")
  ),
});

let prisma: PrismaClient | undefined;

export function getDb(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
  }
  return prisma;
}
