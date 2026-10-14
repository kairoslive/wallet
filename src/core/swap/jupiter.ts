import { getJson, joinUrl, type Fetch } from '../http';
import type { QuoteRequest, SwapQuote } from './types';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export interface JupiterConfig {
  url: string;
  apiKey?: string;
  fetchFn?: Fetch;
}

interface JupQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct?: string;
  routePlan?: { swapInfo?: { label?: string } }[];
}

const mint = (address: string) => (address === 'native' ? WSOL_MINT : address);

function headers(cfg: JupiterConfig): Record<string, string> {
  return cfg.apiKey ? { 'x-api-key': cfg.apiKey } : {};
}

export async function getJupiterQuote(cfg: JupiterConfig, req: QuoteRequest): Promise<SwapQuote> {
  const params = new URLSearchParams({
    inputMint: mint(req.fromToken.address),
    outputMint: mint(req.toToken.address),
    amount: req.fromAmount,
    slippageBps: String(req.slippageBps),
  });
  const q = await getJson<JupQuote>(joinUrl(cfg.url, `swap/v1/quote?${params}`), { headers: headers(cfg) }, cfg.fetchFn);
  const labels = [...new Set((q.routePlan ?? []).map((r) => r.swapInfo?.label).filter(Boolean))];
  return {
    id: `jup-${Date.now()}`,
    provider: 'jupiter',
    request: req,
    toAmount: q.outAmount,
    toAmountMin: q.otherAmountThreshold,
    tool: labels.length ? `Jupiter (${labels.join(', ')})` : 'Jupiter',
    priceImpactPct: q.priceImpactPct ? Number(q.priceImpactPct) * 100 : undefined,
    raw: q,
    createdAt: Date.now(),
  };
}

/** Asks Jupiter to build the swap transaction for a previously fetched quote. */
export async function buildJupiterSwapTx(cfg: JupiterConfig, quote: SwapQuote): Promise<string> {
  const r = await getJson<{ swapTransaction: string }>(
    joinUrl(cfg.url, 'swap/v1/swap'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers(cfg) },
      body: JSON.stringify({
        quoteResponse: quote.raw,
        userPublicKey: quote.request.fromAddress,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }),
    },
    cfg.fetchFn,
  );
  if (!r.swapTransaction) throw new Error('Jupiter did not return a transaction');
  return r.swapTransaction;
}
