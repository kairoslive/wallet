import { describe, expect, it } from 'vitest';
import { recoverTypedDataAddress, type Hex } from 'viem';
import { WalletService } from '../../src/core/wallet/service';
import { MemoryStore } from '../../src/core/storage';
import type { RoutedBuyRequest } from '../../src/core/predictions/execution';

/**
 * A routed buy end to end against a stand-in Kairos: Kairos' routedOrder with every leg checked
 * against the confirmed plan, and the wallet routing it itself when Kairos doesn't offer routing.
 */

const USER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const TRADING = '0xb767404cf2c0a9af65d47e83a5c979cf07056cca';

const polyOrder = (makerAmount: string, tokenId = '123') => ({
  domain: {
    name: 'Polymarket CTF Exchange',
    version: '1',
    chainId: 137,
    verifyingContract: '0xe111180000d2663c0091e4f400237545b87b996b',
  },
  primaryType: 'Order',
  types: {
    Order: [
      { name: 'maker', type: 'address' },
      { name: 'signer', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
      { name: 'makerAmount', type: 'uint256' },
      { name: 'side', type: 'uint8' },
    ],
  },
  message: { maker: TRADING, signer: USER, tokenId, makerAmount, side: 0 },
});
const sign = (td: unknown) => ({ method: 'eth_signTypedData_v4', params: [USER, JSON.stringify(td)] });

const LINK = {
  id: 'L1',
  title: 'Chargers vs. Ravens',
  sideLabels: { yes: 'Chargers', no: 'Ravens' },
  venues: [
    { provider: 'polymarket', marketId: '0xcond', streamKey: '42', tokenIdYes: '123', tokenIdNo: '456', executable: true },
    { provider: 'predictfun', marketId: '7', tokenIdYes: 'pf-lac', tokenIdNo: 'pf-bal', executable: true },
  ],
};

const ROUTE_LEGS = [
  { venue: 'predictfun', market: 'predictfun:7', outcome: 'LAC', price: '0.3', size: '20', timeInForce: 'FAK' },
  { venue: 'polymarket', market: 'polymarket:0xcond', outcome: 'Chargers', price: '0.31', size: '30', timeInForce: 'FAK' },
];

const REQUEST: RoutedBuyRequest = {
  marketId: '42',
  outcome: 'Chargers',
  legs: [
    { key: 'predictfun:7', price: 0.3, size: 20 },
    { key: '42', price: 0.31, size: 30 },
  ],
  maxPrice: 0.33,
  shares: 49.6,
};

type Body = { action?: { type: string; size?: string; market?: string }; signature?: string };

async function setup(actions: (body: Body, url: string) => unknown) {
  const posts: { url: string; body: { action?: { type: string; size?: string; market?: string }; signature?: string } }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (init?.method === 'POST') posts.push({ url, body });
    if (url.includes('/v3/wallets/')) {
      return Response.json({
        wallet: USER,
        tradingWallet: TRADING,
        ready: true,
        next: null,
        balance: '100',
        venues: {
          polymarket: { ready: true, next: null, balance: '100', currency: 'pUSD', tradingWallet: TRADING },
          predictfun: { ready: true, next: null, balance: '100', currency: 'USDT' },
        },
      });
    }
    if (url.includes('/v1/markets/polymarket/42') || url.includes('/v1/markets/polymarket/0xcond')) {
      return Response.json({
        market_id: '42',
        condition_id: '0xcond',
        status: 'open',
        tick_size: 0.01,
        outcomes: [
          { outcome: 'Chargers', token_id: '123' },
          { outcome: 'Ravens', token_id: '456' },
        ],
      });
    }
    if (url.includes('/v1/markets/predictfun/7')) {
      // The other venue lists the sides the other way round: match by token, never by position.
      return Response.json({
        market_id: '7',
        condition_id: '0xpf',
        status: 'open',
        tick_size: 0.01,
        outcomes: [
          { outcome: 'BAL', token_id: 'pf-bal' },
          { outcome: 'LAC', token_id: 'pf-lac' },
        ],
      });
    }
    if (url.includes('/v1/marks')) return Response.json({ marks: [] });
    if (url.includes('/market-links/lookup')) return Response.json({ links: { 'polymarket:42': LINK } });
    if (url.includes('/api/markets/discover')) return Response.json({ markets: [] });
    if (url.includes('/v3/actions')) {
      const r = actions(body, url) as { __status?: number };
      return Response.json(r, { status: r.__status ?? 200 });
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

const step = (o: Record<string, unknown>) => ({
  id: 'r',
  type: 'routed_order',
  request: null,
  description: null,
  result: null,
  error: null,
  ...o,
});

describe('routed buys', () => {
  it('prepares the server route without signing, then consumes the reviewed plan exactly once', async () => {
    const { service, accountId, posts } = await setup((body) =>
      body.action
        ? step({
            status: 'needs_signature',
            venue: 'polymarket',
            chainId: '0x89',
            leg: { index: 2, of: 2 },
            route: { legs: ROUTE_LEGS },
            request: sign(polyOrder('9300000')),
          })
        : step({
            status: 'done',
            result: {
              routed: true,
              placed: 1,
              failed: 1,
              legs: [
                { ...ROUTE_LEGS[0], status: 'failed' },
                { ...ROUTE_LEGS[1], status: 'placed', order: { filledSize: '30', final: true } },
              ],
            },
          }),
    );
    const prepared = await service.predictionPrepareRoutedBuy(accountId, { ...REQUEST, slippageCents: 3, maxSpend: 16 });
    expect(prepared.kind).toBe('kairos');
    if (prepared.kind !== 'kairos') throw new Error('Expected Kairos route');
    expect(prepared.route.legs).toEqual(ROUTE_LEGS);
    expect(posts).toHaveLength(1);
    expect(posts[0].body.action).toMatchObject({ type: 'routedOrder', outcome: 'Yes', slippageCents: 3 });
    await expect(service.predictionExecuteRoutedBuy(accountId, prepared.id)).resolves.toMatchObject({
      mode: 'kairos',
      filled: 30,
    });
    expect(posts[1].body.signature).toHaveLength(132);
    await expect(service.predictionExecuteRoutedBuy(accountId, prepared.id)).rejects.toThrow('expired route');
  });

  it("runs Kairos' routedOrder, signing each leg checked against the plan", async () => {
    const { service, accountId, posts } = await setup((body) => {
      if (body.action) {
        return step({
          status: 'needs_signature',
          venue: 'polymarket',
          chainId: '0x89',
          leg: { index: 2, of: 2 },
          route: { legs: ROUTE_LEGS },
          request: sign(polyOrder('9300000')),
        });
      }
      return step({
        status: 'done',
        result: {
          routed: true,
          placed: 1,
          failed: 1,
          legs: [
            { ...ROUTE_LEGS[0], status: 'failed', error: 'No fill', errorCode: 'NO_MATCH' },
            {
              ...ROUTE_LEGS[1],
              status: 'placed',
              orderId: 'o2',
              order: { orderId: 'o2', status: 'filled', filledSize: '30', final: true, success: true },
            },
          ],
        },
      });
    });
    const res = await service.predictionRoutedBuy(accountId, REQUEST);
    expect(res.mode).toBe('kairos');
    expect(res.filled).toBe(30);
    expect(res.legs.map((l) => [l.key, l.status])).toEqual([
      ['predictfun:7', 'failed'],
      ['42', 'filled'],
    ]);
    expect(posts[0].body.action).toMatchObject({
      type: 'routedOrder',
      market: 'polymarket:0xcond',
      outcome: 'Chargers',
      maxPrice: '0.33',
    });
    const td = polyOrder('9300000');
    const signer = await recoverTypedDataAddress({ ...td, signature: posts[1].body.signature as Hex } as never);
    expect(signer).toBe(USER);
  });

  it('never signs a leg priced above what the user confirmed', async () => {
    const { service, accountId, posts } = await setup(() =>
      step({
        status: 'needs_signature',
        venue: 'polymarket',
        leg: { index: 2, of: 2 },
        route: { legs: [ROUTE_LEGS[0], { ...ROUTE_LEGS[1], price: '0.45' }] },
        request: sign(polyOrder('13500000')),
      }),
    );
    await expect(service.predictionRoutedBuy(accountId, REQUEST)).rejects.toThrow('Refused to sign');
    expect(posts).toHaveLength(1);
  });

  it('never signs an order for another outcome inside a routed order', async () => {
    const { service, accountId, posts } = await setup(() =>
      step({
        status: 'needs_signature',
        venue: 'polymarket',
        leg: { index: 2, of: 2 },
        route: { legs: ROUTE_LEGS },
        request: sign(polyOrder('9300000', '456')),
      }),
    );
    await expect(service.predictionRoutedBuy(accountId, REQUEST)).rejects.toThrow('different outcome');
    expect(posts).toHaveLength(1);
  });

  it('routes it itself when Kairos has routing off, moving what one venue missed to the next', async () => {
    const { service, accountId, posts } = await setup((body) => {
      if (body.action?.type === 'routedOrder') return { __status: 403, message: 'routed orders are not enabled here' };
      if (body.action?.type === 'order' && body.action.market === 'predictfun:7') {
        return step({
          type: 'order',
          status: 'failed',
          error: 'No fill: the venue matched none of this order',
          errorCode: 'NO_MATCH',
        });
      }
      if (body.action?.type === 'order') {
        return step({ type: 'order', status: 'needs_signature', venue: 'polymarket', request: sign(polyOrder('15500000')) });
      }
      return step({
        type: 'order',
        status: 'done',
        result: {
          orderId: 'o2',
          status: 'filled',
          venueOrderId: null,
          filledSize: '50',
          avgPrice: '0.305',
          final: true,
          success: true,
        },
      });
    });
    const res = await service.predictionRoutedBuy(accountId, REQUEST);
    expect(res.mode).toBe('wallet');
    const orders = posts.filter((p) => p.body.action?.type === 'order').map((p) => p.body.action!);
    // Predict.fun is asked first (its own outcome name for the side), then Polymarket takes its 30 plus the 20 missed.
    expect(orders.map((o) => [o.market, (o as { outcome?: string }).outcome, o.size])).toEqual([
      ['predictfun:7', 'LAC', '20'],
      // A bare condition id is Polymarket on every node.
      ['0xcond', 'Chargers', '50'],
    ]);
    expect(res.legs.map((l) => l.status)).toEqual(['failed', 'filled']);
    expect(res.filled).toBe(50);

    // The node is remembered as not routing: the next buy goes straight to venue orders.
    posts.length = 0;
    await service.predictionRoutedBuy(accountId, REQUEST);
    expect(posts.some((p) => p.body.action?.type === 'routedOrder')).toBe(false);
  });

  it('stops routing when an order may be live', async () => {
    const { service, accountId, posts } = await setup((body) => {
      if (body.action?.type === 'routedOrder') return { __status: 403, message: 'routed orders are not enabled here' };
      return step({ type: 'order', status: 'failed', error: 'Outcome not confirmed yet', errorCode: 'ORDER_OUTCOME_UNKNOWN' });
    });
    const res = await service.predictionRoutedBuy(accountId, REQUEST);
    expect(res.uncertain).toBe(true);
    expect(res.legs.map((l) => l.status)).toEqual(['unknown', 'skipped']);
    expect(posts.filter((p) => p.body.action?.type === 'order')).toHaveLength(1);
  });

  it('refuses a plan leg on a market that is not linked', async () => {
    const { service, accountId, posts } = await setup(() => ({}));
    await expect(
      service.predictionRoutedBuy(accountId, {
        ...REQUEST,
        legs: [...REQUEST.legs, { key: 'hyperliquid:9', price: 0.3, size: 5 }],
      }),
    ).rejects.toThrow('no longer linked');
    expect(posts).toHaveLength(0);
  });
});
