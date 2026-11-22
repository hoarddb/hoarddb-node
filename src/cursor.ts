// SPDX-License-Identifier: Apache-2.0
//
// The cursor that find, search, range and list return (section 3.6; build doc step 13). A cursor pins
// nothing: it asks for the next page only when the current one is spent, and holds no lease, timer or
// promise between pages. Its page fetcher is internal (N-33): the public surface names only the class.

import { isHoardDBError } from './errors.js';

/** One page of a scan: its items, whether it was the last, and the server's exact count when it sent one. */
export interface Page<D> {
  items: D[];
  done: boolean;
  total?: number;
  /** Search only: the server's answer to "were there more matches than the limit". */
  hasMore?: boolean;
}

/** Asks the verb for one page; the verb knows the query, the cursor knows the sizes. */
export type PageFetcher<D> = (request: { pageSize: number; pageIndex: number }) => Promise<Page<D>>;

/** The refusal counter of the client whose verb made each cursor (see src/refusals.ts). */
const counters = new WeakMap<object, (error: unknown) => void>();

/** Gives a cursor its client's refusal counter, so a refusal raised inside a page fetch is counted. */
export function countCursorRefusals(cursor: object, count: (error: unknown) => void): void {
  counters.set(cursor, count);
}

export interface CursorOptions {
  pageSize: number;
  limit?: number;
  halveOnTooLarge: boolean;
}

export class Cursor<D> implements AsyncIterable<D> {
  private buffer: D[] = [];
  private position = 0;
  private pagesFetched = 0;
  private finished = false;
  /** Items accepted from pages so far, which is what the limit counts. */
  private accepted = 0;
  private pageSize: number;
  private totalCount: number | undefined;
  private moreMatches: boolean | undefined;
  private closed = false;

  /** @internal */
  constructor(
    private readonly fetch: PageFetcher<D>,
    private readonly options: CursorOptions,
  ) {
    this.pageSize = options.pageSize;
  }

  /**
   * The count the server sent with the first page: for find, the exact number of matches; for search,
   * the number of results it returned (at most `limit`). Undefined before the first page, and for a
   * range or a field list, whose answers carry none.
   */
  get total(): number | undefined {
    return this.totalCount;
  }

  /**
   * Search only: whether the server found more matches than the limit (`true`), or sent every match
   * (`false`). A search cannot be paged, so `true` means raise `limit`, or use `find` when the count
   * matters. Undefined before the first page, for any cursor but a search, and for a server older than
   * the field.
   */
  get hasMore(): boolean | undefined {
    return this.moreMatches;
  }

  /** The next item, or null when the cursor is finished. */
  async next(): Promise<D | null> {
    while (this.position >= this.buffer.length) {
      const items = await this.nextPage();
      if (items === null) return null;
      this.buffer = items;
      this.position = 0;
    }
    const item = this.buffer[this.position];
    this.position += 1;
    return item ?? null;
  }

  /** Every remaining item, in order. */
  async toArray(): Promise<D[]> {
    const items: D[] = [];
    for (let item = await this.next(); item !== null; item = await this.next()) items.push(item);
    return items;
  }

  /** The remaining items page by page; a page that arrives empty is not yielded. */
  async *batches(): AsyncGenerator<D[]> {
    if (this.position < this.buffer.length) {
      yield this.buffer.slice(this.position);
      this.position = this.buffer.length;
    }
    for (;;) {
      const items = await this.nextPage();
      if (items === null) return;
      if (items.length > 0) yield items;
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<D> {
    for (let item = await this.next(); item !== null; item = await this.next()) yield item;
  }

  /** Stops further fetches. Nothing is released on the server: a cursor holds nothing there. */
  close(): Promise<void> {
    this.closed = true;
    this.buffer = [];
    this.position = 0;
    return Promise.resolve();
  }

  /** The next accepted page, truncated to the limit, or null when there is no more to fetch. */
  private async nextPage(): Promise<D[] | null> {
    if (this.closed || this.finished) return null;
    const limit = this.options.limit;
    if (limit !== undefined && this.accepted >= limit) return null;

    let page: Page<D>;
    try {
      page = await this.fetchPage();
    } catch (error) {
      counters.get(this)?.(error);
      throw error;
    }
    this.pagesFetched += 1;
    this.finished = page.done;
    if (page.total !== undefined && this.totalCount === undefined) this.totalCount = page.total;
    if (page.hasMore !== undefined && this.moreMatches === undefined) this.moreMatches = page.hasMore;

    const items = limit === undefined ? page.items : page.items.slice(0, limit - this.accepted);
    this.accepted += items.length;
    return items;
  }

  /**
   * One page. A page the server refuses as too large is asked for again at half the size, as often as
   * it takes: the size only falls, so a page is tried at most log2(pageSize) + 1 times, and a page that
   * cannot fit even one item is the caller's error. A size that worked is kept for the next page, which
   * may halve again (documents of mixed sizes). A cursor that may not halve (search) reports at once.
   */
  private async fetchPage(): Promise<Page<D>> {
    for (;;) {
      try {
        return await this.fetch({ pageSize: this.pageSize, pageIndex: this.pagesFetched });
      } catch (error) {
        if (!this.options.halveOnTooLarge || this.pageSize <= 1 || !isTooLarge(error)) throw error;
        this.pageSize = Math.max(1, Math.floor(this.pageSize / 2));
      }
    }
  }
}

/** The server refused the page as larger than a frame can carry (RESULT_TOO_LARGE). */
function isTooLarge(error: unknown): boolean {
  return isHoardDBError(error) && error.code === 'RESULT_TOO_LARGE';
}
