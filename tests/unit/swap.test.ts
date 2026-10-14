import { describe, expect, it } from 'vitest';
import {
  LIFI_EVM_NATIVE,
  LIFI_SOL_NATIVE,
  getLifiQuote,
  getLifiStatus,
  lifiTokenAddress,
  listLifiTokens,
  type LifiConfig,
} from '../../src/core/swap/lifi';
import { WSOL_MINT, buildJupiterSwapTx, getJupiterQuote, type JupiterConfig } from '../../src/core/swap/jupiter';
import type { QuoteRequest, SwapQuote } from '../../src/core/swap/types';
import { DEFAULT_NETWORKS, LIFI_SOLANA_CHAIN_ID } from '../../src/core/networks';
import { nativeToken } from '../../src/core/tokens';
import type { Network, Token } from '../../src/core/types';
import { headerOf, json, mockFetch } from './helpers/mockFetch';

const net = (id: string) => DEFAULT_NETWORKS.find((n) => n.id === id)!;
const eth = net('eth');
const base = net('base');
const solana = net('solana');
const sepolia = net('sepolia');
const devnet = net('solana-devnet');

const OWNER_EVM = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const OWNER_SOL = 'GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSMQRdW';
const USDC_ETH: Token = { networkId: 'eth', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', name: 'USD Coin', decimals: 6 };
const USDC_BASE: Token = { networkId: 'base', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', name: 'USD Coin', decimals: 6 };
const USDC_SOL: Token = { networkId: 'solana', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', name: 'USD Coin', decimals: 6 };
const SPENDER = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';

const req = (from: Network, to: Network, fromToken: Token, toToken: Token, over: Partial<QuoteRequest> = {}): QuoteRequest => ({
  fromNetworkId: from.id,
  toNetworkId: to.id,
  fromToken,
  toToken,
  fromAmount: '1000000',
  fromAddress: from.type === 'evm' ? OWNER_EVM : OWNER_SOL,
  toAddress: to.type === 'evm' ? OWNER_EVM : OWNER_SOL,
  slippageBps: 50,
  ...over,
});

// A realistic (trimmed) LI.FI /v1/quote response.
const lifiQuote = (over: Record<string, unknown> = {}) => ({
  type: 'lifi',
  id: 'quote-123',
  tool: 'across',
  toolDetails: { key: 'across', name: 'Across', logoURI: 'https://lifi/across.svg' },
  action: { fromChainId: 1, toChainId: 8453, fromToken: {}, toToken: {}, fromAmount: '1000000', slippage: 0.005 },
  estimate: {
    tool: 'across',
    approvalAddress: SPENDER,
    toAmount: '998000',
    toAmountMin: '993010',
    fromAmount: '1000000',
    fromAmountUSD: '1.0001',
    toAmountUSD: '0.9981',
    executionDuration: 52,
    feeCosts: [
      { name: 'LIFI fee', amountUSD: '0.0025', included: true },
      { name: 'Relayer fee', amountUSD: '0.10', included: false },
      { name: 'Other', amountUSD: '0.05' },
    ],
    gasCosts: [{ type: 'SEND', amountUSD: '1.25' }, { type: 'APPROVE', amountUSD: '0.75' }],
  },
  transactionRequest: {
    to: SPENDER,
    data: '0xdeadbeef',
    value: '0x0',
    gasLimit: '0x30d40',
    gasPrice: '0x3b9aca00',
    chainId: 1,
    from: OWNER_EVM,
  },
  ...over,
});

const cfg = (fetchFn: LifiConfig['fetchFn'], over: Partial<LifiConfig> = {}): LifiConfig => ({
  url: 'https://li.quest/',
  integrator: 'duo-wallet',
  fetchFn,
  ...over,
});

describe('lifiTokenAddress', () => {
  it('maps native tokens to LI.FI sentinel addresses', () => {
    expect(lifiTokenAddress(eth, { address: 'native' })).toBe(LIFI_EVM_NATIVE);
    expect(LIFI_EVM_NATIVE).toBe('0x0000000000000000000000000000000000000000');
    expect(lifiTokenAddress(solana, { address: 'native' })).toBe(LIFI_SOL_NATIVE);
    expect(LIFI_SOL_NATIVE).toBe('11111111111111111111111111111111');
    expect(lifiTokenAddress(eth, USDC_ETH)).toBe(USDC_ETH.address);
    expect(lifiTokenAddress(solana, USDC_SOL)).toBe(USDC_SOL.address);
  });
});

describe('getLifiQuote', () => {
  it('sends the right query parameters and api key header', async () => {
    const f = mockFetch(() => lifiQuote());
    await getLifiQuote(cfg(f, { apiKey: 'secret-key' }), eth, base, req(eth, base, nativeToken(eth), USDC_BASE, { slippageBps: 50 }));
    expect(f.calls).toHaveLength(1);
    const u = new URL(f.calls[0].url);
    expect(u.origin + u.pathname).toBe('https://li.quest/v1/quote');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      fromChain: '1',
      toChain: '8453',
      fromToken: LIFI_EVM_NATIVE,
      toToken: USDC_BASE.address,
      fromAmount: '1000000',
      fromAddress: OWNER_EVM,
      toAddress: OWNER_EVM,
      slippage: '0.005',
      integrator: 'duo-wallet',
    });
    expect(headerOf(f.calls[0].init, 'x-lifi-api-key')).toBe('secret-key');
  });

  it('omits the api key header when not configured', async () => {
    const f = mockFetch(() => lifiQuote());
    await getLifiQuote(cfg(f), eth, base, req(eth, base, USDC_ETH, USDC_BASE));
    expect(headerOf(f.calls[0].init, 'x-lifi-api-key')).toBeNull();
  });

  it.each([
    [1, '0.0001'],
    [100, '0.01'],
    [300, '0.03'],
  ])('converts %i bps slippage to fraction %s', async (bps, expected) => {
    const f = mockFetch(() => lifiQuote());
    await getLifiQuote(cfg(f), eth, base, req(eth, base, USDC_ETH, USDC_BASE, { slippageBps: bps }));
    expect(new URL(f.calls[0].url).searchParams.get('slippage')).toBe(expected);
  });

  it('parses an EVM ERC-20 quote including the approval', async () => {
    const f = mockFetch(() => lifiQuote());
    const r = req(eth, base, USDC_ETH, USDC_BASE);
    const before = Date.now();
    const q = await getLifiQuote(cfg(f), eth, base, r);
    expect(q).toMatchObject<Partial<SwapQuote>>({
      id: 'quote-123',
      provider: 'lifi',
      request: r,
      toAmount: '998000',
      toAmountMin: '993010',
      tool: 'Across',
      toolKey: 'across',
      toolLogo: 'https://lifi/across.svg',
      durationSec: 52,
      fromAmountUsd: 1.0001,
      toAmountUsd: 0.9981,
      approval: { token: USDC_ETH.address, spender: SPENDER, amount: '1000000' },
      evmTx: { to: SPENDER, data: '0xdeadbeef', value: '0', gas: '200000', chainId: 1 },
    });
    // Included fees are not added on top.
    expect(q.feeUsd).toBeCloseTo(0.15);
    expect(q.gasUsd).toBeCloseTo(2.0);
    expect(q.solanaTx).toBeUndefined();
    expect(q.createdAt).toBeGreaterThanOrEqual(before);
  });

  it('does not request an approval for native tokens', async () => {
    const f = mockFetch(() =>
      lifiQuote({ transactionRequest: { to: SPENDER, data: '0x01', value: '0xde0b6b3a7640000', chainId: 1 } }),
    );
    const q = await getLifiQuote(cfg(f), eth, base, req(eth, base, nativeToken(eth), USDC_BASE, { fromAmount: '1000000000000000000' }));
    expect(q.approval).toBeUndefined();
    expect(q.evmTx).toEqual({ to: SPENDER, data: '0x01', value: '1000000000000000000', gas: undefined, chainId: 1 });
  });

  it('does not request an approval when LI.FI gives no approvalAddress', async () => {
    const quote = lifiQuote();
    delete (quote.estimate as { approvalAddress?: string }).approvalAddress;
    const f = mockFetch(() => quote);
    const q = await getLifiQuote(cfg(f), eth, base, req(eth, base, USDC_ETH, USDC_BASE));
    expect(q.approval).toBeUndefined();
  });

  it('handles missing optional estimate fields', async () => {
    const f = mockFetch(() =>
      lifiQuote({
        toolDetails: undefined,
        estimate: { toAmount: '5', toAmountMin: '4', feeCosts: [], gasCosts: undefined },
        transactionRequest: { to: SPENDER, data: '0x' },
      }),
    );
    const q = await getLifiQuote(cfg(f), eth, base, req(eth, base, USDC_ETH, USDC_BASE));
    expect(q).toMatchObject({ tool: 'across', toolLogo: undefined, feeUsd: undefined, gasUsd: undefined, fromAmountUsd: undefined });
    expect(q.evmTx).toMatchObject({ value: '0', gas: undefined, chainId: undefined });
    expect(q.approval).toBeUndefined();
  });

  it('parses a Solana-origin quote into solanaTx (native SOL → 1111… address)', async () => {
    const f = mockFetch(() =>
      lifiQuote({
        tool: 'mayan',
        toolDetails: { name: 'Mayan' },
        transactionRequest: { data: 'AQAAAA==base64tx' },
      }),
    );
    const q = await getLifiQuote(cfg(f), solana, eth, req(solana, eth, nativeToken(solana), USDC_ETH));
    const u = new URL(f.calls[0].url);
    expect(u.searchParams.get('fromChain')).toBe(String(LIFI_SOLANA_CHAIN_ID));
    expect(u.searchParams.get('fromToken')).toBe(LIFI_SOL_NATIVE);
    expect(u.searchParams.get('fromAddress')).toBe(OWNER_SOL);
    expect(u.searchParams.get('toAddress')).toBe(OWNER_EVM);
    expect(q.solanaTx).toBe('AQAAAA==base64tx');
    expect(q.evmTx).toBeUndefined();
    expect(q.approval).toBeUndefined();
    expect(q.tool).toBe('Mayan');
  });

  it('maps native ETH as destination to the zero address', async () => {
    const f = mockFetch(() => lifiQuote({ transactionRequest: { data: 'tx' } }));
    await getLifiQuote(cfg(f), solana, base, req(solana, base, USDC_SOL, nativeToken(base)));
    expect(new URL(f.calls[0].url).searchParams.get('toToken')).toBe(LIFI_EVM_NATIVE);
  });

  it('rejects unsupported networks without making a request', async () => {
    const f = mockFetch(() => lifiQuote());
    await expect(getLifiQuote(cfg(f), sepolia, eth, req(sepolia, eth, nativeToken(sepolia), USDC_ETH))).rejects.toThrow(
      'Swaps and bridges are not supported on this network',
    );
    await expect(getLifiQuote(cfg(f), eth, devnet, req(eth, devnet, USDC_ETH, nativeToken(devnet)))).rejects.toThrow(
      'not supported',
    );
    expect(f.calls).toHaveLength(0);
  });

  it('throws when no transaction is returned', async () => {
    const f = mockFetch(() => lifiQuote({ transactionRequest: undefined }));
    await expect(getLifiQuote(cfg(f), eth, base, req(eth, base, USDC_ETH, USDC_BASE))).rejects.toThrow(
      'No transaction returned for this route',
    );
  });

  it('surfaces LI.FI error messages', async () => {
    const f = mockFetch(() => json({ message: 'No available quotes for the requested transfer', code: 1002 }, 404, 'Not Found'));
    await expect(getLifiQuote(cfg(f), eth, base, req(eth, base, USDC_ETH, USDC_BASE))).rejects.toThrow(
      'No available quotes for the requested transfer',
    );
  });
});

describe('getLifiStatus', () => {
  it('sends the right params and parses the status', async () => {
    const f = mockFetch(() => ({
      transactionId: '0x…',
      sending: { txHash: '0xsend', chainId: 1 },
      receiving: { txHash: '0xrecv', chainId: 8453 },
      status: 'DONE',
      substatus: 'COMPLETED',
      substatusMessage: 'The transfer is complete.',
      tool: 'across',
    }));
    const s = await getLifiStatus(cfg(f, { apiKey: 'k' }), '0xsend', 1, 8453, 'across');
    expect(s).toEqual({ status: 'DONE', substatus: 'COMPLETED', substatusMessage: 'The transfer is complete.', receivingTxHash: '0xrecv' });
    const u = new URL(f.calls[0].url);
    expect(u.origin + u.pathname).toBe('https://li.quest/v1/status');
    expect(Object.fromEntries(u.searchParams)).toEqual({ txHash: '0xsend', fromChain: '1', toChain: '8453', bridge: 'across' });
    expect(headerOf(f.calls[0].init, 'x-lifi-api-key')).toBe('k');
  });

  it('omits bridge when not given and handles pending without receiving', async () => {
    const f = mockFetch(() => ({ status: 'PENDING', substatus: 'WAIT_DESTINATION_TRANSACTION' }));
    const s = await getLifiStatus(cfg(f), '0xsend', 1, 8453);
    expect(s).toEqual({ status: 'PENDING', substatus: 'WAIT_DESTINATION_TRANSACTION', substatusMessage: undefined, receivingTxHash: undefined });
    expect(new URL(f.calls[0].url).searchParams.has('bridge')).toBe(false);
  });

  it('maps HTTP 404 to NOT_FOUND', async () => {
    const f = mockFetch(() => json({ message: 'Not an EVM Transaction.', code: 1011 }, 404, 'Not Found'));
    expect(await getLifiStatus(cfg(f), '0xunknown', 1, 8453)).toEqual({ status: 'NOT_FOUND' });
  });

  it('rethrows other errors', async () => {
    const f = mockFetch(() => json({ message: 'Rate limited' }, 429, 'Too Many Requests'));
    await expect(getLifiStatus(cfg(f), '0x', 1, 8453)).rejects.toThrow('Rate limited');
  });
});

describe('listLifiTokens', () => {
  it('flattens tokens across chains', async () => {
    const f = mockFetch(() => ({
      tokens: {
        '1': [{ chainId: 1, address: USDC_ETH.address, symbol: 'USDC', name: 'USD Coin', decimals: 6, priceUSD: '1.00' }],
        '8453': [
          { chainId: 8453, address: USDC_BASE.address, symbol: 'USDC', name: 'USD Coin', decimals: 6 },
          { chainId: 8453, address: LIFI_EVM_NATIVE, symbol: 'ETH', name: 'ETH', decimals: 18 },
        ],
      },
    }));
    const tokens = await listLifiTokens(cfg(f, { apiKey: 'k' }), [1, 8453]);
    expect(tokens.map((t) => `${t.chainId}:${t.symbol}`)).toEqual(['1:USDC', '8453:USDC', '8453:ETH']);
    const u = new URL(f.calls[0].url);
    expect(u.origin + u.pathname).toBe('https://li.quest/v1/tokens');
    expect(u.searchParams.get('chains')).toBe('1,8453');
    expect(headerOf(f.calls[0].init, 'x-lifi-api-key')).toBe('k');
  });

  it('returns [] when tokens are missing', async () => {
    expect(await listLifiTokens(cfg(mockFetch(() => ({}))), [1])).toEqual([]);
  });
});

// ---------------------------------------------------------------- Jupiter

const jupQuote = {
  inputMint: WSOL_MINT,
  inAmount: '1000000000',
  outputMint: USDC_SOL.address,
  outAmount: '150250000',
  otherAmountThreshold: '149498750',
  swapMode: 'ExactIn',
  slippageBps: 50,
  priceImpactPct: '0.0012',
  routePlan: [
    { swapInfo: { ammKey: 'a', label: 'Raydium' }, percent: 60 },
    { swapInfo: { ammKey: 'b', label: 'Orca' }, percent: 40 },
    { swapInfo: { ammKey: 'c', label: 'Raydium' }, percent: 100 },
    { swapInfo: { ammKey: 'd' }, percent: 100 },
  ],
  contextSlot: 1,
  timeTaken: 0.01,
};

const jcfg = (fetchFn: JupiterConfig['fetchFn'], apiKey?: string): JupiterConfig => ({
  url: 'https://lite-api.jup.ag',
  apiKey,
  fetchFn,
});

describe('getJupiterQuote', () => {
  it('maps native SOL to the wSOL mint and sends slippage in bps', async () => {
    const f = mockFetch(() => jupQuote);
    await getJupiterQuote(jcfg(f, 'jup-key'), req(solana, solana, nativeToken(solana), USDC_SOL, { fromAmount: '1000000000', slippageBps: 75 }));
    const u = new URL(f.calls[0].url);
    expect(u.origin + u.pathname).toBe('https://lite-api.jup.ag/swap/v1/quote');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      inputMint: WSOL_MINT,
      outputMint: USDC_SOL.address,
      amount: '1000000000',
      slippageBps: '75',
    });
    expect(headerOf(f.calls[0].init, 'x-api-key')).toBe('jup-key');
  });

  it('maps native as the output too and omits the api key header when unset', async () => {
    const f = mockFetch(() => jupQuote);
    await getJupiterQuote(jcfg(f), req(solana, solana, USDC_SOL, nativeToken(solana)));
    const u = new URL(f.calls[0].url);
    expect(u.searchParams.get('inputMint')).toBe(USDC_SOL.address);
    expect(u.searchParams.get('outputMint')).toBe(WSOL_MINT);
    expect(headerOf(f.calls[0].init, 'x-api-key')).toBeNull();
  });

  it('parses the quote', async () => {
    const f = mockFetch(() => jupQuote);
    const r = req(solana, solana, nativeToken(solana), USDC_SOL);
    const q = await getJupiterQuote(jcfg(f), r);
    expect(q).toMatchObject({
      provider: 'jupiter',
      request: r,
      toAmount: '150250000',
      toAmountMin: '149498750',
      tool: 'Jupiter (Raydium, Orca)',
      raw: jupQuote,
    });
    expect(q.id).toMatch(/^jup-\d+$/);
    expect(q.priceImpactPct).toBeCloseTo(0.12);
    expect(q.evmTx).toBeUndefined();
    expect(q.approval).toBeUndefined();
  });

  it('handles a quote without route labels or price impact', async () => {
    const f = mockFetch(() => ({ ...jupQuote, routePlan: undefined, priceImpactPct: undefined }));
    const q = await getJupiterQuote(jcfg(f), req(solana, solana, nativeToken(solana), USDC_SOL));
    expect(q.tool).toBe('Jupiter');
    expect(q.priceImpactPct).toBeUndefined();
  });

  it('surfaces API errors', async () => {
    const f = mockFetch(() => json({ error: 'Could not find any route', errorCode: 'COULD_NOT_FIND_ANY_ROUTE' }, 400, 'Bad Request'));
    await expect(getJupiterQuote(jcfg(f), req(solana, solana, nativeToken(solana), USDC_SOL))).rejects.toThrow(
      'Could not find any route',
    );
  });
});

describe('buildJupiterSwapTx', () => {
  const quote = (): SwapQuote => ({
    id: 'jup-1',
    provider: 'jupiter',
    request: req(solana, solana, nativeToken(solana), USDC_SOL),
    toAmount: '150250000',
    toAmountMin: '149498750',
    raw: jupQuote,
    createdAt: 0,
  });

  it('POSTs the quote and user key, returning the base64 transaction', async () => {
    const f = mockFetch(() => ({ swapTransaction: 'AQID', lastValidBlockHeight: 1 }));
    const tx = await buildJupiterSwapTx(jcfg(f, 'jup-key'), quote());
    expect(tx).toBe('AQID');
    const { url, init } = f.calls[0];
    expect(url).toBe('https://lite-api.jup.ag/swap/v1/swap');
    expect(init.method).toBe('POST');
    expect(headerOf(init, 'content-type')).toBe('application/json');
    expect(headerOf(init, 'x-api-key')).toBe('jup-key');
    expect(JSON.parse(init.body as string)).toEqual({
      quoteResponse: jupQuote,
      userPublicKey: OWNER_SOL,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    });
  });

  it('throws when Jupiter returns no transaction', async () => {
    const f = mockFetch(() => ({}));
    await expect(buildJupiterSwapTx(jcfg(f), quote())).rejects.toThrow('Jupiter did not return a transaction');
  });
});
