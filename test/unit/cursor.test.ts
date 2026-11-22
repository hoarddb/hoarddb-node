// SPDX-License-Identifier: Apache-2.0
//
// The cursor, against a page fetcher the test controls: it fetches a page only when the one before is
// spent, stops at done or at the limit, halves a page on RESULT_TOO_LARGE as often as it takes (down to
// one item, so never without end), keeps a size that worked for the next page, and reports a page that
// cannot fit even one item (build doc step 13).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Cursor, type Page, type PageFetcher } from '../../src/cursor.js';
import { ResultTooLargeError } from '../../src/errors.js';

/** A fetcher that answers each call with the next page of the script, and counts the calls. */
function scripted(pages: Page<number>[]): { fetch: PageFetcher<number>; calls: { pageSize: number }[] } {
  const calls: { pageSize: number }[] = [];
  const fetch: PageFetcher<number> = async (request) => {
    calls.push({ pageSize: request.pageSize });
    const page = pages[calls.length - 1];
    if (page === undefined) throw new Error('the script has no more pages');
    return page;
  };
  return { fetch, calls };
}

function tooLarge(): ResultTooLargeError {
  return new ResultTooLargeError({ message: 'the page is too large', operation: 'find' });
}

test('pages until done', async () => {
  const { fetch, calls } = scripted([
    { items: [1], done: false },
    { items: [2], done: false },
    { items: [3], done: true },
  ]);
  const cursor = new Cursor<number>(fetch, { pageSize: 1, halveOnTooLarge: false });
  assert.deepEqual(await cursor.toArray(), [1, 2, 3]);
  assert.equal(calls.length, 3);
});

test('limit truncates across pages', async () => {
  const { fetch, calls } = scripted([
    { items: [1, 2], done: false },
    { items: [3, 4], done: false },
  ]);
  const cursor = new Cursor<number>(fetch, { pageSize: 2, limit: 3, halveOnTooLarge: false });
  assert.deepEqual(await cursor.toArray(), [1, 2, 3]);
  assert.equal(calls.length, 2, 'no page is fetched once the limit is reached');
});

test('toArray collects every item', async () => {
  const { fetch } = scripted([
    { items: [1], done: false },
    { items: [2, 3], done: true },
  ]);
  const cursor = new Cursor<number>(fetch, { pageSize: 2, halveOnTooLarge: false });
  assert.deepEqual(await cursor.toArray(), [1, 2, 3]);
});

test('batches yields whole pages', async () => {
  const { fetch } = scripted([
    { items: [1, 2], done: false },
    { items: [3], done: true },
  ]);
  const cursor = new Cursor<number>(fetch, { pageSize: 2, halveOnTooLarge: false });
  const batches: number[][] = [];
  for await (const batch of cursor.batches()) batches.push(batch);
  assert.deepEqual(batches, [[1, 2], [3]]);
});

test('break stops fetching', async () => {
  const { fetch, calls } = scripted(Array.from({ length: 10 }, (_, index) => ({ items: [index, index], done: false })));
  const cursor = new Cursor<number>(fetch, { pageSize: 2, halveOnTooLarge: false });
  for await (const item of cursor) {
    assert.equal(item, 0);
    break;
  }
  assert.equal(calls.length, 1, 'a break after the first item fetched only the first page');
});

test('RESULT_TOO_LARGE halves the page once then succeeds', async () => {
  const calls: number[] = [];
  const fetch: PageFetcher<number> = async (request) => {
    calls.push(request.pageSize);
    if (calls.length === 1) throw tooLarge();
    return { items: [7], done: true };
  };
  const cursor = new Cursor<number>(fetch, { pageSize: 4, halveOnTooLarge: true });
  assert.deepEqual(await cursor.toArray(), [7]);
  assert.deepEqual(calls, [4, 2]);
});

test('a page that can never fit is reported, not looped', async () => {
  const sizes: number[] = [];
  const fetch: PageFetcher<number> = async (request) => {
    sizes.push(request.pageSize);
    throw tooLarge();
  };
  const cursor = new Cursor<number>(fetch, { pageSize: 4, halveOnTooLarge: true });
  await assert.rejects(cursor.toArray(), ResultTooLargeError);
  assert.deepEqual(sizes, [4, 2, 1], 'halved down to one item, then the error: bounded by the halvings');
});

/**
 * A server whose result ceiling holds `ceilingOf(page)` documents: a larger page is RESULT_TOO_LARGE.
 * It holds `stored` documents in all and answers each page with as many as were asked.
 */
function ceilinged(stored: number, ceilingOf: (pageIndex: number) => number): { fetch: PageFetcher<number>; sizes: number[] } {
  const sizes: number[] = [];
  let served = 0;
  const fetch: PageFetcher<number> = async ({ pageSize, pageIndex }) => {
    sizes.push(pageSize);
    if (pageSize > ceilingOf(pageIndex)) throw tooLarge();
    const items = Array.from({ length: Math.min(pageSize, stored - served) }, (_, index) => served + index);
    served += items.length;
    return { items, done: served >= stored };
  };
  return { fetch, sizes };
}

test('uniform large documents page through by halving as often as it takes', async () => {
  // 100 KiB documents against the 16 MiB result ceiling: about 163 fit a page. Asked for 400 at a time,
  // the cursor halves to 200, then to 100, and keeps 100 for every later page.
  const { fetch, sizes } = ceilinged(1000, () => 163);
  const cursor = new Cursor<number>(fetch, { pageSize: 400, halveOnTooLarge: true });
  const items = await cursor.toArray();
  assert.equal(items.length, 1000);
  assert.deepEqual(items.slice(0, 3), [0, 1, 2]);
  assert.deepEqual(sizes.slice(0, 4), [400, 200, 100, 100]);
  assert.ok(sizes.slice(2).every((size) => size === 100), `later pages keep the size that worked: ${sizes.join(',')}`);
});

test('a later page may halve again, from the size the last page succeeded at', async () => {
  // Mixed sizes: the first page's documents are small (ceiling 163), the second page's large (ceiling 40).
  const { fetch, sizes } = ceilinged(300, (pageIndex) => (pageIndex === 0 ? 163 : 40));
  const cursor = new Cursor<number>(fetch, { pageSize: 400, halveOnTooLarge: true });
  const items = await cursor.toArray();
  assert.equal(items.length, 300);
  assert.deepEqual(sizes.slice(0, 6), [400, 200, 100, 100, 50, 25]);
});
