"""Materialise a profiled HF parquet corpus into the on-disk layout experiments expect.

Acquired datasets arrive as a single parquet with embedded image bytes, while
both reimplemented baselines and third-party official code read
`<domain>/<class>/*.jpg` from disk (or a manifest pointing at them). Without
this step the data can be profiled and never trained on.

Everything here is deterministic: the same source, scale and seed produce the
same files, the same manifest order and the same report hash, so a result can
always be traced back to the read-only original.
"""

from __future__ import annotations

import csv
import hashlib
import json
import random
from pathlib import Path

SCHEMA_VERSION = "materialization-report-v1"
GENERATED_BY = "ideaseek-worker-materialize-1"

SCALE_FRACTIONS = {"smoke": 0.02, "quick": 0.1, "standard": 1.0}
DEFAULT_EXT = ".jpg"
IMAGE_EXTENSIONS = {
    ".jpg": ".jpg",
    ".jpeg": ".jpg",
    ".png": ".png",
    ".bmp": ".bmp",
    ".tif": ".tif",
    ".tiff": ".tif",
    ".webp": ".webp",
    ".ppm": ".ppm",
}


class MaterializeError(ValueError):
    """Raised for inputs that cannot be materialised safely."""


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def _safe_component(value: str) -> str:
    """One path segment, never a traversal and never empty."""
    cleaned = "".join(char for char in value.strip() if char not in '\\/:*?"<>|').strip()
    cleaned = cleaned.replace("..", "")
    return cleaned or "unspecified"


def _extension_for(name: str | None) -> str:
    if not name:
        return DEFAULT_EXT
    return IMAGE_EXTENSIONS.get(Path(str(name)).suffix.lower(), DEFAULT_EXT)


def _load_table(parquet_path: Path, image_column: str, group_column: str, label_column: str):
    try:
        import pyarrow.parquet as pq  # noqa: PLC0415 - optional heavy dependency
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise MaterializeError(f"pyarrow is not installed: {exc}") from exc
    try:
        table = pq.ParquetFile(parquet_path).read(columns=[image_column, group_column, label_column])
    except Exception as exc:
        raise MaterializeError(f"cannot read parquet columns: {exc}") from exc
    return table


def _pick_column(names: list[str], candidates: list[str]) -> str | None:
    lowered = {name.lower(): name for name in names}
    for candidate in candidates:
        if candidate in lowered:
            return lowered[candidate]
    return None


def materialize(
    parquet_path: Path,
    out_dir: Path,
    scale: str = "standard",
    seed: int = 42,
    image_column: str | None = None,
    group_column: str | None = None,
    label_column: str | None = None,
) -> dict:
    """Writes `<out>/<domain>/<label>/<row>.<ext>` plus a manifest, and reports it."""
    if scale not in SCALE_FRACTIONS:
        raise MaterializeError(f"unknown scale {scale!r} (expected smoke|quick|standard)")
    if not parquet_path.is_file():
        raise MaterializeError(f"no such parquet file: {parquet_path}")

    source_hash = _sha256_file(parquet_path)
    out_dir = out_dir.resolve()
    report_path = out_dir / "materialization.json"
    manifest_path = out_dir / "manifest.csv"

    # Idempotent: an existing report for the same source, scale and seed is
    # reused rather than rewritten, so re-running never churns the corpus.
    if report_path.is_file():
        try:
            existing = json.loads(report_path.read_text(encoding="utf-8"))
        except Exception:
            existing = None
        if (
            isinstance(existing, dict)
            and existing.get("sourceHash") == source_hash
            and existing.get("scale") == scale
            and existing.get("seed") == seed
        ):
            existing["already"] = True
            return existing

    table = _load_table(
        parquet_path,
        image_column or "image",
        group_column or "domain",
        label_column or "label",
    )
    columns = [field.name for field in table.schema]
    image_column = image_column or _pick_column(columns, ["image", "img", "images"])
    group_column = group_column or _pick_column(columns, ["domain", "style", "scene"])
    label_column = label_column or _pick_column(columns, ["label", "class", "target"])
    missing = [
        name
        for name, resolved in (
            ("image", image_column),
            ("group", group_column),
            ("label", label_column),
        )
        if resolved is None
    ]
    if missing:
        raise MaterializeError(
            f"cannot find {', '.join(missing)} column(s) among {columns}; "
            "pass them explicitly if the corpus uses other names"
        )

    images = table[image_column].to_pylist()
    groups = table[group_column].to_pylist()
    labels = table[label_column].to_pylist()

    # Stratify by (group,label) so a smoke corpus keeps the shape of the data
    # rather than its first rows, which would bias toward one domain.
    strata: dict[tuple[str, str], list[int]] = {}
    for index in range(len(labels)):
        key = (
            _safe_component(str(groups[index])),
            _safe_component(str(labels[index])),
        )
        strata.setdefault(key, []).append(index)

    fraction = SCALE_FRACTIONS[scale]
    rng = random.Random(f"{seed}|{source_hash}|{scale}")
    selected: list[int] = []
    for (_group, _label), indices in sorted(strata.items()):
        keep = max(1, round(len(indices) * fraction)) if fraction < 1 else len(indices)
        selected.extend(sorted(rng.sample(indices, min(keep, len(indices)))))
    selected.sort()

    out_dir.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, str]] = []
    per_group: dict[str, int] = {}
    written_bytes = 0
    for row_index, source_row in enumerate(selected):
        blob = images[source_row]
        name = None
        if isinstance(blob, dict):
            name = blob.get("path")
            blob = blob.get("bytes")
        if not isinstance(blob, (bytes, bytearray)):
            raise MaterializeError(
                f"row {source_row}: image column holds no bytes (found {type(blob).__name__})"
            )
        group = _safe_component(str(groups[source_row]))
        label = _safe_component(str(labels[source_row]))
        folder = out_dir / group / label
        # Defence in depth: the resolved target must stay inside out_dir.
        if not str(folder.resolve()).startswith(str(out_dir)):
            raise MaterializeError(f"refusing to write outside the output directory: {folder}")
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / f"{source_row}{_extension_for(name)}"
        target.write_bytes(bytes(blob))
        written_bytes += target.stat().st_size
        per_group[group] = per_group.get(group, 0) + 1
        rows.append(
            {
                "image": str(target.relative_to(out_dir).as_posix()),
                "label": str(labels[source_row]),
                "domain": str(groups[source_row]),
                "source_row": str(source_row),
                "row": str(row_index),
            }
        )

    with manifest_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["image", "label", "domain", "source_row", "row"])
        writer.writeheader()
        writer.writerows(rows)

    manifest_hash = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    report = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedBy": GENERATED_BY,
        "status": "ok",
        "source": str(parquet_path),
        "sourceHash": source_hash,
        "outDir": str(out_dir),
        "manifest": manifest_path.relative_to(out_dir).as_posix(),
        "manifestHash": f"sha256:{manifest_hash}",
        "scale": scale,
        "seed": seed,
        "columns": {"image": image_column, "group": group_column, "label": label_column},
        "totalSourceRows": len(labels),
        "materializedSamples": len(rows),
        "perDomain": dict(sorted(per_group.items())),
        "domains": len(per_group),
        "bytes": written_bytes,
        "readOnlySourcePreserved": True,
    }
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return report
