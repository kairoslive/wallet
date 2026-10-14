import type { TxRecord } from '../types';

/** Merges indexer and locally-recorded transactions; indexer data wins except for richer local titles. */
export function mergeHistory(local: TxRecord[], indexed: TxRecord[]): TxRecord[] {
  const map = new Map<string, TxRecord>();
  const key = (t: TxRecord) => `${t.networkId}:${t.chainType === 'evm' ? t.hash.toLowerCase() : t.hash}`;
  for (const t of indexed) map.set(key(t), t);
  for (const t of local) {
    const k = key(t);
    const existing = map.get(k);
    if (!existing) map.set(k, t);
    else if (t.kind === 'swap' || t.kind === 'bridge' || t.kind === 'approve') {
      // Our own description of swaps/bridges is more meaningful than a generic "contract call".
      map.set(k, { ...existing, title: t.title, kind: t.kind, bridge: t.bridge ?? existing.bridge });
    }
  }
  return [...map.values()].sort((a, b) => b.timestamp - a.timestamp);
}
