import {
  Http as KairosHttp,
  OnchainIntentsClient,
  TradePlansClient,
  FeesClient,
  FeeSettlementRequiredError,
  type FeeSettlement,
  type FeeSummary,
  type FeeVenue,
  type TradePlan,
  type TradePlanInput,
  type WalletContext,
  WaitTimeoutError,
  type Eip1193Provider,
  type OnchainIntentView,
  type RequestOptions,
  type WalletStatus,
} from '@kairos.trade/sdk';
import { keccak256, type Hex, type TransactionRequest } from 'viem';
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
import { onchainCondition, verifyOnchainBatch, type OnchainRequest } from '../predictions/onchain';
import {
  PLAN_FUNDING,
  PLAN_SIGNATURES,
  PlanReviewed,
  checkPlanRequests,
  wholeSecond,
  type FundedBuy,
  type PredictionActivity,
} from '../predictions/plans';
import {
  filledTokensMissing,
  heldFromFills,
  lookupMarkets,
  metaFor,
  outcomeBalances,
  recordMarket,
  toOrderView,
  toHistoryView,
  toPositionsView,
  withOnchainSizes,
  type MarketMeta,
  type OrderView,
  type PositionsView,
} from '../predictions/portfolio';
import {
  PUSD_ADDRESS,
  UnsafeSigningRequestError,
  verifyLoginRequest,
  verifyRoutePlan,
  verifyRoutedStep,
  verifySigningRequest,
  verifyVenueLoginRequest,
  verifyWalletCalls,
  type RouteContext,
  type RouteProgress,
} from '../predictions/verify';
import { FEE_DECIMALS, VENUE_INFO, isVenue, type Venue } from '../predictions/venues';
import {
  ARBITRUM_USDC,
  HYPERLIQUID_BRIDGE,
  HYPERLIQUID_MIN_DEPOSIT,
  hyperliquidAccount,
  outcomeToken,
} from '../predictions/hyperliquid';
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
  Action,
  CancelResult,
  Candle,
  KairosConfig,
  MarketDetail,
  MarketRules,
  OrderInput,
  OrderResult,
  PredictionEvent,
  PricePoint,
  Resolution,
  ResolutionEvent,
  RoutedOrderResult,
  SetupResult,
  Step,
  TimeInForce,
  TradingStatus,
  WalletCredentials,
  ApiRecord,
} from '../predictions/types';
import { lookupLinks, type MarketLink } from '../predictions/links';
import { groupSearchHits, type SearchResult } from '../predictions/search';
import {
  comboEnabled,
  comboUnits,
  getComboMarkets,
  validateCombo,
  verifyComboResult,
  type ComboInput,
  type ComboPosition,
  type ComboResult,
  type ComboTradeInput,
} from '../predictions/combos';
import { getCatalogEvent, getMatchedMarket, listCatalog, type CatalogQuery } from '../predictions/discover';
import { feePerShare } from '../predictions/router';
import {
  classifyLegError,
  routedOrderUnavailable,
  toRouteExecution,
  needsPolymarketReconnect,
  isUnconfirmedOrder,
  PredictionOrderError,
  venueErrorCode,
  type RouteExecution,
  type RouteLegResult,
  type RoutedBuyRequest,
  type PreparedRoute,
} from '../predictions/execution';
import { HttpError } from '../http';
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

/** The only typed data a routed order's legs may ask for: venue orders, and Hyperliquid's perps → spot move. */
const ROUTED_ORDER_SIGNATURES = new Set(['Order', 'TypedDataSign', 'PlaceOrder']);
const ROUTED_SIGNATURES = new Set([...ROUTED_ORDER_SIGNATURES, 'HyperliquidTransaction:UsdClassTransfer']);

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
  predictionActivity: 'predictionActivity',
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

  async predictionCatalog(query: CatalogQuery = {}) {
    return listCatalog((await this.kairosConfig()).marketDataUrl, query, this.fetchFn);
  }

  async predictionCatalogEvent(id: string) {
    return getCatalogEvent((await this.kairosConfig()).marketDataUrl, id, this.fetchFn);
  }

  async predictionMatchedMarket(id: string) {
    return getMatchedMarket((await this.kairosConfig()).marketDataUrl, id, this.fetchFn);
  }

  /**
   * Short-lived memo for public reads the order path repeats (market detail, links): an order then
   * goes out with one round trip less, and screens opened again render at once.
   */
  private readonly predictionMemo = new Map<string, { at: number; value: Promise<unknown> }>();

  private memo<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.predictionMemo.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
    const value = load();
    this.predictionMemo.set(key, { at: Date.now(), value });
    // A failure isn't worth remembering.
    value.catch(() => this.predictionMemo.get(key)?.value === value && this.predictionMemo.delete(key));
    if (this.predictionMemo.size > 400) this.predictionMemo.delete(this.predictionMemo.keys().next().value!);
    return value;
  }

  async predictionMarket(marketId: string): Promise<MarketDetail> {
    const cfg = await this.kairosConfig();
    return this.memo(`market|${cfg.marketDataUrl}|${marketId}`, 15_000, () => kairos.getMarket(cfg, marketId, this.fetchFn));
  }

  async predictionPriceHistory(marketId: string, opts: kairos.HistoryQuery = {}): Promise<PricePoint[]> {
    return kairos.getPriceHistory(await this.kairosConfig(), marketId, opts, this.fetchFn);
  }

  /** OHLC candles for the chart's candle view. */
  async predictionCandles(marketId: string, opts: kairos.HistoryQuery = {}): Promise<Candle[]> {
    return kairos.getCandles(await this.kairosConfig(), marketId, opts, this.fetchFn);
  }

  /** Search across every venue the wallet trades, with markets listed on several venues merged into one result. */
  async predictionSearch(query: string, limit = 30): Promise<SearchResult[]> {
    const cfg = await this.kairosConfig();
    if (query.trim().length < 2) return [];
    const hits = await kairos.searchMarkets(cfg, query, { limit }, this.fetchFn);
    const links = await lookupLinks(
      cfg,
      hits.map((h) => h.marketId),
      this.fetchFn,
    ).catch(() => ({}) as Record<string, MarketLink>);
    return groupSearchHits(hits, links);
  }

  /** The same question on other venues, if Kairos links it. Undefined when it trades on one venue only. */
  async predictionLink(marketId: string): Promise<MarketLink | undefined> {
    const cfg = await this.kairosConfig();
    const links = await this.memo(`link|${cfg.dataUrl}|${marketId}`, 60_000, () => lookupLinks(cfg, [marketId], this.fetchFn));
    return links[marketId];
  }

  /** Links for many markets at once (market lists merge rows for the same question). */
  async predictionLinks(marketIds: string[]): Promise<Record<string, MarketLink>> {
    return lookupLinks(await this.kairosConfig(), marketIds, this.fetchFn);
  }

  /** Where the market's resolution stands, and its timeline. */
  async predictionResolution(marketId: string): Promise<{ resolution: Resolution; events: ResolutionEvent[] }> {
    const cfg = await this.kairosConfig();
    const [resolution, events] = await Promise.all([
      kairos.getResolution(cfg, marketId, this.fetchFn),
      kairos.getResolutionEvents(cfg, marketId, this.fetchFn).catch(() => [] as ResolutionEvent[]),
    ]);
    return { resolution, events };
  }

  /** The market's written rules. */
  async predictionRules(marketId: string): Promise<MarketRules> {
    const cfg = await this.kairosConfig();
    return this.memo(`rules|${cfg.dataUrl}|${marketId}`, 10 * 60_000, () => kairos.getRules(cfg, marketId, this.fetchFn));
  }

  async predictionStatus(accountId: string): Promise<TradingStatus> {
    const acct = await this.predictionAccount(accountId);
    return kairos.getStatus(await this.kairosConfig(), acct.evmAddress, this.fetchFn);
  }

  async predictionComboMarkets(cursor?: string) {
    await this.comboConfig();
    return this.memo(`combo-markets|${cursor ?? ''}`, 60_000, () => getComboMarkets(cursor, this.fetchFn));
  }

  async predictionCombos(accountId: string): Promise<ComboPosition[]> {
    await this.comboConfig();
    return this.kairosRead<ComboPosition[]>(accountId, [], (cfg, wallet, token) =>
      kairos.getCombos(cfg, wallet, token, this.fetchFn),
    );
  }

  async predictionComboQuote(accountId: string, input: ComboInput): Promise<ComboResult> {
    const position = validateCombo(input);
    const cfg = await this.comboConfig();
    const acct = await this.predictionAccount(accountId);
    const quote = await kairos.runAction<ComboResult>(
      cfg,
      acct.evmAddress,
      { ...input, type: 'comboQuote' },
      {
        fetchFn: this.fetchFn,
        answer: async () => {
          throw new UnsafeSigningRequestError('combo quotes require no signature');
        },
      },
    );
    return verifyComboResult(quote, input, position);
  }

  private readonly comboTrades = new Set<string>();

  async predictionComboTrade(accountId: string, input: ComboTradeInput): Promise<ComboResult> {
    const position = validateCombo(input);
    const limit = comboUnits(input.side === 'buy' ? input.maxPrice : input.minProceeds);
    if (limit <= 0n || (input.side === 'buy' && limit > 1_000_000n)) throw new Error('Invalid combo price limit.');
    const cfg = await this.comboConfig();
    const key = `${cfg.executionUrl}|${accountId}|${position}`;
    if (this.comboTrades.has(key)) throw new Error('A trade for this combo is already being confirmed.');
    this.comboTrades.add(key);
    try {
      const result = await this.runPredictionAction<ComboResult>(accountId, { ...input, type: 'combo' });
      if (result?.status !== 'CONFIRMED') throw new Error('Kairos returned an unconfirmed combo fill.');
      return verifyComboResult(result, input, position);
    } catch (e) {
      if (
        e instanceof UnsafeSigningRequestError ||
        (e instanceof HttpError && e.status < 500 && e.status !== 408 && e.status !== 409)
      )
        throw e;
      const code = e instanceof kairos.ActionFailedError ? e.step.errorCode : undefined;
      if (code === 'SIGNATURE_EXPIRED' || code === 'VENUE_REJECTED') throw e;
      throw new Error(`${(e as Error).message} Check your combo positions before submitting another trade.`, { cause: e });
    } finally {
      this.comboTrades.delete(key);
    }
  }

  private async comboConfig(): Promise<KairosConfig> {
    const cfg = await this.kairosConfig();
    if (!comboEnabled(cfg.executionUrl)) throw new Error('Combos are currently available on Kairos Staging.');
    return cfg;
  }

  /** The account's orders with market titles, images and fill progress. */
  async predictionOrders(accountId: string, open = false): Promise<OrderView[]> {
    const records = await this.kairosRead(accountId, [], (cfg, wallet, token) =>
      kairos.getOrders(cfg, wallet, token, { open, limit: 100 }, this.fetchFn),
    );
    const metas = await lookupMarkets(
      await this.kairosConfig(),
      records.map((r) => recordMarket(r) ?? ''),
      this.fetchFn,
    );
    return records.map((r) => toOrderView(r, metas));
  }

  /**
   * The account's positions with market titles, live prices, value and P&L. Sizes come from the
   * chain when it can be read, since Kairos' position index can lag a fill or a sale.
   */
  async predictionPositions(accountId: string): Promise<PositionsView> {
    const [data, orders, stats] = await Promise.all([
      this.kairosRead(accountId, { open: [], resolved: [] }, (cfg, wallet, token) =>
        kairos.getPositions(cfg, wallet, token, this.fetchFn),
      ),
      // Recent fills reach the chain before the position index; their markets are checked on-chain below.
      this.kairosRead(accountId, [] as ApiRecord[], (cfg, wallet, token) =>
        kairos.getOrders(cfg, wallet, token, { limit: 50 }, this.fetchFn),
      ).catch(() => [] as ApiRecord[]),
      // Past positions and realized P&L are public trader stats on the trading wallet (best effort).
      this.predictionTraderStats(accountId).catch(() => undefined),
    ]);
    const cfg = await this.kairosConfig();
    const past = [...(stats?.closed_positions ?? []), ...(stats?.open_positions ?? [])];
    const metas = await lookupMarkets(
      cfg,
      [...data.open, ...data.resolved, ...past, ...orders].map((r) => recordMarket(r) ?? ''),
      this.fetchFn,
    );
    const [indexed, recent] = await Promise.all([
      this.withOnchainSizes(accountId, data.open),
      this.heldFromRecentFills(accountId, orders, data.open, metas),
    ]);
    const view = toPositionsView({ open: [...indexed, ...recent], resolved: data.resolved }, metas);
    if (!stats) return view;
    const shown = new Set(view.positions.map((p) => p.key.split(':')[0]));
    const { history, realized } = toHistoryView(stats, metas, shown);
    return { ...view, history, totals: { ...view.totals, realized } };
  }

  async predictionOnchain(accountId: string, input: OnchainRequest): Promise<OnchainIntentView> {
    const acct = await this.predictionAccount(accountId);
    const cfg = await this.kairosConfig();
    const wallet = acct.evmAddress.toLowerCase();
    const market = `polymarket:${onchainCondition(input.market)}`;
    if (
      !['split', 'merge', 'redeem'].includes(input.operation) ||
      (input.operation === 'redeem' ? input.outcome !== 0 && input.outcome !== 1 : input.outcome !== undefined)
    ) {
      throw new Error('Invalid position operation.');
    }
    if (!/^[1-9]\d{0,77}$/.test(input.amountRaw) || BigInt(input.amountRaw) >= 2n ** 256n) {
      throw new Error('Enter a positive position amount with at most six decimals.');
    }
    const provider = this.predictionSdkSigner(acct, new Set(['Batch', 'OnchainIntent']), '0x89');
    const client = this.predictionOnchainClient(accountId, cfg, provider, input);
    // The SDK only accepts whole-second deadlines.
    const executeBefore = wholeSecond(input.executeBefore ? Date.parse(input.executeBefore) : Date.now() + 16 * 60_000);
    if (!(Number.isFinite(executeBefore.getTime()) && executeBefore.getTime() <= Date.now() + 17 * 60_000)) {
      throw new Error('Invalid position operation deadline.');
    }
    const opts = { idempotencyKey: input.idempotencyKey, executeBefore };
    try {
      return input.operation === 'redeem'
        ? await client.redeem(wallet, market, input.amountRaw, { ...opts, outcome: input.outcome })
        : await client[input.operation](wallet, market, input.amountRaw, opts);
    } catch (error) {
      if (error instanceof WaitTimeoutError && error.last) return error.last as OnchainIntentView;
      throw error;
    }
  }

  async predictionOnchainStatus(accountId: string, intentId: string): Promise<OnchainIntentView> {
    const acct = await this.predictionAccount(accountId);
    const cfg = await this.kairosConfig();
    if (!/^[0-9a-f-]{36}$/i.test(intentId)) throw new Error('Invalid position operation ID.');
    return this.predictionOnchainClient(accountId, cfg).get(intentId, acct.evmAddress);
  }

  private predictionOnchainClient(accountId: string, cfg: KairosConfig, provider?: Eip1193Provider, input?: OnchainRequest) {
    const checkPrepared = input
      ? (view: unknown, path: string) => {
          if (path !== '/v3/onchain-intents') return;
          const intent = (view as OnchainIntentView).intent;
          if (!intent.committed && !['confirmed', 'failed', 'expired', 'reverted'].includes(intent.status)) {
            if (intent.terms.partnerId !== cfg.partnerId)
              throw new UnsafeSigningRequestError('position operation is for a different partner');
            verifyOnchainBatch(intent.terms.batch.calls, input);
          }
        }
      : undefined;
    const ctx = this.predictionSdkContext(accountId, cfg, provider, checkPrepared);
    if (!input) return new OnchainIntentsClient(ctx);
    return new OnchainIntentsClient({
      ...ctx,
      request: async <T>(wallet: string, method: 'GET' | 'POST', path: string, opts?: RequestOptions) => {
        const id = path.match(/^\/v3\/onchain-intents\/([0-9a-f-]{36})\/execute$/i)?.[1];
        if (id && method === 'POST') {
          await this.rememberPredictionActivity(accountId, cfg, {
            id,
            kind: 'position',
            operation: input.operation,
            market: input.market,
            createdAt: Date.now(),
          });
        }
        return ctx.request<T>(wallet, method, path, opts);
      },
    });
  }

  private predictionSdkSigner(
    acct: Account & { evmAddress: string },
    allowedTypes: Set<string>,
    defaultChain: string,
  ): Eip1193Provider {
    let chain = defaultChain;
    return {
      request: async ({ method, params }) => {
        if (method === 'eth_chainId') return chain;
        if (method === 'wallet_switchEthereumChain') {
          const target = (params?.[0] as { chainId?: string } | undefined)?.chainId;
          if (!target || !['0x89', '0x38', '0xa4b1'].includes(target)) throw new UnsafeSigningRequestError('unexpected chain');
          chain = target;
          return null;
        }
        if (method !== 'eth_signTypedData_v4' || !sameAddress(String(params?.[0]), acct.evmAddress)) {
          throw new UnsafeSigningRequestError('unexpected prediction signing request');
        }
        const typed = JSON.parse(String(params?.[1])) as Parameters<typeof evm.signTypedData>[1];
        if (!allowedTypes.has(String(typed.primaryType)) || BigInt(String(typed.domain?.chainId)) !== BigInt(chain)) {
          throw new UnsafeSigningRequestError('unexpected prediction signature type or chain');
        }
        const types = { ...typed.types };
        delete types.EIP712Domain;
        return evm.signTypedData(this.evmKey(acct), { ...typed, types });
      },
    };
  }

  private predictionSdkContext(
    accountId: string,
    cfg: KairosConfig,
    provider: Eip1193Provider = {
      request: async () => {
        throw new Error('This operation is read-only.');
      },
    },
    checkResponse?: (view: unknown, path: string) => void,
  ): WalletContext {
    const http = new KairosHttp({
      baseUrl: cfg.executionUrl,
      headers: { 'x-kairos-partner-id': cfg.partnerId, 'x-kairos-wallet-api': '2' },
      fetch: (url, init) =>
        (this.fetchFn ?? fetch)(url, {
          ...init,
          redirect: 'error',
          signal: init?.signal ?? AbortSignal.timeout(20_000),
        }),
    });
    return {
      provider,
      pollIntervalMs: 2000,
      timeoutMs: 25_000,
      signal: (opts) => opts?.signal,
      status: (address) => http.get<WalletStatus>(`/v3/wallets/${encodeURIComponent(address)}`),
      request: async <T>(_wallet: string, method: 'GET' | 'POST', path: string, opts: RequestOptions = {}) => {
        const result = await this.kairosRead<T | undefined>(accountId, undefined, (_cfg, _wallet, token) =>
          http.request<T>(method, path, { ...opts, headers: { authorization: `SIWE ${token}` } }),
        );
        if (result === undefined) throw new Error('Set up your prediction trading wallet first.');
        if (method === 'POST') checkResponse?.(result, path);
        return result;
      },
    };
  }

  private readonly preparedPredictionPlans = new Map<
    string,
    {
      accountId: string;
      executionUrl: string;
      partnerId: string;
      plan: TradePlan;
      input: TradePlanInput;
      idempotencyKey: string;
      action: Extract<Action, { type: 'order' }>;
      tokenId: string;
      running?: boolean;
    }
  >();

  async predictionPrepareFundedBuy(accountId: string, buy: FundedBuy): Promise<TradePlan> {
    const acct = await this.predictionAccount(accountId);
    const cfg = await this.kairosConfig();
    const market = await this.predictionMarket(buy.marketId);
    const token = market.tokens.find((t) => t.tokenId === buy.tokenId);
    const source = buy.funding.source;
    if (!token || (source !== 'polygon' && source !== 'arbitrum')) throw new Error('Select an outcome and a USDC source.');
    if (market.venue === 'polymarket' && source === 'polygon') throw new Error('Fund a Polygon order from USDC on Arbitrum.');
    const ref =
      market.venue === 'polymarket'
        ? `polymarket:${onchainCondition(market.conditionId)}`
        : `${market.venue}:${market.venueMarketId}`;
    const clientOrderId = `0x${bytesToHex(crypto.getRandomValues(new Uint8Array(16)))}`;
    const idempotencyKey = crypto.randomUUID();
    const input: TradePlanInput = {
      wallet: acct.evmAddress,
      order: {
        market: ref,
        outcome: token.outcome,
        side: 'buy',
        price: buy.price,
        size: buy.shares,
        timeInForce: 'GTC',
        clientOrderId,
      },
      funding: {
        ...PLAN_FUNDING[source],
        maxAmountRaw: buy.funding.maxAmountRaw,
        slippageBps: (await this.getSettings()).slippageBps,
      },
      tradeSubmitBefore: wholeSecond(Date.now() + 235_000),
    };
    // Prepare through run(), stopping at the first signature: by then the SDK has checked the plan's
    // order, funding, budget and requests and recomputed planHash, so the review shows a verified plan.
    let checked: TradePlan | undefined;
    const reviewOnly: Eip1193Provider = {
      request: async () => {
        throw new Error('A plan is not signed during review.');
      },
    };
    const base = this.predictionSdkContext(accountId, cfg, reviewOnly, checkPlanRequests);
    // Review never commits: only the prepare call may reach Kairos.
    const reviewCtx: WalletContext = {
      ...base,
      request: (wallet, method, path, opts) =>
        method === 'POST' && path !== '/v3/trade-plans'
          ? Promise.reject(new Error('A plan is not committed during review.'))
          : base.request(wallet, method, path, opts),
    };
    const plan = await new TradePlansClient(reviewCtx)
      .run(input, {
        idempotencyKey,
        onSign: (_request, verified) => {
          checked = verified as TradePlan;
          throw new PlanReviewed();
        },
      })
      .then(() => {
        throw new Error('Kairos did not return a reviewable plan for this order.');
      })
      .catch((error) => {
        if (error instanceof PlanReviewed && checked) return checked;
        if (error instanceof FeeSettlementRequiredError) {
          throw new Error(
            'Settle the outstanding balance in Predictions → Positions → Trading fees, then review the order again.',
            { cause: error },
          );
        }
        throw error;
      });
    if (
      plan.status !== 'needs_signatures' ||
      plan.venue !== market.venue ||
      !sameAddress(plan.wallet, acct.evmAddress) ||
      plan.partnerId !== cfg.partnerId ||
      !/^0x[0-9a-f]{64}$/i.test(plan.planHash)
    ) {
      throw new Error('Kairos did not return a reviewable plan for this order.');
    }
    for (const [id, pending] of this.preparedPredictionPlans) {
      if (Date.parse(pending.plan.executeBefore) < Date.now() && !pending.running) this.preparedPredictionPlans.delete(id);
    }
    const action: Extract<Action, { type: 'order' }> = {
      type: 'order',
      market: ref,
      outcome: token.outcome,
      side: 'buy',
      price: buy.price,
      size: buy.shares,
      timeInForce: 'GTC',
    };
    this.preparedPredictionPlans.set(plan.id, {
      accountId,
      executionUrl: cfg.executionUrl,
      partnerId: cfg.partnerId,
      plan,
      input,
      idempotencyKey,
      action,
      tokenId: token.tokenId,
    });
    return plan;
  }

  async predictionExecuteFundedBuy(accountId: string, id: string): Promise<TradePlan> {
    const cfg = await this.kairosConfig();
    const reviewed = this.preparedPredictionPlans.get(id);
    if (
      !reviewed ||
      reviewed.accountId !== accountId ||
      reviewed.executionUrl !== cfg.executionUrl ||
      reviewed.partnerId !== cfg.partnerId ||
      reviewed.running ||
      Date.parse(reviewed.plan.executeBefore) <= Date.now()
    ) {
      throw new Error('This plan can no longer be signed. Review a fresh plan or check the existing plan status.');
    }
    const acct = await this.predictionAccount(accountId);
    if (reviewed.running) throw new Error('This plan is already being submitted.');
    reviewed.running = true;
    try {
      const holdingWallet =
        reviewed.plan.venue === 'polymarket' ? await this.tradingWalletOf(cfg, acct.evmAddress) : acct.evmAddress;
      const provider = this.predictionSdkSigner(acct, PLAN_SIGNATURES, '0x89');
      const client = new TradePlansClient(
        this.predictionSdkContext(accountId, cfg, provider, (value) => {
          const fresh = value as TradePlan;
          if (
            fresh.id !== id ||
            fresh.planHash !== reviewed.plan.planHash ||
            fresh.partnerId !== cfg.partnerId ||
            !sameAddress(fresh.tradingWallet, holdingWallet)
          ) {
            throw new UnsafeSigningRequestError('the trade plan changed since review');
          }
          checkPlanRequests(fresh);
          for (const request of fresh.requests.filter((r) => r.purpose === 'trade')) {
            verifySigningRequest(request.request, {
              wallet: acct.evmAddress,
              tradingWallet: holdingWallet,
              action: reviewed.action,
              tokenId: reviewed.tokenId,
              noSetup: true,
            });
          }
        }),
      );
      await this.rememberPredictionActivity(accountId, cfg, {
        id,
        kind: 'funded-buy',
        market: reviewed.action.market,
        createdAt: Date.now(),
      });
      return await client.run(reviewed.input, {
        idempotencyKey: reviewed.idempotencyKey,
        maxDebitRaw: reviewed.plan.tradeBudget.maxDebitRaw,
      });
    } catch (error) {
      if (error instanceof WaitTimeoutError && error.last) return error.last as TradePlan;
      throw error;
    } finally {
      this.preparedPredictionPlans.delete(id);
    }
  }

  async predictionFundedBuyStatus(accountId: string, id: string): Promise<TradePlan> {
    const acct = await this.predictionAccount(accountId);
    const cfg = await this.kairosConfig();
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid plan ID.');
    return new TradePlansClient(this.predictionSdkContext(accountId, cfg)).get(id, acct.evmAddress);
  }

  private predictionActivityKey(accountId: string, cfg: KairosConfig) {
    return `${accountId}|${cfg.executionUrl}|${cfg.partnerId}`;
  }

  private async rememberPredictionActivity(accountId: string, cfg: KairosConfig, item: PredictionActivity) {
    const key = this.predictionActivityKey(accountId, cfg);
    await this.mutex.run(async () => {
      const all = (await this.store.get<Record<string, PredictionActivity[]>>(K.predictionActivity)) ?? {};
      const existing = all[key] ?? [];
      if (existing.some((activity) => activity.id === item.id)) return;
      await this.store.set(K.predictionActivity, { ...all, [key]: [item, ...existing].slice(0, 25) });
    });
  }

  async predictionActivity(accountId: string): Promise<PredictionActivity[]> {
    await this.predictionAccount(accountId);
    const key = this.predictionActivityKey(accountId, await this.kairosConfig());
    return (await this.store.get<Record<string, PredictionActivity[]>>(K.predictionActivity))?.[key] ?? [];
  }

  async predictionFees(accountId: string): Promise<FeeSummary> {
    const acct = await this.predictionAccount(accountId);
    const cfg = await this.kairosConfig();
    return new FeesClient(this.predictionSdkContext(accountId, cfg)).summary(acct.evmAddress);
  }

  private readonly feePayments = new Mutex();

  private feePaymentKey(cfg: KairosConfig, wallet: string, id: string) {
    return `predictionFee|${cfg.executionUrl}|${cfg.partnerId}|${wallet.toLowerCase()}|${id}`;
  }

  async predictionPrepareFee(accountId: string, venue: FeeVenue) {
    if (venue !== 'polymarket' && venue !== 'predictfun') throw new Error('Unsupported fee settlement venue.');
    const acct = await this.predictionAccount(accountId);
    const cfg = await this.kairosConfig();
    const fees = new FeesClient(this.predictionSdkContext(accountId, cfg));
    const settlement = await fees.createSettlement(acct.evmAddress, venue);
    checkFeeDecimals(settlement);
    const key = this.feePaymentKey(cfg, acct.evmAddress, settlement.id);
    const signed = await this.store.get<{ raw: Hex; hash: Hex }>(key);
    let gasMaxWei: string | undefined;
    if (!signed && venue === 'predictfun' && settlement.status === 'awaiting_signature') {
      const { tx, network } = await this.predictionFeeTransaction(settlement, acct.evmAddress);
      gasMaxWei = (await evm.estimateTx(network, tx)).fee.toString();
    }
    return { settlement, gasMaxWei, resuming: !!signed };
  }

  async predictionSettleFee(
    accountId: string,
    review: {
      id: string;
      venue: FeeVenue;
      amountRaw: string;
      treasury: string;
      gasMaxWei?: string;
    },
  ): Promise<FeeSettlement> {
    return this.feePayments.run(async () => {
      const acct = await this.predictionAccount(accountId);
      const wallet = acct.evmAddress;
      const cfg = await this.kairosConfig();
      const fees = new FeesClient(this.predictionSdkContext(accountId, cfg));
      const settlement = await fees.getSettlement(review.id, wallet);
      if (settlement.status !== 'awaiting_signature') return settlement;
      const holding = settlement.venue === 'polymarket' ? await this.tradingWalletOf(cfg, wallet) : wallet;
      if (
        settlement.id !== review.id ||
        settlement.venue !== review.venue ||
        settlement.amountRaw !== review.amountRaw ||
        !isValidAddress('evm', settlement.treasury) ||
        !sameAddress(settlement.treasury, review.treasury) ||
        !sameAddress(settlement.holdingWallet, holding) ||
        settlement.decimals !== FEE_DECIMALS[settlement.venue]
      ) {
        throw new UnsafeSigningRequestError('the fee settlement changed since review');
      }
      const key = this.feePaymentKey(cfg, wallet, settlement.id);
      const signer = this.predictionSdkSigner(acct, new Set(['Batch']), '0x89');
      const provider: Eip1193Provider = {
        request: async (request) => {
          if (request.method !== 'eth_sendTransaction') return signer.request(request);
          // Fee SDK validates the exact recipient, asset, amount, owner and chain before asking the provider.
          const { tx, network } = await this.predictionFeeTransaction(settlement, wallet);
          let signed = await this.store.get<{ raw: Hex; hash: Hex }>(key);
          if (!signed) {
            const fee = await evm.estimateTx(network, tx);
            if (!review.gasMaxWei || fee.fee > BigInt(review.gasMaxWei)) {
              throw new Error('The BNB network fee increased. Review the payment again.');
            }
            const pricing =
              fee.gasPrice !== undefined
                ? { gasPrice: fee.gasPrice }
                : { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas };
            const raw = await evm.signTransaction(network, this.evmKey(acct), { ...tx, gas: fee.gas, ...pricing });
            signed = { raw, hash: keccak256(raw) };
            // Save before broadcast so a retry sends the same transaction, including after a lost response.
            await this.store.set(key, signed);
          }
          try {
            await evm.publicClient(network).sendRawTransaction({ serializedTransaction: signed.raw });
          } catch (error) {
            if (!(await evm.txKnown(network, signed.hash))) throw error;
          }
          return signed.hash;
        },
      };
      const ctx = this.predictionSdkContext(accountId, cfg, provider);
      const paying = new FeesClient({
        ...ctx,
        request: <T>(address: string, method: 'GET' | 'POST', path: string, opts?: RequestOptions) =>
          method === 'POST' && path === '/v3/fees/settlements'
            ? Promise.resolve(settlement as T)
            : ctx.request<T>(address, method, path, opts),
      });
      try {
        return await paying.settle(wallet, settlement.venue, { timeoutMs: 20_000 });
      } catch (error) {
        if (error instanceof WaitTimeoutError && error.last) return error.last as FeeSettlement;
        throw error;
      }
    });
  }

  private async predictionFeeTransaction(settlement: FeeSettlement, wallet: string) {
    const request = settlement.walletRequest?.request;
    const payload = request?.params[0] as { to?: Hex; from?: Hex; data?: Hex } | undefined;
    if (
      settlement.venue !== 'predictfun' ||
      request?.method !== 'eth_sendTransaction' ||
      !sameAddress(payload?.from, wallet) ||
      !payload?.to ||
      !payload.data
    ) {
      throw new UnsafeSigningRequestError('unexpected fee transfer request');
    }
    const network = (await this.getNetwork('bsc')) as EvmNetwork;
    return { tx: { from: wallet as Hex, to: payload.to, data: payload.data, value: 0n } satisfies TransactionRequest, network };
  }

  async predictionFeeStatus(accountId: string, id: string): Promise<FeeSettlement> {
    const acct = await this.predictionAccount(accountId);
    const cfg = await this.kairosConfig();
    return new FeesClient(this.predictionSdkContext(accountId, cfg)).getSettlement(id, acct.evmAddress);
  }

  private async predictionTraderStats(accountId: string) {
    const acct = await this.predictionAccount(accountId);
    const cfg = await this.kairosConfig();
    const { tradingWallet } = await kairos.getStatus(cfg, acct.evmAddress, this.fetchFn);
    if (!tradingWallet) return undefined;
    return kairos.getTraderPositions(cfg, tradingWallet, this.fetchFn);
  }

  /** Shares of each outcome of one market held on its venue, read on-chain. */
  async predictionHoldings(accountId: string, marketId: string): Promise<Record<string, number>> {
    const market = await this.predictionMarket(marketId);
    const balances = await this.predictionTradingBalances(
      accountId,
      market.tokens.map((t) => t.tokenId),
      market.venue,
    );
    return Object.fromEntries(market.tokens.map((t) => [t.outcome, balances.get(t.tokenId) ?? 0]));
  }

  /**
   * Polymarket shares are in the trading wallet on Polygon; Predict.fun shares in the account itself
   * on BNB Chain; Hyperliquid shares on the account's own HyperCore spot balances.
   */
  private async predictionTradingBalances(
    accountId: string,
    tokenIds: string[],
    venue: Venue = 'polymarket',
  ): Promise<Map<string, number>> {
    const acct = await this.predictionAccount(accountId);
    if (venue === 'hyperliquid') {
      const { shares } = await hyperliquidAccount(acct.evmAddress, this.fetchFn);
      return new Map(tokenIds.map((id) => [id, shares.get(outcomeToken(id)) ?? 0]));
    }
    const owner =
      venue === 'polymarket'
        ? (await kairos.getStatus(await this.kairosConfig(), acct.evmAddress, this.fetchFn)).tradingWallet
        : acct.evmAddress;
    const network = (await this.getNetwork(VENUE_INFO[venue].networkId)) as EvmNetwork;
    return outcomeBalances(network, owner, tokenIds, venue);
  }

  /** Shares from recently filled orders that the position index doesn't list yet, read on-chain (best effort). */
  private async heldFromRecentFills(
    accountId: string,
    orders: ApiRecord[],
    open: ApiRecord[],
    metas: Map<string, MarketMeta>,
  ): Promise<ApiRecord[]> {
    const missing = new Set(filledTokensMissing(orders, open, metas));
    if (!missing.size) return [];
    const byVenue = new Map<Venue, string[]>();
    for (const meta of new Set(orders.map((o) => metaFor(metas, o)))) {
      const ids = (meta?.tokens ?? []).map((t) => t.tokenId).filter((id) => missing.has(id));
      if (meta && ids.length) byVenue.set(meta.venue, [...(byVenue.get(meta.venue) ?? []), ...ids]);
    }
    const balances = new Map<string, number>();
    await Promise.all(
      [...byVenue].map(async ([venue, ids]) => {
        const read = await this.predictionTradingBalances(accountId, ids, venue).catch(() => undefined);
        read?.forEach((v, k) => balances.set(k, v));
      }),
    );
    return heldFromFills(orders, metas, balances);
  }

  /** Open positions with each venue's sizes read on-chain where possible (best effort, per venue). */
  private async withOnchainSizes(accountId: string, open: ApiRecord[]): Promise<ApiRecord[]> {
    const venueOf = (r: ApiRecord): Venue => (isVenue(r.venue) ? r.venue : 'polymarket');
    const tokenOf = (r: ApiRecord) => String(r.tokenId ?? r.token_id ?? '');
    let out = open;
    for (const venue of new Set(open.map(venueOf))) {
      const ids = open.filter((r) => venueOf(r) === venue).map(tokenOf);
      const balances = await this.predictionTradingBalances(accountId, ids, venue).catch(() => undefined);
      if (balances) out = withOnchainSizes(out, balances);
    }
    return out;
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

  /**
   * Runs a Kairos action, validating each step and answering it with the account's EVM key: a
   * typed-data or message signature, or (Predict.fun approvals) transactions sent on BNB Chain.
   */
  /** Trading (deposit) wallet per Kairos node and owner: it never changes, so one status read is enough. */
  private readonly tradingWallets = new Map<string, string>();

  private async tradingWalletOf(cfg: KairosConfig, wallet: string): Promise<string> {
    const key = `${cfg.executionUrl}|${wallet.toLowerCase()}`;
    const known = this.tradingWallets.get(key);
    if (known) return known;
    const { tradingWallet } = await kairos.getStatus(cfg, wallet, this.fetchFn);
    if (tradingWallet) this.tradingWallets.set(key, tradingWallet);
    return tradingWallet;
  }

  private async runPredictionAction<R>(
    accountId: string,
    action: kairos.ActionInput,
    tokenId?: string,
    route?: { ctx: RouteContext; progress: RouteProgress; onStep?: (step: Step) => void; initialStep?: Step },
    options: { reconnectPolymarket?: boolean; onOrderSigned?: () => void } = {},
  ): Promise<R> {
    const { reconnectPolymarket = false, onOrderSigned } = options;
    const acct = await this.predictionAccount(accountId);
    const cfg = action.type === 'combo' ? await this.comboConfig() : await this.kairosConfig();
    const tradingWallet = await this.tradingWalletOf(cfg, acct.evmAddress);
    const pk = this.evmKey(acct);
    const wallet = acct.evmAddress;
    const signText = (message: string) => evm.signMessage(pk, message.startsWith('0x') ? { raw: message as Hex } : message);
    const comboRequests = new Set<string>();
    let signedReconnect = false;
    const result = await kairos.runAction<R>(cfg, wallet, action, {
      fetchFn: this.fetchFn,
      onStep: route?.onStep,
      initialStep: route?.initialStep,
      polymarketOnly: reconnectPolymarket,
      answer: async (step) => {
        // A routed order's legs are ordinary venue orders: check the plan, then the leg like any order.
        let stepAction: Action = action;
        let stepToken = tokenId;
        let legIndex: number | undefined;
        if (route) {
          const leg = verifyRoutedStep(step, { route: route.ctx, progress: route.progress });
          stepAction = leg.action;
          stepToken = leg.tokenId;
          legIndex = leg.index;
        }
        const method = step.request?.method;
        if (reconnectPolymarket && method !== 'eth_signTypedData_v4') {
          throw new UnsafeSigningRequestError('reconnect only requests a Polymarket ownership proof');
        }
        if (stepAction.type === 'combo') {
          const request = JSON.stringify(step.request);
          if (
            step.type !== 'combo' ||
            (step.chainId && Number(step.chainId) !== 137) ||
            (step.venue && step.venue !== 'polymarket')
          ) {
            throw new UnsafeSigningRequestError('unexpected combo signing step');
          }
          // One confirmation, one order: a second signature could fill alongside the first.
          if (comboRequests.size >= 1) {
            throw new UnsafeSigningRequestError(
              comboRequests.has(request)
                ? 'this combo order was already signed'
                : 'the combo asked for a second order; review it again',
            );
          }
          comboRequests.add(request);
        }
        if (method === 'wallet_sendCalls') {
          if (route) throw new UnsafeSigningRequestError('transactions are not expected inside a routed order');
          return { result: await this.sendVenueApprovals(acct, pk, verifyWalletCalls(step, { wallet, action })) };
        }
        if (method === 'personal_sign') {
          const message =
            stepAction.type === 'login'
              ? verifyLoginRequest(step.request, { wallet, action: stepAction, executionUrl: cfg.executionUrl })
              : verifyVenueLoginRequest(step, { wallet, action: stepAction });
          return { signature: await signText(message) };
        }
        const td = verifySigningRequest(step.request, {
          wallet,
          tradingWallet,
          action: stepAction,
          tokenId: stepToken,
          noSetup: !!route,
        });
        if (reconnectPolymarket) {
          if (signedReconnect && step.type === 'setup' && td.primaryType === 'Batch' && td.domain.name === 'DepositWallet') {
            throw new PredictionOrderError(
              'Complete Polymarket trading setup from the market before placing a new order.',
              'POLYMARKET_SETUP_REQUIRED',
            );
          }
          if (signedReconnect || step.type !== 'setup' || td.primaryType !== 'ClobAuth') {
            throw new UnsafeSigningRequestError('reconnect only requests a Polymarket ownership proof');
          }
          signedReconnect = true;
        }
        if (route && step.chainId && Number(step.chainId) !== Number(td.domain.chainId)) {
          throw new UnsafeSigningRequestError('the step and its order name different chains');
        }
        if (route && !ROUTED_SIGNATURES.has(td.primaryType)) {
          throw new UnsafeSigningRequestError(`unexpected request ${td.primaryType} inside a routed order`);
        }
        if (route && legIndex !== undefined && ROUTED_ORDER_SIGNATURES.has(td.primaryType)) {
          // One order signature per leg: a second would be a second order.
          if (route.progress.signed.has(legIndex)) throw new UnsafeSigningRequestError('this leg was already signed');
          route.progress.signed.add(legIndex);
        }
        if (route && legIndex !== undefined && td.primaryType === 'HyperliquidTransaction:UsdClassTransfer') {
          const transferred = (route.progress.transferred ??= new Set());
          if (transferred.has(legIndex)) throw new UnsafeSigningRequestError('this leg already authorized a funding transfer');
          transferred.add(legIndex);
        }
        const types = { ...td.types };
        delete types.EIP712Domain;
        const signature = await evm.signTypedData(pk, {
          domain: td.domain,
          types,
          primaryType: td.primaryType,
          message: td.message,
        } as never);
        if (stepAction.type === 'order' && ROUTED_ORDER_SIGNATURES.has(td.primaryType)) onOrderSigned?.();
        return { signature };
      },
    });
    if (reconnectPolymarket && !signedReconnect) throw new Error('Polymarket did not request a fresh ownership proof');
    return result;
  }

  /**
   * Sends Predict.fun's one-time approvals from the account on BNB Chain, one transaction each
   * (BNB pays the gas), and returns their hashes. Kairos waits for the allowances to land.
   */
  private async sendVenueApprovals(
    acct: Account & { evmAddress: string },
    pk: Hex,
    calls: { to: string; data: string }[],
  ): Promise<Hex[]> {
    const bsc = (await this.getNetwork(VENUE_INFO.predictfun.networkId)) as EvmNetwork;
    let nonce = await evm.publicClient(bsc).getTransactionCount({ address: acct.evmAddress as Hex, blockTag: 'pending' });
    const hashes: Hex[] = [];
    for (const c of calls) {
      const hash = await evm.sendTx(bsc, pk, {
        from: acct.evmAddress as Hex,
        to: c.to as Hex,
        data: c.data as Hex,
        value: 0n,
        nonce: nonce++,
      });
      hashes.push(hash);
      await this.recordTx({
        hash,
        networkId: bsc.id,
        chainType: 'evm',
        from: acct.evmAddress,
        to: c.to,
        title: 'Approved BNB Chain prediction trading',
        direction: 'out',
        kind: 'contract',
        timestamp: Date.now(),
        status: 'pending',
        source: 'local',
      });
    }
    return hashes;
  }

  /**
   * Trading setup. Polymarket: proves wallet ownership and approves its exchange (no gas).
   * Predict.fun: approvals sent on BNB Chain (paid in BNB) and a sign-in. A multi-venue node sets
   * up every venue unless `venues` narrows it; an older node only knows Polymarket.
   */
  async predictionSetup(accountId: string, venues?: Venue[]): Promise<SetupResult> {
    return this.runPredictionAction<SetupResult>(accountId, venues?.length ? { type: 'setup', venues } : { type: 'setup' });
  }

  async predictionReconnectPolymarket(accountId: string): Promise<SetupResult> {
    // Polymarket-only setup requests a fresh proof even when approvals are already in place.
    const result = await this.runPredictionAction<SetupResult>(accountId, { type: 'setup' }, undefined, undefined, {
      reconnectPolymarket: true,
    });
    if (!result?.ready) throw new Error('Polymarket did not confirm the connection');
    return result;
  }

  async predictionOrder(
    accountId: string,
    params: { marketId: string; outcome: string; side: 'buy' | 'sell'; price: string; size: string; timeInForce?: TimeInForce },
  ): Promise<OrderResult> {
    const market = await this.predictionMarket(params.marketId);
    try {
      const result = await this.placeOrder(accountId, market, params);
      if (isUnconfirmedOrder(result)) {
        throw new PredictionOrderError('The order outcome is unconfirmed.', 'ORDER_OUTCOME_UNKNOWN');
      }
      return result;
    } catch (e) {
      if (e instanceof PredictionOrderError) throw e;
      const error = (e as Error).message;
      if (needsPolymarketReconnect({ venue: market.venue, error, errorCode: venueErrorCode(e) })) {
        throw new PredictionOrderError(error, 'POLYMARKET_SIGNER_MISMATCH');
      }
      // Kairos nodes can have order placement switched off (e.g. staging); say where to change it.
      // The venue found nothing to match at the order's limit: the book moved, or was stale when priced.
      if (
        /no liquidity|no orders found to match|MARKET_INSUFFICIENT_LIQUIDITY|FOK_NOT_FILLED|^NO_MATCH/i.test((e as Error).message)
      ) {
        throw new Error(
          `Nothing filled: the price moved before the order reached the exchange. Nothing was spent; check the book and try again, or use a limit order.`,
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

  private async resolveRoutedBuy(req: RoutedBuyRequest, canonical = false) {
    if (!req.legs.length) throw new Error('Nothing to buy');
    if (!(req.maxPrice > 0 && req.maxPrice <= 1)) throw new Error('Invalid price limit');
    if (!Number.isFinite(req.shares) || req.shares <= 0) throw new Error('Enter a number of shares');
    if (
      req.slippageCents !== undefined &&
      (!Number.isInteger(req.slippageCents) || req.slippageCents < 1 || req.slippageCents > 99)
    ) {
      throw new Error('Price movement must be between 1¢ and 99¢.');
    }
    if (req.maxSpend !== undefined && (!Number.isFinite(req.maxSpend) || req.maxSpend <= 0))
      throw new Error('Invalid spending limit');
    const primary = await this.predictionMarket(req.marketId);
    const primaryToken = primary.tokens.find((t) => t.outcome.toLowerCase() === req.outcome.toLowerCase());
    if (!primaryToken) throw new Error(`Unknown outcome ${req.outcome}`);
    const link =
      canonical || req.legs.length > 1 || req.legs[0].key !== req.marketId ? await this.predictionLink(req.marketId) : undefined;
    const side = link?.markets.find((m) => m.key === primary.marketId) ?? link?.markets.find((m) => m.venue === primary.venue);
    const sideOf =
      side && (side.tokenYes === primaryToken.tokenId ? 'yes' : side.tokenNo === primaryToken.tokenId ? 'no' : undefined);

    // Each leg: the venue's own market and outcome name for the same side, matched by token id.
    const legs = await Promise.all(
      req.legs.map(async (l) => {
        if (!(l.price > 0 && l.price < 1) || !(l.size > 0)) throw new Error('Invalid leg in the plan');
        if (l.price > req.maxPrice + 1e-9) throw new Error('A leg is priced above your limit');
        if (l.key === primary.marketId) return { ...l, market: primary, token: primaryToken };
        const linked = link?.markets.find((m) => m.key === l.key);
        if (!linked || !sideOf) throw new Error('That market is no longer linked to this one');
        const market = await this.predictionMarket(l.key);
        const tokenId = sideOf === 'yes' ? linked.tokenYes : linked.tokenNo;
        const token = market.tokens.find((t) => t.tokenId === tokenId);
        if (!token) throw new Error(`${VENUE_INFO[market.venue].name} doesn't list this outcome`);
        return { ...l, market, token };
      }),
    );
    const orderRef = (m: MarketDetail) =>
      m.venue === 'polymarket' ? `polymarket:${m.conditionId}` : `${m.venue}:${m.venueMarketId}`;
    const routeMarkets = legs.map((l) => ({ key: l.key, market: l.market, token: l.token }));
    if (canonical && link && sideOf) {
      const others = link.markets.filter((m) => !routeMarkets.some((l) => l.market.venue === m.venue));
      const results = await Promise.allSettled(
        others.map(async (linked) => {
          const market = await this.predictionMarket(linked.key);
          const token = market.tokens.find((t) => t.tokenId === (sideOf === 'yes' ? linked.tokenYes : linked.tokenNo));
          return token && { key: linked.key, market, token };
        }),
      );
      for (const result of results) if (result.status === 'fulfilled' && result.value) routeMarkets.push(result.value);
    }
    const spendCap = req.maxSpend ?? legs.reduce((s, l) => s + l.price * l.size, 0) * 1.01 + 0.01;
    const sharesCap = legs.reduce((s, l) => s + l.size, 0) * 1.02 + 0.01;
    const ctx: RouteContext = {
      markets: routeMarkets.map((l) => ({
        venue: l.market.venue,
        market: orderRef(l.market),
        tokenId: l.token.tokenId,
        outcome: l.token.outcome,
        fee: l.market.fee,
      })),
      maxPrice: req.maxPrice,
      maxSpend: spendCap,
      maxShares: sharesCap,
    };
    const action: Extract<Action, { type: 'routedOrder' }> = {
      type: 'routedOrder',
      market: orderRef(primary),
      outcome: canonical && sideOf ? (sideOf === 'yes' ? 'Yes' : 'No') : primaryToken.outcome,
      size: String(Math.floor(req.shares * 100) / 100),
      maxPrice: String(Math.min(1, Math.ceil(req.maxPrice * 1_000_000) / 1_000_000)),
      slippageCents: req.slippageCents,
      timeInForce: 'FAK',
      clientOrderId: orderId(),
    };
    return { legs, routeMarkets, ctx, action, linked: !!sideOf };
  }

  private readonly pendingRoutes = new Map<
    string,
    {
      accountId: string;
      executionUrl: string;
      expiresAtMs: number;
      step: Step;
      legs: Awaited<ReturnType<WalletService['resolveRoutedBuy']>>['routeMarkets'];
      action: Extract<Action, { type: 'routedOrder' }>;
      ctx: RouteContext;
      plan: string;
    }
  >();

  /** Starts a Kairos route without signing anything. A separate call authorizes this exact plan. */
  async predictionPrepareRoutedBuy(accountId: string, req: RoutedBuyRequest): Promise<PreparedRoute> {
    const cfg = await this.kairosConfig();
    if (this.routedOrderOff.has(cfg.executionUrl)) return { kind: 'wallet', note: 'This Kairos node has routing turned off.' };
    const acct = await this.predictionAccount(accountId);
    const { routeMarkets, linked, ctx, action } = await this.resolveRoutedBuy(req, true);
    if (!linked) return { kind: 'wallet' };
    let step: Step;
    try {
      step = await kairos.startAction(cfg, acct.evmAddress, action, this.fetchFn);
    } catch (err) {
      if (!routedOrderUnavailable(err)) throw err;
      if ((err as HttpError).status === 403 || (err as HttpError).status === 404) this.routedOrderOff.add(cfg.executionUrl);
      return { kind: 'wallet', note: (err as Error).message };
    }
    if (step.status === 'failed') {
      const result = step.result as RoutedOrderResult | null;
      if (result?.routed && Array.isArray(result.legs)) {
        return { kind: 'failed', execution: toRouteExecution(result, routeMarkets) };
      }
    }
    if (step.status === 'failed' || step.status === 'done') throw new kairos.ActionFailedError(step);
    const progress: RouteProgress = { signed: new Set() };
    verifyRoutePlan(step.route, { route: ctx, progress });
    const expiresAtMs = Math.min(step.expiresAtMs ?? Infinity, Date.now() + 60_000);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now() || !step.id) throw new Error('This route has expired.');
    for (const [id, pending] of this.pendingRoutes) if (pending.expiresAtMs <= Date.now()) this.pendingRoutes.delete(id);
    const id = randomId();
    this.pendingRoutes.set(id, {
      accountId,
      executionUrl: cfg.executionUrl,
      expiresAtMs,
      step,
      legs: routeMarkets,
      action,
      ctx,
      plan: progress.plan!,
    });
    return { kind: 'kairos', id, expiresAtMs, route: step.route! };
  }

  async predictionExecuteRoutedBuy(accountId: string, id: string): Promise<RouteExecution> {
    const pending = this.pendingRoutes.get(id);
    if (!pending || pending.accountId !== accountId || pending.expiresAtMs <= Date.now())
      throw new Error('Refresh the expired route before buying.');
    this.pendingRoutes.delete(id);
    if ((await this.kairosConfig()).executionUrl !== pending.executionUrl)
      throw new Error('The Kairos environment changed. Review a new route.');
    const progress: RouteProgress = { signed: new Set(), plan: pending.plan };
    try {
      const result = await this.runPredictionAction<RoutedOrderResult>(accountId, pending.action, undefined, {
        ctx: pending.ctx,
        progress,
        initialStep: pending.step,
      });
      return toRouteExecution(result, pending.legs);
    } catch (err) {
      const result = err instanceof kairos.ActionFailedError ? (err.step.result as RoutedOrderResult | null) : null;
      if (result?.routed && Array.isArray(result.legs)) return toRouteExecution(result, pending.legs);
      if (progress.signed.size && classifyLegError(err, true) !== 'nothing') {
        throw new Error(`${(err as Error).message} Check your orders before buying again.`, { cause: err });
      }
      throw err;
    }
  }

  /** Runs a locally reviewed market buy. The wallet-only path signs each displayed leg at its reviewed size. */
  async predictionRoutedBuy(accountId: string, req: RoutedBuyRequest, walletOnly = false): Promise<RouteExecution> {
    const cfg = await this.kairosConfig();
    const { legs, ctx, action } = await this.resolveRoutedBuy(req);
    if (walletOnly && req.maxSpend !== undefined) {
      const maxCost = legs.reduce((sum, leg) => {
        const fee = leg.market.fee?.kind === 'curve' ? feePerShare(leg.market.fee, leg.price) : 0;
        return sum + leg.size * (leg.price + fee);
      }, 0);
      if (maxCost > req.maxSpend + 1e-6) throw new Error('This route exceeds your spending limit. Review an updated trade.');
    }

    // Kairos' routedOrder: one action, its own plan, every leg bounded by the user's.
    if (!walletOnly && legs.length > 1 && !this.routedOrderOff.has(cfg.executionUrl)) {
      const progress: RouteProgress = { signed: new Set() };
      let signedAny = false;
      try {
        const result = await this.runPredictionAction<RoutedOrderResult>(accountId, action, undefined, {
          ctx,
          progress,
          onStep: () => (signedAny = true),
        });
        return toRouteExecution(result, legs);
      } catch (e) {
        const result = e instanceof kairos.ActionFailedError ? (e.step.result as RoutedOrderResult | null) : null;
        if (result?.routed && Array.isArray(result.legs)) return toRouteExecution(result, legs);
        if (progress.signed.size && classifyLegError(e, true) !== 'nothing') {
          throw new PredictionOrderError((e as Error).message, 'ORDER_OUTCOME_UNKNOWN');
        }
        // Refused before anything was signed: route it here instead.
        if (signedAny || !routedOrderUnavailable(e)) throw e;
        if ((e as HttpError).status === 403 || (e as HttpError).status === 404) this.routedOrderOff.add(cfg.executionUrl);
      }
    }

    // The wallet routes it: one FAK order per venue, cheapest first.
    const results: RouteLegResult[] = [];
    let carry = 0;
    let stop = false;
    for (const [i, l] of legs.entries()) {
      const venue = l.market.venue;
      if (stop) {
        results.push({ venue, key: l.key, size: l.size, status: 'skipped' });
        continue;
      }
      // What an earlier venue didn't fill moves here, as far as this leg's budget allows at its limit.
      const step = venue === 'hyperliquid' ? 1 : 0.01;
      const extra = i > 0 && !walletOnly ? Math.floor(carry / step) * step : 0;
      const size = Number((l.size + extra).toFixed(6));
      try {
        const r = await this.placeOrder(accountId, l.market, {
          marketId: l.key,
          outcome: l.token.outcome,
          side: 'buy',
          price: String(l.price),
          size: String(size),
          timeInForce: 'FAK',
        });
        const filled = r.filledSize === null || r.filledSize === undefined ? undefined : Number(r.filledSize);
        const avgPrice = r.avgPrice ? Number(r.avgPrice) : undefined;
        if (isUnconfirmedOrder(r)) {
          results.push({ venue, key: l.key, size, status: 'unknown', orderId: r.orderId, error: r.message ?? undefined });
          stop = true;
          continue;
        }
        if (r.final === false) {
          // Still matching (Predict.fun always answers so): it may fill all of it, so nothing moves on.
          results.push({ venue, key: l.key, size, status: 'working', filled, avgPrice, orderId: r.orderId });
          carry = 0;
          continue;
        }
        const got = filled ?? size;
        carry = Math.max(0, size - got);
        results.push({
          venue,
          key: l.key,
          size,
          status: got <= 0 ? 'failed' : carry > 1e-9 ? 'partial' : 'filled',
          filled: got,
          avgPrice,
          orderId: r.orderId,
          error: got <= 0 ? (r.message ?? 'Nothing filled') : undefined,
        });
      } catch (e) {
        const kind = classifyLegError(e);
        if (kind === 'refused' && !results.some((r) => r.filled)) throw e;
        results.push({
          venue,
          key: l.key,
          size,
          status: kind === 'nothing' ? 'failed' : 'unknown',
          error: (e as Error).message,
          errorCode: venueErrorCode(e),
        });
        if (kind === 'nothing') carry = size;
        else stop = true;
      }
    }
    const filled = results.reduce((s, r) => s + (r.filled ?? 0), 0);
    if (
      !results.some((r) => r.status === 'filled' || r.status === 'partial' || r.status === 'working' || r.status === 'unknown') &&
      !results.some(needsPolymarketReconnect)
    ) {
      throw new Error(`Nothing filled: ${results.map((r) => `${VENUE_INFO[r.venue].name}: ${r.error ?? r.status}`).join('; ')}`);
    }
    return { mode: 'wallet', legs: results, filled, uncertain: results.some((r) => r.status === 'unknown') };
  }

  /** Kairos nodes where routedOrder answered "not enabled": the wallet routes there itself. */
  private readonly routedOrderOff = new Set<string>();

  /** Places one order as given (no friendly rewording of errors: routing reads their codes). */
  private async placeOrder(
    accountId: string,
    market: MarketDetail,
    params: { marketId: string; outcome: string; side: 'buy' | 'sell'; price: string; size: string; timeInForce?: TimeInForce },
  ): Promise<OrderResult> {
    if (market.status !== 'open') throw new Error('This market is not open for trading');
    if (market.venue !== 'polymarket') {
      const status = await this.predictionStatus(accountId);
      if (!status.venues?.[market.venue]) throw new Error("This Kairos node doesn't trade this market yet");
    }
    const token = market.tokens.find((t) => t.outcome.toLowerCase() === params.outcome.toLowerCase());
    if (!token) throw new Error(`Unknown outcome ${params.outcome}`);
    const price = Number(params.price);
    const size = Number(params.size);
    if (!(price > 0 && price < 1)) throw new Error('Price must be between 0 and 1');
    const ticks = price / market.tickSize;
    if (Math.abs(ticks - Math.round(ticks)) > 1e-6) throw new Error(`Price must be a multiple of ${market.tickSize}`);
    if (!(size > 0)) throw new Error('Enter a number of shares');
    let timeInForce = params.timeInForce ?? 'GTC';
    let priceText = String(params.price);
    if (market.venue === 'hyperliquid') {
      // Kairos places exactly the order the wallet signs, so it refuses what Hyperliquid would round.
      if (!Number.isInteger(size)) throw new Error('Hyperliquid trades whole shares');
      // On the tick (checked above), so this only drops float noise such as 0.7700000000000001.
      priceText = String(Number(price.toFixed(5)));
      // No fill-or-kill there: a market order fills what it can now and cancels the rest.
      if (timeInForce === 'FOK') timeInForce = 'FAK';
      if (timeInForce === 'GTD') throw new Error('Hyperliquid orders stay open until filled or cancelled');
    }
    const order: OrderInput = {
      // A bare condition id is Polymarket on every node; other venues are `venue:market_id`.
      market: market.venue === 'polymarket' ? market.conditionId : `${market.venue}:${market.venueMarketId}`,
      outcome: token.outcome,
      side: params.side,
      price: priceText,
      size: String(params.size),
      timeInForce,
      clientOrderId: orderId(),
    };
    let signed = false;
    try {
      return await this.runPredictionAction<OrderResult>(accountId, { type: 'order', ...order }, token.tokenId, undefined, {
        onOrderSigned: () => {
          signed = true;
        },
      });
    } catch (error) {
      if (venueErrorCode(error) === 'ORDER_OUTCOME_UNKNOWN' || (signed && classifyLegError(error, true) !== 'nothing')) {
        throw new PredictionOrderError((error as Error).message, 'ORDER_OUTCOME_UNKNOWN');
      }
      throw error;
    }
  }

  /** USDC on the account's Hyperliquid spot and perps, and on Arbitrum ready to deposit. */
  async hyperliquidBalances(accountId: string): Promise<{ spotUsdc: number; perpsUsdc: number; arbitrumUsdc: number }> {
    const acct = await this.predictionAccount(accountId);
    const arbitrum = VENUE_INFO.hyperliquid.networkId;
    const [hl, onArbitrum] = await Promise.all([
      hyperliquidAccount(acct.evmAddress, this.fetchFn),
      this.getBalance(accountId, arbitrum, { address: ARBITRUM_USDC }).catch(() => 0n),
    ]);
    return { spotUsdc: hl.spotUsdc, perpsUsdc: hl.perpsUsdc, arbitrumUsdc: Number(formatUnits(onArbitrum, 6)) };
  }

  /**
   * Deposits USDC to the account's own Hyperliquid account: a transfer of native USDC on Arbitrum
   * to Hyperliquid's bridge, which credits the sender. Hyperliquid loses deposits under 5 USDC.
   */
  async hyperliquidDeposit(accountId: string, amount: string): Promise<TxRecord> {
    if (!(Number(amount) >= HYPERLIQUID_MIN_DEPOSIT)) {
      throw new Error(`Deposit at least ${HYPERLIQUID_MIN_DEPOSIT} USDC: Hyperliquid loses smaller deposits`);
    }
    const arbitrum = await this.getNetwork(VENUE_INFO.hyperliquid.networkId);
    const usdc = defaultTokens(arbitrum.id).find((t) => sameAddress(t.address, ARBITRUM_USDC));
    if (!usdc) throw new Error('USDC on Arbitrum is not available');
    const params = { accountId, networkId: arbitrum.id, token: usdc, to: HYPERLIQUID_BRIDGE, amount };
    await this.previewSend(params); // balance and gas checks
    const record = await this.send(params);
    const patch = { title: `Deposited ${record.amount} USDC to Hyperliquid`, kind: 'contract' as const };
    await this.updateTx(record.networkId, record.hash, patch);
    return { ...record, ...patch };
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

/** A client order id every venue accepts: `0x` + 32 lowercase hex (Hyperliquid takes nothing else). */
function orderId(): string {
  return `0x${bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(16)))}`;
}

/** The review formats the amount with these decimals, so they must be the asset's, not the server's word. */
function checkFeeDecimals(settlement: FeeSettlement): void {
  if (settlement.decimals !== FEE_DECIMALS[settlement.venue]) {
    throw new UnsafeSigningRequestError('the fee settlement names the wrong number of decimals');
  }
}
