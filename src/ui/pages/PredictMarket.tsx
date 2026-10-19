import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BookState, OutcomeBook } from '../../core/predictions/orderbook';
import { liquidityNotices, marketLimitPrice, walkBook, type LiquidityNotice } from '../../core/predictions/orderbook';
import type { MarketDetail, OrderResult, PricePoint, TimeInForce } from '../../core/predictions/types';
import { api } from '../lib/api';
import { navigate, useRoute } from '../lib/router';
import { useWallet } from '../lib/store';
import { Button, ErrorNote, Field, Screen, Sheet, Spinner, TopBar } from '../components/ui';
import { PriceChart } from '../components/PriceChart';
import { Icon } from '../components/Icon';
import { OrderbookSheet, type BookPick } from '../components/OrderbookSheet';
import { useOrderbook, type FeedStatus } from '../components/useOrderbook';
import { VENUE_INFO } from '../../core/predictions/venues';
import {
  VenueTag,
  cents,
  pct,
  perpsUsdc,
  shortfallText,
  usePredictionStatus,
  venueHold,
  venueShortfall,
  venueStatus,
  VenueSheet,
} from './Predict';

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
  /** A price level clicked in the order book; `n` makes repeat clicks on the same level apply again. */
  const [pick, setPick] = useState<BookPick & { n: number }>();
  const { book, status: feed } = useOrderbook(id || undefined);
  /** "Sell" on the position card: switches the trade panel to selling that outcome. */
  const [sellRequest, setSellRequest] = useState<{ outcome: string; n: number }>();
  const { account } = useWallet();
  // Shares held per outcome, read on-chain (what a sell is checked against), plus average entry from Kairos.
  const [holdings, setHoldings] = useState<Record<string, number>>();
  const [avgPrices, setAvgPrices] = useState<Record<string, number>>();
  const marketId = market?.marketId;
  const loadHoldings = useCallback(() => {
    if (!account?.evmAddress || !marketId) return;
    api
      .predictionHoldings(account.id, marketId)
      .then(setHoldings)
      .catch(() => undefined);
    api
      .predictionPositions(account.id)
      .then((v) =>
        setAvgPrices(
          Object.fromEntries(
            v.positions
              .filter((p) => p.marketId === marketId && p.state === 'open' && p.avgPrice !== undefined)
              .map((p) => [p.outcome.toLowerCase(), p.avgPrice!]),
          ),
        ),
      )
      .catch(() => undefined);
  }, [account, marketId]);
  useEffect(loadHoldings, [loadHoldings]);

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
              <VenueTag venue={market.venue} />{' '}
              {[
                market.category,
                market.endDate && `Ends ${new Date(market.endDate).toLocaleDateString()}`,
                market.status !== 'open' && market.status,
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </div>
        </div>

        {holdings && (
          <YourPosition
            market={market}
            book={book}
            yesPrice={yesPrice}
            holdings={holdings}
            avgPrices={avgPrices}
            onSell={(outcome) => setSellRequest({ outcome, n: (sellRequest?.n ?? 0) + 1 })}
          />
        )}

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

        <TradePanel
          market={market}
          yesPrice={yesPrice}
          book={book}
          feed={feed}
          onOpenBook={() => setShowBook(true)}
          pick={pick}
          sellRequest={sellRequest}
          holdings={holdings}
          onHoldingsChanged={loadHoldings}
        />
      </div>
      {showBook && (
        <OrderbookSheet
          market={market}
          book={book}
          feed={feed}
          onClose={() => setShowBook(false)}
          onPick={(p) => {
            setPick({ ...p, n: (pick?.n ?? 0) + 1 });
            setShowBook(false);
          }}
        />
      )}
    </Screen>
  );
}

/** What this wallet holds in the market: shares, value at the best bid, and P&L against the average entry. */
function YourPosition({
  market,
  book,
  yesPrice,
  holdings,
  avgPrices,
  onSell,
}: {
  market: MarketDetail;
  book?: BookState;
  yesPrice?: number;
  holdings: Record<string, number>;
  avgPrices?: Record<string, number>;
  onSell: (outcome: string) => void;
}) {
  // Dust left over from a sell (fractions of a cent) isn't worth showing.
  const held = market.tokens.filter((t) => (holdings[t.outcome] ?? 0) >= 0.01);
  if (!held.length) return null;
  return (
    <div className="your-position" data-testid="your-position">
      <div className="small muted" style={{ fontWeight: 650 }}>
        Your position
      </div>
      {held.map((t, i) => {
        const shares = holdings[t.outcome];
        const ob = book?.outcomes.find((o) => o.name.toLowerCase() === t.outcome.toLowerCase());
        const quoted = t.price ?? (yesPrice === undefined ? undefined : i === 1 ? 1 - yesPrice : yesPrice);
        const price = ob?.bids[0]?.price ?? midpoint(ob) ?? quoted;
        const value = price !== undefined ? shares * price : undefined;
        const avg = avgPrices?.[t.outcome.toLowerCase()];
        const pnl = value !== undefined && avg !== undefined ? value - shares * avg : undefined;
        const tone = t.outcome.toLowerCase() === 'no' || i === 1 ? 'no' : 'yes';
        return (
          <div key={t.tokenId} className="your-position-row">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row" style={{ gap: 6 }}>
                <span className={`outcome-pill ${tone}`}>{t.outcome}</span>
                <span className="num nowrap" style={{ fontWeight: 700 }}>
                  {fmtShares(shares)} shares
                </span>
              </div>
              {avg !== undefined && (
                <div className="small muted num" style={{ marginTop: 3 }}>
                  Avg {cents(avg)}
                  {price !== undefined && ` → now ${cents(price)}`}
                </div>
              )}
            </div>
            <div className="nowrap" style={{ textAlign: 'right' }}>
              <div className="num" style={{ fontWeight: 750 }}>
                {value !== undefined ? usd(value) : '—'}
              </div>
              {pnl !== undefined && (
                <div className={`small num ${pnl >= 0 ? 'pos' : 'neg'}`} style={{ fontWeight: 650 }}>
                  {pnl >= 0 ? '+' : '−'}${Math.abs(pnl).toFixed(2)}
                  {avg ? ` (${pnl >= 0 ? '+' : '−'}${Math.abs((pnl / (shares * avg)) * 100).toFixed(1)}%)` : ''}
                </div>
              )}
            </div>
            <button className="mini-btn strong" onClick={() => onSell(t.outcome)} data-testid="sell-held">
              Sell
            </button>
          </div>
        );
      })}
    </div>
  );
}

function midpoint(o?: OutcomeBook): number | undefined {
  const bid = o?.bids[0]?.price;
  const ask = o?.asks[0]?.price;
  if (bid !== undefined && ask !== undefined) return (bid + ask) / 2;
  return bid ?? ask;
}

const fmtShares = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2 });

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
  pick,
  sellRequest,
  holdings,
  onHoldingsChanged,
}: {
  market: MarketDetail;
  pick?: BookPick & { n: number };
  sellRequest?: { outcome: string; n: number };
  holdings?: Record<string, number>;
  onHoldingsChanged: () => void;
  yesPrice?: number;
  book?: BookState;
  feed: FeedStatus;
  onOpenBook: () => void;
}) {
  const { account } = useWallet();
  const { status, reload } = usePredictionStatus(account?.evmAddress ? account.id : undefined);
  const venue = venueStatus(status, market.venue);
  const venueName = VENUE_INFO[market.venue].name;
  const currency = VENUE_INFO[market.venue].currency;
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
  const loadHoldings = onHoldingsChanged;
  // Holdings load before status for a wallet that was set up in another session; reload once it's ready.
  const setUp = !!account?.evmAddress && !!venue && venue.next !== 'setup';
  useEffect(() => {
    if (setUp) loadHoldings();
  }, [setUp, loadHoldings]);
  const held = holdings?.[outcome] ?? 0;
  /** After an order: refresh now and again while the fill settles on-chain. */
  const afterOrder = () => {
    void reload();
    loadHoldings();
    setAmount('');
    for (const ms of [5_000, 15_000]) setTimeout(() => (void reload(), loadHoldings()), ms);
  };

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
  // A level picked in the order book becomes a limit order at that price: asks → buy, bids → sell.
  const skipSeed = useRef(false);
  useEffect(() => {
    if (!pick) return;
    const nextOutcome =
      market.tokens.find((t) => t.outcome.toLowerCase() === pick.outcome.toLowerCase())?.outcome ?? pick.outcome;
    // The seeding effect below runs only if one of these changes; skip it so it keeps the picked price.
    skipSeed.current = nextOutcome !== outcome || pick.side !== side || kind !== 'limit';
    setOutcome(nextOutcome);
    setSide(pick.side);
    setKind('limit');
    setPriceCents((roundToTick(pick.price, market.tickSize) * 100).toFixed(decimals));
    document.getElementById('trade-amount')?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pick?.n]);

  // "Sell" on the position card: sell that outcome, starting from everything held.
  useEffect(() => {
    if (!sellRequest) return;
    setSide('sell');
    setOutcome(sellRequest.outcome);
    const h = holdings?.[sellRequest.outcome] ?? 0;
    setAmount(h > 0 ? String(Math.floor(h * 100) / 100) : '');
    const input = document.getElementById('trade-amount');
    input?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    input?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sellRequest?.n]);

  // Seed the limit price from the current quote whenever the outcome or side changes.
  useEffect(() => {
    if (skipSeed.current) {
      skipSeed.current = false;
      return;
    }
    const p = quotePrice(outcome);
    if (p !== undefined) setPriceCents((roundToTick(p, market.tickSize) * 100).toFixed(decimals));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome, side, kind]);

  const amt = Number(amount);
  // Hyperliquid: perps USDC counts too; an order that needs it asks to move it to spot first. Status
  // only reports perps once set up, so read Hyperliquid directly.
  const [hlUsdc, setHlUsdc] = useState<number>();
  const hlAccount = market.venue === 'hyperliquid' && account?.evmAddress ? account.id : undefined;
  const statusBalance = venue?.balance;
  useEffect(() => {
    if (!hlAccount) return;
    api
      .hyperliquidBalances(hlAccount)
      .then((b) => setHlUsdc(b.spotUsdc + b.perpsUsdc))
      .catch(() => setHlUsdc(undefined));
  }, [hlAccount, statusBalance]);
  const balance = hlUsdc ?? Number(venue?.balance ?? 0) + perpsUsdc(venue);
  // Hyperliquid trades whole shares; elsewhere hundredths.
  const shareStep = market.venue === 'hyperliquid' ? 1 : 0.01;
  const floorShares = (n: number) => Math.floor(n / shareStep + 1e-9) * shareStep;
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
  // Market orders: the walked worst price plus a little headroom, in case the book moves before the venue sees it.
  const bestPrice = side === 'buy' ? ob?.asks[0]?.price : ob?.bids[0]?.price;
  const price =
    kind === 'market'
      ? fill && bestPrice !== undefined
        ? marketLimitPrice(side, fill, bestPrice, market.tickSize, MAX_SLIPPAGE)
        : undefined
      : limitPrice;
  const shares =
    kind === 'market'
      ? fill
        ? // The venue reserves size × limit price for a buy, so cap shares at what the balance covers.
          floorShares(side === 'buy' && price && balance > 0 ? Math.min(fill.shares, balance / price) : fill.shares)
        : 0
      : side === 'buy'
        ? limitPrice > 0
          ? floorShares(amt / limitPrice)
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
  else if (side === 'sell' && shareStep === 1 && !Number.isInteger(amt)) problem = `${venueName} trades whole shares`;
  else if (side === 'sell' && holdings && amt > held + 1e-9)
    problem = held > 0 ? `You hold ${fmtShares(held)} ${outcome} shares` : `You don't hold any ${outcome} shares`;
  else if (kind === 'market' && amt > 0 && feed !== 'live')
    problem =
      feed === 'waiting'
        ? 'The live order book is unavailable, so market orders are paused. Use a limit order.'
        : 'Waiting for the live order book…';
  else if (kind === 'market' && amt > 0 && !ob)
    problem =
      feed === 'live'
        ? 'No orders on this side of the book'
        : feed === 'waiting'
          ? 'The live order book is unavailable, so market orders are paused. Use a limit order.'
          : 'Waiting for the live order book…';
  else if (kind === 'market' && amt > 0 && ob && !fill) problem = 'Not enough liquidity near the current price';

  // Polymarket needs the one-time setup first. Other venues set up inside the first order.
  const polymarket = market.venue === 'polymarket';
  // Without BNB the first order can't send its approvals, so that blocks selling too.
  const short = polymarket ? undefined : venueShortfall(venue);
  const hold = venueHold(venue);
  const [venueOpen, setVenueOpen] = useState(false);
  const notReady = !account?.evmAddress
    ? 'Switch to an account with an EVM address to trade.'
    : market.status !== 'open'
      ? 'This market is closed.'
      : status && !venue
        ? `This Kairos node doesn't trade ${venueName} yet. You can still follow the market here.`
        : hold
          ? hold
          : polymarket && venue?.next === 'setup'
            ? 'Set up prediction trading first.'
            : short && (short.gas || side === 'buy')
              ? short.gas && !short.collateral
                ? `You have ${usd(balance)} ${currency}. ${shortfallText(market.venue, short)}`
                : shortfallText(market.venue, short)
              : polymarket && venue?.next === 'fund' && side === 'buy'
                ? 'Add pUSD to your trading balance first.'
                : undefined;

  const outcomeClass = (o: string) => (o.toLowerCase() === 'no' || outcomes.indexOf(o) === 1 ? 'no' : 'yes');
  const best = ob && (side === 'buy' ? ob.asks[0] : ob.bids[0]);
  const spread = ob?.asks[0] && ob?.bids[0] ? ob.asks[0].price - ob.bids[0].price : undefined;
  const QUICK = side === 'buy' ? [1, 5, 10, 100] : [];

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
              onClick={() => {
                // Buy amounts are dollars and sell amounts are shares; don't carry one over as the other.
                if (s !== side) setAmount('');
                setSide(s);
              }}
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
          {side === 'buy' && venue && (venue.next !== 'setup' || !polymarket) && (
            <span className="muted num">Balance {usd(balance)}</span>
          )}
          {side === 'sell' && held > 0 && (
            <span className="muted num">
              You hold {fmtShares(held)} {outcome}
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
              <option value="GTC">{market.venue === 'predictfun' ? 'Cancelled, max 1 day' : 'Cancelled'}</option>
              {market.venue === 'hyperliquid' ? (
                <option value="FAK">Fill now, cancel the rest</option>
              ) : (
                <option value="FOK">Fill now or cancel</option>
              )}
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
          {venue && !hold && (venue.next === 'setup' ? polymarket : venue.next === 'fund' && (polymarket || short)) && (
            <button className="link-btn" onClick={() => setVenueOpen(true)}>
              {venue.next === 'setup' ? 'Set up' : 'Add funds'}
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
      {venueOpen && account && status && (
        <VenueSheet
          venue={market.venue}
          status={status}
          accountId={account.id}
          onChange={async () => {
            await reload();
            loadHoldings();
          }}
          onClose={() => setVenueOpen(false)}
        />
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
          firstOrder={!polymarket && venue?.next === 'setup'}
          notices={notices.filter((n) => n.level === 'danger')}
          onClose={() => setConfirming(false)}
          onPlaced={afterOrder}
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
  firstOrder,
  notices,
  onClose,
  onPlaced,
}: {
  accountId: string;
  tone: 'yes' | 'no';
  /** The venue isn't set up yet, so this order also runs its one-time setup. */
  firstOrder?: boolean;
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
  const { name: venueName, currency } = VENUE_INFO[market.venue];

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
            <span>Venue</span>
            <span>
              <VenueTag venue={market.venue} />
            </span>
          </div>
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
            <span className="num">
              ${order.cost.toFixed(2)} {currency}
            </span>
          </div>
          <div className="kv">
            <span>Type</span>
            <span>
              {order.kind === 'market'
                ? 'Market, fills now; any unfilled part is cancelled'
                : order.timeInForce === 'GTC'
                  ? market.venue === 'predictfun'
                    ? 'Limit, stays open until filled or cancelled, for up to about a day'
                    : 'Limit, stays open until filled or cancelled'
                  : order.timeInForce === 'FAK'
                    ? 'Limit, fills what it can now; the rest is cancelled'
                    : 'Limit, fill now or cancel'}
            </span>
          </div>
        </div>
        <LiquidityNotices notices={notices} />
        {firstOrder && market.venue === 'hyperliquid' && (
          <div className="notice" data-testid="first-order-setup">
            Your first Hyperliquid order also asks you to let Kairos place Hyperliquid trades for you. Kairos can only place and
            cancel trades: it can&apos;t withdraw or transfer, costs no gas, and you can revoke it on Hyperliquid at any time.
          </div>
        )}
        {firstOrder && market.venue !== 'hyperliquid' && (
          <div className="notice" data-testid="first-order-setup">
            Your first {venueName} order also signs you in to {venueName} and approves its contracts on BNB Chain. That&apos;s a
            one-time set of transactions from this wallet, paid in BNB.
          </div>
        )}
        <div className="small muted">
          Signed with your wallet and routed by Kairos to {venueName}. Placing and cancelling orders costs no gas; venue fees may
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
