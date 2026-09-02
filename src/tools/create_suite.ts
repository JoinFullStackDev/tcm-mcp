/**
 * create_suite — Create a new test suite in a project.
 *
 * Proxies: POST /api/projects/{projectId}/suites
 * Accepts project_id OR project_name (exactly one), resolved the same way as search_suite.
 */

import { z } from 'zod';
import type { TcmClient } from '../client.js';
import type { SuiteRef, McpError } from '../types.js';
import { resolveProjectId } from './resolve_project.js';

export const createSuiteInputSchema = z
  .object({
    project_id: z.string().uuid('project_id must be a valid UUID').optional(),
    project_name: z.string().min(1).optional(),
    name: z.string().min(1, 'name is required'),
    prefix: z.string().min(1, 'prefix is required').max(20),
    description: z.string().nullable().optional(),
    group: z.string().optional(),
  })
  .refine((d) => (d.project_id ? 1 : 0) + (d.project_name ? 1 : 0) === 1, {
    message: 'Provide exactly one of project_id or project_name.',
  });

export type CreateSuiteInput = z.infer<typeof createSuiteInputSchema>;

export async function createSuite(
  client: TcmClient,
  input: CreateSuiteInput,
): Promise<SuiteRef | McpError> {
  const parsed = createSuiteInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      error: {
        code: 'VALIDATION',
        message: `Invalid input: ${JSON.stringify(parsed.error.flatten())}`,
      },
    };
  }

  const resolved = await resolveProjectId(client, {
    project_id: parsed.data.project_id,
    project_name: parsed.data.project_name,
  });
  if ('error' in resolved) return resolved;
  const project_id = resolved.project_id;

  const body = {
    name: parsed.data.name,
    prefix: parsed.data.prefix,
    description: parsed.data.description ?? null,
    group: parsed.data.group ?? null,
  };

  const res = await client.post<SuiteRef>(
    `/api/projects/${project_id}/suites`,
    body,
  );

  if (!res.ok) {
    return {
      error: {
        code: 'SERVER_ERROR',
        message: `TCM returned ${res.status}: ${JSON.stringify(res.data)}`,
      },
    };
  }

  const suite = res.data as SuiteRef;
  return {
    suite_id: suite.suite_id,
    name: suite.name,
    prefix: suite.prefix,
    project_id: suite.project_id,
    group: suite.group,
    test_case_count: suite.test_case_count ?? 0,
  };
}
