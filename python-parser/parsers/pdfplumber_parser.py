import re
from collections import defaultdict
from io import BytesIO
from typing import Optional

import pdfplumber

# ── Date helpers ──────────────────────────────────────────────────────────────

_MONTH_MAP = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
    "january": 1, "february": 2, "march": 3, "april": 4,
    "june": 6, "july": 7, "august": 8, "september": 9,
    "october": 10, "november": 11, "december": 12,
}


def normalize_date(raw: str) -> Optional[str]:
    """Convert various date formats to YYYY-MM-DD. Returns None on failure."""
    raw = raw.strip()

    if re.match(r"^\d{4}-\d{2}-\d{2}$", raw):
        return raw

    m = re.match(r"^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$", raw)
    if m:
        mo, dy, yr = int(m.group(1)), int(m.group(2)), int(m.group(3))
        try:
            from datetime import date
            return date(yr, mo, dy).isoformat()
        except ValueError:
            pass

    m = re.match(r"^(\w+)\s+(\d{1,2}),?\s+(\d{4})$", raw)
    if m:
        month_num = _MONTH_MAP.get(m.group(1).lower())
        if month_num:
            try:
                from datetime import date
                return date(int(m.group(3)), month_num, int(m.group(2))).isoformat()
            except ValueError:
                pass

    return None


def _find_date_near_label(text: str, labels: list[str]) -> Optional[str]:
    date_pat = (
        r"(\d{1,2}[/\-]\d{1,2}[/\-]\d{4}"
        r"|\d{4}[/\-]\d{2}[/\-]\d{2}"
        r"|\w+\s+\d{1,2},?\s+\d{4})"
    )
    for label in labels:
        pattern = re.compile(
            rf"{re.escape(label)}\s*:?\s*{date_pat}", re.IGNORECASE
        )
        m = pattern.search(text)
        if m:
            normalized = normalize_date(m.group(1))
            if normalized:
                return normalized
    return None


def _find_invoice_number(text: str) -> Optional[str]:
    labels = [
        r"Invoice\s*#", r"Invoice\s+Number", r"Invoice\s+No\.?",
        r"Inv\.?\s*#", r"PO\s*#", r"Order\s*#", r"Order\s+Number",
    ]
    for label in labels:
        m = re.search(rf"{label}\s*:?\s*([A-Z0-9][A-Z0-9\-_/\.{{}}]+)", text, re.IGNORECASE)
        if m:
            return m.group(1).strip()
    return None


def _find_vendor_name(text: str) -> Optional[str]:
    skip = {"invoice", "purchase order", "bill", "receipt", "statement", "packing slip", "page"}
    lines = [l.strip() for l in text.strip().split("\n") if l.strip()]
    for line in lines[:8]:
        if line.lower() not in skip and len(line) > 3 and not re.match(r"^\d", line):
            return line
    return lines[0] if lines else None


# ── Table extraction helpers ─────────────────────────────────────────────────

# "text" strategy for borderless invoice tables.
_TEXT_TABLE_SETTINGS = {
    "vertical_strategy": "text",
    "horizontal_strategy": "text",
    "snap_tolerance": 5,
    "join_tolerance": 5,
    "edge_min_length": 10,
}


def _headers_look_merged(headers: list[str]) -> bool:
    non_empty = [h for h in headers if h and h.strip()]
    if len(non_empty) != 1:
        return False
    return len(non_empty[0].split()) >= 3


def _split_merged_header(headers: list[str], data_rows: list[list]) -> list[str]:
    merged = next((h for h in headers if h and h.strip()), "")
    tokens = merged.split()
    if not tokens:
        return headers

    col_counts = [
        sum(1 for c in row if c is not None and str(c).strip())
        for row in data_rows
        if row
    ]
    data_col_count = max(col_counts, default=0)

    if data_col_count >= 2 and len(tokens) == data_col_count:
        return tokens

    return tokens


def _extract_page_tables(page) -> list[list[list]]:
    tables = page.extract_tables() or []

    needs_retry = any(
        table and table[0]
        and _headers_look_merged([str(c or "").strip() for c in table[0]])
        for table in tables
    )

    if needs_retry:
        try:
            text_tables = page.extract_tables(table_settings=_TEXT_TABLE_SETTINGS) or []
            if text_tables:
                def _distinct_headers(tlist):
                    return sum(
                        len([c for c in t[0] if c and str(c).strip()])
                        for t in tlist if t and t[0]
                    )
                if _distinct_headers(text_tables) > _distinct_headers(tables):
                    return text_tables
        except Exception:
            pass

    return tables


# ── Table scoring ────────────────────────────────────────────────────────────

_LINE_ITEM_KEYWORDS = [
    "item", "sku", "part", "product", "code",
    "description", "desc",
    "qty", "quantity", "ordered", "order", "ship",
    "price", "cost", "unit", "net", "amount",
    "b/o", "bo",
]

_ADDRESS_KEYWORDS = [
    "bill to", "ship to", "sold to", "deliver to",
    "address", "attn", "attention", "fax", "phone", "email",
]

_NUMERIC_RE = re.compile(r"^\$?\s*[\d,]+\.?\d*$")


def _score_table_as_line_items(headers: list[str], data_rows: list[list]) -> float:
    score = 0.0
    header_text = " ".join(h.lower() for h in headers if h)

    for kw in _ADDRESS_KEYWORDS:
        if kw in header_text:
            score -= 20.0

    for kw in _LINE_ITEM_KEYWORDS:
        if kw in header_text:
            score += 5.0

    score += min(len(data_rows) * 2.0, 20.0)

    populated_cols = len([h for h in headers if h])
    if 3 <= populated_cols <= 12:
        score += 5.0

    sample = data_rows[:8]
    numeric, total = 0, 0
    for row in sample:
        for cell in row:
            val = str(cell or "").strip()
            if val:
                total += 1
                if _NUMERIC_RE.match(val):
                    numeric += 1
    if total > 0:
        score += (numeric / total) * 10.0

    return score


# ── Word-position extraction for borderless / colored-background tables ───────

# Keyword pairs that together identify a line-items header row.
_WP_HEADER_PATTERNS = [
    ["product", "description"],
    ["item", "description"],
    ["sku", "description"],
    ["description", "qty"],
    ["description", "quantity"],
    ["description", "price"],
    ["description", "unit"],
]

_WP_TOTALS_RE = re.compile(r"\btotal(s)?\b|\bsubtotal\b|^={3,}$", re.IGNORECASE)

# Rows within this many pts of the anchor row y are part of the same header band.
_HEADER_Y_WINDOW = 20  # pts
# Header-band words within this horizontal distance merge into the same column name.
_HEADER_X_SNAP = 15    # pts
# A data word can land this far left of its column's x-start and still be assigned there.
_X_SNAP = 12           # pts


def _group_words_into_rows(words: list[dict], y_snap: int = 4) -> list[list[dict]]:
    """Group pdfplumber word dicts into rows by snapped top y-position."""
    buckets: dict[int, list] = defaultdict(list)
    for w in words:
        key = round(w["top"] / y_snap) * y_snap
        buckets[key].append(w)
    return [
        sorted(buckets[y], key=lambda w: w["x0"])
        for y in sorted(buckets.keys())
    ]


def _assign_col(x0: float, col_x_starts: list[float]) -> int:
    """Return the rightmost column whose x_start is ≤ x0 + X_SNAP."""
    best = 0
    for j, xs in enumerate(col_x_starts):
        if x0 >= xs - _X_SNAP:
            best = j
    return best


def _extract_by_word_positions(page) -> Optional[dict]:
    """
    Positional table extraction for borderless / colored-background tables.

    1. Find the anchor row — the first row matching a header keyword pair
       (e.g. contains both "description" and "qty").
    2. Collect the header band: every row whose y-coordinate falls within
       _HEADER_Y_WINDOW pts of the anchor row (above OR below).
    3. Process band rows top-to-bottom.  Each word either merges into an
       existing column (nearest x within _HEADER_X_SNAP) or starts a new one.
       This combines split-row headers such as "Order" (row above) + "Qty"
       (anchor row) → "Order Qty" by x-position proximity.
    4. Walk data rows below the band, assigning each word to the nearest
       column bucket, until a totals/end-of-table marker is found.

    Returns {"headers": [str, ...], "data_rows": [{col: val}, ...]} or None.
    """
    words = page.extract_words(keep_blank_chars=False, x_tolerance=3, y_tolerance=3)
    if not words:
        return None

    sorted_rows = _group_words_into_rows(words)

    # ── Find the anchor row (first row matching a header keyword pair) ────
    header_idx: Optional[int] = None
    for i, row in enumerate(sorted_rows):
        row_lower = " ".join(w["text"].lower() for w in row)
        for anchors in _WP_HEADER_PATTERNS:
            if all(a in row_lower for a in anchors):
                header_idx = i
                break
        if header_idx is not None:
            break

    if header_idx is None:
        return None

    anchor_y = min(w["top"] for w in sorted_rows[header_idx])

    # ── Collect the header band: all rows within HEADER_Y_WINDOW of anchor ──
    # Handles invoices where the header spans two rows, with one row above
    # (e.g. "Order B/O Ship Unit Net") and the anchor row below
    # (e.g. "Product Description Qty Qty Qty Price Disc% Price Amount").
    band: list[tuple[int, list]] = []
    for i, row in enumerate(sorted_rows):
        if not row:
            continue
        row_y = min(w["top"] for w in row)
        if abs(row_y - anchor_y) <= _HEADER_Y_WINDOW:
            band.append((i, row))
    band.sort(key=lambda x: min(w["top"] for w in x[1]))  # top → bottom

    data_start = max(idx for idx, _ in band) + 1

    # Debug: dump every word in the header band.
    print(
        f"[pdfplumber:word-pos] {len(band)} header band row(s) "
        f"(anchor y≈{anchor_y:.1f}, window=±{_HEADER_Y_WINDOW}):"
    )
    for ri, (idx, row) in enumerate(band):
        print(f"  band_row[{ri}] sorted_rows[{idx}] — {len(row)} word(s):")
        for w in row:
            print(f"    '{w['text']}'  x0={w['x0']:.1f}  x1={w['x1']:.1f}  y={w['top']:.1f}")

    # ── Merge header-band words into column definitions ────────────────────
    # Process rows top-to-bottom. Each word either:
    #   - Matches an existing column by x-proximity → its text is appended
    #   - Has no nearby match → starts a new column, inserted in x-sorted order
    # This naturally combines "Order" (row above) with "Qty" (anchor row) when
    # they share the same x-position, producing "Order Qty".
    cols: list[list] = []  # each entry: [x_start: float, tokens: list[str]]

    for _, row in band:
        for w in sorted(row, key=lambda w: w["x0"]):
            best_ci, best_dist = None, float("inf")
            for ci, (cx, _) in enumerate(cols):
                d = abs(cx - w["x0"])
                if d < best_dist and d <= _HEADER_X_SNAP:
                    best_ci, best_dist = ci, d
            if best_ci is not None:
                print(
                    f"  [band-merge]  '{w['text']}' x0={w['x0']:.1f} "
                    f"→ col[{best_ci}] '{cols[best_ci][1]}' (dist={best_dist:.1f})"
                )
                cols[best_ci][1].append(w["text"])
            else:
                insert_pos = sum(1 for cx, _ in cols if cx < w["x0"])
                print(f"  [band-new]    '{w['text']}' x0={w['x0']:.1f} → new col[{insert_pos}]")
                cols.insert(insert_pos, [w["x0"], [w["text"]]])

    if len(cols) < 2:
        return None

    col_names = [" ".join(tokens) for _, tokens in cols]
    col_x_starts = [cx for cx, _ in cols]

    print(f"[pdfplumber:word-pos] {len(cols)} column(s) after band merge:")
    for i, (cx, tokens) in enumerate(cols):
        print(f"  col[{i}] x_start={cx:.1f}  name='{' '.join(tokens)}'")

    # ── Walk data rows ────────────────────────────────────────────────────
    data_rows: list[dict] = []
    for row in sorted_rows[data_start:]:
        row_lower = " ".join(w["text"].lower() for w in row)

        if _WP_TOTALS_RE.search(row_lower):
            break
        if len(row) < 2:
            continue

        cells = [""] * len(col_names)
        for w in row:
            ci = _assign_col(w["x0"], col_x_starts)
            cells[ci] = (cells[ci] + " " + w["text"]).strip()

        if sum(1 for c in cells if c.strip()) < 2:
            continue

        data_rows.append(dict(zip(col_names, cells)))

    if not data_rows:
        return None

    print(f"[pdfplumber:word-pos] found {len(data_rows)} rows, columns={col_names}")
    return {"headers": col_names, "data_rows": data_rows}


# ── Column auto-mapping ───────────────────────────────────────────────────────

def auto_map_line_items(rows: list[dict]) -> list[dict]:
    """Best-effort column detection from raw table rows."""
    if not rows:
        return []

    cols = list(rows[0].keys())

    def pick(patterns: list[str]) -> Optional[str]:
        for pat in patterns:
            for col in cols:
                if re.search(pat, col, re.IGNORECASE):
                    return col
        return None

    sku_col = pick([
        r"sku", r"item\s*#", r"item\s*no", r"part\s*#", r"code",
        r"product\s*#", r"^product$",
    ])
    # "Description" from the PDF → "description" field (product title in our schema).
    desc_col = pick([
        r"^description$", r"^desc",
        r"product\s*name", r"item\s*name", r"^name$",
    ])
    # Prefer ship qty (actually delivered) over order qty or generic qty.
    qty_col = pick([
        r"ship\s*qty", r"shipped",
        r"^qty$", r"^quantity$", r"^units?$",
        r"order\s*qty", r"^ordered$",
    ])
    cost_col = pick([
        r"unit\s*cost", r"unit\s*price", r"net\s*price",
        r"price\s*each", r"^each$", r"cost\s*each",
    ])

    if not desc_col:
        return []

    items = []
    for row in rows:
        desc = row.get(desc_col, "").strip()
        if not desc:
            continue

        raw_qty = row.get(qty_col, "1") if qty_col else "1"
        raw_cost = row.get(cost_col, "0") if cost_col else "0"

        try:
            qty = int(re.sub(r"[^\d]", "", str(raw_qty)) or "1") or 1
        except ValueError:
            qty = 1

        try:
            cost = float(re.sub(r"[^\d.]", "", str(raw_cost)) or "0") or 0.0
        except ValueError:
            cost = 0.0

        items.append({
            "sku": row.get(sku_col, "") if sku_col else "",
            "description": desc,
            "quantity": qty,
            "unitCost": cost,
        })

    return items


# ── Logistics-header detection ───────────────────────────────────────────────

# These keywords appear in shipping/terms summary rows, NOT in column-header rows.
_LOGISTICS_KEYWORDS = [
    "ship via", "ship date", "shipped via",
    "customer terms", "payment terms", "price level",
    "salesperson", "sales rep", "fob point", "carrier",
]


def _is_logistics_header(headers: list[str]) -> bool:
    """
    Return True when the table's first row looks like a shipping/terms block
    rather than actual column names.  pdfplumber sometimes picks up rows like
    ['Ship VIA\\nUPS GROUND', 'Customer Terms\\nNet 45 Days', 'Price Level\\n4']
    as the table header; the real column names are in the next row.
    """
    # Normalise: collapse newlines, lower-case, join all cells.
    text = " ".join(re.sub(r"\s+", " ", h).lower() for h in headers if h)
    return any(kw in text for kw in _LOGISTICS_KEYWORDS)


# ── Multi-page helpers ───────────────────────────────────────────────────────

def _tables_compatible(h1: list[str], h2: list[str]) -> bool:
    """True if two header lists describe the same table structure."""
    if abs(len(h1) - len(h2)) > 2:
        return False
    norm = lambda s: re.sub(r"\s+", "", s).lower()
    shorter = h1 if len(h1) <= len(h2) else h2
    longer  = h2 if len(h1) <= len(h2) else h1
    matches = sum(1 for h in shorter if any(norm(h) == norm(l) for l in longer))
    return matches >= max(1, len(shorter) // 2)


def _row_matches_headers(row: list, headers: list[str]) -> bool:
    """True if a data row looks like a repeated header row (common on page 2+)."""
    row_vals    = [str(c or "").strip().lower() for c in row[:len(headers)]]
    header_vals = [h.lower() for h in headers]
    matches = sum(1 for a, b in zip(row_vals, header_vals) if a == b)
    return matches >= max(2, len(headers) // 2)


# ── Main extractor ────────────────────────────────────────────────────────────

def extract_with_pdfplumber(pdf_bytes: bytes) -> dict:
    result = {
        "vendorName": None,
        "invoiceNumber": None,
        "invoiceDate": None,
        "dueDate": None,
        "lineItems": [],
        "rawTableData": [],
        "method": "pdfplumber",
    }

    try:
        with pdfplumber.open(BytesIO(pdf_bytes)) as pdf:
            if not pdf.pages:
                return result

            first_page = pdf.pages[0]
            first_text = first_page.extract_text() or ""
            all_text = "\n".join(
                (page.extract_text() or "") for page in pdf.pages
            )

            result["vendorName"] = _find_vendor_name(first_text)
            result["invoiceNumber"] = _find_invoice_number(all_text)
            result["invoiceDate"] = _find_date_near_label(
                all_text, ["Invoice Date", "Invoice Dated", "Dated", "Date Issued"]
            )
            result["dueDate"] = _find_date_near_label(
                all_text, ["Due Date", "Payment Due", "Due By", "Net Due", "Terms Due"]
            )

            # ── Stage 1: structured table extraction ──────────────────────
            candidates: list[dict] = []
            for page_num, page in enumerate(pdf.pages):
                for table in _extract_page_tables(page):
                    if not table or not table[0]:
                        continue
                    headers = [str(c or "").strip() for c in table[0]]
                    if not any(headers):
                        continue
                    if _headers_look_merged(headers):
                        headers = _split_merged_header(headers, table[1:])
                    data_rows = [
                        row for row in table[1:]
                        if row and any(str(c or "").strip() for c in row)
                    ]
                    if not data_rows:
                        continue
                    score = _score_table_as_line_items(headers, data_rows)
                    candidates.append({
                        "headers": headers,
                        "data_rows": data_rows,
                        "score": score,
                        "page": page_num + 1,
                    })

            print(f"[pdfplumber] {len(candidates)} table candidate(s) found:")
            for i, c in enumerate(candidates):
                print(
                    f"  [{i}] page={c['page']} rows={len(c['data_rows'])} "
                    f"score={c['score']:.1f} headers={c['headers']}"
                )

            best_score = max((c["score"] for c in candidates), default=0)

            if candidates and best_score >= 10:
                best = max(candidates, key=lambda c: c["score"])
                primary_page = best["page"]
                print(f"[pdfplumber] selected table [{candidates.index(best)}] "
                      f"(score={best['score']:.1f}, page={primary_page})")
                headers = best["headers"]
                data_rows = best["data_rows"]

                # If the header row contains shipping/terms info, the real
                # column names are in what pdfplumber treats as the first data row.
                if _is_logistics_header(headers) and data_rows:
                    print(
                        "[pdfplumber] header row looks like logistics info — "
                        "promoting first data row to column headers"
                    )
                    headers = [str(c or "").strip() for c in data_rows[0]]
                    data_rows = data_rows[1:]

                primary_headers = headers
                all_data_rows = list(data_rows)

                # ── Collect continuation pages ────────────────────────────
                for page_num, page in enumerate(pdf.pages):
                    if page_num + 1 == primary_page:
                        continue
                    for table in _extract_page_tables(page):
                        if not table or not table[0]:
                            continue
                        t_headers = [str(c or "").strip() for c in table[0]]
                        if not any(t_headers):
                            continue
                        t_rows = [
                            row for row in table[1:]
                            if row and any(str(c or "").strip() for c in row)
                        ]
                        if len(t_rows) < 2:
                            continue
                        score = _score_table_as_line_items(t_headers, t_rows)
                        if score < 5:
                            print(
                                f"[pdfplumber] page {page_num + 1}: "
                                f"table skipped (score={score:.1f})"
                            )
                            continue
                        # Handle logistics header on continuation page
                        if _is_logistics_header(t_headers) and t_rows:
                            t_headers = [str(c or "").strip() for c in t_rows[0]]
                            t_rows = t_rows[1:]
                        # Only use tables that share the primary column structure
                        if not _tables_compatible(t_headers, primary_headers):
                            print(
                                f"[pdfplumber] page {page_num + 1}: "
                                f"table skipped (incompatible headers: {t_headers})"
                            )
                            continue
                        # Skip repeated header row if the page re-prints it
                        if t_rows and _row_matches_headers(t_rows[0], primary_headers):
                            t_rows = t_rows[1:]
                        if not t_rows:
                            continue
                        print(
                            f"[pdfplumber] page {page_num + 1}: "
                            f"appending {len(t_rows)} continuation row(s)"
                        )
                        all_data_rows.extend(t_rows)

                raw_rows = [
                    {
                        primary_headers[i]: str(row[i] or "").strip()
                        for i in range(min(len(primary_headers), len(row)))
                    }
                    for row in all_data_rows
                ]
                result["rawTableData"] = raw_rows
                result["lineItems"] = auto_map_line_items(raw_rows)

            else:
                # ── Stage 2: word-position extraction for borderless tables ──
                print(
                    "[pdfplumber] no good table candidate "
                    f"(best_score={best_score:.1f}) — trying word-position extraction"
                )
                all_wp_rows: list[dict] = []
                for page_num, page in enumerate(pdf.pages):
                    wp = _extract_by_word_positions(page)
                    if wp and wp.get("data_rows"):
                        print(
                            f"[pdfplumber:word-pos] page {page_num + 1}: "
                            f"{len(wp['data_rows'])} row(s)"
                        )
                        all_wp_rows.extend(wp["data_rows"])
                if all_wp_rows:
                    result["rawTableData"] = all_wp_rows
                    result["lineItems"] = auto_map_line_items(all_wp_rows)

    except Exception:
        pass

    return result
