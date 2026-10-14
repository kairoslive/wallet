import { useEffect, useMemo, useState } from 'react';
import type { HallidayQuote } from '../../core/deposits/halliday';
import { hallidayAsset } from '../../core/deposits/halliday';
import { PUSD_ADDRESS } from '../../core/predictions/verify';
import type { TokenBalance } from '../../core/types';
import { formatAmount, formatUnits, formatUsd, parseUnits, shortAddress } from '../../core/format';
import { sameAddress } from '../../core/address';
import { tokenKey } from '../../core/tokens';
import { api } from '../lib/api';
import { useWallet } from '../lib/store';
import { Button, CopyButton, ErrorNote, Field, Sheet, Spinner, TokenIcon } from './ui';
import { TokenPicker } from './pickers';
import { usePortfolio } from './usePortfolio';
import { openTab } from './tx';

export interface AddFundsPreset {
  networkId: string;
  address: string;
}

type Phase =
  | { kind: 'form' }
  | { kind: 'sending' }
  | { kind: 'converting'; paymentId: string }
  | { kind: 'checkout'; paymentId: string; url: string }
  | { kind: 'done' }
  | { kind: 'failed'; message: string };

const isPusd = (b: { networkId: string; address: string }) => b.networkId === 'polygon' && sameAddress(b.address, PUSD_ADDRESS);

/**
 * Adds pUSD to the prediction-market trading wallet: directly from pUSD, by converting any other
 * held token through Halliday, or by card/bank onramp.
 */
export function AddFundsSheet({
  tradingWallet,
  preset,
  onClose,
  onDone,
}: {
  tradingWallet: string;
  preset?: AddFundsPreset;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [tab, setTab] = useState<'crypto' | 'card'>('crypto');
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });

  // Poll Halliday until the conversion settles.
  useEffect(() => {
    if (phase.kind !== 'converting' && phase.kind !== 'checkout') return;
    const t = setInterval(async () => {
      try {
        const s = await api.depositStatus(phase.paymentId);
        if (s.status === 'COMPLETE') {
          setPhase({ kind: 'done' });
          await onDone();
        } else if (!s.inProgress) {
          setPhase({
            kind: 'failed',
            message: `The conversion ended with status ${s.status.toLowerCase()}. Your funds stay recoverable by your wallet.`,
          });
        }
      } catch {
        // Keep polling.
      }
    }, 5000);
    return () => clearInterval(t);
  }, [phase, onDone]);

  return (
    <Sheet title="Add funds" onClose={onClose}>
      {phase.kind === 'form' && (
        <div className="stack">
          <div className="segmented">
            <button className={tab === 'crypto' ? 'active' : ''} onClick={() => setTab('crypto')}>
              From your wallet
            </button>
            <button className={tab === 'card' ? 'active' : ''} onClick={() => setTab('card')}>
              Card or bank
            </button>
          </div>
          {tab === 'crypto' ? (
            <CryptoDeposit preset={preset} tradingWallet={tradingWallet} onPhase={setPhase} onDirectDone={onDone} />
          ) : (
            <CardDeposit onPhase={setPhase} />
          )}
        </div>
      )}
      {phase.kind === 'sending' && <Progress title="Sending…" body="Confirming your transfer on-chain." />}
      {phase.kind === 'converting' && (
        <Progress
          title="Converting to pUSD…"
          body="Halliday is swapping your deposit into pUSD for your trading wallet. This usually takes under a minute."
        />
      )}
      {phase.kind === 'checkout' && (
        <div className="stack">
          <Progress
            title="Waiting for your payment…"
            body="Finish checkout in the tab that opened. pUSD arrives in your trading wallet once the payment clears."
          />
          <Button variant="secondary" small onClick={() => openTab(phase.url)}>
            Reopen checkout
          </Button>
        </div>
      )}
      {phase.kind === 'done' && (
        <div className="stack">
          <div className="result" data-testid="deposit-done">
            <div style={{ fontWeight: 700 }}>pUSD added</div>
            <div className="small muted">Your trading balance is updated.</div>
          </div>
          <Button onClick={onClose}>Done</Button>
        </div>
      )}
      {phase.kind === 'failed' && (
        <div className="stack">
          <ErrorNote error={phase.message} />
          <Button variant="secondary" onClick={() => setPhase({ kind: 'form' })}>
            Try again
          </Button>
        </div>
      )}
    </Sheet>
  );
}

function Progress({ title, body }: { title: string; body: string }) {
  return (
    <div
      className="stack"
      style={{ alignItems: 'center', textAlign: 'center', padding: '16px 0' }}
      data-testid="deposit-progress"
    >
      <Spinner size={28} />
      <div style={{ fontWeight: 700 }}>{title}</div>
      <div className="small muted">{body}</div>
    </div>
  );
}

function CryptoDeposit({
  preset,
  tradingWallet,
  onPhase,
  onDirectDone,
}: {
  preset?: AddFundsPreset;
  tradingWallet: string;
  onPhase: (p: Phase) => void;
  onDirectDone: () => Promise<void>;
}) {
  const { account, networks } = useWallet();
  const { portfolio } = usePortfolio(account?.id);
  const [inputs, setInputs] = useState<Set<string>>();
  const [picked, setPicked] = useState<string | undefined>(preset ? tokenKey(preset) : undefined);
  const [picking, setPicking] = useState(false);
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<HallidayQuote>();
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    api
      .depositInputs()
      .then((list) => setInputs(new Set(list.map((a) => (a.includes(':0x') ? a.toLowerCase() : a)))))
      .catch((e: Error) => setError(`Couldn't load deposit options: ${e.message}`));
  }, []);

  // Held tokens that can become pUSD: pUSD itself, or anything Halliday routes into pUSD.
  const options = useMemo(() => {
    if (!portfolio || !inputs) return [];
    return portfolio.balances
      .filter((b) => b.balance !== '0')
      .filter((b) => {
        if (isPusd(b)) return true;
        const n = networks.find((x) => x.id === b.networkId);
        const id = n && hallidayAsset(n, b);
        return !!id && inputs.has(id.includes(':0x') ? id.toLowerCase() : id);
      })
      .sort((a, b) => Number(isPusd(b)) - Number(isPusd(a)) || (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
  }, [portfolio, inputs, networks]);

  const selected: TokenBalance | undefined = options.find((o) => tokenKey(o) === picked) ?? (picked ? undefined : options[0]);
  const network = networks.find((n) => n.id === selected?.networkId);
  const direct = selected ? isPusd(selected) : false;

  let amountError: string | undefined;
  try {
    if (amount && selected && parseUnits(amount, selected.decimals) > BigInt(selected.balance))
      amountError = `More than your ${selected.symbol} balance`;
  } catch {
    amountError = 'Enter a valid amount';
  }

  // Live quote for conversions.
  useEffect(() => {
    setQuote(undefined);
    if (!selected || direct || !amount || amountError || !(Number(amount) > 0)) return;
    let stale = false;
    setQuoting(true);
    const t = setTimeout(() => {
      api
        .depositQuote({ networkId: selected.networkId, token: selected, amount })
        .then((q) => !stale && (setQuote(q), setError(undefined)))
        .catch((e: Error) => !stale && setError(e.message))
        .finally(() => !stale && setQuoting(false));
    }, 500);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [selected?.networkId, selected?.address, direct, amount, amountError]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!portfolio || !inputs) {
    return error ? <ErrorNote error={error} /> : <Spinner />;
  }
  if (!options.length) {
    return (
      <div className="stack">
        <div className="notice">
          You don't hold any token that can be converted to pUSD yet. Receive crypto first, or pay by card in the other tab.
        </div>
        <div className="kv">
          <span>Trading wallet</span>
          <span className="row" style={{ gap: 0 }}>
            {shortAddress(tradingWallet)}
            <CopyButton text={tradingWallet} label="Copy trading wallet address" />
          </span>
        </div>
        <div className="small muted">Only send pUSD on Polygon directly to this address.</div>
      </div>
    );
  }

  const max = () => {
    if (!selected) return;
    // Leave native coins for gas; tokens can be sent in full.
    if (selected.address === 'native') {
      api.maxSendable(account!.id, selected.networkId, selected).then(setAmount, (e: Error) => setError(e.message));
    } else setAmount(formatUnits(selected.balance, selected.decimals));
  };

  const submit = async () => {
    if (!account || !selected) return;
    setError(undefined);
    onPhase({ kind: 'sending' });
    try {
      const res = await api.depositWithCrypto(account.id, { networkId: selected.networkId, token: selected, amount, quote });
      await api.waitForTx(res.networkId, res.hash);
      if (res.paymentId) onPhase({ kind: 'converting', paymentId: res.paymentId });
      else {
        onPhase({ kind: 'done' });
        await onDirectDone();
      }
    } catch (e) {
      onPhase({ kind: 'failed', message: (e as Error).message });
    }
  };

  return (
    <div className="stack" data-testid="deposit-crypto">
      <Field label="Pay with">
        <button
          className="list-item"
          style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '8px 12px' }}
          onClick={() => setPicking(true)}
        >
          {selected && <TokenIcon token={selected} network={network} size={32} />}
          <div className="main">
            <div className="title">{selected?.symbol}</div>
            <div className="sub">
              {network?.name} · {selected ? formatAmount(selected.balance, selected.decimals) : ''} available
            </div>
          </div>
        </button>
      </Field>
      <Field label={`Amount (${selected?.symbol ?? ''})`} error={amountError} htmlFor="deposit-amount">
        <div className="input-group">
          <input
            id="deposit-amount"
            className="input num"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
          />
          <span className="suffix">
            <button type="button" className="link-btn small" onClick={max}>
              Max
            </button>
          </span>
        </div>
      </Field>
      {direct ? (
        <div className="small muted">pUSD goes straight to your trading wallet. Needs a little POL for gas.</div>
      ) : (
        <div className="panel">
          <div className="kv">
            <span>You'll receive</span>
            <span className="num">{quoting ? '…' : quote ? `≈ ${Number(quote.outputAmount).toFixed(2)} pUSD` : '—'}</span>
          </div>
          <div className="kv">
            <span>Conversion fee</span>
            <span className="num">{quote ? formatUsd(quote.feesUsd) : '—'}</span>
          </div>
          <div className="small muted" style={{ marginTop: 4 }}>
            Converted by Halliday and delivered to your trading wallet. Sending needs a little {network?.nativeCurrency.symbol}{' '}
            for gas.
          </div>
        </div>
      )}
      <ErrorNote error={error} />
      <Button onClick={submit} disabled={!amount || !!amountError || (!direct && !quote)} data-testid="deposit-submit">
        {direct ? 'Deposit pUSD' : `Convert and deposit`}
      </Button>
      {picking && (
        <TokenPicker
          networkId={selected?.networkId ?? 'polygon'}
          balances={options}
          heldOnly
          allNetworks
          networks={networks}
          onSelect={(t) => {
            setPicked(tokenKey(t));
            setAmount('');
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

function CardDeposit({ onPhase }: { onPhase: (p: Phase) => void }) {
  const { account } = useWallet();
  const [usd, setUsd] = useState('50');
  const [quotes, setQuotes] = useState<HallidayQuote[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setQuotes(undefined);
    if (!(Number(usd) > 0)) return;
    let stale = false;
    setLoading(true);
    const t = setTimeout(() => {
      api
        .depositFiatQuotes(usd)
        .then((q) => !stale && (setQuotes(q), setError(undefined)))
        .catch((e: Error) => !stale && setError(e.message))
        .finally(() => !stale && setLoading(false));
    }, 600);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [usd]);

  const choose = async (q: HallidayQuote) => {
    if (!account) return;
    try {
      const { paymentId, fundingUrl } = await api.depositWithCard(account.id, q);
      openTab(fundingUrl);
      onPhase({ kind: 'checkout', paymentId, url: fundingUrl });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // One row per provider: the best quote each offers.
  const best = (quotes ?? []).filter((q, i, all) => all.findIndex((x) => x.onramp === q.onramp) === i);

  return (
    <div className="stack" data-testid="deposit-card">
      <Field label="Amount (USD)" htmlFor="card-amount">
        <input
          id="card-amount"
          className="input num"
          inputMode="decimal"
          value={usd}
          onChange={(e) => setUsd(e.target.value.replace(/[^0-9.]/g, ''))}
        />
      </Field>
      <ErrorNote error={error} />
      {loading && <Spinner />}
      <div className="list">
        {best.map((q) => (
          <button key={q.paymentId} className="list-item" onClick={() => choose(q)}>
            <div className="main">
              <div className="title" style={{ textTransform: 'capitalize' }}>
                {q.onramp}
              </div>
              <div className="sub">
                {(q.onrampMethod ?? '').replace(/_/g, ' ').toLowerCase()} · fees {formatUsd(q.feesUsd)}
              </div>
            </div>
            <div className="end">
              <div className="num" style={{ fontWeight: 650 }}>
                {Number(q.outputAmount).toFixed(2)} pUSD
              </div>
              <div className="sub">you receive</div>
            </div>
          </button>
        ))}
      </div>
      <div className="small muted">
        Checkout opens in a new tab with the provider. First-time purchases may ask for ID verification.
      </div>
    </div>
  );
}
