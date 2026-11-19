import type { TradePlanFundingInput } from '@kairos.trade/sdk';

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
