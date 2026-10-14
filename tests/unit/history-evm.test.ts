import { describe, expect, it } from 'vitest';
import { fetchBlockscoutHistory, fetchEtherscanHistory, fetchEvmHistory } from '../../src/core/history/evm';
import { DEFAULT_NETWORKS } from '../../src/core/networks';
import type { EvmNetwork, TxRecord } from '../../src/core/types';
import { json, mockFetch } from './helpers/mockFetch';

const eth = DEFAULT_NETWORKS.find((n) => n.id === 'eth') as EvmNetwork;
const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const BOB = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
const ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
const h = (c: string) => `0x${c.repeat(64)}`;

const byHash = (records: TxRecord[], hash: string) => records.find((r) => r.hash.toLowerCase() === hash.toLowerCase())!;

// ---------------------------------------------------------------- Blockscout fixtures (API v2 shape)

const addr = (hash: string) => ({ hash, is_contract: false, name: null, implementations: [] });

const BS_TXS = {
  items: [
    {
      // Plain native send.
      hash: h('a'),
      timestamp: '2024-05-01T12:00:00.000000Z',
      from: addr(OWNER),
      to: addr(BOB),
      value: '1500000000000000000',
      status: 'ok',
      result: 'success',
      fee: { type: 'actual', value: '21000000000000' },
      method: null,
      transaction_types: ['coin_transfer'],
      block_number: 19_000_000,
    },
    {
      // Native receive; Blockscout sometimes returns lowercase hashes.
      hash: h('b'),
      timestamp: '2024-05-02T08:30:00.000000Z',
      from: addr(BOB),
      to: addr(OWNER.toLowerCase()),
      value: '200000000000000000',
      status: 'ok',
      result: 'success',
      fee: { type: 'actual', value: '21000000000000' },
      method: null,
      transaction_types: ['coin_transfer'],
    },
    {
      // ERC-20 transfer() call; the token transfer is reported separately.
      hash: h('c'),
      timestamp: '2024-05-03T00:00:00.000000Z',
      from: addr(OWNER),
      to: { ...addr(USDC), is_contract: true, name: 'FiatTokenProxy' },
      value: '0',
      status: 'ok',
      result: 'success',
      fee: { type: 'actual', value: '50000000000000' },
      method: 'transfer',
      transaction_types: ['contract_call', 'token_transfer'],
    },
    {
      // Failed router call.
      hash: h('d'),
      timestamp: '2024-05-04T00:00:00.000000Z',
      from: addr(OWNER),
      to: addr(ROUTER),
      value: '0',
      status: 'error',
      result: 'Reverted',
      fee: { type: 'actual', value: '90000000000000' },
      method: 'swapExactTokensForETH',
      transaction_types: ['contract_call'],
    },
    {
      // Pending approve.
      hash: h('e'),
      timestamp: '2024-05-05T00:00:00.000000Z',
      from: addr(OWNER),
      to: addr(DAI),
      value: '0',
      status: null,
      result: 'pending',
      fee: null,
      method: 'approve',
      transaction_types: ['contract_call'],
    },
    {
      // Send to self.
      hash: h('f'),
      timestamp: '2024-05-06T00:00:00.000000Z',
      from: addr(OWNER),
      to: addr(OWNER),
      value: '1000000000000000',
      status: 'ok',
      result: 'success',
      fee: { type: 'actual', value: '1' },
      method: null,
      transaction_types: ['coin_transfer'],
    },
    {
      // Contract creation: `to` is null.
      hash: h('9'),
      timestamp: '2024-05-07T00:00:00.000000Z',
      from: addr(OWNER),
      to: null,
      value: '0',
      status: 'ok',
      result: 'success',
      fee: { type: 'actual', value: '1' },
      method: null,
      transaction_types: ['contract_creation'],
    },
  ],
  next_page_params: null,
};

const BS_TRANSFERS = {
  items: [
    {
      // Current field names: transaction_hash + token.address_hash. Upper-case hash checks case-insensitive merge.
      transaction_hash: `0x${'C'.repeat(64)}`,
      timestamp: '2024-05-03T00:00:00.000000Z',
      from: addr(OWNER),
      to: addr(BOB),
      token: { address_hash: USDC, symbol: 'USDC', decimals: '6', type: 'ERC-20', name: 'USD Coin' },
      total: { value: '25000000', decimals: '6' },
      type: 'token_transfer',
      log_index: 12,
    },
    {
      // Legacy field names: tx_hash + token.address; decimals only on the token; incoming-only tx.
      tx_hash: h('1'),
      timestamp: '2024-04-30T00:00:00.000000Z',
      from: addr(BOB),
      to: addr(OWNER),
      token: { address: DAI, symbol: 'DAI', decimals: '18', type: 'ERC-20' },
      total: { value: '100000000000000000000', decimals: null },
    },
    {
      // No symbol / decimals at all.
      transaction_hash: h('2'),
      timestamp: '2024-04-29T00:00:00.000000Z',
      from: addr(OWNER),
      to: addr(BOB),
      token: { address_hash: '0x1111111111111111111111111111111111111111', symbol: null, decimals: null },
      total: { value: '1234500000000000000000' },
    },
    {
      // Missing hash entirely: must be skipped.
      timestamp: '2024-04-28T00:00:00.000000Z',
      from: addr(BOB),
      to: addr(OWNER),
      token: { address_hash: USDC, symbol: 'USDC', decimals: '6' },
      total: { value: '1', decimals: '6' },
    },
  ],
};

function blockscoutFetch(opts: { transfers?: 'ok' | 'fail'; txs?: 'ok' | 'fail' } = {}) {
  return mockFetch((url) => {
    if (url.pathname.endsWith('/transactions')) {
      return opts.txs === 'fail' ? json({ message: 'Internal error' }, 500, 'Server Error') : BS_TXS;
    }
    if (url.pathname.endsWith('/token-transfers')) {
      return opts.transfers === 'fail' ? json({ message: 'nope' }, 500, 'Server Error') : BS_TRANSFERS;
    }
    throw new Error(`unexpected url ${url}`);
  });
}

describe('fetchBlockscoutHistory', () => {
  it('requests transactions and ERC-20 transfers for the owner', async () => {
    const f = blockscoutFetch();
    await fetchBlockscoutHistory(eth, 'https://eth.blockscout.com/', OWNER, f);
    const urls = f.calls.map((c) => c.url).sort();
    expect(urls).toEqual([
      `https://eth.blockscout.com/api/v2/addresses/${OWNER}/token-transfers?type=ERC-20`,
      `https://eth.blockscout.com/api/v2/addresses/${OWNER}/transactions`,
    ]);
  });

  it('parses a native send', async () => {
    const r = byHash(await fetchBlockscoutHistory(eth, 'https://eth.blockscout.com', OWNER, blockscoutFetch()), h('a'));
    expect(r).toEqual<TxRecord>({
      hash: h('a'),
      networkId: 'eth',
      chainType: 'evm',
      from: OWNER,
      to: BOB,
      title: 'Sent 1.5 ETH',
      direction: 'out',
      kind: 'send',
      amount: '1.5',
      symbol: 'ETH',
      timestamp: Date.parse('2024-05-01T12:00:00Z'),
      status: 'confirmed',
      fee: '21000000000000',
      source: 'indexer',
    });
  });

  it('parses a native receive (address case-insensitive)', async () => {
    const r = byHash(await fetchBlockscoutHistory(eth, 'https://eth.blockscout.com', OWNER, blockscoutFetch()), h('b'));
    expect(r).toMatchObject({ title: 'Received 0.2 ETH', direction: 'in', kind: 'receive', amount: '0.2', from: BOB });
    expect(r.timestamp).toBe(Date.UTC(2024, 4, 2, 8, 30));
  });

  it('describes a contract call by its ERC-20 transfer', async () => {
    const r = byHash(await fetchBlockscoutHistory(eth, 'https://eth.blockscout.com', OWNER, blockscoutFetch()), h('c'));
    expect(r).toMatchObject({
      hash: h('c'),
      title: 'Sent 25 USDC',
      amount: '25',
      symbol: 'USDC',
      direction: 'out',
      kind: 'send',
      status: 'confirmed',
      fee: '50000000000000',
    });
  });

  it('without token transfers, a zero-value call is described by its method', async () => {
    const f = mockFetch((url) => (url.pathname.endsWith('/transactions') ? BS_TXS : { items: [] }));
    const r = byHash(await fetchBlockscoutHistory(eth, 'https://eth.blockscout.com', OWNER, f), h('c'));
    expect(r).toMatchObject({ title: 'Called transfer', kind: 'contract', amount: '0', symbol: 'ETH' });
  });

  it('marks failed and pending transactions', async () => {
    const records = await fetchBlockscoutHistory(eth, 'https://eth.blockscout.com', OWNER, blockscoutFetch());
    expect(byHash(records, h('d'))).toMatchObject({
      status: 'failed',
      title: 'Called swapExactTokensForETH',
      kind: 'contract',
      direction: 'out',
      fee: '90000000000000',
    });
    expect(byHash(records, h('e'))).toMatchObject({ status: 'pending', title: 'Called approve', fee: undefined });
  });

  it('handles self sends and contract creation', async () => {
    const records = await fetchBlockscoutHistory(eth, 'https://eth.blockscout.com', OWNER, blockscoutFetch());
    expect(byHash(records, h('f'))).toMatchObject({ direction: 'self', title: 'Sent 0.001 ETH to self', kind: 'send' });
    const create = byHash(records, h('9'));
    expect(create.to).toBeUndefined();
    expect(create).toMatchObject({ direction: 'out', kind: 'contract', status: 'confirmed' });
  });

  it('adds token-only transfers using legacy tx_hash / token.address fields', async () => {
    const records = await fetchBlockscoutHistory(eth, 'https://eth.blockscout.com', OWNER, blockscoutFetch());
    expect(byHash(records, h('1'))).toEqual<TxRecord>({
      hash: h('1'),
      networkId: 'eth',
      chainType: 'evm',
      from: BOB,
      to: OWNER,
      title: 'Received 100 DAI',
      direction: 'in',
      kind: 'receive',
      amount: '100',
      symbol: 'DAI',
      timestamp: Date.parse('2024-04-30T00:00:00Z'),
      status: 'confirmed',
      source: 'indexer',
    });
    // Missing symbol/decimals falls back to TOKEN / 18 decimals.
    expect(byHash(records, h('2'))).toMatchObject({ title: 'Sent 1,234.5 TOKEN', symbol: 'TOKEN', amount: '1,234.5' });
  });

  it('skips transfers without a hash and never duplicates hashes', async () => {
    const records = await fetchBlockscoutHistory(eth, 'https://eth.blockscout.com', OWNER, blockscoutFetch());
    expect(records).toHaveLength(BS_TXS.items.length + 2);
    const keys = records.map((r) => r.hash.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
    expect(records.every((r) => r.source === 'indexer' && r.chainType === 'evm')).toBe(true);
  });

  it('tolerates a failing token-transfer endpoint', async () => {
    const records = await fetchBlockscoutHistory(eth, 'https://eth.blockscout.com', OWNER, blockscoutFetch({ transfers: 'fail' }));
    expect(records).toHaveLength(BS_TXS.items.length);
  });

  it('propagates a failing transactions endpoint', async () => {
    await expect(
      fetchBlockscoutHistory(eth, 'https://eth.blockscout.com', OWNER, blockscoutFetch({ txs: 'fail' })),
    ).rejects.toThrow('Internal error');
  });

  it('handles empty / missing item arrays', async () => {
    const f = mockFetch(() => ({}));
    expect(await fetchBlockscoutHistory(eth, 'https://eth.blockscout.com', OWNER, f)).toEqual([]);
  });

  it('uses the network native symbol and decimals', async () => {
    const pol = DEFAULT_NETWORKS.find((n) => n.id === 'polygon') as EvmNetwork;
    const f = mockFetch((url) => (url.pathname.endsWith('/transactions') ? { items: [BS_TXS.items[0]] } : { items: [] }));
    const [r] = await fetchBlockscoutHistory(pol, 'https://polygon.blockscout.com', OWNER, f);
    expect(r).toMatchObject({ networkId: 'polygon', title: 'Sent 1.5 POL', symbol: 'POL' });
  });
});

// ---------------------------------------------------------------- Etherscan v2 fixtures

const ES_TXLIST = {
  status: '1',
  message: 'OK',
  result: [
    {
      blockNumber: '19000000',
      timeStamp: '1714564800',
      hash: h('a'),
      from: OWNER.toLowerCase(),
      to: BOB.toLowerCase(),
      value: '1500000000000000000',
      gas: '21000',
      gasPrice: '1000000000',
      gasUsed: '21000',
      isError: '0',
      txreceipt_status: '1',
      input: '0x',
      methodId: '0x',
      functionName: '',
    },
    {
      timeStamp: '1714651200',
      hash: h('b'),
      from: BOB.toLowerCase(),
      to: OWNER.toLowerCase(),
      value: '200000000000000000',
      gasPrice: '1000000000',
      gasUsed: '21000',
      isError: '0',
      functionName: '',
    },
    {
      timeStamp: '1714694400',
      hash: h('c'),
      from: OWNER.toLowerCase(),
      to: USDC.toLowerCase(),
      value: '0',
      gasPrice: '2000000000',
      gasUsed: '50000',
      isError: '0',
      functionName: 'transfer(address _to, uint256 _value)',
    },
    {
      timeStamp: '1714780800',
      hash: h('d'),
      from: OWNER.toLowerCase(),
      to: ROUTER.toLowerCase(),
      value: '0',
      gasPrice: '1',
      gasUsed: '90000',
      isError: '1',
      functionName: 'swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
    },
    {
      // Contract creation: empty `to`.
      timeStamp: '1714867200',
      hash: h('9'),
      from: OWNER.toLowerCase(),
      to: '',
      value: '0',
      isError: '0',
      functionName: '',
    },
  ],
};

const ES_TOKENTX = {
  status: '1',
  message: 'OK',
  result: [
    {
      timeStamp: '1714694400',
      hash: `0x${'C'.repeat(64)}`,
      from: OWNER.toLowerCase(),
      to: BOB.toLowerCase(),
      value: '25000000',
      contractAddress: USDC.toLowerCase(),
      tokenName: 'USD Coin',
      tokenSymbol: 'USDC',
      tokenDecimal: '6',
    },
    {
      timeStamp: '1714478400',
      hash: h('1'),
      from: BOB.toLowerCase(),
      to: OWNER.toLowerCase(),
      value: '100000000000000000000',
      contractAddress: DAI.toLowerCase(),
      tokenSymbol: 'DAI',
      tokenDecimal: '18',
    },
  ],
};

function etherscanFetch(over: { txlist?: unknown; tokentx?: unknown } = {}) {
  return mockFetch((url) => {
    const action = url.searchParams.get('action');
    if (action === 'txlist') return over.txlist ?? ES_TXLIST;
    if (action === 'tokentx') return over.tokentx ?? ES_TOKENTX;
    throw new Error(`unexpected action ${action}`);
  });
}

describe('fetchEtherscanHistory', () => {
  const URL_V2 = 'https://api.etherscan.io/v2/api';

  it('sends the v2 query parameters including chainid and apikey', async () => {
    const f = etherscanFetch();
    await fetchEtherscanHistory(eth, URL_V2, 'KEY123', OWNER, f);
    expect(f.calls).toHaveLength(2);
    for (const c of f.calls) {
      const u = new URL(c.url);
      expect(u.origin + u.pathname).toBe(URL_V2);
      expect(Object.fromEntries(u.searchParams)).toMatchObject({
        chainid: '1',
        module: 'account',
        address: OWNER,
        page: '1',
        offset: '25',
        sort: 'desc',
        apikey: 'KEY123',
      });
    }
    expect(f.calls.map((c) => new URL(c.url).searchParams.get('action')).sort()).toEqual(['tokentx', 'txlist']);
  });

  it('omits apikey when not configured', async () => {
    const f = etherscanFetch();
    await fetchEtherscanHistory(eth, URL_V2, undefined, OWNER, f);
    expect(new URL(f.calls[0].url).searchParams.has('apikey')).toBe(false);
  });

  it('parses native sends/receives with fee and timestamp', async () => {
    const records = await fetchEtherscanHistory(eth, URL_V2, undefined, OWNER, etherscanFetch());
    expect(byHash(records, h('a'))).toEqual<TxRecord>({
      hash: h('a'),
      networkId: 'eth',
      chainType: 'evm',
      from: OWNER.toLowerCase(),
      to: BOB.toLowerCase(),
      title: 'Sent 1.5 ETH',
      direction: 'out',
      kind: 'send',
      amount: '1.5',
      symbol: 'ETH',
      timestamp: 1714564800_000,
      status: 'confirmed',
      fee: '21000000000000',
      source: 'indexer',
    });
    expect(byHash(records, h('b'))).toMatchObject({ title: 'Received 0.2 ETH', direction: 'in', kind: 'receive' });
  });

  it('describes a token transfer call by its tokentx entry (case-insensitive hash)', async () => {
    const records = await fetchEtherscanHistory(eth, URL_V2, undefined, OWNER, etherscanFetch());
    expect(byHash(records, h('c'))).toMatchObject({
      hash: h('c'),
      title: 'Sent 25 USDC',
      amount: '25',
      symbol: 'USDC',
      kind: 'send',
      direction: 'out',
      fee: '100000000000000',
    });
  });

  it('marks failed calls and strips the function signature', async () => {
    const records = await fetchEtherscanHistory(eth, URL_V2, undefined, OWNER, etherscanFetch());
    expect(byHash(records, h('d'))).toMatchObject({
      status: 'failed',
      title: 'Called swapExactTokensForETH',
      kind: 'contract',
      fee: '90000',
    });
  });

  it('handles contract creation (empty to) and missing gas data', async () => {
    const r = byHash(await fetchEtherscanHistory(eth, URL_V2, undefined, OWNER, etherscanFetch()), h('9'));
    expect(r.to).toBeUndefined();
    expect(r.fee).toBeUndefined();
  });

  it('adds token-only incoming transfers', async () => {
    const records = await fetchEtherscanHistory(eth, URL_V2, undefined, OWNER, etherscanFetch());
    expect(byHash(records, h('1'))).toMatchObject({
      title: 'Received 100 DAI',
      direction: 'in',
      kind: 'receive',
      amount: '100',
      symbol: 'DAI',
      timestamp: 1714478400_000,
      status: 'confirmed',
    });
    expect(records).toHaveLength(6);
  });

  it('treats "No transactions found" as empty', async () => {
    const empty = { status: '0', message: 'No transactions found', result: [] };
    expect(await fetchEtherscanHistory(eth, URL_V2, undefined, OWNER, etherscanFetch({ txlist: empty, tokentx: empty }))).toEqual(
      [],
    );
    const emptyStr = { status: '0', message: 'No transactions found', result: 'No transactions found' };
    expect(
      await fetchEtherscanHistory(eth, URL_V2, undefined, OWNER, etherscanFetch({ txlist: emptyStr, tokentx: emptyStr })),
    ).toEqual([]);
  });

  it('throws the API error for txlist', async () => {
    const err = { status: '0', message: 'NOTOK', result: 'Invalid API Key (#err2)|x' };
    await expect(fetchEtherscanHistory(eth, URL_V2, 'bad', OWNER, etherscanFetch({ txlist: err }))).rejects.toThrow(
      'Invalid API Key (#err2)|x',
    );
    const err2 = { status: '0', message: 'NOTOK', result: null };
    await expect(fetchEtherscanHistory(eth, URL_V2, 'bad', OWNER, etherscanFetch({ txlist: err2 }))).rejects.toThrow('NOTOK');
  });

  it('ignores a tokentx error', async () => {
    const err = { status: '0', message: 'NOTOK', result: 'Max rate limit reached' };
    const records = await fetchEtherscanHistory(eth, URL_V2, undefined, OWNER, etherscanFetch({ tokentx: err }));
    expect(records).toHaveLength(5);
    expect(byHash(records, h('c')).title).toBe('Called transfer');
  });
});

describe('fetchEvmHistory', () => {
  it('dispatches to Blockscout', async () => {
    const f = blockscoutFetch();
    const records = await fetchEvmHistory(eth, OWNER, f);
    expect(records.length).toBeGreaterThan(0);
    expect(f.calls.every((c) => c.url.startsWith('https://eth.blockscout.com/api/v2/'))).toBe(true);
  });

  it('dispatches to Etherscan with the configured key', async () => {
    const f = etherscanFetch();
    const n: EvmNetwork = { ...eth, history: { kind: 'etherscan', url: 'https://api.etherscan.io/v2/api', apiKey: 'K' } };
    const records = await fetchEvmHistory(n, OWNER, f);
    expect(records).toHaveLength(6);
    expect(f.calls.every((c) => new URL(c.url).searchParams.get('apikey') === 'K')).toBe(true);
  });

  it("returns [] without any request for kind 'none'", async () => {
    const f = mockFetch(() => {
      throw new Error('should not fetch');
    });
    const bsc = DEFAULT_NETWORKS.find((n) => n.id === 'bsc') as EvmNetwork;
    expect(await fetchEvmHistory(bsc, OWNER, f)).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });
});
