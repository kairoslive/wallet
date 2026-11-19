import type { BookLevel } from './orderbook';
import { marketLimitPrice } from './orderbook';
import type { FeeModel } from './types';
import type { Venue } from './venues';

/**
 * Smart order routing for buys. Given the live asks of the same outcome on every venue a question
 * is listed on, spend a dollar budget at the best all-in price: cheapest levels first across all
 * venues, venue fees included, within each venue's balance and order rules. The result is one
 * ordinary immediate (FAK) order per venue, cheapest first.
 *
 * The plan is what the wallet shows and checks; Kairos' `routedOrder` builds its own plan with the
 * same rules, and the wallet bounds every leg it signs by the price and spend shown here.
 */

/** Smallest buy (price × size) each venue accepts, in its collateral. */
export const MIN_BUY: Record<Venue, number> = { polymarket: 1, predictfun: 0.9, hyperliquid: 10 };
/** Share increments each venue trades in. */
export const SHARE_STEP: Record<Venue, number> = { polymarket: 0.01, predictfun: 0.01, hyperliquid: 1 };

export interface RouteVenue {
  venue: Venue;
  /** Wallet market key (see venues.ts). */
  key: string;
  /** The venue's own name for the side being bought (match by token id, never by "Yes"). */
  outcome: string;
  tokenId: string;
  /** Asks, best (lowest) first. */
  asks: BookLevel[];
  tick: number;
  fee?: FeeModel;
  /** Collateral this venue can spend now. Ignored when planning a quote. */
  balance?: number;
  /** Why this venue can't take a leg right now (not set up, blocked, …). Ignored when quoting. */
  unavailable?: string;
}

export interface RouteLeg {
  venue: Venue;
  key: string;
  outcome: string;
  tokenId: string;
  /** Order size: shares bought on this venue. */
  shares: number;
  /** Shares received after any fee taken in shares (Predict.fun). */
  delivered: number;
  /** Paid for the shares at book prices (before fees on top). */
  cost: number;
  /** Venue fee: paid on top (Polymarket), or the value of the shares withheld (Predict.fun). */
  fee: number;
  /** Book average and worst level planned on this venue. */
  avgPrice: number;
  worstPrice: number;
  /** The order's limit: the worst planned level plus a couple of ticks of headroom. */
  limitPrice: number;
  /** The limit as an all-in price per share received, fees included. */
  allInLimit: number;
}

export interface RoutePlan {
  legs: RouteLeg[];
  /** Shares received in total. */
  shares: number;
  /** Money leaving the wallet: book cost plus fees paid on top. */
  spend: number;
  /** Spend per share received: the all-in price. */
  avgPrice: number;
  /** The whole budget could be placed within the slippage band. */
  complete: boolean;
  /** Venues that had a book but got no leg, and why. */
  skipped: { venue: Venue; reason: string }[];
}

export interface PlanOptions {
  /** Plan only levels within this much (all-in) of the best all-in price. */
  maxSlippage?: number;
  /** Quote mode: ignore balances and availability, to show the best price anyone could get. */
  quote?: boolean;
}

/** Fee per share bought at price p, in collateral. */
export function feePerShare(fee: FeeModel | undefined, p: number): number {
  if (!fee) return 0;
  if (fee.kind === 'curve') return fee.rate * Math.pow(p * (1 - p), fee.exponent);
  return fee.rate * Math.min(p, 1 - p);
}

/** What one share received costs at book price p, fees included. */
export function allInPrice(fee: FeeModel | undefined, p: number): number {
  if (!fee) return p;
  // Paid on top: the share costs more. Taken in shares: fewer shares arrive for the same money.
  if (fee.kind === 'curve') return p + feePerShare(fee, p);
  const keep = 1 - feePerShare(fee, p) / p;
  return keep > 0 ? p / keep : Infinity;
}

/** Collateral a buy of one share at p takes from the balance: the price, plus a fee paid on top. */
const payPerShare = (fee: FeeModel | undefined, p: number) => (fee?.kind === 'curve' ? p + feePerShare(fee, p) : p);
/** Shares delivered per share bought at p. */
const keepPerShare = (fee: FeeModel | undefined, p: number) => (fee?.kind === 'min' ? 1 - feePerShare(fee, p) / p : 1);

const floorTo = (n: number, step: number) => Math.floor(n / step + 1e-9) * step;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Hyperliquid prices carry at most 5 decimals; a level it can't name can't be ordered. */
const orderable = (venue: Venue, p: number) => venue !== 'hyperliquid' || Math.abs(p * 1e5 - Math.round(p * 1e5)) < 1e-6;

/** The best all-in ask on each venue, cheapest first. */
export function bestPrices(venues: RouteVenue[]): { venue: Venue; price: number; allIn: number }[] {
  return venues
    .map((v) => {
      const top = v.asks.find((l) => l.size > 0 && orderable(v.venue, l.price));
      return top && { venue: v.venue, price: top.price, allIn: allInPrice(v.fee, top.price) };
    })
    .filter((x): x is { venue: Venue; price: number; allIn: number } => !!x)
    .sort((a, b) => a.allIn - b.allIn);
}

/**
 * Plans spending `budget` (collateral, all venues counted 1:1 as dollars) on the outcome across
 * venues. Venues whose leg would fall under their minimum are dropped and the plan is rebuilt
 * without them, so every leg can actually be placed.
 */
export function planBuy(venues: RouteVenue[], budget: number, opts: PlanOptions = {}): RoutePlan {
  const maxSlippage = opts.maxSlippage ?? 0.05;
  const skipped: { venue: Venue; reason: string }[] = [];
  let pool = venues.filter((v) => {
    if (!v.asks.some((l) => l.size > 0)) {
      skipped.push({ venue: v.venue, reason: 'No sellers right now' });
      return false;
    }
    if (opts.quote) return true;
    if (v.unavailable) {
      skipped.push({ venue: v.venue, reason: v.unavailable });
      return false;
    }
    if (!(Number(v.balance) > 0)) {
      skipped.push({ venue: v.venue, reason: 'No funds there' });
      return false;
    }
    return true;
  });

  for (;;) {
    const plan = walk(pool, budget, maxSlippage, !!opts.quote);
    const tooSmall = plan.legs.filter((l) => l.shares * l.limitPrice < MIN_BUY[l.venue] - 1e-9 || l.shares <= 0);
    // Drop the smallest offender and replan: its share of the budget moves to the other venues.
    if (tooSmall.length) {
      const worst = tooSmall.sort((a, b) => a.cost - b.cost)[0];
      skipped.push({ venue: worst.venue, reason: `Its share is under the ${MIN_BUY[worst.venue]} minimum` });
      pool = pool.filter((v) => v.venue !== worst.venue);
      continue;
    }
    return { ...plan, skipped };
  }
}

function walk(venues: RouteVenue[], budget: number, maxSlippage: number, quote: boolean): Omit<RoutePlan, 'skipped'> {
  type Level = { v: RouteVenue; price: number; size: number; allIn: number };
  const levels: Level[] = venues
    .flatMap((v) =>
      v.asks
        .filter((l) => l.size > 0 && l.price > 0 && l.price < 1 && orderable(v.venue, l.price))
        .map((l) => ({ v, price: l.price, size: l.size, allIn: allInPrice(v.fee, l.price) })),
    )
    .sort((a, b) => a.allIn - b.allIn || venues.indexOf(a.v) - venues.indexOf(b.v));
  if (!levels.length || !(budget > 0)) return { legs: [], shares: 0, spend: 0, avgPrice: 0, complete: false };

  const cap = levels[0].allIn + maxSlippage + 1e-9;
  type Acc = { shares: number; cost: number; fee: number; delivered: number; worst: number; best: number };
  const acc = new Map<RouteVenue, Acc>();
  let left = budget;
  for (const l of levels) {
    if (l.allIn > cap || left <= 1e-9) break;
    const a = acc.get(l.v) ?? { shares: 0, cost: 0, fee: 0, delivered: 0, worst: l.price, best: l.price };
    const pay = payPerShare(l.v.fee, l.price);
    // A venue holds back shares × limit (plus fees on top) from its balance, so leave headroom for the limit.
    const venueLeft = quote ? Infinity : Number(l.v.balance) - venueReserve(l.v, a.shares, a.worst);
    const take = Math.min(l.size, left / pay, Math.max(0, venueLeft) / limitPay(l.v, l.price));
    if (take <= 1e-9) continue;
    a.shares += take;
    a.cost += take * l.price;
    a.fee += take * feePerShare(l.v.fee, l.price);
    a.delivered += take * keepPerShare(l.v.fee, l.price);
    a.worst = Math.max(a.worst, l.price);
    acc.set(l.v, a);
    left -= take * pay;
  }

  const legs: RouteLeg[] = [];
  let available = budget;
  for (const [v, a] of acc) {
    const limitPrice = marketLimitPrice('buy', { worstPrice: a.worst }, a.best, v.tick, maxSlippage);
    const heldPerShare = limitPay(v, limitPrice);
    let shares = Math.min(a.shares, available / heldPerShare);
    // The venue checks its balance against size × limit, not the expected average.
    if (!quote) shares = Math.min(shares, Number(v.balance) / limitPay(v, limitPrice));
    shares = floorTo(shares, SHARE_STEP[v.venue]);
    if (shares <= 0) {
      legs.push({ ...emptyLeg(v), limitPrice, allInLimit: allInPrice(v.fee, limitPrice) });
      continue;
    }
    available -= heldPerShare * shares;
    const scale = shares / a.shares;
    legs.push({
      venue: v.venue,
      key: v.key,
      outcome: v.outcome,
      tokenId: v.tokenId,
      shares: round6(shares),
      delivered: round6(a.delivered * scale),
      cost: round6(a.cost * scale),
      fee: round6(a.fee * scale),
      avgPrice: a.cost / a.shares,
      worstPrice: a.worst,
      limitPrice,
      allInLimit: allInPrice(v.fee, limitPrice),
    });
  }
  legs.sort((x, y) => allInPrice(feeOf(venues, x), x.avgPrice) - allInPrice(feeOf(venues, y), y.avgPrice));
  const placed = legs.filter((l) => l.shares > 0);
  const shares = placed.reduce((s, l) => s + l.delivered, 0);
  const spend = placed.reduce((s, l) => s + l.cost + (feeOf(venues, l)?.kind === 'curve' ? l.fee : 0), 0);
  return {
    legs,
    shares: round6(shares),
    spend: round6(spend),
    avgPrice: shares > 0 ? spend / shares : 0,
    complete: left <= Math.max(0.01, budget * 1e-4),
  };
}

const feeOf = (venues: RouteVenue[], l: { venue: Venue }) => venues.find((v) => v.venue === l.venue)?.fee;

/** Collateral one share at limit p ties up on the venue. */
const limitPay = (v: RouteVenue, p: number) => payPerShare(v.fee, p);

/** What the shares planned so far on a venue tie up there, at a limit a few ticks above the worst level. */
const venueReserve = (v: RouteVenue, shares: number, worst: number) =>
  shares > 0 ? shares * limitPay(v, Math.min(1 - v.tick, worst + 2 * v.tick)) : 0;

const emptyLeg = (v: RouteVenue): Omit<RouteLeg, 'limitPrice' | 'allInLimit'> => ({
  venue: v.venue,
  key: v.key,
  outcome: v.outcome,
  tokenId: v.tokenId,
  shares: 0,
  delivered: 0,
  cost: 0,
  fee: 0,
  avgPrice: 0,
  worstPrice: 0,
});

/**
 * Upper bounds the wallet enforces on every leg it signs for a routed buy, derived from the plan
 * the user confirmed: no leg above `maxPrice`, and no more than `maxSpend` across all legs.
 */
export function routeBounds(plan: RoutePlan): { maxPrice: number; maxSpend: number; maxShares: number } {
  const legs = plan.legs.filter((l) => l.shares > 0);
  // All-in, as Kairos reads `maxPrice`; a leg's book limit is always at or under it.
  const maxPrice = Math.min(1, Math.max(...legs.map((l) => l.allInLimit)));
  // Each leg may fill at up to its limit; Kairos' own plan can shift size between venues, so bound the total.
  const maxSpend = legs.reduce((s, l) => s + l.shares * payPerShare(undefined, l.limitPrice) + l.fee, 0);
  const maxShares = legs.reduce((s, l) => s + l.shares, 0);
  return { maxPrice, maxSpend: round6(maxSpend * 1.01 + 0.01), maxShares: round6(maxShares * 1.02 + 0.01) };
}
