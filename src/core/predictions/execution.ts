import { HttpError } from '../http';
import type { OrderResult, RoutedOrderResult, WalletRoute } from './types';
import { parseMarketKey, type Venue } from './venues';

/**
 * Executing a routed buy: what the UI asks for, what comes back, and how a failed venue order is
 * read (was anything placed?) to decide whether the next venue may take the rest.
 */

/** A routed buy as the user confirmed it: the plan's legs, cheapest first. */
export interface RoutedBuyRequest {
  /** The market the user opened (wallet market key). */
  marketId: string;
  /** The outcome name on that market. */
  outcome: string;
  legs: {
    /** Wallet market key of this venue's market. */
    key: string;
    /** Limit price, 0–1. */
    price: number;
    /** Shares to buy on this venue. */
    size: number;
  }[];
  /** Highest all-in price per share the user accepted (fees included), 0–1. */
  maxPrice: number;
  /** Shares the plan delivers in total. */
  shares: number;
  slippageCents?: number;
  /** Hard collateral ceiling for the reviewed route. */
  maxSpend?: number;
}

export type PreparedRoute =
  | { kind: 'kairos'; id: string; route: WalletRoute; expiresAtMs: number }
  | { kind: 'wallet'; note?: string }
  | { kind: 'failed'; execution: RouteExecution };

export type LegStatus = 'filled' | 'partial' | 'working' | 'failed' | 'unknown' | 'skipped';

export interface RouteLegResult {
  venue: Venue;
  key: string;
  /** Shares asked of this venue. */
  size: number;
  status: LegStatus;
  filled?: number;
  avgPrice?: number;
  orderId?: string;
  error?: string;
  errorCode?: string;
}

export interface RouteExecution {
  /** `kairos`: Kairos' own routedOrder ran it. `wallet`: the wallet placed one order per venue itself. */
  mode: 'kairos' | 'wallet';
  legs: RouteLegResult[];
  /** Shares confirmed filled so far (orders still working may add more). */
  filled: number;
  /** Some leg may be live without confirmation: check orders before buying again. */
  uncertain: boolean;
}

export class PredictionOrderError extends Error {
  constructor(
    message: string,
    readonly code: 'POLYMARKET_SIGNER_MISMATCH' | 'POLYMARKET_SETUP_REQUIRED' | 'ORDER_OUTCOME_UNKNOWN',
  ) {
    super(message);
  }
}

export function venueErrorCode(error: unknown): string | undefined {
  if (error instanceof HttpError && error.status === 422 && error.body && typeof error.body === 'object') {
    if ('code' in error.body && typeof error.body.code === 'string') return error.body.code;
  }
  if (error instanceof Error && 'step' in error && error.step && typeof error.step === 'object') {
    if ('errorCode' in error.step && typeof error.step.errorCode === 'string') return error.step.errorCode;
  }
}

export function needsPolymarketReconnect(order: { venue: Venue; errorCode?: string; error?: string }): boolean {
  return (
    order.venue === 'polymarket' &&
    order.errorCode === 'VENUE_REJECTED' &&
    /^(?:CLOB error: )?the order signer address has to be the address of the API KEY$/i.test(order.error?.trim() ?? '')
  );
}

/** Error codes meaning the venue placed nothing, so another venue may take the order. */
const NOTHING_PLACED = new Set(['NO_MATCH', 'VENUE_REJECTED', 'SIGNATURE_EXPIRED']);

/**
 * Reads a failed venue order: `nothing` (safe to try the next venue), `unknown` (it may be live:
 * stop), or `refused` (the wallet refused to sign: stop and say why).
 */
export function classifyLegError(e: unknown, signed = false): 'nothing' | 'unknown' | 'refused' {
  if (e instanceof PredictionOrderError && e.code === 'ORDER_OUTCOME_UNKNOWN') return 'unknown';
  const err = e as { name?: string; message?: string; step?: { errorCode?: string | null }; status?: number };
  const code = venueErrorCode(e) ?? err?.step?.errorCode ?? undefined;
  if (signed) {
    if (code && NOTHING_PLACED.has(code)) return 'nothing';
    return 'unknown';
  }
  if (err?.name === 'UnsafeSigningRequestError') return 'refused';
  const message = String(err?.message ?? '');
  if (code === 'ORDER_OUTCOME_UNKNOWN' || /outcome not confirmed|outcome unknown/i.test(message)) return 'unknown';
  if (code && NOTHING_PLACED.has(code)) return 'nothing';
  if (/^(NO_MATCH|VENUE_REJECTED|SIGNATURE_EXPIRED)\b/.test(message)) return 'nothing';
  if (/no orders found to match|no liquidity|FOK_NOT_FILLED|MARKET_INSUFFICIENT_LIQUIDITY/i.test(message)) return 'nothing';
  // Timeouts, conflicts and rate limits say nothing about an order already sent: it may be live.
  if (e instanceof HttpError && (e.status === 408 || e.status === 409 || e.status === 429)) return 'unknown';
  if (e instanceof HttpError && e.status < 500) {
    // Refused before anything was signed: unavailable venue, disabled access, bad request.
    return 'nothing';
  }
  if (/is not available right now|API-key access to/i.test(message)) return 'nothing';
  // Timeouts and 5xx after signing may have reached the venue.
  return 'unknown';
}

/** Kairos refused a routedOrder before anything was signed, so the wallet can route the buy itself. */
export function routedOrderUnavailable(e: unknown): boolean {
  if (!(e instanceof HttpError)) return false;
  if (e.status === 403) return /routed orders? (?:are )?not enabled|routedOrder (?:is )?disabled/i.test(e.message);
  if (e.status === 404 || e.status === 405 || e.status === 501) return true;
  // Not linked, no venue can take a leg (Kairos' view may lag the wallet's), or an older node
  // that doesn't know the action type.
  if (e.status === 422 || e.status === 400)
    return /not linked|ROUTE_UNAVAILABLE|unknown variant|routedOrder|multi-venue/i.test(
      `${e.message} ${JSON.stringify(e.body ?? '')}`,
    );
  return false;
}

export function isUnconfirmedOrder(order: OrderResult | undefined): boolean {
  return order?.success === false && /outcome (?:not confirmed|unknown)/i.test(order.message ?? '');
}

/** Reads Kairos' routedOrder result in the same shape as a wallet-routed buy. */
export function toRouteExecution(result: RoutedOrderResult, legs: { key: string; market: { venue: Venue } }[]): RouteExecution {
  const keyOf = (venue: Venue, market: string) =>
    legs.find((l) => l.market.venue === venue)?.key ?? (venue === 'polymarket' ? market.replace(/^polymarket:/, '') : market);
  const out: RouteLegResult[] = (result.legs ?? []).map((l) => {
    const order = l.order;
    const filled = order?.filledSize === null || order?.filledSize === undefined ? undefined : Number(order.filledSize);
    const size = Number(l.size);
    let status: LegStatus;
    if (l.status === 'placed') {
      if (isUnconfirmedOrder(order)) status = 'unknown';
      else if (order?.final === false) status = 'working';
      else if (filled === undefined) status = 'working';
      else status = filled <= 0 ? 'failed' : filled + 1e-9 < size ? 'partial' : 'filled';
    } else status = l.status;
    return {
      venue: l.venue,
      key: keyOf(l.venue, l.market),
      size,
      status,
      filled,
      avgPrice: order?.avgPrice ? Number(order.avgPrice) : undefined,
      orderId: l.orderId,
      error: l.error ?? (status === 'failed' || status === 'unknown' ? (order?.message ?? undefined) : undefined),
      errorCode: l.errorCode,
    };
  });
  return {
    mode: 'kairos',
    legs: out,
    filled: out.reduce((s, l) => s + (l.filled ?? 0), 0),
    uncertain: out.some((l) => l.status === 'unknown'),
  };
}

/** The venue of a wallet market key. */
export const venueOfKey = (key: string): Venue => parseMarketKey(key).venue;
