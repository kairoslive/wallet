import { describe, expect, it } from 'vitest';
import {
  LocalBook,
  TAG,
  decodeDelta,
  decodeDeltaBatch,
  decodeError,
  decodeSnapshot,
  encodeFetch,
  encodeSubscribe,
  walkBook,
  type DeltaMsg,
  type OutcomeBook,
  type SnapshotMsg,
} from '../../src/core/predictions/orderbook';

// ------------------------------------------------------------------ tiny protobuf writer for fixtures

const varint = (v: number | bigint): number[] => {
  let n = BigInt.asUintN(64, BigInt(v));
  const out: number[] = [];
  while (n > 0x7fn) {
    out.push(Number(n & 0x7fn) | 0x80);
    n >>= 7n;
  }
  out.push(Number(n));
  return out;
};
const key = (f: number, w: number) => varint((f << 3) | w);
const vfield = (f: number, v: number | bigint) => [...key(f, 0), ...varint(v)];
const bfield = (f: number, b: number[]) => [...key(f, 2), ...varint(b.length), ...b];
const sfield = (f: number, s: string) => bfield(f, [...new TextEncoder().encode(s)]);
const level = (price: number, size: number) => [...vfield(1, price), ...vfield(2, size)];
const side = (levels: [number, number][]) => levels.flatMap(([p, s]) => bfield(1, level(p, s)));
const outcome = (bids: [number, number][], asks: [number, number][]) => [...bfield(1, side(bids)), ...bfield(2, side(asks))];

function snapshotBytes(o: { seq: number; epoch?: number; yes: [[number, number][], [number, number][]] }) {
  return Uint8Array.from([
    ...vfield(1, 2),
    ...sfield(2, '2589812'),
    ...vfield(3, 1_700_000_000_000_000),
    ...sfield(4, 'tokYes'),
    ...sfield(4, 'tokNo'),
    ...sfield(5, 'Yes'),
    ...sfield(5, 'No'),
    ...bfield(6, outcome(o.yes[0], o.yes[1])),
    ...bfield(6, outcome([[2800, 1000]], [[2900, 2000]])),
    ...vfield(7, o.seq),
    ...vfield(8, o.epoch ?? 1),
  ]);
}

function deltaBytes(seq: number, snapshotSeq: number, bids: [number, number][], asks: [number, number][], epoch = 1) {
  return [
    ...sfield(1, '2589812'),
    ...bfield(3, outcome(bids, asks)),
    ...vfield(4, seq),
    ...vfield(5, snapshotSeq),
    ...vfield(6, epoch),
  ];
}

describe('orderbook codec', () => {
  it('encodes subscribe and fetch frames with their tags', () => {
    const sub = encodeSubscribe('2589812', 'polymarket', ['orderbook_slow']);
    expect(sub[0]).toBe(TAG.SUBSCRIBE);
    expect([...sub.subarray(1)]).toEqual([...sfield(1, '2589812'), ...sfield(2, 'polymarket'), ...sfield(3, 'orderbook_slow')]);
    expect(encodeFetch('1', 'polymarket')[0]).toBe(TAG.FETCH);
  });

  it('decodes a snapshot, including unknown fields it should skip', () => {
    const bytes = Uint8Array.from([
      ...snapshotBytes({ seq: 7, yes: [[[7100, 1_420_976]], [[7200, 12_422]]] }),
      ...vfield(99, 5),
      ...sfield(98, 'x'),
    ]);
    const s = decodeSnapshot(bytes);
    expect(s).toMatchObject({
      contractId: '2589812',
      tokenIds: ['tokYes', 'tokNo'],
      outcomeNames: ['Yes', 'No'],
      seq: 7,
      epoch: 1,
    });
    expect(s.outcomes[0]).toEqual({ bids: [{ price: 7100, size: 1_420_976 }], asks: [{ price: 7200, size: 12_422 }] });
  });

  it('decodes delta batches and errors', () => {
    const batch = Uint8Array.from([
      ...bfield(1, deltaBytes(8, 7, [[7100, 0]], [])),
      ...bfield(1, deltaBytes(9, 7, [[7050, 500]], [])),
    ]);
    const deltas = decodeDeltaBatch(batch);
    expect(deltas.map((d) => d.seq)).toEqual([8, 9]);
    expect(deltas[0].outcomes[0].bids).toEqual([{ price: 7100, size: 0 }]);
    expect(decodeDelta(Uint8Array.from(deltaBytes(3, 2, [], [])))).toMatchObject({ seq: 3, snapshotSeq: 2 });
    expect(decodeError(Uint8Array.from([...sfield(1, 'nope'), ...sfield(2, 'fetch_waiting:polymarket:1')]))).toEqual({
      message: 'nope',
      action: 'fetch_waiting:polymarket:1',
    });
  });
});

describe('LocalBook', () => {
  const snap = (seq: number, epoch = 1): SnapshotMsg =>
    decodeSnapshot(
      snapshotBytes({
        seq,
        epoch,
        yes: [
          [
            [7100, 10_000],
            [7000, 5_000],
          ],
          [
            [7200, 2_000],
            [7300, 3_000],
          ],
        ],
      }),
    );
  const delta = (
    seq: number,
    snapshotSeq: number,
    bids: [number, number][] = [],
    asks: [number, number][] = [],
    epoch = 1,
  ): DeltaMsg => decodeDelta(Uint8Array.from(deltaBytes(seq, snapshotSeq, bids, asks, epoch)));

  it('converts scaled prices and sizes and sorts best-first', () => {
    const b = new LocalBook('2589812');
    b.applySnapshot(snap(10));
    const yes = b.state().outcomes[0];
    expect(yes.name).toBe('Yes');
    expect(yes.bids).toEqual([
      { price: 0.71, size: 100 },
      { price: 0.7, size: 50 },
    ]);
    expect(yes.asks[0]).toEqual({ price: 0.72, size: 20 });
  });

  it('applies in-sequence deltas: insert, replace and remove levels', () => {
    const b = new LocalBook('c');
    b.applySnapshot(snap(10));
    expect(
      b.applyDelta(
        delta(
          11,
          10,
          [
            [7100, 0],
            [7150, 4_000],
          ],
          [[7200, 9_000]],
        ),
      ),
    ).toBe('applied');
    const yes = b.state().outcomes[0];
    expect(yes.bids.map((l) => l.price)).toEqual([0.715, 0.7]);
    expect(yes.asks[0]).toEqual({ price: 0.72, size: 90 });
  });

  it('drops stale deltas and old epochs, and stops on gaps until a new snapshot', () => {
    const b = new LocalBook('c');
    b.applySnapshot(snap(10, 2));
    expect(b.applyDelta(delta(10, 10, [], [], 2))).toBe('stale');
    // An older streamer epoch is fenced off even when its seq looks right.
    expect(b.applyDelta(delta(11, 10, [], [], 1))).toBe('stale');
    expect(b.applyDelta(delta(13, 10, [], [], 2))).toBe('gap');
    // Still resyncing: even the "next" delta must not be applied on top of a broken baseline.
    expect(b.applyDelta(delta(11, 10, [], [], 2))).toBe('gap');
    expect(b.applySnapshot(snap(20, 1))).toBe(false);
    expect(b.applySnapshot(snap(20, 2))).toBe(true);
    expect(b.applyDelta(delta(21, 20, [], [], 2))).toBe('applied');
  });

  it('treats a delta built on another baseline as a gap', () => {
    const b = new LocalBook('c');
    b.applySnapshot(snap(10));
    expect(b.applyDelta(delta(11, 9))).toBe('gap');
    expect(b.needsResync).toBe(true);
  });
});

describe('walkBook', () => {
  const book: OutcomeBook = {
    name: 'Yes',
    tokenId: 't',
    bids: [
      { price: 0.71, size: 100 },
      { price: 0.7, size: 100 },
      { price: 0.5, size: 1000 },
    ],
    asks: [
      { price: 0.72, size: 10 },
      { price: 0.73, size: 100 },
      { price: 0.9, size: 1000 },
    ],
  };

  it('buys across levels for a pUSD amount', () => {
    const f = walkBook(book, 'buy', 20)!;
    // 10 @ 0.72 = 7.20, then 12.80 / 0.73 = 17.534… shares
    expect(f.shares).toBeCloseTo(10 + 12.8 / 0.73, 6);
    expect(f.notional).toBeCloseTo(20, 9);
    expect(f.worstPrice).toBe(0.73);
    expect(f.avgPrice).toBeCloseTo(20 / f.shares, 9);
    expect(f.complete).toBe(true);
  });

  it('stops at the slippage cap and reports a partial fill', () => {
    const f = walkBook(book, 'buy', 500, 0.05)!;
    expect(f.worstPrice).toBe(0.73);
    expect(f.shares).toBe(110);
    expect(f.complete).toBe(false);
  });

  it('sells shares into the bids', () => {
    const f = walkBook(book, 'sell', 150)!;
    expect(f.shares).toBe(150);
    expect(f.notional).toBeCloseTo(100 * 0.71 + 50 * 0.7, 9);
    expect(f.worstPrice).toBe(0.7);
  });

  it('returns nothing for an empty side or zero amount', () => {
    expect(walkBook({ ...book, asks: [] }, 'buy', 10)).toBeUndefined();
    expect(walkBook(book, 'buy', 0)).toBeUndefined();
  });
});
