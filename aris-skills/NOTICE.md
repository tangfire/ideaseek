# Vendored ARIS skills

These files are copied from the ARIS project so IdeaSeek's P0 capability
contracts (ADR-008) hold even when the upstream repository is not installed
on the machine.

- Source repository: https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep
- Source commit: `8f493923f28c3f991dcca1287db97aa780d0969b` (2026-11-11)
- License: MIT — see `LICENSE` in this directory (Copyright (c) 2026 wanshuiyin)
- Vendored: 2026-11-11

Contents: 12 skill definitions (`skills/<name>/SKILL.md`), the
`shared-references/*.md` files those skills link to, and the pure-stdlib
`tools/research_wiki.py` helper used by the research-wiki skill.

Integrity: every vendored file's SHA-256 is recorded in
`src/aris/manifest.ts` and verified by `ideaseek aris` (and by
`loadArisSkill` before any execution). A mismatch refuses to load —
restore this directory or update the manifest deliberately in the same
commit as the refresh.

To refresh: copy the skill files from a newer upstream commit, update
`ARIS_SOURCE.commit` and the hashes in `src/aris/manifest.ts`, then run
`pnpm vitest run tests/aris-skill.test.ts`.
