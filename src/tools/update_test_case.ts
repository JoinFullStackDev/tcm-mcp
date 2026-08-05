/**
 * update_test_case — Partial update of an existing test case; steps are full-replace when provided.
 *
 * Proxies: PATCH /api/test-cases/by-display-id/{displayId} (E5)
 * PRD §8.5, OQ-6 Option B
 */

import { z } from 'zod';
import type { TcmClient } from '../client.js';
import type { TestCaseDetail, UpdateDryRunResult, McpError } from '../types.js';
import { hashPayload } from '../client.js';

const priorityEnum = z.enum(['low', 'medium', 'high']);
const automationStatusEnum = z.enum(['not_automated', 'scripted', 'in_cicd', 'out_of_sync']);
const platformTagEnum = z.enum(['desktop', 'tablet', 'mobile']);

const stepInputSchema = z.object({
  description: z.string().min(1, 'Step description is required').max(5000),
  test_data: z.string().max(5000).nullable().optional(),
  expected_result: z.string().max(5000).nullable().optional(),
  is_automation_only: z.boolean().optional().default(false),
});

export const updateTestCaseInputSchema = z.object({
  display_id: z.string().min(1, 'display_id is required'),
  title: z.string().min(1).max(500).optional(),
  precondition: z.string().max(5000).nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
  /** v1: low/medium/high only. critical deferred to v2 (OQ-5). */
  priority: priorityEnum.nullable().optional(),
  automation_status: automationStatusEnum.optional(),
  platform_tags: z.array(platformTagEnum).optional(),
  tags: z.array(z.string().max(50)).optional(),
  /**
   * If provided, wipes ALL existing steps and inserts these (full-replace).
   * The dry-run summary shows the full before/after step list.
   * If omitted, steps are untouched.
   */
  steps: z.array(stepInputSchema).optional(),
  /**
   * dry_run: true → validate, resolve IDs, compute and return diff. No write.
   * false/omitted → commit.
   */
  dry_run: z.boolean().optional().default(false),
});

export type UpdateTestCaseInput = z.infer<typeof updateTestCaseInputSchema>;

export async function updateTestCase(
  client: TcmClient,
  input: UpdateTestCaseInput,
  correlationId?: string,
): Promise<TestCaseDetail | UpdateDryRunResult | McpError> {
  const parsed = updateTestCaseInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      error: {
        code: 'VALIDATION',
        message: `Invalid input: ${JSON.stringify(parsed.error.flatten())}`,
      },
    };
  }

  const { display_id, dry_run, ...updates } = parsed.data;
  const isDryRun = dry_run === true;

  // Compute payload hash for audit correlation
  const payloadHash = hashPayload({ display_id, ...updates });

  const body = {
    ...updates,
    dry_run: isDryRun,
  };

  const path = `/api/test-cases/by-display-id/${encodeURIComponent(display_id)}${isDryRun ? '?dry_run=true' : ''}`;

  const res = await client.patch<TestCaseDetail | UpdateDryRunResult | { error: string; code?: string }>(
    path,
    body,
    {
      correlationId,
      intent: isDryRun ? 'dry-run-update' : 'commit-update',
    },
  );

  if (res.status === 404) {
    return {
      error: {
        code: 'NOT_FOUND',
        message: `Test case "${display_id}" not found or deleted`,
      },
    };
  }

  if (res.status === 409) {
    const errData = res.data as { error?: string; code?: string };
    const code = errData?.code === 'IN_CICD_LOCKED' ? 'IN_CICD_LOCKED' as const : 'SERVER_ERROR' as const;
    return {
      error: {
        code,
        message: errData?.error ?? 'Conflict: test case may be in_cicd locked',
      },
    };
  }

  if (res.status === 400) {
    return {
      error: {
        code: 'VALIDATION',
        message: `Validation failed: ${JSON.stringify((res.data as { details?: unknown })?.details ?? res.data)}`,
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

  const result = res.data as TestCaseDetail | UpdateDryRunResult;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { ...(result as any), _payload_hash: payloadHash } as unknown as typeof result;
}
