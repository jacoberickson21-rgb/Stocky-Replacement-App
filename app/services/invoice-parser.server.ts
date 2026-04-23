import Anthropic from "@anthropic-ai/sdk";

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
  dueDate: ExtractedField<string | null>;
  lineItems: ExtractedLineItem[];
  hasLowConfidence: boolean;
};

type RawExtracted = {
  vendorName: { value: string; confidence: number };
  invoiceNumber: { value: string; confidence: number };
  dueDate: { value: string | null; confidence: number };
  lineItems: {
    sku: { value: string; confidence: number };
    description: { value: string; confidence: number };
    quantity: { value: number; confidence: number };
    unitCost: { value: number; confidence: number };
  }[];
};

function flag<T>(field: { value: T; confidence: number }): ExtractedField<T> {
  return { ...field, flagged: field.confidence < CONFIDENCE_THRESHOLD };
}

export async function parsePdfInvoice(pdfBuffer: ArrayBuffer): Promise<ExtractionResult> {
  console.log("API key check:", {
    exists: !!process.env.ANTHROPIC_API_KEY,
    length: process.env.ANTHROPIC_API_KEY?.length ?? 0,
    prefix: process.env.ANTHROPIC_API_KEY?.substring(0, 10) ?? 'MISSING'
  });
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const base64Pdf = Buffer.from(pdfBuffer).toString("base64");

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8000,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: base64Pdf,
            },
          },
          {
            type: "text",
            text: `Extract the following fields from this invoice PDF and return ONLY a valid JSON object with no markdown formatting, no code fences, and no explanation text. The response must be parseable directly by JSON.parse().

Return this exact structure:
{
  "vendorName": { "value": "<vendor/supplier name>", "confidence": <0.0-1.0> },
  "invoiceNumber": { "value": "<invoice number>", "confidence": <0.0-1.0> },
  "dueDate": { "value": "<YYYY-MM-DD or null if not found>", "confidence": <0.0-1.0> },
  "lineItems": [
    {
      "sku": { "value": "<sku or item code>", "confidence": <0.0-1.0> },
      "description": { "value": "<item description>", "confidence": <0.0-1.0> },
      "quantity": { "value": <integer quantity>, "confidence": <0.0-1.0> },
      "unitCost": { "value": <decimal unit price>, "confidence": <0.0-1.0> }
    }
  ]
}

Confidence scoring rules:
- 1.0: field is clearly and unambiguously present in the document
- 0.85-0.99: field is present but required minor interpretation
- 0.5-0.84: field was inferred or partially legible — flag for manual review
- 0.0-0.49: field could not be reliably determined

If a field is not found, use an empty string for string fields or null for dueDate, with confidence 0.0.
For SKU: if no explicit SKU/item code exists, use the item number or a short identifier derived from the description.
For unitCost: extract the per-unit price, not the line total.`,
          },
        ],
      },
    ],
  });

  const rawText = message.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { type: "text"; text: string }).text)
    .join("");

  let raw: RawExtracted;
  try {
    raw = JSON.parse(rawText);
  } catch {
    throw new Error(
      `Claude returned malformed JSON — the response may have been truncated. ` +
      `Response length: ${rawText.length} chars. ` +
      `First 200 chars: ${rawText.substring(0, 200)}`
    );
  }

  const result: ExtractionResult = {
    vendorName: flag(raw.vendorName),
    invoiceNumber: flag(raw.invoiceNumber),
    dueDate: flag(raw.dueDate),
    lineItems: raw.lineItems.map((item) => ({
      sku: flag(item.sku),
      description: flag(item.description),
      quantity: flag(item.quantity),
      unitCost: flag(item.unitCost),
    })),
    hasLowConfidence: false,
  };

  result.hasLowConfidence =
    result.vendorName.flagged ||
    result.invoiceNumber.flagged ||
    result.dueDate.flagged ||
    result.lineItems.some(
      (item) =>
        item.sku.flagged ||
        item.description.flagged ||
        item.quantity.flagged ||
        item.unitCost.flagged
    );

  return result;
}
