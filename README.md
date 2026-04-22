# Time Tracker

A lightweight, multi-user web app for tracking working hours with clean separation of **regular time**, **ordered overtime**, and **flex balance**. Each user has their own isolated data and settings.

Self-hosted on your LAN. Frontend is plain HTML/CSS/vanilla JS, backend is a small Node.js + Express server that persists to SQLite via Node's built-in `node:sqlite` (no native build deps). Auth is cookie-based sessions over scrypt-hashed passwords — all of it uses only `node:crypto` and `node:sqlite`, no extra dependencies.

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
  auth.js              # scrypt password hashing + session cookies
  db.js                # node:sqlite store (users, sessions, per-user days + settings)
  admin.js             # CLI: add-user / set-password / list-users / ...
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
| `BOOTSTRAP_USER` | — | If set and no login-capable users exist, create this user on first start. |
| `BOOTSTRAP_PASSWORD` | — | Password for `BOOTSTRAP_USER`. Required when `BOOTSTRAP_USER` is set. |
| `ALLOW_REGISTRATION` | — | Set to `1` to expose `POST /api/auth/register` (self-serve sign-up). |

## Users & authentication

Every request to `/api/*` (other than `/api/health`, `/api/auth/login`, `/api/auth/config`, and — when enabled — `/api/auth/register`) requires a session cookie. Sessions are stored server-side in SQLite with a 30-day sliding expiry. Passwords are hashed with scrypt.

### Creating the first user

On a fresh database there are no users, so you need to create one. Pick either:

**Option 1 — bootstrap via env vars** (good for first-time systemd installs)

```bash
BOOTSTRAP_USER=alice BOOTSTRAP_PASSWORD='change-me-now' npm start
```

This creates the user on first start and never again. If the database was migrated from the old single-user schema, this same step *claims* the migrated data for the new account instead of creating a second one.

**Option 2 — use the admin CLI**

```bash
cd server
node admin.js add-user alice          # prompts for password
node admin.js list-users
node admin.js set-password alice      # rotate password + invalidate sessions
node admin.js rename-user alice alicia
node admin.js delete-user alice       # removes the user and all their data
```

### Self-serve registration (optional)

If you want people on your LAN to sign themselves up, start the server with `ALLOW_REGISTRATION=1`. The login screen then shows a "Create one" link. Leave it off in the default setup to keep the instance private.

### Migrating an existing single-user database

Upgrading in place is safe: on first start after the upgrade, the old `days` and `settings` rows are re-parented to a placeholder account called `_legacy` (which has no usable password). Do one of the following to claim the data:

- Set `BOOTSTRAP_USER` / `BOOTSTRAP_PASSWORD` once — the server will rename `_legacy` to your new username and set the password.
- Or with the CLI: `node admin.js rename-user _legacy <you>` followed by `node admin.js set-password <you>`.

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

All `/api/*` endpoints except the ones marked *public* require the `tt_session` cookie obtained from `POST /api/auth/login`. All protected endpoints operate on the current user's data only.

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/api/health` *(public)* | — | `{ ok, now }` |
| `GET` | `/api/auth/config` *(public)* | — | `{ allowRegistration }` |
| `GET` | `/api/auth/me` | — | `{ user }` or `401` |
| `POST` | `/api/auth/login` *(public)* | `{ username, password }` | `{ user }` + `Set-Cookie` |
| `POST` | `/api/auth/logout` | — | 204 |
| `POST` | `/api/auth/register` *(public, opt-in)* | `{ username, password }` | `{ user }` + `Set-Cookie` |
| `POST` | `/api/auth/change-password` | `{ currentPassword, newPassword }` | `{ ok: true }` |
| `GET` | `/api/state` | — | full `{ version, settings, days }` |
| `PUT` | `/api/state` | full state | replaces everything (used by Import JSON) |
| `PUT` | `/api/settings` | settings object | merged + persisted settings |
| `PUT` | `/api/days/:date` | `{ entries, note }` | the saved day, or 204 if it became empty |
| `DELETE` | `/api/days/:date` | — | 204 |
| `POST` | `/api/reset` | — | empty default state |

`:date` must be `YYYY-MM-DD`. The session cookie is `HttpOnly; SameSite=Lax; Path=/` — combined with same-origin fetches the UI needs no CSRF token.

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

1. Per day, with an office window `[officeStart, officeEnd]` configured (default `07:30`–`17:30`):
   - `workedRaw = sum(work segments)` (lunch segments never count).
   - Each work segment is split into in-office minutes (overlap with the window) and outside-office minutes.
   - **Auto-lunch deduction**: if `workedRaw > lunchThresholdHours` (default `6h`) and the recorded lunch is shorter than `minLunchMinutes` (default `30` min), the missing break time is deducted from worked hours — in-office first, outside only if nothing else is left. Set `minLunchMinutes` to `0` to disable.
   - `regular = min(inOffice, dailyHours)` — only in-office time can earn regular hours.
   - `extraInOffice = max(0, inOffice - dailyHours)` — over-target in-office hours, eligible for overtime or flex.
   - `extraOutside = outside` — all outside-office hours, eligible for overtime **only**.
   - `shortfall = max(0, dailyHours - inOffice)` — outside-hours work does not reduce shortfall.
   - If `officeStart`/`officeEnd` are blank or invalid the window is disabled and all hours are treated as in-office.
2. Per week (starts on the configured day), days are walked in order:
   - Inside the overtime period, the weekly overtime target is filled from `extraOutside` **first** (use-it-or-lose-it — outside hours can never become flex), then from `extraInOffice`. Any leftover `extraInOffice` becomes `flex gain`. Any leftover `extraOutside` is counted as `outsideUnused` and is discarded.
   - Outside the overtime period, all `extraInOffice` becomes flex gain and all `extraOutside` is discarded.
   - `flex net = flex gain - shortfall`.
3. The all-time **flex balance** is the configured opening balance plus the sum of `flex net` across every week with recorded data.

## Settings

Configurable in the Settings view:

| Setting | Purpose |
|---|---|
| Week starts on | Mon / Sun / Sat — affects week grouping everywhere |
| Regular hours per day | Threshold above which hours become "extra" |
| Office hours start / end | Work outside this window can only become overtime — never regular or flex. Leave blank to disable. |
| Weekly overtime target | How many extra hours per week count as ordered overtime before overflowing to flex |
| Overtime period start | First day of the ordered-overtime period |
| Overtime period length | Number of weeks the overtime order applies |
| Default lunch | Informational default (currently used as a reference only) |
| Minimum lunch (minutes) | Auto-deduct the missing break from worked hours when the threshold is exceeded. `0` disables the rule. |
| Auto-lunch threshold (hours) | Daily worked time above which the minimum-lunch rule kicks in (default `6h`). |
| Opening flex balance | Starting flex (hours) added on top of computed weeks |
| Opening flex as of | Optional cutoff date — weeks up to this date are not double-counted |

## Backups

The whole dataset (all users, sessions, days and settings) is one SQLite file: `/var/lib/timetracker/timetracker.db`.

- **Export JSON backup** – downloads a portable JSON snapshot of the signed-in user's data from the Settings view.
- **Export CSV** – one row per day with all computed fields, suitable for Excel.
- **Import JSON** – replaces the signed-in user's data after confirmation (calls `PUT /api/state`). Other users are not affected.
- **Reset all data** – wipes the signed-in user's data only (calls `POST /api/reset`). Other users are not affected. To wipe the whole database, stop the service and delete the `.db` file, or use `node server/admin.js delete-user` per user.

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
