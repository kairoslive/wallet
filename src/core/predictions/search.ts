import type { MarketLink } from './links';
import type { PredictionEvent, SearchHit } from './types';
import type { Venue } from './venues';

/** One question in search results, however many venues list it. */
export interface SearchResult extends SearchHit {
  /** Every venue the question trades on, primary first. */
  venues: Venue[];
  /** The linked question, when it trades on several venues. */
  linkId?: string;
}

/**
 * Merges hits for the same linked question into one result: the busiest venue's market opens, the
 * volume is the sum, and the order follows the best-ranked hit of each question.
 */
export function groupSearchHits(hits: SearchHit[], links: Record<string, MarketLink>): SearchResult[] {
  const out: SearchResult[] = [];
  const byLink = new Map<string, SearchResult>();
  for (const h of hits) {
    const link = links[h.marketId];
    const existing = link && byLink.get(link.id);
    if (existing) {
      if (!existing.venues.includes(h.venue)) existing.venues.push(h.venue);
      const busier = (h.volume24h ?? 0) > (existing.volume24h ?? 0);
      existing.volume24h = (existing.volume24h ?? 0) + (h.volume24h ?? 0) || undefined;
      if (busier) Object.assign(existing, { marketId: h.marketId, venue: h.venue, price: h.price ?? existing.price });
      existing.image ??= h.image;
      continue;
    }
    const venues = link ? [h.venue, ...link.markets.map((m) => m.venue).filter((v) => v !== h.venue)] : [h.venue];
    const result: SearchResult = {
      ...h,
      // A linked question reads better under its link's title ("Chargers vs. Ravens") than one venue's wording.
      title: link?.title || h.title,
      image: h.image ?? link?.image,
      venues: [...new Set(venues)],
      linkId: link?.id,
    };
    if (link) byLink.set(link.id, result);
    out.push(result);
  }
  return out;
}

/** A market row; questions listed on several venues show once, as the busiest venue's market. */
export type LinkedEvent = PredictionEvent & { markets?: number; linkId?: string };

/**
 * Folds rows for the same linked question into one: the busiest venue's row stays (it opens that
 * market, whose screen prices every venue), volumes add up. Grouped events are left as they are.
 */
export function mergeLinked(events: LinkedEvent[], links: Record<string, MarketLink>): LinkedEvent[] {
  const out: LinkedEvent[] = [];
  const byLink = new Map<string, LinkedEvent>();
  for (const e of events) {
    const link = e.outcomes.length === 1 ? links[e.outcomes[0].marketId] : undefined;
    const id = e.linkId ?? link?.id;
    const seen = id ? byLink.get(id) : undefined;
    if (seen && id) {
      const merged: LinkedEvent = (e.volume24h ?? 0) > (seen.volume24h ?? 0) ? { ...e } : { ...seen };
      merged.volume24h = (seen.volume24h ?? 0) + (e.volume24h ?? 0) || undefined;
      merged.markets = (seen.markets ?? 1) + (e.markets ?? 1);
      merged.linkId = id;
      merged.image ??= seen.image ?? e.image;
      out[out.indexOf(seen)] = merged;
      byLink.set(id, merged);
      continue;
    }
    const row: LinkedEvent = id ? { ...e, linkId: id, markets: e.markets ?? 1 } : e;
    if (id) byLink.set(id, row);
    out.push(row);
  }
  return out;
}
