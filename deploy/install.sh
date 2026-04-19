#!/usr/bin/env bash
# install.sh — Install the Time Tracker on a fresh Debian/Ubuntu LXC.
#
# Run this from inside a checkout of the repo, as root, on the LXC:
#   bash deploy/install.sh
#
# What it does (idempotent):
#   * Installs Node.js 22 LTS (via NodeSource) if /usr/bin/node is missing
#   * Creates a system user 'timetracker'
#   * Copies the app to /opt/timetracker
#   * Installs production npm deps
#   * Creates /var/lib/timetracker for the SQLite database
#   * Installs and enables a systemd service on port 8787
#
# Re-running this is safe: it just refreshes the files and restarts the service.

set -euo pipefail

APP_DIR=/opt/timetracker
DATA_DIR=/var/lib/timetracker
SERVICE_NAME=timetracker
SERVICE_USER=timetracker
NODE_MAJOR=${NODE_MAJOR:-24}            # node:sqlite is stable in Node 24 LTS

log() { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; }

if [[ $EUID -ne 0 ]]; then
  err "Run as root (e.g. sudo bash deploy/install.sh)."
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  err "This installer targets Debian/Ubuntu (apt-get not found)."
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
log "Installing from $REPO_ROOT"

# ---------- 1. Node.js ----------
need_node=true
if command -v node >/dev/null 2>&1; then
  current=$(node -v | sed 's/v//; s/\..*//')
  if [[ "$current" -ge "$NODE_MAJOR" ]]; then
    log "Node $(node -v) already installed."
    need_node=false
  else
    log "Found Node $(node -v); want >=v${NODE_MAJOR}.x. Reinstalling."
  fi
fi

if $need_node; then
  log "Installing Node.js ${NODE_MAJOR}.x via NodeSource."
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -y
  apt-get install -y nodejs
fi

log "Node: $(node -v),  npm: $(npm -v)"

# ---------- 2. Service user ----------
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  log "Creating system user '$SERVICE_USER'."
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# ---------- 3. App files ----------
log "Syncing files to $APP_DIR"
mkdir -p "$APP_DIR"
# Copy server + public + (top-level README/.gitignore for reference). Skip data dirs.
for d in server public; do
  rm -rf "$APP_DIR/$d"
  cp -a "$REPO_ROOT/$d" "$APP_DIR/"
done
# Wipe any node_modules that came along — we install fresh on the host.
rm -rf "$APP_DIR/server/node_modules"

# ---------- 4. npm install (production) ----------
log "Installing npm dependencies (production)."
(cd "$APP_DIR/server" && npm install --omit=dev --no-audit --no-fund)

# ---------- 5. Data dir ----------
mkdir -p "$DATA_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR" "$APP_DIR"

# ---------- 6. systemd unit ----------
log "Installing systemd unit /etc/systemd/system/${SERVICE_NAME}.service"
install -m 0644 "$REPO_ROOT/deploy/${SERVICE_NAME}.service" "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

sleep 1
if systemctl is-active --quiet "$SERVICE_NAME"; then
  ip=$(hostname -I | awk '{print $1}')
  log "Done. Service is running."
  log "Open: http://${ip:-<lxc-ip>}:8787"
  log "Logs: journalctl -u $SERVICE_NAME -f"
else
  err "Service failed to start. Recent logs:"
  journalctl -u "$SERVICE_NAME" --no-pager -n 40 || true
  exit 1
fi
