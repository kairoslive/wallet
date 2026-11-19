import type { CatalogEvent, CatalogListing, CatalogPage, MatchedMarket } from '../../src/core/predictions/discover';

export const listing: CatalogListing = {
  exchange_id: 'hyperliquid',
  market_id: '35891',
  token_id_yes: '#358911',
  token_id_no: '#358910',
  outcome_yes_label: 'GSW',
  outcome_no_label: 'DAL',
  tick_size: 0.0001,
  open: true,
  executable: true,
};

export const matchedMarket: MatchedMarket = {
  id: '9e5d06ff-8cf1-47f2-9817-68836a9eff94',
  event_id: 'ev_cG9seW1hcmtldDoxMzEyMzI3',
  title: 'Match winner',
  status: 'live',
  category: 'Sports',
  start_time: '2026-11-19T01:00:00Z',
  close_time: '2026-11-19T02:30:00Z',
  listed_at: '2026-11-12T02:42:21.171Z',
  outcomes: { yes: 'Warriors', no: 'Mavericks' },
  venues: [
    {
      ...listing,
      exchange_id: 'kalshi',
      market_id: 'NBA-GSW',
      market_id_no: 'NBA-DAL',
      token_id_yes: 'NBA-GSW::0',
      token_id_no: 'NBA-DAL::0',
      executable: false,
    },
    listing,
  ],
  executable_venues: ['hyperliquid'],
  route: { provider: 'hyperliquid', market_id: '35891', market: 'hyperliquid:35891' },
  books: null,
};

export const catalogEvent: CatalogEvent = {
  id: matchedMarket.event_id,
  title: 'Warriors vs. Mavericks',
  category: 'Sports',
  image: null,
  venues: ['hyperliquid', 'kalshi'],
  venue_events: [
    { exchange_id: 'hyperliquid', event_id: '35891' },
    { exchange_id: 'kalshi', event_id: 'NBA-GSW-DAL' },
  ],
  status: 'live',
  market_count: 1,
  start_time: matchedMarket.start_time,
  first_close_time: matchedMarket.close_time,
  last_close_time: matchedMarket.close_time,
  markets: [matchedMarket],
};

export const catalogPage: CatalogPage = {
  events: [catalogEvent],
  count: 1,
  total: 2,
  next_cursor: 'next_page',
  has_more: true,
  as_of: '2026-11-19T01:00:00Z',
};
