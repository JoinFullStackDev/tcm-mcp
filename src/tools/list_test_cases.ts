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
 * Tag filtering is done by TCM (TCM#114): `tags` is forwarded as a query param and the
 * database does the matching, ANY-of and case-insensitive. This replaced an in-process
 * scan of one 200-row page, which silently under-reported on any project larger than
 * that — FullStackRX has 494 cases, where `smoke` returned 8 instead of 25.
 */

import { z } from 'zod';
import type { TcmClient } from '../client.js';
import type { ListTestCasesResult, McpError, TestCaseListItem } from '../types.js';
import { resolveProjectId } from './resolve_project.js';

const LIST_LIMIT_MAX = 200;
const LIST_LIMIT_DEFAULT = 50;

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
  // No Math.min needed: the schema's .max(LIST_LIMIT_MAX) rejects anything larger.
  const effectiveLimit = limit ?? LIST_LIMIT_DEFAULT;

  // Resolve project_name -> UUID when provided (project_id passes through unchanged).
  let resolvedProjectId = project_id;
  if (project_name) {
    const resolved = await resolveProjectId(client, { project_name });
    if ('error' in resolved) return resolved;
    resolvedProjectId = resolved.project_id;
  }

  const params = new URLSearchParams({ fields: 'lean', limit: String(effectiveLimit) });
  // Repeated params rather than a comma-joined value, so a tag containing a comma
  // survives: TCM splits on commas as a convenience for hand-written URLs.
  // Trimmed here as well as server-side, so a tag pasted from a UI label with stray
  // whitespace doesn't depend on the backend to clean it up.
  if (tags) for (const t of tags) params.append('tags', t.trim());
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

  // TCM returns { items, total, has_more } when fields=lean
  if (res.data && typeof res.data === 'object' && 'items' in (res.data as object)) {
    const result = res.data as ListTestCasesResult;
    const items = result.items ?? [];

    // Confirm TCM actually applied the filter. A backend predating the server-side `tags`
    // support — or a proxy that drops unknown query params — ignores `tags` and returns the
    // ordinary page, which we would otherwise report as "these are your matches": 494
    // arbitrary cases presented as tagged `smoke`. That is worse than the under-reporting
    // this passthrough replaced, so it has to fail loudly.
    //
    // The filter is ANY-of, so if it ran, EVERY returned row carries a requested tag.
    if (tags && items.length > 0) {
      const wanted = new Set(tags.map((t) => t.trim().toLowerCase()));
      const honoured = items.every(
        (i) =>
          Array.isArray(i.tags) &&
          i.tags.some((t) => wanted.has(String(t).trim().toLowerCase())),
      );
      if (!honoured) {
        return {
          error: {
            code: 'SERVER_ERROR',
            message:
              'TCM returned rows that do not all carry a requested tag, so the `tags` filter ' +
              'was not applied (or its response omits `tags` and cannot be verified). ' +
              'Results are NOT filtered by tag — retry without `tags`, or upgrade TCM.',
          },
        };
      }
    }

    return {
      items,
      total: result.total ?? items.length,
      has_more: result.has_more ?? false,
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
