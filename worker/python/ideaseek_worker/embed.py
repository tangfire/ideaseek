"""Local embedding bridge (fastembed/ONNX, no external embedding API).

Protocol: JSON {model, texts, cacheDir, warmupOnly?} on stdin → one JSON line
on stdout: {vectors?, dim, model, fastembedVersion, license, fingerprint,
cacheDir, downloaded}. All model bytes live in the project-managed cacheDir;
the fingerprint is a content hash over the cached model files so provenance
(ID/version/license/hash/cache) can be recorded and verified.

Failures use the shared error taxonomy: FASTEMBED_MISSING, MODEL_UNAVAILABLE,
PARSE_FAILED (bad input), INTERNAL.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

DEFAULT_MODEL = "sentence-transformers/all-MiniLM-L6-v2"


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + chr(10))
    sys.stdout.flush()


def _fail(code: str, message: str) -> int:
    sys.stderr.write(json.dumps({"code": code, "message": message}) + "\n")
    sys.stderr.flush()
    return 1


def model_fingerprint(model_dir: Path) -> str:
    digest = hashlib.sha256()
    if not model_dir.is_dir():
        return "sha256:missing"
    for path in sorted(model_dir.rglob("*")):
        if not path.is_file():
            continue
        file_hash = hashlib.sha256()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                file_hash.update(chunk)
        rel = path.relative_to(model_dir).as_posix()
        digest.update(f"{rel}:{file_hash.hexdigest()}\n".encode("utf-8"))
    return f"sha256:{digest.hexdigest()}"


def resolve_model_dir(cache_dir: Path, model: str) -> Path | None:
    if not cache_dir.is_dir():
        return None
    slug = model.replace("/", "--").lower()
    direct = cache_dir / slug
    if direct.is_dir():
        return direct
    # fastembed/Qdrant layouts nest under models--* directories.
    for candidate in cache_dir.rglob("*"):
        if candidate.is_dir() and slug.replace("--", "*").lower() in candidate.name.lower().replace("--", "*"):
            return candidate
        if candidate.is_dir() and candidate.name.lower().startswith("models--") and model.split("/")[-1].lower() in candidate.name.lower():
            return candidate
    for candidate in cache_dir.rglob("*.onnx"):
        return candidate.parent
    return None


def _model_license(model: str) -> str:
    try:
        from fastembed import TextEmbedding

        for entry in TextEmbedding.list_supported_models():
            if entry.get("model") == model:
                return str(entry.get("license") or "unknown")
    except Exception:  # noqa: BLE001 - metadata is best effort
        pass
    return "unknown"


def read_payload() -> dict:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"stdin must be JSON: {exc}") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("texts"), list):
        raise ValueError("stdin JSON must be {model?, texts: [...]}")
    return payload



def probe_environment(cache_dir: str, model: str) -> dict:
    """Fast capability probe: package presence + cache state, NEVER downloads."""
    out = {"packageInstalled": False, "fastembedVersion": None, "model": model, "modelCached": False, "license": "unknown", "cacheDir": cache_dir}
    try:
        import fastembed
        from fastembed import TextEmbedding
    except ImportError:
        return out
    out["packageInstalled"] = True
    out["fastembedVersion"] = fastembed.__version__
    try:
        for entry in TextEmbedding.list_supported_models():
            if entry.get("model") == model:
                out["license"] = str(entry.get("license") or "unknown")
                break
    except Exception:  # noqa: BLE001 - metadata best effort
        pass
    model_dir = resolve_model_dir(Path(cache_dir), model)
    if model_dir is not None and any(model_dir.rglob("*.onnx")):
        out["modelCached"] = True
        out["fingerprint"] = model_fingerprint(model_dir)
    return out


def cmd_embed(_args) -> int:
    try:
        payload = read_payload()
    except ValueError as exc:
        return _fail("PARSE_FAILED", str(exc))
    model = str(payload.get("model") or DEFAULT_MODEL)
    cache_dir = Path(str(payload.get("cacheDir") or ""))
    warmup = bool(payload.get("warmupOnly"))

    try:
        from fastembed import TextEmbedding
        import fastembed
    except ImportError as exc:
        return _fail("FASTEMBED_MISSING", f"fastembed is not installed in the worker venv: {exc}")

    try:
        embedding = TextEmbedding(model_name=model, cache_dir=str(cache_dir) if str(cache_dir) else None)
    except Exception as exc:  # noqa: BLE001 - download or init failure
        return _fail("MODEL_UNAVAILABLE", f"cannot initialize embedding model: {exc}")

    model_dir = resolve_model_dir(cache_dir, model)
    fingerprint = model_fingerprint(model_dir) if model_dir else "sha256:pending"
    meta = {
        "model": model,
        "fastembedVersion": fastembed.__version__,
        "license": _model_license(model),
        "fingerprint": fingerprint,
        "cacheDir": str(cache_dir),
        "downloaded": model_dir is not None,
    }
    if warmup:
        try:
            list(embedding.embed(["warmup"]))  # triggers download if needed
        except Exception as exc:  # noqa: BLE001
            return _fail("MODEL_UNAVAILABLE", f"model warmup failed (network?): {exc}")
        meta["cacheDir"] = str(cache_dir)
        meta["fingerprint"] = model_fingerprint(resolve_model_dir(cache_dir, model))
        meta["downloaded"] = True
        _emit(meta)
        return 0

    texts = payload.get("texts") or []
    if not texts:
        return _fail("PARSE_FAILED", "texts must be a non-empty list")
    try:
        vectors = [list(map(float, vector)) for vector in embedding.embed(texts)]
    except Exception as exc:  # noqa: BLE001
        return _fail("MODEL_UNAVAILABLE", f"embedding failed: {exc}")
    if not vectors:
        return _fail("MODEL_UNAVAILABLE", "embedding produced no vectors")
    _emit({**meta, "vectors": vectors, "dim": len(vectors[0])})
    return 0
