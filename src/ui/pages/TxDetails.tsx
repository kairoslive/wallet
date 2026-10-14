import { useEffect, useState } from 'react';
import type { Network, TxRecord } from '../../core/types';
import { formatAmount, shortAddress } from '../../core/format';
import { explorerTxUrl } from '../../core/networks';
import { api } from '../lib/api';
import { useRoute } from '../lib/router';
import { useWallet } from '../lib/store';
import { findCachedTx } from '../lib/txCache';
import { CopyButton, Empty, ErrorNote, NetworkDot, Screen, Spinner, StatusPill, TopBar } from '../components/ui';
import { ExplorerButton, bridgeStatusLabel, openTab, useBridgeStatus } from '../components/tx';

export function TxDetails() {
  const { account, networks } = useWallet();
  const route = useRoute();
  const hash = route.query.get('hash') ?? '';
  const networkId = route.query.get('network') ?? '';
  const [tx, setTx] = useState<TxRecord | undefined>(() => findCachedTx(networkId, hash));
  const [loading, setLoading] = useState(!tx);
  const [error, setError] = useState<string>();
  const network = networks.find((n) => n.id === networkId);

  const accountId = account?.id;
  useEffect(() => {
    if (tx || !accountId) return;
    let stale = false;
    api
      .getHistory(accountId, networkId)
      .then((r) => !stale && setTx(r.txs.find((t) => t.hash === hash)))
      .catch((e: Error) => !stale && setError(e.message))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
    };
  }, [tx, accountId, networkId, hash]);

  if (loading) {
    return (
      <Screen>
        <TopBar title="Transaction" />
        <div className="center" style={{ padding: 40 }}>
          <Spinner />
        </div>
      </Screen>
    );
  }

  if (!tx) {
    return (
      <Screen>
        <TopBar title="Transaction" />
        <div className="screen-body stack">
          <ErrorNote error={error} />
          <Empty title="Transaction not found">It may not be indexed yet. Try the explorer instead.</Empty>
          {hash && <ExplorerButton network={network} hash={hash} />}
        </div>
      </Screen>
    );
  }

  return (
    <Screen>
      <TopBar title="Transaction" />
      <div className="screen-body stack">
        <div>
          <div style={{ fontSize: 18, fontWeight: 750 }}>{tx.title}</div>
          <div className="row small muted" style={{ gap: 6, marginTop: 2 }}>
            <span>{tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'Unknown date'}</span>
            {tx.status === 'confirmed' ? <span className="pos">Confirmed</span> : <StatusPill status={tx.status} />}
          </div>
        </div>

        <div className="panel">
          {tx.amount && tx.amount !== '0' && (
            <div className="kv">
              <span>Amount</span>
              <span className="num">
                {tx.amount} {tx.symbol}
              </span>
            </div>
          )}
          <AddressRow label="From" address={tx.from} />
          {tx.to && <AddressRow label="To" address={tx.to} />}
          {tx.fee && (
            <div className="kv">
              <span>Network fee</span>
              <span className="num">{formatFee(tx.fee, network)}</span>
            </div>
          )}
          <div className="kv">
            <span>Network</span>
            <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
              <NetworkDot network={network} />
              {network?.name ?? tx.networkId}
            </span>
          </div>
          <AddressRow label="Hash" address={tx.hash} />
        </div>

        {tx.kind === 'bridge' && tx.bridge?.toNetworkId && <BridgeSection tx={tx} networks={networks} />}

        <ExplorerButton network={network} hash={tx.hash} />
      </div>
    </Screen>
  );
}

function AddressRow({ label, address }: { label: string; address: string }) {
  return (
    <div className="kv" style={{ alignItems: 'center', padding: '2px 0' }}>
      <span>{label}</span>
      <span className="row" style={{ gap: 0, justifyContent: 'flex-end' }}>
        <span className="mono" title={address}>
          {shortAddress(address, 6)}
        </span>
        <CopyButton text={address} label={`Copy ${label.toLowerCase()}`} />
      </span>
    </div>
  );
}

/** Indexers report fees in base units; older/local records may already be formatted. */
function formatFee(fee: string, network?: Network): string {
  if (!network || !/^\d+$/.test(fee)) return fee;
  return `${formatAmount(fee, network.nativeCurrency.decimals)} ${network.nativeCurrency.symbol}`;
}

function BridgeSection({ tx, networks }: { tx: TxRecord; networks: Network[] }) {
  const toNetwork = networks.find((n) => n.id === tx.bridge?.toNetworkId);
  const settled = tx.bridge?.status === 'DONE' || tx.bridge?.status === 'FAILED';
  const live = useBridgeStatus(tx.hash, tx.networkId, tx.bridge?.toNetworkId, tx.status === 'confirmed' && !settled, tx.bridge?.tool);
  const status = live.status?.status ?? tx.bridge?.status;
  const receiving = live.status?.receivingTxHash ?? tx.bridge?.receivingHash;
  const label = tx.status === 'failed' ? 'Failed' : bridgeStatusLabel(status);
  return (
    <div className="panel">
      <div className="kv">
        <span>Bridge to</span>
        <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
          <NetworkDot network={toNetwork} />
          {toNetwork?.name ?? tx.bridge?.toNetworkId}
        </span>
      </div>
      <div className="kv">
        <span>Bridge status</span>
        <span className={label === 'Done' ? 'pos' : label === 'Failed' ? 'neg' : undefined}>
          {label}
          {live.status?.substatusMessage && label !== 'Done' && (
            <span className="small muted" style={{ display: 'block', fontWeight: 400 }}>
              {live.status.substatusMessage}
            </span>
          )}
        </span>
      </div>
      {receiving && toNetwork && (
        <div className="kv">
          <span>Receiving tx</span>
          <button className="link-btn" onClick={() => openTab(explorerTxUrl(toNetwork, receiving))}>
            {shortAddress(receiving, 6)}
          </button>
        </div>
      )}
      {live.error && <div className="small muted">Couldn't check bridge status: {live.error}</div>}
    </div>
  );
}
