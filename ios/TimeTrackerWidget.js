// TimeTrackerWidget.js — iOS home-screen widget for the self-hosted
// Flex-1 Time Tracker.
//
// Runs inside https://scriptable.app (free, no account needed). Shows
// live clock-in / lunch / off status plus four tappable tiles:
//   • In       → POST /api/quick/clock-in
//   • Out      → POST /api/quick/clock-out
//   • Lunch    → POST /api/quick/lunch-toggle
//   • ↻        → just refresh the widget
//
// iOS only lets a SMALL widget have one tap target, so on the small
// size the whole tile taps through to a "smart" action:
//   off → clock-in, working → clock-out, lunch → end lunch.
// Medium and large widgets get all four tiles.
//
// Setup:
//   1. Install Scriptable.
//   2. In the web UI go to Settings → Phone widget, create an API
//      token. Copy the ttk_… value; it is shown once.
//   3. Create a new Scriptable script called "TimeTracker" (or any
//      name — the widget keys off Script.name()). Paste this file.
//   4. Run it once inside Scriptable; it prompts for the server base
//      URL (e.g. http://192.168.1.10:8787) and the ttk_… token. Both
//      live in the iOS Keychain afterwards.
//   5. On the home screen: long-press → Edit Home Screen → + →
//      Scriptable → pick "Medium" (recommended) → drop it. Long-press
//      the new widget → Edit Widget → Script = TimeTracker, When
//      Interacting = Run Script.
//
// iOS limitation: tapping any tile must open Scriptable briefly — the
// system cannot run this JavaScript inside the widget itself. After
// each action we call App.close() when available so you hop back to
// the home screen quickly (you may still see a short transition). To
// avoid opening Scriptable at all, use Shortcuts widgets instead (see
// README).
//
// Re-run the script with the "Configure" quick-action (or tap the
// small cog in the widget) to change the server URL or rotate the
// token.
//
// Tokens are limited to /api/quick/*. They cannot read history or
// change the password, so it's safe to store in Keychain.

const KEY_BASE  = "tt.base";
const KEY_TOKEN = "tt.token";
const ACTIONS = {
  "clock-in":    "/api/quick/clock-in",
  "clock-out":   "/api/quick/clock-out",
  "lunch-toggle":"/api/quick/lunch-toggle"
};

// -------- config (Keychain-backed) --------

function hasConfig() {
  return Keychain.contains(KEY_BASE) && Keychain.contains(KEY_TOKEN);
}
function getBase()  { return Keychain.get(KEY_BASE); }
function getToken() { return Keychain.get(KEY_TOKEN); }

async function promptConfig() {
  const a = new Alert();
  a.title = "Time Tracker";
  a.message = "Server URL (e.g. http://192.168.1.10:8787) and API token (ttk_…) from the web Settings.";
  a.addTextField("https://your-server", Keychain.contains(KEY_BASE) ? getBase() : "");
  a.addSecureTextField("ttk_…", Keychain.contains(KEY_TOKEN) ? getToken() : "");
  a.addAction("Save");
  a.addCancelAction("Cancel");
  const idx = await a.present();
  if (idx !== 0) return false;
  const base  = (a.textFieldValue(0) || "").trim().replace(/\/+$/, "");
  const token = (a.textFieldValue(1) || "").trim();
  if (!/^https?:\/\//.test(base)) {
    await alert("Base URL must start with http:// or https://");
    return false;
  }
  if (!/^ttk_/.test(token)) {
    await alert("Token must start with ttk_ — create one in Settings → Phone widget.");
    return false;
  }
  Keychain.set(KEY_BASE, base);
  Keychain.set(KEY_TOKEN, token);
  return true;
}

async function alert(msg) {
  const a = new Alert();
  a.title = "Time Tracker";
  a.message = msg;
  a.addAction("OK");
  await a.present();
}

// -------- HTTP --------

async function api(path, method) {
  const req = new Request(getBase() + path);
  req.method = method || "GET";
  req.timeoutInterval = 8;
  req.headers = {
    Authorization: "Bearer " + getToken(),
    Accept: "application/json"
  };
  let data;
  try { data = await req.loadJSON(); } catch (_) { data = null; }
  return {
    status: req.response ? req.response.statusCode : 0,
    data
  };
}

async function fetchStatus() {
  try {
    const r = await api("/api/quick/status", "GET");
    if (r.status === 200) return { ok: true, status: r.data };
    if (r.status === 401) return { ok: false, error: "token rejected — reconfigure" };
    return { ok: false, error: "HTTP " + r.status };
  } catch (e) {
    return { ok: false, error: "no network" };
  }
}

// -------- URL scheme dispatch --------

function scriptURL(action) {
  const name = encodeURIComponent(Script.name());
  return `scriptable:///run/${name}?action=${encodeURIComponent(action)}`;
}

async function doAction(action) {
  const path = ACTIONS[action];
  if (!path) return;
  try {
    const r = await api(path, "POST");
    if (r.status !== 200) {
      const msg = (r.data && r.data.error) || ("HTTP " + r.status);
      await notify("Time Tracker — failed", msg);
    }
    // Success path: no notification; the widget auto-refreshes
    // shortly and the user sees the new state there.
  } catch (e) {
    await notify("Time Tracker — error", String(e.message || e));
  }
}

async function smartAction(status) {
  // Used by the SMALL widget (single tap target).
  if (!status) return doAction("clock-in");
  switch (status.state) {
    case "off":     return doAction("clock-in");
    case "working": return doAction("clock-out");
    case "lunch":   return doAction("lunch-toggle");
    default:        return doAction("clock-in");
  }
}

async function notify(title, body) {
  const n = new Notification();
  n.title = title;
  n.body = body;
  await n.schedule();
}

/**
 * After a widget tap, Scriptable has to come to the foreground. When
 * the runtime exposes App.close(), use it so iOS returns you to the
 * home screen right away (still a brief flash — unavoidable).
 */
function collapseHostApp() {
  try {
    if (typeof App !== "undefined" && typeof App.close === "function") {
      App.close();
    }
  } catch (_) {
    /* App.close is undocumented / may be absent on some versions */
  }
}

// -------- widget layout --------

const COLORS = {
  bg:         new Color("#171a21"),
  bgSecond:   new Color("#22262f"),
  border:     new Color("#2a2f3a"),
  text:       new Color("#e7e9ee"),
  dim:        new Color("#9aa3b2"),
  muted:      new Color("#6b7383"),
  primary:    new Color("#4f8cff"),
  working:    new Color("#3ecf8e"),
  lunch:      new Color("#f5a623"),
  off:        new Color("#6b7383"),
  danger:     new Color("#ef5350"),
  tileBg:     new Color("#1f2430"),
  tileBgWork: new Color("#284835"),
  tileBgOff:  new Color("#3a2828"),
  tileBgLunch:new Color("#3e3419")
};

function stateColor(state) {
  if (state === "working") return COLORS.working;
  if (state === "lunch")   return COLORS.lunch;
  return COLORS.off;
}

function stateLabel(state) {
  if (state === "working") return "Clocked in";
  if (state === "lunch")   return "On lunch";
  return "Off";
}

function fmtElapsed(since, nowDate) {
  if (!since || !/^\d{2}:\d{2}$/.test(since)) return "";
  const [h, m] = since.split(":").map(Number);
  const d = nowDate || new Date();
  const start = new Date(d);
  start.setHours(h, m, 0, 0);
  let diffMin = Math.max(0, Math.floor((d - start) / 60000));
  const hh = Math.floor(diffMin / 60);
  const mm = diffMin % 60;
  return hh + "h " + (mm < 10 ? "0" + mm : mm) + "m";
}

function addTile(parent, label, color, bg, url, big) {
  const tile = parent.addStack();
  tile.layoutVertically();
  tile.cornerRadius = 10;
  tile.backgroundColor = bg;
  tile.size = new Size(0, big ? 44 : 36);
  tile.setPadding(6, 6, 6, 6);
  tile.url = url;

  const row = tile.addStack();
  row.addSpacer();
  const t = row.addText(label);
  t.font = Font.semiboldSystemFont(big ? 16 : 13);
  t.textColor = color;
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.7;
  row.addSpacer();
  return tile;
}

function addStatusBlock(parent, state, since, project, error, now) {
  const block = parent.addStack();
  block.layoutVertically();
  block.spacing = 2;

  const topRow = block.addStack();
  topRow.centerAlignContent();
  const dot = topRow.addText("●");
  dot.font = Font.mediumSystemFont(14);
  dot.textColor = error ? COLORS.danger : stateColor(state);
  topRow.addSpacer(6);
  const stateTxt = topRow.addText(error ? "Offline" : stateLabel(state));
  stateTxt.font = Font.semiboldSystemFont(17);
  stateTxt.textColor = COLORS.text;
  stateTxt.lineLimit = 1;
  stateTxt.minimumScaleFactor = 0.7;

  if (error) {
    const msg = block.addText(error);
    msg.font = Font.systemFont(11);
    msg.textColor = COLORS.danger;
    msg.lineLimit = 2;
    msg.minimumScaleFactor = 0.7;
    return;
  }

  if (state === "off") {
    const sub = block.addText("Ready when you are");
    sub.font = Font.systemFont(11);
    sub.textColor = COLORS.dim;
    return;
  }

  if (since) {
    const sub = block.addText("Since " + since);
    sub.font = Font.systemFont(11);
    sub.textColor = COLORS.dim;
    const elapsed = fmtElapsed(since, now);
    if (elapsed) {
      const big = block.addText(elapsed);
      big.font = Font.mediumRoundedSystemFont(20);
      big.textColor = state === "lunch" ? COLORS.lunch : COLORS.working;
      big.lineLimit = 1;
      big.minimumScaleFactor = 0.6;
    }
  }
  if (project) {
    const pr = block.addText("· " + project);
    pr.font = Font.systemFont(11);
    pr.textColor = COLORS.primary;
    pr.lineLimit = 1;
    pr.minimumScaleFactor = 0.7;
  }
}

function projectFrom(status) {
  if (!status || !status.project) return null;
  return status.project.name || null;
}

function buildSmallWidget(w, status, error) {
  w.setPadding(12, 12, 12, 12);
  // Entire small widget = single tap target.
  w.url = error ? scriptURL("configure") : scriptURL(
    status && status.state === "working" ? "clock-out"
      : status && status.state === "lunch" ? "lunch-toggle"
      : "clock-in"
  );
  addStatusBlock(w, status && status.state, status && status.since,
    projectFrom(status), error, new Date());
  w.addSpacer();
  const hint = w.addText(
    error ? "Tap to configure" :
    status && status.state === "working" ? "Tap to clock out" :
    status && status.state === "lunch"   ? "Tap to end lunch" :
                                           "Tap to clock in"
  );
  hint.font = Font.systemFont(11);
  hint.textColor = COLORS.muted;
  hint.centerAlignText();
}

function buildMediumWidget(w, status, error) {
  w.setPadding(10, 12, 10, 12);

  const container = w.addStack();
  container.layoutHorizontally();
  container.spacing = 10;

  // Left: status block (roughly 55% of the width).
  const left = container.addStack();
  left.layoutVertically();
  left.size = new Size(150, 0);
  addStatusBlock(left, status && status.state, status && status.since,
    projectFrom(status), error, new Date());
  left.addSpacer();
  const tiny = left.addStack();
  tiny.layoutHorizontally();
  const cog = tiny.addText("⚙︎ Configure");
  cog.font = Font.systemFont(10);
  cog.textColor = COLORS.muted;
  tiny.url = scriptURL("configure");

  // Right: 2x2 action grid.
  const right = container.addStack();
  right.layoutVertically();
  right.spacing = 6;

  const rowTop = right.addStack();
  rowTop.layoutHorizontally();
  rowTop.spacing = 6;
  addTile(rowTop, "In",    COLORS.working, COLORS.tileBgWork, scriptURL("clock-in"));
  addTile(rowTop, "Lunch", COLORS.lunch,   COLORS.tileBgLunch, scriptURL("lunch-toggle"));

  const rowBot = right.addStack();
  rowBot.layoutHorizontally();
  rowBot.spacing = 6;
  addTile(rowBot, "Out",   COLORS.danger,  COLORS.tileBgOff,  scriptURL("clock-out"));
  addTile(rowBot, "↻",     COLORS.dim,     COLORS.tileBg,     scriptURL("refresh"));
}

function buildLargeWidget(w, status, error) {
  w.setPadding(16, 16, 16, 16);
  addStatusBlock(w, status && status.state, status && status.since,
    projectFrom(status), error, new Date());

  if (status && status.today) {
    const t = w.addText(
      "Worked today: " + (status.today.workedHours || 0).toFixed(2) + " h" +
      "   Lunch: " + (status.today.lunchHours || 0).toFixed(2) + " h"
    );
    t.font = Font.systemFont(12);
    t.textColor = COLORS.dim;
  }

  w.addSpacer();

  const row1 = w.addStack();
  row1.layoutHorizontally();
  row1.spacing = 8;
  addTile(row1, "Clock in",  COLORS.working, COLORS.tileBgWork, scriptURL("clock-in"), true);
  addTile(row1, "Clock out", COLORS.danger,  COLORS.tileBgOff,  scriptURL("clock-out"), true);

  w.addSpacer(8);

  const row2 = w.addStack();
  row2.layoutHorizontally();
  row2.spacing = 8;
  addTile(row2, "Lunch",   COLORS.lunch,   COLORS.tileBgLunch, scriptURL("lunch-toggle"), true);
  addTile(row2, "Refresh", COLORS.dim,     COLORS.tileBg,      scriptURL("refresh"), true);
}

async function buildWidget() {
  const w = new ListWidget();
  w.backgroundColor = COLORS.bg;
  w.refreshAfterDate = new Date(Date.now() + 60 * 1000); // hint to iOS

  let status = null;
  let error = null;
  if (!hasConfig()) {
    error = "Not configured";
  } else {
    const r = await fetchStatus();
    if (r.ok) status = r.status; else error = r.error;
  }

  const family = (typeof config !== "undefined" && config.widgetFamily) || "medium";
  if (family === "small")       buildSmallWidget(w, status, error);
  else if (family === "large")  buildLargeWidget(w, status, error);
  else                          buildMediumWidget(w, status, error);

  return w;
}

// -------- entry point --------

async function main() {
  const action = args.queryParameters && args.queryParameters.action;

  // First-run: make sure we have config before anything else. In
  // widget context we can't prompt, so we just render an error tile.
  if (!hasConfig() && !config.runsInWidget) {
    const ok = await promptConfig();
    if (!ok) return;
  }

  if (config.runsInWidget) {
    const w = await buildWidget();
    Script.setWidget(w);
    Script.complete();
    return;
  }

  // Running from a widget tap or manually inside the Scriptable app.
  if (action === "configure") {
    await promptConfig();
    Script.complete();
    collapseHostApp();
    return;
  }
  if (action === "smart") {
    const r = await fetchStatus();
    await smartAction(r.ok ? r.status : null);
    Script.complete();
    collapseHostApp();
    return;
  }
  if (action && ACTIONS[action]) {
    await doAction(action);
    Script.complete();
    collapseHostApp();
    return;
  }
  if (action === "refresh") {
    // Widget "↻" — rebuild snapshot and dismiss; do not presentMedium()
    // (that would trap you inside Scriptable).
    const w = await buildWidget();
    Script.setWidget(w);
    Script.complete();
    collapseHostApp();
    return;
  }
  if (!action) {
    // ▶︎ inside Scriptable with no ?action= — preview layout only.
    const w = await buildWidget();
    await w.presentMedium();
    Script.complete();
    return;
  }
}

await main();
