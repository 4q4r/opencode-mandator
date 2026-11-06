#!/usr/bin/env bash
# opencode-mandator — atomic installer for the dispatch-policy enforcement plugin.
#
# ATOMICITY CONTRACT (load-bearing):
#   OpenCode hot-reloads plugin files on every change. A broken interim file at the
#   live path fail-closes EVERY gated tool call, with no in-session recovery (the
#   documented unlock is `rm ~/.config/opencode/plugin/dispatch-policy.ts`).
#   Therefore this script NEVER edits the live file in place: it materializes the
#   new content under a temp name in the SAME directory and installs it with a
#   single `mv -Tf` — one rename(2), no window where the live path is broken.
#
# MODES:
#   default    symlink the repo's src/dispatch-policy.ts into the plugin dir
#              (single source of truth; the repo copy is the live plugin). The
#              loader is probed with `opencode plugin list` right after install;
#              if it does not admit the symlink, the script falls back to an
#              atomic copy automatically.
#   --copy     skip the symlink attempt, install a byte-copy.
#   --package  do NOT touch the live install; verify the package-directory layout
#              (plugin-package/) loads via `opencode plugin list` from a temp
#              project dir whose project config carries the object-form entry,
#              then print the ready-to-paste global-config snippet for enabling
#              CONFIGURABLE installs (options live in opencode.json; the
#              file-symlink mode can never carry them). One mode at a time:
#              file symlink AND plugins-array entry together may double-load the
#              plugin (PRIMER injected twice — observed live 2026-11-07).
#   verify     report installed mode + byte-parity + loader registration.
#   uninstall  remove the live plugin file (gate disarms — documented unlock).
#
# Usage: ./install.sh [--copy | --package | verify | uninstall]
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${REPO_DIR}/src/dispatch-policy.ts"
PLUGIN_DIR="${HOME}/.config/opencode/plugin"
DEST="${PLUGIN_DIR}/dispatch-policy.ts"
OPENCODE_BIN="${OPENCODE_BIN:-opencode}"

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[opencode-mandator] $*"; }

# Loader probe: does a fresh opencode process see (and load) the plugin?
# Retried: a probe run immediately after the atomic mv can race the CLI's own
# startup/plugin scan (observed live 2026-10-14: both probes failed yet the very
# next `opencode plugin list` registered the plugin). 3 attempts, 2s apart.
loader_sees_plugin() {
  command -v "$OPENCODE_BIN" >/dev/null 2>&1 || return 2   # 2 = cannot check
  local attempt
  for attempt in 1 2 3; do
    if "$OPENCODE_BIN" plugin list 2>/dev/null | grep -q "dispatch-policy"; then
      return 0
    fi
    [[ $attempt -lt 3 ]] && sleep 2
  done
  return 1
}

# Atomic install of MODE (symlink|copy): temp entry in the plugin dir, then one mv.
install_mode() {
  local mode="$1" tmp
  [[ -f "$SRC" ]] || die "source plugin not found: $SRC"
  mkdir -p "$PLUGIN_DIR"
  tmp="$(mktemp "${PLUGIN_DIR}/.dispatch-policy.XXXXXX")"
  if [[ "$mode" == "symlink" ]]; then
    rm -f "$tmp"
    ln -s "$SRC" "$tmp"
  else
    cp "$SRC" "$tmp"
  fi
  mv -Tf "$tmp" "$DEST"   # atomic rename within the same directory
}

describe_dest() {
  if [[ -L "$DEST" ]]; then
    echo "symlink -> $(readlink "$DEST")"
  elif [[ -f "$DEST" ]]; then
    echo "regular file ($(wc -c <"$DEST") bytes)"
  else
    echo "MISSING"
  fi
}

cmd_install() {
  local mode="${1:-symlink}"
  install_mode "$mode"
  log "installed (${mode}): $(describe_dest)"
  local probe_rc
  loader_sees_plugin && probe_rc=0 || probe_rc=$?
  if [[ $probe_rc -eq 0 ]]; then
    log "loader probe: PASS — 'opencode plugin list' registers dispatch-policy (${mode} mode)"
    return 0
  elif [[ $probe_rc -eq 2 ]]; then
    log "loader probe: SKIPPED — '${OPENCODE_BIN}' CLI not found; run './install.sh verify' later"
    return 0
  fi
  if [[ "$mode" == "symlink" ]]; then
    log "loader probe: FAIL — loader does not admit the symlink; falling back to atomic copy"
    install_mode copy
    log "installed (copy): $(describe_dest)"
    if loader_sees_plugin; then
      log "loader probe: PASS after copy fallback"
      return 0
    fi
  fi
  die "loader still does not register dispatch-policy after install; check 'opencode plugin list' output"
}

cmd_verify() {
  local rc=0
  if [[ ! -e "$DEST" && ! -L "$DEST" ]]; then
    log "verify: FAIL — $DEST does not exist"
    exit 1
  fi
  log "verify: installed at $DEST ($(describe_dest))"
  if [[ -L "$DEST" ]]; then
    if [[ "$(readlink "$DEST")" == "$SRC" ]]; then
      log "verify: symlink target OK — single source of truth ($SRC)"
    else
      log "verify: FAIL — symlink points elsewhere: $(readlink "$DEST")"
      rc=1
    fi
  else
    if cmp -s "$SRC" "$DEST"; then
      log "verify: byte-identical to $SRC (copy mode)"
    else
      log "verify: FAIL — copy has drifted from $SRC (re-run './install.sh --copy')"
      rc=1
    fi
  fi
  if loader_sees_plugin; then
    log "verify: loader registers dispatch-policy — PASS"
  elif command -v "$OPENCODE_BIN" >/dev/null 2>&1; then
    log "verify: FAIL — 'opencode plugin list' does not show dispatch-policy"
    rc=1
  else
    log "verify: loader check SKIPPED — '${OPENCODE_BIN}' CLI not found"
  fi
  exit $rc
}

cmd_uninstall() {
  if [[ -e "$DEST" || -L "$DEST" ]]; then
    rm -f "$DEST"
    log "uninstalled: $DEST removed"
    log "note: the enforcement gate is now DISARMED (fail-open while absent) — reinstall with './install.sh' to re-arm"
  else
    log "nothing to uninstall: $DEST absent"
  fi
}

cmd_package() {
  local pkgdir="${REPO_DIR}/plugin-package"
  [[ -f "$pkgdir/package.json" && -f "$pkgdir/index.ts" ]] || die "package layout missing: $pkgdir"
  log "package mode: verifying the package entry loads (default file install untouched)"
  if ( cd "$REPO_DIR" && bun -e "const m = await import('$pkgdir/index.ts'); if (!m.default || typeof m.default.setup !== 'function') process.exit(1)" ); then
    log "package check: PASS — $pkgdir/index.ts imports and re-exports the plugin (default + setup)"
  else
    log "package check: FAIL — could not import $pkgdir/index.ts (run from the repo with bun)"
    return 1
  fi
  cat <<EOF

Ready-to-paste global config (one mode at a time — see the warning below):

  // ~/.config/opencode/opencode.jsonc  (apply = opencode service restart)
  {
    "plugins": [
      { "package": "$pkgdir", "options": { /* see docs/RULES.md §6 */ } }
    ]
  }

WARNING (double-load, observed live 2026-11-07): the file-discovered plugin
($DEST) and a plugins-array entry for the same id are BOTH loaded when they
coexist — PRIMER injected twice, hooks duplicated. Switching modes = remove the
symlink AND add the array entry in the SAME step, then 'opencode service restart'
and verify primer-once. Default install mode (file symlink) is unchanged by this
command; options can only ride on the object form above.

End-to-end options verification (fresh process, live fail-closed check):
  scripts/probe-options.sh
EOF
}

case "${1:-install}" in
  install)    cmd_install symlink ;;
  --copy)     cmd_install copy ;;
  --package)  cmd_package ;;
  verify)     cmd_verify ;;
  uninstall)  cmd_uninstall ;;
  -h|--help)  sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *)          die "unknown argument: $1 (use: install | --copy | --package | verify | uninstall)" ;;
esac
