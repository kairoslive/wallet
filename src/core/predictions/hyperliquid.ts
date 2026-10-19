import { getJson, type Fetch } from '../http';

/**
 * Hyperliquid's own account reads (public, no key), and where deposits go. HIP-4 outcome markets
 * trade on HyperCore spot: the wallet's account there is its own address, USDC arrives through
 * Hyperliquid's Arbitrum bridge, and outcome shares are spot balances.
 */

export const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';
/** Hyperliquid's bridge on Arbitrum: native USDC sent here is credited to the sender's Hyperliquid perps account. */
export const HYPERLIQUID_BRIDGE = '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7';
/** Native (Circle) USDC on Arbitrum, the only token the bridge credits. */
export const ARBITRUM_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
/** Hyperliquid loses deposits below this: the bridge does not credit them. */
export const HYPERLIQUID_MIN_DEPOSIT = 5;

export interface HyperliquidAccount {
  /** Free USDC on spot, which outcome orders spend. */
  spotUsdc: number;
  /** USDC the perps account can release to spot (what a bridge deposit lands in). */
  perpsUsdc: number;
  /** Outcome shares held, by token id (`#<encoding>`, as market data names them). */
  shares: Map<string, number>;
}

interface SpotState {
  balances?: { coin: string; total: string; hold?: string }[];
}

/** HIP-4 outcome assets are numbered from here; `#<encoding>` is asset `100000000 + encoding`. */
const ASSET_BASE = 100_000_000;

/** One form for an outcome token: `#<encoding>`, from `#…`, `+…` (spot balances) or a full asset id. */
export function outcomeToken(id: string): string {
  const digits = id.replace(/^[#+]/, '');
  if (!/^\d+$/.test(digits)) return id;
  const n = Number(digits);
  return `#${n >= ASSET_BASE ? n - ASSET_BASE : n}`;
}

const info = <T>(body: unknown, fetchFn?: Fetch) =>
  getJson<T>(
    HYPERLIQUID_INFO_URL,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    fetchFn,
  );

/** The wallet's Hyperliquid balances. Spot names outcome shares `+<encoding>`; the order book `#<encoding>`. */
export async function hyperliquidAccount(user: string, fetchFn?: Fetch): Promise<HyperliquidAccount> {
  const [spot, perps] = await Promise.all([
    info<SpotState>({ type: 'spotClearinghouseState', user }, fetchFn),
    info<{ withdrawable?: string }>({ type: 'clearinghouseState', user }, fetchFn).catch(() => ({ withdrawable: '0' })),
  ]);
  let spotUsdc = 0;
  const shares = new Map<string, number>();
  for (const b of spot.balances ?? []) {
    const total = Number(b.total);
    if (b.coin === 'USDC') spotUsdc = total - Number(b.hold ?? 0);
    else if (b.coin.startsWith('+') && total > 0) shares.set(outcomeToken(b.coin), total);
  }
  return { spotUsdc, perpsUsdc: Math.max(0, Number(perps.withdrawable ?? 0)), shares };
}
