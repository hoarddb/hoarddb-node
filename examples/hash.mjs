// SPDX-License-Identifier: Apache-2.0
//
// A hash bucket: put, get, update with three operators, find, delete.
import { connect } from 'hoarddb';

const client = await connect();
const name = 'example_hash';
try {
  await client.createDatabase(name, { ifNotExists: true });
  const people = await client.database(name).createBucket('people', 'hash', { ifNotExists: true });

  await people.put('ada', { Name: 'Ada', Age: 36, Visits: 1, Tags: ['maths'] });
  const ada = await people.get('ada');
  console.log('got', ada._id_, ada.Name, ada.Age);

  const updated = await people.update('ada', {
    $set: { Age: 37 },
    $inc: { Visits: 2 },
    $push: { Tags: 'poetry' },
  });
  console.log('updated', updated._id_, updated.Name, updated.Age, updated.Visits, updated.Tags.join(','));

  try {
    await people.get('nobody');
  } catch (err) {
    if (err.code !== 'NOT_FOUND') throw err;
    console.log('missing is', err.code);
  }
  for await (const person of people.find({ Age: { $gte: 30 } })) console.log('found', person.Name);
  console.log('deleted', await people.delete('ada'), 'then', await people.delete('ada'));
} finally {
  await client.dropDatabase(name);
  await client.close();
}
