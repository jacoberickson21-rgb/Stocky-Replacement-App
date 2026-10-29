-- CreateEnum
CREATE TYPE "StocktakeMode" AS ENUM ('SCOPED', 'FREE_SCAN');

-- CreateEnum
CREATE TYPE "StocktakeStatus" AS ENUM ('PREPARING', 'IN_PROGRESS', 'REVIEW', 'APPLYING', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StocktakeDriftResolution" AS ENUM ('KEEP_COUNT', 'ADJUST_FOR_MOVEMENT', 'SKIP');

-- CreateEnum
CREATE TYPE "StocktakeScanKind" AS ENUM ('SCAN', 'MANUAL_SET', 'LINKED');

-- AlterTable
ALTER TABLE "ProductCache" ADD COLUMN     "tracked" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "Stocktake" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "mode" "StocktakeMode" NOT NULL,
    "filters" JSONB,
    "status" "StocktakeStatus" NOT NULL DEFAULT 'PREPARING',
    "locationId" TEXT NOT NULL,
    "zeroUnscanned" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "startedById" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedById" INTEGER,
    "completedAt" TIMESTAMP(3),
    "snapshotTotal" INTEGER,
    "snapshotDone" INTEGER,
    "applyTotal" INTEGER,
    "applyDone" INTEGER,
    "applyStartedAt" TIMESTAMP(3),
    "applyEndedAt" TIMESTAMP(3),
    "applyError" TEXT,
    "applyAttempt" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Stocktake_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StocktakeItem" (
    "id" SERIAL NOT NULL,
    "stocktakeId" INTEGER NOT NULL,
    "variantId" TEXT NOT NULL,
    "productId" TEXT,
    "inventoryItemId" TEXT NOT NULL,
    "sku" TEXT,
    "barcode" TEXT,
    "title" TEXT NOT NULL,
    "variantTitle" TEXT NOT NULL,
    "vendor" TEXT,
    "expectedQty" INTEGER NOT NULL,
    "countedQty" INTEGER,
    "cost" DECIMAL(10,2),
    "outsideScope" BOOLEAN NOT NULL DEFAULT false,
    "liveQtyAtReview" INTEGER,
    "liveAvailableAtReview" INTEGER,
    "drifted" BOOLEAN NOT NULL DEFAULT false,
    "driftResolution" "StocktakeDriftResolution",
    "targetQty" INTEGER,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "appliedAt" TIMESTAMP(3),
    "applyError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StocktakeItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StocktakeScan" (
    "id" SERIAL NOT NULL,
    "stocktakeId" INTEGER NOT NULL,
    "itemId" INTEGER NOT NULL,
    "kind" "StocktakeScanKind" NOT NULL DEFAULT 'SCAN',
    "barcode" TEXT,
    "qtyBefore" INTEGER,
    "qtyAfter" INTEGER NOT NULL,
    "scannedById" INTEGER NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" TIMESTAMP(3),

    CONSTRAINT "StocktakeScan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StocktakeUnknownBarcode" (
    "id" SERIAL NOT NULL,
    "stocktakeId" INTEGER NOT NULL,
    "barcode" TEXT NOT NULL,
    "scanCount" INTEGER NOT NULL DEFAULT 1,
    "lastScannedById" INTEGER,
    "lastScannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedItemId" INTEGER,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "StocktakeUnknownBarcode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Stocktake_status_idx" ON "Stocktake"("status");

-- CreateIndex
CREATE INDEX "Stocktake_startedAt_idx" ON "Stocktake"("startedAt");

-- CreateIndex
CREATE INDEX "StocktakeItem_stocktakeId_barcode_idx" ON "StocktakeItem"("stocktakeId", "barcode");

-- CreateIndex
CREATE INDEX "StocktakeItem_stocktakeId_sku_idx" ON "StocktakeItem"("stocktakeId", "sku");

-- CreateIndex
CREATE INDEX "StocktakeItem_stocktakeId_applied_idx" ON "StocktakeItem"("stocktakeId", "applied");

-- CreateIndex
CREATE UNIQUE INDEX "StocktakeItem_stocktakeId_variantId_key" ON "StocktakeItem"("stocktakeId", "variantId");

-- CreateIndex
CREATE INDEX "StocktakeScan_stocktakeId_scannedById_scannedAt_idx" ON "StocktakeScan"("stocktakeId", "scannedById", "scannedAt");

-- CreateIndex
CREATE INDEX "StocktakeScan_itemId_idx" ON "StocktakeScan"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "StocktakeUnknownBarcode_stocktakeId_barcode_key" ON "StocktakeUnknownBarcode"("stocktakeId", "barcode");

-- AddForeignKey
ALTER TABLE "Stocktake" ADD CONSTRAINT "Stocktake_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stocktake" ADD CONSTRAINT "Stocktake_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StocktakeItem" ADD CONSTRAINT "StocktakeItem_stocktakeId_fkey" FOREIGN KEY ("stocktakeId") REFERENCES "Stocktake"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StocktakeScan" ADD CONSTRAINT "StocktakeScan_stocktakeId_fkey" FOREIGN KEY ("stocktakeId") REFERENCES "Stocktake"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StocktakeScan" ADD CONSTRAINT "StocktakeScan_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "StocktakeItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StocktakeScan" ADD CONSTRAINT "StocktakeScan_scannedById_fkey" FOREIGN KEY ("scannedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StocktakeUnknownBarcode" ADD CONSTRAINT "StocktakeUnknownBarcode_stocktakeId_fkey" FOREIGN KEY ("stocktakeId") REFERENCES "Stocktake"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StocktakeUnknownBarcode" ADD CONSTRAINT "StocktakeUnknownBarcode_lastScannedById_fkey" FOREIGN KEY ("lastScannedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StocktakeUnknownBarcode" ADD CONSTRAINT "StocktakeUnknownBarcode_resolvedItemId_fkey" FOREIGN KEY ("resolvedItemId") REFERENCES "StocktakeItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

