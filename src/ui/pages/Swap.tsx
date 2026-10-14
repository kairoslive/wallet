import { useEffect, useMemo, useState } from 'react';
import type { Account, Network, Token, TxRecord } from '../../core/types';
import type { SwapQuote } from '../../core/swap/types';
import { formatAmount, formatUsd, parseUnits, shortAddress } from '../../core/format';
import { isValidAddress } from '../../core/address';
import { explorerTxUrl } from '../../core/networks';
import { nativeToken, tokenKey } from '../../core/tokens';
import { api } from '../lib/api';
import { navigate, useRoute } from '../lib/router';
import { useWallet } from '../lib/store';
import { Button, ErrorNote, Field, NetworkDot, Screen, Sheet, Spinner, TopBar } from '../components/ui';
import { NetworkPicker, TokenPicker } from '../components/pickers';
import { AmountInput, amountError, amountUsd } from '../components/AmountInput';
import { ExplorerButton, TxHero, bridgeStatusLabel, openTab, useBridgeStatus, useTxStatus } from '../components/tx';
import { usePortfolio } from '../components/usePortfolio';
import { Icon } from '../components/Icon';

type Mode = 'swap' | 'bridge';
type Sheets = 'fromNetwork' | 'toNetwork' | 'fromToken' | 'toToken' | 'slippage';

const QUOTE_TTL_MS = 45_000;
const QUOTE_DEBOUNCE_MS = 600;
const SLIPPAGE_PRESETS = [10, 50, 100, 300];

function addressOn(account: Account, network: Network): string | undefined {
  return network.type === 'evm' ? account.evmAddress : account.solanaAddress;
}

export function Swap() {
  const { state, account, activeNetworks, refresh } = useWallet();
  const route = useRoute();
  const { portfolio, loading: portfolioLoading } = usePortfolio(account?.id);
  const [mode, setMode] = useState<Mode>(route.query.get('mode') === 'bridge' ? 'bridge' : 'swap');

  // Aggregators only cover networks with a LI.FI chain id (which excludes testnets and custom chains).
  const sourceNetworks = useMemo(
    () => activeNetworks.filter((n) => n.lifiChainId && account && addressOn(account, n)),
    [activeNetworks, account],
  );
  const destNetworks = useMemo(() => activeNetworks.filter((n) => n.lifiChainId), [activeNetworks]);
  const requested = activeNetworks.find((n) => n.id === route.query.get('network'));
  const unsupported = requested && !sourceNetworks.some((n) => n.id === requested.id) ? requested : undefined;

  const [fromId, setFromId] = useState<string | undefined>(() => {
    const wanted = requested?.id ?? state.settings.selectedNetworkId;
    return sourceNetworks.some((n) => n.id === wanted) ? wanted : undefined;
  });
  const [toId, setToId] = useState<string | undefined>(route.query.get('toNetwork') ?? undefined);
  const [fromAddr, setFromAddr] = useState(route.query.get('from') ?? 'native');
  const [toChoice, setToChoice] = useState<Token>();
  const wantedTo = route.query.get('to')?.toLowerCase();
  const [destTokens, setDestTokens] = useState<Token[]>([]);
  const [amount, setAmount] = useState('');
  const [destAddress, setDestAddress] = useState('');
  const [sheet, setSheet] = useState<Sheets>();
  const [quote, setQuote] = useState<{ q: SwapQuote; at: number }>();
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string>();
  const [nonce, setNonce] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<'max' | 'execute'>();
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<{ record: TxRecord; quote: SwapQuote }>();

  useEffect(() => {
    if (fromId || (!portfolio && portfolioLoading)) return;
    const ids = new Set(sourceNetworks.map((n) => n.id));
    const richest = portfolio?.balances.find((b) => ids.has(b.networkId) && b.balance !== '0');
    setFromId(richest?.networkId ?? sourceNetworks[0]?.id);
  }, [fromId, portfolio, portfolioLoading, sourceNetworks]);

  const fromNetwork = sourceNetworks.find((n) => n.id === fromId);
  const toNetworkId =
    mode === 'swap'
      ? fromId
      : toId && toId !== fromId
        ? toId
        : (
            destNetworks.find((n) => n.id !== fromId && account && addressOn(account, n)) ??
            destNetworks.find((n) => n.id !== fromId)
          )?.id;
  const toNetwork = destNetworks.find((n) => n.id === toNetworkId);

  useEffect(() => {
    if (!toNetworkId) return;
    let stale = false;
    api
      .getTokens(toNetworkId)
      .then((t) => !stale && setDestTokens(t))
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [toNetworkId]);

  const held = useMemo(() => {
    const list = (portfolio?.balances ?? []).filter(
      (b) => b.networkId === fromId && (b.balance !== '0' || b.address === 'native'),
    );
    if (fromNetwork && !list.some((b) => b.address === 'native')) list.unshift({ ...nativeToken(fromNetwork), balance: '0' });
    return list;
  }, [portfolio, fromId, fromNetwork]);
  const fromKey = fromId ? tokenKey({ networkId: fromId, address: fromAddr }) : '';
  const fromHeld = held.find((b) => tokenKey(b) === fromKey);
  const fromToken: Token | undefined = fromHeld ?? (fromNetwork ? nativeToken(fromNetwork) : undefined);
  const fromBalance = portfolio?.balances.find((b) => tokenKey(b) === fromKey)?.balance;

  const toToken: Token | undefined = useMemo(() => {
    if (!toNetwork || !fromToken) return undefined;
    if (toChoice && toChoice.networkId === toNetwork.id) return toChoice;
    const tokens = destTokens.filter((t) => t.networkId === toNetwork.id);
    // Deep links (e.g. "Get pUSD" from prediction markets) can preselect the destination token.
    const wanted = tokens.find((t) => t.address.toLowerCase() === wantedTo);
    if (wanted && tokenKey(wanted) !== tokenKey(fromToken)) return wanted;
    if (mode === 'swap') {
      // Native → first listed token (usually USDC); anything else → native.
      return fromToken.address === 'native' ? tokens.find((t) => t.address !== 'native') : nativeToken(toNetwork);
    }
    const sym = fromToken.symbol.toUpperCase();
    return tokens.find((t) => t.symbol.toUpperCase() === sym) ?? nativeToken(toNetwork);
  }, [toNetwork, fromToken, toChoice, destTokens, mode, wantedTo]);
  const toHeld = toToken && portfolio?.balances.find((b) => tokenKey(b) === tokenKey(toToken));

  const needsDest = !!(account && toNetwork && mode === 'bridge' && !addressOn(account, toNetwork));
  const destError =
    needsDest && toNetwork && destAddress.trim() && !isValidAddress(toNetwork.type, destAddress.trim())
      ? `Enter a valid ${toNetwork.type === 'evm' ? '0x' : 'Solana'} address for ${toNetwork.name}.`
      : undefined;
  const amountProblem = fromToken ? amountError(amount, fromToken, fromBalance) : undefined;
  const slippageBps = state.settings.slippageBps;

  // Serialized so the debounce effect re-runs only when an input actually changes.
  const paramsKey = useMemo(() => {
    if (!account || !fromId || !toNetworkId || !fromToken || !toToken || amountProblem || destError) return '';
    if (needsDest && !destAddress.trim()) return '';
    try {
      if (parseUnits(amount, fromToken.decimals) <= 0n) return '';
    } catch {
      return '';
    }
    return JSON.stringify({
      accountId: account.id,
      fromNetworkId: fromId,
      toNetworkId,
      fromToken,
      toToken,
      amount,
      slippageBps,
      toAddress: needsDest ? destAddress.trim() : undefined,
    });
  }, [account, fromId, toNetworkId, fromToken, toToken, amount, amountProblem, destError, needsDest, destAddress, slippageBps]);

  useEffect(() => {
    setQuote(undefined);
    setQuoteError(undefined);
    if (!paramsKey) {
      setQuoting(false);
      return;
    }
    let stale = false;
    setQuoting(true);
    const t = setTimeout(() => {
      api
        .getQuote(JSON.parse(paramsKey))
        .then((q) => !stale && setQuote({ q, at: Date.now() }))
        .catch((e: Error) => !stale && setQuoteError(e.message))
        .finally(() => !stale && setQuoting(false));
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [paramsKey, nonce]);

  useEffect(() => {
    if (!quote) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [quote]);

  if (!account) return null;
  if (result) return <SwapResult record={result.record} quote={result.quote} networks={activeNetworks} />;

  const expired = !!quote && now - quote.at > QUOTE_TTL_MS;
  const isBridge = mode === 'bridge';
  const verb = isBridge ? 'Bridge' : 'Swap';

  const switchMode = (m: Mode) => {
    setMode(m);
    setToChoice(undefined);
    setError(undefined);
  };

  const max = async () => {
    if (!fromNetwork || !fromToken) return;
    setBusy('max');
    setError(undefined);
    try {
      setAmount(await api.maxSendable(account.id, fromNetwork.id, fromToken, 'swap'));
    } catch (e) {
      setError(`Couldn't work out the maximum: ${(e as Error).message}`);
    } finally {
      setBusy(undefined);
    }
  };

  const execute = async () => {
    if (!quote || expired) return;
    setBusy('execute');
    setError(undefined);
    try {
      const record = await api.executeQuote(account.id, quote.q);
      setResult({ record, quote: quote.q });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const setSlippage = async (bps: number) => {
    setSheet(undefined);
    try {
      await api.updateSettings({ slippageBps: bps });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const progress = quote?.q.approval
    ? `Approving and ${isBridge ? 'bridging' : 'swapping'}…`
    : isBridge
      ? 'Bridging…'
      : 'Swapping…';
  const q = quote?.q;

  return (
    <Screen>
      <TopBar title={verb} />
      <div className="screen-body stack">
        <div className="segmented" role="tablist">
          {(['swap', 'bridge'] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              className={mode === m ? 'active' : ''}
              onClick={() => switchMode(m)}
            >
              {m === 'swap' ? 'Swap' : 'Bridge'}
            </button>
          ))}
        </div>

        {!sourceNetworks.length ? (
          <div className="notice">
            Swaps and bridges need a mainnet network where this account has an address. Testnets and custom networks aren't
            supported by LI.FI or Jupiter. Turn on a mainnet network in Settings → Networks.
          </div>
        ) : (
          <>
            {unsupported && (
              <div className="notice info">
                {unsupported.name} isn't supported for swaps or bridges
                {unsupported.testnet ? ' (testnets have no aggregator liquidity)' : ''}. Pick another network below.
              </div>
            )}

            <NetworkRow
              label={isBridge ? 'From' : 'Network'}
              network={fromNetwork}
              disabled={!!busy}
              onClick={() => setSheet('fromNetwork')}
            />
            <AmountInput
              label="You pay"
              token={fromToken}
              network={fromNetwork}
              value={amount}
              onChange={setAmount}
              onPickToken={() => setSheet('fromToken')}
              balance={fromBalance}
              usd={q?.fromAmountUsd ?? amountUsd(amount, fromHeld?.priceUsd)}
              onMax={max}
              maxLoading={busy === 'max'}
              invalid={!!amountProblem}
            />
            {amountProblem && <div className="small neg">{amountProblem}</div>}

            {isBridge && <NetworkRow label="To" network={toNetwork} disabled={!!busy} onClick={() => setSheet('toNetwork')} />}
            <AmountInput
              label="You receive"
              token={toToken}
              network={toNetwork}
              value={q && toToken ? formatAmount(q.toAmount, toToken.decimals) : ''}
              readOnly
              onPickToken={() => setSheet('toToken')}
              balance={toHeld?.balance}
              usd={q?.toAmountUsd}
            />

            {needsDest && toNetwork && (
              <Field
                label={`Destination address on ${toNetwork.name}`}
                htmlFor="dest-address"
                error={destError}
                hint={`This account has no ${toNetwork.type === 'evm' ? 'EVM' : 'Solana'} address. Enter the address that should receive the funds.`}
              >
                <input
                  id="dest-address"
                  className={`input mono ${destError ? 'invalid' : ''}`}
                  spellCheck={false}
                  placeholder={toNetwork.type === 'evm' ? '0x…' : 'Solana address'}
                  value={destAddress}
                  onChange={(e) => setDestAddress(e.target.value)}
                />
              </Field>
            )}

            <div className="row small">
              <span className="muted">Max slippage</span>
              <div className="spacer" />
              <button className="link-btn" onClick={() => setSheet('slippage')} disabled={!!busy}>
                {slippageBps / 100}%
              </button>
            </div>

            {quoting && (
              <div className="row muted small" role="status">
                <Spinner size={14} /> Finding the best route…
              </div>
            )}
            {quoteError && <div className="notice error">{quoteError}</div>}
            {q && toToken && (
              <div className="panel" data-testid="quote">
                <div className="kv">
                  <span>Minimum received</span>
                  <span className="num">
                    {formatAmount(q.toAmountMin, toToken.decimals)} {toToken.symbol}
                  </span>
                </div>
                {q.tool && (
                  <div className="kv">
                    <span>Route</span>
                    <span>{q.tool}</span>
                  </div>
                )}
                {isBridge && q.durationSec !== undefined && (
                  <div className="kv">
                    <span>Estimated time</span>
                    <span>{formatDuration(q.durationSec)}</span>
                  </div>
                )}
                {q.gasUsd !== undefined && (
                  <div className="kv">
                    <span>Network fee</span>
                    <span className="num">{formatUsd(q.gasUsd)}</span>
                  </div>
                )}
                {!!q.feeUsd && (
                  <div className="kv">
                    <span>Provider fee</span>
                    <span className="num">{formatUsd(q.feeUsd)}</span>
                  </div>
                )}
                {q.priceImpactPct !== undefined && (
                  <div className="kv">
                    <span>Price impact</span>
                    <span className={`num ${q.priceImpactPct > 3 ? 'neg' : ''}`}>{q.priceImpactPct.toFixed(2)}%</span>
                  </div>
                )}
              </div>
            )}
            {q && q.priceImpactPct !== undefined && q.priceImpactPct > 3 && (
              <div className="notice">
                High price impact. You'll get noticeably less than the market rate. Try a smaller amount.
              </div>
            )}
            {expired && <div className="notice info">This quote has expired. Refresh it to get the latest price.</div>}
            <ErrorNote error={error} />
          </>
        )}
      </div>
      <div className="screen-footer">
        {expired ? (
          <Button variant="secondary" icon="refresh" onClick={() => setNonce((n) => n + 1)}>
            Refresh quote
          </Button>
        ) : (
          <Button onClick={execute} disabled={!q || quoting} loading={busy === 'execute'} data-testid="execute-quote">
            {busy === 'execute' ? progress : verb}
          </Button>
        )}
      </div>

      {sheet === 'fromNetwork' && (
        <NetworkPicker
          title="From network"
          networks={sourceNetworks}
          selected={fromId}
          onSelect={(id) => {
            setSheet(undefined);
            if (id === fromId) return;
            setFromId(id);
            setFromAddr('native');
            setAmount('');
          }}
          onClose={() => setSheet(undefined)}
        />
      )}
      {sheet === 'toNetwork' && (
        <NetworkPicker
          title="To network"
          networks={destNetworks.filter((n) => n.id !== fromId)}
          selected={toNetworkId}
          onSelect={(id) => {
            setSheet(undefined);
            setToId(id);
            setToChoice(undefined);
          }}
          onClose={() => setSheet(undefined)}
        />
      )}
      {sheet === 'fromToken' && fromNetwork && (
        <TokenPicker
          networkId={fromNetwork.id}
          network={fromNetwork}
          balances={held}
          heldOnly
          onSelect={(t) => {
            setSheet(undefined);
            setFromAddr(t.address);
            setAmount('');
          }}
          onClose={() => setSheet(undefined)}
        />
      )}
      {sheet === 'toToken' && toNetwork && (
        <TokenPicker
          networkId={toNetwork.id}
          network={toNetwork}
          balances={portfolio?.balances}
          onSelect={(t) => {
            setSheet(undefined);
            setToChoice(t);
          }}
          onClose={() => setSheet(undefined)}
        />
      )}
      {sheet === 'slippage' && (
        <Sheet title="Max slippage" onClose={() => setSheet(undefined)}>
          <p className="muted small" style={{ marginTop: 0 }}>
            If the price moves more than this before your transaction lands, it is cancelled instead of filling at a worse rate.
          </p>
          <div className="segmented">
            {SLIPPAGE_PRESETS.map((bps) => (
              <button key={bps} className={slippageBps === bps ? 'active' : ''} onClick={() => setSlippage(bps)}>
                {bps / 100}%
              </button>
            ))}
          </div>
        </Sheet>
      )}
    </Screen>
  );
}

function NetworkRow({
  label,
  network,
  onClick,
  disabled,
}: {
  label: string;
  network?: Network;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="row">
      <span className="field-label" style={{ minWidth: 52 }}>
        {label}
      </span>
      <button className="chip" onClick={onClick} disabled={disabled}>
        <NetworkDot network={network} />
        {network?.name ?? 'Select network'}
        <Icon name="chevronDown" size={14} />
      </button>
    </div>
  );
}

function formatDuration(sec: number): string {
  if (sec < 60) return `~${Math.max(1, Math.round(sec))} s`;
  if (sec < 3600) return `~${Math.round(sec / 60)} min`;
  return `~${(sec / 3600).toFixed(1)} h`;
}

function SwapResult({ record, quote, networks }: { record: TxRecord; quote: SwapQuote; networks: Network[] }) {
  const isBridge = record.kind === 'bridge';
  const from = networks.find((n) => n.id === record.networkId);
  const to = networks.find((n) => n.id === record.bridge?.toNetworkId);
  const tx = useTxStatus(record.networkId, record.hash);
  const bridge = useBridgeStatus(
    record.hash,
    record.networkId,
    record.bridge?.toNetworkId,
    isBridge && tx.status === 'confirmed',
    record.bridge?.tool,
  );
  const bridgeState = bridge.status?.status;
  const receiving = bridge.status?.receivingTxHash;

  let status = tx.status;
  let title =
    tx.status === 'pending' ? (isBridge ? 'Bridging…' : 'Swapping…') : tx.status === 'failed' ? 'Transaction failed' : 'Swapped';
  if (isBridge && tx.status === 'confirmed') {
    if (bridgeState === 'DONE') title = 'Bridged';
    else if (bridgeState === 'FAILED' || bridgeState === 'INVALID') {
      status = 'failed';
      title = 'Bridge failed';
    } else {
      status = 'pending';
      title = `Bridging to ${to?.name ?? 'destination'}…`;
    }
  }

  return (
    <Screen>
      <TopBar title={isBridge ? 'Bridge' : 'Swap'} noBack />
      <div className="screen-body stack">
        <TxHero status={status} title={title}>
          <span className="ink2">{record.title}</span>
          {isBridge && status === 'pending' && (
            <span className="muted small">
              {quote.durationSec ? `Bridges like this usually take ${formatDuration(quote.durationSec)}. ` : ''}
              You can close this screen. Progress shows in Activity.
            </span>
          )}
        </TxHero>
        {isBridge && (
          <div className="panel">
            <div className="kv">
              <span>Source transaction</span>
              <span>{tx.status === 'pending' ? 'Pending' : tx.status === 'confirmed' ? 'Confirmed' : 'Failed'}</span>
            </div>
            <div className="kv">
              <span>Bridge status</span>
              <span>{tx.status === 'confirmed' ? bridgeStatusLabel(bridgeState) : '—'}</span>
            </div>
            {receiving && to && (
              <div className="kv">
                <span>Receiving tx</span>
                <button className="link-btn" onClick={() => openTab(explorerTxUrl(to, receiving))}>
                  {shortAddress(receiving, 6)}
                </button>
              </div>
            )}
            {bridge.error && <div className="small muted">Couldn't check bridge status: {bridge.error}</div>}
          </div>
        )}
        {tx.error && <div className="notice">Couldn't check the status: {tx.error}. Look it up on the explorer.</div>}
        <ExplorerButton network={from} hash={record.hash} />
      </div>
      <div className="screen-footer">
        <Button onClick={() => navigate('/', { tab: 'activity' }, true)}>Done</Button>
      </div>
    </Screen>
  );
}
