import { useState, type ReactNode } from 'react';
import type { ChainType, EvmNetwork, HistoryProvider, Network, SolanaNetwork } from '../../core/types';
import { DEFAULT_NETWORKS } from '../../core/networks';
import { api } from '../lib/api';
import { back, useRoute } from '../lib/router';
import { useWallet } from '../lib/store';
import { Button, Empty, Field, NetworkDot, Spinner, Toggle, TopBar } from '../components/ui';
import { ConfirmSheet } from '../components/sheets';

const ETHERSCAN_URL = 'https://api.etherscan.io/v2/api';
// Brand colors already used by the built-in networks, so custom networks stay visually consistent.
const PALETTE = ['#627EEA', '#0052FF', '#28A0F0', '#FF0420', '#8247E5', '#F0B90B', '#E84142', '#9945FF', '#12805c', '#A0A0A0'];
const CLUSTERS: SolanaNetwork['cluster'][] = ['mainnet-beta', 'devnet', 'testnet', 'custom'];

interface Form {
  name: string;
  id: string;
  rpcUrl: string;
  chainId: string;
  currencyName: string;
  symbol: string;
  decimals: string;
  explorerUrl: string;
  testnet: boolean;
  enabled: boolean;
  color: string;
  nativePriceId: string;
  priceChain: string;
  lifiChainId: string;
  cluster: SolanaNetwork['cluster'];
  historyKind: HistoryProvider['kind'];
  blockscoutUrl: string;
  etherscanUrl: string;
  etherscanKey: string;
}

function toForm(n: Network | undefined, type: ChainType): Form {
  const h = n?.type === 'evm' ? n.history : undefined;
  return {
    name: n?.name ?? '',
    id: n?.id ?? '',
    rpcUrl: n?.rpcUrl ?? '',
    chainId: n?.type === 'evm' ? String(n.chainId) : '',
    currencyName: n?.nativeCurrency.name ?? (type === 'solana' ? 'Solana' : ''),
    symbol: n?.nativeCurrency.symbol ?? (type === 'solana' ? 'SOL' : ''),
    decimals: String(n?.nativeCurrency.decimals ?? (type === 'solana' ? 9 : 18)),
    explorerUrl: n?.explorerUrl ?? (type === 'solana' ? 'https://explorer.solana.com' : ''),
    testnet: n?.testnet ?? false,
    enabled: n?.enabled ?? true,
    color: n?.color ?? PALETTE[0],
    nativePriceId: n?.nativePriceId ?? '',
    priceChain: n?.priceChain ?? '',
    lifiChainId: n?.lifiChainId !== undefined ? String(n.lifiChainId) : '',
    cluster: n?.type === 'solana' ? n.cluster : 'custom',
    historyKind: h?.kind ?? 'none',
    blockscoutUrl: h?.kind === 'blockscout' ? h.url : '',
    etherscanUrl: h?.kind === 'etherscan' ? h.url : ETHERSCAN_URL,
    etherscanKey: h?.kind === 'etherscan' ? (h.apiKey ?? '') : '',
  };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Empty → NaN so the service's integer checks report a missing value instead of accepting 0. */
const toInt = (s: string) => (s.trim() === '' ? NaN : Number(s.trim()));
const opt = (s: string) => s.trim() || undefined;

function fromForm(f: Form, type: ChainType): Network {
  const lifi = f.lifiChainId.trim();
  if (lifi && !/^\d+$/.test(lifi)) throw new Error('LI.FI chain ID must be a whole number. Leave it empty to turn off swaps on this network.');
  const base = {
    id: f.id.trim(),
    name: f.name.trim(),
    rpcUrl: f.rpcUrl.trim(),
    explorerUrl: f.explorerUrl.trim(),
    nativeCurrency: { name: f.currencyName.trim() || f.symbol.trim(), symbol: f.symbol.trim(), decimals: toInt(f.decimals) },
    nativePriceId: opt(f.nativePriceId),
    priceChain: opt(f.priceChain),
    lifiChainId: lifi ? Number(lifi) : undefined,
    testnet: f.testnet,
    enabled: f.enabled,
    color: f.color,
  };
  if (type === 'solana') return { ...base, type, cluster: f.cluster } satisfies SolanaNetwork;
  let history: HistoryProvider = { kind: 'none' };
  if (f.historyKind === 'blockscout') {
    if (!/^https?:\/\//.test(f.blockscoutUrl.trim())) throw new Error('Blockscout URL must start with http:// or https://');
    history = { kind: 'blockscout', url: f.blockscoutUrl.trim() };
  } else if (f.historyKind === 'etherscan') {
    if (!/^https?:\/\//.test(f.etherscanUrl.trim())) throw new Error('Etherscan API URL must start with http:// or https://');
    history = { kind: 'etherscan', url: f.etherscanUrl.trim(), apiKey: opt(f.etherscanKey) };
  }
  return { ...base, type, chainId: toInt(f.chainId), history } satisfies EvmNetwork;
}

export function NetworkEdit() {
  const { networks } = useWallet();
  const q = useRoute().query;
  const id = q.get('id');
  const newType: ChainType | undefined = q.get('new') === 'solana' ? 'solana' : q.get('new') === 'evm' ? 'evm' : undefined;
  const network = id ? networks.find((n) => n.id === id) : undefined;

  if (!network && !newType) {
    return (
      <div className="screen">
        <TopBar title="Network" />
        <Empty title="Network not found">It may have been removed.</Empty>
      </div>
    );
  }
  // Keyed so switching between networks resets the form.
  return <Editor key={network?.id ?? `new-${newType}`} network={network} type={network?.type ?? newType!} />;
}

function Editor({ network, type }: { network?: Network; type: ChainType }) {
  const { networks, refresh, toast } = useWallet();
  const isNew = !network;
  const builtIn = !!network && DEFAULT_NETWORKS.some((n) => n.id === network.id);
  const [f, setF] = useState<Form>(() => toForm(network, type));
  const [idTouched, setIdTouched] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; chainId?: number; error?: string } | 'loading'>();
  const [confirm, setConfirm] = useState<'reset' | 'remove'>();

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((prev) => ({ ...prev, [k]: v }));
  const done = () => back('/settings/networks');

  const runTest = async () => {
    setTest('loading');
    try {
      setTest(await api.testRpc(type, f.rpcUrl.trim()));
    } catch (e) {
      setTest({ ok: false, error: (e as Error).message });
    }
  };

  const save = async () => {
    setErrors([]);
    try {
      const n = fromForm(f, type);
      if (isNew && networks.some((x) => x.id === n.id)) throw new Error(`The id "${n.id}" is already used by another network. Pick a different one.`);
      setSaving(true);
      await api.upsertNetwork(n, { create: isNew });
      await refresh();
      toast(isNew ? `${n.name} added` : 'Network saved');
      done();
    } catch (e) {
      // upsertNetwork joins all validation problems with "; ".
      setErrors((e as Error).message.split('; '));
      setSaving(false);
    }
  };

  const chainIdMismatch = test && test !== 'loading' && test.ok && test.chainId !== undefined && String(test.chainId) !== f.chainId.trim();

  return (
    <div className="screen">
      <TopBar
        title={isNew ? `Add ${type === 'evm' ? 'EVM' : 'Solana'} network` : network.name}
        right={!isNew && <NetworkDot network={{ color: f.color }} size={12} />}
      />
      <form
        style={{ display: 'contents' }}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="screen-body">
          <div className="stack">
            <Field label="Name" htmlFor="net-name">
              <input
                id="net-name"
                className="input"
                autoFocus={isNew}
                value={f.name}
                onChange={(e) => {
                  const name = e.target.value;
                  setF((prev) => ({ ...prev, name, id: isNew && !idTouched ? slug(name) : prev.id }));
                }}
              />
            </Field>
            <Field label="Id" htmlFor="net-id" hint={isNew ? 'Used internally. Lowercase letters, digits and dashes.' : "Built into saved data, so it can't change."}>
              <input
                id="net-id"
                className="input mono"
                disabled={!isNew}
                value={f.id}
                onChange={(e) => {
                  setIdTouched(true);
                  set('id', e.target.value.toLowerCase());
                }}
              />
            </Field>

            <Field label="RPC URL" htmlFor="net-rpc">
              <div className="row" style={{ gap: 8 }}>
                <input
                  id="net-rpc"
                  className="input"
                  placeholder="https://"
                  value={f.rpcUrl}
                  onChange={(e) => {
                    set('rpcUrl', e.target.value);
                    setTest(undefined);
                  }}
                />
                <Button type="button" variant="secondary" small onClick={runTest} disabled={!f.rpcUrl.trim() || test === 'loading'}>
                  {test === 'loading' ? <Spinner size={14} /> : 'Test'}
                </Button>
              </div>
              {test && test !== 'loading' && (
                <div className={`small ${test.ok ? 'pos' : 'neg'}`} role="status">
                  {test.ok
                    ? `Connected${test.chainId !== undefined ? ` · chain id ${test.chainId}` : ''}`
                    : `Couldn't connect: ${test.error ?? 'no response'}. Check the URL and try again.`}
                  {chainIdMismatch && type === 'evm' && (
                    <>
                      {' '}
                      <button type="button" className="link-btn" onClick={() => set('chainId', String(test.chainId))}>
                        Use chain id {test.chainId}
                      </button>
                    </>
                  )}
                </div>
              )}
            </Field>

            {type === 'evm' ? (
              <Field label="Chain ID" htmlFor="net-chain">
                <input id="net-chain" className="input" inputMode="numeric" value={f.chainId} onChange={(e) => set('chainId', e.target.value)} />
              </Field>
            ) : (
              <Field label="Cluster" htmlFor="net-cluster" hint="Used for explorer links.">
                <select id="net-cluster" className="select" value={f.cluster} onChange={(e) => set('cluster', e.target.value as Form['cluster'])}>
                  {CLUSTERS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            <Field label="Currency name" htmlFor="net-cur-name">
              <input id="net-cur-name" className="input" value={f.currencyName} onChange={(e) => set('currencyName', e.target.value)} />
            </Field>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <div style={{ flex: 2 }}>
                <Field label="Symbol" htmlFor="net-symbol">
                  <input id="net-symbol" className="input" value={f.symbol} onChange={(e) => set('symbol', e.target.value)} />
                </Field>
              </div>
              <div style={{ flex: 1 }}>
                <Field label="Decimals" htmlFor="net-decimals">
                  <input id="net-decimals" className="input" inputMode="numeric" value={f.decimals} onChange={(e) => set('decimals', e.target.value)} />
                </Field>
              </div>
            </div>

            <Field label="Block explorer URL" htmlFor="net-explorer" hint="Optional. Used for address and transaction links.">
              <input id="net-explorer" className="input" placeholder="https://" value={f.explorerUrl} onChange={(e) => set('explorerUrl', e.target.value)} />
            </Field>

            {type === 'evm' && (
              <Field
                label="Transaction history"
                hint={
                  f.historyKind === 'none'
                    ? 'Only transactions sent from this wallet will show in Activity.'
                    : f.historyKind === 'blockscout'
                      ? 'Blockscout instance for this chain, e.g. https://eth.blockscout.com'
                      : 'Etherscan V2 covers most chains with one API key.'
                }
              >
                <div className="segmented" role="radiogroup" aria-label="Transaction history">
                  {(['none', 'blockscout', 'etherscan'] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      role="radio"
                      aria-checked={f.historyKind === k}
                      className={f.historyKind === k ? 'active' : ''}
                      onClick={() => set('historyKind', k)}
                    >
                      {k === 'none' ? 'None' : k === 'blockscout' ? 'Blockscout' : 'Etherscan'}
                    </button>
                  ))}
                </div>
                {f.historyKind === 'blockscout' && (
                  <input
                    className="input"
                    aria-label="Blockscout URL"
                    placeholder="https://"
                    value={f.blockscoutUrl}
                    onChange={(e) => set('blockscoutUrl', e.target.value)}
                  />
                )}
                {f.historyKind === 'etherscan' && (
                  <>
                    <input className="input" aria-label="Etherscan API URL" value={f.etherscanUrl} onChange={(e) => set('etherscanUrl', e.target.value)} />
                    <input
                      className="input"
                      type="password"
                      aria-label="Etherscan API key"
                      placeholder="API key"
                      autoComplete="off"
                      value={f.etherscanKey}
                      onChange={(e) => set('etherscanKey', e.target.value)}
                    />
                  </>
                )}
              </Field>
            )}

            <Field label="Color">
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }} role="radiogroup" aria-label="Color">
                {PALETTE.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={f.color === c}
                    aria-label={c}
                    onClick={() => set('color', c)}
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: '50%',
                      background: c,
                      border: '2px solid var(--bg)',
                      outline: f.color === c ? '2px solid var(--ink)' : 'none',
                      cursor: 'pointer',
                    }}
                  />
                ))}
              </div>
            </Field>

            <div className="list">
              <ToggleRow title="Testnet" sub="Hidden unless Show testnets is on">
                <Toggle on={f.testnet} onChange={(v) => set('testnet', v)} label="Testnet" />
              </ToggleRow>
              <ToggleRow title="Enabled" sub="Show balances and activity for this network">
                <Toggle on={f.enabled} onChange={(v) => set('enabled', v)} label="Enabled" />
              </ToggleRow>
            </div>

            <div>
              <button type="button" className="link-btn small" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
                {advanced ? 'Hide advanced settings' : 'Show advanced settings'}
              </button>
            </div>
            {advanced && (
              <>
                <Field label="Native price id" htmlFor="net-price-id" hint='DefiLlama key for the native coin, e.g. "coingecko:ethereum". Leave empty to skip USD prices.'>
                  <input id="net-price-id" className="input mono" value={f.nativePriceId} onChange={(e) => set('nativePriceId', e.target.value)} />
                </Field>
                <Field label="Price chain" htmlFor="net-price-chain" hint='DefiLlama chain slug for token prices, e.g. "ethereum" or "base".'>
                  <input id="net-price-chain" className="input mono" value={f.priceChain} onChange={(e) => set('priceChain', e.target.value)} />
                </Field>
                <Field
                  label="LI.FI chain ID"
                  htmlFor="net-lifi"
                  hint={
                    type === 'evm'
                      ? 'Usually the same as the chain ID. Leave empty to turn off swaps and bridges here.'
                      : 'Solana mainnet is 1151111081099710. Leave empty to turn off bridges here.'
                  }
                >
                  <input id="net-lifi" className="input" inputMode="numeric" value={f.lifiChainId} onChange={(e) => set('lifiChainId', e.target.value)} />
                </Field>
              </>
            )}

            {errors.length > 0 && (
              <div className="notice error" role="alert">
                {errors.map((e) => (
                  <div key={e}>{e}</div>
                ))}
              </div>
            )}

            {builtIn && (
              <Button type="button" variant="secondary" block icon="refresh" onClick={() => setConfirm('reset')}>
                Reset to default
              </Button>
            )}
            {!isNew && !builtIn && (
              <Button type="button" variant="danger" block icon="trash" onClick={() => setConfirm('remove')}>
                Remove network
              </Button>
            )}
          </div>
        </div>
        <div className="screen-footer">
          <Button type="button" variant="secondary" onClick={done}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            {isNew ? 'Add network' : 'Save'}
          </Button>
        </div>
      </form>

      {confirm === 'reset' && network && (
        <ConfirmSheet
          title={`Reset ${network.name}?`}
          confirmLabel="Reset to default"
          danger={false}
          onClose={() => setConfirm(undefined)}
          onConfirm={async () => {
            await api.resetNetwork(network.id);
            await refresh();
            toast(`${network.name} reset to default`);
            done();
          }}
        >
          <p style={{ margin: 0 }}>Your changes to the RPC, explorer and other settings for this network are replaced with the built-in values.</p>
        </ConfirmSheet>
      )}
      {confirm === 'remove' && network && (
        <ConfirmSheet
          title={`Remove ${network.name}?`}
          confirmLabel="Remove network"
          onClose={() => setConfirm(undefined)}
          onConfirm={async () => {
            await api.removeNetwork(network.id);
            // Leave first so the editor doesn't flash "not found" once the network is gone.
            done();
            toast(`${network.name} removed`);
            await refresh();
          }}
        >
          <p style={{ margin: 0 }}>Balances and activity for this network stop showing. Your funds aren't affected, and you can add it again later.</p>
        </ConfirmSheet>
      )}
    </div>
  );
}

function ToggleRow({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <div className="list-item" style={{ minHeight: 48, padding: '8px 0' }}>
      <div className="main">
        <div className="title">{title}</div>
        <div className="sub">{sub}</div>
      </div>
      {children}
    </div>
  );
}
