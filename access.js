const crypto = require('crypto');
const express = require('express');

// Optional password gate for copies reachable from the internet (for example on a VPS).
// Turned on by setting APP_PASSWORD; without it the app is open to anyone who can reach it.

const COOKIE = 'cloudlift_session';
// The installable-app files hold no data and are fetched by phones without the session cookie.
const PUBLIC = /^\/(manifest\.webmanifest|sw\.js|offline\.html|icons\/[\w-]+\.png)$/;
const SESSION_DAYS = 30;
const enabled = () => !!process.env.APP_PASSWORD;
const key = () => process.env.TOKEN_KEY || 'cloudlift-session-key';
const sign = (value) => crypto.createHmac('sha256', key()).update(value).digest('base64url');
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter(([k]) => k));
}

function validSession(req) {
  const [expires, signature] = String(cookies(req)[COOKIE] || '').split('.');
  if (!expires || !signature || Number(expires) < Date.now()) return false;
  const expected = sign(expires);
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function setSession(req, res) {
  const expires = String(Date.now() + SESSION_DAYS * 86400000);
  res.cookie(COOKIE, `${expires}.${sign(expires)}`, {
    httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_DAYS * 86400000, path: '/',
  });
}

// Slows down password guessing: 5 wrong attempts per address, then a 15 minute wait.
const failures = new Map(); // ip -> { count, until }
function blocked(ip) {
  const f = failures.get(ip);
  return !!f && f.count >= 5 && Date.now() < f.until;
}
function recordFailure(ip) {
  const f = failures.get(ip);
  const fresh = !f || Date.now() > f.until;
  failures.set(ip, { count: fresh ? 1 : f.count + 1, until: Date.now() + 15 * 60000 });
}

const page = (message) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · CloudLift</title>
<link rel="manifest" href="/manifest.webmanifest"><link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png"><link rel="apple-touch-icon" href="/icons/apple-touch-icon.png"><meta name="theme-color" content="#5458ee">
<style>
:root{color-scheme:light dark;--bg:#f5f6fa;--card:#fff;--ink:#171c2a;--muted:#76809a;--line:#e3e6ee;--primary:#5458ee;--bad:#d42146}
@media (prefers-color-scheme:dark){:root{--bg:#0d1017;--card:#161a24;--ink:#eceff5;--muted:#8a93a8;--line:#293043;--primary:#8487ff;--bad:#fb7185}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--ink);font:15px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
form{width:min(380px,100%);background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px;box-shadow:0 12px 40px #0002}
.mark{display:block;width:48px;height:48px;border-radius:12px;margin-bottom:14px}
h1{margin:0;font-size:22px}p{margin:6px 0 18px;color:var(--muted)}
input{width:100%;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:transparent;color:inherit;font:inherit}
input:focus{outline:0;border-color:var(--primary);box-shadow:0 0 0 4px color-mix(in srgb,var(--primary) 20%,transparent)}
button{width:100%;margin-top:12px;padding:12px;border:0;border-radius:10px;background:var(--primary);color:#fff;font:inherit;font-weight:700;cursor:pointer}
.err{color:var(--bad);margin:10px 0 0;font-weight:600}
</style></head><body><form method="post" action="/login"><img class="mark" src="/icons/icon-192.png" alt=""><h1>CloudLift</h1><p>Enter the password for this copy of CloudLift.</p>
<input type="password" name="password" autocomplete="current-password" aria-label="Password" placeholder="Password" required autofocus>
<button type="submit">Sign in</button>${message ? `<p class="err">${message}</p>` : ''}</form></body></html>`;

function install(app) {
  if (!enabled()) return;
  app.get('/login', (req, res) => (validSession(req) ? res.redirect('/') : res.send(page(''))));
  app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
    const ip = req.ip;
    if (blocked(ip)) return res.status(429).send(page('Too many wrong attempts. Try again in 15 minutes.'));
    const ok = crypto.timingSafeEqual(digest(req.body?.password ?? ''), digest(process.env.APP_PASSWORD));
    if (!ok) {
      recordFailure(ip);
      return res.status(401).send(page('Wrong password.'));
    }
    failures.delete(ip);
    setSession(req, res);
    res.redirect('/');
  });
  app.post('/logout', (req, res) => {
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });
  // Everything else, including the OAuth callbacks, needs a signed-in session.
  app.use((req, res, next) => {
    if (validSession(req) || PUBLIC.test(req.path)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Signed out. Reload the page to sign in again.' });
    res.redirect('/login');
  });
}

module.exports = { install, enabled };
