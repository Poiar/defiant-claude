#!/usr/bin/env bash
# defiant — Use Claude Code with cheap backends. Provider-agnostic.
# Thin wrapper around scripts/cli.mjs (Node.js unified launcher).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="$SCRIPT_DIR/scripts/cli.mjs"

if [ ! -f "$CLI" ]; then
    echo "ERROR: cli.mjs not found at $CLI" >&2
    exit 1
fi

exec node "$CLI" "$@"
