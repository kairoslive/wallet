import { getJson, joinUrl, type Fetch } from './http';
import type { Network, Token } from './types';

/** Returns the DefiLlama coin key for a token, or undefined if it can't be priced. */
export function priceKey(network: Network, token: Pick<Token, 'address'>): string | undefined {
  if (token.address === 'native') return network.nativePriceId;
  if (!network.priceChain) return undefined;
  const addr = network.type === 'evm' ? token.address.toLowerCase() : token.address;
  return `${network.priceChain}:${addr}`;
}

/** Fetches USD prices for a set of DefiLlama keys. Missing keys are omitted. */
export async function fetchPrices(pricesUrl: string, keys: string[], fetchFn: Fetch = fetch): Promise<Record<string, number>> {
  const unique = [...new Set(keys)].filter(Boolean);
  const out: Record<string, number> = {};
  for (let i = 0; i < unique.length; i += 80) {
    const chunk = unique.slice(i, i + 80);
    const res = await getJson<{ coins: Record<string, { price: number }> }>(
      joinUrl(pricesUrl, `prices/current/${chunk.map(encodeURIComponent).join(',')}`),
      {},
      fetchFn,
    );
    for (const [k, v] of Object.entries(res.coins ?? {})) {
      // DefiLlama lowercases EVM addresses in keys but preserves Solana mints.
      out[k] = v.price;
      out[k.toLowerCase()] = v.price;
    }
  }
  return out;
}

export function lookupPrice(prices: Record<string, number>, key?: string): number | undefined {
  if (!key) return undefined;
  return prices[key] ?? prices[key.toLowerCase()];
}
