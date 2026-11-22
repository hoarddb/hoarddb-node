// SPDX-License-Identifier: Apache-2.0
//
// Errors: branch on err.code, not on instanceof; the message is the server's own sentence.
import { connect } from 'hoarddb';

const client = await connect();
const name = 'example_errors';
try {
  await client.createDatabase(name, { ifNotExists: true });
  const database = client.database(name);

  try {
    await database.hash('missing').get('ada');
  } catch (err) {
    console.log(err.code);
    console.log(err.message);
  }

  const accounts = await database.createBucket('accounts', 'hash', {
    ifNotExists: true,
    indexes: [{ fields: ['Email'], unique: true }],
  });
  await accounts.put('a', { Email: 'ada@example.com' });
  try {
    await accounts.put('b', { Email: 'ada@example.com' });
  } catch (err) {
    if (err.code === 'DUPLICATE_KEY') console.log('that email is taken');
    else throw err;
  }
} finally {
  await client.dropDatabase(name);
  await client.close();
}
