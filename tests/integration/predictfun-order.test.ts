import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, http, recoverMessageAddress, recoverTypedDataAddress, type Hex } from 'viem';
import { WalletService } from '../../src/core/wallet/service';
import { MemoryStore } from '../../src/core/storage';
import type { EvmNetwork } from '../../src/core/types';
import { startAnvil, ANVIL_MNEMONIC, type AnvilInstance } from '../helpers/anvil';
import {
  APPROVALS,
  LOGIN_MESSAGE,
  USDT,
  approveCall,
  orderStep,
  orderTypedData,
  sendCallsStep,
  venueLoginStep,
} from '../helpers/predictfun';

/**
 * A first Predict.fun order against a stand-in multi-venue wallet API, with BNB Chain played by a
 * local chain (id 56): the wallet sends the one-time approvals itself, signs Predict.fun's login,
 * then signs the order, all inside one action.
 */
const USER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const TOKEN = '22792533058364109967843974336023525129117701581478587988463610813242968119951';
const E18 = 10n ** 18n;

describe('Predict.fun order (multi-venue wallet API)', () => {
  let anvil: AnvilInstance;
  let service: WalletService;
  let accountId: string;
  let script: ((body: Record<string, unknown> | undefined) => unknown)[] = [];
  let posts: { url: string; body: Record<string, unknown> | undefined; headers: Record<string, string> }[] = [];

  beforeAll(async () => {
    anvil = await startAnvil({ chainId: 56 });
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const json = (v: unknown) => new Response(JSON.stringify(v));
      if (u.includes('/v1/markets/predictfun/3394712')) {
        return json({
          market_id: '3394712',
          condition_id: '0x66ab4b0834dd860a35d2fdd9be319ef0ee0ac6ff58b4efea32c78484eb10e683',
          title: 'LoL: MVK Esports vs Karmine Corp (BO5)',
          status: 'open',
          tick_size: 0.01,
          image: 'https://static.predict.fun/x.jpg',
          outcomes: [
            { outcome: 'MVK', token_id: TOKEN },
            { outcome: 'KC', token_id: '45037070117908503852634416053362667880996399826599604567350300693665460331040' },
          ],
        });
      }
      if (u.includes('/v1/marks')) return json({ marks: [] });
      if (u.includes('/v3/wallets/')) {
        return json({
          wallet: USER,
          ready: false,
          next: 'setup',
          venues: {
            polymarket: {
              ready: false,
              next: 'setup',
              tradingWallet: '0xb767404cf2c0a9af65d47e83a5c979cf07056cca',
              balance: '0',
            },
            predictfun: { ready: false, next: 'setup', balance: '25', currency: 'USDT' },
          },
        });
      }
      if (u.includes('/v3/actions')) {
        posts.push({ url: u, body, headers: init?.headers as Record<string, string> });
        const next = script.shift();
        if (!next) throw new Error(`unexpected action request ${u}`);
        return json(next(body));
      }
      throw new Error(`unexpected request ${u}`);
    }) as unknown as typeof fetch;
    service = new WalletService({ store: new MemoryStore(), session: new MemoryStore(), pbkdf2Iterations: 1000, fetchFn });
    await service.createWallet({ password: 'password123', mnemonic: ANVIL_MNEMONIC });
    const bsc = (await service.getSettings()).networks.find((n) => n.id === 'bsc') as EvmNetwork;
    await service.upsertNetwork({ ...bsc, rpcUrl: anvil.rpcUrl, history: { kind: 'none' } });
    accountId = (await service.getState()).accounts[0].id;
  }, 120_000);

  afterAll(async () => anvil?.stop());

  it('sends the approvals on BNB Chain, signs in to Predict.fun and signs the order, in one action', async () => {
    posts = [];
    const td = orderTypedData(USER, { tokenId: TOKEN, makerAmount: (5n * E18).toString() });
    script = [
      () => sendCallsStep(USER),
      () => venueLoginStep(USER),
      () => orderStep(USER, td),
      () => ({
        id: 'pf',
        type: 'order',
        status: 'done',
        request: null,
        description: null,
        result: { orderId: 'o1', status: 'open', venueOrderId: 'v1', venue: 'predictfun', market: 'predictfun:3394712' },
        error: null,
      }),
    ];

    const result = await service.predictionOrder(accountId, {
      marketId: 'predictfun:3394712',
      outcome: 'MVK',
      side: 'buy',
      price: '0.5',
      size: '10',
    });
    expect(result).toMatchObject({ orderId: 'o1', venue: 'predictfun' });

    // The order names its venue, and every request opts in to the multi-venue API.
    expect(posts[0].body).toMatchObject({
      wallet: USER,
      action: { type: 'order', market: 'predictfun:3394712', outcome: 'MVK' },
    });
    for (const p of posts) expect(p.headers['X-Kairos-Wallet-Api']).toBe('2');

    // Approvals: 12 transactions from the wallet on chain 56, exactly the calls asked for.
    const hashes = (posts[1].body as { result: Hex[] }).result;
    expect(hashes).toHaveLength(12);
    const client = createPublicClient({ transport: http(anvil.rpcUrl) });
    for (const [i, hash] of hashes.entries()) {
      const tx = await client.getTransaction({ hash });
      expect(tx.chainId).toBe(56);
      expect(tx.from.toLowerCase()).toBe(USER.toLowerCase());
      expect(tx.to!.toLowerCase()).toBe(APPROVALS[i].to.toLowerCase());
      expect(tx.input).toBe(APPROVALS[i].data);
      expect(tx.value).toBe(0n);
    }
    const { txs } = await service.getHistory(accountId, 'bsc', { localOnly: true });
    expect(txs.filter((t) => t.title === 'Approved Predict.fun trading')).toHaveLength(12);

    // Predict.fun's login challenge, signed by the wallet.
    const login = (posts[2].body as { signature: Hex }).signature;
    expect(await recoverMessageAddress({ message: LOGIN_MESSAGE, signature: login })).toBe(USER);

    // The order, signed by the wallet over Predict.fun's domain on chain 56.
    const types = { ...td.types } as Record<string, unknown>;
    delete types.EIP712Domain;
    const signer = await recoverTypedDataAddress({
      domain: td.domain,
      types,
      primaryType: 'Order',
      message: td.message,
      signature: (posts[3].body as { signature: Hex }).signature,
    } as unknown as Parameters<typeof recoverTypedDataAddress>[0]);
    expect(signer).toBe(USER);
  });

  it('refuses an approval for an unknown spender and sends nothing', async () => {
    posts = [];
    const before = await createPublicClient({ transport: http(anvil.rpcUrl) }).getTransactionCount({ address: USER });
    script = [
      () => sendCallsStep(USER, [...APPROVALS.slice(0, 3), approveCall(USDT, '0x000000000000000000000000000000000000dEaD')]),
    ];
    await expect(
      service.predictionOrder(accountId, {
        marketId: 'predictfun:3394712',
        outcome: 'MVK',
        side: 'buy',
        price: '0.5',
        size: '10',
      }),
    ).rejects.toThrow('Refused to sign: collateral approval for an unknown spender');
    expect(posts).toHaveLength(1);
    expect(await createPublicClient({ transport: http(anvil.rpcUrl) }).getTransactionCount({ address: USER })).toBe(before);
  });
});
