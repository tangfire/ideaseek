#!/bin/sh
# One-command install entry (docs/PACKAGING.md): delegates to the
# cross-platform Node installer. Local/checkout use:
#   ./install.sh [--prefix <dir>] [--json]
# Remote curl|sh flows must pin version + checksum at the hosting layer
# (the script itself shows source/version/fingerprint before writing).
set -e
exec node "$(dirname "$0")/scripts/install.mjs" "$@"
