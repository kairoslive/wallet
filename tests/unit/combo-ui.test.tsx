import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { PredictCombos } from '../../src/ui/pages/PredictCombos';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  environment: 'https://staging-execution.kairos.trade',
  markets: vi.fn(),
  quote: vi.fn(),
  trade: vi.fn(),
}));

vi.mock('../../src/ui/lib/store', () => ({
  useWallet: () => ({
    account: { id: 'a', evmAddress: '0x01' },
    state: { settings: { apis: { kairosEnabled: true, kairosExecutionUrl: mocks.environment } } },
  }),
}));
vi.mock('../../src/ui/lib/router', () => ({
  back: vi.fn(),
  navigate: mocks.navigate,
  useRoute: () => ({ path: '/predict/combos', query: new URLSearchParams() }),
}));
vi.mock('../../src/ui/lib/predictQueries', () => ({
  useTradingStatus: () => ({ data: { balance: '20', ready: true }, reload: vi.fn() }),
  invalidateAfterTrade: vi.fn(),
}));
vi.mock('../../src/ui/lib/api', () => ({
  api: { predictionComboMarkets: mocks.markets, predictionComboQuote: mocks.quote, predictionComboTrade: mocks.trade },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('shows the environment requirement before loading any markets', async () => {
  mocks.environment = 'https://execution.kairos.trade';
  render(<PredictCombos />);
  expect(screen.getByText('Combos are in preview')).toBeTruthy();
  expect(mocks.markets).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Open provider settings' }));
  expect(mocks.navigate).toHaveBeenCalledWith('/settings/apis');
});

it('reviews a maker quote before authorizing the exact combo price and stake', async () => {
  mocks.environment = 'https://staging-execution.kairos.trade';
  mocks.markets.mockResolvedValue({
    markets: [
      {
        id: 'a',
        title: 'Market A',
        tags: [],
        outcomes: [
          { id: '1', label: 'Yes' },
          { id: '2', label: 'No' },
        ],
      },
      {
        id: 'b',
        title: 'Market B',
        tags: [],
        outcomes: [
          { id: '3', label: 'Yes' },
          { id: '4', label: 'No' },
        ],
      },
    ],
  });
  const quote = { side: 'buy', price: '0.4', shares: '5', cost: '2', exchangeFee: '0.02', kairosFee: '0.01', totalCost: '2.01' };
  mocks.quote.mockResolvedValue(quote);
  mocks.trade.mockResolvedValue({ ...quote, status: 'CONFIRMED' });
  const user = userEvent.setup();
  render(<PredictCombos />);
  const yes = await screen.findByRole('button', { name: 'Yes · Market A' });
  const no = screen.getByRole('button', { name: 'No · Market A' });
  await user.click(yes);
  await user.click(no);
  expect(no.getAttribute('aria-pressed')).toBe('true');
  expect(yes.getAttribute('aria-pressed')).toBe('false');
  await user.click(screen.getByRole('button', { name: 'Yes · Market B' }));
  await user.type(screen.getByRole('textbox', { name: 'Stake (pUSD)' }), '2');
  await user.click(screen.getByRole('button', { name: 'Get combo quote' }));
  const review = await screen.findByRole('dialog', { name: 'Review combo buy' });
  expect(await within(review).findByText('2.01 pUSD')).toBeTruthy();
  expect(mocks.quote).toHaveBeenCalledWith('a', { legs: ['2', '3'], side: 'buy', amount: '2' });
  expect(mocks.trade).not.toHaveBeenCalled();
  await user.click(within(review).getByRole('button', { name: 'Buy combo' }));
  expect(mocks.trade).toHaveBeenCalledWith('a', { legs: ['2', '3'], side: 'buy', amount: '2', maxPrice: '0.4' });
  expect(await screen.findByRole('dialog', { name: 'Combo bought' })).toBeTruthy();
});
