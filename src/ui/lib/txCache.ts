import type { TxRecord } from '../../core/types';

/** Last history page shown on Home, so the details screen can render without refetching. */
let cache: TxRecord[] = [];

export function setTxCache(txs: TxRecord[]) {
  cache = txs;
}

export function findCachedTx(networkId: string, hash: string): TxRecord | undefined {
  return cache.find((t) => t.networkId === networkId && t.hash === hash);
}
