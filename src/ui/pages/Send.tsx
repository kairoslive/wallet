import { useEffect, useMemo, useState } from 'react';
import type { SendPreview } from '../../core/wallet/service';
import type { Account, Network, Token, TxRecord } from '../../core/types';
import { formatAmount, formatUsd, shortAddress } from '../../core/format';
import { isValidAddress, isValidEvmAddress, isValidSolanaAddress } from '../../core/address';
import { nativeToken, tokenKey } from '../../core/tokens';
import { api } from '../lib/api';
import { navigate, useRoute } from '../lib/router';
import { useWallet } from '../lib/store';
import { Button, ErrorNote, Field, NetworkDot, Screen, TokenIcon, TopBar } from '../components/ui';
import { NetworkPicker, TokenPicker } from '../components/pickers';
import { AmountInput, amountError, amountUsd } from '../components/AmountInput';
import { ExplorerButton, TxHero, useTxStatus } from '../components/tx';
import { usePortfolio } from '../components/usePortfolio';
import { Icon } from '../components/Icon';
import { RecipientSuggestions } from '../components/RecipientSuggestions';

type Step = { kind: 'form' } | { kind: 'review'; preview: SendPreview } | { kind: 'done'; record: TxRecord };

function addressOn(account: Account, network: Network): string | undefined {
  return network.type === 'evm' ? account.evmAddress : account.solanaAddress;
}

export function Send() {
  const { state, account, activeNetworks } = useWallet();
  const route = useRoute();
  const { portfolio, loading: portfolioLoading } = usePortfolio(account?.id);
  const networks = useMemo(() => activeNetworks.filter((n) => account && addressOn(account, n)), [activeNetworks, account]);

  const [networkId, setNetworkId] = useState<string | undefined>(() => {
    const wanted = route.query.get('network') ?? state.settings.selectedNetworkId;
    return networks.some((n) => n.id === wanted) ? wanted : undefined;
  });
  const [tokenAddr, setTokenAddr] = useState(route.query.get('token') ?? 'native');
  const [localTokens, setLocalTokens] = useState<Token[]>([]);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [sheet, setSheet] = useState<'network' | 'token'>();
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const [busy, setBusy] = useState<'max' | 'review' | 'send'>();
  const [error, setError] = useState<string>();

  // Coming from "All networks": default to the network holding the most value.
  useEffect(() => {
    if (networkId || (!portfolio && portfolioLoading)) return;
    const ids = new Set(networks.map((n) => n.id));
    const richest = portfolio?.balances.find((b) => ids.has(b.networkId) && b.balance !== '0');
    setNetworkId(richest?.networkId ?? networks[0]?.id);
  }, [networkId, portfolio, portfolioLoading, networks]);

  useEffect(() => {
    if (!networkId) return;
    let stale = false;
    api.getTokens(networkId).then((t) => !stale && setLocalTokens(t)).catch(() => {});
    return () => {
      stale = true;
    };
  }, [networkId]);

  const network = networks.find((n) => n.id === networkId);
  const held = useMemo(() => {
    const list = (portfolio?.balances ?? []).filter((b) => b.networkId === networkId && (b.balance !== '0' || b.address === 'native'));
    if (network && !list.some((b) => b.address === 'native')) list.unshift({ ...nativeToken(network), balance: '0' });
    return list;
  }, [portfolio, networkId, network]);
  const key = network ? tokenKey({ networkId: network.id, address: tokenAddr }) : '';
  const heldToken = held.find((b) => tokenKey(b) === key);
  // Only trust balances the portfolio actually returned (not the native placeholder above).
  const balance = portfolio?.balances.find((b) => tokenKey(b) === key)?.balance;
  const token: Token | undefined =
    heldToken ?? localTokens.find((t) => tokenKey(t) === key) ?? (network && tokenAddr === 'native' ? nativeToken(network) : undefined);

  const toError = network && to.trim() ? recipientError(network, to.trim()) : undefined;
  const amountProblem = token ? amountError(amount, token, balance) : undefined;
  const canReview = !!(account && network && token && to.trim() && amount && !toError && !amountProblem);

  if (!account) return null;

  if (step.kind === 'done') return <SendResult record={step.record} network={network} />;

  const params = network && token ? { accountId: account.id, networkId: network.id, token, to: to.trim(), amount } : undefined;

  const review = async () => {
    if (!params) return;
    setBusy('review');
    setError(undefined);
    try {
      setStep({ kind: 'review', preview: await api.previewSend(params) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const confirm = async () => {
    if (!params) return;
    setBusy('send');
    setError(undefined);
    try {
      setStep({ kind: 'done', record: await api.send(params) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const max = async () => {
    if (!network || !token) return;
    setBusy('max');
    setError(undefined);
    try {
      setAmount(await api.maxSendable(account.id, network.id, token));
    } catch (e) {
      setError(`Couldn't work out the maximum: ${(e as Error).message}`);
    } finally {
      setBusy(undefined);
    }
  };

  if (step.kind === 'review' && network && token) {
    const p = step.preview;
    return (
      <Screen>
        <TopBar title="Review" onBack={() => setStep({ kind: 'form' })} />
        <div className="screen-body stack">
          <div className="result" style={{ paddingTop: 12 }}>
            <TokenIcon token={token} network={network} size={48} />
            <h2 className="num">
              {formatAmount(p.amountBase, token.decimals, token.decimals)} {token.symbol}
            </h2>
            <span className="muted num">{formatUsd(amountUsd(amount, heldToken?.priceUsd))}</span>
          </div>
          <div className="panel">
            <div className="kv">
              <span>To</span>
              <span className="mono" title={to.trim()}>
                {to.trim()}
              </span>
            </div>
            <div className="kv">
              <span>Network</span>
              <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                <NetworkDot network={network} />
                {network.name}
              </span>
            </div>
            <div className="kv">
              <span>Network fee</span>
              <span className="num">
                {formatAmount(p.fee, p.feeDecimals, 9)} {p.feeSymbol}
                {p.feeUsd !== undefined && <span className="muted"> · {formatUsd(p.feeUsd)}</span>}
              </span>
            </div>
            {p.extra && (
              <div className="kv">
                <span>{p.extra.label}</span>
                <span className="num">
                  {formatAmount(p.extra.amount, p.feeDecimals)} {p.feeSymbol}
                </span>
              </div>
            )}
          </div>
          {p.warnings.map((w) => (
            <div key={w} className="notice">
              {w}
            </div>
          ))}
          <ErrorNote error={error} />
        </div>
        <div className="screen-footer">
          <Button variant="secondary" onClick={() => setStep({ kind: 'form' })} disabled={busy === 'send'}>
            Back
          </Button>
          <Button onClick={confirm} loading={busy === 'send'} data-testid="confirm-send">
            Confirm
          </Button>
        </div>
      </Screen>
    );
  }

  return (
    <Screen>
      <TopBar title="Send" />
      <div className="screen-body stack">
        {!networks.length ? (
          <div className="notice">This account has no address on any active network. Turn on a network in Settings → Networks.</div>
        ) : (
          <>
            <Field label="Network">
              <button className="chip" style={{ alignSelf: 'flex-start' }} onClick={() => setSheet('network')} disabled={!!busy}>
                <NetworkDot network={network} />
                {network?.name ?? 'Select network'}
                <Icon name="chevronDown" size={14} />
              </button>
            </Field>
            <Field label="To" htmlFor="send-to" error={toError}>
              <textarea
                id="send-to"
                className="textarea mono"
                rows={2}
                spellCheck={false}
                placeholder={network?.type === 'solana' ? 'Solana address' : '0x… address'}
                value={to}
                onChange={(e) => setTo(e.target.value)}
                style={toError ? { borderColor: 'var(--neg)' } : undefined}
              />
            </Field>
            {network && !to.trim() && (
              <RecipientSuggestions chainType={network.type} exclude={addressOn(account, network)} onPick={setTo} />
            )}
            <AmountInput
              label="Amount"
              token={token}
              network={network}
              value={amount}
              onChange={setAmount}
              onPickToken={() => setSheet('token')}
              balance={balance}
              usd={amountUsd(amount, heldToken?.priceUsd)}
              onMax={max}
              maxLoading={busy === 'max'}
              invalid={!!amountProblem}
            />
            {amountProblem && <div className="small neg">{amountProblem}</div>}
            <ErrorNote error={error} />
          </>
        )}
      </div>
      <div className="screen-footer">
        <Button onClick={review} disabled={!canReview} loading={busy === 'review'} data-testid="review-send">
          Review
        </Button>
      </div>

      {sheet === 'network' && (
        <NetworkPicker
          networks={networks}
          selected={networkId}
          onSelect={(id) => {
            setSheet(undefined);
            if (id === networkId) return;
            setNetworkId(id);
            setTokenAddr('native');
            setAmount('');
            setError(undefined);
          }}
          onClose={() => setSheet(undefined)}
        />
      )}
      {sheet === 'token' && network && (
        <TokenPicker
          networkId={network.id}
          network={network}
          balances={held}
          heldOnly
          onSelect={(t) => {
            setSheet(undefined);
            setTokenAddr(t.address);
            setAmount('');
          }}
          onClose={() => setSheet(undefined)}
        />
      )}
    </Screen>
  );
}

function recipientError(network: Network, to: string): string | undefined {
  if (isValidAddress(network.type, to)) return undefined;
  if (network.type === 'solana' && isValidEvmAddress(to)) return `That's an EVM address. Enter a Solana address, or switch to an EVM network.`;
  if (network.type === 'evm' && isValidSolanaAddress(to)) return `That's a Solana address. Enter a 0x address, or switch to Solana.`;
  return network.type === 'evm' ? 'Enter a valid 0x address (42 characters).' : 'Enter a valid Solana address.';
}

function SendResult({ record, network }: { record: TxRecord; network?: Network }) {
  const { status, error } = useTxStatus(record.networkId, record.hash);
  const title = status === 'pending' ? 'Sending…' : status === 'confirmed' ? 'Sent' : 'Transaction failed';
  return (
    <Screen>
      <TopBar title="Send" noBack />
      <div className="screen-body stack">
        <TxHero status={status} title={title}>
          <span className="ink2">{record.title}</span>
          {record.to && <span className="muted small">to {shortAddress(record.to, 6)}</span>}
          {status === 'pending' && <span className="muted small">You can close this screen. It will keep going in the background.</span>}
        </TxHero>
        {error && <div className="notice">Couldn't check the status: {error}. Look it up on the explorer.</div>}
        <ExplorerButton network={network} hash={record.hash} />
      </div>
      <div className="screen-footer">
        <Button onClick={() => navigate('/', { tab: 'activity' }, true)}>Done</Button>
      </div>
    </Screen>
  );
}
