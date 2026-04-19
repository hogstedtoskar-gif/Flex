# Time Tracker

A lightweight, single-user web app for tracking working hours with clean separation of **regular time**, **ordered overtime**, and **flex balance**.

Self-hosted on your LAN. Frontend is plain HTML/CSS/vanilla JS, backend is a small Node.js + Express server that persists to SQLite via Node's built-in `node:sqlite` (no native build deps).

## Architecture

```
public/                # Static UI served as-is
  index.html
  styles.css
  js/
    calc.js            # pure time math
    storage.js         # talks to /api/* (debounced + coalesced)
    ui.js              # DOM helpers, toasts, charts
    app.js             # router, state, event wiring
server/
  server.js            # Express app: serves /public + /api/*
  db.js                # node:sqlite store (one row per day + a settings blob)
  package.json         # only dep: express
deploy/
  ct/timetracker.sh                # Proxmox-host one-liner (community-scripts style)
  install/timetracker-install.sh   # in-container installer (community-scripts style)
  install.sh                       # manual installer for an existing LXC
  uninstall.sh
  timetracker.service              # systemd unit
```

The data lives in a single SQLite file (`/var/lib/timetracker/timetracker.db` once installed). All writes are scoped to the day or the settings document that changed, so a clock-in is one tiny `PUT /api/days/<date>`.

## Run it locally (dev)

Requires Node.js **>= 22.5** (>= 24 recommended for stable `node:sqlite`).

```bash
cd server
npm install
npm start            # http://localhost:8787
# or for auto-reload:
npm run dev
```

Then open <http://localhost:8787> in any modern browser.

Optional environment overrides:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | TCP port to listen on |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `server/data` | Where `timetracker.db` lives |
| `PUBLIC_DIR` | `../public` | Static asset directory |

## Host it on a Proxmox LXC

You get two paths. Pick whichever fits how you like to work.

### A) One-liner on the Proxmox host (community-scripts style)

Uses [community-scripts](https://community-scripts.org/docs) `build.func` for the interactive container-creation wizard (storage, network, resources, etc.), then runs our installer inside the new LXC.

Requires the repo to be reachable on GitHub (or another raw-git host).

On your Proxmox host, as **root**:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/hogstedtoskar-gif/St-mpling/Server/deploy/ct/timetracker.sh)"
```

Override defaults via env vars before the command, e.g. `var_ram=1024 var_disk=4 bash -c "$(curl …)"`. If you forked the repo, set `TT_REPO_URL=https://github.com/you/your-fork.git`.

The script creates an unprivileged Debian 13 LXC (1 vCPU, 512 MB, 2 GB disk by default), installs Node 24, clones this repo to `/opt/timetracker`, puts the DB at `/var/lib/timetracker`, enables the systemd unit, and prints the access URL.

### B) Manual install inside an existing LXC

If you'd rather create the LXC yourself in the Proxmox UI:

1. Create an unprivileged LXC (Debian 12/13 or Ubuntu 22+ template, 1 vCPU, 256 MB RAM, 1 GB disk).
2. Get the code inside (`git clone`, `scp`, or `pct push`).
3. Run the installer as root:
   ```bash
   sudo bash deploy/install.sh
   ```
   Same end state as path A.
4. Browse to `http://<lxc-ip>:8787` from anywhere on your LAN.

Useful commands on the LXC:

```bash
systemctl status  timetracker
systemctl restart timetracker
journalctl -u    timetracker -f
sudo bash deploy/uninstall.sh           # keeps data
sudo bash deploy/uninstall.sh --purge   # removes data + user too
```

To upgrade after pulling new code, just re-run `sudo bash deploy/install.sh` — it's idempotent and restarts the service.

## REST API

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/api/health` | — | `{ ok, now }` |
| `GET` | `/api/state` | — | full `{ version, settings, days }` |
| `PUT` | `/api/state` | full state | replaces everything (used by Import JSON) |
| `PUT` | `/api/settings` | settings object | merged + persisted settings |
| `PUT` | `/api/days/:date` | `{ entries, note }` | the saved day, or 204 if it became empty |
| `DELETE` | `/api/days/:date` | — | 204 |
| `POST` | `/api/reset` | — | empty default state |

`:date` must be `YYYY-MM-DD`.

## Keyboard shortcuts

- `I` – Clock in
- `O` – Clock out
- `L` – Start/end lunch (depending on current state)
- `1` / `2` / `3` / `4` – Switch to Dashboard / Diary / Summary / Settings

## Features

- Clock in/out and lunch start/end buttons with a state machine that prevents invalid actions.
- Manual entry and editing of every segment in the Diary view.
- Per-day calculation of worked, regular, extra, lunch, and shortfall hours.
- Weekly allocation: overtime is filled up to the configured weekly target; the rest flows into flex.
- Overtime period tracking with per-week progress bars and total filled vs required.
- All-time flex balance (positive surplus or negative deficit), with a configurable opening balance.
- Weekly and monthly summaries with inline bar charts.
- JSON backup/restore and CSV export (downloaded to your browser).
- Overlap and validation errors are highlighted in the Diary view.
- Alerts for past days with an unfinished clock-out.
- Dark and light themes follow your OS preference.

## How overtime & flex are computed

1. Per day: `worked = sum(work segments)`, lunch is never counted. `regular = min(worked, dailyHours)`, `extra = max(0, worked - dailyHours)`, `shortfall = max(0, dailyHours - worked)`.
2. Per week (starts on the configured day):
   - If the week falls inside the configured overtime period, days are walked in order and `extra` hours fill the weekly overtime target first. Anything beyond the target becomes `flex gain`.
   - Outside the period, all `extra` goes straight to flex.
   - `flex net = flex gain - shortfall`.
3. The all-time **flex balance** is the configured opening balance plus the sum of `flex net` across every week with recorded data.

## Settings

Configurable in the Settings view:

| Setting | Purpose |
|---|---|
| Week starts on | Mon / Sun / Sat — affects week grouping everywhere |
| Regular hours per day | Threshold above which hours become "extra" |
| Weekly overtime target | How many extra hours per week count as ordered overtime before overflowing to flex |
| Overtime period start | First day of the ordered-overtime period |
| Overtime period length | Number of weeks the overtime order applies |
| Default lunch | Informational default (currently used as a reference only) |
| Opening flex balance | Starting flex (hours) added on top of computed weeks |
| Opening flex as of | Optional cutoff date — weeks up to this date are not double-counted |

## Backups

The whole dataset is one SQLite file: `/var/lib/timetracker/timetracker.db`.

- **Export JSON backup** – downloads a portable JSON snapshot from the Settings view (recommended before any risky action).
- **Export CSV** – one row per day with all computed fields, suitable for Excel.
- **Import JSON** – replaces all data after confirmation (calls `PUT /api/state`).
- **Reset all data** – wipes the database (calls `POST /api/reset`).

For automated backups, just snapshot the SQLite file (e.g. nightly `cp /var/lib/timetracker/timetracker.db /backups/timetracker-$(date +%F).db`) — SQLite WAL mode means a plain copy of the `.db` is consistent enough for a single-user app, but `sqlite3 file.db ".backup /path/file.db"` is safer.

## JSON shape

```json
{
  "version": 1,
  "settings": { "weekStartDay": 1, "regularHoursPerDay": 8, "...": "..." },
  "days": {
    "2026-04-17": {
      "entries": [
        { "id": "uuid", "type": "work",  "start": "08:00", "end": "12:00" },
        { "id": "uuid", "type": "lunch", "start": "12:00", "end": "12:30" },
        { "id": "uuid", "type": "work",  "start": "12:30", "end": "17:30" }
      ],
      "note": "optional"
    }
  }
}
```
