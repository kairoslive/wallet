import type { Network, Token } from './types';

type Def = [address: string, symbol: string, name: string, decimals: number];

const LISTS: Record<string, Def[]> = {
  eth: [
    ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'USDC', 'USD Coin', 6],
    ['0xdAC17F958D2ee523a2206206994597C13D831ec7', 'USDT', 'Tether USD', 6],
    ['0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 'WETH', 'Wrapped Ether', 18],
    ['0x6B175474E89094C44Da98b954EedeAC495271d0F', 'DAI', 'Dai Stablecoin', 18],
  ],
  base: [
    ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'USDC', 'USD Coin', 6],
    ['0x4200000000000000000000000000000000000006', 'WETH', 'Wrapped Ether', 18],
  ],
  arbitrum: [
    ['0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 'USDC', 'USD Coin', 6],
    ['0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 'USDT', 'Tether USD', 6],
    ['0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 'WETH', 'Wrapped Ether', 18],
  ],
  optimism: [
    ['0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 'USDC', 'USD Coin', 6],
    ['0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', 'USDT', 'Tether USD', 6],
    ['0x4200000000000000000000000000000000000006', 'WETH', 'Wrapped Ether', 18],
  ],
  polygon: [
    ['0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 'USDC', 'USD Coin', 6],
    ['0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 'USDT', 'Tether USD', 6],
  ],
  bsc: [
    ['0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 'USDC', 'USD Coin', 18],
    ['0x55d398326f99059fF775485246999027B3197955', 'USDT', 'Tether USD', 18],
  ],
  avalanche: [
    ['0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', 'USDC', 'USD Coin', 6],
    ['0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', 'USDT', 'Tether USD', 6],
  ],
  solana: [
    ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDC', 'USD Coin', 6],
    ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'USDT', 'Tether USD', 6],
    ['JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 'JUP', 'Jupiter', 6],
  ],
  sepolia: [['0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', 'USDC', 'USD Coin', 6]],
  'solana-devnet': [['4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', 'USDC', 'USD Coin (Devnet)', 6]],
};

export function nativeToken(network: Network): Token {
  return {
    networkId: network.id,
    address: 'native',
    symbol: network.nativeCurrency.symbol,
    name: network.nativeCurrency.name,
    decimals: network.nativeCurrency.decimals,
  };
}

export function defaultTokens(networkId: string): Token[] {
  return (LISTS[networkId] ?? []).map(([address, symbol, name, decimals]) => ({
    networkId,
    address,
    symbol,
    name,
    decimals,
  }));
}

export function tokenKey(t: Pick<Token, 'networkId' | 'address'>): string {
  return `${t.networkId}:${t.address === 'native' ? 'native' : t.address.toLowerCase()}`;
}

/** Merges token lists, de-duplicating by network + address (first wins). */
export function mergeTokens(...lists: Token[][]): Token[] {
  const seen = new Map<string, Token>();
  for (const list of lists) for (const t of list) if (!seen.has(tokenKey(t))) seen.set(tokenKey(t), t);
  return [...seen.values()];
}
