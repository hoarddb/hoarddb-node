// SPDX-License-Identifier: Apache-2.0
//
// Change how many copies of a bucket a cluster keeps. On a single node there is no second node to
// copy to: the server refuses, and its sentence says how to form a cluster.
import { connect } from 'hoarddb';

const client = await connect();
const name = 'example_alter';
try {
  await client.createDatabase(name, { ifNotExists: true });
  const db = client.database(name);
  await db.createBucket('invoices', 'hash', { ifNotExists: true });
  try {
    const result = await db.alterBucket('invoices', { replicationFactor: 3 });
    console.log('invoices keeps', result.replicationFactor, 'copies, was', result.previousFactor);
    console.log('copying to', (result.pending ?? []).length, 'members');
  } catch (err) {
    if (err.code === 'UNAVAILABLE' && err.retryable) console.log('try again later:', err.code);
    else if (err.code === 'INVALID_ARGUMENT') console.log('refused', err.code); // err.message names the fix
    else throw err;
  }
} finally {
  await client.dropDatabase(name);
  await client.close();
}
