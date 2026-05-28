import Papa from "papaparse";
import { getDb } from "../db.server";
import type { InvoiceStatus } from "@prisma/client";

export interface POImportResult {
  imported: number;
  skipped: number;
  vendorsCreated: number;
  errors: { row: number; message: string }[];
}

function normalizeVendorName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, " ");
}

function parseBool(val: string | undefined): boolean {
  if (!val) return false;
  const v = val.trim().toLowerCase();
  return v === "true" || v === "yes" || v === "1";
}

function parseTotal(val: string | undefined): number {
  if (!val) return 0;
  return parseFloat(val.replace(/[$,]/g, "").trim()) || 0;
}

function parseDate(val: string | undefined): Date | null {
  if (!val || !val.trim()) return null;
  const d = new Date(val.trim());
  return isNaN(d.getTime()) ? null : d;
}

function mapStatus(
  archived: string | undefined,
  paid: string | undefined,
  received: string | undefined,
): InvoiceStatus {
  const isArchived = parseBool(archived);
  const isPaid = parseBool(paid);

  let fullyReceived = false;
  if (received && received.trim()) {
    const match = received.trim().match(/^(\d+)\s+of\s+(\d+)$/i);
    if (match) {
      const got = parseInt(match[1], 10);
      const total = parseInt(match[2], 10);
      fullyReceived = got > 0 && got === total;
    }
  }

  if ((isArchived && isPaid) || (fullyReceived && isPaid)) return "PAID";
  if (fullyReceived && !isPaid) return "RECEIVED";
  return "ORDERED";
}

export async function importPOsFromCSV(csvText: string): Promise<POImportResult> {
  const db = getDb();

  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  console.log("[po-import] PapaParse row count:", parsed.data.length);
  if (parsed.data.length > 0) {
    console.log("[po-import] first row keys:", Object.keys(parsed.data[0]));
    console.log("[po-import] first row values:", parsed.data[0]);
  }
  if (parsed.errors.length > 0) {
    console.log("[po-import] PapaParse errors:", parsed.errors);
  }

  const [existingVendors, existingInvoices] = await Promise.all([
    db.vendor.findMany({ select: { id: true, name: true } }),
    db.invoice.findMany({ select: { invoiceNumber: true } }),
  ]);

  const vendorByNorm = new Map(
    existingVendors.map((v) => [normalizeVendorName(v.name), v.id]),
  );
  const existingNumbers = new Set(
    existingInvoices.map((i) => i.invoiceNumber.toLowerCase()),
  );

  let imported = 0;
  let skipped = 0;
  let vendorsCreated = 0;
  const errors: { row: number; message: string }[] = [];

  for (let i = 0; i < parsed.data.length; i++) {
    const row = parsed.data[i];
    const rowNum = i + 2; // +1 for header, +1 for 1-based display

    try {
      const invoiceNumber =
        (row["Invoice No."] ?? "").trim() || (row["No."] ?? "").trim();
      if (!invoiceNumber) {
        errors.push({ row: rowNum, message: "No invoice number (Invoice No. and No. both empty)" });
        continue;
      }

      if (existingNumbers.has(invoiceNumber.toLowerCase())) {
        skipped++;
        continue;
      }

      const vendorNameRaw = (row["Vendor/Supplier"] ?? "").trim();
      if (!vendorNameRaw) {
        errors.push({ row: rowNum, message: `Invoice ${invoiceNumber}: missing vendor name` });
        continue;
      }

      const normName = normalizeVendorName(vendorNameRaw);
      let vendorId = vendorByNorm.get(normName);

      // Substring containment fuzzy match
      if (vendorId === undefined) {
        for (const [existing, id] of vendorByNorm.entries()) {
          if (existing.includes(normName) || normName.includes(existing)) {
            vendorId = id;
            break;
          }
        }
      }

      // Auto-create vendor if still not found
      if (vendorId === undefined) {
        const newVendor = await db.vendor.create({ data: { name: vendorNameRaw } });
        vendorId = newVendor.id;
        vendorByNorm.set(normName, vendorId);
        vendorsCreated++;
      }

      const status = mapStatus(row["Archived"], row["Paid"], row["Received"]);
      const total = parseTotal(row["Total Cost"]);
      const invoiceDate = parseDate(row["PO Date"]);
      const dueDate = parseDate(row["Payment Due"]);

      await db.invoice.create({
        data: {
          invoiceNumber,
          vendorId,
          status,
          invoiceDate,
          dueDate,
          total,
        },
      });

      existingNumbers.add(invoiceNumber.toLowerCase());
      imported++;
    } catch (err) {
      errors.push({
        row: rowNum,
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return { imported, skipped, vendorsCreated, errors };
}
