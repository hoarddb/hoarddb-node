// SPDX-License-Identifier: Apache-2.0
//
// A blob bucket: bytes under a key, with metadata beside them.
import { connect } from 'hoarddb';

const client = await connect();
const name = 'example_blob';
try {
  await client.createDatabase(name, { ifNotExists: true });
  const files = await client.database(name).createBucket('files', 'blob', { ifNotExists: true });

  const written = await files.putBlob('hello.txt', new TextEncoder().encode('hello, hoardDB'), {
    metadata: { type: 'text/plain' },
  });
  console.log('stored', written.key, written.size, 'bytes');

  const blob = await files.getBlob('hello.txt');
  console.log('read', new TextDecoder().decode(blob.data), blob.metadata.type);
  try {
    await files.getBlob('nothing.txt');
  } catch (err) {
    if (err.code !== 'NOT_FOUND') throw err;
    console.log('missing is', err.code);
  }
  console.log('count', await files.count());
} finally {
  await client.dropDatabase(name);
  await client.close();
}
