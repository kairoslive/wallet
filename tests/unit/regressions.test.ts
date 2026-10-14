import { describe, expect, it } from 'vitest';
import { isValidEvmAddress } from '../../src/core/address';
import { parseUnits } from '../../src/core/format';
import { tokenKey } from '../../src/core/tokens';

describe('review fixes', () => {
  it('rejects mixed-case EVM addresses with a bad checksum', () => {
    expect(isValidEvmAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')).toBe(true);
    expect(isValidEvmAddress('0xF39fd6e51aad88F6F4ce6aB8827279cffFb92266')).toBe(false);
  });

  it('accepts trailing zeros beyond the token decimals', () => {
    expect(parseUnits('1.5000000', 6)).toBe(1_500_000n);
    expect(() => parseUnits('1.0000001', 6)).toThrow('Too many decimal places');
  });

  it('keeps Solana mint case in token keys', () => {
    expect(tokenKey({ networkId: 'solana', address: 'AbC' })).not.toBe(tokenKey({ networkId: 'solana', address: 'abc' }));
    expect(tokenKey({ networkId: 'eth', address: '0xAbC' })).toBe(tokenKey({ networkId: 'eth', address: '0xabc' }));
  });
});
