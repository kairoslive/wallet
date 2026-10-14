import type { ParsedTransactionWithMeta } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import { connection } from '../solana/client';
import { formatAmount } from '../format';
import type { SolanaNetwork, TxRecord } from '../types';

export interface TokenSymbolLookup {
  (mint: string): string | undefined;
}

/** Derives a human-readable record from a parsed transaction, from the owner's perspective. */
export function summarizeSolanaTx(
  network: SolanaNetwork,
  owner: string,
  signature: string,
  tx: ParsedTransactionWithMeta,
  symbolFor: TokenSymbolLookup = () => undefined,
): TxRecord {
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
  const idx = keys.indexOf(owner);
  const meta = tx.meta;
  const feePayer = keys[0];
  const fee = BigInt(meta?.fee ?? 0);
  let solDelta = 0n;
  if (meta && idx >= 0) {
    solDelta = BigInt(meta.postBalances[idx]) - BigInt(meta.preBalances[idx]);
    if (feePayer === owner) solDelta += fee; // Report the transfer amount excluding the fee.
  }
  const tokenDeltas = new Map<string, { delta: bigint; decimals: number }>();
  for (const b of meta?.preTokenBalances ?? []) {
    if (b.owner !== owner) continue;
    const e = tokenDeltas.get(b.mint) ?? { delta: 0n, decimals: b.uiTokenAmount.decimals };
    e.delta -= BigInt(b.uiTokenAmount.amount);
    tokenDeltas.set(b.mint, e);
  }
  for (const b of meta?.postTokenBalances ?? []) {
    if (b.owner !== owner) continue;
    const e = tokenDeltas.get(b.mint) ?? { delta: 0n, decimals: b.uiTokenAmount.decimals };
    e.delta += BigInt(b.uiTokenAmount.amount);
    tokenDeltas.set(b.mint, e);
  }
  const changes: { symbol: string; delta: bigint; decimals: number }[] = [];
  // Ignore SOL dust movements that are just token-account rent when tokens moved too.
  for (const [mint, e] of tokenDeltas) if (e.delta !== 0n) changes.push({ symbol: symbolFor(mint) ?? `${mint.slice(0, 4)}…`, ...e });
  if (solDelta !== 0n && (changes.length === 0 || absBig(solDelta) > 3_000_000n)) {
    changes.unshift({ symbol: network.nativeCurrency.symbol, delta: solDelta, decimals: network.nativeCurrency.decimals });
  }
  const outs = changes.filter((c) => c.delta < 0n);
  const ins = changes.filter((c) => c.delta > 0n);
  const fmt = (c: (typeof changes)[number]) => `${formatAmount(absBig(c.delta), c.decimals)} ${c.symbol}`;
  let title = 'Transaction';
  let kind: TxRecord['kind'] = 'contract';
  let dir: TxRecord['direction'] = 'contract';
  let main = changes[0];
  if (outs.length && ins.length) {
    title = `Swapped ${fmt(outs[0])} → ${fmt(ins[0])}`;
    kind = 'swap';
    dir = 'out';
    main = outs[0];
  } else if (outs.length) {
    title = `Sent ${fmt(outs[0])}`;
    kind = 'send';
    dir = 'out';
    main = outs[0];
  } else if (ins.length) {
    title = `Received ${fmt(ins[0])}`;
    kind = 'receive';
    dir = 'in';
    main = ins[0];
  }
  // Best-effort counterparty: the other account whose SOL balance moved opposite to ours.
  let counterparty: string | undefined;
  if (meta && idx >= 0) {
    for (let i = 0; i < keys.length; i++) {
      if (i === idx) continue;
      const d = BigInt(meta.postBalances[i]) - BigInt(meta.preBalances[i]);
      if ((dir === 'out' && d > 0n) || (dir === 'in' && d < 0n)) {
        counterparty = keys[i];
        break;
      }
    }
  }
  return {
    hash: signature,
    networkId: network.id,
    chainType: 'solana',
    from: dir === 'in' ? (counterparty ?? feePayer) : owner,
    to: dir === 'in' ? owner : counterparty,
    title,
    direction: dir,
    kind,
    amount: main ? formatAmount(absBig(main.delta), main.decimals) : undefined,
    symbol: main?.symbol,
    timestamp: (tx.blockTime ?? 0) * 1000,
    status: meta?.err ? 'failed' : 'confirmed',
    fee: feePayer === owner ? fee.toString() : undefined,
    source: 'indexer',
  };
}

function absBig(x: bigint): bigint {
  return x < 0n ? -x : x;
}

export async function fetchSolanaHistory(
  network: SolanaNetwork,
  owner: string,
  symbolFor?: TokenSymbolLookup,
  limit = 15,
): Promise<TxRecord[]> {
  const conn = connection(network);
  const sigs = await conn.getSignaturesForAddress(new PublicKey(owner), { limit });
  const out: TxRecord[] = [];
  // Fetch sequentially in small groups: public RPCs throttle batched getTransaction calls.
  for (let i = 0; i < sigs.length; i += 5) {
    const group = sigs.slice(i, i + 5);
    const txs = await Promise.all(
      group.map((s) =>
        conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null),
      ),
    );
    group.forEach((s, j) => {
      const tx = txs[j];
      if (tx) out.push(summarizeSolanaTx(network, owner, s.signature, tx, symbolFor));
      else
        out.push({
          hash: s.signature,
          networkId: network.id,
          chainType: 'solana',
          from: owner,
          title: 'Transaction',
          direction: 'contract',
          kind: 'contract',
          timestamp: (s.blockTime ?? 0) * 1000,
          status: s.err ? 'failed' : 'confirmed',
          source: 'indexer',
        });
    });
  }
  return out;
}
