"""Image-corpus profiling for domain-generalization style datasets.

Two shapes cover this field: a directory layout (`<domain>/<class>/*.jpg`,
what DG codebases consume) and a single HF parquet (what `datasets acquire`
now downloads). Both are read **metadata-only** — image bytes are never
decoded except for a bounded resolution sample — so a 190 MiB parquet profiles
in well under a second.

The point is not a row count. Protocol design needs the *grouping structure*:
which column carries the domain, how many domains exist, how classes are
distributed inside each, so the synthesis agent can ground a
leave-one-domain-out split in paper evidence instead of inventing one.
"""

from __future__ import annotations

import hashlib
import statistics
from pathlib import Path

SCHEMA_VERSION = "image-profile-v1"
GENERATED_BY = "ideaseek-worker-images-1"

# Column names that carry the domain/style/scene axis in FedDG-style corpora.
GROUP_KEYS = (
    "domain",
    "domains",
    "style",
    "styles",
    "scene",
    "scenes",
    "task",
    "tasks",
    "source",
    "client",
    "clients",
    "user",
    "site",
    "camera",
    "session",
)
LABEL_KEYS = ("label", "labels", "class", "classes", "target", "category", "y")
IMAGE_KEYS = ("image", "img", "images", "file", "path", "filename")
IMAGE_SUFFIXES = (".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp", ".ppm")
RESOLUTION_SAMPLE = 24
MAX_WARNINGS = 8


class ImageProfileError(ValueError):
    """Raised for inputs that are not a profileable image corpus."""


class MissingDependencyError(ImageProfileError):
    """An optional heavy dependency is absent: a fixable environment gap."""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def _counts(values: list[str]) -> list[dict]:
    tally: dict[str, int] = {}
    for value in values:
        tally[value] = tally.get(value, 0) + 1
    return [
        {"name": name, "count": count}
        for name, count in sorted(tally.items(), key=lambda item: (-item[1], item[0]))
    ]


def _spread(values: list[int]) -> dict:
    if not values:
        return {}
    return {
        "min": min(values),
        "median": int(statistics.median(values)),
        "max": max(values),
        "sampled": len(values),
    }


def _pick(columns: list[str], keys: tuple[str, ...]) -> str | None:
    lowered = {column.lower(): column for column in columns}
    for key in keys:
        if key in lowered:
            return lowered[key]
    return None


def _split_rules(groups: dict) -> list[str]:
    rules = []
    values = groups.get("values") or []
    if len(values) >= 2:
        rules.append(
            f"leave-one-group-out over {groups['column']}: {len(values)} groups "
            f"({', '.join(str(item['name']) for item in values[:8])})"
        )
        rules.append(
            f"one federated client per {groups['column']} value "
            f"({len(values)} clients), labels shared across clients"
        )
    return rules


def profile_parquet(path: Path) -> dict:
    try:
        import pyarrow.parquet as pq  # noqa: PLC0415 - optional heavy dependency
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise MissingDependencyError(
            f"pyarrow is not installed in the IdeaSeek worker environment: {exc}"
        ) from exc

    try:
        schema_names = [field.name for field in pq.ParquetFile(path).schema_arrow]
    except Exception as exc:
        raise ImageProfileError(f"cannot read parquet metadata: {exc}") from exc

    group_column = _pick(schema_names, GROUP_KEYS)
    label_column = _pick(schema_names, LABEL_KEYS)
    image_column = _pick(schema_names, IMAGE_KEYS)
    read_columns = [c for c in (group_column, label_column) if c]
    warnings: list[str] = []

    groups: dict = {"column": group_column, "values": []}
    classes: dict = {"column": label_column, "values": [], "distinct": 0}
    samples = 0
    resolution: dict = {}

    if read_columns:
        # ParquetFile.read avoids pyarrow.dataset, whose import pulls in a
        # compiled numpy ABI and breaks in mixed-version environments.
        table = pq.ParquetFile(path).read(columns=read_columns)
        samples = table.num_rows
        if group_column:
            groups["values"] = _counts(
                [str(value.as_py()) for value in table.column(group_column)]
            )
        if label_column:
            labels = [str(value.as_py()) for value in table.column(label_column)]
            classes["values"] = _counts(labels)
            classes["distinct"] = len(classes["values"])
        del table
    else:
        samples = pq.ParquetFile(path).metadata.num_rows
        warnings.append(
            f"no domain-like or label-like column among {schema_names}; "
            "grouping structure cannot be grounded"
        )

    if image_column:
        resolution = _sample_resolution(path, image_column)
        if not resolution:
            warnings.append(f"column {image_column!r} present but dimensions unreadable")

    if group_column is None:
        warnings.append("no grouping column: leave-one-domain-out cannot be derived")

    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedBy": GENERATED_BY,
        "source": {
            "path": str(path),
            "format": "parquet",
            "bytes": path.stat().st_size,
            "sha256": _sha256(path),
            "columns": schema_names,
        },
        "samples": samples,
        "grouping": groups,
        "classes": classes,
        "imageBytesColumn": image_column,
        "resolution": resolution,
        "splitRules": _split_rules(groups),
        "warnings": warnings[:MAX_WARNINGS],
    }


def _sample_resolution(path: Path, image_column: str) -> dict:
    """Decodes at most RESOLUTION_SAMPLE images to bound the cost."""
    try:
        import pyarrow.parquet as pq  # noqa: PLC0415
        from PIL import Image  # noqa: PLC0415
        import io  # noqa: PLC0415
    except ImportError:
        return {}
    widths: list[int] = []
    heights: list[int] = []
    try:
        table = pq.ParquetFile(path).read(columns=[image_column]).slice(0, RESOLUTION_SAMPLE)
        for value in table.column(image_column).to_pylist():
            blob = None
            if isinstance(value, dict):
                blob = value.get("bytes")
            elif isinstance(value, (bytes, bytearray)):
                blob = value
            if not blob:
                continue
            try:
                with Image.open(io.BytesIO(blob)) as image:
                    widths.append(image.width)
                    heights.append(image.height)
            except Exception:
                continue
    except Exception:
        return {}
    if not widths:
        return {}
    return {"width": _spread(widths), "height": _spread(heights)}


def profile_image_dir(root: Path) -> dict:
    files = sorted(
        item for item in root.rglob("*") if item.is_file() and item.suffix.lower() in IMAGE_SUFFIXES
    )
    if not files:
        raise ImageProfileError(f"no image files under {root}")

    # The grouping axis is whatever the first directory level under the root is;
    # `<class>/<domain>/` layouts are reported as found, never guessed at.
    rels = [item.relative_to(root) for item in files]
    grouped = [rel for rel in rels if len(rel.parts) >= 3]
    warnings: list[str] = []
    groups: dict = {"column": None, "values": []}
    classes: dict = {"column": None, "values": [], "distinct": 0}

    if grouped:
        group_names = [rel.parts[0] for rel in grouped]
        class_names = [rel.parts[1] for rel in grouped]
        groups = {"column": "directory:level-1", "values": _counts(group_names)}
        classes = {
            "column": "directory:level-2",
            "values": _counts(class_names),
            "distinct": len(set(class_names)),
        }
    else:
        single = [rel for rel in rels if len(rel.parts) == 2]
        if single:
            classes = {
                "column": "directory:level-1",
                "values": _counts([rel.parts[0] for rel in single]),
                "distinct": len({rel.parts[0] for rel in single}),
            }
            warnings.append(
                "flat <class>/<image> layout: no domain axis found, "
                "leave-one-domain-out cannot be derived from the directory tree"
            )
        else:
            warnings.append("images sit directly under the root: no grouping or class axis")

    widths: list[int] = []
    heights: list[int] = []
    try:
        from PIL import Image  # noqa: PLC0415

        for item in files[:RESOLUTION_SAMPLE]:
            try:
                with Image.open(item) as image:
                    widths.append(image.width)
                    heights.append(image.height)
            except Exception:
                continue
    except ImportError:
        warnings.append("Pillow not installed: image dimensions skipped")

    total_bytes = sum(item.stat().st_size for item in files)
    digest = hashlib.sha256()
    for rel in rels:
        digest.update(str(rel).encode("utf-8"))

    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedBy": GENERATED_BY,
        "source": {
            "path": str(root),
            "format": "image-dir",
            "bytes": total_bytes,
            "sha256": f"sha256:{digest.hexdigest()}",
            "columns": sorted({part for rel in rels for part in rel.parts[:-1]}),
        },
        "samples": len(files),
        "grouping": groups,
        "classes": classes,
        "imageBytesColumn": None,
        "resolution": ({"width": _spread(widths), "height": _spread(heights)} if widths else {}),
        "splitRules": _split_rules(groups),
        "warnings": warnings[:MAX_WARNINGS],
    }


def profile_images(path: Path) -> dict:
    """Dispatches on the input: a .parquet file or a directory corpus."""
    if path.is_file() and path.suffix.lower() == ".parquet":
        return profile_parquet(path)
    if path.is_dir():
        parquet_children = sorted(
            item for item in path.glob("*.parquet") if item.is_file()
        )
        if parquet_children and not any(
            item.suffix.lower() in IMAGE_SUFFIXES for item in path.rglob("*") if item.is_file()
        ):
            merged = [profile_parquet(child) for child in parquet_children[:8]]
            if len(merged) > 1:
                return _merge_parquet(merged, path)
            return merged[0]
        return profile_image_dir(path)
    raise ImageProfileError(f"not a parquet file or directory: {path}")


def _merge_parquet(profiles: list[dict], root: Path) -> dict:
    """Aggregates sharded parquet files into one corpus profile."""
    groups: dict[str, int] = {}
    classes: dict[str, int] = {}
    first = profiles[0]
    for profile in profiles:
        for item in profile["grouping"].get("values") or []:
            groups[item["name"]] = groups.get(item["name"], 0) + item["count"]
        for item in profile["classes"].get("values") or []:
            classes[item["name"]] = classes.get(item["name"], 0) + item["count"]
    merged_groups = {
        "column": first["grouping"]["column"],
        "values": sorted(
            [{"name": k, "count": v} for k, v in groups.items()],
            key=lambda item: (-item["count"], item["name"]),
        ),
    }
    merged_classes = {
        "column": first["classes"]["column"],
        "values": sorted(
            [{"name": k, "count": v} for k, v in classes.items()],
            key=lambda item: (-item["count"], item["name"]),
        ),
        "distinct": len(classes),
    }
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedBy": GENERATED_BY,
        "source": {
            "path": str(root),
            "format": "parquet-shards",
            "bytes": sum(profile["source"]["bytes"] for profile in profiles),
            "sha256": "sha256:"
            + hashlib.sha256(
                "|".join(profile["source"]["sha256"] for profile in profiles).encode("utf-8")
            ).hexdigest(),
            "columns": first["source"]["columns"],
        },
        "samples": sum(profile["samples"] for profile in profiles),
        "grouping": merged_groups,
        "classes": merged_classes,
        "imageBytesColumn": first["imageBytesColumn"],
        "resolution": first["resolution"],
        "splitRules": _split_rules(merged_groups),
        "warnings": [
            f"aggregated {len(profiles)} parquet shard(s) under {root}"
        ]
        + [warning for profile in profiles for warning in profile["warnings"]][:MAX_WARNINGS],
    }
