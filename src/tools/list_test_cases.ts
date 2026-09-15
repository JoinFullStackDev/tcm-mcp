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

/** TCM caps /api/test-cases at 200 rows and exposes no offset — this is one full page. */
const BACKEND_MAX_ROWS = 200;

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
      return {
        error: {
          code: 'SERVER_ERROR',
          message:
            'TCM returned a projection without tags, so the tags filter cannot be applied. ' +
            'Retry without `tags`, or upgrade TCM to a build whose /api/test-cases supports tag filtering.',
        },
      };
    }
    const rows = res.data;
    const wanted = new Set(tags.map((t) => t.trim().toLowerCase()));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const matched = rows.filter((tc: any) =>
      (tc.tags ?? []).some((t: string) => wanted.has(String(t).trim().toLowerCase())),
    );
    return {
      items: matched.slice(0, clampedLimit).map(toListItem),
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

/** Project a full TCM row down to the lean list item (keeping tags, which lean omits). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toListItem(tc: any): TestCaseListItem {
  return {
    display_id: tc.display_id,
    title: tc.title,
    automation_status: tc.automation_status,
    priority: tc.priority,
    tags: tc.tags ?? [],
  };
}
