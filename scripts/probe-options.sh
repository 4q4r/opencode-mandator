#!/usr/bin/env bash
# scripts/probe-options.sh — Flexibility Phase 1 live options probe (design §D.4;
# a script, NOT a unit test — it asserts runtime facts bun cannot see).
#
# WHAT IT PROVES: an option set in opencode.json actually reaches the plugin in a fresh
# opencode process loaded through the PACKAGE layout (plugin-package/), and the hybrid
# fail-closed semantics fire live. The fixture config sets `gates.tools` to a non-array
# marker string — every formerly-gated call must then be denied with
#   DENIED by dispatch-policy plugin: [config-error] gates.tools must be an array of
#   non-empty strings (got "<MARKER>"); skill gate failing closed ...
# The deny is returned to the model as the tool result and persists in the fixture
# session DB; the probe greps both for the unique per-run marker.
#
# HERMETICITY: the probe redirects HOME to a throwaway fixture home (the LIVE install is
# untouched end to end — no file-discovered plugin, no live config, no live DB, no live
# model quota) and points the provider at a LOCAL mock server (probe-mock-server.ts on
# 127.0.0.1, chat-completions). This is deliberate: verified empirically on this machine
# (v2.2.5, 2026-11-07), a standalone opencode process does NOT apply the config/env
# proxy for provider calls, so every real provider is unreachable (geo/quota errors) —
# the mock removes the network from the equation entirely.
#
# NOTES (verified live 2026-11-07, v2.2.5)
#   - OPENCODE_CONFIG / OPENCODE_CONFIG_DIR / XDG_CONFIG_HOME do NOT redirect the config
#     home; a HOME redirect does. A project-level opencode.json plugins entry registers
#     the package entry, and a file-discovered plugin + array entry for the same id are
#     BOTH registered (double-load hazard — design §D.1); the fixture avoids the
#     discovered file entirely via the redirected HOME.
#   - The probe process env is sanitized (env -i) — a stray OPENCODE_CONFIG from the
#     parent session leaks the live config into the fixture otherwise (observed live).
#   - Retried 3x: a probe immediately after process start can race the plugin scan
#     (observed live 2026-10-14, same pattern as install.sh).
#
# Usage: scripts/probe-options.sh [--keep]   (--keep preserves the fixture dir)
# Env:   OPENCODE_BIN (default: opencode), MOCK_PORT (default: ephemeral)
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_DIR="${REPO_DIR}/plugin-package"
OPENCODE_BIN="${OPENCODE_BIN:-opencode}"
SCRATCH_ROOT="${SCRATCH_ROOT:-/tmp/opencode/mandator-ext6/flex-design}"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

log() { echo "[probe-options] $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

command -v "$OPENCODE_BIN" >/dev/null 2>&1 || die "'${OPENCODE_BIN}' CLI not found"
command -v bun >/dev/null 2>&1 || die "'bun' not found (needed for the local mock provider)"
[[ -d "$PACKAGE_DIR" ]] || die "package layout missing: $PACKAGE_DIR"

FIXTURE="$(mktemp -d "${SCRATCH_ROOT}/probe-options.XXXXXX")"
MOCK_PID=""
cleanup() {
  [[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" 2>/dev/null
  if [[ $KEEP -eq 1 ]]; then
    log "--keep: fixture preserved at $FIXTURE"
  else
    rm -rf "$FIXTURE"
  fi
}
trap cleanup EXIT

MARKER="probe-opts-$(date +%s)-$$_not-an-array"

# --- start the local mock provider ---
export MOCK_LOG="$FIXTURE/mock-requests.log"
bun "$REPO_DIR/scripts/probe-mock-server.ts" > "$FIXTURE/mock.out" 2> "$FIXTURE/mock.err" &
MOCK_PID=$!
for _ in 1 2 3 4 5; do
  grep -q PROBE_MOCK_PORT "$FIXTURE/mock.out" 2>/dev/null && break
  sleep 0.5
done
MOCK_PORT="$(grep -oE 'PROBE_MOCK_PORT=[0-9]+' "$FIXTURE/mock.out" | cut -d= -f2)"
[[ -n "$MOCK_PORT" ]] || { cat "$FIXTURE/mock.err" >&2; die "mock provider did not report a port"; }
log "mock provider listening on 127.0.0.1:${MOCK_PORT} (pid ${MOCK_PID})"

# --- fixture home: global config = package entry with marker options + mock provider ---
mkdir -p "$FIXTURE/home/.config/opencode" "$FIXTURE/home/.local/share/opencode" "$FIXTURE/project"
cat > "$FIXTURE/home/.config/opencode/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "model": "probe-mock/probe-model",
  "providers": {
    "probe-mock": {
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:${MOCK_PORT}/v1", "apiKey": "probe-mock" },
      "models": { "probe-model": { "name": "Probe Model" } }
    }
  },
  "plugins": [
    { "package": "${PACKAGE_DIR}", "options": { "gates": { "tools": "${MARKER}" } } }
  ]
}
EOF

# --- one probe attempt: fresh standalone process, sanitized env, auto-approved permissions ---
probe_once() {
  (
    cd "$FIXTURE/project"
    env -i HOME="$FIXTURE/home" PATH="$PATH" TERM=xterm \
      timeout 180 "$OPENCODE_BIN" run --standalone --auto \
      "Use the shell tool to run exactly: echo probe-options-ok. Then report the exact tool result you received, verbatim." \
      > "$FIXTURE/run.log" 2>&1
  )
}

check_evidence() {
  local found=0
  if grep -q "$MARKER" "$FIXTURE/run.log" 2>/dev/null; then
    found=1
    log "evidence: marker found in run output"
  fi
  # WAL mode: the deny may sit in opencode.db-wal until checkpoint — grep all db files.
  if grep -a -q "$MARKER" "$FIXTURE/home/.local/share/opencode/opencode.db" \
    "$FIXTURE/home/.local/share/opencode/opencode.db-wal" 2>/dev/null; then
    found=1
    log "evidence: marker found in the fixture session DB"
  fi
  grep -q "config-error" "$FIXTURE/run.log" 2>/dev/null || \
    grep -a -q "config-error" "$FIXTURE/home/.local/share/opencode/opencode.db" \
      "$FIXTURE/home/.local/share/opencode/opencode.db-wal" 2>/dev/null || found=0
  return $((1 - found))
}

ATTEMPT=1
PASS=0
while [[ $ATTEMPT -le 3 ]]; do
  log "attempt $ATTEMPT/3: fresh opencode process (standalone, mock provider, fixture config)"
  probe_once
  if check_evidence; then
    PASS=1
    break
  fi
  log "attempt $ATTEMPT: marker not observed — retrying"
  ATTEMPT=$((ATTEMPT + 1))
  [[ $ATTEMPT -le 3 ]] && sleep 2
done

if [[ $PASS -eq 1 ]]; then
  log "PASS — the option reached the plugin in a fresh process: gates.tools invalid ⇒ CONFIG-ERROR deny names the path (hybrid fail-closed, live)"
  grep -m1 -a "config-error" "$FIXTURE/run.log" \
    "$FIXTURE/home/.local/share/opencode/opencode.db" \
    "$FIXTURE/home/.local/share/opencode/opencode.db-wal" 2>/dev/null | head -c 400 || true
  echo
  exit 0
fi

die "FAIL — marker ${MARKER} not observed after 3 attempts; inspect with --keep (run.log, mock.err, mock.out in the fixture dir)"
