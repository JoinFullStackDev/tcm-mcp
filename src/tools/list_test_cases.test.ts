/**
 * Self-check for list_test_cases request construction and response handling.
 * Run: npm run check   (builds first — the .js specifiers need the compiled output)
 *
 * Tag MATCHING is TCM's job now (TCM#114); what this pins is that we hand TCM the right
 * query and pass its answer back faithfully — the two things that can silently go wrong
 * here without any error surfacing.
 */
import assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { listTestCases } from './list_test_cases.js';
import { VERSION } from '../config.js';
import type { TcmClient } from '../client.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const envelope = (items: unknown[], total?: number, has_more = false) => ({
  items,
  total: total ?? items.length,
  has_more,
});

function fake(data: unknown, urls: string[] = []): TcmClient {
  return {
    get: async (p: string) => (urls.push(p), { ok: true, status: 200, data }),
  } as unknown as TcmClient;
}

(async () => {
  // Tags go as REPEATED params, never comma-joined: TCM splits on commas as a convenience
  // for hand-written URLs, so joining would split a tag that itself contains one.
  const urls: string[] = [];
  await listTestCases(fake(envelope([]), urls), { tags: ['needs-qa-review', 'a,b'] } as never);
  const qs = new URLSearchParams(urls[0].split('?')[1]);
  assert.deepStrictEqual(qs.getAll('tags'), ['needs-qa-review', 'a,b'], 'tags sent as repeated params');
  assert.strictEqual(qs.get('fields'), 'lean', 'lean projection (the only shape with a real total)');

  // TCM's count is authoritative — we must not recompute it from the page we received.
  // This is the regression that mattered: the old client-side scan reported 8 of 25.
  const counted = await listTestCases(
    fake(envelope([{ display_id: 'A-1' }, { display_id: 'A-2' }], 25, true)),
    { tags: ['smoke'] } as never,
  );
  assert('items' in counted && counted.total === 25, 'server total passed through, not items.length');
  assert('items' in counted && counted.has_more === true, 'server has_more passed through');
  assert('items' in counted && counted.items.length === 2, 'items are the page TCM returned');

  // No client-side filtering left: whatever TCM returns is the answer, even if a row's
  // tags look unrelated (it may have matched on a tag lean did not project).
  const trust = await listTestCases(
    fake(envelope([{ display_id: 'B-1', tags: ['other'] }])),
    { tags: ['smoke'] } as never,
  );
  assert('items' in trust && trust.items.length === 1, 'results are not re-filtered locally');

  // Untagged calls must not grow a tags param.
  const plain: string[] = [];
  await listTestCases(fake(envelope([]), plain), { project_id: PROJECT, limit: 25 } as never);
  assert(!plain[0].includes('tags'), 'no tags param on untagged calls');
  assert(plain[0].includes('limit=25') && plain[0].includes(`project_id=${PROJECT}`), 'other filters intact');

  // Over-max limit is clamped and flagged rather than silently truncated.
  const clamped = await listTestCases(fake(envelope([])), { limit: 500 } as never);
  assert('error' in clamped, 'limit above max is a validation error');

  // Legacy raw-array fallback still works, and must not invent a `tags` field.
  const legacy = await listTestCases(fake([{ display_id: 'L-1', title: 'l' }]), {} as never);
  assert('items' in legacy && !('tags' in legacy.items[0]), 'tags omitted when TCM did not send it');

  // config.VERSION and package.json must agree.
  const pkgVersion = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')).version;
  assert.strictEqual(VERSION, pkgVersion, `config.VERSION ${VERSION} != package.json ${pkgVersion}`);

  console.log('list_test_cases tag passthrough: all checks passed');
})();
