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
import * as kairos from '../predictions/client';
import {
  lookupMarkets,
  outcomeBalances,
  toOrderView,
  toHistoryView,
  toPositionsView,
  withOnchainSizes,
  type OrderView,
  type PositionsView,
} from '../predictions/portfolio';
import { PUSD_ADDRESS, verifyLoginRequest, verifySigningRequest } from '../predictions/verify';
import {
  encodePause,
  encodeUnpause,
  encodeWithdraw,
  getRecoveryState,
  type RecoveryState,
  type WithdrawalRequest,
} from '../predictions/recovery';
import * as halliday from '../deposits/halliday';
import type {
  CancelResult,
  KairosConfig,
  MarketDetail,
  OrderInput,
  OrderResult,
  PredictionEvent,
  PricePoint,
  SetupResult,
  TimeInForce,
  TradingStatus,
  WalletCredentials,
} from '../predictions/types';
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
  /** Kairos read-only sign-in tokens, in session storage (cleared when the browser closes or the wallet locks). */
  kairosLogins: 'kairosLogins',
  /** Pending pUSD withdrawals from trading wallets, by account id (they span the hour-long timelock). */
  predictionWithdrawals: 'predictionWithdrawals',
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
  /** Kairos sign-ins in flight, so concurrent reads share one. */
  private readonly kairosLoginsInFlight = new Map<string, Promise<WalletCredentials>>();
  /** Fallback when there's no session store (tests, scripts). */
  private readonly kairosLoginsMemory = new Map<string, WalletCredentials>();
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
    await this.session?.remove(K.kairosLogins);
    this.kairosLoginsMemory.clear();
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

  // ---------------------------------------------------------------- prediction markets (Kairos)

  private async kairosConfig(): Promise<KairosConfig> {
    const { apis } = await this.getSettings();
    if (!apis.kairosEnabled) throw new Error('Prediction markets are turned off in Settings');
    return {
      executionUrl: apis.kairosExecutionUrl,
      dataUrl: apis.kairosDataUrl,
      marketDataUrl: apis.kairosMarketDataUrl,
      partnerId: apis.kairosPartnerId,
    };
  }

  private async predictionAccount(accountId: string): Promise<Account & { evmAddress: string }> {
    const acct = await this.getAccount(accountId);
    if (!acct.evmAddress) throw new Error('Prediction markets need an account with an EVM address');
    return acct as Account & { evmAddress: string };
  }

  async predictionMarkets(query: kairos.DiscoverQuery = {}): Promise<PredictionEvent[]> {
    return kairos.discoverMarkets(await this.kairosConfig(), query, this.fetchFn);
  }

  async predictionMarket(marketId: string): Promise<MarketDetail> {
    return kairos.getMarket(await this.kairosConfig(), marketId, this.fetchFn);
  }

  async predictionPriceHistory(
    marketId: string,
    opts: { outcomeIndex?: number; hours?: number; timeframeSeconds?: number } = {},
  ): Promise<PricePoint[]> {
    return kairos.getPriceHistory(await this.kairosConfig(), marketId, opts, this.fetchFn);
  }

  async predictionStatus(accountId: string): Promise<TradingStatus> {
    const acct = await this.predictionAccount(accountId);
    return kairos.getStatus(await this.kairosConfig(), acct.evmAddress, this.fetchFn);
  }

  /** The account's orders with market titles, images and fill progress. */
  async predictionOrders(accountId: string, open = false): Promise<OrderView[]> {
    const records = await this.kairosRead(accountId, [], (cfg, wallet, token) =>
      kairos.getOrders(cfg, wallet, token, { open, limit: 100 }, this.fetchFn),
    );
    const metas = await lookupMarkets(
      await this.kairosConfig(),
      records.map((r) => String(r.market_id ?? '')),
      this.fetchFn,
    );
    return records.map((r) => toOrderView(r, metas));
  }

  /**
   * The account's positions with market titles, live prices, value and P&L. Sizes come from the
   * chain when it can be read, since Kairos' position index can lag a fill or a sale.
   */
  async predictionPositions(accountId: string): Promise<PositionsView> {
    const data = await this.kairosRead(accountId, { open: [], resolved: [] }, (cfg, wallet, token) =>
      kairos.getPositions(cfg, wallet, token, this.fetchFn),
    );
    const cfg = await this.kairosConfig();
    // Past positions and realized P&L are public trader stats on the trading wallet (best effort).
    const stats = await this.predictionTraderStats(accountId).catch(() => undefined);
    const past = [...(stats?.closed_positions ?? []), ...(stats?.open_positions ?? [])];
    const [metas, open] = await Promise.all([
      lookupMarkets(
        cfg,
        [...data.open, ...data.resolved, ...past].map((r) => String(r.market_id ?? '')),
        this.fetchFn,
      ),
      this.predictionTradingBalances(
        accountId,
        data.open.map((r) => String(r.token_id ?? '')),
      )
        .then((b) => withOnchainSizes(data.open, b))
        .catch(() => data.open),
    ]);
    const view = toPositionsView({ open, resolved: data.resolved }, metas);
    if (!stats) return view;
    const shown = new Set(view.positions.map((p) => p.key.split(':')[0]));
    const { history, realized } = toHistoryView(stats, metas, shown);
    return { ...view, history, totals: { ...view.totals, realized } };
  }

  private async predictionTraderStats(accountId: string) {
    const acct = await this.predictionAccount(accountId);
    const cfg = await this.kairosConfig();
    const { tradingWallet } = await kairos.getStatus(cfg, acct.evmAddress, this.fetchFn);
    if (!tradingWallet) return undefined;
    return kairos.getTraderPositions(cfg, tradingWallet, this.fetchFn);
  }

  /** Shares of each outcome of one market held by the trading wallet, read on-chain. */
  async predictionHoldings(accountId: string, marketId: string): Promise<Record<string, number>> {
    const market = await this.predictionMarket(marketId);
    const balances = await this.predictionTradingBalances(
      accountId,
      market.tokens.map((t) => t.tokenId),
    );
    return Object.fromEntries(market.tokens.map((t) => [t.outcome, balances.get(t.tokenId) ?? 0]));
  }

  private async predictionTradingBalances(accountId: string, tokenIds: string[]): Promise<Map<string, number>> {
    const acct = await this.predictionAccount(accountId);
    const { tradingWallet } = await kairos.getStatus(await this.kairosConfig(), acct.evmAddress, this.fetchFn);
    return outcomeBalances((await this.getNetwork('polygon')) as EvmNetwork, tradingWallet, tokenIds);
  }

  /**
   * Orders and positions are private: they need a read-only token from a `login` action (one
   * Sign-In with Ethereum signature, valid 24 hours). Uses the cached token, signs in when there is
   * none or it is about to expire, and signs in once more if Kairos rejects it. A wallet that isn't
   * set up can't sign in and has nothing to show, so it gets `empty`.
   */
  private async kairosRead<T>(
    accountId: string,
    empty: T,
    read: (cfg: KairosConfig, wallet: string, token: string) => Promise<T>,
  ): Promise<T> {
    const acct = await this.predictionAccount(accountId);
    const cfg = await this.kairosConfig();
    let creds = await this.kairosCredentials(cfg, acct.evmAddress);
    const fresh = !creds || Date.parse(creds.expiresAt) <= Date.now() + 60_000;
    if (fresh) {
      const status = await kairos.getStatus(cfg, acct.evmAddress, this.fetchFn);
      if (status.next === 'setup') return empty;
      creds = await this.kairosLogin(accountId, cfg, acct.evmAddress);
    }
    try {
      return await read(cfg, acct.evmAddress, creds!.token);
    } catch (e) {
      if (fresh || !kairos.isUnauthorized(e)) throw e;
      return read(cfg, acct.evmAddress, (await this.kairosLogin(accountId, cfg, acct.evmAddress)).token);
    }
  }

  private kairosLoginKey(cfg: KairosConfig, wallet: string) {
    return `${cfg.executionUrl}|${wallet.toLowerCase()}`;
  }

  private async kairosCredentials(cfg: KairosConfig, wallet: string): Promise<WalletCredentials | undefined> {
    const key = this.kairosLoginKey(cfg, wallet);
    if (!this.session) return this.kairosLoginsMemory.get(key);
    return (await this.session.get<Record<string, WalletCredentials>>(K.kairosLogins))?.[key];
  }

  private kairosLogin(accountId: string, cfg: KairosConfig, wallet: string): Promise<WalletCredentials> {
    const key = this.kairosLoginKey(cfg, wallet);
    let pending = this.kairosLoginsInFlight.get(key);
    if (!pending) {
      pending = this.runPredictionAction<WalletCredentials>(accountId, { type: 'login' })
        .catch((e: Error) => {
          // Nodes that predate sign-in reject the action type outright.
          if (/unknown variant `login`/.test(e.message)) {
            throw new Error(
              "This Kairos node doesn't support signing in yet, so it can't show orders or positions. Trading isn't affected.",
              { cause: e },
            );
          }
          throw e;
        })
        .then(async (creds) => {
          if (!creds?.token || !creds.expiresAt) throw new Error('Kairos returned an incomplete sign-in');
          if (this.session) {
            const all = (await this.session.get<Record<string, WalletCredentials>>(K.kairosLogins)) ?? {};
            for (const [k, v] of Object.entries(all)) if (Date.parse(v.expiresAt) <= Date.now()) delete all[k];
            await this.session.set(K.kairosLogins, { ...all, [key]: creds });
          } else {
            this.kairosLoginsMemory.set(key, creds);
          }
          return creds;
        })
        .finally(() => this.kairosLoginsInFlight.delete(key));
      this.kairosLoginsInFlight.set(key, pending);
    }
    return pending;
  }

  /** pUSD the account holds on Polygon (base units), i.e. what it can move into its trading wallet. */
  async predictionWalletPusd(accountId: string): Promise<string> {
    await this.predictionAccount(accountId);
    return (await this.getBalance(accountId, 'polygon', { address: PUSD_ADDRESS })).toString();
  }

  /** Tokens in the trading wallet that trading can't use (e.g. USDC sent instead of pUSD), and the exit state. */
  async predictionRecoveryState(accountId: string): Promise<RecoveryState> {
    const acct = await this.predictionAccount(accountId);
    const { tradingWallet } = await kairos.getStatus(await this.kairosConfig(), acct.evmAddress, this.fetchFn);
    const polygon = (await this.getNetwork('polygon')) as EvmNetwork;
    return getRecoveryState(polygon, tradingWallet, await this.withdrawalRequest(accountId));
  }

  private async withdrawalRequest(accountId: string): Promise<WithdrawalRequest | undefined> {
    return (await this.store.get<Record<string, WithdrawalRequest>>(K.predictionWithdrawals))?.[accountId];
  }

  private async setWithdrawalRequest(accountId: string, request: WithdrawalRequest | undefined): Promise<void> {
    const all = { ...((await this.store.get<Record<string, WithdrawalRequest>>(K.predictionWithdrawals)) ?? {}) };
    if (request) all[accountId] = request;
    else delete all[accountId];
    await this.store.set(K.predictionWithdrawals, all);
  }

  /**
   * Starts moving pUSD from the trading wallet back to this account. The trading wallet's owner
   * exits through its timelock (pause → wait → withdraw → resume), so nothing depends on Kairos or
   * Polymarket. `amount` is pUSD as a decimal string, or 'all'. Run the steps with predictionRecoveryStep.
   */
  async predictionWithdrawStart(accountId: string, amount: string | 'all'): Promise<RecoveryState> {
    const state = await this.predictionRecoveryState(accountId);
    const acct = await this.predictionAccount(accountId);
    if (!sameAddress(state.owner, acct.evmAddress)) throw new Error('This trading wallet is owned by a different account');
    const balance = BigInt(state.pusdBalance);
    let units: bigint | 'all' = 'all';
    if (amount !== 'all') {
      if (!/^\d+(\.\d{1,6})?$/.test(amount.trim())) throw new Error('Enter an amount of pUSD');
      units = parseUnits(amount.trim(), 6);
      if (units <= 0n) throw new Error('Enter an amount of pUSD');
      if (units > balance) throw new Error(`Your trading balance is ${formatAmount(balance.toString(), 6)} pUSD`);
    }
    if (balance === 0n) throw new Error('There is no pUSD in your trading wallet');
    await this.setWithdrawalRequest(accountId, {
      amount: units === 'all' ? 'all' : units.toString(),
      requestedAt: Date.now(),
    });
    return this.predictionRecoveryState(accountId);
  }

  /** Drops a pending withdrawal. A trading wallet that's already paused still resumes after the timelock. */
  async predictionWithdrawCancel(accountId: string): Promise<RecoveryState> {
    await this.setWithdrawalRequest(accountId, undefined);
    return this.predictionRecoveryState(accountId);
  }

  /**
   * Gas the owner needs for the remaining recovery transactions, so the UI can prompt for exactly
   * that much POL and continue once it arrives.
   */
  async predictionRecoveryGas(accountId: string): Promise<{ address: string; have: string; needed: string }> {
    const acct = await this.predictionAccount(accountId);
    const polygon = (await this.getNetwork('polygon')) as EvmNetwork;
    const state = await this.predictionRecoveryState(accountId);
    // Generous per-call gas: pause/unpause are single storage writes, withdrawals one token transfer.
    const gas =
      state.next === 'pause'
        ? 80_000n
        : state.next === 'withdraw'
          ? 120_000n * BigInt(state.stray.length + (state.withdrawal ? 1 : 0)) + 80_000n
          : state.next === 'unpause'
            ? 80_000n
            : 0n;
    const [gasPrice, have] = await Promise.all([
      evm.publicClient(polygon).getGasPrice(),
      evm.getNativeBalance(polygon, acct.evmAddress),
    ]);
    // 2× headroom for fee spikes between now and sending.
    return { address: acct.evmAddress, have: have.toString(), needed: (gas * gasPrice * 2n).toString() };
  }

  /**
   * Performs the next recovery step from the owner's account (each is a Polygon transaction):
   * pause the trading wallet, or after the timelock, withdraw stray tokens to the owner and unpause.
   */
  async predictionRecoveryStep(accountId: string): Promise<RecoveryState> {
    const acct = await this.predictionAccount(accountId);
    const polygon = (await this.getNetwork('polygon')) as EvmNetwork;
    const state = await this.predictionRecoveryState(accountId);
    if (!sameAddress(state.owner, acct.evmAddress)) throw new Error('This trading wallet is owned by a different account');
    const gas = await this.predictionRecoveryGas(accountId);
    if (BigInt(gas.have) < BigInt(gas.needed)) {
      throw new Error(
        `This step needs about ${formatAmount(gas.needed, 18, 4)} POL for gas. Send it on Polygon to ${acct.evmAddress}.`,
      );
    }
    const pk = this.evmKey(acct);
    const run = async (data: Hex, title: string) => {
      const hash = await evm.sendTx(polygon, pk, {
        from: acct.evmAddress as Hex,
        to: state.tradingWallet as Hex,
        data,
        value: 0n,
      });
      await this.recordTx({
        hash,
        networkId: polygon.id,
        chainType: 'evm',
        from: acct.evmAddress,
        to: state.tradingWallet,
        title,
        direction: 'out',
        kind: 'contract',
        timestamp: Date.now(),
        status: 'pending',
        source: 'local',
      });
      if ((await this.waitForTx(polygon.id, hash)) !== 'confirmed') throw new Error(`${title} failed on-chain`);
    };
    switch (state.next) {
      case 'pause':
        await run(encodePause(), 'Paused trading wallet for recovery');
        break;
      case 'withdraw':
        if (state.withdrawal) {
          const w = state.withdrawal;
          await run(
            encodeWithdraw(w.address, acct.evmAddress, BigInt(w.amount)),
            `Withdrew ${formatAmount(w.amount, 6)} pUSD from trading`,
          );
          await this.setWithdrawalRequest(accountId, undefined);
        }
        for (const t of state.stray) {
          await run(
            encodeWithdraw(t.address, acct.evmAddress, BigInt(t.amount)),
            `Recovered ${formatAmount(t.amount, t.decimals)} ${t.symbol}`,
          );
        }
        await run(encodeUnpause(), 'Resumed trading wallet');
        break;
      case 'unpause':
        await run(encodeUnpause(), 'Resumed trading wallet');
        break;
      case 'wait':
        throw new Error(`Withdrawals unlock at ${new Date(state.unlocksAt * 1000).toLocaleTimeString()}`);
      default:
        break;
    }
    return this.predictionRecoveryState(accountId);
  }

  // ---------------------------------------------------------------- prediction deposits (Halliday)

  private async hallidayConfig(): Promise<halliday.HallidayConfig> {
    const { apis } = await this.getSettings();
    return { url: apis.hallidayUrl, apiKey: apis.hallidayApiKey, fetchFn: this.fetchFn };
  }

  private pusdAsset(): string {
    return `polygon:${PUSD_ADDRESS.toLowerCase()}`;
  }

  private depositInputsCache?: { at: number; tokens: string[] };

  /** Halliday asset ids that can be converted into pUSD (cached for an hour). */
  async depositInputs(): Promise<string[]> {
    if (this.depositInputsCache && Date.now() - this.depositInputsCache.at < 3_600_000) return this.depositInputsCache.tokens;
    const { tokens } = await halliday.availableInputs(await this.hallidayConfig(), this.pusdAsset());
    this.depositInputsCache = { at: Date.now(), tokens };
    return tokens;
  }

  /** Halliday asset id for one of our tokens, if Halliday knows the network. */
  async depositAssetId(networkId: string, token: Pick<Token, 'address'>): Promise<string | undefined> {
    return halliday.hallidayAsset(await this.getNetwork(networkId), token);
  }

  /** Best quote for converting `amount` of a held token into pUSD for the trading wallet. */
  async depositQuote(params: { networkId: string; token: Token; amount: string }): Promise<halliday.HallidayQuote> {
    const network = await this.getNetwork(params.networkId);
    const inputAsset = halliday.hallidayAsset(network, params.token);
    if (!inputAsset) throw new Error(`Deposits from ${network.name} aren't supported`);
    if (!(Number(params.amount) > 0)) throw new Error('Enter an amount');
    const [best] = await halliday.getQuotes(await this.hallidayConfig(), {
      inputAsset,
      amount: params.amount,
      outputAsset: this.pusdAsset(),
    });
    return best;
  }

  /** Card/bank onramp quotes for a USD amount, delivered as pUSD. */
  async depositFiatQuotes(usdAmount: string): Promise<halliday.HallidayQuote[]> {
    if (!(Number(usdAmount) > 0)) throw new Error('Enter an amount');
    return halliday.getQuotes(await this.hallidayConfig(), {
      inputAsset: 'USD',
      amount: usdAmount,
      outputAsset: this.pusdAsset(),
      onramps: ['stripe', 'moonpay', 'transak', 'coinbase'],
      onrampMethods: ['CREDIT_CARD', 'DEBIT_CARD', 'APPLE_PAY', 'GOOGLE_PAY', 'ACH'],
    });
  }

  /** Confirms a Halliday payment to the trading wallet, completing owner verification if Halliday asks. */
  private async confirmDeposit(
    acct: Account & { evmAddress: string },
    quote: halliday.HallidayQuote,
    owner: string,
    ownerChain?: string,
  ) {
    const cfg = await this.hallidayConfig();
    const { tradingWallet } = await this.predictionStatus(acct.id);
    let status = await halliday.confirmPayment(cfg, {
      paymentId: quote.paymentId,
      stateToken: quote.stateToken,
      owner,
      ownerChain,
      destination: tradingWallet,
    });
    const ni = status.next_instruction;
    if (status.status === 'UNCONFIRMED' && ni?.type === 'USER_VERIFY' && ni.verification_token) {
      // One-time proof that the user controls the owner address (payments of $300 or more).
      const pk = this.evmKey(acct);
      const signatures = [];
      for (const v of ni.verifications ?? []) {
        if (v.reason !== 'EVM_OWNER') throw new Error(`Unexpected verification request: ${v.reason}`);
        let signature: string;
        if (v.signature_type === 'EIP712') {
          const td = JSON.parse(v.payload) as {
            domain: object;
            types: Record<string, unknown>;
            primaryType: string;
            message: Record<string, unknown>;
          };
          // An ownership proof never needs token permissions; refuse anything that looks like one.
          if (/permit/i.test(td.primaryType) || 'spender' in td.message || 'amount' in td.message || 'value' in td.message) {
            throw new Error('Refused to sign: the verification request looks like a token permission');
          }
          const types = { ...td.types };
          delete types.EIP712Domain;
          signature = await evm.signTypedData(pk, {
            domain: td.domain,
            types,
            primaryType: td.primaryType,
            message: td.message,
          } as never);
        } else {
          signature = await evm.signMessage(pk, v.payload);
        }
        signatures.push({ reason: v.reason, signature_type: v.signature_type, signature });
      }
      status = await halliday.continueConfirm(cfg, ni.verification_token, signatures);
    }
    return status;
  }

  /**
   * Deposits a held token into the trading wallet as pUSD. pUSD on Polygon is sent directly; anything
   * else goes to a one-time Halliday deposit address that swaps/bridges it into pUSD.
   */
  async depositWithCrypto(
    accountId: string,
    params: { networkId: string; token: Token; amount: string; quote?: halliday.HallidayQuote },
  ): Promise<{ hash: string; networkId: string; paymentId?: string }> {
    const acct = await this.predictionAccount(accountId);
    const network = await this.getNetwork(params.networkId);
    const isPusd = network.id === 'polygon' && sameAddress(params.token.address, PUSD_ADDRESS);
    if (isPusd) {
      const { tradingWallet } = await this.predictionStatus(accountId);
      const rec = await this.send({
        accountId,
        networkId: network.id,
        token: params.token,
        to: tradingWallet,
        amount: params.amount,
      });
      return { hash: rec.hash, networkId: rec.networkId };
    }
    const quote = params.quote ?? (await this.depositQuote(params));
    if (Date.parse(quote.acceptBy) < Date.now()) throw new Error('This quote has expired. Get a new one.');
    const owner = network.type === 'solana' ? acct.solanaAddress : acct.evmAddress;
    if (!owner) throw new Error(`${acct.name} has no ${network.name} address`);
    const status = await this.confirmDeposit(acct, quote, owner, network.type === 'solana' ? 'solana' : undefined);
    const info = halliday.checkDepositInfo(status.next_instruction?.deposit_info?.[0], quote);
    // Never send more decimals than the token supports.
    const [whole, frac = ''] = info.deposit_amount.split('.');
    const amount = frac ? `${whole}.${frac.slice(0, params.token.decimals)}` : whole;
    const rec = await this.send({ accountId, networkId: network.id, token: params.token, to: info.deposit_address, amount });
    await this.updateTx(network.id, rec.hash, {
      title: `Deposited ${formatAmount(parseUnits(amount, params.token.decimals), params.token.decimals)} ${params.token.symbol} → pUSD`,
    });
    return { hash: rec.hash, networkId: rec.networkId, paymentId: quote.paymentId };
  }

  /** Starts a card/bank onramp into the trading wallet; returns the provider checkout URL. */
  async depositWithCard(accountId: string, quote: halliday.HallidayQuote): Promise<{ paymentId: string; fundingUrl: string }> {
    const acct = await this.predictionAccount(accountId);
    const status = await this.confirmDeposit(acct, quote, acct.evmAddress);
    const url = status.next_instruction?.funding_page_url;
    if (!url || !/^https:\/\//.test(url)) throw new Error('Halliday did not return a checkout page');
    return { paymentId: quote.paymentId, fundingUrl: url };
  }

  async depositStatus(paymentId: string): Promise<{ status: string; inProgress: boolean }> {
    const p = await halliday.getPayment(await this.hallidayConfig(), paymentId);
    return { status: p.status, inProgress: halliday.IN_PROGRESS.has(p.status) };
  }

  /** Runs a Kairos action, validating and signing each step with the account's EVM key. */
  private async runPredictionAction<R>(accountId: string, action: kairos.ActionInput, tokenId?: string): Promise<R> {
    const acct = await this.predictionAccount(accountId);
    const cfg = await this.kairosConfig();
    const { tradingWallet } = await kairos.getStatus(cfg, acct.evmAddress, this.fetchFn);
    const pk = this.evmKey(acct);
    return kairos.runAction<R>(cfg, acct.evmAddress, action, {
      fetchFn: this.fetchFn,
      sign: async (step) => {
        if (action.type === 'login') {
          const message = verifyLoginRequest(step.request, { wallet: acct.evmAddress, action, executionUrl: cfg.executionUrl });
          return evm.signMessage(pk, message.startsWith('0x') ? { raw: message as Hex } : message);
        }
        const td = verifySigningRequest(step.request, { wallet: acct.evmAddress, tradingWallet, action, tokenId });
        const types = { ...td.types };
        delete types.EIP712Domain;
        return evm.signTypedData(pk, { domain: td.domain, types, primaryType: td.primaryType, message: td.message } as never);
      },
    });
  }

  /** One-time trading setup: proves wallet ownership and approves the exchange contracts (no gas). */
  async predictionSetup(accountId: string): Promise<SetupResult> {
    return this.runPredictionAction<SetupResult>(accountId, { type: 'setup' });
  }

  async predictionOrder(
    accountId: string,
    params: { marketId: string; outcome: string; side: 'buy' | 'sell'; price: string; size: string; timeInForce?: TimeInForce },
  ): Promise<OrderResult> {
    const market = await this.predictionMarket(params.marketId);
    if (market.status !== 'open') throw new Error('This market is not open for trading');
    const token = market.tokens.find((t) => t.outcome.toLowerCase() === params.outcome.toLowerCase());
    if (!token) throw new Error(`Unknown outcome ${params.outcome}`);
    const price = Number(params.price);
    const size = Number(params.size);
    if (!(price > 0 && price < 1)) throw new Error('Price must be between 0 and 1');
    const ticks = price / market.tickSize;
    if (Math.abs(ticks - Math.round(ticks)) > 1e-6) throw new Error(`Price must be a multiple of ${market.tickSize}`);
    if (!(size > 0)) throw new Error('Enter a number of shares');
    const order: OrderInput = {
      market: market.conditionId,
      outcome: token.outcome,
      side: params.side,
      price: String(params.price),
      size: String(params.size),
      timeInForce: params.timeInForce ?? 'GTC',
      clientOrderId: randomId(),
    };
    try {
      return await this.runPredictionAction<OrderResult>(accountId, { type: 'order', ...order }, token.tokenId);
    } catch (e) {
      // Kairos nodes can have order placement switched off (e.g. staging); say where to change it.
      // The venue found nothing to match at the order's limit: the book moved, or was stale when priced.
      if (/no liquidity|no orders found to match|MARKET_INSUFFICIENT_LIQUIDITY|FOK_NOT_FILLED/i.test((e as Error).message)) {
        throw new Error(
          'Nothing filled: the price moved before the order reached Polymarket. Nothing was spent; check the book and try again, or use a limit order.',
          { cause: e },
        );
      }
      if (/trading is not available on this node/i.test((e as Error).message)) {
        throw new Error(
          'This Kairos node has order placement turned off. Set a trading-enabled wallet API URL in Settings → Swap & data providers → Prediction markets.',
          { cause: e },
        );
      }
      throw e;
    }
  }

  async predictionCancel(accountId: string, orderIds: string[] | 'all'): Promise<CancelResult> {
    const action = orderIds === 'all' ? { type: 'cancel' as const, all: true as const } : { type: 'cancel' as const, orderIds };
    if (orderIds !== 'all' && (!orderIds.length || orderIds.length > 100)) throw new Error('Cancel between 1 and 100 orders');
    return this.runPredictionAction<CancelResult>(accountId, action);
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
