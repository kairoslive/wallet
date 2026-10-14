import { test as base, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const DIST = resolve(process.cwd(), 'dist');

export const MNEMONIC = 'test test test test test test test test test test test junk';
export const PASSWORD = 'e2e-password-123';

type Fixtures = {
  context: BrowserContext;
  background: Worker;
  extensionId: string;
  openWallet: (hash?: string) => Promise<Page>;
};

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext(mkdtempSync(resolve(tmpdir(), 'duo-e2e-')), {
      channel: 'chromium',
      headless: process.env.HEADED ? false : true,
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
      // Crisp captures for the README.
      deviceScaleFactor: process.env.SCREENSHOTS ? 2 : undefined,
    });
    await use(context);
    await context.close();
  },
  background: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    sw ??= await context.waitForEvent('serviceworker');
    await use(sw);
  },
  extensionId: async ({ background }, use) => {
    await use(new URL(background.url()).host);
  },
  openWallet: async ({ context, extensionId }, use) => {
    await use(async (hash = '/') => {
      const page = await context.newPage();
      // Popup dimensions, so the layout matches the toolbar popup.
      await page.setViewportSize({ width: 360, height: 600 });
      await page.goto(`chrome-extension://${extensionId}/popup.html#${hash}`);
      return page;
    });
  },
});

export const expect = test.expect;

/** Imports the test mnemonic through the onboarding UI. */
export async function onboardWithMnemonic(page: Page, mnemonic = MNEMONIC) {
  await page.getByRole('button', { name: 'Import recovery phrase' }).click();
  await page.getByLabel('Recovery phrase').fill(mnemonic);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create wallet' }).click();
  await page.getByRole('button', { name: 'Open wallet' }).click();
}

/** Clicks a button that closes its own window (approval screens); the window closing mid-click is expected. */
export async function clickAndClose(page: Page, name: string) {
  await page
    .getByRole('button', { name })
    .click()
    .catch((e: Error) => {
      if (!page.isClosed()) throw e;
    });
}
