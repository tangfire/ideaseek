# IdeaSeek Python worker

Page-aware PDF parsing for Phase 2, invoked by the TypeScript side as a
subprocess (`python -m ideaseek_worker parse <file>`) with a strict JSON
stdout protocol. It is **not** an Agent Loop and never touches the workflow
database — the bridge passes paths and receives structured JSON only.

## Setup

```bash
cd worker/python
pip install -r requirements.txt   # or: pip install pypdf
python -m ideaseek_worker selftest
```

## Commands

| command | purpose |
| --- | --- |
| `parse <path>` | extract text per 1-based page → `{"source","pageCount","pages":[{"page","text"}],"parser"}` |
| `make-fixture <out>` | write a small multi-page fixture PDF (tests; no binary fixtures committed) |
| `selftest` | build + parse + verify a fixture (exit 0 on success) |

Errors are one JSON object on stderr with a stable `code`
(`FILE_NOT_FOUND`, `EMPTY_FILE`, `ENCRYPTED_PDF`, `PARSE_FAILED`,
`NO_TEXT_LAYER`, `PARSER_MISSING`, `INTERNAL`) and exit code 1.

## Tests

```bash
python -m unittest discover -s tests -v
```
