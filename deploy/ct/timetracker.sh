#!/usr/bin/env bash
source <(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/misc/build.func)
# Copyright (c) 2021-2026 community-scripts ORG
# Author: hogst
# License: MIT | https://github.com/community-scripts/ProxmoxVE/raw/main/LICENSE
# Source:  https://github.com/hogst/St-mpling
#
# Time Tracker — self-hosted time / overtime / flex tracker.
# Node.js + Express + node:sqlite (no native build deps). Runs on port 8787.
#
# Usage (on the Proxmox host, as root):
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/hogst/St-mpling/main/deploy/ct/timetracker.sh)"
#
# This script uses community-scripts' build.func for the interactive container
# creation wizard and base OS setup. Because the install script for this
# personal app does NOT live in the community-scripts repo, build.func's
# automatic install step is a no-op (404 → empty container). We then run our
# own install script from this repo via `pct exec`, which gives us the exact
# same msg_*/color output without needing a fork of build.func.

APP="TimeTracker"
var_tags="${var_tags:-productivity;tracking}"
var_cpu="${var_cpu:-1}"
var_ram="${var_ram:-512}"
var_disk="${var_disk:-2}"
var_os="${var_os:-debian}"
var_version="${var_version:-13}"
var_unprivileged="${var_unprivileged:-1}"

# Where our install script lives. Override via env if you forked the repo.
TT_REPO_URL="${TT_REPO_URL:-https://github.com/hogst/St-mpling.git}"
TT_REPO_BRANCH="${TT_REPO_BRANCH:-main}"
TT_INSTALL_URL="${TT_INSTALL_URL:-https://raw.githubusercontent.com/hogst/St-mpling/${TT_REPO_BRANCH}/deploy/install/timetracker-install.sh}"

header_info "$APP"
variables
color
catch_errors

function update_script() {
  header_info
  check_container_storage
  check_container_resources

  if [[ ! -d /opt/timetracker ]]; then
    msg_error "No ${APP} Installation Found!"
    exit
  fi

  msg_info "Updating Node.js"
  $STD apt-get update
  $STD apt-get -y install nodejs
  msg_ok "Updated Node.js"

  msg_info "Pulling latest ${APP} from git"
  cd /opt/timetracker
  $STD git fetch --all --prune
  $STD git reset --hard "origin/$(git rev-parse --abbrev-ref HEAD)"
  msg_ok "Pulled latest ${APP}"

  msg_info "Reinstalling production dependencies"
  cd /opt/timetracker/server
  $STD npm install --omit=dev --no-audit --no-fund
  msg_ok "Reinstalled dependencies"

  msg_info "Restarting service"
  chown -R timetracker:timetracker /opt/timetracker /var/lib/timetracker
  systemctl daemon-reload
  systemctl restart timetracker
  msg_ok "Restarted service"

  msg_ok "Updated ${APP} successfully!"
  exit
}

start
build_container
# At this point the LXC exists and has had base OS setup done (locale, tz,
# apt-update, sudo/curl installed). build.func tried to curl an install script
# from community-scripts for us — that 404s for this personal app, so the
# container is empty beyond the base. Now we run our own installer:

msg_info "Running Time Tracker installer inside CT $CTID"
# Pass the repo URL/branch through so the in-container installer pulls the
# same code the user is deploying. The install script falls back to fetching
# install.func itself if FUNCTIONS_FILE_PATH isn't propagated.
pct exec "$CTID" -- env \
  REPO_URL="$TT_REPO_URL" \
  REPO_BRANCH="$TT_REPO_BRANCH" \
  bash -c "$(curl -fsSL "$TT_INSTALL_URL")"
msg_ok "Installed Time Tracker"

description

msg_ok "Completed Successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW} Access it using the following URL:${CL}"
echo -e "${TAB}${GATEWAY}${BGN}http://${IP}:8787${CL}"
