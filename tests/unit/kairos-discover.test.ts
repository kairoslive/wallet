import { describe, expect, it } from 'vitest';
import { catalogTradeTarget, getCatalogEvent, getMatchedMarket, listCatalog } from '../../src/core/predictions/discover';
import { decodeSyntheticQuote } from '../../src/core/predictions/orderbook';
import { catalogEvent, catalogPage, listing, matchedMarket } from '../helpers/kairos-catalog';
import { mockFetch } from './helpers/mockFetch';

const MD = 'https://md.kairos.trade/';

describe('Kairos catalog', () => {
  it('forwards all event filters without signing or attaching wallet identity', async () => {
    const fetch = mockFetch(() => catalogPage);
    expect(
      await listCatalog(
        MD,
        {
          q: ' Warriors ',
          category: 'Sports',
          venues: ['kalshi', 'hyperliquid'],
          executableVenues: ['hyperliquid'],
          statuses: ['upcoming', 'live'],
          minVenues: 3,
          routable: true,
          startsAfter: '2026-11-18T00:00:00Z',
          startsBefore: '2026-11-19T04:00:00Z',
          closesAfter: '2026-11-18T00:00:00Z',
          closesBefore: '2026-11-19T06:00:00Z',
          sort: 'start_time',
          includeMarkets: false,
          limit: 20,
          cursor: 'A+/=B&?',
        },
        fetch,
      ),
    ).toEqual(catalogPage);
    const url = new URL(fetch.calls[0].url);
    expect(url.pathname).toBe('/v1/events');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'Warriors',
      category: 'Sports',
      venue: 'kalshi,hyperliquid',
      executable_venue: 'hyperliquid',
      status: 'upcoming,live',
      min_venues: '3',
      routable: 'true',
      starts_after: '2026-11-18T00:00:00Z',
      starts_before: '2026-11-19T04:00:00Z',
      closes_after: '2026-11-18T00:00:00Z',
      closes_before: '2026-11-19T06:00:00Z',
      sort: 'start_time',
      include_markets: 'false',
      limit: '20',
      cursor: 'A+/=B&?',
    });
    expect([...new Headers(fetch.calls[0].init.headers)]).toEqual([]);
  });

  it('looks up canonical event and matched-market ids independently', async () => {
    const fetch = mockFetch((url) =>
      url.pathname.startsWith('/v1/events/') ? { event: catalogEvent } : { market: matchedMarket, event: catalogEvent },
    );
    expect((await getCatalogEvent(MD, 'ev_test/path?', fetch)).event).toEqual(catalogEvent);
    expect((await getMatchedMarket(MD, matchedMarket.id, fetch)).market).toEqual(matchedMarket);
    expect(fetch.calls.map(({ url }) => new URL(url).pathname)).toEqual([
      '/v1/events/ev_test%2Fpath%3F',
      `/v1/matched-markets/${matchedMarket.id}`,
    ]);
  });

  it('keeps canonical sides by token id when a venue lists teams in a different order', () => {
    expect(catalogTradeTarget(matchedMarket, 'yes')).toEqual({ id: 'hyperliquid:35891', token: '#358911' });
    expect(catalogTradeTarget(matchedMarket, 'no')).toEqual({ id: 'hyperliquid:35891', token: '#358910' });
  });

  it('only opens live executable venue listings with a token for the chosen side', () => {
    const closedAnchor = {
      ...matchedMarket,
      executable_venues: ['hyperliquid', 'predictfun'] as const,
      venues: [
        ...matchedMarket.venues.slice(0, 1),
        { ...listing, open: false },
        { ...listing, exchange_id: 'predictfun' as const, market_id: '17', token_id_yes: '171', token_id_no: null },
      ],
    };
    const market = { ...closedAnchor, executable_venues: [...closedAnchor.executable_venues] };
    expect(catalogTradeTarget(market, 'yes')).toEqual({ id: 'predictfun:17', token: '171' });
    expect(catalogTradeTarget(market, 'no')).toBeUndefined();
    expect(catalogTradeTarget({ ...matchedMarket, status: 'resolved' }, 'yes')).toBeUndefined();
    expect(catalogTradeTarget({ ...matchedMarket, executable_venues: [] }, 'yes')).toBeUndefined();
  });
});

describe('matched-market price stream', () => {
  const id = 'syn_4f1627ce6441877f';
  const frame = (status: number, price: number) => {
    const varint = (value: number) => {
      const bytes = [];
      while (value > 127) {
        bytes.push((value % 128) | 128);
        value = Math.floor(value / 128);
      }
      return [...bytes, value];
    };
    const level = [8, ...varint(price), 16, ...varint(1_000_000_000)];
    return Uint8Array.from([
      0x53,
      1,
      10,
      id.length,
      ...new TextEncoder().encode(id),
      16,
      12,
      24,
      2,
      32,
      status,
      50,
      level.length,
      ...level,
      64,
      9,
    ]);
  };

  it('decodes versioned fee-inclusive asks and clears non-executable quotes', () => {
    expect(decodeSyntheticQuote(frame(1, 587_500_000))).toEqual({ id, epoch: 2n, sequence: 12n, ask: 0.5875 });
    expect(decodeSyntheticQuote(frame(3, 587_500_000))?.ask).toBeUndefined();
    const unsupported = frame(1, 100_000_000);
    unsupported[1] = 2;
    expect(decodeSyntheticQuote(unsupported)).toBeUndefined();
  });
});
