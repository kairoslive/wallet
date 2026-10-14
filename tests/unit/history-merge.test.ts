import { describe, expect, it } from 'vitest';
import { mergeHistory } from '../../src/core/history/merge';
import type { TxRecord } from '../../src/core/types';

const rec = (over: Partial<TxRecord>): TxRecord => ({
  hash: '0xabc',
  networkId: 'eth',
  chainType: 'evm',
  from: '0x1',
  title: 'Contract interaction',
  direction: 'out',
  kind: 'contract',
  timestamp: 1000,
  status: 'confirmed',
  source: 'indexer',
  ...over,
});

describe('mergeHistory', () => {
  it('de-duplicates by network + hash, preferring indexer data', () => {
    const indexed = rec({ hash: '0xABC', status: 'confirmed', fee: '21000', title: 'Sent 1 ETH', kind: 'send' });
    const local = rec({ hash: '0xabc', status: 'pending', title: 'Sent 1 ETH (local)', kind: 'send', source: 'local' });
    const out = mergeHistory([local], [indexed]);
    expect(out).toEqual([indexed]);
  });

  it('EVM hashes match case-insensitively, Solana signatures case-sensitively', () => {
    const sol = (hash: string, source: TxRecord['source']) =>
      rec({ hash, networkId: 'solana', chainType: 'solana', source, kind: 'send' });
    expect(mergeHistory([sol('AbC', 'local')], [sol('abc', 'indexer')])).toHaveLength(2);
    expect(mergeHistory([sol('AbC', 'local')], [sol('AbC', 'indexer')])).toHaveLength(1);
    expect(mergeHistory([rec({ hash: '0xAbC', source: 'local' })], [rec({ hash: '0xaBc' })])).toHaveLength(1);
  });

  it('keeps the same hash on different networks separate', () => {
    expect(mergeHistory([rec({ networkId: 'base', source: 'local' })], [rec({ networkId: 'eth' })])).toHaveLength(2);
  });

  it.each(['swap', 'bridge', 'approve'] as const)('local %s title/kind override the indexer', (kind) => {
    const indexed = rec({ title: 'Called swapExactETHForTokens', kind: 'contract', status: 'confirmed', fee: '42' });
    const local = rec({
      title: 'Swapped 1 ETH → 3000 USDC',
      kind,
      status: 'pending',
      source: 'local',
      bridge: kind === 'bridge' ? { toNetworkId: 'base', tool: 'across', status: 'PENDING' } : undefined,
    });
    const [out] = mergeHistory([local], [indexed]);
    expect(out.title).toBe('Swapped 1 ETH → 3000 USDC');
    expect(out.kind).toBe(kind);
    // Everything else comes from the indexer.
    expect(out.status).toBe('confirmed');
    expect(out.fee).toBe('42');
    expect(out.source).toBe('indexer');
    expect(out.bridge).toEqual(local.bridge);
  });

  it('keeps indexer bridge info when the local record lacks it', () => {
    const indexed = rec({ bridge: { status: 'DONE' } });
    const local = rec({ kind: 'bridge', title: 'Bridged', source: 'local' });
    expect(mergeHistory([local], [indexed])[0].bridge).toEqual({ status: 'DONE' });
  });

  it('includes local-only records (e.g. still pending)', () => {
    const out = mergeHistory([rec({ hash: '0xnew', source: 'local', status: 'pending', timestamp: 5000 })], [rec({})]);
    expect(out.map((t) => t.hash)).toEqual(['0xnew', '0xabc']);
  });

  it('sorts newest first', () => {
    const indexed = [rec({ hash: '0x1', timestamp: 1 }), rec({ hash: '0x3', timestamp: 3 })];
    const local = [rec({ hash: '0x2', timestamp: 2, source: 'local' }), rec({ hash: '0x4', timestamp: 4, source: 'local' })];
    expect(mergeHistory(local, indexed).map((t) => t.hash)).toEqual(['0x4', '0x3', '0x2', '0x1']);
  });

  it('handles empty inputs', () => {
    expect(mergeHistory([], [])).toEqual([]);
  });

  it('does not mutate inputs', () => {
    const indexed = rec({});
    const local = rec({ kind: 'swap', title: 'Swapped', source: 'local' });
    mergeHistory([local], [indexed]);
    expect(indexed.title).toBe('Contract interaction');
    expect(indexed.kind).toBe('contract');
  });
});
