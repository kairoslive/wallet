/**
 * Prediction venues Kairos trades for a self-custodied wallet. Markets are referred to by a key:
 * Polymarket keeps its bare market id (so existing links keep working), every other venue is
 * `venue:market_id`, since ids collide across venues.
 */

export type Venue = 'polymarket' | 'predictfun' | 'hyperliquid';

export const VENUES: Venue[] = ['polymarket', 'predictfun', 'hyperliquid'];

export interface VenueInfo {
  name: string;
  /** The wallet's network id where the venue settles (Hyperliquid: where deposits come from). */
  networkId: string;
  chainId: number;
  /** What a trade is paid in. */
  currency: string;
}

export const VENUE_INFO: Record<Venue, VenueInfo> = {
  polymarket: { name: 'Polymarket', networkId: 'polygon', chainId: 137, currency: 'pUSD' },
  predictfun: { name: 'Predict.fun', networkId: 'bsc', chainId: 56, currency: 'USDT' },
  // HIP-4 outcome markets on HyperCore; its user-signed actions name Arbitrum, where USDC is deposited from.
  hyperliquid: { name: 'Hyperliquid', networkId: 'arbitrum', chainId: 42161, currency: 'USDC' },
};

export const isVenue = (v: unknown): v is Venue => typeof v === 'string' && (VENUES as string[]).includes(v);

/** The key the wallet uses for a venue's market. */
export function marketKey(venue: Venue, id: string): string {
  return venue === 'polymarket' ? id : `${venue}:${id}`;
}

/** Splits a market key (or a wallet API `venue:market_id` reference) into venue and id. */
export function parseMarketKey(key: string): { venue: Venue; id: string } {
  const i = key.indexOf(':');
  const venue = i > 0 ? key.slice(0, i) : '';
  if (isVenue(venue)) return { venue, id: key.slice(i + 1) };
  return { venue: 'polymarket', id: key };
}
