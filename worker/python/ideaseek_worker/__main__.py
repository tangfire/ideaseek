"""CLI entry: `python -m ideaseek_worker <command>`.

Protocol: one JSON object on stdout for success; one JSON object on stderr
with a stable `code` for failures (exit 1). Never prints tracebacks or
secrets to stdout — the TypeScript bridge parses stdout strictly.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

from .pdf_parse import PdfParseError, parse_pdf
from .minipdf import build_minimal_pdf


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _fail(code: str, message: str) -> int:
    sys.stderr.write(json.dumps({"code": code, "message": message}, ensure_ascii=False) + "\n")
    sys.stderr.flush()
    return 1


def cmd_parse(args: argparse.Namespace) -> int:
    try:
        parsed = parse_pdf(args.path)
    except PdfParseError as exc:
        return _fail(exc.code, exc.message)
    except Exception as exc:  # noqa: BLE001 - last-resort normalization
        return _fail("INTERNAL", str(exc))
    _emit(parsed.to_json())
    return 0


def cmd_make_fixture(args: argparse.Namespace) -> int:
    """Writes a small multi-page fixture PDF (tests only; no binary committed)."""
    marker = getattr(args, "marker", "Evidence")
    pages = [
        f"{marker} Page One: the transformer uses attention only.",
        f"{marker} Page Two: recurrence is dispensable.",
    ]
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(build_minimal_pdf(pages))
    _emit({"path": str(out), "pages": len(pages)})
    return 0


def cmd_selftest(_args: argparse.Namespace) -> int:
    """Builds a fixture in a temp dir, parses it and verifies page evidence."""
    with tempfile.TemporaryDirectory(prefix="ideaseek-worker-") as tmp:
        pdf_path = Path(tmp) / "fixture.pdf"
        pdf_path.write_bytes(
            build_minimal_pdf(["Selftest Page Alpha content", "Selftest Page Beta content"])
        )
        try:
            parsed = parse_pdf(pdf_path)
        except PdfParseError as exc:
            return _fail(exc.code, exc.message)
    if parsed.page_count != 2:
        return _fail("SELFTEST_FAILED", f"expected 2 pages, got {parsed.page_count}")
    joined = " ".join(p.text for p in parsed.pages)
    if "Selftest Page Alpha" not in joined or "Selftest Page Beta" not in joined:
        return _fail("SELFTEST_FAILED", "fixture text not extracted")
    if [p.page for p in parsed.pages] != [1, 2]:
        return _fail("SELFTEST_FAILED", "page numbers must be 1-based and ordered")
    _emit({"ok": True, "parser": parsed.parser, "pageCount": parsed.page_count})
    return 0


def _force_utf8_streams() -> None:
    """Windows consoles default to GBK; paper text must never crash JSON output."""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass



MAX_TABLES_PER_DOC = 30
MAX_TABLE_ROWS = 60
MAX_TABLE_COLS = 20

def cmd_tables(args: argparse.Namespace) -> int:
    """Extract table grids from a PDF (docs: 表格/图表解析, opt-in)."""
    try:
        import pdfplumber
    except ImportError as exc:
        return _fail("PARSER_MISSING", f"pdfplumber is not installed: {exc}")
    path = args.path
    if not Path(path).is_file():
        return _fail("FILE_NOT_FOUND", f"no such file: {path}")
    tables = []
    try:
        with pdfplumber.open(path) as pdf:
            for page_no, page in enumerate(pdf.pages, start=1):
                if len(tables) >= MAX_TABLES_PER_DOC:
                    break
                try:
                    grids = page.extract_tables() or []
                except Exception:
                    grids = []
                for grid in grids:
                    if len(tables) >= MAX_TABLES_PER_DOC:
                        break
                    if not grid or not any(any(cell for cell in row) for row in grid):
                        continue
                    rows = []
                    for row in grid[:MAX_TABLE_ROWS]:
                        cells = ["" if cell is None else str(cell).strip() for cell in row]
                        rows.append(cells[:MAX_TABLE_COLS])
                    if rows:
                        tables.append({"page": page_no, "rows": rows})
    except Exception as exc:
        return _fail("PARSE_FAILED", f"cannot extract tables: {exc}")
    _emit({
        "source": str(path),
        "tables": tables,
        "tableCount": len(tables),
        "parser": f"pdfplumber/{pdfplumber.__version__}",
    })
    return 0


def main(argv: list[str] | None = None) -> int:
    _force_utf8_streams()
    parser = argparse.ArgumentParser(prog="ideaseek_worker")
    sub = parser.add_subparsers(dest="command", required=True)

    parse_cmd = sub.add_parser("parse", help="extract page text from a PDF")
    parse_cmd.add_argument("path")
    parse_cmd.set_defaults(func=cmd_parse)

    fixture_cmd = sub.add_parser("make-fixture", help="write a test fixture PDF")
    fixture_cmd.add_argument("out")
    fixture_cmd.add_argument("--marker", default="Evidence", help="page text marker")
    fixture_cmd.set_defaults(func=cmd_make_fixture)

    tables_cmd = sub.add_parser("tables", help="extract table grids from a PDF")
    tables_cmd.add_argument("path")
    tables_cmd.set_defaults(func=cmd_tables)

    self_cmd = sub.add_parser("selftest", help="parse a generated fixture end to end")
    self_cmd.set_defaults(func=cmd_selftest)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
