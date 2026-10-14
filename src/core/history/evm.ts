import { formatAmount } from '../format';
import { getJson, joinUrl, type Fetch } from '../http';
import { sameAddress } from '../address';
import type { EvmNetwork, TxRecord } from '../types';

type Addr = { hash: string } | null;

interface BlockscoutTx {
  hash: string;
  timestamp: string;
  from: Addr;
  to: Addr;
  value: string;
  status: 'ok' | 'error' | null;
  result?: string;
  fee?: { value: string } | null;
  method?: string | null;
  transaction_types?: string[];
}

interface BlockscoutTokenTransfer {
  transaction_hash?: string;
  tx_hash?: string;
  timestamp: string;
  from: Addr;
  to: Addr;
  token: { address?: string; address_hash?: string; symbol: string | null; decimals: string | null; type?: string };
  total: { value?: string; decimals?: string | null } | null;
}

function direction(owner: string, from?: string, to?: string): TxRecord['direction'] {
  const out = sameAddress(owner, from);
  const inc = sameAddress(owner, to);
  if (out && inc) return 'self';
  if (out) return 'out';
  if (inc) return 'in';
  return 'contract';
}

function titleFor(dir: TxRecord['direction'], amount: string, symbol: string, method?: string | null): string {
  if (dir === 'in') return `Received ${amount} ${symbol}`;
  if (dir === 'self') return `Sent ${amount} ${symbol} to self`;
  if (amount === '0' && method) return `Called ${method}`;
  if (dir === 'out') return `Sent ${amount} ${symbol}`;
  return method ? `Called ${method}` : 'Contract interaction';
}

export async function fetchBlockscoutHistory(
  network: EvmNetwork,
  url: string,
  owner: string,
  fetchFn: Fetch = fetch,
): Promise<TxRecord[]> {
  const [txs, transfers] = await Promise.all([
    getJson<{ items: BlockscoutTx[] }>(joinUrl(url, `api/v2/addresses/${owner}/transactions`), {}, fetchFn),
    getJson<{ items: BlockscoutTokenTransfer[] }>(
      joinUrl(url, `api/v2/addresses/${owner}/token-transfers?type=ERC-20`),
      {},
      fetchFn,
    ).catch(() => ({ items: [] as BlockscoutTokenTransfer[] })),
  ]);
  const records = new Map<string, TxRecord>();
  const sym = network.nativeCurrency.symbol;
  for (const t of txs.items ?? []) {
    const dir = direction(owner, t.from?.hash, t.to?.hash ?? undefined);
    const amount = formatAmount(t.value ?? '0', network.nativeCurrency.decimals);
    const isTransfer = !t.method || t.method === 'transfer' || (t.transaction_types ?? []).includes('coin_transfer');
    records.set(t.hash.toLowerCase(), {
      hash: t.hash,
      networkId: network.id,
      chainType: 'evm',
      from: t.from?.hash ?? '',
      to: t.to?.hash ?? undefined,
      title: titleFor(dir, amount, sym, isTransfer && t.value !== '0' ? null : t.method),
      direction: dir,
      kind: dir === 'in' ? 'receive' : isTransfer && t.value !== '0' ? 'send' : 'contract',
      amount,
      symbol: sym,
      timestamp: Date.parse(t.timestamp),
      status: t.status === 'error' ? 'failed' : t.status === 'ok' ? 'confirmed' : 'pending',
      fee: t.fee?.value,
      source: 'indexer',
    });
  }
  for (const tr of transfers.items ?? []) {
    const hash = tr.transaction_hash ?? tr.tx_hash;
    if (!hash) continue;
    const decimals = Number(tr.total?.decimals ?? tr.token.decimals ?? 18);
    const symbol = tr.token.symbol ?? 'TOKEN';
    const amount = formatAmount(tr.total?.value ?? '0', decimals);
    const dir = direction(owner, tr.from?.hash, tr.to?.hash);
    const existing = records.get(hash.toLowerCase());
    const title = dir === 'in' ? `Received ${amount} ${symbol}` : dir === 'out' ? `Sent ${amount} ${symbol}` : `${amount} ${symbol}`;
    if (existing) {
      // A token transfer inside a tx we already know about: prefer the token description.
      if (existing.kind === 'contract' || existing.amount === '0') {
        Object.assign(existing, { title, amount, symbol, direction: dir, kind: dir === 'in' ? 'receive' : 'send' });
      }
      continue;
    }
    records.set(hash.toLowerCase(), {
      hash,
      networkId: network.id,
      chainType: 'evm',
      from: tr.from?.hash ?? '',
      to: tr.to?.hash,
      title,
      direction: dir,
      kind: dir === 'in' ? 'receive' : 'send',
      amount,
      symbol,
      timestamp: Date.parse(tr.timestamp),
      status: 'confirmed',
      source: 'indexer',
    });
  }
  return [...records.values()];
}

interface EtherscanTx {
  hash: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  isError?: string;
  functionName?: string;
  gasUsed?: string;
  gasPrice?: string;
  tokenSymbol?: string;
  tokenDecimal?: string;
}

export async function fetchEtherscanHistory(
  network: EvmNetwork,
  url: string,
  apiKey: string | undefined,
  owner: string,
  fetchFn: Fetch = fetch,
): Promise<TxRecord[]> {
  const q = (action: string) => {
    const u = new URL(url);
    u.searchParams.set('chainid', String(network.chainId));
    u.searchParams.set('module', 'account');
    u.searchParams.set('action', action);
    u.searchParams.set('address', owner);
    u.searchParams.set('page', '1');
    u.searchParams.set('offset', '25');
    u.searchParams.set('sort', 'desc');
    if (apiKey) u.searchParams.set('apikey', apiKey);
    return u.toString();
  };
  const unwrap = (r: { status: string; message: string; result: EtherscanTx[] | string }) => {
    if (Array.isArray(r.result)) return r.result;
    if (r.message === 'No transactions found') return [];
    throw new Error(typeof r.result === 'string' ? r.result : r.message);
  };
  const [txs, tokens] = await Promise.all([
    getJson<{ status: string; message: string; result: EtherscanTx[] | string }>(q('txlist'), {}, fetchFn).then(unwrap),
    getJson<{ status: string; message: string; result: EtherscanTx[] | string }>(q('tokentx'), {}, fetchFn)
      .then(unwrap)
      .catch(() => []),
  ]);
  const records = new Map<string, TxRecord>();
  const sym = network.nativeCurrency.symbol;
  for (const t of txs) {
    const dir = direction(owner, t.from, t.to);
    const amount = formatAmount(t.value, network.nativeCurrency.decimals);
    const method = t.functionName ? t.functionName.split('(')[0] : undefined;
    records.set(t.hash.toLowerCase(), {
      hash: t.hash,
      networkId: network.id,
      chainType: 'evm',
      from: t.from,
      to: t.to || undefined,
      title: titleFor(dir, amount, sym, method),
      direction: dir,
      kind: dir === 'in' ? 'receive' : method ? 'contract' : 'send',
      amount,
      symbol: sym,
      timestamp: Number(t.timeStamp) * 1000,
      status: t.isError === '1' ? 'failed' : 'confirmed',
      fee: t.gasUsed && t.gasPrice ? (BigInt(t.gasUsed) * BigInt(t.gasPrice)).toString() : undefined,
      source: 'indexer',
    });
  }
  for (const t of tokens) {
    const dir = direction(owner, t.from, t.to);
    const amount = formatAmount(t.value, Number(t.tokenDecimal ?? 18));
    const symbol = t.tokenSymbol ?? 'TOKEN';
    const title = dir === 'in' ? `Received ${amount} ${symbol}` : `Sent ${amount} ${symbol}`;
    const existing = records.get(t.hash.toLowerCase());
    if (existing) {
      if (existing.amount === '0') Object.assign(existing, { title, amount, symbol, direction: dir, kind: dir === 'in' ? 'receive' : 'send' });
      continue;
    }
    records.set(t.hash.toLowerCase(), {
      hash: t.hash,
      networkId: network.id,
      chainType: 'evm',
      from: t.from,
      to: t.to,
      title,
      direction: dir,
      kind: dir === 'in' ? 'receive' : 'send',
      amount,
      symbol,
      timestamp: Number(t.timeStamp) * 1000,
      status: 'confirmed',
      source: 'indexer',
    });
  }
  return [...records.values()];
}

export async function fetchEvmHistory(network: EvmNetwork, owner: string, fetchFn: Fetch = fetch): Promise<TxRecord[]> {
  const h = network.history;
  if (h.kind === 'blockscout') return fetchBlockscoutHistory(network, h.url, owner, fetchFn);
  if (h.kind === 'etherscan') return fetchEtherscanHistory(network, h.url, h.apiKey, owner, fetchFn);
  return [];
}
