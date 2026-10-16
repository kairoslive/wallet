import { useEffect, useMemo, useState } from 'react';
import type { BookState, OutcomeBook } from '../../core/predictions/orderbook';
import { liquidityNotices, walkBook, type LiquidityNotice } from '../../core/predictions/orderbook';
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

/** Chart ranges; the short ones use 1-minute candles and refresh every minute. */
const RANGES = [
  { key: '1H', label: 'past hour', hours: 1, tf: 60 },
  { key: '6H', label: 'past 6 hours', hours: 6, tf: 60 },
  { key: '1D', label: 'past day', hours: 24, tf: 60 },
  { key: '1W', label: 'past week', hours: 24 * 7, tf: 3600 },
  { key: '1M', label: 'past month', hours: 24 * 30, tf: 14400 },
] as const;

type Side = 'buy' | 'sell';

export function PredictMarket() {
  const route = useRoute();
  const id = route.query.get('id') ?? '';
  const [market, setMarket] = useState<MarketDetail>();
  const [error, setError] = useState<string>();
  const [range, setRange] = useState<(typeof RANGES)[number]>(RANGES.find((r) => r.key === '1W')!);
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
    const load = (initial: boolean) =>
      api
        .predictionPriceHistory(id, { hours: range.hours, timeframeSeconds: range.tf })
        .then((h) => !stale && setHistory(h))
        .catch(() => !stale && initial && setHistory([]));
    void load(true);
    const timer = range.tf === 60 ? setInterval(() => void load(false), 60_000) : undefined;
    return () => {
      stale = true;
      clearInterval(timer);
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
  const change = history && history.length > 1 && yesPrice !== undefined ? yesPrice - history[0].price : undefined;
  // Candles only exist for minutes with trades; carry the line to now at the live price.
  const chartPoints =
    history && history.length && yesPrice !== undefined ? [...history, { t: Date.now(), price: yesPrice }] : (history ?? []);

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
          <div style={{ minWidth: 0 }}>
            {market.eventTitle && (
              <div className="small muted ellipsis" style={{ fontWeight: 600 }}>
                {market.eventTitle}
              </div>
            )}
            <div className="market-title" data-testid="market-title">
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
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div>
              <div className="row" style={{ alignItems: 'baseline', gap: 6 }}>
                <span className="market-prob num">{pct(yesPrice)}</span>
                <span className="muted small">chance</span>
              </div>
              {change !== undefined && Math.round(change * 100) !== 0 && (
                <div className={`small num ${change > 0 ? 'pos' : 'neg'}`} style={{ fontWeight: 650 }}>
                  {change > 0 ? '▲' : '▼'} {Math.abs(Math.round(change * 100))} pts · {range.label}
                </div>
              )}
            </div>
            <div className="spacer" />
            <div className="range-tabs" role="tablist" aria-label="Chart range">
              {RANGES.map((r) => (
                <button
                  key={r.key}
                  role="tab"
                  aria-selected={range.key === r.key}
                  className={range.key === r.key ? 'active' : ''}
                  onClick={() => setRange(r)}
                >
                  {r.key}
                </button>
              ))}
            </div>
          </div>
          {history ? (
            <PriceChart points={chartPoints} color={change !== undefined && change < 0 ? 'var(--no)' : 'var(--yes)'} />
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

const usd = (v: number) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
  // Positions link here with ?side=sell&outcome=Yes to start a sell (or buy more) of that outcome.
  const route = useRoute();
  const [side, setSide] = useState<Side>(route.query.get('side') === 'sell' ? 'sell' : 'buy');
  const [outcome, setOutcome] = useState(
    outcomes.find((o) => o.toLowerCase() === route.query.get('outcome')?.toLowerCase()) ?? outcomes[0] ?? 'Yes',
  );
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
  const notices = useMemo(
    () => (kind === 'market' && ob ? liquidityNotices(ob, side, amt, MAX_SLIPPAGE) : []),
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
    problem =
      feed === 'live'
        ? 'No orders on this side of the book'
        : feed === 'waiting'
          ? 'The live order book is unavailable, so market orders are paused. Use a limit order.'
          : 'Waiting for the live order book…';
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

  const outcomeClass = (o: string) => (o.toLowerCase() === 'no' || outcomes.indexOf(o) === 1 ? 'no' : 'yes');
  const best = ob && (side === 'buy' ? ob.asks[0] : ob.bids[0]);
  const spread = ob?.asks[0] && ob?.bids[0] ? ob.asks[0].price - ob.bids[0].price : undefined;
  const QUICK = side === 'buy' ? [1, 5, 10, 100] : [];
  // Shares held of the selected outcome, passed by the Positions tab (?held=…&outcome=…).
  const heldParam = Number(route.query.get('held'));
  const held = route.query.get('outcome')?.toLowerCase() === outcome.toLowerCase() && heldParam > 0 ? heldParam : 0;

  return (
    <div className="trade stack" style={{ gap: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="side-tabs" role="tablist" aria-label="Side">
          {(['buy', 'sell'] as const).map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={side === s}
              className={side === s ? 'active' : ''}
              onClick={() => setSide(s)}
            >
              {s === 'buy' ? 'Buy' : 'Sell'}
            </button>
          ))}
        </div>
        <select
          className="select-pill"
          value={kind}
          onChange={(e) => setKind(e.target.value as OrderKind)}
          aria-label="Order type"
        >
          <option value="market">Market</option>
          <option value="limit">Limit</option>
        </select>
      </div>

      <div className="outcome-buttons">
        {outcomes.map((o) => (
          <button
            key={o}
            className={`outcome-btn ${outcomeClass(o)} ${outcome === o ? 'selected' : ''}`}
            onClick={() => setOutcome(o)}
            aria-pressed={outcome === o}
          >
            <span>{o}</span>
            <span className="outcome-price">{cents(quotePrice(o))}</span>
          </button>
        ))}
      </div>

      <button type="button" className="book-strip" onClick={onOpenBook}>
        <span className={`live-dot ${feed}`} aria-hidden="true" />
        <span className="muted">
          {best
            ? `${side === 'buy' ? 'Best ask' : 'Best bid'} ${cents(best.price)}`
            : feed === 'live'
              ? 'No orders on this side'
              : feed === 'waiting'
                ? 'Order book not available from Kairos yet'
                : 'Connecting to the book…'}
          {spread !== undefined ? ` · spread ${(spread * 100).toFixed(1)}¢` : ''}
        </span>
        <span className="spacer" />
        <span className="link-btn small row nowrap" style={{ gap: 4, flexShrink: 0 }}>
          <Icon name="book" size={14} /> Order book
        </span>
      </button>

      <div>
        <div className="row small" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
          <label htmlFor="trade-amount" className="muted" style={{ fontWeight: 600 }}>
            {side === 'buy' ? 'Amount' : 'Shares'}
          </label>
          {side === 'buy' && status && status.next !== 'setup' && (
            <span className="muted num">Balance {usd(Number(status.balance ?? 0))}</span>
          )}
          {side === 'sell' && held > 0 && (
            <span className="muted num">
              You hold {held.toLocaleString(undefined, { maximumFractionDigits: 2 })} {outcome}
            </span>
          )}
        </div>
        <div className="amount-input">
          {side === 'buy' && <span className="amount-prefix">$</span>}
          <input
            id="trade-amount"
            className="num"
            inputMode="decimal"
            placeholder="0"
            autoComplete="off"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
          />
        </div>
        {side === 'buy' && (
          <div className="quick-amounts">
            {QUICK.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setAmount(String(Math.round(((Number(amount) || 0) + q) * 100) / 100))}
              >
                +${q}
              </button>
            ))}
            <button type="button" disabled={!(balance > 0)} onClick={() => setAmount(String(Math.floor(balance * 100) / 100))}>
              Max
            </button>
          </div>
        )}
        {side === 'sell' && held > 0 && (
          <div className="quick-amounts">
            {[0.25, 0.5, 1].map((f) => (
              <button key={f} type="button" onClick={() => setAmount(String(Math.floor(held * f * 100) / 100))}>
                {f === 1 ? 'Max' : `${f * 100}%`}
              </button>
            ))}
          </div>
        )}
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
        <div className="trade-summary">
          {side === 'buy' ? (
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span>To win</span>
              <span className="trade-win num">{usd(shares)}</span>
            </div>
          ) : (
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span>You receive</span>
              <span className="trade-win num">{usd(cost)}</span>
            </div>
          )}
          <div className="small muted num">
            {shares.toLocaleString()} shares
            {kind === 'market' && fill ? ` · avg ${cents(fill.avgPrice)}` : ` at ${cents(limitPrice)}`}
            {side === 'buy' ? ` · ${kind === 'market' ? 'est. ' : ''}cost ${usd(cost)}` : ''}
          </div>
        </div>
      )}
      <LiquidityNotices notices={notices} />
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
          variant="dark"
          block
          className={`trade-cta ${outcomeClass(outcome)}`}
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
          tone={outcomeClass(outcome)}
          notices={notices.filter((n) => n.level === 'danger')}
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
  tone,
  notices,
  onClose,
  onPlaced,
}: {
  accountId: string;
  tone: 'yes' | 'no';
  notices: LiquidityNotice[];
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
        <LiquidityNotices notices={notices} />
        <div className="small muted">
          Signed with your wallet and routed by Kairos to Polymarket. Placing and cancelling orders costs no gas; venue fees may
          apply.
        </div>
        <ErrorNote error={error} />
        <Button
          variant="dark"
          className={`trade-cta ${tone}`}
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

function LiquidityNotices({ notices }: { notices: LiquidityNotice[] }) {
  if (!notices.length) return null;
  return (
    <div className="stack" style={{ gap: 6 }} data-testid="liquidity-notices">
      {notices.map((n) => (
        <div
          key={n.text}
          className={`notice row ${n.level === 'danger' ? 'error' : ''}`}
          style={{ alignItems: 'flex-start', gap: 8 }}
        >
          <span style={{ flexShrink: 0, marginTop: 1 }}>
            <Icon name="alert" size={15} />
          </span>
          <span>{n.text}</span>
        </div>
      ))}
    </div>
  );
}
