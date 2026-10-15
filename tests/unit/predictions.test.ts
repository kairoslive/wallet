import { describe, expect, it } from 'vitest';
import { recoverTypedDataAddress, type Hex } from 'viem';
import { WalletService } from '../../src/core/wallet/service';
import { MemoryStore } from '../../src/core/storage';
import { verifySigningRequest, type VerifyContext } from '../../src/core/predictions/verify';
import {
  discoverMarkets,
  getMarket,
  getPositions,
  getOrders,
  getStatus,
  runAction,
  ActionFailedError,
} from '../../src/core/predictions/client';
import type { KairosConfig, Step } from '../../src/core/predictions/types';

const USER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const TRADING = '0xb767404cf2c0a9af65d47e83a5c979cf07056cca';
const PUSD = '0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb';
const CTF = '0x4d97dcd97ec945f40cf65f87097ace5ea0476045';
const SPENDER = 'e111180000d2663c0091e4f400237545b87b996b';
const MAX = 'f'.repeat(64);
const pad = (hex: string) => hex.padStart(64, '0');

const CFG: KairosConfig = {
  executionUrl: 'https://exec.test',
  dataUrl: 'https://data.test',
  marketDataUrl: 'https://md.test',
  partnerId: 'wallet-pilot',
};

/** Shapes captured from the staging setup flow. */
function clobAuth(address = USER, chainId = 137) {
  return {
    domain: { chainId, name: 'ClobAuthDomain', version: '1' },
    message: {
      address,
      message: 'This message attests that I control the given wallet',
      nonce: 867522066,
      timestamp: '1792018079',
    },
    primaryType: 'ClobAuth',
    types: {
      ClobAuth: [
        { name: 'address', type: 'address' },
        { name: 'timestamp', type: 'string' },
        { name: 'nonce', type: 'uint256' },
        { name: 'message', type: 'string' },
      ],
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
      ],
    },
  };
}

function batch(calls: { target: string; data: string; value?: string }[], wallet = TRADING) {
  return {
    domain: { chainId: 137, name: 'DepositWallet', verifyingContract: wallet, version: '1' },
    message: { calls: calls.map((c) => ({ value: '0', ...c })), deadline: '1792018687', nonce: '0', wallet },
    primaryType: 'Batch',
    types: {
      Batch: [
        { name: 'wallet', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'calls', type: 'Call[]' },
      ],
      Call: [
        { name: 'target', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
      ],
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
    },
  };
}

const approve = (spender = SPENDER, amount = MAX) => ({ target: PUSD, data: `0x095ea7b3${pad(spender)}${amount}` });
const approveAll = (op = SPENDER) => ({ target: CTF, data: `0xa22cb465${pad(op)}${pad('1')}` });

const req = (td: unknown, address = USER) => ({ method: 'eth_signTypedData_v4', params: [address, JSON.stringify(td)] });
const setupCtx: VerifyContext = { wallet: USER, tradingWallet: TRADING, action: { type: 'setup' } };
const orderCtx: VerifyContext = {
  wallet: USER,
  tradingWallet: TRADING,
  action: { type: 'order', market: '0xcond', outcome: 'Yes', side: 'buy', price: '0.5', size: '10' },
  tokenId: '123',
};

function order(overrides: Record<string, unknown> = {}) {
  return {
    domain: {
      name: 'Polymarket CTF Exchange',
      version: '1',
      chainId: 137,
      verifyingContract: '0xe111180000d2663c0091e4f400237545b87b996b',
    },
    primaryType: 'Order',
    types: { Order: [{ name: 'tokenId', type: 'uint256' }] },
    message: {
      maker: TRADING,
      signer: USER,
      tokenId: '123',
      side: 0,
      makerAmount: '5000000',
      takerAmount: '10000000',
      ...overrides,
    },
  };
}

describe('verifySigningRequest', () => {
  it('accepts the setup ownership proof and approval batch', () => {
    expect(verifySigningRequest(req(clobAuth()), setupCtx).primaryType).toBe('ClobAuth');
    expect(
      verifySigningRequest(req(batch([approve(), approveAll(), approve('d91e80cf2e7be2e162c6513ced06f1dd0da35296')])), setupCtx)
        .primaryType,
    ).toBe('Batch');
  });

  it('refuses other signing methods and other wallets', () => {
    expect(() => verifySigningRequest({ method: 'personal_sign', params: ['0x00', USER] }, setupCtx)).toThrow(
      'unsupported signing method',
    );
    expect(() => verifySigningRequest({ method: 'eth_sendTransaction', params: [{}] }, setupCtx)).toThrow(
      'unsupported signing method',
    );
    expect(() => verifySigningRequest(req(clobAuth(), TRADING), setupCtx)).toThrow('different wallet');
    expect(() => verifySigningRequest(null, setupCtx)).toThrow('no signing request');
  });

  it('refuses the wrong chain and malformed data', () => {
    expect(() => verifySigningRequest(req(clobAuth(USER, 1)), setupCtx)).toThrow('unexpected chain 1');
    expect(() => verifySigningRequest({ method: 'eth_signTypedData_v4', params: [USER, '{nope'] }, setupCtx)).toThrow(
      'not valid JSON',
    );
  });

  it('refuses an ownership proof for another address', () => {
    expect(() => verifySigningRequest(req(clobAuth('0x70997970C51812dc3A010C7d01b50e0d17dc79C8')), setupCtx)).toThrow(
      'different wallet',
    );
  });

  it.each([
    ['a pUSD transfer', [{ target: PUSD, data: `0xa9059cbb${pad(SPENDER)}${MAX}` }], 'unexpected pUSD call'],
    [
      'an unknown contract',
      [{ target: '0x1111111111111111111111111111111111111111', data: `0x095ea7b3${pad(SPENDER)}${MAX}` }],
      'unknown contract',
    ],
    ['an unknown spender', [approve('1234567890123456789012345678901234567890')], 'unknown spender'],
    ['an unknown operator', [approveAll('1234567890123456789012345678901234567890')], 'unknown spender'],
    ['native value', [{ ...approve(), value: '1' }], 'native funds'],
    ['extra calldata', [{ target: PUSD, data: `0x095ea7b3${pad(SPENDER)}${MAX}00` }], 'unexpected arguments'],
    ['a CTF transfer', [{ target: CTF, data: `0xf242432a${pad(SPENDER)}${pad('1')}` }], 'unexpected outcome-token call'],
  ])('refuses a setup batch with %s', (_name, calls, message) => {
    expect(() => verifySigningRequest(req(batch(calls)), setupCtx)).toThrow(message);
  });

  it('refuses a batch for a different trading wallet', () => {
    expect(() => verifySigningRequest(req(batch([approve()], '0x2222222222222222222222222222222222222222')), setupCtx)).toThrow(
      'not for your trading wallet',
    );
  });

  it('refuses contract-call batches and ownership proofs outside setup', () => {
    expect(() => verifySigningRequest(req(batch([approve()])), orderCtx)).toThrow('only expected during setup');
    expect(() => verifySigningRequest(req(clobAuth()), orderCtx)).toThrow('only expected during setup');
  });

  it('accepts an order matching what the user confirmed', () => {
    expect(verifySigningRequest(req(order()), orderCtx).primaryType).toBe('Order');
  });

  it.each([
    ['another outcome token', { tokenId: '999' }, 'different outcome'],
    ['the opposite side', { side: 1 }, 'side does not match'],
    ['a larger spend', { makerAmount: '9000000' }, 'spends more'],
    ['a foreign maker', { maker: '0x3333333333333333333333333333333333333333' }, 'maker is not your wallet'],
  ])('refuses an order for %s', (_name, overrides, message) => {
    expect(() => verifySigningRequest(req(order(overrides)), orderCtx)).toThrow(message);
  });
});

// ------------------------------------------------------------------ client

function router(routes: Record<string, (init?: RequestInit) => unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response(JSON.stringify({ error: `no route ${url}` }), { status: 404 });
    return new Response(JSON.stringify(routes[key](init)));
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe('Kairos client', () => {
  it('maps discover results into events with outcomes', async () => {
    const { fetchFn, calls } = router({
      'api/markets/discover/v2': () => ({
        markets: [
          {
            id: '1',
            event_id: 'e1',
            eventTitle: 'BTC on Friday?',
            title: 'BTC on Friday?',
            volume24h: 1000,
            outcomes: [
              { id: '1', title: 'Above 80k?', outcomeLabel: '↑ 80k', price: 0.4, condition_id: '0xa' },
              { id: '2', title: 'Above 90k?', outcomeLabel: '↑ 90k', price: 0.1, condition_id: '0xb' },
            ],
          },
          { id: '3', title: 'Simple?', price: 0.7, condition_id: '0xc' },
        ],
      }),
    });
    const events = await discoverMarkets(CFG, { category: 'crypto', search: ' btc ' }, fetchFn);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      id: 'e1',
      title: 'BTC on Friday?',
      outcomes: [{ marketId: '1', label: '↑ 80k', price: 0.4 }, { marketId: '2' }],
    });
    expect(events[1].outcomes).toEqual([expect.objectContaining({ marketId: '3', conditionId: '0xc', price: 0.7 })]);
    const url = new URL(calls[0].url);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      provider: 'polymarket',
      category: 'crypto',
      search: 'btc',
      sort_by: 'volume_24h',
    });
  });

  it('loads market detail with token marks on a 0–1 scale', async () => {
    const { fetchFn, calls } = router({
      'v1/markets/polymarket/42': () => ({
        market_id: '42',
        condition_id: '0xcond',
        title: 'Will it rain?',
        status: 'open',
        tick_size: 0.01,
        neg_risk: false,
        outcomes: [
          { outcome: 'Yes', token_id: 't1' },
          { outcome: 'No', token_id: 't2' },
        ],
      }),
      'v1/marks': () => ({ marks: [{ contract_id: '0xcond', token_id: 't1', price: 63.5 }] }),
    });
    const m = await getMarket(CFG, '42', fetchFn);
    expect(m.tokens).toEqual([
      { outcome: 'Yes', tokenId: 't1', price: 0.635 },
      { outcome: 'No', tokenId: 't2' },
    ]);
    expect(decodeURIComponent(calls[1].url)).toContain('pairs=0xcond:t1,0xcond:t2');
  });

  it('explains a host that no longer serves the wallet API', async () => {
    const fetchFn = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    await expect(getStatus(CFG, USER, fetchFn)).rejects.toThrow("exec.test doesn't serve the Kairos wallet API");
  });

  it('explains auth and rate-limit refusals on read routes', async () => {
    const status = (code: number) =>
      (async () => new Response(JSON.stringify({ error: 'Missing authorization' }), { status: code })) as unknown as typeof fetch;
    await expect(getPositions(CFG, USER, status(401))).rejects.toThrow("Trading isn't affected");
    await expect(getOrders(CFG, USER, {}, status(429))).rejects.toThrow('rate-limiting');
  });

  it('unwraps nested positions', async () => {
    const { fetchFn } = router({
      'v3/wallets': () => ({ positions: { positions: [{ size: '5' }], resolved: [{ size: '1' }] } }),
    });
    expect(await getPositions(CFG, USER, fetchFn)).toEqual({ open: [{ size: '5' }], resolved: [{ size: '1' }] });
  });

  it('drives an action through signing and polling, sending the partner id', async () => {
    let n = 0;
    const steps: Step[] = [
      {
        id: 'a',
        type: 'setup',
        status: 'needs_signature',
        request: { method: 'x', params: [] },
        description: 'Sign',
        result: null,
        error: null,
      },
      { id: 'a', type: 'setup', status: 'working', request: null, description: null, result: null, error: null },
      { id: 'a', type: 'setup', status: 'done', request: null, description: null, result: { ready: true }, error: null },
    ];
    const { fetchFn, calls } = router({ 'v3/actions': () => steps[n++] });
    const signed: string[] = [];
    const res = await runAction(
      CFG,
      USER,
      { type: 'setup' },
      { fetchFn, pollIntervalMs: 1, sign: async (s) => (signed.push(s.id), '0xsig') },
    );
    expect(res).toEqual({ ready: true });
    expect(signed).toEqual(['a']);
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ signature: '0xsig' });
    for (const c of calls) expect((c.init?.headers as Record<string, string>)['X-Kairos-Partner-Id']).toBe('wallet-pilot');
  });

  it('throws ActionFailedError with the reason', async () => {
    const { fetchFn } = router({
      'v3/actions': () => ({
        id: 'b',
        type: 'order',
        status: 'failed',
        request: null,
        description: null,
        result: null,
        error: 'insufficient balance',
      }),
    });
    const err = await runAction(CFG, USER, { type: 'setup' }, { fetchFn, sign: async () => '0x' }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ActionFailedError);
    expect((err as Error).message).toBe('insufficient balance');
  });
});

// ------------------------------------------------------------------ service

describe('WalletService prediction markets', () => {
  async function setup(steps: (body: unknown) => unknown) {
    const posts: { url: string; body: unknown }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (init?.method === 'POST') posts.push({ url, body });
      if (url.includes('/v3/wallets/')) {
        return new Response(JSON.stringify({ wallet: USER, tradingWallet: TRADING, ready: false, balance: '0', next: 'setup' }));
      }
      if (url.includes('/v1/markets/polymarket/42')) {
        return new Response(
          JSON.stringify({
            market_id: '42',
            condition_id: '0xcond',
            title: 'Rain?',
            status: 'open',
            tick_size: 0.01,
            outcomes: [
              { outcome: 'Yes', token_id: '123' },
              { outcome: 'No', token_id: '456' },
            ],
          }),
        );
      }
      if (url.includes('/v1/marks')) return new Response(JSON.stringify({ marks: [] }));
      if (url.includes('/v3/actions')) {
        const r = steps(body) as { __status?: number };
        return new Response(JSON.stringify(r), { status: r.__status ?? 200 });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const service = new WalletService({ store: new MemoryStore(), session: new MemoryStore(), pbkdf2Iterations: 1000, fetchFn });
    await service.createWallet({
      password: 'password123',
      mnemonic: 'test test test test test test test test test test test junk',
    });
    const accountId = (await service.getState()).accounts[0].id;
    return { service, accountId, posts };
  }

  it('signs a valid setup with the account key', async () => {
    const td = batch([approve(), approveAll()]);
    const { service, accountId, posts } = await setup((body) =>
      (body as { signature?: string }).signature
        ? {
            id: 's',
            type: 'setup',
            status: 'done',
            request: null,
            description: null,
            result: { ready: true, tradingWallet: TRADING },
            error: null,
          }
        : {
            id: 's',
            type: 'setup',
            status: 'needs_signature',
            request: req(td),
            description: 'Approve',
            result: null,
            error: null,
          },
    );
    expect(await service.predictionSetup(accountId)).toEqual({ ready: true, tradingWallet: TRADING });
    const sig = (posts[1].body as { signature: Hex }).signature;
    const types = { ...td.types } as Record<string, unknown>;
    delete types.EIP712Domain;
    const signer = await recoverTypedDataAddress({
      domain: td.domain,
      types,
      primaryType: 'Batch',
      message: td.message,
      signature: sig,
    } as unknown as Parameters<typeof recoverTypedDataAddress>[0]);
    expect(signer).toBe(USER);
  });

  it('never signs a malicious batch and never submits a signature', async () => {
    const evil = batch([{ target: PUSD, data: `0xa9059cbb${pad('1234567890123456789012345678901234567890')}${MAX}` }]);
    const { service, accountId, posts } = await setup(() => ({
      id: 's',
      type: 'setup',
      status: 'needs_signature',
      request: req(evil),
      description: 'Approve',
      result: null,
      error: null,
    }));
    await expect(service.predictionSetup(accountId)).rejects.toThrow('Refused to sign');
    expect(posts).toHaveLength(1);
  });

  it('validates orders against the market before contacting Kairos', async () => {
    const { service, accountId, posts } = await setup(() => ({}));
    const base = { marketId: '42', outcome: 'Yes', side: 'buy' as const, size: '10' };
    await expect(service.predictionOrder(accountId, { ...base, price: '0.505' })).rejects.toThrow('multiple of 0.01');
    await expect(service.predictionOrder(accountId, { ...base, price: '1.2' })).rejects.toThrow('between 0 and 1');
    await expect(service.predictionOrder(accountId, { ...base, price: '0.5', outcome: 'Maybe' })).rejects.toThrow(
      'Unknown outcome',
    );
    await expect(service.predictionOrder(accountId, { ...base, price: '0.5', size: '0' })).rejects.toThrow('number of shares');
    expect(posts).toHaveLength(0);
  });

  it('places an order, binding the signature check to the chosen outcome token', async () => {
    const { service, accountId, posts } = await setup((body) =>
      (body as { signature?: string }).signature
        ? {
            id: 'o',
            type: 'order',
            status: 'done',
            request: null,
            description: null,
            result: { orderId: 'ord1', status: 'live', venueOrderId: null },
            error: null,
          }
        : {
            id: 'o',
            type: 'order',
            status: 'needs_signature',
            request: req(order()),
            description: 'Confirm',
            result: null,
            error: null,
          },
    );
    const res = await service.predictionOrder(accountId, {
      marketId: '42',
      outcome: 'yes',
      side: 'buy',
      price: '0.5',
      size: '10',
    });
    expect(res.orderId).toBe('ord1');
    expect(posts[0].body).toMatchObject({
      wallet: USER,
      action: { type: 'order', market: '0xcond', outcome: 'Yes', side: 'buy', price: '0.5', size: '10', timeInForce: 'GTC' },
    });
  });

  it('explains when the Kairos node has trading switched off', async () => {
    const { service, accountId } = await setup(() => ({ __status: 503, error: 'trading is not available on this node' }));
    await expect(
      service.predictionOrder(accountId, { marketId: '42', outcome: 'Yes', side: 'buy', price: '0.5', size: '10' }),
    ).rejects.toThrow('order placement turned off');
  });

  it('refuses when prediction markets are turned off', async () => {
    const { service, accountId } = await setup(() => ({}));
    const s = await service.getSettings();
    await service.updateSettings({ apis: { ...s.apis, kairosEnabled: false } });
    await expect(service.predictionStatus(accountId)).rejects.toThrow('turned off');
  });
});
