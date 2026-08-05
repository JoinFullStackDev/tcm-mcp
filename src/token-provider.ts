/**
 * token-provider.ts — Refreshing user-token auth (issue #1).
 *
 * In user-token mode the Supabase access JWT expires ~1h. Instead of forcing the
 * user to re-extract a token and fully restart Claude Code, this provider holds the
 * Supabase *refresh* token and mints fresh access tokens on demand.
 *
 * Source of truth is a session file (JSON), default ~/.tcm-mcp/session.json,
 * override TCM_SESSION_FILE. It is produced by `npm run login` (scripts/login.mjs).
 *
 * Supabase rotates the refresh token on every refresh call, and Claude Code restarts
 * this process whenever it reconnects the MCP — so the rotated refresh token MUST be
 * persisted back to disk atomically, or the next process start would use a dead token.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AuthProvider } from './auth.js';
import { resolveBaseUrl } from './config.js';

export interface SupabaseSession {
  supabase_url: string;
  anon_key: string;
  access_token: string;
  refresh_token: string;
  /** Epoch SECONDS at which access_token expires (as returned by GoTrue). */
  expires_at: number;
}

/** Refresh when the access token is within this many seconds of expiring. */
const EXPIRY_SKEW_SECONDS = 60;

export function defaultSessionFile(): string {
  return (
    process.env.TCM_SESSION_FILE ||
    path.join(os.homedir(), '.tcm-mcp', 'session.json')
  );
}

/** Raised when there is no usable session and the user must re-run `npm run login`. */
export class SessionExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

export class RefreshingTokenProvider implements AuthProvider {
  readonly mode = 'user-refresh' as const;
  readonly baseUrl: string;

  private session: SupabaseSession;
  private readonly sessionFile: string;
  /** De-dupes concurrent refreshes within one process. */
  private inFlight: Promise<void> | null = null;

  constructor(baseUrl: string, session: SupabaseSession, sessionFile: string) {
    this.baseUrl = baseUrl;
    this.session = session;
    this.sessionFile = sessionFile;
  }

  /**
   * Load a session from disk. Throws SessionExpiredError with actionable guidance
   * if the file is missing or malformed.
   */
  static load(sessionFile: string): RefreshingTokenProvider {
    const baseUrl = resolveBaseUrl();
    const session = readSessionFile(sessionFile);
    return new RefreshingTokenProvider(baseUrl, session, sessionFile);
  }

  async headers(): Promise<Record<string, string>> {
    if (this.isExpired()) {
      await this.refresh();
    }
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.session.access_token}`,
    };
  }

  async handleUnauthorized(): Promise<boolean> {
    try {
      await this.refresh({ force: true });
      return true;
    } catch {
      return false;
    }
  }

  private isExpired(): boolean {
    if (!this.session.access_token) return true;
    const nowSeconds = Math.floor(Date.now() / 1000);
    return nowSeconds >= this.session.expires_at - EXPIRY_SKEW_SECONDS;
  }

  /**
   * Refresh the access token via the Supabase refresh_token grant and persist the
   * rotated session. Concurrent callers share a single in-flight refresh.
   */
  private async refresh(opts: { force?: boolean } = {}): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!opts.force && !this.isExpired()) return;

    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doRefresh(): Promise<void> {
    try {
      this.session = await this.callRefreshGrant(this.session.refresh_token);
      writeSessionFile(this.sessionFile, this.session);
    } catch (err) {
      // Another process (a concurrent server spawn) may have already refreshed and
      // rotated the token on disk, invalidating our in-memory copy. Re-read and retry once.
      const fresh = tryReadSessionFile(this.sessionFile);
      if (fresh && fresh.refresh_token !== this.session.refresh_token) {
        this.session = await this.callRefreshGrant(fresh.refresh_token);
        writeSessionFile(this.sessionFile, this.session);
        return;
      }
      throw new SessionExpiredError(
        `[tcm-mcp] Session refresh failed (${(err as Error).message}). ` +
          'Run `npm run login` in the tcm-mcp repo to re-authenticate.',
      );
    }
  }

  /** POST {supabase_url}/auth/v1/token?grant_type=refresh_token */
  private async callRefreshGrant(
    refreshToken: string,
  ): Promise<SupabaseSession> {
    const url = `${this.session.supabase_url.replace(/\/$/, '')}/auth/v1/token?grant_type=refresh_token`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: this.session.anon_key,
        Authorization: `Bearer ${this.session.anon_key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!res.ok) {
      let detail = '';
      try {
        detail = JSON.stringify(await res.json());
      } catch {
        /* ignore */
      }
      throw new Error(`refresh grant HTTP ${res.status} ${detail}`);
    }

    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_at?: number;
      expires_in?: number;
    };

    if (!data.access_token || !data.refresh_token) {
      throw new Error(
        'refresh grant response missing access_token/refresh_token',
      );
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAt = data.expires_at ?? nowSeconds + (data.expires_in ?? 3600);

    return {
      supabase_url: this.session.supabase_url,
      anon_key: this.session.anon_key,
      access_token: data.access_token,
      refresh_token: data.refresh_token, // ROTATED — must persist
      expires_at: expiresAt,
    };
  }
}

// ─── Session file I/O ─────────────────────────────────────────────────────────

const REQUIRED_FIELDS: (keyof SupabaseSession)[] = [
  'supabase_url',
  'anon_key',
  'access_token',
  'refresh_token',
  'expires_at',
];

function readSessionFile(sessionFile: string): SupabaseSession {
  let raw: string;
  try {
    raw = fs.readFileSync(sessionFile, 'utf8');
  } catch {
    throw new SessionExpiredError(
      `[tcm-mcp] No session file at ${sessionFile}. ` +
        'Run `npm run login` in the tcm-mcp repo to authenticate.',
    );
  }
  let parsed: SupabaseSession;
  try {
    parsed = JSON.parse(raw) as SupabaseSession;
  } catch {
    throw new SessionExpiredError(
      `[tcm-mcp] Session file at ${sessionFile} is not valid JSON. Re-run \`npm run login\`.`,
    );
  }
  for (const field of REQUIRED_FIELDS) {
    if (
      parsed[field] === undefined ||
      parsed[field] === null ||
      parsed[field] === ''
    ) {
      throw new SessionExpiredError(
        `[tcm-mcp] Session file at ${sessionFile} is missing '${field}'. Re-run \`npm run login\`.`,
      );
    }
  }
  return parsed;
}

/** Non-throwing read used on the refresh-retry path. */
function tryReadSessionFile(sessionFile: string): SupabaseSession | null {
  try {
    return readSessionFile(sessionFile);
  } catch {
    return null;
  }
}

/** Atomic write (temp + rename) with 0600 perms so the refresh token stays private. */
export function writeSessionFile(
  sessionFile: string,
  session: SupabaseSession,
): void {
  const dir = path.dirname(sessionFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${sessionFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, sessionFile);
  // renameSync preserves the temp file's mode; ensure 0600 in case it pre-existed.
  fs.chmodSync(sessionFile, 0o600);
}

/** Whether a usable session file exists (used for auth-mode precedence). */
export function sessionFileExists(sessionFile: string): boolean {
  return tryReadSessionFile(sessionFile) !== null;
}
