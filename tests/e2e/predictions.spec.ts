import { test, expect, onboardWithMnemonic } from './fixtures';
import { generateMnemonic } from '../../src/core/keyring/derive';

/** Live against Kairos staging; opt-in with KAIROS_LIVE=1 pnpm test:e2e. */
test.skip(!process.env.KAIROS_LIVE, 'needs Kairos staging (KAIROS_LIVE=1)');

const SHOTS = process.env.SHOTS_DIR;

test('browses markets, opens one, and sets up trading', async ({ openWallet }) => {
  test.setTimeout(180_000);
  const page = await openWallet('/onboarding');
  // A fresh phrase so setup runs from scratch.
  await onboardWithMnemonic(page, generateMnemonic());
  await page.getByRole('button', { name: 'Predict' }).click();

  await expect(page.getByTestId('market-list').locator('.list-item').first()).toBeVisible({ timeout: 30_000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/predict.png` });

  await page.getByRole('button', { name: 'Crypto' }).click();
  await expect(page.getByTestId('market-list').locator('.list-item').first()).toBeVisible({ timeout: 30_000 });
  await page.getByPlaceholder('Search markets').fill('bitcoin');
  await expect(page.getByTestId('market-list').locator('.list-item').first()).toBeVisible({ timeout: 30_000 });

  // Open the first market (via its event if grouped).
  await page.getByTestId('market-list').locator('.list-item').first().click();
  if (page.url().includes('/predict/event')) {
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/predict-event.png` });
    await page.getByTestId('outcome-list').locator('.list-item').first().click();
  }
  await expect(page.getByTestId('market-title')).not.toBeEmpty({ timeout: 30_000 });
  await expect(page.getByText('Set up prediction trading first.')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/predict-market.png` });

  // Setup from the Predictions hub.
  await page.getByRole('button', { name: 'Go to Predictions' }).click();
  await expect(page.getByTestId('prediction-setup')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/predict-setup.png` });
  await page.getByRole('button', { name: 'Set up trading' }).click();
  await expect(page.getByTestId('prediction-balance')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText('Add pUSD to start trading.')).toBeVisible();
  await page.getByRole('button', { name: 'Add funds' }).click();
  await expect(page.getByRole('button', { name: 'From your wallet' })).toBeVisible();
  await page.waitForTimeout(800);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/predict-fund.png` });
  // Card onramp quotes come from Halliday.
  await page.getByRole('button', { name: 'Card or bank' }).click();
  await expect(page.getByTestId('deposit-card').locator('.list-item').first()).toBeVisible({ timeout: 30_000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/predict-fund-card.png` });
});

test('shows the live order book and estimates a market order from it', async ({ openWallet }) => {
  test.setTimeout(120_000);
  const page = await openWallet('/onboarding');
  await onboardWithMnemonic(page, generateMnemonic());
  // A liquid Polymarket market.
  await page.goto(page.url().replace(/#.*/, '#/predict/market?id=2589812'));
  await expect(page.getByTestId('market-title')).not.toBeEmpty({ timeout: 30_000 });

  // Short ranges chart 1-minute candles.
  await page.getByRole('tab', { name: '1H' }).click();
  await expect(page.getByRole('img', { name: 'Price history' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('tab', { name: '1W' }).click();

  // Market orders are the default; limit controls stay hidden until chosen.
  await expect(page.getByLabel('Limit price (¢)')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Order book' }).first()).toBeVisible();
  await expect(page.locator('.live-dot.live').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/market-live.png` });

  await page.getByTestId('open-orderbook').click();
  const book = page.getByTestId('orderbook');
  await expect(book.locator('.ob-row.ask').first()).toBeVisible();
  await expect(book.locator('.ob-row.bid').first()).toBeVisible();
  await page.waitForTimeout(600);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/orderbook.png` });
  await page.getByRole('button', { name: 'Close' }).click();

  await page.getByLabel('Order type').selectOption('limit');
  await expect(page.getByLabel('Limit price (¢)')).toBeVisible();
  await page.getByLabel('Order type').selectOption('market');
  await expect(page.getByLabel('Limit price (¢)')).toHaveCount(0);

  // A market sell is estimated by walking the live bids (no balance needed to see the estimate).
  await page.getByRole('tab', { name: 'Sell' }).click();
  await page.getByLabel('Shares').fill('100');
  await expect(page.getByText('You receive')).toBeVisible();
  await expect(page.getByText(/100 shares · avg \d+(\.\d)?¢/)).toBeVisible();
  // A huge order on the same book shows a slippage / liquidity warning.
  await page.getByLabel('Shares').fill('5000000');
  await expect(page.getByTestId('liquidity-notices')).toContainText(/Not enough liquidity|High slippage/);
  if (SHOTS) {
    await page.getByTestId('liquidity-notices').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/market-slippage.png` });
  }
  await page.getByLabel('Shares').fill('100');
  await page.getByTestId('review-order').or(page.locator('.notice')).first().scrollIntoViewIfNeeded();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/market-estimate.png` });
});
