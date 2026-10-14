import { describe, expect, it } from 'vitest';
import { DEFAULT_NETWORKS } from '../../src/core/networks';
import { fetchPrices, lookupPrice, priceKey } from '../../src/core/prices';
import type { EvmNetwork, Network } from '../../src/core/types';
import { json, mockFetch } from './helpers/mockFetch';

const net = (id: string) => DEFAULT_NETWORKS.find((n) => n.id === id)!;
const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const LLAMA = 'https://coins.llama.fi';

describe('priceKey', () => {
  it('uses nativePriceId for native tokens', () => {
    expect(priceKey(net('eth'), { address: 'native' })).toBe('coingecko:ethereum');
    expect(priceKey(net('base'), { address: 'native' })).toBe('coingecko:ethereum');
    expect(priceKey(net('solana'), { address: 'native' })).toBe('coingecko:solana');
    expect(priceKey(net('polygon'), { address: 'native' })).toBe('coingecko:polygon-ecosystem-token');
  });

  it('is undefined for natives without a price id (testnets)', () => {
    expect(priceKey(net('sepolia'), { address: 'native' })).toBeUndefined();
    expect(priceKey(net('solana-devnet'), { address: 'native' })).toBeUndefined();
  });

  it('lowercases EVM token addresses', () => {
    expect(priceKey(net('eth'), { address: USDC_ETH })).toBe(`ethereum:${USDC_ETH.toLowerCase()}`);
    expect(priceKey(net('avalanche'), { address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E' })).toBe(
      'avax:0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e',
    );
  });

  it('preserves Solana mint case', () => {
    expect(priceKey(net('solana'), { address: USDC_SOL })).toBe(`solana:${USDC_SOL}`);
  });

  it('is undefined for tokens on networks without a price chain', () => {
    expect(priceKey(net('sepolia'), { address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' })).toBeUndefined();
    const custom: EvmNetwork = { ...(net('eth') as EvmNetwork), id: 'x', priceChain: undefined };
    expect(priceKey(custom, { address: USDC_ETH })).toBeUndefined();
  });
});

describe('fetchPrices', () => {
  it('requests DefiLlama current prices and maps results', async () => {
    const f = mockFetch(() => ({
      coins: {
        'coingecko:ethereum': { price: 2500.5, symbol: 'ETH' },
        [`solana:${USDC_SOL}`]: { price: 1 },
      },
    }));
    const out = await fetchPrices(`${LLAMA}/`, ['coingecko:ethereum', `solana:${USDC_SOL}`], f);
    expect(f.calls).toHaveLength(1);
    const u = new URL(f.calls[0].url);
    expect(u.origin + u.pathname.split('/').slice(0, 3).join('/')).toBe(`${LLAMA}/prices/current`);
    const requested = decodeURIComponent(u.pathname.slice('/prices/current/'.length)).split(',');
    expect(requested).toEqual(['coingecko:ethereum', `solana:${USDC_SOL}`]);
    expect(out['coingecko:ethereum']).toBe(2500.5);
    expect(lookupPrice(out, `solana:${USDC_SOL}`)).toBe(1);
  });

  it('stores both the original and lowercased key', async () => {
    const f = mockFetch(() => ({ coins: { [`ethereum:${USDC_ETH}`]: { price: 0.9999 } } }));
    const out = await fetchPrices(LLAMA, [`ethereum:${USDC_ETH.toLowerCase()}`], f);
    expect(out[`ethereum:${USDC_ETH}`]).toBe(0.9999);
    expect(out[`ethereum:${USDC_ETH.toLowerCase()}`]).toBe(0.9999);
    // Our priceKey (lowercased EVM) finds it.
    expect(lookupPrice(out, priceKey(net('eth'), { address: USDC_ETH }))).toBe(0.9999);
  });

  it('chunks requests at 80 keys and de-duplicates/filters keys', async () => {
    const keys = Array.from({ length: 170 }, (_, i) => `ethereum:0x${i.toString(16).padStart(40, '0')}`);
    const f = mockFetch((url) => {
      const requested = decodeURIComponent(url.pathname.slice('/prices/current/'.length)).split(',');
      return { coins: Object.fromEntries(requested.map((k, i) => [k, { price: i + 1 }])) };
    });
    const out = await fetchPrices(LLAMA, [...keys, ...keys.slice(0, 10), ''], f);
    expect(f.calls).toHaveLength(3);
    const sizes = f.calls.map((c) => decodeURIComponent(new URL(c.url).pathname).split('/').at(-1)!.split(',').length);
    expect(sizes).toEqual([80, 80, 10]);
    const all = f.calls.flatMap((c) => decodeURIComponent(new URL(c.url).pathname).split('/').at(-1)!.split(','));
    expect(new Set(all).size).toBe(170);
    expect(all).not.toContain('');
    for (const k of keys) expect(out[k]).toBeTypeOf('number');
  });

  it('makes no request for an empty key list', async () => {
    const f = mockFetch(() => ({ coins: {} }));
    expect(await fetchPrices(LLAMA, [], f)).toEqual({});
    expect(await fetchPrices(LLAMA, ['', ''], f)).toEqual({});
    expect(f.calls).toHaveLength(0);
  });

  it('tolerates a missing coins field and omits unknown keys', async () => {
    const f = mockFetch(() => ({}));
    expect(await fetchPrices(LLAMA, ['coingecko:nope'], f)).toEqual({});
  });

  it('propagates HTTP errors', async () => {
    const f = mockFetch(() => json({ message: 'down' }, 503, 'Service Unavailable'));
    await expect(fetchPrices(LLAMA, ['coingecko:ethereum'], f)).rejects.toThrow('down');
  });
});

describe('lookupPrice', () => {
  const prices = { 'coingecko:ethereum': 2000, 'ethereum:0xabc': 1, [`solana:${USDC_SOL}`]: 1.001 };

  it('looks up exact then lowercased keys', () => {
    expect(lookupPrice(prices, 'coingecko:ethereum')).toBe(2000);
    expect(lookupPrice(prices, 'ethereum:0xABC')).toBe(1);
    expect(lookupPrice(prices, `solana:${USDC_SOL}`)).toBe(1.001);
  });

  it('returns undefined for missing or empty keys', () => {
    expect(lookupPrice(prices, undefined)).toBeUndefined();
    expect(lookupPrice(prices, '')).toBeUndefined();
    expect(lookupPrice(prices, 'coingecko:nope')).toBeUndefined();
  });

  it('returns a zero price rather than undefined', () => {
    expect(lookupPrice({ k: 0 }, 'k')).toBe(0);
  });

  it('works with priceKey for every default network native', () => {
    const p = { 'coingecko:ethereum': 1, 'coingecko:solana': 2 };
    const n: Network = net('arbitrum');
    expect(lookupPrice(p, priceKey(n, { address: 'native' }))).toBe(1);
  });
});
