import { getAddress, parseAbi } from 'viem';
import { getJson, joinUrl, type Fetch } from '../http';
import { parseUnits } from '../format';
import { publicClient } from '../evm/client';
import type { EvmNetwork } from '../types';
import { CTF_ADDRESS, PREDICTFUN_CTFS } from './verify';
import type { ApiRecord, KairosConfig } from './types';
import { outcomeToken } from './hyperliquid';
import { isVenue, marketKey, parseMarketKey, type Venue } from './venues';

/**
 * Turns the wallet API's bare order and position records (ids, sizes, bps prices) into rows a
 * person can read: market title, outcome label, image, live price, value and P&L. Older nodes send
 * Polymarket's raw rows; multi-venue nodes send shared rows (`venue`, `marketId`, `size`, …).
 */

export interface MarketMeta {
  /** Market key (what the market screen opens; see venues.ts). */
  marketId: string;
  venue: Venue;
  conditionId: string;
  title: string;
  /** Event title for grouped markets ("Fed Decision in October?"). */
  eventTitle?: string;
  /** Short outcome label within the event ("No change"). */
  label?: string;
  image?: string;
  endDate?: string;
  status?: string;
  tokens: { outcome: string; tokenId: string; price?: number }[];
}

export interface PositionView {
  key: string;
  venue: Venue;
  marketId?: string;
  title: string;
  subtitle?: string;
  image?: string;
  outcome: string;
  redemption?: { market: string; outcome: 0 | 1; amountRaw: string };
  shares: number;
  avgPrice?: number;
  price?: number;
  cost?: number;
  value?: number;
  pnl?: number;
  pnlPct?: number;
  realizedPnl?: number;
  /** open: still trading. won/lost: market resolved. closed: sold, kept for its realized P&L. */
  state: 'open' | 'won' | 'lost' | 'closed';
  endDate?: string;
  lastTradeAt?: string;
  closedAt?: string;
}

export interface PositionsView {
  positions: PositionView[];
  /** Positions sold down to nothing, newest first, with what they made or lost. */
  history: PositionView[];
  totals: { value: number; cost: number; pnl: number; pnlPct?: number; realized?: number };
}

/** Less than this many shares is leftover from a sale, not a position. */
export const DUST_SHARES = 0.01;

export interface OrderView {
  id: string;
  venue: Venue;
  marketId?: string;
  title: string;
  subtitle?: string;
  image?: string;
  side: 'buy' | 'sell';
  outcome: string;
  price?: number;
  shares: number;
  filled: number;
  avgFillPrice?: number;
  status: string;
  open: boolean;
  kind?: string;
  timeInForce?: string;
  createdAt?: string;
  fee?: number;
  error?: string;
}

const OPEN_STATUSES = new Set(['pending', 'queued', 'locked', 'executing', 'live', 'partial', 'open', 'orphaned']);

const str = (r: ApiRecord, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = r[k];
    if (v !== undefined && v !== null && v !== '') return String(v);
  }
  return undefined;
};
const num = (r: ApiRecord, ...keys: string[]): number | undefined => {
  const v = str(r, ...keys);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

// ------------------------------------------------------------------ market lookup

interface MdMarket {
  market_id: string;
  condition_id: string;
  title?: string;
  end_date?: string | null;
  status?: string;
  outcomes: { outcome: string; token_id: string }[];
}

interface DiscoverMarket {
  id: string;
  title?: string;
  image?: string | null;
  price?: number | null;
  outcomes?: { id: string; title?: string; outcomeLabel?: string | null; image?: string | null; price?: number | null }[];
}

/** The market key a record refers to: shared rows name their venue, older rows are Polymarket. */
export function recordMarket(r: ApiRecord): string | undefined {
  const venue = str(r, 'venue');
  const id = str(r, 'marketId', 'market_id', 'condition_id');
  if (isVenue(venue) && id) return normalizeKey(marketKey(venue, id));
  const ref = str(r, 'market');
  if (ref) return normalizeKey(ref.startsWith('polymarket:') ? ref.slice('polymarket:'.length) : ref);
  return id ? normalizeKey(id) : undefined;
}

/** Marks name a market by condition id; Hyperliquid has none and uses its market id. */
const markContract = (m: Pick<MarketMeta, 'conditionId' | 'marketId'>) => m.conditionId || parseMarketKey(m.marketId).id;

/** Condition ids are hex and compared in lower case. */
const normalizeKey = (key: string) => (key.startsWith('0x') ? key.toLowerCase() : key);

/**
 * Metadata for markets by key (Polymarket by condition id or numeric id), keyed by both and by
 * token id. Per venue, three best-effort calls: market data batch (ids, tokens), discover (images,
 * event titles) and marks (live prices). Missing pieces just leave fields empty.
 */
export async function lookupMarkets(cfg: KairosConfig, keys: string[], fetchFn?: Fetch): Promise<Map<string, MarketMeta>> {
  const out = new Map<string, MarketMeta>();
  const byVenue = new Map<Venue, string[]>();
  for (const key of new Set(keys.filter(Boolean))) {
    const { venue, id } = parseMarketKey(key);
    byVenue.set(venue, [...(byVenue.get(venue) ?? []), id]);
  }
  await Promise.all([...byVenue].map(([venue, ids]) => lookupVenue(cfg, venue, ids.slice(0, 200), out, fetchFn)));
  return out;
}

async function lookupVenue(cfg: KairosConfig, venue: Venue, unique: string[], out: Map<string, MarketMeta>, fetchFn?: Fetch) {
  const batch = await getJson<{ markets: Record<string, MdMarket> }>(
    joinUrl(cfg.marketDataUrl, 'v1/markets/batch'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: venue, market_ids: unique }),
    },
    fetchFn,
  ).catch(() => ({ markets: {} as Record<string, MdMarket> }));

  const metas = new Map<string, MarketMeta>();
  for (const m of Object.values(batch.markets ?? {})) {
    if (!m?.market_id || metas.has(m.market_id)) continue;
    metas.set(m.market_id, {
      marketId: marketKey(venue, m.market_id),
      venue,
      conditionId: m.condition_id,
      title: m.title ?? '',
      endDate: m.end_date ?? undefined,
      status: m.status,
      tokens: (m.outcomes ?? []).map((o) => ({ outcome: o.outcome, tokenId: o.token_id })),
    });
  }
  if (!metas.size) return;

  const numericIds = [...metas.keys()];
  const [discover, marks] = await Promise.all([
    getJson<{ markets?: DiscoverMarket[] }>(
      joinUrl(
        cfg.dataUrl,
        `api/markets/discover/v2?${new URLSearchParams({ provider: venue, market_ids: numericIds.join(','), limit: String(numericIds.length) })}`,
      ),
      {},
      fetchFn,
    ).catch(() => ({ markets: [] as DiscoverMarket[] })),
    getJson<{ marks: { token_id: string; price: number }[] }>(
      joinUrl(
        cfg.marketDataUrl,
        `v1/marks?${new URLSearchParams({
          provider: venue,
          pairs: [...metas.values()].flatMap((m) => m.tokens.map((t) => `${markContract(m)}:${t.tokenId}`)).join(','),
        })}`,
      ),
      {},
      fetchFn,
    ).catch(() => ({ marks: [] as { token_id: string; price: number }[] })),
  ]);

  /** The listing's last price for a market's first outcome, for venues without marks. */
  const listed = new Map<MarketMeta, number>();
  for (const ev of discover.markets ?? []) {
    const outcomes = ev.outcomes?.length ? ev.outcomes : [{ id: ev.id, title: ev.title, price: ev.price }];
    for (const o of outcomes) {
      const meta = metas.get(String(o.id));
      if (!meta) continue;
      if (typeof o.price === 'number') listed.set(meta, o.price);
      meta.image = o.image ?? ev.image ?? undefined;
      if (outcomes.length > 1 && ev.title) {
        meta.eventTitle = ev.title;
        meta.label = o.outcomeLabel ?? undefined;
      }
    }
  }
  const markByToken = new Map((marks.marks ?? []).map((m) => [m.token_id, m.price / 100]));
  for (const meta of metas.values()) {
    for (const t of meta.tokens) t.price = markByToken.get(t.tokenId);
    // Predict.fun and Hyperliquid have no marks: price a two-outcome market from its listing (first outcome p, second 1 − p).
    const first = listed.get(meta);
    if (first !== undefined && meta.tokens.length === 2 && meta.tokens.every((t) => t.price === undefined)) {
      meta.tokens[0].price = first;
      meta.tokens[1].price = Math.max(0, 1 - first);
    }
    out.set(meta.marketId, meta);
    if (meta.conditionId) out.set(marketKey(venue, meta.conditionId.toLowerCase()), meta);
    for (const t of meta.tokens) out.set(t.tokenId, meta);
  }
}

export function metaFor(metas: Map<string, MarketMeta>, r: ApiRecord): MarketMeta | undefined {
  const key = recordMarket(r);
  const tokenId = str(r, 'tokenId', 'token_id');
  return (key ? metas.get(key) : undefined) ?? (tokenId ? metas.get(tokenId) : undefined);
}

/** The venue a record is on: shared rows name it, older rows are Polymarket. */
function venueOf(meta: MarketMeta | undefined, r: ApiRecord): Venue {
  const v = str(r, 'venue');
  return isVenue(v) ? v : (meta?.venue ?? parseMarketKey(recordMarket(r) ?? '').venue);
}

/** Title and subtitle for a market: grouped markets show the event, then the outcome label. */
function titles(meta: MarketMeta | undefined, fallback: string): { title: string; subtitle?: string } {
  if (!meta) return { title: fallback };
  if (meta.eventTitle && meta.label) return { title: meta.eventTitle, subtitle: meta.label };
  return { title: meta.title || fallback };
}

function outcomeOf(meta: MarketMeta | undefined, r: ApiRecord): string {
  const named = str(r, 'outcome');
  if (named) return named;
  const tokenId = str(r, 'tokenId', 'token_id');
  return meta?.tokens.find((t) => t.tokenId === tokenId)?.outcome ?? '—';
}

// ------------------------------------------------------------------ positions

export function toPositionsView(
  data: { open: ApiRecord[]; resolved: ApiRecord[] },
  metas: Map<string, MarketMeta>,
): PositionsView {
  const rows: PositionView[] = [];
  const add = (r: ApiRecord, resolved: boolean) => {
    const shares = num(r, 'net_size', 'size', 'shares') ?? 0;
    if (!resolved && !(shares >= DUST_SHARES)) return;
    const meta = metaFor(metas, r);
    const tokenId = str(r, 'tokenId', 'token_id');
    const bps = num(r, 'avg_entry_price_bps');
    const avgPrice = bps !== undefined ? bps / 10_000 : num(r, 'avg_price', 'avgPrice');
    const state: PositionView['state'] = !resolved ? 'open' : r.redeemable === true ? 'won' : 'lost';
    const outcomeIndex = meta?.tokens.findIndex((t) => t.tokenId === tokenId);
    const exactSize = str(r, 'net_size', 'size', 'shares');
    let redemption: PositionView['redemption'];
    if (
      state === 'won' &&
      meta?.venue === 'polymarket' &&
      /^0x0[123][0-9a-f]{60}00$/i.test(meta.conditionId) &&
      (outcomeIndex === 0 || outcomeIndex === 1) &&
      shares > 0 &&
      exactSize
    ) {
      try {
        const amountRaw = parseUnits(exactSize, 6);
        if (amountRaw > 0n)
          redemption = { market: `polymarket:${meta.conditionId}`, outcome: outcomeIndex, amountRaw: amountRaw.toString() };
      } catch {
        // A position with an imprecise amount remains visible without an action.
      }
    }
    const price = state === 'won' ? 1 : state === 'lost' ? 0 : meta?.tokens.find((t) => t.tokenId === tokenId)?.price;
    const cost = avgPrice !== undefined ? shares * avgPrice : undefined;
    const value = price !== undefined ? shares * price : undefined;
    const pnl = cost !== undefined && value !== undefined ? value - cost : undefined;
    rows.push({
      key: `${tokenId ?? recordMarket(r)}:${resolved ? 'r' : 'o'}`,
      venue: venueOf(meta, r),
      marketId: meta?.marketId,
      ...titles(meta, 'Unknown market'),
      image: meta?.image,
      outcome: outcomeOf(meta, r),
      shares,
      redemption,
      avgPrice,
      price,
      cost,
      value,
      pnl,
      pnlPct: pnl !== undefined && cost ? pnl / cost : undefined,
      realizedPnl: num(r, 'realized_pnl', 'realizedPnl'),
      state,
      endDate: meta?.endDate,
      lastTradeAt: str(r, 'last_trade_at', 'lastTradeAt'),
    });
  };
  for (const r of data.open) add(r, false);
  for (const r of data.resolved) add(r, true);
  // Open first (largest value first), then winners, then losers.
  const rank = { open: 0, won: 1, lost: 2, closed: 3 };
  rows.sort((a, b) => rank[a.state] - rank[b.state] || (b.value ?? 0) - (a.value ?? 0));

  const value = rows.reduce((s, p) => s + (p.value ?? 0), 0);
  const cost = rows.reduce((s, p) => s + (p.cost ?? 0), 0);
  const pnl = rows.reduce((s, p) => s + (p.pnl ?? 0), 0);
  return { positions: rows, history: [], totals: { value, cost, pnl, pnlPct: cost ? pnl / cost : undefined } };
}

/**
 * Past positions from the Data API's trader stats: everything closed, plus open ones sold down to
 * dust. Tokens still shown as positions (open or resolved) are left out so nothing appears twice.
 */
export function toHistoryView(
  stats: { performance?: ApiRecord; open_positions?: ApiRecord[]; closed_positions?: ApiRecord[] },
  metas: Map<string, MarketMeta>,
  shown: Set<string>,
): { history: PositionView[]; realized?: number } {
  const rows = [
    ...(stats.closed_positions ?? []),
    ...(stats.open_positions ?? []).filter((r) => (num(r, 'size') ?? 0) < DUST_SHARES),
  ];
  const history: PositionView[] = [];
  for (const r of rows) {
    const tokenId = str(r, 'token_id');
    if (!tokenId || shown.has(tokenId)) continue;
    const realizedPnl = num(r, 'realized_pnl');
    // Nothing bought or sold leaves nothing to show.
    if (realizedPnl === undefined) continue;
    const meta = metaFor(metas, r);
    const fallback = str(r, 'market_name') ?? 'Unknown market';
    history.push({
      key: `${tokenId}:c`,
      venue: venueOf(meta, r),
      marketId: meta?.marketId ?? str(r, 'market_id'),
      ...titles(meta, fallback),
      image: meta?.image ?? str(r, 'icon'),
      outcome: outcomeOf(meta, r),
      shares: 0,
      avgPrice: num(r, 'entry_price'),
      realizedPnl,
      state: 'closed',
      endDate: meta?.endDate,
      closedAt: str(r, 'closed_at'),
    });
  }
  // Newest first; rows without a close date go after, biggest result first.
  const when = (p: PositionView) => (p.closedAt ? Date.parse(p.closedAt) || 0 : 0);
  history.sort((a, b) => when(b) - when(a) || Math.abs(b.realizedPnl!) - Math.abs(a.realizedPnl!));
  return { history, realized: num(stats.performance ?? {}, 'total_realized_pnl') };
}

// ------------------------------------------------------------------ orders

export function toOrderView(r: ApiRecord, metas: Map<string, MarketMeta>): OrderView {
  const meta = metaFor(metas, r);
  const status = (str(r, 'status') ?? 'unknown').toLowerCase();
  const bps = num(r, 'price_bps');
  return {
    id: str(r, 'orderId', 'id', 'order_id') ?? '',
    venue: venueOf(meta, r),
    marketId: meta?.marketId,
    ...titles(meta, 'Unknown market'),
    image: meta?.image,
    side: str(r, 'side')?.toLowerCase() === 'sell' ? 'sell' : 'buy',
    outcome: outcomeOf(meta, r),
    price: num(r, 'price') ?? (bps !== undefined ? bps / 10_000 : undefined),
    shares: num(r, 'quantity', 'size', 'original_size') ?? 0,
    filled: num(r, 'filledSize', 'filled_quantity', 'filled_size', 'size_matched', 'filled') ?? 0,
    avgFillPrice: num(r, 'avgFillPrice', 'avg_fill_price'),
    status,
    open: OPEN_STATUSES.has(status),
    kind: str(r, 'kind'),
    timeInForce: str(r, 'time_in_force', 'timeInForce'),
    createdAt: str(r, 'created_at', 'createdAt'),
    fee: num(r, 'fee_amount'),
    error: str(r, 'error_message', 'error'),
  };
}

// ------------------------------------------------------------------ on-chain holdings

const CTF_ABI = parseAbi(['function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])']);

/** Where each venue keeps outcome shares, and their decimals. Predict.fun has one contract per market variant. */
const SHARE_CONTRACTS: Record<Exclude<Venue, 'hyperliquid'>, { ctfs: string[]; decimals: number }> = {
  polymarket: { ctfs: [CTF_ADDRESS], decimals: 6 },
  predictfun: { ctfs: PREDICTFUN_CTFS, decimals: 18 },
};

/**
 * Outcome shares a wallet actually holds, read from the venue's Conditional Tokens contracts. This
 * is what the venue checks a sell against, so it beats an indexer that lags. Polymarket shares sit
 * in the trading wallet; Predict.fun shares in the wallet itself. (Hyperliquid's are HyperCore spot
 * balances: see `hyperliquidAccount`.)
 */
export async function outcomeBalances(
  network: EvmNetwork,
  wallet: string,
  tokenIds: string[],
  venue: Exclude<Venue, 'hyperliquid'> = 'polymarket',
): Promise<Map<string, number>> {
  const ids = [...new Set(tokenIds.filter((t) => /^\d+$/.test(t)))];
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const owner = getAddress(wallet);
  const { ctfs, decimals } = SHARE_CONTRACTS[venue];
  const per = await Promise.all(
    ctfs.map((address) =>
      publicClient(network).readContract({
        address: address as `0x${string}`,
        abi: CTF_ABI,
        functionName: 'balanceOfBatch',
        args: [ids.map(() => owner), ids.map((t) => BigInt(t))],
      }),
    ),
  );
  // Token ids are unique per contract, so a share is only ever held on one of them.
  const scale = 10n ** BigInt(decimals - 6);
  ids.forEach((t, i) => out.set(t, Number(per.reduce((sum, b) => sum + b[i], 0n) / scale) / 1e6));
  return out;
}

/** One form per outcome token: Hyperliquid names a token `#n`, `+n` or by its asset id. */
const tokenKey = (venue: Venue | undefined, id: string) => (venue === 'hyperliquid' ? outcomeToken(id) : id);
const filled = (r: ApiRecord) => num(r, 'filledSize', 'filled_quantity', 'filled_size', 'size_matched', 'filled') ?? 0;

/** Outcome tokens of markets with a filled order that no indexed position (open or resolved) covers. */
export function filledTokensMissing(orders: ApiRecord[], indexed: ApiRecord[], metas: Map<string, MarketMeta>): string[] {
  const shown = new Set<string>();
  for (const r of indexed) {
    const id = str(r, 'tokenId', 'token_id');
    if (id) shown.add(tokenKey(venueOf(metaFor(metas, r), r), id));
  }
  const out = new Set<string>();
  for (const r of orders) {
    if (!(filled(r) > 0)) continue;
    const meta = metaFor(metas, r);
    for (const t of meta?.tokens ?? []) if (!shown.has(tokenKey(meta!.venue, t.tokenId))) out.add(t.tokenId);
  }
  return [...out];
}

/**
 * Open records for shares held on-chain that the position index (`indexed`, open and resolved)
 * doesn't list yet, priced at the latest filled buy of that outcome.
 */
export function heldFromFills(
  orders: ApiRecord[],
  indexed: ApiRecord[],
  metas: Map<string, MarketMeta>,
  balances: Map<string, number>,
): ApiRecord[] {
  const missing = new Set(filledTokensMissing(orders, indexed, metas));
  const out: ApiRecord[] = [];
  for (const r of orders) {
    const meta = metaFor(metas, r);
    if (!meta) continue;
    for (const t of meta.tokens) {
      const shares = balances.get(t.tokenId);
      if (!missing.has(t.tokenId) || shares === undefined || !(shares >= DUST_SHARES)) continue;
      missing.delete(t.tokenId);
      const key = tokenKey(meta.venue, t.tokenId);
      const buy = orders.find((o) => {
        if (metaFor(metas, o) !== meta || str(o, 'side')?.toLowerCase() === 'sell' || !(filled(o) > 0)) return false;
        if (!(num(o, 'avgFillPrice', 'avg_fill_price')! > 0)) return false;
        const id = str(o, 'tokenId', 'token_id');
        return id ? tokenKey(meta.venue, id) === key : outcomeOf(meta, o).toLowerCase() === t.outcome.toLowerCase();
      });
      // The order's own market fields, so the row resolves to the same market metadata.
      out.push({
        venue: str(r, 'venue') ?? meta.venue,
        market: str(r, 'market'),
        marketId: str(r, 'marketId', 'market_id', 'condition_id'),
        tokenId: t.tokenId,
        net_size: String(shares),
        avg_price: buy ? num(buy, 'avgFillPrice', 'avg_fill_price') : undefined,
        last_trade_at: str(buy ?? r, 'createdAt', 'created_at'),
      });
    }
  }
  return out;
}

/** Replaces each open position's size with the on-chain balance where one was read. */
export function withOnchainSizes(open: ApiRecord[], balances: Map<string, number>): ApiRecord[] {
  return open.map((r) => {
    const id = str(r, 'tokenId', 'token_id');
    const onchain = id !== undefined ? balances.get(id) : undefined;
    return onchain === undefined ? r : { ...r, net_size: String(onchain), indexed_size: r.net_size ?? r.size };
  });
}
