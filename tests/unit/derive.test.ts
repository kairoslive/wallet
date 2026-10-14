import { describe, expect, it } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { derivePath as refDerivePath } from 'ed25519-hd-key';
import {
  deriveAddresses,
  deriveEvmPrivateKey,
  deriveSolanaSecretKey,
  evmAddressFromPrivateKey,
  evmPath,
  generateMnemonic,
  isValidMnemonic,
  mnemonicToSeed,
  normalizeMnemonic,
  parseEvmPrivateKey,
  parseSolanaPrivateKey,
  solanaAddressFromSecret,
  solanaPath,
  solanaSecretFromSeed,
} from '../../src/core/keyring/derive';

const MNEMONIC = 'test test test test test test test test test test test junk';
// The second, independent mnemonic guards against an implementation that only "works" for one seed.
const MNEMONIC_2 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('derivation paths', () => {
  it('uses BIP-44 paths for EVM and Phantom-style paths for Solana', () => {
    expect(evmPath(0)).toBe("m/44'/60'/0'/0/0");
    expect(evmPath(7)).toBe("m/44'/60'/0'/0/7");
    expect(solanaPath(0)).toBe("m/44'/501'/0'/0'");
    expect(solanaPath(3)).toBe("m/44'/501'/3'/0'");
  });
});

describe('EVM derivation', () => {
  const seed = mnemonicToSeed(MNEMONIC);

  it('matches the well-known Hardhat/Anvil accounts', () => {
    const pk0 = deriveEvmPrivateKey(seed, 0);
    const pk1 = deriveEvmPrivateKey(seed, 1);
    expect(pk0).toBe('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
    expect(pk1).toBe('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    expect(evmAddressFromPrivateKey(pk0)).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(evmAddressFromPrivateKey(pk1)).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  });

  it('deriveAddresses returns checksummed EVM addresses', () => {
    expect(deriveAddresses(MNEMONIC, 0).evmAddress).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(deriveAddresses(MNEMONIC, 1).evmAddress).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  });
});

describe('Solana derivation (cross-checked against ed25519-hd-key + @solana/web3.js)', () => {
  for (const mnemonic of [MNEMONIC, MNEMONIC_2]) {
    const seed = mnemonicToSeed(mnemonic);
    for (const i of [0, 1, 2]) {
      it(`${mnemonic.split(' ').at(-1)} index ${i}`, () => {
        const ref = refDerivePath(`m/44'/501'/${i}'/0'`, bytesToHex(seed));
        const refKp = Keypair.fromSeed(Uint8Array.from(ref.key));
        const secret = deriveSolanaSecretKey(seed, i);
        expect(secret).toHaveLength(64);
        expect(bytesToHex(secret)).toBe(bytesToHex(refKp.secretKey));
        expect(solanaAddressFromSecret(secret)).toBe(refKp.publicKey.toBase58());
        expect(deriveAddresses(mnemonic, i).solanaAddress).toBe(refKp.publicKey.toBase58());
      });
    }
  }

  it('different indexes yield different addresses', () => {
    const a = new Set([0, 1, 2].map((i) => deriveAddresses(MNEMONIC, i).solanaAddress));
    expect(a.size).toBe(3);
  });

  it('solanaSecretFromSeed builds seed || pubkey', () => {
    const seed32 = new Uint8Array(32).fill(7);
    const secret = solanaSecretFromSeed(seed32);
    expect(bytesToHex(secret)).toBe(bytesToHex(Keypair.fromSeed(seed32).secretKey));
  });
});

describe('mnemonics', () => {
  it('normalizes whitespace and case', () => {
    expect(normalizeMnemonic('  TEST test\t\tTest\n test  ')).toBe('test test test test');
  });

  it('validates normalized mnemonics', () => {
    expect(isValidMnemonic(MNEMONIC)).toBe(true);
    expect(isValidMnemonic(`  ${MNEMONIC.toUpperCase().replace(/ /g, '   ')} \n`)).toBe(true);
    expect(isValidMnemonic('test test test test test test test test test test test test')).toBe(false); // bad checksum
    expect(isValidMnemonic('test test test test test test test test test test junk')).toBe(false); // 11 words
    expect(isValidMnemonic('test test test test test test test test test test test zzzz')).toBe(false); // not in list
    expect(isValidMnemonic('')).toBe(false);
  });

  it('seed derivation is insensitive to formatting', () => {
    const a = mnemonicToSeed(MNEMONIC);
    const b = mnemonicToSeed(`\n ${MNEMONIC.toUpperCase().replace(/ /g, '  ')} `);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
    expect(a).toHaveLength(64);
    expect(deriveAddresses(MNEMONIC.toUpperCase(), 0).evmAddress).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  });

  it('generates valid 12 and 24 word mnemonics', () => {
    const m12 = generateMnemonic();
    const m24 = generateMnemonic(24);
    expect(m12.split(' ')).toHaveLength(12);
    expect(generateMnemonic(12).split(' ')).toHaveLength(12);
    expect(m24.split(' ')).toHaveLength(24);
    expect(isValidMnemonic(m12)).toBe(true);
    expect(isValidMnemonic(m24)).toBe(true);
    for (const w of m24.split(' ')) expect(wordlist).toContain(w);
    expect(generateMnemonic()).not.toBe(m12);
  });
});

describe('parseEvmPrivateKey', () => {
  const PK = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const N = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141';

  it('accepts keys with or without 0x, any case, surrounding whitespace', () => {
    expect(parseEvmPrivateKey(PK)).toBe(`0x${PK}`);
    expect(parseEvmPrivateKey(`0x${PK}`)).toBe(`0x${PK}`);
    expect(parseEvmPrivateKey(`  0X${PK.toUpperCase()}\n`)).toBe(`0x${PK}`);
    expect(evmAddressFromPrivateKey(parseEvmPrivateKey(PK))).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  });

  it('accepts boundary values 1 and n-1', () => {
    expect(parseEvmPrivateKey('0'.repeat(63) + '1')).toBe(`0x${'0'.repeat(63)}1`);
    expect(parseEvmPrivateKey(N.slice(0, -1) + '0')).toBe(`0x${N.slice(0, -1)}0`);
  });

  it.each([
    ['empty', ''],
    ['too short', PK.slice(2)],
    ['too long', `${PK}00`],
    ['non-hex', `${PK.slice(0, 63)}g`],
    ['zero', '0'.repeat(64)],
    ['curve order', N],
    ['above curve order', 'f'.repeat(64)],
    ['double prefix', `0x0x${PK}`],
  ])('rejects %s', (_, input) => {
    expect(() => parseEvmPrivateKey(input)).toThrow('Invalid EVM private key');
  });
});

describe('parseSolanaPrivateKey', () => {
  const seed32 = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const kp = Keypair.fromSeed(seed32);
  const secretHex = bytesToHex(kp.secretKey);

  it('accepts a base58 64-byte secret (Phantom export)', () => {
    const out = parseSolanaPrivateKey(bs58.encode(kp.secretKey));
    expect(bytesToHex(out)).toBe(secretHex);
    expect(solanaAddressFromSecret(out)).toBe(kp.publicKey.toBase58());
  });

  it('accepts a JSON byte array (solana-keygen file), with whitespace', () => {
    const json = `  ${JSON.stringify(Array.from(kp.secretKey), null, 1)}\n`;
    expect(bytesToHex(parseSolanaPrivateKey(json))).toBe(secretHex);
  });

  it('accepts a 32-byte seed as JSON, hex (with/without 0x) or base58', () => {
    expect(bytesToHex(parseSolanaPrivateKey(JSON.stringify(Array.from(seed32))))).toBe(secretHex);
    expect(bytesToHex(parseSolanaPrivateKey(bytesToHex(seed32)))).toBe(secretHex);
    expect(bytesToHex(parseSolanaPrivateKey(`0x${bytesToHex(seed32)}`))).toBe(secretHex);
    expect(bytesToHex(parseSolanaPrivateKey(bytesToHex(seed32).toUpperCase()))).toBe(secretHex);
    expect(bytesToHex(parseSolanaPrivateKey(bs58.encode(seed32)))).toBe(secretHex);
  });

  it('accepts a 64-byte secret as hex', () => {
    expect(bytesToHex(parseSolanaPrivateKey(secretHex))).toBe(secretHex);
  });

  it('rejects a 64-byte secret whose public half does not match', () => {
    const bad = new Uint8Array(kp.secretKey);
    bad[63] ^= 1;
    expect(() => parseSolanaPrivateKey(bs58.encode(bad))).toThrow('public key mismatch');
    const other = Keypair.fromSeed(new Uint8Array(32).fill(9));
    const mixed = new Uint8Array([...seed32, ...other.publicKey.toBytes()]);
    expect(() => parseSolanaPrivateKey(JSON.stringify(Array.from(mixed)))).toThrow('public key mismatch');
  });

  it.each([
    ['empty', ''],
    ['garbage text', 'hello world'],
    ['non-base58 characters', '0OIl0OIl'],
    ['wrong-length base58', bs58.encode(new Uint8Array(16).fill(1))],
    ['malformed JSON', '[1, 2,'],
    ['JSON array with out-of-range bytes', JSON.stringify(Array(64).fill(256))],
    ['JSON array with non-integers', JSON.stringify(Array(32).fill(1.5))],
    ['JSON array with strings', JSON.stringify(Array(32).fill('1'))],
    ['JSON of wrong length', JSON.stringify(Array(33).fill(1))],
    ['empty JSON array', '[]'],
  ])('rejects %s', (_, input) => {
    expect(() => parseSolanaPrivateKey(input)).toThrow('Invalid Solana private key');
  });
});
