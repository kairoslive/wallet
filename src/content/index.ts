import { DAPP_PORT, type PortMessage, type PortRequest } from '../shared/api';

/**
 * Isolated-world relay between the page's injected providers (window.postMessage)
 * and the background service worker (long-lived runtime port).
 */
const TO_CONTENT = 'duo-wallet:content';
const TO_PAGE = 'duo-wallet:inpage';

let port: chrome.runtime.Port | undefined;
const inflight = new Set<number>();

function getPort(): chrome.runtime.Port {
  if (port) return port;
  const p = chrome.runtime.connect({ name: DAPP_PORT });
  p.onMessage.addListener((msg: PortMessage) => {
    if (msg.type === 'response') inflight.delete(msg.id);
    window.postMessage({ target: TO_PAGE, msg }, window.location.origin);
  });
  p.onDisconnect.addListener(() => {
    port = undefined;
    // The service worker restarted; fail requests that can no longer be answered.
    for (const id of inflight) {
      const msg: PortMessage = { type: 'response', id, error: { code: 4900, message: 'Wallet disconnected, please retry' } };
      window.postMessage({ target: TO_PAGE, msg }, window.location.origin);
    }
    inflight.clear();
  });
  port = p;
  return p;
}

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window || e.data?.target !== TO_CONTENT) return;
  const req = e.data.req as PortRequest;
  if (typeof req?.id !== 'number' || typeof req.method !== 'string') return;
  inflight.add(req.id);
  try {
    getPort().postMessage(req);
  } catch {
    port = undefined;
    getPort().postMessage(req);
  }
});

// Open the port eagerly so the page receives account/chain events.
try {
  getPort();
} catch {
  // Extension context invalidated (e.g. after an update); nothing to do.
}
