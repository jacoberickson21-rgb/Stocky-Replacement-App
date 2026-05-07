-- AlterTable
ALTER TABLE "InvoiceLineItem" ADD COLUMN "shopifyProductTitle" TEXT;
ALTER TABLE "InvoiceLineItem" ADD COLUMN "shopifyVariantId" TEXT;
ALTER TABLE "InvoiceLineItem" ADD COLUMN "shopifyInventoryItemId" TEXT;
