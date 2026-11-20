import { getJson, joinUrl, type Fetch } from '../http';
import type { ComboPosition } from './combos';
import type {
  Action,
  ApiRecord,
  Candle,
  FeeModel,
  KairosConfig,
  MarketDetail,
  MarketRules,
  PredictionEvent,
  PricePoint,
  Resolution,
  ResolutionEvent,
  SearchHit,
  Step,
  TradingStatus,
  VenueStatus,
} from './types';
import { isVenue, marketKey, parseMarketKey, type Venue } from './venues';

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
  yes_sub_title?: string | null;
  no_sub_title?: string | null;
}

export const CATEGORIES = ['all', 'politics', 'crypto', 'sports', 'finance', 'tech', 'world', 'culture', 'weather'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface DiscoverQuery {
  venue?: Venue;
  category?: Category;
  search?: string;
  sort?: 'volume_24h' | 'volume' | 'newest' | 'liquidity';
  offset?: number;
  limit?: number;
}

/** Event-grouped, sorted market list (Kairos data API, public route). */
export async function discoverMarkets(cfg: KairosConfig, q: DiscoverQuery, fetchFn?: Fetch): Promise<PredictionEvent[]> {
  const venue = q.venue ?? 'polymarket';
  const res = await getJson<{ markets: DiscoverMarket[] }>(
    joinUrl(
      cfg.dataUrl,
      `api/markets/discover/v2?${qs({
        provider: venue,
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
  return (res.markets ?? []).map((m) => toEvent(m, venue)).filter((e) => e.outcomes.length > 0);
}

function toEvent(m: DiscoverMarket, venue: Venue): PredictionEvent {
  const outcomes = m.outcomes?.length
    ? m.outcomes
    : [{ id: m.id, title: m.title, price: m.price, volume24h: m.volume24h, condition_id: m.condition_id }];
  return {
    id: marketKey(venue, m.event_id ?? m.id),
    venue,
    title: m.eventTitle || m.title,
    image: m.image ?? undefined,
    category: m.category ?? undefined,
    volume24h: m.volume24h ?? undefined,
    expiration: m.expiration ?? undefined,
    sides: !m.outcomes?.length && m.yes_sub_title && m.no_sub_title ? [m.yes_sub_title, m.no_sub_title] : undefined,
    outcomes: outcomes
      // Hyperliquid markets have no condition id; elsewhere a missing one means an untradeable listing.
      .filter((o) => o.condition_id || venue === 'hyperliquid')
      .map((o) => ({
        marketId: marketKey(venue, o.id),
        conditionId: o.condition_id ?? '',
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
  fees_enabled?: boolean | number | null;
  fee_schedule?: { rate?: number; exponent?: number; taker_only?: boolean } | null;
  raw?: { fee_rate_bps?: number | string | null } | null;
}

/** The taker fee a buy pays on this market, from what market data publishes. */
export function feeModel(venue: Venue, m: Pick<MdMarket, 'fees_enabled' | 'fee_schedule' | 'raw'>): FeeModel | undefined {
  if (venue === 'polymarket') {
    const s = m.fee_schedule;
    if (!m.fees_enabled || !s || !(Number(s.rate) > 0)) return undefined;
    return { kind: 'curve', rate: Number(s.rate), exponent: Number(s.exponent ?? 1) || 1 };
  }
  if (venue === 'predictfun') {
    const bps = Number(m.raw?.fee_rate_bps);
    return bps > 0 ? { kind: 'min', rate: bps / 10_000 } : undefined;
  }
  // Hyperliquid charges nothing on a buy.
  return undefined;
}

/** Market metadata including outcome token ids (Kairos market data API), by market key. */
export async function getMarket(cfg: KairosConfig, key: string, fetchFn?: Fetch): Promise<MarketDetail> {
  const { venue, id } = parseMarketKey(key);
  const m = await getJson<MdMarket>(joinUrl(cfg.marketDataUrl, `v1/markets/${venue}/${encodeURIComponent(id)}`), {}, fetchFn);
  const detail: MarketDetail = {
    marketId: marketKey(venue, m.market_id),
    venue,
    venueMarketId: m.market_id,
    conditionId: m.condition_id,
    title: m.title ?? '',
    image: m.image ?? undefined,
    category: m.category ?? undefined,
    endDate: m.end_date ?? undefined,
    status: m.status,
    tickSize: m.tick_size ?? 0.01,
    negRisk: !!m.neg_risk,
    tokens: m.outcomes.map((o) => ({ outcome: o.outcome, tokenId: o.token_id })),
    fee: feeModel(venue, m),
  };
  // Marks are last-trade prices on a 0–100 scale; never-traded tokens are omitted.
  const marks = await getJson<{ marks: { token_id: string; price: number }[] }>(
    joinUrl(
      cfg.marketDataUrl,
      `v1/marks?${qs({ provider: venue, pairs: detail.tokens.map((t) => `${detail.conditionId || detail.venueMarketId}:${t.tokenId}`).join(',') })}`,
    ),
    {},
    fetchFn,
  ).catch(() => ({ marks: [] }));
  for (const t of detail.tokens) {
    const mark = marks.marks.find((x) => x.token_id === t.tokenId);
    if (mark) t.price = mark.price / 100;
  }
  // Market data has no artwork; discover has the event's image and title, and the last price where
  // there are no marks (Predict.fun, Hyperliquid). Best effort.
  const unpriced = detail.tokens.every((t) => t.price === undefined);
  if (!detail.image || unpriced) {
    const found = await getJson<{ markets?: DiscoverMarket[] }>(
      joinUrl(cfg.dataUrl, `api/markets/discover/v2?${qs({ provider: venue, market_ids: detail.venueMarketId, limit: 1 })}`),
      {},
      fetchFn,
    ).catch(() => ({ markets: [] as DiscoverMarket[] }));
    const ev = found.markets?.[0];
    if (ev) {
      detail.image ??= ev.image ?? undefined;
      if ((ev.outcomes?.length ?? 0) > 1 && ev.title) detail.eventTitle = ev.title;
      const listed = (ev.outcomes ?? []).find((o) => o.id === detail.venueMarketId)?.price ?? ev.price;
      if (unpriced && typeof listed === 'number' && detail.tokens.length === 2) {
        detail.tokens[0].price = listed;
        detail.tokens[1].price = Math.max(0, 1 - listed);
      }
    }
  }
  return detail;
}

export interface HistoryQuery {
  outcomeIndex?: number;
  hours?: number;
  /** Bucket width: 60, 300, 900, 3600, 14400 or 86400. */
  timeframeSeconds?: number;
}

/** OHLCV candles for one outcome, 0–1 scale, by market key. Buckets exist only where something traded. */
export async function getCandles(cfg: KairosConfig, key: string, opts: HistoryQuery = {}, fetchFn?: Fetch): Promise<Candle[]> {
  const { venue, id } = parseMarketKey(key);
  const end = new Date();
  const start = new Date(end.getTime() - (opts.hours ?? 24 * 7) * 3_600_000);
  const res = await getJson<{
    candles: { bucket_start: string; open: number; high: number; low: number; close: number; volume?: number }[];
  }>(
    joinUrl(
      cfg.marketDataUrl,
      `v1/candles?${qs({
        provider: venue,
        contract_id: id,
        timeframe_seconds: opts.timeframeSeconds ?? 3600,
        start: start.toISOString(),
        end: end.toISOString(),
        outcome: opts.outcomeIndex,
      })}`,
    ),
    {},
    fetchFn,
  );
  // Candles are on a 0–100 scale.
  return (res.candles ?? []).map((c) => ({
    t: Date.parse(c.bucket_start),
    open: c.open / 100,
    high: c.high / 100,
    low: c.low / 100,
    close: c.close / 100,
    volume: c.volume ?? 0,
  }));
}

/** Hourly (or custom) price history for one outcome token, 0–1 scale, by market key. */
export async function getPriceHistory(
  cfg: KairosConfig,
  key: string,
  opts: HistoryQuery = {},
  fetchFn?: Fetch,
): Promise<PricePoint[]> {
  return (await getCandles(cfg, key, opts, fetchFn)).map((c) => ({ t: c.t, price: c.close }));
}

// ------------------------------------------------------------------ resolution and rules (public)

interface MdResolution {
  status?: string | null;
  proposed_price?: string | number | null;
  proposed_at?: string | null;
  challenge_window_ends_at?: string | null;
  dispute_count?: number | null;
  payout_numerators?: (string | number)[] | null;
  resolved_ts?: string | null;
}

/** Normalizes an oracle price: UMA proposes 1e18 for Yes, 0 for No and 0.5e18 for a split. */
function oracleFraction(v: string | number | null | undefined): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return n > 1 ? n / 1e18 : n;
}

/** Where the market's resolution stands. A market that hasn't started resolving reports `initialized`. */
export async function getResolution(cfg: KairosConfig, key: string, fetchFn?: Fetch): Promise<Resolution> {
  const { venue, id } = parseMarketKey(key);
  const r = await getJson<MdResolution>(
    joinUrl(cfg.marketDataUrl, `v1/markets/${venue}/${encodeURIComponent(id)}/resolution`),
    {},
    fetchFn,
  );
  const numerators = (r.payout_numerators ?? []).map(Number).filter(Number.isFinite);
  const total = numerators.reduce((a, b) => a + b, 0);
  return {
    status: (r.status ?? 'initialized').toLowerCase(),
    proposedPrice: oracleFraction(r.proposed_price),
    proposedAt: r.proposed_at ?? undefined,
    challengeEndsAt: r.challenge_window_ends_at ?? undefined,
    disputes: r.dispute_count ?? 0,
    resolvedAt: r.resolved_ts ?? undefined,
    payouts: total > 0 ? numerators.map((n) => n / total) : undefined,
  };
}

/** The resolution's timeline (proposed, disputed, settled, …), oldest first. */
export async function getResolutionEvents(cfg: KairosConfig, key: string, fetchFn?: Fetch): Promise<ResolutionEvent[]> {
  const { venue, id } = parseMarketKey(key);
  const r = await getJson<{ events?: { event_type?: string; event_ts?: string }[] }>(
    joinUrl(cfg.marketDataUrl, `v1/markets/${venue}/${encodeURIComponent(id)}/resolution/events`),
    {},
    fetchFn,
  );
  return (r.events ?? [])
    .filter((e) => e.event_type && e.event_ts)
    .map((e) => ({ type: e.event_type!.toLowerCase(), at: e.event_ts! }));
}

/** The market's written description and rules. */
export async function getRules(cfg: KairosConfig, key: string, fetchFn?: Fetch): Promise<MarketRules> {
  const { venue, id } = parseMarketKey(key);
  const m = await getJson<{ description?: string | null; match_delay_ms?: number | null }>(
    joinUrl(cfg.dataUrl, `markets/metadata?${qs({ provider: venue, ticker: id })}`),
    {},
    fetchFn,
  );
  return { description: m.description?.trim() || undefined, matchDelayMs: m.match_delay_ms ?? undefined };
}

// ------------------------------------------------------------------ search (public)

interface SearchRow {
  market_id: string;
  provider: string;
  event_name?: string | null;
  name: string;
  outcome_label?: string | null;
  category?: string | null;
  status?: string | null;
  expires_at?: string | null;
  /** 0–100. */
  price?: number | null;
  volume_24h?: number | null;
  image?: string | null;
  icon?: string | null;
  outcomes?: string[];
}

/**
 * Full-text market search across every venue the wallet trades, best match first. Rows from venues
 * the wallet can't trade (e.g. Kalshi) are dropped.
 */
export async function searchMarkets(
  cfg: KairosConfig,
  q: string,
  opts: { limit?: number; signal?: AbortSignal } = {},
  fetchFn?: Fetch,
): Promise<SearchHit[]> {
  const res = await getJson<{ results?: SearchRow[] }>(
    joinUrl(cfg.dataUrl, `search/simple?${qs({ q: q.trim(), limit: opts.limit ?? 30, sort_by: 'relevance' })}`),
    opts.signal ? { signal: opts.signal } : {},
    fetchFn,
  );
  const out: SearchHit[] = [];
  for (const r of res.results ?? []) {
    if (!isVenue(r.provider)) continue;
    if (r.status && r.status !== 'open') continue;
    const venue = r.provider;
    const event = r.event_name?.trim();
    out.push({
      marketId: marketKey(venue, r.market_id),
      venue,
      title: r.name,
      eventTitle: event && event !== r.name ? event : undefined,
      label: r.outcome_label && !/^(yes|no)$/i.test(r.outcome_label) ? r.outcome_label : undefined,
      image: r.image ?? r.icon ?? undefined,
      category: r.category ?? undefined,
      price: typeof r.price === 'number' ? r.price / 100 : undefined,
      volume24h: r.volume_24h ?? undefined,
      endsAt: r.expires_at ?? undefined,
      status: r.status ?? undefined,
      outcomes: r.outcomes?.length ? r.outcomes : undefined,
    });
  }
  return out;
}

// ------------------------------------------------------------------ wallet API (/v3)

/** Opts in to the multi-venue wallet API. A node that predates it ignores the header and serves Polymarket. */
export const WALLET_API_VERSION = '2';

function headers(cfg: KairosConfig, json = false): HeadersInit {
  if (!cfg.partnerId) throw new Error('Set a Kairos partner id in Settings → Prediction markets');
  return {
    'X-Kairos-Partner-Id': cfg.partnerId,
    'X-Kairos-Wallet-Api': WALLET_API_VERSION,
    ...(json ? { 'content-type': 'application/json' } : {}),
  };
}

/**
 * A multi-venue node's top-level `ready`/`next` cover every venue. The wallet keeps them meaning
 * Polymarket, as on older nodes, and reads other venues from `venues`.
 */
export function normalizeStatus(raw: TradingStatus): TradingStatus {
  const venues = raw.venues && typeof raw.venues === 'object' ? raw.venues : undefined;
  const poly = venues?.polymarket;
  if (!venues) return raw;
  const known = Object.fromEntries(Object.entries(venues).filter(([v]) => isVenue(v))) as Partial<Record<Venue, VenueStatus>>;
  return {
    ...raw,
    venues: known,
    ...(poly
      ? {
          ready: poly.ready,
          next: poly.next,
          tradingWallet: poly.tradingWallet ?? raw.tradingWallet,
          balance: poly.balance ?? raw.balance ?? null,
        }
      : {}),
  };
}

export async function getStatus(cfg: KairosConfig, wallet: string, fetchFn?: Fetch): Promise<TradingStatus> {
  try {
    return normalizeStatus(
      await getJson<TradingStatus>(joinUrl(cfg.executionUrl, `v3/wallets/${wallet}`), { headers: headers(cfg) }, fetchFn),
    );
  } catch (e) {
    // The status route exists for every address, so a 404 means this host doesn't serve the wallet API at all.
    if ((e as { status?: number }).status === 404) {
      throw new Error(
        `${new URL(cfg.executionUrl).host} doesn't serve the Kairos wallet API right now. Check the wallet API URL in Settings → Swap & data providers.`,
        { cause: e },
      );
    }
    throw e;
  }
}

/** Status codes the caller handles itself: 401 means sign in again. */
export const isUnauthorized = (e: unknown) => (e as { status?: number }).status === 401;

function explainReadError(what: string, e: unknown): never {
  const status = (e as { status?: number }).status;
  if (status === 401) throw e;
  if (status === 403)
    throw new Error(`Kairos refused to show ${what} for this wallet (partner or wallet disabled).`, { cause: e });
  if (status === 429) throw new Error(`Kairos is rate-limiting requests. Try again in a minute.`, { cause: e });
  throw e;
}

/** Private reads carry the read-only token from a `login` action. */
function authHeaders(cfg: KairosConfig, token: string): HeadersInit {
  return { ...headers(cfg), Authorization: `SIWE ${token}` };
}

export async function getCombos(cfg: KairosConfig, wallet: string, token: string, fetchFn?: Fetch): Promise<ComboPosition[]> {
  const res = await getJson<{ combos?: ComboPosition[] }>(
    joinUrl(cfg.executionUrl, `v3/wallets/${wallet}/combos`),
    { headers: authHeaders(cfg, token) },
    fetchFn,
  ).catch((e) => explainReadError('your combos', e));
  return res.combos ?? [];
}

export async function getOrders(
  cfg: KairosConfig,
  wallet: string,
  token: string,
  opts: { open?: boolean; limit?: number } = {},
  fetchFn?: Fetch,
) {
  const res = await getJson<{ orders: ApiRecord[] }>(
    joinUrl(cfg.executionUrl, `v3/wallets/${wallet}/orders?${qs({ open: opts.open ? 'true' : undefined, limit: opts.limit })}`),
    { headers: authHeaders(cfg, token) },
    fetchFn,
  ).catch((e) => explainReadError('your orders', e));
  return res.orders ?? [];
}

/** Positions; the API wraps them as { positions: { positions: [...], resolved: [...], closed: [...] } }. */
export async function getPositions(cfg: KairosConfig, wallet: string, token: string, fetchFn?: Fetch) {
  const res = await getJson<{
    positions: ApiRecord[] | { positions?: ApiRecord[]; resolved?: ApiRecord[]; closed?: ApiRecord[] };
  }>(joinUrl(cfg.executionUrl, `v3/wallets/${wallet}/positions`), { headers: authHeaders(cfg, token) }, fetchFn).catch((e) =>
    explainReadError('your positions', e),
  );
  const p = res.positions;
  if (Array.isArray(p)) return { open: p, resolved: [] as ApiRecord[] };
  return { open: p?.positions ?? [], resolved: p?.resolved ?? [] };
}

/**
 * A trader's positions with realized P&L, open and closed, from the public Data API. The wallet
 * API keeps only token ids once a position closes, so past trades come from here. Pass the
 * trading wallet: that's the address holding the shares.
 */
export async function getTraderPositions(cfg: KairosConfig, address: string, fetchFn?: Fetch) {
  return getJson<{
    performance?: ApiRecord;
    open_positions?: ApiRecord[];
    closed_positions?: ApiRecord[];
  }>(joinUrl(cfg.dataUrl, `trader-stats/positions/${address}?${qs({ status: 'all', limit: 500 })}`), {}, fetchFn);
}

/** What the wallet posts back for a step: a signature, or the result of transactions it sent. */
export type StepAnswer = { signature: string } | { result: unknown };

export interface RunOptions {
  /** Validates a step and answers it: signs it, or sends the transactions it asks for. */
  answer: (step: Step) => Promise<StepAnswer>;
  onStep?: (step: Step) => void;
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetchFn?: Fetch;
  initialStep?: Step;
}

export class ActionFailedError extends Error {
  constructor(public step: Step) {
    super(step.error ?? `${step.type} failed`);
    this.name = 'ActionFailedError';
  }
}

function postAction(cfg: KairosConfig, path: string, body: unknown, fetchFn?: Fetch) {
  return getJson<Step>(
    joinUrl(cfg.executionUrl, path),
    { method: 'POST', headers: headers(cfg, true), body: JSON.stringify(body) },
    fetchFn,
  );
}

export function startAction(cfg: KairosConfig, wallet: string, action: Action, fetchFn?: Fetch) {
  return postAction(cfg, 'v3/actions', { wallet, action }, fetchFn);
}

export function readAction(cfg: KairosConfig, id: string, fetchFn?: Fetch) {
  return getJson<Step>(joinUrl(cfg.executionUrl, `v3/actions/${encodeURIComponent(id)}`), { headers: headers(cfg) }, fetchFn);
}

/** Starts or resumes an action and drives it to completion, signing each approved step. */
export async function runAction<R>(cfg: KairosConfig, wallet: string, action: Action, opts: RunOptions): Promise<R> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  let step = opts.initialStep ?? (await startAction(cfg, wallet, action, opts.fetchFn));
  const actionId = step.id;
  for (;;) {
    if ((step.status === 'needs_signature' || step.status === 'working') && step.id !== actionId) {
      throw new ActionFailedError({ ...step, error: 'Kairos changed the action id' });
    }
    switch (step.status) {
      case 'done':
        return step.result as R;
      case 'failed':
        throw new ActionFailedError(step);
      case 'needs_signature': {
        opts.onStep?.(step);
        step = await postAction(cfg, `v3/actions/${encodeURIComponent(step.id)}`, await opts.answer(step), opts.fetchFn);
        break;
      }
      case 'working': {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new ActionFailedError({ ...step, error: 'Timed out waiting for Kairos' });
        const delay = Math.max(opts.pollIntervalMs ?? 2000, (step.holdUntilMs ?? 0) - Date.now());
        await new Promise((r) => setTimeout(r, Math.min(remaining, delay)));
        step = await readAction(cfg, step.id, opts.fetchFn);
        break;
      }
      default:
        throw new ActionFailedError({ ...step, error: `Unexpected step status ${String(step.status)}` } as Step);
    }
  }
}
