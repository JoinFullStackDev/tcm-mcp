#!/usr/bin/env node
/**
 * login.mjs — one-time interactive login for the auto-refreshing user-token mode (issue #1).
 *
 * Writes a session file (default ~/.tcm-mcp/session.json, override TCM_SESSION_FILE) that
 * the MCP server uses to mint fresh access tokens on demand. After this the server runs with
 * zero env vars (base URL defaults to production) — no token, no restart when the JWT expires.
 *
 * Usage:
 *   npm run login                 # opens a browser only if no valid saved session
 *   TCM_BASE_URL=... npm run login
 *
 * How it works: drives a Chromium profile persisted at ~/.tcm-mcp/browser.
 *   - First run (or once the refresh token dies): opens a visible window to log in with Google.
 *   - Later runs: reuses the profile and refreshes silently (headless).
 * From the logged-in page it captures the Supabase session (access + refresh + expiry) from
 * the sb-<ref>-auth-token cookie, the project URL from the JWT `iss`, and the anon key from a
 * Supabase network request. All of that goes into the session file (0600).
 *
 * Playwright is intentionally NOT a dependency of the server (keeps `npx github:.../tcm-mcp`
 * lean); this helper auto-installs it into ~/.tcm-mcp on first login if it isn't already present.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const log = (...a) => console.error('[tcm-mcp login]', ...a);

const APP_DIR = path.join(os.homedir(), '.tcm-mcp');
const PLAYWRIGHT_VERSION = '1.58.2';

// Playwright is deliberately NOT a server dependency (keeps `npx tcm-mcp` lean). For login
// we load it from wherever it resolves; if it's missing we install it ONCE into ~/.tcm-mcp
// (isolated — never touches the user's projects) so the oneliner works with no manual setup.
async function loadChromium() {
  // 1) already resolvable (dev clone that ran `npm i -D playwright`, or a global install)
  try {
    return (await import('playwright')).chromium;
  } catch {
    /* fall through */
  }
  // 2) previously bootstrapped into ~/.tcm-mcp
  const appEntry = path.join(
    APP_DIR,
    'node_modules',
    'playwright',
    'index.mjs',
  );
  if (fs.existsSync(appEntry)) {
    try {
      return (await import(pathToFileURL(appEntry).href)).chromium;
    } catch {
      /* fall through to reinstall */
    }
  }
  // 3) install once into ~/.tcm-mcp
  log(
    'Playwright not found — installing it once into ~/.tcm-mcp (includes a ~100MB browser download)…',
  );
  fs.mkdirSync(APP_DIR, { recursive: true });
  const pkgFile = path.join(APP_DIR, 'package.json');
  if (!fs.existsSync(pkgFile)) {
    fs.writeFileSync(
      pkgFile,
      JSON.stringify({ name: 'tcm-mcp-login-deps', private: true }, null, 2),
    );
  }
  const install = spawnSync(
    'npm',
    [
      'install',
      `playwright@${PLAYWRIGHT_VERSION}`,
      '--prefix',
      APP_DIR,
      '--no-audit',
      '--no-fund',
      '--loglevel',
      'error',
    ],
    { stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (install.status !== 0) {
    log(
      'Could not install Playwright automatically. Install it manually, then re-run login:',
    );
    log(
      `  npm i -D playwright@${PLAYWRIGHT_VERSION} && npx playwright install chromium`,
    );
    process.exit(1);
  }
  const cli = path.join(APP_DIR, 'node_modules', 'playwright', 'cli.js');
  const browser = spawnSync(process.execPath, [cli, 'install', 'chromium'], {
    stdio: 'inherit',
  });
  if (browser.status !== 0) {
    log(
      'Could not download the Chromium browser. Re-run login, or run: npx playwright install chromium',
    );
    process.exit(1);
  }
  return (await import(pathToFileURL(appEntry).href)).chromium;
}

const chromium = await loadChromium();

const BASE_URL = (
  process.env.TCM_BASE_URL || 'https://tcm-ochre.vercel.app'
).replace(/\/$/, '');
const SESSION_FILE =
  process.env.TCM_SESSION_FILE ||
  path.join(os.homedir(), '.tcm-mcp', 'session.json');
const PROFILE_DIR =
  process.env.TCM_BROWSER_PROFILE ||
  path.join(os.homedir(), '.tcm-mcp', 'browser');
const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;

// Runs in the page: reconstruct the chunked `sb-<ref>-auth-token` cookie into the
// Supabase session object ({ access_token, refresh_token, expires_at, ... }).
const EXTRACT_SESSION = () => {
  const jar = {};
  document.cookie.split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) jar[c.slice(0, i).trim()] = c.slice(i + 1);
  });
  const names = Object.keys(jar).filter((k) =>
    /^sb-.+-auth-token(\.\d+)?$/.test(k),
  );
  if (!names.length) return null;
  const base = names[0].replace(/\.\d+$/, '');
  let raw = '';
  for (let i = 0; i < 20; i++)
    if (jar[`${base}.${i}`] != null) raw += jar[`${base}.${i}`];
  if (!raw && jar[base] != null) raw = jar[base];
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* value was not encoded */
  }
  if (raw.startsWith('base64-')) raw = raw.slice('base64-'.length);
  try {
    return JSON.parse(atob(raw));
  } catch {
    return null;
  }
};

/** Decode a JWT payload (no verification) to read the `iss` / `exp` claims. */
function decodeJwt(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** Derive https://<ref>.supabase.co from the access token's iss (…/auth/v1). */
function supabaseUrlFromToken(accessToken) {
  const claims = decodeJwt(accessToken);
  if (!claims?.iss) return null;
  try {
    const u = new URL(claims.iss);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** Block until the interactive Google login lands back on the app (or time out). */
async function waitForLogin(page) {
  log('Please log in with Google in the opened browser window…');
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    const u = page.url();
    // Only done once we're back on the app origin (not /login, not the Supabase/Google
    // OAuth hops) — so transient redirects don't look like a completed login.
    if (u.startsWith(BASE_URL) && !u.includes('/login')) return true;
  }
  return false;
}

/**
 * Read the Supabase session from the page cookies and validate it by minting a fresh
 * token. A refresh token grabbed from the browser profile can already be stale (the
 * session was rotated/used elsewhere — e.g. the server refreshed it), so writing it
 * verbatim would produce a dead session file. Rotating here both proves it works and
 * stores a known-good, freshly-minted token. Returns null if there is no usable session.
 */
async function extractValidated(
  page,
  capturedApiKey,
  { waitMs = 500, tries = 1 } = {},
) {
  // The session cookie is written asynchronously after the OAuth /auth/callback code
  // exchange, so poll (and nudge to '/' once) rather than reading a single time.
  let session = null;
  for (let i = 0; i < tries; i++) {
    await page.waitForTimeout(i === 0 ? waitMs : 1200);
    session = await page.evaluate(EXTRACT_SESSION).catch(() => null);
    if (session?.access_token && session?.refresh_token) break;
    if (i === 2) {
      await page
        .goto(BASE_URL + '/', { waitUntil: 'domcontentloaded' })
        .catch(() => {});
    }
  }
  if (!session?.access_token || !session?.refresh_token) {
    log(`No Supabase session cookie found (url: ${page.url()}).`);
    return null;
  }

  const supabaseUrl = supabaseUrlFromToken(session.access_token);
  if (!supabaseUrl) {
    log('Could not derive supabase_url from the access token.');
    return null;
  }

  const anonKey =
    capturedApiKey.value ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!anonKey) {
    log(
      'Could not capture the Supabase anon key from network traffic. ' +
        'Set SUPABASE_ANON_KEY and re-run (the anon key is public/safe).',
    );
    return null;
  }

  const rotated = await refreshGrant(
    supabaseUrl,
    anonKey,
    session.refresh_token,
  );
  if (!rotated) {
    log(
      'Captured refresh token did not validate (stale/expired) — will re-try login.',
    );
    return null;
  }

  return {
    supabase_url: supabaseUrl,
    anon_key: anonKey,
    access_token: rotated.access_token,
    refresh_token: rotated.refresh_token,
    expires_at: rotated.expires_at,
  };
}

async function sessionFrom(context, capturedApiKey, { allowLogin }) {
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(BASE_URL + '/', { waitUntil: 'networkidle' }).catch(() => {});

  // First try the existing session (unless we're already bounced to /login).
  if (!page.url().includes('/login')) {
    const ok = await extractValidated(page, capturedApiKey);
    if (ok) return ok;
  }

  if (!allowLogin) return null; // silent phase: leave interactive login to phase 2

  // Recover: the profile has no session, or its refresh token is stale. Clear any stale
  // cookie so the app routes to /login, then wait for the user to re-authenticate.
  await context.clearCookies().catch(() => {});
  await page
    .goto(BASE_URL + '/login', { waitUntil: 'domcontentloaded' })
    .catch(() => {});
  if (!(await waitForLogin(page))) {
    log('Timed out waiting for login.');
    return null;
  }
  // Poll: the code-exchange after the OAuth redirect writes the session cookie async.
  return extractValidated(page, capturedApiKey, { waitMs: 1000, tries: 15 });
}

/**
 * Exchange a refresh token for a fresh session via the Supabase refresh_token grant.
 * Returns the rotated { access_token, refresh_token, expires_at } or null on failure.
 */
async function refreshGrant(supabaseUrl, anonKey, refreshToken) {
  try {
    const url = `${supabaseUrl.replace(/\/$/, '')}/auth/v1/token?grant_type=refresh_token`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) return null;
    const d = await res.json();
    if (!d.access_token || !d.refresh_token) return null;
    const now = Math.floor(Date.now() / 1000);
    return {
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      expires_at: d.expires_at ?? now + (d.expires_in ?? 3600),
    };
  } catch {
    return null;
  }
}

/** Attach an `apikey`-header sniffer for Supabase requests; returns a mutable holder. */
function attachApiKeyCapture(context) {
  const holder = { value: null };
  context.on('request', (req) => {
    if (holder.value) return;
    const url = req.url();
    if (!/\.supabase\.co\//.test(url) && !/\/auth\/v1\//.test(url)) return;
    const key = req.headers()['apikey'];
    if (key) holder.value = key;
  });
  return holder;
}

function writeSessionFile(file, session) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

// ── Phase 1 — silent: refresh the token if the saved profile still has a session. ──
let ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: true,
});
let apiKey = attachApiKeyCapture(ctx);
let session = await sessionFrom(ctx, apiKey, { allowLogin: false }).catch(
  () => null,
);
await ctx.close();

// ── Phase 2 — interactive: only if the silent path found no valid session. ──
if (!session) {
  log('No valid saved session — opening a browser for login.');
  ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
  });
  apiKey = attachApiKeyCapture(ctx);
  session = await sessionFrom(ctx, apiKey, { allowLogin: true }).catch(
    () => null,
  );
  await ctx.close();
}

if (!session) {
  log('Failed to obtain a session.');
  process.exit(1);
}

writeSessionFile(SESSION_FILE, session);
const expiresIn = Math.max(
  0,
  session.expires_at - Math.floor(Date.now() / 1000),
);
log(`Wrote session to ${SESSION_FILE} (0600).`);
log(`  supabase_url: ${session.supabase_url}`);
log(
  `  access token expires in ~${Math.round(expiresIn / 60)} min (auto-refreshed from here on).`,
);
log(
  'Done. The tcm-mcp server now runs with zero env vars (base URL defaults to production).',
);
