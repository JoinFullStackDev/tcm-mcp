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
 * TCM_BASE_URL defaults to the production instance (see config.ts); override to point
 * elsewhere.
 *
 * Precedence: CLUTCH_API_KEY → session file present → TCM_USER_TOKEN → degraded
 * `needs-login` mode (server still boots so the `login` tool is reachable).
 */

import { resolveBaseUrl } from './config.js';
import {
  defaultSessionFile,
  RefreshingTokenProvider,
  SessionExpiredError,
  sessionFileExists,
} from './token-provider.js';

export type AuthMode =
  'clutch-key' | 'user-token' | 'user-refresh' | 'needs-login';

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
 * Degraded provider used when there is no credential yet. The server still boots (so the
 * `login` tool is reachable, e.g. in Claude Desktop) but any real request fails with a
 * clear 'not logged in' error until a session is established and the provider is swapped.
 */
class NoAuthProvider implements AuthProvider {
  readonly mode = 'needs-login' as const;
  constructor(readonly baseUrl: string) {}

  async headers(): Promise<Record<string, string>> {
    throw new SessionExpiredError(
      '[tcm-mcp] Not signed in to TCM. Run the `login` tool (or `npx github:JoinFullStackDev/tcm-mcp#v1.1.0 login`) to sign in.',
    );
  }

  async handleUnauthorized(): Promise<boolean> {
    return false;
  }
}

/**
 * Resolve an auth provider from the environment. Never throws / never exits: with no
 * credential it returns a degraded NoAuthProvider so the `login` tool stays reachable.
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

  // No credential yet: boot in a degraded state so the `login` tool is still reachable
  // (Claude Desktop can't run a terminal command). Real requests error until sign-in.
  return new NoAuthProvider(baseUrl);
}
