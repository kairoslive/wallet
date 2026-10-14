import { beforeEach, describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { bytesToHex } from '@noble/hashes/utils.js';
import { WalletService } from '../../src/core/wallet/service';
import { MemoryStore } from '../../src/core/storage';
import { DEFAULT_NETWORKS } from '../../src/core/networks';
import {
  deriveAddresses,
  deriveEvmPrivateKey,
  deriveSolanaSecretKey,
  mnemonicToSeed,
  solanaAddressFromSecret,
  solanaSecretFromSeed,
} from '../../src/core/keyring/derive';
import type { EvmNetwork, Permission, SolanaNetwork, Token } from '../../src/core/types';

const MNEMONIC = 'test test test test test test test test test test test junk';
const MNEMONIC_2 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'hunter22hunter22';
const ANVIL_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ANVIL_0_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const RANDOM_EVM_KEY = `0x${'11'.repeat(32)}`;
const RANDOM_SOL_SEED = new Uint8Array(32).fill(7);

type Event = 'lock' | 'unlock' | 'accounts' | 'settings';

function makeService(store = new MemoryStore(), session = new MemoryStore()) {
  const service = new WalletService({
    store,
    session,
    pbkdf2Iterations: 1000,
    fetchFn: async () => {
      throw new Error('network access is not allowed in unit tests');
    },
  });
  return { service, store, session };
}

async function created(mnemonic = MNEMONIC) {
  const ctx = makeService();
  await ctx.service.createWallet({ password: PASSWORD, mnemonic });
  return ctx;
}

describe('WalletService: createWallet', () => {
  it('starts uninitialized and locked', async () => {
    const { service } = makeService();
    const st = await service.getState();
    expect(st).toMatchObject({ initialized: false, unlocked: false, seeds: [], accounts: [] });
    expect(st.selectedAccountId).toBeUndefined();
    expect(st.settings.networks.map((n) => n.id)).toEqual(DEFAULT_NETWORKS.map((n) => n.id));
  });

  it('creates from a mnemonic with derived EVM + Solana addresses', async () => {
    const { service, store } = makeService();
    const st = await service.createWallet({ password: PASSWORD, mnemonic: `  ${MNEMONIC.toUpperCase()}  ` });
    expect(st.initialized).toBe(true);
    expect(st.unlocked).toBe(true);
    expect(st.seeds).toHaveLength(1);
    expect(st.seeds[0]).toMatchObject({ name: 'Wallet 1', nextIndex: 1, backedUp: true });
    expect(st.accounts).toHaveLength(1);
    const expected = deriveAddresses(MNEMONIC, 0);
    expect(st.accounts[0]).toMatchObject({
      name: 'Account 1',
      kind: 'seed',
      seedId: st.seeds[0].id,
      index: 0,
      evmAddress: ANVIL_0,
      solanaAddress: expected.solanaAddress,
    });
    expect(st.selectedAccountId).toBe(st.accounts[0].id);
    // Mnemonic is normalized before storage.
    expect(await service.revealMnemonic(st.seeds[0].id, PASSWORD)).toBe(MNEMONIC);
    // Nothing secret is stored in plaintext.
    const dump = JSON.stringify({ vault: await store.get('vault'), wallet: await store.get('wallet') });
    expect(dump).not.toContain('junk');
  });

  it('generates a mnemonic when none is given and honours backedUp', async () => {
    const { service } = makeService();
    const st = await service.createWallet({ password: PASSWORD, backedUp: false });
    expect(st.seeds[0].backedUp).toBe(false);
    const phrase = await service.revealMnemonic(st.seeds[0].id, PASSWORD);
    expect(phrase.split(' ')).toHaveLength(12);
    expect(service.validateMnemonic(phrase)).toBe(true);
    await service.markSeedBackedUp(st.seeds[0].id);
    expect((await service.getState()).seeds[0].backedUp).toBe(true);
    await expect(service.markSeedBackedUp('nope')).rejects.toThrow('Unknown wallet');
  });

  it('creates from an EVM private key', async () => {
    const { service } = makeService();
    const st = await service.createWallet({ password: PASSWORD, privateKey: { chainType: 'evm', key: ANVIL_0_KEY.slice(2) } });
    expect(st.seeds).toEqual([]);
    expect(st.accounts).toHaveLength(1);
    expect(st.accounts[0]).toMatchObject({ name: 'Account 1', kind: 'privateKey', evmAddress: ANVIL_0 });
    expect(st.accounts[0].solanaAddress).toBeUndefined();
    expect(await service.revealPrivateKey(st.accounts[0].id, 'evm', PASSWORD)).toBe(ANVIL_0_KEY);
  });

  it('creates from a Solana private key', async () => {
    const { service } = makeService();
    const secret = solanaSecretFromSeed(RANDOM_SOL_SEED);
    const st = await service.createWallet({ password: PASSWORD, privateKey: { chainType: 'solana', key: bs58.encode(secret) } });
    expect(st.accounts[0]).toMatchObject({ kind: 'privateKey', solanaAddress: solanaAddressFromSecret(secret) });
    expect(st.accounts[0].evmAddress).toBeUndefined();
    expect(await service.revealPrivateKey(st.accounts[0].id, 'solana', PASSWORD)).toBe(bs58.encode(secret));
    await expect(service.revealPrivateKey(st.accounts[0].id, 'evm', PASSWORD)).rejects.toThrow('This account has no EVM key');
  });

  it('enforces the password length rule', async () => {
    const { service } = makeService();
    await expect(service.createWallet({ password: 'short', mnemonic: MNEMONIC })).rejects.toThrow(
      'Password must be at least 8 characters',
    );
    expect(await service.isInitialized()).toBe(false);
    await service.createWallet({ password: '12345678', mnemonic: MNEMONIC });
    expect(await service.isInitialized()).toBe(true);
  });

  it('rejects invalid input without initializing', async () => {
    const { service } = makeService();
    await expect(service.createWallet({ password: PASSWORD, mnemonic: 'not a real phrase at all' })).rejects.toThrow(
      'Invalid recovery phrase',
    );
    await expect(service.createWallet({ password: PASSWORD, privateKey: { chainType: 'evm', key: '0x1234' } })).rejects.toThrow(
      'Invalid EVM private key',
    );
    await expect(
      service.createWallet({ password: PASSWORD, privateKey: { chainType: 'solana', key: 'not-base58-!!' } }),
    ).rejects.toThrow('Invalid Solana private key');
    expect(await service.isInitialized()).toBe(false);
  });

  it('refuses to create a second wallet', async () => {
    const { service } = await created();
    await expect(service.createWallet({ password: PASSWORD, mnemonic: MNEMONIC_2 })).rejects.toThrow('Wallet already exists');
  });

  it('serializes concurrent createWallet calls (only one wins)', async () => {
    const { service } = makeService();
    const results = await Promise.allSettled([
      service.createWallet({ password: PASSWORD, mnemonic: MNEMONIC }),
      service.createWallet({ password: PASSWORD, mnemonic: MNEMONIC_2 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await service.getState()).accounts).toHaveLength(1);
  });
});

describe('WalletService: lock / unlock / session', () => {
  it('locks and unlocks with the right password only', async () => {
    const { service } = await created();
    const id = (await service.getState()).accounts[0].id;
    await service.lock();
    expect(service.isUnlocked()).toBe(false);
    expect((await service.getState()).unlocked).toBe(false);
    await expect(service.evmSigner(id)).rejects.toThrow('Wallet is locked');
    await expect(service.addSeed()).rejects.toThrow('Wallet is locked');

    await expect(service.unlock('wrong password')).rejects.toThrow('Incorrect password');
    expect(service.isUnlocked()).toBe(false);
    await service.unlock(PASSWORD);
    expect(service.isUnlocked()).toBe(true);
    expect((await service.evmSigner(id)).address).toBe(ANVIL_0);
  });

  it('unlock / verifyPassword fail when not initialized', async () => {
    const { service } = makeService();
    await expect(service.unlock(PASSWORD)).rejects.toThrow('Wallet not initialized');
    await expect(service.verifyPassword(PASSWORD)).rejects.toThrow('Wallet not initialized');
  });

  it('restores the session in a fresh instance sharing the same stores', async () => {
    const { service, store, session } = await created();
    expect(await session.get('sessionKey')).toEqual(expect.any(String));

    const fresh = makeService(store, session).service;
    expect(fresh.isUnlocked()).toBe(false);
    expect(await fresh.restoreSession()).toBe(true);
    expect(fresh.isUnlocked()).toBe(true);
    const seedId = (await fresh.getState()).seeds[0].id;
    expect(await fresh.revealMnemonic(seedId, PASSWORD)).toBe(MNEMONIC);
    // Already unlocked: no-op true.
    expect(await fresh.restoreSession()).toBe(true);

    // The restored instance can write secrets that the original can read after unlock.
    const imported = await fresh.importPrivateKey({ chainType: 'evm', privateKey: RANDOM_EVM_KEY });
    await service.lock();
    await service.unlock(PASSWORD);
    expect(await service.revealPrivateKey(imported.id, 'evm', PASSWORD)).toBe(RANDOM_EVM_KEY);
  });

  it('does not restore after lock or without a session store entry', async () => {
    const { service, store, session } = await created();
    await service.lock();
    expect(await session.get('sessionKey')).toBeUndefined();
    expect(await makeService(store, session).service.restoreSession()).toBe(false);
    expect(await makeService(store, new MemoryStore()).service.restoreSession()).toBe(false);
    expect(await makeService(new MemoryStore(), new MemoryStore()).service.restoreSession()).toBe(false);
  });

  it('drops an invalid session key', async () => {
    const { store, session } = await created();
    await session.set('sessionKey', bytesToHex(new Uint8Array(4)));
    expect(await makeService(store, session).service.restoreSession()).toBe(false);
    expect(await session.get('sessionKey')).toBeUndefined();

    // A well-formed key that doesn't match the vault is also rejected and dropped.
    await session.set('sessionKey', Buffer.alloc(32, 1).toString('base64'));
    expect(await makeService(store, session).service.restoreSession()).toBe(false);
    expect(await session.get('sessionKey')).toBeUndefined();
  });

  it('changePassword re-encrypts the vault', async () => {
    const { service, store, session } = await created();
    await expect(service.changePassword('wrong password', 'new password 123')).rejects.toThrow('Incorrect password');
    await expect(service.changePassword(PASSWORD, 'short')).rejects.toThrow('Password must be at least 8 characters');
    const oldVault = await store.get('vault');
    await service.changePassword(PASSWORD, 'new password 123');
    expect(await store.get('vault')).not.toEqual(oldVault);
    expect(service.isUnlocked()).toBe(true);

    await service.lock();
    await expect(service.unlock(PASSWORD)).rejects.toThrow('Incorrect password');
    await service.unlock('new password 123');
    const seedId = (await service.getState()).seeds[0].id;
    await expect(service.revealMnemonic(seedId, PASSWORD)).rejects.toThrow('Incorrect password');
    expect(await service.revealMnemonic(seedId, 'new password 123')).toBe(MNEMONIC);
    // New session key works in a fresh instance.
    expect(await makeService(store, session).service.restoreSession()).toBe(true);
  });
});

describe('WalletService: seeds & accounts', () => {
  let service: WalletService;
  let store: MemoryStore;
  let seedId: string;
  let firstId: string;

  beforeEach(async () => {
    ({ service, store } = await created());
    const st = await service.getState();
    seedId = st.seeds[0].id;
    firstId = st.accounts[0].id;
  });

  it('addAccount derives sequential indexes (Account 2 uses index 1)', async () => {
    const a2 = await service.addAccount({ seedId });
    expect(a2).toMatchObject({ name: 'Account 2', index: 1, seedId, kind: 'seed' });
    expect(a2.evmAddress).toBe(deriveAddresses(MNEMONIC, 1).evmAddress);
    expect(a2.solanaAddress).toBe(deriveAddresses(MNEMONIC, 1).solanaAddress);
    const a3 = await service.addAccount({ seedId, name: '  Savings  ' });
    expect(a3).toMatchObject({ name: 'Savings', index: 2 });
    const st = await service.getState();
    expect(st.seeds[0].nextIndex).toBe(3);
    expect(st.selectedAccountId).toBe(a3.id);
    await expect(service.addAccount({ seedId: 'nope' })).rejects.toThrow('Unknown wallet');
  });

  it('addAccount skips indexes that are already used', async () => {
    await service.addAccount({ seedId }); // index 1
    await service.addAccount({ seedId }); // index 2
    // Simulate stale metadata (e.g. older data) where nextIndex lags behind the used indexes.
    const data = (await store.get<{ seeds: { nextIndex: number }[] }>('wallet'))!;
    data.seeds[0].nextIndex = 1;
    await store.set('wallet', data);
    const next = await service.addAccount({ seedId });
    expect(next.index).toBe(3);
    expect((await service.getState()).seeds[0].nextIndex).toBe(4);
  });

  it('addAccount skips an index whose address was already imported as a private key', async () => {
    const idx1Key = deriveEvmPrivateKey(mnemonicToSeed(MNEMONIC), 1);
    await service.importPrivateKey({ chainType: 'evm', privateKey: idx1Key });
    const next = await service.addAccount({ seedId });
    expect(next.index).toBe(2);
    const addrs = (await service.getState()).accounts.map((a) => a.evmAddress?.toLowerCase());
    expect(new Set(addrs).size).toBe(addrs.length);
  });

  it('removing a derived account does not reuse its index', async () => {
    const a2 = await service.addAccount({ seedId });
    await service.removeAccount(a2.id);
    const a3 = await service.addAccount({ seedId });
    expect(a3.index).toBe(2);
  });

  it('addSeed with a generated phrase', async () => {
    const { seed, account } = await service.addSeed();
    expect(seed).toMatchObject({ name: 'Wallet 2', backedUp: false, nextIndex: 1 });
    expect(account).toMatchObject({ name: 'Account 2', index: 0, seedId: seed.id });
    const phrase = await service.revealMnemonic(seed.id, PASSWORD);
    expect(phrase).not.toBe(MNEMONIC);
    expect(account.evmAddress).toBe(deriveAddresses(phrase, 0).evmAddress);
    const st = await service.getState();
    expect(st.seeds).toHaveLength(2);
    expect(st.selectedAccountId).toBe(account.id);
  });

  it('addSeed with an imported phrase persists the secret in the vault', async () => {
    const { seed, account } = await service.addSeed({ mnemonic: MNEMONIC_2, name: ' Cold ' });
    expect(seed).toMatchObject({ name: 'Cold', backedUp: true });
    expect(account.evmAddress).toBe(deriveAddresses(MNEMONIC_2, 0).evmAddress);
    await service.lock();
    await service.unlock(PASSWORD);
    expect(await service.revealMnemonic(seed.id, PASSWORD)).toBe(MNEMONIC_2);
    // Accounts from the second seed can sign.
    expect((await service.evmSigner(account.id)).address).toBe(account.evmAddress);
  });

  it('rejects a duplicate recovery phrase (after normalization)', async () => {
    await expect(service.addSeed({ mnemonic: `  ${MNEMONIC.toUpperCase().replace(/ /g, '   ')} ` })).rejects.toThrow(
      'This recovery phrase is already imported',
    );
    await expect(service.addSeed({ mnemonic: 'invalid words here' })).rejects.toThrow('Invalid recovery phrase');
    expect((await service.getState()).seeds).toHaveLength(1);
  });

  it('importPrivateKey EVM, Solana and duplicate detection', async () => {
    const evmAcct = await service.importPrivateKey({ chainType: 'evm', privateKey: RANDOM_EVM_KEY });
    expect(evmAcct).toMatchObject({ name: 'Imported 1', kind: 'privateKey' });
    expect(evmAcct.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(evmAcct.solanaAddress).toBeUndefined();

    const solSecret = solanaSecretFromSeed(RANDOM_SOL_SEED);
    // JSON byte-array format (solana-keygen).
    const solAcct = await service.importPrivateKey({
      chainType: 'solana',
      privateKey: JSON.stringify([...solSecret]),
      name: 'Phantom',
    });
    expect(solAcct).toMatchObject({ name: 'Phantom', solanaAddress: solanaAddressFromSecret(solSecret) });
    expect(await service.revealPrivateKey(solAcct.id, 'solana', PASSWORD)).toBe(bs58.encode(solSecret));
    expect((await service.solanaSigner(solAcct.id)).address).toBe(solAcct.solanaAddress);

    // Same EVM key again (different casing / no prefix).
    await expect(
      service.importPrivateKey({ chainType: 'evm', privateKey: RANDOM_EVM_KEY.slice(2).toUpperCase() }),
    ).rejects.toThrow('This account is already in the wallet (Imported 1)');
    // Key of an account derived from the seed.
    await expect(service.importPrivateKey({ chainType: 'evm', privateKey: ANVIL_0_KEY })).rejects.toThrow(
      'This account is already in the wallet (Account 1)',
    );
    const derivedSol = deriveSolanaSecretKey(mnemonicToSeed(MNEMONIC), 0);
    await expect(service.importPrivateKey({ chainType: 'solana', privateKey: bs58.encode(derivedSol) })).rejects.toThrow(
      'This account is already in the wallet (Account 1)',
    );
    // Hex 32-byte seed form of the already-imported Solana key.
    await expect(service.importPrivateKey({ chainType: 'solana', privateKey: bytesToHex(RANDOM_SOL_SEED) })).rejects.toThrow(
      'already in the wallet (Phantom)',
    );
    await expect(service.importPrivateKey({ chainType: 'evm', privateKey: '0x00' })).rejects.toThrow('Invalid EVM private key');

    // Secrets are persisted: survive lock/unlock.
    await service.lock();
    await service.unlock(PASSWORD);
    expect(await service.revealPrivateKey(evmAcct.id, 'evm', PASSWORD)).toBe(RANDOM_EVM_KEY);
    expect((await service.getState()).accounts.map((a) => a.name)).toEqual(['Account 1', 'Imported 1', 'Phantom']);
  });

  it('rename / hide / select accounts', async () => {
    const a2 = await service.addAccount({ seedId });
    await service.renameAccount(a2.id, '  Trading  ');
    await expect(service.renameAccount(a2.id, '   ')).rejects.toThrow('Name is required');
    await expect(service.renameAccount('nope', 'x')).rejects.toThrow('Unknown account');
    await service.setAccountHidden(a2.id, true);
    expect(await service.getAccount(a2.id)).toMatchObject({ name: 'Trading', hidden: true });
    await service.setAccountHidden(a2.id, false);
    expect((await service.getAccount(a2.id)).hidden).toBe(false);

    await service.selectAccount(firstId);
    expect((await service.getState()).selectedAccountId).toBe(firstId);
    await expect(service.selectAccount('nope')).rejects.toThrow('Unknown account');
    await expect(service.getAccount('nope')).rejects.toThrow('Unknown account');

    await service.renameSeed(seedId, ' Main ');
    expect((await service.getState()).seeds[0].name).toBe('Main');
    await expect(service.renameSeed(seedId, '')).rejects.toThrow('Name is required');
    await expect(service.renameSeed('nope', 'x')).rejects.toThrow('Unknown wallet');
  });

  it('removeAccount: cannot remove the last account; selection moves; imported key secret is deleted', async () => {
    await expect(service.removeAccount(firstId)).rejects.toThrow('Cannot remove the only account');
    await expect(service.removeAccount('nope')).rejects.toThrow('Unknown account');

    const imported = await service.importPrivateKey({ chainType: 'evm', privateKey: RANDOM_EVM_KEY });
    expect((await service.getState()).selectedAccountId).toBe(imported.id);
    await service.removeAccount(imported.id);
    const st = await service.getState();
    expect(st.accounts.map((a) => a.id)).toEqual([firstId]);
    expect(st.selectedAccountId).toBe(firstId);

    // The key was removed from the vault, so re-importing works and yields a single secret.
    await service.lock();
    await service.unlock(PASSWORD);
    const again = await service.importPrivateKey({ chainType: 'evm', privateKey: RANDOM_EVM_KEY });
    expect(await service.revealPrivateKey(again.id, 'evm', PASSWORD)).toBe(RANDOM_EVM_KEY);
    await expect(service.revealPrivateKey(imported.id, 'evm', PASSWORD)).rejects.toThrow('Unknown account');
  });

  it('removeSeed removes its accounts and secrets', async () => {
    await expect(service.removeSeed(seedId)).rejects.toThrow('Cannot remove the only wallet');
    await expect(service.removeSeed('nope')).rejects.toThrow('Unknown wallet');

    const { seed: seed2, account: s2a1 } = await service.addSeed({ mnemonic: MNEMONIC_2 });
    const s2a2 = await service.addAccount({ seedId: seed2.id });
    const imported = await service.importPrivateKey({ chainType: 'evm', privateKey: RANDOM_EVM_KEY });
    await service.selectAccount(s2a2.id);

    await service.removeSeed(seed2.id);
    let st = await service.getState();
    expect(st.seeds.map((s) => s.id)).toEqual([seedId]);
    expect(st.accounts.map((a) => a.id)).toEqual([firstId, imported.id]);
    expect(st.selectedAccountId).toBe(firstId);
    await expect(service.revealMnemonic(seed2.id, PASSWORD)).rejects.toThrow('Unknown wallet');
    expect([s2a1.id, s2a2.id].some((id) => st.accounts.some((a) => a.id === id))).toBe(false);

    // Persisted: after re-unlock the phrase is gone and can be re-imported.
    await service.lock();
    await service.unlock(PASSWORD);
    await expect(service.revealMnemonic(seed2.id, PASSWORD)).rejects.toThrow('Unknown wallet');
    await service.addSeed({ mnemonic: MNEMONIC_2 });

    // A wallet consisting of only private-key accounts can lose its last seed.
    await service.removeSeed(seedId);
    st = await service.getState();
    expect(st.seeds).toHaveLength(1);
    expect(st.accounts.some((a) => a.id === imported.id)).toBe(true);
  });

  it('revealMnemonic / revealPrivateKey require the correct password', async () => {
    await expect(service.revealMnemonic(seedId, 'wrong password')).rejects.toThrow('Incorrect password');
    await expect(service.revealPrivateKey(firstId, 'evm', 'wrong password')).rejects.toThrow('Incorrect password');
    expect(await service.revealMnemonic(seedId, PASSWORD)).toBe(MNEMONIC);
    expect(await service.revealPrivateKey(firstId, 'evm', PASSWORD)).toBe(ANVIL_0_KEY);
    expect(await service.revealPrivateKey(firstId, 'solana', PASSWORD)).toBe(
      bs58.encode(deriveSolanaSecretKey(mnemonicToSeed(MNEMONIC), 0)),
    );
    await expect(service.revealMnemonic('nope', PASSWORD)).rejects.toThrow('Unknown wallet');

    const a2 = await service.addAccount({ seedId });
    expect(await service.revealPrivateKey(a2.id, 'evm', PASSWORD)).toBe(deriveEvmPrivateKey(mnemonicToSeed(MNEMONIC), 1));

    // Even with the right password, the wallet must be unlocked.
    await service.lock();
    await expect(service.revealMnemonic(seedId, PASSWORD)).rejects.toThrow('Wallet is locked');
  });
});

describe('WalletService: settings & networks', () => {
  let service: WalletService;

  const customEvm: EvmNetwork = {
    type: 'evm',
    id: 'my-chain',
    name: 'My Chain',
    chainId: 999_999,
    rpcUrl: 'http://127.0.0.1:8545',
    explorerUrl: '',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    history: { kind: 'none' },
    testnet: false,
    enabled: true,
  };

  beforeEach(async () => {
    ({ service } = await created());
  });

  it('updateSettings validates and merges', async () => {
    await expect(service.updateSettings({ autoLockMinutes: 0 })).rejects.toThrow('Auto-lock must be between 1 and 1440 minutes');
    await expect(service.updateSettings({ autoLockMinutes: 1441 })).rejects.toThrow('Auto-lock');
    await expect(service.updateSettings({ slippageBps: 0 })).rejects.toThrow('Slippage must be between 0.01% and 50%');
    await expect(service.updateSettings({ slippageBps: 5001 })).rejects.toThrow('Slippage');

    const defaults = await service.getSettings();
    const next = await service.updateSettings({
      autoLockMinutes: 60,
      slippageBps: 100,
      hideZeroBalances: true,
      apis: { ...defaults.apis, lifiApiKey: 'k' },
    });
    expect(next).toMatchObject({ autoLockMinutes: 60, slippageBps: 100, hideZeroBalances: true });
    expect(next.apis).toEqual({ ...defaults.apis, lifiApiKey: 'k' });
    expect(await service.getSettings()).toEqual(next);
    // Boundaries are inclusive.
    await service.updateSettings({ autoLockMinutes: 1, slippageBps: 1 });
    await service.updateSettings({ autoLockMinutes: 1440, slippageBps: 5000 });
  });

  it('upsertNetwork adds/updates and validates', async () => {
    await service.upsertNetwork(customEvm);
    expect(await service.getNetwork('my-chain')).toEqual({ ...customEvm, custom: true });
    await service.upsertNetwork({ ...customEvm, name: 'Renamed' });
    const s = await service.getSettings();
    expect(s.networks.filter((n) => n.id === 'my-chain')).toHaveLength(1);
    expect((await service.getNetwork('my-chain')).name).toBe('Renamed');

    await expect(service.upsertNetwork({ ...customEvm, id: 'Bad Id' })).rejects.toThrow('Id must be lowercase');
    await expect(service.upsertNetwork({ ...customEvm, id: 'other', chainId: 1 })).rejects.toThrow(
      'Chain ID 1 is already used by Ethereum',
    );
    await expect(service.upsertNetwork({ ...customEvm, rpcUrl: 'ws://x' })).rejects.toThrow('RPC URL must start with http');

    const sol: SolanaNetwork = {
      type: 'solana',
      id: 'sol-local',
      name: 'Local',
      cluster: 'custom',
      rpcUrl: 'http://127.0.0.1:8899',
      explorerUrl: '',
      nativeCurrency: { name: 'Solana', symbol: 'SOL', decimals: 9 },
      testnet: true,
      enabled: true,
    };
    await service.upsertNetwork(sol);
    expect((await service.getNetwork('sol-local')).custom).toBe(true);

    // Editing a built-in keeps custom=false.
    const eth = await service.getNetwork('eth');
    await service.upsertNetwork({ ...eth, rpcUrl: 'https://my-eth-rpc.example' });
    expect(await service.getNetwork('eth')).toMatchObject({ rpcUrl: 'https://my-eth-rpc.example', custom: false });
    await expect(service.getNetwork('nope')).rejects.toThrow('Unknown network: nope');
  });

  it('removeNetwork and resetNetwork', async () => {
    await service.upsertNetwork(customEvm);
    await service.updateSettings({ selectedNetworkId: 'my-chain' });
    await service.removeNetwork('my-chain');
    const s = await service.getSettings();
    expect(s.networks.some((n) => n.id === 'my-chain')).toBe(false);
    expect(s.selectedNetworkId).toBe('all');
    await expect(service.removeNetwork('my-chain')).rejects.toThrow('Unknown network');

    const eth = await service.getNetwork('eth');
    await service.upsertNetwork({ ...eth, rpcUrl: 'https://my-eth-rpc.example', enabled: false });
    await service.resetNetwork('eth');
    expect(await service.getNetwork('eth')).toEqual({ ...DEFAULT_NETWORKS.find((n) => n.id === 'eth'), custom: false });

    // A removed built-in can be restored.
    await service.removeNetwork('base');
    await service.resetNetwork('base');
    expect((await service.getNetwork('base')).rpcUrl).toBe(DEFAULT_NETWORKS.find((n) => n.id === 'base')!.rpcUrl);
    await expect(service.resetNetwork('my-chain')).rejects.toThrow('Not a built-in network');

    // Cannot remove the last network.
    for (const n of (await service.getSettings()).networks.slice(1)) await service.removeNetwork(n.id);
    const last = (await service.getSettings()).networks;
    expect(last).toHaveLength(1);
    await expect(service.removeNetwork(last[0].id)).rejects.toThrow('Cannot remove the last network');
  });

  it('activeNetworks respects enabled and showTestnets', async () => {
    const ids = async () => (await service.activeNetworks()).map((n) => n.id);
    expect(await ids()).not.toContain('sepolia');
    expect(await ids()).toContain('eth');
    await service.updateSettings({ showTestnets: true });
    expect(await ids()).toContain('sepolia');
    const eth = await service.getNetwork('eth');
    await service.upsertNetwork({ ...eth, enabled: false });
    expect(await ids()).not.toContain('eth');
  });
});

describe('WalletService: custom tokens', () => {
  let service: WalletService;
  const evmToken: Token = {
    networkId: 'eth',
    address: '0x5aeda56215b167893e80b4fe645ba6d5bab767de',
    symbol: 'LINKX',
    name: 'Some Token',
    decimals: 18,
  };

  beforeEach(async () => {
    ({ service } = await created());
  });

  it('adds, de-duplicates and removes custom tokens', async () => {
    await service.addCustomToken(evmToken);
    const list = await service.getCustomTokens();
    expect(list).toEqual([{ ...evmToken, address: '0x5AEDA56215b167893e80B4fE645BA6d5Bab767DE', custom: true }]);
    await expect(
      service.addCustomToken({ ...evmToken, address: evmToken.address.toUpperCase().replace('0X', '0x') }),
    ).rejects.toThrow('Token already added');
    // Same address on another network is a different token.
    await service.addCustomToken({ ...evmToken, networkId: 'base' });
    expect(await service.getCustomTokens()).toHaveLength(2);

    const tokens = await service.getTokens('eth');
    expect(tokens[0]).toMatchObject({ address: 'native', symbol: 'ETH' });
    expect(tokens.some((t) => t.symbol === 'USDC')).toBe(true);
    expect(tokens.some((t) => t.symbol === 'LINKX' && t.custom)).toBe(true);

    await expect(service.addCustomToken({ ...evmToken, address: 'not-an-address' })).rejects.toThrow('Invalid token address');
    await expect(service.addCustomToken({ ...evmToken, networkId: 'nope' })).rejects.toThrow('Unknown network');
    await expect(service.addCustomToken({ ...evmToken, networkId: 'solana' })).rejects.toThrow('Invalid token address');

    // Remove is case-insensitive for EVM.
    await service.removeCustomToken('eth', evmToken.address.toUpperCase().replace('0X', '0x'));
    expect((await service.getCustomTokens()).map((t) => t.networkId)).toEqual(['base']);
  });

  it('handles Solana mints', async () => {
    const mint = 'So11111111111111111111111111111111111111112';
    await service.addCustomToken({ networkId: 'solana', address: mint, symbol: 'WSOL', name: 'Wrapped SOL', decimals: 9 });
    await expect(
      service.addCustomToken({ networkId: 'solana', address: mint, symbol: 'X', name: 'X', decimals: 9 }),
    ).rejects.toThrow('Token already added');
    expect((await service.getTokens('solana')).some((t) => t.address === mint && t.custom)).toBe(true);
    await service.removeCustomToken('solana', mint);
    expect(await service.getCustomTokens()).toEqual([]);
  });
});

describe('WalletService: permissions', () => {
  it('set / revoke and cleanup on account removal', async () => {
    const { service } = await created();
    const st = await service.getState();
    const a1 = st.accounts[0].id;
    const a2 = (await service.addAccount({ seedId: st.seeds[0].id })).id;
    const perm = (origin: string, accountIds: string[]): Permission => ({ origin, accountIds, connectedAt: 1 });

    await service.setPermission(perm('https://a.example', [a1, a2]));
    await service.setPermission(perm('https://b.example', [a2]));
    await service.setPermission({ ...perm('https://c.example', [a1]), evmNetworkId: 'base' });
    expect(Object.keys(await service.getPermissions()).sort()).toEqual([
      'https://a.example',
      'https://b.example',
      'https://c.example',
    ]);
    expect(await service.getPermission('https://c.example')).toEqual({
      ...perm('https://c.example', [a1]),
      evmNetworkId: 'base',
    });

    await service.revokePermission('https://c.example');
    expect(await service.getPermission('https://c.example')).toBeUndefined();
    await service.revokePermission('https://never.example'); // no-op

    await service.removeAccount(a2);
    const all = await service.getPermissions();
    expect(all['https://a.example'].accountIds).toEqual([a1]);
    // Origins left with no accounts are dropped.
    expect(all['https://b.example']).toBeUndefined();
  });

  it('removeSeed cleans up permissions of its accounts', async () => {
    const { service } = await created();
    const a1 = (await service.getState()).accounts[0].id;
    const { seed, account } = await service.addSeed({ mnemonic: MNEMONIC_2 });
    await service.setPermission({ origin: 'https://x.example', accountIds: [account.id], connectedAt: 1 });
    await service.setPermission({ origin: 'https://y.example', accountIds: [a1, account.id], connectedAt: 1 });
    await service.removeSeed(seed.id);
    const all = await service.getPermissions();
    expect(all['https://x.example']).toBeUndefined();
    expect(all['https://y.example'].accountIds).toEqual([a1]);
  });
});

describe('WalletService: resetWallet & events', () => {
  it('resetWallet wipes everything', async () => {
    const { service, store, session } = await created();
    await service.setPermission({ origin: 'https://a.example', accountIds: ['x'], connectedAt: 1 });
    await service.updateSettings({ autoLockMinutes: 5 });
    await service.resetWallet();
    expect(service.isUnlocked()).toBe(false);
    expect(await service.isInitialized()).toBe(false);
    expect(await session.get('sessionKey')).toBeUndefined();
    expect(await store.get('wallet')).toBeUndefined();
    const st = await service.getState();
    expect(st.accounts).toEqual([]);
    expect(st.settings.autoLockMinutes).toBe(15);
    expect(await service.getPermissions()).toEqual({});
    // Can set up again afterwards.
    await service.createWallet({ password: PASSWORD, mnemonic: MNEMONIC_2 });
    expect((await service.getState()).accounts[0].evmAddress).toBe(deriveAddresses(MNEMONIC_2, 0).evmAddress);
  });

  it('emits onChange events and supports unsubscribe', async () => {
    const { service } = makeService();
    const events: Event[] = [];
    const off = service.onChange((e) => events.push(e));

    await service.createWallet({ password: PASSWORD, mnemonic: MNEMONIC });
    expect(events).toEqual(['unlock']);
    const st = await service.getState();

    events.length = 0;
    await service.addAccount({ seedId: st.seeds[0].id });
    expect(events).toEqual(['accounts']);

    events.length = 0;
    await service.updateSettings({ autoLockMinutes: 30 });
    await service.upsertNetwork({ ...(await service.getNetwork('eth')), enabled: false });
    expect(events).toEqual(['settings', 'settings']);

    events.length = 0;
    await service.lock();
    await service.unlock(PASSWORD);
    expect(events).toEqual(['lock', 'unlock']);

    events.length = 0;
    await service.renameAccount(st.accounts[0].id, 'Renamed');
    await service.selectAccount(st.accounts[0].id);
    expect(events).toEqual(['accounts', 'accounts']);

    off();
    events.length = 0;
    await service.lock();
    expect(events).toEqual([]);
  });
});
