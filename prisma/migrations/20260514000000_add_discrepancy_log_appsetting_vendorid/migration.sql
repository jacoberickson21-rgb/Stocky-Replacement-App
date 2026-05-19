-- AlterTable: add retailPrice and vendorId to InvoiceLineItem
ALTER TABLE "InvoiceLineItem" ADD COLUMN "retailPrice" DECIMAL(10,2),
ADD COLUMN "vendorId" INTEGER;

-- CreateTable: VendorProfile
CREATE TABLE "VendorProfile" (
    "id" TEXT NOT NULL,
    "vendorId" INTEGER NOT NULL,
    "columnMappings" JSONB NOT NULL,
    "extractionHints" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable: DiscrepancyLog
CREATE TABLE "DiscrepancyLog" (
    "id" SERIAL NOT NULL,
    "invoiceLineItemId" INTEGER NOT NULL,
    "invoiceId" INTEGER NOT NULL,
    "vendorId" INTEGER NOT NULL,
    "sku" TEXT,
    "expectedQty" INTEGER NOT NULL,
    "actualQty" INTEGER NOT NULL,
    "note" TEXT,
    "staffId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscrepancyLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable: AppSetting
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "VendorProfile_vendorId_key" ON "VendorProfile"("vendorId");

-- AddForeignKey
ALTER TABLE "VendorProfile" ADD CONSTRAINT "VendorProfile_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLineItem" ADD CONSTRAINT "InvoiceLineItem_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscrepancyLog" ADD CONSTRAINT "DiscrepancyLog_invoiceLineItemId_fkey" FOREIGN KEY ("invoiceLineItemId") REFERENCES "InvoiceLineItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscrepancyLog" ADD CONSTRAINT "DiscrepancyLog_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscrepancyLog" ADD CONSTRAINT "DiscrepancyLog_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscrepancyLog" ADD CONSTRAINT "DiscrepancyLog_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: populate vendorId on existing InvoiceLineItem rows from parent Invoice
UPDATE "InvoiceLineItem" li
SET "vendorId" = i."vendorId"
FROM "Invoice" i
WHERE li."invoiceId" = i.id
  AND li."vendorId" IS NULL;
