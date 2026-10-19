import { describe, expect, it } from 'vitest';
import { marketKey, parseMarketKey } from '../../src/core/predictions/venues';
import { normalizeStatus } from '../../src/core/predictions/client';
import {
  verifySigningRequest,
  verifyVenueLoginRequest,
  verifyWalletCalls,
  type VerifyContext,
} from '../../src/core/predictions/verify';
import { recordMarket, toOrderView, toPositionsView, type MarketMeta } from '../../src/core/predictions/portfolio';
import { outcomeToken } from '../../src/core/predictions/hyperliquid';
import {
  AGENT,
  approveAgentTypedData,
  builderFeeTypedData,
  perpsToSpotTypedData,
  placeOrderTypedData,
  withdrawTypedData,
} from '../helpers/hyperliquid';
import type { Action, Step, TradingStatus } from '../../src/core/predictions/types';
import {
  APPROVALS,
  EXCHANGES,
  USDT,
  approveCall,
  operatorCall,
  orderTypedData,
  sendCallsStep,
  venueLoginStep,
} from '../helpers/predictfun';

const USER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const OTHER = '0x2222222222222222222222222222222222222222';
const TOKEN = '22792533058364109967843974336023525129117701581478587988463610813242968119951';
const E18 = 10n ** 18n;

const order = (o: Partial<Extract<Action, { type: 'order' }>> = {}): Action => ({
  type: 'order',
  market: 'predictfun:3394712',
  outcome: 'MVK',
  side: 'buy',
  price: '0.5',
  size: '10',
  ...o,
});
const ctx = (action: Action = order()): VerifyContext => ({ wallet: USER, tradingWallet: OTHER, action, tokenId: TOKEN });
const sign = (td: unknown) => ({ method: 'eth_signTypedData_v4', params: [USER, JSON.stringify(td)] });

describe('market keys', () => {
  it('keeps Polymarket ids bare and prefixes other venues', () => {
    expect(marketKey('polymarket', '601826')).toBe('601826');
    expect(marketKey('predictfun', '3394712')).toBe('predictfun:3394712');
    expect(parseMarketKey('predictfun:3394712')).toEqual({ venue: 'predictfun', id: '3394712' });
    expect(parseMarketKey('601826')).toEqual({ venue: 'polymarket', id: '601826' });
    expect(parseMarketKey('polymarket:0xabc')).toEqual({ venue: 'polymarket', id: '0xabc' });
    expect(parseMarketKey('hyperliquid:13228')).toEqual({ venue: 'hyperliquid', id: '13228' });
    // An unknown prefix isn't a venue.
    expect(parseMarketKey('kalshi:1')).toEqual({ venue: 'polymarket', id: 'kalshi:1' });
  });
});

describe('normalizeStatus', () => {
  const v2 = {
    wallet: USER,
    ready: false,
    next: 'fund',
    venues: {
      polymarket: { ready: true, next: null, tradingWallet: OTHER, balance: '25', currency: 'pUSD' },
      predictfun: { ready: false, next: 'fund', balance: '0', currency: 'USDT' },
      mystery: { ready: true, next: null, balance: '1' },
    },
  } as unknown as TradingStatus;

  it('keeps the top level meaning Polymarket and lists the venues it knows', () => {
    const s = normalizeStatus(v2);
    expect(s).toMatchObject({ ready: true, next: null, tradingWallet: OTHER, balance: '25' });
    expect(Object.keys(s.venues!)).toEqual(['polymarket', 'predictfun']);
    expect(s.venues!.predictfun!.next).toBe('fund');
  });

  it('leaves an older node’s status alone', () => {
    const old = { wallet: USER, tradingWallet: OTHER, ready: true, balance: '3', next: null } as TradingStatus;
    expect(normalizeStatus(old)).toBe(old);
  });
});

describe('Predict.fun orders', () => {
  const buy = orderTypedData(USER, { tokenId: TOKEN, makerAmount: (5n * E18).toString() });

  it('accepts the order the user confirmed, on every Predict.fun exchange', () => {
    for (const exchange of Object.values(EXCHANGES)) {
      expect(() =>
        verifySigningRequest(sign({ ...buy, domain: { ...buy.domain, verifyingContract: exchange } }), ctx()),
      ).not.toThrow();
    }
    const sell = orderTypedData(USER, { tokenId: TOKEN, side: 1, makerAmount: (10n * E18).toString() });
    expect(() => verifySigningRequest(sign(sell), ctx(order({ side: 'sell' })))).not.toThrow();
  });

  it('refuses anything else', () => {
    const bad = (patch: (td: ReturnType<typeof orderTypedData>) => void, c = ctx()) => {
      const td = structuredClone(buy);
      patch(td);
      return () => verifySigningRequest(sign(td), c);
    };
    expect(bad((td) => (td.domain.verifyingContract = OTHER))).toThrow('unknown exchange');
    expect(bad((td) => (td.domain.name = 'Other Exchange'))).toThrow('not Predict.fun');
    expect(bad((td) => (td.message.maker = OTHER))).toThrow('not made by your wallet');
    expect(bad((td) => (td.message.signer = OTHER))).toThrow('not made by your wallet');
    expect(bad((td) => (td.message.taker = OTHER))).toThrow('one counterparty');
    expect(bad((td) => (td.message.tokenId = '1'))).toThrow('different outcome');
    expect(bad((td) => (td.message.side = 1))).toThrow('side does not match');
    expect(bad((td) => (td.message.makerAmount = (6n * E18).toString()))).toThrow('spends more');
    expect(bad((td) => (td.primaryType = 'Transfer'))).toThrow('unexpected BNB Chain request');
    expect(bad(() => undefined, ctx({ type: 'cancel', all: true }))).toThrow('only expected for an order');
  });
});

describe('Predict.fun approvals (wallet_sendCalls)', () => {
  const step = (s: unknown) => s as Step;
  const setup: Action = { type: 'setup' };

  it('accepts the 12 approvals Kairos asks a fresh wallet for, in a setup or an order', () => {
    const calls = verifyWalletCalls(step(sendCallsStep(USER)), { wallet: USER, action: setup });
    expect(calls).toHaveLength(12);
    expect(verifyWalletCalls(step(sendCallsStep(USER)), { wallet: USER, action: order() })).toHaveLength(12);
  });

  it('refuses calls that would do anything else', () => {
    const run =
      (calls: unknown[], extra: Record<string, unknown> = {}, action: Action = setup) =>
      () =>
        verifyWalletCalls(step(sendCallsStep(USER, calls as typeof APPROVALS, extra)), { wallet: USER, action });
    expect(run([approveCall(USDT, OTHER)])).toThrow('unknown spender');
    expect(run([operatorCall('0x22DA1810B194ca018378464a58f6Ac2B10C9d244', OTHER)])).toThrow('unknown operator');
    expect(run([approveCall(OTHER, EXCHANGES.plain)])).toThrow('unknown contract');
    // transfer(to, amount) on USDT.
    expect(run([{ to: USDT, data: `0xa9059cbb${'0'.repeat(24)}${OTHER.slice(2)}${'f'.repeat(64)}` }])).toThrow(
      'unexpected collateral call',
    );
    expect(run([{ ...APPROVALS[0], value: '0x1' }])).toThrow('native funds');
    expect(run([{ ...APPROVALS[0], data: `${APPROVALS[0].data}00` }])).toThrow('unexpected arguments');
    expect(run([])).toThrow('number of calls');
    expect(run(APPROVALS, {}, { type: 'cancel', all: true })).toThrow('only expected during setup');
    expect(() =>
      verifyWalletCalls(
        step({
          ...sendCallsStep(USER),
          request: { method: 'wallet_sendCalls', params: [{ chainId: '0x89', calls: APPROVALS }] },
        }),
        { wallet: USER, action: setup },
      ),
    ).toThrow('unexpected chain');
    expect(() =>
      verifyWalletCalls(
        step({
          ...sendCallsStep(USER),
          request: { method: 'wallet_sendCalls', params: [{ chainId: '0x38', from: OTHER, calls: APPROVALS }] },
        }),
        { wallet: USER, action: setup },
      ),
    ).toThrow('different wallet');
  });
});

describe('Predict.fun sign-in (personal_sign)', () => {
  const step = (s: unknown) => s as Step;

  it('signs Predict.fun’s login challenge during setup or an order', () => {
    const raw = verifyVenueLoginRequest(step(venueLoginStep(USER)), { wallet: USER, action: order() });
    expect(Buffer.from(raw.slice(2), 'hex').toString()).toContain('log in');
  });

  it('refuses other messages and contexts', () => {
    const run =
      (s: unknown, action: Action = order()) =>
      () =>
        verifyVenueLoginRequest(step(s), { wallet: USER, action });
    expect(run({ ...venueLoginStep(USER), venue: 'polymarket' })).toThrow('only expected for Predict.fun');
    expect(run(venueLoginStep(USER), { type: 'login' })).toThrow('only expected during setup');
    expect(run(venueLoginStep(OTHER))).toThrow('different wallet');
    expect(run(venueLoginStep(USER, `0x${'ab'.repeat(32)}`))).toThrow('raw hash');
    expect(run(venueLoginStep(USER, `evil.example wants you to sign in with your Ethereum account:\n${USER}`))).toThrow(
      'not Predict.fun',
    );
    expect(() =>
      verifyVenueLoginRequest(
        step({ ...venueLoginStep(USER), request: { method: 'personal_sign', params: ['0xff00ff', USER] } }),
        { wallet: USER, action: order() },
      ),
    ).toThrow('readable text');
  });
});

describe('shared rows (multi-venue reads)', () => {
  const meta: MarketMeta = {
    marketId: 'predictfun:3394712',
    venue: 'predictfun',
    conditionId: '0x66ab',
    title: 'LoL: MVK Esports vs Karmine Corp (BO5)',
    tokens: [
      { outcome: 'MVK', tokenId: TOKEN, price: 0.3 },
      { outcome: 'KC', tokenId: '450', price: 0.7 },
    ],
  };
  const metas = new Map([[meta.marketId, meta]]);

  it('reads a Predict.fun position row', () => {
    const row = {
      venue: 'predictfun',
      market: 'predictfun:3394712',
      marketId: '3394712',
      outcome: 'MVK',
      tokenId: TOKEN,
      size: '20',
      avgPrice: '0.25',
    };
    expect(recordMarket(row)).toBe('predictfun:3394712');
    const [p] = toPositionsView({ open: [row], resolved: [] }, metas).positions;
    expect(p).toMatchObject({ venue: 'predictfun', marketId: 'predictfun:3394712', shares: 20, avgPrice: 0.25, price: 0.3 });
    expect(p.value).toBeCloseTo(6);
    expect(p.pnl).toBeCloseTo(1);
  });

  it('reads a Predict.fun order row', () => {
    const o = toOrderView(
      {
        orderId: 'o1',
        venue: 'predictfun',
        market: 'predictfun:3394712',
        marketId: '3394712',
        outcome: 'MVK',
        side: 'buy',
        price: '0.25',
        size: '20',
        filledSize: '5',
        status: 'open',
        createdAt: '2026-10-16T00:00:00Z',
      },
      metas,
    );
    expect(o).toMatchObject({
      id: 'o1',
      venue: 'predictfun',
      marketId: 'predictfun:3394712',
      price: 0.25,
      shares: 20,
      filled: 5,
      open: true,
    });
  });

  it('treats older rows as Polymarket', () => {
    expect(recordMarket({ market_id: '0xABC' })).toBe('0xabc');
    expect(recordMarket({ venue: 'polymarket', marketId: '601826' })).toBe('601826');
    expect(recordMarket({ market: 'polymarket:0xDEF' })).toBe('0xdef');
  });
});

describe('Hyperliquid (HIP-4 outcome markets)', () => {
  const hlOrder = (o: Partial<Extract<Action, { type: 'order' }>> = {}): Action =>
    order({ market: 'hyperliquid:13228', outcome: 'SF', price: '0.5', size: '10', timeInForce: 'GTC', ...o });
  const check =
    (td: unknown, action: Action = hlOrder()) =>
    () =>
      verifySigningRequest(sign(td), { wallet: USER, tradingWallet: USER, action });
  const setup: Action = { type: 'setup', venues: ['hyperliquid'] };

  it('signs the trade-only agent approval and a small builder fee, in setup or an order', () => {
    for (const action of [setup, hlOrder()]) {
      expect(check(approveAgentTypedData(), action)).not.toThrow();
      expect(check(builderFeeTypedData(), action)).not.toThrow();
    }
    expect(check(approveAgentTypedData({ chainId: 421614, network: 'Testnet' }), setup)).not.toThrow();
  });

  it('refuses approvals that are off', () => {
    expect(check(approveAgentTypedData(), { type: 'cancel', all: true })).toThrow('only expected during setup or an order');
    expect(check(approveAgentTypedData({ network: 'Testnet' }), setup)).toThrow('different Hyperliquid network');
    expect(check(approveAgentTypedData({ agent: USER }), setup)).toThrow('your own wallet');
    const renamed = approveAgentTypedData();
    renamed.domain.name = 'Other';
    expect(check(renamed, setup)).toThrow('not a Hyperliquid action');
    const extra = approveAgentTypedData();
    extra.types['HyperliquidTransaction:ApproveAgent'].push({ name: 'amount', type: 'string' });
    expect(check(extra, setup)).toThrow('unexpected fields');
    expect(check(builderFeeTypedData({ rate: '1%' }), setup)).toThrow('builder fee 1% is too high');
    expect(check(builderFeeTypedData({ rate: 'lots' }), setup)).toThrow('too high');
  });

  it('never signs a withdrawal or any other Hyperliquid action', () => {
    expect(check(withdrawTypedData(OTHER), setup)).toThrow('unexpected Hyperliquid request HyperliquidTransaction:Withdraw');
    expect(check(withdrawTypedData(OTHER))).toThrow('unexpected Hyperliquid request');
  });

  it('moves perps USDC to spot only for a buy, and only what the order needs', () => {
    // 10 shares at 0.5 = 5 USDC, plus fees.
    expect(check(perpsToSpotTypedData({ amount: '5.06' }))).not.toThrow();
    expect(check(perpsToSpotTypedData({ amount: '9' }))).toThrow('more than this order needs');
    expect(check(perpsToSpotTypedData({ toPerp: true }))).toThrow('moves USDC to perps');
    expect(check(perpsToSpotTypedData(), hlOrder({ side: 'sell' }))).toThrow('only expected for a buy');
    expect(check(perpsToSpotTypedData(), setup)).toThrow('only expected for a buy');
  });

  it('signs the order authorization only for exactly the order confirmed', () => {
    expect(check(placeOrderTypedData(USER))).not.toThrow();
    expect(check(placeOrderTypedData(USER, { price: '0.50000' }))).not.toThrow();
    expect(check(placeOrderTypedData(USER, { timeInForce: 'FAK' }), hlOrder({ timeInForce: 'FAK' }))).not.toThrow();
    const bad = (o: Parameters<typeof placeOrderTypedData>[1]) => check(placeOrderTypedData(USER, o));
    expect(check(placeOrderTypedData(OTHER))).toThrow('different wallet');
    expect(bad({ market: 'hyperliquid:11464' })).toThrow('different market');
    expect(bad({ outcome: 'WAS' })).toThrow('different outcome');
    expect(bad({ side: 'sell' })).toThrow('side does not match');
    expect(bad({ price: '0.51' })).toThrow('price does not match');
    expect(bad({ size: '100' })).toThrow('size does not match');
    expect(bad({ timeInForce: 'IOC' })).toThrow('duration does not match');
    expect(bad({ postOnly: true })).toThrow('post-only');
    expect(bad({ expiresAt: Math.floor(Date.now() / 1000) + 86_400 })).toThrow('lasts too long');
    expect(check(placeOrderTypedData(USER), setup)).toThrow('only expected for an order');
    const contract = placeOrderTypedData(USER) as { domain: Record<string, unknown> };
    contract.domain.verifyingContract = OTHER;
    expect(check(contract)).toThrow('not Kairos');
  });

  it('reads the venue in status and names outcome tokens one way', () => {
    const s = normalizeStatus({
      wallet: USER,
      ready: false,
      next: 'fund',
      venues: { hyperliquid: { ready: false, next: 'fund', balance: '0', currency: 'USDC', tradingWallet: USER } },
    } as unknown as TradingStatus);
    expect(s.venues!.hyperliquid!.currency).toBe('USDC');
    expect(outcomeToken('+132280')).toBe('#132280');
    expect(outcomeToken('#132280')).toBe('#132280');
    expect(outcomeToken('100132280')).toBe('#132280');
    expect(outcomeToken('abc')).toBe('abc');
    expect(AGENT).not.toBe(USER);
  });
});
