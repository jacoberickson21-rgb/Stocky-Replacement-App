UPDATE "InvoiceLineItem" li
SET "vendorId" = i."vendorId"
FROM "Invoice" i
WHERE li."invoiceId" = i.id
  AND li."vendorId" IS NULL;
