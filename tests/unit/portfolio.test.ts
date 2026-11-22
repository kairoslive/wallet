import { describe, expect, it } from 'vitest';
import {
  filledTokensMissing,
  heldFromFills,
  lookupMarkets,
  toHistoryView,
  toOrderView,
  toPositionsView,
  withOnchainSizes,
  type MarketMeta,
} from '../../src/core/predictions/portfolio';
import type { KairosConfig } from '../../src/core/predictions/types';

const CFG: KairosConfig = {
  executionUrl: 'https://exec.test',
  dataUrl: 'https://data.test',
  marketDataUrl: 'https://md.test',
  partnerId: 'p',
};
const COND = '0xDF9B000000000000000000000000000000000000000000000000000000000001';

function fakeFetch() {
  const calls: { url: string; body?: unknown }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (v: unknown) => new Response(JSON.stringify(v));
    if (url.includes('v1/markets/batch'))
      return json({
        markets: {
          [COND]: {
            market_id: '2589812',
            condition_id: COND,
            title: 'Will there be no change in Fed interest rates?',
            end_date: '2026-10-29T03:59:00Z',
            status: 'open',
            outcomes: [
              { outcome: 'Yes', token_id: 'tyes' },
              { outcome: 'No', token_id: 'tno' },
            ],
          },
        },
      });
    if (url.includes('discover/v2'))
      return json({
        markets: [
          {
            id: '2589812',
            title: 'Fed Decision in October?',
            image: 'https://img/fed.jpg',
            outcomes: [
              { id: '2589812', title: 'No change?', outcomeLabel: 'No change' },
              { id: '2589813', title: 'Cut?', outcomeLabel: '25 bps decrease' },
            ],
          },
        ],
      });
    if (url.includes('v1/marks')) return json({ marks: [{ token_id: 'tyes', price: 72 }] });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe('lookupMarkets', () => {
  it('joins market data, discover images and live marks, keyed by every id', async () => {
    const { fetchFn, calls } = fakeFetch();
    const metas = await lookupMarkets(CFG, [COND, COND, ''], fetchFn);
    const m = metas.get(COND.toLowerCase())!;
    expect(m).toMatchObject({
      marketId: '2589812',
      eventTitle: 'Fed Decision in October?',
      label: 'No change',
      image: 'https://img/fed.jpg',
    });
    expect(m.tokens).toEqual([
      { outcome: 'Yes', tokenId: 'tyes', price: 0.72 },
      { outcome: 'No', tokenId: 'tno', price: undefined },
    ]);
    expect(metas.get('2589812')).toBe(m);
    expect(metas.get('tno')).toBe(m);
    expect(calls[0].body).toEqual({ provider: 'polymarket', market_ids: [COND] });
    expect(decodeURIComponent(calls[1].url)).toContain('market_ids=2589812');
  });

  it('looks up each venue with its own provider and prices Predict.fun from its listing', async () => {
    const seen: string[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      seen.push(body ? `batch:${body.provider}` : (new URL(url).searchParams.get('provider') ?? ''));
      const json = (v: unknown) => new Response(JSON.stringify(v));
      if (url.includes('/v1/markets/batch')) {
        return body.provider === 'predictfun'
          ? json({
              markets: {
                '12754': {
                  market_id: '12754',
                  condition_id: '0x55c9',
                  title: '12+ cuts',
                  outcomes: [
                    { outcome: 'Yes', token_id: 'pf-yes' },
                    { outcome: 'No', token_id: 'pf-no' },
                  ],
                },
              },
            })
          : json({ markets: {} });
      }
      if (url.includes('/discover/')) {
        return json({
          markets: [{ id: '12754', title: 'How many Fed rate cuts in 2026?', outcomes: [{ id: '12754', price: 0.25 }] }],
        });
      }
      return json({ marks: [] });
    }) as unknown as typeof fetch;
    const metas = await lookupMarkets(CFG, ['predictfun:12754', COND], fetchFn);
    const m = metas.get('predictfun:12754')!;
    expect(m).toMatchObject({ venue: 'predictfun', marketId: 'predictfun:12754' });
    expect(m.tokens.map((t) => t.price)).toEqual([0.25, 0.75]);
    expect(metas.get('12754')).toBeUndefined();
    expect(seen).toContain('batch:predictfun');
    expect(seen).toContain('batch:polymarket');
    expect(seen.filter((p) => p === 'predictfun')).toHaveLength(2);
  });

  it('degrades to empty metadata when lookups fail', async () => {
    const fetchFn = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    expect((await lookupMarkets(CFG, [COND], fetchFn)).size).toBe(0);
    expect((await lookupMarkets(CFG, [], fetchFn)).size).toBe(0);
  });
});

describe('portfolio views', () => {
  const meta: MarketMeta = {
    marketId: '2589812',
    venue: 'polymarket',
    conditionId: COND.toLowerCase(),
    title: 'Will there be no change?',
    eventTitle: 'Fed Decision in October?',
    label: 'No change',
    image: 'https://img/fed.jpg',
    endDate: '2026-10-29T03:59:00Z',
    tokens: [
      { outcome: 'Yes', tokenId: 'tyes', price: 0.72 },
      { outcome: 'No', tokenId: 'tno', price: 0.29 },
    ],
  };
  const metas = new Map<string, MarketMeta>([
    [meta.conditionId, meta],
    ['2589812', meta],
    ['tyes', meta],
    ['tno', meta],
  ]);

  it('values positions at the live price with cost and P&L', () => {
    const v = toPositionsView(
      {
        open: [
          { token_id: 'tyes', market_id: COND, outcome: 'Yes', net_size: '7.04', avg_entry_price_bps: 7100, realized_pnl: '0' },
          { token_id: 'tno', market_id: COND, outcome: null, net_size: '0' },
        ],
        resolved: [{ token_id: 'tno', market_id: '2589812', net_size: '3', redeemable: true }],
      },
      metas,
    );
    expect(v.positions).toHaveLength(2);
    const [open, won] = v.positions;
    expect(open).toMatchObject({
      title: 'Fed Decision in October?',
      subtitle: 'No change',
      outcome: 'Yes',
      state: 'open',
      marketId: '2589812',
    });
    expect(open.avgPrice).toBeCloseTo(0.71);
    expect(open.value).toBeCloseTo(7.04 * 0.72);
    expect(open.pnl).toBeCloseTo(7.04 * 0.01);
    expect(open.pnlPct).toBeCloseTo(0.01 / 0.71);
    expect(won).toMatchObject({ outcome: 'No', state: 'won', price: 1, value: 3 });
    expect(v.totals.value).toBeCloseTo(7.04 * 0.72 + 3);
  });

  it('lists closed and dust positions as history with realized P&L, newest first', () => {
    const v = toHistoryView(
      {
        performance: { total_realized_pnl: '-0.08939' },
        open_positions: [
          // Sold down to dust: history. Still shown as a position: skipped.
          {
            market_id: '2589812',
            token_id: 'tyes',
            outcome: 'Yes',
            size: '0.002254',
            entry_price: '0.71',
            realized_pnl: '-0.0704',
          },
          { market_id: '2589812', token_id: 'tno', outcome: 'No', size: '3', entry_price: '0.3', realized_pnl: '0' },
        ],
        closed_positions: [
          {
            market_id: '601826',
            market_name: 'Will Flávio win?',
            icon: 'https://i/f.png',
            token_id: 'tf',
            outcome: 'Yes',
            size: '0',
            entry_price: '0.793',
            realized_pnl: '0.5',
            closed_at: '2026-10-15T10:00:00Z',
          },
          {
            market_id: '9',
            token_id: 'told',
            outcome: 'No',
            size: '0',
            entry_price: '0.2',
            realized_pnl: '1.2',
            closed_at: '2026-10-01T10:00:00Z',
          },
        ],
      },
      metas,
      new Set(['tno']),
    );
    expect(v.realized).toBeCloseTo(-0.08939);
    expect(v.history.map((p) => p.key)).toEqual(['tf:c', 'told:c', 'tyes:c']);
    expect(v.history[0]).toMatchObject({
      title: 'Will Flávio win?',
      image: 'https://i/f.png',
      state: 'closed',
      realizedPnl: 0.5,
      shares: 0,
    });
    expect(v.history[0].avgPrice).toBeCloseTo(0.793);
    // Known markets get the same titles as open positions.
    expect(v.history[2]).toMatchObject({ title: 'Fed Decision in October?', subtitle: 'No change', marketId: '2589812' });
  });

  it('drops dust from open positions', () => {
    const v = toPositionsView({ open: [{ token_id: 'tyes', market_id: COND, net_size: '0.002254' }], resolved: [] }, metas);
    expect(v.positions).toEqual([]);
    expect(v.history).toEqual([]);
  });

  it('keeps unknown markets readable', () => {
    const v = toPositionsView({ open: [{ token_id: 'x', market_id: '0xabc', net_size: '2' }], resolved: [] }, new Map());
    expect(v.positions[0]).toMatchObject({ title: 'Unknown market', outcome: '—', shares: 2, value: undefined });
    expect(v.totals).toMatchObject({ value: 0, pnl: 0 });
  });

  it('maps orders with fill progress and open state', () => {
    const o = toOrderView(
      {
        id: 'd84f',
        market_id: COND,
        token_id: 'tyes',
        side: 'buy',
        quantity: '7.04000000',
        price: '0.71',
        filled_quantity: '3.5',
        avg_fill_price: '0.705',
        status: 'partial',
        created_at: '2026-10-15T20:00:00Z',
        outcome: 'Yes',
      },
      metas,
    );
    expect(o).toMatchObject({
      id: 'd84f',
      title: 'Fed Decision in October?',
      subtitle: 'No change',
      image: 'https://img/fed.jpg',
      side: 'buy',
      outcome: 'Yes',
      price: 0.71,
      shares: 7.04,
      filled: 3.5,
      avgFillPrice: 0.705,
      open: true,
    });
    expect(toOrderView({ id: 'x', status: 'cancelled', side: 'SELL', price_bps: 9900, quantity: '5' }, metas)).toMatchObject({
      open: false,
      side: 'sell',
      price: 0.99,
      title: 'Unknown market',
    });
  });
});

describe('withOnchainSizes', () => {
  it('trusts the chain over a lagging index, and drops positions that were sold', () => {
    const open = [
      { token_id: '1', net_size: '7.04' },
      { token_id: '2', net_size: '3' },
      { token_id: '3', net_size: '1' },
    ];
    const fixed = withOnchainSizes(
      open,
      new Map([
        ['1', 0.002254],
        ['2', 3],
      ]),
    );
    expect(fixed.map((r) => r.net_size)).toEqual(['0.002254', '3', '1']);
    expect(fixed[0].indexed_size).toBe('7.04');
  });
});

describe('positions from recent fills', () => {
  const meta: MarketMeta = {
    marketId: '0xabc',
    venue: 'polymarket',
    conditionId: '0xabc',
    title: 'Fed Decision',
    tokens: [
      { outcome: 'Yes', tokenId: '11', price: 0.9 },
      { outcome: 'No', tokenId: '22', price: 0.1 },
    ],
  };
  const metas = new Map([['0xabc', meta]]);
  const buy = { market: '0xabc', side: 'buy', outcome: 'Yes', filledSize: '5.67', avgFillPrice: '0.92', created_at: '2026-11-22T06:43:00Z' };

  it('names the tokens of filled markets the index does not show', () => {
    expect(filledTokensMissing([buy], [], metas).sort()).toEqual(['11', '22']);
    expect(filledTokensMissing([buy], [{ tokenId: '11' }], metas)).toEqual(['22']);
    expect(filledTokensMissing([{ ...buy, filledSize: '0' }], [], metas)).toEqual([]);
  });

  it('turns shares held on-chain into open rows priced at the filled buy', () => {
    const rows = heldFromFills([buy], [], metas, new Map([['11', 5.69], ['22', 0]]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tokenId: '11', net_size: '5.69', avg_price: 0.92 });
    const view = toPositionsView({ open: rows, resolved: [] }, metas);
    expect(view.positions[0]).toMatchObject({ outcome: 'Yes', shares: 5.69, state: 'open', title: 'Fed Decision' });
  });

  it('shows nothing once the shares are sold', () => {
    expect(heldFromFills([buy], [], metas, new Map([['11', 0]]))).toEqual([]);
  });

  it('never repeats a token the index lists, open or resolved', () => {
    const balances = new Map([['11', 5], ['22', 3]]);
    expect(heldFromFills([buy], [{ tokenId: '11', net_size: '5' }], metas, balances).map((r) => r.tokenId)).toEqual(['22']);
    expect(heldFromFills([buy], [{ tokenId: '22', redeemable: true }, { tokenId: '11' }], metas, balances)).toEqual([]);
  });

  it('prices each outcome from its own filled buy, not a sell or an unfilled order', () => {
    const orders = [
      { ...buy, side: 'sell', avgFillPrice: '0.95' },
      { ...buy, filledSize: '0', avgFillPrice: '0.5' },
      { ...buy, outcome: 'No', tokenId: '22', avgFillPrice: '0.1' },
      buy,
    ];
    const rows = heldFromFills(orders, [], metas, new Map([['11', 5], ['22', 2]]));
    expect(Object.fromEntries(rows.map((r) => [r.tokenId, r.avg_price]))).toEqual({ '11': 0.92, '22': 0.1 });
  });

  it('matches Hyperliquid tokens across their spellings', () => {
    const hl: MarketMeta = {
      marketId: 'hyperliquid:7',
      venue: 'hyperliquid',
      conditionId: '',
      title: 'BTC above 100k',
      tokens: [
        { outcome: 'Yes', tokenId: '#70' },
        { outcome: 'No', tokenId: '#71' },
      ],
    };
    const hm = new Map<string, MarketMeta>([['hyperliquid:7', hl], ['#70', hl], ['#71', hl]]);
    const order = { venue: 'hyperliquid', marketId: '7', tokenId: '100000070', side: 'buy', filledSize: '3', avgFillPrice: '0.4' };
    expect(filledTokensMissing([order], [{ venue: 'hyperliquid', marketId: '7', tokenId: '+70' }], hm)).toEqual(['#71']);
    const rows = heldFromFills([order], [], hm, new Map([['#70', 3]]));
    expect(rows).toMatchObject([{ tokenId: '#70', avg_price: 0.4 }]);
    expect(toPositionsView({ open: rows, resolved: [] }, hm).positions[0]).toMatchObject({ title: 'BTC above 100k', outcome: 'Yes' });
  });
});
