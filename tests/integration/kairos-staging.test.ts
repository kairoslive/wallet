import { describe, expect, it } from 'vitest';
import { WalletService } from '../../src/core/wallet/service';
import { MemoryStore } from '../../src/core/storage';
import { generateMnemonic } from '../../src/core/keyring/derive';

/**
 * Live checks against Kairos staging. Opt-in (they need the internet and create a staging trading
 * wallet): KAIROS_LIVE=1 pnpm test:integration
 */
describe.skipIf(!process.env.KAIROS_LIVE)('Kairos staging (live)', () => {
  async function wallet() {
    const service = new WalletService({ store: new MemoryStore(), session: new MemoryStore(), pbkdf2Iterations: 1000 });
    await service.createWallet({ password: 'password123', mnemonic: generateMnemonic() });
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
    expect(res.ready).toBe(true);
    expect(res.tradingWallet.toLowerCase()).toBe(before.tradingWallet.toLowerCase());
    const after = await service.predictionStatus(accountId);
    expect(after.next).toBe('fund');
    expect(await service.predictionOrders(accountId, true)).toEqual([]);
    expect((await service.predictionPositions(accountId)).open).toEqual([]);
  }, 180_000);
});
