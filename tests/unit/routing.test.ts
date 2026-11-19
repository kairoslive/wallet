import { describe, expect, it } from 'vitest';
import { allInPrice, bestPrices, feePerShare, planBuy, routeBounds, type RouteVenue } from '../../src/core/predictions/router';
import { toLink, lookupLinks } from '../../src/core/predictions/links';
import { groupSearchHits } from '../../src/core/predictions/search';
import { classifyLegError, routedOrderUnavailable, toRouteExecution } from '../../src/core/predictions/execution';
import { verifyRoutedStep, type RouteContext, type RouteProgress } from '../../src/core/predictions/verify';
import { feeModel } from '../../src/core/predictions/client';
import { ActionFailedError } from '../../src/core/predictions/client';
import { HttpError } from '../../src/core/http';
import type { RoutedOrderResult, SearchHit, Step } from '../../src/core/predictions/types';

const POLY_FEE = { kind: 'curve' as const, rate: 0.03, exponent: 1 };
const PF_FEE = { kind: 'min' as const, rate: 0.02 };

const venue = (v: Partial<RouteVenue> & Pick<RouteVenue, 'venue'>): RouteVenue => ({
  key: `${v.venue}:1`,
  outcome: 'Yes',
  tokenId: `${v.venue}-yes`,
  asks: [],
  tick: 0.01,
  balance: 1000,
  ...v,
});

describe('venue fees', () => {
  it('matches the documented Buccaneers example', () => {
    // Polymarket: 50 at 0.29 with a 3% curve fee → 0.31 on top.
    expect(feePerShare(POLY_FEE, 0.29) * 50).toBeCloseTo(0.309, 3);
    // Predict.fun: 50 at 0.30 with 2% → 0.30 of value, taken in shares (49 delivered).
    expect(feePerShare(PF_FEE, 0.3) * 50).toBeCloseTo(0.3, 6);
    expect(allInPrice(PF_FEE, 0.3)).toBeCloseTo(0.3 / 0.98, 6);
    expect(allInPrice(undefined, 0.28653)).toBe(0.28653);
  });

  it('reads fee models from market data', () => {
    expect(feeModel('polymarket', { fees_enabled: true, fee_schedule: { rate: 0.05, exponent: 1 } })).toEqual({
      kind: 'curve',
      rate: 0.05,
      exponent: 1,
    });
    expect(feeModel('polymarket', { fees_enabled: false, fee_schedule: { rate: 0.05 } })).toBeUndefined();
    expect(feeModel('predictfun', { raw: { fee_rate_bps: 200 } })).toEqual({ kind: 'min', rate: 0.02 });
    expect(feeModel('hyperliquid', { raw: { fee_rate_bps: 200 } })).toBeUndefined();
  });
});

describe('planBuy', () => {
  const books = () => [
    venue({
      venue: 'polymarket',
      fee: POLY_FEE,
      asks: [
        { price: 0.29, size: 20 },
        { price: 0.31, size: 500 },
      ],
    }),
    venue({
      venue: 'predictfun',
      fee: PF_FEE,
      asks: [
        { price: 0.3, size: 30 },
        { price: 0.33, size: 500 },
      ],
    }),
    venue({
      venue: 'hyperliquid',
      tick: 0.0001,
      asks: [
        { price: 0.28653, size: 40 },
        { price: 0.32, size: 500 },
      ],
    }),
  ];

  it('fills the cheapest all-in levels first, across venues', () => {
    const plan = planBuy(books(), 20);
    const by = Object.fromEntries(plan.legs.map((l) => [l.venue, l]));
    // Hyperliquid's 0.28653 is cheapest all-in, then Polymarket 0.29 (+fee ≈ 0.2962), then Predict.fun 0.30 (≈ 0.3061).
    expect(by.hyperliquid.shares).toBe(40);
    expect(by.polymarket.shares).toBeGreaterThan(0);
    expect(plan.legs[0].venue).toBe('hyperliquid');
    expect(plan.complete).toBe(true);
    expect(plan.spend).toBeLessThanOrEqual(20 + 1e-6);
    // Every leg's limit sits at or above its worst planned level, within the slippage band.
    for (const l of plan.legs) {
      expect(l.limitPrice).toBeGreaterThanOrEqual(l.worstPrice - 1e-9);
      expect(l.limitPrice).toBeLessThanOrEqual(l.worstPrice + 0.05);
    }
  });

  it('beats any single venue for the same money', () => {
    const routed = planBuy(books(), 30);
    for (const single of books()) {
      const alone = planBuy([single], 30);
      if (alone.shares > 0) expect(routed.shares).toBeGreaterThanOrEqual(alone.shares - 1e-6);
    }
  });

  it('keeps each leg within the balance at its limit price', () => {
    const v = books();
    v[2].balance = 12.5; // Hyperliquid: under its 10 USDC minimum once capped? 12.5 / ~0.3 → 41 shares
    v[0].balance = 3;
    const plan = planBuy(v, 50);
    for (const l of plan.legs) {
      const bal = v.find((x) => x.venue === l.venue)!.balance!;
      const reserve = l.shares * l.limitPrice + (l.venue === 'polymarket' ? l.shares * feePerShare(POLY_FEE, l.limitPrice) : 0);
      expect(reserve).toBeLessThanOrEqual(bal + 1e-6);
    }
  });

  it('reserves the shared dollar budget at the worst limit across venues', () => {
    const v = books();
    const budget = 30;
    const plan = planBuy(v, budget);
    const worstSpend = plan.legs.reduce(
      (sum, leg) =>
        sum + leg.shares * (leg.limitPrice + (leg.venue === 'polymarket' ? feePerShare(POLY_FEE, leg.limitPrice) : 0)),
      0,
    );
    expect(plan.legs.length).toBeGreaterThan(1);
    expect(worstSpend).toBeLessThanOrEqual(budget + 1e-6);
  });

  it('drops a venue whose share would be under its minimum and replans without it', () => {
    const v = books();
    v[2].asks = [{ price: 0.2, size: 5 }]; // Hyperliquid: 5 × 0.2 = 1 USDC, under its 10 minimum
    const plan = planBuy(v, 20);
    expect(plan.legs.map((l) => l.venue)).not.toContain('hyperliquid');
    expect(plan.skipped.some((s) => s.venue === 'hyperliquid')).toBe(true);
    expect(plan.complete).toBe(true);
  });

  it('trades whole shares on Hyperliquid and skips prices it cannot name', () => {
    const plan = planBuy(
      [
        venue({
          venue: 'hyperliquid',
          tick: 0.00001,
          asks: [
            { price: 0.123456, size: 100 },
            { price: 0.3, size: 100 },
          ],
        }),
      ],
      15.5,
    );
    expect(plan.legs[0].shares % 1).toBe(0);
    expect(plan.legs[0].worstPrice).toBe(0.3);
  });

  it('leaves out venues that are not set up or unfunded, unless quoting', () => {
    const v = books();
    v[0].unavailable = 'Set up first';
    v[1].balance = 0;
    // Hyperliquid alone needs at least 10 USDC at the limit price.
    const plan = planBuy(v, 20);
    expect(plan.legs.map((l) => l.venue)).toEqual(['hyperliquid']);
    expect(plan.skipped.map((s) => s.venue).sort()).toEqual(['polymarket', 'predictfun']);
    expect(planBuy(v, 30, { quote: true }).legs.length).toBeGreaterThan(1);
  });

  it('stays within the slippage band', () => {
    const plan = planBuy(
      [
        venue({
          venue: 'polymarket',
          asks: [
            { price: 0.3, size: 10 },
            { price: 0.5, size: 1000 },
          ],
        }),
      ],
      100,
    );
    expect(plan.complete).toBe(false);
    expect(plan.legs[0].shares).toBe(10);
  });

  it('plans nothing when the only leg is under the minimum', () => {
    const plan = planBuy([venue({ venue: 'hyperliquid', asks: [{ price: 0.5, size: 100 }] })], 5);
    expect(plan.legs).toEqual([]);
    expect(plan.skipped[0]).toMatchObject({ venue: 'hyperliquid' });
  });

  it('ranks best prices all-in', () => {
    expect(bestPrices(books()).map((b) => b.venue)).toEqual(['hyperliquid', 'polymarket', 'predictfun']);
  });

  it('bounds every leg by the confirmed plan', () => {
    const plan = planBuy(books(), 20);
    const b = routeBounds(plan);
    expect(b.maxPrice).toBeGreaterThanOrEqual(Math.max(...plan.legs.map((l) => l.limitPrice)));
    expect(b.maxSpend).toBeGreaterThanOrEqual(plan.legs.reduce((s, l) => s + l.shares * l.limitPrice, 0));
  });
});

describe('market links', () => {
  const row = {
    id: 'L1',
    title: 'Chargers vs. Ravens',
    sideLabels: { yes: 'Chargers', no: 'Ravens' },
    venues: [
      {
        provider: 'hyperliquid',
        marketId: '30164',
        streamKey: '30164',
        tokenIdYes: '#301641',
        tokenIdNo: '#301640',
        executable: true,
      },
      { provider: 'kalshi', marketId: 'KX-LAC', tokenIdYes: 'a', tokenIdNo: 'b', executable: false },
      { provider: 'polymarket', marketId: '0xe579', streamKey: '6296764', tokenIdYes: '411', tokenIdNo: '121', executable: true },
      { provider: 'predictfun', marketId: '3915503', tokenIdYes: '747', tokenIdNo: '814', executable: true },
    ],
  };

  it('keys each venue the way the wallet does and keeps only tradeable venues', () => {
    const link = toLink(row);
    expect(link.markets.map((m) => [m.venue, m.key, m.bookKey])).toEqual([
      ['hyperliquid', 'hyperliquid:30164', 'hyperliquid:30164'],
      ['polymarket', '6296764', '0xe579'],
      ['predictfun', 'predictfun:3915503', 'predictfun:3915503'],
    ]);
  });

  it('looks links up by wallet keys', async () => {
    let url = '';
    const fetchFn = (async (u: string) => {
      url = u;
      return new Response(JSON.stringify({ links: { 'polymarket:6296764': row } }));
    }) as typeof fetch;
    const links = await lookupLinks(
      { dataUrl: 'https://d', executionUrl: '', marketDataUrl: '', partnerId: '' },
      ['6296764', 'predictfun:1'],
      fetchFn,
    );
    expect(decodeURIComponent(url)).toContain('markets=polymarket:6296764,predictfun:1');
    expect(Object.keys(links)).toEqual(['6296764']);
  });
});

describe('search grouping', () => {
  const hit = (marketId: string, venue: SearchHit['venue'], volume24h: number): SearchHit => ({
    marketId,
    venue,
    title: `${venue} wording`,
    volume24h,
    price: 0.4,
  });
  it('merges the same question across venues and keeps the busiest market', () => {
    const link = toLink({
      id: 'L',
      title: 'Chargers vs. Ravens',
      venues: [
        { provider: 'polymarket', marketId: '0x1', streamKey: '1', tokenIdYes: 'a', tokenIdNo: 'b', executable: true },
        { provider: 'predictfun', marketId: '2', tokenIdYes: 'c', tokenIdNo: 'd', executable: true },
      ],
    });
    const out = groupSearchHits([hit('predictfun:2', 'predictfun', 10), hit('9', 'polymarket', 5), hit('1', 'polymarket', 50)], {
      'predictfun:2': link,
      '1': link,
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ marketId: '1', title: 'Chargers vs. Ravens', volume24h: 60 });
    expect(out[0].venues.sort()).toEqual(['polymarket', 'predictfun']);
  });
});

describe('routed order verification', () => {
  const ctx = (): { route: RouteContext; progress: RouteProgress } => ({
    route: {
      markets: [
        { venue: 'predictfun', market: 'predictfun:3481439', tokenId: 'pf-yes', outcome: 'Buccaneers' },
        { venue: 'polymarket', market: 'polymarket:0xabc', tokenId: 'pm-yes', outcome: 'Yes' },
      ],
      maxPrice: 0.32,
      maxSpend: 16,
      maxShares: 51,
    },
    progress: { signed: new Set() },
  });
  const step = (legs: Record<string, string>[], index = 1, venue = 'predictfun'): Step =>
    ({
      id: 'a',
      type: 'routed_order',
      status: 'needs_signature',
      request: null,
      description: null,
      venue,
      leg: { index, of: legs.length },
      route: { legs },
      result: null,
      error: null,
    }) as unknown as Step;
  const legs = [
    { venue: 'predictfun', market: 'predictfun:3481439', outcome: 'Buccaneers', price: '0.3', size: '30.6', timeInForce: 'FAK' },
    { venue: 'polymarket', market: 'polymarket:0xabc', outcome: 'Yes', price: '0.31', size: '20', timeInForce: 'FAK' },
  ];

  it('turns each leg into the order it must be', () => {
    const c = ctx();
    const r = verifyRoutedStep(step(legs), c);
    expect(r).toMatchObject({ index: 1, tokenId: 'pf-yes', action: { market: 'predictfun:3481439', side: 'buy', size: '30.6' } });
    expect(verifyRoutedStep(step(legs, 2, 'polymarket'), c).tokenId).toBe('pm-yes');
  });

  it('refuses a leg that buys the other outcome', () => {
    expect(() => verifyRoutedStep(step([{ ...legs[0], outcome: 'Commanders' }]), ctx())).toThrow(/different outcome/);
  });

  it('refuses a venue market the user did not choose', () => {
    expect(() => verifyRoutedStep(step([{ ...legs[0], market: 'predictfun:999' }]), ctx())).toThrow(/didn't choose/);
  });

  it('refuses a leg above the price cap, or a plan that spends or buys more', () => {
    expect(() => verifyRoutedStep(step([{ ...legs[0], price: '0.35' }]), ctx())).toThrow(/priced above/);
    expect(() => verifyRoutedStep(step([{ ...legs[0], size: '60' }]), ctx())).toThrow(/spends more|buys more/);
  });

  it('refuses a resting leg, a changed plan and a mismatched venue', () => {
    expect(() => verifyRoutedStep(step([{ ...legs[0], timeInForce: 'GTC' }]), ctx())).toThrow(/rest/);
    const c = ctx();
    verifyRoutedStep(step(legs), c);
    expect(() => verifyRoutedStep(step([legs[0], { ...legs[1], size: '21' }], 2, 'polymarket'), c)).toThrow(/changed/);
    expect(() => verifyRoutedStep(step(legs, 2, 'predictfun'), ctx())).toThrow(/different venue/);
    expect(() => verifyRoutedStep(step(legs, 3), ctx())).toThrow(/no leg/);
  });
});

describe('routing decisions', () => {
  const failed = (errorCode: string) => new ActionFailedError({ errorCode, error: 'x' } as unknown as Step);
  it('moves on only when nothing was placed', () => {
    expect(classifyLegError(failed('NO_MATCH'))).toBe('nothing');
    expect(classifyLegError(failed('VENUE_REJECTED'))).toBe('nothing');
    // Refused up front, per the routing guide: nothing was placed.
    expect(classifyLegError(new HttpError(503, 'predictfun is not available right now'))).toBe('nothing');
    expect(classifyLegError(new HttpError(502, 'Bad gateway'))).toBe('unknown');
    expect(classifyLegError(new Error('predictfun is not available right now'))).toBe('nothing');
    expect(classifyLegError(new HttpError(422, 'bad'))).toBe('nothing');
    expect(classifyLegError(new HttpError(429, 'Too many requests'))).toBe('unknown');
    expect(classifyLegError(failed('ORDER_OUTCOME_UNKNOWN'))).toBe('unknown');
    expect(classifyLegError(new Error('Request timed out: execution.kairos.trade'))).toBe('unknown');
    const refused = new Error('Refused to sign: x');
    refused.name = 'UnsafeSigningRequestError';
    expect(classifyLegError(refused)).toBe('refused');
  });

  it('falls back to wallet routing only when Kairos refused before signing', () => {
    expect(routedOrderUnavailable(new HttpError(403, 'routed orders are not enabled here'))).toBe(true);
    expect(
      routedOrderUnavailable(new HttpError(422, 'this market is not linked to another venue; place a single-venue order')),
    ).toBe(true);
    expect(routedOrderUnavailable(new HttpError(422, 'x', { errorCode: 'ROUTE_UNAVAILABLE' }))).toBe(true);
    expect(routedOrderUnavailable(new HttpError(503, 'orderbook source unavailable'))).toBe(false);
    expect(routedOrderUnavailable(new Error('boom'))).toBe(false);
  });

  it("reads Kairos' routed result per leg", () => {
    const result = {
      routed: true,
      placed: 1,
      failed: 1,
      legs: [
        {
          venue: 'predictfun',
          market: 'predictfun:1',
          outcome: 'A',
          price: '0.3',
          size: '30',
          status: 'placed',
          order: { orderId: 'o', status: 'live', venueOrderId: null, filledSize: null, final: false },
        },
        {
          venue: 'polymarket',
          market: 'polymarket:0xabc',
          outcome: 'Yes',
          price: '0.31',
          size: '20',
          status: 'failed',
          error: 'No fill',
        },
      ],
    } as RoutedOrderResult;
    const ex = toRouteExecution(result, [
      { key: 'predictfun:1', market: { venue: 'predictfun' } },
      { key: '601', market: { venue: 'polymarket' } },
    ]);
    expect(ex.legs.map((l) => [l.key, l.status])).toEqual([
      ['predictfun:1', 'working'],
      ['601', 'failed'],
    ]);
  });
});
