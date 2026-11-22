// SPDX-License-Identifier: Apache-2.0
//
// A lifo bucket: push, peek and pop; the newest comes out first.
import { connect } from 'hoarddb';

const client = await connect();
const name = 'example_lifo';
try {
  await client.createDatabase(name, { ifNotExists: true });
  const jobs = await client.database(name).createBucket('jobs', 'lifo', { ifNotExists: true });

  for (const n of [1, 2, 3]) await jobs.push({ n });
  console.log('peek', (await jobs.peek())[0].n);
  for (let taken = await jobs.pop(); taken.length > 0; taken = await jobs.pop()) console.log('pop', taken[0].n);
  console.log('empty pop is', await jobs.pop());
} finally {
  await client.dropDatabase(name);
  await client.close();
}
