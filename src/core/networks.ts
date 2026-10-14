import type { EvmNetwork, Network, SolanaNetwork } from './types';

export const LIFI_SOLANA_CHAIN_ID = 1151111081099710;

const evm = (n: Omit<EvmNetwork, 'type' | 'enabled' | 'testnet' | 'lifiChainId'> & Partial<EvmNetwork>): EvmNetwork => ({
  type: 'evm',
  enabled: true,
  testnet: false,
  lifiChainId: n.testnet ? undefined : n.chainId,
  ...n,
});

const blockscout = (url: string) => ({ kind: 'blockscout' as const, url });
const ETH = { name: 'Ether', symbol: 'ETH', decimals: 18 };

export const DEFAULT_NETWORKS: Network[] = [
  evm({
    id: 'eth',
    name: 'Ethereum',
    chainId: 1,
    rpcUrl: 'https://ethereum-rpc.publicnode.com',
    explorerUrl: 'https://etherscan.io',
    nativeCurrency: ETH,
    nativePriceId: 'coingecko:ethereum',
    priceChain: 'ethereum',
    history: blockscout('https://eth.blockscout.com'),
    color: '#627EEA',
  }),
  evm({
    id: 'base',
    name: 'Base',
    chainId: 8453,
    rpcUrl: 'https://mainnet.base.org',
    explorerUrl: 'https://basescan.org',
    nativeCurrency: ETH,
    nativePriceId: 'coingecko:ethereum',
    priceChain: 'base',
    history: blockscout('https://base.blockscout.com'),
    color: '#0052FF',
  }),
  evm({
    id: 'arbitrum',
    name: 'Arbitrum One',
    chainId: 42161,
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    explorerUrl: 'https://arbiscan.io',
    nativeCurrency: ETH,
    nativePriceId: 'coingecko:ethereum',
    priceChain: 'arbitrum',
    history: blockscout('https://arbitrum.blockscout.com'),
    color: '#28A0F0',
  }),
  evm({
    id: 'optimism',
    name: 'OP Mainnet',
    chainId: 10,
    rpcUrl: 'https://mainnet.optimism.io',
    explorerUrl: 'https://optimistic.etherscan.io',
    nativeCurrency: ETH,
    nativePriceId: 'coingecko:ethereum',
    priceChain: 'optimism',
    history: blockscout('https://optimism.blockscout.com'),
    color: '#FF0420',
  }),
  evm({
    id: 'polygon',
    name: 'Polygon',
    chainId: 137,
    rpcUrl: 'https://polygon-bor-rpc.publicnode.com',
    explorerUrl: 'https://polygonscan.com',
    nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
    nativePriceId: 'coingecko:polygon-ecosystem-token',
    priceChain: 'polygon',
    history: blockscout('https://polygon.blockscout.com'),
    color: '#8247E5',
  }),
  evm({
    id: 'bsc',
    name: 'BNB Chain',
    chainId: 56,
    rpcUrl: 'https://bsc-dataseed.bnbchain.org',
    explorerUrl: 'https://bscscan.com',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    nativePriceId: 'coingecko:binancecoin',
    priceChain: 'bsc',
    history: { kind: 'none' },
    color: '#F0B90B',
  }),
  evm({
    id: 'avalanche',
    name: 'Avalanche C-Chain',
    chainId: 43114,
    rpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
    explorerUrl: 'https://snowtrace.io',
    nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
    nativePriceId: 'coingecko:avalanche-2',
    priceChain: 'avax',
    history: { kind: 'none' },
    color: '#E84142',
  }),
  {
    type: 'solana',
    id: 'solana',
    name: 'Solana',
    cluster: 'mainnet-beta',
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    explorerUrl: 'https://explorer.solana.com',
    nativeCurrency: { name: 'Solana', symbol: 'SOL', decimals: 9 },
    nativePriceId: 'coingecko:solana',
    priceChain: 'solana',
    lifiChainId: LIFI_SOLANA_CHAIN_ID,
    testnet: false,
    enabled: true,
    color: '#9945FF',
  } satisfies SolanaNetwork,
  evm({
    id: 'sepolia',
    name: 'Sepolia',
    chainId: 11155111,
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    explorerUrl: 'https://sepolia.etherscan.io',
    nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
    history: blockscout('https://eth-sepolia.blockscout.com'),
    testnet: true,
    color: '#A0A0A0',
  }),
  evm({
    id: 'base-sepolia',
    name: 'Base Sepolia',
    chainId: 84532,
    rpcUrl: 'https://sepolia.base.org',
    explorerUrl: 'https://sepolia.basescan.org',
    nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
    history: blockscout('https://base-sepolia.blockscout.com'),
    testnet: true,
    color: '#7A9CFF',
  }),
  {
    type: 'solana',
    id: 'solana-devnet',
    name: 'Solana Devnet',
    cluster: 'devnet',
    rpcUrl: 'https://api.devnet.solana.com',
    explorerUrl: 'https://explorer.solana.com',
    nativeCurrency: { name: 'Solana', symbol: 'SOL', decimals: 9 },
    testnet: true,
    enabled: true,
    color: '#C9A2FF',
  } satisfies SolanaNetwork,
];

export function explorerTxUrl(network: Network, hash: string): string {
  if (network.type === 'solana') return `${network.explorerUrl}/tx/${hash}${clusterQuery(network)}`;
  return `${network.explorerUrl.replace(/\/$/, '')}/tx/${hash}`;
}

export function explorerAddressUrl(network: Network, address: string): string {
  if (network.type === 'solana') return `${network.explorerUrl}/address/${address}${clusterQuery(network)}`;
  return `${network.explorerUrl.replace(/\/$/, '')}/address/${address}`;
}

function clusterQuery(n: SolanaNetwork): string {
  if (n.cluster === 'mainnet-beta') return '';
  if (n.cluster === 'custom') return `?cluster=custom&customUrl=${encodeURIComponent(n.rpcUrl)}`;
  return `?cluster=${n.cluster}`;
}

/** Validates a user-supplied network definition, returning a list of problems. */
export function validateNetwork(n: Network, existing: Network[]): string[] {
  const errors: string[] = [];
  if (!n.id || !/^[a-z0-9-]+$/.test(n.id)) errors.push('Id must be lowercase letters, digits or dashes');
  if (!n.name.trim()) errors.push('Name is required');
  if (!/^https?:\/\//.test(n.rpcUrl)) errors.push('RPC URL must start with http:// or https://');
  if (n.explorerUrl && !/^https?:\/\//.test(n.explorerUrl)) errors.push('Explorer URL must start with http(s)://');
  if (!n.nativeCurrency.symbol.trim()) errors.push('Currency symbol is required');
  if (!Number.isInteger(n.nativeCurrency.decimals) || n.nativeCurrency.decimals < 0 || n.nativeCurrency.decimals > 36) {
    errors.push('Decimals must be an integer between 0 and 36');
  }
  if (n.type === 'evm') {
    if (!Number.isInteger(n.chainId) || n.chainId <= 0) errors.push('Chain ID must be a positive integer');
    const dup = existing.find((e) => e.type === 'evm' && e.chainId === n.chainId && e.id !== n.id);
    if (dup) errors.push(`Chain ID ${n.chainId} is already used by ${dup.name}`);
  }
  return errors;
}
