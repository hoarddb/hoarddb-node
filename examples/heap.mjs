// SPDX-License-Identifier: Apache-2.0
//
// A heap bucket: every push carries a priority, and pop returns the next one the heap serves.
import { connect } from 'hoarddb';

const client = await connect();
const name = 'example_heap';
try {
  await client.createDatabase(name, { ifNotExists: true });
  const tasks = await client.database(name).createBucket('tasks', 'heap', { ifNotExists: true });

  await tasks.push({ title: 'write docs' }, { priority: 5 });
  await tasks.push({ title: 'fix bug' }, { priority: 1 });
  await tasks.push({ title: 'no priority given' });

  for (let taken = await tasks.pop(); taken.length > 0; taken = await tasks.pop()) console.log('pop', taken[0].title);
  console.log('empty pop is', await tasks.pop());
} finally {
  await client.dropDatabase(name);
  await client.close();
}
