/** Prediction markets via Kairos (Polymarket venue, settled in pUSD on Polygon). */

export interface PredictionOutcome {
  /** Venue market id (Polymarket numeric id). */
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
  title: string;
  image?: string;
  category?: string;
  volume24h?: number;
  expiration?: string;
  /** One entry for a simple Yes/No market; several for grouped events. */
  outcomes: PredictionOutcome[];
}

export interface MarketToken {
  /** Outcome name the venue uses, e.g. "Yes". */
  outcome: string;
  tokenId: string;
  price?: number;
}

export interface MarketDetail {
  marketId: string;
  conditionId: string;
  title: string;
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
  | { type: 'setup' }
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

export interface Step<R = unknown> {
  id: string;
  type: Action['type'];
  status: StepStatus;
  request: { method: string; params: unknown[] } | null;
  description: string | null;
  result: R | null;
  error: string | null;
}

export interface TradingStatus {
  wallet: string;
  tradingWallet: string;
  ready: boolean;
  /** pUSD balance of the trading wallet. */
  balance: string | null;
  next: 'setup' | 'fund' | null;
}

export interface SetupResult {
  ready: boolean;
  tradingWallet: string;
  transactionHash?: string | null;
}

export interface OrderResult {
  orderId: string;
  status: string;
  venueOrderId: string | null;
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
