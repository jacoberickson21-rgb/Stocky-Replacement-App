// DORMANT — replaced by the python-parser microservice (python-parser/).
// The Claude API call below is intentionally disabled and never invoked.
// Active PDF parsing goes through app/services/pdf-parser-client.server.ts.
// Types are kept here because invoices.upload.tsx imports them.

// import Anthropic from "@anthropic-ai/sdk"; // dormant

const CONFIDENCE_THRESHOLD = 0.85;

export type ExtractedField<T> = {
  value: T;
  confidence: number;
  flagged: boolean;
};

export type ExtractedLineItem = {
  sku: ExtractedField<string>;
  description: ExtractedField<string>;
  quantity: ExtractedField<number>;
  unitCost: ExtractedField<number>;
};

export type ExtractionResult = {
  vendorName: ExtractedField<string>;
  invoiceNumber: ExtractedField<string>;
  invoiceDate?: ExtractedField<string | null>;
  dueDate: ExtractedField<string | null>;
  lineItems: ExtractedLineItem[];
  hasLowConfidence: boolean;
};

// Kept so callers do not need to change imports, but always throws.
export async function parsePdfInvoice(_pdfBuffer: ArrayBuffer): Promise<ExtractionResult> {
  throw new Error(
    "parsePdfInvoice is dormant. Use callPdfParser from pdf-parser-client.server.ts instead."
  );
}

// ── Original Claude implementation (dormant) ─────────────────────────────────
//
// type RawExtracted = { ... };
//
// function flag<T>(field: { value: T; confidence: number }): ExtractedField<T> {
//   return { ...field, flagged: field.confidence < CONFIDENCE_THRESHOLD };
// }
//
// export async function parsePdfInvoice(pdfBuffer: ArrayBuffer) {
//   const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
//   const base64Pdf = Buffer.from(pdfBuffer).toString("base64");
//   const message = await client.messages.create({ ... });
//   ...
// }
