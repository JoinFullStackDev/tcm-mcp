/**
 * config.ts — shared static configuration.
 *
 * The production TCM instance is baked in as the default so a fresh install needs
 * ZERO env vars for the common case: `npx github:JoinFullStackDev/tcm-mcp` just works.
 * Point at a different instance (preview / self-host) by setting TCM_BASE_URL.
 */

export const DEFAULT_TCM_BASE_URL = 'https://tcm-ochre.vercel.app';

/** The TCM base URL to use: TCM_BASE_URL if set, else the baked-in production default. */
export function resolveBaseUrl(): string {
  const raw = process.env.TCM_BASE_URL?.trim();
  return (raw && raw.length > 0 ? raw : DEFAULT_TCM_BASE_URL).replace(
    /\/$/,
    '',
  );
}

/**
 * Server version, reported in the MCP handshake and used in the install hints the
 * `login` flow prints. Kept here so `package.json`, the handshake, and those hints
 * cannot drift apart — bump this and package.json together at release time, and tag
 * the repo `v<VERSION>` so the hint resolves.
 *
 * Clients pin by git tag, so an older pin keeps running that tag's code untouched;
 * this value only ever describes the build the user actually launched.
 */
export const VERSION = '1.5.0';
