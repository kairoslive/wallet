import { describe, expect, it } from 'vitest';
import { WalletService } from '../../src/core/wallet/service';
import { MemoryStore } from '../../src/core/storage';
import { generateMnemonic } from '../../src/core/keyring/derive';
import { KAIROS_ENVIRONMENTS, type KairosEnvironment } from '../../src/core/predictions/environments';

/**
 * Live checks against Kairos staging. Opt-in (they need the internet and create a staging trading
 * wallet): KAIROS_LIVE=1 [KAIROS_ENV=production] pnpm test:integration
 */
describe.skipIf(!process.env.KAIROS_LIVE)('Kairos staging (live)', () => {
  async function wallet() {
    const service = new WalletService({ store: new MemoryStore(), session: new MemoryStore(), pbkdf2Iterations: 1000 });
    await service.createWallet({ password: 'password123', mnemonic: generateMnemonic() });
    const env = (process.env.KAIROS_ENV ?? 'staging') as KairosEnvironment;
    await service.updateSettings({ apis: { ...(await service.getSettings()).apis, ...KAIROS_ENVIRONMENTS[env] } });
    return { service, accountId: (await service.getState()).accounts[0].id };
  }

  it('lists markets and loads one with prices and history', async () => {
    const { service } = await wallet();
    const events = await service.predictionMarkets({ category: 'crypto', limit: 5 });
    expect(events.length).toBeGreaterThan(0);
    const outcome = events[0].outcomes[0];
    const market = await service.predictionMarket(outcome.marketId);
    expect(market.conditionId).toBe(outcome.conditionId);
    expect(market.tokens.length).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(await service.predictionPriceHistory(outcome.marketId, { hours: 24 }))).toBe(true);
    const search = await service.predictionMarkets({ search: 'bitcoin', limit: 5 });
    expect(search.length).toBeGreaterThan(0);
  });

  it('sets up a fresh wallet end to end, every signature passing the validator', async () => {
    const { service, accountId } = await wallet();
    const before = await service.predictionStatus(accountId);
    expect(before.next).toBe('setup');
    const res = await service.predictionSetup(accountId);
    // Other venues stay unready until funded, so only Polymarket's own setup must finish.
    expect(res.venues?.polymarket?.ready ?? res.ready).toBe(true);
    expect(res.tradingWallet?.toLowerCase()).toBe(before.tradingWallet.toLowerCase());
    const after = await service.predictionStatus(accountId);
    expect(after.next).toBe('fund');
    // Reads sign in first (login action). Until a node ships login, it says so instead.
    try {
      expect(await service.predictionOrders(accountId, true)).toEqual([]);
      expect((await service.predictionPositions(accountId)).positions).toEqual([]);
    } catch (e) {
      expect((e as Error).message).toMatch(/doesn't support signing in yet/);
    }
  }, 180_000);

  it('quotes Halliday conversions into pUSD (crypto and card)', async () => {
    const { service } = await wallet();
    const inputs = await service.depositInputs();
    expect(inputs).toContain('polygon:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359');
    const usdc = {
      networkId: 'polygon',
      address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
    };
    const quote = await service.depositQuote({ networkId: 'polygon', token: usdc, amount: '20' });
    expect(Number(quote.outputAmount)).toBeGreaterThan(19);
    const card = await service.depositFiatQuotes('50');
    expect(card.length).toBeGreaterThan(0);
    expect(card[0].onramp).toBeTruthy();
  });
});
