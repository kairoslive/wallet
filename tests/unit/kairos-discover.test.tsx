import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CatalogQuery } from '../../src/core/predictions/discover';
import { RouterProvider, useRoute } from '../../src/ui/lib/router';
import { PredictDiscover, PredictDiscoverEvent, PredictDiscoverMarket } from '../../src/ui/pages/PredictDiscover';
import { PredictMarket } from '../../src/ui/pages/PredictMarket';
import { catalogEvent, catalogPage, matchedMarket } from '../helpers/kairos-catalog';

const { api } = vi.hoisted(() => ({
  api: {
    predictionCatalog: vi.fn(),
    predictionCatalogEvent: vi.fn(),
    predictionMatchedMarket: vi.fn(),
    predictionMarket: vi.fn(),
    predictionStatus: vi.fn(),
    predictionPriceHistory: vi.fn(),
    predictionLink: vi.fn(async () => null),
    predictionHoldings: vi.fn(async () => ({})),
    predictionPositions: vi.fn(async () => ({ positions: [], history: [], totals: { value: 0, cost: 0, pnl: 0 } })),
    predictionResolution: vi.fn(async () => ({ resolution: { status: 'initialized' }, events: [] })),
    predictionRules: vi.fn(async () => null),
  },
}));

vi.mock('../../src/ui/lib/api', () => ({ api }));
vi.mock('../../src/ui/lib/store', () => ({
  useWallet: () => ({
    state: {
      settings: { apis: { kairosEnabled: true, kairosMarketDataUrl: 'https://test-md.kairos.trade', kairosStreamUrl: '' } },
    },
    account: { id: 'catalog-test-account', evmAddress: '0x123' },
  }),
}));

afterEach(cleanup);

function Routes() {
  switch (useRoute().path) {
    case '/predict/discover/event':
      return <PredictDiscoverEvent />;
    case '/predict/discover/market':
      return <PredictDiscoverMarket />;
    case '/predict/market':
      return <PredictMarket />;
    default:
      return <PredictDiscover />;
  }
}

it('filters and pages matched events, then opens the selected canonical side in the wallet trade panel', async () => {
  api.predictionCatalog.mockImplementation(async ({ cursor }: CatalogQuery) =>
    cursor
      ? {
          ...catalogPage,
          next_cursor: null,
          has_more: false,
          events: [catalogEvent, { ...catalogEvent, id: 'another-event', title: 'Celtics vs. Nuggets' }],
        }
      : catalogPage,
  );
  api.predictionCatalogEvent.mockResolvedValue({ event: catalogEvent });
  api.predictionMatchedMarket.mockResolvedValue({ market: matchedMarket, event: catalogEvent });
  api.predictionMarket.mockResolvedValue({
    marketId: 'hyperliquid:35891',
    venue: 'hyperliquid',
    venueMarketId: '35891',
    conditionId: '35891',
    title: 'Warriors vs. Mavericks',
    status: 'open',
    tickSize: 0.0001,
    negRisk: false,
    tokens: [
      { outcome: 'DAL', tokenId: '#358910', price: 0.41 },
      { outcome: 'GSW', tokenId: '#358911', price: 0.59 },
    ],
  });
  api.predictionPriceHistory.mockResolvedValue([]);
  api.predictionStatus.mockResolvedValue({
    wallet: '0x123',
    tradingWallet: '0x456',
    ready: false,
    next: 'setup',
    balance: '0',
    venues: { hyperliquid: { ready: true, next: null, balance: '99' } },
  });
  window.history.replaceState(null, '', '#/predict/discover');
  render(
    <RouterProvider>
      <Routes />
    </RouterProvider>,
  );

  await screen.findByRole('button', { name: /Warriors vs\. Mavericks/ });
  fireEvent.change(screen.getByRole('textbox', { name: 'Search matched events' }), { target: { value: 'Warriors' } });
  await waitFor(() =>
    expect(api.predictionCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'Warriors', includeMarkets: false })),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Live' }));
  await waitFor(() => expect(api.predictionCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ statuses: ['live'] })));
  fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
  fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Sports' } });
  fireEvent.click(await screen.findByRole('switch', { name: 'Ready to trade with this wallet' }));
  expect(screen.queryByRole('button', { name: 'Kalshi' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show events' }));
  await waitFor(() =>
    expect(api.predictionCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ category: 'Sports', venues: [], executableVenues: ['hyperliquid'] }),
    ),
  );

  fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
  await screen.findByRole('button', { name: /Celtics vs\. Nuggets/ });
  expect(screen.getAllByTestId('catalog-event-row')).toHaveLength(2);
  expect(api.predictionCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'next_page', q: 'Warriors' }));

  fireEvent.click(screen.getByRole('button', { name: /Warriors vs\. Mavericks/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Match winner/ }));
  expect((await screen.findByTestId('catalog-listings')).textContent).toMatch(/\d+ venues? · \d+ trading/);
  fireEvent.click(screen.getByRole('button', { name: 'Warriors' }));
  expect(await screen.findByRole('button', { name: /GSW/, pressed: true })).toBeTruthy();
  expect(screen.getByRole('button', { name: /DAL/, pressed: false })).toBeTruthy();
  await waitFor(() =>
    expect(api.predictionPriceHistory).toHaveBeenCalledWith('hyperliquid:35891', expect.objectContaining({ outcomeIndex: 1 })),
  );
});
