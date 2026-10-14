import type { Token } from '../types';

export interface QuoteRequest {
  fromNetworkId: string;
  toNetworkId: string;
  fromToken: Token;
  toToken: Token;
  /** Base units. */
  fromAmount: string;
  fromAddress: string;
  toAddress: string;
  slippageBps: number;
}

export interface SwapQuote {
  id: string;
  provider: 'lifi' | 'jupiter';
  request: QuoteRequest;
  toAmount: string;
  toAmountMin: string;
  /** Display name of the route's bridge/DEX. */
  tool?: string;
  /** Provider's machine id for the tool (LI.FI status lookups need it). */
  toolKey?: string;
  toolLogo?: string;
  durationSec?: number;
  feeUsd?: number;
  gasUsd?: number;
  fromAmountUsd?: number;
  toAmountUsd?: number;
  priceImpactPct?: number;
  /** ERC-20 approval required before the swap tx. */
  approval?: { token: string; spender: string; amount: string };
  evmTx?: { to: string; data: string; value: string; gas?: string; chainId?: number };
  /** Base64 serialized Solana transaction. */
  solanaTx?: string;
  /** Provider-specific data needed at execution time. */
  raw?: unknown;
  createdAt: number;
}

export interface BridgeStatus {
  status: 'PENDING' | 'DONE' | 'FAILED' | 'NOT_FOUND' | 'INVALID';
  substatus?: string;
  substatusMessage?: string;
  receivingTxHash?: string;
}

export interface ListedToken {
  chainId: number;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  priceUSD?: string;
}
