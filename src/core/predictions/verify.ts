import { getAddress, isAddress } from 'viem';
import type { Action } from './types';

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
  if (Number(td.domain.chainId) !== POLYGON_CHAIN_ID) fail(`unexpected chain ${String(td.domain.chainId)}`);

  // Batched contract calls from the trading wallet are only legitimate during setup (token approvals).
  if (td.domain.name === 'DepositWallet' || 'calls' in td.message) {
    if (ctx.action.type !== 'setup') fail('contract calls are only expected during setup');
    verifyApprovalBatch(td, ctx, fail);
    return td;
  }

  if (td.primaryType === 'ClobAuth') {
    if (ctx.action.type !== 'setup') fail('wallet-ownership proof is only expected during setup');
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
