#!/usr/bin/env bash
# enable-web-lxc-update.sh
#
# One-time setup for "Settings -> Server update" (web-triggered install/update):
#   1) Enables ALLOW_WEB_LXC_UPDATE on the timetracker systemd service
#   2) Sets LXC_UPDATE_SCRIPT (default: /opt/timetracker/deploy/install.sh)
#   3) Optionally restricts users via LXC_UPDATE_ALLOWED_USERS
#   4) Grants passwordless sudo for the service user to run that script
#   5) Disables NoNewPrivileges in a drop-in (required for sudo escalation)
#
# Usage:
#   sudo bash deploy/enable-web-lxc-update.sh
#   sudo bash deploy/enable-web-lxc-update.sh --users alice,bob
#   sudo bash deploy/enable-web-lxc-update.sh --script /opt/timetracker/deploy/install.sh --service timetracker

set -euo pipefail

SERVICE_NAME="timetracker"
SERVICE_USER="timetracker"
SCRIPT_PATH="/opt/timetracker/deploy/install.sh"
ALLOWED_USERS=""

log() { printf '\033[1;34m[web-update]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; }

usage() {
  cat <<'EOF'
Usage: sudo bash deploy/enable-web-lxc-update.sh [options]

Options:
  --users <csv>       Allowed usernames for UI trigger (alice,bob).
                      If omitted, any signed-in user can run it.
  --script <path>     Script to run as root (default /opt/timetracker/deploy/install.sh)
  --service <name>    Systemd service name (default timetracker)
  --service-user <u>  Service account for sudoers entry (default timetracker)
  -h, --help          Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --users) ALLOWED_USERS="${2:-}"; shift 2 ;;
    --script) SCRIPT_PATH="${2:-}"; shift 2 ;;
    --service) SERVICE_NAME="${2:-}"; shift 2 ;;
    --service-user) SERVICE_USER="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) err "Unknown argument: $1"; usage; exit 2 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  err "Run as root (sudo)."
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  err "systemctl not found. This script expects systemd."
  exit 1
fi
if ! command -v visudo >/dev/null 2>&1; then
  err "visudo not found. Install sudo package first."
  exit 1
fi

if [[ ! -f "$SCRIPT_PATH" ]]; then
  err "Script not found: $SCRIPT_PATH"
  exit 1
fi

OVERRIDE_DIR="/etc/systemd/system/${SERVICE_NAME}.service.d"
OVERRIDE_FILE="${OVERRIDE_DIR}/20-web-lxc-update.conf"
SUDOERS_FILE="/etc/sudoers.d/${SERVICE_NAME}-web-lxc-update"

log "Writing systemd override: $OVERRIDE_FILE"
mkdir -p "$OVERRIDE_DIR"
{
  echo "[Service]"
  echo "Environment=ALLOW_WEB_LXC_UPDATE=1"
  echo "Environment=LXC_UPDATE_SCRIPT=${SCRIPT_PATH}"
  if [[ -n "$ALLOWED_USERS" ]]; then
    echo "Environment=LXC_UPDATE_ALLOWED_USERS=${ALLOWED_USERS}"
  else
    # Explicitly clear any previous restriction from older runs.
    echo "Environment=LXC_UPDATE_ALLOWED_USERS="
  fi
  # sudo cannot elevate when NoNewPrivileges=true.
  echo "NoNewPrivileges=false"
} > "$OVERRIDE_FILE"

log "Writing sudoers rule: $SUDOERS_FILE"
{
  echo "# Managed by deploy/enable-web-lxc-update.sh"
  echo "${SERVICE_USER} ALL=(root) NOPASSWD: /bin/bash ${SCRIPT_PATH}"
} > "$SUDOERS_FILE"
chmod 0440 "$SUDOERS_FILE"

log "Validating sudoers syntax"
visudo -cf "$SUDOERS_FILE" >/dev/null

log "Reloading and restarting ${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl restart "${SERVICE_NAME}.service"

if systemctl is-active --quiet "${SERVICE_NAME}.service"; then
  log "Done. Web-triggered update is enabled."
  log "Service: ${SERVICE_NAME}.service"
  log "Script: ${SCRIPT_PATH}"
  if [[ -n "$ALLOWED_USERS" ]]; then
    log "Allowed users: ${ALLOWED_USERS}"
  else
    log "Allowed users: any signed-in user"
  fi
else
  err "${SERVICE_NAME}.service failed to start."
  journalctl -u "${SERVICE_NAME}.service" --no-pager -n 60 || true
  exit 1
fi
