/**
 * list_suites — Enumerate every suite in a project (no search term).
 *
 * Proxies: GET /api/projects/{projectId}/suites   (no ?search — TCM returns all,
 * position-ordered). Each suite carries its `group` (role label) and `test_case_count`.
 *
 * This is the "list all" counterpart to search_suite. search_suite is for resolving a
 * name/prefix to a suite and returns NOT_FOUND when nothing matches; list_suites returns
 * the full set and an empty project legitimately yields []. Accepts project_id OR
 * project_name (exactly one), resolved the same way as search_suite.
 */

import { z } from 'zod';
import type { TcmClient } from '../client.js';
import type { SuiteRef, McpError } from '../types.js';
import { resolveProjectId } from './resolve_project.js';
import { toSuiteRefs } from './search_suite.js';

export const listSuitesInputSchema = z
  .object({
    project_id: z.string().uuid('project_id must be a valid UUID').optional(),
    project_name: z.string().min(1).optional(),
  })
  .refine((d) => (d.project_id ? 1 : 0) + (d.project_name ? 1 : 0) === 1, {
    message: 'Provide exactly one of project_id or project_name.',
  });

export type ListSuitesInput = z.infer<typeof listSuitesInputSchema>;

export async function listSuites(
  client: TcmClient,
  input: ListSuitesInput,
): Promise<SuiteRef[] | McpError> {
  const parsed = listSuitesInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      error: {
        code: 'VALIDATION',
        message: `Invalid input: ${JSON.stringify(parsed.error.flatten())}`,
      },
    };
  }

  // Resolve project_id (pass-through) or project_name (name -> UUID lookup).
  const resolved = await resolveProjectId(client, {
    project_id: parsed.data.project_id,
    project_name: parsed.data.project_name,
  });
  if ('error' in resolved) return resolved;
  const project_id = resolved.project_id;

  // No ?search — the backend returns every suite in the project, position-ordered.
  const res = await client.get<SuiteRef[]>(
    `/api/projects/${project_id}/suites`,
  );

  if (!res.ok) {
    return {
      error: {
        code: 'SERVER_ERROR',
        message: `TCM returned ${res.status}`,
      },
    };
  }

  // An empty project legitimately returns [] — no NOT_FOUND here (that's search_suite's job).
  return toSuiteRefs(res.data ?? []);
}
