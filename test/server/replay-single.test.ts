// SPDX-License-Identifier: Apache-2.0
//
// Leg 3 of the conformance harness on one node (handbook testing.md section 2): every exchange
// vector marked replay, sent to a real server under its own request ID and compared field by field
// (replayExchange, test/helpers/server.ts). The vectors were captured from a real server; replaying
// them is what proves the driver's wire layer against one (build doc step 15).

import { test, after } from 'node:test';

import { loadDriverVectors, type Vector } from '../helpers/vectors.js';
import { replayExchange, startServer, type TestServer } from '../helpers/server.js';

const file = loadDriverVectors();
const replayable = file.vectors.filter(
  (vector) => vector.kind === 'exchange' && vector['topology'] === 'single' && vector['replay'] === true,
);

interface ServerGroup {
  name: string;
  env: Record<string, string>;
  vectors: Vector[];
}

/**
 * One server per server_env, so the vectors that need the same operator limits share one; but a
 * vector whose notes say it needs a fresh server (testing.md section 1.1: "list databases" lists every
 * database the node holds) gets a server of its own (build doc N-48).
 */
const groups: ServerGroup[] = [];

/**
 * The `users` rows each run on a server that holds only the root account (handbook testing.md
 * section 1.1: every vector runs against a fresh server): an account one row creates would otherwise be seen by the next. User
 * administration is USER_CREATE to USER_REVOKE, 0xB5 to 0xBB.
 */
function touchesUsers(vector: Vector): boolean {
  const steps = [...((vector['setup'] ?? []) as { opcode: number }[]), vector['request'] as { opcode: number }];
  return steps.some((step) => step.opcode >= 0xb5 && step.opcode <= 0xbb);
}
const byEnvironment = new Map<string, ServerGroup>();
for (const vector of replayable) {
  const env = (vector['server_env'] ?? {}) as Record<string, string>;
  const key = JSON.stringify(env);
  if (String(vector['notes'] ?? '').includes('fresh server') || touchesUsers(vector)) {
    groups.push({ name: `a fresh server for "${vector.name}" (environment ${key})`, env, vectors: [vector] });
    continue;
  }
  let group = byEnvironment.get(key);
  if (group === undefined) {
    group = { name: `server environment ${key}`, env, vectors: [] };
    byEnvironment.set(key, group);
    groups.push(group);
  }
  group.vectors.push(vector);
}

const servers: TestServer[] = [];
let replayed = 0;
let passed = 0;

after(async () => {
  for (const server of servers) await server.stop();
  process.stdout.write(`leg 3 replay (single): ${replayed} vectors, ${passed} passed\n`);
});

for (const group of groups) {
  test(`leg 3 replay (single) on ${group.name}`, async () => {
    const server = await startServer({
      user: file.server_env['HOARDDB_ROOT_USER'] ?? 'admin',
      password: file.server_env['HOARDDB_ROOT_PASSWORD'] ?? 'vectors-root-password',
      // The vectors were captured on a node named vectors-node, and a user answer names its master.
      env: { HOARDDB_NODE_ID: 'vectors-node', ...group.env },
    });
    servers.push(server);

    const failures: string[] = [];
    for (const vector of group.vectors) {
      replayed += 1;
      try {
        await replayExchange(vector, server);
        passed += 1;
      } catch (error) {
        failures.push((error as Error).message);
      }
    }
    if (failures.length > 0) {
      throw new Error(`${failures.length} of ${group.vectors.length} vectors differ:\n${failures.join('\n')}`);
    }
  });
}
