import { describe, expect, it } from 'vitest';
import {
  isValidAddress,
  isValidEvmAddress,
  isValidSolanaAddress,
  normalizeAddress,
  sameAddress,
} from '../../src/core/address';

const EVM = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

describe('isValidEvmAddress', () => {
  it.each([EVM, EVM.toLowerCase(), `0x${EVM.slice(2).toUpperCase()}`, `  ${EVM}\n`, '0x0000000000000000000000000000000000000000'])(
    'accepts %j',
    (a) => expect(isValidEvmAddress(a)).toBe(true),
  );

  it.each(['', '0x', EVM.slice(2), EVM.slice(0, -1), `${EVM}0`, `0x${'g'.repeat(40)}`, SOL, `0X${EVM.slice(2)}`])(
    'rejects %j',
    (a) => expect(isValidEvmAddress(a)).toBe(false),
  );
});

describe('isValidSolanaAddress', () => {
  it.each([SOL, SYSTEM_PROGRAM, 'So11111111111111111111111111111111111111112', `  ${SOL} `])('accepts %j', (a) =>
    expect(isValidSolanaAddress(a)).toBe(true),
  );

  it.each([
    '',
    EVM,
    SOL.slice(0, 31),
    `${SOL}1111`,
    `${SOL.slice(0, -1)}0`, // '0' is not base58
    `${SOL.slice(0, -1)}O`,
    `${SOL.slice(0, -1)}I`,
    `${SOL.slice(0, -1)}l`,
    'z'.repeat(44), // valid charset but decodes to > 32 bytes
  ])('rejects %j', (a) => expect(isValidSolanaAddress(a)).toBe(false));
});

describe('isValidAddress', () => {
  it('dispatches on chain type', () => {
    expect(isValidAddress('evm', EVM)).toBe(true);
    expect(isValidAddress('evm', SOL)).toBe(false);
    expect(isValidAddress('solana', SOL)).toBe(true);
    expect(isValidAddress('solana', EVM)).toBe(false);
  });
});

describe('normalizeAddress', () => {
  it('EIP-55 checksums EVM addresses', () => {
    expect(normalizeAddress('evm', EVM.toLowerCase())).toBe(EVM);
    expect(normalizeAddress('evm', `0x${EVM.slice(2).toUpperCase()}`)).toBe(EVM);
    expect(normalizeAddress('evm', `  ${EVM.toLowerCase()} `)).toBe(EVM);
    expect(normalizeAddress('evm', '0x70997970c51812dc3a010c7d01b50e0d17dc79c8')).toBe(
      '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    );
  });

  it('trims Solana addresses', () => {
    expect(normalizeAddress('solana', ` ${SOL}\n`)).toBe(SOL);
  });

  it('throws on invalid input', () => {
    expect(() => normalizeAddress('evm', 'nope')).toThrow();
    expect(() => normalizeAddress('solana', 'not-base58!')).toThrow();
  });
});

describe('sameAddress', () => {
  it('compares EVM addresses case-insensitively', () => {
    expect(sameAddress(EVM, EVM.toLowerCase())).toBe(true);
    expect(sameAddress(EVM.toLowerCase(), EVM)).toBe(true);
    expect(sameAddress(EVM, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8')).toBe(false);
  });

  it('compares Solana addresses case-sensitively', () => {
    expect(sameAddress(SOL, SOL)).toBe(true);
    expect(sameAddress(SOL, SOL.toLowerCase())).toBe(false);
  });

  it('returns false when either side is missing', () => {
    expect(sameAddress(undefined, EVM)).toBe(false);
    expect(sameAddress(EVM, undefined)).toBe(false);
    expect(sameAddress('', '')).toBe(false);
    expect(sameAddress()).toBe(false);
  });
});
