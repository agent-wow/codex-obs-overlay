#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 0 ]] || { printf 'Usage: %s\n' "$0" >&2; exit 1; }
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
exec bash -- "$script_dir/install-service.sh" --uninstall
