import { useEffect, useMemo, useRef, useState } from 'react';
import { liquidityNotices, marketLimitPrice, walkBook, type LiquidityNotice } from '../../core/predictions/orderbook';
import { planBuy, routeBounds, type RoutePlan, type RouteVenue } from '../../core/predictions/router';
import type { RouteExecution, RouteLegResult } from '../../core/predictions/execution';
import type { MarketDetail, ResolutionEvent, TimeInForce, TradingStatus } from '../../core/predictions/types';
import { VENUE_INFO, type Venue } from '../../core/predictions/venues';
import { describeResolution } from '../../core/predictions/resolution';
import { api } from '../lib/api';
import { navigate, useRoute } from '../lib/router';
import { useWallet } from '../lib/store';
import { fetchQuery, setQueryData } from '../lib/query';
import {
  invalidateAfterTrade,
  keys,
  useCandles,
  useHistory,
  useLink,
  useMarket,
  useResolution,
  useRules,
  usePositions,
  useTradingStatus,
} from '../lib/predictQueries';
import { Button, ErrorNote, Field, Screen, Sheet, Spinner, TopBar } from '../components/ui';
import { PriceChart, type ScrubPoint } from '../components/PriceChart';
import { Icon } from '../components/Icon';
import { OrderbookSheet, type BookPick } from '../components/OrderbookSheet';
import type { FeedStatus } from '../components/useOrderbook';
import { useMarketVenues, type MarketSide, type SideVenue } from '../components/useMarketVenues';
import { cents, pct, perpsUsdc, shortfallText, venueHold, venueShortfall, venueStatus, VenueSheet } from './Predict';

/** Chart ranges. Short ones use 1-minute buckets and refresh every minute; candles use wider buckets. */
const RANGES = [
  { key: '1H', label: 'past hour', hours: 1, tf: 60, candleTf: 60 },
  { key: '6H', label: 'past 6 hours', hours: 6, tf: 60, candleTf: 300 },
  { key: '1D', label: 'past day', hours: 24, tf: 60, candleTf: 900 },
  { key: '1W', label: 'past week', hours: 24 * 7, tf: 3600, candleTf: 14400 },
  { key: '1M', label: 'past month', hours: 24 * 30, tf: 14400, candleTf: 86400 },
] as const;
type Range = (typeof RANGES)[number];

type Side = 'buy' | 'sell';
type OrderKind = 'market' | 'limit';

/** Market orders accept fills up to this far from the best price. */
const MAX_SLIPPAGE = 0.05;

const fmtShares = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2 });
const usd = (v: number) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const venueName = (v: Venue) => VENUE_INFO[v].name;
const toneOf = (market: MarketDetail, name: string) =>
  name.toLowerCase() === 'no' || market.tokens.findIndex((t) => t.outcome === name) === 1 ? 'no' : 'yes';

function roundToTick(p: number, tick: number) {
  const r = Math.round(p / tick) * tick;
  return Math.min(1 - tick, Math.max(tick, Number(r.toFixed(6))));
}

const midpoint = (bid?: number, ask?: number) => (bid !== undefined && ask !== undefined ? (bid + ask) / 2 : (bid ?? ask));

export function PredictMarket() {
  const route = useRoute();
  const id = route.query.get('id') ?? '';
  const { account } = useWallet();
  const { data: market, error } = useMarket(id);
  const { data: link } = useLink(id);
  const venues = useMarketVenues(market, link);
  const [showBook, setShowBook] = useState(false);
  /** A price level clicked in the order book; `n` makes repeat clicks on the same level apply again. */
  const [pick, setPick] = useState<BookPick & { n: number }>();
  /** "Sell" on the position card: switches the trade panel to selling that outcome. */
  const [sellRequest, setSellRequest] = useState<{ outcome: string; n: number }>();
  const accountId = account?.evmAddress ? account.id : undefined;
  const holdings = useAllHoldings(
    accountId,
    venues.markets.map((m) => m.key),
  );

  if (error && !market) {
    return (
      <Screen>
        <TopBar title="" />
        <div className="screen-body">
          <ErrorNote error={error} />
        </div>
      </Screen>
    );
  }
  if (!market) {
    return (
      <Screen>
        <TopBar title="" />
        <div className="screen-body stack" style={{ gap: 14 }}>
          <div className="skeleton" style={{ height: 44, width: '80%' }} />
          <div className="skeleton" style={{ height: 36, width: 120 }} />
          <div className="skeleton price-chart" />
          <div className="skeleton" style={{ height: 120 }} />
        </div>
      </Screen>
    );
  }

  const yes = venues.sides[0];
  // Across every venue: the best bid and the best ask, so the price is the market's, not one venue's.
  const livePrice = midpoint(yes?.bestBid?.price, yes?.bestAsk?.price) ?? market.tokens[0]?.price;

  return (
    <Screen>
      <TopBar
        title=""
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
      <div className="screen-body stack market-screen" style={{ gap: 16 }}>
        <MarketHeader market={market} />
        <ResolvedBanner market={market} />
        <ChartSection market={market} livePrice={livePrice} />
        {holdings && (
          <YourPosition
            market={market}
            sides={venues.sides}
            holdings={holdings}
            onSell={(outcome) => setSellRequest({ outcome, n: (sellRequest?.n ?? 0) + 1 })}
          />
        )}
        <TradePanel
          market={market}
          sides={venues.sides}
          feed={venues.feed}
          holdings={holdings}
          onOpenBook={() => setShowBook(true)}
          pick={pick}
          sellRequest={sellRequest}
        />
        <About market={market} />
      </div>
      {showBook && (
        <OrderbookSheet
          market={market}
          book={venues.primaryBook}
          feed={venues.sides[0]?.venues[0]?.feed ?? 'connecting'}
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

function MarketHeader({ market }: { market: MarketDetail }) {
  return (
    <div className="market-head">
      {market.image ? <img className="market-head-thumb" src={market.image} alt="" /> : <span className="market-head-thumb" />}
      <div style={{ minWidth: 0 }}>
        {market.eventTitle && <div className="market-head-event ellipsis">{market.eventTitle}</div>}
        <h1 className="market-title" data-testid="market-title">
          {market.title}
        </h1>
        <div className="small muted">
          {[
            market.category,
            market.endDate &&
              `Ends ${new Date(market.endDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`,
            market.status !== 'open' && 'Closed',
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ price and chart

/** When the scrubbed point is, as precisely as the range needs. */
function scrubTime(t: number, hours: number): string {
  const d = new Date(t);
  if (hours <= 24) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (hours <= 24 * 7) return d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function ChartSection({ market, livePrice }: { market: MarketDetail; livePrice?: number }) {
  const [range, setRange] = useState<Range>(RANGES[3]);
  const [mode, setMode] = useState<'line' | 'candles'>('line');
  const [scrub, setScrub] = useState<ScrubPoint>();
  const { data: history } = useHistory(market.marketId, range.hours, range.tf, {
    refreshMs: range.tf === 60 ? 60_000 : undefined,
  });
  const { data: candles } = useCandles(mode === 'candles' ? market.marketId : undefined, range.hours, range.candleTf, {
    refreshMs: range.candleTf <= 300 ? 60_000 : undefined,
  });
  const price = scrub?.price ?? livePrice ?? history?.at(-1)?.price;
  const base = history?.[0]?.price;
  const change = price !== undefined && base !== undefined && history && history.length > 1 ? price - base : undefined;
  // Candles only exist for minutes with trades; carry the line to now at the live price.
  const points =
    history && history.length && livePrice !== undefined ? [...history, { t: Date.now(), price: livePrice }] : (history ?? []);
  const up = change === undefined || change >= 0;
  const c = scrub?.candle;

  return (
    <div>
      <div className="price-head">
        <div className="price-big num" aria-live="polite">
          {pct(price)}
          <span className="price-big-unit">chance</span>
        </div>
        <div className={`price-change num ${change === undefined ? 'muted' : up ? 'pos' : 'neg'}`}>
          {c ? (
            <span className="muted">
              {scrubTime(c.t, range.hours)} · O {cents(c.open)} H {cents(c.high)} L {cents(c.low)} C {cents(c.close)}
            </span>
          ) : change !== undefined ? (
            <>
              {up ? '▲' : '▼'} {Math.abs(Math.round(change * 100))} pts{' '}
              <span className="muted">{scrub ? scrubTime(scrub.t, range.hours) : range.label}</span>
            </>
          ) : (
            ' '
          )}
        </div>
      </div>
      {mode === 'candles' ? (
        candles ? (
          <PriceChart points={[]} candles={candles} onScrub={setScrub} />
        ) : (
          <div className="skeleton price-chart" />
        )
      ) : history ? (
        <PriceChart points={points} color={up ? 'var(--yes)' : 'var(--no)'} onScrub={setScrub} />
      ) : (
        <div className="skeleton price-chart" />
      )}
      <div className="chart-controls">
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
        <button
          className="icon-btn chart-mode"
          aria-label={mode === 'line' ? 'Show candles' : 'Show line'}
          title={mode === 'line' ? 'Candles' : 'Line'}
          aria-pressed={mode === 'candles'}
          onClick={() => setMode(mode === 'line' ? 'candles' : 'line')}
          data-testid="chart-mode"
        >
          <Icon name={mode === 'line' ? 'candles' : 'chart'} size={18} />
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ holdings

/** Shares held per market key and outcome, across every venue listing the question (read on-chain). */
function useAllHoldings(accountId: string | undefined, marketKeys: string[]) {
  const [held, setHeld] = useState<Record<string, Record<string, number>>>();
  const joined = marketKeys.join('|');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!accountId || !joined) return;
    let stale = false;
    const ks = joined.split('|');
    const load = () =>
      Promise.all(
        ks.map((k) =>
          fetchQuery(keys.holdings(accountId, k), () => api.predictionHoldings(accountId, k), 10_000)
            .then((h) => [k, h] as const)
            .catch(() => [k, {} as Record<string, number>] as const),
        ),
      ).then((rows) => !stale && setHeld(Object.fromEntries(rows)));
    void load();
    return () => {
      stale = true;
    };
  }, [accountId, joined, tick]);
  // Re-read when a trade writes optimistic holdings or invalidates them.
  useEffect(() => {
    const onTrade = () => setTick((t) => t + 1);
    window.addEventListener('predict:traded', onTrade);
    return () => window.removeEventListener('predict:traded', onTrade);
  }, []);
  return held;
}

/** Shares of one outcome held on each venue. */
const heldOn = (side: MarketSide, holdings: Record<string, Record<string, number>> | undefined) =>
  side.venues.map((v) => ({ v, shares: holdings?.[v.key]?.[v.outcome] ?? 0 })).filter((x) => x.shares >= 0.01);

/** What this wallet holds in the market across venues: shares, value at the best bid, one Sell. */
function YourPosition({
  market,
  sides,
  holdings,
  onSell,
}: {
  market: MarketDetail;
  sides: MarketSide[];
  holdings: Record<string, Record<string, number>>;
  onSell: (outcome: string) => void;
}) {
  const { account } = useWallet();
  // Average entry from Kairos positions, weighted across every venue the shares are on.
  const { data: positions } = usePositions(account?.evmAddress ? account.id : undefined);
  const rows = sides
    .map((s) => {
      const on = heldOn(s, holdings);
      const shares = on.reduce((a, x) => a + x.shares, 0);
      const value = on.reduce((a, x) => a + x.shares * (x.v.book?.bids[0]?.price ?? s.bestBid?.price ?? 0), 0);
      let costed = 0;
      let cost = 0;
      for (const { v, shares: held } of on) {
        const p = positions?.positions.find(
          (x) => x.state === 'open' && x.marketId === v.key && x.outcome.toLowerCase() === v.outcome.toLowerCase(),
        );
        if (p?.avgPrice === undefined) continue;
        costed += held;
        cost += held * p.avgPrice;
      }
      const avg = costed > 0 ? cost / costed : undefined;
      const pnl = avg !== undefined && value > 0 ? value - shares * avg : undefined;
      return { s, shares, value, avg, pnl };
    })
    .filter((r) => r.shares >= 0.01);
  if (!rows.length) return null;
  return (
    <div className="your-position" data-testid="your-position">
      <div className="section-label">Your position</div>
      {rows.map(({ s, shares, value, avg, pnl }) => (
        <div key={s.name} className="your-position-row">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="row" style={{ gap: 8 }}>
              <span className={`outcome-pill ${toneOf(market, s.name)}`}>{s.name}</span>
              <span className="num nowrap" style={{ fontWeight: 700 }}>
                {fmtShares(shares)} shares
              </span>
            </div>
            <div className="small muted num" style={{ marginTop: 3 }}>
              {avg !== undefined ? `Avg ${cents(avg)} · ` : ''}pays {usd(shares)} if {s.name} wins
            </div>
          </div>
          <div className="nowrap num" style={{ textAlign: 'right' }}>
            <div style={{ fontWeight: 750 }}>{value > 0 ? usd(value) : '—'}</div>
            {pnl !== undefined && (
              <div className={`small ${pnl >= 0 ? 'pos' : 'neg'}`} style={{ fontWeight: 650 }}>
                {pnl >= 0 ? '+' : '−'}${Math.abs(pnl).toFixed(2)}
              </div>
            )}
          </div>
          <button className="mini-btn strong" onClick={() => onSell(s.name)} data-testid="sell-held">
            Sell
          </button>
        </div>
      ))}
    </div>
  );
}

/** What a venue's first order also does, said before it's signed. */
function FirstOrderNotice({ venue }: { venue: Venue }) {
  return (
    <div className="notice" data-testid="first-order-setup">
      {venue === 'hyperliquid'
        ? "Your first Hyperliquid order also asks you to let Kairos place Hyperliquid trades for you. Kairos can only place and cancel trades: it can't withdraw or transfer, costs no gas, and you can revoke it on Hyperliquid at any time."
        : `Your first ${venueName(venue)} order also signs you in to ${venueName(venue)} and approves its contracts on BNB Chain. That's a one-time set of transactions from this wallet, paid in BNB.`}
    </div>
  );
}

// ------------------------------------------------------------------ trading

/** What each venue can spend now, and why one can't take a leg. */
function routeVenues(side: MarketSide, status: TradingStatus | undefined): RouteVenue[] {
  return side.venues.map((v) => {
    const vs = venueStatus(status, v.venue);
    const hold = venueHold(vs);
    const short = v.venue === 'polymarket' ? undefined : venueShortfall(vs);
    const unavailable = !status
      ? 'Checking your balance…'
      : !vs
        ? 'Not available to this wallet yet'
        : hold
          ? hold
          : v.venue === 'polymarket' && vs.next === 'setup'
            ? 'Set up first'
            : short?.gas
              ? shortfallText(v.venue, short)
              : undefined;
    return {
      venue: v.venue,
      key: v.key,
      outcome: v.outcome,
      tokenId: v.tokenId,
      asks: v.book?.asks ?? [],
      tick: v.tick,
      fee: v.fee,
      balance: Number(vs?.balance ?? 0) + perpsUsdc(vs),
      unavailable,
    };
  });
}

function TradePanel({
  market,
  sides,
  feed,
  holdings,
  onOpenBook,
  pick,
  sellRequest,
}: {
  market: MarketDetail;
  sides: MarketSide[];
  feed: FeedStatus;
  holdings?: Record<string, Record<string, number>>;
  onOpenBook: () => void;
  pick?: BookPick & { n: number };
  sellRequest?: { outcome: string; n: number };
}) {
  const { account } = useWallet();
  const accountId = account?.evmAddress ? account.id : undefined;
  const { data: status, reload } = useTradingStatus(accountId);
  const route = useRoute();
  const outcomes = market.tokens.map((t) => t.outcome);
  // Positions link here with ?side=sell&outcome=Yes to start a sell (or buy more) of that outcome.
  const [side, setSide] = useState<Side>(route.query.get('side') === 'sell' ? 'sell' : 'buy');
  const [outcome, setOutcome] = useState(
    outcomes.find((o) => o.toLowerCase() === route.query.get('outcome')?.toLowerCase()) ?? outcomes[0] ?? 'Yes',
  );
  const [kind, setKind] = useState<OrderKind>('market');
  const [tif, setTif] = useState<TimeInForce>('GTC');
  const [amount, setAmount] = useState('');
  const [priceCents, setPriceCents] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [venueOpen, setVenueOpen] = useState<Venue>();
  const [showRoute, setShowRoute] = useState(false);

  const sideData = sides.find((s) => s.name === outcome) ?? sides[0];
  const primary = sideData?.venues[0];
  const primaryVs = venueStatus(status, market.venue);
  const decimals = Math.max(0, Math.round(-Math.log10(market.tickSize)) - 2);
  const amt = Number(amount);

  // A level picked in the order book becomes a limit order at that price: asks → buy, bids → sell.
  const skipSeed = useRef(false);
  useEffect(() => {
    if (!pick) return;
    const next = market.tokens.find((t) => t.outcome.toLowerCase() === pick.outcome.toLowerCase())?.outcome ?? pick.outcome;
    skipSeed.current = next !== outcome || pick.side !== side || kind !== 'limit';
    setOutcome(next);
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
    setKind('market');
    setOutcome(sellRequest.outcome);
    const s = sides.find((x) => x.name === sellRequest.outcome);
    const h = s ? heldOn(s, holdings).reduce((a, x) => a + x.shares, 0) : 0;
    setAmount(h > 0 ? String(Math.floor(h * 100) / 100) : '');
    const input = document.getElementById('trade-amount');
    input?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    input?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sellRequest?.n]);

  // Seed the limit price from the primary market's quote whenever the outcome or side changes.
  useEffect(() => {
    if (skipSeed.current) {
      skipSeed.current = false;
      return;
    }
    const p = side === 'buy' ? primary?.book?.asks[0]?.price : primary?.book?.bids[0]?.price;
    if (p !== undefined) setPriceCents((roundToTick(p, market.tickSize) * 100).toFixed(decimals));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome, side, kind]);

  // ---- buy at market: routed across venues
  const rvs = useMemo(() => (sideData ? routeVenues(sideData, status) : []), [sideData, status]);
  const buyingPower = rvs.filter((v) => !v.unavailable).reduce((s, v) => s + (v.balance ?? 0), 0);
  const plan = useMemo(
    () => (side === 'buy' && kind === 'market' && amt > 0 ? planBuy(rvs, amt, { maxSlippage: MAX_SLIPPAGE }) : undefined),
    [rvs, side, kind, amt],
  );
  // What anyone could get, ignoring this wallet's balances: shown while it has no funds where the price is.
  const quote = useMemo(
    () =>
      side === 'buy' && kind === 'market' && amt > 0 ? planBuy(rvs, amt, { maxSlippage: MAX_SLIPPAGE, quote: true }) : undefined,
    [rvs, side, kind, amt],
  );
  /** The best single venue for the same money, to show what routing adds. */
  const single = useMemo(() => {
    if (!plan || plan.legs.length < 2) return undefined;
    return rvs
      .filter((v) => !v.unavailable)
      .map((v) => planBuy([v], amt, { maxSlippage: MAX_SLIPPAGE }))
      .sort((a, b) => b.shares - a.shares)[0];
  }, [plan, rvs, amt]);

  // ---- sell at market: where the shares are, best bid first
  const sellLegs = useMemo(() => {
    if (side !== 'sell' || kind !== 'market' || !sideData || !(amt > 0)) return undefined;
    let left = amt;
    const legs: { v: SideVenue; shares: number; avg: number; limit: number; proceeds: number }[] = [];
    for (const { v, shares } of heldOn(sideData, holdings).sort(
      (a, b) => (b.v.book?.bids[0]?.price ?? 0) - (a.v.book?.bids[0]?.price ?? 0),
    )) {
      if (left <= 1e-9 || !v.book?.bids.length) continue;
      const step = v.venue === 'hyperliquid' ? 1 : 0.01;
      const take = Math.floor(Math.min(shares, left) / step + 1e-9) * step;
      const fill = take > 0 ? walkBook(v.book, 'sell', take, MAX_SLIPPAGE) : undefined;
      if (!fill) continue;
      const limit = marketLimitPrice('sell', fill, v.book.bids[0].price, v.tick, MAX_SLIPPAGE);
      const sold = Math.floor(fill.shares / step + 1e-9) * step;
      legs.push({ v, shares: sold, avg: fill.avgPrice, limit, proceeds: sold * fill.avgPrice });
      left -= sold;
    }
    return legs;
  }, [side, kind, sideData, holdings, amt]);
  const heldTotal = sideData ? heldOn(sideData, holdings).reduce((a, x) => a + x.shares, 0) : 0;

  // ---- limit: on the opened market
  const limitPrice = Number(priceCents) / 100;
  const primaryHeld = primary ? (holdings?.[primary.key]?.[primary.outcome] ?? 0) : 0;
  const limitShares =
    side === 'buy'
      ? limitPrice > 0
        ? Math.floor(amt / limitPrice / (market.venue === 'hyperliquid' ? 1 : 0.01) + 1e-9) *
          (market.venue === 'hyperliquid' ? 1 : 0.01)
        : 0
      : amt;
  const primaryBalance = Number(primaryVs?.balance ?? 0) + perpsUsdc(primaryVs);

  const notices = useMemo(
    () => (kind === 'market' && side === 'sell' && primary?.book ? liquidityNotices(primary.book, side, amt, MAX_SLIPPAGE) : []),
    [kind, side, primary?.book, amt],
  );

  /** A venue that could take the buy (set up, funded) hasn't streamed its book yet. */
  const fundedLoading = rvs.some(
    (v) =>
      !v.unavailable && (v.balance ?? 0) > 0 && !v.asks.length && sideData?.venues.find((x) => x.key === v.key)?.feed !== 'live',
  );

  let problem: string | undefined;
  if (amount && !(amt > 0)) problem = 'Enter an amount';
  else if (kind === 'limit') {
    if (priceCents && !(limitPrice > 0 && limitPrice < 1)) problem = 'Price must be between 1¢ and 99¢';
    else if (priceCents && Math.abs(limitPrice / market.tickSize - Math.round(limitPrice / market.tickSize)) > 1e-6)
      problem = `Price must be in steps of ${market.tickSize * 100}¢`;
    else if (side === 'buy' && amt > primaryBalance) problem = `More than you can spend on this market (${usd(primaryBalance)})`;
    else if (side === 'sell' && amt > primaryHeld + 1e-9)
      problem =
        primaryHeld > 0 ? `You can sell up to ${fmtShares(primaryHeld)} at a limit here` : `You don't hold ${outcome} here`;
  } else if (side === 'buy' && amt > 0) {
    if ((feed !== 'live' || fundedLoading) && !plan?.legs.length)
      problem = feed === 'waiting' ? 'Live prices are unavailable right now. Use a limit order.' : 'Getting live prices…';
    else if (amt > buyingPower + 1e-9 && buyingPower > 0) problem = `More than your buying power (${usd(buyingPower)})`;
    else if (plan && !plan.legs.length && quote?.legs.length)
      problem = undefined; // shown as a funding notice below
    else if (plan && !plan.legs.length) problem = plan.skipped[0]?.reason ?? 'No sellers near the current price';
  } else if (side === 'sell' && amt > 0) {
    if (amt > heldTotal + 1e-9)
      problem = heldTotal > 0 ? `You hold ${fmtShares(heldTotal)} ${outcome} shares` : `You don't hold any ${outcome} shares`;
    else if (!sellLegs?.length) problem = feed === 'live' ? 'No buyers near the current price' : 'Getting live prices…';
  }

  // Only when nothing funded can take it: a funded venue whose book is still loading is "getting prices", not "add funds".
  const needsFunds =
    side === 'buy' && kind === 'market' && amt > 0 && !!plan && !plan.legs.length && !!quote?.legs.length && !fundedLoading;
  // The opened market's own venue: what it needs before it can trade.
  const polymarket = market.venue === 'polymarket';
  const hold = venueHold(primaryVs);
  const short = polymarket ? undefined : venueShortfall(primaryVs);
  const venueProblem = !status
    ? undefined
    : !primaryVs
      ? `This Kairos node doesn't trade ${venueName(market.venue)} yet. You can still follow the market here.`
      : hold
        ? hold
        : polymarket && primaryVs.next === 'setup'
          ? 'Set up prediction trading first.'
          : short && (short.gas || side === 'buy')
            ? short.gas && !short.collateral
              ? `You have ${usd(primaryBalance)} ${VENUE_INFO[market.venue].currency}. ${shortfallText(market.venue, short)}`
              : shortfallText(market.venue, short)
            : polymarket && primaryVs.next === 'fund' && side === 'buy'
              ? 'Add pUSD to your trading balance first.'
              : undefined;
  // Another venue listing the same question can take a market buy: routing sends it there.
  const elsewhere =
    side === 'buy' && kind === 'market' && rvs.some((v) => v.key !== market.marketId && !v.unavailable && (v.balance ?? 0) > 0);
  const notReady = !account?.evmAddress
    ? 'Switch to an account with an EVM address to trade.'
    : market.status !== 'open'
      ? 'This market is closed for trading.'
      : elsewhere
        ? undefined
        : venueProblem;
  const fixable =
    !!primaryVs && !hold && (primaryVs.next === 'setup' ? polymarket : primaryVs.next === 'fund' && (polymarket || !!short));

  const shown = plan?.legs.length ? plan : quote;
  const sellProceeds = sellLegs?.reduce((s, l) => s + l.proceeds, 0) ?? 0;
  const sellShares = sellLegs?.reduce((s, l) => s + l.shares, 0) ?? 0;
  const ready =
    !notReady &&
    !problem &&
    amt > 0 &&
    (kind === 'limit' ? limitShares > 0 : side === 'buy' ? !!plan?.legs.length : !!sellLegs?.length);
  const quick = side === 'buy' ? [5, 20, 100] : [];

  return (
    <div className="trade stack" style={{ gap: 14 }}>
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
        {sides.map((s) => {
          const p = side === 'buy' ? (kind === 'market' ? s.bestAsk?.allIn : s.venues[0].book?.asks[0]?.price) : s.bestBid?.price;
          return (
            <button
              key={s.name}
              className={`outcome-btn ${toneOf(market, s.name)} ${outcome === s.name ? 'selected' : ''}`}
              onClick={() => setOutcome(s.name)}
              aria-pressed={outcome === s.name}
            >
              <span className="ellipsis">{s.name}</span>
              <span className="outcome-price num">{cents(p ?? market.tokens[s.index]?.price)}</span>
            </button>
          );
        })}
      </div>

      <div>
        <div className="row small" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
          <label htmlFor="trade-amount" className="muted" style={{ fontWeight: 650 }}>
            {side === 'buy' ? 'Amount' : 'Shares'}
          </label>
          {side === 'buy' && status && (
            <span className="muted num">
              {kind === 'market' ? `Buying power ${usd(buyingPower)}` : `Available ${usd(primaryBalance)}`}
            </span>
          )}
          {side === 'sell' && heldTotal > 0 && (
            <span className="muted num">
              You hold {fmtShares(heldTotal)} {outcome}
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
        {side === 'buy' ? (
          <div className="quick-amounts">
            {quick.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setAmount(String(Math.round(((Number(amount) || 0) + q) * 100) / 100))}
              >
                +${q}
              </button>
            ))}
            <button
              type="button"
              disabled={!((kind === 'market' ? buyingPower : primaryBalance) > 0)}
              onClick={() => setAmount(String(Math.floor((kind === 'market' ? buyingPower : primaryBalance) * 100) / 100))}
            >
              Max
            </button>
          </div>
        ) : (
          heldTotal > 0 && (
            <div className="quick-amounts">
              {[0.25, 0.5, 1].map((f) => (
                <button key={f} type="button" onClick={() => setAmount(String(Math.floor(heldTotal * f * 100) / 100))}>
                  {f === 1 ? 'Max' : `${f * 100}%`}
                </button>
              ))}
            </div>
          )
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

      {/* The estimate updates in place as the books move; nothing jumps. */}
      {amt > 0 && !problem && (
        <div className="trade-summary" data-testid="trade-summary">
          {side === 'buy' && kind === 'market' && shown && shown.legs.length > 0 && (
            <>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span>Pays if {outcome} wins</span>
                <span className="trade-win num">{usd(shown.shares)}</span>
              </div>
              <div className="small muted num">
                {fmtShares(shown.shares)} shares · avg {cents(shown.avgPrice)} incl. fees · cost {usd(shown.spend)}
              </div>
              {shown.legs.filter((l) => l.shares > 0).length > 1 && (
                <button
                  type="button"
                  className="route-chip"
                  onClick={() => setShowRoute(!showRoute)}
                  aria-expanded={showRoute}
                  data-testid="route-chip"
                >
                  <Icon name="route" size={14} />
                  Best price across {shown.legs.filter((l) => l.shares > 0).length} markets
                  {single && plan && plan.shares - single.shares >= 0.01 && (
                    <span className="pos"> · +{fmtShares(plan.shares - single.shares)} shares</span>
                  )}
                </button>
              )}
              {showRoute && <RouteBreakdown plan={shown} />}
            </>
          )}
          {side === 'sell' && kind === 'market' && sellLegs && sellLegs.length > 0 && (
            <>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span>You receive</span>
                <span className="trade-win num">{usd(sellProceeds)}</span>
              </div>
              <div className="small muted num">
                {fmtShares(sellShares)} shares · avg {cents(sellShares ? sellProceeds / sellShares : undefined)}
              </div>
            </>
          )}
          {kind === 'limit' && limitShares > 0 && (
            <>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span>{side === 'buy' ? `Pays if ${outcome} wins` : 'You receive'}</span>
                <span className="trade-win num">{usd(side === 'buy' ? limitShares : limitShares * limitPrice)}</span>
              </div>
              <div className="small muted num">
                {fmtShares(limitShares)} shares at {cents(limitPrice)}
                {side === 'buy' ? ` · cost ${usd(limitShares * limitPrice)}` : ''}
              </div>
            </>
          )}
        </div>
      )}
      <LiquidityNotices notices={notices} />
      {problem && amount && <div className="small neg">{problem}</div>}
      {needsFunds && (
        <div className="notice">
          Add funds to buy at {cents(quote!.avgPrice)}.{' '}
          <button className="link-btn" onClick={() => setVenueOpen(quote?.legs.find((l) => l.shares > 0)?.venue ?? market.venue)}>
            Add funds
          </button>
        </div>
      )}
      {notReady ? (
        <div className="notice">
          {notReady}{' '}
          {notReady === venueProblem && fixable && (
            <button className="link-btn" onClick={() => setVenueOpen(market.venue)}>
              {primaryVs?.next === 'setup' ? 'Set up' : 'Add funds'}
            </button>
          )}
        </div>
      ) : (
        <Button
          variant="dark"
          block
          className={`trade-cta ${toneOf(market, outcome)}`}
          disabled={!ready}
          onClick={() => setConfirming(true)}
          data-testid="review-order"
        >
          {side === 'buy' ? `Buy ${outcome}` : `Sell ${outcome}`}
        </Button>
      )}
      <button type="button" className="book-strip" onClick={onOpenBook}>
        <span className={`live-dot ${feed}`} aria-hidden="true" />
        <span className="muted">{feed === 'live' ? 'Live prices' : feed === 'waiting' ? 'Prices delayed' : 'Connecting…'}</span>
        <span className="spacer" />
        <span className="link-btn small row nowrap" style={{ gap: 4, flexShrink: 0 }}>
          <Icon name="book" size={14} /> Order book
        </span>
      </button>
      {venueOpen && account && status && (
        <VenueSheet
          venue={venueOpen}
          status={status}
          accountId={account.id}
          onChange={async () => void (await reload())}
          onClose={() => setVenueOpen(undefined)}
        />
      )}
      {confirming && account && side === 'buy' && kind === 'market' && plan && (
        <RouteSheet
          accountId={account.id}
          market={market}
          outcome={outcome}
          plan={plan}
          setupVenues={plan.legs
            .filter((l) => l.shares > 0 && l.venue !== 'polymarket' && venueStatus(status, l.venue)?.next === 'setup')
            .map((l) => l.venue)}
          onClose={() => setConfirming(false)}
          onDone={() => setAmount('')}
        />
      )}
      {confirming && account && (side === 'sell' || kind === 'limit') && (
        <OrderSheet
          accountId={account.id}
          market={market}
          tone={toneOf(market, outcome)}
          orders={
            kind === 'limit'
              ? [
                  {
                    key: market.marketId,
                    venue: market.venue,
                    outcome: primary?.outcome ?? outcome,
                    side,
                    price: limitPrice,
                    size: limitShares,
                    timeInForce: tif,
                  },
                ]
              : (sellLegs ?? []).map((l) => ({
                  key: l.v.key,
                  venue: l.v.venue,
                  outcome: l.v.outcome,
                  side,
                  price: l.limit,
                  size: l.shares,
                  timeInForce: 'FAK' as TimeInForce,
                  avg: l.avg,
                }))
          }
          kind={kind}
          outcome={outcome}
          setupVenues={[
            ...new Set(
              (kind === 'limit' ? [market.venue] : (sellLegs ?? []).map((l) => l.v.venue)).filter(
                (v) => v !== 'polymarket' && venueStatus(status, v)?.next === 'setup',
              ),
            ),
          ]}
          notices={notices.filter((n) => n.level === 'danger')}
          onClose={() => setConfirming(false)}
          onDone={() => setAmount('')}
        />
      )}
    </div>
  );
}

/** Where the order goes: each market's share, at its average. */
function RouteBreakdown({ plan }: { plan: RoutePlan }) {
  const legs = plan.legs.filter((l) => l.shares > 0);
  return (
    <div className="route-breakdown" data-testid="route-breakdown">
      {legs.map((l) => (
        <div key={l.venue} className="route-leg">
          <span className="route-bar" style={{ width: `${Math.max(6, (l.delivered / plan.shares) * 100)}%` }} />
          <span className="route-leg-text">
            <span className="num">{fmtShares(l.delivered)} sh</span>
            <span className="muted"> at {cents(l.avgPrice)}</span>
          </span>
          <span className="muted small">{venueName(l.venue)}</span>
        </div>
      ))}
      <div className="small muted">
        The same question is listed on several markets. Your buy fills the cheapest shares first, fees included, as separate
        orders.
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ confirm and execute

/** Applies a finished trade to what's on screen at once; the next refresh confirms it. */
function applyTrade(accountId: string, legs: { key: string; outcome: string; shares: number; side: Side }[]) {
  for (const l of legs) {
    if (!(l.shares > 0)) continue;
    setQueryData<Record<string, number>>(keys.holdings(accountId, l.key), (h) =>
      h ? { ...h, [l.outcome]: Math.max(0, (h[l.outcome] ?? 0) + (l.side === 'buy' ? l.shares : -l.shares)) } : h,
    );
  }
  window.dispatchEvent(new Event('predict:traded'));
  // Fills settle on-chain over the next seconds: re-read then, and once more.
  for (const ms of [4_000, 15_000])
    setTimeout(() => (invalidateAfterTrade(accountId), window.dispatchEvent(new Event('predict:traded'))), ms);
}

const LEG_LABEL: Record<RouteLegResult['status'], string> = {
  filled: 'Filled',
  partial: 'Partly filled',
  working: 'Confirming',
  failed: 'Not filled',
  unknown: 'Unconfirmed',
  skipped: 'Skipped',
};

function RouteSheet({
  accountId,
  market,
  outcome,
  plan,
  setupVenues,
  onClose,
  onDone,
}: {
  accountId: string;
  market: MarketDetail;
  outcome: string;
  plan: RoutePlan;
  /** Venues whose first order this is: it also runs their one-time setup. */
  setupVenues: Venue[];
  onClose: () => void;
  onDone: () => void;
}) {
  // The plan is frozen when the sheet opens: what the user reviews is what gets signed.
  const [frozen] = useState(plan);
  const legs = frozen.legs.filter((l) => l.shares > 0);
  const bounds = routeBounds(frozen);
  const [phase, setPhase] = useState<'review' | 'sending' | 'done'>('review');
  const [result, setResult] = useState<RouteExecution>();
  const [error, setError] = useState<string>();
  const outcomeOf = (key: string) => legs.find((l) => l.key === key)?.outcome ?? outcome;

  const submit = async () => {
    setPhase('sending');
    setError(undefined);
    try {
      const r = await api.predictionRoutedBuy(accountId, {
        marketId: market.marketId,
        outcome,
        legs: legs.map((l) => ({ key: l.key, price: l.limitPrice, size: l.shares })),
        maxPrice: bounds.maxPrice,
        shares: frozen.shares,
      });
      setResult(r);
      setPhase('done');
      applyTrade(
        accountId,
        r.legs.map((l) => ({ key: l.key, outcome: outcomeOf(l.key), shares: l.filled ?? 0, side: 'buy' })),
      );
      onDone();
    } catch (e) {
      const msg = (e as Error).message;
      setError(/outcome unknown|not confirmed/i.test(msg) ? `${msg}. Check your orders before trying again.` : msg);
      setPhase('review');
    }
  };

  if (phase !== 'review' && (result || phase === 'sending')) {
    const filled = result?.filled ?? 0;
    const working = result?.legs.some((l) => l.status === 'working');
    return (
      <Sheet title="" onClose={onClose}>
        <div className="stack execution" style={{ gap: 14 }} data-testid="order-result">
          <div className={`exec-hero ${phase}`}>
            <span className="exec-mark" aria-hidden>
              {phase === 'sending' ? <Spinner size={22} /> : <Icon name="check" size={24} />}
            </span>
            <div>
              <div className="exec-title">
                {phase === 'sending'
                  ? `Buying ${outcome}…`
                  : filled > 0
                    ? `Bought ${fmtShares(filled)} ${outcome}`
                    : working
                      ? 'Order sent'
                      : 'Order placed'}
              </div>
              <div className="small muted">
                {phase === 'sending'
                  ? legs.length > 1
                    ? `Signing ${legs.length} orders, cheapest first`
                    : 'Signing and sending'
                  : working
                    ? 'Some fills are still confirming on-chain.'
                    : result?.uncertain
                      ? 'An order may still be live. Check your orders before buying again.'
                      : 'Shares show up in your position as they settle.'}
              </div>
            </div>
          </div>
          <div className="exec-legs">
            {(result?.legs ?? legs.map((l) => ({ venue: l.venue, key: l.key, size: l.shares, status: 'sending' as const }))).map(
              (l, i) => (
                <div key={`${l.key}-${i}`} className={`exec-leg ${l.status}`}>
                  <span className="exec-leg-dot" aria-hidden>
                    {l.status === 'sending' ? <Spinner size={12} /> : null}
                  </span>
                  <span className="num" style={{ flex: 1 }}>
                    {'filled' in l && l.filled !== undefined
                      ? `${fmtShares(l.filled)} of ${fmtShares(l.size)}`
                      : fmtShares(l.size)}{' '}
                    shares
                    <span className="muted small"> · {venueName(l.venue)}</span>
                  </span>
                  <span className="small">{l.status === 'sending' ? '' : LEG_LABEL[l.status]}</span>
                </div>
              ),
            )}
          </div>
          {phase === 'done' && (
            <div className="row" style={{ gap: 8 }}>
              <Button variant="secondary" style={{ flex: 1 }} onClick={() => navigate('/predict', { tab: 'orders' })}>
                View orders
              </Button>
              <Button style={{ flex: 1 }} onClick={onClose}>
                Done
              </Button>
            </div>
          )}
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title={`Buy ${outcome}`} onClose={onClose}>
      <div className="stack" style={{ gap: 14 }}>
        <div className="review-hero">
          <div className="small muted">Pays if {outcome} wins</div>
          <div className="review-amount num">{usd(frozen.shares)}</div>
          <div className="small muted num">
            {fmtShares(frozen.shares)} shares for {usd(frozen.spend)} · avg {cents(frozen.avgPrice)}
          </div>
        </div>
        <div className="panel">
          <div className="kv">
            <span>Market</span>
            <span>{market.title}</span>
          </div>
          {legs.map((l) => (
            <div className="kv" key={l.key}>
              <span>{legs.length > 1 ? `Order on ${venueName(l.venue)}` : 'Order'}</span>
              <span className="num">
                {fmtShares(l.shares)} @ up to {cents(l.limitPrice)}
              </span>
            </div>
          ))}
          <div className="kv">
            <span>Fees (est.)</span>
            <span className="num">{usd(legs.reduce((s, l) => s + l.fee, 0))}</span>
          </div>
          <div className="kv">
            <span>Most you'll pay</span>
            <span className="num">{cents(bounds.maxPrice)} a share</span>
          </div>
        </div>
        {setupVenues.map((v) => (
          <FirstOrderNotice key={v} venue={v} />
        ))}
        <div className="small muted">
          Fills now at the best prices available; anything that can't fill at your limit is cancelled. Each order is signed by
          this wallet and checked against this plan before signing.
        </div>
        <ErrorNote error={error} />
        <Button variant="dark" className={`trade-cta ${toneOf(market, outcome)}`} onClick={submit} data-testid="place-order">
          Confirm buy
        </Button>
      </div>
    </Sheet>
  );
}

interface SimpleOrder {
  key: string;
  venue: Venue;
  outcome: string;
  side: Side;
  price: number;
  size: number;
  timeInForce: TimeInForce;
  avg?: number;
}

/** Limit orders, and market sells (one per venue the shares are on). */
function OrderSheet({
  accountId,
  market,
  tone,
  orders,
  kind,
  outcome,
  setupVenues,
  notices,
  onClose,
  onDone,
}: {
  accountId: string;
  market: MarketDetail;
  tone: 'yes' | 'no';
  orders: SimpleOrder[];
  kind: OrderKind;
  outcome: string;
  setupVenues: Venue[];
  notices: LiquidityNotice[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [frozen] = useState(orders);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<{ status: string; filled?: number }[]>();
  const side = frozen[0]?.side ?? 'sell';
  const verb = side === 'buy' ? 'Buy' : 'Sell';
  const size = frozen.reduce((s, o) => s + o.size, 0);
  const value = frozen.reduce((s, o) => s + o.size * (o.avg ?? o.price), 0);

  if (done) {
    return (
      <Sheet title="" onClose={onClose}>
        <div className="stack execution" style={{ gap: 14 }} data-testid="order-result">
          <div className="exec-hero done">
            <span className="exec-mark" aria-hidden>
              <Icon name="check" size={24} />
            </span>
            <div>
              <div className="exec-title">
                {kind === 'limit'
                  ? 'Order placed'
                  : `${side === 'buy' ? 'Bought' : 'Sold'} ${fmtShares(done.reduce((s, d) => s + (d.filled ?? 0), 0) || size)} ${outcome}`}
              </div>
              <div className="small muted">Status: {done.map((d) => d.status).join(', ')}</div>
            </div>
          </div>
          <Button onClick={() => navigate('/predict', { tab: 'orders' })}>View orders</Button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title={`${verb} ${outcome}`} onClose={onClose}>
      <div className="stack" style={{ gap: 14 }}>
        <div className="review-hero">
          <div className="small muted">{side === 'buy' ? `Pays if ${outcome} wins` : 'You receive (est.)'}</div>
          <div className="review-amount num">{usd(side === 'buy' ? size : value)}</div>
          <div className="small muted num">
            {fmtShares(size)} shares{' '}
            {kind === 'limit' ? `at ${cents(frozen[0]?.price)}` : `· avg ${cents(size ? value / size : undefined)}`}
          </div>
        </div>
        <div className="panel">
          <div className="kv">
            <span>Market</span>
            <span>{market.title}</span>
          </div>
          {frozen.map((o) => (
            <div className="kv" key={o.key}>
              <span>
                {frozen.length > 1
                  ? `Order on ${venueName(o.venue)}`
                  : kind === 'limit'
                    ? 'Limit price'
                    : side === 'buy'
                      ? 'Worst price accepted'
                      : 'Lowest price accepted'}
              </span>
              <span className="num">{frozen.length > 1 ? `${fmtShares(o.size)} @ ${cents(o.price)}` : cents(o.price)}</span>
            </div>
          ))}
          <div className="kv">
            <span>{side === 'buy' ? 'Est. cost' : 'Est. proceeds'}</span>
            <span className="num">
              {usd(side === 'buy' ? frozen.reduce((s, o) => s + o.size * o.price, 0) : value)}{' '}
              {[...new Set(frozen.map((o) => VENUE_INFO[o.venue].currency))].join('/')}
            </span>
          </div>
          <div className="kv">
            <span>Type</span>
            <span>
              {kind === 'market'
                ? 'Market, fills now; any unfilled part is cancelled'
                : frozen[0].timeInForce === 'GTC'
                  ? market.venue === 'predictfun'
                    ? 'Limit, open until filled or cancelled (up to about a day)'
                    : 'Limit, open until filled or cancelled'
                  : frozen[0].timeInForce === 'FAK'
                    ? 'Limit, fills what it can now; the rest is cancelled'
                    : 'Limit, fill now or cancel'}
            </span>
          </div>
        </div>
        <LiquidityNotices notices={notices} />
        {setupVenues.map((v) => (
          <FirstOrderNotice key={v} venue={v} />
        ))}
        <div className="small muted">
          Signed by this wallet. Placing and cancelling orders costs no gas; venue fees may apply.
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
            const results: { status: string; filled?: number }[] = [];
            const applied: { key: string; outcome: string; shares: number; side: Side }[] = [];
            try {
              for (const o of frozen) {
                const r = await api.predictionOrder(accountId, {
                  marketId: o.key,
                  outcome: o.outcome,
                  side: o.side,
                  price: String(o.price),
                  size: String(o.size),
                  timeInForce: o.timeInForce,
                });
                const filled = r.filledSize ? Number(r.filledSize) : undefined;
                results.push({ status: r.status, filled });
                if (filled) applied.push({ key: o.key, outcome: o.outcome, shares: filled, side: o.side });
              }
              setDone(results);
              applyTrade(accountId, applied);
              onDone();
            } catch (e) {
              const msg = (e as Error).message;
              // Earlier orders in a multi-venue sell went through: say so, and keep what they did.
              if (results.length) {
                applyTrade(accountId, applied);
                setError(`${results.length} of ${frozen.length} orders went through. ${msg}`);
              } else {
                // The API may not know whether a failed call reached the venue; tell the user to check before retrying.
                setError(
                  /outcome unknown|not confirmed/i.test(msg) ? `${msg}. Check your open orders before trying again.` : msg,
                );
              }
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

// ------------------------------------------------------------------ rules and resolution

const EVENT_LABEL: Record<string, string> = {
  initialized: 'Market created',
  price_requested: 'Result requested',
  proposed: 'Result proposed',
  proposal: 'Result proposed',
  disputed: 'Disputed',
  dispute: 'Disputed',
  reset: 'Reset for a new proposal',
  settled: 'Settled',
  resolved: 'Resolved',
};

function ResolvedBanner({ market }: { market: MarketDetail }) {
  const { data } = useResolution(market.status !== 'open' ? market.marketId : undefined);
  if (!data) return null;
  const d = describeResolution(market, data.resolution);
  if (d.stage === 'open') return null;
  return (
    <div className={`resolve-banner ${d.stage}`} data-testid="resolution-banner">
      <Icon name={d.stage === 'resolved' ? 'check' : 'clock'} size={16} />
      <div>
        <div style={{ fontWeight: 700 }}>{d.title}</div>
        {d.detail && <div className="small">{d.detail}</div>}
      </div>
    </div>
  );
}

function About({ market }: { market: MarketDetail }) {
  const { data: rules } = useRules(market.marketId);
  const { data: res } = useResolution(market.marketId);
  const [more, setMore] = useState(false);
  const d = res && describeResolution(market, res.resolution);
  const events = (res?.events ?? []).filter((e: ResolutionEvent) => EVENT_LABEL[e.type]);
  return (
    <section className="about stack" style={{ gap: 12 }}>
      <div className="section-label">About</div>
      {d && (
        <div className={`resolve-status ${d.stage}`} data-testid="resolution-status">
          <div className="row" style={{ gap: 8 }}>
            <span className={`resolve-dot ${d.stage}`} aria-hidden />
            <span style={{ fontWeight: 700 }}>{d.title}</span>
          </div>
          {d.detail && (
            <div className="small muted" style={{ marginLeft: 16 }}>
              {d.detail}
            </div>
          )}
          {d.stage !== 'open' && events.length > 1 && (
            <ol className="timeline">
              {events.map((e, i) => (
                <li key={`${e.type}-${i}`}>
                  <span>{EVENT_LABEL[e.type]}</span>
                  <span className="muted num">
                    {new Date(e.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      {rules?.description && (
        <div>
          <div className="small muted" style={{ fontWeight: 650, marginBottom: 4 }}>
            Rules
          </div>
          <p className={`rules ${more ? 'open' : ''}`} data-testid="market-rules">
            {rules.description}
          </p>
          {rules.description.length > 220 && (
            <button className="link-btn small" onClick={() => setMore(!more)}>
              {more ? 'Show less' : 'Read more'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
