import { useEffect, useState } from 'react';
import { decodeSyntheticQuote, encodeSubscribe, PUBLIC_SUBPROTOCOL, type SyntheticQuote } from '../../core/predictions/orderbook';

/** Watch two canonical union books on one anonymous connection while a matched market is open. */
export function useCatalogQuotes(url: string, yes?: string | null, no?: string | null) {
  const key = JSON.stringify([url, yes, no]);
  const [state, setState] = useState<{ key: string; quotes: Record<string, SyntheticQuote> }>();

  useEffect(() => {
    const ids = new Set([yes, no].filter((id): id is string => !!id && /^syn_[a-f0-9]{16}$/.test(id)));
    if (!url || !ids.size) return;
    let socket: WebSocket | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let delay = 1000;
    let quotes: Record<string, SyntheticQuote> = {};
    const connect = () => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url, [PUBLIC_SUBPROTOCOL]);
      } catch {
        return;
      }
      socket = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        for (const id of ids) ws.send(encodeSubscribe(id, 'synthetic', ['synthetic.quote']));
      };
      ws.onmessage = ({ data }) => {
        if (stopped || !(data instanceof ArrayBuffer)) return;
        try {
          const quote = decodeSyntheticQuote(new Uint8Array(data));
          if (!quote || !ids.has(quote.id)) return;
          const prev = quotes[quote.id];
          if (prev && (quote.epoch < prev.epoch || (quote.epoch === prev.epoch && quote.sequence <= prev.sequence))) return;
          quotes = { ...quotes, [quote.id]: quote };
          setState({ key, quotes });
          delay = 1000;
        } catch {
          // Ignore malformed frames; the next top-of-book quote is a complete state.
        }
      };
      ws.onclose = () => {
        if (stopped) return;
        quotes = {};
        setState({ key, quotes });
        retryTimer = setTimeout(connect, delay);
        delay = Math.min(15_000, delay * 2);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      socket?.close();
    };
  }, [key, no, url, yes]);

  const quotes = state?.key === key ? state.quotes : undefined;
  return { yes: yes ? quotes?.[yes]?.ask : undefined, no: no ? quotes?.[no]?.ask : undefined };
}
