import { generateMnemonic as genMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { privateKeyToAccount } from 'viem/accounts';
import bs58 from 'bs58';
import { derivePath } from '../crypto/slip10';

export const evmPath = (index: number) => `m/44'/60'/0'/0/${index}`;
/** Phantom / Solflare / Backpack default path. */
export const solanaPath = (index: number) => `m/44'/501'/${index}'/0'`;

export function generateMnemonic(words: 12 | 24 = 12): string {
  return genMnemonic(wordlist, words === 24 ? 256 : 128);
}

export function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().toLowerCase().split(/\s+/).join(' ');
}

export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(normalizeMnemonic(mnemonic), wordlist);
}

export function mnemonicToSeed(mnemonic: string): Uint8Array {
  return mnemonicToSeedSync(normalizeMnemonic(mnemonic));
}

export function deriveEvmPrivateKey(seed: Uint8Array, index: number): `0x${string}` {
  const node = HDKey.fromMasterSeed(seed).derive(evmPath(index));
  if (!node.privateKey) throw new Error('Failed to derive EVM key');
  return `0x${bytesToHex(node.privateKey)}`;
}

export function evmAddressFromPrivateKey(pk: `0x${string}`): string {
  return privateKeyToAccount(pk).address;
}

/** Returns the 64-byte Solana secret key (seed || pubkey). */
export function deriveSolanaSecretKey(seed: Uint8Array, index: number): Uint8Array {
  const { key } = derivePath(seed, solanaPath(index));
  return solanaSecretFromSeed(key);
}

export function solanaSecretFromSeed(seed32: Uint8Array): Uint8Array {
  const pub = ed25519.getPublicKey(seed32);
  const secret = new Uint8Array(64);
  secret.set(seed32, 0);
  secret.set(pub, 32);
  return secret;
}

export function solanaAddressFromSecret(secret: Uint8Array): string {
  return bs58.encode(secret.slice(32));
}

export interface DerivedAddresses {
  evmAddress: string;
  solanaAddress: string;
}

export function deriveAddresses(mnemonic: string, index: number): DerivedAddresses {
  const seed = mnemonicToSeed(mnemonic);
  return {
    evmAddress: evmAddressFromPrivateKey(deriveEvmPrivateKey(seed, index)),
    solanaAddress: solanaAddressFromSecret(deriveSolanaSecretKey(seed, index)),
  };
}

/** Accepts a 0x-prefixed or bare 32-byte hex key. */
export function parseEvmPrivateKey(input: string): `0x${string}` {
  const hex = input.trim().replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('Invalid EVM private key');
  const n = BigInt(`0x${hex}`);
  if (n === 0n || n >= secp256k1Order()) throw new Error('Invalid EVM private key');
  return `0x${hex}`;
}

function secp256k1Order(): bigint {
  return 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
}

/**
 * Accepts the common Solana private key formats: base58 64-byte secret (Phantom export),
 * a JSON byte array (solana-keygen file), or a 32-byte seed in base58/hex.
 */
export function parseSolanaPrivateKey(input: string): Uint8Array {
  const s = input.trim();
  let bytes: Uint8Array;
  if (s.startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(s);
    } catch {
      throw new Error('Invalid Solana private key');
    }
    if (!Array.isArray(arr) || !arr.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) {
      throw new Error('Invalid Solana private key');
    }
    bytes = Uint8Array.from(arr as number[]);
  } else if (/^(0x)?[0-9a-fA-F]{64}$/.test(s) || /^(0x)?[0-9a-fA-F]{128}$/.test(s)) {
    bytes = hexToBytes(s.replace(/^0x/, ''));
  } else {
    try {
      bytes = bs58.decode(s);
    } catch {
      throw new Error('Invalid Solana private key');
    }
  }
  if (bytes.length === 32) return solanaSecretFromSeed(bytes);
  if (bytes.length !== 64) throw new Error('Invalid Solana private key');
  const expected = ed25519.getPublicKey(bytes.slice(0, 32));
  if (bytesToHex(expected) !== bytesToHex(bytes.slice(32))) {
    throw new Error('Invalid Solana private key (public key mismatch)');
  }
  return bytes;
}
