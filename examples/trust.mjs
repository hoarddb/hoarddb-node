// SPDX-License-Identifier: Apache-2.0
//
// Trust on first use: a server whose key is not pinned is shown to the program, which decides.
// The accepted key is recorded in ~/.hoarddb/known_servers, so the next connect asks nothing.
import { connect } from 'hoarddb';

const client = await connect({
  tls: {
    onUnknownServer: (server) => {
      console.log('trusting', `${server.host}:${server.port}`);
      return true;
    },
  },
});
try {
  await client.ping();
  console.log('connected');
} finally {
  await client.close();
}
