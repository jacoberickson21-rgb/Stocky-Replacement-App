import os
import tempfile

from parsers.pdfplumber_parser import auto_map_line_items


def extract_with_camelot(pdf_bytes: bytes) -> dict:
    """
    Extract tables using Camelot (lattice then stream).
    Falls back gracefully if Camelot or Ghostscript is unavailable.
    """
    result = {
        "vendorName": None,
        "invoiceNumber": None,
        "invoiceDate": None,
        "dueDate": None,
        "lineItems": [],
        "rawTableData": [],
        "method": "camelot",
    }

    try:
        import camelot  # lazy import — Ghostscript must be present
    except ImportError:
        return result

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            tmp.write(pdf_bytes)
            tmp_path = tmp.name

        raw_rows: list[dict] = []

        for flavor in ("lattice", "stream"):
            try:
                tables = camelot.read_pdf(tmp_path, pages="all", flavor=flavor)
            except Exception:
                continue

            if tables.n == 0:
                continue

            for table in tables:
                df = table.df
                if df.empty or len(df) < 2:
                    continue

                headers = [str(h).strip() for h in df.iloc[0]]
                if not any(headers):
                    continue

                for _, row in df.iloc[1:].iterrows():
                    vals = [str(v).strip() for v in row]
                    if all(v == "" for v in vals):
                        continue
                    raw_rows.append({
                        headers[i]: vals[i]
                        for i in range(min(len(headers), len(vals)))
                    })

            if raw_rows:
                break

        result["rawTableData"] = raw_rows
        result["lineItems"] = auto_map_line_items(raw_rows)

    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)

    return result
