// SPDX-License-Identifier: Apache-2.0
//
// A real hoardDB server for one test file: its own data directory, home directory and four
// loopback ports, started from the binary HOARDDB_SERVER_BIN names, with only the environment
// handbook testing.md section 3.1 lists. Nothing is shared between servers, so the failed-login
// limiter, the connection caps and the files a test writes never reach another test.

import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import assert from 'node:assert/strict';

import { authenticate } from '../../src/auth.js';
import { bytesFromExtendedJson, decodeDocument, extendedJsonFromBytes } from '../../src/codec/index.js';
import { Connection } from '../../src/connection.js';
import { makeTrustPolicy } from '../../src/trust.js';
import { Op } from '../../src/wire/opcodes.js';
import { requestIdHex } from '../../src/wire/frame.js';
import { assertResponseMatches, removePath } from './compare.js';
import { hexToBytes, type Vector } from './vectors.js';

const DEFAULT_TEST_PASSWORD = 'node-driver-test-password';
const FINGERPRINT_PATTERN = /"fingerprint":"(SHA256:[0-9a-f]{64})"/;
const READY_TIMEOUT_MS = 60_000;
const STOP_GRACE_MS = 15_000;

export interface TestServer {
  address: string;
  host: string;
  port: number;
  /** The ring port, which rewritePorts rewrites to 4433; a cluster helper fills it in for its nodes. */
  ringPort: number;
  fingerprint: string;
  user: string;
  password: string;
  dataDir: string;
  home: string;
  logPath: string;
  uri(): string;
  stop(): Promise<void>;
  kill(): void;
  restart(): Promise<void>;
}

export interface StartOptions {
  env?: Record<string, string>;
  password?: string;
  user?: string;
}

/** The binary the build script printed, or the sentence that says how to get one. */
export function serverBinary(): string {
  const binary = process.env['HOARDDB_SERVER_BIN'];
  if (binary === undefined || binary === '') {
    throw new Error(
      'HOARDDB_SERVER_BIN is not set: run scripts/fetch-server.sh and export its output (HOARDDB_SERVER_BIN=$(scripts/fetch-server.sh)), or point it at a hoardDB-server binary',
    );
  }
  return binary;
}

/** Ask the kernel for n distinct free loopback ports, holding every one until all are known. */
export async function freePorts(count: number): Promise<number[]> {
  const holders: Server[] = [];
  const ports: number[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const holder = createServer();
      await new Promise<void>((resolveListen, rejectListen) => {
        holder.once('error', rejectListen);
        holder.listen(0, '127.0.0.1', resolveListen);
      });
      holders.push(holder);
      const address = holder.address();
      if (address === null || typeof address === 'string') throw new Error('a listening socket has no port');
      ports.push(address.port);
    }
  } finally {
    await Promise.all(
      holders.map((holder) => new Promise<void>((resolveClose) => holder.close(() => resolveClose()))),
    );
  }
  return ports;
}

/** One free loopback port. */
export async function freePort(): Promise<number> {
  const [port] = await freePorts(1);
  if (port === undefined) throw new Error('no free port was found');
  return port;
}

function logTail(path: string, lines: number): string {
  try {
    return readFileSync(path, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log was written)';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** The pieces of one running server that a restart reuses. */
interface Launch {
  root: string;
  env: Record<string, string>;
  logPath: string;
}

class RunningProcess {
  readonly exited: Promise<void>;
  private hasExited = false;

  constructor(readonly child: ChildProcess) {
    this.exited = new Promise<void>((resolveExit) => {
      child.once('exit', () => {
        this.hasExited = true;
        resolveExit();
      });
    });
  }

  get alive(): boolean {
    return !this.hasExited;
  }
}

function launch(launchPlan: Launch): RunningProcess {
  // Appending, so a restart keeps the first run's lines for the failure report.
  const logFd = openSync(launchPlan.logPath, 'a');
  try {
    const child = spawn(serverBinary(), [], {
      env: launchPlan.env,
      stdio: ['ignore', logFd, logFd],
      cwd: launchPlan.root,
    });
    return new RunningProcess(child);
  } finally {
    closeSync(logFd);
  }
}

/** Wait for the fingerprint line a launch wrote after the log was `fromBytes` long. */
async function waitForFingerprint(running: RunningProcess, logPath: string, fromBytes: number): Promise<string> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const match = FINGERPRINT_PATTERN.exec(readFileSync(logPath).subarray(fromBytes).toString('utf8'));
    if (match?.[1] !== undefined) return match[1];
    if (!running.alive) {
      throw new Error(`the server exited before it was ready; the last 40 log lines:\n${logTail(logPath, 40)}`);
    }
    if (Date.now() > deadline) {
      running.child.kill('SIGKILL');
      throw new Error(`the server was not ready after ${READY_TIMEOUT_MS} ms; the last 40 log lines:\n${logTail(logPath, 40)}`);
    }
    await sleep(100);
  }
}

/** Start a fresh single-node server and wait for the log line that carries its fingerprint. */
export async function startServer(options: StartOptions = {}): Promise<TestServer> {
  const root = mkdtempSync(join(tmpdir(), 'hoarddb-node-server-'));
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(home, { recursive: true });

  const [driverPort, ringPort, internodePort, metricsPort] = await freePorts(4);
  if (driverPort === undefined || ringPort === undefined || internodePort === undefined || metricsPort === undefined) {
    throw new Error('four free ports were not found');
  }
  const user = options.user ?? 'admin';
  const password = options.password ?? DEFAULT_TEST_PASSWORD;
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOARDDB_DATA_DIR: dataDir,
    HOARDDB_TCP_LISTEN: `127.0.0.1:${driverPort}`,
    HOARDDB_LISTEN: `127.0.0.1:${ringPort}`,
    HOARDDB_TCP_INTERNODE_LISTEN: `127.0.0.1:${internodePort}`,
    HOARDDB_METRICS_LISTEN: `127.0.0.1:${metricsPort}`,
    HOARDDB_ROOT_USER: user,
    HOARDDB_ROOT_PASSWORD: password,
    HOME: home,
    ...options.env,
  };
  const plan: Launch = { root, env, logPath: join(root, 'server.log') };

  let running = launch(plan);
  let fingerprint: string;
  try {
    fingerprint = await waitForFingerprint(running, plan.logPath, 0);
  } catch (error) {
    running.child.kill('SIGKILL');
    await running.exited;
    rmSync(root, { recursive: true, force: true });
    throw error;
  }

  const host = '127.0.0.1';
  const server: TestServer = {
    address: `${host}:${driverPort}`,
    host,
    port: driverPort,
    ringPort,
    fingerprint,
    user,
    password,
    dataDir,
    home,
    logPath: plan.logPath,
    uri: () => `hoarddb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${driverPort}?fingerprint=${fingerprint}`,
    async stop() {
      if (running.alive) {
        running.child.kill('SIGTERM');
        const timer = setTimeout(() => {
          if (running.alive) running.child.kill('SIGKILL');
        }, STOP_GRACE_MS);
        await running.exited;
        clearTimeout(timer);
      }
      rmSync(root, { recursive: true, force: true });
    },
    kill() {
      if (running.alive) running.child.kill('SIGKILL');
    },
    async restart() {
      if (running.alive) {
        running.child.kill('SIGTERM');
        await running.exited;
      }
      const before = statSync(plan.logPath).size;
      running = launch(plan);
      const restarted = await waitForFingerprint(running, plan.logPath, before);
      if (restarted !== fingerprint) {
        throw new Error(`the restarted server presented ${restarted}, not ${fingerprint}`);
      }
    },
  };
  return server;
}

/**
 * The answer's ports and data directory are the run's own; the vectors were written with fixed
 * ones (normalisations, sentence 4), so a replayed answer is rewritten before it is compared.
 * Only strings are touched, and a stored document's strings are not (they are the test's own).
 */
export function rewritePorts(tree: unknown, server: TestServer): unknown {
  return rewrite(tree, server, false);
}

const STORED_DOCUMENT_KEYS: ReadonlySet<string> = new Set([
  'data',
  'doc',
  'documents',
  'results',
  'value',
  'element',
  'metadata',
  'values',
]);

function rewrite(node: unknown, server: TestServer, insideDocument: boolean): unknown {
  if (typeof node === 'string') {
    if (insideDocument) return node;
    return node
      .split(`127.0.0.1:${server.port}`)
      .join('127.0.0.1:7433')
      .split(`127.0.0.1:${server.ringPort}`)
      .join('127.0.0.1:4433')
      .split(server.dataDir)
      .join('/data');
  }
  if (Array.isArray(node)) return node.map((entry) => rewrite(entry, server, insideDocument));
  if (typeof node === 'object' && node !== null) {
    const rewritten: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(node)) {
      rewritten[key] = rewrite(entry, server, insideDocument || STORED_DOCUMENT_KEYS.has(key));
    }
    return rewritten;
  }
  return node;
}

/** Every opcode a setup request may be answered with: the harness reads the answer, it does not predict it. */
const ANY_OPCODE: readonly number[] = Object.values(Op);
const REPLAY_TIMEOUT_MS = 30_000;

interface VectorRequest {
  opcode: number;
  request_id_hex: string;
  payload_json?: unknown;
  payload_hex: string;
}

interface VectorResponse {
  opcode: number;
  request_id_hex: string;
  payload_json?: unknown;
  payload_hex: string;
  fields: string[];
  vary: string[];
  additive_fields: string[];
  absent_fields: string[];
}

function payloadOf(request: { payload_json?: unknown; payload_hex: string }, lease?: string): Uint8Array {
  return request.payload_json === undefined
    ? hexToBytes(request.payload_hex)
    : bytesFromExtendedJson(withLease(request.payload_json, lease));
}

/**
 * A lease request's `lease_id` is captured as "normalised" because the real one differs every run; the
 * vector's notes say it is the id the setup's claim returned, so the harness puts that id back.
 */
function withLease(payload: unknown, lease: string | undefined): unknown {
  if (lease === undefined || typeof payload !== 'object' || payload === null || Array.isArray(payload)) return payload;
  const fields = payload as Record<string, unknown>;
  return fields['lease_id'] === 'normalised' ? { ...fields, lease_id: lease } : payload;
}

/** The first name of a field path: "buckets[].name" and "buckets" both belong to "buckets". */
function topLevelName(path: string): string {
  const cut = path.search(/[.[]/);
  return cut === -1 ? path : path.slice(0, cut);
}

/**
 * Replay one exchange vector on a real server (handbook testing.md leg 3): a fresh connection pinned
 * to the server's key, the vector's setup, then its own request under its own request ID, and the
 * answer compared the way section 1.1 says. Throws, naming the vector, on the first difference.
 */
export async function replayExchange(
  vector: Vector,
  server: TestServer,
  identity?: readonly (readonly [fixed: string, live: string])[],
): Promise<void> {
  try {
    await replay(vector, server, identity);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`vector "${vector.name}": ${reason}`, { cause: error });
  }
}

async function replay(
  vector: Vector,
  server: TestServer,
  identity: readonly (readonly [string, string])[] | undefined,
): Promise<void> {
  const request = vector['request'] as VectorRequest;
  const response = vector['response'] as VectorResponse;
  const setup = (vector['setup'] ?? []) as { opcode: number; payload_json: unknown }[];

  const trust = makeTrustPolicy({ fingerprints: [server.fingerprint], knownServersPath: false }, [], 1);
  const connection = await Connection.dial({
    target: { host: server.host, port: server.port, hostIndex: 0 },
    trust,
    dialTimeoutMs: 10_000,
  });
  try {
    if (vector['connection'] === 'authenticated') {
      await authenticate(connection, { username: server.user, password: server.password }, REPLAY_TIMEOUT_MS);
    }
    let lease: string | undefined;
    for (const step of setup) {
      const answer = await connection.send(step.opcode, bytesFromExtendedJson(withLease(step.payload_json, lease)), {
        timeoutMs: REPLAY_TIMEOUT_MS,
        expect: ANY_OPCODE,
      });
      assert.notEqual(answer.opcode, Op.ERROR, `a setup request (opcode ${step.opcode}) was refused: ${errorText(answer.payload)}`);
      if (answer.payload.length > 0) {
        const fields = decodeDocument(answer.payload, 'safe');
        assert.notEqual(fields['success'], false, `a setup request (opcode ${step.opcode}) answered success: false`);
        if (typeof fields['lease_id'] === 'string') lease = fields['lease_id'];
      }
    }

    const answer = await connection.sendWithId(
      request.opcode,
      hexToBytes(request.request_id_hex),
      payloadOf(request, lease),
      { timeoutMs: REPLAY_TIMEOUT_MS, expect: [response.opcode] },
    );
    assert.equal(answer.opcode, response.opcode, 'the answer opcode differs');
    assert.equal(requestIdHex(answer.requestId), response.request_id_hex, 'the request ID was not echoed');
    compareAnswer(vector, response, answer.payload, server, identity);
  } finally {
    connection.destroy();
  }
}

function errorText(payload: Uint8Array): string {
  try {
    const fields = decodeDocument(payload, 'safe');
    return `code ${String(fields['code'])}: ${String(fields['message'])}`;
  } catch {
    return '(the payload did not decode)';
  }
}

/** Every occurrence of each fixed string replaced by its live one (the cluster's identity, N-55). */
/**
 * Every fixed value replaced by its live one in a single pass: one alternation, longest key first, so a
 * live value that equals another node's fixed value (a live port 4435 for node1, node2's fixed 4435) is
 * never rewritten a second time (N-59).
 */
export function applyPairs(text: string, pairs: readonly (readonly [string, string])[]): string {
  if (pairs.length === 0) return text;
  const live = new Map(pairs.map(([fixed, value]) => [fixed, value] as const));
  const keys = [...live.keys()].sort((left, right) => right.length - left.length);
  const pattern = new RegExp(keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return text.replace(pattern, (found) => live.get(found) ?? found);
}

function compareAnswer(
  vector: Vector,
  response: VectorResponse,
  payload: Uint8Array,
  server: TestServer,
  identity: readonly (readonly [string, string])[] | undefined,
): void {
  const error = vector['error'] as
    | { code: number; write_outcome?: string; message_contains?: string[] }
    | undefined;
  const authFail = vector['auth_fail'] as { reason: number; message_contains?: string[] } | undefined;

  if (error !== undefined || authFail !== undefined) {
    const fields = decodeDocument(payload, 'safe');
    const message = String(fields['message'] ?? '');
    if (error !== undefined) {
      assert.equal(Number(fields['code']), error.code, `the error code differs (${message})`);
      if (error.write_outcome !== undefined) {
        assert.equal(fields['write_outcome'], error.write_outcome, 'the write_outcome differs');
      }
    }
    if (authFail !== undefined) {
      assert.equal(Number(fields['reason']), authFail.reason, `the AUTH_FAIL reason differs (${message})`);
    }
    for (const written of error?.message_contains ?? authFail?.message_contains ?? []) {
      const part = identity === undefined ? written : applyPairs(written, identity);
      assert.ok(message.includes(part), `the message "${message}" does not contain "${part}"`);
    }
    return;
  }

  if (response.payload_json === undefined) {
    if (response.payload_hex === '') {
      assert.equal(payload.length, 0, 'the answer should have no payload');
    } else {
      assert.equal(payload[0], hexToBytes(response.payload_hex)[0], 'the answer status byte differs');
    }
    return;
  }

  // With the cluster's identity the expected answer carries the live addresses, so only the data
  // directory of the answer is rewritten; otherwise the answer's own ports go back to the fixed ones.
  const answered = extendedJsonFromBytes(payload);
  const actual = (
    identity === undefined
      ? rewritePorts(answered, server)
      : (JSON.parse(JSON.stringify(answered).split(server.dataDir).join('/data')) as unknown)
  ) as Record<string, unknown>;
  const known = new Set(response.fields.map(topLevelName));
  for (const key of Object.keys(actual)) {
    assert.ok(known.has(key), `the answer carries "${key}", which the vector's fields do not list`);
  }
  for (const path of response.absent_fields) {
    assert.equal(removePath(structuredClone(actual), path).length, 0, `the answer carries "${path}", which must be absent`);
  }
  // Additive fields may be present or absent, so neither side is held to them.
  const expected = (
    identity === undefined
      ? structuredClone(response.payload_json)
      : (JSON.parse(applyPairs(JSON.stringify(response.payload_json), identity)) as unknown)
  ) as Record<string, unknown>;
  for (const path of response.additive_fields) {
    removePath(actual, path);
    removePath(expected, path);
  }
  assertResponseMatches(actual, expected, response.vary);
}

/**
 * Runs a vector's setup on a fresh authenticated connection and returns the lease id the last claim of
 * the setup answered (a lease request in the vector names it as "normalised"). The conformance replay
 * through the public API sets the world up with this and then makes the call with the driver's verbs.
 */
export async function runVectorSetup(vector: Vector, server: TestServer): Promise<string | undefined> {
  const setup = (vector['setup'] ?? []) as { opcode: number; payload_json: unknown }[];
  const trust = makeTrustPolicy({ fingerprints: [server.fingerprint], knownServersPath: false }, [], 1);
  const connection = await Connection.dial({ target: { host: server.host, port: server.port, hostIndex: 0 }, trust, dialTimeoutMs: 10_000 });
  try {
    await authenticate(connection, { username: server.user, password: server.password }, REPLAY_TIMEOUT_MS);
    let lease: string | undefined;
    for (const step of setup) {
      const answer = await connection.send(step.opcode, bytesFromExtendedJson(withLease(step.payload_json, lease)), {
        timeoutMs: REPLAY_TIMEOUT_MS,
        expect: ANY_OPCODE,
      });
      assert.notEqual(answer.opcode, Op.ERROR, `a setup request (opcode ${step.opcode}) was refused: ${errorText(answer.payload)}`);
      if (answer.payload.length > 0) {
        const fields = decodeDocument(answer.payload, 'safe');
        assert.notEqual(fields['success'], false, `a setup request (opcode ${step.opcode}) answered success: false`);
        if (typeof fields['lease_id'] === 'string') lease = fields['lease_id'];
      }
    }
    return lease;
  } finally {
    connection.destroy();
  }
}
