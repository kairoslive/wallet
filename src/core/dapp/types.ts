export type DappChain = 'evm' | 'solana';

export interface DappRequest {
  chain: DappChain;
  method: string;
  params?: unknown;
}

export type ApprovalType =
  | 'connect'
  | 'evmSignMessage'
  | 'evmSignTypedData'
  | 'evmSendTransaction'
  | 'evmAddNetwork'
  | 'evmWatchAsset'
  | 'solanaSignMessage'
  | 'solanaSignTransaction';

export interface ApprovalRequest {
  id: string;
  type: ApprovalType;
  origin: string;
  /** Type-specific, JSON-serializable data for the approval screen. */
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface ApprovalResult {
  approved: boolean;
  /** Extra data from the approval screen, e.g. selected account ids. */
  data?: Record<string, unknown>;
}

export interface Approver {
  request(type: ApprovalType, origin: string, payload: Record<string, unknown>): Promise<ApprovalResult>;
}

/** EIP-1193 / JSON-RPC style error, also used for Solana wallet-standard errors. */
export class ProviderError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

export const Errors = {
  userRejected: () => new ProviderError(4001, 'User rejected the request'),
  unauthorized: () => new ProviderError(4100, 'The requested account and/or method has not been authorized by the user'),
  unsupported: (m: string) => new ProviderError(4200, `Unsupported method: ${m}`),
  unrecognizedChain: (id: string) =>
    new ProviderError(4902, `Unrecognized chain ID ${id}. Try adding the chain using wallet_addEthereumChain first.`),
  invalidParams: (msg: string) => new ProviderError(-32602, msg),
  internal: (msg: string) => new ProviderError(-32603, msg),
};

/** Events pushed to connected pages. */
export type DappEvent =
  | { chain: 'evm'; event: 'accountsChanged'; data: string[] }
  | { chain: 'evm'; event: 'chainChanged'; data: string }
  | { chain: 'evm'; event: 'connect'; data: { chainId: string } }
  | { chain: 'evm'; event: 'disconnect'; data: { code: number; message: string } }
  | { chain: 'solana'; event: 'accountsChanged'; data: string[] };
