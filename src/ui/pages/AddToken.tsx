import { useCallback, useEffect, useState } from 'react';
import type { Token } from '../../core/types';
import { shortAddress } from '../../core/format';
import { isValidAddress } from '../../core/address';
import { api } from '../lib/api';
import { navigate, useRoute } from '../lib/router';
import { useWallet } from '../lib/store';
import { Button, ErrorNote, Field, NetworkDot, Screen, Spinner, TokenIcon, TopBar } from '../components/ui';
import { NetworkPicker } from '../components/pickers';
import { Icon } from '../components/Icon';

export function AddToken() {
  const { state, activeNetworks, toast } = useWallet();
  const route = useRoute();
  const [networkId, setNetworkId] = useState(() => {
    const wanted = route.query.get('network') ?? state.settings.selectedNetworkId;
    return activeNetworks.find((n) => n.id === wanted)?.id ?? activeNetworks[0]?.id;
  });
  const network = activeNetworks.find((n) => n.id === networkId);
  const [address, setAddress] = useState('');
  const [found, setFound] = useState<Token>();
  const [symbol, setSymbol] = useState('');
  const [looking, setLooking] = useState(false);
  const [lookupError, setLookupError] = useState<string>();
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [custom, setCustom] = useState<Token[]>([]);
  const [picker, setPicker] = useState(false);

  const loadCustom = useCallback(() => {
    api.getCustomTokens().then(setCustom).catch(() => {});
  }, []);
  useEffect(loadCustom, [loadCustom]);

  const trimmed = address.trim();
  const formatError = network && trimmed && !isValidAddress(network.type, trimmed)
    ? network.type === 'evm'
      ? 'Enter a 0x contract address (42 characters).'
      : 'Enter a Solana mint address.'
    : undefined;

  const netId = network?.id;
  const netName = network?.name;
  useEffect(() => {
    setFound(undefined);
    setLookupError(undefined);
    if (!netId || !trimmed || formatError) return;
    let stale = false;
    setLooking(true);
    const t = setTimeout(() => {
      api
        .lookupToken(netId, trimmed)
        .then((tok) => {
          if (stale) return;
          setFound(tok);
          setSymbol(tok.symbol);
        })
        .catch((e: Error) => !stale && setLookupError(`Couldn't read this token on ${netName}: ${e.message}. Check the address and network.`))
        .finally(() => !stale && setLooking(false));
    }, 500);
    return () => {
      stale = true;
      clearTimeout(t);
      setLooking(false);
    };
  }, [netId, netName, trimmed, formatError]);

  const add = async () => {
    if (!found) return;
    setAdding(true);
    setError(undefined);
    try {
      await api.addCustomToken({ ...found, symbol: symbol.trim() || found.symbol });
      toast('Token added');
      navigate('/', undefined, true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const remove = async (t: Token) => {
    try {
      await api.removeCustomToken(t.networkId, t.address);
      toast(`Removed ${t.symbol}`);
      loadCustom();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const existing = custom.filter((t) => t.networkId === networkId);

  return (
    <Screen>
      <TopBar title="Add a token" />
      <div className="screen-body stack">
        <Field label="Network">
          <button className="chip" style={{ alignSelf: 'flex-start' }} onClick={() => setPicker(true)}>
            <NetworkDot network={network} />
            {network?.name ?? 'Select network'}
            <Icon name="chevronDown" size={14} />
          </button>
        </Field>
        <Field
          label={network?.type === 'solana' ? 'Mint address' : 'Contract address'}
          htmlFor="token-address"
          error={formatError ?? lookupError}
        >
          <div className="input-group">
            <input
              id="token-address"
              className={`input mono ${formatError || lookupError ? 'invalid' : ''}`}
              spellCheck={false}
              autoFocus
              placeholder={network?.type === 'solana' ? 'Paste mint address' : 'Paste 0x address'}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
            {looking && (
              <span className="suffix muted">
                <Spinner size={14} />
              </span>
            )}
          </div>
        </Field>

        {found && (
          <div className="panel stack" style={{ gap: 10 }}>
            <div className="row">
              <TokenIcon token={{ ...found, symbol: symbol || found.symbol }} network={network} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 650 }} className="ellipsis">
                  {found.name}
                </div>
                <div className="small muted">{found.decimals} decimals</div>
              </div>
            </div>
            <Field label="Symbol" htmlFor="token-symbol">
              <input
                id="token-symbol"
                className="input"
                maxLength={16}
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
              />
            </Field>
          </div>
        )}
        <ErrorNote error={error} />

        {existing.length > 0 && (
          <div>
            <h2 className="section">Your custom tokens on {network?.name}</h2>
            <div className="list">
              {existing.map((t) => (
                <div key={t.address} className="list-item">
                  <TokenIcon token={t} network={network} />
                  <div className="main">
                    <div className="title">{t.symbol}</div>
                    <div className="sub ellipsis">
                      {t.name} · {shortAddress(t.address)}
                    </div>
                  </div>
                  <button className="icon-btn" aria-label={`Remove ${t.symbol}`} title="Remove" onClick={() => remove(t)}>
                    <Icon name="trash" size={16} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="screen-footer">
        <Button onClick={add} disabled={!found || looking || !symbol.trim()} loading={adding}>
          Add token
        </Button>
      </div>

      {picker && (
        <NetworkPicker
          networks={activeNetworks}
          selected={networkId}
          onSelect={(id) => {
            setPicker(false);
            setNetworkId(id);
          }}
          onClose={() => setPicker(false)}
        />
      )}
    </Screen>
  );
}
