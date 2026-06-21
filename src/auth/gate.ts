// Single shared-password login gate.
//
// Enabled only when APP_PASSWORD is set (so local dev / tests stay open). A
// successful login sets a signed, HttpOnly cookie whose value is an HMAC of a
// constant secret — the password itself never lands in the cookie. Every route
// is protected except the login/logout endpoints and the health check.

import * as crypto from 'crypto';
import type { Express, Request, Response, NextFunction } from 'express';

const COOKIE = 'thcp_auth';
const ALLOW = new Set(['/login', '/logout', '/api/health']);
const MAX_AGE_DAYS = 7;

function appPassword(): string {
  return process.env.APP_PASSWORD ?? '';
}

function sessionSecret(): string {
  // Fall back to the password so the gate still works if SESSION_SECRET is unset.
  return process.env.SESSION_SECRET || appPassword() || 'thcp-dev-secret';
}

/** The expected cookie value: HMAC(secret, marker). Rotating SESSION_SECRET or
 *  APP_PASSWORD invalidates all existing sessions. */
function expectedToken(): string {
  return crypto.createHmac('sha256', sessionSecret()).update('authenticated:v1').digest('hex');
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function isAuthed(req: Request): boolean {
  const token = readCookie(req, COOKIE);
  return !!token && timingSafeEqual(token, expectedToken());
}

function secureCookie(): boolean {
  return process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
}

function loginPage(error?: string): string {
  const msg = error ? `<p class="err">${error}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>THCP Autopilot — Sign in</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
    font:16px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background:#0b1220; color:#e7ecf3; }
  .card { width:min(92vw,360px); background:#121a2b; border:1px solid #243049;
    border-radius:14px; padding:28px; box-shadow:0 10px 40px rgba(0,0,0,.4); }
  h1 { font-size:18px; margin:0 0 4px; }
  p.sub { margin:0 0 20px; color:#9fb0c9; font-size:13px; }
  label { display:block; font-size:13px; color:#9fb0c9; margin-bottom:6px; }
  input { width:100%; box-sizing:border-box; padding:11px 12px; border-radius:9px;
    border:1px solid #2c3a57; background:#0d1422; color:#e7ecf3; font-size:15px; }
  button { width:100%; margin-top:16px; padding:11px; border:0; border-radius:9px;
    background:#3b82f6; color:#fff; font-size:15px; font-weight:600; cursor:pointer; }
  button:hover { background:#2f6fe0; }
  .err { color:#fca5a5; font-size:13px; margin:0 0 14px; }
</style>
</head>
<body>
  <form class="card" method="POST" action="/login">
    <h1>THCP Autopilot</h1>
    <p class="sub">Enter the access password to continue.</p>
    ${msg}
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required />
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;
}

/** Register the login/logout routes and the protecting middleware on `app`.
 *  Must be called before express.static and the API routers. */
export function mountAuth(app: Express): void {
  // No password configured → gate disabled (local dev, tests).
  if (!appPassword()) return;

  app.get('/login', (req: Request, res: Response) => {
    if (isAuthed(req)) return res.redirect('/');
    res.type('html').send(loginPage());
  });

  app.post('/login', (req: Request, res: Response) => {
    const supplied = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!supplied || !timingSafeEqual(supplied, appPassword())) {
      return res.status(401).type('html').send(loginPage('Incorrect password.'));
    }
    const attrs = [
      `${COOKIE}=${expectedToken()}`,
      'HttpOnly',
      'Path=/',
      'SameSite=Lax',
      `Max-Age=${MAX_AGE_DAYS * 24 * 60 * 60}`,
    ];
    if (secureCookie()) attrs.push('Secure');
    res.setHeader('Set-Cookie', attrs.join('; '));
    res.redirect('/');
  });

  app.get('/logout', (_req: Request, res: Response) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
    res.redirect('/login');
  });

  // Gate everything else.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (ALLOW.has(req.path) || isAuthed(req)) return next();
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Not authenticated. Please sign in.' });
    }
    return res.redirect('/login');
  });
}
