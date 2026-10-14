import { describe, expect, it } from 'vitest';
import { formatAmount, formatUnits, formatUsd, parseUnits, shortAddress, toUsd } from '../../src/core/format';

describe('parseUnits', () => {
  it.each([
    ['0', 18, 0n],
    ['0.0', 6, 0n],
    ['1', 18, 10n ** 18n],
    ['.5', 18, 5n * 10n ** 17n],
    ['1.', 18, 10n ** 18n],
    ['1.5', 6, 1_500_000n],
    ['  2.25 ', 2, 225n],
    ['0.000001', 6, 1n],
    ['000123', 0, 123n],
    ['5', 0, 5n],
    ['5.', 0, 5n],
    ['123456789012345678901234567890', 0, 123456789012345678901234567890n],
    ['1.123456789012345678', 18, 1123456789012345678n],
  ])('parseUnits(%j, %i) = %s', (value, decimals, expected) => {
    expect(parseUnits(value, decimals)).toBe(expected);
  });

  it('rejects too many decimal places', () => {
    expect(() => parseUnits('1.1234567', 6)).toThrow('Too many decimal places (max 6)');
    expect(() => parseUnits('0.5', 0)).toThrow('Too many decimal places (max 0)');
    expect(() => parseUnits('0.0000000000000000001', 18)).toThrow('max 18');
  });

  it.each(['', ' ', '.', 'abc', '-1', '+1', '1e18', '1,000', '1.2.3', '0x10', 'NaN', 'Infinity', '1 000', '١'])(
    'rejects invalid input %j',
    (value) => {
      expect(() => parseUnits(value, 18)).toThrow('Invalid amount');
    },
  );
});

describe('formatUnits', () => {
  it.each([
    [0n, 18, '0'],
    [0n, 0, '0'],
    [1n, 18, '0.000000000000000001'],
    [10n ** 18n, 18, '1'],
    [1_500_000n, 6, '1.5'],
    [123n, 2, '1.23'],
    [100n, 0, '100'],
    [120n, 2, '1.2'],
    ['1000000', 6, '1'],
    [-1n, 18, '-0.000000000000000001'],
    [-1_500_000n, 6, '-1.5'],
    ['-250', 2, '-2.5'],
  ])('formatUnits(%s, %i) = %s', (value, decimals, expected) => {
    expect(formatUnits(value, decimals)).toBe(expected);
  });

  it('round-trips with parseUnits', () => {
    for (const [v, d] of [
      ['1.5', 6],
      ['0.000000000000000001', 18],
      ['123456.789', 9],
      ['42', 0],
    ] as const) {
      expect(formatUnits(parseUnits(v, d), d)).toBe(v);
    }
  });
});

describe('formatAmount', () => {
  it('adds thousands separators', () => {
    expect(formatAmount(1_234_567n * 10n ** 18n, 18)).toBe('1,234,567');
    expect(formatAmount(1234567890000000000000n, 18)).toBe('1,234.56789');
    expect(formatAmount(1234567n, 0)).toBe('1,234,567');
    expect(formatAmount(999n, 0)).toBe('999');
  });

  it('formats zero', () => {
    expect(formatAmount(0n, 18)).toBe('0');
    expect(formatAmount('0', 6)).toBe('0');
  });

  it('truncates to maxFrac and trims trailing zeros', () => {
    expect(formatAmount(1_123_456_789n, 9)).toBe('1.123456');
    expect(formatAmount(1_123_456_789n, 9, 2)).toBe('1.12');
    expect(formatAmount(1_100_000n, 6)).toBe('1.1');
    expect(formatAmount(1_000_000_1n, 7, 6)).toBe('1'); // 1.0000001 → fractional part beyond maxFrac dropped
    expect(formatAmount(1_000_001n, 6)).toBe('1.000001');
  });

  it('shows significant digits for tiny non-zero values instead of 0', () => {
    expect(formatAmount(1n, 18)).toBe('0.000000000000000001'); // 1 wei
    expect(formatAmount(1234n, 18)).toBe('0.0000000000000012');
    expect(formatAmount(1234n, 10)).toBe('0.00000012');
    expect(formatAmount(1200n, 10)).toBe('0.00000012');
    expect(formatAmount(1000n, 10)).toBe('0.0000001');
    expect(formatAmount(1234n, 6)).toBe('0.001234');
  });

  it('handles negatives', () => {
    expect(formatAmount(-1_500_000n, 6)).toBe('-1.5');
    expect(formatAmount(-1_234_567n * 10n ** 6n, 6)).toBe('-1,234,567');
    expect(formatAmount(-1n, 18)).toBe('-0.000000000000000001');
  });
});

describe('formatUsd', () => {
  it('formats currency values', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(1)).toBe('$1.00');
    expect(formatUsd(1234.5)).toBe('$1,234.50');
    expect(formatUsd(0.01)).toBe('$0.01');
    expect(formatUsd(1234567.891)).toBe('$1,234,567.89');
  });

  it('shows <$0.01 for tiny positive values', () => {
    expect(formatUsd(0.009)).toBe('<$0.01');
    expect(formatUsd(1e-12)).toBe('<$0.01');
  });

  it('handles negatives', () => {
    expect(formatUsd(-5)).toBe('-$5.00');
  });

  it('shows a dash for missing or non-finite values', () => {
    expect(formatUsd(undefined)).toBe('—');
    expect(formatUsd(NaN)).toBe('—');
    expect(formatUsd(Infinity)).toBe('—');
    expect(formatUsd(-Infinity)).toBe('—');
  });
});

describe('shortAddress', () => {
  it('shortens EVM addresses keeping the 0x prefix', () => {
    expect(shortAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')).toBe('0xf39F…2266');
    expect(shortAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', 6)).toBe('0xf39Fd6…b92266');
  });

  it('shortens Solana addresses', () => {
    expect(shortAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe('EPjF…Dt1v');
  });

  it('leaves short or empty strings untouched', () => {
    expect(shortAddress('')).toBe('');
    expect(shortAddress('abc')).toBe('abc');
    expect(shortAddress('0x12345678901')).toBe('0x12345678901'); // 13 chars: at threshold
    expect(shortAddress('0x123456789012')).toBe('0x1234…9012'); // 14 chars
    expect(shortAddress('12345678901')).toBe('12345678901'); // 11 chars: at threshold
    expect(shortAddress('123456789012')).toBe('1234…9012');
  });
});

describe('toUsd', () => {
  it('converts base units to USD', () => {
    expect(toUsd(1_500_000n, 6, 2)).toBe(3);
    expect(toUsd('2000000000000000000', 18, 2500)).toBe(5000);
    expect(toUsd(0n, 18, 2500)).toBe(0);
    expect(toUsd(10n ** 18n, 18, 0)).toBe(0);
  });

  it('returns undefined when the price is unknown', () => {
    expect(toUsd(1n, 18)).toBeUndefined();
    expect(toUsd(1n, 18, undefined)).toBeUndefined();
  });
});
