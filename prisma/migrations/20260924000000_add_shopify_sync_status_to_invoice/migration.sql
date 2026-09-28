-- CreateEnum
CREATE TYPE "ShopifySyncStatus" AS ENUM ('SYNCING', 'SYNCED', 'FAILED');

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "shopifySyncStatus" "ShopifySyncStatus",
ADD COLUMN     "shopifySyncStartedAt" TIMESTAMP(3),
ADD COLUMN     "shopifySyncEndedAt" TIMESTAMP(3),
ADD COLUMN     "shopifySyncError" TEXT;
