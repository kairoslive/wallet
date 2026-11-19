import { getJson, joinUrl, type Fetch } from '../http';
import { isVenue, marketKey, type Venue } from './venues';

/** The public catalog also includes listings that a self-custody wallet cannot trade. */
export type CatalogVenue = Venue | 'kalshi';
export type CatalogStatus = 'upcoming' | 'live' | 'open' | 'resolving' | 'ended' | 'closed' | 'resolved';
export type CatalogSort = 'start_time' | 'close_time' | 'newest' | 'markets';
export type CatalogSide = 'yes' | 'no';

export interface CatalogListing {
  exchange_id: CatalogVenue;
  market_id: string;
  market_id_no?: string;
  token_id_yes: string | null;
  token_id_no: string | null;
  outcome_yes_label: string;
  outcome_no_label: string;
  title?: string;
  tick_size: number | null;
  open: boolean;
  executable: boolean;
}

export interface MatchedMarket {
  id: string;
  event_id: string;
  title: string;
  status: CatalogStatus;
  category: string | null;
  image?: string | null;
  start_time: string | null;
  close_time: string | null;
  listed_at: string;
  /** The meaning of YES/NO on this market, independent of venue labeling and token order. */
  outcomes: Record<CatalogSide, string>;
  venues: CatalogListing[];
  executable_venues: Venue[];
  route: { provider: Venue; market_id: string; market: string } | null;
  /** Opaque ids for the canonical sides' union books. */
  books: Record<CatalogSide, string | null> | null;
}

export interface CatalogEvent {
  id: string;
  title: string;
  category: string | null;
  image: string | null;
  venues: CatalogVenue[];
  venue_events: { exchange_id: CatalogVenue; event_id: string }[];
  status: CatalogStatus;
  market_count: number;
  start_time: string | null;
  first_close_time: string | null;
  last_close_time: string | null;
  markets?: MatchedMarket[];
}

export interface CatalogPage {
  events: CatalogEvent[];
  count: number;
  total: number;
  next_cursor: string | null;
  has_more: boolean;
  as_of: string;
}

export interface CatalogQuery {
  q?: string;
  category?: string;
  venues?: CatalogVenue[];
  executableVenues?: Venue[];
  statuses?: CatalogStatus[];
  minVenues?: number;
  routable?: boolean;
  startsAfter?: string;
  startsBefore?: string;
  closesAfter?: string;
  closesBefore?: string;
  sort?: CatalogSort;
  includeMarkets?: boolean;
  limit?: number;
  cursor?: string;
}

export async function listCatalog(baseUrl: string, query: CatalogQuery, fetchFn?: Fetch): Promise<CatalogPage> {
  const params = new URLSearchParams();
  const values = {
    q: query.q?.trim(),
    category: query.category,
    venue: query.venues?.join(','),
    executable_venue: query.executableVenues?.join(','),
    status: query.statuses?.join(','),
    min_venues: query.minVenues,
    routable: query.routable,
    starts_after: query.startsAfter,
    starts_before: query.startsBefore,
    closes_after: query.closesAfter,
    closes_before: query.closesBefore,
    sort: query.sort,
    include_markets: query.includeMarkets,
    limit: query.limit,
    cursor: query.cursor,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  return getJson(joinUrl(baseUrl, `v1/events?${params}`), {}, fetchFn);
}

export function getCatalogEvent(baseUrl: string, id: string, fetchFn?: Fetch): Promise<{ event: CatalogEvent; as_of: string }> {
  return getJson(joinUrl(baseUrl, `v1/events/${encodeURIComponent(id)}`), {}, fetchFn);
}

export interface MatchedMarketResult {
  market: MatchedMarket;
  event: Pick<CatalogEvent, 'id' | 'title' | 'category'>;
  as_of: string;
}

export function getMatchedMarket(baseUrl: string, id: string, fetchFn?: Fetch): Promise<MatchedMarketResult> {
  return getJson(joinUrl(baseUrl, `v1/matched-markets/${encodeURIComponent(id)}`), {}, fetchFn);
}

/** Start from the router's anchor when possible. Carry the selected token, never the venue's outcome index. */
export function catalogTradeTarget(market: MatchedMarket, side: CatalogSide): { id: string; token: string } | undefined {
  if (market.status === 'closed' || market.status === 'resolved') return undefined;
  const tokenOf = (v: CatalogListing) => (side === 'yes' ? v.token_id_yes : v.token_id_no);
  const open = market.venues.filter(
    (v) => isVenue(v.exchange_id) && v.open && v.executable && market.executable_venues.includes(v.exchange_id) && tokenOf(v),
  );
  const listing = open.find((v) => v.exchange_id === market.route?.provider && v.market_id === market.route.market_id) ?? open[0];
  if (!listing || !isVenue(listing.exchange_id)) return undefined;
  const token = tokenOf(listing);
  if (token) return { id: marketKey(listing.exchange_id, listing.market_id), token };
}
