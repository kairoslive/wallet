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
  /** The venue's taker fee on a buy, where market data publishes it. */
  fee?: FeeModel;
}

/**
 * A venue's taker fee per share at price p, as market data publishes it:
 * - `curve` (Polymarket): `rate × (p × (1 − p))^exponent`, paid on top in collateral.
 * - `min` (Predict.fun): `rate × min(p, 1 − p)`, taken out of the shares received.
 */
export type FeeModel = { kind: 'curve'; rate: number; exponent: number } | { kind: 'min'; rate: number };

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

/**
 * Kairos' smart order routing: one buy split across every venue the market is linked to, cheapest
 * first. Each leg is an ordinary venue order the wallet signs on its own.
 */
export interface RoutedOrderInput {
  /** Any linked venue's market, as in an order. */
  market: string;
  /** `Yes`/`No` or any linked venue's own name for that side. */
  outcome: string;
  /** Shares to receive in total, across venues. */
  size: string;
  /** Highest price per share any leg may cost, venue fees included (0–1). */
  maxPrice?: string;
  timeInForce?: 'FAK' | 'IOC';
  clientOrderId?: string;
}

export type Action =
  | { type: 'login' }
  | { type: 'setup'; venues?: Venue[] }
  | ({ type: 'order' } & OrderInput)
  | ({ type: 'routedOrder' } & RoutedOrderInput)
  | { type: 'cancel'; orderIds: string[] }
  | { type: 'cancel'; all: true };

/** A routed order's plan, as Kairos sends it on every step (decimal strings). */
export interface WalletRoute {
  linkTitle?: string;
  requested?: string;
  planned?: string;
  unfilled?: string;
  blendedEffective?: string | null;
  stop?: string;
  legs: {
    venue: Venue;
    market: string;
    outcome: string;
    /** The leg's limit price. */
    price: string;
    size: string;
    delivered?: string;
    estCost?: string;
    estFee?: string;
    effectiveLimit?: string;
    timeInForce?: string;
    clientOrderId?: string | null;
  }[];
  notes?: string[];
}

export interface RoutedOrderResult extends WalletRoute {
  routed: true;
  placed: number;
  failed: number;
  unknown?: number;
  legs: (WalletRoute['legs'][number] & {
    status: 'placed' | 'failed' | 'unknown' | 'skipped';
    orderId?: string;
    orderStatus?: string;
    order?: OrderResult;
    error?: string;
    errorCode?: string;
  })[];
}

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
  /** The action type; a routed order's steps say `routed_order`. */
  type: Action['type'] | 'routed_order';
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
  /** On `failed`: e.g. `NO_MATCH` (nothing placed) or `ORDER_OUTCOME_UNKNOWN` (it may be live). */
  errorCode?: string | null;
  /** Routed orders: the plan, and which venue order this step asks for. */
  route?: WalletRoute;
  leg?: { index: number; of: number };
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
  /** Shares matched; null while not known yet. */
  filledSize?: string | null;
  avgPrice?: string | null;
  /** true: matching is over, nothing rests. false: it rests, or fills are still confirming. */
  final?: boolean;
  /** false when it ended without doing anything or isn't confirmed yet (`message` says why). */
  success?: boolean;
  message?: string | null;
}

/** One OHLC bucket of a market's price, 0–1. */
export interface Candle {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Where a market's resolution stands. CTF venues go through an optimistic oracle: an answer is
 * proposed, can be disputed during a challenge window, then settles with payouts per outcome.
 */
export interface Resolution {
  /** Venue-reported stage, e.g. initialized, proposed, disputed, resolved. */
  status: string;
  /** Proposed answer as a Yes fraction (1 = first outcome, 0 = second, 0.5 = split). */
  proposedPrice?: number;
  proposedAt?: string;
  challengeEndsAt?: string;
  disputes: number;
  resolvedAt?: string;
  /** Payout fraction per outcome, in outcome order, once resolved. */
  payouts?: number[];
}

export interface ResolutionEvent {
  type: string;
  at: string;
}

/** The market's written rules, from the data API's metadata. */
export interface MarketRules {
  description?: string;
  /** Delay before a taker order matches (ms), where the venue holds orders briefly. */
  matchDelayMs?: number;
}

/** A search result, one tradeable market. */
export interface SearchHit {
  /** Market key (see venues.ts). */
  marketId: string;
  venue: Venue;
  title: string;
  eventTitle?: string;
  /** Label of this market within its event, e.g. "80,000 to 84,999". */
  label?: string;
  image?: string;
  category?: string;
  /** Yes price, 0–1. */
  price?: number;
  volume24h?: number;
  endsAt?: string;
  status?: string;
  outcomes?: string[];
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
