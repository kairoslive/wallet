import { getJson, joinUrl, type Fetch } from '../http';
import type { Network, Token } from '../types';
import type { BridgeStatus, ListedToken, QuoteRequest, SwapQuote } from './types';

export const LIFI_EVM_NATIVE = '0x0000000000000000000000000000000000000000';
export const LIFI_SOL_NATIVE = '11111111111111111111111111111111';

export interface LifiConfig {
  url: string;
  apiKey?: string;
  integrator: string;
  fetchFn?: Fetch;
}

export function lifiTokenAddress(network: Network, token: Pick<Token, 'address'>): string {
  if (token.address !== 'native') return token.address;
  return network.type === 'evm' ? LIFI_EVM_NATIVE : LIFI_SOL_NATIVE;
}

function headers(cfg: LifiConfig): HeadersInit {
  return cfg.apiKey ? { 'x-lifi-api-key': cfg.apiKey } : {};
}

interface LifiQuoteResponse {
  id: string;
  tool: string;
  toolDetails?: { name: string; logoURI?: string };
  action: { fromChainId: number; toChainId: number };
  estimate: {
    approvalAddress?: string;
    toAmount: string;
    toAmountMin: string;
    executionDuration?: number;
    fromAmountUSD?: string;
    toAmountUSD?: string;
    feeCosts?: { amountUSD?: string; included?: boolean }[];
    gasCosts?: { amountUSD?: string }[];
  };
  transactionRequest?: { to?: string; data: string; value?: string; gasLimit?: string; chainId?: number };
}

const sumUsd = (xs?: { amountUSD?: string; included?: boolean }[]) =>
  xs?.length ? xs.filter((x) => !x.included).reduce((a, x) => a + Number(x.amountUSD ?? 0), 0) : undefined;

export async function getLifiQuote(cfg: LifiConfig, from: Network, to: Network, req: QuoteRequest): Promise<SwapQuote> {
  if (!from.lifiChainId || !to.lifiChainId) throw new Error('Swaps and bridges are not supported on this network');
  const params = new URLSearchParams({
    fromChain: String(from.lifiChainId),
    toChain: String(to.lifiChainId),
    fromToken: lifiTokenAddress(from, req.fromToken),
    toToken: lifiTokenAddress(to, req.toToken),
    fromAmount: req.fromAmount,
    fromAddress: req.fromAddress,
    toAddress: req.toAddress,
    slippage: String(req.slippageBps / 10_000),
    integrator: cfg.integrator,
  });
  const q = await getJson<LifiQuoteResponse>(joinUrl(cfg.url, `v1/quote?${params}`), { headers: headers(cfg) }, cfg.fetchFn);
  const tr = q.transactionRequest;
  if (!tr) throw new Error('No transaction returned for this route');
  const quote: SwapQuote = {
    id: q.id,
    provider: 'lifi',
    request: req,
    toAmount: q.estimate.toAmount,
    toAmountMin: q.estimate.toAmountMin,
    tool: q.toolDetails?.name ?? q.tool,
    toolKey: q.tool,
    toolLogo: q.toolDetails?.logoURI,
    durationSec: q.estimate.executionDuration,
    feeUsd: sumUsd(q.estimate.feeCosts),
    gasUsd: sumUsd(q.estimate.gasCosts),
    fromAmountUsd: q.estimate.fromAmountUSD ? Number(q.estimate.fromAmountUSD) : undefined,
    toAmountUsd: q.estimate.toAmountUSD ? Number(q.estimate.toAmountUSD) : undefined,
    createdAt: Date.now(),
  };
  if (from.type === 'evm') {
    quote.evmTx = {
      to: tr.to!,
      data: tr.data,
      value: BigInt(tr.value ?? '0x0').toString(),
      gas: tr.gasLimit ? BigInt(tr.gasLimit).toString() : undefined,
      chainId: tr.chainId,
    };
    if (req.fromToken.address !== 'native' && q.estimate.approvalAddress) {
      quote.approval = { token: req.fromToken.address, spender: q.estimate.approvalAddress, amount: req.fromAmount };
    }
  } else {
    quote.solanaTx = tr.data;
  }
  return quote;
}

export async function getLifiStatus(
  cfg: LifiConfig,
  txHash: string,
  fromChain: number,
  toChain: number,
  bridge?: string,
): Promise<BridgeStatus> {
  const params = new URLSearchParams({ txHash, fromChain: String(fromChain), toChain: String(toChain) });
  if (bridge) params.set('bridge', bridge);
  try {
    const r = await getJson<{
      status: BridgeStatus['status'];
      substatus?: string;
      substatusMessage?: string;
      receiving?: { txHash?: string };
    }>(joinUrl(cfg.url, `v1/status?${params}`), { headers: headers(cfg) }, cfg.fetchFn);
    return {
      status: r.status,
      substatus: r.substatus,
      substatusMessage: r.substatusMessage,
      receivingTxHash: r.receiving?.txHash,
    };
  } catch (e) {
    if ((e as { status?: number }).status === 404) return { status: 'NOT_FOUND' };
    throw e;
  }
}

export async function listLifiTokens(cfg: LifiConfig, chainIds: number[]): Promise<ListedToken[]> {
  const r = await getJson<{ tokens: Record<string, ListedToken[]> }>(
    joinUrl(cfg.url, `v1/tokens?chains=${chainIds.join(',')}`),
    { headers: headers(cfg) },
    cfg.fetchFn,
  );
  return Object.values(r.tokens ?? {}).flat();
}
