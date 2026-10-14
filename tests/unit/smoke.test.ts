import { describe, expect, it } from 'vitest';
import { deriveAddresses } from '../../src/core/keyring/derive';

describe('smoke', () => {
  it('derives the well-known anvil account', () => {
    const { evmAddress } = deriveAddresses('test test test test test test test test test test test junk', 0);
    expect(evmAddress).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  });
});
