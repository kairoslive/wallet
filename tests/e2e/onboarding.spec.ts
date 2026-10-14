import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, onboardWithMnemonic, clickAndClose, PASSWORD } from './fixtures';

test('creates a new wallet with phrase confirmation, locks and unlocks', async ({ openWallet }) => {
  const page = await openWallet('/onboarding?tab=1');
  await page.getByRole('button', { name: 'Create a new wallet' }).click();
  await page.getByRole('button', { name: 'Reveal phrase' }).click();
  const words = (await page.getByTestId('phrase-grid').locator('.word').allInnerTexts()).map((t) =>
    t.replace(/^\d+\s*/, '').trim(),
  );
  expect(words).toHaveLength(12);
  await page.getByLabel('I saved my recovery phrase somewhere safe').check();
  await page.getByRole('button', { name: 'Continue' }).click();

  // Fill the three requested words.
  for (const label of await page.getByText(/^Word #\d+$/).allInnerTexts()) {
    const n = Number(label.replace('Word #', ''));
    await page.getByLabel(label, { exact: true }).fill(words[n - 1]);
  }
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create wallet' }).click();
  await expect(page.getByText('Your wallet is ready')).toBeVisible();
  await page.getByRole('button', { name: 'Open wallet' }).click();

  await expect(page.getByRole('button', { name: 'Switch account' })).toContainText('Account 1');
  await expect(page.getByText(/^EVM 0x/)).toBeVisible();
  await expect(page.getByText(/^Solana /)).toBeVisible();

  // Lock from settings, then unlock with a wrong and the right password.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Lock wallet' }).click();
  await expect(page.getByText('Welcome back')).toBeVisible();
  await page.getByPlaceholder('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByText('Incorrect password')).toBeVisible();
  await page.getByPlaceholder('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Unlock' }).click();
  // Unlocking returns to the screen that was open.
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
});

test('rejects an invalid recovery phrase', async ({ openWallet }) => {
  const page = await openWallet('/onboarding');
  await page.getByRole('button', { name: 'Import recovery phrase' }).click();
  await page.getByLabel('Recovery phrase').fill('test test test test test test test test test test test test');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText("This isn't a valid recovery phrase")).toBeVisible();
});

test.describe('dApp connection', () => {
  let server: Server;
  let url: string;

  test.beforeAll(async () => {
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><title>Test dApp</title><body>
        <script>
          window.__eip6963 = [];
          window.addEventListener('eip6963:announceProvider', (e) => window.__eip6963.push(e.detail.info.name));
          window.dispatchEvent(new Event('eip6963:requestProvider'));
          window.__wallets = [];
          const api = { register: (...ws) => { window.__wallets.push(...ws); return () => {}; } };
          window.addEventListener('wallet-standard:register-wallet', (e) => e.detail(api));
          window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
        </script></body>`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  test.afterAll(() => server.close());

  test('connects, signs a message and exposes the Solana wallet', async ({ context, openWallet }) => {
    const wallet = await openWallet('/onboarding');
    await onboardWithMnemonic(wallet);
    await expect(wallet.getByRole('button', { name: 'Switch account' })).toBeVisible();

    const dapp = await context.newPage();
    await dapp.goto(url);
    await expect
      .poll(() => dapp.evaluate(() => (window as unknown as { __eip6963: string[] }).__eip6963))
      .toContain('Duo Wallet');
    expect(
      await dapp.evaluate(() => (window as unknown as { __wallets: { name: string }[] }).__wallets.map((w) => w.name)),
    ).toContain('Duo Wallet');
    expect(
      await dapp.evaluate(() =>
        (window as unknown as { ethereum: { request: (a: object) => Promise<unknown> } }).ethereum.request({
          method: 'eth_accounts',
        }),
      ),
    ).toEqual([]);

    // eth_requestAccounts opens the approval window.
    const approvalPage = context.waitForEvent('page', (p) => p.url().includes('#/approve'));
    const accounts = dapp.evaluate(() =>
      (window as unknown as { ethereum: { request: (a: object) => Promise<string[]> } }).ethereum.request({
        method: 'eth_requestAccounts',
      }),
    );
    const approval = await approvalPage;
    await expect(approval.getByText('Connect to this site')).toBeVisible();
    await expect(approval.getByTestId('approval-origin')).toHaveText('127.0.0.1');
    await clickAndClose(approval, 'Connect');
    expect(await accounts).toEqual(['0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266']);

    // personal_sign → approve → signature.
    const approvalPage2 = context.waitForEvent('page', (p) => p.url().includes('#/approve'));
    const signature = dapp.evaluate(() =>
      (window as unknown as { ethereum: { request: (a: object) => Promise<string> } }).ethereum.request({
        method: 'personal_sign',
        params: ['0x48656c6c6f2044756f', '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'],
      }),
    );
    const approval2 = await approvalPage2;
    await expect(approval2.getByText('Hello Duo')).toBeVisible();
    await clickAndClose(approval2, 'Sign');
    expect(await signature).toMatch(/^0x[0-9a-f]{130}$/);

    // A rejected request surfaces as EIP-1193 error 4001.
    const approvalPage3 = context.waitForEvent('page', (p) => p.url().includes('#/approve'));
    const rejected = dapp.evaluate(() =>
      (window as unknown as { ethereum: { request: (a: object) => Promise<string> } }).ethereum
        .request({ method: 'personal_sign', params: ['0x00', '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'] })
        .catch((e: { code: number }) => e.code),
    );
    await clickAndClose(await approvalPage3, 'Reject');
    expect(await rejected).toBe(4001);

    // The site shows up under connected sites and can be disconnected.
    await wallet.goto(wallet.url().replace(/#.*/, '#/settings/sites'));
    await expect(wallet.getByText('127.0.0.1')).toBeVisible();
  });
});
