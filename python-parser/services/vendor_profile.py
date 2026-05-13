import re
from difflib import SequenceMatcher
from typing import Optional, Tuple

FUZZY_THRESHOLD = 0.85


def _fuzzy_match(name: str, candidates: list) -> Tuple[Optional[object], float]:
    name_lower = name.lower().strip()
    best_vendor, best_ratio = None, 0.0
    for vendor in candidates:
        ratio = SequenceMatcher(None, name_lower, vendor.name.lower().strip()).ratio()
        if ratio > best_ratio:
            best_ratio = ratio
            best_vendor = vendor
    if best_ratio >= FUZZY_THRESHOLD:
        return best_vendor, best_ratio
    return None, best_ratio


def get_profile_for_vendor(vendor_name: str) -> Optional[dict]:
    """
    Look up a VendorProfile by fuzzy vendor name match.
    Returns None if DATABASE_URL is unset or no matching profile exists.
    """
    from db.database import SessionLocal, Vendor, VendorProfile

    if SessionLocal is None:
        return None

    db = SessionLocal()
    try:
        vendors = db.query(Vendor).all()
        matched, ratio = _fuzzy_match(vendor_name, vendors)
        if not matched:
            return None

        profile = (
            db.query(VendorProfile)
            .filter(VendorProfile.vendorId == matched.id)
            .first()
        )
        if not profile:
            return None

        return {
            "vendorId": profile.vendorId,
            "columnMappings": profile.columnMappings,
            "extractionHints": profile.extractionHints,
            "matchRatio": ratio,
        }
    finally:
        db.close()


def apply_profile_to_raw_data(raw_rows: list[dict], profile: dict) -> list[dict]:
    """Apply saved column mappings to raw table rows to produce line items."""
    mappings = profile.get("columnMappings", {})
    sku_col = mappings.get("sku")
    desc_col = mappings.get("description")
    qty_col = mappings.get("quantity")
    cost_col = mappings.get("unitCost")

    if not desc_col:
        return []

    items = []
    for row in raw_rows:
        desc = row.get(desc_col, "").strip()
        if not desc:
            continue

        raw_qty = row.get(qty_col, "1") if qty_col else "1"
        raw_cost = row.get(cost_col, "0") if cost_col else "0"

        try:
            qty = int(re.sub(r"[^\d]", "", str(raw_qty)) or "1") or 1
        except (ValueError, AttributeError):
            qty = 1

        try:
            cost = float(re.sub(r"[^\d.]", "", str(raw_cost)) or "0") or 0.0
        except (ValueError, AttributeError):
            cost = 0.0

        items.append({
            "sku": row.get(sku_col, "") if sku_col else "",
            "description": desc,
            "quantity": qty,
            "unitCost": cost,
        })

    return items
