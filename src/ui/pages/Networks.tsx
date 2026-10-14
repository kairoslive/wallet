import type { Network } from '../../core/types';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { useWallet } from '../lib/store';
import { Button, NetworkDot, Toggle, TopBar } from '../components/ui';

function rpcHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function Networks() {
  const { networks, state, refresh, toast } = useWallet();
  const mainnets = networks.filter((n) => !n.testnet);
  const testnets = networks.filter((n) => n.testnet);

  const setEnabled = async (n: Network, enabled: boolean) => {
    try {
      await api.upsertNetwork({ ...n, enabled });
      await refresh();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const rows = (list: Network[]) => (
    <div className="list">
      {list.map((n) => (
        <div
          key={n.id}
          className="list-item clickable"
          role="button"
          tabIndex={0}
          onClick={() => navigate('/settings/network', { id: n.id })}
          onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && navigate('/settings/network', { id: n.id })}
          style={n.enabled ? undefined : { opacity: 0.6 }}
        >
          <NetworkDot network={n} size={12} />
          <div className="main">
            <div className="title row" style={{ gap: 6 }}>
              <span className="ellipsis">{n.name}</span>
              {n.testnet && <span className="tag">Testnet</span>}
              {n.custom && <span className="tag">Custom</span>}
            </div>
            <div className="sub ellipsis">
              {n.type === 'evm' ? `EVM · chain ${n.chainId}` : 'Solana'} · {rpcHost(n.rpcUrl)}
            </div>
          </div>
          {/* Toggle sits inside a clickable row; keep its click from opening the editor. */}
          <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            <Toggle on={n.enabled} onChange={(v) => setEnabled(n, v)} label={`Enable ${n.name}`} />
          </span>
        </div>
      ))}
    </div>
  );

  return (
    <div className="screen">
      <TopBar title="Networks" />
      <div className="screen-body">
        <h2 className="section">Mainnets</h2>
        {rows(mainnets)}
        {testnets.length > 0 && (
          <>
            <h2 className="section">Testnets</h2>
            {!state.settings.showTestnets && (
              <div className="small muted" style={{ marginBottom: 4 }}>
                Testnets are hidden from your balances. Turn on "Show testnets" in Settings to use them.
              </div>
            )}
            {rows(testnets)}
          </>
        )}
      </div>
      <div className="screen-footer">
        <Button variant="secondary" small icon="plus" onClick={() => navigate('/settings/network', { new: 'evm' })}>
          Add EVM network
        </Button>
        <Button variant="secondary" small icon="plus" onClick={() => navigate('/settings/network', { new: 'solana' })}>
          Add Solana network
        </Button>
      </div>
    </div>
  );
}
