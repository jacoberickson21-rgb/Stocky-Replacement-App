import { PrismaClient } from "@prisma/client";

let prisma: PrismaClient | undefined;

export function getDb(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
  }
  return prisma;
}
