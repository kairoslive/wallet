import type { TradePlan, TradePlanFundingInput } from '@kairos.trade/sdk';
import { UnsafeSigningRequestError } from './verify';

export type FundingSource = 'arbitrum' | 'polygon';

export const PLAN_FUNDING: Record<FundingSource, Pick<TradePlanFundingInput, 'sourceChainId' | 'sourceToken'>> = {
  arbitrum: { sourceChainId: '42161', sourceToken: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' },
  polygon: { sourceChainId: '137', sourceToken: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359' },
};

export interface FundedBuy {
  marketId: string;
  tokenId: string;
  price: string;
  shares: string;
  funding: { source: FundingSource; maxAmountRaw: string };
}

export type PredictionActivity = { id: string; market: string; createdAt: number } & (
  { kind: 'funded-buy' } | { kind: 'position'; operation: 'split' | 'merge' | 'redeem' }
);

/** A deadline the SDK accepts: whole seconds, floored. */
export function wholeSecond(ms: number): Date {
  if (!Number.isFinite(ms)) throw new Error('Invalid deadline.');
  return new Date(Math.floor(ms / 1000) * 1000);
}

/** Stops a trade plan run once the SDK has verified it, before anything is signed. */
export class PlanReviewed extends Error {}

/** The only typed data a trade plan signs: its authorization, the venue order, and a USDC funding permit. */
export const PLAN_SIGNATURES = new Set([
  'TradePlan',
  'TypedDataSign',
  'Order',
  'PlaceOrder',
  'ReceiveWithAuthorization',
  'MulticallAuthorization',
]);
const PLAN_PURPOSES = new Set(['plan', 'trade', 'funding']);

/** Every request in a plan must be a signature the SDK knows how to check; anything else is refused. */
export function checkPlanRequests(value: unknown): void {
  const plan = value as Partial<TradePlan> | undefined;
  if (!plan || !Array.isArray(plan.requests)) return;
  for (const r of plan.requests) {
    if (!PLAN_PURPOSES.has(String(r.purpose)) || r.kind !== 'signature') {
      throw new UnsafeSigningRequestError(`the plan asks for an unexpected ${String(r.purpose)} request`);
    }
  }
}
