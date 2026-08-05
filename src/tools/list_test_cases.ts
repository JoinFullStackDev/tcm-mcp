/**
 * list_test_cases — Filterable, lightweight list of test cases.
 *
 * Proxies: GET /api/test-cases?project_id=&suite_id=&search=&limit=&fields=lean
 * PRD §8.2
 *
 * Issue #3 Part 2: optionally accepts project_name as an alternative to project_id
 * (resolved to a UUID via resolveProjectId). Passing both is a VALIDATION error.
 * Passing neither is still valid (unscoped list across all visible projects).
 */

import { z } from 'zod';
import type { TcmClient } from '../client.js';
import type { ListTestCasesResult, McpError } from '../types.js';
import { resolveProjectId } from './resolve_project.js';

const LIST_LIMIT_MAX = 200;
const LIST_LIMIT_DEFAULT = 50;

export const listTestCasesInputSchema = z
  .object({
    project_id: z.string().uuid().optional(),
    project_name: z.string().min(1).optional(),
    suite_id: z.string().uuid().optional(),
    search: z.string().optional(),
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

  const { project_id, project_name, suite_id, search, limit } = parsed.data;
  const clampedLimit = Math.min(limit ?? LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX);

  // Resolve project_name -> UUID when provided (project_id passes through unchanged).
  let resolvedProjectId = project_id;
  if (project_name) {
    const resolved = await resolveProjectId(client, { project_name });
    if ('error' in resolved) return resolved;
    resolvedProjectId = resolved.project_id;
  }

  const params = new URLSearchParams({ fields: 'lean', limit: String(clampedLimit) });
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    items: items.map((tc: any) => ({
      display_id: tc.display_id,
      title: tc.title,
      automation_status: tc.automation_status,
      priority: tc.priority,
    })),
    total: items.length,
    has_more: false,
  };
}
