import { getJson, joinUrl, type Fetch } from '../http';
import type { Network, Token } from '../types';

/**
 * Halliday payments: converts almost any token (or fiat via card/bank onramps) into a target asset,
 * delivered to a destination address. Each payment gets a one-time deposit address (OTW) owned by the
 * user; funding it with the quoted token starts the swap/bridge.
 * https://docs.halliday.xyz/pages/api-quickstart
 */

export interface HallidayConfig {
  url: string;
  /** Publishable (pk_) key; safe to use client-side. */
  apiKey: string;
  fetchFn?: Fetch;
}

/** Our network ids → Halliday chain names. */
const CHAINS: Record<string, string> = {
  eth: 'ethereum',
  base: 'base',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  polygon: 'polygon',
  bsc: 'bsc',
  avalanche: 'avalanche',
  solana: 'solana',
};

export const SOLANA_NATIVE_ASSET = 'solana:So11111111111111111111111111111111111111111';

export function hallidayChain(network: Network): string | undefined {
  return CHAINS[network.id];
}

/** Halliday asset id, e.g. "base:0x833589fc…", "polygon:0x" (native), "solana:EPjF…". */
export function hallidayAsset(network: Network, token: Pick<Token, 'address'>): string | undefined {
  const chain = hallidayChain(network);
  if (!chain) return undefined;
  if (token.address === 'native') return network.type === 'solana' ? SOLANA_NATIVE_ASSET : `${chain}:0x`;
  return network.type === 'evm' ? `${chain}:${token.address.toLowerCase()}` : `${chain}:${token.address}`;
}

function headers(cfg: HallidayConfig, json = false): HeadersInit {
  if (!cfg.apiKey) throw new Error('Set a Halliday API key in Settings → Swap & data providers');
  return { Authorization: `Bearer ${cfg.apiKey}`, ...(json ? { 'content-type': 'application/json' } : {}) };
}

export async function availableInputs(cfg: HallidayConfig, outputAsset: string): Promise<{ tokens: string[]; fiats: string[] }> {
  const res = await getJson<Record<string, { tokens?: string[]; fiats?: string[] }>>(
    joinUrl(cfg.url, `assets/available-inputs?${new URLSearchParams({ 'outputs[]': outputAsset })}`),
    { headers: headers(cfg) },
    cfg.fetchFn,
  );
  const entry = res[outputAsset] ?? Object.values(res)[0] ?? {};
  return { tokens: entry.tokens ?? [], fiats: entry.fiats ?? [] };
}

export interface HallidayQuote {
  paymentId: string;
  stateToken: string;
  inputAsset: string;
  /** Decimal string, in the input asset's units. */
  inputAmount: string;
  outputAsset: string;
  /** Decimal string, in the output asset's units. */
  outputAmount: string;
  feesUsd: number;
  onramp?: string;
  onrampMethod?: string;
  acceptBy: string;
}

interface QuoteResponse {
  quotes: {
    payment_id: string;
    onramp?: string | null;
    onramp_method?: string | null;
    output_amount: { asset: string; amount: string };
    fees?: { total_fees?: string };
  }[];
  state_token: string;
  accept_by: string;
  failures?: { message?: string; reason?: string }[];
}

/** Quotes for converting a fixed input amount (token, or fiat like "USD") into the output asset; best first. */
export async function getQuotes(
  cfg: HallidayConfig,
  p: { inputAsset: string; amount: string; outputAsset: string; onramps?: string[]; onrampMethods?: string[] },
): Promise<HallidayQuote[]> {
  const res = await getJson<QuoteResponse>(
    joinUrl(cfg.url, 'payments/quotes'),
    {
      method: 'POST',
      headers: headers(cfg, true),
      body: JSON.stringify({
        request: {
          kind: 'FIXED_INPUT',
          fixed_input_amount: { asset: p.inputAsset, amount: p.amount },
          output_asset: p.outputAsset,
        },
        price_currency: 'USD',
        ...(p.onramps ? { onramps: p.onramps, onramp_methods: p.onrampMethods } : {}),
      }),
    },
    cfg.fetchFn,
  );
  if (!res.quotes?.length) {
    const why = res.failures?.map((f) => f.message ?? f.reason).filter(Boolean)[0];
    throw new Error(why ? `No route: ${why}` : 'No route for this deposit. Try another token or amount.');
  }
  return res.quotes
    .map((q) => ({
      paymentId: q.payment_id,
      stateToken: res.state_token,
      inputAsset: p.inputAsset,
      inputAmount: p.amount,
      outputAsset: q.output_amount.asset,
      outputAmount: q.output_amount.amount,
      feesUsd: Number(q.fees?.total_fees ?? 0),
      onramp: q.onramp ?? undefined,
      onrampMethod: q.onramp_method ?? undefined,
      acceptBy: res.accept_by,
    }))
    .sort((a, b) => Number(b.outputAmount) - Number(a.outputAmount));
}

export interface DepositInfo {
  deposit_token: string;
  deposit_amount: string;
  deposit_address: string;
  deposit_chain: string;
}

export interface Verification {
  reason: 'EVM_OWNER' | 'EVM_WITHDRAWAL';
  signature_type: 'EIP712' | 'EIP191';
  payload: string;
}

export interface PaymentStatus {
  payment_id: string;
  status: 'PENDING' | 'UNCONFIRMED' | 'COMPLETE' | 'FAILED' | 'EXPIRED' | 'WITHDRAWN' | 'WITHDRAW_PENDING' | string;
  next_instruction?: {
    type: 'ONRAMP' | 'TRANSFER_IN' | 'USER_VERIFY' | string;
    funding_page_url?: string;
    deposit_info?: DepositInfo[];
    verification_token?: string;
    verifications?: Verification[];
  } | null;
  [key: string]: unknown;
}

export async function confirmPayment(
  cfg: HallidayConfig,
  p: { paymentId: string; stateToken: string; owner: string; ownerChain?: string; destination: string },
): Promise<PaymentStatus> {
  return getJson<PaymentStatus>(
    joinUrl(cfg.url, 'payments/confirm'),
    {
      method: 'POST',
      headers: headers(cfg, true),
      body: JSON.stringify({
        payment_id: p.paymentId,
        state_token: p.stateToken,
        owner_address: p.owner,
        destination_address: p.destination,
        ...(p.ownerChain ? { owner_chain: p.ownerChain } : {}),
      }),
    },
    cfg.fetchFn,
  );
}

export async function continueConfirm(
  cfg: HallidayConfig,
  verificationToken: string,
  signatures: { reason: string; signature_type: string; signature: string }[],
): Promise<PaymentStatus> {
  return getJson<PaymentStatus>(
    joinUrl(cfg.url, 'payments/confirm'),
    { method: 'POST', headers: headers(cfg, true), body: JSON.stringify({ verification_token: verificationToken, signatures }) },
    cfg.fetchFn,
  );
}

export async function getPayment(cfg: HallidayConfig, paymentId: string): Promise<PaymentStatus> {
  return getJson<PaymentStatus>(
    joinUrl(cfg.url, `payments?${new URLSearchParams({ payment_id: paymentId })}`),
    { headers: headers(cfg) },
    cfg.fetchFn,
  );
}

/** Statuses where the payment is still moving and the UI should keep polling. */
export const IN_PROGRESS = new Set(['PENDING', 'UNCONFIRMED', 'WITHDRAW_PENDING']);

/**
 * Checks Halliday's funding instruction against the quote before any funds are sent: the deposit
 * must be the quoted token, on the quoted chain, for no more than the quoted amount.
 */
export function checkDepositInfo(
  info: DepositInfo | undefined,
  quote: Pick<HallidayQuote, 'inputAsset' | 'inputAmount'>,
): DepositInfo {
  if (!info) throw new Error('Halliday did not return deposit instructions');
  const norm = (a: string) => (a.includes(':0x') ? a.toLowerCase() : a);
  if (norm(info.deposit_token) !== norm(quote.inputAsset)) throw new Error('Deposit instructions are for a different token');
  if (info.deposit_chain !== quote.inputAsset.split(':')[0]) throw new Error('Deposit instructions are for a different chain');
  if (Number(info.deposit_amount) > Number(quote.inputAmount) * 1.0001)
    throw new Error('Deposit instructions ask for more than you entered');
  if (!info.deposit_address) throw new Error('Deposit instructions have no address');
  return info;
}
