import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { test, expect, onboardWithMnemonic } from '../fixtures';
import { startAnvil } from '../../helpers/anvil';

/**
 * Captures the screens used in the README (docs/screenshots) against a local anvil chain.
 * Run with `pnpm screenshots`.
 */
const DIR = process.env.SHOTS_DIR ?? 'docs/screenshots';

test('readme screenshots', async ({ context, extensionId }) => {
  test.setTimeout(180_000);
  const anvil = await startAnvil({ chainId: 1 });
  // A realistic demo balance rather than anvil's default 10,000 ETH.
  await anvil.rpc('anvil_setBalance', ['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', '0x2f7647e14bd60000']);

  const page = await context.newPage();
  await page.setViewportSize({ width: 360, height: 600 });
  const open = (hash: string) => page.goto(`chrome-extension://${extensionId}/popup.html#${hash}`);
  const shot = async (name: string) => {
    // Toasts from the previous step would otherwise show up in the capture.
    await expect(page.locator('.toast')).toHaveCount(0, { timeout: 10_000 });
    await page.screenshot({ path: `${DIR}/${name}.png` });
  };

  await open('/onboarding');
  await page.waitForTimeout(300);
  await shot('onboarding');
  await onboardWithMnemonic(page);

  // Ethereum on anvil, plus Solana mainnet; everything else off.
  await open('/settings/networks');
  await expect(page.getByRole('switch', { name: 'Enable Ethereum' })).toBeVisible();
  const names = await page.getByRole('switch').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')!));
  for (const name of names) {
    const sw = page.getByRole('switch', { name, exact: true });
    const want = name === 'Enable Ethereum' || name === 'Enable Solana';
    if (((await sw.getAttribute('aria-checked')) === 'true') !== want) {
      await sw.click();
      await expect(sw).toHaveAttribute('aria-checked', String(want));
    }
  }
  await page.getByText('Ethereum', { exact: true }).click();
  await page.getByLabel('RPC URL').fill(anvil.rpcUrl);
  await page.getByRole('radiogroup', { name: 'Transaction history' }).getByText('None').click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Network saved')).toBeVisible();
  await shot('networks');

  // Send once so Activity has something to show.
  await open('/send?network=eth');
  await page.getByLabel('To').fill('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  await page.getByLabel('Amount amount').fill('0.25');
  await page.getByTestId('review-send').click();
  await expect(page.getByText('Network fee')).toBeVisible();
  await page.waitForTimeout(500);
  await shot('send-review');
  await page.getByTestId('confirm-send').click();
  await expect(page.getByTestId('tx-result')).toHaveAttribute('data-status', 'confirmed', { timeout: 30_000 });

  await open('/');
  await expect(page.getByTestId('token-list')).toContainText('ETH');
  await page.waitForTimeout(4000);
  await shot('home');
  await open('/?tab=activity');
  await expect(page.getByText('Loading full history…')).toHaveCount(0, { timeout: 60_000 });
  await shot('activity');
  await open('/receive');
  await page.waitForTimeout(500);
  await shot('receive');
  await open('/swap?mode=bridge&network=eth');
  await page.waitForTimeout(1500);
  await shot('bridge');

  // dApp connection request.
  const server = createServer((_q, r) => {
    r.setHeader('content-type', 'text/html');
    r.end('<!doctype html><title>Demo dApp</title>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const dapp = await context.newPage();
  await dapp.goto(`http://localhost:${(server.address() as AddressInfo).port}/`);
  const approvalPromise = context.waitForEvent('page', (p) => p.url().includes('#/approve'));
  // Never resolves (the request stays pending); it rejects when the browser closes.
  void dapp
    .evaluate(() =>
      (window as unknown as { ethereum: { request: (a: object) => Promise<unknown> } }).ethereum.request({
        method: 'eth_requestAccounts',
      }),
    )
    .catch(() => {});
  const approval: Page = await approvalPromise;
  await approval.setViewportSize({ width: 360, height: 600 });
  await expect(approval.getByText('Connect to this site')).toBeVisible();
  await approval.waitForTimeout(900);
  await approval.screenshot({ path: `${DIR}/connect.png` });

  server.close();
  await anvil.stop();
});
