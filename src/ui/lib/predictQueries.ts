import type { MarketLink } from '../../core/predictions/links';
import type { OrderView, PositionsView } from '../../core/predictions/portfolio';
import type { Candle, MarketDetail, MarketRules, PricePoint, TradingStatus } from '../../core/predictions/types';
import { api } from './api';
import { invalidate, prefetch, useQuery, type QueryOptions } from './query';

/**
 * Prediction reads through the shared query cache: one request per key however many components
 * show it, instant on revisit, refreshed in the background.
 */

export const keys = {
  status: (accountId: string) => `p/status/${accountId}`,
  market: (id: string) => `p/market/${id}`,
  link: (id: string) => `p/link/${id}`,
  history: (id: string, hours: number, tf: number, outcome = 0) => `p/history/${id}/${hours}/${tf}/${outcome}`,
  candles: (id: string, hours: number, tf: number, outcome = 0) => `p/candles/${id}/${hours}/${tf}/${outcome}`,
  resolution: (id: string) => `p/resolution/${id}`,
  rules: (id: string) => `p/rules/${id}`,
  holdings: (accountId: string, id: string) => `p/holdings/${accountId}/${id}`,
  positions: (accountId: string) => `p/positions/${accountId}`,
  orders: (accountId: string, open: boolean) => `p/orders/${accountId}/${open ? 'open' : 'all'}`,
};

const fetchers = {
  market: (id: string) => () => api.predictionMarket(id),
  link: (id: string) => () => api.predictionLink(id).then((l) => l ?? null),
};

export function useTradingStatus(accountId: string | undefined, opts?: QueryOptions) {
  return useQuery<TradingStatus>(accountId && keys.status(accountId), () => api.predictionStatus(accountId!), {
    ttl: 15_000,
    ...opts,
  });
}

export function useMarket(id: string | undefined) {
  return useQuery<MarketDetail>(id && keys.market(id), fetchers.market(id ?? ''), { ttl: 20_000 });
}

/** The same question on other venues; `null` once known not to be linked. */
export function useLink(id: string | undefined) {
  return useQuery<MarketLink | null>(id && keys.link(id), fetchers.link(id ?? ''), { ttl: 60_000 });
}

type OutcomeQueryOptions = QueryOptions & { outcomeIndex?: number };

export function useHistory(id: string | undefined, hours: number, tf: number, opts?: OutcomeQueryOptions) {
  const outcomeIndex = opts?.outcomeIndex;
  return useQuery<PricePoint[]>(
    id && keys.history(id, hours, tf, outcomeIndex),
    () => api.predictionPriceHistory(id!, { hours, timeframeSeconds: tf, outcomeIndex }),
    { ttl: 30_000, ...opts },
  );
}

export function useCandles(id: string | undefined, hours: number, tf: number, opts?: OutcomeQueryOptions) {
  const outcomeIndex = opts?.outcomeIndex;
  return useQuery<Candle[]>(
    id && keys.candles(id, hours, tf, outcomeIndex),
    () => api.predictionCandles(id!, { hours, timeframeSeconds: tf, outcomeIndex }),
    { ttl: 30_000, ...opts },
  );
}

export function useResolution(id: string | undefined) {
  return useQuery(id && keys.resolution(id), () => api.predictionResolution(id!), { ttl: 60_000 });
}

export function useRules(id: string | undefined) {
  return useQuery<MarketRules>(id && keys.rules(id), () => api.predictionRules(id!), { ttl: 10 * 60_000 });
}

export function useHoldings(accountId: string | undefined, id: string | undefined) {
  return useQuery<Record<string, number>>(
    accountId && id ? keys.holdings(accountId, id) : undefined,
    () => api.predictionHoldings(accountId!, id!),
    { ttl: 15_000 },
  );
}

export function usePositions(accountId: string | undefined) {
  return useQuery<PositionsView>(accountId && keys.positions(accountId), () => api.predictionPositions(accountId!), {
    ttl: 20_000,
  });
}

export function useOrders(accountId: string | undefined, open: boolean) {
  return useQuery<OrderView[]>(accountId && keys.orders(accountId, open), () => api.predictionOrders(accountId!, open), {
    ttl: 10_000,
  });
}

/** Warms a market screen before it opens (rows call this on pointer-down). */
export function prefetchMarket(id: string) {
  prefetch(keys.market(id), fetchers.market(id), 20_000);
  prefetch(keys.link(id), fetchers.link(id), 60_000);
}

/** After an order: balances, holdings, positions and orders all change. */
export function invalidateAfterTrade(accountId: string) {
  invalidate(keys.status(accountId));
  invalidate(`p/holdings/${accountId}/`);
  invalidate(keys.positions(accountId));
  invalidate(`p/orders/${accountId}/`);
}
