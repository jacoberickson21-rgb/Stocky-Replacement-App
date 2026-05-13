from parsers.pdfplumber_parser import extract_with_pdfplumber
from parsers.camelot_parser import extract_with_camelot
from parsers.ocr_parser import extract_with_ocr
from services.confidence import (
    FIELD_CONFIDENCE_THRESHOLD,
    compute_overall_confidence,
    make_field,
    score_date,
    score_description,
    score_invoice_number,
    score_quantity,
    score_sku,
    score_unit_cost,
    score_vendor_name,
)
from services.vendor_profile import apply_profile_to_raw_data, get_profile_for_vendor


def _merge_headers(primary: dict, fallback: dict) -> dict:
    """Carry header text fields from fallback when primary is empty."""
    for key in ("vendorName", "invoiceNumber", "invoiceDate", "dueDate"):
        if not primary.get(key):
            primary[key] = fallback.get(key)
    return primary


def _build_response(extracted: dict, profile: dict | None = None) -> dict:
    method = extracted["method"]

    line_items_data = extracted.get("lineItems") or []
    if profile and extracted.get("rawTableData"):
        profile_items = apply_profile_to_raw_data(extracted["rawTableData"], profile)
        if profile_items:
            line_items_data = profile_items

    vendor_val = extracted.get("vendorName") or ""
    inv_num_val = extracted.get("invoiceNumber") or ""
    inv_date_val = extracted.get("invoiceDate") or None
    due_date_val = extracted.get("dueDate") or None

    vendor_conf = score_vendor_name(vendor_val, method)
    inv_conf = score_invoice_number(inv_num_val, method)
    inv_date_conf = score_date(inv_date_val, method) if inv_date_val else 0.0
    # A missing due date is common — don't tank the score, just note it as low.
    due_date_conf = score_date(due_date_val, method) if due_date_val else 0.3

    scored_items = []
    item_scores: list[float] = []
    for item in line_items_data:
        sku_c = score_sku(item.get("sku"), method)
        desc_c = score_description(item.get("description"), method)
        qty_c = score_quantity(item.get("quantity"), method)
        cost_c = score_unit_cost(item.get("unitCost"), method)
        scored_items.append({
            "sku": make_field(item.get("sku", ""), sku_c),
            "description": make_field(item.get("description", ""), desc_c),
            "quantity": make_field(item.get("quantity", 0), qty_c),
            "unitCost": make_field(item.get("unitCost", 0.0), cost_c),
        })
        item_scores.extend([sku_c, desc_c, qty_c, cost_c])

    header_scores = [vendor_conf, inv_conf]
    if inv_date_val:
        header_scores.append(inv_date_conf)

    overall = compute_overall_confidence(header_scores + item_scores)

    # Hard cap: missing vendor, invoice number, or all line items is a failure.
    if not vendor_val or not inv_num_val or not line_items_data:
        overall = min(overall, 0.50)

    requires_review = overall < FIELD_CONFIDENCE_THRESHOLD

    return {
        "vendorName": make_field(vendor_val, vendor_conf),
        "invoiceNumber": make_field(inv_num_val, inv_conf),
        "invoiceDate": make_field(inv_date_val, inv_date_conf),
        "dueDate": make_field(due_date_val, due_date_conf),
        "lineItems": scored_items,
        "overallConfidence": overall,
        "requiresManualReview": requires_review,
        "vendorProfileFound": profile is not None,
        "extractionMethod": method,
        # Return raw table data only when review is needed so the UI can offer column mapping.
        "rawTableData": extracted.get("rawTableData") if requires_review else None,
    }


def extract_invoice(pdf_bytes: bytes) -> dict:
    """
    Three-stage extraction pipeline.
    Stage 1 — pdfplumber (native text/tables).
    Stage 2 — Camelot (complex table layouts), when stage 1 confidence is low.
    Stage 3 — Tesseract OCR, when stages 1 & 2 are both low confidence.
    Header fields (vendor, invoice #, dates) are always sourced from pdfplumber
    because it reads text more reliably; table parsers fill in line items.
    """
    # Stage 1
    plumber_raw = extract_with_pdfplumber(pdf_bytes)
    vendor_name = plumber_raw.get("vendorName") or ""
    profile = get_profile_for_vendor(vendor_name) if vendor_name else None

    response = _build_response(plumber_raw, profile)

    if response["overallConfidence"] >= FIELD_CONFIDENCE_THRESHOLD:
        return response

    # Stage 2 — Camelot
    camelot_raw = extract_with_camelot(pdf_bytes)
    if camelot_raw.get("lineItems") or camelot_raw.get("rawTableData"):
        camelot_raw = _merge_headers(camelot_raw, plumber_raw)
        camelot_response = _build_response(camelot_raw, profile)
        if camelot_response["overallConfidence"] > response["overallConfidence"]:
            response = camelot_response

    if response["overallConfidence"] >= FIELD_CONFIDENCE_THRESHOLD:
        return response

    # Stage 3 — OCR
    ocr_raw = extract_with_ocr(pdf_bytes)
    if ocr_raw.get("lineItems") or ocr_raw.get("vendorName"):
        ocr_raw = _merge_headers(ocr_raw, plumber_raw)
        ocr_response = _build_response(ocr_raw, profile)
        if ocr_response["overallConfidence"] > response["overallConfidence"]:
            response = ocr_response

    return response
