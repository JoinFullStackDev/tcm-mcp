/**
 * get_test_case — Full detail for a single test case, including all steps.
 *
 * Proxies: GET /api/test-cases/by-display-id/{displayId}
 * PRD §8.3
 */

import { z } from 'zod';
import type { TcmClient } from '../client.js';
import type { TestCaseDetail, McpError } from '../types.js';

export const getTestCaseInputSchema = z.object({
  display_id: z.string().min(1, 'display_id is required'),
});

export type GetTestCaseInput = z.infer<typeof getTestCaseInputSchema>;

export async function getTestCase(
  client: TcmClient,
  input: GetTestCaseInput,
): Promise<TestCaseDetail | McpError> {
  const parsed = getTestCaseInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      error: {
        code: 'VALIDATION',
        message: `Invalid input: ${JSON.stringify(parsed.error.flatten())}`,
      },
    };
  }

  const { display_id } = parsed.data;
  const path = `/api/test-cases/by-display-id/${encodeURIComponent(display_id)}`;

  const res = await client.get<TestCaseDetail | { error: string }>(path);

  if (res.status === 404) {
    return {
      error: {
        code: 'NOT_FOUND',
        message: `Test case "${display_id}" not found or deleted`,
      },
    };
  }

  if (!res.ok) {
    return {
      error: {
        code: 'SERVER_ERROR',
        message: `TCM returned ${res.status}`,
      },
    };
  }

  return res.data as TestCaseDetail;
}
