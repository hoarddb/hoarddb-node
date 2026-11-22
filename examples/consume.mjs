// SPDX-License-Identifier: Apache-2.0
//
// A work queue with leases: claim takes entries and leaves them in the store, an ack removes them, and
// consume is the loop that does both for you. A handler that throws is not acknowledged, so its entry is
// delivered again; after 5 deliveries it moves to the dead list, where you can read, requeue or discard it.
import { connect } from 'hoarddb';

const client = await connect();
const name = 'example_consume';
try {
  await client.createDatabase(name, { ifNotExists: true });
  const jobs = await client.database(name).createBucket('jobs', 'fifo', { ifNotExists: true });
  for (const n of [1, 2, 3]) await jobs.push({ n });

  // By hand: claim takes up to `limit` entries for `lease` milliseconds; they are invisible until acked or released.
  const claimed = await jobs.claim({ limit: 2, lease: 60_000 });
  console.log('claimed', claimed.items.map((job) => job.document.n).join(', '), 'for', claimed.grantedMs, 'ms');
  console.log('visible now', (await jobs.peek({ limit: 5 })).map((job) => job.n).join(', '));
  console.log('acked', (await jobs.ack(claimed.leaseId)).acked);

  // The loop: handlers of one batch run at the same time, and the ones that resolve are acknowledged.
  const stop = new AbortController();
  const seen = [];
  try {
    await jobs.consume(
      async (job) => {
        seen.push(job.document.n);
        stop.abort(); // one job is all this example needs
      },
      { signal: stop.signal },
    );
  } catch (error) {
    if (error.code !== 'ABORTED') throw error;
  }
  console.log('consumed', seen.join(', '));
  console.log('left in the queue', await jobs.count());
  console.log('dead entries', (await jobs.deadList()).items.length);
} finally {
  await client.dropDatabase(name);
  await client.close();
}
