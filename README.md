# IdeaSeek

IdeaSeek is a DSH-based multi-agent research workflow platform.

## Installation

IdeaSeek is currently under active development. For the development checkout, read `docs/BOOTSTRAP_DEVELOPMENT.md` and `docs/AGENTS.md`. The target end-user installation after release is:

```bash
npm install -g ideaseek
ideaseek doctor
ideaseek init
```

Linux is the primary execution platform. Windows users should use WSL2 or SSH to a Linux server. See [docs/PACKAGING.md](docs/PACKAGING.md) for development installation, Python workers, upgrades, rollback, and platform support.

The design and development handoff documents are in `docs/`. Start with:

1. `docs/AGENTS.md`
2. `docs/README.md`
3. `docs/plan.md`
4. `docs/BOOTSTRAP_DEVELOPMENT.md`
5. `docs/PROGRESS.md`

Source code and tests are intentionally empty until Phase 0 begins.

Start development with [docs/BOOTSTRAP_DEVELOPMENT.md](docs/BOOTSTRAP_DEVELOPMENT.md). The authoritative design and developer instructions are in [docs/README.md](docs/README.md), [docs/AGENTS.md](docs/AGENTS.md), and [docs/PROGRESS.md](docs/PROGRESS.md).
