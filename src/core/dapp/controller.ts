import { hexToString, isHex, numberToHex, type Hex, type TransactionRequest } from 'viem';
import { Transaction, VersionedTransaction } from '@solana/web3.js';
import { base64 } from '@scure/base';
import type { WalletService } from '../wallet/service';
import type { Account, EvmNetwork, Network, SolanaNetwork } from '../types';
import { isValidEvmAddress, sameAddress } from '../address';
import * as evm from '../evm/client';
import * as sol from '../solana/client';
import { formatAmount } from '../format';
import type { Fetch } from '../http';
import { hostname } from '../../shared/url';
import { Errors, ProviderError, type Approver, type DappRequest } from './types';

/** Methods proxied verbatim to the selected network's RPC. */
const EVM_READ_METHODS = new Set([
  'eth_blockNumber',
  'eth_call',
  'eth_estimateGas',
  'eth_feeHistory',
  'eth_gasPrice',
  'eth_getBalance',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getBlockTransactionCountByHash',
  'eth_getBlockTransactionCountByNumber',
  'eth_getCode',
  'eth_getLogs',
  'eth_getProof',
  'eth_getStorageAt',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_maxPriorityFeePerGas',
  'eth_syncing',
  'net_listening',
  'web3_clientVersion',
]);

export const SOLANA_CHAINS: Record<string, SolanaNetwork['cluster']> = {
  'solana:mainnet': 'mainnet-beta',
  'solana:devnet': 'devnet',
  'solana:testnet': 'testnet',
};

export class DappController {
  constructor(
    private service: WalletService,
    private approver: Approver,
    private fetchFn: Fetch = (...a) => fetch(...a),
  ) {}

  async handle(origin: string, req: DappRequest): Promise<unknown> {
    try {
      if (req.chain === 'evm') return await this.handleEvm(origin, req.method, (req.params ?? []) as unknown[]);
      if (req.chain === 'solana') return await this.handleSolana(origin, req.method, (req.params ?? {}) as Record<string, unknown>);
      throw Errors.unsupported(String(req.method));
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw Errors.internal((e as Error).message);
    }
  }

  // ------------------------------------------------------------- shared helpers

  /** Accounts visible to the origin, with the wallet's selected account first. */
  async permittedAccounts(origin: string): Promise<Account[]> {
    if (!this.service.isUnlocked()) return [];
    const perm = await this.service.getPermission(origin);
    if (!perm) return [];
    const state = await this.service.getState();
    const accounts = perm.accountIds
      .map((id) => state.accounts.find((a) => a.id === id))
      .filter((a): a is Account => !!a);
    const selected = accounts.findIndex((a) => a.id === state.selectedAccountId);
    if (selected > 0) accounts.unshift(...accounts.splice(selected, 1));
    return accounts;
  }

  async evmAccounts(origin: string): Promise<string[]> {
    return (await this.permittedAccounts(origin)).flatMap((a) => (a.evmAddress ? [a.evmAddress.toLowerCase()] : []));
  }

  async solanaAccounts(origin: string): Promise<string[]> {
    return (await this.permittedAccounts(origin)).flatMap((a) => (a.solanaAddress ? [a.solanaAddress] : []));
  }

  private async connect(origin: string, chain: 'evm' | 'solana'): Promise<void> {
    const existing = await this.service.getPermission(origin);
    const state = await this.service.getState();
    const res = await this.approver.request('connect', origin, {
      chain,
      selectedAccountId: state.selectedAccountId,
      existingAccountIds: existing?.accountIds ?? [],
    });
    if (!res.approved) throw Errors.userRejected();
    const fresh = await this.service.getState();
    const ids = (res.data?.accountIds as string[] | undefined)?.filter((id) => fresh.accounts.some((a) => a.id === id));
    const accountIds = ids?.length ? ids : fresh.selectedAccountId ? [fresh.selectedAccountId] : [];
    if (!accountIds.length) throw Errors.userRejected();
    await this.service.setPermission({
      origin,
      accountIds,
      evmNetworkId: existing?.evmNetworkId ?? this.unconnectedChains.get(origin),
      connectedAt: Date.now(),
    });
  }

  // ------------------------------------------------------------- EVM

  async evmNetworkFor(origin: string): Promise<EvmNetwork> {
    const s = await this.service.getSettings();
    const perm = await this.service.getPermission(origin);
    const evmNets = s.networks.filter((n): n is EvmNetwork => n.type === 'evm');
    const preferred =
      evmNets.find((n) => n.id === (perm?.evmNetworkId ?? this.unconnectedChains.get(origin))) ??
      evmNets.find((n) => n.id === s.selectedNetworkId) ??
      evmNets.find((n) => n.enabled && !n.testnet) ??
      evmNets[0];
    if (!preferred) throw Errors.internal('No EVM network configured');
    return preferred;
  }

  private async requireEvmAccount(origin: string, address?: unknown): Promise<Account> {
    const accounts = (await this.permittedAccounts(origin)).filter((a) => a.evmAddress);
    if (!accounts.length) throw Errors.unauthorized();
    if (address === undefined) return accounts[0];
    const acct = accounts.find((a) => sameAddress(a.evmAddress, String(address)));
    if (!acct) throw Errors.unauthorized();
    return acct;
  }

  private async handleEvm(origin: string, method: string, params: unknown[]): Promise<unknown> {
    switch (method) {
      case 'eth_chainId':
        return numberToHex((await this.evmNetworkFor(origin)).chainId);
      case 'net_version':
        return String((await this.evmNetworkFor(origin)).chainId);
      case 'eth_accounts':
        return this.evmAccounts(origin);
      case 'eth_requestAccounts': {
        let accounts = await this.evmAccounts(origin);
        if (!accounts.length) {
          await this.connect(origin, 'evm');
          accounts = await this.evmAccounts(origin);
        }
        if (!accounts.length) throw Errors.unauthorized();
        return accounts;
      }
      case 'wallet_requestPermissions': {
        await this.connect(origin, 'evm');
        return [{ parentCapability: 'eth_accounts', date: Date.now() }];
      }
      case 'wallet_getPermissions':
        return (await this.evmAccounts(origin)).length ? [{ parentCapability: 'eth_accounts' }] : [];
      case 'wallet_revokePermissions':
        await this.service.revokePermission(origin);
        return null;
      case 'personal_sign':
        return this.personalSign(origin, params);
      case 'eth_signTypedData_v4':
      case 'eth_signTypedData_v3':
        return this.signTypedData(origin, params);
      case 'eth_sendTransaction':
        return this.sendTransaction(origin, params);
      case 'wallet_switchEthereumChain':
        return this.switchChain(origin, params);
      case 'wallet_addEthereumChain':
        return this.addChain(origin, params);
      case 'wallet_watchAsset':
        return this.watchAsset(origin, params);
      case 'eth_sign':
        throw Errors.unsupported('eth_sign (unsafe, use personal_sign)');
      default:
        if (EVM_READ_METHODS.has(method)) return this.proxyRpc(await this.evmNetworkFor(origin), method, params);
        throw Errors.unsupported(method);
    }
  }

  private async proxyRpc(network: Network, method: string, params: unknown[]): Promise<unknown> {
    const res = await this.fetchFn(network.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
    if (body.error) throw new ProviderError(body.error.code, body.error.message, body.error.data);
    return body.result;
  }

  private async personalSign(origin: string, params: unknown[]) {
    let [data, address] = params as [string, string];
    // Some dApps send [address, message]; detect and swap.
    if (isValidEvmAddress(String(data)) && !isValidEvmAddress(String(address))) [data, address] = [address, data];
    if (typeof data !== 'string') throw Errors.invalidParams('Message must be a string');
    const acct = await this.requireEvmAccount(origin, address);
    const display = isHex(data) ? safeHexToUtf8(data) : data;
    const res = await this.approver.request('evmSignMessage', origin, {
      accountId: acct.id,
      address: acct.evmAddress,
      message: display,
      raw: data,
    });
    if (!res.approved) throw Errors.userRejected();
    const signer = await this.service.evmSigner(acct.id);
    return signer.signMessage(isHex(data) ? { raw: data as Hex } : data);
  }

  private async signTypedData(origin: string, params: unknown[]) {
    const [address, rawTyped] = params as [string, unknown];
    const acct = await this.requireEvmAccount(origin, address);
    let typed: Record<string, unknown>;
    try {
      typed = (typeof rawTyped === 'string' ? JSON.parse(rawTyped) : rawTyped) as Record<string, unknown>;
    } catch {
      throw Errors.invalidParams('Invalid typed data');
    }
    if (!typed?.types || !typed.primaryType || !typed.message) throw Errors.invalidParams('Invalid typed data');
    const network = await this.evmNetworkFor(origin);
    const domainChain = (typed.domain as { chainId?: unknown } | undefined)?.chainId;
    if (domainChain !== undefined && Number(domainChain) !== network.chainId) {
      throw Errors.invalidParams(`Typed data chainId ${Number(domainChain)} does not match the active chain ${network.chainId}`);
    }
    const res = await this.approver.request('evmSignTypedData', origin, {
      accountId: acct.id,
      address: acct.evmAddress,
      typedData: typed,
    });
    if (!res.approved) throw Errors.userRejected();
    const types = { ...(typed.types as Record<string, unknown>) };
    delete types.EIP712Domain;
    const signer = await this.service.evmSigner(acct.id);
    return signer.signTypedData({
      domain: typed.domain as never,
      types: types as never,
      primaryType: typed.primaryType as string,
      message: typed.message as never,
    });
  }

  private async sendTransaction(origin: string, params: unknown[]) {
    const raw = params[0] as Record<string, string | undefined> | undefined;
    if (!raw || typeof raw !== 'object') throw Errors.invalidParams('Missing transaction');
    const acct = await this.requireEvmAccount(origin, raw.from);
    const network = await this.evmNetworkFor(origin);
    if (raw.chainId !== undefined && Number(raw.chainId) !== network.chainId) {
      throw Errors.invalidParams('Transaction chainId does not match the active chain');
    }
    const tx: TransactionRequest = {
      from: acct.evmAddress as Hex,
      to: raw.to as Hex | undefined,
      value: raw.value ? BigInt(raw.value) : 0n,
      data: (raw.data ?? raw.input) as Hex | undefined,
      gas: raw.gas ?? raw.gasLimit ? BigInt((raw.gas ?? raw.gasLimit)!) : undefined,
    };
    let fee: evm.EvmFeeEstimate | undefined;
    let estimateError: string | undefined;
    try {
      fee = await evm.estimateTx(network, tx);
    } catch (e) {
      estimateError = (e as Error).message.split('\n')[0];
    }
    const res = await this.approver.request('evmSendTransaction', origin, {
      accountId: acct.id,
      networkId: network.id,
      from: acct.evmAddress,
      to: tx.to,
      value: (tx.value ?? 0n).toString(),
      data: tx.data ?? '0x',
      fee: fee?.fee.toString(),
      estimateError,
    });
    if (!res.approved) throw Errors.userRejected();
    const signer = await this.service.evmSigner(acct.id);
    const hash = await signer.sendTransaction(network, tx, fee);
    const symbol = network.nativeCurrency.symbol;
    const isTransfer = !tx.data || tx.data === '0x';
    const amount = formatAmount(tx.value ?? 0n, network.nativeCurrency.decimals);
    await this.service.recordTx({
      hash,
      networkId: network.id,
      chainType: 'evm',
      from: acct.evmAddress!,
      to: tx.to ?? undefined,
      title: isTransfer ? `Sent ${amount} ${symbol}` : `${hostname(origin)} interaction`,
      direction: 'out',
      kind: isTransfer ? 'send' : 'dapp',
      amount,
      symbol,
      timestamp: Date.now(),
      status: 'pending',
      source: 'local',
    });
    return hash;
  }

  private async switchChain(origin: string, params: unknown[]) {
    const chainIdHex = (params[0] as { chainId?: string } | undefined)?.chainId;
    if (!chainIdHex) throw Errors.invalidParams('Missing chainId');
    const chainId = Number(chainIdHex);
    const s = await this.service.getSettings();
    const network = s.networks.find((n): n is EvmNetwork => n.type === 'evm' && n.chainId === chainId);
    if (!network) throw Errors.unrecognizedChain(chainIdHex);
    const perm = await this.service.getPermission(origin);
    if (perm) await this.service.setPermission({ ...perm, evmNetworkId: network.id });
    else this.unconnectedChains.set(origin, network.id);
    return null;
  }

  /** Chain choices for sites that switched chain before connecting (kept in memory only). */
  private unconnectedChains = new Map<string, string>();

  private async addChain(origin: string, params: unknown[]) {
    const p = params[0] as {
      chainId?: string;
      chainName?: string;
      rpcUrls?: string[];
      nativeCurrency?: { name: string; symbol: string; decimals: number };
      blockExplorerUrls?: string[];
    };
    if (!p?.chainId || !p.rpcUrls?.length) throw Errors.invalidParams('chainId and rpcUrls are required');
    const chainId = Number(p.chainId);
    const s = await this.service.getSettings();
    const existing = s.networks.find((n) => n.type === 'evm' && n.chainId === chainId);
    if (!existing) {
      const rpcUrl = p.rpcUrls.find((u) => u.startsWith('https://')) ?? p.rpcUrls[0];
      const network: EvmNetwork = {
        type: 'evm',
        id: `chain-${chainId}`,
        name: p.chainName?.slice(0, 64) || `Chain ${chainId}`,
        chainId,
        rpcUrl,
        explorerUrl: p.blockExplorerUrls?.[0] ?? '',
        nativeCurrency: p.nativeCurrency ?? { name: 'Ether', symbol: 'ETH', decimals: 18 },
        history: { kind: 'none' },
        testnet: false,
        enabled: true,
        custom: true,
      };
      const res = await this.approver.request('evmAddNetwork', origin, { network });
      if (!res.approved) throw Errors.userRejected();
      // Ensure the RPC really serves the chain it claims before trusting it.
      const actual = await evm.getChainId(rpcUrl).catch(() => undefined);
      if (actual !== chainId) throw Errors.invalidParams(`RPC returned chainId ${actual}, expected ${chainId}`);
      await this.service.upsertNetwork(network);
    }
    return this.switchChain(origin, [{ chainId: p.chainId }]);
  }

  private async watchAsset(origin: string, params: unknown) {
    const p = (Array.isArray(params) ? params[0] : params) as {
      type?: string;
      options?: { address?: string; symbol?: string; decimals?: number; image?: string };
    };
    if (p?.type !== 'ERC20' || !p.options?.address) throw Errors.invalidParams('Only ERC20 assets are supported');
    const network = await this.evmNetworkFor(origin);
    const token = await this.service.lookupToken(network.id, p.options.address);
    const res = await this.approver.request('evmWatchAsset', origin, { token, networkName: network.name });
    if (!res.approved) throw Errors.userRejected();
    await this.service.addCustomToken({ ...token, logoURI: p.options.image ?? token.logoURI }).catch((e: Error) => {
      if (!/already added/.test(e.message)) throw e;
    });
    return true;
  }

  // ------------------------------------------------------------- Solana (wallet-standard)

  private async solanaNetwork(chain?: unknown): Promise<SolanaNetwork> {
    const cluster = SOLANA_CHAINS[String(chain ?? 'solana:mainnet')] ?? 'mainnet-beta';
    const s = await this.service.getSettings();
    const nets = s.networks.filter((n): n is SolanaNetwork => n.type === 'solana');
    const n = nets.find((x) => x.cluster === cluster && x.enabled) ?? nets.find((x) => x.cluster === cluster);
    if (!n) throw Errors.internal(`No Solana network configured for ${String(chain)}`);
    return n;
  }

  private async requireSolanaAccount(origin: string, address: unknown): Promise<Account> {
    const accounts = (await this.permittedAccounts(origin)).filter((a) => a.solanaAddress);
    const acct = accounts.find((a) => a.solanaAddress === address);
    if (!acct) throw Errors.unauthorized();
    return acct;
  }

  private async handleSolana(origin: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'connect': {
        let accounts = await this.solanaAccounts(origin);
        if (!accounts.length) {
          if (params.onlyIfTrusted) throw Errors.userRejected();
          await this.connect(origin, 'solana');
          accounts = await this.solanaAccounts(origin);
        }
        if (!accounts.length) throw new ProviderError(4100, 'No Solana account connected');
        return { accounts };
      }
      case 'accounts':
        return { accounts: await this.solanaAccounts(origin) };
      case 'disconnect':
        await this.service.revokePermission(origin);
        return null;
      case 'signMessage': {
        const acct = await this.requireSolanaAccount(origin, params.address);
        const message = base64.decode(String(params.message));
        const res = await this.approver.request('solanaSignMessage', origin, {
          accountId: acct.id,
          address: acct.solanaAddress,
          message: safeBytesToUtf8(message),
        });
        if (!res.approved) throw Errors.userRejected();
        const signer = await this.service.solanaSigner(acct.id);
        return { signature: base64.encode(signer.signMessage(message)), signedMessage: params.message };
      }
      case 'signTransaction':
      case 'signAndSendTransaction': {
        const acct = await this.requireSolanaAccount(origin, params.address);
        const network = await this.solanaNetwork(params.chain);
        const raws = (Array.isArray(params.transactions) ? params.transactions : [params.transaction]).map((t) => String(t));
        if (!raws.length || raws.some((r) => !r)) throw Errors.invalidParams('Missing transaction');
        const txs = raws.map((r) => sol.deserializeTx(base64.decode(r)));
        const send = method === 'signAndSendTransaction';
        const res = await this.approver.request('solanaSignTransaction', origin, {
          accountId: acct.id,
          address: acct.solanaAddress,
          networkId: network.id,
          send,
          transactions: txs.map((t) => describeSolanaTx(t)),
        });
        if (!res.approved) throw Errors.userRejected();
        const signer = await this.service.solanaSigner(acct.id);
        if (!send) {
          return { signedTransactions: txs.map((t) => base64.encode(sol.serializeTx(sol.signTx(t, signer.keypair)))) };
        }
        const signatures: string[] = [];
        for (const t of txs) {
          const sig = await sol.signAndSend(network, t, signer.keypair);
          signatures.push(sig);
          await this.service.recordTx({
            hash: sig,
            networkId: network.id,
            chainType: 'solana',
            from: acct.solanaAddress!,
            title: `${hostname(origin)} interaction`,
            direction: 'out',
            kind: 'dapp',
            timestamp: Date.now(),
            status: 'pending',
            source: 'local',
          });
        }
        return { signatures };
      }
      default:
        throw Errors.unsupported(method);
    }
  }
}


function safeHexToUtf8(hex: string): string {
  try {
    const s = hexToString(hex as Hex);
    // Fall back to hex if it decodes to control characters (binary payload).
    return /[\x00-\x08\x0e-\x1f]/.test(s) ? hex : s;
  } catch {
    return hex;
  }
}

function safeBytesToUtf8(bytes: Uint8Array): string {
  const s = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return /[\x00-\x08\x0e-\x1f�]/.test(s) ? `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}` : s;
}

/** Human-oriented summary of a Solana transaction for the approval screen. */
export function describeSolanaTx(tx: Transaction | VersionedTransaction): { feePayer?: string; programs: string[]; version: string } {
  if (tx instanceof VersionedTransaction) {
    const keys = tx.message.staticAccountKeys;
    const programs = [...new Set(tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex]?.toBase58()).filter(Boolean))];
    return { feePayer: keys[0]?.toBase58(), programs: programs.map(programName), version: String(tx.version) };
  }
  return {
    feePayer: tx.feePayer?.toBase58(),
    programs: [...new Set(tx.instructions.map((ix) => ix.programId.toBase58()))].map(programName),
    version: 'legacy',
  };
}

const KNOWN_PROGRAMS: Record<string, string> = {
  '11111111111111111111111111111111': 'System Program',
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'Token Program',
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'Token-2022 Program',
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'Associated Token Program',
  ComputeBudget111111111111111111111111111111: 'Compute Budget',
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: 'Jupiter Aggregator v6',
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: 'Memo Program',
};

function programName(id: string): string {
  return KNOWN_PROGRAMS[id] ? `${KNOWN_PROGRAMS[id]} (${id.slice(0, 4)}…)` : id;
}
