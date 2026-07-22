/**
 * Live config from git.
 *
 * The repo is bind-mounted at REPO_DIR. Every GIT_SYNC_INTERVAL seconds we fetch and
 * hard-reset the checkout to origin/BRANCH, then invalidate the config cache. Edit
 * devices.yml / parts.yml / stores.yml / settings.yml on GitHub and the live site
 * follows within one interval — no ssh, no redeploy.
 *
 * hard reset (not `pull --ff-only`) on purpose: this checkout is a read-only mirror of
 * main. If someone hand-edits a file on the box, a ff-only pull would wedge forever;
 * a reset silently heals it. Nothing precious lives here — prices.db and the store
 * calculators are on the data volume and are not tracked by git.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_DIR = process.env.REPO_DIR || '/repo';
const REMOTE = process.env.GIT_REMOTE || 'https://github.com/THVjQ/parts-price-puller.git';
const BRANCH = process.env.GIT_BRANCH || 'main';
const ENABLED = process.env.GIT_SYNC !== '0';
const INTERVAL = Math.max(20, Number(process.env.GIT_SYNC_INTERVAL) || 60) * 1000;
const TOKEN = process.env.GIT_TOKEN || '';

let last = { at: null, ok: null, head: null, changed: false, message: 'not run yet' };
let running = false;

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    // Token (private repo / higher rate limit) is passed per-invocation so it never
    // gets written into .git/config on the volume.
    const auth = TOKEN
      ? ['-c', 'http.extraheader=Authorization: Basic ' + Buffer.from('x-access-token:' + TOKEN).toString('base64')]
      : [];
    execFile('git', [...auth, ...args], { cwd, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(((stderr || '') + (stdout || '') || err.message).trim().slice(0, 500)));
      resolve((stdout || '').trim());
    });
  });
}

const isRepo = () => fs.existsSync(path.join(REPO_DIR, '.git'));

async function pull() {
  if (running) return last;
  running = true;
  const before = last.head;
  try {
    if (!isRepo()) {
      fs.mkdirSync(REPO_DIR, { recursive: true });
      const entries = fs.readdirSync(REPO_DIR);
      if (entries.length) throw new Error(`${REPO_DIR} is not a git checkout and is not empty — clone the repo there first`);
      await git(['clone', '--branch', BRANCH, '--depth', '20', REMOTE, REPO_DIR], '/');
    } else {
      await git(['fetch', '--depth', '20', 'origin', BRANCH], REPO_DIR);
      await git(['reset', '--hard', 'origin/' + BRANCH], REPO_DIR);
    }
    const head = await git(['rev-parse', '--short', 'HEAD'], REPO_DIR);
    const subject = await git(['log', '-1', '--pretty=%s'], REPO_DIR);
    last = { at: new Date().toISOString(), ok: true, head, changed: before !== null && before !== head, message: subject };
    if (last.changed) console.log(`[git] updated to ${head} — ${subject}`);
  } catch (e) {
    last = { at: new Date().toISOString(), ok: false, head: last.head, changed: false, message: e.message };
    console.error('[git] sync failed:', e.message);
  } finally {
    running = false;
  }
  return last;
}

function start(onUpdate) {
  if (!ENABLED) {
    last = { at: null, ok: null, head: null, changed: false, message: 'disabled (GIT_SYNC=0)' };
    console.log('[git] sync disabled');
    return null;
  }
  const tick = () => pull().then(r => { if (r.changed && onUpdate) onUpdate(r); });
  tick();
  const t = setInterval(tick, INTERVAL);
  t.unref?.();
  console.log(`[git] syncing ${REMOTE}#${BRANCH} into ${REPO_DIR} every ${INTERVAL / 1000}s`);
  return t;
}

module.exports = { start, pull, status: () => ({ ...last, enabled: ENABLED, repo: REPO_DIR, branch: BRANCH, intervalSec: INTERVAL / 1000 }) };
