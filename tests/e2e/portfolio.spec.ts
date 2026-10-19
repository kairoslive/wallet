import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, onboardWithMnemonic } from './fixtures';

/**
 * Positions and orders against a stand-in wallet API (status, SIWE login, orders, positions),
 * enriched from the live Kairos market data and discover APIs. Opt-in: KAIROS_LIVE=1.
 */
test.skip(!process.env.KAIROS_LIVE, 'enriches from live Kairos market data (KAIROS_LIVE=1)');

const SHOTS = process.env.SHOTS_DIR;
// The Fed "no change" market (Polymarket 2589812).
const COND = '0xdf9bf27ee5757c55b44b8b9826ddc9ec3a8809aa3278634c45edbb7fc8f1a3e3';
const YES = '111061902544814266207267295505639408607400625795891618462682726460921782993748';

let server: Server;
let base = '';
let auth: (string | undefined)[] = [];
/** Serve the multi-venue contract (Predict.fun alongside Polymarket), as a node with the v2 wallet API does. */
let multiVenue = false;
/** Predict.fun's status on that node. */
let pfStatus: Record<string, unknown> = {};
/** Hyperliquid's status on that node; listed only when set. */
let hlStatus: Record<string, unknown> | undefined;
// A Predict.fun market (LoL Worlds) and its first outcome token.
const PF_MARKET = '3394712';
const PF_TOKEN = '22792533058364109967843974336023525129117701581478587988463610813242968119951';

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url!, base);
    const json = (v: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(v));
    };
    const wallet = url.pathname.split('/')[3] ?? '';
    if (req.method === 'POST' && (url.pathname === '/rpc' || url.pathname === '/bsc-rpc')) {
      // Predict.fun shares have 18 decimals; Polymarket's 6.
      const unit = url.pathname === '/bsc-rpc' ? 10n ** 12n : 1n;
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const calls = [JSON.parse(body)].flat() as {
          id: number;
          method: string;
          params: { to?: string; data?: string; input?: string }[];
        }[];
        const answer = calls.map((c) => {
          if (c.method === 'eth_chainId') return { jsonrpc: '2.0', id: c.id, result: unit > 1n ? '0x38' : '0x89' };
          if (c.method === 'eth_call') {
            const w = (v: bigint | number) => BigInt(v).toString(16).padStart(64, '0');
            const input = c.params[0].data ?? c.params[0].input ?? '0x';
            // balanceOfBatch(address[], uint256[]): 7.04 shares (6 decimals) for every id. Anything else reads as zero.
            if (!input.startsWith('0x4e1273f4')) return { jsonrpc: '2.0', id: c.id, result: `0x${w(0)}` };
            // On BNB Chain the shares sit on one of Predict.fun's three share contracts: the plain one.
            const holds = unit === 1n || c.params[0].to?.toLowerCase() === '0x22da1810b194ca018378464a58f6ac2b10c9d244';
            const data = input.slice(10);
            const word = (i: number) => BigInt(`0x${data.slice(i * 64, i * 64 + 64)}`);
            const n = Number(word(Number(word(0)) / 32));
            return { jsonrpc: '2.0', id: c.id, result: `0x${w(32)}${w(n)}${w(holds ? 7_040_000n * unit : 0).repeat(n)}` };
          }
          if (c.method === 'eth_getBalance' || c.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: c.id, result: '0x0' };
          return { jsonrpc: '2.0', id: c.id, error: { code: -32601, message: 'unsupported' } };
        });
        json(Array.isArray(JSON.parse(body)) ? answer : answer[0]);
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v3/actions') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { wallet: w } = JSON.parse(body);
        const msg = [
          `${new URL(base).host} wants you to sign in with your Ethereum account:`,
          w,
          '',
          'Read your Kairos orders and positions.',
          '',
          `URI: ${base}`,
          'Version: 1',
          'Chain ID: 137',
          'Nonce: e2e12345',
          `Issued At: ${new Date().toISOString()}`,
        ].join('\n');
        json({
          id: 'l1',
          type: 'login',
          status: 'needs_signature',
          request: { method: 'personal_sign', params: [`0x${Buffer.from(msg).toString('hex')}`, w] },
          description: 'Sign in',
          result: null,
          error: null,
        });
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v3/actions/l1') {
      return json({
        id: 'l1',
        type: 'login',
        status: 'done',
        request: null,
        description: null,
        result: { token: 'e2e-token', expiresAt: new Date(Date.now() + 864e5).toISOString() },
        error: null,
      });
    }
    // Past positions (public trader stats). Everything else on the data API passes through to live.
    if (url.pathname.startsWith('/trader-stats/positions/')) {
      return json({
        performance: { total_realized_pnl: '-1.25' },
        open_positions: [],
        closed_positions: [
          {
            market_id: '601826',
            market_name: 'Will Flávio Bolsonaro win the 2026 Brazilian presidential election?',
            icon: null,
            token_id: '109876868437950584369987384406356259939519193117253465815665152916226511121427',
            outcome: 'Yes',
            size: '0',
            entry_price: '0.793',
            realized_pnl: '-1.25',
            status: 'CLOSED',
            closed_at: new Date(Date.now() - 3 * 86400e3).toISOString(),
          },
        ],
        has_more: false,
      });
    }
    if (url.pathname.startsWith('/api/')) {
      void fetch(`https://data.kairos.trade${req.url}`)
        .then(async (r) => {
          res.writeHead(r.status, { 'content-type': 'application/json' });
          res.end(await r.text());
        })
        .catch(() => json({ error: 'upstream' }, 502));
      return;
    }
    if (url.pathname.endsWith('/positions')) {
      auth.push(req.headers.authorization);
      const predictfun = multiVenue
        ? [
            {
              venue: 'predictfun',
              market: `predictfun:${PF_MARKET}`,
              marketId: PF_MARKET,
              outcome: null,
              tokenId: PF_TOKEN,
              size: '7.04',
              avgPrice: '0.2',
            },
          ]
        : [];
      return json({
        positions: {
          positions: [
            ...predictfun,
            {
              token_id: YES,
              market_id: COND,
              outcome: 'Yes',
              net_size: '7.04',
              avg_entry_price_bps: 7100,
              realized_pnl: '0',
              last_trade_at: new Date().toISOString(),
            },
          ],
          resolved: [],
          closed: [],
          as_of: new Date().toISOString(),
        },
      });
    }
    if (url.pathname.endsWith('/orders')) {
      auth.push(req.headers.authorization);
      const all = [
        {
          id: 'o-live',
          market_id: COND,
          token_id: YES,
          side: 'buy',
          kind: 'limit',
          quantity: '20.00000000',
          price: '0.65',
          filled_quantity: '6',
          avg_fill_price: '0.65',
          status: 'partial',
          outcome: 'Yes',
          created_at: new Date(Date.now() - 2 * 3600e3).toISOString(),
        },
        {
          id: 'd84fcbd4',
          market_id: COND,
          token_id: YES,
          side: 'buy',
          kind: 'market',
          quantity: '7.04000000',
          price: '0.71',
          filled_quantity: '7.04',
          avg_fill_price: '0.71',
          status: 'filled',
          outcome: 'Yes',
          created_at: new Date(Date.now() - 5 * 3600e3).toISOString(),
        },
        {
          id: 'f8759891',
          market_id: COND,
          token_id: YES,
          side: 'buy',
          kind: 'limit',
          quantity: '5.05000000',
          price: '0.99',
          filled_quantity: '0',
          status: 'cancelled',
          outcome: 'Over',
          created_at: new Date(Date.now() - 86400e3).toISOString(),
        },
      ];
      return json({ orders: url.searchParams.get('open') === 'true' ? all.filter((o) => o.status === 'partial') : all });
    }
    if (url.pathname === `/v3/wallets/${wallet}` && multiVenue) {
      return json({
        wallet,
        ready: false,
        next: 'setup',
        venues: {
          polymarket: {
            ready: true,
            next: null,
            tradingWallet: '0x26ca00000000000000000000000000000000e90b',
            balance: '34.919999',
            currency: 'pUSD',
          },
          predictfun: { ready: false, next: 'setup', balance: '12.5', currency: 'USDT', ...pfStatus },
          ...(hlStatus ? { hyperliquid: { tradingWallet: wallet, currency: 'USDC', ...hlStatus } } : {}),
        },
      });
    }
    if (url.pathname === `/v3/wallets/${wallet}`) {
      return json({
        wallet,
        tradingWallet: '0x26ca00000000000000000000000000000000e90b',
        ready: true,
        balance: '34.919999',
        next: null,
      });
    }
    json({ error: 'not found' }, 404);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => server.close());

test('shows positions and orders with market details, value and P&L', async ({ openWallet }) => {
  test.setTimeout(90_000);
  auth = [];
  const page = await openWallet('/onboarding');
  await onboardWithMnemonic(page);
  await page.evaluate(async (url) => {
    const state = (await chrome.runtime.sendMessage({ kind: 'wallet', method: 'getState', args: [] })) as {
      result: { settings: { apis: Record<string, unknown>; networks: { id: string; rpcUrl: string }[] } };
    };
    // Outcome-token balances come from this stand-in Polygon RPC.
    const polygon = state.result.settings.networks.find((n) => n.id === 'polygon')!;
    await chrome.runtime.sendMessage({ kind: 'wallet', method: 'upsertNetwork', args: [{ ...polygon, rpcUrl: `${url}/rpc` }] });
    await chrome.runtime.sendMessage({
      kind: 'wallet',
      method: 'updateSettings',
      args: [{ apis: { ...state.result.settings.apis, kairosExecutionUrl: url, kairosDataUrl: url } }],
    });
  }, base);
  await page.goto(page.url().replace(/#.*/, '#/predict?tab=positions'));

  const summary = page.getByTestId('positions-summary');
  await expect(summary).toContainText('Positions value', { timeout: 30_000 });
  await expect(page.getByTestId('prediction-balance')).toContainText('$34.92');

  // Withdraw: amount with quick picks, destination and timing up front.
  await page.getByTestId('withdraw-open').click();
  const sheet = page.getByTestId('withdraw-sheet');
  await sheet.getByRole('button', { name: 'Max' }).click();
  await expect(sheet.getByLabel('Amount')).toHaveValue('34.91');
  await expect(sheet.getByTestId('withdraw-start')).toHaveText('Withdraw $34.91');
  await expect(sheet).toContainText('About 1 hour');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/withdraw.png` });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const list = page.getByTestId('position-list');
  await expect(list).toContainText('Fed Decision in October?');
  await expect(list).toContainText('No change');
  await expect(list).toContainText('7.04 shares');
  await expect(list.locator('img.market-thumb')).toBeVisible();
  expect(auth.every((a) => a === 'SIWE e2e-token')).toBe(true);

  // Closed positions keep their realized P&L.
  const closed = page.getByTestId('closed-list');
  await expect(closed).toContainText('Flávio Bolsonaro');
  await expect(closed).toContainText('−$1.25');
  await expect(closed).toContainText('Avg 79¢');
  await expect(page.getByTestId('realized-total')).toContainText('−$1.25');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/closed-positions.png`, fullPage: true });
  await page.waitForTimeout(500);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/positions.png` });

  await page.getByRole('tab', { name: 'Orders' }).click();
  const orders = page.getByTestId('order-list');
  await expect(orders).toContainText('Partly filled', { timeout: 30_000 });
  await expect(orders).toContainText('6 of 20 filled');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/orders-open.png` });
  await page.getByRole('button', { name: 'History' }).click();
  await expect(orders).toContainText('Cancelled', { timeout: 30_000 });
  await expect(orders).toContainText('Filled');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/orders-all.png` });

  // Sell from a position opens the market with the sell side and held shares ready.
  await page.getByRole('tab', { name: 'Positions' }).click();
  await page.getByTestId('sell-position').click();
  await expect(page.getByRole('tab', { name: 'Sell', selected: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('You hold 7.04 Yes')).toBeVisible();
  await page.getByRole('button', { name: 'Max' }).click();
  await expect(page.getByLabel('Shares')).toHaveValue('7.04');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sell-from-position.png` });

  // The market page shows what's held up top, and its Sell fills in the whole position.
  await page.getByRole('tab', { name: 'Buy' }).click();
  const held = page.getByTestId('your-position');
  await expect(held).toContainText('7.04 shares');
  await expect(held).toContainText('Avg');
  if (SHOTS) await held.screenshot({ path: `${SHOTS}/your-position.png` });
  await held.getByTestId('sell-held').first().click();
  await expect(page.getByRole('tab', { name: 'Sell', selected: true })).toBeVisible();
  await expect(page.getByLabel('Shares')).toHaveValue('7.04');
});

test('trades Predict.fun from the same wallet on a multi-venue node', async ({ openWallet }) => {
  test.setTimeout(90_000);
  multiVenue = true;
  try {
    const page = await openWallet('/onboarding');
    await onboardWithMnemonic(page);
    await page.evaluate(async (url) => {
      const state = (await chrome.runtime.sendMessage({ kind: 'wallet', method: 'getState', args: [] })) as {
        result: { settings: { apis: Record<string, unknown>; networks: { id: string; rpcUrl: string }[] } };
      };
      const net = (id: string) => state.result.settings.networks.find((n) => n.id === id)!;
      await chrome.runtime.sendMessage({
        kind: 'wallet',
        method: 'upsertNetwork',
        args: [{ ...net('polygon'), rpcUrl: `${url}/rpc` }],
      });
      await chrome.runtime.sendMessage({
        kind: 'wallet',
        method: 'upsertNetwork',
        args: [{ ...net('bsc'), rpcUrl: `${url}/bsc-rpc` }],
      });
      await chrome.runtime.sendMessage({
        kind: 'wallet',
        method: 'updateSettings',
        args: [{ apis: { ...state.result.settings.apis, kairosExecutionUrl: url, kairosDataUrl: url } }],
      });
    }, base);
    await page.goto(page.url().replace(/#.*/, '#/predict?tab=positions'));

    // Polymarket stays the main balance; Predict.fun trades from the wallet's own USDT on BNB Chain.
    await expect(page.getByTestId('prediction-balance')).toContainText('$34.92', { timeout: 30_000 });
    // Every venue is the same row under one total.
    await expect(page.getByTestId('prediction-balance')).toContainText('$47.42');
    // One line each: name and balance; the details live in the venue's sheet.
    await expect(page.getByTestId('venue-balance-polymarket')).toContainText('$34.92');
    const pf = page.getByTestId('venue-balance-predictfun');
    await expect(pf).toContainText('$12.50');
    await expect(pf).toHaveAttribute('title', 'Sets up with your first order');
    await expect(pf.getByTestId('venue-shortfall')).toHaveCount(0);
    await pf.click();
    await expect(page.getByTestId('venue-sheet-predictfun')).toContainText('USDT on BNB Chain, in this wallet');
    await page.waitForTimeout(500);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/venue-sheet.png` });
    await page.keyboard.press('Escape');

    // Its position reads its shares on BNB Chain (18 decimals) and carries the venue.
    const list = page.getByTestId('position-list');
    const card = list.locator('.position-card', { has: page.locator('.venue-tag.predictfun') });
    await expect(card).toContainText('7.04 shares', { timeout: 30_000 });
    await expect(card).toContainText('Avg 20¢');
    await expect(list).toContainText('Fed Decision in October?');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/multi-venue-positions.png` });

    // Its market page: the order runs Predict.fun's one-time setup, and the review says so.
    await card.getByTestId('sell-position').click();
    await expect(page.getByTestId('market-title')).not.toBeEmpty({ timeout: 30_000 });
    expect(decodeURIComponent(page.url())).toContain(`id=predictfun:${PF_MARKET}`);
    const held = page.getByTestId('your-position');
    await expect(held).toContainText('7.04 shares');
    await page.getByRole('tab', { name: 'Buy' }).click();
    await page.getByLabel('Order type').selectOption('limit');
    await page.getByLabel('Limit price (¢)').fill('5');
    await page.locator('#trade-amount').fill('1');
    await page.getByTestId('review-order').click();
    await expect(page.getByTestId('first-order-setup')).toContainText('approves its contracts on BNB Chain');
    await expect(page.getByText(/USDT$/).first()).toBeVisible();
    await page.waitForTimeout(500);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/predictfun-confirm.png` });

    // USDT but no BNB: Kairos reports "fund" for the approvals' gas. Ask for BNB, not USDT.
    pfStatus = { next: 'fund', venueDetail: { chainId: '0x38', gasBalance: '0', missingApprovals: 12 } };
    await page.reload();
    await expect(page.getByText('You have $12.50 USDT. Add a few cents of BNB on BNB Chain')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Add funds' }).click();
    await expect(page.getByTestId('venue-sheet-predictfun').getByRole('button', { name: 'Get BNB' })).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/predictfun-needs-bnb.png`, fullPage: true });
    await page.goto(page.url().replace(/#.*/, '#/predict?tab=positions'));
    await expect(page.getByTestId('venue-shortfall')).toHaveText('Add BNB');
    await expect(page.getByTestId('venue-balance-predictfun')).toContainText('$12.50');
    await page.getByTestId('venue-balance-predictfun').click();
    await expect(page.getByTestId('venue-sheet-predictfun')).toContainText('Add a few cents of BNB');
  } finally {
    multiVenue = false;
    pfStatus = {};
  }
});

test('trades Hyperliquid outcome markets from the wallet’s own Hyperliquid account', async ({ openWallet }) => {
  test.setTimeout(120_000);
  multiVenue = true;
  // Never funded: Hyperliquid refuses every action, so Kairos asks for a deposit first.
  hlStatus = {
    ready: false,
    next: 'fund',
    balance: '0',
    venueDetail: { chainId: '0xa4b1', network: 'Mainnet', reason: 'deposit USDC to Hyperliquid first' },
  };
  try {
    const page = await openWallet('/onboarding');
    await onboardWithMnemonic(page);
    await page.evaluate(async (url) => {
      const state = (await chrome.runtime.sendMessage({ kind: 'wallet', method: 'getState', args: [] })) as {
        result: { settings: { apis: Record<string, unknown> } };
      };
      await chrome.runtime.sendMessage({
        kind: 'wallet',
        method: 'updateSettings',
        args: [{ apis: { ...state.result.settings.apis, kairosExecutionUrl: url, kairosDataUrl: url } }],
      });
    }, base);
    await page.goto(page.url().replace(/#.*/, '#/predict?tab=positions'));

    const hl = page.getByTestId('venue-balance-hyperliquid');
    await expect(hl.getByTestId('venue-shortfall')).toHaveText('Add funds', { timeout: 30_000 });
    await expect(hl).not.toContainText('$0.00');

    // The deposit goes through Hyperliquid's bridge on Arbitrum, never under its minimum.
    await hl.click();
    const hlSheet = page.getByTestId('venue-sheet-hyperliquid');
    await expect(hlSheet).toContainText('USDC on your Hyperliquid account');
    await expect(hlSheet).toContainText('Deposit USDC to your Hyperliquid account (at least 5 USDC)');
    await expect(hlSheet).toContainText('never withdraw');
    await page.waitForTimeout(500);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/hyperliquid-sheet.png` });
    await hlSheet.getByRole('button', { name: 'Add funds' }).click();
    const sheet = page.getByTestId('hl-deposit-sheet');
    await expect(sheet).toContainText('Available $0.00', { timeout: 30_000 });
    await expect(sheet).toContainText('You need at least 5 USDC on Arbitrum');
    await expect(sheet.getByRole('button', { name: 'Get USDC on Arbitrum' })).toBeVisible();
    await page.locator('#hl-deposit-amount').fill('3');
    await expect(sheet).toContainText('Deposit at least 5 USDC. Hyperliquid loses smaller deposits.');
    await expect(page.getByTestId('hl-deposit-confirm')).toBeDisabled();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/hyperliquid-deposit.png` });
    await page.keyboard.press('Escape');

    // Its markets, live from Kairos.
    await page.goto(page.url().replace(/#.*/, '#/predict?tab=markets&venue=hyperliquid'));
    await expect(page.getByRole('radio', { name: 'Hyperliquid' })).toHaveAttribute('aria-checked', 'true');
    const first = page.getByTestId('market-list').locator('.list-item').first();
    await expect(first).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1000);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/hyperliquid-markets.png` });
    await first.click();
    if (page.url().includes('/predict/event')) await page.getByTestId('outcome-list').locator('.list-item').first().click();
    await expect(page.getByTestId('market-title')).not.toBeEmpty({ timeout: 30_000 });
    expect(decodeURIComponent(page.url())).toMatch(/id=hyperliquid:/);
    await expect(page.locator('.venue-tag.hyperliquid').first()).toBeVisible();
    await expect(page.getByText('Deposit USDC to your Hyperliquid account (at least 5 USDC).')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add funds' })).toBeVisible();
    const marketUrl = page.url();

    // Funded but not set up: the first order approves Kairos' trade-only agent, and the review says so.
    hlStatus = { ready: false, next: 'setup', balance: '25', venueDetail: { chainId: '0xa4b1', network: 'Mainnet' } };
    await page.goto(marketUrl);
    await page.reload();
    await page.getByLabel('Order type').selectOption('limit');
    await expect(page.getByLabel('Time in force').locator('option')).toHaveText(['Cancelled', 'Fill now, cancel the rest']);
    await page.getByLabel('Limit price (¢)').fill('5');
    await page.locator('#trade-amount').fill('1.99');
    // Whole shares only: $1.99 at 5¢ buys 39, not 39.8.
    await expect(page.getByText('39 shares at 5¢')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('review-order').click();
    await expect(page.getByTestId('first-order-setup')).toContainText("can't withdraw or transfer");
    await expect(page.getByText(/USDC$/).first()).toBeVisible();
    await page.waitForTimeout(500);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/hyperliquid-confirm.png` });

    // An account Kairos can't use there says why, instead of offering to trade.
    hlStatus = {
      ready: false,
      next: 'blocked',
      balance: '25',
      venueDetail: { reason: 'portfolio margin accounts are not supported (Hyperliquid account mode: portfolioMargin)' },
    };
    await page.goto(marketUrl);
    await page.reload();
    await expect(page.getByText("This account can't trade here: portfolio margin accounts are not supported")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId('review-order')).toHaveCount(0);
  } finally {
    multiVenue = false;
    hlStatus = undefined;
  }
});
