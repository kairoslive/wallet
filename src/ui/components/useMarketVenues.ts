import { useEffect, useMemo, useState } from 'react';
import type { BookState, OutcomeBook } from '../../core/predictions/orderbook';
import type { LinkedMarket, MarketLink } from '../../core/predictions/links';
import type { FeeModel, MarketDetail } from '../../core/predictions/types';
import type { Venue } from '../../core/predictions/venues';
import { allInPrice } from '../../core/predictions/router';
import { api } from '../lib/api';
import { fetchQuery } from '../lib/query';
import { keys } from '../lib/predictQueries';
import { useOrderbooks, type FeedStatus } from './useOrderbook';

/** One venue's listing of one outcome. */
export interface SideVenue {
  venue: Venue;
  /** Wallet market key of this venue's market. */
  key: string;
  bookKey: string;
  /** The venue's own name for this outcome. */
  outcome: string;
  tokenId: string;
  book?: OutcomeBook;
  feed: FeedStatus;
  tick: number;
  fee?: FeeModel;
  primary: boolean;
}

/** One outcome of the market, across every venue that lists it. */
export interface MarketSide {
  index: number;
  /** The outcome's name on the market the user opened. */
  name: string;
  venues: SideVenue[];
  /** Cheapest all-in ask across venues. */
  bestAsk?: { price: number; allIn: number; venue: Venue };
  /** Highest bid across venues. */
  bestBid?: { price: number; venue: Venue };
}

export interface MarketVenues {
  sides: MarketSide[];
  /** Live if any venue's book is live. */
  feed: FeedStatus;
  /** The opened market's own book (the order book sheet shows it). */
  primaryBook?: BookState;
  /** Every venue market of this question, the opened one first. */
  markets: { venue: Venue; key: string; detail?: MarketDetail }[];
}

/** Market details for linked venues, through the shared cache. */
function useMarketDetails(marketKeys: string[]): Record<string, MarketDetail> {
  const [details, setDetails] = useState<Record<string, MarketDetail>>({});
  const joined = marketKeys.join('|');
  useEffect(() => {
    let stale = false;
    for (const k of joined ? joined.split('|') : []) {
      fetchQuery(keys.market(k), () => api.predictionMarket(k), 20_000)
        .then((d) => !stale && setDetails((cur) => (cur[k] === d ? cur : { ...cur, [k]: d })))
        .catch(() => undefined);
    }
    return () => {
      stale = true;
    };
  }, [joined]);
  return details;
}

/** The book key the stream uses for a market: Polymarket by condition id, others by market key. */
export const bookKeyOf = (m: Pick<MarketDetail, 'venue' | 'conditionId' | 'marketId'>) =>
  m.venue === 'polymarket' ? m.conditionId : m.marketId;

/**
 * Lines up the market's outcomes across every venue Kairos links it to, matched by token id (venues
 * name and order sides differently), each with its live book, tick and fee.
 */
export function useMarketVenues(market: MarketDetail | undefined, link: MarketLink | null | undefined): MarketVenues {
  const primaryLinked =
    market && link ? link.markets.find((m) => m.key === market.marketId || m.venueMarketId === market.conditionId) : undefined;
  const others: LinkedMarket[] = useMemo(
    () => (market && link && primaryLinked ? link.markets.filter((m) => m !== primaryLinked && m.venue !== market.venue) : []),
    [market, link, primaryLinked],
  );
  const details = useMarketDetails(others.map((o) => o.key));
  const bookKeys = market ? [bookKeyOf(market), ...others.map((o) => o.bookKey)] : [];
  const books = useOrderbooks(bookKeys);

  return useMemo(() => {
    if (!market) return { sides: [], feed: 'connecting' as FeedStatus, markets: [] };
    const primaryKey = bookKeyOf(market);
    const primaryFeed = books[primaryKey];
    const findBook = (b: BookState | undefined, tokenId: string, name: string) =>
      b?.outcomes.find((o) => o.tokenId && o.tokenId === tokenId) ??
      b?.outcomes.find((o) => o.name.toLowerCase() === name.toLowerCase());

    const sides: MarketSide[] = market.tokens.map((t, index) => {
      const venues: SideVenue[] = [
        {
          venue: market.venue,
          key: market.marketId,
          bookKey: primaryKey,
          outcome: t.outcome,
          tokenId: t.tokenId,
          book: findBook(primaryFeed?.book, t.tokenId, t.outcome),
          feed: primaryFeed?.status ?? 'connecting',
          tick: market.tickSize,
          fee: market.fee,
          primary: true,
        },
      ];
      // Which side of the link this outcome is: by token id, falling back to order for a plain Yes/No pair.
      const side = primaryLinked?.tokenYes === t.tokenId ? 'yes' : primaryLinked?.tokenNo === t.tokenId ? 'no' : undefined;
      for (const o of side ? others : []) {
        const d = details[o.key];
        const tokenId = side === 'yes' ? o.tokenYes : o.tokenNo;
        const token = d?.tokens.find((x) => x.tokenId === tokenId);
        if (!d || !token || d.status !== 'open') continue;
        const f = books[o.bookKey];
        venues.push({
          venue: o.venue,
          key: o.key,
          bookKey: o.bookKey,
          outcome: token.outcome,
          tokenId,
          book: findBook(f?.book, tokenId, token.outcome),
          feed: f?.status ?? 'connecting',
          // Hyperliquid prices carry up to 5 decimals.
          tick: o.venue === 'hyperliquid' ? Math.min(d.tickSize, 0.00001) : d.tickSize,
          fee: d.fee,
          primary: false,
        });
      }
      let bestAsk: MarketSide['bestAsk'];
      let bestBid: MarketSide['bestBid'];
      for (const v of venues) {
        const a = v.book?.asks[0];
        if (a) {
          const allIn = allInPrice(v.fee, a.price);
          if (!bestAsk || allIn < bestAsk.allIn) bestAsk = { price: a.price, allIn, venue: v.venue };
        }
        const b = v.book?.bids[0];
        if (b && (!bestBid || b.price > bestBid.price)) bestBid = { price: b.price, venue: v.venue };
      }
      return { index, name: t.outcome, venues, bestAsk, bestBid };
    });
    const feeds = bookKeys.map((k) => books[k]?.status);
    const feed: FeedStatus = feeds.includes('live') ? 'live' : (primaryFeed?.status ?? 'connecting');
    return {
      sides,
      feed,
      primaryBook: primaryFeed?.book,
      markets: [
        { venue: market.venue, key: market.marketId, detail: market },
        ...others.map((o) => ({ venue: o.venue, key: o.key, detail: details[o.key] })),
      ],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, primaryLinked, others, details, books]);
}
