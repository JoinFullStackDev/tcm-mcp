/**
 * Self-check for the client-side tag filter in list_test_cases.
 * Run: npx ts-node src/tools/list_test_cases.test.ts
 */
import assert from 'assert';
import { listTestCases } from './list_test_cases.js';
import type { TcmClient } from '../client.js';

const ROWS = [
  { display_id: 'TRI-3', title: 'a', automation_status: 'not_automated', priority: null, tags: ['needs-qa-review', 'imported-from-dev-tests'] },
  { display_id: 'LOG-1', title: 'b', automation_status: 'in_cicd', priority: 'medium', tags: ['Smoke'] },
  { display_id: 'APA-1', title: 'c', automation_status: 'not_automated', priority: null, tags: [] },
  { display_id: 'NO-TAGS', title: 'd', automation_status: 'not_automated', priority: null },
];

function fake(rows: unknown[], urls: string[] = []): TcmClient {
  return { get: async (p: string) => (urls.push(p), { ok: true, status: 200, data: rows }) } as unknown as TcmClient;
}

(async () => {
  const urls: string[] = [];
  const hit = await listTestCases(fake(ROWS, urls), { tags: ['NEEDS-QA-REVIEW'] } as never);
  assert('items' in hit && hit.items.map((i) => i.display_id).join() === 'TRI-3', 'case-insensitive match');
  assert('items' in hit && hit.items[0].tags?.length === 2, 'tags echoed back');
  assert(!urls[0].includes('fields=lean') && urls[0].includes('limit=200'), 'tags path skips lean, asks full page');

  // ANY-of semantics: two tags that live on different cases both match.
  const any = await listTestCases(fake(ROWS), { tags: ['smoke', 'imported-from-dev-tests'] } as never);
  assert('items' in any && any.items.length === 2, 'ANY-of match');

  // A row with no tags key must not blow up, and must not match.
  const none = await listTestCases(fake(ROWS), { tags: ['nope'] } as never);
  assert('items' in none && none.items.length === 0 && none.total === 0, 'no match is empty, not a throw');

  // A full backend page means the scan was truncated -> has_more.
  const full = Array.from({ length: 200 }, () => ROWS[0]);
  const trunc = await listTestCases(fake(full), { tags: ['Smoke'] } as never);
  assert('items' in trunc && trunc.has_more === true, 'full page => has_more');

  // limit caps items but total reports every match.
  const capped = await listTestCases(fake(full), { tags: ['needs-qa-review'], limit: 5 } as never);
  assert('items' in capped && capped.items.length === 5 && capped.total === 200, 'limit caps items, total is real');

  // No tags => untouched lean path.
  const leanUrls: string[] = [];
  await listTestCases(fake({ items: [], total: 0, has_more: false } as never, leanUrls), {} as never);
  assert(leanUrls[0].includes('fields=lean'), 'lean path unchanged when no tags');

  // An envelope reaching the tags path means lean rows (no `tags`) — must be a loud
  // error, not an empty list that reads as "nothing carries this tag".
  const envelope = await listTestCases(
    fake({ items: [{ display_id: 'X-1' }], total: 1, has_more: false } as never),
    { tags: ['smoke'] } as never,
  );
  assert('error' in envelope && envelope.error.code === 'SERVER_ERROR', 'untaggable projection errors loudly');

  // Back-compat: a client that never sends `tags` (e.g. a pinned v1.4.0 install) must
  // produce the exact same request as before — lean projection, no tags param.
  const oldUrls: string[] = [];
  await listTestCases(fake({ items: [], total: 0, has_more: false } as never, oldUrls), {
    project_id: '11111111-1111-4111-8111-111111111111',
    search: 'login',
    limit: 25,
  } as never);
  assert(oldUrls[0].includes('fields=lean') && oldUrls[0].includes('limit=25'), 'v1.4.0-shaped call unchanged');
  assert(!oldUrls[0].includes('tags'), 'no tags param leaks into untagged calls');

  console.log('list_test_cases tag filter: all checks passed');
})();
