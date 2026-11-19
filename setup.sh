#!/usr/bin/env bash
# IdeaSeek one-command setup: clone → run this → ideaseek is globally available.
#
# Installs everything npm cannot provide: LaTeX (paper compile), Python
# (experiments), and an SVG→PDF converter (deterministic figures). Then links
# the CLI globally so `ideaseek` works from any directory.
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[ok]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
fail()  { echo -e "${RED}[✗]${NC} $1"; }
step()  { echo -e "\n${GREEN}==>${NC} $1"; }

# --- Platform detection ---
OS="$(uname -s 2>/dev/null || echo Windows)"
IS_WSL=false
case "$OS" in
  Linux*) if grep -qi microsoft /proc/version 2>/dev/null; then IS_WSL=true; fi ;;
  MINGW*|MSYS*|CYGWIN*) IS_WSL=false ;;
esac

# npm registry: default to the China mirror (product docs are zh-first, and
# the mirror is a faithful integrity-preserving mirror — the lockfile still
# pins hashes). International or locked-down networks override it.
IDEASEEK_NPM_REGISTRY="${IDEASEEK_NPM_REGISTRY:-https://registry.npmmirror.com}"

step "Checking required tools"

# Git
if command -v git >/dev/null 2>&1; then
  info "git $(git --version | head -1 | awk '{print $3}')"
else
  fail "git not found"
  echo "  Install: https://git-scm.com/downloads"
  exit 1
fi

# Node.js — a bare host must not be a dead end: bootstrap >= 24.9 when
# missing or too old (Linux/macOS; the tarball layout matches nodejs.org).
NODE_REQUIRED_MAJOR=24
NODE_REQUIRED_MINOR=9
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local ver major rest minor
  ver=$(node --version 2>/dev/null | tr -d 'v') || return 1
  major=${ver%%.*}
  rest=${ver#*.}
  minor=${rest%%.*}
  case "${major}${minor}" in *[!0-9]* | '') return 1 ;; esac
  [ "$major" -gt "$NODE_REQUIRED_MAJOR" ] && return 0
  [ "$major" -eq "$NODE_REQUIRED_MAJOR" ] && [ "$minor" -ge "$NODE_REQUIRED_MINOR" ]
}

if ! node_ok; then
  case "$OS" in
    Linux | Darwin)
      step "Bootstrapping Node.js >= 24.9"
      NARCH=$(uname -m)
      case "$NARCH" in
        x86_64) NARCH=x64 ;;
        aarch64 | arm64) NARCH=arm64 ;;
        *) NARCH="" ;;
      esac
      case "$OS" in
        Linux) NOS=linux ;;
        Darwin) NOS=darwin ;;
      esac
      if [ -n "$NARCH" ] && command -v curl >/dev/null 2>&1; then
        NODE_V=v24.19.0
        NODE_PREFIX=/usr/local/lib/node-ideaseek
        NODE_LINK=/usr/local/bin
        if [ "$(id -u)" -ne 0 ] && [ ! -w /usr/local ]; then
          NODE_PREFIX="$HOME/.local/lib/node-ideaseek"
          NODE_LINK="$HOME/.local/bin"
          mkdir -p "$NODE_LINK"
        fi
        NODE_TAR="/tmp/node-${NODE_V}-${NOS}-${NARCH}.tar.xz"
        if curl -fsSL --max-time 300 \
          "https://registry.npmmirror.com/-/binary/node/${NODE_V}/node-${NODE_V}-${NOS}-${NARCH}.tar.xz" \
          -o "$NODE_TAR" 2>/dev/null ||
          curl -fsSL --max-time 300 \
            "https://nodejs.org/dist/${NODE_V}/node-${NODE_V}-${NOS}-${NARCH}.tar.xz" \
            -o "$NODE_TAR" 2>/dev/null; then
          mkdir -p "$NODE_PREFIX"
          tar -xJf "$NODE_TAR" -C "$NODE_PREFIX" --strip-components=1
          rm -f "$NODE_TAR"
          ln -sf "$NODE_PREFIX/bin/node" "$NODE_LINK/node"
          ln -sf "$NODE_PREFIX/bin/npm" "$NODE_LINK/npm"
          ln -sf "$NODE_PREFIX/bin/npx" "$NODE_LINK/npx"
          export PATH="$NODE_LINK:$PATH"
          info "node $(node --version) → $NODE_LINK/node"
        else
          fail "node download failed (npmmirror + nodejs.org both unreachable)"
          exit 1
        fi
      else
        fail "node >= 24.9 required and cannot auto-install on this platform"
        echo "  Install: https://nodejs.org/ (LTS recommended)"
        exit 1
      fi
      ;;
    *)
      fail "node not found"
      echo "  Install: https://nodejs.org/ (LTS recommended)"
      exit 1
      ;;
  esac
fi

if node_ok; then
  info "node $(node --version)"
else
  fail "node $(node --version 2>/dev/null || echo missing) < 24.9 required — upgrade: https://nodejs.org/"
  exit 1
fi

# pnpm
if command -v pnpm >/dev/null 2>&1; then
  info "pnpm $(pnpm --version)"
else
  warn "pnpm not found — installing..."
  npm install -g pnpm --registry="$IDEASEEK_NPM_REGISTRY"
  info "pnpm installed"
fi

# Python
if command -v python >/dev/null 2>&1; then
  PY_VER=$(python --version 2>&1 | awk '{print $2}')
  info "python $PY_VER"
elif command -v python3 >/dev/null 2>&1; then
  PY_VER=$(python3 --version 2>&1 | awk '{print $2}')
  info "python3 $PY_VER"
else
  warn "python not found — needed for experiments"
  case "$OS" in
    Darwin*) echo "  Install: brew install python3" ;;
    Linux*)  echo "  Install: sudo apt install python3 python3-pip" ;;
    *)       echo "  Install: https://python.org/downloads/ (check 'Add to PATH')" ;;
  esac
fi

# LaTeX (pdflatex)
if command -v pdflatex >/dev/null 2>&1; then
  info "pdflatex available"
else
  warn "pdflatex not found — needed for 'ideaseek paper compile'"
  case "$OS" in
    Darwin*) echo "  Install: brew install --cask mactex-no-gui" ;;
    Linux*)  echo "  Install: sudo apt install texlive-full (or texlive-latex-recommended)" ;;
    *)       echo "  Install: https://tug.org/texlive/ (Windows installer)" ;;
  esac
fi

# SVG→PDF converter (Inkscape or rsvg-convert)
if command -v inkscape >/dev/null 2>&1; then
  info "inkscape available"
elif command -v rsvg-convert >/dev/null 2>&1; then
  info "rsvg-convert available"
else
  warn "no SVG→PDF converter — 'paper diagram' figures will be skipped"
  case "$OS" in
    Darwin*) echo "  Install: brew install --cask inkscape" ;;
    Linux*)  echo "  Install: sudo apt install librsvg2-bin  (or inkscape)" ;;
    *)       echo "  Install: https://inkscape.org/ (Windows installer)" ;;
  esac
fi

step "Installing IdeaSeek dependencies"
info "npm registry: $IDEASEEK_NPM_REGISTRY (override: IDEASEEK_NPM_REGISTRY=...)"
pnpm install --registry="$IDEASEEK_NPM_REGISTRY"

step "Building IdeaSeek"
pnpm build

step "Making ideaseek globally available"
# npm link creates a global symlink to the local dist/cli.js
npm link 2>/dev/null || {
  # Fallback: add to PATH manually
  IDEASeek_BIN="$(pwd)/dist/cli.js"
  SHELL_RC=""
  case "$SHELL" in
    */zsh)  SHELL_RC="$HOME/.zshrc" ;;
    */bash) SHELL_RC="$HOME/.bashrc" ;;
    *)      SHELL_RC="$HOME/.profile" ;;
  esac
  if ! grep -q "ideaseek" "$SHELL_RC" 2>/dev/null; then
    echo "alias ideaseek='node $IDEASeek_BIN'" >> "$SHELL_RC"
    info "alias added to $SHELL_RC — restart your terminal"
  fi
}

# Verify
if command -v ideaseek >/dev/null 2>&1; then
  info "ideaseek is globally available"
else
  warn "ideaseek not on PATH yet — restart your terminal or run: npm link"
fi

step "Setup complete!"
echo ""
echo "Next steps:"
echo "  1. cd your-project-directory"
echo "  2. ideaseek init"
echo "  3. ideaseek setup          # verify environment"
echo "  4. ideaseek models setup   # configure API key"
echo "  5. ideaseek prepare --question \"your research question\""
