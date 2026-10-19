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

/**
 * Live orderbook for one market (by market key, on any venue) from the Kairos `orderbook_slow` feed (anonymous public
 * tier). Applies snapshots and delta batches with the documented sequencing rules, re-fetches a
 * snapshot on any gap, and reconnects with backoff.
 */
export function useOrderbook(key: string | undefined): { book?: BookState; status: FeedStatus } {
  const { state } = useWallet();
  const url = state.settings.apis.kairosStreamUrl;
  const [book, setBook] = useState<BookState>();
  const [status, setStatus] = useState<FeedStatus>('connecting');
  const local = useRef<LocalBook | undefined>(undefined);

  useEffect(() => {
    if (!key || !url) return;
    const { venue: provider, id: marketId } = parseMarketKey(key);
    let ws: WebSocket | undefined;
    let closed = false;
    let retry = 0;
    let lastFetch = 0;
    let dirty = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    local.current = new LocalBook(marketId);
    setBook(undefined);

    // Re-anchor on a fresh snapshot now and then, so a stalled feed can't leave a stale book marked live.
    const recheck = setInterval(() => resync(), RECHECK_MS);

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
      ws.send(encodeFetch(marketId, provider));
    };

    const connect = () => {
      setStatus('connecting');
      ws = new WebSocket(url, [PUBLIC_SUBPROTOCOL]);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        retry = 0;
        ws!.send(encodeSubscribe(marketId, provider, ['orderbook_slow']));
      };
      ws.onmessage = (e) => {
        if (!(e.data instanceof ArrayBuffer) || !local.current) return;
        const buf = new Uint8Array(e.data);
        const payload = buf.subarray(1);
        switch (buf[0]) {
          case TAG.ORDERBOOK_SNAPSHOT: {
            const snap = decodeSnapshot(payload);
            if (snap.contractId === marketId && local.current.applySnapshot(snap)) {
              dirty = true;
              setStatus('live');
            }
            break;
          }
          case TAG.ORDERBOOK_DELTA_BATCH:
          case TAG.ORDERBOOK_DELTA: {
            const deltas = buf[0] === TAG.ORDERBOOK_DELTA ? [decodeDelta(payload)] : decodeDeltaBatch(payload);
            for (const d of deltas) {
              if (d.contractId && d.contractId !== marketId) continue;
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
            if (err.action.startsWith('fetch_waiting')) setStatus('waiting');
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
      clearTimeout(reconnectTimer);
      try {
        if (ws?.readyState === WebSocket.OPEN) ws.send(encodeUnsubscribe(marketId, provider));
      } catch {
        // Closing anyway.
      }
      ws?.close();
    };
  }, [key, url]);

  return { book, status };
}
