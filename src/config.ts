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
