import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { derivePath, masterKeyFromSeed, parsePath } from '../../src/core/crypto/slip10';

// SLIP-0010 "Test vector 1 for ed25519" (https://github.com/satoshilabs/slips/blob/master/slip-0010.md).
// Public keys in the spec are prefixed with 0x00.
const SEED = hexToBytes('000102030405060708090a0b0c0d0e0f');
const VECTOR_1: { path: string; chainCode: string; priv: string; pub: string }[] = [
  {
    path: 'm',
    chainCode: '90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb',
    priv: '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7',
    pub: '00a4b2856bfec510abab89753fac1ac0e1112364e7d250545963f135f2a33188ed',
  },
  {
    path: "m/0'",
    chainCode: '8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69',
    priv: '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3',
    pub: '008c8a13df77a28f3445213a0f432fde644acaa215fc72dcdf300d5efaa85d350c',
  },
  {
    path: "m/0'/1'",
    chainCode: 'a320425f77d1b5c2505a6b1b27382b37368ee640e3557c315416801243552f14',
    priv: 'b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2',
    pub: '001932a5270f335bed617d5b935c80aedb1a35bd9fc1e31acafd5372c30f5c1187',
  },
  {
    path: "m/0'/1'/2'",
    chainCode: '2e69929e00b5ab250f49c3fb1c12f252de4fed2c1db88387094a0f8c4c9ccd6c',
    priv: '92a5b23c0b8a99e37d07df3fb9966917f5d06e02ddbd909c7e184371463e9fc9',
    pub: '00ae98736566d30ed0e9d2f4486a64bc95740d89c7db33f52121f8ea8f76ff0fc1',
  },
  {
    path: "m/0'/1'/2'/2'",
    chainCode: '8f6d87f93d750e0efccda017d662a1b31a266e4a6f5993b15f5c1f07f74dd5cc',
    priv: '30d1dc7e5fc04c31219ab25a27ae00b50f6fd66622f6e9c913253d6511d1e662',
    pub: '008abae2d66361c879b900d204ad2cc4984fa2aa344dd7ddc46007329ac76c429c',
  },
  {
    path: "m/0'/1'/2'/2'/1000000000'",
    chainCode: '68789923a0cac2cd5a29172a475fe9e0fb14cd6adb5ad98a3fa70333e7afa230',
    priv: '8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793',
    pub: '003c24da049451555d51a7014a37337aa4e12d41e485abccfa46b47dfb2af54b7a',
  },
];

describe('SLIP-0010 ed25519 test vector 1', () => {
  it.each(VECTOR_1)('derives $path', ({ path, chainCode, priv, pub }) => {
    const node = derivePath(SEED, path);
    expect(bytesToHex(node.chainCode)).toBe(chainCode);
    expect(bytesToHex(node.key)).toBe(priv);
    expect(`00${bytesToHex(ed25519.getPublicKey(node.key))}`).toBe(pub);
  });

  it('masterKeyFromSeed equals derivePath(seed, "m")', () => {
    const m = masterKeyFromSeed(SEED);
    expect(bytesToHex(m.key)).toBe(VECTOR_1[0].priv);
    expect(bytesToHex(m.chainCode)).toBe(VECTOR_1[0].chainCode);
    expect(m.key).toHaveLength(32);
    expect(m.chainCode).toHaveLength(32);
  });

  it('does not mutate the input seed and is deterministic', () => {
    const copy = new Uint8Array(SEED);
    const a = derivePath(SEED, "m/0'/1'");
    const b = derivePath(SEED, "m/0'/1'");
    expect(SEED).toEqual(copy);
    expect(a).toEqual(b);
  });
});

describe('parsePath', () => {
  it('returns hardened indices', () => {
    expect(parsePath('m')).toEqual([]);
    expect(parsePath("m/44'/501'/0'/0'")).toEqual([0x8000002c, 0x800001f5, 0x80000000, 0x80000000]);
    expect(parsePath("m/2147483647'")).toEqual([0xffffffff]);
  });

  it('rejects non-hardened segments', () => {
    expect(() => parsePath("m/44'/501'/0'/0")).toThrow('ed25519 only supports hardened derivation');
    expect(() => parsePath('m/0')).toThrow('hardened');
    expect(() => parsePath('m/')).toThrow('hardened');
  });

  it('rejects a bad prefix', () => {
    expect(() => parsePath("M/0'")).toThrow('Invalid derivation path');
    expect(() => parsePath("/0'")).toThrow('Invalid derivation path');
    expect(() => parsePath("44'/501'")).toThrow('Invalid derivation path');
    expect(() => parsePath('')).toThrow('Invalid derivation path');
  });

  it('rejects malformed or out-of-range segments', () => {
    for (const seg of ["'", "-1'", "1.5'", "abc'", "0x10'", "1e3'", " 1'", "2147483648'"]) {
      expect(() => parsePath(`m/${seg}`), seg).toThrow('Invalid path segment');
    }
  });

  it('derivePath surfaces path errors', () => {
    expect(() => derivePath(SEED, "m/0'/1")).toThrow('hardened');
  });
});
