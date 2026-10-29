-- AlterTable
ALTER TABLE "Stocktake" ADD COLUMN     "applyHeartbeatAt" TIMESTAMP(3),
ADD COLUMN     "applyReason" TEXT,
ADD COLUMN     "applyTestResult" TEXT;

-- AlterTable
ALTER TABLE "StocktakeItem" ADD COLUMN     "applyStale" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "excludeReason" TEXT,
ADD COLUMN     "excludedAt" TIMESTAMP(3),
ADD COLUMN     "excludedById" INTEGER;

-- AddForeignKey
ALTER TABLE "StocktakeItem" ADD CONSTRAINT "StocktakeItem_excludedById_fkey" FOREIGN KEY ("excludedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

