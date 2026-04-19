/* smoke-test.js — Black-box smoke test of the running server.
 *
 * Run with the server already up:
 *   node server/server.js &       # in another terminal
 *   node server/smoke-test.js
 *
 * Walks through the full lifecycle the UI exercises:
 *   1. GET / and the JS files (static)
 *   2. GET /api/health, GET /api/state (empty)
 *   3. PUT settings, PUT a day, GET state -> verify
 *   4. PUT empty day -> verify it gets pruned (204)
 *   5. PUT /api/state (import), verify
 *   6. POST /api/reset, verify empty
 */

const BASE = process.env.BASE || 'http://127.0.0.1:8787';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ ' + msg); }
}

async function req(method, path, body) {
  const init = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, init);
  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = text; }
  }
  return { status: res.status, data, headers: res.headers };
}

async function main() {
  console.log('Smoke testing ' + BASE);

  console.log('\n[1] Static');
  let r = await req('GET', '/');
  assert(r.status === 200, 'GET / -> 200');
  assert(typeof r.data === 'string' && r.data.includes('Time Tracker'), 'index has title');
  r = await req('GET', '/js/storage.js');
  assert(r.status === 200, 'GET /js/storage.js -> 200');
  assert(typeof r.data === 'string' && r.data.includes('Storage'), 'storage.js looks right');

  console.log('\n[2] Health & initial state');
  r = await req('GET', '/api/health');
  assert(r.status === 200 && r.data && r.data.ok === true, 'health ok');
  r = await req('GET', '/api/state');
  assert(r.status === 200, 'state -> 200');
  assert(r.data && r.data.version === 1, 'state has version 1');
  assert(r.data && typeof r.data.settings === 'object', 'state has settings');
  assert(r.data && typeof r.data.days === 'object', 'state has days');

  console.log('\n[3] Settings + day upsert');
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

  console.log('\n[4] Empty day prunes');
  r = await req('PUT', '/api/days/2026-04-15', { entries: [], note: '' });
  assert(r.status === 204, 'empty PUT returns 204 (pruned)');
  r = await req('GET', '/api/state');
  assert(!r.data.days['2026-04-15'], 'day removed from state');

  console.log('\n[5] Import via PUT /api/state');
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

  console.log('\n[6] Validation');
  r = await req('PUT', '/api/days/garbage', { entries: [], note: '' });
  assert(r.status === 400, 'bad date -> 400');
  assert(r.data && /Invalid date key/.test(r.data.error), 'bad date error message');

  console.log('\n[7] Reset');
  r = await req('POST', '/api/reset');
  assert(r.status === 200, 'reset -> 200');
  assert(r.data && Object.keys(r.data.days).length === 0, 'days empty after reset');
  assert(r.data && r.data.settings.regularHoursPerDay === 8, 'settings back to defaults after reset');

  console.log('\nResult: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(2);
});
