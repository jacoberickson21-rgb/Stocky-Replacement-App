-- AlterTable
ALTER TABLE "StocktakeScan" ADD COLUMN     "batchId" TEXT;

-- CreateIndex
CREATE INDEX "StocktakeScan_stocktakeId_batchId_idx" ON "StocktakeScan"("stocktakeId", "batchId");

