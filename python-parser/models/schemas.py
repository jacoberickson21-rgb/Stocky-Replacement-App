from typing import Any, List, Optional

from pydantic import BaseModel


class ExtractedField(BaseModel):
    value: Any
    confidence: float
    flagged: bool


class ExtractedLineItem(BaseModel):
    sku: ExtractedField
    description: ExtractedField
    quantity: ExtractedField
    unitCost: ExtractedField


class ParseResponse(BaseModel):
    vendorName: ExtractedField
    invoiceNumber: ExtractedField
    invoiceDate: ExtractedField
    dueDate: ExtractedField
    lineItems: List[ExtractedLineItem]
    overallConfidence: float
    requiresManualReview: bool
    vendorProfileFound: bool
    extractionMethod: str
    # Only populated when requiresManualReview is True so the UI can show column mapping.
    rawTableData: Optional[List[dict]] = None


class HealthResponse(BaseModel):
    status: str
    version: str
