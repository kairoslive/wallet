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
