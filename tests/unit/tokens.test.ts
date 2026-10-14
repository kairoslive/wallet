import { describe, expect, it } from 'vitest';
import { DEFAULT_NETWORKS } from '../../src/core/networks';
import { defaultTokens, mergeTokens, nativeToken, tokenKey } from '../../src/core/tokens';
import { isValidAddress, normalizeAddress } from '../../src/core/address';
import type { Token } from '../../src/core/types';

const net = (id: string) => DEFAULT_NETWORKS.find((n) => n.id === id)!;
const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const tok = (networkId: string, address: string, symbol = 'T', extra: Partial<Token> = {}): Token => ({
  networkId,
  address,
  symbol,
  name: symbol,
  decimals: 18,
  ...extra,
});

describe('nativeToken', () => {
  it('builds the native token from network currency', () => {
    expect(nativeToken(net('eth'))).toEqual({ networkId: 'eth', address: 'native', symbol: 'ETH', name: 'Ether', decimals: 18 });
    expect(nativeToken(net('solana'))).toEqual({
      networkId: 'solana',
      address: 'native',
      symbol: 'SOL',
      name: 'Solana',
      decimals: 9,
    });
    expect(nativeToken(net('polygon')).symbol).toBe('POL');
  });
});

describe('defaultTokens', () => {
  it('returns the list for known networks with networkId set', () => {
    const eth = defaultTokens('eth');
    expect(eth.map((t) => t.symbol)).toEqual(['USDC', 'USDT', 'WETH', 'DAI']);
    expect(eth[0]).toEqual({ networkId: 'eth', address: USDC_ETH, symbol: 'USDC', name: 'USD Coin', decimals: 6 });
    expect(defaultTokens('solana').find((t) => t.symbol === 'USDC')?.address).toBe(
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    );
  });

  it('returns an empty list for unknown networks', () => {
    expect(defaultTokens('nope')).toEqual([]);
  });

  it('returns fresh objects each call', () => {
    const a = defaultTokens('eth');
    a[0].symbol = 'MUTATED';
    expect(defaultTokens('eth')[0].symbol).toBe('USDC');
  });

  it('every default token has a valid, canonical address for its chain', () => {
    for (const n of DEFAULT_NETWORKS) {
      for (const t of defaultTokens(n.id)) {
        expect(isValidAddress(n.type, t.address), `${n.id} ${t.symbol}`).toBe(true);
        expect(normalizeAddress(n.type, t.address), `${n.id} ${t.symbol}`).toBe(t.address);
        expect(Number.isInteger(t.decimals)).toBe(true);
      }
    }
  });
});

describe('tokenKey', () => {
  it('combines network and lowercased address', () => {
    expect(tokenKey({ networkId: 'eth', address: USDC_ETH })).toBe(`eth:${USDC_ETH.toLowerCase()}`);
    expect(tokenKey({ networkId: 'eth', address: USDC_ETH.toLowerCase() })).toBe(tokenKey({ networkId: 'eth', address: USDC_ETH }));
    expect(tokenKey({ networkId: 'eth', address: 'native' })).toBe('eth:native');
    expect(tokenKey({ networkId: 'base', address: 'native' })).not.toBe(tokenKey({ networkId: 'eth', address: 'native' }));
  });
});

describe('mergeTokens', () => {
  it('de-duplicates EVM addresses case-insensitively, first wins', () => {
    const a = tok('eth', USDC_ETH, 'USDC');
    const b = tok('eth', USDC_ETH.toLowerCase(), 'USDC-dup', { custom: true });
    const merged = mergeTokens([a], [b]);
    expect(merged).toEqual([a]);
    expect(merged[0]).toBe(a);
  });

  it('keeps the same address on different networks', () => {
    const weth = '0x4200000000000000000000000000000000000006';
    expect(mergeTokens([tok('base', weth)], [tok('optimism', weth)])).toHaveLength(2);
  });

  it('dedupes native tokens and within a single list, preserving order', () => {
    const native = nativeToken(net('eth'));
    const list = [native, tok('eth', '0x1'), { ...native, symbol: 'X' }, tok('eth', '0x2'), tok('eth', '0X1'.toLowerCase())];
    const merged = mergeTokens(list);
    expect(merged.map((t) => t.address)).toEqual(['native', '0x1', '0x2']);
    expect(merged[0].symbol).toBe('ETH');
  });

  it('merges defaults with custom tokens', () => {
    const custom = tok('eth', '0x1111111111111111111111111111111111111111', 'CUS', { custom: true });
    const merged = mergeTokens([nativeToken(net('eth'))], defaultTokens('eth'), [custom, ...defaultTokens('eth')]);
    expect(merged).toHaveLength(6);
    expect(merged.at(-1)).toBe(custom);
  });

  it('handles empty input', () => {
    expect(mergeTokens()).toEqual([]);
    expect(mergeTokens([], [])).toEqual([]);
  });
});
