import type { BackgroundApi, Message, Response, WalletApi, WalletMethod } from '../../shared/api';

async function send(msg: Message): Promise<unknown> {
  const res = (await chrome.runtime.sendMessage(msg)) as Response | undefined;
  if (!res) throw new Error('No response from wallet background');
  if (!res.ok) {
    // An older background worker doesn't know newer methods: the extension was rebuilt but not reloaded.
    if (/^Unknown method/.test(res.error)) throw new Error('The wallet was just updated. Reload it to finish updating.');
    throw new Error(res.error);
  }
  return res.result;
}

/** Typed proxy: `api.getState()` → background WalletService.getState(). */
export const api = new Proxy({} as WalletApi, {
  get:
    (_t, method: string) =>
    (...args: unknown[]) =>
      send({ kind: 'wallet', method: method as WalletMethod, args }),
});

export function bg<M extends keyof BackgroundApi>(
  method: M,
  ...args: Parameters<BackgroundApi[M]>
): ReturnType<BackgroundApi[M]> {
  return send({ kind: 'bg', method, args }) as ReturnType<BackgroundApi[M]>;
}
