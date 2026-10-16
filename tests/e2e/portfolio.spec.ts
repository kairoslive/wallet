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

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url!, base);
    const json = (v: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(v));
    };
    const wallet = url.pathname.split('/')[3] ?? '';
    if (req.method === 'POST' && url.pathname === '/rpc') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const calls = [JSON.parse(body)].flat() as { id: number; method: string; params: { data?: string; input?: string }[] }[];
        const answer = calls.map((c) => {
          if (c.method === 'eth_chainId') return { jsonrpc: '2.0', id: c.id, result: '0x89' };
          if (c.method === 'eth_call') {
            const w = (v: bigint | number) => BigInt(v).toString(16).padStart(64, '0');
            const input = c.params[0].data ?? c.params[0].input ?? '0x';
            // balanceOfBatch(address[], uint256[]): 7.04 shares (6 decimals) for every id. Anything else reads as zero.
            if (!input.startsWith('0x4e1273f4')) return { jsonrpc: '2.0', id: c.id, result: `0x${w(0)}` };
            const data = input.slice(10);
            const word = (i: number) => BigInt(`0x${data.slice(i * 64, i * 64 + 64)}`);
            const n = Number(word(Number(word(0)) / 32));
            return { jsonrpc: '2.0', id: c.id, result: `0x${w(32)}${w(n)}${w(7_040_000).repeat(n)}` };
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
    if (url.pathname.endsWith('/positions')) {
      auth.push(req.headers.authorization);
      return json({
        positions: {
          positions: [
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
      args: [{ apis: { ...state.result.settings.apis, kairosExecutionUrl: url } }],
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
  await page.getByRole('button', { name: 'Close' }).click();
  const list = page.getByTestId('position-list');
  await expect(list).toContainText('Fed Decision in October?');
  await expect(list).toContainText('No change');
  await expect(list).toContainText('7.04 shares');
  await expect(list.locator('img.market-thumb')).toBeVisible();
  expect(auth.every((a) => a === 'SIWE e2e-token')).toBe(true);
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
