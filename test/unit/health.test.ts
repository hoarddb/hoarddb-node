// SPDX-License-Identifier: Apache-2.0
//
// The health answer: the facts the driver types (handbook operations.md section 5, "health") and the
// host document a node sends about its machine, which a driver shows and never decides from.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { recordingClient } from '../helpers/recording.js';

const BASE = { nodeid: 'node1', uptime: '1s', version: 'test', bucketcount: 3, healthy: true };

test('health types the host facts a node sends', async () => {
  const { client } = recordingClient(
    new Map([
      [
        'HEALTH_CHECK',
        {
          ...BASE,
          host: {
            cpus: 4,
            host_cpus: 32,
            memory_total_bytes: 17179869184n,
            memory_used_bytes: 4294967296,
            memory_source: 'cgroup',
            load: { one_minute: 0.5, five_minutes: 0.25, fifteen_minutes: 0 },
          },
        },
      ],
    ]),
  );
  const health = await client.health();
  assert.deepEqual(health.host, {
    cpus: 4,
    hostCpus: 32,
    memoryTotalBytes: 17179869184,
    memoryUsedBytes: 4294967296,
    memorySource: 'cgroup',
    load: { oneMinute: 0.5, fiveMinutes: 0.25, fifteenMinutes: 0 },
  });
  assert.equal(health.bucketCount, 3);
});

test('a node that can read nothing but its cpu count sends cpus alone, and an idle load is kept', async () => {
  const alone = recordingClient(new Map([['HEALTH_CHECK', { ...BASE, host: { cpus: 2 } }]]));
  assert.deepEqual((await alone.client.health()).host, { cpus: 2 });

  const idle = recordingClient(
    new Map([['HEALTH_CHECK', { ...BASE, host: { cpus: 2, load: { one_minute: 0, five_minutes: 0, fifteen_minutes: 0 } } }]]),
  );
  assert.deepEqual((await idle.client.health()).host?.load, { oneMinute: 0, fiveMinutes: 0, fifteenMinutes: 0 });
});

test('a server older than the host document leaves host undefined', async () => {
  const { client } = recordingClient(new Map([['HEALTH_CHECK', BASE]]));
  assert.equal((await client.health()).host, undefined);
});

test('a host document that is not a document is ignored, not a crash', async () => {
  const { client } = recordingClient(new Map([['HEALTH_CHECK', { ...BASE, host: 'busy' }]]));
  assert.equal((await client.health()).host, undefined);
});
