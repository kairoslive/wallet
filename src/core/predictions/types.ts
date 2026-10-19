/** Prediction markets via Kairos: Polymarket (pUSD on Polygon) and Predict.fun (USDT on BNB Chain). */

import type { Venue } from './venues';

export interface PredictionOutcome {
  /** Market key: the Polymarket id, or `venue:market_id` on other venues (see venues.ts). */
  marketId: string;
  conditionId: string;
  /** Full question, e.g. "Will Bitcoin reach $85,000 on October 14?". */
  title: string;
  /** Short label within a grouped event, e.g. "↑ 85,000". */
  label?: string;
  /** Last "Yes" price, 0–1. */
  price?: number;
  volume24h?: number;
}

export interface PredictionEvent {
  id: string;
  venue: Venue;
  title: string;
  image?: string;
  category?: string;
  volume24h?: number;
  expiration?: string;
  /** One entry for a simple Yes/No market; several for grouped events. */
  outcomes: PredictionOutcome[];
  /** A simple market's two outcomes when they aren't Yes and No, e.g. two teams. */
  sides?: [string, string];
}

export interface MarketToken {
  /** Outcome name the venue uses, e.g. "Yes". */
  outcome: string;
  tokenId: string;
  price?: number;
}

export interface MarketDetail {
  /** Market key (see venues.ts). */
  marketId: string;
  venue: Venue;
  /** The venue's own market id. */
  venueMarketId: string;
  conditionId: string;
  title: string;
  /** Event title for grouped markets ("Fed Decision in October?"). */
  eventTitle?: string;
  image?: string;
  category?: string;
  endDate?: string;
  status: string;
  tickSize: number;
  negRisk: boolean;
  tokens: MarketToken[];
}

export interface PricePoint {
  t: number;
  /** 0–1. */
  price: number;
}

export type Side = 'buy' | 'sell';
export type TimeInForce = 'GTC' | 'GTD' | 'FOK' | 'FAK' | 'IOC';

export interface OrderInput {
  /** `venue:market_id`, or a bare Polymarket condition id. */
  market: string;
  outcome: string;
  side: Side;
  /** 0–1, as a decimal string. */
  price: string;
  /** Shares, as a decimal string. */
  size: string;
  timeInForce?: TimeInForce;
  postOnly?: boolean;
  clientOrderId?: string;
}

export type Action =
  | { type: 'login' }
  | { type: 'setup'; venues?: Venue[] }
  | ({ type: 'order' } & OrderInput)
  | { type: 'cancel'; orderIds: string[] }
  | { type: 'cancel'; all: true };

/** What a `login` action returns: a read-only token for one wallet's orders and positions. */
export interface WalletCredentials {
  /** Sent as `Authorization: SIWE <token>`. */
  token: string;
  /** ISO time after which the token stops working (24 hours). */
  expiresAt: string;
}

export type StepStatus = 'needs_signature' | 'working' | 'done' | 'failed';

export interface Eip1193Request {
  method: string;
  params: unknown[];
}

export interface Step<R = unknown> {
  id: string;
  type: Action['type'];
  status: StepStatus;
  /** A signature to make, or (approvals) transactions the wallet sends itself. */
  request: Eip1193Request | null;
  description: string | null;
  /** The chain `request` is for (EIP-155 hex), or null for any chain. */
  chainId?: string | null;
  venue?: Venue | null;
  /** For a `wallet_sendCalls` request: the same calls as one transaction each. */
  fallbackRequests?: Eip1193Request[];
  result: R | null;
  error: string | null;
}

export type VenueNext = 'setup' | 'wait' | 'fund' | 'blocked' | null;

/** Where the wallet stands on one venue. */
export interface VenueStatus {
  ready: boolean;
  /** `wait`: approvals already sent are confirming. `blocked`: this venue account can't be used (`venueDetail.reason`). */
  next: VenueNext;
  /** Where this venue's collateral goes. Predict.fun trades from the wallet itself. */
  tradingWallet?: string;
  /** Collateral in whole units of `currency`. */
  balance: string | null;
  currency?: string;
  error?: string;
  /**
   * Venue specifics, e.g. Predict.fun's `gasBalance` (BNB) and `missingApprovals`, or Hyperliquid's
   * `transferFromPerps` (perps USDC the next order can move to spot).
   */
  venueDetail?: Record<string, unknown>;
}

/**
 * The wallet's trading status. The top-level fields describe Polymarket, as they always have; a
 * multi-venue node also reports every venue under `venues`.
 */
export interface TradingStatus {
  wallet: string;
  /** Polymarket deposit wallet. */
  tradingWallet: string;
  ready: boolean;
  /** pUSD balance of the trading wallet. */
  balance: string | null;
  next: VenueNext;
  venues?: Partial<Record<Venue, VenueStatus>>;
}

export interface SetupResult {
  ready: boolean;
  tradingWallet?: string;
  transactionHash?: string | null;
  venues?: Partial<Record<Venue, { ready: boolean; tradingWallet?: string; next?: VenueNext }>>;
}

export interface OrderResult {
  orderId: string;
  status: string;
  venueOrderId: string | null;
  venue?: Venue;
  market?: string;
}

export interface CancelResult {
  cancelled: string[];
  alreadyClosed?: string[];
  failed: { orderId: string; reason: string }[] | number;
}

/** Orders and positions come back loosely typed from the API; the UI reads known fields defensively. */
export type ApiRecord = Record<string, unknown>;

export interface KairosConfig {
  executionUrl: string;
  dataUrl: string;
  marketDataUrl: string;
  partnerId: string;
}
