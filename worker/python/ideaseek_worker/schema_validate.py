"""Python-side self-validation against the shared JSON Schema files.

The schema files under ``src/core/schema/schemas/`` are the single
cross-language authority (docs/DEPENDENCY_POLICY.md): TypeScript compiles
them with ajv, and the worker validates its payloads against the SAME
files before emitting them — early feedback at the producer instead of
waiting for the TS read gate.

Degradation policy: when ``jsonschema`` is not installed the check is
skipped with a one-line stderr note (the TS read gate remains
authoritative, so a missing optional dependency never weakens the
contract). When it IS installed, a violating payload is a hard error.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

SCHEMA_FILENAMES = {
    "parsed-paper-v1": "parsed-paper-v1.json",
    "dataset-profile-v1": "dataset-profile-v1.json",
    "image-profile-v1": "image-profile-v1.json",
}


def schema_dir() -> Path | None:
    """Shared schema directory: env override, else repo-relative default."""
    override = os.environ.get("IDEASEEK_SCHEMA_DIR")
    if override:
        path = Path(override)
        return path if path.is_dir() else None
    # worker/python/ideaseek_worker/schema_validate.py -> repo root is 3 up.
    repo_root = Path(__file__).resolve().parents[3]
    candidate = repo_root / "src" / "core" / "schema" / "schemas"
    return candidate if candidate.is_dir() else None


def validate_payload(schema_name: str, payload: dict[str, Any]) -> str | None:
    """Returns None when valid (or validation unavailable), else an error message.

    Never raises: worker commands translate the message into their stable
    failure protocol (``_fail``).
    """
    filename = SCHEMA_FILENAMES.get(schema_name)
    if filename is None:
        return f"unknown schema: {schema_name}"
    try:
        import jsonschema
    except ImportError:
        sys.stderr.write(
            json.dumps(
                {
                    "code": "SCHEMA_VALIDATOR_MISSING",
                    "message": "jsonschema not installed; python-side self-validation skipped "
                    "(the TypeScript read gate still enforces the contract)",
                },
                ensure_ascii=False,
            )
            + "\n"
        )
        return None
    directory = schema_dir()
    if directory is None:
        sys.stderr.write(
            json.dumps(
                {
                    "code": "SCHEMA_DIR_MISSING",
                    "message": "shared schema directory not found; self-validation skipped",
                },
                ensure_ascii=False,
            )
            + "\n"
        )
        return None
    try:
        schema = json.loads((directory / filename).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return f"cannot load schema {filename}: {exc}"
    validator = jsonschema.Draft7Validator(schema)
    errors = sorted(validator.iter_errors(payload), key=lambda error: list(error.path))
    if not errors:
        return None
    parts = []
    for error in errors[:5]:
        # Leading slash matches the ajv instancePath format on the TS side
        # (`/pages/0/page`), so both languages report identical paths.
        path = "/" + "/".join(str(segment) for segment in error.path)
        parts.append(f"{path}: {error.message}")
    extra = f" (+{len(errors) - 5} more)" if len(errors) > 5 else ""
    return f"{schema_name} self-validation failed: {'; '.join(parts)}{extra}"
