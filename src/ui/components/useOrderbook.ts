import { useEffect, useMemo, useRef, useState } from 'react';
import {
  LocalBook,
  PUBLIC_SUBPROTOCOL,
  TAG,
  decodeDelta,
  decodeDeltaBatch,
  decodeError,
  decodeSnapshot,
  encodeFetch,
  encodeSubscribe,
  encodeUnsubscribe,
  type BookState,
} from '../../core/predictions/orderbook';
import { parseMarketKey } from '../../core/predictions/venues';
import { useWallet } from '../lib/store';

export type FeedStatus = 'connecting' | 'live' | 'waiting' | 'offline';

/** Re-render at most this often; the feed itself batches deltas every ~150 ms. */
const RENDER_MS = 250;
/** How often to confirm the book with a fresh snapshot. */
const RECHECK_MS = 20_000;

/**
 * Streams one market's book from the Kairos `orderbook_slow` feed (anonymous public tier), by book
 * key on any venue (Polymarket books are keyed by condition id). Applies snapshots and delta
 * batches with the documented sequencing rules, re-fetches a snapshot on any gap, and reconnects
 * with backoff. Returns a function that stops it.
 */
export function streamBook(
  url: string,
  key: string,
  onBook: (book: BookState) => void,
  onStatus: (status: FeedStatus) => void,
): () => void {
  const { venue: provider, id: marketId } = parseMarketKey(key);
  let ws: WebSocket | undefined;
  let closed = false;
  let retry = 0;
  let lastFetch = 0;
  let dirty = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const local = new LocalBook(marketId);

  // Re-anchor on a fresh snapshot now and then, so a stalled feed can't leave a stale book marked live.
  const recheck = setInterval(() => resync(), RECHECK_MS);
  const flush = setInterval(() => {
    if (dirty && !local.needsResync) {
      dirty = false;
      onBook(local.state());
    }
  }, RENDER_MS);

  const resync = () => {
    // Anonymous clients may fetch at most one snapshot per second.
    if (!ws || ws.readyState !== WebSocket.OPEN || Date.now() - lastFetch < 1100) return;
    lastFetch = Date.now();
    ws.send(encodeFetch(marketId, provider));
  };

  const connect = () => {
    onStatus('connecting');
    ws = new WebSocket(url, [PUBLIC_SUBPROTOCOL]);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      retry = 0;
      ws!.send(encodeSubscribe(marketId, provider, ['orderbook_slow']));
    };
    ws.onmessage = (e) => {
      if (!(e.data instanceof ArrayBuffer)) return;
      const buf = new Uint8Array(e.data);
      const payload = buf.subarray(1);
      switch (buf[0]) {
        case TAG.ORDERBOOK_SNAPSHOT: {
          const snap = decodeSnapshot(payload);
          if (snap.contractId === marketId && local.applySnapshot(snap)) {
            // The first snapshot renders at once rather than on the next flush: the price appears sooner.
            dirty = false;
            onBook(local.state());
            onStatus('live');
          }
          break;
        }
        case TAG.ORDERBOOK_DELTA_BATCH:
        case TAG.ORDERBOOK_DELTA: {
          const deltas = buf[0] === TAG.ORDERBOOK_DELTA ? [decodeDelta(payload)] : decodeDeltaBatch(payload);
          for (const d of deltas) {
            if (d.contractId && d.contractId !== marketId) continue;
            const r = local.applyDelta(d);
            if (r === 'applied') {
              dirty = true;
              onStatus('live');
            } else if (r === 'gap') resync();
          }
          break;
        }
        case TAG.ERROR: {
          const err = decodeError(payload);
          // "fetch_waiting": no usable snapshot yet, but one is on its way (usually within milliseconds),
          // so keep listening rather than asking again. If this answers a periodic re-check, the
          // book we hold can't be confirmed: stop calling it live.
          if (err.action.startsWith('fetch_waiting')) onStatus('waiting');
          break;
        }
      }
    };
    ws.onclose = () => {
      if (closed) return;
      onStatus('offline');
      reconnectTimer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 15_000));
    };
  };
  connect();

  return () => {
    closed = true;
    clearInterval(flush);
    clearInterval(recheck);
    clearTimeout(reconnectTimer);
    try {
      if (ws?.readyState === WebSocket.OPEN) ws.send(encodeUnsubscribe(marketId, provider));
    } catch {
      // Closing anyway.
    }
    ws?.close();
  };
}

/** Live order book for one market, by book key. */
export function useOrderbook(key: string | undefined): { book?: BookState; status: FeedStatus } {
  const books = useOrderbooks(key ? [key] : []);
  return key ? books[key] : { status: 'connecting' };
}

/**
 * Live books for several markets at once (every venue a question is listed on), by book key. Each
 * key keeps its own stream; adding or removing a key leaves the others running.
 */
export function useOrderbooks(bookKeys: string[]): Record<string, { book?: BookState; status: FeedStatus }> {
  const { state } = useWallet();
  const url = state.settings.apis.kairosStreamUrl;
  const [books, setBooks] = useState<Record<string, { book?: BookState; status: FeedStatus }>>({});
  const streams = useRef(new Map<string, () => void>());
  const wanted = bookKeys.join('|');

  useEffect(() => {
    const want = new Set(wanted ? wanted.split('|') : []);
    for (const [k, stop] of streams.current) {
      if (!want.has(k) || !url) {
        stop();
        streams.current.delete(k);
      }
    }
    if (!url) return;
    for (const k of want) {
      if (streams.current.has(k)) continue;
      const set = (patch: { book?: BookState; status?: FeedStatus }) =>
        setBooks((cur) => ({ ...cur, [k]: { ...(cur[k] ?? { status: 'connecting' as FeedStatus }), ...patch } }));
      streams.current.set(
        k,
        streamBook(
          url,
          k,
          (book) => set({ book }),
          (status) => set({ status }),
        ),
      );
    }
  }, [wanted, url]);

  useEffect(
    () => () => {
      for (const stop of streams.current.values()) stop();
      streams.current.clear();
    },
    [],
  );

  return useMemo(() => {
    const out: Record<string, { book?: BookState; status: FeedStatus }> = {};
    for (const k of bookKeys) out[k] = books[k] ?? { status: 'connecting' };
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [books, wanted]);
}
