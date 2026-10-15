import { useEffect, useMemo, useState } from 'react';
import type { BookState, OutcomeBook } from '../../core/predictions/orderbook';
import { walkBook } from '../../core/predictions/orderbook';
import type { MarketDetail, OrderResult, PricePoint, TimeInForce } from '../../core/predictions/types';
import { api } from '../lib/api';
import { navigate, useRoute } from '../lib/router';
import { useWallet } from '../lib/store';
import { Button, ErrorNote, Field, Screen, Sheet, Spinner, TopBar } from '../components/ui';
import { PriceChart } from '../components/PriceChart';
import { Icon } from '../components/Icon';
import { OrderbookSheet } from '../components/OrderbookSheet';
import { useOrderbook, type FeedStatus } from '../components/useOrderbook';
import { cents, pct, usePredictionStatus } from './Predict';

const RANGES = [
  { key: '1D', hours: 24, tf: 900 },
  { key: '1W', hours: 24 * 7, tf: 3600 },
  { key: '1M', hours: 24 * 30, tf: 14400 },
] as const;

type Side = 'buy' | 'sell';

export function PredictMarket() {
  const route = useRoute();
  const id = route.query.get('id') ?? '';
  const [market, setMarket] = useState<MarketDetail>();
  const [error, setError] = useState<string>();
  const [range, setRange] = useState<(typeof RANGES)[number]>(RANGES[1]);
  const [history, setHistory] = useState<PricePoint[]>();
  const [showBook, setShowBook] = useState(false);
  const { book, status: feed } = useOrderbook(id || undefined);

  useEffect(() => {
    api
      .predictionMarket(id)
      .then(setMarket)
      .catch((e: Error) => setError(e.message));
  }, [id]);

  useEffect(() => {
    let stale = false;
    setHistory(undefined);
    api
      .predictionPriceHistory(id, { hours: range.hours, timeframeSeconds: range.tf })
      .then((h) => !stale && setHistory(h))
      .catch(() => !stale && setHistory([]));
    return () => {
      stale = true;
    };
  }, [id, range]);

  if (error) {
    return (
      <Screen>
        <TopBar title="Market" />
        <div className="screen-body">
          <ErrorNote error={error} />
        </div>
      </Screen>
    );
  }
  if (!market) {
    return (
      <Screen>
        <TopBar title="Market" />
        <div className="screen-body center" style={{ paddingTop: 40 }}>
          <Spinner />
        </div>
      </Screen>
    );
  }

  const yes = market.tokens.find((t) => t.outcome.toLowerCase() === 'yes') ?? market.tokens[0];
  // Prefer the live book's midpoint; fall back to the last trade mark, then the chart.
  const yesBook = book?.outcomes.find((o) => o.name.toLowerCase() === (yes?.outcome ?? 'yes').toLowerCase()) ?? book?.outcomes[0];
  const yesPrice = midpoint(yesBook) ?? yes?.price ?? history?.at(-1)?.price;

  return (
    <Screen>
      <TopBar
        title="Market"
        right={
          <button
            className="icon-btn"
            aria-label="Order book"
            title="Order book"
            onClick={() => setShowBook(true)}
            data-testid="open-orderbook"
          >
            <Icon name="book" />
          </button>
        }
      />
      <div className="screen-body stack" style={{ gap: 12 }}>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          {market.image && <img className="market-thumb" src={market.image} alt="" style={{ width: 48, height: 48 }} />}
          <div>
            <div style={{ fontWeight: 750, fontSize: 16, lineHeight: 1.3 }} data-testid="market-title">
              {market.title}
            </div>
            <div className="small muted">
              {market.category ? `${market.category} · ` : ''}
              {market.endDate ? `Ends ${new Date(market.endDate).toLocaleDateString()}` : ''}
              {market.status !== 'open' ? ` · ${market.status}` : ''}
            </div>
          </div>
        </div>

        <div>
          <div className="row" style={{ alignItems: 'baseline' }}>
            <span style={{ fontSize: 28, fontWeight: 750 }} className="num">
              {pct(yesPrice)}
            </span>
            <span className="muted small">chance of {yes?.outcome ?? 'Yes'}</span>
            <div className="spacer" />
            <div className="chip-row" style={{ padding: 0 }}>
              {RANGES.map((r) => (
                <button
                  key={r.key}
                  className={`chip ${range.key === r.key ? 'active' : ''}`}
                  style={{ height: 26 }}
                  onClick={() => setRange(r)}
                >
                  {r.key}
                </button>
              ))}
            </div>
          </div>
          {history ? (
            <PriceChart
              points={history}
              color={history.length > 1 && history[history.length - 1].price < history[0].price ? 'var(--no)' : 'var(--yes)'}
            />
          ) : (
            <div className="skeleton price-chart" />
          )}
        </div>

        <TradePanel market={market} yesPrice={yesPrice} book={book} feed={feed} onOpenBook={() => setShowBook(true)} />
      </div>
      {showBook && <OrderbookSheet market={market} book={book} feed={feed} onClose={() => setShowBook(false)} />}
    </Screen>
  );
}

function midpoint(o?: OutcomeBook): number | undefined {
  const bid = o?.bids[0]?.price;
  const ask = o?.asks[0]?.price;
  if (bid !== undefined && ask !== undefined) return (bid + ask) / 2;
  return bid ?? ask;
}

function roundToTick(p: number, tick: number) {
  const r = Math.round(p / tick) * tick;
  return Math.min(1 - tick, Math.max(tick, Number(r.toFixed(6))));
}

/** Market orders accept fills up to this far from the best price. */
const MAX_SLIPPAGE = 0.05;

type OrderKind = 'market' | 'limit';

function TradePanel({
  market,
  yesPrice,
  book,
  feed,
  onOpenBook,
}: {
  market: MarketDetail;
  yesPrice?: number;
  book?: BookState;
  feed: FeedStatus;
  onOpenBook: () => void;
}) {
  const { account } = useWallet();
  const { status, reload } = usePredictionStatus(account?.evmAddress ? account.id : undefined);
  const outcomes = market.tokens.map((t) => t.outcome);
  const [side, setSide] = useState<Side>('buy');
  const [outcome, setOutcome] = useState(outcomes[0] ?? 'Yes');
  const [kind, setKind] = useState<OrderKind>('market');
  const [tif, setTif] = useState<TimeInForce>('GTC');
  const [amount, setAmount] = useState('');
  const [priceCents, setPriceCents] = useState('');
  const [confirming, setConfirming] = useState(false);

  const outcomeBook = (name: string) => book?.outcomes.find((o) => o.name.toLowerCase() === name.toLowerCase());
  const fallbackPrice = (name: string) => {
    const t = market.tokens.find((x) => x.outcome === name);
    if (t?.price !== undefined) return t.price;
    if (yesPrice === undefined) return undefined;
    return name.toLowerCase() === 'no' ? 1 - yesPrice : yesPrice;
  };
  /** What you'd pay (buy → best ask) or get (sell → best bid) right now. */
  const quotePrice = (name: string) => {
    const ob = outcomeBook(name);
    return (side === 'buy' ? ob?.asks[0]?.price : ob?.bids[0]?.price) ?? fallbackPrice(name);
  };

  const decimals = Math.max(0, Math.round(-Math.log10(market.tickSize)) - 2);
  // Seed the limit price from the current quote whenever the outcome or side changes.
  useEffect(() => {
    const p = quotePrice(outcome);
    if (p !== undefined) setPriceCents((roundToTick(p, market.tickSize) * 100).toFixed(decimals));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome, side, kind]);

  const amt = Number(amount);
  const balance = Number(status?.balance ?? 0);
  const ob = outcomeBook(outcome);

  // Market: walk the live book. Limit: user's price.
  const fill = useMemo(
    () => (kind === 'market' && ob && amt > 0 ? walkBook(ob, side, amt, MAX_SLIPPAGE) : undefined),
    [kind, ob, side, amt],
  );
  const limitPrice = Number(priceCents) / 100;
  const price = kind === 'market' ? (fill ? roundToTick(fill.worstPrice, market.tickSize) : undefined) : limitPrice;
  const shares =
    kind === 'market'
      ? fill
        ? Math.floor(fill.shares * 100) / 100
        : 0
      : side === 'buy'
        ? limitPrice > 0
          ? Math.floor((amt / limitPrice) * 100) / 100
          : 0
        : amt;
  const cost = kind === 'market' ? (fill?.notional ?? 0) : shares * limitPrice;

  let problem: string | undefined;
  if (amount && !(amt > 0)) problem = 'Enter an amount';
  else if (kind === 'limit' && priceCents && !(limitPrice > 0 && limitPrice < 1)) problem = 'Price must be between 1¢ and 99¢';
  else if (
    kind === 'limit' &&
    priceCents &&
    Math.abs(limitPrice / market.tickSize - Math.round(limitPrice / market.tickSize)) > 1e-6
  )
    problem = `Price must be in steps of ${market.tickSize * 100}¢`;
  else if (side === 'buy' && amt > balance) problem = 'More than your trading balance';
  else if (kind === 'market' && amt > 0 && !ob)
    problem = feed === 'live' ? 'No orders on this side of the book' : 'Waiting for the live order book…';
  else if (kind === 'market' && amt > 0 && ob && !fill) problem = 'Not enough liquidity near the current price';

  const notReady = !account?.evmAddress
    ? 'Switch to an account with an EVM address to trade.'
    : market.status !== 'open'
      ? 'This market is closed.'
      : status?.next === 'setup'
        ? 'Set up prediction trading first.'
        : status?.next === 'fund' && side === 'buy'
          ? 'Add pUSD to your trading balance first.'
          : undefined;

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="segmented">
        {(['buy', 'sell'] as const).map((s) => (
          <button key={s} className={side === s ? 'active' : ''} onClick={() => setSide(s)}>
            {s === 'buy' ? 'Buy' : 'Sell'}
          </button>
        ))}
      </div>
      <div className="outcome-buttons">
        {outcomes.map((o, i) => {
          const cls = o.toLowerCase() === 'no' || i === 1 ? 'no' : 'yes';
          return (
            <button key={o} className={`outcome-btn ${cls} ${outcome === o ? 'selected' : ''}`} onClick={() => setOutcome(o)}>
              {o} {cents(quotePrice(o))}
            </button>
          );
        })}
      </div>

      <Field label={side === 'buy' ? 'Amount (pUSD)' : 'Shares'} htmlFor="trade-amount">
        <div className="input-group">
          <input
            id="trade-amount"
            className="input num"
            inputMode="decimal"
            placeholder="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
          />
          {side === 'buy' && balance > 0 && (
            <span className="suffix">
              <button type="button" className="link-btn small" onClick={() => setAmount(String(Math.floor(balance * 100) / 100))}>
                Max
              </button>
            </span>
          )}
        </div>
      </Field>

      <div className="row small" style={{ justifyContent: 'space-between' }}>
        <label className="row muted" style={{ gap: 6 }}>
          Order type
          <select
            className="select-inline"
            value={kind}
            onChange={(e) => setKind(e.target.value as OrderKind)}
            aria-label="Order type"
          >
            <option value="market">Market</option>
            <option value="limit">Limit</option>
          </select>
        </label>
        <button type="button" className="link-btn small row" style={{ gap: 4 }} onClick={onOpenBook}>
          <Icon name="book" size={14} /> Order book
          <span className={`live-dot ${feed}`} aria-hidden="true" />
        </button>
      </div>

      {kind === 'limit' && (
        <div className="row" style={{ gap: 10, alignItems: 'flex-end' }}>
          <Field label="Limit price (¢)" htmlFor="trade-price">
            <input
              id="trade-price"
              className="input num"
              inputMode="decimal"
              value={priceCents}
              onChange={(e) => setPriceCents(e.target.value.replace(/[^0-9.]/g, ''))}
            />
          </Field>
          <Field label="Until">
            <select
              className="select"
              value={tif}
              onChange={(e) => setTif(e.target.value as TimeInForce)}
              aria-label="Time in force"
            >
              <option value="GTC">Cancelled</option>
              <option value="FOK">Fill now or cancel</option>
            </select>
          </Field>
        </div>
      )}

      {amt > 0 && !problem && shares > 0 && (
        <div className="panel">
          {kind === 'market' && fill && (
            <div className="kv">
              <span>Avg price</span>
              <span className="num">{cents(fill.avgPrice)}</span>
            </div>
          )}
          <div className="kv">
            <span>Shares</span>
            <span className="num">{shares.toLocaleString()}</span>
          </div>
          <div className="kv">
            <span>{side === 'buy' ? (kind === 'market' ? 'Est. cost' : 'Cost') : 'You receive'}</span>
            <span className="num">${cost.toFixed(2)}</span>
          </div>
          {side === 'buy' && (
            <div className="kv">
              <span>Payout if {outcome} wins</span>
              <span className="num pos">${shares.toFixed(2)}</span>
            </div>
          )}
          {kind === 'market' && fill && !fill.complete && (
            <div className="small muted" style={{ marginTop: 4 }}>
              Only part of your amount fits within {Math.round(MAX_SLIPPAGE * 100)}¢ of the best price.
            </div>
          )}
        </div>
      )}
      {side === 'buy' && status && status.next !== 'setup' && (
        <div className="small muted">Trading balance: {status.balance ?? '0'} pUSD</div>
      )}
      {problem && amount && <div className="small neg">{problem}</div>}
      {notReady ? (
        <div className="notice">
          {notReady}{' '}
          {(status?.next === 'setup' || status?.next === 'fund') && (
            <button className="link-btn" onClick={() => navigate('/predict')}>
              Go to Predictions
            </button>
          )}
        </div>
      ) : (
        <Button
          disabled={!amt || !!problem || !(shares > 0) || price === undefined}
          onClick={() => setConfirming(true)}
          data-testid="review-order"
        >
          {side === 'buy' ? `Buy ${outcome}` : `Sell ${outcome}`}
        </Button>
      )}
      {confirming && account && price !== undefined && (
        <ConfirmOrder
          accountId={account.id}
          market={market}
          order={{
            kind,
            side,
            outcome,
            price: String(price),
            size: String(shares),
            // Market orders fill what they can at or better than the worst acceptable price, then cancel the rest.
            timeInForce: kind === 'market' ? 'FAK' : tif,
            cost,
            avgPrice: fill?.avgPrice,
          }}
          onClose={() => setConfirming(false)}
          onPlaced={() => void reload()}
        />
      )}
    </div>
  );
}

function ConfirmOrder({
  accountId,
  market,
  order,
  onClose,
  onPlaced,
}: {
  accountId: string;
  market: MarketDetail;
  order: {
    kind: OrderKind;
    side: Side;
    outcome: string;
    price: string;
    size: string;
    timeInForce: TimeInForce;
    cost: number;
    avgPrice?: number;
  };
  onClose: () => void;
  onPlaced: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<OrderResult>();
  const verb = order.side === 'buy' ? 'Buy' : 'Sell';

  if (result) {
    return (
      <Sheet title="Order placed" onClose={onClose}>
        <div className="stack">
          <div className="result" data-testid="order-result">
            <div className="ink2">
              {order.side === 'buy' ? 'Buying' : 'Selling'} {Number(order.size).toLocaleString()} {order.outcome}
              {order.kind === 'limit' ? ` at ${cents(Number(order.price))}` : ''}
            </div>
            <div className="small muted">Status: {result.status}</div>
          </div>
          <Button onClick={() => navigate('/predict', { tab: 'orders' })}>View orders</Button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title={`${verb} ${order.outcome}`} onClose={onClose}>
      <div className="stack">
        <div className="panel">
          <div className="kv">
            <span>Market</span>
            <span>{market.title}</span>
          </div>
          <div className="kv">
            <span>Shares</span>
            <span className="num">{Number(order.size).toLocaleString()}</span>
          </div>
          {order.kind === 'market' ? (
            <>
              <div className="kv">
                <span>Avg price</span>
                <span className="num">{cents(order.avgPrice)}</span>
              </div>
              <div className="kv">
                <span>{order.side === 'buy' ? 'Worst price accepted' : 'Lowest price accepted'}</span>
                <span className="num">{cents(Number(order.price))}</span>
              </div>
            </>
          ) : (
            <div className="kv">
              <span>Limit price</span>
              <span className="num">{cents(Number(order.price))}</span>
            </div>
          )}
          <div className="kv">
            <span>{order.side === 'buy' ? 'Est. cost' : 'Est. proceeds'}</span>
            <span className="num">${order.cost.toFixed(2)} pUSD</span>
          </div>
          <div className="kv">
            <span>Type</span>
            <span>
              {order.kind === 'market'
                ? 'Market, fills now; any unfilled part is cancelled'
                : order.timeInForce === 'GTC'
                  ? 'Limit, stays open until filled or cancelled'
                  : 'Limit, fill now or cancel'}
            </span>
          </div>
        </div>
        <div className="small muted">
          Signed with your wallet and routed by Kairos to Polymarket. Placing and cancelling orders costs no gas; venue fees may
          apply.
        </div>
        <ErrorNote error={error} />
        <Button
          loading={busy}
          data-testid="place-order"
          onClick={async () => {
            setBusy(true);
            setError(undefined);
            try {
              setResult(
                await api.predictionOrder(accountId, {
                  marketId: market.marketId,
                  outcome: order.outcome,
                  side: order.side,
                  price: order.price,
                  size: order.size,
                  timeInForce: order.timeInForce,
                }),
              );
              onPlaced();
            } catch (e) {
              const msg = (e as Error).message;
              // The API may not know whether a failed call reached the venue; tell the user to check before retrying.
              setError(/outcome unknown/i.test(msg) ? `${msg}. Check your open orders before trying again.` : msg);
            } finally {
              setBusy(false);
            }
          }}
        >
          Confirm {verb.toLowerCase()}
        </Button>
      </div>
    </Sheet>
  );
}
