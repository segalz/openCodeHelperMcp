#!/usr/bin/env bash
# Fails when a file the executors must never change is modified or added (Linux port, plan section 2).
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(git rev-parse --abbrev-ref HEAD)" = "linux-support" ] || { echo "check-locked: not on linux-support" >&2; exit 2; }
bad=$(git status --porcelain --untracked-files=all | cut -c4- \
  | grep -E '^(test/|scripts/|\.github/|package\.json$|package-lock\.json$|\.gitattributes$|plan/linux-port/plan\.md$)' || true)
if [ -n "$bad" ]; then echo "check-locked: locked files changed:" >&2; echo "$bad" >&2; exit 3; fi
