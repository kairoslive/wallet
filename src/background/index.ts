import { ChromeStore } from '../core/storage';
import { WalletService } from '../core/wallet/service';
import { DappController } from '../core/dapp/controller';
import { ProviderError } from '../core/dapp/types';
import { numberToHex } from 'viem';
import { ChromeApprover } from './approvals';
import {
  DAPP_PORT,
  WALLET_METHODS,
  type BackgroundApi,
  type Message,
  type PortMessage,
  type PortRequest,
  type Response,
} from '../shared/api';

const service = new WalletService({
  store: new ChromeStore(chrome.storage.local),
  session: new ChromeStore(chrome.storage.session),
});

const approver = new ChromeApprover((count) => {
  void chrome.action.setBadgeText({ text: count ? String(count) : '' });
  void chrome.action.setBadgeBackgroundColor({ color: '#2563EB' });
});
const dapp = new DappController(service, approver);

/**
 * Some public RPCs (notably api.mainnet-beta.solana.com) reject any request carrying a browser Origin.
 * The wallet's own requests don't need one, so strip it for requests initiated by this extension.
 */
async function installOriginRule() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1],
    addRules: [
      {
        id: 1,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
          requestHeaders: [{ header: 'origin', operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE }],
        },
        condition: {
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: [
            chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
            chrome.declarativeNetRequest.ResourceType.OTHER,
          ],
        },
      },
    ],
  });
}
const originRule = installOriginRule().catch((e) => console.warn('Could not install origin rule', e));

// Re-hydrate unlocked state after the service worker was suspended.
const ready = Promise.all([service.restoreSession().catch(() => false), originRule]).then(([unlocked]) => unlocked);

// ------------------------------------------------------------------ auto-lock

const AUTOLOCK_ALARM = 'autolock';

async function touchAutoLock() {
  if (!service.isUnlocked()) return;
  const { autoLockMinutes } = await service.getSettings();
  await chrome.alarms.create(AUTOLOCK_ALARM, { delayInMinutes: autoLockMinutes });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  // Wait for session restore first, otherwise the restore could finish after the lock and re-unlock.
  if (alarm.name === AUTOLOCK_ALARM) void ready.then(() => service.lock());
});

// ------------------------------------------------------------------ extension pages

const allowed = new Set<string>(WALLET_METHODS);

const bgApi: BackgroundApi = {
  'approvals.list': async () => approver.list(),
  'approvals.resolve': async (id, result) => approver.resolve(id, result),
  activity: async () => touchAutoLock(),
};

function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  // Content scripts share our extension id, so require the sender to be one of our own pages.
  return sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(''));
}

async function handleMessage(msg: Message): Promise<unknown> {
  await ready;
  if (msg.kind === 'wallet') {
    if (!allowed.has(msg.method)) throw new Error(`Unknown method ${msg.method}`);
    const fn = service[msg.method] as (...a: unknown[]) => unknown;
    const result = await fn.apply(service, msg.args);
    if (msg.method !== 'lock' && msg.method !== 'resetWallet') await touchAutoLock();
    return result;
  }
  if (msg.kind === 'bg') {
    const fn = bgApi[msg.method] as (...a: unknown[]) => Promise<unknown>;
    if (!fn) throw new Error(`Unknown method ${msg.method}`);
    return fn(...msg.args);
  }
  throw new Error('Unknown message');
}

chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse: (r: Response) => void) => {
  if (!isExtensionPage(sender)) return false;
  handleMessage(msg).then(
    (result) => sendResponse({ ok: true, result: result ?? null }),
    (e: Error) => sendResponse({ ok: false, error: e?.message ?? String(e) }),
  );
  return true;
});

// ------------------------------------------------------------------ dApp connections

interface Conn {
  port: chrome.runtime.Port;
  origin: string;
  last?: { evmAccounts: string; chainId: string; solAccounts: string };
}

const conns = new Set<Conn>();

async function snapshot(origin: string) {
  const [evmAccounts, solAccounts, network] = await Promise.all([
    dapp.evmAccounts(origin),
    dapp.solanaAccounts(origin),
    dapp.evmNetworkFor(origin).catch(() => undefined),
  ]);
  return {
    evmAccounts: JSON.stringify(evmAccounts),
    solAccounts: JSON.stringify(solAccounts),
    chainId: network ? numberToHex(network.chainId) : '0x1',
  };
}

function post(conn: Conn, msg: PortMessage) {
  try {
    conn.port.postMessage(msg);
  } catch {
    conns.delete(conn);
  }
}

/** Pushes accountsChanged / chainChanged events to pages whose view of the wallet changed. */
async function broadcast() {
  await Promise.all(
    [...conns].map(async (c) => {
      const next = await snapshot(c.origin).catch(() => undefined);
      if (!next) return;
      const prev = c.last;
      c.last = next;
      if (!prev) return;
      if (prev.evmAccounts !== next.evmAccounts) {
        post(c, { type: 'event', chain: 'evm', event: 'accountsChanged', data: JSON.parse(next.evmAccounts) });
      }
      if (prev.chainId !== next.chainId) post(c, { type: 'event', chain: 'evm', event: 'chainChanged', data: next.chainId });
      if (prev.solAccounts !== next.solAccounts) {
        post(c, { type: 'event', chain: 'solana', event: 'accountsChanged', data: JSON.parse(next.solAccounts) });
      }
    }),
  );
}

service.onChange(() => void broadcast());

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== DAPP_PORT) return;
  const origin = port.sender?.origin ?? (port.sender?.url ? new URL(port.sender.url).origin : undefined);
  // Opaque origins ("null", e.g. sandboxed frames) would all share one permission entry; refuse them.
  if (!origin || origin === 'null' || port.sender?.id !== chrome.runtime.id) {
    port.disconnect();
    return;
  }
  const conn: Conn = { port, origin };
  conns.add(conn);
  void ready.then(() => snapshot(origin)).then((s) => (conn.last = s));
  port.onDisconnect.addListener(() => conns.delete(conn));
  port.onMessage.addListener(async (req: PortRequest) => {
    await ready;
    let msg: PortMessage;
    try {
      const result = await dapp.handle(origin, { chain: req.chain, method: req.method, params: req.params });
      msg = { type: 'response', id: req.id, result: result ?? null };
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError(-32603, (e as Error).message);
      msg = { type: 'response', id: req.id, error: { code: err.code, message: err.message, data: err.data } };
    }
    post(conn, msg);
    // Permission or chain changes made by this request are announced to every tab.
    void broadcast();
  });
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install' && !(await service.isInitialized())) {
    await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html#/onboarding?tab=1') });
  }
});
