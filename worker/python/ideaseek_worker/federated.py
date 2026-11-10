"""Read-only federated dataset profiling (docs/plan.md 阶段 B2 + user checklist).

Walks an EXTERNAL dataset root (never written to, never copied), detects
train/test client archives (<client>.npz with a pickled dict of x/y) and
emits the full checklist: splits, client counts, samples per client, x/y
shape+dtype, label distributions, per-client variance and non-IID metrics,
content hashes and a writability report.

All opens are 'rb'/'r' — the profiler cannot modify the source tree.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

import numpy as np

PARSER_NAME = "npz-pickle-v1"
MAX_CLIENTS_REPORTED = 500


def _client_sort_key(path: Path) -> tuple:
    stem = path.stem
    return (0, int(stem)) if stem.isdigit() else (1, stem)


def _load_client(path: Path) -> dict:
    with np.load(path, allow_pickle=True) as archive:
        data = archive["data"]
        inner = data.item() if getattr(data, "shape", None) == () else data[0]
    if not isinstance(inner, dict) or "x" not in inner or "y" not in inner:
        raise ValueError(f"unexpected npz layout in {path.name}: keys={list(inner) if isinstance(inner, dict) else type(inner)}")
    return {"x": np.asarray(inner["x"]), "y": np.asarray(inner["y"])}


def _label_counts(y: np.ndarray) -> dict[str, int]:
    values, counts = np.unique(y, return_counts=True)
    return {str(int(v) if float(v).is_integer() else v): int(c) for v, c in zip(values, counts)}


def _share(counts: dict[str, int], classes: list[str]) -> list[float]:
    total = sum(counts.values()) or 1
    return [counts.get(c, 0) / total for c in classes]


def _total_variation(p: list[float], q: list[float]) -> float:
    return 0.5 * sum(abs(a - b) for a, b in zip(p, q))


def profile_split(split_dir: Path, rel_prefix: str) -> dict:
    files = sorted(split_dir.glob("*.npz"), key=_client_sort_key)
    clients = []
    all_counts: dict[str, int] = {}
    sample_counts: list[int] = []
    for path in files:
        payload = _load_client(path)
        x, y = payload["x"], payload["y"]
        counts = _label_counts(y)
        all_counts.update({k: all_counts.get(k, 0) + v for k, v in counts.items()})
        sample_counts.append(int(len(y)))
        clients.append(
            {
                "id": path.stem,
                "file": f"{rel_prefix}/{path.name}",
                "samples": int(len(y)),
                "xShape": list(x.shape),
                "xDtype": str(x.dtype),
                "yShape": list(y.shape),
                "yDtype": str(y.dtype),
                "labelCounts": counts,
            }
        )
    return {
        "dir": rel_prefix,
        "clients": clients[:MAX_CLIENTS_REPORTED],
        "clientCount": len(clients),
        "totalSamples": int(sum(sample_counts)),
        "sampleStats": _sample_stats(sample_counts),
        "labelDistribution": dict(sorted(all_counts.items())),
        "_counts": all_counts,
        "_sampleCounts": sample_counts,
    }


def _sample_stats(values: list[int]) -> dict:
    if not values:
        return {"min": 0, "max": 0, "mean": 0.0, "std": 0.0}
    arr = np.asarray(values, dtype=np.float64)
    return {
        "min": int(arr.min()),
        "max": int(arr.max()),
        "mean": round(float(arr.mean()), 2),
        "std": round(float(arr.std(ddof=0)), 2),
    }


def non_iid_metrics(train_clients: list[dict], global_counts: dict[str, int]) -> dict:
    if not train_clients:
        return {"tvDistanceMean": 0.0, "tvDistanceMax": 0.0, "samplesCv": 0.0, "classesPerClientMean": 0.0}
    classes = sorted(global_counts, key=lambda c: (len(c), c))
    global_total = sum(global_counts.values()) or 1
    global_share = [global_counts.get(c, 0) / global_total for c in classes]
    tvs = []
    classes_per_client = []
    for client in train_clients:
        counts = client["labelCounts"]
        tvs.append(_total_variation(_share(counts, classes), global_share))
        classes_per_client.append(len(counts))
    samples = [c["samples"] for c in train_clients]
    arr = np.asarray(samples, dtype=np.float64)
    mean = float(arr.mean()) or 1.0
    return {
        "tvDistanceMean": round(float(np.mean(tvs)), 4),
        "tvDistanceMax": round(float(np.max(tvs)), 4),
        "samplesCv": round(float(arr.std(ddof=0) / mean), 4),
        "classesPerClientMean": round(float(np.mean(classes_per_client)), 2),
        "interpretation": "label distribution total-variation distance from the global mix; >0.1 mean indicates non-IID partitions",
    }


def file_hashes(root: Path) -> tuple[list[dict], str]:
    entries = []
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        h = hashlib.sha256()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                h.update(chunk)
        rel = path.relative_to(root).as_posix()
        file_hash = h.hexdigest()
        entries.append({"rel": rel, "bytes": path.stat().st_size, "sha256": f"sha256:{file_hash}"})
        digest.update(f"{rel}:{file_hash}\n".encode("utf-8"))
    return entries, f"sha256:{digest.hexdigest()}"


def profile_dataset(root: Path) -> dict:
    if not root.is_dir():
        raise FileNotFoundError(f"no such dataset root: {root}")
    train_dir = root / "train"
    test_dir = root / "test"
    splits = {}
    if train_dir.is_dir():
        splits["train"] = profile_split(train_dir, "train")
    if test_dir.is_dir():
        splits["test"] = profile_split(test_dir, "test")
    if not splits:
        raise ValueError(f"no train/ or test/ client archives under {root}")

    train_clients = splits.get("train", {}).get("clients", [])
    global_counts = splits.get("train", {}).get("_counts", {})
    non_iid = non_iid_metrics(train_clients, global_counts)

    for split in splits.values():
        split.pop("_counts", None)
        split.pop("_sampleCounts", None)

    files, root_hash = file_hashes(root)
    writable = os.access(root, os.W_OK)
    sample_writable = any(os.access(root / f["rel"], os.W_OK) for f in files[:5]) if files else False

    return {
        "parser": PARSER_NAME,
        "root": root.as_posix(),
        "splits": splits,
        "clientCount": len(train_clients),
        "nonIid": non_iid,
        "files": files,
        "fileCount": len(files),
        "rootHash": root_hash,
        "readOnly": {
            "rootWritableByProcess": writable,
            "sampleWritableByProcess": sample_writable,
            "policy": "external datasets are registered read-only in research.yaml; the platform only ever opens them for reading and writes derived slices under .research/slices/",
        },
    }
