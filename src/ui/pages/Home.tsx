import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Portfolio } from '../../core/wallet/service';
import type { Account, Network, TxRecord } from '../../core/types';
import { formatAmount, formatUsd, shortAddress } from '../../core/format';
import { api } from '../lib/api';
import { navigate, useRoute } from '../lib/router';
import { useWallet } from '../lib/store';
import { setTxCache } from '../lib/txCache';
import { Avatar, CopyButton, Empty, NetworkDot, Sheet, Spinner, StatusPill, TokenIcon } from '../components/ui';
import { NetworkPicker } from '../components/pickers';
import { Icon } from '../components/Icon';

export function Home() {
  const { state, account, networks, activeNetworks, refresh, toast } = useWallet();
  const route = useRoute();
  const routeTab = route.query.get('tab') === 'activity' ? 'activity' : 'tokens';
  const [tab, setTab] = useState<'tokens' | 'activity'>(routeTab);
  useEffect(() => setTab(routeTab), [routeTab]);
  const [portfolio, setPortfolio] = useState<Portfolio>();
  const [loading, setLoading] = useState(false);
  const [sheet, setSheet] = useState<'accounts' | 'network'>();
  const selectedNetwork = state.settings.selectedNetworkId;
  const network = networks.find((n) => n.id === selectedNetwork);

  const load = useCallback(async () => {
    if (!account) return;
    setLoading(true);
    try {
      setPortfolio(await api.getPortfolio(account.id));
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setLoading(false);
    }
  }, [account, toast]);

  useEffect(() => {
    if (!account) return;
    let stale = false;
    api.getCachedPortfolio(account.id).then((p) => !stale && p && setPortfolio(p));
    void load();
    return () => {
      stale = true;
    };
  }, [account, load, state.settings.showTestnets]);

  const visibleNetworks = useMemo(
    () => activeNetworks.filter((n) => !account || (n.type === 'evm' ? account.evmAddress : account.solanaAddress)),
    [activeNetworks, account],
  );
  const balances = useMemo(() => {
    const ids = new Set(visibleNetworks.map((n) => n.id));
    const all = (portfolio?.balances ?? []).filter((b) => (selectedNetwork === 'all' ? ids.has(b.networkId) : b.networkId === selectedNetwork));
    if (selectedNetwork === 'all') {
      // Across many chains, empty native balances are noise; fall back to them only for an empty wallet.
      const held = all.filter((b) => b.balance !== '0');
      return held.length ? held : all.filter((b) => b.address === 'native');
    }
    return all.filter((b) => !state.settings.hideZeroBalances || b.balance !== '0' || b.address === 'native');
  }, [portfolio, selectedNetwork, visibleNetworks, state.settings.hideZeroBalances]);
  const total = balances.reduce((a, b) => a + (b.valueUsd ?? 0), 0);
  const failing = Object.entries(portfolio?.errors ?? {}).filter(
    ([id]) => id !== 'prices' && (selectedNetwork === 'all' || id === selectedNetwork),
  );

  const selectNetwork = async (id: string) => {
    setSheet(undefined);
    await api.updateSettings({ selectedNetworkId: id });
    await refresh();
  };

  if (!account) return null;
  const supportsSwap = selectedNetwork === 'all' || !!network?.lifiChainId;

  return (
    <div className="screen">
      <div className="topbar">
        <button className="chip" style={{ border: 'none', paddingLeft: 6 }} onClick={() => setSheet('accounts')} aria-label="Switch account">
          <Avatar seed={account.evmAddress ?? account.solanaAddress ?? account.id} size={26} />
          <span className="ellipsis" style={{ maxWidth: 120 }}>
            {account.name}
          </span>
          <Icon name="chevronDown" size={14} />
        </button>
        <div className="spacer" />
        <button className="chip" onClick={() => setSheet('network')} aria-label="Select network">
          {network ? <NetworkDot network={network} /> : <Icon name="layers" size={14} />}
          <span className="ellipsis" style={{ maxWidth: 92 }}>
            {network?.name ?? 'All networks'}
          </span>
        </button>
        <button
          className="icon-btn"
          aria-label="Open in tab"
          title="Open in tab"
          onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('popup.html#/?tab=1') })}
        >
          <Icon name="expand" size={16} />
        </button>
        <button className="icon-btn" aria-label="Settings" onClick={() => navigate('/settings')}>
          <Icon name="settings" />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        <div className="balance">
          <AddressLine account={account} network={network} />
          <div className="total num" data-testid="total-balance">
            {portfolio ? formatUsd(total, { hero: true }) : <span className="skeleton" style={{ display: 'inline-block', width: 140, height: 36 }} />}
          </div>
        </div>

        <div className="actions">
          <Action icon="send" label="Send" onClick={() => navigate('/send', { network: network?.id })} />
          <Action icon="receive" label="Receive" onClick={() => navigate('/receive', { network: network?.id })} />
          <Action icon="swap" label="Swap" disabled={!supportsSwap} onClick={() => navigate('/swap', { network: network?.id })} />
          <Action
            icon="bridge"
            label="Bridge"
            disabled={!supportsSwap}
            onClick={() => navigate('/swap', { mode: 'bridge', network: network?.id })}
          />
        </div>

        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'tokens'} className={tab === 'tokens' ? 'active' : ''} onClick={() => setTab('tokens')}>
            Tokens
          </button>
          <button
            role="tab"
            aria-selected={tab === 'activity'}
            className={tab === 'activity' ? 'active' : ''}
            onClick={() => setTab('activity')}
          >
            Activity
          </button>
          <div className="spacer" />
          {tab === 'tokens' && (
            <button className="icon-btn" aria-label="Refresh balances" onClick={() => void load()} disabled={loading}>
              {loading ? <Spinner size={14} /> : <Icon name="refresh" size={16} />}
            </button>
          )}
        </div>

        <div style={{ padding: '0 20px 16px' }}>
          {tab === 'tokens' ? (
            <>
              {failing.length > 0 && (
                <div className="notice" style={{ marginTop: 12 }}>
                  Couldn't load {failing.map(([id]) => networks.find((n) => n.id === id)?.name ?? id).join(', ')}. Check the RPC in
                  Settings → Networks.
                </div>
              )}
              <div className="list" data-testid="token-list">
                {balances.map((b) => {
                  const n = networks.find((x) => x.id === b.networkId);
                  return (
                    <button
                      key={`${b.networkId}:${b.address}`}
                      className="list-item"
                      onClick={() => navigate('/send', { network: b.networkId, token: b.address })}
                    >
                      <TokenIcon token={b} network={n} />
                      <div className="main">
                        <div className="title">{b.symbol}</div>
                        <div className="sub ellipsis">
                          {n?.name}
                          {b.priceUsd !== undefined && ` · ${formatUsd(b.priceUsd)}`}
                        </div>
                      </div>
                      <div className="end">
                        <div className="num" style={{ fontWeight: 650 }}>
                          {formatAmount(b.balance, b.decimals)}
                        </div>
                        <div className="sub num">{formatUsd(b.valueUsd)}</div>
                      </div>
                    </button>
                  );
                })}
                {!portfolio && loading && <SkeletonRows />}
              </div>
              <div className="center" style={{ paddingTop: 10 }}>
                <button className="link-btn" onClick={() => navigate('/tokens/add', { network: network?.id })}>
                  Add a token
                </button>
              </div>
            </>
          ) : (
            <Activity account={account} networkId={selectedNetwork === 'all' ? undefined : selectedNetwork} networks={networks} />
          )}
        </div>
      </div>

      {sheet === 'network' && (
        <NetworkPicker
          networks={visibleNetworks}
          selected={selectedNetwork}
          allowAll
          onSelect={selectNetwork}
          onClose={() => setSheet(undefined)}
        />
      )}
      {sheet === 'accounts' && <AccountSwitcher onClose={() => setSheet(undefined)} />}
    </div>
  );
}

function Action({ icon, label, onClick, disabled }: { icon: 'send' | 'receive' | 'swap' | 'bridge'; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button className="action" onClick={onClick} disabled={disabled}>
      <span className="circle">
        <Icon name={icon} size={20} />
      </span>
      {label}
    </button>
  );
}

function AddressLine({ account, network }: { account: Account; network?: Network }) {
  const rows: { label: string; address: string }[] = [];
  if (account.evmAddress && (!network || network.type === 'evm')) rows.push({ label: 'EVM', address: account.evmAddress });
  if (account.solanaAddress && (!network || network.type === 'solana')) rows.push({ label: 'Solana', address: account.solanaAddress });
  return (
    <div className="row" style={{ gap: 4, marginBottom: 6, flexWrap: 'wrap' }}>
      {rows.map((r) => (
        <span key={r.label} className="row muted small" style={{ gap: 0 }}>
          <span>
            {r.label} {shortAddress(r.address)}
          </span>
          <CopyButton text={r.address} label={`Copy ${r.label} address`} />
        </span>
      ))}
    </div>
  );
}

function SkeletonRows() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div key={i} className="list-item">
          <div className="skeleton" style={{ width: 36, height: 36, borderRadius: '50%' }} />
          <div className="main">
            <div className="skeleton" style={{ width: 80, height: 12, marginBottom: 6 }} />
            <div className="skeleton" style={{ width: 120, height: 10 }} />
          </div>
        </div>
      ))}
    </>
  );
}

function timeAgo(ts: number): string {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function Activity({ account, networkId, networks }: { account: Account; networkId?: string; networks: Network[] }) {
  const [txs, setTxs] = useState<TxRecord[]>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    // Show this wallet's own transactions right away; indexers can take a while.
    api
      .getHistory(account.id, networkId, { localOnly: true })
      .then((r) => !stale && r.txs.length && setTxs((cur) => cur ?? r.txs))
      .catch(() => {});
    api
      .getHistory(account.id, networkId)
      .then((r) => {
        if (stale) return;
        setTxs(r.txs);
        setErrors(r.errors);
        setTxCache(r.txs);
      })
      .catch((e: Error) => !stale && setErrors({ all: e.message }))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
    };
  }, [account.id, networkId]);

  const failing = Object.keys(errors);
  return (
    <div data-testid="activity-list">
      {failing.length > 0 && (
        <div className="notice" style={{ marginTop: 12 }}>
          History unavailable for {failing.map((id) => networks.find((n) => n.id === id)?.name ?? id).join(', ')}. Transactions sent
          from this wallet still appear. You can switch the history provider in Settings → Networks.
        </div>
      )}
      {loading && !txs && (
        <div className="center" style={{ padding: 24 }}>
          <Spinner />
        </div>
      )}
      {loading && txs && (
        <div className="row small muted" style={{ padding: '10px 0 0' }}>
          <Spinner size={12} /> Loading full history…
        </div>
      )}
      {txs && !txs.length && !loading && (
        <Empty title="No activity yet">Transactions you send and receive will show up here.</Empty>
      )}
      <div className="list">
        {txs?.map((t) => {
          const n = networks.find((x) => x.id === t.networkId);
          const sign = t.direction === 'in' ? '+' : t.direction === 'out' ? '−' : '';
          return (
            <button key={`${t.networkId}:${t.hash}`} className="list-item" onClick={() => navigate('/tx', { hash: t.hash, network: t.networkId })}>
              <span className="token-icon">
                <span className="face" style={{ background: 'var(--surface)', color: 'var(--ink-2)' }}>
                  <Icon name={kindIcon(t)} size={16} />
                </span>
                {n && <span className="net" style={{ background: n.color }} />}
              </span>
              <div className="main">
                <div className="title ellipsis">{t.title}</div>
                <div className="sub row" style={{ gap: 6 }}>
                  <span>{timeAgo(t.timestamp)}</span>
                  <StatusPill status={t.status} />
                  {t.kind === 'bridge' && t.bridge?.status === 'PENDING' && t.status === 'confirmed' && (
                    <span className="status-pill pending">Bridging</span>
                  )}
                </div>
              </div>
              {t.amount && t.amount !== '0' && t.kind !== 'swap' && (
                <div className={`end num ${t.direction === 'in' ? 'pos' : ''}`} style={{ fontWeight: 650 }}>
                  {sign}
                  {t.amount} {t.symbol}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function kindIcon(t: TxRecord) {
  if (t.kind === 'swap') return 'swap' as const;
  if (t.kind === 'bridge') return 'bridge' as const;
  if (t.kind === 'approve') return 'check' as const;
  if (t.direction === 'in') return 'receive' as const;
  if (t.direction === 'out') return 'send' as const;
  return 'globe' as const;
}

export function AccountSwitcher({ onClose }: { onClose: () => void }) {
  const { state, refresh } = useWallet();
  const groups: { title: string; accounts: Account[] }[] = [
    ...state.seeds.map((s) => ({ title: s.name, accounts: state.accounts.filter((a) => a.seedId === s.id && !a.hidden) })),
    { title: 'Imported', accounts: state.accounts.filter((a) => a.kind === 'privateKey' && !a.hidden) },
  ].filter((g) => g.accounts.length);
  const select = async (id: string) => {
    await api.selectAccount(id);
    await refresh();
    onClose();
  };
  return (
    <Sheet title="Accounts" onClose={onClose}>
      {groups.map((g) => (
        <div key={g.title}>
          <h2 className="section">{g.title}</h2>
          <div className="list">
            {g.accounts.map((a) => (
              <button key={a.id} className="list-item" onClick={() => select(a.id)}>
                <Avatar seed={a.evmAddress ?? a.solanaAddress ?? a.id} />
                <div className="main">
                  <div className="title">{a.name}</div>
                  <div className="sub">
                    {[a.evmAddress && shortAddress(a.evmAddress), a.solanaAddress && shortAddress(a.solanaAddress)].filter(Boolean).join(' · ')}
                  </div>
                </div>
                {a.id === state.selectedAccountId && <Icon name="check" />}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn secondary small" style={{ flex: 1 }} onClick={() => navigate('/accounts/add')}>
          Add account
        </button>
        <button className="btn secondary small" style={{ flex: 1 }} onClick={() => navigate('/accounts')}>
          Manage
        </button>
      </div>
    </Sheet>
  );
}
