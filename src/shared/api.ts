import type { WalletService } from '../core/wallet/service';
import type { ApprovalRequest, ApprovalResult } from '../core/dapp/types';

/** Wallet methods callable from extension pages. Everything here must take/return JSON-safe values. */
export const WALLET_METHODS = [
  'getState',
  'generateMnemonic',
  'validateMnemonic',
  'createWallet',
  'unlock',
  'verifyPassword',
  'lock',
  'changePassword',
  'resetWallet',
  'addSeed',
  'markSeedBackedUp',
  'addAccount',
  'importPrivateKey',
  'renameAccount',
  'setAccountHidden',
  'selectAccount',
  'removeAccount',
  'renameSeed',
  'removeSeed',
  'revealMnemonic',
  'revealPrivateKey',
  'updateSettings',
  'upsertNetwork',
  'removeNetwork',
  'resetNetwork',
  'testRpc',
  'getTokens',
  'getCustomTokens',
  'lookupToken',
  'addCustomToken',
  'removeCustomToken',
  'searchTokens',
  'getCachedPortfolio',
  'getPortfolio',
  'previewSend',
  'maxSendable',
  'send',
  'waitForTx',
  'getHistory',
  'getQuote',
  'executeQuote',
  'getBridgeStatus',
  'predictionMarkets',
  'predictionMarket',
  'predictionPriceHistory',
  'predictionStatus',
  'predictionOrders',
  'predictionPositions',
  'predictionHoldings',
  'predictionSetup',
  'predictionWalletPusd',
  'predictionRecoveryState',
  'predictionRecoveryStep',
  'predictionWithdrawStart',
  'predictionWithdrawCancel',
  'predictionRecoveryGas',
  'depositInputs',
  'depositAssetId',
  'depositQuote',
  'depositFiatQuotes',
  'depositWithCrypto',
  'depositWithCard',
  'depositStatus',
  'predictionOrder',
  'predictionCancel',
  'getContacts',
  'saveContact',
  'removeContact',
  'getRecentRecipients',
  'getPermissions',
  'revokePermission',
] as const satisfies readonly (keyof WalletService)[];

export type WalletMethod = (typeof WALLET_METHODS)[number];

export type WalletApi = {
  [M in WalletMethod]: WalletService[M] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};

/** Background-only helpers that are not WalletService methods. */
export interface BackgroundApi {
  'approvals.list': () => Promise<ApprovalRequest[]>;
  'approvals.resolve': (id: string, result: ApprovalResult) => Promise<void>;
  /** Build id of the running background worker. */
  buildId: () => Promise<string>;
  /** Pings the auto-lock timer. */
  activity: () => Promise<void>;
}

export type Message =
  { kind: 'wallet'; method: WalletMethod; args: unknown[] } | { kind: 'bg'; method: keyof BackgroundApi; args: unknown[] };

export type Response = { ok: true; result: unknown } | { ok: false; error: string };

export const DAPP_PORT = 'duo-dapp';

/** Messages between the content script and the background over the dApp port. */
export type PortRequest = { id: number; chain: 'evm' | 'solana'; method: string; params?: unknown };
export type PortMessage =
  | { type: 'response'; id: number; result?: unknown; error?: { code: number; message: string; data?: unknown } }
  | { type: 'event'; chain: 'evm' | 'solana'; event: string; data: unknown };
