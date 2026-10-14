export type ChainType = 'evm' | 'solana';

export interface NativeCurrency {
  name: string;
  symbol: string;
  decimals: number;
}

export type HistoryProvider =
  { kind: 'blockscout'; url: string } | { kind: 'etherscan'; url: string; apiKey?: string } | { kind: 'none' };

interface NetworkBase {
  /** Stable internal id, e.g. "eth", "base", "solana". */
  id: string;
  name: string;
  rpcUrl: string;
  explorerUrl: string;
  nativeCurrency: NativeCurrency;
  /** DefiLlama price key for the native asset, e.g. "coingecko:ethereum". */
  nativePriceId?: string;
  /** DefiLlama chain slug used for token prices, e.g. "ethereum", "base", "solana". */
  priceChain?: string;
  /** Chain id understood by LI.FI (swaps & bridges). Undefined = unsupported. */
  lifiChainId?: number;
  testnet: boolean;
  enabled: boolean;
  custom?: boolean;
  color?: string;
}

export interface EvmNetwork extends NetworkBase {
  type: 'evm';
  chainId: number;
  history: HistoryProvider;
}

export interface SolanaNetwork extends NetworkBase {
  type: 'solana';
  cluster: 'mainnet-beta' | 'devnet' | 'testnet' | 'custom';
}

export type Network = EvmNetwork | SolanaNetwork;

/** "native" for the chain's native coin, otherwise contract (EVM) or mint (Solana) address. */
export type TokenAddress = 'native' | string;

export interface Token {
  networkId: string;
  address: TokenAddress;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  custom?: boolean;
}

export interface TokenBalance extends Token {
  /** Raw amount in base units, as a decimal string. */
  balance: string;
  priceUsd?: number;
  valueUsd?: number;
}

export interface SeedMeta {
  id: string;
  name: string;
  createdAt: number;
  /** Next unused derivation index. */
  nextIndex: number;
  /** True if the user created it in-wallet and has not yet confirmed backup. */
  backedUp: boolean;
}

export interface Account {
  id: string;
  name: string;
  kind: 'seed' | 'privateKey';
  seedId?: string;
  index?: number;
  evmAddress?: string;
  solanaAddress?: string;
  hidden?: boolean;
}

export interface VaultSecrets {
  seeds: { id: string; mnemonic: string }[];
  keys: { accountId: string; chainType: ChainType; privateKey: string }[];
}

export interface ApiSettings {
  lifiUrl: string;
  lifiApiKey?: string;
  lifiIntegrator: string;
  jupiterUrl: string;
  jupiterApiKey?: string;
  /** Which aggregator to use for same-chain Solana swaps. */
  solanaSwapProvider: 'jupiter' | 'lifi';
  pricesUrl: string;
}

export interface Settings {
  networks: Network[];
  /** A network id, or "all" for the aggregated view. */
  selectedNetworkId: string;
  autoLockMinutes: number;
  showTestnets: boolean;
  slippageBps: number;
  apis: ApiSettings;
  hideZeroBalances: boolean;
}

export type TxStatus = 'pending' | 'confirmed' | 'failed';

export interface TxRecord {
  /** Tx hash (EVM) or signature (Solana). */
  hash: string;
  networkId: string;
  chainType: ChainType;
  from: string;
  to?: string;
  /** Human-readable summary, e.g. "Sent 0.1 ETH". */
  title: string;
  direction: 'in' | 'out' | 'self' | 'contract';
  kind: 'send' | 'receive' | 'swap' | 'bridge' | 'approve' | 'contract' | 'dapp';
  amount?: string;
  symbol?: string;
  timestamp: number;
  status: TxStatus;
  fee?: string;
  /** For bridges: tracking info. */
  bridge?: { toNetworkId?: string; tool?: string; status?: string; receivingHash?: string };
  source: 'local' | 'indexer';
}

export interface Contact {
  id: string;
  name: string;
  address: string;
  chainType: ChainType;
  createdAt: number;
}

export interface Permission {
  origin: string;
  /** Account ids the site is allowed to see. */
  accountIds: string[];
  /** Chain families the site connected with; undefined (older data) means both. */
  chains?: ('evm' | 'solana')[];
  evmNetworkId?: string;
  connectedAt: number;
}
