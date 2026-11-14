#!/bin/sh
# One-command uninstall entry: removes only what install.sh created.
set -e
exec node "$(dirname "$0")/scripts/uninstall.mjs" "$@"
