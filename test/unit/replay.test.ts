// SPDX-License-Identifier: Apache-2.0
//
// The pieces of the cluster replay (build doc step 20, N-55) that can be checked without a cluster:
// the substitution of the capture's fixed identities by live ones is one pass, so a live port that
// equals another node's fixed port is not rewritten again; and the fixed fingerprints come from a
// vector other than the one being validated, so a fingerprint mutated in that vector is not hidden.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fixedFingerprints, identityPairs } from '../helpers/cluster.js';
import { applyPairs } from '../helpers/server.js';
import { vectorNamed } from '../helpers/vectors.js';

test('the identity substitution is one pass: a live port equal to another fixed port is not rewritten twice', () => {
  // node1's live ring port happens to be node2's fixed one; node2's live port is elsewhere.
  const pairs: [string, string][] = [
    ['127.0.0.1:4433', '127.0.0.1:4435'],
    ['127.0.0.1:4435', '127.0.0.1:50001'],
  ];
  assert.equal(applyPairs('node1 127.0.0.1:4433, node2 127.0.0.1:4435', pairs), 'node1 127.0.0.1:4435, node2 127.0.0.1:50001');
});

test("a fingerprint mutated in 'list nodes' is not hidden by the identity it is validated with", () => {
  const live = [
    { name: 'node1', ringPort: 50011, port: 50021, fingerprint: `SHA256:${'1'.repeat(64)}` },
    { name: 'node2', ringPort: 50012, port: 50022, fingerprint: `SHA256:${'2'.repeat(64)}` },
    { name: 'node3', ringPort: 50013, port: 50023, fingerprint: `SHA256:${'3'.repeat(64)}` },
  ];
  // "list nodes" is validated with fingerprints read from the history vector, never from itself.
  const pairs = identityPairs(live, fixedFingerprints('list nodes with membership history'));
  const listed = JSON.stringify((vectorNamed('list nodes')['response'] as { payload_json: unknown }).payload_json);

  const localised = applyPairs(listed, pairs);
  for (const node of live) assert.ok(localised.includes(node.fingerprint), `${node.name}'s live fingerprint is expected`);
  assert.ok(!localised.includes('fdf72a088f18'), "no capture fingerprint is left in the expected answer");

  // A changed capture fingerprint in "list nodes" stays changed, so the live answer cannot match it.
  const mutated = listed.replace('ed23d853125a', 'ed23d853125b');
  assert.notEqual(applyPairs(mutated, pairs), localised, 'the mutation must survive the substitution');
});
