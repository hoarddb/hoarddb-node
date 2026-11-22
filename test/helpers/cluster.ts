// SPDX-License-Identifier: Apache-2.0
//
// Three real servers on one machine, joined into a ring (handbook testing.md section 3.2), and
// optionally a fourth that is never joined. Each node has its own identity (so the seed fingerprints
// are known before anything starts), its own data directory and home, and four free ports, with the
// ring port's successor free as well because the internode listener is always the ring port plus one.
// The single-node helper cannot be used for this: it sets HOARDDB_TCP_INTERNODE_LISTEN, which a ring
// node must not set, and it does not look for a free successor port.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect } from '../../src/index.js';
import { removeTlsIdentity, makeTlsIdentity } from './tls-identity.js';
import { serverBinary, type TestServer } from './server.js';
import { vectorNamed } from './vectors.js';

const ROOT_PASSWORD = 'node-driver-cluster-password';
const FINGERPRINT_PATTERN = /"fingerprint":"(SHA256:[0-9a-f]{64})"/;
const READY_TIMEOUT_MS = 90_000;
const POLL_MS = 250;
const STOP_GRACE_MS = 15_000;

export interface TestCluster {
  /** node1, node2, node3, joined. */
  nodes: TestServer[];
  /** Set once startNewcomer() has run. */
  readonly newcomer?: TestServer;
  /** Starts the fourth node, which is never joined; a second call returns the running one. */
  startNewcomer(): Promise<TestServer>;
  /**
   * The replay substitution pairs, fixed to live (N-55); the newcomer's are included once it runs. The
   * fixed fingerprints come from the named vector, which must not be the one being validated (N-59).
   */
  identity(fingerprintsFrom: string): (readonly [fixed: string, live: string])[];
  stopNode(index: number): Promise<void>;
  startNode(index: number): Promise<void>;
  stop(): Promise<void>;
}

interface NodePorts {
  driver: number;
  ring: number;
  metrics: number;
}

/** One node's process, which a stop and a start replace. */
class NodeProcess {
  child: ChildProcess | undefined;
  private exited: Promise<void> = Promise.resolve();
  private running = false;

  constructor(
    private readonly env: Record<string, string>,
    private readonly root: string,
    readonly logPath: string,
  ) {}

  get alive(): boolean {
    return this.running;
  }

  launch(): void {
    const logFd = openSync(this.logPath, 'a');
    try {
      const child = spawn(serverBinary(), [], { env: this.env, stdio: ['ignore', logFd, logFd], cwd: this.root });
      this.child = child;
      this.running = true;
      this.exited = new Promise<void>((resolveExit) => {
        child.once('exit', () => {
          this.running = false;
          resolveExit();
        });
      });
    } finally {
      closeSync(logFd);
    }
  }

  async terminate(): Promise<void> {
    if (!this.running) return;
    this.child?.kill('SIGTERM');
    const timer = setTimeout(() => this.child?.kill('SIGKILL'), STOP_GRACE_MS);
    await this.exited;
    clearTimeout(timer);
  }

  kill(): void {
    if (this.running) this.child?.kill('SIGKILL');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function listenOn(port: number): Promise<Server> {
  return new Promise((resolveListen, rejectListen) => {
    const holder = createServer();
    holder.once('error', rejectListen);
    holder.listen(port, '127.0.0.1', () => resolveListen(holder));
  });
}

function portOf(holder: Server): number {
  const address = holder.address();
  if (address === null || typeof address === 'string') throw new Error('a listening socket has no port');
  return address.port;
}

/** Ports for every node, all held until the last is chosen; a ring port is only kept when the next one is free too. */
async function allocatePorts(nodeCount: number): Promise<NodePorts[]> {
  const holders: Server[] = [];
  const result: NodePorts[] = [];
  try {
    for (let index = 0; index < nodeCount; index += 1) {
      const driver = await listenOn(0);
      const metrics = await listenOn(0);
      holders.push(driver, metrics);
      let ring: Server | undefined;
      for (let attempt = 0; attempt < 100 && ring === undefined; attempt += 1) {
        const candidate = await listenOn(0);
        try {
          const successor = await listenOn(portOf(candidate) + 1);
          holders.push(candidate, successor);
          ring = candidate;
        } catch {
          await new Promise<void>((resolveClose) => candidate.close(() => resolveClose()));
        }
      }
      if (ring === undefined) throw new Error('no ring port with a free successor was found in 100 tries');
      result.push({ driver: portOf(driver), ring: portOf(ring), metrics: portOf(metrics) });
    }
  } finally {
    await Promise.all(holders.map((holder) => new Promise<void>((resolveClose) => holder.close(() => resolveClose()))));
  }
  return result;
}

function logSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

async function waitForFingerprint(node: NodeProcess, fromBytes: number): Promise<string> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const text = readFileSync(node.logPath).subarray(fromBytes).toString('utf8');
    const match = FINGERPRINT_PATTERN.exec(text);
    if (match?.[1] !== undefined) return match[1];
    if (!node.alive) throw new Error(`a node exited before it was ready; its last log lines:\n${text.split('\n').slice(-40).join('\n')}`);
    if (Date.now() > deadline) throw new Error(`a node was not ready in ${READY_TIMEOUT_MS} ms; its last log lines:\n${text.split('\n').slice(-40).join('\n')}`);
    await sleep(100);
  }
}

/** Poll HEALTH_CHECK through the driver until the node says its membership is confirmed. */
async function waitForMembership(server: TestServer): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = 'no answer yet';
  while (Date.now() < deadline) {
    try {
      const client = await connect(server.uri(), { tls: { knownServersPath: false }, requestTimeoutMs: 5_000 });
      try {
        const health = await client.health();
        last = String(health.membership);
        if (health.membership === 'confirmed') return;
      } finally {
        await client.close({ timeoutMs: 1_000 });
      }
    } catch (error) {
      last = (error as Error).message;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`${server.address} did not confirm its membership in ${READY_TIMEOUT_MS} ms (last answer: ${last}; log: ${server.logPath})`);
}

/** The ring and driver ports the vectors were captured with, per node (normalisations, sentence 4). */
const FIXED_PORTS = [
  { ring: 4433, driver: 7433 },
  { ring: 4435, driver: 7434 },
  { ring: 4437, driver: 7435 },
  { ring: 4439, driver: 7436 },
] as const;

/**
 * The capture's fixed fingerprints by node ID, read from the named vector. The replay of one listing
 * takes them from the other ("list nodes" from "list nodes with membership history" and back), so a
 * fingerprint changed in the vector being validated is not substituted away (N-59).
 */
export function fixedFingerprints(fromVector: string): Map<string, string> {
  const vector = vectorNamed(fromVector);
  const response = vector['response'] as { payload_json: { nodes: { nodeid: string; fingerprint: string }[] } };
  return new Map(response.payload_json.nodes.map((entry) => [entry.nodeid, entry.fingerprint]));
}

/** A live node as the identity sees it: its name, its two ports and its fingerprint. */
export interface LiveNode {
  name: string;
  ringPort: number;
  port: number;
  fingerprint: string;
}

/**
 * The substitution pairs, fixed to live, for the nodes given in the capture's order (node1, node2,
 * node3, then the newcomer): each node's fixed ring and driver address, and its fixed fingerprint when
 * the source vector names one.
 */
export function identityPairs(live: readonly LiveNode[], fixed: ReadonlyMap<string, string>): (readonly [string, string])[] {
  const pairs: (readonly [string, string])[] = [];
  live.forEach((node, index) => {
    const ports = FIXED_PORTS[index];
    if (ports === undefined) return;
    pairs.push([`127.0.0.1:${ports.ring}`, `127.0.0.1:${node.ringPort}`]);
    pairs.push([`127.0.0.1:${ports.driver}`, `127.0.0.1:${node.port}`]);
    const fixedFingerprint = fixed.get(node.name);
    if (fixedFingerprint !== undefined && fixedFingerprint !== '') pairs.push([fixedFingerprint, node.fingerprint]);
  });
  return pairs;
}

export async function startCluster(options: { env?: Record<string, string> } = {}): Promise<TestCluster> {
  // The newcomer's ports and identity are chosen with the members', so every seed list is known up
  // front; it is only launched by startNewcomer().
  const names = ['node1', 'node2', 'node3', 'newcomer'];
  const root = mkdtempSync(join(tmpdir(), 'hoarddb-node-cluster-'));
  const token = randomBytes(32).toString('hex');
  const ports = await allocatePorts(names.length);
  const identities = names.map(() => makeTlsIdentity());

  const processes: NodeProcess[] = [];
  const servers: TestServer[] = [];
  try {
    const seedAddress = (index: number): string => `127.0.0.1:${ports[index]?.ring}`;
    const seedList = (members: number[]): { nodes: string; fingerprints: string } => ({
      nodes: members.map((index) => `${names[index]}@${seedAddress(index)}`).join(','),
      fingerprints: members.map((index) => `${seedAddress(index)}=${identities[index]?.fingerprint}`).join(','),
    });

    names.forEach((name, index) => {
      const nodePorts = ports[index];
      const identity = identities[index];
      if (nodePorts === undefined || identity === undefined) throw new Error('a node has no ports or identity');
      const nodeRoot = join(root, name);
      const dataDir = join(nodeRoot, 'data');
      const home = join(nodeRoot, 'home');
      mkdirSync(join(dataDir, 'keys'), { recursive: true });
      mkdirSync(home, { recursive: true });
      copyFileSync(identity.keyPath, join(dataDir, 'keys', 'server.key'));
      chmodSync(join(dataDir, 'keys', 'server.key'), 0o600);
      copyFileSync(identity.certPath, join(dataDir, 'keys', 'server.crt'));

      // The three members know each other; the newcomer knows them and itself, and nobody joins it.
      const seeds = seedList(name === 'newcomer' ? [0, 1, 2, 3] : [0, 1, 2]);
      const env: Record<string, string> = {
        PATH: process.env['PATH'] ?? '',
        HOARDDB_DATA_DIR: dataDir,
        HOARDDB_TCP_LISTEN: `127.0.0.1:${nodePorts.driver}`,
        HOARDDB_METRICS_LISTEN: `127.0.0.1:${nodePorts.metrics}`,
        HOARDDB_ROOT_USER: 'admin',
        HOARDDB_ROOT_PASSWORD: ROOT_PASSWORD,
        HOME: home,
        HOARDDB_NODE_ID: name,
        HOARDDB_LISTEN: `127.0.0.1:${nodePorts.ring}`,
        HOARDDB_SEED_NODES: seeds.nodes,
        HOARDDB_SEED_FINGERPRINTS: seeds.fingerprints,
        HOARDDB_CLUSTER_TOKEN: token,
        HOARDDB_REPLICATION_FACTOR: '3',
        ...options.env,
      };
      const logPath = join(nodeRoot, 'server.log');
      const node = new NodeProcess(env, nodeRoot, logPath);
      processes.push(node);

      const server: TestServer = {
        address: `127.0.0.1:${nodePorts.driver}`,
        host: '127.0.0.1',
        port: nodePorts.driver,
        ringPort: nodePorts.ring,
        fingerprint: identity.fingerprint,
        user: 'admin',
        password: ROOT_PASSWORD,
        dataDir,
        home,
        logPath,
        uri: () =>
          `hoarddb://admin:${encodeURIComponent(ROOT_PASSWORD)}@127.0.0.1:${nodePorts.driver}?fingerprint=${identity.fingerprint}`,
        // A node's stop keeps its directory, so it can start again; the cluster's stop removes them all.
        stop: () => node.terminate(),
        kill: () => node.kill(),
        restart: async () => {
          await node.terminate();
          const before = logSize(logPath);
          node.launch();
          await waitForFingerprint(node, before);
        },
      };
      servers.push(server);
    });

    const memberProcesses = processes.slice(0, 3);
    for (const node of memberProcesses) node.launch();
    await Promise.all(memberProcesses.map((node) => waitForFingerprint(node, 0)));
    const members = servers.slice(0, 3);
    await Promise.all(members.map((member) => waitForMembership(member)));
  } catch (error) {
    await Promise.all(processes.map((node) => node.terminate()));
    for (const identity of identities) removeTlsIdentity(identity);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  for (const identity of identities) removeTlsIdentity(identity);

  const members = servers.slice(0, 3);
  let newcomerStarted: Promise<TestServer> | undefined;
  return {
    nodes: members,
    get newcomer(): TestServer | undefined {
      return newcomerStarted === undefined ? undefined : servers[3];
    },
    startNewcomer(): Promise<TestServer> {
      newcomerStarted ??= (async () => {
        const node = processes[3];
        const server = servers[3];
        if (node === undefined || server === undefined) throw new Error('the newcomer was not planned');
        node.launch();
        await waitForFingerprint(node, 0);
        return server;
      })();
      return newcomerStarted;
    },
    identity(fingerprintsFrom: string): (readonly [string, string])[] {
      const running = servers.filter((_, index) => index < 3 || newcomerStarted !== undefined);
      const live = running.map((server, index) => ({
        name: names[index] ?? '',
        ringPort: server.ringPort,
        port: server.port,
        fingerprint: server.fingerprint,
      }));
      return identityPairs(live, fixedFingerprints(fingerprintsFrom));
    },
    async stopNode(index: number): Promise<void> {
      await processes[index]?.terminate();
    },
    async startNode(index: number): Promise<void> {
      const node = processes[index];
      const server = servers[index];
      if (node === undefined || server === undefined) throw new Error(`there is no node ${index}`);
      const before = logSize(node.logPath);
      node.launch();
      await waitForFingerprint(node, before);
      if (index < 3) await waitForMembership(server);
    },
    async stop(): Promise<void> {
      await Promise.all(processes.map((node) => node.terminate()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}
