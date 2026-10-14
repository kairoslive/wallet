import type { Hex, TransactionRequest } from 'viem';
import { PublicKey, type Keypair } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  decryptVault,
  decryptWithKey,
  encryptVault,
  encryptWithKey,
  exportKey,
  importKey,
  type EncryptedVault,
} from '../crypto/vault';
import {
  deriveEvmPrivateKey,
  deriveSolanaSecretKey,
  evmAddressFromPrivateKey,
  generateMnemonic,
  isValidMnemonic,
  mnemonicToSeed,
  normalizeMnemonic,
  parseEvmPrivateKey,
  parseSolanaPrivateKey,
  solanaAddressFromSecret,
} from '../keyring/derive';
import bs58 from 'bs58';
import { bytesToHex } from '@noble/hashes/utils.js';
import { isValidAddress, normalizeAddress, sameAddress } from '../address';
import * as evm from '../evm/client';
import * as sol from '../solana/client';
import { fetchEvmHistory } from '../history/evm';
import { fetchSolanaHistory } from '../history/solana';
import { mergeHistory } from '../history/merge';
import { fetchPrices, lookupPrice, priceKey } from '../prices';
import { formatAmount, formatUnits, parseUnits, toUsd } from '../format';
import { defaultTokens, mergeTokens, nativeToken, tokenKey } from '../tokens';
import { DEFAULT_NETWORKS, validateNetwork } from '../networks';
import { discoverEvmTokens, fetchSolanaTokenMeta } from '../discovery';
import { getLifiQuote, getLifiStatus, listLifiTokens, type LifiConfig } from '../swap/lifi';
import { buildJupiterSwapTx, getJupiterQuote } from '../swap/jupiter';
import type { BridgeStatus, ListedToken, QuoteRequest, SwapQuote } from '../swap/types';
import type { KVStore } from '../storage';
import type { Fetch } from '../http';
import type {
  Account,
  ChainType,
  Contact,
  EvmNetwork,
  Network,
  Permission,
  SeedMeta,
  Settings,
  SolanaNetwork,
  Token,
  TokenBalance,
  TxRecord,
  VaultSecrets,
} from '../types';
import { defaultSettings } from './defaults';
import { Mutex } from './mutex';

const K = {
  vault: 'vault',
  wallet: 'wallet',
  settings: 'settings',
  customTokens: 'customTokens',
  txs: 'txs',
  permissions: 'permissions',
  portfolioCache: 'portfolioCache',
  tokenMeta: 'tokenMeta',
  sessionKey: 'sessionKey',
  contacts: 'contacts',
} as const;

const MAX_TXS = 500;

interface WalletData {
  seeds: SeedMeta[];
  accounts: Account[];
  selectedAccountId?: string;
}

export interface WalletState {
  initialized: boolean;
  unlocked: boolean;
  seeds: SeedMeta[];
  accounts: Account[];
  selectedAccountId?: string;
  settings: Settings;
}

export interface Portfolio {
  accountId: string;
  balances: TokenBalance[];
  totalUsd: number;
  errors: Record<string, string>;
  updatedAt: number;
}

export interface SendParams {
  accountId: string;
  networkId: string;
  token: Token;
  to: string;
  /** Human-readable decimal amount. */
  amount: string;
}

export interface SendPreview {
  fee: string;
  feeSymbol: string;
  feeDecimals: number;
  feeUsd?: number;
  amountBase: string;
  /** Extra cost such as Solana token-account rent. */
  extra?: { amount: string; label: string };
  warnings: string[];
}

export interface WalletServiceOptions {
  store: KVStore;
  /** Volatile storage that survives service-worker restarts but not browser restarts. */
  session?: KVStore;
  fetchFn?: Fetch;
  pbkdf2Iterations?: number;
}

export class WalletService {
  private key?: CryptoKey;
  private secrets?: VaultSecrets;
  private mutex = new Mutex();
  /** Bumped on every lock, so an in-flight session restore can't resurrect secrets after a lock. */
  private lockEpoch = 0;
  private readonly store: KVStore;
  private readonly session?: KVStore;
  private readonly fetchFn: Fetch;
  private readonly iterations?: number;
  private tokenListCache = new Map<string, { at: number; tokens: ListedToken[] }>();
  /** Listeners notified when accounts/lock state change (used for dApp events). */
  private listeners = new Set<(event: 'lock' | 'unlock' | 'accounts' | 'settings') => void>();

  constructor(opts: WalletServiceOptions) {
    this.store = opts.store;
    this.session = opts.session;
    this.fetchFn = opts.fetchFn ?? ((...a) => fetch(...a));
    this.iterations = opts.pbkdf2Iterations;
  }

  onChange(fn: (event: 'lock' | 'unlock' | 'accounts' | 'settings') => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(event: 'lock' | 'unlock' | 'accounts' | 'settings') {
    for (const l of this.listeners) l(event);
  }

  // ---------------------------------------------------------------- state

  async isInitialized(): Promise<boolean> {
    return (await this.store.get(K.vault)) !== undefined;
  }

  isUnlocked(): boolean {
    return !!this.secrets;
  }

  async getState(): Promise<WalletState> {
    const data = await this.walletData();
    return {
      initialized: await this.isInitialized(),
      unlocked: this.isUnlocked(),
      seeds: data.seeds,
      accounts: data.accounts,
      selectedAccountId: data.selectedAccountId,
      settings: await this.getSettings(),
    };
  }

  private async walletData(): Promise<WalletData> {
    return (await this.store.get<WalletData>(K.wallet)) ?? { seeds: [], accounts: [] };
  }

  private async saveWalletData(d: WalletData) {
    await this.store.set(K.wallet, d);
    this.emit('accounts');
  }

  async getSettings(): Promise<Settings> {
    const saved = await this.store.get<Settings>(K.settings);
    const defaults = defaultSettings();
    if (!saved) return defaults;
    return { ...defaults, ...saved, apis: { ...defaults.apis, ...saved.apis } };
  }

  private requireUnlocked(): VaultSecrets {
    if (!this.secrets) throw new Error('Wallet is locked');
    return this.secrets;
  }

  private async persistSecrets(secrets: VaultSecrets) {
    if (!this.key) throw new Error('Wallet is locked');
    const old = await this.store.get<EncryptedVault>(K.vault);
    if (!old) throw new Error('Wallet not initialized');
    await this.store.set(K.vault, await encryptWithKey(this.key, secrets, old.kdf));
    this.secrets = secrets;
  }

  // ---------------------------------------------------------------- lifecycle

  generateMnemonic(words: 12 | 24 = 12): string {
    return generateMnemonic(words);
  }

  validateMnemonic(m: string): boolean {
    return isValidMnemonic(m);
  }

  /** First-run setup with either a recovery phrase or a single private key. */
  async createWallet(params: {
    password: string;
    mnemonic?: string;
    privateKey?: { chainType: ChainType; key: string };
    backedUp?: boolean;
  }): Promise<WalletState> {
    return this.mutex.run(async () => {
      if (await this.isInitialized()) throw new Error('Wallet already exists');
      if (params.password.length < 8) throw new Error('Password must be at least 8 characters');
      const secrets: VaultSecrets = { seeds: [], keys: [] };
      const data: WalletData = { seeds: [], accounts: [] };
      if (params.privateKey) {
        const acct = this.buildImportedAccount(secrets, params.privateKey.chainType, params.privateKey.key, 'Account 1');
        data.accounts.push(acct);
      } else {
        const mnemonic = params.mnemonic ?? generateMnemonic();
        const { seed, account } = this.buildSeed(secrets, mnemonic, 'Wallet 1', 1, params.backedUp ?? true);
        data.seeds.push(seed);
        data.accounts.push(account);
      }
      data.selectedAccountId = data.accounts[0].id;
      const { vault, key } = await encryptVault(params.password, secrets, this.iterations);
      await this.store.set(K.vault, vault);
      await this.store.set(K.wallet, data);
      await this.setSession(key, secrets);
      this.emit('unlock');
      return this.getState();
    });
  }

  async unlock(password: string): Promise<void> {
    // Serialized with secret writes so a concurrent persistSecrets can't be overwritten by an older copy.
    await this.mutex.run(async () => {
      const vault = await this.store.get<EncryptedVault>(K.vault);
      if (!vault) throw new Error('Wallet not initialized');
      const { value, key } = await decryptVault<VaultSecrets>(password, vault);
      await this.setSession(key, value);
    });
    this.emit('unlock');
  }

  async verifyPassword(password: string): Promise<void> {
    const vault = await this.store.get<EncryptedVault>(K.vault);
    if (!vault) throw new Error('Wallet not initialized');
    await decryptVault(password, vault);
  }

  private async setSession(key: CryptoKey, secrets: VaultSecrets) {
    this.key = key;
    this.secrets = secrets;
    await this.session?.set(K.sessionKey, await exportKey(key));
  }

  /** Re-hydrates unlocked state after a service worker restart. Returns true if unlocked. */
  async restoreSession(): Promise<boolean> {
    if (this.secrets) return true;
    const epoch = this.lockEpoch;
    const raw = await this.session?.get<string>(K.sessionKey);
    const vault = await this.store.get<EncryptedVault>(K.vault);
    if (!raw || !vault) return false;
    try {
      const key = await importKey(raw);
      const secrets = await decryptWithKey<VaultSecrets>(key, vault);
      // A lock happened while we were restoring (e.g. the auto-lock alarm woke the worker): stay locked.
      if (epoch !== this.lockEpoch) return false;
      this.secrets = secrets;
      this.key = key;
      return true;
    } catch {
      await this.session?.remove(K.sessionKey);
      return false;
    }
  }

  async lock(): Promise<void> {
    this.lockEpoch++;
    this.key = undefined;
    this.secrets = undefined;
    await this.session?.remove(K.sessionKey);
    this.emit('lock');
  }

  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    return this.mutex.run(async () => {
      if (newPassword.length < 8) throw new Error('Password must be at least 8 characters');
      const vault = await this.store.get<EncryptedVault>(K.vault);
      if (!vault) throw new Error('Wallet not initialized');
      const { value } = await decryptVault<VaultSecrets>(oldPassword, vault);
      const { vault: next, key } = await encryptVault(newPassword, value, this.iterations ?? vault.kdf.iterations);
      await this.store.set(K.vault, next);
      // Only refresh the session if already unlocked; changing the password must not unlock the wallet.
      if (this.secrets) await this.setSession(key, value);
    });
  }

  async resetWallet(): Promise<void> {
    await this.mutex.run(async () => {
      await this.lock();
      await this.store.clear();
      await this.session?.clear();
    });
  }

  // ---------------------------------------------------------------- seeds & accounts

  private buildSeed(secrets: VaultSecrets, mnemonicIn: string, name: string, accountNumber: number, backedUp: boolean) {
    const mnemonic = normalizeMnemonic(mnemonicIn);
    if (!isValidMnemonic(mnemonic)) throw new Error('Invalid recovery phrase');
    if (secrets.seeds.some((s) => s.mnemonic === mnemonic)) throw new Error('This recovery phrase is already imported');
    const id = randomId();
    secrets.seeds.push({ id, mnemonic });
    const seed: SeedMeta = { id, name, createdAt: Date.now(), nextIndex: 1, backedUp };
    const account = this.deriveSeedAccount(mnemonic, id, 0, `Account ${accountNumber}`);
    return { seed, account };
  }

  private deriveSeedAccount(mnemonic: string, seedId: string, index: number, name: string): Account {
    const seed = mnemonicToSeed(mnemonic);
    return {
      id: randomId(),
      name,
      kind: 'seed',
      seedId,
      index,
      evmAddress: evmAddressFromPrivateKey(deriveEvmPrivateKey(seed, index)),
      solanaAddress: solanaAddressFromSecret(deriveSolanaSecretKey(seed, index)),
    };
  }

  private buildImportedAccount(secrets: VaultSecrets, chainType: ChainType, keyInput: string, name: string): Account {
    const id = randomId();
    if (chainType === 'evm') {
      const pk = parseEvmPrivateKey(keyInput);
      secrets.keys.push({ accountId: id, chainType, privateKey: pk });
      return { id, name, kind: 'privateKey', evmAddress: evmAddressFromPrivateKey(pk) };
    }
    const secret = parseSolanaPrivateKey(keyInput);
    secrets.keys.push({ accountId: id, chainType, privateKey: bs58.encode(secret) });
    return { id, name, kind: 'privateKey', solanaAddress: solanaAddressFromSecret(secret) };
  }

  /** Adds another recovery phrase (generated if omitted) with its first account. */
  async addSeed(params: { mnemonic?: string; name?: string; backedUp?: boolean } = {}) {
    return this.mutex.run(async () => {
      const secrets = structuredClone(this.requireUnlocked());
      const data = await this.walletData();
      const generated = !params.mnemonic;
      const mnemonic = params.mnemonic ?? generateMnemonic();
      const { seed, account } = this.buildSeed(
        secrets,
        mnemonic,
        params.name?.trim() || `Wallet ${data.seeds.length + 1}`,
        data.accounts.length + 1,
        params.backedUp ?? !generated,
      );
      this.assertNoDuplicate(data, account);
      await this.persistSecrets(secrets);
      data.seeds.push(seed);
      data.accounts.push(account);
      data.selectedAccountId = account.id;
      await this.saveWalletData(data);
      return { seed, account };
    });
  }

  async markSeedBackedUp(seedId: string) {
    return this.mutex.run(async () => {
      const data = await this.walletData();
      const seed = data.seeds.find((s) => s.id === seedId);
      if (!seed) throw new Error('Unknown wallet');
      seed.backedUp = true;
      await this.saveWalletData(data);
    });
  }

  /** Derives the next account from a seed. */
  async addAccount(params: { seedId: string; name?: string; index?: number }): Promise<Account> {
    return this.mutex.run(async () => {
      const secrets = this.requireUnlocked();
      const data = await this.walletData();
      const seed = data.seeds.find((s) => s.id === params.seedId);
      const secret = secrets.seeds.find((s) => s.id === params.seedId);
      if (!seed || !secret) throw new Error('Unknown wallet');
      const used = new Set(data.accounts.filter((a) => a.seedId === seed.id).map((a) => a.index));
      const name = params.name?.trim() || `Account ${data.accounts.length + 1}`;
      if (params.index !== undefined) {
        // Explicit index: lets users restore a removed account or match another wallet's numbering.
        if (!Number.isInteger(params.index) || params.index < 0 || params.index >= 2 ** 31)
          throw new Error('Invalid account index');
        if (used.has(params.index)) throw new Error(`Account index ${params.index} is already in this wallet`);
        const account = this.deriveSeedAccount(secret.mnemonic, seed.id, params.index, name);
        this.assertNoDuplicate(data, account);
        seed.nextIndex = Math.max(seed.nextIndex, params.index + 1);
        data.accounts.push(account);
        data.selectedAccountId = account.id;
        await this.saveWalletData(data);
        return account;
      }
      let index = seed.nextIndex;
      let account: Account;
      // Skip indexes already in use, including addresses the user imported as raw private keys.
      for (;;) {
        if (!used.has(index)) {
          account = this.deriveSeedAccount(secret.mnemonic, seed.id, index, name);
          const dup = data.accounts.some(
            (a) => sameAddress(a.evmAddress, account.evmAddress) || a.solanaAddress === account.solanaAddress,
          );
          if (!dup) break;
        }
        index++;
      }
      seed.nextIndex = index + 1;
      data.accounts.push(account);
      data.selectedAccountId = account.id;
      await this.saveWalletData(data);
      return account;
    });
  }

  async importPrivateKey(params: { chainType: ChainType; privateKey: string; name?: string }): Promise<Account> {
    return this.mutex.run(async () => {
      const secrets = structuredClone(this.requireUnlocked());
      const data = await this.walletData();
      const account = this.buildImportedAccount(
        secrets,
        params.chainType,
        params.privateKey,
        params.name?.trim() || `Imported ${data.accounts.filter((a) => a.kind === 'privateKey').length + 1}`,
      );
      this.assertNoDuplicate(data, account);
      await this.persistSecrets(secrets);
      data.accounts.push(account);
      data.selectedAccountId = account.id;
      await this.saveWalletData(data);
      return account;
    });
  }

  private assertNoDuplicate(data: WalletData, account: Account) {
    const dup = data.accounts.find(
      (a) =>
        (account.evmAddress && sameAddress(a.evmAddress, account.evmAddress)) ||
        (account.solanaAddress && a.solanaAddress === account.solanaAddress),
    );
    if (dup) throw new Error(`This account is already in the wallet (${dup.name})`);
  }

  async renameAccount(id: string, name: string) {
    return this.updateAccount(id, (a) => {
      if (!name.trim()) throw new Error('Name is required');
      a.name = name.trim();
    });
  }

  async setAccountHidden(id: string, hidden: boolean) {
    return this.mutex.run(async () => {
      const data = await this.walletData();
      const acct = data.accounts.find((a) => a.id === id);
      if (!acct) throw new Error('Unknown account');
      if (hidden && !data.accounts.some((a) => a.id !== id && !a.hidden))
        throw new Error('At least one account must stay visible');
      acct.hidden = hidden;
      // Don't leave a hidden account active.
      if (hidden && data.selectedAccountId === id) data.selectedAccountId = data.accounts.find((a) => !a.hidden)!.id;
      await this.saveWalletData(data);
    });
  }

  private async updateAccount(id: string, fn: (a: Account) => void) {
    return this.mutex.run(async () => {
      const data = await this.walletData();
      const acct = data.accounts.find((a) => a.id === id);
      if (!acct) throw new Error('Unknown account');
      fn(acct);
      await this.saveWalletData(data);
    });
  }

  async selectAccount(id: string) {
    return this.mutex.run(async () => {
      const data = await this.walletData();
      if (!data.accounts.some((a) => a.id === id)) throw new Error('Unknown account');
      data.selectedAccountId = id;
      await this.saveWalletData(data);
    });
  }

  async removeAccount(id: string) {
    return this.mutex.run(async () => {
      const data = await this.walletData();
      const acct = data.accounts.find((a) => a.id === id);
      if (!acct) throw new Error('Unknown account');
      if (data.accounts.length === 1) throw new Error('Cannot remove the only account');
      if (acct.kind === 'privateKey') {
        const secrets = structuredClone(this.requireUnlocked());
        secrets.keys = secrets.keys.filter((k) => k.accountId !== id);
        await this.persistSecrets(secrets);
      }
      data.accounts = data.accounts.filter((a) => a.id !== id);
      if (data.selectedAccountId === id) data.selectedAccountId = data.accounts[0].id;
      await this.saveWalletData(data);
      await this.dropAccountFromPermissions(id);
    });
  }

  async renameSeed(seedId: string, name: string) {
    return this.mutex.run(async () => {
      const data = await this.walletData();
      const seed = data.seeds.find((s) => s.id === seedId);
      if (!seed) throw new Error('Unknown wallet');
      if (!name.trim()) throw new Error('Name is required');
      seed.name = name.trim();
      await this.saveWalletData(data);
    });
  }

  /** Removes a recovery phrase and all accounts derived from it. */
  async removeSeed(seedId: string) {
    return this.mutex.run(async () => {
      const data = await this.walletData();
      if (!data.seeds.some((s) => s.id === seedId)) throw new Error('Unknown wallet');
      const remaining = data.accounts.filter((a) => a.seedId !== seedId);
      if (!remaining.length) throw new Error('Cannot remove the only wallet');
      const secrets = structuredClone(this.requireUnlocked());
      secrets.seeds = secrets.seeds.filter((s) => s.id !== seedId);
      await this.persistSecrets(secrets);
      const removed = data.accounts.filter((a) => a.seedId === seedId).map((a) => a.id);
      data.seeds = data.seeds.filter((s) => s.id !== seedId);
      data.accounts = remaining;
      if (!remaining.some((a) => a.id === data.selectedAccountId)) data.selectedAccountId = remaining[0].id;
      await this.saveWalletData(data);
      for (const id of removed) await this.dropAccountFromPermissions(id);
    });
  }

  async revealMnemonic(seedId: string, password: string): Promise<string> {
    await this.verifyPassword(password);
    const s = this.requireUnlocked().seeds.find((x) => x.id === seedId);
    if (!s) throw new Error('Unknown wallet');
    return s.mnemonic;
  }

  async revealPrivateKey(accountId: string, chainType: ChainType, password: string): Promise<string> {
    await this.verifyPassword(password);
    const acct = await this.getAccount(accountId);
    if (chainType === 'evm') return this.evmKey(acct);
    return bs58.encode(this.solanaSecret(acct));
  }

  async getAccount(id: string): Promise<Account> {
    const acct = (await this.walletData()).accounts.find((a) => a.id === id);
    if (!acct) throw new Error('Unknown account');
    return acct;
  }

  // ---------------------------------------------------------------- signing keys (in-memory only)

  private evmKey(acct: Account): Hex {
    const secrets = this.requireUnlocked();
    if (acct.kind === 'privateKey') {
      const k = secrets.keys.find((x) => x.accountId === acct.id && x.chainType === 'evm');
      if (!k) throw new Error('This account has no EVM key');
      return k.privateKey as Hex;
    }
    const s = secrets.seeds.find((x) => x.id === acct.seedId);
    if (!s || acct.index === undefined) throw new Error('Seed not found');
    return deriveEvmPrivateKey(mnemonicToSeed(s.mnemonic), acct.index);
  }

  private solanaSecret(acct: Account): Uint8Array {
    const secrets = this.requireUnlocked();
    if (acct.kind === 'privateKey') {
      const k = secrets.keys.find((x) => x.accountId === acct.id && x.chainType === 'solana');
      if (!k) throw new Error('This account has no Solana key');
      return bs58.decode(k.privateKey);
    }
    const s = secrets.seeds.find((x) => x.id === acct.seedId);
    if (!s || acct.index === undefined) throw new Error('Seed not found');
    return deriveSolanaSecretKey(mnemonicToSeed(s.mnemonic), acct.index);
  }

  private solanaKeypair(acct: Account): Keypair {
    return sol.keypairFromSecret(this.solanaSecret(acct));
  }

  /** Exposed for the dApp bridge: signs with the account's EVM key. */
  async evmSigner(accountId: string) {
    const acct = await this.getAccount(accountId);
    const pk = this.evmKey(acct);
    return {
      address: acct.evmAddress!,
      signMessage: (message: string | { raw: Hex }) => evm.signMessage(pk, message),
      signTypedData: (typed: Parameters<typeof evm.signTypedData>[1]) => evm.signTypedData(pk, typed),
      sendTransaction: (network: EvmNetwork, tx: TransactionRequest, fee?: evm.EvmFeeEstimate) =>
        evm.sendTx(network, pk, tx, fee),
      signTransaction: (network: EvmNetwork, tx: TransactionRequest) => evm.signTransaction(network, pk, tx),
    };
  }

  async solanaSigner(accountId: string) {
    const acct = await this.getAccount(accountId);
    const kp = this.solanaKeypair(acct);
    return {
      address: acct.solanaAddress!,
      keypair: kp,
      signMessage: (msg: Uint8Array) => sol.signMessage(kp.secretKey, msg),
    };
  }

  // ---------------------------------------------------------------- settings & networks

  async updateSettings(patch: Partial<Omit<Settings, 'networks'>>): Promise<Settings> {
    return this.mutex.run(async () => {
      const s = await this.getSettings();
      if (patch.autoLockMinutes !== undefined && (patch.autoLockMinutes < 1 || patch.autoLockMinutes > 1440)) {
        throw new Error('Auto-lock must be between 1 and 1440 minutes');
      }
      if (patch.slippageBps !== undefined && (patch.slippageBps < 1 || patch.slippageBps > 5000)) {
        throw new Error('Slippage must be between 0.01% and 50%');
      }
      const next: Settings = { ...s, ...patch, apis: { ...s.apis, ...(patch.apis ?? {}) } };
      await this.store.set(K.settings, next);
      this.emit('settings');
      return next;
    });
  }

  async getNetwork(id: string): Promise<Network> {
    const n = (await this.getSettings()).networks.find((x) => x.id === id);
    if (!n) throw new Error(`Unknown network: ${id}`);
    return n;
  }

  async upsertNetwork(network: Network, opts: { create?: boolean } = {}): Promise<Settings> {
    return this.mutex.run(async () => {
      const s = await this.getSettings();
      const errors = validateNetwork(network, s.networks);
      const idx = s.networks.findIndex((n) => n.id === network.id);
      if (opts.create && idx >= 0) errors.push(`The id "${network.id}" is already used by another network`);
      if (errors.length) throw new Error(errors.join('; '));
      const isDefault = DEFAULT_NETWORKS.some((n) => n.id === network.id);
      const next = { ...network, custom: !isDefault } as Network;
      if (idx >= 0) s.networks[idx] = next;
      else s.networks.push(next);
      await this.store.set(K.settings, s);
      this.emit('settings');
      return s;
    });
  }

  async removeNetwork(id: string): Promise<Settings> {
    return this.mutex.run(async () => {
      const s = await this.getSettings();
      if (!s.networks.some((n) => n.id === id)) throw new Error('Unknown network');
      if (s.networks.length === 1) throw new Error('Cannot remove the last network');
      s.networks = s.networks.filter((n) => n.id !== id);
      if (s.selectedNetworkId === id) s.selectedNetworkId = 'all';
      await this.store.set(K.settings, s);
      this.emit('settings');
      return s;
    });
  }

  async resetNetwork(id: string): Promise<Settings> {
    const def = DEFAULT_NETWORKS.find((n) => n.id === id);
    if (!def) throw new Error('Not a built-in network');
    return this.upsertNetwork(structuredClone(def));
  }

  /** Checks an RPC endpoint is reachable and (for EVM) reports its chain id. */
  async testRpc(type: ChainType, rpcUrl: string): Promise<{ ok: boolean; chainId?: number; error?: string }> {
    try {
      if (type === 'evm') return { ok: true, chainId: await evm.getChainId(rpcUrl) };
      await sol.connection({ rpcUrl } as SolanaNetwork).getLatestBlockhash();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async activeNetworks(): Promise<Network[]> {
    const s = await this.getSettings();
    return s.networks.filter((n) => n.enabled && (s.showTestnets || !n.testnet));
  }

  // ---------------------------------------------------------------- tokens

  async getCustomTokens(): Promise<Token[]> {
    return (await this.store.get<Token[]>(K.customTokens)) ?? [];
  }

  async getTokens(networkId: string): Promise<Token[]> {
    const n = await this.getNetwork(networkId);
    const custom = (await this.getCustomTokens()).filter((t) => t.networkId === networkId);
    return mergeTokens([nativeToken(n)], defaultTokens(networkId), custom);
  }

  async lookupToken(networkId: string, address: string): Promise<Token> {
    const n = await this.getNetwork(networkId);
    if (!isValidAddress(n.type, address)) throw new Error('Invalid token address');
    if (n.type === 'evm') {
      const meta = await evm.getTokenMetadata(n, normalizeAddress('evm', address));
      return { ...meta, networkId };
    }
    const mint = normalizeAddress('solana', address);
    const { decimals } = await sol.getMintInfo(n, mint);
    const s = await this.getSettings();
    const meta = await fetchSolanaTokenMeta(s.apis.jupiterUrl, [mint], this.fetchFn, s.apis.jupiterApiKey).catch(() => undefined);
    const m = meta?.get(mint);
    return {
      networkId,
      address: mint,
      decimals,
      symbol: m?.symbol ?? mint.slice(0, 4).toUpperCase(),
      name: m?.name ?? 'Unknown token',
      logoURI: m?.logoURI,
    };
  }

  async addCustomToken(token: Token): Promise<void> {
    return this.mutex.run(async () => {
      const n = await this.getNetwork(token.networkId);
      if (!isValidAddress(n.type, token.address)) throw new Error('Invalid token address');
      const list = await this.getCustomTokens();
      const t = { ...token, address: normalizeAddress(n.type, token.address), custom: true };
      if (list.some((x) => tokenKey(x) === tokenKey(t))) throw new Error('Token already added');
      list.push(t);
      await this.store.set(K.customTokens, list);
    });
  }

  async removeCustomToken(networkId: string, address: string): Promise<void> {
    return this.mutex.run(async () => {
      const list = await this.getCustomTokens();
      const key = tokenKey({ networkId, address });
      await this.store.set(
        K.customTokens,
        list.filter((t) => tokenKey(t) !== key),
      );
    });
  }

  /** Searches the swap provider's token list for a network (cached for 1 hour). */
  async searchTokens(networkId: string, query: string): Promise<Token[]> {
    const n = await this.getNetwork(networkId);
    const local = await this.getTokens(networkId);
    const q = query.trim().toLowerCase();
    const matches = (t: Pick<Token, 'symbol' | 'name' | 'address'>) =>
      !q || t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.address.toLowerCase() === q;
    let remote: Token[] = [];
    if (n.lifiChainId) {
      try {
        const cached = this.tokenListCache.get(networkId);
        let list = cached && Date.now() - cached.at < 3_600_000 ? cached.tokens : undefined;
        if (!list) {
          list = await listLifiTokens(await this.lifiConfig(), [n.lifiChainId]);
          this.tokenListCache.set(networkId, { at: Date.now(), tokens: list });
        }
        remote = list
          .filter((t) => !/^0x0{40}$/.test(t.address) && t.address !== '11111111111111111111111111111111')
          .map((t) => ({
            networkId,
            address: t.address,
            symbol: t.symbol,
            name: t.name,
            decimals: t.decimals,
            logoURI: t.logoURI,
          }));
      } catch {
        // Token list is a convenience; fall back to local tokens.
      }
    }
    const results = mergeTokens(local, remote).filter(matches);
    if (!results.length && isValidAddress(n.type, query.trim())) {
      try {
        return [await this.lookupToken(networkId, query.trim())];
      } catch {
        return [];
      }
    }
    return results.slice(0, 100);
  }

  // ---------------------------------------------------------------- balances

  addressFor(acct: Account, network: Network): string | undefined {
    return network.type === 'evm' ? acct.evmAddress : acct.solanaAddress;
  }

  async getCachedPortfolio(accountId: string): Promise<Portfolio | undefined> {
    const all = (await this.store.get<Record<string, Portfolio>>(K.portfolioCache)) ?? {};
    return all[accountId];
  }

  async getPortfolio(accountId: string, networkIds?: string[]): Promise<Portfolio> {
    const acct = await this.getAccount(accountId);
    const s = await this.getSettings();
    const networks = (networkIds ? s.networks.filter((n) => networkIds.includes(n.id)) : await this.activeNetworks()).filter(
      (n) => this.addressFor(acct, n),
    );
    const errors: Record<string, string> = {};
    const balances: TokenBalance[] = [];
    await Promise.all(
      networks.map(async (n) => {
        try {
          balances.push(...(await this.networkBalances(n, this.addressFor(acct, n)!)));
        } catch (e) {
          errors[n.id] = (e as Error).message;
        }
      }),
    );
    let prices: Record<string, number> = {};
    try {
      const keys = balances
        .map((b) =>
          priceKey(
            networks.find((n) => n.id === b.networkId)!,
            b,
          ),
        )
        .filter((k): k is string => !!k);
      prices = keys.length ? await fetchPrices(s.apis.pricesUrl, keys, this.fetchFn) : {};
    } catch (e) {
      errors.prices = (e as Error).message;
    }
    let totalUsd = 0;
    for (const b of balances) {
      const n = networks.find((x) => x.id === b.networkId)!;
      b.priceUsd = n.testnet ? undefined : lookupPrice(prices, priceKey(n, b));
      b.valueUsd = toUsd(b.balance, b.decimals, b.priceUsd);
      totalUsd += b.valueUsd ?? 0;
    }
    const order = new Map(s.networks.map((n, i) => [n.id, i]));
    balances.sort(
      (a, b) =>
        (b.valueUsd ?? 0) - (a.valueUsd ?? 0) ||
        (order.get(a.networkId) ?? 0) - (order.get(b.networkId) ?? 0) ||
        (a.address === 'native' ? -1 : b.address === 'native' ? 1 : a.symbol.localeCompare(b.symbol)),
    );
    const portfolio: Portfolio = { accountId, balances, totalUsd, errors, updatedAt: Date.now() };
    if (!networkIds) {
      const all = (await this.store.get<Record<string, Portfolio>>(K.portfolioCache)) ?? {};
      all[accountId] = portfolio;
      await this.store.set(K.portfolioCache, all);
    }
    return portfolio;
  }

  private async networkBalances(n: Network, address: string): Promise<TokenBalance[]> {
    const tokens = await this.getTokens(n.id);
    const out: TokenBalance[] = [];
    if (n.type === 'evm') {
      const [native, erc20, discovered] = await Promise.all([
        evm.getNativeBalance(n, address),
        evm.getTokenBalances(
          n,
          address,
          tokens.filter((t) => t.address !== 'native'),
        ),
        discoverEvmTokens(n, address, this.fetchFn).catch(() => []),
      ]);
      out.push({ ...nativeToken(n), balance: native.toString() });
      for (const t of tokens) {
        if (t.address === 'native') continue;
        const bal = erc20.get(t.address.toLowerCase());
        if (bal === undefined) continue;
        // Default (non-custom) tokens are only listed when held, to keep the list tidy.
        if (bal > 0n || t.custom) out.push({ ...t, balance: bal.toString() });
      }
      for (const d of discovered) {
        if (d.balance > 0n && !out.some((b) => tokenKey(b) === tokenKey(d.token))) {
          out.push({ ...d.token, balance: d.balance.toString() });
        }
      }
      return out;
    }
    const [native, holdings] = await Promise.all([sol.getNativeBalance(n, address), sol.getSplHoldings(n, address)]);
    out.push({ ...nativeToken(n), balance: native.toString() });
    const known = new Map(tokens.map((t) => [t.address, t]));
    const unknown = holdings.filter((h) => !known.has(h.mint) && h.amount > 0n).map((h) => h.mint);
    const meta = await this.solanaMeta(unknown);
    for (const h of holdings) {
      const t = known.get(h.mint);
      if (!t && h.amount === 0n) continue;
      const m = meta.get(h.mint);
      out.push({
        networkId: n.id,
        address: h.mint,
        decimals: h.decimals,
        symbol: t?.symbol ?? m?.symbol ?? `${h.mint.slice(0, 4)}…`,
        name: t?.name ?? m?.name ?? 'Unknown token',
        logoURI: t?.logoURI ?? m?.logoURI,
        custom: t?.custom,
        balance: h.amount.toString(),
      });
    }
    for (const t of tokens) {
      if (t.custom && !out.some((b) => b.address === t.address)) out.push({ ...t, balance: '0' });
    }
    return out;
  }

  /** Cached Solana token metadata lookups. */
  private async solanaMeta(mints: string[]): Promise<Map<string, Omit<Token, 'networkId'>>> {
    const cache = (await this.store.get<Record<string, Omit<Token, 'networkId'>>>(K.tokenMeta)) ?? {};
    const missing = mints.filter((m) => !cache[m]);
    if (missing.length) {
      try {
        const s = await this.getSettings();
        const fetched = await fetchSolanaTokenMeta(s.apis.jupiterUrl, missing, this.fetchFn, s.apis.jupiterApiKey);
        for (const [k, v] of fetched) cache[k] = v;
        await this.store.set(K.tokenMeta, cache);
      } catch {
        // Metadata is cosmetic.
      }
    }
    return new Map(mints.filter((m) => cache[m]).map((m) => [m, cache[m]]));
  }

  async getBalance(accountId: string, networkId: string, token: Pick<Token, 'address'>): Promise<bigint> {
    const acct = await this.getAccount(accountId);
    const n = await this.getNetwork(networkId);
    const address = this.addressFor(acct, n);
    if (!address) throw new Error(`${acct.name} has no ${n.type === 'evm' ? 'EVM' : 'Solana'} address`);
    if (n.type === 'evm') {
      if (token.address === 'native') return evm.getNativeBalance(n, address);
      const m = await evm.getTokenBalances(n, address, [{ address: token.address } as Token]);
      return m.get(token.address.toLowerCase()) ?? 0n;
    }
    if (token.address === 'native') return sol.getNativeBalance(n, address);
    const holdings = await sol.getSplHoldings(n, address);
    return holdings.find((h) => h.mint === token.address)?.amount ?? 0n;
  }

  // ---------------------------------------------------------------- sending

  private async resolveSend(p: SendParams) {
    const acct = await this.getAccount(p.accountId);
    const n = await this.getNetwork(p.networkId);
    const from = this.addressFor(acct, n);
    if (!from) throw new Error(`${acct.name} has no ${n.type === 'evm' ? 'EVM' : 'Solana'} address`);
    if (!isValidAddress(n.type, p.to)) throw new Error('Invalid recipient address');
    const to = normalizeAddress(n.type, p.to);
    const amount = parseUnits(p.amount, p.token.decimals);
    if (amount <= 0n) throw new Error('Amount must be greater than zero');
    return { acct, n, from, to, amount };
  }

  async previewSend(p: SendParams): Promise<SendPreview> {
    const { acct, n, from, to, amount } = await this.resolveSend(p);
    const warnings: string[] = [];
    if (sameAddress(from, to)) warnings.push('You are sending to your own address');
    const [balance, nativeBal] = await Promise.all([
      this.getBalance(acct.id, n.id, p.token),
      p.token.address === 'native' ? Promise.resolve(undefined) : this.getBalance(acct.id, n.id, { address: 'native' }),
    ]);
    if (amount > balance) throw new Error(`Insufficient ${p.token.symbol} balance`);
    let fee: bigint;
    let extra: SendPreview['extra'];
    if (n.type === 'evm') {
      const est = await evm.estimateTx(n, evm.buildTransferTx({ from, to, token: p.token, amount }));
      fee = est.fee;
    } else {
      const toInfo = await sol.connection(n).getAccountInfo(new PublicKey(to));
      if (toInfo && (toInfo.owner.equals(TOKEN_PROGRAM_ID) || toInfo.owner.equals(TOKEN_2022_PROGRAM_ID))) {
        throw new Error("That's a token account, not a wallet address. Ask the recipient for their wallet address.");
      }
      if (p.token.address !== 'native' && !PublicKey.isOnCurve(new PublicKey(to).toBytes())) {
        warnings.push(
          'This address is a program account, not a regular wallet. Make sure the recipient can access tokens sent to it.',
        );
      }
      const priority = await sol.getPriorityFee(n);
      const built = await sol.buildTransferTx(n, { from, to, token: p.token, amount, priorityMicroLamports: priority });
      fee = await sol.estimateFee(n, built.tx);
      if (built.rentLamports > 0n) {
        extra = {
          amount: built.rentLamports.toString(),
          label: 'Recipient token account rent',
        };
      }
      if (p.token.address === 'native' && to !== from) {
        const recipientBal = await sol.getNativeBalance(n, to);
        if (recipientBal === 0n && amount < 890_880n) {
          warnings.push('Recipient has no SOL; sends below the 0.00089 SOL rent minimum will fail');
        }
      }
    }
    const nativeNeeded = fee + BigInt(extra?.amount ?? 0) + (p.token.address === 'native' ? amount : 0n);
    const nativeHave = p.token.address === 'native' ? balance : nativeBal!;
    if (nativeNeeded > nativeHave) {
      throw new Error(`Insufficient ${n.nativeCurrency.symbol} to cover the network fee`);
    }
    let feeUsd: number | undefined;
    if (!n.testnet && n.nativePriceId) {
      const s = await this.getSettings();
      const prices = await fetchPrices(s.apis.pricesUrl, [n.nativePriceId], this.fetchFn).catch(() => ({}));
      feeUsd = toUsd(fee, n.nativeCurrency.decimals, lookupPrice(prices, n.nativePriceId));
    }
    return {
      fee: fee.toString(),
      feeSymbol: n.nativeCurrency.symbol,
      feeDecimals: n.nativeCurrency.decimals,
      feeUsd,
      amountBase: amount.toString(),
      extra,
      warnings,
    };
  }

  /** Largest amount of `token` that can be sent after reserving the network fee. */
  async maxSendable(accountId: string, networkId: string, token: Token, purpose: 'send' | 'swap' = 'send'): Promise<string> {
    const balance = await this.getBalance(accountId, networkId, token);
    if (token.address !== 'native') return formatUnits(balance, token.decimals);
    const acct = await this.getAccount(accountId);
    const n = await this.getNetwork(networkId);
    const from = this.addressFor(acct, n)!;
    let fee: bigint;
    if (n.type === 'evm') {
      const est = await evm.estimateTx(n, { from: from as Hex, to: from as Hex, value: 0n });
      // Leave headroom for base-fee movement; swaps and bridges cost far more gas than a plain transfer.
      fee = purpose === 'swap' ? (est.maxFeePerGas * 500_000n * 12n) / 10n : (est.fee * 12n) / 10n;
    } else {
      // Swaps may open token accounts (rent) and pay priority fees; transfers pay the base fee plus priority.
      const priority = await sol.getPriorityFee(n as SolanaNetwork);
      fee = purpose === 'swap' ? 10_000_000n : 5000n + sol.priorityFeeLamports(priority, sol.NATIVE_TRANSFER_CU);
    }
    const max = balance > fee ? balance - fee : 0n;
    return formatUnits(max, token.decimals);
  }

  async send(p: SendParams): Promise<TxRecord> {
    const { acct, n, from, to, amount } = await this.resolveSend(p);
    let hash: string;
    if (n.type === 'evm') {
      hash = await evm.sendTx(n, this.evmKey(acct), evm.buildTransferTx({ from, to, token: p.token, amount }));
    } else {
      const priority = await sol.getPriorityFee(n);
      const built = await sol.buildTransferTx(n, { from, to, token: p.token, amount, priorityMicroLamports: priority });
      hash = await sol.signAndSend(n, built.tx, this.solanaKeypair(acct));
    }
    const record: TxRecord = {
      hash,
      networkId: n.id,
      chainType: n.type,
      from,
      to,
      title: `Sent ${formatAmount(amount, p.token.decimals)} ${p.token.symbol}`,
      direction: sameAddress(from, to) ? 'self' : 'out',
      kind: 'send',
      amount: formatAmount(amount, p.token.decimals),
      symbol: p.token.symbol,
      timestamp: Date.now(),
      status: 'pending',
      source: 'local',
    };
    await this.recordTx(record);
    return record;
  }

  async waitForTx(networkId: string, hash: string): Promise<TxRecord['status']> {
    const n = await this.getNetwork(networkId);
    const status = n.type === 'evm' ? (await evm.waitForTx(n, hash as Hex)).status : await sol.waitForSignature(n, hash);
    await this.updateTx(networkId, hash, { status });
    return status;
  }

  // ---------------------------------------------------------------- history

  async recordTx(record: TxRecord): Promise<void> {
    return this.mutex.run(async () => {
      const txs = (await this.store.get<TxRecord[]>(K.txs)) ?? [];
      txs.unshift(record);
      await this.store.set(K.txs, txs.slice(0, MAX_TXS));
    });
  }

  private async updateTx(networkId: string, hash: string, patch: Partial<TxRecord>) {
    return this.mutex.run(async () => {
      const txs = (await this.store.get<TxRecord[]>(K.txs)) ?? [];
      const t = txs.find((x) => x.networkId === networkId && x.hash === hash);
      if (t) {
        Object.assign(t, patch);
        if (patch.bridge) t.bridge = { ...t.bridge, ...patch.bridge };
        await this.store.set(K.txs, txs);
      }
    });
  }

  async getLocalTxs(): Promise<TxRecord[]> {
    return (await this.store.get<TxRecord[]>(K.txs)) ?? [];
  }

  /** Checks pending local transactions (and in-flight bridges) and updates their status. */
  async refreshPending(): Promise<void> {
    const txs = await this.getLocalTxs();
    const s = await this.getSettings();
    await Promise.all(
      txs
        .filter((t) => t.status === 'pending' || (t.kind === 'bridge' && t.bridge?.status === 'PENDING'))
        .map(async (t) => {
          const n = s.networks.find((x) => x.id === t.networkId);
          if (!n) return;
          try {
            if (t.status === 'pending') {
              const st = n.type === 'evm' ? await evm.getTxStatus(n, t.hash as Hex) : await sol.getSignatureStatus(n, t.hash);
              if (st !== 'pending') await this.updateTx(t.networkId, t.hash, { status: st });
              else if (Date.now() - t.timestamp > 30 * 60_000) {
                // Solana blockhashes have long expired by now; an EVM tx only failed if the node dropped it.
                const gone = n.type === 'solana' || !(await evm.txKnown(n, t.hash as Hex));
                if (gone) await this.updateTx(t.networkId, t.hash, { status: 'failed' });
              }
            }
            if (t.kind === 'bridge' && t.bridge?.toNetworkId) {
              const to = s.networks.find((x) => x.id === t.bridge!.toNetworkId);
              if (n.lifiChainId && to?.lifiChainId) {
                const st = await getLifiStatus(await this.lifiConfig(), t.hash, n.lifiChainId, to.lifiChainId, t.bridge.tool);
                await this.updateTx(t.networkId, t.hash, {
                  bridge: { status: st.status === 'NOT_FOUND' ? 'PENDING' : st.status, receivingHash: st.receivingTxHash },
                });
              }
            }
          } catch {
            // Try again on the next refresh.
          }
        }),
    );
  }

  async getHistory(
    accountId: string,
    networkId?: string,
    opts: { localOnly?: boolean } = {},
  ): Promise<{ txs: TxRecord[]; errors: Record<string, string> }> {
    const acct = await this.getAccount(accountId);
    const networks = networkId ? [await this.getNetwork(networkId)] : await this.activeNetworks();
    if (opts.localOnly) {
      // Fast path for first paint: only what this wallet recorded itself.
      return { txs: mergeHistory(await this.localTxsFor(acct, networks), []), errors: {} };
    }
    await this.refreshPending();
    const errors: Record<string, string> = {};
    const indexed: TxRecord[] = [];
    const symbolCache = (await this.store.get<Record<string, { symbol: string }>>(K.tokenMeta)) ?? {};
    const custom = await this.getCustomTokens();
    await Promise.all(
      networks.map(async (n) => {
        const address = this.addressFor(acct, n);
        if (!address) return;
        try {
          if (n.type === 'evm') indexed.push(...(await fetchEvmHistory(n, address, this.fetchFn)));
          else {
            const known = mergeTokens(
              defaultTokens(n.id),
              custom.filter((t) => t.networkId === n.id),
            );
            const symbolFor = (mint: string) => known.find((t) => t.address === mint)?.symbol ?? symbolCache[mint]?.symbol;
            indexed.push(...(await fetchSolanaHistory(n, address, symbolFor)));
          }
        } catch (e) {
          errors[n.id] = (e as Error).message;
        }
      }),
    );
    return { txs: mergeHistory(await this.localTxsFor(acct, networks), indexed), errors };
  }

  private async localTxsFor(acct: Account, networks: Network[]): Promise<TxRecord[]> {
    const ids = new Set(networks.map((n) => n.id));
    const mine = (t: TxRecord) => {
      const n = networks.find((x) => x.id === t.networkId);
      const addr = n && this.addressFor(acct, n);
      return !!addr && (sameAddress(t.from, addr) || sameAddress(t.to, addr));
    };
    return (await this.getLocalTxs()).filter((t) => ids.has(t.networkId) && mine(t));
  }

  // ---------------------------------------------------------------- swaps & bridges

  private async lifiConfig(): Promise<LifiConfig> {
    const s = await this.getSettings();
    return { url: s.apis.lifiUrl, apiKey: s.apis.lifiApiKey, integrator: s.apis.lifiIntegrator, fetchFn: this.fetchFn };
  }

  async getQuote(params: {
    accountId: string;
    fromNetworkId: string;
    toNetworkId: string;
    fromToken: Token;
    toToken: Token;
    /** Human-readable amount. */
    amount: string;
    slippageBps?: number;
    toAddress?: string;
  }): Promise<SwapQuote> {
    const acct = await this.getAccount(params.accountId);
    const from = await this.getNetwork(params.fromNetworkId);
    const to = await this.getNetwork(params.toNetworkId);
    const s = await this.getSettings();
    const fromAddress = this.addressFor(acct, from);
    if (!fromAddress) throw new Error(`${acct.name} has no address on ${from.name}`);
    const toAddress = params.toAddress?.trim() || this.addressFor(acct, to);
    if (!toAddress) throw new Error(`Enter a destination address on ${to.name}`);
    if (!isValidAddress(to.type, toAddress)) throw new Error('Invalid destination address');
    const fromAmount = parseUnits(params.amount, params.fromToken.decimals);
    if (fromAmount <= 0n) throw new Error('Amount must be greater than zero');
    if (from.id === to.id && tokenKey(params.fromToken) === tokenKey(params.toToken)) {
      throw new Error('Choose two different tokens');
    }
    const balance = await this.getBalance(acct.id, from.id, params.fromToken);
    if (fromAmount > balance) throw new Error(`Insufficient ${params.fromToken.symbol} balance`);
    const req: QuoteRequest = {
      fromNetworkId: from.id,
      toNetworkId: to.id,
      fromToken: params.fromToken,
      toToken: params.toToken,
      fromAmount: fromAmount.toString(),
      fromAddress,
      toAddress: normalizeAddress(to.type, toAddress),
      slippageBps: params.slippageBps ?? s.slippageBps,
    };
    if (from.type === 'solana' && to.id === from.id && s.apis.solanaSwapProvider === 'jupiter') {
      if (from.cluster !== 'mainnet-beta') throw new Error('Swaps are only available on Solana mainnet');
      // Jupiter always pays out to the signer, so a different recipient can't be honoured.
      if (req.toAddress !== fromAddress) throw new Error('Jupiter swaps can only pay out to your own address');
      return getJupiterQuote({ url: s.apis.jupiterUrl, apiKey: s.apis.jupiterApiKey, fetchFn: this.fetchFn }, req);
    }
    return getLifiQuote(await this.lifiConfig(), from, to, req);
  }

  /** Executes a quote (approving first if needed) and records it in history. */
  async executeQuote(accountId: string, quote: SwapQuote): Promise<TxRecord> {
    const acct = await this.getAccount(accountId);
    const from = await this.getNetwork(quote.request.fromNetworkId);
    const to = await this.getNetwork(quote.request.toNetworkId);
    if (
      this.addressFor(acct, from) !== quote.request.fromAddress &&
      !sameAddress(this.addressFor(acct, from), quote.request.fromAddress)
    ) {
      throw new Error('Quote was created for a different account');
    }
    const isBridge = from.id !== to.id;
    const { fromToken, toToken } = quote.request;
    const title = isBridge
      ? `Bridged ${formatAmount(quote.request.fromAmount, fromToken.decimals)} ${fromToken.symbol} → ${to.name}`
      : `Swapped ${formatAmount(quote.request.fromAmount, fromToken.decimals)} ${fromToken.symbol} → ${formatAmount(quote.toAmount, toToken.decimals)} ${toToken.symbol}`;
    let hash: string;
    if (from.type === 'evm') {
      const pk = this.evmKey(acct);
      if (quote.approval) {
        const allowance = await evm.getAllowance(from, quote.approval.token, quote.request.fromAddress, quote.approval.spender);
        if (allowance < BigInt(quote.approval.amount)) {
          if (allowance > 0n) {
            // Tokens like USDT revert when changing one non-zero allowance to another; reset to zero first.
            const resetHash = await evm.sendTx(
              from,
              pk,
              evm.buildApproveTx(quote.request.fromAddress, quote.approval.token, quote.approval.spender, 0n),
            );
            if ((await this.waitForTx(from.id, resetHash).catch(() => 'failed')) !== 'confirmed') {
              throw new Error('Resetting the token allowance failed');
            }
          }
          const approveHash = await evm.sendTx(
            from,
            pk,
            evm.buildApproveTx(
              quote.request.fromAddress,
              quote.approval.token,
              quote.approval.spender,
              BigInt(quote.approval.amount),
            ),
          );
          await this.recordTx({
            hash: approveHash,
            networkId: from.id,
            chainType: 'evm',
            from: quote.request.fromAddress,
            to: quote.approval.token,
            title: `Approved ${fromToken.symbol}`,
            direction: 'out',
            kind: 'approve',
            timestamp: Date.now(),
            status: 'pending',
            source: 'local',
          });
          const st = await this.waitForTx(from.id, approveHash);
          if (st !== 'confirmed') throw new Error('Token approval failed');
        }
      }
      const tx = quote.evmTx!;
      if (tx.chainId !== undefined && tx.chainId !== (from as EvmNetwork).chainId) {
        throw new Error('The route returned a transaction for a different chain');
      }
      hash = await evm.sendTx(from, pk, {
        from: quote.request.fromAddress as Hex,
        to: tx.to as Hex,
        data: tx.data as Hex,
        value: BigInt(tx.value),
        gas: tx.gas ? BigInt(tx.gas) : undefined,
      });
    } else {
      // Solana transactions embed a blockhash that expires in about a minute. Never swap in a different
      // quote than the one the user reviewed; ask them to refresh instead.
      if (quote.provider === 'lifi' && Date.now() - quote.createdAt > 50_000) {
        throw new Error('This quote has expired. Refresh it and review the new price.');
      }
      let b64 = quote.solanaTx;
      if (quote.provider === 'jupiter') {
        const s = await this.getSettings();
        b64 = await buildJupiterSwapTx({ url: s.apis.jupiterUrl, apiKey: s.apis.jupiterApiKey, fetchFn: this.fetchFn }, quote);
      }
      if (!b64) throw new Error('Quote has no transaction');
      const tx = sol.txFromBase64(b64);
      const payer = sol.describeFeePayer(tx);
      if (payer && payer !== quote.request.fromAddress)
        throw new Error('The route returned a transaction for a different account');
      hash = await sol.signAndSend(from as SolanaNetwork, tx, this.solanaKeypair(acct));
    }
    const record: TxRecord = {
      hash,
      networkId: from.id,
      chainType: from.type,
      from: quote.request.fromAddress,
      to: quote.request.toAddress,
      title,
      direction: 'out',
      kind: isBridge ? 'bridge' : 'swap',
      amount: formatAmount(quote.request.fromAmount, fromToken.decimals),
      symbol: fromToken.symbol,
      timestamp: Date.now(),
      status: 'pending',
      bridge: isBridge ? { toNetworkId: to.id, tool: quote.toolKey, status: 'PENDING' } : undefined,
      source: 'local',
    };
    await this.recordTx(record);
    return record;
  }

  async getBridgeStatus(hash: string, fromNetworkId: string, toNetworkId: string, tool?: string): Promise<BridgeStatus> {
    const from = await this.getNetwork(fromNetworkId);
    const to = await this.getNetwork(toNetworkId);
    if (!from.lifiChainId || !to.lifiChainId) throw new Error('Unsupported network');
    const local = (await this.getLocalTxs()).find((t) => t.networkId === fromNetworkId && t.hash === hash);
    const st = await getLifiStatus(await this.lifiConfig(), hash, from.lifiChainId, to.lifiChainId, tool ?? local?.bridge?.tool);
    if (local && st.status !== 'NOT_FOUND') {
      await this.updateTx(fromNetworkId, hash, { bridge: { status: st.status, receivingHash: st.receivingTxHash } });
    }
    return st;
  }

  // ---------------------------------------------------------------- address book

  async getContacts(): Promise<Contact[]> {
    return (await this.store.get<Contact[]>(K.contacts)) ?? [];
  }

  async saveContact(input: { id?: string; name: string; address: string; chainType: ChainType }): Promise<Contact> {
    return this.mutex.run(async () => {
      const name = input.name.trim();
      if (!name) throw new Error('Name is required');
      if (!isValidAddress(input.chainType, input.address)) {
        throw new Error(input.chainType === 'evm' ? 'Enter a valid 0x address' : 'Enter a valid Solana address');
      }
      const address = normalizeAddress(input.chainType, input.address);
      const list = await this.getContacts();
      const dup = list.find((c) => c.id !== input.id && c.chainType === input.chainType && sameAddress(c.address, address));
      if (dup) throw new Error(`This address is already saved as ${dup.name}`);
      const existing = input.id ? list.find((c) => c.id === input.id) : undefined;
      if (input.id && !existing) throw new Error('Unknown contact');
      const contact: Contact = {
        id: existing?.id ?? randomId(),
        name,
        address,
        chainType: input.chainType,
        createdAt: existing?.createdAt ?? Date.now(),
      };
      await this.store.set(K.contacts, existing ? list.map((c) => (c.id === contact.id ? contact : c)) : [...list, contact]);
      return contact;
    });
  }

  async removeContact(id: string): Promise<void> {
    return this.mutex.run(async () => {
      await this.store.set(
        K.contacts,
        (await this.getContacts()).filter((c) => c.id !== id),
      );
    });
  }

  /** Most recent distinct addresses this wallet sent to on networks of the given type. */
  async getRecentRecipients(chainType: ChainType, limit = 5): Promise<{ address: string; timestamp: number }[]> {
    const out: { address: string; timestamp: number }[] = [];
    for (const t of await this.getLocalTxs()) {
      if (t.chainType !== chainType || t.kind !== 'send' || t.direction !== 'out' || !t.to) continue;
      if (out.some((r) => sameAddress(r.address, t.to))) continue;
      out.push({ address: t.to, timestamp: t.timestamp });
      if (out.length >= limit) break;
    }
    return out;
  }

  // ---------------------------------------------------------------- dApp permissions

  async getPermissions(): Promise<Record<string, Permission>> {
    return (await this.store.get<Record<string, Permission>>(K.permissions)) ?? {};
  }

  async getPermission(origin: string): Promise<Permission | undefined> {
    return (await this.getPermissions())[origin];
  }

  async setPermission(p: Permission): Promise<void> {
    return this.mutex.run(async () => {
      const all = await this.getPermissions();
      all[p.origin] = p;
      await this.store.set(K.permissions, all);
    });
  }

  /** Atomically updates an origin's permission; return undefined from fn to delete it. */
  async updatePermission(
    origin: string,
    fn: (p: Permission | undefined) => Permission | undefined,
  ): Promise<Permission | undefined> {
    return this.mutex.run(async () => {
      const all = await this.getPermissions();
      const next = fn(all[origin]);
      if (next) all[origin] = next;
      else delete all[origin];
      await this.store.set(K.permissions, all);
      return next;
    });
  }

  async revokePermission(origin: string): Promise<void> {
    return this.mutex.run(async () => {
      const all = await this.getPermissions();
      delete all[origin];
      await this.store.set(K.permissions, all);
    });
  }

  private async dropAccountFromPermissions(accountId: string) {
    const all = await this.getPermissions();
    let changed = false;
    for (const [origin, p] of Object.entries(all)) {
      if (p.accountIds.includes(accountId)) {
        p.accountIds = p.accountIds.filter((x) => x !== accountId);
        if (!p.accountIds.length) delete all[origin];
        changed = true;
      }
    }
    if (changed) await this.store.set(K.permissions, all);
  }
}

function randomId(): string {
  return bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(8)));
}
