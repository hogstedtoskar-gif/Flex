# Time Tracker

A lightweight, single-user, fully-local web app for tracking working hours with clean separation of **regular time**, **ordered overtime**, and **flex balance**.

No build step, no dependencies, no cloud. Everything is stored in your browser's `localStorage`.

## Run it

Open `index.html` directly in a modern browser (Chrome, Edge, Firefox, Safari). Double-clicking the file is enough. Bookmark it for quick daily access.

If you'd rather serve it locally (optional):

```bash
# Python 3
python -m http.server 8080
# then visit http://localhost:8080
```

## Keyboard shortcuts

- `I` - Clock in
- `O` - Clock out
- `L` - Start/end lunch (depending on current state)
- `1` / `2` / `3` / `4` - Switch to Dashboard / Diary / Summary / Settings

## Features

- Clock in/out and lunch start/end buttons with a state machine that prevents invalid actions.
- Manual entry and editing of every segment in the Diary view.
- Per-day calculation of worked, regular, extra, lunch, and shortfall hours.
- Weekly allocation: overtime is filled up to the configured weekly target; the rest flows into flex.
- Overtime period tracking with per-week progress bars and total filled vs required.
- All-time flex balance (positive surplus or negative deficit).
- Weekly and monthly summaries with inline bar charts.
- JSON backup/restore and CSV export.
- Overlap and validation errors are highlighted in the Diary view.
- Alerts for past days with an unfinished clock-out.
- Dark and light themes follow your OS preference.

## How overtime & flex are computed

1. For each day: `worked = sum(work segments)`, lunch is never counted. `regular = min(worked, dailyHours)`, `extra = max(0, worked - dailyHours)`, `shortfall = max(0, dailyHours - worked)`.
2. For each week (starts on the configured day):
   - If the week falls inside the configured overtime period, days are walked in order and `extra` hours fill the weekly overtime target first. Anything beyond the target becomes `flex gain`.
   - Outside the period, all `extra` goes straight to flex.
   - `flex net = flex gain - shortfall`.
3. The all-time **flex balance** is the sum of `flex net` across every week that has recorded data.

## Settings

All of the following are configurable in the Settings view:

| Setting | Purpose |
|---|---|
| Week starts on | Mon / Sun / Sat - affects week grouping everywhere |
| Regular hours per day | Threshold above which hours become "extra" |
| Weekly overtime target | How many extra hours per week count as ordered overtime before overflowing to flex |
| Overtime period start | First day of the ordered-overtime period |
| Overtime period length | Number of weeks the overtime order applies |
| Default lunch | Informational default (currently used as a reference only) |

## Data & backups

All data lives in a single `localStorage` key named `timetracker.v1`.

- **Export JSON backup** - full snapshot (recommended before any risky action).
- **Export CSV** - one row per day with all computed fields, suitable for Excel.
- **Import JSON** - replaces all data after confirmation.
- **Reset all data** - wipes `localStorage` for the app.

The JSON shape:

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

## File layout

```
index.html       Tab shell and view templates
styles.css       Styling, dark + light
js/calc.js       Pure time-math (no DOM)
js/storage.js    localStorage + JSON/CSV I/O
js/ui.js         DOM helpers, toasts, charts
js/app.js        Router, state, event wiring
```
