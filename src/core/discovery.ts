import { getJson, joinUrl, type Fetch } from './http';
import type { EvmNetwork, Token } from './types';

interface BlockscoutTokenBalance {
  value: string;
  token: {
    address?: string;
    address_hash?: string;
    symbol: string | null;
    name: string | null;
    decimals: string | null;
    type: string;
    icon_url?: string | null;
    exchange_rate?: string | null;
  };
}

/**
 * Discovers ERC-20 holdings via Blockscout. Only tokens with a market price are returned,
 * which filters out most airdropped spam.
 */
export async function discoverEvmTokens(
  network: EvmNetwork,
  owner: string,
  fetchFn: Fetch = fetch,
): Promise<{ token: Token; balance: bigint }[]> {
  if (network.history.kind !== 'blockscout') return [];
  const items = await getJson<BlockscoutTokenBalance[]>(
    joinUrl(network.history.url, `api/v2/addresses/${owner}/token-balances`),
    {},
    fetchFn,
  );
  return (Array.isArray(items) ? items : [])
    .filter((i) => i.token.type === 'ERC-20' && i.token.exchange_rate && i.token.symbol && i.token.decimals !== null)
    .map((i) => ({
      token: {
        networkId: network.id,
        address: (i.token.address_hash ?? i.token.address)!,
        symbol: i.token.symbol!,
        name: i.token.name ?? i.token.symbol!,
        decimals: Number(i.token.decimals),
        logoURI: i.token.icon_url ?? undefined,
      },
      balance: BigInt(i.value),
    }));
}

interface JupToken {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
  icon?: string;
}

/** Looks up Solana token metadata (symbol/name/logo) for a batch of mints using Jupiter's token API. */
export async function fetchSolanaTokenMeta(
  jupiterUrl: string,
  mints: string[],
  fetchFn: Fetch = fetch,
  apiKey?: string,
): Promise<Map<string, Omit<Token, 'networkId'>>> {
  const out = new Map<string, Omit<Token, 'networkId'>>();
  for (let i = 0; i < mints.length; i += 50) {
    const chunk = mints.slice(i, i + 50);
    const res = await getJson<JupToken[]>(
      joinUrl(jupiterUrl, `tokens/v2/search?query=${chunk.join(',')}`),
      { headers: apiKey ? { 'x-api-key': apiKey } : {} },
      fetchFn,
    );
    for (const t of Array.isArray(res) ? res : []) {
      out.set(t.id, { address: t.id, symbol: t.symbol, name: t.name, decimals: t.decimals, logoURI: t.icon });
    }
  }
  return out;
}
