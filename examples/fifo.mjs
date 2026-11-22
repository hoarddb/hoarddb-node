// SPDX-License-Identifier: Apache-2.0
//
// A fifo bucket: push, peek and pop; the oldest comes out first. A pop returns a list: one entry by
// default, or up to `limit` (1 to 100) taken in one request.
import { connect } from 'hoarddb';

const client = await connect();
const name = 'example_fifo';
try {
  await client.createDatabase(name, { ifNotExists: true });
  const jobs = await client.database(name).createBucket('jobs', 'fifo', { ifNotExists: true });

  for (const n of [1, 2, 3, 4]) await jobs.push({ n });
  console.log('peek', (await jobs.peek())[0].n);
  console.log('pop two at once', (await jobs.pop({ limit: 2 })).map((job) => job.n).join(', '));
  for (let taken = await jobs.pop(); taken.length > 0; taken = await jobs.pop()) console.log('pop', taken[0].n);
  console.log('empty pop is', await jobs.pop());
} finally {
  await client.dropDatabase(name);
  await client.close();
}
