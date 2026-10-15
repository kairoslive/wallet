import { execFileSync } from 'node:child_process';
import { test, expect, onboardWithMnemonic } from './fixtures';

/**
 * After a rebuild, Chrome keeps the old service worker running while new pages load the new UI.
 * The UI must notice and offer a reload instead of failing with "Unknown method" errors.
 * (Clicking Reload calls chrome.runtime.reload(); Playwright's Chromium disables --load-extension
 * extensions on reload, so that last step is exercised manually in regular Chrome.)
 */
test('detects a background worker left running from an older build', async ({ openWallet }) => {
  test.setTimeout(180_000);
  const page = await openWallet('/onboarding');
  await onboardWithMnemonic(page);
  await expect(page.getByText('The wallet was updated')).toHaveCount(0);

  execFileSync('node', ['scripts/build.mjs'], { stdio: 'ignore' });
  const fresh = await openWallet('/');
  await expect(fresh.getByRole('alert')).toContainText('The wallet was updated. Reload to finish.');
  await expect(fresh.getByRole('button', { name: 'Reload' })).toBeVisible();
});
