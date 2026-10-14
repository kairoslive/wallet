import { registerWallet } from '@wallet-standard/wallet';
import type { IdentifierString, Wallet, WalletAccount } from '@wallet-standard/base';
import {
  StandardConnect,
  StandardDisconnect,
  StandardEvents,
  type StandardConnectFeature,
  type StandardDisconnectFeature,
  type StandardEventsFeature,
  type StandardEventsListeners,
  type StandardEventsNames,
} from '@wallet-standard/features';
import {
  SolanaSignAndSendTransaction,
  SolanaSignMessage,
  SolanaSignTransaction,
  type SolanaSignAndSendTransactionFeature,
  type SolanaSignMessageFeature,
  type SolanaSignTransactionFeature,
} from '@solana/wallet-standard-features';
import { base64 } from '@scure/base';
import bs58 from 'bs58';
import { ICON_DATA_URI, WALLET_NAME } from '../shared/icon';
import type { PortMessage } from '../shared/api';

/** Runs in the page's MAIN world: exposes an EIP-1193 provider (EIP-6963) and a Solana wallet-standard wallet. */

const TO_CONTENT = 'duo-wallet:content';
const TO_PAGE = 'duo-wallet:inpage';

type Listener = (data: unknown) => void;

let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
const eventHandlers: ((chain: string, event: string, data: unknown) => void)[] = [];

class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

function send(chain: 'evm' | 'solana', method: string, params?: unknown): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    window.postMessage({ target: TO_CONTENT, req: { id, chain, method, params } }, window.location.origin);
  });
}

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window || e.data?.target !== TO_PAGE) return;
  const msg = e.data.msg as PortMessage;
  if (msg.type === 'response') {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
    else p.resolve(msg.result);
  } else if (msg.type === 'event') {
    for (const h of eventHandlers) h(msg.chain, msg.event, msg.data);
  }
});

// ------------------------------------------------------------------------- EVM (EIP-1193)

class DuoEthereumProvider {
  readonly isDuoWallet = true;
  private listeners = new Map<string, Set<Listener>>();
  chainId: string | null = null;
  selectedAddress: string | null = null;

  constructor() {
    eventHandlers.push((chain, event, data) => {
      if (chain !== 'evm') return;
      if (event === 'accountsChanged') this.selectedAddress = (data as string[])[0] ?? null;
      if (event === 'chainChanged') this.chainId = data as string;
      this.emit(event, data);
    });
    void this.request({ method: 'eth_chainId' }).then(
      (c) => {
        this.chainId = c as string;
        this.emit('connect', { chainId: c });
      },
      () => {},
    );
  }

  async request(args: { method: string; params?: unknown[] | object }): Promise<unknown> {
    if (!args || typeof args.method !== 'string') throw new RpcError(-32600, 'Invalid request');
    const result = await send('evm', args.method, args.params);
    if (args.method === 'eth_requestAccounts' || args.method === 'eth_accounts') {
      this.selectedAddress = (result as string[])[0] ?? null;
    }
    if (args.method === 'eth_chainId') this.chainId = result as string;
    return result;
  }

  isConnected(): boolean {
    return true;
  }

  /** Legacy API used by older dApps. */
  enable(): Promise<unknown> {
    return this.request({ method: 'eth_requestAccounts' });
  }

  sendAsync(payload: { id?: number; method: string; params?: unknown[] }, cb: (err: unknown, res?: unknown) => void) {
    this.request(payload).then(
      (result) => cb(null, { id: payload.id, jsonrpc: '2.0', result }),
      (error) => cb(error),
    );
  }

  send(methodOrPayload: string | { method: string; params?: unknown[] }, paramsOrCb?: unknown): unknown {
    if (typeof methodOrPayload === 'string') return this.request({ method: methodOrPayload, params: paramsOrCb as unknown[] });
    if (typeof paramsOrCb === 'function') return this.sendAsync(methodOrPayload, paramsOrCb as never);
    return this.request(methodOrPayload);
  }

  on(event: string, fn: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
    return this;
  }

  once(event: string, fn: Listener) {
    const wrapped: Listener = (d) => {
      this.removeListener(event, wrapped);
      fn(d);
    };
    return this.on(event, wrapped);
  }

  removeListener(event: string, fn: Listener) {
    this.listeners.get(event)?.delete(fn);
    return this;
  }

  off(event: string, fn: Listener) {
    return this.removeListener(event, fn);
  }

  removeAllListeners(event?: string) {
    if (event) this.listeners.delete(event);
    else this.listeners.clear();
    return this;
  }

  private emit(event: string, data: unknown) {
    for (const fn of this.listeners.get(event) ?? []) {
      try {
        fn(data);
      } catch (e) {
        console.error(e);
      }
    }
  }
}

const ethereum = new DuoEthereumProvider();
const info = Object.freeze({
  uuid: crypto.randomUUID(),
  name: WALLET_NAME,
  icon: ICON_DATA_URI,
  rdns: 'app.duowallet',
});

function announce() {
  window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider: ethereum }) }));
}
window.addEventListener('eip6963:requestProvider', announce);
announce();

// Don't clobber another wallet's injected provider; dApps can still find us through EIP-6963.
if (!('ethereum' in window) || !(window as { ethereum?: unknown }).ethereum) {
  Object.defineProperty(window, 'ethereum', { value: ethereum, configurable: true, writable: true });
}
(window as unknown as { duoWallet: unknown }).duoWallet = { ethereum };

// ------------------------------------------------------------------------- Solana (wallet-standard)

const SOLANA_CHAINS = ['solana:mainnet', 'solana:devnet', 'solana:testnet'] as const;
const SOLANA_FEATURES = [SolanaSignAndSendTransaction, SolanaSignTransaction, SolanaSignMessage] as const;

class DuoAccount implements WalletAccount {
  readonly address: string;
  readonly publicKey: Uint8Array;
  readonly chains = SOLANA_CHAINS;
  readonly features = SOLANA_FEATURES;
  readonly label = undefined;
  readonly icon = undefined;

  constructor(address: string) {
    this.address = address;
    this.publicKey = bs58.decode(address);
  }
}

class DuoSolanaWallet implements Wallet {
  readonly version = '1.0.0' as const;
  readonly name = WALLET_NAME;
  readonly icon = ICON_DATA_URI;
  readonly chains = SOLANA_CHAINS;
  #accounts: DuoAccount[] = [];
  #listeners: { [E in StandardEventsNames]?: Set<StandardEventsListeners[E]> } = {};

  constructor() {
    eventHandlers.push((chain, event, data) => {
      if (chain !== 'solana' || event !== 'accountsChanged') return;
      // Only propagate changes once the site has connected through this wallet.
      if (!this.#accounts.length && !(data as string[]).length) return;
      this.#setAccounts(data as string[]);
    });
  }

  get accounts() {
    return this.#accounts.slice();
  }

  get features(): StandardConnectFeature &
    StandardDisconnectFeature &
    StandardEventsFeature &
    SolanaSignAndSendTransactionFeature &
    SolanaSignTransactionFeature &
    SolanaSignMessageFeature {
    return {
      [StandardConnect]: { version: '1.0.0', connect: this.#connect },
      [StandardDisconnect]: { version: '1.0.0', disconnect: this.#disconnect },
      [StandardEvents]: { version: '1.0.0', on: this.#on },
      [SolanaSignAndSendTransaction]: {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signAndSendTransaction: this.#signAndSendTransaction,
      },
      [SolanaSignTransaction]: {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signTransaction: this.#signTransaction,
      },
      [SolanaSignMessage]: { version: '1.0.0', signMessage: this.#signMessage },
    };
  }

  #setAccounts(addresses: string[]) {
    const prev = this.#accounts.map((a) => a.address).join();
    this.#accounts = addresses.map((a) => new DuoAccount(a));
    if (prev !== addresses.join()) this.#emit('change', { accounts: this.accounts });
  }

  #emit<E extends StandardEventsNames>(event: E, ...args: Parameters<StandardEventsListeners[E]>) {
    for (const l of this.#listeners[event] ?? []) (l as (...a: unknown[]) => void)(...args);
  }

  #on: StandardEventsFeature[typeof StandardEvents]['on'] = (event, listener) => {
    (this.#listeners[event] ??= new Set()).add(listener as never);
    return () => this.#listeners[event]?.delete(listener as never);
  };

  #connect: StandardConnectFeature[typeof StandardConnect]['connect'] = async (input) => {
    const res = (await send('solana', 'connect', { onlyIfTrusted: !!input?.silent })) as { accounts: string[] };
    this.#setAccounts(res.accounts);
    return { accounts: this.accounts };
  };

  #disconnect: StandardDisconnectFeature[typeof StandardDisconnect]['disconnect'] = async () => {
    await send('solana', 'disconnect');
    this.#setAccounts([]);
  };

  #signMessage: SolanaSignMessageFeature[typeof SolanaSignMessage]['signMessage'] = async (...inputs) => {
    const out = [];
    for (const input of inputs) {
      const res = (await send('solana', 'signMessage', {
        address: input.account.address,
        message: base64.encode(input.message),
      })) as { signature: string };
      out.push({ signedMessage: input.message, signature: base64.decode(res.signature), signatureType: 'ed25519' as const });
    }
    return out;
  };

  #signTransaction: SolanaSignTransactionFeature[typeof SolanaSignTransaction]['signTransaction'] = async (...inputs) => {
    if (!inputs.length) return [];
    const res = (await send('solana', 'signTransaction', {
      address: inputs[0].account.address,
      chain: inputs[0].chain,
      transactions: inputs.map((i) => base64.encode(i.transaction)),
    })) as { signedTransactions: string[] };
    return res.signedTransactions.map((t) => ({ signedTransaction: base64.decode(t) }));
  };

  #signAndSendTransaction: SolanaSignAndSendTransactionFeature[typeof SolanaSignAndSendTransaction]['signAndSendTransaction'] =
    async (...inputs) => {
      if (!inputs.length) return [];
      const res = (await send('solana', 'signAndSendTransaction', {
        address: inputs[0].account.address,
        chain: inputs[0].chain as IdentifierString,
        transactions: inputs.map((i) => base64.encode(i.transaction)),
      })) as { signatures: string[] };
      return res.signatures.map((s) => ({ signature: bs58.decode(s) }));
    };
}

registerWallet(new DuoSolanaWallet());
