#!/usr/bin/env bash

# Copyright (c) 2021-2026 community-scripts ORG
# Author: hogst
# License: MIT | https://github.com/community-scripts/ProxmoxVE/raw/main/LICENSE
# Source:  https://github.com/hogstedtoskar-gif/St-mpling
#
# This script installs the Time Tracker inside an already-created LXC.
# It can be invoked two ways:
#
#   a) By community-scripts' build.func orchestration. FUNCTIONS_FILE_PATH is
#      set and contains install.func + tools.func.
#
#   b) Standalone via `pct exec $CTID -- bash -c "$(curl -fsSL ...)"`. In that
#      case we fetch install.func from community-scripts ourselves.

if [[ -n "${FUNCTIONS_FILE_PATH:-}" ]]; then
  source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"
else
  source <(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/misc/install.func)
fi

color
verb_ip6
catch_errors
setting_up_container
network_check
update_os

REPO_URL="${REPO_URL:-https://github.com/hogstedtoskar-gif/St-mpling.git}"
REPO_BRANCH="${REPO_BRANCH:-Server}"
APP_USER="timetracker"
APP_DIR="/opt/timetracker"
DATA_DIR="/var/lib/timetracker"

msg_info "Installing Dependencies"
$STD apt-get install -y \
  ca-certificates \
  curl \
  git \
  gnupg \
  jq
msg_ok "Installed Dependencies"

# Node 24 LTS — node:sqlite is stable there, no native build deps.
NODE_VERSION="24"
setup_nodejs

msg_info "Creating '${APP_USER}' system user"
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi
mkdir -p "$DATA_DIR"
msg_ok "Created '${APP_USER}' system user"

msg_info "Cloning Time Tracker from ${REPO_URL}"
rm -rf "$APP_DIR"
$STD git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
msg_ok "Cloned Time Tracker"

msg_info "Installing Time Tracker dependencies"
cd "$APP_DIR/server"
$STD npm install --omit=dev --no-audit --no-fund
msg_ok "Installed Time Tracker dependencies"

msg_info "Creating systemd service"
# Prefer the unit file shipped in the repo; fall back to an inline copy.
if [[ -f "$APP_DIR/deploy/timetracker.service" ]]; then
  install -m 0644 "$APP_DIR/deploy/timetracker.service" /etc/systemd/system/timetracker.service
else
  cat >/etc/systemd/system/timetracker.service <<'EOF'
[Unit]
Description=Time Tracker (self-hosted time/overtime/flex tracker)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=timetracker
Group=timetracker
WorkingDirectory=/opt/timetracker
Environment=NODE_ENV=production
Environment=PORT=8787
Environment=HOST=0.0.0.0
Environment=DATA_DIR=/var/lib/timetracker
Environment=PUBLIC_DIR=/opt/timetracker/public
ExecStart=/usr/bin/node --no-warnings=ExperimentalWarning /opt/timetracker/server/server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=timetracker

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/timetracker
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
LockPersonality=true
MemoryDenyWriteExecute=true

[Install]
WantedBy=multi-user.target
EOF
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR"
systemctl daemon-reload
systemctl enable -q --now timetracker
msg_ok "Created systemd service"

motd_ssh
customize
cleanup_lxc
