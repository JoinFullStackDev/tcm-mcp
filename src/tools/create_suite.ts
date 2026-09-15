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
import { toSuiteRefs } from './search_suite.js';

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
  correlationId?: string,
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

  const res = await client.post<unknown>(`/api/projects/${project_id}/suites`, body, {
    correlationId,
    intent: 'commit-create-suite',
  });

  // A rejected payload — name too long, bad group (400), or a prefix already used in this
  // project (409, via TCM's conflict() helper). Reporting any of them as SERVER_ERROR reads
  // to an agent as a transient fault, so it retries a create that can never succeed.
  // 409 is the common one in practice and was the case this branch originally cited while
  // only handling 400. Mirrors create_test_case / update_test_case, which both map 409.
  if (res.status === 400 || res.status === 409 || res.status === 422) {
    return {
      error: {
        code: 'VALIDATION',
        message: `Validation failed: ${JSON.stringify(
          (res.data as { error?: string; details?: unknown })?.details ?? res.data,
        )}`,
      },
    };
  }

  if (!res.ok) {
    return {
      error: {
        code: 'SERVER_ERROR',
        message: `TCM returned ${res.status}: ${JSON.stringify(res.data)}`,
      },
    };
  }

  // client.ts sets data = null whenever the body doesn't parse as JSON while ok stays true
  // — an empty 201, or an HTML page from an intervening proxy. toSuiteRefs would dereference
  // that null and the TypeError would escape as a raw MCP -32603, since index.ts only
  // converts SessionExpiredError. Return a structured error instead, as client.ts promises.
  if (!res.data || typeof res.data !== 'object') {
    return {
      error: {
        code: 'SERVER_ERROR',
        message: `TCM returned ${res.status} with no suite body.`,
      },
    };
  }

  // TCM returns the raw suites row, whose primary key is `id` — not `suite_id`. Reading
  // res.data.suite_id directly yielded undefined, which then failed create_test_case's
  // uuid check. toSuiteRefs is the shared normalizer that already knows this; go through it
  // rather than re-deriving the mapping here.
  const suite = toSuiteRefs([res.data])[0];

  // A shape toSuiteRefs can't map (e.g. a wrapped `{ suite: {...} }`) yields undefined with
  // no error — the original bug, just silent. Fail loudly rather than hand create_test_case
  // an undefined it will reject with a confusing uuid error.
  if (!suite?.suite_id) {
    return {
      error: {
        code: 'SERVER_ERROR',
        message: `TCM returned ${res.status} without a recognisable suite id: ${JSON.stringify(res.data)}`,
      },
    };
  }
  return {
    ...suite,
    // The POST response predates any test cases, and TCM does not project a count onto it.
    project_id: suite.project_id ?? project_id,
    test_case_count: suite.test_case_count ?? 0,
  };
}
