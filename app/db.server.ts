import { PrismaClient } from "@prisma/client";

let prisma: PrismaClient | undefined;

export function getDb(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient();
  }
  return prisma;
}
