#!/usr/bin/env bash
# Linux check for one plan step. Usage: bash scripts/linux-check.sh [test/<file>.test.js ...]   (no args = whole suite)
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/check-locked.sh
if [ "$#" -gt 0 ]; then node --test "$@"; else node --test; fi
