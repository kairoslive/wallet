import { describe, expect, it } from 'vitest';
import { DEFAULT_NETWORKS } from '../../src/core/networks';
import { checkDepositInfo, getQuotes, hallidayAsset, SOLANA_NATIVE_ASSET } from '../../src/core/deposits/halliday';

const net = (id: string) => DEFAULT_NETWORKS.find((n) => n.id === id)!;

describe('Halliday helpers', () => {
  it('maps our tokens to Halliday asset ids', () => {
    expect(hallidayAsset(net('eth'), { address: 'native' })).toBe('ethereum:0x');
    expect(hallidayAsset(net('polygon'), { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' })).toBe(
      'polygon:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
    );
    expect(hallidayAsset(net('solana'), { address: 'native' })).toBe(SOLANA_NATIVE_ASSET);
    expect(hallidayAsset(net('solana'), { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' })).toBe(
      'solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    );
    expect(hallidayAsset(net('sepolia'), { address: 'native' })).toBeUndefined();
  });

  it('checks deposit instructions against the quote', () => {
    const quote = { inputAsset: 'base:0xabc', inputAmount: '10' };
    const ok = { deposit_token: 'base:0xABC', deposit_amount: '10', deposit_address: '0xdep', deposit_chain: 'base' };
    expect(checkDepositInfo(ok, quote)).toBe(ok);
    expect(() => checkDepositInfo(undefined, quote)).toThrow('did not return');
    expect(() => checkDepositInfo({ ...ok, deposit_token: 'base:0xdef' }, quote)).toThrow('different token');
    expect(() => checkDepositInfo({ ...ok, deposit_chain: 'polygon' }, quote)).toThrow('different chain');
    expect(() => checkDepositInfo({ ...ok, deposit_amount: '10.5' }, quote)).toThrow('more than you entered');
    expect(() => checkDepositInfo({ ...ok, deposit_address: '' }, quote)).toThrow('no address');
  });

  it('sorts quotes by output and explains a missing route', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const ok = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          quotes: [
            { payment_id: 'a', output_amount: { asset: 'polygon:0xp', amount: '9.5' }, fees: { total_fees: '0.5' } },
            { payment_id: 'b', output_amount: { asset: 'polygon:0xp', amount: '9.9' }, fees: { total_fees: '0.1' } },
          ],
          state_token: 's',
          accept_by: '2030-01-01T00:00:00Z',
        }),
      );
    }) as unknown as typeof fetch;
    const cfg = { url: 'https://h.test', apiKey: 'pk_x', fetchFn: ok };
    const quotes = await getQuotes(cfg, { inputAsset: 'USD', amount: '10', outputAsset: 'polygon:0xp' });
    expect(quotes.map((q) => q.paymentId)).toEqual(['b', 'a']);
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer pk_x');
    const none = (async () =>
      new Response(JSON.stringify({ quotes: [], failures: [{ message: 'amount too small' }] }))) as unknown as typeof fetch;
    await expect(getQuotes({ ...cfg, fetchFn: none }, { inputAsset: 'USD', amount: '1', outputAsset: 'x' })).rejects.toThrow(
      'amount too small',
    );
  });
});
