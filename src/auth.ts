/**
 * auth.ts — Auth for the TCM MCP server (PRD §9.1, OQ-2; issue #1).
 *
 * Three modes, resolved from the environment / session file:
 *
 * Mode 1 — Clutch/headless (Torque via OpenClaw):
 *   CLUTCH_API_KEY → X-Clutch-Key on every proxied request.
 *   Validated server-side by withAgentAuth() in TCM. Static; never refreshes.
 *
 * Mode 2 — Refreshing user token (issue #1, preferred for Claude Code):
 *   A session file (default ~/.tcm-mcp/session.json, from `npm run login`) holds the
 *   Supabase refresh token. The server mints fresh access JWTs on demand and on 401,
 *   so there is no ~1h manual re-auth + Claude Code restart. See token-provider.ts.
 *
 * Mode 3 — Static user token (back-compat):
 *   TCM_USER_TOKEN → Authorization: Bearer <token>. A single Supabase JWT that
 *   expires (~1h); superseded by mode 2 but kept for scripts / CI that inject a token.
 *
 * TCM_BASE_URL is required in every mode.
 *
 * Precedence: CLUTCH_API_KEY → session file present → TCM_USER_TOKEN → exit(1).
 */

import { resolveBaseUrl } from './config.js';
import {
  defaultSessionFile,
  RefreshingTokenProvider,
  sessionFileExists,
} from './token-provider.js';

export type AuthMode = 'clutch-key' | 'user-token' | 'user-refresh';

/**
 * An auth strategy. `headers()` returns the per-request auth headers (and may refresh
 * an expiring credential first); `handleUnauthorized()` is called after a 401 and
 * returns true if the credential was refreshed and the request should be retried once.
 */
export interface AuthProvider {
  readonly mode: AuthMode;
  readonly baseUrl: string;
  headers(): Promise<Record<string, string>>;
  handleUnauthorized(): Promise<boolean>;
}

/** Static-header provider for credentials that never refresh (clutch key, static JWT). */
class StaticAuthProvider implements AuthProvider {
  constructor(
    readonly mode: AuthMode,
    readonly baseUrl: string,
    private readonly staticHeaders: Record<string, string>,
  ) {}

  async headers(): Promise<Record<string, string>> {
    return { ...this.staticHeaders };
  }

  async handleUnauthorized(): Promise<boolean> {
    // Nothing to refresh — a 401 here is terminal.
    return false;
  }
}

/**
 * Resolve an auth provider from the environment.
 * Exits with a clear error if no usable credential is found, or if TCM_BASE_URL is missing.
 */
export function resolveAuthConfig(): AuthProvider {
  // Defaults to the production TCM instance; override with TCM_BASE_URL. Never missing.
  const baseUrl = resolveBaseUrl();

  const clutchKey = process.env.CLUTCH_API_KEY;
  const userToken = process.env.TCM_USER_TOKEN;

  if (clutchKey) {
    // Startup check: MCP_AGENT_USER_ID is required for headless create/update calls
    // so that created_by / updated_by are not null (NOT NULL constraint on those columns).
    if (!process.env.MCP_AGENT_USER_ID) {
      console.warn(
        '[tcm-mcp] WARNING: MCP_AGENT_USER_ID is not set — create/update calls will fail with NOT NULL constraint on created_by.\n' +
          '  Set MCP_AGENT_USER_ID to the UUID of the Clutch Agent service profile row in the profiles table.',
      );
    }
    return new StaticAuthProvider('clutch-key', baseUrl, {
      'Content-Type': 'application/json',
      // X-Clutch-Key: validated by withAgentAuth() in TCM (non-constant-time compare
      // is a known minor weakness flagged in OQ-2; hardening is deferred to v2).
      'X-Clutch-Key': clutchKey,
    });
  }

  // Preferred interactive path: a login session with a refresh token (issue #1).
  const sessionFile = defaultSessionFile();
  if (sessionFileExists(sessionFile)) {
    return RefreshingTokenProvider.load(sessionFile);
  }

  // Back-compat: a single static JWT injected via env (expires ~1h, no refresh).
  if (userToken) {
    return new StaticAuthProvider('user-token', baseUrl, {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userToken}`,
    });
  }

  console.error(
    '[tcm-mcp] ERROR: No auth credentials found.\n' +
      '  Set one of:\n' +
      '    CLUTCH_API_KEY — for headless agent use (Torque via Clutch/OpenClaw)\n' +
      '    a login session — run `npm run login` (auto-refreshing user token, recommended)\n' +
      '    TCM_USER_TOKEN — a single static Supabase JWT (expires ~1h, no refresh)',
  );
  process.exit(1);
}
