#!/usr/bin/env bash
set -euo pipefail

mode=${1:-install}
case "$mode" in
  install|--dry-run|--uninstall) ;;
  *) printf 'Usage: %s [--dry-run|--uninstall]\n' "$0" >&2; exit 1 ;;
esac
[[ $# -le 1 ]] || { printf 'Too many arguments\n' >&2; exit 1; }
project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
unit_name=codex-obs-overlay.service
unit_dir=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
target=$unit_dir/$unit_name
marker='# Managed by codex-obs-overlay/install-service.sh'
if [[ -e "$target" || -L "$target" ]]; then
  [[ -f "$target" && ! -L "$target" ]] || { printf 'Refusing to replace non-regular unit: %s\n' "$target" >&2; exit 1; }
  IFS= read -r first_line < "$target" || true
  [[ "$first_line" == "$marker" ]] || { printf 'Refusing to replace an unmanaged unit: %s\n' "$target" >&2; exit 1; }
fi
if [[ "$mode" == --uninstall ]]; then
  if [[ -f "$target" ]]; then
    systemctl --user disable --now "$unit_name"
    rm -- "$target"
    systemctl --user daemon-reload
  fi
  exit 0
fi
bun_bin=${BUN_BIN:-$HOME/.bun/bin/bun}
[[ -x "$bun_bin" ]] || bun_bin=$(command -v bun)
bun_bin=$(realpath -e -- "$bun_bin")
[[ "$project_dir" != *$'\n'* && "$bun_bin" != *$'\n'* ]] || exit 1
quote() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//%/%%}
  printf '"%s"' "$value"
}
render() {
  cat <<EOF
$marker
[Unit]
Description=Read-only Codex activity overlay for OBS

[Service]
Type=simple
WorkingDirectory=${project_dir//%/%%}
ExecStart=$(quote ":$bun_bin") run --silent start
EnvironmentFile=-%h/.config/codex-obs-overlay.env
Restart=on-failure
RestartSec=3
TimeoutStopSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF
}
if [[ "$mode" == --dry-run ]]; then render; exit 0; fi
staging_dir=$(mktemp -d)
trap 'rm -rf -- "$staging_dir"' EXIT
render > "$staging_dir/$unit_name"
systemd-analyze --user verify "$staging_dir/$unit_name"
mkdir -p -- "$unit_dir"
install -m 0644 -- "$staging_dir/$unit_name" "$target"
systemctl --user daemon-reload
systemctl --user enable "$unit_name"
systemctl --user restart "$unit_name"
systemctl --user --no-pager status "$unit_name"
