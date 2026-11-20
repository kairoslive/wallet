import { encodeAbiParameters, keccak256 } from 'viem';
import { getJson, type Fetch } from '../http';
import { KAIROS_ENVIRONMENTS } from './environments';

export interface ComboInput {
  /** Polymarket Protocol V2 outcome position IDs, one per market. */
  legs: string[];
  side: 'buy' | 'sell';
  /** pUSD including exchange fees on buys, shares on sells. */
  amount: string;
}

export type ComboTradeInput = ComboInput & ({ side: 'buy'; maxPrice: string } | { side: 'sell'; minProceeds: string });

export interface ComboResult {
  side: ComboInput['side'];
  conditionId: string;
  positionId: string;
  price: string;
  shares: string;
  exchangeFee: string;
  kairosFee: string;
  cost?: string;
  totalCost?: string;
  grossProceeds?: string;
  proceeds?: string;
  netProceeds?: string;
  rfqId?: string;
  status?: string;
  transactionHash?: string;
}

export interface ComboPosition {
  market?: string;
  comboConditionId: string;
  comboPositionId: string;
  sharesBalance: string;
  totalCostUsdc?: string;
  redeemable: boolean;
  legsPending: number;
  legs: { legPositionId: string; title?: string; outcome?: string; outcomeLabel?: string; legStatus?: string }[];
}

export interface ComboMarket {
  id: string;
  title: string;
  image?: string;
  tags: string[];
  outcomes: [{ id: string; label: string; price?: number }, { id: string; label: string; price?: number }];
}

const MAX_UINT256 = (1n << 256n) - 1n;
const ZERO = 0n;

export function comboEnabled(executionUrl: string): boolean {
  return executionUrl.trim().replace(/\/+$/, '').toLowerCase() === KAIROS_ENVIRONMENTS.staging.kairosExecutionUrl;
}

export function comboUnits(value: string): bigint {
  if (typeof value !== 'string' || !/^\d{1,18}(\.\d{1,6})?$/.test(value)) throw new Error('Enter up to 6 decimal places.');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

function legId(raw: string): bigint {
  if (typeof raw !== 'string' || !/^\d{1,78}$/.test(raw)) throw new Error('Invalid combo leg.');
  const id = BigInt(raw);
  const module = id >> 248n;
  if (id > MAX_UINT256 || (module !== 1n && module !== 2n) || (id & 0xffn) > 1n) {
    throw new Error('Invalid combo leg.');
  }
  return id;
}

/** Mirror the deployed Polymarket CombinatorialModule.getConditionId and PositionIdLib.
 * https://polygonscan.com/address/0x30000034706C7d8e12009DAB006Be20000c031A8#code
 */
export function comboPositionId(legs: string[]): bigint {
  if (!Array.isArray(legs) || legs.length < 2 || legs.length > 10) throw new Error('Choose 2 to 10 outcomes.');
  const sorted = legs.map(legId).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (new Set(sorted.map((id) => id >> 8n)).size !== sorted.length) throw new Error('Choose one outcome per market.');
  const module = 3n;
  const data = encodeAbiParameters([{ type: 'uint256[]' }], [sorted]);
  const hash = BigInt(keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [module, data])));
  return (module << 248n) | ((hash & ((1n << 128n) - 1n)) << 120n);
}

export function validateCombo(input: ComboInput): bigint {
  if (input.side !== 'buy' && input.side !== 'sell') throw new Error('Choose a combo trade side.');
  if (comboUnits(input.amount) <= ZERO) throw new Error('Enter an amount greater than zero.');
  return comboPositionId(input.legs);
}

export function comboRedeemMarket(combo: ComboPosition): string {
  const id = comboPositionId(combo.legs.map((leg) => leg.legPositionId));
  if (!combo.redeemable || id.toString() !== combo.comboPositionId) throw new Error('This combo is not ready to redeem.');
  return `polymarket:0x${id.toString(16).padStart(64, '0')}`;
}

export function verifyComboResult(result: ComboResult, input: ComboInput, position: bigint): ComboResult {
  if (result?.side !== input.side || result.positionId !== position.toString())
    throw new Error('Kairos returned a price for a different combo.');
  const price = comboUnits(result.price);
  const shares = comboUnits(result.shares);
  const fee = comboUnits(result.kairosFee);
  comboUnits(result.exchangeFee);
  if (price <= 0n || price > 1_000_000n || shares <= 0n) throw new Error('Kairos returned an invalid combo quote.');
  if (input.side === 'buy') {
    const cost = comboUnits(result.cost ?? '');
    if (cost <= 0n || cost > comboUnits(input.amount) || comboUnits(result.totalCost ?? '') !== cost + fee) {
      throw new Error('Kairos returned an invalid combo cost.');
    }
  } else {
    const proceeds = comboUnits(result.proceeds ?? '');
    const net = comboUnits(result.netProceeds ?? '');
    if (shares !== comboUnits(input.amount) || net <= 0n || net !== proceeds - fee)
      throw new Error('Kairos returned an invalid cash-out quote.');
  }
  return result;
}

interface ComboMarketRow {
  id?: string;
  title?: string;
  image?: string;
  pending?: boolean;
  position_ids?: string[];
  outcomes?: string[];
  outcome_prices?: string[];
  tags?: string[];
}

/** Polymarket's active RFQ catalog, sorted by volume and paged with venue cursors. */
export async function getComboMarkets(cursor?: string, fetchFn?: Fetch): Promise<{ markets: ComboMarket[]; cursor?: string }> {
  const params = new URLSearchParams({ limit: '50' });
  if (cursor) params.set('cursor', cursor);
  const res = await getJson<{ markets: ComboMarketRow[]; next_cursor?: string | null }>(
    `https://combos-rfq-api.polymarket.com/v1/rfq/combo-markets?${params}`,
    {},
    fetchFn,
  );
  const markets = (res.markets ?? []).flatMap((market): ComboMarket[] => {
    const [yes, no] = market.position_ids ?? [];
    if (!yes || !no || !market.id || !market.title || market.pending) return [];
    try {
      const y = legId(yes);
      if ((y & 0xffn) !== 0n || legId(no) !== y + 1n) return [];
    } catch {
      return [];
    }
    const outcome = (id: string, i: number, fallback: string) => {
      const price = Number(market.outcome_prices?.[i] ?? NaN);
      return { id, label: market.outcomes?.[i] || fallback, price: price >= 0 && price <= 1 ? price : undefined };
    };
    return [
      {
        id: market.id,
        title: market.title,
        image: market.image,
        tags: market.tags ?? [],
        outcomes: [outcome(yes, 0, 'Yes'), outcome(no, 1, 'No')],
      },
    ];
  });
  return { markets, cursor: res.next_cursor || undefined };
}
