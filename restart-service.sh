#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 0 ]] || { printf 'Usage: %s\n' "$0" >&2; exit 1; }
unit_name=codex-obs-overlay.service
systemctl --user restart "$unit_name"
systemctl --user --no-pager status "$unit_name"
