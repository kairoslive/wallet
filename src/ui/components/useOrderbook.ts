import { useEffect, useRef, useState } from 'react';
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
/** While there is no usable snapshot, ask again this often: Kairos sometimes answers "unavailable" and then nothing. */
const NO_BOOK_RETRY_MS = 3_000;

/**
 * Live orderbook for one market (by market key, on any venue) from the Kairos `orderbook_slow` feed (anonymous public
 * tier). Applies snapshots and delta batches with the documented sequencing rules, re-fetches a
 * snapshot on any gap, and reconnects with backoff.
 *
 * `alias` is another id the stream may know the same book by. Kairos keys some Polymarket books by
 * market id and others by condition id, so both are subscribed and the first to send a snapshot wins.
 */
export function useOrderbook(key: string | undefined, alias?: string): { book?: BookState; status: FeedStatus } {
  const { state } = useWallet();
  const url = state.settings.apis.kairosStreamUrl;
  const [book, setBook] = useState<BookState>();
  const [status, setStatus] = useState<FeedStatus>('connecting');
  const local = useRef<LocalBook | undefined>(undefined);

  useEffect(() => {
    if (!key || !url) return;
    const { venue: provider, id: marketId } = parseMarketKey(key);
    const candidates = alias && alias !== marketId ? [marketId, alias] : [marketId];
    /** The id whose snapshot arrived first; until then every candidate is subscribed. */
    let active: string | undefined = candidates.length === 1 ? marketId : undefined;
    let ws: WebSocket | undefined;
    let closed = false;
    let retry = 0;
    let lastFetch = 0;
    let dirty = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    local.current = active ? new LocalBook(active) : undefined;
    setBook(undefined);

    // Re-anchor on a fresh snapshot now and then, so a stalled feed can't leave a stale book marked live.
    const recheck = setInterval(() => resync(), RECHECK_MS);
    let attempt = 0;
    const noBookRetry = setInterval(() => {
      if (!local.current || local.current.needsResync) resync();
    }, NO_BOOK_RETRY_MS);

    const flush = setInterval(() => {
      if (dirty && local.current && !local.current.needsResync) {
        dirty = false;
        setBook(local.current.state());
      }
    }, RENDER_MS);

    const resync = () => {
      // Anonymous clients may fetch at most one snapshot per second.
      if (!ws || ws.readyState !== WebSocket.OPEN || Date.now() - lastFetch < 1100) return;
      lastFetch = Date.now();
      // Before a book is chosen, take turns asking for each id it may be under.
      ws.send(encodeFetch(active ?? candidates[attempt++ % candidates.length], provider));
    };

    const connect = () => {
      setStatus('connecting');
      ws = new WebSocket(url, [PUBLIC_SUBPROTOCOL]);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        retry = 0;
        for (const id of active ? [active] : candidates) ws!.send(encodeSubscribe(id, provider, ['orderbook_slow']));
      };
      ws.onmessage = (e) => {
        if (!(e.data instanceof ArrayBuffer)) return;
        const buf = new Uint8Array(e.data);
        const payload = buf.subarray(1);
        switch (buf[0]) {
          case TAG.ORDERBOOK_SNAPSHOT: {
            const snap = decodeSnapshot(payload);
            if (!active && candidates.includes(snap.contractId)) {
              active = snap.contractId;
              local.current = new LocalBook(active);
              for (const id of candidates) if (id !== active) ws!.send(encodeUnsubscribe(id, provider));
            }
            if (snap.contractId === active && local.current?.applySnapshot(snap)) {
              dirty = true;
              setStatus('live');
            }
            break;
          }
          case TAG.ORDERBOOK_DELTA_BATCH:
          case TAG.ORDERBOOK_DELTA: {
            if (!active || !local.current) break;
            const deltas = buf[0] === TAG.ORDERBOOK_DELTA ? [decodeDelta(payload)] : decodeDeltaBatch(payload);
            for (const d of deltas) {
              if (d.contractId && d.contractId !== active) continue;
              const r = local.current.applyDelta(d);
              if (r === 'applied') {
                dirty = true;
                setStatus('live');
              } else if (r === 'gap') resync();
            }
            break;
          }
          case TAG.ERROR: {
            const err = decodeError(payload);
            // "fetch_waiting": no usable snapshot yet; a live one will arrive and re-anchor the book.
            // If this answers a periodic re-check, the book we hold can't be confirmed: stop calling it live.
            // Ignore it for an id that lost the race (action is `fetch_waiting:<provider>:<id>`).
            if (err.action.startsWith('fetch_waiting') && (!active || err.action.endsWith(`:${active}`))) setStatus('waiting');
            break;
          }
        }
      };
      ws.onclose = () => {
        if (closed) return;
        setStatus('offline');
        reconnectTimer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 15_000));
      };
    };
    connect();

    return () => {
      closed = true;
      clearInterval(flush);
      clearInterval(recheck);
      clearInterval(noBookRetry);
      clearTimeout(reconnectTimer);
      try {
        if (ws?.readyState === WebSocket.OPEN) for (const id of active ? [active] : candidates) ws.send(encodeUnsubscribe(id, provider));
      } catch {
        // Closing anyway.
      }
      ws?.close();
    };
  }, [key, alias, url]);

  return { book, status };
}
