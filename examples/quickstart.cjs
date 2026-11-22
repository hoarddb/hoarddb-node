// SPDX-License-Identifier: Apache-2.0
//
// The same quickstart for CommonJS: no top-level await, the same package and the same calls.
const { connect } = require('hoarddb');

async function main() {
  const client = await connect();
  try {
    await client.createDatabase('example_quickstart', { ifNotExists: true });
    const users = await client.database('example_quickstart').createBucket('users', 'hash', { ifNotExists: true });

    await users.put('ada', { name: 'Ada', age: 36 });
    const ada = await users.get('ada');
    console.log(ada.name, ada.age, ada._id_);
    for await (const user of users.find({ age: { $gte: 30 } })) console.log(user.name);
  } finally {
    await client.dropDatabase('example_quickstart');
    await client.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
