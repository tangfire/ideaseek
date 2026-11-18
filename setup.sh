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

step "Checking required tools"

# Git
if command -v git >/dev/null 2>&1; then
  info "git $(git --version | head -1 | awk '{print $3}')"
else
  fail "git not found"
  echo "  Install: https://git-scm.com/downloads"
  exit 1
fi

# Node.js
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node --version)
  info "node $NODE_VER"
  # Check minimum version (24.9+)
  NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1 | tr -d 'v')
  if [ "$NODE_MAJOR" -lt 24 ]; then
    warn "node $NODE_VER < 24.9 required — upgrade: https://nodejs.org/"
  fi
else
  fail "node not found"
  echo "  Install: https://nodejs.org/ (LTS recommended)"
  exit 1
fi

# pnpm
if command -v pnpm >/dev/null 2>&1; then
  info "pnpm $(pnpm --version)"
else
  warn "pnpm not found — installing..."
  npm install -g pnpm
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
pnpm install

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
