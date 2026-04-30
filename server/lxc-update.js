/* lxc-update.js — run deploy/install.sh from the web UI (opt-in).
 *
 * Requires root privileges for the real deploy/install.sh. Typical LXC setup:
 *   timetracker ALL=(root) NOPASSWD: /bin/bash /opt/timetracker/deploy/install.sh
 *
 * Env:
 *   ALLOW_WEB_LXC_UPDATE=1     — enable GET/POST /api/admin/lxc-update
 *   LXC_UPDATE_SCRIPT          — path to install.sh (default /opt/timetracker/deploy/install.sh)
 *   LXC_UPDATE_ALLOWED_USERS   — optional comma-separated usernames allowed to run
 */

const { spawn } = require('child_process');

const DEFAULT_SCRIPT = '/opt/timetracker/deploy/install.sh';
const MAX_OUTPUT_CHARS = 120000;
const KILL_AFTER_MS = 15 * 60 * 1000;

function webUpdateEnabled() {
  return process.env.ALLOW_WEB_LXC_UPDATE === '1';
}

function scriptPath() {
  const s = process.env.LXC_UPDATE_SCRIPT;
  return (typeof s === 'string' && s.trim()) ? s.trim() : DEFAULT_SCRIPT;
}

function allowedUsernames() {
  const raw = process.env.LXC_UPDATE_ALLOWED_USERS || '';
  return raw
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

function canUserRun(username) {
  const allow = allowedUsernames();
  if (!allow.length) return true;
  const u = (username && String(username).trim().toLowerCase()) || '';
  return allow.includes(u);
}

/**
 * Runs: sudo -n bash <scriptPath>
 * Returns: { code, stdout, stderr }.
 */
function runInstallScript() {
  const script = scriptPath();
  return new Promise((resolve, reject) => {
    const child = spawn('sudo', ['-n', 'bash', script], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const cap = (chunk, acc) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString();
      const next = acc + s;
      return next.length > MAX_OUTPUT_CHARS
        ? next.slice(0, MAX_OUTPUT_CHARS) + '\n... [truncated]'
        : next;
    };
    child.stdout.on('data', (d) => { stdout = cap(d, stdout); });
    child.stderr.on('data', (d) => { stderr = cap(d, stderr); });
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_) { /* ignore */ }
    }, KILL_AFTER_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: code == null ? -1 : code,
        stdout,
        stderr
      });
    });
  });
}

module.exports = {
  webUpdateEnabled,
  scriptPath,
  allowedUsernames,
  canUserRun,
  runInstallScript
};
