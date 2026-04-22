#!/usr/bin/env node
/* admin.js — CLI for user management.
 *
 * Usage (run inside the server/ directory or with any CWD):
 *   node server/admin.js list-users
 *   node server/admin.js add-user <username> [password]
 *   node server/admin.js set-password <username> [password]
 *   node server/admin.js rename-user <oldName> <newName>
 *   node server/admin.js delete-user <username>
 *
 * If [password] is omitted, it is read from stdin without echo (when
 * the terminal supports it).
 *
 * DATA_DIR env var overrides where timetracker.db lives (defaults to
 * ./data relative to this file, matching server.js).
 */

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { open } = require('./db');
const auth = require('./auth');

// Resolve the DB path. Honor DATA_DIR when set (same knob as server.js).
// Otherwise try the local dev default first, then the standard deploy
// location so `sudo -u timetracker node .../admin.js ...` just works on
// an installed LXC without having to remember an env var.
const CANDIDATE_DIRS = process.env.DATA_DIR
  ? [path.resolve(process.env.DATA_DIR)]
  : [
      path.join(__dirname, 'data'),      // local dev
      '/var/lib/timetracker'              // deploy/install.sh default
    ];

let DB_PATH = null;
for (const dir of CANDIDATE_DIRS) {
  const candidate = path.join(dir, 'timetracker.db');
  if (fs.existsSync(candidate)) { DB_PATH = candidate; break; }
}
// If nothing was found, fall through with the first candidate so the
// error message below tells the user where we looked.
if (!DB_PATH) DB_PATH = path.join(CANDIDATE_DIRS[0], 'timetracker.db');

function help(exitCode = 0) {
  const usage = [
    'Usage:',
    '  node server/admin.js list-users',
    '  node server/admin.js add-user <username> [password]',
    '  node server/admin.js set-password <username> [password]',
    '  node server/admin.js rename-user <oldName> <newName>',
    '  node server/admin.js delete-user <username>'
  ].join('\n');
  (exitCode === 0 ? console.log : console.error)(usage);
  process.exit(exitCode);
}

async function readSecret(prompt) {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isTTY && stdin.isRaw;
    if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          if (stdin.setRawMode) stdin.setRawMode(!!wasRaw);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(buf);
          return;
        }
        if (c === '\u0003') { // Ctrl+C
          process.stdout.write('\n');
          process.exit(130);
        }
        if (c === '\u007f' || c === '\b') {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function getPassword(passwordArg, confirm) {
  if (passwordArg) return passwordArg;
  const p1 = await readSecret('Password: ');
  if (!confirm) return p1;
  const p2 = await readSecret('Confirm:  ');
  if (p1 !== p2) {
    console.error('Passwords do not match.');
    process.exit(1);
  }
  return p1;
}

function requireDb() {
  if (!fs.existsSync(DB_PATH)) {
    const searched = CANDIDATE_DIRS.map((d) => '  - ' + path.join(d, 'timetracker.db')).join('\n');
    console.error(
      'No timetracker.db found. Looked in:\n' + searched +
      '\nStart the server once first, or set DATA_DIR=/path/to/data.'
    );
    process.exit(1);
  }
  return open(DB_PATH);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '-h' || cmd === '--help') help(0);

  const store = requireDb();

  try {
    if (cmd === 'list-users') {
      const users = store.listUsers();
      if (!users.length) {
        console.log('(no users yet)');
      } else {
        for (const u of users) {
          console.log(`${String(u.id).padStart(3)}  ${u.username.padEnd(20)}  ${u.created_at}`);
        }
      }
      return;
    }

    if (cmd === 'add-user') {
      const [username, passwordArg] = rest;
      if (!username) help(2);
      const password = await getPassword(passwordArg, true);
      const user = store.createUser(username, auth.hashPassword(password));
      console.log(`Created user #${user.id} "${user.username}".`);
      return;
    }

    if (cmd === 'set-password') {
      const [username, passwordArg] = rest;
      if (!username) help(2);
      const row = store.getUserByUsername(username);
      if (!row) {
        console.error(`No such user: ${username}`);
        process.exit(1);
      }
      const password = await getPassword(passwordArg, true);
      store.setPassword(row.id, auth.hashPassword(password));
      store.deleteUserSessions(row.id);
      console.log(`Password updated for "${row.username}"; all sessions invalidated.`);
      return;
    }

    if (cmd === 'rename-user') {
      const [oldName, newName] = rest;
      if (!oldName || !newName) help(2);
      const row = store.getUserByUsername(oldName);
      if (!row) {
        console.error(`No such user: ${oldName}`);
        process.exit(1);
      }
      store.renameUser(row.id, newName);
      console.log(`Renamed "${oldName}" -> "${newName}".`);
      return;
    }

    if (cmd === 'delete-user') {
      const [username] = rest;
      if (!username) help(2);
      const row = store.getUserByUsername(username);
      if (!row) {
        console.error(`No such user: ${username}`);
        process.exit(1);
      }
      store.deleteUser(row.id);
      console.log(`Deleted user "${username}" and all their data.`);
      return;
    }

    help(2);
  } finally {
    try { store.db.close(); } catch (_) { /* noop */ }
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
