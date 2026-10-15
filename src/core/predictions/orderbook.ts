/**
 * Kairos market-data stream (orderbooks) — a minimal, dependency-free protobuf codec for the handful
 * of messages the wallet uses, plus a local book that applies the documented sequencing rules.
 * https://docs.kairos.trade/websocket/market-data-websocket
 */

export const TAG = {
  ORDERBOOK_SNAPSHOT: 0x02,
  ORDERBOOK_DELTA: 0x0f,
  ORDERBOOK_DELTA_BATCH: 0x1e,
  SUBSCRIBE: 0x10,
  UNSUBSCRIBE: 0x11,
  SUBSCRIBED: 0x14,
  FETCH: 0x16,
  ERROR: 0x17,
} as const;

/** Anonymous public tier: no keys, a few markets per connection. */
export const PUBLIC_SUBPROTOCOL = 'kairos.marketdata.public.v1';

// ------------------------------------------------------------------ protobuf wire format

class Reader {
  pos = 0;
  constructor(private buf: Uint8Array) {}
  get done() {
    return this.pos >= this.buf.length;
  }
  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.buf.length) throw new Error('truncated varint');
      const b = this.buf[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
    }
  }
  bytes(): Uint8Array {
    const len = Number(this.varint());
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  skip(wireType: number) {
    if (wireType === 0) this.varint();
    else if (wireType === 1) this.pos += 8;
    else if (wireType === 2) this.bytes();
    else if (wireType === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wireType}`);
  }
}

/** Iterates (field number, wire type) pairs, letting the callback consume each value. */
function readFields(buf: Uint8Array, onField: (field: number, wireType: number, r: Reader) => void) {
  const r = new Reader(buf);
  while (!r.done) {
    const key = Number(r.varint());
    const before = r.pos;
    onField(key >>> 3, key & 7, r);
    if (r.pos === before) r.skip(key & 7);
  }
}

const utf8 = new TextDecoder();
const toInt32 = (v: bigint) => Number(BigInt.asIntN(32, v));
const toInt64 = (v: bigint) => Number(BigInt.asIntN(64, v));

function writeVarint(out: number[], v: number) {
  let n = v >>> 0;
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
}

function writeString(out: number[], field: number, s: string) {
  const bytes = new TextEncoder().encode(s);
  writeVarint(out, (field << 3) | 2);
  writeVarint(out, bytes.length);
  out.push(...bytes);
}

// ------------------------------------------------------------------ messages

export function encodeSubscribe(contractId: string, provider: string, topics: string[]): Uint8Array {
  const out: number[] = [TAG.SUBSCRIBE];
  writeString(out, 1, contractId);
  writeString(out, 2, provider);
  for (const t of topics) writeString(out, 3, t);
  return Uint8Array.from(out);
}

export function encodeUnsubscribe(contractId: string, provider: string): Uint8Array {
  const out: number[] = [TAG.UNSUBSCRIBE];
  writeString(out, 1, contractId);
  writeString(out, 2, provider);
  return Uint8Array.from(out);
}

export function encodeFetch(contractId: string, provider: string): Uint8Array {
  const out: number[] = [TAG.FETCH];
  writeString(out, 1, contractId);
  writeString(out, 2, provider);
  return Uint8Array.from(out);
}

export interface RawLevel {
  price: number;
  size: number;
}

export interface RawSide {
  bids: RawLevel[];
  asks: RawLevel[];
}

export interface SnapshotMsg {
  contractId: string;
  tokenIds: string[];
  outcomeNames: string[];
  outcomes: RawSide[];
  seq: number;
  epoch: number;
  priceScale: number;
  sizeScale: number;
  timestampUs: number;
}

export interface DeltaMsg {
  contractId: string;
  outcomes: RawSide[];
  seq: number;
  snapshotSeq: number;
  epoch: number;
}

function decodeLevels(buf: Uint8Array): RawLevel[] {
  // OrderbookSide / DeltaSide: repeated (PriceLevel | DeltaLevel) levels = 1 — same shape.
  const levels: RawLevel[] = [];
  readFields(buf, (f, w, r) => {
    if (f !== 1 || w !== 2) return;
    const level = { price: 0, size: 0 };
    readFields(r.bytes(), (lf, lw, lr) => {
      if (lf === 1 && lw === 0) level.price = toInt32(lr.varint());
      else if (lf === 2 && lw === 0) level.size = toInt64(lr.varint());
    });
    levels.push(level);
  });
  return levels;
}

function decodeOutcome(buf: Uint8Array): RawSide {
  const side: RawSide = { bids: [], asks: [] };
  readFields(buf, (f, w, r) => {
    if (w !== 2) return;
    if (f === 1) side.bids = decodeLevels(r.bytes());
    else if (f === 2) side.asks = decodeLevels(r.bytes());
  });
  return side;
}

export function decodeSnapshot(buf: Uint8Array): SnapshotMsg {
  const m: SnapshotMsg = {
    contractId: '',
    tokenIds: [],
    outcomeNames: [],
    outcomes: [],
    seq: 0,
    epoch: 0,
    priceScale: 0,
    sizeScale: 0,
    timestampUs: 0,
  };
  readFields(buf, (f, w, r) => {
    if (f === 2 && w === 2) m.contractId = utf8.decode(r.bytes());
    else if (f === 3 && w === 0) m.timestampUs = toInt64(r.varint());
    else if (f === 4 && w === 2) m.tokenIds.push(utf8.decode(r.bytes()));
    else if (f === 5 && w === 2) m.outcomeNames.push(utf8.decode(r.bytes()));
    else if (f === 6 && w === 2) m.outcomes.push(decodeOutcome(r.bytes()));
    else if (f === 7 && w === 0) m.seq = Number(r.varint());
    else if (f === 8 && w === 0) m.epoch = Number(r.varint());
    else if (f === 9 && w === 0) m.priceScale = toInt64(r.varint());
    else if (f === 10 && w === 0) m.sizeScale = toInt64(r.varint());
  });
  return m;
}

export function decodeDelta(buf: Uint8Array): DeltaMsg {
  const m: DeltaMsg = { contractId: '', outcomes: [], seq: 0, snapshotSeq: 0, epoch: 0 };
  readFields(buf, (f, w, r) => {
    if (f === 1 && w === 2) m.contractId = utf8.decode(r.bytes());
    else if (f === 3 && w === 2) m.outcomes.push(decodeOutcome(r.bytes()));
    else if (f === 4 && w === 0) m.seq = Number(r.varint());
    else if (f === 5 && w === 0) m.snapshotSeq = Number(r.varint());
    else if (f === 6 && w === 0) m.epoch = Number(r.varint());
  });
  return m;
}

/** OrderbookDeltaBatch: repeated OrderbookDelta deltas = 1. */
export function decodeDeltaBatch(buf: Uint8Array): DeltaMsg[] {
  const out: DeltaMsg[] = [];
  readFields(buf, (f, w, r) => {
    if (f === 1 && w === 2) out.push(decodeDelta(r.bytes()));
  });
  return out;
}

export function decodeError(buf: Uint8Array): { message: string; action: string } {
  const e = { message: '', action: '' };
  readFields(buf, (f, w, r) => {
    if (w !== 2) return;
    if (f === 1) e.message = utf8.decode(r.bytes());
    else if (f === 2) e.action = utf8.decode(r.bytes());
  });
  return e;
}

// ------------------------------------------------------------------ local book

export interface BookLevel {
  /** 0–1. */
  price: number;
  /** Shares. */
  size: number;
}

export interface OutcomeBook {
  name: string;
  tokenId: string;
  /** Best first: highest bid first. */
  bids: BookLevel[];
  /** Best first: lowest ask first. */
  asks: BookLevel[];
}

export interface BookState {
  contractId: string;
  outcomes: OutcomeBook[];
  /** Our clock, ms, when the book last changed. */
  updatedAt: number;
}

/** Polymarket book sizes are shares × 100 when the snapshot doesn't carry its own size scale. */
const DEFAULT_SIZE_SCALE = 100;
const DEFAULT_PRICE_SCALE = 10_000;

/**
 * Maintains one contract's book from snapshots and deltas, enforcing the documented rules:
 * replace on snapshot; apply deltas strictly in sequence on the matching baseline; drop stale
 * epochs; on any gap stop applying and ask for a resync.
 */
export class LocalBook {
  private levels: { bids: Map<number, number>; asks: Map<number, number> }[] = [];
  private names: string[] = [];
  private tokenIds: string[] = [];
  private expectedSeq = 0;
  private snapshotSeq = -1;
  private epoch = 0;
  private priceScale = DEFAULT_PRICE_SCALE;
  private sizeScale = DEFAULT_SIZE_SCALE;
  /** True while waiting for a snapshot after a gap. */
  needsResync = true;
  updatedAt = 0;

  constructor(public readonly contractId: string) {}

  applySnapshot(s: SnapshotMsg): boolean {
    if (s.epoch && s.epoch < this.epoch) return false;
    this.epoch = Math.max(this.epoch, s.epoch);
    this.priceScale = s.priceScale || DEFAULT_PRICE_SCALE;
    this.sizeScale = s.sizeScale || DEFAULT_SIZE_SCALE;
    this.names = s.outcomeNames;
    this.tokenIds = s.tokenIds;
    this.levels = s.outcomes.map((o) => ({
      bids: new Map(o.bids.filter((l) => l.size > 0).map((l) => [l.price, l.size])),
      asks: new Map(o.asks.filter((l) => l.size > 0).map((l) => [l.price, l.size])),
    }));
    this.snapshotSeq = s.seq;
    this.expectedSeq = s.seq + 1;
    this.needsResync = false;
    this.updatedAt = Date.now();
    return true;
  }

  /** Returns 'applied', 'stale' (ignored), or 'gap' (caller should fetch a snapshot). */
  applyDelta(d: DeltaMsg): 'applied' | 'stale' | 'gap' {
    if (d.epoch && d.epoch < this.epoch) return 'stale';
    if (this.needsResync) return 'gap';
    if (d.seq < this.expectedSeq) return 'stale';
    if (d.seq > this.expectedSeq || d.snapshotSeq !== this.snapshotSeq) {
      this.needsResync = true;
      return 'gap';
    }
    d.outcomes.forEach((o, i) => {
      const book = this.levels[i];
      if (!book) return;
      for (const [side, list] of [
        [book.bids, o.bids],
        [book.asks, o.asks],
      ] as const) {
        for (const l of list) {
          if (l.size === 0) side.delete(l.price);
          else side.set(l.price, l.size);
        }
      }
    });
    this.expectedSeq = d.seq + 1;
    this.updatedAt = Date.now();
    return 'applied';
  }

  state(): BookState {
    const conv = (m: Map<number, number>, desc: boolean) =>
      [...m.entries()]
        .sort((a, b) => (desc ? b[0] - a[0] : a[0] - b[0]))
        .map(([p, s]) => ({ price: p / this.priceScale, size: s / this.sizeScale }));
    return {
      contractId: this.contractId,
      updatedAt: this.updatedAt,
      outcomes: this.levels.map((l, i) => ({
        name: this.names[i] ?? `Outcome ${i + 1}`,
        tokenId: this.tokenIds[i] ?? '',
        bids: conv(l.bids, true),
        asks: conv(l.asks, false),
      })),
    };
  }
}

// ------------------------------------------------------------------ market orders

export interface MarketFill {
  /** Shares that can be bought/sold within the limits. */
  shares: number;
  /** pUSD spent (buy) or received (sell). */
  notional: number;
  avgPrice: number;
  /** Worst price touched — used as the order's limit. */
  worstPrice: number;
  /** True if the book could absorb the whole request. */
  complete: boolean;
}

/**
 * Walks the book for a market order. Buy: spend `amount` pUSD against the asks. Sell: sell
 * `amount` shares into the bids. `maxSlippage` caps how far from the best price we'll go.
 */
export function walkBook(book: OutcomeBook, side: 'buy' | 'sell', amount: number, maxSlippage = 0.05): MarketFill | undefined {
  const levels = side === 'buy' ? book.asks : book.bids;
  if (!levels.length || !(amount > 0)) return undefined;
  const best = levels[0].price;
  const limit = side === 'buy' ? Math.min(0.99, best + maxSlippage) : Math.max(0.01, best - maxSlippage);
  let shares = 0;
  let notional = 0;
  let worst = best;
  let remaining = amount;
  for (const l of levels) {
    if (side === 'buy' ? l.price > limit : l.price < limit) break;
    const take = side === 'buy' ? Math.min(l.size, remaining / l.price) : Math.min(l.size, remaining);
    if (take <= 0) break;
    shares += take;
    notional += take * l.price;
    worst = l.price;
    remaining -= side === 'buy' ? take * l.price : take;
    if (remaining <= 1e-9) break;
  }
  if (shares <= 0) return undefined;
  return { shares, notional, avgPrice: notional / shares, worstPrice: worst, complete: remaining <= 1e-6 };
}
