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

  // Every venue in one list by default.
  await expect(page.getByRole('radio', { name: 'All', checked: true })).toBeVisible();
  await expect(page.getByTestId('market-list').locator('.list-item').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/predict.png` });
  await page.getByRole('radio', { name: 'Polymarket' }).click();

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

  // Setup right from the market, in the venue's sheet.
  await page.getByRole('button', { name: 'Set up', exact: true }).click();
  const venueSheet = page.getByTestId('venue-sheet-polymarket');
  await expect(venueSheet).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/predict-setup.png` });
  await venueSheet.getByRole('button', { name: 'Set up trading' }).click();
  await expect(venueSheet).toContainText('Add pUSD to start trading.', { timeout: 120_000 });
  await venueSheet.getByRole('button', { name: 'Add funds' }).click();
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
  // Tapping an ask sets up a limit buy at that price.
  const ask = book.locator('button.ob-row.ask').last();
  const askPrice = (await ask.locator('.ob-price').innerText()).replace('¢', '');
  await ask.click();
  await expect(page.getByTestId('orderbook')).toHaveCount(0);
  await expect(page.getByLabel('Order type')).toHaveValue('limit');
  await expect(page.getByRole('tab', { name: 'Buy', selected: true })).toBeVisible();
  await expect(page.getByLabel('Limit price (¢)')).toHaveValue(askPrice);
  await page.getByLabel('Order type').selectOption('market');

  await page.getByLabel('Order type').selectOption('limit');
  await expect(page.getByLabel('Limit price (¢)')).toBeVisible();
  await page.getByLabel('Order type').selectOption('market');
  await expect(page.getByLabel('Limit price (¢)')).toHaveCount(0);

  // A fresh wallet holds no shares, so a sell is stopped up front (holdings are read on-chain).
  await page.getByRole('tab', { name: 'Sell' }).click();
  await page.getByLabel('Shares').fill('100');
  await expect(page.getByText(/You don't hold any \w+ shares/)).toBeVisible({ timeout: 15_000 });
  // A huge order on the live book still shows a slippage / liquidity warning.
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

test('defaults to production and switches to staging in Settings', async ({ openWallet }) => {
  const page = await openWallet('/onboarding');
  await onboardWithMnemonic(page);
  await page.goto(page.url().replace(/#.*/, '#/settings/apis'));

  const env = page.getByRole('radiogroup', { name: 'Kairos environment' });
  await expect(env.getByRole('radio', { name: 'Production' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#kairos-exec')).toHaveValue('https://execution.kairos.trade');
  await env.getByRole('radio', { name: 'Staging' }).click();
  await expect(page.locator('#kairos-exec')).toHaveValue('https://staging-execution.kairos.trade');
  await page.getByRole('button', { name: 'Save' }).click();

  await page.goto(page.url().replace(/#.*/, '#/settings/apis'));
  await expect(env.getByRole('radio', { name: 'Staging' })).toHaveAttribute('aria-checked', 'true');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/settings-env.png` });
});

test('browses Predict.fun markets with their live book', async ({ openWallet }) => {
  test.setTimeout(120_000);
  const page = await openWallet('/onboarding');
  await onboardWithMnemonic(page, generateMnemonic());
  await page.getByRole('button', { name: 'Predict' }).click();
  await page.getByRole('radio', { name: 'Predict.fun' }).click();
  await expect(page.getByRole('radio', { name: 'Predict.fun', checked: true })).toBeVisible();
  const list = page.getByTestId('market-list').locator('.list-item');
  await expect(list.first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1000);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/predictfun-markets.png` });

  await list.first().click();
  if (page.url().includes('/predict/event')) await page.getByTestId('outcome-list').locator('.list-item').first().click();
  await expect(page.getByTestId('market-title')).not.toBeEmpty({ timeout: 30_000 });
  expect(decodeURIComponent(page.url())).toContain('id=predictfun:');
  await expect(page.locator('.venue-tag.predictfun')).toHaveText('Predict.fun');
  await expect(page.locator('.live-dot.live').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/predictfun-market.png` });
  // Until the node serves the multi-venue API, Predict.fun markets are read-only.
  await expect(page.getByText(/doesn't trade Predict.fun yet|Add USDT on BNB Chain/)).toBeVisible({ timeout: 30_000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/predictfun-trade.png`, fullPage: true });
});
