import type { ExtractionResult, ExtractedLineItem } from "./invoice-parser.server";

const PDF_PARSER_URL = process.env.PDF_PARSER_URL ?? "http://localhost:8000";

type PythonField<T> = { value: T; confidence: number; flagged: boolean };

type PythonParseResponse = {
  vendorName: PythonField<string>;
  invoiceNumber: PythonField<string>;
  invoiceDate: PythonField<string | null>;
  dueDate: PythonField<string | null>;
  lineItems: {
    sku: PythonField<string>;
    description: PythonField<string>;
    quantity: PythonField<number>;
    unitCost: PythonField<number>;
  }[];
  overallConfidence: number;
  requiresManualReview: boolean;
  vendorProfileFound: boolean;
  extractionMethod: string;
  rawTableData: Record<string, string>[] | null;
};

export type ExtendedExtractionResult = ExtractionResult & {
  invoiceDate: PythonField<string | null>;
  overallConfidence: number;
  requiresManualReview: boolean;
  vendorProfileFound: boolean;
  extractionMethod: string;
  rawTableData: Record<string, string>[] | null;
};

export async function callPdfParser(
  pdfBuffer: ArrayBuffer
): Promise<ExtendedExtractionResult> {
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([pdfBuffer], { type: "application/pdf" }),
    "invoice.pdf"
  );

  let response: Response;
  try {
    response = await fetch(`${PDF_PARSER_URL}/parse`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new Error(
      `Could not reach PDF parser service at ${PDF_PARSER_URL}. ` +
        `Is python-parser running? (${err instanceof Error ? err.message : err})`
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`PDF parser returned ${response.status}: ${text}`);
  }

  const parsed: PythonParseResponse = await response.json();

  return {
    vendorName: parsed.vendorName,
    invoiceNumber: parsed.invoiceNumber,
    invoiceDate: parsed.invoiceDate,
    dueDate: parsed.dueDate,
    lineItems: parsed.lineItems as ExtractedLineItem[],
    hasLowConfidence: parsed.requiresManualReview,
    overallConfidence: parsed.overallConfidence,
    requiresManualReview: parsed.requiresManualReview,
    vendorProfileFound: parsed.vendorProfileFound,
    extractionMethod: parsed.extractionMethod,
    rawTableData: parsed.rawTableData,
  };
}
