import { describe, expect, it } from 'vitest';
import {
  LocalBook,
  PUBLIC_SUBPROTOCOL,
  TAG,
  decodeDeltaBatch,
  decodeError,
  decodeSnapshot,
  encodeSubscribe,
  walkBook,
} from '../../src/core/predictions/orderbook';

/** Live: the anonymous orderbook_slow feed on Kairos production. Opt-in with KAIROS_LIVE=1. */
const STREAM = process.env.KAIROS_STREAM_URL ?? 'wss://stream.kairos.trade';
/** A liquid Polymarket market; override with KAIROS_STREAM_MARKET. */
const MARKET = process.env.KAIROS_STREAM_MARKET ?? '2589812';

describe.skipIf(!process.env.KAIROS_LIVE)('Kairos orderbook stream (live)', () => {
  it('streams a Polymarket book with snapshots and in-sequence delta batches', async () => {
    // Polymarket books are keyed by condition id.
    const md = (await (await fetch(`https://md.kairos.trade/v1/markets/polymarket/${MARKET}`)).json()) as {
      condition_id: string;
    };
    const contract = md.condition_id;
    const book = new LocalBook(contract);
    const log: string[] = [];
    let snapshots = 0;
    let applied = 0;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(STREAM, [PUBLIC_SUBPROTOCOL]);
      ws.binaryType = 'arraybuffer';
      const done = setTimeout(() => {
        ws.close();
        resolve();
      }, 8000);
      ws.onopen = () => ws.send(encodeSubscribe(contract, 'polymarket', ['orderbook_slow']));
      ws.onerror = () => {
        clearTimeout(done);
        reject(new Error('websocket error'));
      };
      ws.onmessage = (e) => {
        const buf = new Uint8Array(e.data as ArrayBuffer);
        const tag = buf[0];
        const payload = buf.subarray(1);
        log.push(tag.toString(16));
        if (tag === TAG.ORDERBOOK_SNAPSHOT) {
          snapshots++;
          book.applySnapshot(decodeSnapshot(payload));
        } else if (tag === TAG.ORDERBOOK_DELTA_BATCH) {
          for (const d of decodeDeltaBatch(payload)) if (book.applyDelta(d) === 'applied') applied++;
        } else if (tag === TAG.ERROR) {
          const err = decodeError(payload);
          log.push(`error ${err.action}: ${err.message}`);
        }
      };
    });

    console.log('contract', contract, 'tags', [...new Set(log)].join(','), 'snapshots', snapshots, 'deltas applied', applied);
    expect(snapshots).toBeGreaterThan(0);
    const state = book.state();
    expect(state.outcomes.length).toBeGreaterThanOrEqual(2);
    const yes = state.outcomes[0];
    console.log(yes.name, 'best bid', yes.bids[0], 'best ask', yes.asks[0], 'levels', yes.bids.length, yes.asks.length);
    // Prices are probabilities and the book isn't crossed.
    for (const l of [...yes.bids, ...yes.asks]) expect(l.price > 0 && l.price < 1).toBe(true);
    if (yes.bids[0] && yes.asks[0]) expect(yes.bids[0].price).toBeLessThan(yes.asks[0].price);
    const fill = walkBook(yes, 'buy', 10);
    console.log('market buy $10 →', fill);
  }, 30_000);
});
