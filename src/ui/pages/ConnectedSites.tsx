import { useState } from 'react';
import type { Permission } from '../../core/types';
import { api } from '../lib/api';
import { useAsync, useWallet } from '../lib/store';
import { Button, Empty, ErrorNote, Spinner, TopBar } from '../components/ui';
import { Icon } from '../components/Icon';

function hostname(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

export function ConnectedSites() {
  const { state, networks, toast } = useWallet();
  const { data, error, loading, reload } = useAsync(() => api.getPermissions(), []);
  const [busy, setBusy] = useState<string>();
  const sites = Object.values(data ?? {}).sort((a, b) => b.connectedAt - a.connectedAt);

  const disconnect = async (p: Permission) => {
    setBusy(p.origin);
    try {
      await api.revokePermission(p.origin);
      await reload();
      toast(`Disconnected ${hostname(p.origin)}`);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="screen">
      <TopBar title="Connected sites" />
      <div className="screen-body">
        <ErrorNote error={error} />
        {loading && !data && (
          <div className="center" style={{ padding: 24 }}>
            <Spinner />
          </div>
        )}
        {data && !sites.length && (
          <Empty title="No connected sites">When you connect this wallet to a site, it shows up here. You can disconnect it at any time.</Empty>
        )}
        <div className="list">
          {sites.map((p) => {
            const names = p.accountIds.map((id) => state.accounts.find((a) => a.id === id)?.name).filter(Boolean);
            const evmNetwork = p.evmNetworkId ? networks.find((n) => n.id === p.evmNetworkId) : undefined;
            return (
              <div key={p.origin} className="list-item" style={{ alignItems: 'flex-start' }}>
                <span className="row" style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--surface)', justifyContent: 'center' }}>
                  <Icon name="globe" size={16} />
                </span>
                <div className="main">
                  <div className="title ellipsis" title={p.origin}>
                    {hostname(p.origin)}
                  </div>
                  <div className="sub">{names.length ? names.join(', ') : 'No accounts'}</div>
                  <div className="sub">
                    Connected {new Date(p.connectedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                    {evmNetwork && ` · ${evmNetwork.name}`}
                  </div>
                </div>
                <Button variant="secondary" small loading={busy === p.origin} onClick={() => disconnect(p)}>
                  Disconnect
                </Button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
