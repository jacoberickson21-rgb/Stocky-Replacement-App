import re
from typing import Any

FIELD_CONFIDENCE_THRESHOLD = 0.70


def _method_baseline(method: str) -> float:
    return {"pdfplumber": 0.90, "camelot": 0.75, "ocr": 0.55}.get(method, 0.70)


def score_vendor_name(value: str | None, method: str) -> float:
    if not value or not value.strip():
        return 0.0
    base = _method_baseline(method)
    word_count = len(value.split())
    name_quality = min(1.0, 0.55 + word_count * 0.15)
    return round(min(1.0, base * name_quality), 3)


def score_invoice_number(value: str | None, method: str) -> float:
    if not value or not value.strip():
        return 0.0
    base = _method_baseline(method)
    has_alnum = bool(re.search(r"[A-Z0-9]{2,}", value.upper()))
    return round(min(1.0, base * (1.0 if has_alnum else 0.6)), 3)


def score_date(value: str | None, method: str) -> float:
    if not value or not value.strip():
        return 0.0
    base = _method_baseline(method)
    if re.match(r"^\d{4}-\d{2}-\d{2}$", value.strip()):
        return round(min(1.0, base), 3)
    return round(min(1.0, base * 0.5), 3)


def score_sku(value: str | None, method: str) -> float:
    if not value or not value.strip():
        return 0.45  # SKU is optional; missing is common and not catastrophic
    base = _method_baseline(method)
    has_pattern = bool(re.search(r"[A-Z0-9\-]{3,}", value.upper()))
    return round(min(1.0, base * (1.0 if has_pattern else 0.65)), 3)


def score_description(value: str | None, method: str) -> float:
    if not value or not value.strip():
        return 0.0
    base = _method_baseline(method)
    word_count = len(value.split())
    quality = min(1.0, 0.5 + word_count * 0.1)
    return round(min(1.0, base * quality), 3)


def score_quantity(value: Any, method: str) -> float:
    try:
        if int(value) > 0:
            return round(_method_baseline(method), 3)
    except (ValueError, TypeError):
        pass
    return 0.1


def score_unit_cost(value: Any, method: str) -> float:
    try:
        if float(value) >= 0:
            return round(_method_baseline(method), 3)
    except (ValueError, TypeError):
        pass
    return 0.1


def compute_overall_confidence(scores: list[float]) -> float:
    if not scores:
        return 0.0
    return round(sum(scores) / len(scores), 3)


def make_field(value: Any, confidence: float) -> dict:
    return {
        "value": value,
        "confidence": confidence,
        "flagged": confidence < FIELD_CONFIDENCE_THRESHOLD,
    }
