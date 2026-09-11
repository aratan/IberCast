#!/usr/bin/env bash
#
# run.sh — IberCast dev stack launcher.
#
# Starts, in order:
#   1. MediaMTX (RTMP ingest) — live streaming (OBS push)   (rtmp://:1935)
#   2. Kubo (IPFS daemon)       — if not already running    (http://localhost:5001)
#   3. ibercastd (Go API)       — build + serve             (http://localhost:8585)
#   4. player (Vite dev)        — npm run dev               (http://localhost:5173)
#
# Ctrl+C (SIGINT) stops everything.
#
# Flags:
#   --no-live      skip starting MediaMTX (live streaming off)
#   --no-ipfs      skip starting Kubo (assume daemon already up or unused)
#   --no-player    skip the Vite dev server
#   --daemon-only  alias for --no-player
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IPFS_API="http://localhost:5001"
IPFS_GATEWAY="http://localhost:8080"
DAEMON_PORT=8585
PLAYER_PORT=5173
RTMP_PORT=1935
PIDS=()

log()  { printf '\033[1;34m[run]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[run]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[run]\033[0m %s\n' "$*" >&2; }

need() { command -v "$1" >/dev/null 2>&1 || { err "missing dependency: $1 (install it first)"; exit 1; }; }

SKIP_IPFS=0
SKIP_PLAYER=0
SKIP_LIVE=0
for a in "$@"; do
  case "$a" in
    --no-ipfs)     SKIP_IPFS=1 ;;
    --no-player)   SKIP_PLAYER=1 ;;
    --daemon-only) SKIP_PLAYER=1 ;;
    --no-live)     SKIP_LIVE=1 ;;
    *) err "unknown flag: $a"; exit 1 ;;
  esac
done

cleanup() {
  log "Stopping..."
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  log "Done."
}
trap cleanup INT TERM EXIT

wait_for() { # wait_for <name> <url> [extra curl flags...]
  local name="$1" url="$2" i; shift 2
  log "Waiting for $name..."
  for i in $(seq 1 60); do
    # curl handles both IPv4 and IPv6 localhost; Vite binds ::1 on some systems
    if curl -sf --max-time 2 "$@" "$url" >/dev/null 2>&1; then
      log "$name is up: $url"
      return 0
    fi
    sleep 1
  done
  err "$name did not come up in 60s. Check $ROOT/app.log"
  exit 1
}

# --- dependency check -------------------------------------------------------
[[ "$SKIP_IPFS" -eq 0 ]] && need ipfs
need ffmpeg
need go
need npm

# --- 1. MediaMTX (RTMP ingest, live) ----------------------------------------
if [[ "$SKIP_LIVE" -eq 0 ]]; then
  if [[ -x "$ROOT/bin/mediamtx" ]]; then
    if curl -sf --max-time 2 "http://127.0.0.1:9997/v3/paths/list" >/dev/null 2>&1; then
      log "MediaMTX already running (rtmp://localhost:$RTMP_PORT)."
    else
      log "Starting MediaMTX (RTMP ingest on :$RTMP_PORT)..."
      "$ROOT/bin/mediamtx" "$ROOT/mediamtx.yml" >>"$ROOT/app.log" 2>&1 &
      PIDS+=($!)
      wait_for "MediaMTX API" "http://127.0.0.1:9997/v3/paths/list"
    fi
  else
    warn "bin/mediamtx not found — live streaming disabled (OBS push won't work)"
  fi
fi

# --- 2. Kubo (IPFS) ---------------------------------------------------------
if [[ "$SKIP_IPFS" -eq 0 ]]; then
  # The API can be mid-boot; give the pre-check a few tries before spawning.
  # Kubo 0.4x answers /api/v0/* to POST (GET returns 405 on some builds).
  for i in $(seq 1 5); do
    curl -sf -X POST --max-time 2 "$IPFS_API/api/v0/version" >/dev/null 2>&1 && break
    sleep 1
  done
  if curl -sf -X POST --max-time 2 "$IPFS_API/api/v0/version" >/dev/null 2>&1; then
    log "Kubo already running ($IPFS_API)."
  else
    log "Starting Kubo daemon..."
    ipfs daemon >"$ROOT/app.log" 2>&1 &
    PIDS+=($!)
    # If another daemon holds the repo lock, it serves the API anyway.
    wait_for "Kubo API" "$IPFS_API/api/v0/version" -X POST
  fi
fi

# --- 3. ibercastd -----------------------------------------------------------
log "Building ibercastd..."
( cd "$ROOT/ibercastd" && go build -o ibercastd . ) || { err "go build failed"; exit 1; }

log "Starting ibercastd on :$DAEMON_PORT..."
"$ROOT/ibercastd/ibercastd" serve --port "$DAEMON_PORT" --data-dir "$ROOT/data" >>"$ROOT/app.log" 2>&1 &
PIDS+=($!)
wait_for "ibercastd" "http://localhost:$DAEMON_PORT/api/health"

# --- 4. player (Vite) -------------------------------------------------------
if [[ "$SKIP_PLAYER" -eq 0 ]]; then
  log "Starting player dev server on :$PLAYER_PORT..."
  ( cd "$ROOT/player" && npm run dev ) >>"$ROOT/app.log" 2>&1 &
  PIDS+=($!)
  wait_for "player" "http://localhost:$PLAYER_PORT/"
fi

# --- done -------------------------------------------------------------------
cat <<EOF

  IberCast stack is running. Ctrl+C stops it.

  ┌──────────┬──────────────────────────────────────────────┐
  │ Player   │ http://localhost:$PLAYER_PORT/?mode=viewer            │
  │ API      │ http://localhost:$DAEMON_PORT/api/health              │
  │ RTMP     │ rtmp://localhost:$RTMP_PORT/live                      │
  │ IPFS API │ $IPFS_API                                       │
  │ IPFS GW  │ $IPFS_GATEWAY                                    │
  │ Logs     │ $ROOT/app.log                                    │
  └──────────┴──────────────────────────────────────────────┘

  Quick test:
    curl http://localhost:$DAEMON_PORT/api/health

  Upload a video (admin; without token it is open in dev):
    curl -X POST http://localhost:$DAEMON_PORT/api/videos \
      -F "title=My Video" -F "file=@/path/to/video.mp4"

EOF

wait