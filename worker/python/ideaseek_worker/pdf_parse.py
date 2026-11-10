"""Page-aware PDF text extraction (Phase 2 ingest).

Output contract (consumed by the TypeScript bridge, see
docs/DATA_CONTRACTS.md): one JSON object with 1-based page numbers so every
extracted span keeps its evidence locator. Failures raise `PdfParseError`
with a stable code — never raw tracebacks on stdout.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

PARSER_NAME = "pypdf"


class PdfParseError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class ParsedPage:
    page: int
    text: str


@dataclass
class ParsedPdf:
    source: str
    page_count: int
    pages: list[ParsedPage] = field(default_factory=list)
    parser: str = ""

    def to_json(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "pageCount": self.page_count,
            "pages": [{"page": p.page, "text": p.text} for p in self.pages],
            "parser": self.parser,
        }


def parse_pdf(path: str | Path) -> ParsedPdf:
    try:
        from pypdf import PdfReader
        import pypdf
    except ImportError as exc:  # pragma: no cover - environment guard
        raise PdfParseError(
            "PARSER_MISSING",
            "pypdf is not installed; run: pip install pypdf (see worker/python/README.md)",
        ) from exc

    file_path = Path(path)
    if not file_path.is_file():
        raise PdfParseError("FILE_NOT_FOUND", f"no such file: {file_path}")
    if file_path.stat().st_size == 0:
        raise PdfParseError("EMPTY_FILE", f"file is empty: {file_path}")

    try:
        reader = PdfReader(str(file_path))
        if getattr(reader, "is_encrypted", False):
            try:
                reader.decrypt("")
            except Exception as exc:  # noqa: BLE001 - pypdf raises many types
                raise PdfParseError(
                    "ENCRYPTED_PDF", f"encrypted PDF cannot be read: {file_path.name}"
                ) from exc
        pages: list[ParsedPage] = []
        for index, page in enumerate(reader.pages, start=1):
            try:
                text = page.extract_text() or ""
            except Exception as exc:  # noqa: BLE001 - per-page resilience
                text = ""
                pages.append(ParsedPage(page=index, text=text))
                continue
            pages.append(ParsedPage(page=index, text=text))
    except PdfParseError:
        raise
    except Exception as exc:  # noqa: BLE001 - normalize pypdf failures
        raise PdfParseError("PARSE_FAILED", f"cannot parse PDF: {exc}") from exc

    if not any(p.text.strip() for p in pages):
        raise PdfParseError(
            "NO_TEXT_LAYER",
            "no extractable text layer (scanned PDFs need OCR, not yet supported)",
        )

    return ParsedPdf(
        source=str(file_path),
        page_count=len(pages),
        pages=pages,
        parser=f"{PARSER_NAME}/{getattr(pypdf, '__version__', 'unknown')}",
    )
