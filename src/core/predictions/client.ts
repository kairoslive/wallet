import { getJson, joinUrl, type Fetch } from '../http';
import type { Action, ApiRecord, KairosConfig, MarketDetail, PredictionEvent, PricePoint, Step, TradingStatus } from './types';

export const PROVIDER = 'polymarket';

export type ActionInput = Action;

const qs = (params: Record<string, string | number | undefined>) =>
  new URLSearchParams(
    Object.entries(params)
      .filter((e): e is [string, string | number] => e[1] !== undefined)
      .map(([k, v]) => [k, String(v)]),
  ).toString();

// ------------------------------------------------------------------ market data (public)

interface DiscoverOutcome {
  id: string;
  title: string;
  outcomeLabel?: string | null;
  price?: number | null;
  volume24h?: number | null;
  condition_id?: string;
}

interface DiscoverMarket {
  id: string;
  event_id?: string;
  eventTitle?: string;
  title: string;
  image?: string | null;
  category?: string | null;
  volume24h?: number | null;
  expiration?: string | null;
  price?: number | null;
  outcomes?: DiscoverOutcome[];
  condition_id?: string;
}

export const CATEGORIES = ['all', 'politics', 'crypto', 'sports', 'finance', 'tech', 'world', 'culture', 'weather'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface DiscoverQuery {
  category?: Category;
  search?: string;
  sort?: 'volume_24h' | 'volume' | 'newest' | 'liquidity';
  offset?: number;
  limit?: number;
}

/** Event-grouped, sorted market list (Kairos data API, public route). */
export async function discoverMarkets(cfg: KairosConfig, q: DiscoverQuery, fetchFn?: Fetch): Promise<PredictionEvent[]> {
  const res = await getJson<{ markets: DiscoverMarket[] }>(
    joinUrl(
      cfg.dataUrl,
      `api/markets/discover/v2?${qs({
        provider: PROVIDER,
        category: q.category && q.category !== 'all' ? q.category : undefined,
        search: q.search?.trim() || undefined,
        sort_by: q.sort ?? 'volume_24h',
        sort_order: 'desc',
        offset: q.offset ?? 0,
        limit: q.limit ?? 30,
      })}`,
    ),
    {},
    fetchFn,
  );
  return (res.markets ?? []).map(toEvent).filter((e) => e.outcomes.length > 0);
}

function toEvent(m: DiscoverMarket): PredictionEvent {
  const outcomes = m.outcomes?.length
    ? m.outcomes
    : [{ id: m.id, title: m.title, price: m.price, volume24h: m.volume24h, condition_id: m.condition_id }];
  return {
    id: m.event_id ?? m.id,
    title: m.eventTitle || m.title,
    image: m.image ?? undefined,
    category: m.category ?? undefined,
    volume24h: m.volume24h ?? undefined,
    expiration: m.expiration ?? undefined,
    outcomes: outcomes
      .filter((o) => o.condition_id)
      .map((o) => ({
        marketId: o.id,
        conditionId: o.condition_id!,
        title: o.title,
        label: o.outcomeLabel ?? undefined,
        price: o.price ?? undefined,
        volume24h: o.volume24h ?? undefined,
      })),
  };
}

interface MdMarket {
  market_id: string;
  condition_id: string;
  title?: string;
  image?: string | null;
  category?: string | null;
  end_date?: string | null;
  status: string;
  tick_size?: number;
  neg_risk?: boolean;
  outcomes: { outcome: string; token_id: string }[];
}

/** Market metadata including outcome token ids (Kairos market data API). */
export async function getMarket(cfg: KairosConfig, marketId: string, fetchFn?: Fetch): Promise<MarketDetail> {
  const m = await getJson<MdMarket>(
    joinUrl(cfg.marketDataUrl, `v1/markets/${PROVIDER}/${encodeURIComponent(marketId)}`),
    {},
    fetchFn,
  );
  const detail: MarketDetail = {
    marketId: m.market_id,
    conditionId: m.condition_id,
    title: m.title ?? '',
    image: m.image ?? undefined,
    category: m.category ?? undefined,
    endDate: m.end_date ?? undefined,
    status: m.status,
    tickSize: m.tick_size ?? 0.01,
    negRisk: !!m.neg_risk,
    tokens: m.outcomes.map((o) => ({ outcome: o.outcome, tokenId: o.token_id })),
  };
  // Marks are last-trade prices on a 0–100 scale; never-traded tokens are omitted.
  const marks = await getJson<{ marks: { token_id: string; price: number }[] }>(
    joinUrl(
      cfg.marketDataUrl,
      `v1/marks?${qs({ provider: PROVIDER, pairs: detail.tokens.map((t) => `${detail.conditionId}:${t.tokenId}`).join(',') })}`,
    ),
    {},
    fetchFn,
  ).catch(() => ({ marks: [] }));
  for (const t of detail.tokens) {
    const mark = marks.marks.find((x) => x.token_id === t.tokenId);
    if (mark) t.price = mark.price / 100;
  }
  return detail;
}

/** Hourly (or custom) price history for one outcome token, 0–1 scale. */
export async function getPriceHistory(
  cfg: KairosConfig,
  marketId: string,
  opts: { outcomeIndex?: number; hours?: number; timeframeSeconds?: number } = {},
  fetchFn?: Fetch,
): Promise<PricePoint[]> {
  const end = new Date();
  const start = new Date(end.getTime() - (opts.hours ?? 24 * 7) * 3_600_000);
  const res = await getJson<{ candles: { bucket_start: string; close: number }[] }>(
    joinUrl(
      cfg.marketDataUrl,
      `v1/candles?${qs({
        provider: PROVIDER,
        contract_id: marketId,
        timeframe_seconds: opts.timeframeSeconds ?? 3600,
        start: start.toISOString(),
        end: end.toISOString(),
        outcome: opts.outcomeIndex,
      })}`,
    ),
    {},
    fetchFn,
  );
  return (res.candles ?? []).map((c) => ({ t: Date.parse(c.bucket_start), price: c.close / 100 }));
}

// ------------------------------------------------------------------ wallet API (/v3)

function headers(cfg: KairosConfig, json = false): HeadersInit {
  if (!cfg.partnerId) throw new Error('Set a Kairos partner id in Settings → Prediction markets');
  return { 'X-Kairos-Partner-Id': cfg.partnerId, ...(json ? { 'content-type': 'application/json' } : {}) };
}

export async function getStatus(cfg: KairosConfig, wallet: string, fetchFn?: Fetch): Promise<TradingStatus> {
  return getJson<TradingStatus>(joinUrl(cfg.executionUrl, `v3/wallets/${wallet}`), { headers: headers(cfg) }, fetchFn);
}

export async function getOrders(
  cfg: KairosConfig,
  wallet: string,
  opts: { open?: boolean; limit?: number } = {},
  fetchFn?: Fetch,
) {
  const res = await getJson<{ orders: ApiRecord[] }>(
    joinUrl(cfg.executionUrl, `v3/wallets/${wallet}/orders?${qs({ open: opts.open ? 'true' : undefined, limit: opts.limit })}`),
    { headers: headers(cfg) },
    fetchFn,
  );
  return res.orders ?? [];
}

/** Positions; the API wraps them as { positions: { positions: [...], resolved: [...], closed: [...] } }. */
export async function getPositions(cfg: KairosConfig, wallet: string, fetchFn?: Fetch) {
  const res = await getJson<{
    positions: ApiRecord[] | { positions?: ApiRecord[]; resolved?: ApiRecord[]; closed?: ApiRecord[] };
  }>(joinUrl(cfg.executionUrl, `v3/wallets/${wallet}/positions`), { headers: headers(cfg) }, fetchFn);
  const p = res.positions;
  if (Array.isArray(p)) return { open: p, resolved: [] as ApiRecord[] };
  return { open: p?.positions ?? [], resolved: p?.resolved ?? [] };
}

export interface RunOptions {
  /** Signs a validated step; returns the signature. */
  sign: (step: Step) => Promise<string>;
  onStep?: (step: Step) => void;
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetchFn?: Fetch;
}

export class ActionFailedError extends Error {
  constructor(public step: Step) {
    super(step.error ?? `${step.type} failed`);
    this.name = 'ActionFailedError';
  }
}

/** Starts an action and drives it to completion, signing each step it asks for. */
export async function runAction<R>(cfg: KairosConfig, wallet: string, action: Action, opts: RunOptions): Promise<R> {
  const post = (path: string, body: unknown) =>
    getJson<Step<R>>(
      joinUrl(cfg.executionUrl, path),
      { method: 'POST', headers: headers(cfg, true), body: JSON.stringify(body) },
      opts.fetchFn,
    );
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  let step = await post('v3/actions', { wallet, action });
  for (;;) {
    switch (step.status) {
      case 'done':
        return step.result as R;
      case 'failed':
        throw new ActionFailedError(step);
      case 'needs_signature': {
        opts.onStep?.(step);
        const signature = await opts.sign(step as Step);
        step = await post(`v3/actions/${step.id}`, { signature });
        break;
      }
      case 'working':
        if (Date.now() > deadline) throw new ActionFailedError({ ...step, error: 'Timed out waiting for Kairos' } as Step);
        await new Promise((r) => setTimeout(r, opts.pollIntervalMs ?? 2000));
        step = await getJson<Step<R>>(
          joinUrl(cfg.executionUrl, `v3/actions/${step.id}`),
          { headers: headers(cfg) },
          opts.fetchFn,
        );
        break;
      default:
        throw new ActionFailedError({ ...step, error: `Unexpected step status ${String(step.status)}` } as Step);
    }
  }
}
