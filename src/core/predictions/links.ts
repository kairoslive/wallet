import { getJson, joinUrl, type Fetch } from '../http';
import type { KairosConfig } from './types';
import { isVenue, marketKey, parseMarketKey, type Venue } from './venues';

/**
 * Cross-venue links: the same real-world question listed on several venues. Kairos' data API
 * publishes approved links (`/market-links/lookup`), each with every venue's market and the token
 * ids of its two sides. The wallet uses them to price a buy across venues and route it.
 */

/** One venue's market inside a link, keyed the way the wallet keys markets. */
export interface LinkedMarket {
  venue: Venue;
  /** Wallet market key (see venues.ts): Polymarket by its numeric market id, others `venue:id`. */
  key: string;
  /** The venue's own market id (Polymarket: the condition id). */
  venueMarketId: string;
  /** What the order book stream keys this market by (Polymarket: condition id). */
  bookKey: string;
  /** Token id of the link's `yes` side and `no` side on this venue. */
  tokenYes: string;
  tokenNo: string;
}

export interface MarketLink {
  id: string;
  title: string;
  image?: string;
  /** What each side of the link means, e.g. `{ yes: 'Chargers', no: 'Ravens' }`. */
  sideLabels: { yes: string; no: string };
  /** Venues the wallet can trade this question on. */
  markets: LinkedMarket[];
}

interface LinkVenue {
  provider: string;
  marketId: string;
  streamKey?: string | null;
  tokenIdYes?: string | null;
  tokenIdNo?: string | null;
  executable?: boolean;
}

interface LinkRow {
  id: string;
  title?: string;
  image?: string | null;
  sideLabels?: { yes?: string; no?: string } | null;
  venues?: LinkVenue[];
}

/** The reference `/market-links/lookup` takes for a wallet market key. Polymarket matches its numeric id as the stream key. */
export function linkRef(key: string): string {
  const { venue, id } = parseMarketKey(key);
  return `${venue}:${id}`;
}

export function toLink(row: LinkRow): MarketLink {
  const markets: LinkedMarket[] = [];
  for (const v of row.venues ?? []) {
    if (!isVenue(v.provider) || !v.executable || !v.tokenIdYes || !v.tokenIdNo) continue;
    const venue = v.provider;
    // Polymarket links carry the condition id as the market id and the numeric id as the stream key.
    const walletId = venue === 'polymarket' ? (v.streamKey ?? v.marketId) : v.marketId;
    markets.push({
      venue,
      key: marketKey(venue, walletId),
      venueMarketId: v.marketId,
      bookKey: venue === 'polymarket' ? v.marketId : marketKey(venue, v.marketId),
      tokenYes: v.tokenIdYes,
      tokenNo: v.tokenIdNo,
    });
  }
  return {
    id: row.id,
    title: row.title ?? '',
    image: row.image ?? undefined,
    sideLabels: { yes: row.sideLabels?.yes || 'Yes', no: row.sideLabels?.no || 'No' },
    markets,
  };
}

/**
 * The link holding each market, by wallet market key. Markets listed on one venue only are left
 * out, as are links the wallet can trade on just one venue.
 */
export async function lookupLinks(cfg: KairosConfig, keys: string[], fetchFn?: Fetch): Promise<Record<string, MarketLink>> {
  const unique = [...new Set(keys)];
  const out: Record<string, MarketLink> = {};
  // The lookup takes at most 100 references per call.
  for (let i = 0; i < unique.length; i += 100) {
    const batch = unique.slice(i, i + 100);
    const refs = batch.map(linkRef);
    const res = await getJson<{ links?: Record<string, LinkRow> }>(
      joinUrl(cfg.dataUrl, `market-links/lookup?markets=${refs.map(encodeURIComponent).join(',')}`),
      {},
      fetchFn,
    );
    batch.forEach((key, j) => {
      const row = res.links?.[refs[j]];
      if (!row) return;
      const link = toLink(row);
      if (link.markets.length > 1) out[key] = link;
    });
  }
  return out;
}

/** Which side of the link an outcome token is on, if either. */
export function linkSide(market: LinkedMarket, tokenId: string): 'yes' | 'no' | undefined {
  if (market.tokenYes === tokenId) return 'yes';
  if (market.tokenNo === tokenId) return 'no';
  return undefined;
}
