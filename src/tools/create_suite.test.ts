/**
 * Self-check for create_suite's response mapping.
 * Run: npm run check   (builds first — the .js specifiers need the compiled output)
 */
import assert from 'assert';
import { createSuite } from './create_suite.js';
import type { TcmClient } from '../client.js';

const PROJECT = '577edc11-e8c6-44e6-932f-150e5d9e4c15';
const SUITE = '9fa99db1-b2a3-487e-a9c7-1c48414b934e';

/** TCM returns the raw suites row: primary key `id`, no `suite_id`. */
const TCM_ROW = {
  id: SUITE,
  project_id: PROJECT,
  name: 'Login',
  prefix: 'LOG',
  group: 'QA',
  description: null,
  position: 0,
};

type Call = { path: string; body: unknown; opts: Record<string, unknown> | undefined };

function fake(status: number, data: unknown, calls: Call[] = []): TcmClient {
  return {
    get: async () => ({ ok: true, status: 200, data: [{ id: PROJECT, name: 'FullStackRX' }] }),
    post: async (path: string, body: unknown, opts?: Record<string, unknown>) => {
      calls.push({ path, body, opts });
      return { ok: status >= 200 && status < 300, status, data };
    },
  } as unknown as TcmClient;
}

(async () => {
  const calls: Call[] = [];
  const ok = await createSuite(
    fake(201, TCM_ROW, calls),
    { project_id: PROJECT, name: 'Login', prefix: 'LOG', group: 'QA' } as never,
    'corr-123',
  );

  // The bug this file exists for: reading res.data.suite_id gave undefined, which then
  // failed create_test_case's z.string().uuid() check.
  assert(!('error' in ok), 'create succeeded');
  assert.strictEqual(ok.suite_id, SUITE, 'suite_id mapped from TCM\'s `id`');
  assert.notStrictEqual(ok.suite_id, undefined, 'suite_id is not undefined');
  assert.strictEqual(ok.project_id, PROJECT, 'project_id populated');
  assert.strictEqual(ok.name, 'Login');
  assert.strictEqual(ok.prefix, 'LOG');
  assert.strictEqual(ok.group, 'QA');
  assert.strictEqual(ok.test_case_count, 0, 'fresh suite counts zero, not undefined');

  // Audit correlation (Appendix C) — every other write sends these.
  assert.strictEqual(calls[0].opts?.correlationId, 'corr-123', 'correlation id forwarded');
  assert.strictEqual(calls[0].opts?.intent, 'commit-create-suite', 'intent tagged');

  // A rejected payload must not look like a transient fault, or agents retry forever.
  const dup = await createSuite(
    fake(400, { error: 'Validation failed', details: { prefix: 'already in use' } }),
    { project_id: PROJECT, name: 'Login', prefix: 'LOG' } as never,
  );
  assert('error' in dup && dup.error.code === 'VALIDATION', '400 maps to VALIDATION');
  assert('error' in dup && dup.error.message.includes('already in use'), 'details surfaced');

  // Genuine server faults still read as such.
  const boom = await createSuite(fake(500, { error: 'boom' }), {
    project_id: PROJECT, name: 'Login', prefix: 'LOG',
  } as never);
  assert('error' in boom && boom.error.code === 'SERVER_ERROR', '500 stays SERVER_ERROR');

  // Defensive: a TCM build that ever returns `suite_id` still maps (toSuiteRefs handles both).
  const alt = await createSuite(
    fake(201, { suite_id: SUITE, project_id: PROJECT, name: 'L', prefix: 'L', group: null }),
    { project_id: PROJECT, name: 'L', prefix: 'L' } as never,
  );
  assert(!('error' in alt) && alt.suite_id === SUITE, 'suite_id shape also accepted');

  console.log('create_suite response mapping: all checks passed');
})();
