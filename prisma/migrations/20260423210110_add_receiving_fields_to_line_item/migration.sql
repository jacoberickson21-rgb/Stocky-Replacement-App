-- AlterTable
ALTER TABLE "InvoiceLineItem" ADD COLUMN     "hasDiscrepancy" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "receivingNote" TEXT;
