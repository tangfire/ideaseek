# IdeaSeek

IdeaSeek is a DSH-based multi-agent research workflow platform.

## Installation

IdeaSeek is currently under active development. For the development checkout, read `docs/BOOTSTRAP_DEVELOPMENT.md` and `docs/AGENTS.md`. The target end-user installation after release is:

```bash
npm install -g ideaseek
ideaseek doctor
ideaseek init
```

Linux is the primary execution platform. Windows users should use WSL2 or SSH to a Linux server (the CLI and test suite are verified on Windows 11 and WSL2). See [docs/PACKAGING.md](docs/PACKAGING.md) for development installation, Python workers, upgrades, rollback, and platform support.

## Quickstart (source checkout)

Verified end to end from a fresh clone (install → build → project flow → REPL):

```bash
# 1. toolchain: Node >= 24.9, pnpm, Python 3 with pypdf/pdfplumber
git clone <repo> ideaseek && cd ideaseek
pnpm install --frozen-lockfile
pnpm build            # tsc → dist/
pnpm test             # regression suite: vitest + python worker tests
pnpm release-check    # dependency licenses + tracked-file secret scan

# 2. create a project (run the CLI from the checkout via node dist/cli.js,
#    or link the bin: npm link / pnpm link --global)
mkdir my-research && cd my-research
node <checkout>/dist/cli.js init
node <checkout>/dist/cli.js setup     # environment probes
node <checkout>/dist/cli.js doctor    # health report

# 3. drop inputs into papers/ datasets/ comparisons/ incoming/, then
node <checkout>/dist/cli.js scan
node <checkout>/dist/cli.js intake
node <checkout>/dist/cli.js plan --question "your research question"

# 4. run and observe (exit codes: 0 ok · 1 failed · 2 blocked/needs-input ·
#    3 still running · 4 canceled — see docs/CLI_SPEC.md)
node <checkout>/dist/cli.js run --question "your research question"
node <checkout>/dist/cli.js next
node <checkout>/dist/cli.js status
node <checkout>/dist/cli.js report

# 5. interactive UI (slash menu, natural language, live events;
#    /quit never cancels background runs)
node <checkout>/dist/cli.js interactive
```

From here, [docs/USER_GUIDE.md](docs/USER_GUIDE.md) covers the full journey (model configuration, paper/data intake, interactive runs, recovery, results, handoff); [docs/CLI_SPEC.md](docs/CLI_SPEC.md) documents every command and exit code.

The design and development handoff documents are in `docs/`. Start with:

1. `docs/AGENTS.md`
2. `docs/README.md`
3. `docs/plan.md`
4. `docs/BOOTSTRAP_DEVELOPMENT.md`
5. `docs/PROGRESS.md`

Start development with [docs/BOOTSTRAP_DEVELOPMENT.md](docs/BOOTSTRAP_DEVELOPMENT.md). The authoritative design and developer instructions are in [docs/README.md](docs/README.md), [docs/AGENTS.md](docs/AGENTS.md), and [docs/PROGRESS.md](docs/PROGRESS.md).

For end-user usage, start with [docs/USER_GUIDE.md](docs/USER_GUIDE.md). It covers installation, project setup, model configuration, paper/data intake, interactive runs, recovery, results, and handoff.

Prefer a browsable guide? Open the [IdeaSeek documentation site](docs/site/index.html) directly in a browser. It is a self-contained local HTML guide with navigation, search, responsive layout, and copyable commands; canonical technical references remain in `docs/*.md`.


使用说明请从 [docs/USER_GUIDE.md](docs/USER_GUIDE.md) 开始；完整文档目录和发布方式见 [docs/DOCUMENTATION_PLAN.md](docs/DOCUMENTATION_PLAN.md)。

