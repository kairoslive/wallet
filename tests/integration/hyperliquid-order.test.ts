import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createTestClient,
  encodeAbiParameters,
  erc20Abi,
  http,
  keccak256,
  pad,
  recoverTypedDataAddress,
  toHex,
  type Hex,
} from 'viem';
import { WalletService } from '../../src/core/wallet/service';
import { MemoryStore } from '../../src/core/storage';
import type { EvmNetwork } from '../../src/core/types';
import { ARBITRUM_USDC, HYPERLIQUID_BRIDGE, HYPERLIQUID_INFO_URL } from '../../src/core/predictions/hyperliquid';
import { startAnvil, ANVIL_MNEMONIC, type AnvilInstance } from '../helpers/anvil';
import { compileContracts } from '../helpers/contracts';
import {
  approveAgentTypedData,
  builderFeeTypedData,
  hlStep,
  perpsToSpotTypedData,
  placeOrderTypedData,
  withdrawTypedData,
} from '../helpers/hyperliquid';

/**
 * A first Hyperliquid (HIP-4) order against a stand-in multi-venue wallet API: the wallet approves
 * Kairos' trade-only agent and the builder fee, moves the USDC the order needs from its perps to its
 * spot, then signs Kairos' authorization of exactly that order. And a deposit, sent to Hyperliquid's
 * bridge on a local chain playing Arbitrum.
 */
const USER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

type Typed = {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
};
async function signer(td: Typed, signature: Hex) {
  const types = { ...td.types };
  delete types.EIP712Domain;
  return recoverTypedDataAddress({ ...td, types, signature } as unknown as Parameters<typeof recoverTypedDataAddress>[0]);
}

describe('Hyperliquid order (multi-venue wallet API)', () => {
  let anvil: AnvilInstance;
  let service: WalletService;
  let accountId: string;
  let script: ((body: Record<string, unknown> | undefined) => unknown)[] = [];
  let posts: { body: Record<string, unknown> | undefined; headers: Record<string, string> }[] = [];

  beforeAll(async () => {
    anvil = await startAnvil({ chainId: 42161 });
    // Native USDC on "Arbitrum": a test token's code at USDC's address, with 50 USDC for the user.
    const { TestToken } = compileContracts();
    const test = createTestClient({ mode: 'anvil', transport: http(anvil.rpcUrl) });
    const pub = createPublicClient({ transport: http(anvil.rpcUrl) });
    await test.setCode({
      address: ARBITRUM_USDC,
      bytecode: await deployedCode(TestToken.bytecode, TestToken.abi, pub, anvil.rpcUrl),
    });
    const balanceSlot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [USER, 4n]));
    await test.setStorageAt({ address: ARBITRUM_USDC, index: balanceSlot, value: pad(toHex(50_000_000n)) });

    const fetchFn = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const json = (v: unknown) => new Response(JSON.stringify(v));
      if (u.includes('/v1/markets/hyperliquid/13228')) {
        return json({
          market_id: '13228',
          condition_id: '',
          title: 'NFL Regular Season: San Francisco 49ers v Washington Commanders',
          status: 'open',
          tick_size: 0.0001,
          image: 'https://cdn.outcome.xyz/assets/outcome/13228.png',
          outcomes: [
            { outcome: 'SF', token_id: '#132280' },
            { outcome: 'WAS', token_id: '#132281' },
          ],
        });
      }
      if (u.includes('/v1/marks')) return json({ marks: [] });
      if (u.includes('/discover/')) return json({ markets: [{ id: '13228', title: 'SF v WAS', price: 0.77 }] });
      if (u === HYPERLIQUID_INFO_URL) {
        if (body.type === 'spotClearinghouseState') {
          return json({
            balances: [
              { coin: 'USDC', total: '3.5', hold: '0.5' },
              { coin: '+132280', total: '12.0', hold: '0.0' },
            ],
          });
        }
        return json({ withdrawable: '20.25' });
      }
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
            hyperliquid: { ready: false, next: 'setup', tradingWallet: USER, balance: '0', currency: 'USDC' },
          },
        });
      }
      if (u.includes('/v3/actions')) {
        posts.push({ body, headers: init?.headers as Record<string, string> });
        const next = script.shift();
        if (!next) throw new Error(`unexpected action request ${u}`);
        return json(next(body));
      }
      throw new Error(`unexpected request ${u}`);
    }) as unknown as typeof fetch;
    service = new WalletService({ store: new MemoryStore(), session: new MemoryStore(), pbkdf2Iterations: 1000, fetchFn });
    await service.createWallet({ password: 'password123', mnemonic: ANVIL_MNEMONIC });
    const arbitrum = (await service.getSettings()).networks.find((n) => n.id === 'arbitrum') as EvmNetwork;
    await service.upsertNetwork({ ...arbitrum, rpcUrl: anvil.rpcUrl, history: { kind: 'none' } });
    accountId = (await service.getState()).accounts[0].id;
  }, 120_000);

  afterAll(async () => anvil?.stop());

  it('approves the agent and builder fee, moves perps USDC to spot, and authorizes the order, in one action', async () => {
    posts = [];
    const order = placeOrderTypedData(USER, { price: '0.77', size: '10' });
    script = [
      () => hlStep(USER, approveAgentTypedData(), 'Allow Kairos to place Hyperliquid trades for you before your order'),
      () => hlStep(USER, builderFeeTypedData(), 'Approve the Hyperliquid builder fee on your trades (no gas)'),
      () => hlStep(USER, perpsToSpotTypedData({ amount: '7.78' }), 'Move 7.78 USDC from your Hyperliquid perps to spot'),
      () => hlStep(USER, order),
      () => ({
        id: 'hl',
        type: 'order',
        status: 'done',
        request: null,
        description: null,
        result: { orderId: 'o1', status: 'open', venueOrderId: '991', venue: 'hyperliquid', market: 'hyperliquid:13228' },
        error: null,
      }),
    ];

    const result = await service.predictionOrder(accountId, {
      marketId: 'hyperliquid:13228',
      outcome: 'SF',
      side: 'buy',
      price: '0.77',
      size: '10',
    });
    expect(result).toMatchObject({ orderId: 'o1', venue: 'hyperliquid' });
    expect(posts[0].body).toMatchObject({
      wallet: USER,
      action: {
        type: 'order',
        market: 'hyperliquid:13228',
        outcome: 'SF',
        side: 'buy',
        price: '0.77',
        size: '10',
        timeInForce: 'GTC',
      },
    });
    for (const p of posts) expect(p.headers['X-Kairos-Wallet-Api']).toBe('2');

    const signed = [approveAgentTypedData(), builderFeeTypedData(), perpsToSpotTypedData({ amount: '7.78' }), order];
    for (const [i, td] of signed.entries()) {
      expect(await signer(td as Typed, (posts[i + 1].body as { signature: Hex }).signature)).toBe(USER);
    }
  });

  it('refuses a withdrawal dressed up as a setup step, and signs nothing', async () => {
    posts = [];
    script = [() => hlStep(USER, withdrawTypedData('0x000000000000000000000000000000000000dEaD'))];
    await expect(
      service.predictionOrder(accountId, {
        marketId: 'hyperliquid:13228',
        outcome: 'SF',
        side: 'buy',
        price: '0.77',
        size: '10',
      }),
    ).rejects.toThrow('Refused to sign: unexpected Hyperliquid request HyperliquidTransaction:Withdraw');
    expect(posts).toHaveLength(1);
  });

  it('keeps to Hyperliquid’s order rules before asking Kairos', async () => {
    posts = [];
    const place = (o: { size?: string; price?: string; timeInForce?: 'GTD' }) =>
      service.predictionOrder(accountId, {
        marketId: 'hyperliquid:13228',
        outcome: 'SF',
        side: 'buy',
        price: '0.77',
        size: '10',
        ...o,
      });
    await expect(place({ size: '10.5' })).rejects.toThrow('whole shares');
    await expect(place({ timeInForce: 'GTD' })).rejects.toThrow('stay open until filled or cancelled');
    expect(posts).toHaveLength(0);
  });

  it('signs a market order priced with float noise at the price Hyperliquid will use', async () => {
    posts = [];
    script = [
      () => hlStep(USER, placeOrderTypedData(USER, { price: '0.3', size: '10', timeInForce: 'FAK' })),
      () => ({
        id: 'hl',
        type: 'order',
        status: 'done',
        request: null,
        description: null,
        result: { orderId: 'o2', status: 'filled', venueOrderId: '992' },
        error: null,
      }),
    ];
    // The UI asks for fill-or-kill on market orders; Hyperliquid has none, so it fills what it can.
    await service.predictionOrder(accountId, {
      marketId: 'hyperliquid:13228',
      outcome: 'SF',
      side: 'buy',
      price: String(0.1 + 0.2), // 0.30000000000000004
      size: '10',
      timeInForce: 'FOK',
    });
    expect(posts[0].body).toMatchObject({ action: { price: '0.3', timeInForce: 'FAK' } });
  });

  it('reads balances and holdings from Hyperliquid', async () => {
    expect(await service.hyperliquidBalances(accountId)).toEqual({ spotUsdc: 3, perpsUsdc: 20.25, arbitrumUsdc: 50 });
    expect(await service.predictionHoldings(accountId, 'hyperliquid:13228')).toEqual({ SF: 12, WAS: 0 });
  });

  it('deposits USDC to Hyperliquid through its bridge on Arbitrum, never under the minimum', async () => {
    await expect(service.hyperliquidDeposit(accountId, '4.99')).rejects.toThrow('at least 5 USDC');
    await expect(service.hyperliquidDeposit(accountId, '60')).rejects.toThrow('Insufficient USDC balance');
    const tx = await service.hyperliquidDeposit(accountId, '6');
    expect(tx).toMatchObject({ to: HYPERLIQUID_BRIDGE, title: 'Deposited 6 USDC to Hyperliquid', kind: 'contract' });
    const pub = createPublicClient({ transport: http(anvil.rpcUrl) });
    await pub.waitForTransactionReceipt({ hash: tx.hash as Hex });
    const read = (address: Hex) =>
      pub.readContract({ address: ARBITRUM_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
    expect(await read(HYPERLIQUID_BRIDGE)).toBe(6_000_000n);
    expect(await read(USER)).toBe(44_000_000n);
    const { txs } = await service.getHistory(accountId, 'arbitrum', { localOnly: true });
    expect(txs.find((t) => t.hash === tx.hash)?.title).toBe('Deposited 6 USDC to Hyperliquid');
  });
});

/** Deploys a contract once and returns its runtime code, to place at another address. */
async function deployedCode(
  bytecode: Hex,
  abi: readonly unknown[],
  pub: ReturnType<typeof createPublicClient>,
  rpcUrl: string,
): Promise<Hex> {
  const { createWalletClient } = await import('viem');
  const { mnemonicToAccount } = await import('viem/accounts');
  const wallet = createWalletClient({ account: mnemonicToAccount(ANVIL_MNEMONIC), transport: http(rpcUrl) });
  const hash = await wallet.deployContract({
    abi,
    bytecode,
    args: ['USD Coin', 'USDC', 6, 0n],
    chain: {
      id: 42161,
      name: 'local',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    },
  });
  const { contractAddress } = await pub.waitForTransactionReceipt({ hash });
  return (await pub.getCode({ address: contractAddress! }))!;
}
