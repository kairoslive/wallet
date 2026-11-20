import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import {
  comboPositionId,
  comboRedeemMarket,
  getComboMarkets,
  verifyComboResult,
  type ComboResult,
  type ComboTradeInput,
} from '../../src/core/predictions/combos';
import { verifySigningRequest, type TypedData } from '../../src/core/predictions/verify';

const wallet = getAddress('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
const tradingWallet = getAddress('0xb767404cf2c0a9af65d47e83a5c979cf07056cca');
const yesA = '737627543131928977073597406197629922241678896546839963013331152486512197632';
const yesB = '798559951534518479645224261511384773234863312866932338530531601041078616064';
const noA = (BigInt(yesA) + 1n).toString();
const legs = [yesA, yesB];
// CombinatorialModule.getConditionId on Polygon for these two listed Polymarket legs.
const market = '0x036289da690189dbbed6e130055aab7db8000000000000000000000000000000';
const positionId = BigInt(market).toString();
const zero = `0x${'0'.repeat(64)}`;

const buy: ComboTradeInput = { legs, side: 'buy', amount: '10', maxPrice: '0.5' };
const sell: ComboTradeInput = { legs, side: 'sell', amount: '20', minProceeds: '9' };

function order(overrides: Record<string, unknown> = {}): TypedData {
  return {
    domain: {
      name: 'Polymarket CTF Exchange',
      version: '3',
      chainId: 137,
      verifyingContract: '0xe3333700cA9d93003F00f0F71f8515005F6c00Aa',
    },
    primaryType: 'TypedDataSign',
    types: {
      Order: [
        { name: 'maker', type: 'address' },
        { name: 'signer', type: 'address' },
        { name: 'tokenId', type: 'uint256' },
        { name: 'makerAmount', type: 'uint256' },
        { name: 'takerAmount', type: 'uint256' },
        { name: 'side', type: 'uint8' },
        { name: 'signatureType', type: 'uint8' },
        { name: 'metadata', type: 'bytes32' },
        { name: 'builder', type: 'bytes32' },
      ],
      TypedDataSign: [
        { name: 'contents', type: 'Order' },
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
        { name: 'salt', type: 'bytes32' },
      ],
    },
    message: {
      name: 'DepositWallet',
      version: '1',
      chainId: 137,
      verifyingContract: tradingWallet,
      salt: zero,
      contents: {
        maker: tradingWallet,
        signer: tradingWallet,
        signatureType: 3,
        tokenId: positionId,
        side: 0,
        makerAmount: '10000000',
        takerAmount: '20000000',
        builder: zero,
        metadata: zero,
        ...overrides,
      },
    },
  };
}

const verify = (input: ComboTradeInput, typedData = order()) =>
  verifySigningRequest(
    {
      method: 'eth_signTypedData_v4',
      params: [wallet, JSON.stringify(typedData)],
    },
    { wallet, tradingWallet, action: { type: 'combo', ...input } },
  );

describe('Polymarket combo identities', () => {
  it('derives the same YES position ID as the deployed Polygon CombinatorialModule', () => {
    expect(comboPositionId(legs).toString()).toBe(positionId);
    expect(comboPositionId([...legs].reverse()).toString()).toBe(positionId);
    expect(comboPositionId([noA, yesB]).toString()).not.toBe(positionId);
    expect(
      comboRedeemMarket({
        comboPositionId: positionId,
        comboConditionId: market,
        redeemable: true,
        sharesBalance: '20',
        legsPending: 0,
        legs: legs.map((legPositionId) => ({ legPositionId })),
      }),
    ).toBe(`polymarket:${market}`);
  });

  it('rejects duplicate and contrary outcomes from the same condition', () => {
    expect(() => comboPositionId([yesA, noA])).toThrow('one outcome per market');
    expect(() => comboPositionId([yesA, yesA])).toThrow('one outcome per market');
    expect(() => comboPositionId([yesA, '17'])).toThrow('Invalid combo leg');
  });

  it('loads an active RFQ catalog page and keeps its opaque cursor', async () => {
    const result = await getComboMarkets('opaque+cursor=', async (url) => {
      expect(new URL(String(url)).searchParams.get('cursor')).toBe('opaque+cursor=');
      return Response.json({
        next_cursor: 'next',
        markets: [
          { id: '1', title: 'Market A', position_ids: [yesA, noA], outcomes: ['A', 'B'], outcome_prices: ['0.45', '0.55'] },
          { id: '2', title: 'Market B', position_ids: [yesA, yesB] },
          { id: '3', title: 'Pending', position_ids: [yesA, noA], pending: true },
        ],
      });
    });
    expect(result).toEqual({
      cursor: 'next',
      markets: [
        {
          id: '1',
          title: 'Market A',
          tags: [],
          outcomes: [
            { id: yesA, label: 'A', price: 0.45 },
            { id: noA, label: 'B', price: 0.55 },
          ],
        },
      ],
    });
  });
});

describe('combo signing terms', () => {
  it('accepts the exact combo position, price, side, and amounts', () => {
    expect(verify(buy)).toEqual(order());
    const cashOut = order({ side: 1, makerAmount: '20000000', takerAmount: '9500000' });
    expect(verify(sell, cashOut)).toEqual(cashOut);
  });

  it('rejects changed positions, exchanges, prices and stakes', () => {
    expect(() => verify(buy, order({ tokenId: yesA }))).toThrow('different combo');
    const wrongExchange = order();
    wrongExchange.domain.verifyingContract = wallet;
    expect(() => verify(buy, wrongExchange)).toThrow('unknown exchange');
    expect(() => verify(buy, order({ side: 1 }))).toThrow('side changed');
    expect(() => verify(buy, order({ takerAmount: '19999999' }))).toThrow('costs more');
    expect(() => verify(buy, order({ makerAmount: '10000001', takerAmount: '21000000' }))).toThrow('costs more');
    expect(() => verify(sell, order({ side: 1, makerAmount: '19999999', takerAmount: '9500000' }))).toThrow('does not meet');
    expect(() => verify(sell, order({ side: 1, makerAmount: '20000000', takerAmount: '8999999' }))).toThrow('does not meet');
  });

  it('checks displayed fees and total against the requested stake', () => {
    const quote: ComboResult = {
      side: 'buy',
      positionId,
      conditionId: market,
      price: '0.5',
      shares: '20',
      cost: '10',
      exchangeFee: '0.1',
      kairosFee: '0.05',
      totalCost: '10.05',
    };
    expect(verifyComboResult(quote, buy, BigInt(positionId))).toEqual(quote);
    expect(() => verifyComboResult({ ...quote, totalCost: '10.04' }, buy, BigInt(positionId))).toThrow('invalid combo cost');
  });
});
