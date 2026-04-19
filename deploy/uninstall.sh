#!/usr/bin/env bash
# uninstall.sh — Remove the Time Tracker from the LXC.
# By default the data directory is preserved. Pass --purge to remove it too.

set -euo pipefail

APP_DIR=/opt/timetracker
DATA_DIR=/var/lib/timetracker
SERVICE_NAME=timetracker
SERVICE_USER=timetracker

if [[ $EUID -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi

systemctl stop "$SERVICE_NAME" 2>/dev/null || true
systemctl disable "$SERVICE_NAME" 2>/dev/null || true
rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload

rm -rf "$APP_DIR"

if [[ "${1:-}" == "--purge" ]]; then
  rm -rf "$DATA_DIR"
  userdel "$SERVICE_USER" 2>/dev/null || true
  echo "Purged data and user."
else
  echo "Removed app. Data at $DATA_DIR preserved (pass --purge to delete)."
fi
