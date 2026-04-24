/* smoke-test.js — Black-box smoke test of the running server.
 *
 * Run with the server already up. The server needs registration
 * enabled (ALLOW_REGISTRATION=1) so the test can create a throw-away
 * user, or set SMOKE_USERNAME / SMOKE_PASSWORD to log in as an
 * existing account.
 *
 *   ALLOW_REGISTRATION=1 node server/server.js &    # in another terminal
 *   node server/smoke-test.js
 *
 * Walks through the full lifecycle the UI exercises:
 *   1. GET / and the JS files (static)
 *   2. GET /api/health, confirm /api/state requires auth
 *   3. register / login, verify /me and cookie
 *   4. PUT settings, PUT a day, GET state -> verify
 *   5. PUT empty day -> verify it gets pruned (204)
 *   6. PUT /api/state (import), verify
 *   7. POST /api/reset, verify empty
 *   8. API tokens: create/list/use/revoke + bearer scope enforcement
 *   9. Quick actions: clock-in / lunch-toggle / clock-out state machine
 *  10. PWA assets: manifest + service worker are reachable
 *  11. logout -> /api/state 401
 */

const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const SMOKE_USERNAME = process.env.SMOKE_USERNAME
  || ('smoke_' + Math.random().toString(36).slice(2, 8));
const SMOKE_PASSWORD = process.env.SMOKE_PASSWORD || 'smoke-password-123';

let passed = 0;
let failed = 0;
let cookieJar = '';

function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ ' + msg); }
}

/**
 * Static parity check: server/db.js and public/js/storage.js both
 * declare a `DEFAULT_SETTINGS` object. If the two drift, the client
 * briefly renders stale defaults before the first /api/state response
 * arrives. This check runs before we touch the network so it fails
 * fast even if the server isn't up.
 */
function checkDefaultsParity() {
  console.log('\n[0] Default-settings parity (server vs client)');
  const repoRoot = path.join(__dirname, '..');
  const dbPath = path.join(repoRoot, 'server', 'db.js');
  const storagePath = path.join(repoRoot, 'public', 'js', 'storage.js');

  function extractDefaultKeys(filePath) {
    const src = fs.readFileSync(filePath, 'utf8');
    const startIdx = src.indexOf('DEFAULT_SETTINGS = {');
    if (startIdx < 0) throw new Error('No DEFAULT_SETTINGS in ' + filePath);
    const from = src.indexOf('{', startIdx);
    // Balanced-brace scan to find the matching close.
    let depth = 0;
    let end = -1;
    for (let i = from; i < src.length; i++) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) throw new Error('Unbalanced braces in ' + filePath);
    let body = src.slice(from + 1, end);
    // Strip comments before string/brace parsing so a comment like
    // "Office hours window: ..." doesn't masquerade as a setting key.
    body = body.replace(/\/\*[\s\S]*?\*\//g, ' ');
    body = body.replace(/(^|[^:])\/\/.*$/gm, (match, prefix) => prefix + ' ');
    // Grab top-level `identifier:` patterns. This is a naive parser,
    // but our DEFAULT_SETTINGS only uses simple literal keys.
    const keys = new Set();
    const noStrings = body.replace(/'(?:\\.|[^'\\])*'/g, '""').replace(/"(?:\\.|[^"\\])*"/g, '""');
    // Strip nested objects/arrays at depth > 0 so we only see top-level keys.
    let d = 0; let stripped = '';
    for (const ch of noStrings) {
      if (ch === '{' || ch === '[') { d++; stripped += ' '; continue; }
      if (ch === '}' || ch === ']') { d--; stripped += ' '; continue; }
      stripped += d === 0 ? ch : ' ';
    }
    const re = /([A-Za-z_$][\w$]*)\s*:/g;
    let m;
    while ((m = re.exec(stripped)) !== null) keys.add(m[1]);
    return keys;
  }

  try {
    const serverKeys = extractDefaultKeys(dbPath);
    const clientKeys = extractDefaultKeys(storagePath);
    const missingOnClient = [...serverKeys].filter((k) => !clientKeys.has(k));
    const missingOnServer = [...clientKeys].filter((k) => !serverKeys.has(k));
    assert(
      missingOnClient.length === 0 && missingOnServer.length === 0,
      'DEFAULT_SETTINGS keys match between server/db.js and public/js/storage.js'
    );
    if (missingOnClient.length) console.error('     missing on client:', missingOnClient.join(', '));
    if (missingOnServer.length) console.error('     missing on server:', missingOnServer.join(', '));
  } catch (err) {
    failed++;
    console.error('  ✗ parity check crashed: ' + err.message);
  }
}

async function req(method, path, body, extraHeaders) {
  const init = { method, headers: { Accept: 'application/json' } };
  if (cookieJar) init.headers.Cookie = cookieJar;
  if (extraHeaders) Object.assign(init.headers, extraHeaders);
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, init);
  const set = res.headers.get('set-cookie');
  if (set) {
    // fetch() gives us a single combined header; grab each name=value pair.
    const m = set.match(/tt_session=[^;]*/);
    if (m) cookieJar = m[0];
  }
  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = text; }
  }
  return { status: res.status, data, headers: res.headers };
}

async function main() {
  console.log('Smoke testing ' + BASE);

  checkDefaultsParity();

  console.log('\n[1] Static');
  let r = await req('GET', '/');
  assert(r.status === 200, 'GET / -> 200');
  assert(typeof r.data === 'string' && r.data.includes('Time Tracker'), 'index has title');
  r = await req('GET', '/js/storage.js');
  assert(r.status === 200, 'GET /js/storage.js -> 200');
  assert(typeof r.data === 'string' && r.data.includes('Storage'), 'storage.js looks right');

  console.log('\n[2] Health & auth gate');
  r = await req('GET', '/api/health');
  assert(r.status === 200 && r.data && r.data.ok === true, 'health ok (public)');
  r = await req('GET', '/api/state');
  assert(r.status === 401, '/api/state without session -> 401');
  r = await req('GET', '/api/auth/me');
  assert(r.status === 401, '/api/auth/me unauthenticated -> 401');

  console.log('\n[3] Register / login');
  const cfg = await req('GET', '/api/auth/config');
  const canRegister = cfg.data && cfg.data.allowRegistration;
  if (canRegister && !process.env.SMOKE_USERNAME) {
    r = await req('POST', '/api/auth/register', {
      username: SMOKE_USERNAME, password: SMOKE_PASSWORD
    });
    assert(r.status === 201 && r.data.user.username === SMOKE_USERNAME, 'register -> 201');
  } else {
    r = await req('POST', '/api/auth/login', {
      username: SMOKE_USERNAME, password: SMOKE_PASSWORD
    });
    assert(r.status === 200 && r.data.user, 'login -> 200 (set SMOKE_USERNAME/PASSWORD for existing user)');
  }
  assert(/^tt_session=/.test(cookieJar), 'session cookie captured');
  r = await req('GET', '/api/auth/me');
  assert(r.status === 200 && r.data.user.username === SMOKE_USERNAME, '/me returns current user');

  console.log('\n[4] Settings + day upsert');
  r = await req('PUT', '/api/settings', {
    weekStartDay: 1,
    regularHoursPerDay: 7.5,
    weeklyOvertimeTargetHours: 5,
    overtimePeriodStart: '2026-04-13',
    overtimePeriodWeeks: 4,
    defaultLunchMinutes: 30,
    flexOpeningBalance: 1.25,
    flexOpeningDate: ''
  });
  assert(r.status === 200 && r.data.regularHoursPerDay === 7.5, 'settings saved');

  const day = {
    entries: [
      { id: 'a', type: 'work',  start: '08:00', end: '12:00' },
      { id: 'b', type: 'lunch', start: '12:00', end: '12:30' },
      { id: 'c', type: 'work',  start: '12:30', end: '17:00' }
    ],
    note: 'smoke'
  };
  r = await req('PUT', '/api/days/2026-04-15', day);
  assert(r.status === 200, 'PUT day -> 200');
  assert(r.data && Array.isArray(r.data.entries) && r.data.entries.length === 3, 'PUT echoed 3 entries');

  r = await req('GET', '/api/state');
  const stored = r.data.days['2026-04-15'];
  assert(stored && stored.entries.length === 3, 'state has 3 entries for the day');
  assert(stored.note === 'smoke', 'note round-trips');
  assert(stored.entries[1].type === 'lunch', 'lunch entry type preserved');
  assert(r.data.settings.flexOpeningBalance === 1.25, 'settings still applied');

  console.log('\n[5] Empty day prunes');
  r = await req('PUT', '/api/days/2026-04-15', { entries: [], note: '' });
  assert(r.status === 204, 'empty PUT returns 204 (pruned)');
  r = await req('GET', '/api/state');
  assert(!r.data.days['2026-04-15'], 'day removed from state');

  console.log('\n[6] Import via PUT /api/state');
  const importPayload = {
    version: 1,
    settings: { weekStartDay: 0, regularHoursPerDay: 6, weeklyOvertimeTargetHours: 0,
      overtimePeriodStart: '', overtimePeriodWeeks: 0, defaultLunchMinutes: 0,
      flexOpeningBalance: 0, flexOpeningDate: '' },
    days: {
      '2026-04-10': { entries: [{ id: 'x', type: 'work', start: '09:00', end: '15:00' }], note: '' }
    }
  };
  r = await req('PUT', '/api/state', importPayload);
  assert(r.status === 200, 'import returns 200');
  assert(r.data.days['2026-04-10'] && r.data.days['2026-04-10'].entries[0].id === 'x', 'imported day present');
  assert(r.data.settings.regularHoursPerDay === 6, 'imported settings present');

  console.log('\n[7] Validation');
  r = await req('PUT', '/api/days/garbage', { entries: [], note: '' });
  assert(r.status === 400, 'bad date -> 400');
  assert(r.data && /Invalid date key/.test(r.data.error), 'bad date error message');

  console.log('\n[8] API tokens + bearer scope');
  // Fresh slate so the state-machine tests start clean.
  r = await req('POST', '/api/reset');
  assert(r.status === 200, 'pre-tokens reset -> 200');

  r = await req('POST', '/api/auth/tokens', { label: 'smoke widget' });
  assert(r.status === 201, 'create token -> 201');
  assert(r.data && typeof r.data.token === 'string' && r.data.token.startsWith('ttk_'), 'token has ttk_ prefix');
  const token = r.data.token;
  const tokenId = r.data.id;

  r = await req('GET', '/api/auth/tokens');
  assert(r.status === 200 && Array.isArray(r.data.tokens) && r.data.tokens.length >= 1, 'list tokens');
  assert(r.data.tokens.find((t) => t.id === tokenId && t.label === 'smoke widget'), 'created token is in list');
  // Tokens list must never leak plaintext.
  assert(!JSON.stringify(r.data).includes(token), 'list does not leak plaintext');

  const savedCookie = cookieJar;
  cookieJar = '';

  r = await req('GET', '/api/auth/me', undefined, { Authorization: 'Bearer ' + token });
  assert(r.status === 401, 'bearer token cannot access /auth/me');

  r = await req('POST', '/api/auth/tokens', { label: 'x' }, { Authorization: 'Bearer ' + token });
  assert(r.status === 401 || r.status === 403, 'bearer token cannot create more tokens');

  r = await req('GET', '/api/state', undefined, { Authorization: 'Bearer ' + token });
  assert(r.status === 401, 'bearer token cannot read /api/state');

  console.log('\n[9] Quick state machine (via bearer token)');
  r = await req('GET', '/api/quick/status', undefined, { Authorization: 'Bearer ' + token });
  assert(r.status === 200, 'GET /quick/status (bearer) -> 200');
  assert(r.data.state === 'off', 'initial state is off');

  r = await req('POST', '/api/quick/clock-in?tz=UTC&time=08:00', undefined, { Authorization: 'Bearer ' + token });
  assert(r.status === 200 && r.data.state === 'working', 'clock-in -> working');

  r = await req('POST', '/api/quick/clock-in?tz=UTC&time=08:05', undefined, { Authorization: 'Bearer ' + token });
  assert(r.status === 409, 'double clock-in -> 409');

  r = await req('POST', '/api/quick/lunch-toggle?tz=UTC&time=12:00', undefined, { Authorization: 'Bearer ' + token });
  assert(r.status === 200 && r.data.state === 'lunch', 'lunch-toggle from working -> lunch');

  r = await req('POST', '/api/quick/lunch-toggle?tz=UTC&time=12:30', undefined, { Authorization: 'Bearer ' + token });
  assert(r.status === 200 && r.data.state === 'working', 'lunch-toggle from lunch -> working');

  r = await req('POST', '/api/quick/clock-out?tz=UTC&time=17:00', undefined, { Authorization: 'Bearer ' + token });
  assert(r.status === 200 && r.data.state === 'off', 'clock-out -> off');
  assert(r.data.today && r.data.today.workedHours >= 8, 'worked hours computed');

  r = await req('POST', '/api/quick/clock-out?tz=UTC&time=18:00', undefined, { Authorization: 'Bearer ' + token });
  assert(r.status === 409, 'double clock-out -> 409');

  console.log('\n[10] PWA assets reachable');
  r = await req('GET', '/manifest.webmanifest');
  assert(r.status === 200, 'manifest.webmanifest -> 200');
  assert(r.data && (r.data.start_url || (typeof r.data === 'string' && r.data.includes('start_url'))), 'manifest has start_url');
  r = await req('GET', '/sw.js');
  assert(r.status === 200 && typeof r.data === 'string' && r.data.includes('CACHE_VERSION'), 'sw.js reachable and looks right');
  r = await req('GET', '/icons/icon.svg');
  assert(r.status === 200, 'icon.svg -> 200');

  // Revoke + confirm bearer no longer works.
  cookieJar = savedCookie;
  r = await req('DELETE', '/api/auth/tokens/' + tokenId);
  assert(r.status === 204, 'revoke token -> 204');
  cookieJar = '';
  r = await req('POST', '/api/quick/clock-in?tz=UTC&time=09:00', undefined, { Authorization: 'Bearer ' + token });
  assert(r.status === 401, 'revoked token -> 401');

  // Restore session for the remaining tests.
  cookieJar = savedCookie;

  console.log('\n[11] Projects CRUD + tags on entries');
  r = await req('GET', '/api/projects');
  assert(r.status === 200 && Array.isArray(r.data.projects), 'GET /api/projects -> 200');
  assert(r.data.projects.length === 0, 'no projects for fresh user');

  r = await req('POST', '/api/projects', { name: 'Alpha', color: '#ff8800' });
  assert(r.status === 201 && r.data && r.data.name === 'Alpha', 'create project Alpha -> 201');
  const projAlphaId = r.data.id;
  assert(r.data.color === '#ff8800', 'color persisted');

  r = await req('POST', '/api/projects', { name: 'Alpha' });
  assert(r.status === 409 || r.status === 400, 'duplicate project name rejected');

  r = await req('POST', '/api/projects', { name: 'Beta', color: 'not-a-color' });
  assert(
    r.status === 400
      || (r.status === 201 && (r.data.color === null || r.data.color === '')),
    'invalid color rejected or coerced to empty'
  );

  r = await req('POST', '/api/projects', { name: 'Beta', color: '#00aaff' });
  assert(r.status === 201 || r.status === 409, 'create project Beta handled');
  let projBetaId = (r.status === 201 && r.data) ? r.data.id : null;
  if (!projBetaId) {
    const list = await req('GET', '/api/projects');
    const beta = list.data.projects.find((p) => p.name === 'Beta');
    projBetaId = beta && beta.id;
  }
  assert(projBetaId, 'Beta project id resolved');

  r = await req('GET', '/api/projects');
  assert(r.data.projects.length >= 2, 'list has at least 2 projects');

  r = await req('PATCH', '/api/projects/' + projBetaId, { name: 'Beta Prime', color: '#44ee99' });
  assert(r.status === 200 && r.data.name === 'Beta Prime', 'rename project');

  r = await req('PATCH', '/api/projects/' + projBetaId, { archived: true });
  assert(r.status === 200 && r.data.archived === true, 'archive project');

  const tagDay = {
    entries: [
      { id: 'pa', type: 'work',  start: '08:00', end: '10:00',
        projectId: projAlphaId, tags: ['deep-work', 'api'] },
      { id: 'pl', type: 'lunch', start: '10:00', end: '10:30' },
      { id: 'pb', type: 'work',  start: '10:30', end: '12:00',
        projectId: projAlphaId, tags: ['review'] }
    ],
    note: ''
  };
  r = await req('PUT', '/api/days/2026-04-20', tagDay);
  assert(r.status === 200, 'PUT day with project+tags -> 200');
  assert(r.data && r.data.entries[0].projectId === projAlphaId, 'projectId round-trips');
  assert(
    Array.isArray(r.data.entries[0].tags) && r.data.entries[0].tags.includes('deep-work'),
    'tags round-trip'
  );
  const lunch = r.data.entries.find((e) => e.type === 'lunch');
  assert(!lunch.projectId && !(lunch.tags && lunch.tags.length), 'lunch segments have no project/tags');

  const bogusDay = {
    entries: [{
      id: 'bg', type: 'work', start: '09:00', end: '10:00',
      projectId: 999999, tags: ['x']
    }],
    note: ''
  };
  r = await req('PUT', '/api/days/2026-04-21', bogusDay);
  assert(r.status === 200, 'PUT day with unknown projectId -> 200');
  assert(r.data.entries[0].projectId == null, 'unknown projectId stripped');

  r = await req('DELETE', '/api/projects/' + projAlphaId);
  assert(r.status === 409 || r.status === 400, 'cannot delete referenced project');

  await req('PUT', '/api/days/2026-04-20', { entries: [], note: '' });
  await req('PUT', '/api/days/2026-04-21', { entries: [], note: '' });
  r = await req('DELETE', '/api/projects/' + projAlphaId);
  assert(r.status === 204 || r.status === 200, 'delete unreferenced project');

  r = await req('GET', '/api/state');
  assert(Array.isArray(r.data.projects), '/api/state returns projects[]');

  // Quick clock-in carries projectId when passed
  r = await req('POST', '/api/auth/tokens', { label: 'smoke proj' });
  assert(r.status === 201, 'create token for project quick test');
  const projToken = r.data.token;
  const projTokenId = r.data.id;

  const headersProj = { Authorization: 'Bearer ' + projToken };
  r = await req('POST',
    '/api/quick/clock-in?tz=UTC&time=09:00&project=' + projBetaId + '&tags=focus,proj',
    undefined, headersProj);
  assert(r.status === 200 && r.data.state === 'working', 'quick clock-in with project -> working');
  assert(r.data.project && r.data.project.id === projBetaId,
    'status snapshot includes active project');
  assert(Array.isArray(r.data.tags) && r.data.tags.includes('focus'),
    'status snapshot includes active tags');
  r = await req('POST', '/api/quick/clock-out?tz=UTC&time=10:30', undefined, headersProj);
  assert(r.status === 200 && r.data.state === 'off', 'quick clock-out -> off');
  assert(r.data.project === null && r.data.tags === null,
    'project + tags null after clock-out');

  r = await req('GET', '/api/state');
  const pdKeys = Object.keys(r.data.days);
  const lastKey = pdKeys.sort()[pdKeys.length - 1];
  const projEntry = r.data.days[lastKey].entries.find((e) => e.type === 'work' && e.end);
  assert(projEntry && projEntry.projectId === projBetaId, 'quick-action segment carries projectId');
  assert(projEntry && Array.isArray(projEntry.tags) && projEntry.tags.includes('focus'),
    'quick-action segment carries tags');

  await req('DELETE', '/api/auth/tokens/' + projTokenId);

  console.log('\n[12] Reset + logout');
  r = await req('POST', '/api/reset');
  assert(r.status === 200, 'reset -> 200');
  assert(r.data && Object.keys(r.data.days).length === 0, 'days empty after reset');
  assert(r.data && r.data.settings.regularHoursPerDay === 8, 'settings back to defaults after reset');
  assert(r.data && Array.isArray(r.data.projects) && r.data.projects.length === 0,
    'projects cleared after reset');

  r = await req('POST', '/api/auth/logout');
  assert(r.status === 204, 'logout -> 204');
  cookieJar = '';
  r = await req('GET', '/api/state');
  assert(r.status === 401, 'after logout /api/state -> 401');

  console.log('\nResult: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(2);
});
