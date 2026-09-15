/**
 * list_test_cases — Filterable, lightweight list of test cases.
 *
 * Proxies: GET /api/test-cases?project_id=&suite_id=&search=&limit=&fields=lean
 * PRD §8.2
 *
 * Issue #3 Part 2: optionally accepts project_name as an alternative to project_id
 * (resolved to a UUID via resolveProjectId). Passing both is a VALIDATION error.
 * Passing neither is still valid (unscoped list across all visible projects).
 *
 * Tag filtering is done HERE, not in TCM: GET /api/test-cases ignores a `tags` query
 * param, so the tags path asks for the full projection (which carries `tags`) and
 * filters client-side. Matching is case-insensitive, ANY-of the requested tags.
 */

import { z } from 'zod';
import type { TcmClient } from '../client.js';
import type { ListTestCasesResult, McpError, TestCaseListItem } from '../types.js';
import { resolveProjectId } from './resolve_project.js';

const LIST_LIMIT_MAX = 200;
const LIST_LIMIT_DEFAULT = 50;

/**
 * One full page from TCM. Must track LIST_LIMIT_MAX in TCM's src/app/api/test-cases/route.ts,
 * which applies the same clamp to the lean and full projections; the route honours no
 * offset/page/cursor, so there is no second page to ask for.
 *
 * ponytail: if TCM ever clamps BELOW this, a truncated scan would report has_more: false —
 * the cap is not discoverable from the response. The fix is the server-side `tags` filter
 * (TCM#114), which removes the scan entirely, not a cleverer guess here.
 */
const BACKEND_MAX_ROWS = 200;

const UNTAGGABLE =
  'TCM returned rows without a `tags` field, so the tags filter could not be applied. ' +
  'This is a projection/response-shape problem, not a missing TCM feature. ' +
  'Retry without `tags` to list the cases unfiltered.';

export const listTestCasesInputSchema = z
  .object({
    project_id: z.string().uuid().optional(),
    project_name: z.string().min(1).optional(),
    suite_id: z.string().uuid().optional(),
    search: z.string().optional(),
    tags: z.array(z.string().min(1)).min(1).optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(LIST_LIMIT_MAX)
      .optional()
      .default(LIST_LIMIT_DEFAULT),
  })
  .refine((d) => !(d.project_id && d.project_name), {
    message: 'Provide either project_id or project_name, not both.',
  });

export type ListTestCasesInput = z.infer<typeof listTestCasesInputSchema>;

export async function listTestCases(
  client: TcmClient,
  input: ListTestCasesInput,
): Promise<ListTestCasesResult | McpError> {
  const parsed = listTestCasesInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      error: {
        code: 'VALIDATION',
        message: `Invalid input: ${JSON.stringify(parsed.error.flatten())}`,
      },
    };
  }

  const { project_id, project_name, suite_id, search, tags, limit } = parsed.data;
  const clampedLimit = Math.min(limit ?? LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX);

  // Resolve project_name -> UUID when provided (project_id passes through unchanged).
  let resolvedProjectId = project_id;
  if (project_name) {
    const resolved = await resolveProjectId(client, { project_name });
    if ('error' in resolved) return resolved;
    resolvedProjectId = resolved.project_id;
  }

  // ponytail: tag filtering scans one backend page (200 rows) because TCM has no `tags`
  // param and no offset. Scope with project_id/suite_id to stay inside a page; add a
  // server-side `tags` filter to GET /api/test-cases if a project ever outgrows 200 cases.
  const params = tags
    ? new URLSearchParams({ limit: String(BACKEND_MAX_ROWS) })
    : new URLSearchParams({ fields: 'lean', limit: String(clampedLimit) });
  if (resolvedProjectId) params.set('project_id', resolvedProjectId);
  if (suite_id) params.set('suite_id', suite_id);
  if (search) params.set('search', search);

  const res = await client.get<ListTestCasesResult | unknown[]>(`/api/test-cases?${params}`);

  if (!res.ok) {
    return {
      error: {
        code: 'SERVER_ERROR',
        message: `TCM returned ${res.status}`,
      },
    };
  }

  if (tags) {
    // The full projection is a raw array; the { items, ... } envelope only ever comes back
    // for fields=lean, which strips `tags`. So a non-array here means we were handed rows
    // we cannot tag-filter — say so instead of reporting a confident "no matches", which
    // is indistinguishable from a real empty result.
    if (!Array.isArray(res.data)) {
      return { error: { code: 'SERVER_ERROR', message: UNTAGGABLE } };
    }
    const rows = res.data;
    // Same reasoning one level down: an array of rows that simply do not carry `tags`
    // (an older TCM, or a narrowed projection) would match nothing and read as a real
    // empty result. `tags` is NOT NULL DEFAULT '{}' in TCM, so every row of a `select *`
    // has the key — its total absence across a non-empty page means we were not given it.
    if (rows.length > 0 && !rows.some((tc: unknown) => tc !== null && typeof tc === 'object' && 'tags' in tc)) {
      return { error: { code: 'SERVER_ERROR', message: UNTAGGABLE } };
    }
    const wanted = new Set(tags.map((t) => t.trim().toLowerCase()));
    // Rows are guarded, not trusted: the probe above already allows for malformed rows, and
    // a throw here would escape as a raw MCP -32603 (index.ts rethrows non-SessionExpired
    // errors), which is exactly what client.ts's "never throws" contract exists to avoid.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const matched = rows.filter((tc: any) =>
      Array.isArray(tc?.tags) &&
      tc.tags.some((t: unknown) => wanted.has(String(t).trim().toLowerCase())),
    );
    return {
      items: matched.slice(0, clampedLimit).map(toListItem),
      // NB: on this path `total` is "matches within the page we scanned", not a server-side
      // count across the project — it cannot exceed BACKEND_MAX_ROWS. has_more distinguishes
      // a complete count from a capped one.
      total: matched.length,
      // Truncated either by the caller's limit, or by the single backend page we scanned.
      has_more: matched.length > clampedLimit || rows.length >= BACKEND_MAX_ROWS,
    };
  }

  // TCM returns { items, total, has_more } when fields=lean
  if (res.data && typeof res.data === 'object' && 'items' in (res.data as object)) {
    const result = res.data as ListTestCasesResult;
    const notedClamp = (limit ?? LIST_LIMIT_DEFAULT) > LIST_LIMIT_MAX;
    return {
      items: result.items ?? [],
      total: result.total ?? (result.items ?? []).length,
      has_more: result.has_more || notedClamp,
    };
  }

  // Fallback: raw array (older TCM versions without lean support)
  const items = Array.isArray(res.data) ? res.data : [];
  return {
    items: items.map(toListItem),
    total: items.length,
    has_more: false,
  };
}

/**
 * Project a full TCM row down to the lean list item, keeping `tags` (which lean omits).
 *
 * `tags` is omitted entirely when the row has no such key — this helper is shared with the
 * legacy raw-array fallback, where rows may be lean. Emitting `tags: []` there would assert
 * "this case has no tags" when the truth is "we were not told", which the field's doc
 * comment on TestCaseListItem explicitly disclaims.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toListItem(tc: any): TestCaseListItem {
  return {
    display_id: tc.display_id,
    title: tc.title,
    automation_status: tc.automation_status,
    priority: tc.priority,
    ...(tc.tags ? { tags: tc.tags } : {}),
  };
}
