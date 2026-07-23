/**
 * Site auth. Three modes, set with AUTH_MODE:
 *   password  (default) — one shared SITE_PASSWORD, signed session cookie
 *   cf-access           — Cloudflare Access sits in front; trust its headers
 *   none                — open (LAN-only testing; never with a public hostname)
 *
 * Supplier wholesale pricing is behind this. There is no "public" mode by accident:
 * with AUTH_MODE=password and no SITE_PASSWORD set, the server refuses to start.
 */
const crypto = require('crypto');

const MODE = (process.env.AUTH_MODE || 'password').toLowerCase();
const USERNAME = process.env.SITE_USER || 'SOSPhonerepairs';
const PASSWORD = process.env.SITE_PASSWORD || '';
const COOKIE = 'ppp_session';
const TTL_MS = (Number(process.env.SESSION_DAYS) || 30) * 86400000;
// auto (default) = mark the cookie Secure only when the request actually arrived over
// https. A fixed "1" silently breaks login over plain http on the LAN — the browser
// drops the cookie and you bounce back to /login with no error — which is exactly what
// happens while a domain's TLS is still being sorted out.
const SECURE_MODE = process.env.SECURE_COOKIE || 'auto';
const isHttps = req => Boolean(req && (req.secure || String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https'));
const useSecure = req => (SECURE_MODE === '1' ? true : SECURE_MODE === '0' ? false : isHttps(req));

// A stable secret means sessions survive restarts. Derived from the password unless
// one is given explicitly — changing SITE_PASSWORD then logs everyone out, which is
// what you want when you rotate it.
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('ppp|' + PASSWORD).digest('hex');

if (MODE === 'password' && !PASSWORD) {
  console.error('FATAL: AUTH_MODE=password but SITE_PASSWORD is empty. Set it in .env, or set AUTH_MODE=cf-access / none.');
  process.exit(1);
}

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const hmac = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');

function sign(payload) { const p = b64(payload); return p + '.' + hmac(p); }

function verify(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [p, sig] = token.split('.');
  const want = hmac(p);
  if (sig.length !== want.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch (e) { return null; }
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// ── brute-force damper: 10 tries per IP per 15 min ──────────────────────────
const attempts = new Map();
function tooManyAttempts(ip) {
  const a = attempts.get(ip);
  if (!a) return false;
  if (Date.now() > a.until) { attempts.delete(ip); return false; }
  return a.n >= 10;
}
function noteAttempt(ip, ok) {
  if (ok) { attempts.delete(ip); return; }
  const a = attempts.get(ip) || { n: 0, until: Date.now() + 15 * 60000 };
  a.n++; a.until = Date.now() + 15 * 60000;
  attempts.set(ip, a);
}

const same = (given, want) => {
  const a = Buffer.from(String(given == null ? '' : given));
  const b = Buffer.from(String(want));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// One shared account. The username is matched case-insensitively — staff type it on
// phones with autocapitalise on, and it is a deterrent, not a secret.
function checkLogin(username, password) {
  return same(String(username || '').trim().toLowerCase(), USERNAME.toLowerCase()) && same(password, PASSWORD);
}

function isLoggedIn(req) {
  if (MODE === 'none') return true;
  // Cloudflare Access terminates auth upstream; it always sets this JWT header.
  if (MODE === 'cf-access') return Boolean(req.headers['cf-access-jwt-assertion'] || req.headers['cf-access-authenticated-user-email']);
  return Boolean(verify(readCookie(req, COOKIE)));
}

function setSession(req, res) {
  const token = sign({ exp: Date.now() + TTL_MS });
  res.setHeader('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(TTL_MS / 1000)}` +
    (useSecure(req) ? '; Secure' : ''));
}
function clearSession(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` + (useSecure(req) ? '; Secure' : ''));
}

module.exports = { MODE, USERNAME, isLoggedIn, setSession, clearSession, checkLogin, tooManyAttempts, noteAttempt };
