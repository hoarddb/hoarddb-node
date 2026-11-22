// SPDX-License-Identifier: Apache-2.0
//
// A btree bucket: keys stay in order, so a range reads them sorted.
import { connect } from 'hoarddb';

const client = await connect();
const name = 'example_btree';
try {
  await client.createDatabase(name, { ifNotExists: true });
  const scores = await client.database(name).createBucket('scores', 'btree', { ifNotExists: true });

  for (const [key, points] of [['carol', 7], ['alice', 9], ['bob', 4]]) await scores.put(key, { points });

  for await (const entry of scores.range({})) console.log('in order', entry.key, entry.value.points);
  for await (const entry of scores.range({ gte: 'b', lte: 'bz' })) console.log('between b and bz', entry.key);
  console.log('first', (await scores.first()).key);
  console.log('last', (await scores.last()).key);
} finally {
  await client.dropDatabase(name);
  await client.close();
}
