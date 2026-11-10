# IdeaSeek Python worker

Page-aware PDF parsing, table extraction and OCR for Phase 2, invoked by the
TypeScript side as a subprocess (`python -m ideaseek_worker <cmd> <file>`)
with a strict one-JSON-line stdout protocol. It is **not** an Agent Loop and
never touches the workflow database — the bridge passes paths and receives
structured JSON only.

## Setup (recommended: isolated venv)

```bash
cd worker/python
python -m venv .venv
.venv/bin/pip install -r requirements.txt    # Windows: .venv\Scripts\pip
.venv/bin/python -m ideaseek_worker selftest
```

The CLI prefers this venv automatically (the pinned wheels — including a
known-stable onnxruntime — keep OCR reproducible and isolated from the
system Python). Without a venv it falls back to `python3`/`python` for
parse/tables (pypdf/pdfplumber must be installed there); OCR then reports
`PARSER_MISSING` instead of crashing.

## Commands

| command | purpose |
| --- | --- |
| `parse <path>` | extract text per 1-based page → `{source, pageCount, pages, parser}` |
| `tables <path>` | pdfplumber table grids (opt-in; capped 30×60×20) |
| `ocr <path>` | rapidocr fallback for scanned (textless) PDFs, ≤20 pages |
| `make-fixture <out> [--marker]` | write a small fixture PDF (tests; no binaries committed) |
| `selftest` | build + parse + verify a fixture (exit 0 on success) |

Errors are one JSON object on stderr with a stable `code`
(`FILE_NOT_FOUND`, `EMPTY_FILE`, `ENCRYPTED_PDF`, `PARSE_FAILED`,
`NO_TEXT_LAYER`, `PARSER_MISSING`, `INTERNAL`) and exit code 1.

## Tests

```bash
python -m unittest discover -s tests -v
```
