from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from models.schemas import HealthResponse, ParseResponse
from services.extraction import extract_invoice

app = FastAPI(title="Invoice PDF Parser", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/health", response_model=HealthResponse)
def health():
    return HealthResponse(status="healthy", version="1.0.0")


@app.post("/parse", response_model=ParseResponse)
async def parse_pdf(file: UploadFile = File(...)):
    content_type = file.content_type or ""
    filename = file.filename or ""
    if not filename.lower().endswith(".pdf") and "pdf" not in content_type:
        raise HTTPException(status_code=400, detail="Only PDF files are accepted.")

    pdf_bytes = await file.read()
    if not pdf_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    try:
        result = extract_invoice(pdf_bytes)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Extraction error: {exc}") from exc

    # DEBUG — remove once column extraction is verified in production.
    raw = result.get("rawTableData") or []
    col_names = list(raw[0].keys()) if raw else []
    print(f"[parse] method={result.get('extractionMethod')} "
          f"confidence={result.get('overallConfidence')} "
          f"rows={len(raw)} "
          f"columns={col_names}")
    if raw:
        print(f"[parse] first row: {raw[0]}")

    return result
