/**
 * list_projects — Discover the projects the caller can see (issue #3, Part 1).
 *
 * Proxies: GET /api/projects?fields=lean&search=&limit=
 *
 * The MCP has no notion of a "current project"; scoping is by argument. This tool lets an
 * agent resolve a project name -> UUID before calling search_suite / list_test_cases.
 *
 * `fetchProjects` is the shared proxy used both here and by resolve_project.ts (Part 2).
 */

import { z } from 'zod';
import type { TcmClient } from '../client.js';
import type { ListProjectsResult, ProjectRef, McpError } from '../types.js';

const LIST_LIMIT_MAX = 200;
const LIST_LIMIT_DEFAULT = 50;

export const listProjectsInputSchema = z.object({
  search: z.string().optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(LIST_LIMIT_MAX)
    .optional()
    .default(LIST_LIMIT_DEFAULT),
});

export type ListProjectsInput = z.infer<typeof listProjectsInputSchema>;

/**
 * Fetch the visible projects (lean projection). Returns a normalized
 * { items, total, has_more } result, or an McpError on a non-ok response.
 *
 * Tolerates two TCM shapes: the lean envelope { items, total, has_more } (id already
 * mapped to project_id server-side) and a legacy raw array (older TCM without lean
 * support), which is mapped + filtered + clamped client-side.
 */
export async function fetchProjects(
  client: TcmClient,
  opts: { search?: string; limit?: number } = {},
): Promise<ListProjectsResult | McpError> {
  const clampedLimit = Math.min(opts.limit ?? LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX);

  const params = new URLSearchParams({ fields: 'lean', limit: String(clampedLimit) });
  if (opts.search) params.set('search', opts.search);

  const res = await client.get<ListProjectsResult | unknown[]>(`/api/projects?${params}`);

  if (!res.ok) {
    return {
      error: {
        code: 'SERVER_ERROR',
        message: `TCM returned ${res.status}`,
      },
    };
  }

  // Preferred: lean envelope from TCM.
  if (res.data && typeof res.data === 'object' && 'items' in (res.data as object)) {
    const result = res.data as ListProjectsResult;
    return {
      items: result.items ?? [],
      total: result.total ?? (result.items ?? []).length,
      has_more: result.has_more ?? false,
    };
  }

  // Fallback: legacy raw array (older TCM without lean). Map id -> project_id and apply
  // the search + limit client-side so callers see a consistent envelope.
  const arr = Array.isArray(res.data) ? res.data : [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let items: ProjectRef[] = arr.map((p: any) => ({
    project_id: p.project_id ?? p.id,
    name: p.name,
    suite_count: p.suite_count,
    test_case_count: p.test_case_count,
  }));
  if (opts.search) {
    const needle = opts.search.toLowerCase();
    items = items.filter((p) => (p.name ?? '').toLowerCase().includes(needle));
  }
  const total = items.length;
  const clamped = items.slice(0, clampedLimit);
  return { items: clamped, total, has_more: total > clamped.length };
}

export async function listProjects(
  client: TcmClient,
  input: ListProjectsInput,
): Promise<ListProjectsResult | McpError> {
  const parsed = listProjectsInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      error: {
        code: 'VALIDATION',
        message: `Invalid input: ${JSON.stringify(parsed.error.flatten())}`,
      },
    };
  }

  return fetchProjects(client, parsed.data);
}
