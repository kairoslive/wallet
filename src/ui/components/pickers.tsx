import { useEffect, useMemo, useState } from 'react';
import type { Network, Token, TokenBalance } from '../../core/types';
import { formatAmount, formatUsd, shortAddress } from '../../core/format';
import { tokenKey } from '../../core/tokens';
import { api } from '../lib/api';
import { Button, Field, NetworkDot, Sheet, Spinner, TokenIcon } from './ui';
import { Icon } from './Icon';

export function NetworkPicker({
  networks,
  selected,
  onSelect,
  onClose,
  allowAll,
  title = 'Network',
}: {
  networks: Network[];
  selected?: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  allowAll?: boolean;
  title?: string;
}) {
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="list">
        {allowAll && (
          <button className="list-item" onClick={() => onSelect('all')}>
            <Icon name="layers" />
            <div className="main title">All networks</div>
            {selected === 'all' && <Icon name="check" />}
          </button>
        )}
        {networks.map((n) => (
          <button key={n.id} className="list-item" onClick={() => onSelect(n.id)}>
            <NetworkDot network={n} size={12} />
            <div className="main">
              <div className="title">{n.name}</div>
              <div className="sub">
                {n.type === 'evm' ? `EVM · chain ${n.chainId}` : 'Solana'}
                {n.testnet ? ' · testnet' : ''}
              </div>
            </div>
            {selected === n.id && <Icon name="check" />}
          </button>
        ))}
      </div>
    </Sheet>
  );
}

/**
 * Token picker. Shows held tokens first (from `balances`), then searches the
 * network's token list. Pasting a contract/mint address looks it up on-chain.
 */
export function TokenPicker({
  networkId,
  network,
  balances,
  onSelect,
  onClose,
  heldOnly,
}: {
  networkId: string;
  network?: Network;
  balances?: TokenBalance[];
  onSelect: (t: Token) => void;
  onClose: () => void;
  heldOnly?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Token[]>([]);
  const [loading, setLoading] = useState(false);
  const held = useMemo(() => (balances ?? []).filter((b) => b.networkId === networkId), [balances, networkId]);

  useEffect(() => {
    if (heldOnly) return;
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      api
        .searchTokens(networkId, query)
        .then((r) => !cancelled && setResults(r))
        .catch(() => !cancelled && setResults([]))
        .finally(() => !cancelled && setLoading(false));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [networkId, query, heldOnly]);

  const q = query.trim().toLowerCase();
  const heldFiltered = held.filter((t) => !q || t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q));
  const heldKeys = new Set(held.map(tokenKey));
  const others = results.filter((t) => !heldKeys.has(tokenKey(t)));

  return (
    <Sheet title="Select token" onClose={onClose}>
      <div className="input-group" style={{ marginBottom: 8 }}>
        <input
          className="input"
          autoFocus
          placeholder="Search name or paste address"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="suffix muted">{loading ? <Spinner size={14} /> : <Icon name="search" size={16} />}</span>
      </div>
      <div className="list">
        {heldFiltered.map((t) => (
          <button key={tokenKey(t)} className="list-item" onClick={() => onSelect(t)}>
            <TokenIcon token={t} network={network} />
            <div className="main">
              <div className="title">{t.symbol}</div>
              <div className="sub ellipsis">{t.name}</div>
            </div>
            <div className="end">
              <div className="num">{formatAmount(t.balance, t.decimals)}</div>
              <div className="sub num">{formatUsd(t.valueUsd)}</div>
            </div>
          </button>
        ))}
        {!heldOnly &&
          others.map((t) => (
            <button key={tokenKey(t)} className="list-item" onClick={() => onSelect(t)}>
              <TokenIcon token={t} network={network} />
              <div className="main">
                <div className="title">{t.symbol}</div>
                <div className="sub ellipsis">
                  {t.name}
                  {t.address !== 'native' && ` · ${shortAddress(t.address)}`}
                </div>
              </div>
            </button>
          ))}
        {!loading && !heldFiltered.length && (heldOnly || !others.length) && (
          <div className="empty">
            <strong>No tokens found</strong>
            Try another name, or paste the token's contract address.
          </div>
        )}
      </div>
    </Sheet>
  );
}

/** Asks for the wallet password before showing secrets. */
export function PasswordSheet({
  title,
  confirmLabel,
  onSubmit,
  onClose,
  danger,
  children,
}: {
  title: string;
  confirmLabel: string;
  onSubmit: (password: string) => Promise<void>;
  onClose: () => void;
  danger?: boolean;
  children?: React.ReactNode;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <Sheet title={title} onClose={onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(undefined);
          try {
            await onSubmit(password);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {children}
        <Field label="Password" error={error} htmlFor="pw-confirm">
          <input
            id="pw-confirm"
            className="input"
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Button type="submit" variant={danger ? 'danger' : 'primary'} block loading={busy} disabled={!password}>
          {confirmLabel}
        </Button>
      </form>
    </Sheet>
  );
}
