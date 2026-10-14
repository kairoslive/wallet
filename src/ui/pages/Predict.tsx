import { useCallback, useEffect, useState } from 'react';
import type { ApiRecord, PredictionEvent, TradingStatus } from '../../core/predictions/types';
import type { Category } from '../../core/predictions/client';
import { CATEGORIES } from '../../core/predictions/client';
import { PUSD_ADDRESS } from '../../core/predictions/verify';
import { formatAmount, parseUnits, shortAddress } from '../../core/format';
import { api } from '../lib/api';
import { navigate, useRoute } from '../lib/router';
import { useWallet } from '../lib/store';
import { cacheEvents } from '../lib/predictCache';
import { Button, CopyButton, Empty, ErrorNote, Field, Sheet, Spinner, TopBar } from '../components/ui';
import { Icon } from '../components/Icon';

type Tab = 'markets' | 'positions' | 'orders';

export const pct = (p?: number) => (p === undefined ? '—' : `${Math.round(p * 100)}%`);
export const cents = (p?: number) => (p === undefined ? '—' : `${(p * 100).toFixed(p * 100 < 1 ? 1 : 0)}¢`);

export function compactUsd(v?: number): string {
  if (v === undefined) return '';
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

/** Reads the first present field; order and position records vary by venue. */
export function pick(r: ApiRecord, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = r[k];
    if (v !== undefined && v !== null && v !== '') return String(v);
  }
  return undefined;
}

export function usePredictionStatus(accountId?: string) {
  const [status, setStatus] = useState<TradingStatus>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    if (!accountId) return;
    setError(undefined);
    try {
      setStatus(await api.predictionStatus(accountId));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [accountId]);
  useEffect(() => {
    void load();
  }, [load]);
  return { status, error, reload: load };
}

export function Predict() {
  const { state, account } = useWallet();
  const route = useRoute();
  const tab = (route.query.get('tab') as Tab) || 'markets';
  const { status, error, reload } = usePredictionStatus(account?.evmAddress ? account.id : undefined);

  if (!state.settings.apis.kairosEnabled) {
    return (
      <div className="screen">
        <TopBar title="Predictions" />
        <div className="screen-body">
          <Empty title="Prediction markets are off">
            <button className="link-btn" onClick={() => navigate('/settings/apis')}>
              Turn them on in Settings
            </button>
          </Empty>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <TopBar title="Predictions" />
      <div className="screen-body stack" style={{ gap: 12 }}>
        {account && !account.evmAddress ? (
          <div className="notice">Prediction markets trade on Polygon. Switch to an account with an EVM address to trade.</div>
        ) : (
          <TradingCard status={status} error={error} onChange={reload} />
        )}
        <div className="segmented" role="tablist">
          {(['markets', 'positions', 'orders'] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? 'active' : ''}
              onClick={() => navigate('/predict', { tab: t }, true)}
            >
              {t === 'markets' ? 'Markets' : t === 'positions' ? 'Positions' : 'Orders'}
            </button>
          ))}
        </div>
        {tab === 'markets' && <MarketList />}
        {tab === 'positions' && account?.evmAddress && <Positions accountId={account.id} />}
        {tab === 'orders' && account?.evmAddress && <Orders accountId={account.id} />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ trading wallet status

function TradingCard({ status, error, onChange }: { status?: TradingStatus; error?: string; onChange: () => Promise<void> }) {
  const { account, toast } = useWallet();
  const [busy, setBusy] = useState(false);
  const [setupError, setSetupError] = useState<string>();
  const [deposit, setDeposit] = useState(false);

  if (error) return <div className="notice error">Couldn't reach Kairos: {error}</div>;
  if (!status || !account) {
    return (
      <div className="panel row">
        <Spinner size={14} /> <span className="muted">Checking your trading wallet…</span>
      </div>
    );
  }

  if (status.next === 'setup') {
    return (
      <div className="panel stack" style={{ gap: 10 }} data-testid="prediction-setup">
        <div>
          <div style={{ fontWeight: 700 }}>Set up prediction trading</div>
          <div className="small ink2" style={{ marginTop: 4 }}>
            Creates a trading wallet owned by {shortAddress(status.wallet)} and approves the Polymarket exchange to use it. You'll
            sign twice in this wallet. No gas is needed.
          </div>
        </div>
        <ErrorNote error={setupError} />
        <Button
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setSetupError(undefined);
            try {
              await api.predictionSetup(account.id);
              toast('Trading wallet ready');
              await onChange();
            } catch (e) {
              setSetupError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Setting up (about 30 seconds)…' : 'Set up trading'}
        </Button>
      </div>
    );
  }

  return (
    <div className="panel" data-testid="prediction-balance">
      <div className="row">
        <div style={{ flex: 1 }}>
          <div className="small muted">Trading balance</div>
          <div style={{ fontWeight: 750, fontSize: 22 }} className="num">
            {status.balance ?? '0'} <span className="small muted">pUSD</span>
          </div>
        </div>
        <Button small variant={status.next === 'fund' ? 'primary' : 'secondary'} icon="plus" onClick={() => setDeposit(true)}>
          Add funds
        </Button>
      </div>
      {status.next === 'fund' && (
        <div className="small ink2" style={{ marginTop: 6 }}>
          Add pUSD to start trading.
        </div>
      )}
      {deposit && (
        <DepositSheet
          tradingWallet={status.tradingWallet}
          onClose={() => setDeposit(false)}
          onDone={async () => {
            setDeposit(false);
            await onChange();
          }}
        />
      )}
    </div>
  );
}

const PUSD = { networkId: 'polygon', address: PUSD_ADDRESS, symbol: 'pUSD', name: 'Polymarket USD', decimals: 6 };

function DepositSheet({
  tradingWallet,
  onClose,
  onDone,
}: {
  tradingWallet: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { account, toast } = useWallet();
  const [held, setHeld] = useState<string>();
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!account) return;
    api
      .predictionWalletPusd(account.id)
      .then(setHeld)
      .catch((e: Error) => setError(e.message));
  }, [account]);

  let amountError: string | undefined;
  try {
    if (amount && held !== undefined && parseUnits(amount, 6) > BigInt(held)) amountError = 'More than your pUSD balance';
  } catch {
    amountError = 'Enter a valid amount';
  }

  return (
    <Sheet title="Add funds" onClose={onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!account) return;
          setBusy(true);
          setError(undefined);
          try {
            const record = await api.send({
              accountId: account.id,
              networkId: 'polygon',
              token: PUSD,
              to: tradingWallet,
              amount,
            });
            toast('Deposit sent');
            await api.waitForTx(record.networkId, record.hash);
            await onDone();
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <div className="small ink2">
          Move pUSD from your Polygon account to your trading wallet. The transfer needs a little POL for gas.
        </div>
        <div className="kv">
          <span>Your pUSD on Polygon</span>
          <span className="num">{held === undefined ? '…' : formatAmount(held, 6)}</span>
        </div>
        <div className="kv">
          <span>Trading wallet</span>
          <span className="row" style={{ gap: 0 }}>
            {shortAddress(tradingWallet)}
            <CopyButton text={tradingWallet} label="Copy trading wallet address" />
          </span>
        </div>
        <Field label="Amount (pUSD)" error={amountError} htmlFor="deposit-amount">
          <input
            id="deposit-amount"
            className="input num"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
          />
        </Field>
        <ErrorNote error={error} />
        <Button type="submit" loading={busy} disabled={!amount || !!amountError || held === undefined}>
          Deposit
        </Button>
        <button
          type="button"
          className="link-btn"
          style={{ alignSelf: 'center' }}
          onClick={() => navigate('/swap', { network: 'polygon', to: PUSD_ADDRESS })}
        >
          Get pUSD by swapping or bridging
        </button>
      </form>
    </Sheet>
  );
}

// ------------------------------------------------------------------ markets

function MarketList() {
  const [category, setCategory] = useState<Category>('all');
  const [query, setQuery] = useState('');
  const [events, setEvents] = useState<PredictionEvent[]>();
  const [error, setError] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let stale = false;
    setEvents(undefined);
    setError(undefined);
    setDone(false);
    const t = setTimeout(
      () =>
        api
          .predictionMarkets({ category, search: query, limit: 30 })
          .then((list) => {
            if (stale) return;
            cacheEvents(list);
            setEvents(list);
            setDone(list.length < 30);
          })
          .catch((e: Error) => !stale && setError(e.message)),
      query ? 350 : 0,
    );
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [category, query]);

  const more = async () => {
    setLoadingMore(true);
    try {
      const next = await api.predictionMarkets({ category, search: query, limit: 30, offset: events?.length ?? 0 });
      cacheEvents(next);
      setEvents((cur) => [...(cur ?? []), ...next.filter((n) => !cur?.some((c) => c.id === n.id))]);
      setDone(next.length < 30);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="input-group">
        <input
          className="input"
          placeholder="Search markets"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search markets"
        />
        <span className="suffix muted">
          <Icon name="search" size={16} />
        </span>
      </div>
      <div className="chip-row" role="tablist" aria-label="Categories">
        {CATEGORIES.map((c) => (
          <button key={c} className={`chip ${category === c ? 'active' : ''}`} onClick={() => setCategory(c)}>
            {c === 'all' ? 'Trending' : c[0].toUpperCase() + c.slice(1)}
          </button>
        ))}
      </div>
      <ErrorNote error={error} />
      {!events && !error && (
        <div className="center" style={{ padding: 24 }}>
          <Spinner />
        </div>
      )}
      {events && !events.length && <Empty title="No markets found">Try another search or category.</Empty>}
      <div className="list" data-testid="market-list">
        {events?.map((e) => (
          <EventRow key={e.id} event={e} />
        ))}
      </div>
      {events && events.length > 0 && !done && (
        <Button variant="secondary" small loading={loadingMore} onClick={more}>
          Load more
        </Button>
      )}
    </div>
  );
}

function EventRow({ event }: { event: PredictionEvent }) {
  const single = event.outcomes.length === 1;
  const lead = [...event.outcomes].sort((a, b) => (b.price ?? 0) - (a.price ?? 0))[0];
  return (
    <button
      className="list-item"
      onClick={() =>
        single ? navigate('/predict/market', { id: event.outcomes[0].marketId }) : navigate('/predict/event', { id: event.id })
      }
    >
      {event.image ? <img className="market-thumb" src={event.image} alt="" /> : <span className="market-thumb" />}
      <div className="main">
        <div className="title" style={{ fontSize: 13, lineHeight: 1.3 }}>
          {event.title}
        </div>
        <div className="sub">
          {single ? 'Yes / No' : `${event.outcomes.length} outcomes · ${lead.label ?? lead.title}`}
          {event.volume24h ? ` · ${compactUsd(event.volume24h)} 24h` : ''}
        </div>
      </div>
      <div className="end">
        <div className="prob">{pct(lead.price)}</div>
        <div className="sub">{single ? 'Yes' : 'leading'}</div>
      </div>
    </button>
  );
}

// ------------------------------------------------------------------ positions & orders

function Positions({ accountId }: { accountId: string }) {
  const [data, setData] = useState<{ open: ApiRecord[]; resolved: ApiRecord[] }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api
      .predictionPositions(accountId)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [accountId]);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Spinner />;
  const rows = [...data.open, ...data.resolved];
  if (!rows.length) return <Empty title="No positions yet">Shares you buy show up here.</Empty>;
  return (
    <div className="list" data-testid="position-list">
      {rows.map((p, i) => {
        const size = pick(p, 'size', 'shares', 'quantity', 'balance');
        const avg = pick(p, 'avg_price', 'average_price', 'avgPrice');
        const cur = pick(p, 'current_price', 'cur_price', 'curPrice', 'mark', 'price');
        const value = pick(p, 'current_value', 'currentValue', 'value');
        const pnl = pick(p, 'unrealized_pnl', 'cash_pnl', 'cashPnl', 'pnl');
        return (
          <div key={i} className="list-item">
            <div className="main">
              <div className="title" style={{ fontSize: 13 }}>
                {pick(p, 'title', 'market_title', 'question', 'name', 'market', 'condition_id') ?? 'Position'}
              </div>
              <div className="sub">
                {pick(p, 'outcome') ?? ''} {size ? `· ${Number(size).toLocaleString()} shares` : ''}
                {avg ? ` · avg ${cents(Number(avg))}` : ''}
                {cur ? ` · now ${cents(Number(cur))}` : ''}
              </div>
            </div>
            <div className="end">
              {value && (
                <div className="num" style={{ fontWeight: 650 }}>
                  ${Number(value).toFixed(2)}
                </div>
              )}
              {pnl && (
                <div className={`sub num ${Number(pnl) >= 0 ? 'pos' : 'neg'}`}>
                  {Number(pnl) >= 0 ? '+' : '−'}${Math.abs(Number(pnl)).toFixed(2)}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Orders({ accountId }: { accountId: string }) {
  const { toast } = useWallet();
  const [open, setOpen] = useState(true);
  const [orders, setOrders] = useState<ApiRecord[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  const load = useCallback(() => {
    setOrders(undefined);
    api
      .predictionOrders(accountId, open)
      .then(setOrders)
      .catch((e: Error) => setError(e.message));
  }, [accountId, open]);
  useEffect(load, [load]);

  const cancel = async (ids: string[] | 'all') => {
    setBusy(ids === 'all' ? 'all' : ids[0]);
    try {
      await api.predictionCancel(accountId, ids);
      toast(ids === 'all' ? 'Open orders cancelled' : 'Order cancelled');
      load();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row">
        <div className="chip-row" style={{ flex: 1, padding: 0 }}>
          <button className={`chip ${open ? 'active' : ''}`} onClick={() => setOpen(true)}>
            Open
          </button>
          <button className={`chip ${!open ? 'active' : ''}`} onClick={() => setOpen(false)}>
            All
          </button>
        </div>
        {open && !!orders?.length && (
          <Button small variant="secondary" loading={busy === 'all'} onClick={() => cancel('all')}>
            Cancel all
          </Button>
        )}
      </div>
      <ErrorNote error={error} />
      {!orders && !error && <Spinner />}
      {orders && !orders.length && (
        <Empty title={open ? 'No open orders' : 'No orders yet'}>Orders you place show up here.</Empty>
      )}
      <div className="list" data-testid="order-list">
        {orders?.map((o) => {
          const id = pick(o, 'id', 'order_id', 'orderId')!;
          const status = (pick(o, 'status') ?? '').toLowerCase();
          const isOpen = ['open', 'live', 'pending', 'partially_filled', 'resting', 'new'].includes(status);
          return (
            <div key={id} className="list-item">
              <div className="main">
                <div className="title" style={{ fontSize: 13 }}>
                  {(pick(o, 'side') ?? '').toUpperCase()} {pick(o, 'outcome') ?? ''} ·{' '}
                  {pick(o, 'price') ? cents(Number(pick(o, 'price'))) : ''}
                </div>
                <div className="sub row" style={{ gap: 6 }}>
                  <span className="ellipsis">{pick(o, 'title', 'market_title', 'market', 'condition_id') ?? id}</span>
                </div>
                <div className="sub">
                  {pick(o, 'size', 'quantity', 'original_size') ?? '?'} shares
                  {pick(o, 'filled', 'filled_size', 'size_matched')
                    ? ` · ${pick(o, 'filled', 'filled_size', 'size_matched')} filled`
                    : ''}
                  {status ? ` · ${status.replace(/_/g, ' ')}` : ''}
                </div>
              </div>
              {isOpen && (
                <Button small variant="secondary" loading={busy === id} disabled={!!busy} onClick={() => cancel([id])}>
                  Cancel
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
