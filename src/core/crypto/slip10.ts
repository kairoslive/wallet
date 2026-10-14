import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';

/** SLIP-0010 ed25519 key derivation (hardened-only), as used by Solana wallets. */

const ED25519_SEED = new TextEncoder().encode('ed25519 seed');
const HARDENED = 0x80000000;

export interface Slip10Node {
  key: Uint8Array;
  chainCode: Uint8Array;
}

export function masterKeyFromSeed(seed: Uint8Array): Slip10Node {
  const I = hmac(sha512, ED25519_SEED, seed);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

function ckdPriv(parent: Slip10Node, index: number): Slip10Node {
  const data = new Uint8Array(37);
  data[0] = 0;
  data.set(parent.key, 1);
  new DataView(data.buffer).setUint32(33, index >>> 0, false);
  const I = hmac(sha512, parent.chainCode, data);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

export function parsePath(path: string): number[] {
  const parts = path.split('/');
  if (parts[0] !== 'm') throw new Error(`Invalid derivation path: ${path}`);
  return parts.slice(1).map((p) => {
    if (!p.endsWith("'")) throw new Error('ed25519 only supports hardened derivation');
    const n = Number(p.slice(0, -1));
    if (!Number.isInteger(n) || n < 0 || n >= HARDENED) throw new Error(`Invalid path segment: ${p}`);
    return n + HARDENED;
  });
}

export function derivePath(seed: Uint8Array, path: string): Slip10Node {
  return parsePath(path).reduce(ckdPriv, masterKeyFromSeed(seed));
}
