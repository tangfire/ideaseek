"""Minimal PDF writer used only by tests/fixtures (no external deps).

Builds a valid single- or multi-page PDF containing Helvetica text so the
parser pipeline can be exercised without committing binary PDFs (the repo
gitignores *.pdf by policy).
"""

from __future__ import annotations


def build_minimal_pdf(pages: list[str]) -> bytes:
    """Returns a PDF bytes object with one page per entry in `pages`."""
    if not pages:
        raise ValueError("at least one page is required")

    # Object ids: 1 catalog, 2 pages, then per page: page obj + content obj,
    # then font obj last.
    font_id = 3 + 2 * len(pages)
    objects: dict[int, bytes] = {}

    kids = " ".join(f"{3 + 2 * i} 0 R" for i in range(len(pages)))
    objects[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objects[2] = f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>".encode("latin-1")

    for i, text in enumerate(pages):
        page_id = 3 + 2 * i
        content_id = page_id + 1
        objects[page_id] = (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Contents {content_id} 0 R "
            f"/Resources << /Font << /F1 {font_id} 0 R >> >> >>"
        ).encode("latin-1")
        escaped = text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
        stream = f"BT /F1 12 Tf 72 720 Td ({escaped}) Tj ET".encode("latin-1")
        objects[content_id] = (
            f"<< /Length {len(stream)} >>\nstream\n".encode("latin-1")
            + stream
            + b"\nendstream"
        )

    objects[font_id] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"

    out = bytearray(b"%PDF-1.4\n")
    offsets: dict[int, int] = {}
    for oid in sorted(objects):
        offsets[oid] = len(out)
        out += f"{oid} 0 obj\n".encode("latin-1")
        out += objects[oid]
        out += b"\nendobj\n"

    xref_pos = len(out)
    count = font_id + 1
    out += f"xref\n0 {count}\n".encode("latin-1")
    out += b"0000000000 65535 f \n"
    for oid in range(1, count):
        out += f"{offsets[oid]:010d} 00000 n \n".encode("latin-1")
    out += (
        f"trailer\n<< /Size {count} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n"
    ).encode("latin-1")
    return bytes(out)
