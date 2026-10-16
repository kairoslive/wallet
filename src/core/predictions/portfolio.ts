import { getJson, joinUrl, type Fetch } from '../http';
import type { ApiRecord, KairosConfig } from './types';

/**
 * Turns the wallet API's bare order and position records (ids, sizes, bps prices) into rows a
 * person can read: market title, outcome label, image, live price, value and P&L.
 */

export interface MarketMeta {
  /** Numeric Polymarket market id (what the market screen opens). */
  marketId: string;
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
  marketId?: string;
  title: string;
  subtitle?: string;
  image?: string;
  outcome: string;
  shares: number;
  avgPrice?: number;
  price?: number;
  cost?: number;
  value?: number;
  pnl?: number;
  pnlPct?: number;
  realizedPnl?: number;
  /** open: still trading. won/lost: market resolved. */
  state: 'open' | 'won' | 'lost';
  endDate?: string;
  lastTradeAt?: string;
}

export interface PositionsView {
  positions: PositionView[];
  totals: { value: number; cost: number; pnl: number; pnlPct?: number };
}

export interface OrderView {
  id: string;
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
  outcomes?: { id: string; title?: string; outcomeLabel?: string | null; image?: string | null }[];
}

/**
 * Metadata for markets referenced by condition id or numeric id, keyed by both (and by token id).
 * Three best-effort calls: market data batch (ids, tokens), discover (images, event titles) and
 * marks (live prices). Missing pieces just leave fields empty.
 */
export async function lookupMarkets(cfg: KairosConfig, ids: string[], fetchFn?: Fetch): Promise<Map<string, MarketMeta>> {
  const out = new Map<string, MarketMeta>();
  const unique = [...new Set(ids.filter(Boolean))].slice(0, 200);
  if (!unique.length) return out;

  const batch = await getJson<{ markets: Record<string, MdMarket> }>(
    joinUrl(cfg.marketDataUrl, 'v1/markets/batch'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'polymarket', market_ids: unique }),
    },
    fetchFn,
  ).catch(() => ({ markets: {} as Record<string, MdMarket> }));

  const metas = new Map<string, MarketMeta>();
  for (const m of Object.values(batch.markets ?? {})) {
    if (!m?.market_id || metas.has(m.market_id)) continue;
    metas.set(m.market_id, {
      marketId: m.market_id,
      conditionId: m.condition_id,
      title: m.title ?? '',
      endDate: m.end_date ?? undefined,
      status: m.status,
      tokens: (m.outcomes ?? []).map((o) => ({ outcome: o.outcome, tokenId: o.token_id })),
    });
  }
  if (!metas.size) return out;

  const numericIds = [...metas.keys()];
  const [discover, marks] = await Promise.all([
    getJson<{ markets?: DiscoverMarket[] }>(
      joinUrl(
        cfg.dataUrl,
        `api/markets/discover/v2?${new URLSearchParams({ provider: 'polymarket', market_ids: numericIds.join(','), limit: String(numericIds.length) })}`,
      ),
      {},
      fetchFn,
    ).catch(() => ({ markets: [] as DiscoverMarket[] })),
    getJson<{ marks: { token_id: string; price: number }[] }>(
      joinUrl(
        cfg.marketDataUrl,
        `v1/marks?${new URLSearchParams({
          provider: 'polymarket',
          pairs: [...metas.values()].flatMap((m) => m.tokens.map((t) => `${m.conditionId}:${t.tokenId}`)).join(','),
        })}`,
      ),
      {},
      fetchFn,
    ).catch(() => ({ marks: [] as { token_id: string; price: number }[] })),
  ]);

  for (const ev of discover.markets ?? []) {
    const outcomes = ev.outcomes?.length ? ev.outcomes : [{ id: ev.id, title: ev.title }];
    for (const o of outcomes) {
      const meta = metas.get(String(o.id));
      if (!meta) continue;
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
    out.set(meta.marketId, meta);
    out.set(meta.conditionId.toLowerCase(), meta);
    for (const t of meta.tokens) out.set(t.tokenId, meta);
  }
  return out;
}

export function metaFor(metas: Map<string, MarketMeta>, r: ApiRecord): MarketMeta | undefined {
  const marketId = str(r, 'market_id', 'condition_id', 'market');
  const tokenId = str(r, 'token_id');
  const byMarket = marketId ? metas.get(marketId.startsWith('0x') ? marketId.toLowerCase() : marketId) : undefined;
  return byMarket ?? (tokenId ? metas.get(tokenId) : undefined);
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
  const tokenId = str(r, 'token_id');
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
    if (!resolved && !(shares > 0)) return;
    const meta = metaFor(metas, r);
    const tokenId = str(r, 'token_id');
    const bps = num(r, 'avg_entry_price_bps');
    const avgPrice = bps !== undefined ? bps / 10_000 : num(r, 'avg_price', 'avgPrice');
    const state: PositionView['state'] = !resolved ? 'open' : r.redeemable === true ? 'won' : 'lost';
    const price = state === 'won' ? 1 : state === 'lost' ? 0 : meta?.tokens.find((t) => t.tokenId === tokenId)?.price;
    const cost = avgPrice !== undefined ? shares * avgPrice : undefined;
    const value = price !== undefined ? shares * price : undefined;
    const pnl = cost !== undefined && value !== undefined ? value - cost : undefined;
    rows.push({
      key: `${tokenId ?? str(r, 'market_id')}:${resolved ? 'r' : 'o'}`,
      marketId: meta?.marketId,
      ...titles(meta, 'Unknown market'),
      image: meta?.image,
      outcome: outcomeOf(meta, r),
      shares,
      avgPrice,
      price,
      cost,
      value,
      pnl,
      pnlPct: pnl !== undefined && cost ? pnl / cost : undefined,
      realizedPnl: num(r, 'realized_pnl'),
      state,
      endDate: meta?.endDate,
      lastTradeAt: str(r, 'last_trade_at'),
    });
  };
  for (const r of data.open) add(r, false);
  for (const r of data.resolved) add(r, true);
  // Open first (largest value first), then winners, then losers.
  const rank = { open: 0, won: 1, lost: 2 };
  rows.sort((a, b) => rank[a.state] - rank[b.state] || (b.value ?? 0) - (a.value ?? 0));

  const value = rows.reduce((s, p) => s + (p.value ?? 0), 0);
  const cost = rows.reduce((s, p) => s + (p.cost ?? 0), 0);
  const pnl = rows.reduce((s, p) => s + (p.pnl ?? 0), 0);
  return { positions: rows, totals: { value, cost, pnl, pnlPct: cost ? pnl / cost : undefined } };
}

// ------------------------------------------------------------------ orders

export function toOrderView(r: ApiRecord, metas: Map<string, MarketMeta>): OrderView {
  const meta = metaFor(metas, r);
  const status = (str(r, 'status') ?? 'unknown').toLowerCase();
  const bps = num(r, 'price_bps');
  return {
    id: str(r, 'id', 'order_id', 'orderId') ?? '',
    marketId: meta?.marketId,
    ...titles(meta, 'Unknown market'),
    image: meta?.image,
    side: str(r, 'side')?.toLowerCase() === 'sell' ? 'sell' : 'buy',
    outcome: outcomeOf(meta, r),
    price: num(r, 'price') ?? (bps !== undefined ? bps / 10_000 : undefined),
    shares: num(r, 'quantity', 'size', 'original_size') ?? 0,
    filled: num(r, 'filled_quantity', 'filled_size', 'size_matched', 'filled') ?? 0,
    avgFillPrice: num(r, 'avg_fill_price'),
    status,
    open: OPEN_STATUSES.has(status),
    kind: str(r, 'kind'),
    timeInForce: str(r, 'time_in_force', 'timeInForce'),
    createdAt: str(r, 'created_at', 'createdAt'),
    fee: num(r, 'fee_amount'),
    error: str(r, 'error_message'),
  };
}
