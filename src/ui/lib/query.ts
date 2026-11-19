import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * A small stale-while-revalidate cache shared by every screen. A screen opened again shows what it
 * last had at once and refreshes behind it; concurrent readers of one key share one request; rows
 * can prefetch on pointer-down so the next screen opens filled; and an action can write its
 * expected result straight in (optimistic), to be confirmed by the next refresh.
 */

interface Entry<T = unknown> {
  data?: T;
  error?: string;
  /** When data last arrived. */
  at: number;
  inflight?: Promise<T>;
  listeners: Set<() => void>;
}

const cache = new Map<string, Entry>();
const MAX_ENTRIES = 300;

function entry<T>(key: string): Entry<T> {
  let e = cache.get(key) as Entry<T> | undefined;
  if (!e) {
    e = { at: 0, listeners: new Set() };
    cache.set(key, e as Entry);
    if (cache.size > MAX_ENTRIES) {
      // Drop the oldest entry nobody is watching.
      for (const [k, v] of cache) {
        if (!v.listeners.size && !v.inflight) {
          cache.delete(k);
          break;
        }
      }
    }
  }
  return e;
}

const notify = (e: Entry) => e.listeners.forEach((l) => l());

/** Loads `key` unless fresh data (younger than `ttl`) or a request for it already exists. */
export function fetchQuery<T>(key: string, fn: () => Promise<T>, ttl = 0): Promise<T> {
  const e = entry<T>(key);
  if (e.inflight) return e.inflight;
  if (e.data !== undefined && Date.now() - e.at < ttl) return Promise.resolve(e.data);
  const p = fn().then(
    (data) => {
      e.data = data;
      e.error = undefined;
      e.at = Date.now();
      e.inflight = undefined;
      notify(e as Entry);
      return data;
    },
    (err: Error) => {
      e.error = err?.message ?? String(err);
      e.inflight = undefined;
      notify(e as Entry);
      throw err;
    },
  );
  e.inflight = p;
  notify(e as Entry);
  return p;
}

/** Warms the cache for a screen about to open. Errors are kept for that screen to show. */
export function prefetch<T>(key: string, fn: () => Promise<T>, ttl = 15_000) {
  void fetchQuery(key, fn, ttl).catch(() => undefined);
}

export function getQueryData<T>(key: string): T | undefined {
  return cache.get(key)?.data as T | undefined;
}

/** Writes data for a key (optimistic updates), notifying every screen showing it. */
export function setQueryData<T>(key: string, update: T | ((prev: T | undefined) => T | undefined)) {
  const e = entry<T>(key);
  const next = typeof update === 'function' ? (update as (p: T | undefined) => T | undefined)(e.data) : update;
  e.data = next;
  e.at = next === undefined ? 0 : Date.now();
  notify(e as Entry);
}

/** Marks every key starting with `prefix` stale; screens showing one refresh it. */
export function invalidate(prefix: string) {
  for (const [k, e] of cache) {
    if (k.startsWith(prefix)) {
      e.at = 0;
      notify(e);
    }
  }
}

/** Forgets everything under `prefix`, so nothing from before (e.g. another environment) is shown again. */
export function clearQueries(prefix: string) {
  for (const [k, e] of cache) {
    if (k.startsWith(prefix)) {
      e.data = undefined;
      e.error = undefined;
      e.at = 0;
      notify(e);
    }
  }
}

export interface QueryOptions {
  /** Data younger than this isn't fetched again on mount. Default 10 s. */
  ttl?: number;
  /** Refresh on this interval while mounted. */
  refreshMs?: number;
}

export interface QueryResult<T> {
  data: T | undefined;
  error: string | undefined;
  /** True only while there is nothing to show yet. */
  loading: boolean;
  /** A refresh is running behind data already shown. */
  refreshing: boolean;
  reload: () => Promise<T | undefined>;
}

/** Reads `key` through the shared cache; `undefined` key means "not yet" (nothing loads). */
export function useQuery<T>(key: string | undefined, fn: () => Promise<T>, opts: QueryOptions = {}): QueryResult<T> {
  const ttl = opts.ttl ?? 10_000;
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const subscribe = useCallback(
    (cb: () => void) => {
      if (!key) return () => {};
      const e = entry(key);
      e.listeners.add(cb);
      return () => e.listeners.delete(cb);
    },
    [key],
  );
  // A version counter would do; reading the entry object fields keeps snapshots stable between notifies.
  const snap = useSyncExternalStore(
    subscribe,
    () => (key ? snapshotOf(key) : EMPTY),
    () => EMPTY,
  );

  const reload = useCallback(async () => {
    if (!key) return undefined;
    try {
      return await fetchQuery(key, () => fnRef.current(), 0);
    } catch {
      return undefined;
    }
  }, [key]);

  useEffect(() => {
    if (!key) return;
    void fetchQuery(key, () => fnRef.current(), ttl).catch(() => undefined);
    // Stale data shown again: refresh it now that someone looks.
  }, [key, ttl, snap.stale]);

  useEffect(() => {
    if (!key || !opts.refreshMs) return;
    const t = setInterval(() => void fetchQuery(key, () => fnRef.current(), 0).catch(() => undefined), opts.refreshMs);
    return () => clearInterval(t);
  }, [key, opts.refreshMs]);

  return {
    data: snap.data as T | undefined,
    error: snap.data === undefined ? snap.error : undefined,
    loading: snap.data === undefined && !snap.error,
    refreshing: snap.inflight && snap.data !== undefined,
    reload,
  };
}

interface Snapshot {
  data: unknown;
  error: string | undefined;
  inflight: boolean;
  stale: boolean;
}
const EMPTY: Snapshot = { data: undefined, error: undefined, inflight: false, stale: false };
const snapshots = new WeakMap<Entry, Snapshot>();

function snapshotOf(key: string): Snapshot {
  const e = entry(key);
  const prev = snapshots.get(e);
  const stale = e.at === 0 && e.data !== undefined;
  if (prev && prev.data === e.data && prev.error === e.error && prev.inflight === !!e.inflight && prev.stale === stale)
    return prev;
  const next = { data: e.data, error: e.error, inflight: !!e.inflight, stale };
  snapshots.set(e, next);
  return next;
}
