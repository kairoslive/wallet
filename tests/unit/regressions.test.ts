import { describe, expect, it } from 'vitest';
import { isValidEvmAddress } from '../../src/core/address';
import { parseUnits } from '../../src/core/format';
import { tokenKey } from '../../src/core/tokens';

describe('review fixes', () => {
  it('rejects mixed-case EVM addresses with a bad checksum', () => {
    expect(isValidEvmAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')).toBe(true);
    expect(isValidEvmAddress('0xF39fd6e51aad88F6F4ce6aB8827279cffFb92266')).toBe(false);
  });

  it('accepts trailing zeros beyond the token decimals', () => {
    expect(parseUnits('1.5000000', 6)).toBe(1_500_000n);
    expect(() => parseUnits('1.0000001', 6)).toThrow('Too many decimal places');
  });

  it('keeps Solana mint case in token keys', () => {
    expect(tokenKey({ networkId: 'solana', address: 'AbC' })).not.toBe(tokenKey({ networkId: 'solana', address: 'abc' }));
    expect(tokenKey({ networkId: 'eth', address: '0xAbC' })).toBe(tokenKey({ networkId: 'eth', address: '0xabc' }));
  });
});

import { WalletService } from '../../src/core/wallet/service';
import { MemoryStore } from '../../src/core/storage';

describe('service gap fixes', () => {
  async function svc() {
    const s = new WalletService({ store: new MemoryStore(), session: new MemoryStore(), pbkdf2Iterations: 1000 });
    await s.createWallet({ password: 'password123', mnemonic: 'test test test test test test test test test test test junk' });
    return s;
  }

  it('addAccount can restore a specific index', async () => {
    const s = await svc();
    const seedId = (await s.getState()).seeds[0].id;
    const a1 = await s.addAccount({ seedId });
    await s.removeAccount(a1.id);
    const restored = await s.addAccount({ seedId, index: 1 });
    expect(restored.evmAddress).toBe(a1.evmAddress);
    await expect(s.addAccount({ seedId, index: 1 })).rejects.toThrow('already in this wallet');
    await expect(s.addAccount({ seedId, index: -1 })).rejects.toThrow('Invalid account index');
    expect((await s.addAccount({ seedId })).index).toBe(2);
  });

  it('upsertNetwork with create refuses to overwrite an existing id', async () => {
    const s = await svc();
    const eth = (await s.getSettings()).networks.find((n) => n.id === 'eth')!;
    await expect(s.upsertNetwork({ ...eth, name: 'Mine' }, { create: true })).rejects.toThrow('already used');
  });

  it('hiding the selected account selects another visible one', async () => {
    const s = await svc();
    const st = await s.getState();
    const a2 = await s.addAccount({ seedId: st.seeds[0].id });
    await s.setAccountHidden(a2.id, true);
    expect((await s.getState()).selectedAccountId).toBe(st.accounts[0].id);
    await expect(s.setAccountHidden(st.accounts[0].id, true)).rejects.toThrow('must stay visible');
  });
});
