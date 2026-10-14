import { base64 } from '@scure/base';

/**
 * Password-based encryption for the secret vault.
 * PBKDF2-SHA256 derives an AES-256-GCM key; the raw key can be cached in
 * session storage so the MV3 service worker can restart without re-prompting.
 */

export const DEFAULT_PBKDF2_ITERATIONS = 600_000;

export interface EncryptedVault {
  version: 1;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: { name: 'AES-GCM'; iv: string };
  data: string;
}

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

function buf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

export async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await subtle().importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

export async function exportKey(key: CryptoKey): Promise<string> {
  return base64.encode(new Uint8Array(await subtle().exportKey('raw', key)));
}

export async function importKey(raw: string): Promise<CryptoKey> {
  return subtle().importKey('raw', buf(base64.decode(raw)), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

export async function encryptWithKey<T>(key: CryptoKey, value: T, kdf: EncryptedVault['kdf']): Promise<EncryptedVault> {
  const iv = randomBytes(12);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value)));
  return {
    version: 1,
    kdf,
    cipher: { name: 'AES-GCM', iv: base64.encode(iv) },
    data: base64.encode(new Uint8Array(ct)),
  };
}

export async function decryptWithKey<T>(key: CryptoKey, vault: EncryptedVault): Promise<T> {
  try {
    const pt = await subtle().decrypt(
      { name: 'AES-GCM', iv: buf(base64.decode(vault.cipher.iv)) },
      key,
      buf(base64.decode(vault.data)),
    );
    return JSON.parse(dec.decode(pt)) as T;
  } catch {
    throw new Error('Incorrect password');
  }
}

export async function encryptVault<T>(
  password: string,
  value: T,
  iterations = DEFAULT_PBKDF2_ITERATIONS,
): Promise<{ vault: EncryptedVault; key: CryptoKey }> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, iterations);
  const vault = await encryptWithKey(key, value, {
    name: 'PBKDF2',
    hash: 'SHA-256',
    iterations,
    salt: base64.encode(salt),
  });
  return { vault, key };
}

export async function decryptVault<T>(password: string, vault: EncryptedVault): Promise<{ value: T; key: CryptoKey }> {
  const key = await deriveKey(password, base64.decode(vault.kdf.salt), vault.kdf.iterations);
  const value = await decryptWithKey<T>(key, vault);
  return { value, key };
}
