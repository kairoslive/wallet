import { useEffect, useState, type ReactNode } from 'react';
import type { Network, TxStatus } from '../../core/types';
import type { BridgeStatus } from '../../core/swap/types';
import { explorerTxUrl } from '../../core/networks';
import { api } from '../lib/api';
import { Button, Spinner } from './ui';
import { Icon } from './Icon';

export function openTab(url: string) {
  void chrome.tabs.create({ url });
}

export function ExplorerButton({
  network,
  hash,
  label = 'View on explorer',
}: {
  network?: Network;
  hash: string;
  label?: string;
}) {
  if (!network?.explorerUrl) return null;
  return (
    <Button variant="secondary" block icon="external" onClick={() => openTab(explorerTxUrl(network, hash))}>
      {label}
    </Button>
  );
}

/** Big status badge + headline used on result screens. */
export function TxHero({ status, title, children }: { status: TxStatus; title: string; children?: ReactNode }) {
  return (
    <div className="result" data-testid="tx-result" data-status={status}>
      <div className={`badge ${status}`}>
        {status === 'pending' ? (
          <Spinner size={24} />
        ) : (
          <Icon name={status === 'confirmed' ? 'check' : 'close'} size={26} strokeWidth={2.5} />
        )}
      </div>
      <h2>{title}</h2>
      {children}
    </div>
  );
}

/** Waits for a freshly submitted transaction to settle. */
export function useTxStatus(networkId: string | undefined, hash: string | undefined, initial: TxStatus = 'pending') {
  const [status, setStatus] = useState<TxStatus>(initial);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!networkId || !hash || initial !== 'pending') return;
    let stale = false;
    api
      .waitForTx(networkId, hash)
      .then((s) => !stale && setStatus(s))
      .catch((e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [networkId, hash, initial]);
  return { status, error };
}

const BRIDGE_POLL_MS = 10_000;

/** Polls LI.FI for a bridge's destination status until it finishes. */
export function useBridgeStatus(
  hash: string | undefined,
  fromNetworkId: string | undefined,
  toNetworkId: string | undefined,
  enabled = true,
  tool?: string,
) {
  const [status, setStatus] = useState<BridgeStatus>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!enabled || !hash || !fromNetworkId || !toNetworkId) return;
    let stale = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const s = await api.getBridgeStatus(hash, fromNetworkId, toNetworkId, tool);
        if (stale) return;
        setStatus(s);
        setError(undefined);
        if (s.status === 'DONE' || s.status === 'FAILED' || s.status === 'INVALID') return;
      } catch (e) {
        if (stale) return;
        setError((e as Error).message);
      }
      timer = setTimeout(poll, BRIDGE_POLL_MS);
    };
    void poll();
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [hash, fromNetworkId, toNetworkId, enabled, tool]);
  return { status, error };
}

export function bridgeStatusLabel(s?: string): string {
  switch (s) {
    case 'DONE':
      return 'Done';
    case 'FAILED':
    case 'INVALID':
      return 'Failed';
    default:
      return 'Pending';
  }
}
