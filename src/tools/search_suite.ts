/**
 * search_suite — Resolve a suite name or prefix to a suite reference.
 *
 * Proxies: GET /api/projects/{projectId}/suites?search={name_or_prefix}
 * PRD §8.1
 *
 * Issue #3 Part 2: accepts project_id OR project_name (exactly one). A project_name is
 * resolved to a UUID via resolveProjectId before the suites lookup.
 */

import { z } from 'zod';
import type { TcmClient } from '../client.js';
import type { SuiteRef, McpError } from '../types.js';
import { resolveProjectId } from './resolve_project.js';

export const searchSuiteInputSchema = z
  .object({
    project_id: z.string().uuid('project_id must be a valid UUID').optional(),
    project_name: z.string().min(1).optional(),
    name_or_prefix: z.string().min(1, 'name_or_prefix is required'),
  })
  .refine(
    (d) => (d.project_id ? 1 : 0) + (d.project_name ? 1 : 0) === 1,
    { message: 'Provide exactly one of project_id or project_name.' },
  );

export type SearchSuiteInput = z.infer<typeof searchSuiteInputSchema>;

export async function searchSuite(
  client: TcmClient,
  input: SearchSuiteInput,
): Promise<SuiteRef[] | McpError> {
  const parsed = searchSuiteInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      error: {
        code: 'VALIDATION',
        message: `Invalid input: ${JSON.stringify(parsed.error.flatten())}`,
      },
    };
  }

  const { name_or_prefix } = parsed.data;

  // Resolve project_id (pass-through) or project_name (name -> UUID lookup).
  const resolved = await resolveProjectId(client, {
    project_id: parsed.data.project_id,
    project_name: parsed.data.project_name,
  });
  if ('error' in resolved) return resolved;
  const project_id = resolved.project_id;

  const path = `/api/projects/${project_id}/suites?search=${encodeURIComponent(name_or_prefix)}`;

  const res = await client.get<SuiteRef[]>(path);

  if (!res.ok) {
    return {
      error: {
        code: 'SERVER_ERROR',
        message: `TCM returned ${res.status}`,
      },
    };
  }

  const suites = res.data ?? [];

  if (suites.length === 0) {
    return {
      error: {
        code: 'NOT_FOUND',
        message: `No suite found matching "${name_or_prefix}" in project ${project_id}`,
      },
    };
  }

  return toSuiteRefs(suites);
}

/**
 * Map a raw TCM suites payload to SuiteRef[]. TCM returns `id` (not `suite_id`) and
 * carries `group` + `test_case_count`; keep them so list_suites / search_suite expose
 * the role label and the truncation-guard count. Shared with list_suites.
 */
export function toSuiteRefs(suites: unknown[]): SuiteRef[] {
  return (suites as Array<Record<string, unknown>>).map((s) => ({
    suite_id: (s.id ?? s.suite_id) as string,
    name: s.name as string,
    prefix: s.prefix as string,
    project_id: s.project_id as string,
    group: (s.group ?? null) as string | null,
    test_case_count: s.test_case_count as number | undefined,
  }));
}
