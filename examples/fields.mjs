// SPDX-License-Identifier: Apache-2.0
//
// Store fields: every User document carries its own fifo of purchases and its own hash of friends.
import { connect } from 'hoarddb';

const client = await connect();
const name = 'example_fields';
try {
  await client.createDatabase(name, { ifNotExists: true });
  const users = await client.database(name).createBucket('User', 'hash', {
    ifNotExists: true,
    stores: [
      { name: 'Purchases', type: 'fifo' },
      { name: 'Friends', type: 'hash' },
    ],
  });
  await users.put('ada', { Name: 'Ada' });
  await users.put('bob', { Name: 'Bob' });

  const adaPurchases = users.field('ada', 'Purchases');
  await adaPurchases.push({ item: 'book' });
  await adaPurchases.push({ item: 'pen' });
  console.log('ada has', await adaPurchases.len(), 'purchases; bob has', await users.field('bob', 'Purchases').len());
  console.log('ada buys first', (await adaPurchases.pop())[0].element.item);

  const friends = users.field('ada', 'Friends');
  await friends.put('bob', { since: 2020 });
  console.log('friend since', (await friends.get('bob')).element.since);
  try {
    await friends.get('carol');
  } catch (err) {
    if (err.code !== 'NOT_FOUND') throw err;
    console.log('no such friend', err.code);
  }
} finally {
  await client.dropDatabase(name);
  await client.close();
}
