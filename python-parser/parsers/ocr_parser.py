import re

from parsers.pdfplumber_parser import (
    _find_date_near_label,
    _find_invoice_number,
    _find_vendor_name,
)


def extract_with_ocr(pdf_bytes: bytes) -> dict:
    """
    Extract invoice data from scanned PDFs via Tesseract OCR.
    Requires pdf2image (poppler) and pytesseract (tesseract-ocr).
    """
    result = {
        "vendorName": None,
        "invoiceNumber": None,
        "invoiceDate": None,
        "dueDate": None,
        "lineItems": [],
        "rawTableData": [],
        "method": "ocr",
    }

    try:
        from pdf2image import convert_from_bytes
        import pytesseract
    except ImportError:
        return result

    try:
        images = convert_from_bytes(pdf_bytes, dpi=300)
        if not images:
            return result

        pages_text = [
            pytesseract.image_to_string(img, config="--oem 3 --psm 6")
            for img in images
        ]
        all_text = "\n".join(pages_text)
        first_text = pages_text[0] if pages_text else ""

        result["vendorName"] = _find_vendor_name(first_text)
        result["invoiceNumber"] = _find_invoice_number(all_text)
        result["invoiceDate"] = _find_date_near_label(
            all_text, ["Invoice Date", "Invoice Dated", "Dated", "Date Issued"]
        )
        result["dueDate"] = _find_date_near_label(
            all_text, ["Due Date", "Payment Due", "Due By", "Net Due"]
        )
        result["lineItems"] = _parse_line_items_from_text(all_text)

    except Exception:
        pass

    return result


def _parse_line_items_from_text(text: str) -> list[dict]:
    """
    Heuristic line-item parser for OCR output.
    Looks for lines that contain a leading quantity and a trailing price.
    """
    items = []
    price_re = re.compile(r"\$?\s*(\d{1,6}(?:\.\d{2}))\s*$")
    qty_re = re.compile(r"^\s*(\d{1,4})\s+")

    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        price_m = price_re.search(line)
        qty_m = qty_re.match(line)
        if price_m and qty_m:
            qty = int(qty_m.group(1))
            cost = float(price_m.group(1))
            desc = line[qty_m.end() : price_m.start()].strip()
            if desc and cost > 0 and qty > 0:
                items.append({
                    "sku": "",
                    "description": desc,
                    "quantity": qty,
                    "unitCost": cost,
                })

    return items
