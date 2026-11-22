// SPDX-License-Identifier: Apache-2.0
//
// A throwaway TLS identity for tests that need a real ed25519 handshake: openssl mints the key and
// the self-signed certificate, and the key is read back the way trust.md section 5 says a Node
// driver reads a peer's, so a test never trusts the driver's own reading of its own file.

import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TlsIdentity {
  dir: string;
  keyPem: string;
  certPem: string;
  keyPath: string;
  certPath: string;
  publicKeyHex: string;
  fingerprint: string;
}

function openssl(args: string[]): void {
  try {
    execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    throw new Error(`openssl ${args.join(' ')} failed: ${(error as Error).message}`);
  }
}

/** Mint a fresh ed25519 key and a self-signed certificate for it, in a temporary directory. */
export function makeTlsIdentity(): TlsIdentity {
  const dir = mkdtempSync(join(tmpdir(), 'hoarddb-tls-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');

  openssl(['genpkey', '-algorithm', 'ed25519', '-out', keyPath]);
  openssl([
    'req',
    '-new',
    '-x509',
    '-key',
    keyPath,
    '-out',
    certPath,
    '-days',
    '3650',
    '-subj',
    '/O=hoardDB/CN=hoarddb-node',
  ]);

  const certificate = new X509Certificate(readFileSync(certPath, 'utf8'));
  const spki = certificate.publicKey.export({ type: 'spki', format: 'der' });
  const rawKey = new Uint8Array(spki.subarray(spki.length - 32));

  return {
    dir,
    keyPem: readFileSync(keyPath, 'utf8'),
    certPem: readFileSync(certPath, 'utf8'),
    keyPath,
    certPath,
    publicKeyHex: Buffer.from(rawKey).toString('hex'),
    fingerprint: `SHA256:${createHash('sha256').update(rawKey).digest('hex')}`,
  };
}

/** Remove an identity's directory and with it the private key it holds. */
export function removeTlsIdentity(identity: TlsIdentity): void {
  rmSync(identity.dir, { recursive: true, force: true });
}