/**
 * auth.ts — Two-mode auth for the TCM MCP server (PRD §9.1, OQ-2).
 *
 * Mode 1 — Clutch/headless path (Torque via OpenClaw):
 *   CLUTCH_API_KEY env var → sends X-Clutch-Key on every proxied request.
 *   Handled server-side by withAgentAuth() in TCM.
 *
 * Mode 2 — User/interactive path (Claude Code):
 *   TCM_USER_TOKEN env var → sends Authorization: Bearer <token>.
 *   Token is the user's Supabase JWT (from Playwright login or direct sign-in).
 *
 * TCM_BASE_URL is required in both modes.
 */

export type AuthMode = 'clutch-key' | 'user-token';

export interface AuthConfig {
  mode: AuthMode;
  baseUrl: string;
  headers: Record<string, string>;
}

/**
 * Resolve auth configuration from environment variables.
 * Exits with a clear error if neither auth var is set, or if TCM_BASE_URL is missing.
 */
export function resolveAuthConfig(): AuthConfig {
  const baseUrl = process.env.TCM_BASE_URL?.replace(/\/$/, '');
  if (!baseUrl) {
    console.error(
      '[tcm-mcp] ERROR: TCM_BASE_URL is not set.\n' +
      '  Set TCM_BASE_URL to your TCM instance (e.g. https://tcm-ochre.vercel.app).',
    );
    process.exit(1);
  }

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
    return {
      mode: 'clutch-key',
      baseUrl,
      headers: {
        'Content-Type': 'application/json',
        // X-Clutch-Key: validated by withAgentAuth() in TCM (non-constant-time compare
        // is a known minor weakness flagged in OQ-2; hardening is deferred to v2).
        'X-Clutch-Key': clutchKey,
      },
    };
  }

  if (userToken) {
    return {
      mode: 'user-token',
      baseUrl,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userToken}`,
      },
    };
  }

  console.error(
    '[tcm-mcp] ERROR: No auth credentials found.\n' +
    '  Set one of:\n' +
    '    CLUTCH_API_KEY — for headless agent use (Torque via Clutch/OpenClaw)\n' +
    '    TCM_USER_TOKEN — for interactive use (Claude Code / user JWT)',
  );
  process.exit(1);
}
