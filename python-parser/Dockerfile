FROM python:3.11-slim

# System deps:
#   ghostscript  — required by camelot for lattice table detection
#   tesseract-ocr — OCR fallback for scanned PDFs
#   poppler-utils — required by pdf2image (pdftoppm)
#   libgl1 / libglib2.0-0 — required by OpenCV (camelot dependency)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ghostscript \
    tesseract-ocr \
    poppler-utils \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
