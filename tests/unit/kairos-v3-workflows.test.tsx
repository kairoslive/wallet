import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { TradePlan } from '@kairos.trade/sdk';
import type { MarketDetail } from '../../src/core/predictions/types';
import { FundedOrder } from '../../src/ui/components/FundedOrder';
import { PositionIntentSheet, PositionTools } from '../../src/ui/components/PositionTools';

const { api, invalidateAfterTrade } = vi.hoisted(() => ({
  api: {
    predictionOnchain: vi.fn(),
    predictionOnchainStatus: vi.fn(),
    predictionPrepareFundedBuy: vi.fn(),
    predictionExecuteFundedBuy: vi.fn(),
    predictionFundedBuyStatus: vi.fn(),
  },
  invalidateAfterTrade: vi.fn(),
}));
vi.mock('../../src/ui/lib/api', () => ({ api }));
vi.mock('../../src/ui/lib/predictQueries', () => ({ invalidateAfterTrade }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const ACCOUNT = 'account-1';
const CONDITION = `0x${'11'.repeat(31)}00`;
const INTENT = '00000000-0000-4000-8000-000000000001';
const PLAN = '00000000-0000-4000-8000-000000000002';
const market: MarketDetail = {
  marketId: '17459',
  venue: 'polymarket',
  venueMarketId: '17459',
  conditionId: CONDITION,
  title: 'Warriors vs. Mavericks',
  status: 'open',
  tickSize: 0.01,
  negRisk: false,
  tokens: [
    { outcome: 'Warriors', tokenId: '101' },
    { outcome: 'Mavericks', tokenId: '102' },
  ],
};

const intent = (status: 'reconciling' | 'confirmed' | 'expired') => ({
  intent: { terms: { id: INTENT }, status, committed: status !== 'expired' },
});

function tradePlan(status: TradePlan['status'], overrides: { id?: string; funding?: null; error?: TradePlan['error'] } = {}) {
  return {
    id: PLAN,
    status,
    executeBefore: new Date(Date.now() + 90_000).toISOString(),
    order: { size: '10', outcome: 'Mavericks', price: '0.5' },
    tradeBudget: { decimals: 6, maxDebitRaw: '5200000', maxCollateralFeeRaw: '200000' },
    funding: { sourceChainId: '42161', amountInRaw: '5400000', sourceDecimals: 6 },
    execution: {
      committed: status !== 'needs_signatures',
      fundingStatus: status === 'funded_trade_failed' ? 'confirmed' : 'pending',
    },
    ...overrides,
  };
}

it.each([
  {
    operation: 'split',
    action: 'Split pUSD',
    field: 'Amount in pUSD',
    detail: /each pUSD gives you 1 share of Warriors and 1 share of Mavericks/i,
  },
  {
    operation: 'merge',
    action: 'Merge shares',
    field: 'Number of complete sets',
    detail: /each set of Warriors and Mavericks shares returns 1 pUSD/i,
  },
])(
  'reviews and submits $operation in exact base units, then reads a pending intent',
  async ({ operation, action, field, detail }) => {
    api.predictionOnchain.mockResolvedValue(intent('reconciling'));
    api.predictionOnchainStatus.mockResolvedValue(intent('confirmed'));
    render(<PositionTools accountId={ACCOUNT} market={market} />);
    fireEvent.click(screen.getByRole('button', { name: action }));
    const sheet = within(screen.getByRole('dialog', { name: action }));
    expect(sheet.getByText(detail)).toBeTruthy();
    expect(sheet.getByText('Gasless')).toBeTruthy();

    const submit = sheet.getByRole<HTMLButtonElement>('button', { name: action });
    expect(submit.disabled).toBe(true);
    fireEvent.change(sheet.getByLabelText(field), { target: { value: '1.0000001' } });
    expect(submit.disabled).toBe(true);
    expect(api.predictionOnchain).not.toHaveBeenCalled();

    fireEvent.change(sheet.getByLabelText(field), { target: { value: '1.234567' } });
    fireEvent.click(submit);
    fireEvent.click(await sheet.findByRole('button', { name: 'Check status' }));
    await sheet.findByText(/confirmed on Polygon/i);
    expect(api.predictionOnchain).toHaveBeenCalledExactlyOnceWith(ACCOUNT, {
      operation,
      market: CONDITION,
      amountRaw: '1234567',
      idempotencyKey: expect.any(String),
      executeBefore: expect.any(String),
    });
    expect(api.predictionOnchainStatus).toHaveBeenCalledExactlyOnceWith(ACCOUNT, INTENT);
    expect(invalidateAfterTrade).toHaveBeenCalledExactlyOnceWith(ACCOUNT);
  },
);

it('preserves the resolved position’s exact outcome and amount during redemption, and distinguishes expiry from confirmation', async () => {
  api.predictionOnchain.mockResolvedValue(intent('expired'));
  const close = vi.fn();
  render(
    <PositionIntentSheet
      accountId={ACCOUNT}
      title={market.title}
      draft={{ operation: 'redeem', market: CONDITION, amountRaw: '4000011', outcome: 1 }}
      onClose={close}
    />,
  );
  const sheet = within(screen.getByRole('dialog', { name: 'Redeem shares' }));
  expect(sheet.getByText(/4\.000011 shares/)).toBeTruthy();
  expect(sheet.queryByRole('textbox')).toBeNull();

  fireEvent.click(sheet.getByRole('button', { name: 'Redeem shares' }));
  expect(await sheet.findByText(/operation expired/i)).toBeTruthy();
  expect(api.predictionOnchain).toHaveBeenCalledExactlyOnceWith(ACCOUNT, {
    operation: 'redeem',
    market: CONDITION,
    amountRaw: '4000011',
    outcome: 1,
    idempotencyKey: expect.any(String),
    executeBefore: expect.any(String),
  });
  expect(invalidateAfterTrade).not.toHaveBeenCalled();
  fireEvent.click(sheet.getByRole('button', { name: 'Done' }));
  expect(close).toHaveBeenCalledOnce();
});

it('keeps the submitted position amount, deadline, and idempotency key together after a timeout', async () => {
  api.predictionOnchain.mockRejectedValueOnce(new Error('Request timed out')).mockResolvedValueOnce(intent('confirmed'));
  render(<PositionTools accountId={ACCOUNT} market={market} />);
  fireEvent.click(screen.getByRole('button', { name: 'Split pUSD' }));
  const sheet = within(screen.getByRole('dialog', { name: 'Split pUSD' }));
  const input = sheet.getByLabelText<HTMLInputElement>('Amount in pUSD');
  fireEvent.change(input, { target: { value: '2' } });
  fireEvent.click(sheet.getByRole('button', { name: 'Split pUSD' }));
  await sheet.findByText('Request timed out');
  expect(input.disabled).toBe(true);
  fireEvent.click(sheet.getByRole('button', { name: 'Split pUSD' }));
  await sheet.findByText(/confirmed on Polygon/i);
  const [first, retry] = api.predictionOnchain.mock.calls;
  expect(first[1].amountRaw).toBe('2000000');
  expect(retry).toEqual(first);
});

function openFundedOrder() {
  render(<FundedOrder accountId={ACCOUNT} market={market} />);
  fireEvent.click(screen.getByRole('button', { name: 'Buy with USDC' }));
  const sheet = within(screen.getByRole('dialog', { name: 'Buy with USDC' }));
  fireEvent.change(sheet.getByLabelText('Outcome'), { target: { value: '102' } });
  fireEvent.change(sheet.getByLabelText('Limit price ($)'), { target: { value: '0.50' } });
  fireEvent.change(sheet.getByLabelText('Shares'), { target: { value: '10.000' } });
  fireEvent.change(sheet.getByLabelText('Maximum USDC to bridge'), { target: { value: '6.000000' } });
  fireEvent.click(sheet.getByRole('button', { name: 'Review funded buy' }));
  return sheet;
}

it('shows the exact funded order, venue debit and fees before confirmation, and treats completion as an accepted order', async () => {
  api.predictionPrepareFundedBuy.mockResolvedValue(tradePlan('needs_signatures'));
  api.predictionExecuteFundedBuy.mockResolvedValue(tradePlan('funding_pending'));
  api.predictionFundedBuyStatus.mockResolvedValue(tradePlan('completed'));
  const sheet = openFundedOrder();

  const confirm = await sheet.findByRole('button', { name: 'Confirm funded buy' });
  expect(api.predictionPrepareFundedBuy).toHaveBeenCalledExactlyOnceWith(ACCOUNT, {
    marketId: market.marketId,
    tokenId: '102',
    price: '0.5',
    shares: '10',
    funding: { source: 'arbitrum', maxAmountRaw: '6000000' },
  });
  expect(sheet.getByText('10 Mavericks shares')).toBeTruthy();
  expect(sheet.getByText('$0.5 per share')).toBeTruthy();
  expect(sheet.getByText('Maximum debit').parentElement?.textContent).toContain('5.2 pUSD');
  expect(sheet.getByText('Maximum trade fees').parentElement?.textContent).toContain('0.2 pUSD');
  expect(sheet.getByText('USDC from Arbitrum').parentElement?.textContent).toContain('5.4');
  expect(api.predictionExecuteFundedBuy).not.toHaveBeenCalled();

  fireEvent.click(confirm);
  fireEvent.click(await sheet.findByRole('button', { name: 'Check status' }));
  await sheet.findByText(/order accepted by the venue/i);
  expect(api.predictionExecuteFundedBuy).toHaveBeenCalledExactlyOnceWith(ACCOUNT, PLAN);
  expect(api.predictionFundedBuyStatus).toHaveBeenCalledExactlyOnceWith(ACCOUNT, PLAN);
  expect(invalidateAfterTrade).toHaveBeenCalledExactlyOnceWith(ACCOUNT);
});

it('reads an existing funded plan after an uncertain submit and shows when the bridge succeeded but the order failed', async () => {
  api.predictionPrepareFundedBuy.mockResolvedValue(tradePlan('needs_signatures'));
  api.predictionExecuteFundedBuy.mockRejectedValue(new Error('Request timed out'));
  api.predictionFundedBuyStatus.mockResolvedValue(
    tradePlan('funded_trade_failed', {
      error: { code: 'VENUE_REJECTED', message: 'The venue declined this order.', nextAction: 'inspect_funds' },
    }),
  );
  const sheet = openFundedOrder();
  fireEvent.click(await sheet.findByRole('button', { name: 'Confirm funded buy' }));
  await sheet.findByText('Request timed out');
  expect(sheet.queryByRole('button', { name: 'Confirm funded buy' })).toBeNull();
  fireEvent.click(sheet.getByRole('button', { name: 'Check status' }));
  await sheet.findByText('The venue declined this order.');
  expect(sheet.getByText(/Bridged funds are available/i)).toBeTruthy();
  expect(api.predictionExecuteFundedBuy).toHaveBeenCalledOnce();
  expect(api.predictionFundedBuyStatus).toHaveBeenCalledExactlyOnceWith(ACCOUNT, PLAN);
  fireEvent.click(sheet.getByRole('button', { name: 'Done' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('allows a fresh funded review once the existing plan is confirmed to need signatures', async () => {
  api.predictionPrepareFundedBuy.mockResolvedValue(tradePlan('needs_signatures'));
  api.predictionExecuteFundedBuy.mockRejectedValue(new Error('Request timed out'));
  api.predictionFundedBuyStatus.mockResolvedValue(tradePlan('needs_signatures'));
  const sheet = openFundedOrder();
  fireEvent.click(await sheet.findByRole('button', { name: 'Confirm funded buy' }));
  await sheet.findByText('Request timed out');
  expect(sheet.queryByRole('button', { name: 'Review a fresh plan' })).toBeNull();
  fireEvent.click(sheet.getByRole('button', { name: 'Check status' }));
  fireEvent.click(await sheet.findByRole('button', { name: 'Review a fresh plan' }));
  expect(sheet.getByLabelText<HTMLInputElement>('Limit price ($)').value).toBe('0.50');
  expect(api.predictionPrepareFundedBuy).toHaveBeenCalledOnce();
  expect(api.predictionExecuteFundedBuy).toHaveBeenCalledOnce();
});
