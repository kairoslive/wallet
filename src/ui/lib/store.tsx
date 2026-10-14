import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { WalletState } from '../../core/wallet/service';
import type { Account, Network } from '../../core/types';
import { api, bg } from './api';

interface Toast {
  id: number;
  text: string;
  error?: boolean;
}

interface WalletCtx {
  state: WalletState | undefined;
  account: Account | undefined;
  networks: Network[];
  /** Enabled networks honoring the testnet toggle. */
  activeNetworks: Network[];
  refresh: () => Promise<WalletState>;
  toast: (text: string, error?: boolean) => void;
  toasts: Toast[];
}

const Ctx = createContext<WalletCtx | null>(null);

let toastId = 0;

export function WalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WalletState>();
  const [toasts, setToasts] = useState<Toast[]>([]);

  const refresh = useCallback(async () => {
    const s = await api.getState();
    setState(s);
    return s;
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    // Keep the auto-lock timer alive while the UI is in use.
    const ping = () => void bg('activity').catch(() => {});
    window.addEventListener('pointerdown', ping);
    window.addEventListener('keydown', ping);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pointerdown', ping);
      window.removeEventListener('keydown', ping);
    };
  }, [refresh]);

  const toast = useCallback((text: string, error?: boolean) => {
    const id = ++toastId;
    setToasts((t) => [...t, { id, text, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 5000 : 2500);
  }, []);

  const value = useMemo<WalletCtx>(() => {
    const networks = state?.settings.networks ?? [];
    return {
      state,
      account: state?.accounts.find((a) => a.id === state.selectedAccountId) ?? state?.accounts[0],
      networks,
      activeNetworks: networks.filter((n) => n.enabled && (state?.settings.showTestnets || !n.testnet)),
      refresh,
      toast,
      toasts,
    };
  }, [state, refresh, toast, toasts]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletCtx & { state: WalletState } {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useWallet outside provider');
  return ctx as WalletCtx & { state: WalletState };
}

export function useMaybeWallet(): WalletCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useWallet outside provider');
  return ctx;
}

/** Small async helper: runs fn, tracks loading and error, and toasts errors when asked. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const run = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const r = await fn();
      setData(r);
      return r;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void run();
  }, [run]);
  return { data, error, loading, reload: run, setData };
}
