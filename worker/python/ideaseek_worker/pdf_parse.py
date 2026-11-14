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
# Bump whenever extraction behaviour changes in a way that makes previously
# parsed papers worth re-parsing (a recovered page, a new fallback). ingest
# uses this to decide an old artifact is stale even though its bytes did not
# change — without it, every parser improvement is permanently cached away.
PARSER_REVISION = "rev2"


class PdfParseError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class ParsedPage:
    page: int
    text: str
    # Hyperlink targets are separate from the text layer: a paper that says
    # "code is available" with github.com/x/y as a link annotation has no
    # URL in its extracted text, so scanning text alone misses official code.
    links: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    parser: str = PARSER_NAME


MAX_LINKS_PER_PAGE = 40


def _pdfplumber_page_text(pdf: Any, index: int) -> str:
    """Fallback extraction for pages pypdf refuses to parse.

    pypdf enforces a token budget per content stream and raises
    LimitReachedError on dense vector graphics (common in camera-ready CVPR
    PDFs). Silently recording such a page as empty truncates the paper and
    every downstream artifact inherits the hole without noticing.
    """
    pages = pdf.pages
    if index > len(pages):
        return ""
    try:
        return pages[index - 1].extract_text() or ""
    except Exception:  # noqa: BLE001 - a second failure is reported, not hidden
        return ""


def _page_links(page: Any) -> list[str]:
    """Read-only extraction of hyperlink targets from one page."""
    links: list[str] = []
    try:
        annotations = page.get_links() or []
    except Exception:  # noqa: BLE001 - malformed annotations must not fail a page
        return links
    for annotation in annotations:
        if not isinstance(annotation, dict):
            continue
        target = annotation.get("uri") or annotation.get("target")
        if isinstance(target, str) and target.strip():
            value = target.strip()
            if value not in links:
                links.append(value)
        if len(links) >= MAX_LINKS_PER_PAGE:
            break
    return links


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
            "pages": [
                {
                    "page": p.page,
                    "text": p.text,
                    "links": list(p.links),
                    "warnings": list(p.warnings),
                    "parser": p.parser,
                }
                for p in self.pages
            ],
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
        fallback: Any = None
        for index, page in enumerate(reader.pages, start=1):
            links = _page_links(page)
            warnings: list[str] = []
            text = ""
            failed: str | None = None
            try:
                text = page.extract_text() or ""
            except Exception as exc:  # noqa: BLE001 - per-page resilience, reported
                failed = f"{type(exc).__name__}: {str(exc)[:120]}"
            if failed is not None or not text.strip():
                # Open pdfplumber lazily: most papers never need it.
                if fallback is None:
                    try:
                        import pdfplumber  # noqa: PLC0415 - optional heavy dependency

                        fallback = pdfplumber.open(str(file_path))
                    except Exception as exc:  # noqa: BLE001 - no fallback available
                        fallback = False
                        warnings.append(f"fallback unavailable: {type(exc).__name__}")
                if fallback:
                    recovered = _pdfplumber_page_text(fallback, index)
                    if recovered.strip():
                        if failed is not None:
                            warnings.append(f"pypdf failed, recovered by pdfplumber: {failed}")
                        text = recovered
                        pages.append(
                            ParsedPage(
                                page=index,
                                text=text,
                                links=links,
                                warnings=warnings,
                                parser="pdfplumber",
                            )
                        )
                        continue
            if failed is not None:
                warnings.append(f"page text extraction failed: {failed}")
            pages.append(ParsedPage(page=index, text=text, links=links, warnings=warnings))
        if fallback:
            try:
                fallback.close()
            except Exception:  # noqa: BLE001 - close is best-effort
                pass
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
        parser=f"{PARSER_NAME}/{getattr(pypdf, '__version__', 'unknown')}+{PARSER_REVISION}",
    )
