import { describe, expect, it } from 'vitest';
import { describeResolution } from '../../src/core/predictions/resolution';
import { getResolution } from '../../src/core/predictions/client';
import { mergeLinked, type LinkedEvent } from '../../src/core/predictions/search';
import { toLink } from '../../src/core/predictions/links';
import type { Resolution } from '../../src/core/predictions/types';

const market = {
  tokens: [
    { outcome: 'Chargers', tokenId: 'a' },
    { outcome: 'Ravens', tokenId: 'b' },
  ],
  endDate: '2026-11-17T01:15:00Z',
  status: 'open',
};
const NOW = Date.parse('2026-11-14T00:00:00Z');
const res = (r: Partial<Resolution>): Resolution => ({ status: 'initialized', disputes: 0, ...r });

describe('describeResolution', () => {
  it('is open before the end date, then waits for a result', () => {
    expect(describeResolution(market, res({}), NOW).stage).toBe('open');
    expect(describeResolution(market, res({}), Date.parse('2026-11-18T00:00:00Z'))).toMatchObject({
      stage: 'awaiting',
      title: 'Waiting for the result',
    });
  });

  it('names a proposed result and the time left to dispute it', () => {
    const d = describeResolution(
      market,
      res({ status: 'proposed', proposedPrice: 1, challengeEndsAt: new Date(NOW + 90 * 60_000).toISOString() }),
      NOW,
    );
    expect(d).toMatchObject({ stage: 'proposed', title: 'Result proposed: Chargers' });
    expect(d.detail).toBe('Final in 2h unless disputed');
    expect(describeResolution(market, res({ status: 'proposed', proposedPrice: 0 }), NOW).title).toBe('Result proposed: Ravens');
  });

  it('flags disputes and names the winner once paid out', () => {
    expect(describeResolution(market, res({ status: 'disputed', disputes: 1 }), NOW).stage).toBe('disputed');
    expect(describeResolution(market, res({ status: 'resolved', payouts: [0, 1] }), NOW)).toMatchObject({
      stage: 'resolved',
      winner: 'Ravens',
    });
    expect(describeResolution(market, res({ status: 'resolved', payouts: [0.5, 0.5] }), NOW).title).toBe('Resolved as a split');
  });

  it('reads the market data resolution payload', async () => {
    const fetchFn = (async () =>
      Response.json({
        status: 'resolved',
        proposed_price: '1000000000000000000',
        payout_numerators: ['1', '0'],
        dispute_count: 0,
        resolved_ts: '2026-10-16T21:19:00Z',
      })) as unknown as typeof fetch;
    const r = await getResolution(
      { marketDataUrl: 'https://md', dataUrl: '', executionUrl: '', partnerId: '' },
      'predictfun:1',
      fetchFn,
    );
    expect(r).toMatchObject({ status: 'resolved', proposedPrice: 1, payouts: [1, 0], resolvedAt: '2026-10-16T21:19:00Z' });
  });
});

describe('mergeLinked', () => {
  const ev = (id: string, venue: LinkedEvent['venue'], volume24h: number): LinkedEvent => ({
    id,
    venue,
    title: id,
    volume24h,
    outcomes: [{ marketId: id, conditionId: '', title: id }],
  });
  it('shows a question listed on several venues once, under its busiest market', () => {
    const link = toLink({
      id: 'L',
      venues: [
        { provider: 'polymarket', marketId: '0x1', streamKey: 'pm', tokenIdYes: 'a', tokenIdNo: 'b', executable: true },
        { provider: 'predictfun', marketId: '9', tokenIdYes: 'c', tokenIdNo: 'd', executable: true },
      ],
    });
    const out = mergeLinked([ev('pm', 'polymarket', 100), ev('other', 'polymarket', 50), ev('predictfun:9', 'predictfun', 300)], {
      pm: link,
      'predictfun:9': link,
    });
    expect(out.map((e) => [e.id, e.markets, e.volume24h])).toEqual([
      ['predictfun:9', 2, 400],
      ['other', undefined, 50],
    ]);
  });
});
