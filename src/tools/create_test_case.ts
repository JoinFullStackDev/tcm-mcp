/**
 * create_test_case — Create a test case (with steps) via dry-run → approval → commit.
 *
 * Proxies: POST /api/test-cases (with dry_run support via E4 extension)
 * PRD §8.4, OQ-6 Option B
 */

import { z } from 'zod';
import type { TcmClient } from '../client.js';
import type { TestCaseDetail, CreateDryRunResult, McpError } from '../types.js';
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

export const createTestCaseInputSchema = z.object({
  suite_id: z.string().uuid('suite_id must be a valid UUID'),
  title: z.string().min(1, 'Title is required').max(500),
  precondition: z.string().max(5000).nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
  /** v1: low/medium/high only. critical is deferred to v2 (OQ-5). */
  priority: priorityEnum.nullable().optional(),
  automation_status: automationStatusEnum.optional().default('not_automated'),
  /** Constrained enum — desktop/tablet/mobile only, not free-form (PRD §7). */
  platform_tags: z.array(platformTagEnum).optional().default([]),
  tags: z.array(z.string().max(50)).optional().default([]),
  steps: z.array(stepInputSchema).min(0),
  /**
   * dry_run: true → validate + return summary, no write.
   * false/omitted → commit.
   * (OQ-6 Option B: dry_run is passed to TCM REST endpoint for server-side logging.)
   */
  dry_run: z.boolean().optional().default(false),
});

export type CreateTestCaseInput = z.infer<typeof createTestCaseInputSchema>;

export async function createTestCase(
  client: TcmClient,
  input: CreateTestCaseInput,
  correlationId?: string,
): Promise<TestCaseDetail | CreateDryRunResult | McpError> {
  const parsed = createTestCaseInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      error: {
        code: 'VALIDATION',
        message: `Invalid input: ${JSON.stringify(parsed.error.flatten())}`,
      },
    };
  }

  const data = parsed.data;
  const isDryRun = data.dry_run === true;

  // Compute payload hash for audit correlation
  const payloadHash = hashPayload({
    suite_id: data.suite_id,
    title: data.title,
    precondition: data.precondition,
    description: data.description,
    priority: data.priority,
    automation_status: data.automation_status,
    platform_tags: data.platform_tags,
    tags: data.tags,
    steps: data.steps,
  });

  const body = {
    suite_id: data.suite_id,
    title: data.title,
    precondition: data.precondition ?? null,
    description: data.description ?? null,
    priority: data.priority ?? null,
    automation_status: data.automation_status,
    platform_tags: data.platform_tags,
    tags: data.tags,
    steps: data.steps.map((s, i) => ({ ...s, step_number: i + 1 })),
    dry_run: isDryRun,
  };

  const res = await client.post<TestCaseDetail | CreateDryRunResult | { error: string }>(
    '/api/test-cases',
    body,
    {
      correlationId,
      intent: isDryRun ? 'dry-run-create' : 'commit-create',
    },
  );

  if (res.status === 400) {
    return {
      error: {
        code: 'VALIDATION',
        message: `Validation failed: ${JSON.stringify((res.data as { error?: string; details?: unknown })?.details ?? res.data)}`,
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

  // Return dry-run result or committed case
  const result = res.data as TestCaseDetail | CreateDryRunResult;

  // Attach payload hash to result for audit reference (not in PRD shape — extra)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { ...(result as any), _payload_hash: payloadHash } as unknown as typeof result;
}
