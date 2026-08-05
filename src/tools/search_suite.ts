/**
 * search_suite — Resolve a suite name or prefix to a suite reference.
 *
 * Proxies: GET /api/projects/{projectId}/suites?search={name_or_prefix}
 * PRD §8.1
 */

import { z } from 'zod';
import type { TcmClient } from '../client.js';
import type { SuiteRef, McpError } from '../types.js';

export const searchSuiteInputSchema = z.object({
  project_id: z.string().uuid('project_id must be a valid UUID'),
  name_or_prefix: z.string().min(1, 'name_or_prefix is required'),
});

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

  const { project_id, name_or_prefix } = parsed.data;
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

  // Map TCM response to SuiteRef shape (TCM returns id, not suite_id)
  return suites.map((s: SuiteRef & { id?: string }) => ({
    suite_id: (s as { id?: string; suite_id?: string }).id ?? s.suite_id,
    name: s.name,
    prefix: s.prefix,
    project_id: s.project_id,
  })) as SuiteRef[];
}
