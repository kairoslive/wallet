import { createPublicClient, http, parseEther } from 'viem';
import { test, expect, onboardWithMnemonic } from './fixtures';
import { startAnvil, type AnvilInstance } from '../helpers/anvil';

const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

test.describe('sending on a local EVM chain', () => {
  let anvil: AnvilInstance;

  test.beforeAll(async () => {
    // Chain id 1 so the built-in Ethereum network can point at it.
    anvil = await startAnvil({ chainId: 1 });
  });
  test.afterAll(async () => anvil?.stop());

  test('edits the RPC in settings, then sends ETH through the UI', async ({ openWallet }) => {
    const page = await openWallet('/onboarding');
    await onboardWithMnemonic(page);

    // Only keep Ethereum on, so the test never touches public RPCs.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: /^Networks/ }).click();
    for (const sw of await page.getByRole('switch').all()) {
      const name = await sw.getAttribute('aria-label');
      const on = (await sw.getAttribute('aria-checked')) === 'true';
      if (on !== (name === 'Enable Ethereum')) await sw.click();
    }
    await expect(page.getByRole('switch', { name: 'Enable Ethereum' })).toHaveAttribute('aria-checked', 'true');

    // Point Ethereum at anvil and verify with the RPC test button.
    await page.getByText('Ethereum', { exact: true }).click();
    await page.getByLabel('RPC URL').fill(anvil.rpcUrl);
    await page.getByRole('button', { name: 'Test' }).click();
    await expect(page.getByText(/chain id 1\b/i)).toBeVisible();
    await page.getByRole('button', { name: 'Save' }).click();

    await page.goto(page.url().replace(/#.*/, '#/'));
    await expect(page.getByTestId('token-list')).toContainText('10,000');

    // Send 1.5 ETH to anvil account #1.
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByLabel('To').fill(RECIPIENT);
    await page.getByLabel('Amount amount').fill('1.5');
    await page.getByTestId('review-send').click();
    await expect(page.getByText('Network fee')).toBeVisible();
    await page.getByTestId('confirm-send').click();
    await expect(page.getByTestId('tx-result')).toHaveAttribute('data-status', 'confirmed', { timeout: 30_000 });

    const client = createPublicClient({ transport: http(anvil.rpcUrl) });
    expect(await client.getBalance({ address: RECIPIENT })).toBe(parseEther('10001.5'));

    // The send shows up in activity.
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('activity-list')).toContainText('Sent 1.5 ETH');
  });

  test('shows the receive QR code and both addresses', async ({ openWallet }) => {
    const page = await openWallet('/onboarding');
    await onboardWithMnemonic(page);
    await page.getByRole('button', { name: 'Receive', exact: true }).click();
    await expect(page.getByText('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')).toBeVisible();
    await expect(page.locator('img[alt*="QR"], canvas').first()).toBeVisible();
  });

  test('saves a contact and picks it on the send screen', async ({ openWallet }) => {
    const page = await openWallet('/onboarding');
    await onboardWithMnemonic(page);
    await page.goto(page.url().replace(/#.*/, '#/settings/contacts'));
    await page.getByRole('button', { name: 'Add contact' }).click();
    await page.getByLabel('Name').fill('Bob');
    await page.getByLabel('Address').fill(RECIPIENT.toLowerCase());
    await page.getByRole('dialog').getByRole('button', { name: 'Add contact' }).click();
    await expect(page.getByText('Contact added')).toBeVisible();
    await expect(page.locator('.list-item')).toContainText('Bob');

    await page.goto(page.url().replace(/#.*/, '#/send?network=eth'));
    await page.getByRole('button', { name: /^Bob/ }).click();
    await expect(page.getByLabel('To')).toHaveValue(RECIPIENT);
  });
});
