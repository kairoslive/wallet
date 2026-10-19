import { getAddress, isAddress } from 'viem';
import type { Action, Step } from './types';

/**
 * Every signature Kairos asks for is checked here before the wallet signs it.
 * Kairos builds the payloads, so a compromised or buggy API must not be able to
 * get the user to sign something other than what the current action needs.
 */

export const POLYGON_CHAIN_ID = 137;
export const PUSD_ADDRESS = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
/** Polymarket Conditional Tokens (outcome shares, ERC-1155). */
export const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

/**
 * Contracts setup may approve to spend pUSD / move outcome tokens: Polymarket's
 * exchanges, neg-risk adapter and Kairos' settlement contracts, as observed on the
 * setup flow. An unknown spender is refused rather than signed.
 */
export const TRUSTED_SPENDERS = new Set(
  [
    '0xe111180000d2663c0091e4f400237545b87b996b',
    '0xe2222d279d744050d28e00520010520000310f59',
    '0xada2005600dec949baf300f4c6120000bdb6eaab',
    '0xd91e80cf2e7be2e162c6513ced06f1dd0da35296',
    '0xa1200000d0002264c9a1698e001292d00e1b00af',
  ].map((a) => a.toLowerCase()),
);

// ------------------------------------------------------------------ Predict.fun (BNB Chain)

export const BSC_CHAIN_ID = 56;
/** Predict.fun's collateral: USDT on BNB Chain (18 decimals). */
export const BSC_USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955';
/** Predict.fun's four CTF exchanges (plain, neg-risk, yield-bearing, yield-bearing neg-risk): the order domain's verifyingContract. */
export const PREDICTFUN_EXCHANGES = [
  '0x8BC070BEdAB741406F4B1Eb65A72bee27894B689',
  '0x365fb81bd4A24D6303cd2F19c349dE6894D8d58A',
  '0x6bEb5a40C032AFc305961162d8204CDA16DECFa5',
  '0x8A289d458f5a134bA40015085A8F50Ffb681B41d',
];
/** ERC-20s the exchanges may pull: USDT, and the wrapped collateral neg-risk markets settle in (plain, yield-bearing). */
const PREDICTFUN_COLLATERALS = [
  BSC_USDT_ADDRESS,
  '0x66239b70133773A72A0D589E5564E88a50Cd39e7',
  '0xCfb9beF5F7B748aC72311F057f3a888BC73334D9',
];
/** Neg-risk adapters, which also move outcome shares. */
const PREDICTFUN_ADAPTERS = ['0xc3Cf7c252f65E0d8D88537dF96569AE94a7F1A6E', '0x41dCe1A4B8FB5e6327701750aF6231B7CD0B2A40'];
/** Predict.fun's Conditional Tokens contracts (outcome shares, ERC-1155, 18 decimals). */
export const PREDICTFUN_CTFS = [
  '0x22DA1810B194ca018378464a58f6Ac2B10C9d244',
  '0x9400F8Ad57e9e0F352345935d6D3175975eb1d9F',
  '0xF64b0b318AAf83BD9071110af24D24445719A07F',
];
const PREDICTFUN_DOMAIN_NAME = 'predict.fun CTF Exchange';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const SELECTOR_APPROVE = '0x095ea7b3';
const SELECTOR_SET_APPROVAL_FOR_ALL = '0xa22cb465';

export interface VerifyContext {
  /** The user's EOA that signs. */
  wallet: string;
  /** The user's Kairos trading (deposit) wallet, from the status endpoint. */
  tradingWallet: string;
  action: Action;
  /** For orders: the outcome token being traded. */
  tokenId?: string;
}

export interface TypedData {
  domain: { name?: string; version?: string; chainId?: number | string; verifyingContract?: string };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

export class UnsafeSigningRequestError extends Error {
  constructor(reason: string) {
    super(`Refused to sign: ${reason}`);
    this.name = 'UnsafeSigningRequestError';
  }
}

const same = (a: unknown, b: string) => typeof a === 'string' && isAddress(a) && getAddress(a) === getAddress(b);

/** Validates a step's signing request and returns the parsed typed data to sign. */
export function verifySigningRequest(request: { method: string; params: unknown[] } | null, ctx: VerifyContext): TypedData {
  const fail = (reason: string): never => {
    throw new UnsafeSigningRequestError(reason);
  };
  if (!request) fail('the step has no signing request');
  if (ctx.action.type === 'login') fail('sign-in must be a personal_sign request');
  if (request!.method !== 'eth_signTypedData_v4') fail(`unsupported signing method ${request!.method}`);
  const [address, raw] = request!.params;
  if (!same(address, ctx.wallet)) fail('the request is for a different wallet');
  let td: TypedData;
  try {
    td = (typeof raw === 'string' ? JSON.parse(raw) : raw) as TypedData;
  } catch {
    return fail('the typed data is not valid JSON');
  }
  if (!td || typeof td !== 'object' || !td.domain || !td.types || !td.primaryType || !td.message) fail('malformed typed data');
  if (Number(td.domain.chainId) === BSC_CHAIN_ID) {
    verifyPredictfunOrder(td, ctx, fail);
    return td;
  }
  if (HYPERLIQUID_CHAINS[Number(td.domain.chainId)]) {
    verifyHyperliquidRequest(td, ctx, fail);
    return td;
  }
  if (Number(td.domain.chainId) !== POLYGON_CHAIN_ID) fail(`unexpected chain ${String(td.domain.chainId)}`);
  // An order runs whatever setup its venue still needs first, in the same action.
  const settingUp = ctx.action.type === 'setup' || ctx.action.type === 'order';

  // Batched contract calls from the trading wallet are only legitimate while setting up (token approvals).
  if (td.domain.name === 'DepositWallet' || 'calls' in td.message) {
    if (!settingUp) fail('contract calls are only expected during setup');
    verifyApprovalBatch(td, ctx, fail);
    return td;
  }

  if (td.primaryType === 'ClobAuth') {
    if (!settingUp) fail('wallet-ownership proof is only expected during setup');
    if (!same(td.message.address, ctx.wallet)) fail('ownership proof names a different wallet');
    return td;
  }

  if (ctx.action.type === 'order') verifyOrder(td, ctx, fail);
  return td;
}

function verifyApprovalBatch(td: TypedData, ctx: VerifyContext, fail: (r: string) => never) {
  if (!same(td.domain.verifyingContract, ctx.tradingWallet)) fail('the batch is not for your trading wallet');
  if (td.message.wallet !== undefined && !same(td.message.wallet, ctx.tradingWallet)) fail('the batch names a different wallet');
  const calls = td.message.calls;
  if (!Array.isArray(calls) || !calls.length) fail('the batch has no calls');
  for (const c of calls as { target?: string; data?: string; value?: string | number }[]) {
    if (BigInt(c.value ?? 0) !== 0n) fail('a call would send native funds');
    const target = String(c.target ?? '');
    const data = String(c.data ?? '').toLowerCase();
    const selector = data.slice(0, 10);
    // approve(spender, amount) / setApprovalForAll(operator, bool): spender is the first argument.
    const spender = `0x${data.slice(34, 74)}`;
    if (same(target, PUSD_ADDRESS)) {
      if (selector !== SELECTOR_APPROVE) fail(`unexpected pUSD call ${selector}`);
    } else if (same(target, CTF_ADDRESS)) {
      if (selector !== SELECTOR_SET_APPROVAL_FOR_ALL) fail(`unexpected outcome-token call ${selector}`);
    } else {
      fail(`a call targets an unknown contract ${target}`);
    }
    if (data.length !== 138) fail('a call has unexpected arguments');
    if (!TRUSTED_SPENDERS.has(spender)) fail(`approval for an unknown spender ${spender}`);
  }
}

/**
 * Checks the fields of a Polymarket order when present: the outcome token, side and the amount
 * the user gives up must match what they confirmed in the wallet.
 */
function verifyOrder(td: TypedData, ctx: VerifyContext, fail: (r: string) => never) {
  if (ctx.action.type !== 'order') return;
  const m = (td.message.order && typeof td.message.order === 'object' ? td.message.order : td.message) as Record<string, unknown>;
  const owners = [ctx.wallet, ctx.tradingWallet];
  for (const key of ['maker', 'signer']) {
    if (m[key] !== undefined && !owners.some((o) => same(m[key], o))) fail(`the order's ${key} is not your wallet`);
  }
  if (ctx.tokenId && m.tokenId !== undefined && String(m.tokenId) !== ctx.tokenId) fail('the order is for a different outcome');
  if (m.side !== undefined) {
    const side = String(m.side).toLowerCase();
    const isBuy = side === '0' || side === 'buy';
    if (isBuy !== (ctx.action.side === 'buy')) fail('the order side does not match');
  }
  if (m.makerAmount !== undefined) {
    // Amounts are in 6-decimal units for both pUSD and outcome shares.
    const size = Number(ctx.action.size);
    const price = Number(ctx.action.price);
    const maxGive = ctx.action.side === 'buy' ? price * size : size;
    const limit = BigInt(Math.ceil(maxGive * 1.01 * 1e6)) + 10_000n;
    if (BigInt(String(m.makerAmount)) > limit) fail('the order spends more than you confirmed');
  }
}

/**
 * A Predict.fun order: the plain EIP-712 `Order` on one of Predict.fun's exchanges, made and
 * signed by the wallet itself, for the outcome, side and amount the user confirmed.
 */
function verifyPredictfunOrder(td: TypedData, ctx: VerifyContext, fail: (r: string) => never) {
  if (ctx.action.type !== 'order') fail('a BNB Chain signature is only expected for an order');
  if (td.primaryType !== 'Order') fail(`unexpected BNB Chain request ${td.primaryType}`);
  if (td.domain.name !== PREDICTFUN_DOMAIN_NAME) fail(`the order is for ${String(td.domain.name)}, not Predict.fun`);
  if (!PREDICTFUN_EXCHANGES.some((a) => same(td.domain.verifyingContract, a))) fail('the order is for an unknown exchange');
  const m = td.message;
  if (!same(m.maker, ctx.wallet) || !same(m.signer, ctx.wallet)) fail('the order is not made by your wallet');
  if (m.taker !== undefined && !same(m.taker, ZERO_ADDRESS)) fail('the order is reserved for one counterparty');
  if (m.signatureType !== undefined && Number(m.signatureType) !== 0) fail('unexpected signature type');
  if (ctx.action.type !== 'order') return;
  if (!ctx.tokenId || String(m.tokenId) !== ctx.tokenId) fail('the order is for a different outcome');
  const isBuy = String(m.side) === '0';
  if (!['0', '1'].includes(String(m.side)) || isBuy !== (ctx.action.side === 'buy')) fail('the order side does not match');
  // USDT and outcome shares both have 18 decimals.
  const size = Number(ctx.action.size);
  const price = Number(ctx.action.price);
  const maxGive = ctx.action.side === 'buy' ? price * size : size;
  const limit = BigInt(Math.ceil(maxGive * 1.01 * 1e6)) * 10n ** 12n + 10n ** 16n;
  let amount: bigint;
  try {
    amount = BigInt(String(m.makerAmount));
  } catch {
    return fail('the order has no amount');
  }
  if (amount > limit) fail('the order spends more than you confirmed');
}

// ------------------------------------------------------------------ Hyperliquid (HIP-4 outcome markets)

/** The chain Hyperliquid's user-signed actions name, by the HyperCore network it means. */
const HYPERLIQUID_CHAINS: Record<number, string> = { 42161: 'Mainnet', 421614: 'Testnet' };
/** Builder fees above this are refused (Hyperliquid caps perps at 0.1%; Kairos charges none in production). */
export const HYPERLIQUID_MAX_BUILDER_FEE_PERCENT = 0.1;
/** Taker fees plus the largest builder fee: what a perps → spot move may add on top of the order's cost. */
const HYPERLIQUID_MAX_FEE_RATE = 0.011;

/** The user-signed HyperCore actions setup and orders may ask for, with their exact fields. Nothing else is signed. */
const HYPERLIQUID_USER_ACTIONS: Record<string, string[]> = {
  'HyperliquidTransaction:ApproveAgent': ['hyperliquidChain', 'agentAddress', 'agentName', 'nonce'],
  'HyperliquidTransaction:ApproveBuilderFee': ['hyperliquidChain', 'maxFeeRate', 'builder', 'nonce'],
  'HyperliquidTransaction:UsdClassTransfer': ['hyperliquidChain', 'amount', 'toPerp', 'nonce'],
};
const KAIROS_PLACE_ORDER = [
  'wallet',
  'market',
  'outcome',
  'side',
  'price',
  'size',
  'timeInForce',
  'postOnly',
  'action',
  'expiresAt',
];

const fieldNames = (td: TypedData) => (td.types[td.primaryType] ?? []).map((f) => f.name).join(',');
const sameDecimal = (a: unknown, b: string) => typeof a === 'string' && a.trim() !== '' && Number(a) === Number(b);

/**
 * A Hyperliquid request: the agent approval (trade-only, cannot withdraw) and builder-fee grant of
 * setup, a move of the wallet's own perps USDC to its own spot for an order, or Kairos' order
 * authorization, which must match the order the user confirmed field for field.
 */
function verifyHyperliquidRequest(td: TypedData, ctx: VerifyContext, fail: (r: string) => never) {
  const action = ctx.action;
  const network = HYPERLIQUID_CHAINS[Number(td.domain.chainId)];
  if (td.primaryType === 'PlaceOrder') {
    if (action.type !== 'order') return fail('an order signature is only expected for an order');
    if (td.domain.name !== 'Kairos' || td.domain.version !== '1' || td.domain.verifyingContract !== undefined) {
      fail('the order authorization is not Kairos’');
    }
    if (fieldNames(td) !== KAIROS_PLACE_ORDER.join(',')) fail('the order authorization has unexpected fields');
    const m = td.message;
    if (!same(m.wallet, ctx.wallet)) fail('the order is for a different wallet');
    if (m.market !== action.market) fail('the order is for a different market');
    if (m.outcome !== action.outcome.trim()) fail('the order is for a different outcome');
    if (m.side !== action.side) fail('the order side does not match');
    if (!sameDecimal(m.price, action.price)) fail('the order price does not match');
    if (!sameDecimal(m.size, action.size)) fail('the order size does not match');
    if (m.timeInForce !== (action.timeInForce ?? 'GTC')) fail('the order duration does not match');
    if (m.postOnly !== !!action.postOnly) fail('the order’s post-only setting does not match');
    const expires = Number(m.expiresAt);
    if (!Number.isFinite(expires) || expires > Date.now() / 1000 + 3600) fail('the order authorization lasts too long');
    return;
  }

  const fields = HYPERLIQUID_USER_ACTIONS[td.primaryType];
  if (!fields) return fail(`unexpected Hyperliquid request ${td.primaryType}`);
  if (
    td.domain.name !== 'HyperliquidSignTransaction' ||
    td.domain.version !== '1' ||
    !same(td.domain.verifyingContract, ZERO_ADDRESS)
  ) {
    fail('the request is not a Hyperliquid action');
  }
  if (fieldNames(td) !== fields.join(',')) fail('the Hyperliquid request has unexpected fields');
  const m = td.message;
  if (m.hyperliquidChain !== network) fail('the request is for a different Hyperliquid network');
  if (action.type !== 'setup' && action.type !== 'order')
    fail('Hyperliquid approvals are only expected during setup or an order');

  switch (td.primaryType) {
    case 'HyperliquidTransaction:ApproveAgent':
      if (typeof m.agentAddress !== 'string' || !isAddress(m.agentAddress)) fail('the agent is not an address');
      if (same(m.agentAddress, ctx.wallet)) fail('the agent is your own wallet');
      if (typeof m.agentName !== 'string' || m.agentName.length > 32) fail('unexpected agent name');
      return;
    case 'HyperliquidTransaction:ApproveBuilderFee': {
      if (typeof m.builder !== 'string' || !isAddress(m.builder)) fail('the builder is not an address');
      const rate = /^(\d+(?:\.\d+)?)%$/.exec(String(m.maxFeeRate));
      if (!rate || Number(rate[1]) > HYPERLIQUID_MAX_BUILDER_FEE_PERCENT) fail(`builder fee ${String(m.maxFeeRate)} is too high`);
      return;
    }
    case 'HyperliquidTransaction:UsdClassTransfer': {
      // Only ever the wallet's own perps to its own spot, for at most what the order costs.
      if (action.type !== 'order' || action.side !== 'buy') return fail('moving USDC is only expected for a buy');
      if (m.toPerp !== false) fail('the transfer moves USDC to perps');
      const cost = Number(action.price) * Number(action.size);
      const max = Math.ceil(cost * (1 + HYPERLIQUID_MAX_FEE_RATE) * 100) / 100 + 0.01;
      const amount = Number(m.amount);
      if (typeof m.amount !== 'string' || !(amount > 0) || amount > max) fail('the transfer moves more than this order needs');
      return;
    }
  }
}

const hexChain = (id: number) => `0x${id.toString(16)}`;

/**
 * Validates a `wallet_sendCalls` step: Predict.fun's one-time approvals, which the wallet sends
 * itself on BNB Chain. Every call must approve Predict.fun collateral to a Predict.fun exchange, or
 * let a Predict.fun exchange or adapter move outcome shares. Returns the calls to send.
 */
export function verifyWalletCalls(step: Step, ctx: { wallet: string; action: Action }): { to: string; data: string }[] {
  const fail = (reason: string): never => {
    throw new UnsafeSigningRequestError(reason);
  };
  const request = step.request;
  if (!request || request.method !== 'wallet_sendCalls') fail('expected a wallet_sendCalls request');
  if (ctx.action.type !== 'setup' && ctx.action.type !== 'order') fail('transactions are only expected during setup');
  const [batch] = request!.params as [{ chainId?: string; from?: string; calls?: unknown } | undefined];
  if (!batch || typeof batch !== 'object') fail('malformed wallet_sendCalls request');
  const chainId = String(batch!.chainId ?? step.chainId ?? '').toLowerCase();
  if (chainId !== hexChain(BSC_CHAIN_ID)) fail(`transactions on unexpected chain ${chainId}`);
  if (step.chainId && step.chainId.toLowerCase() !== chainId) fail('the step and its calls name different chains');
  if (batch!.from !== undefined && !same(batch!.from, ctx.wallet)) fail('the calls are from a different wallet');
  const calls = batch!.calls;
  if (!Array.isArray(calls) || !calls.length || calls.length > 24) fail('unexpected number of calls');
  return (calls as { to?: string; data?: string; value?: string | number }[]).map((c) => {
    if (BigInt(c.value ?? 0) !== 0n) fail('a call would send native funds');
    const to = String(c.to ?? '');
    const data = String(c.data ?? '').toLowerCase();
    const selector = data.slice(0, 10);
    const spender = `0x${data.slice(34, 74)}`;
    if (data.length !== 138 || !/^0x[0-9a-f]+$/.test(data)) fail('a call has unexpected arguments');
    if (PREDICTFUN_COLLATERALS.some((a) => same(to, a))) {
      if (selector !== SELECTOR_APPROVE) fail(`unexpected collateral call ${selector}`);
      if (!PREDICTFUN_EXCHANGES.some((a) => same(spender, a))) fail(`collateral approval for an unknown spender ${spender}`);
    } else if (PREDICTFUN_CTFS.some((a) => same(to, a))) {
      if (selector !== SELECTOR_SET_APPROVAL_FOR_ALL) fail(`unexpected outcome-token call ${selector}`);
      if (![...PREDICTFUN_EXCHANGES, ...PREDICTFUN_ADAPTERS].some((a) => same(spender, a))) {
        fail(`outcome-token approval for an unknown operator ${spender}`);
      }
    } else {
      fail(`a call targets an unknown contract ${to}`);
    }
    return { to: getAddress(to), data };
  });
}

// ------------------------------------------------------------------ sign-in (login action)

/** Hosts a Kairos sign-in message may name: the configured wallet API host, or any kairos.trade host. */
function isKairosHost(host: string, executionUrl: string): boolean {
  const h = host.toLowerCase();
  let api = '';
  try {
    api = new URL(executionUrl).host.toLowerCase();
  } catch {
    // An invalid URL just means only kairos.trade hosts are accepted.
  }
  return h === api || h === 'kairos.trade' || h.endsWith('.kairos.trade');
}

function decodeMessage(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (!/^0x([0-9a-fA-F]{2})*$/.test(raw)) return raw;
  const bytes = new Uint8Array((raw.length - 2) / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(raw.slice(2 + i * 2, 4 + i * 2), 16);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Validates the `personal_sign` request of a `login` action and returns the message to sign. It
 * must be a Sign-In with Ethereum (EIP-4361) message for this wallet whose domain and URI are
 * Kairos, so the API can't get the wallet to sign in to some other site.
 */
export function verifyLoginRequest(
  request: { method: string; params: unknown[] } | null,
  ctx: { wallet: string; action: Action; executionUrl: string },
): string {
  const fail = (reason: string): never => {
    throw new UnsafeSigningRequestError(reason);
  };
  if (!request) fail('the step has no signing request');
  if (ctx.action.type !== 'login') fail('a sign-in message is only expected when signing in');
  if (request!.method !== 'personal_sign') fail(`unsupported signing method ${request!.method}`);
  const [raw, address] = request!.params;
  if (!same(address, ctx.wallet)) fail('the request is for a different wallet');
  const text = decodeMessage(raw);
  if (!text) fail('the sign-in message is not readable text');

  const lines = text!.split('\n');
  const header = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^\s/]+) wants you to sign in with your Ethereum account:$/i.exec(lines[0] ?? '');
  if (!header) fail('not a Sign-In with Ethereum message');
  if (!isKairosHost(header![1], ctx.executionUrl)) fail(`the sign-in is for ${header![1]}, not Kairos`);
  if (!same(lines[1]?.trim(), ctx.wallet)) fail('the sign-in names a different wallet');

  const field = (name: string) =>
    lines
      .find((l) => l.startsWith(`${name}: `))
      ?.slice(name.length + 2)
      .trim();
  const uri = field('URI');
  if (!uri) fail('the sign-in has no URI');
  let uriHost = '';
  try {
    uriHost = new URL(uri!).host;
  } catch {
    fail('the sign-in URI is invalid');
  }
  if (!isKairosHost(uriHost, ctx.executionUrl)) fail(`the sign-in URI points to ${uriHost}, not Kairos`);
  if (field('Version') !== '1') fail('unsupported Sign-In with Ethereum version');
  if (!field('Nonce')) fail('the sign-in has no nonce');
  return typeof raw === 'string' ? raw : '';
}

/**
 * Validates a venue's own sign-in (`personal_sign` of Predict.fun's login challenge, which Kairos
 * trades for the venue session that lets it place and watch the wallet's orders). It runs inside a
 * setup or an order. A signed text message can't move funds; the checks keep it to readable text
 * for this wallet, and a Sign-In with Ethereum message must name Predict.fun.
 */
export function verifyVenueLoginRequest(step: Step, ctx: { wallet: string; action: Action }): string {
  const fail = (reason: string): never => {
    throw new UnsafeSigningRequestError(reason);
  };
  const request = step.request;
  if (!request || request.method !== 'personal_sign') fail('expected a personal_sign request');
  if (step.venue !== 'predictfun') fail('a venue sign-in is only expected for Predict.fun');
  if (ctx.action.type !== 'setup' && ctx.action.type !== 'order') fail('a venue sign-in is only expected during setup');
  const [raw, address] = request!.params;
  if (!same(address, ctx.wallet)) fail('the request is for a different wallet');
  const text = decodeMessage(raw);
  if (!text || !text.trim() || text.length > 2000) fail('the sign-in message is not readable text');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0e-\x1f]/.test(text!)) fail('the sign-in message is not readable text');
  if (/^0x[0-9a-f]{64}$/i.test(text!.trim())) fail('the sign-in message is a raw hash');
  const siwe = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^\s/]+) wants you to sign in with your Ethereum account:/i.exec(text!);
  if (siwe) {
    const host = siwe[1].toLowerCase();
    if (host !== 'predict.fun' && !host.endsWith('.predict.fun')) fail(`the sign-in is for ${host}, not Predict.fun`);
  }
  return typeof raw === 'string' ? raw : '';
}
