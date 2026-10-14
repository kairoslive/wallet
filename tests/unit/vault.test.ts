import { describe, expect, it } from 'vitest';
import { base64 } from '@scure/base';
import {
  DEFAULT_PBKDF2_ITERATIONS,
  decryptVault,
  decryptWithKey,
  deriveKey,
  encryptVault,
  encryptWithKey,
  exportKey,
  importKey,
  type EncryptedVault,
} from '../../src/core/crypto/vault';

const ITER = 1000;
const SECRET = { seeds: [{ id: 's1', mnemonic: 'test test test test test test test test test test test junk' }], keys: [], n: 1, u: 'ünïcødé ✓' };

describe('vault', () => {
  it('uses a strong default iteration count', () => {
    expect(DEFAULT_PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(600_000);
  });

  it('round-trips a value with the right password', async () => {
    const { vault, key } = await encryptVault('correct horse', SECRET, ITER);
    expect(vault.version).toBe(1);
    expect(vault.kdf).toMatchObject({ name: 'PBKDF2', hash: 'SHA-256', iterations: ITER });
    expect(vault.cipher.name).toBe('AES-GCM');
    expect(base64.decode(vault.kdf.salt)).toHaveLength(16);
    expect(base64.decode(vault.cipher.iv)).toHaveLength(12);
    // Ciphertext must not leak the plaintext.
    expect(vault.data).not.toContain('test');
    expect(new TextDecoder().decode(base64.decode(vault.data))).not.toContain('junk');

    const out = await decryptVault<typeof SECRET>('correct horse', vault);
    expect(out.value).toEqual(SECRET);
    // The key returned by decryptVault is equivalent to the one from encryption.
    expect(await exportKey(out.key)).toBe(await exportKey(key));
  });

  it('survives JSON serialization of the vault (as stored in chrome.storage)', async () => {
    const { vault } = await encryptVault('pw', SECRET, ITER);
    const stored = JSON.parse(JSON.stringify(vault)) as EncryptedVault;
    expect((await decryptVault('pw', stored)).value).toEqual(SECRET);
  });

  it("throws 'Incorrect password' for a wrong password", async () => {
    const { vault } = await encryptVault('correct horse', SECRET, ITER);
    await expect(decryptVault('wrong horse', vault)).rejects.toThrow('Incorrect password');
    await expect(decryptVault('', vault)).rejects.toThrow('Incorrect password');
    await expect(decryptVault('Correct horse', vault)).rejects.toThrow('Incorrect password');
  });

  it("throws 'Incorrect password' when the ciphertext or IV is tampered with", async () => {
    const { vault } = await encryptVault('pw', SECRET, ITER);
    const ct = base64.decode(vault.data);
    ct[0] ^= 1;
    await expect(decryptVault('pw', { ...vault, data: base64.encode(ct) })).rejects.toThrow('Incorrect password');
    const iv = base64.decode(vault.cipher.iv);
    iv[0] ^= 1;
    await expect(decryptVault('pw', { ...vault, cipher: { ...vault.cipher, iv: base64.encode(iv) } })).rejects.toThrow(
      'Incorrect password',
    );
  });

  it('uses the iteration count stored in the vault', async () => {
    const { vault } = await encryptVault('pw', SECRET, ITER);
    // Changing iterations changes the derived key, so decryption must fail.
    await expect(decryptVault('pw', { ...vault, kdf: { ...vault.kdf, iterations: ITER + 1 } })).rejects.toThrow(
      'Incorrect password',
    );
  });

  it('uses a fresh salt and IV for every encryption', async () => {
    const a = await encryptVault('pw', SECRET, ITER);
    const b = await encryptVault('pw', SECRET, ITER);
    expect(a.vault.kdf.salt).not.toBe(b.vault.kdf.salt);
    expect(a.vault.cipher.iv).not.toBe(b.vault.cipher.iv);
    expect(a.vault.data).not.toBe(b.vault.data);
    expect(await exportKey(a.key)).not.toBe(await exportKey(b.key));
  });

  it('encryptWithKey uses a fresh IV each time with the same key', async () => {
    const { vault, key } = await encryptVault('pw', SECRET, ITER);
    const ivs = new Set([vault.cipher.iv]);
    for (let i = 0; i < 5; i++) {
      const v = await encryptWithKey(key, SECRET, vault.kdf);
      expect(v.kdf).toEqual(vault.kdf);
      ivs.add(v.cipher.iv);
      expect(await decryptWithKey(key, v)).toEqual(SECRET);
    }
    expect(ivs.size).toBe(6);
  });

  it('exportKey/importKey round-trip can decrypt (session key cache)', async () => {
    const { vault, key } = await encryptVault('pw', SECRET, ITER);
    const raw = await exportKey(key);
    expect(base64.decode(raw)).toHaveLength(32);
    const imported = await importKey(raw);
    expect(await decryptWithKey(imported, vault)).toEqual(SECRET);
    // And data re-encrypted with the imported key decrypts with the password.
    const v2 = await encryptWithKey(imported, { changed: true }, vault.kdf);
    expect((await decryptVault('pw', v2)).value).toEqual({ changed: true });
  });

  it('decryptWithKey with an unrelated key throws Incorrect password', async () => {
    const { vault } = await encryptVault('pw', SECRET, ITER);
    const other = await deriveKey('pw', new Uint8Array(16), ITER);
    await expect(decryptWithKey(other, vault)).rejects.toThrow('Incorrect password');
  });

  it('deriveKey is deterministic for the same password/salt/iterations', async () => {
    const salt = new Uint8Array(16).fill(3);
    const k1 = await exportKey(await deriveKey('pw', salt, ITER));
    const k2 = await exportKey(await deriveKey('pw', salt, ITER));
    const k3 = await exportKey(await deriveKey('pw2', salt, ITER));
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
  });
});
