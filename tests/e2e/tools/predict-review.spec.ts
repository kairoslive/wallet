import { test, expect, onboardWithMnemonic } from '../fixtures';

/**
 * Captures the prediction screens against live Kairos market data, for design review: the market
 * list, search, a market listed on several venues (price, chart scrubbing, candles, routed quote
 * and its breakdown, rules and resolution). Read-only: nothing is signed.
 *
 * SCREENSHOTS=1 KAIROS_LIVE=1 pnpm exec playwright test tests/e2e/tools/predict-review.spec.ts
 */
const DIR = process.env.SHOTS_DIR ?? 'test-results/predict-review';

test('prediction screens', async ({ context, extensionId }) => {
  test.skip(!process.env.KAIROS_LIVE, 'needs live Kairos data (KAIROS_LIVE=1)');
  test.setTimeout(180_000);
  const page = await context.newPage();
  await page.setViewportSize({ width: 360, height: 600 });
  const open = (hash: string) => page.goto(`chrome-extension://${extensionId}/popup.html#${hash}`);
  const shot = (name: string, fullPage = false) => page.screenshot({ path: `${DIR}/${name}.png`, fullPage });

  await open('/onboarding');
  await onboardWithMnemonic(page);

  await open('/predict');
  await expect(page.getByTestId('market-list').locator('.market-row').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await shot('list');

  await page.getByTestId('open-search').click();
  await page.getByTestId('search-input').fill('Chargers Ravens');
  await expect(page.getByTestId('search-results').locator('.market-row').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(500);
  await shot('search');

  const market = process.env.REVIEW_MARKET ?? '6296764';
  await open(`/predict/market?id=${market}`);
  await expect(page.getByTestId('market-title')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.live-dot.live')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await shot('market');

  // Scrub the chart: the headline follows the pointer.
  const chart = page.getByTestId('price-chart');
  const box = (await chart.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2);
  await page.waitForTimeout(200);
  await shot('market-scrub');
  await page.mouse.move(0, 0);

  await page.getByTestId('chart-mode').click();
  await page.waitForTimeout(1500);
  await shot('market-candles');

  await page.locator('#trade-amount').fill(process.env.REVIEW_AMOUNT ?? '20');
  // Every venue's book streams in on its own; give the slower ones a moment.
  await page.waitForTimeout(3000);
  const chip = page.getByTestId('route-chip');
  if (await chip.isVisible()) await chip.click();
  await page.getByTestId('trade-summary').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot('market-route');
  await shot('market-full', true);

  await page.locator('.about').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await shot('market-about');
});
