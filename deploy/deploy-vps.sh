#!/usr/bin/env bash
# One-command deploy for IberCast to a VPS.
#
# Usage:
#   VPS_USER=root VPS_HOST=1.2.3.4 VPS_ADMIN_TOKEN='super-secret' ./deploy/deploy-vps.sh
#
# Env vars:
#   VPS_USER        SSH user (default: root)
#   VPS_HOST        VPS host or IP (required)
#   VPS_ADMIN_TOKEN Admin token for ibercastd (required)
#   VPS_PORT        SSH port (default: 22)
#   VPS_DOMAIN      Optional: domain for nginx server_name / certbot
#   REMOTE_DIR      Install dir on VPS (default: /opt/ibercastd)
#
# What it does:
#   1. Builds the daemon (Go) and the player (TS) locally.
#   2. Packages binary + static player + systemd unit + nginx config into a tarball.
#   3. rsyncs it to the VPS and installs everything.
#   4. Installs ffmpeg + ipfs if missing, starts the systemd service, reloads nginx.
#   5. Optionally runs certbot for TLS if VPS_DOMAIN is set.

set -euo pipefail

# --- Config ----------------------------------------------------------------
VPS_USER="${VPS_USER:-root}"
VPS_HOST="${VPS_HOST:?VPS_HOST is required (e.g. VPS_HOST=1.2.3.4)}"
VPS_PORT="${VPS_PORT:-22}"
VPS_ADMIN_TOKEN="${VPS_ADMIN_TOKEN:?VPS_ADMIN_TOKEN is required}"
VPS_DOMAIN="${VPS_DOMAIN:-}"
REMOTE_DIR="${REMOTE_DIR:-/opt/ibercastd}"
SSH="ssh -p $VPS_PORT"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG_DIR="$(mktemp -d)"
TARBALL="$(mktemp --suffix=.tar.gz)"
trap 'rm -rf "$PKG_DIR" "$TARBALL"' EXIT

echo "==> [1/5] Building daemon (Go)"
(cd "$ROOT/ibercastd" && go vet ./... && go build -trimpath -ldflags="-s -w" -o ibercastd .)

echo "==> [2/5] Building player (TS)"
(cd "$ROOT/player" && npm ci && npm run typecheck && npm run build)

echo "==> [3/5] Packaging"
mkdir -p "$PKG_DIR/player" "$PKG_DIR/deploy"
cp "$ROOT/ibercastd/ibercastd" "$PKG_DIR/"
cp -r "$ROOT/player/dist/." "$PKG_DIR/player/"
cp "$ROOT/deploy/ibercastd.service" "$ROOT/deploy/nginx-ibercastd.conf" "$PKG_DIR/deploy/"
# Write the tarball OUTSIDE PKG_DIR — archiving a dir that contains the
# archive itself makes tar fail with "file changed as we read it".
tar -C "$PKG_DIR" -czf "$TARBALL" .

echo "==> [4/5] Uploading to $VPS_USER@$VPS_HOST"
$SSH "$VPS_USER@$VPS_HOST" "mkdir -p $REMOTE_DIR"
scp -P "$VPS_PORT" "$TARBALL" "$VPS_USER@$VPS_HOST:$REMOTE_DIR/release.tar.gz"

echo "==> [5/5] Installing on VPS"
$SSH "$VPS_USER@$VPS_HOST" bash -s -- "$REMOTE_DIR" "$VPS_ADMIN_TOKEN" "$VPS_DOMAIN" <<'REMOTE'
set -euo pipefail
REMOTE_DIR="$1"; TOKEN="$2"; DOMAIN="$3"

# Extract package
cd "$REMOTE_DIR"
tar -xzf release.tar.gz && rm -f release.tar.gz

# Dependencies (best-effort; ignore if already installed)
command -v ffmpeg >/dev/null || { apt-get update -qq && apt-get install -y -qq ffmpeg; }
command -v ipfs >/dev/null || { apt-get update -qq && apt-get install -y -qq ipfs; }
command -v nginx >/dev/null || { apt-get update -qq && apt-get install -y -qq nginx; }

# Start ipfs daemon if not running
if ! pgrep -x ipfs >/dev/null; then
  ipfs init >/dev/null 2>&1 || true
  nohup ipfs daemon >/var/log/ipfs.log 2>&1 &
fi

# Admin token env file (0600)
install -d -m 700 /etc/ibercastd
umask 077
printf 'IBERCASTD_ADMIN_TOKEN=%s\n' "$TOKEN" > /etc/ibercastd/env

# systemd unit
cp "$REMOTE_DIR/deploy/ibercastd.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable ibercastd >/dev/null
systemctl restart ibercastd
systemctl --no-pager --lines=5 status ibercastd || true

# nginx site
if [ -n "$DOMAIN" ]; then
  sed "s/server_name _;/server_name $DOMAIN;/" "$REMOTE_DIR/deploy/nginx-ibercastd.conf" > /etc/nginx/sites-available/ibercastd
else
  cp "$REMOTE_DIR/deploy/nginx-ibercastd.conf" /etc/nginx/sites-available/ibercastd
fi
ln -sf /etc/nginx/sites-available/ibercastd /etc/nginx/sites-enabled/ibercastd
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# TLS (optional)
if [ -n "$DOMAIN" ]; then
  if command -v certbot >/dev/null; then
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect || true
  else
    echo "certbot not installed; run: apt install certbot python3-certbot-nginx && certbot --nginx -d $DOMAIN"
  fi
fi

echo "✅ Deployed. API: http://${DOMAIN:-<vps-ip>}/api/health"
REMOTE

echo "🎉 Deploy complete."
echo "   Player:  http://$VPS_HOST/?mode=dashboard&token=$VPS_ADMIN_TOKEN"
echo "   Health:  http://$VPS_HOST/api/health"