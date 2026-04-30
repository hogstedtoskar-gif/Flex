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

### Web-triggered LXC update (optional)

On a production LXC, `deploy/install.sh` must run as **root**. The UI can trigger it only if the Node process user may run that script without a password. Typical pattern:

1. Install the app so the script exists at `/opt/timetracker/deploy/install.sh` (or set `LXC_UPDATE_SCRIPT`).
2. Add a **sudoers** snippet for the `timetracker` service user, e.g.  
   `timetracker ALL=(root) NOPASSWD: /bin/bash /opt/timetracker/deploy/install.sh`
3. Start the server with `ALLOW_WEB_LXC_UPDATE=1` (and optionally `LXC_UPDATE_ALLOWED_USERS=alice,bob`).

Then **Settings → Server update → Run install / update script** appears. The HTTP request may time out in front of a reverse proxy while the script runs; check `journalctl -u timetracker` on the host. **Do not enable this on untrusted networks.**

One-command setup on an installed LXC:

```bash
sudo bash /opt/timetracker/deploy/enable-web-lxc-update.sh --users alice,bob
```

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
| `ALLOW_WEB_LXC_UPDATE` | — | Set to `1` to expose **Settings → Server update** and `GET`/`POST /api/admin/lxc-update` (runs the install script via `sudo -n`; see below). |
| `LXC_UPDATE_SCRIPT` | `/opt/timetracker/deploy/install.sh` | Bash script path passed to `sudo -n bash …`. |
| `LXC_UPDATE_ALLOWED_USERS` | — | Optional comma-separated usernames allowed to POST; if unset, any signed-in user may run it when `ALLOW_WEB_LXC_UPDATE=1`. |

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
| `PUT` | `/api/days/:date` | `{ entries, note, pto? }` | the saved day, or 204 if it became empty (a PTO-only day uses `entries: []`, empty `note`, and `pto: true`) |
| `GET` | `/api/admin/lxc-update` | — | `{ enabled, script?, restricted? }` — requires session; `enabled` is true only when `ALLOW_WEB_LXC_UPDATE=1` |
| `POST` | `/api/admin/lxc-update` | — | runs `sudo -n bash` on `LXC_UPDATE_SCRIPT`; JSON `{ code, stdout, stderr }`; 403 if disabled or user not allowed |
| `DELETE` | `/api/days/:date` | — | 204 |
| `POST` | `/api/reset` | — | empty default state |
| `GET` | `/api/auth/tokens` | — | list of phone-widget tokens (no plaintext) |
| `POST` | `/api/auth/tokens` | `{ label }` | `{ id, label, token }` — plaintext returned **once** |
| `DELETE` | `/api/auth/tokens/:id` | — | 204 |
| `GET` | `/api/quick/status` | — | `{ state, since, today }` — accepts cookie or `Authorization: Bearer ttk_…` |
| `POST` | `/api/quick/clock-in` | *(optional `tz`/`date`/`time`)* | status snapshot; 409 if already clocked in |
| `POST` | `/api/quick/clock-out` | *(optional `tz`/`date`/`time`)* | status snapshot; 409 if not working |
| `POST` | `/api/quick/lunch-toggle` | *(optional `tz`/`date`/`time`)* | status snapshot; toggles between `working` and `lunch` |

`:date` must be `YYYY-MM-DD`. The session cookie is `HttpOnly; SameSite=Lax; Path=/` — combined with same-origin fetches the UI needs no CSRF token. Bearer API tokens are only accepted on `/api/quick/*` — every other protected route requires a real session.

## Keyboard shortcuts

- `I` – Clock in
- `O` – Clock out
- `L` – Start/end lunch (depending on current state)
- `1` / `2` / `3` / `4` / `5` – Switch to Dashboard / Diary / Summary / Quick / Settings

## Phone: install as a PWA + one-tap home-screen widget

Time Tracker ships a small PWA shell and a dedicated **Quick** view with three giant
touch-friendly buttons. Combined with a long-lived API token, you can drive it from a
real one-tap home-screen widget on both iOS and Android — no extra apps required on
the server, no app-store accounts.

### Install the app itself (optional, but nice)

1. Open `http://<your-server>:8787/quick` on the phone.
2. iOS Safari: <b>Share → Add to Home Screen</b>.
3. Android Chrome: menu → <b>Install app</b> (or <b>Add to Home screen</b>).

The icon now opens straight into the Quick view in a chromeless full-screen window.
The app shell is cached by a service worker, so it opens instantly even on bad Wi-Fi.

### Create an API token for widgets

1. Sign in on the browser, go to <b>Settings → Phone widget</b>.
2. Enter a label (e.g. `iPhone home`) and click <b>Create token</b>.
3. Copy the `ttk_…` value immediately — it is shown <b>once</b>. If you lose it, revoke
   and create a new one.

Tokens can only drive the `/api/quick/*` endpoints. They cannot log in to the web UI,
read historical data, change the password, or create more tokens. Revoke any token
from the same Settings page.

### iOS — interactive widget (Scriptable, recommended)

The `ios/TimeTrackerWidget.js` file in this repo is a drop-in [Scriptable](https://scriptable.app)
widget that shows live status **and** clock-in / clock-out / lunch / refresh tiles in a single
home-screen tile — no Shortcuts juggling required.

1. Install the free <b>Scriptable</b> app on your iPhone.
2. In the web UI go to <b>Settings → Phone widget</b> and create an API token. Copy the
   `ttk_…` value immediately.
3. Open Scriptable → <b>+</b> to create a new script, name it <b>TimeTracker</b>, and paste
   the contents of <a href="./ios/TimeTrackerWidget.js"><code>ios/TimeTrackerWidget.js</code></a>.
4. Tap <b>▶︎</b> once to run it. You'll be prompted for:
   - <b>Server URL</b> — e.g. `http://192.168.1.10:8787` or `https://tt.your-domain`.
   - <b>Token</b> — the `ttk_…` value from step 2.
   Both are stored in the iOS Keychain.
5. Long-press the home screen → <b>Edit Home Screen</b> → <b>+</b> → <b>Scriptable</b> →
   pick the <b>Medium</b> size → <b>Add Widget</b>.
6. Long-press the new widget → <b>Edit Widget</b> → set <b>Script</b> to <i>TimeTracker</i>
   and <b>When Interacting</b> to <b>Run Script</b>. Done.

Layout by widget size:

| Size    | What you get |
|---------|--------------|
| Small   | Status only + one smart tap target: tap to clock in when off, to clock out when working, to end lunch when on lunch (iOS limits small widgets to one tap region). |
| Medium  | Status + elapsed + active project on the left, four tiles on the right (<b>In</b>, <b>Lunch</b>, <b>Out</b>, <b>↻</b>), plus a small <b>⚙︎ Configure</b> link. Recommended. |
| Large   | Status + today's totals + four big action tiles. Best if you already have extra space. |

Status colours: green = clocked in, amber = on lunch, grey = off, red = offline (no network
or token rejected — tap <b>⚙︎ Configure</b> to re-enter the URL or rotate the token).

To change the server URL or rotate the token later, open the script in Scriptable and run
it again (or tap <b>⚙︎ Configure</b> in the medium widget) — the same alert comes up with
the stored values pre-filled.

**Why Scriptable jumps to the foreground when you tap a button**

Apple only renders the widget UI in the background; any JavaScript (network calls, parsing)
must run inside the Scriptable app. There is no supported way to keep Scriptable hidden for
that step. The widget script calls `App.close()` at the end of each action when iOS exposes
that API, so you are sent back to the home screen as soon as the request finishes — you may
still see a quick transition. The **↻** tile only refreshes the widget snapshot (it no longer
opens a full-screen preview inside Scriptable).

If you want to avoid opening Scriptable entirely, use **Shortcuts** home-screen widgets
instead (see the next section): each shortcut is a separate tile, but Shortcuts often stays
more in the background than a full app switch. Another option is **Back Tap** or the **Action
Button** running a shortcut that POSTs to `/api/quick/*` with *Show When Run* turned off.

Because the widget uses the same `/api/quick/*` endpoints as every other integration here,
it respects the per-user default project: if you set one in Settings, tapping <b>In</b>
starts the new segment already tagged with that project.

### iOS — Shortcuts + home-screen widget (alternative)

1. Open the built-in <b>Shortcuts</b> app → <b>+</b> (new shortcut).
2. Add the action <b>Get contents of URL</b>.
3. Tap <b>Show More</b>:
   - Method: <b>POST</b>.
   - Headers: add <code>Authorization</code> = <code>Bearer ttk_…</code> (paste the
     token you created).
4. URL: `https://your-server/api/quick/clock-in` (or `/clock-out`, or `/lunch-toggle`).
5. Rename the shortcut (e.g. "Clock in"), tap <b>Done</b>.
6. Long-press the home screen → <b>Edit</b> → <b>+</b> → <b>Shortcuts</b> widget → pick
   the shortcut. You now have a real one-tap widget.

Repeat for "Clock out" and "Toggle lunch" if you want three widgets, or use the iOS 17+
interactive widget that groups several shortcuts.

Tip: put the three shortcuts in a *Stack* on the home screen to save space.

### iOS — "Status" shortcut (read-only)

If you also want a one-tap shortcut that just *tells you* whether you're currently
clocked in, on lunch, or off — and since when — build a second shortcut against the
`GET /api/quick/status` endpoint. It reuses the same `ttk_…` token; no new token is
needed.

1. Open <b>Shortcuts</b> → <b>+</b> (new shortcut).
2. Add <b>Get contents of URL</b>:
   - URL: `https://your-server/api/quick/status`.
   - Tap <b>Show More</b> → Method: <b>GET</b>.
   - Headers: add <code>Authorization</code> = <code>Bearer ttk_…</code>.
3. Add <b>Get Dictionary from Input</b> (parses the JSON response).
4. Add <b>Get Dictionary Value</b> → Key: `state` → store in a variable named `State`
   (use the <b>Set Variable</b> action right after).
5. Add another <b>Get Dictionary Value</b> on the same dictionary → Key: `since` →
   store in a variable named `Since`.
6. Add an <b>If</b> action with condition `State` <i>is</i> `working`:
   - Inside <b>If</b>: <b>Text</b> action with `Clocked in since [Since]`.
   - Add <b>Otherwise If</b> with condition `State` <i>is</i> `lunch`:
     - <b>Text</b> action with `On lunch since [Since]`.
   - <b>Otherwise</b>: <b>Text</b> action with `Clocked out`.
   - End If.
7. Add <b>Show Notification</b> (or <b>Show Result</b> / <b>Speak Text</b>) with the
   text from the If block as input.
8. Rename the shortcut (e.g. "Status"), tap <b>Done</b>.

Place it on the home screen the same way as the action shortcuts (long-press →
<b>Edit</b> → <b>+</b> → <b>Shortcuts</b> widget). It pairs nicely with the Clock in
/ Clock out / Toggle lunch shortcuts in an iOS 17+ interactive widget stack.

Because this call is a plain `GET`, it is covered by the same 30 req / 60 s per-token
rate limit as the action endpoints — safe to refresh often.

### Android — HTTP Shortcuts widget

The open-source [HTTP Shortcuts](https://http-shortcuts.rmy.ch/) app (F-Droid / Play
Store) can place a one-tap widget:

1. Install <b>HTTP Shortcuts</b>.
2. Create a new shortcut → Method: <b>POST</b>.
3. URL: `https://your-server/api/quick/clock-in`.
4. Under <b>Headers</b>, add `Authorization: Bearer ttk_…`.
5. Save. Repeat for `clock-out` and `lunch-toggle`.
6. Long-press the home screen → <b>Widgets</b> → <b>HTTP Shortcuts</b> → select the
   shortcut → drop it where you want.

Tasker users can drive the same endpoints via an HTTP Request action and any of
Tasker's widget/AutoInput options.

### Quick-action API (for any widget / automation)

All endpoints accept either the browser session cookie or `Authorization: Bearer <token>`.
Optional query (or JSON body) parameters let the widget pass the phone's clock/timezone:

| Param | Example | Meaning |
|---|---|---|
| `tz` | `Europe/Stockholm` | IANA timezone for "now" (default: server-local) |
| `date` | `2026-04-22` | Force the day the entry lands in |
| `time` | `08:03` | Force the clock time of the action |
| `project` | `3` | Tag the new work segment with this project id (clock-in / lunch-end). Defaults to the user's configured default project; use `0` or `-` to force untagged. |
| `tags` | `deep-work,review` | Comma-separated tags for the new work segment. |

| Method | Path | Behaviour |
|---|---|---|
| `GET` | `/api/quick/status` | Current `state` (`off`/`working`/`lunch`). `since` is the `HH:MM` of the currently open segment (or `null` when `state` is `off`), plus `today` totals |
| `POST` | `/api/quick/clock-in` | Start a new work segment. 409 if already clocked in |
| `POST` | `/api/quick/clock-out` | Close the open work segment. 409 if not working |
| `POST` | `/api/quick/lunch-toggle` | Start lunch if working; end lunch (resume work) if on lunch |

Response body is a status snapshot:

```json
{
  "date": "2026-04-22",
  "state": "working",
  "since": "08:03",
  "project": { "id": 3, "name": "Alpha", "color": "#ff8800" },
  "tags": ["deep-work"],
  "today": { "workedHours": 0, "lunchHours": 0 }
}
```

`project` and `tags` are `null` when the open segment is not tagged (or there is no open
segment).

Each token is rate-limited to 30 requests / 60 s to protect the server from a runaway
widget. Revoking a token is immediate.

## Features

- Clock in/out and lunch start/end buttons with a state machine that prevents invalid actions.
- Manual entry and editing of every segment in the Diary view.
- **PTO (paid time off)** – mark a day in the Diary so it never creates shortfall; a full PTO day with no work segments credits regular hours at your daily target for reporting.
- Per-day calculation of worked, regular, extra, lunch, and shortfall hours.
- Weekly allocation: overtime is filled up to the configured weekly target; the rest flows into flex.
- Overtime period tracking with per-week progress bars and total filled vs required.
- All-time flex balance (positive surplus or negative deficit), with a configurable opening balance.
- Weekly and monthly summaries with inline bar charts.
- **Projects & tags** – attach an optional project (with custom color) and free-form tags to every work segment. Pick a default project or pick one per clock-in from the dashboard; the weekly/monthly summary breaks totals down by project.
- **Visual day timeline** – an SVG strip on the dashboard and in the Diary shows the day's segments at a glance, shaded with each project's color. The current work segment grows live as time passes.
- **Interactive iOS widget** – a drop-in [Scriptable](https://scriptable.app) script in `ios/TimeTrackerWidget.js` renders a home-screen tile with live status plus Clock-in / Clock-out / Lunch / Refresh buttons.
- JSON backup/restore, a daily CSV export, and a per-segment CSV export (project + tags columns).
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
   - **Non-working days (default Sat/Sun)** are the exception: every worked minute is routed straight to `extraOutside` (overtime-only), `regular`/`extraInOffice` are always 0, and `shortfall` is always 0. The set of working days is configurable per user in Settings → Work days.
2. Per week (starts on the configured day), days are walked in order:
   - The weekly overtime **target** is configured in **whole minutes** (default 360 = 6h), optionally overridden per week inside the overtime period.
   - Inside the overtime period, the weekly overtime target is filled from `extraOutside` **first** (use-it-or-lose-it — outside hours can never become flex), then from `extraInOffice`. Any leftover `extraInOffice` becomes `flex gain`. Any leftover `extraOutside` is counted as `outsideUnused` and is discarded.
   - Outside the overtime period, all `extraInOffice` becomes flex gain and all `extraOutside` is discarded.
   - `flex net = flex gain - shortfall`.
3. The all-time **flex balance** is the configured opening balance plus `flex gain − shortfall` summed over every *recorded* day (days with no entries never contribute, so weekends and future days don't sink the balance). If **Opening flex applies from** is set, only days on or after that date contribute.
4. **PTO** (Diary → “This day is PTO”): on a **work day**, shortfall is always zero (even if you worked less than the daily target or not at all). With **no work segments**, regular hours are set to your daily target so weekly regular totals treat the day as fully paid off. Overtime and flex still follow your clocked segments when you do record work on a PTO day.

## Settings

Configurable in the Settings view:

| Setting | Purpose |
|---|---|
| Week starts on | Mon / Sun / Sat — affects week grouping everywhere |
| Regular hours per day | Threshold above which hours become "extra" |
| Work days | Which weekdays are working days (default Mon–Fri). Worked time on unchecked days can only fill the weekly overtime target — never becomes regular or flex, and never creates shortfall. The weekly "Regular hours" progress bar target is `regularHoursPerDay × (number of checked days)`. |
| Office hours start / end | Work outside this window can only become overtime — never regular or flex. Leave blank to disable. |
| Weekly overtime target | Default overtime **minutes** per week (integer, 0–10080) before overflowing to flex (default 360 = 6h) |
| Per-week overtime targets | Optional week-by-week overrides in **minutes** within the overtime period (leave blank to use the default) |
| Overtime period start | First day of the ordered-overtime period |
| Overtime period length | Number of weeks the overtime order applies |
| Default lunch | Informational default (currently used as a reference only) |
| Minimum lunch (minutes) | Auto-deduct the missing break from worked hours when the threshold is exceeded. `0` disables the rule. |
| Auto-lunch threshold (hours) | Daily worked time above which the minimum-lunch rule kicks in (default `6h`). |
| Opening flex balance | Your flex balance at the start of "applies from" (e.g. imported from a previous tool) |
| Opening flex applies from | Flex earned on this date and later is summed on top of the opening balance. Days before this date do not contribute (they're assumed to be rolled up in the opening value). Leave blank to sum every recorded day. |
| Default project | Pre-selects this project for new clock-ins (UI and quick-action widgets). Set to `— None —` to always start untagged. |

**PTO** is toggled per calendar day in the **Diary** view (not in Settings). It is stored on that day’s record and appears in CSV export and the weekly summary table.

Project management lives in the same Settings view: create projects with a display color, rename or recolor them inline, archive when they're no longer in use (archived projects still show in historical reports but disappear from the clock-in picker), and delete projects once they have no entries referencing them.

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
  "settings": { "weekStartDay": 1, "regularHoursPerDay": 8, "weeklyOvertimeTargetMinutes": 360, "...": "..." },
  "days": {
    "2026-04-17": {
      "entries": [
        { "id": "uuid", "type": "work",  "start": "08:00", "end": "12:00" },
        { "id": "uuid", "type": "lunch", "start": "12:00", "end": "12:30" },
        { "id": "uuid", "type": "work",  "start": "12:30", "end": "17:30" }
      ],
      "note": "optional",
      "pto": false
    },
    "2026-04-18": {
      "entries": [],
      "pto": true,
      "note": ""
    }
  }
}
```
