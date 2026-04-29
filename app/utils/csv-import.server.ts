import Papa from "papaparse";
import { getDb } from "../db.server";

export interface ImportResult {
  created: number;
  skipped: number;
  errors: { row: number; message: string }[];
}

export async function importVendorsFromCSV(csvText: string): Promise<ImportResult> {
  const db = getDb();
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, "_"),
  });

  const [existingVendors, existingSuppliers] = await Promise.all([
    db.vendor.findMany({ select: { name: true } }),
    db.supplier.findMany({ select: { id: true, name: true } }),
  ]);

  const seenNames = new Set(existingVendors.map((v) => v.name.toLowerCase()));
  const supplierByName = new Map(existingSuppliers.map((s) => [s.name.toLowerCase(), s.id]));

  let skipped = 0;
  const errors: { row: number; message: string }[] = [];
  const toCreate: Array<{
    name: string;
    contactName: string | null;
    email: string | null;
    phone: string | null;
    supplierId: number | null;
  }> = [];

  for (let i = 0; i < parsed.data.length; i++) {
    const row = parsed.data[i];
    const rowNum = i + 2; // +1 for header, +1 for 1-based
    const name = (row["name"] ?? "").trim();

    if (!name) {
      errors.push({ row: rowNum, message: 'Missing required field "name"' });
      continue;
    }

    if (seenNames.has(name.toLowerCase())) {
      skipped++;
      continue;
    }

    seenNames.add(name.toLowerCase());

    const supplierName = (row["supplier_name"] ?? "").trim();
    const supplierId = supplierName
      ? (supplierByName.get(supplierName.toLowerCase()) ?? null)
      : null;

    toCreate.push({
      name,
      contactName: (row["contact_name"] ?? "").trim() || null,
      email: (row["email"] ?? "").trim() || null,
      phone: (row["phone"] ?? "").trim() || null,
      supplierId,
    });
  }

  if (toCreate.length > 0) {
    await db.vendor.createMany({ data: toCreate });
  }

  return { created: toCreate.length, skipped, errors };
}

export async function importSuppliersFromCSV(csvText: string): Promise<ImportResult> {
  const db = getDb();
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, "_"),
  });

  const existingSuppliers = await db.supplier.findMany({ select: { name: true } });
  const seenNames = new Set(existingSuppliers.map((s) => s.name.toLowerCase()));

  let skipped = 0;
  const errors: { row: number; message: string }[] = [];
  const toCreate: Array<{
    name: string;
    contactName: string | null;
    email: string | null;
    phone: string | null;
  }> = [];

  for (let i = 0; i < parsed.data.length; i++) {
    const row = parsed.data[i];
    const rowNum = i + 2;
    const name = (row["name"] ?? "").trim();

    if (!name) {
      errors.push({ row: rowNum, message: 'Missing required field "name"' });
      continue;
    }

    if (seenNames.has(name.toLowerCase())) {
      skipped++;
      continue;
    }

    seenNames.add(name.toLowerCase());

    toCreate.push({
      name,
      contactName: (row["contact_name"] ?? "").trim() || null,
      email: (row["email"] ?? "").trim() || null,
      phone: (row["phone"] ?? "").trim() || null,
    });
  }

  if (toCreate.length > 0) {
    await db.supplier.createMany({ data: toCreate });
  }

  return { created: toCreate.length, skipped, errors };
}
