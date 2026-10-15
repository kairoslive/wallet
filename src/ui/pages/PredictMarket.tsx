import { useEffect, useMemo, useState } from 'react';
import type { MarketDetail, OrderResult, PricePoint, TimeInForce } from '../../core/predictions/types';
import { api } from '../lib/api';
import { navigate, useRoute } from '../lib/router';
import { useWallet } from '../lib/store';
import { Button, ErrorNote, Field, Screen, Sheet, Spinner, TopBar } from '../components/ui';
import { PriceChart } from '../components/PriceChart';
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
  // Fall back to the last chart point when the token has no recent trade mark.
  const yesPrice = yes?.price ?? history?.at(-1)?.price;

  return (
    <Screen>
      <TopBar title="Market" />
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
          {history ? <PriceChart points={history} /> : <div className="skeleton price-chart" />}
        </div>

        <TradePanel market={market} yesPrice={yesPrice} />
      </div>
    </Screen>
  );
}

function roundToTick(p: number, tick: number) {
  const r = Math.round(p / tick) * tick;
  return Math.min(1 - tick, Math.max(tick, r));
}

function TradePanel({ market, yesPrice }: { market: MarketDetail; yesPrice?: number }) {
  const { account } = useWallet();
  const { status, reload } = usePredictionStatus(account?.evmAddress ? account.id : undefined);
  const outcomes = market.tokens.map((t) => t.outcome);
  const [side, setSide] = useState<Side>('buy');
  const [outcome, setOutcome] = useState(outcomes[0] ?? 'Yes');
  const [tif, setTif] = useState<TimeInForce>('GTC');
  const [amount, setAmount] = useState('');
  const [confirming, setConfirming] = useState(false);

  const tokenPrice = useMemo(() => {
    const t = market.tokens.find((x) => x.outcome === outcome);
    if (t?.price !== undefined) return t.price;
    if (yesPrice === undefined) return undefined;
    return outcome.toLowerCase() === 'no' ? 1 - yesPrice : yesPrice;
  }, [market, outcome, yesPrice]);
  const decimals = Math.max(0, Math.round(-Math.log10(market.tickSize)) - 2);
  const [priceCents, setPriceCents] = useState('');
  useEffect(() => {
    if (tokenPrice !== undefined) setPriceCents((roundToTick(tokenPrice, market.tickSize) * 100).toFixed(decimals));
  }, [tokenPrice, market.tickSize, decimals]);

  const price = Number(priceCents) / 100;
  const amt = Number(amount);
  // Buy: amount is pUSD to spend. Sell: amount is shares.
  const shares = side === 'buy' ? (price > 0 ? Math.floor((amt / price) * 100) / 100 : 0) : amt;
  const cost = shares * price;
  const balance = Number(status?.balance ?? 0);

  let problem: string | undefined;
  if (amount && !(amt > 0)) problem = 'Enter an amount';
  else if (priceCents && !(price > 0 && price < 1)) problem = 'Price must be between 1¢ and 99¢';
  else if (priceCents && Math.abs(price / market.tickSize - Math.round(price / market.tickSize)) > 1e-6)
    problem = `Price must be in steps of ${market.tickSize * 100}¢`;
  else if (side === 'buy' && amt > balance) problem = 'More than your trading balance';

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
          const t = market.tokens[i];
          const p = t.price ?? (yesPrice === undefined ? undefined : o.toLowerCase() === 'no' ? 1 - yesPrice : yesPrice);
          const cls = o.toLowerCase() === 'no' || i === 1 ? 'no' : 'yes';
          return (
            <button key={o} className={`outcome-btn ${cls} ${outcome === o ? 'selected' : ''}`} onClick={() => setOutcome(o)}>
              {o} {cents(p)}
            </button>
          );
        })}
      </div>
      <div className="row" style={{ gap: 10 }}>
        <Field label={side === 'buy' ? 'Amount (pUSD)' : 'Shares'} htmlFor="trade-amount">
          <input
            id="trade-amount"
            className="input num"
            inputMode="decimal"
            placeholder="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
          />
        </Field>
        <Field label="Limit price (¢)" htmlFor="trade-price">
          <input
            id="trade-price"
            className="input num"
            inputMode="decimal"
            value={priceCents}
            onChange={(e) => setPriceCents(e.target.value.replace(/[^0-9.]/g, ''))}
          />
        </Field>
      </div>
      <div className="segmented" aria-label="Order type">
        <button className={tif === 'GTC' ? 'active' : ''} onClick={() => setTif('GTC')}>
          Limit
        </button>
        <button className={tif === 'FOK' ? 'active' : ''} onClick={() => setTif('FOK')}>
          Fill now or cancel
        </button>
      </div>
      {amt > 0 && price > 0 && !problem && (
        <div className="panel">
          <div className="kv">
            <span>Shares</span>
            <span className="num">{shares.toLocaleString()}</span>
          </div>
          <div className="kv">
            <span>{side === 'buy' ? 'Cost' : 'You receive'}</span>
            <span className="num">${cost.toFixed(2)}</span>
          </div>
          {side === 'buy' && (
            <div className="kv">
              <span>Payout if {outcome} wins</span>
              <span className="num pos">${shares.toFixed(2)}</span>
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
        <Button disabled={!amt || !!problem || !(shares > 0)} onClick={() => setConfirming(true)} data-testid="review-order">
          Review order
        </Button>
      )}
      {confirming && account && (
        <ConfirmOrder
          accountId={account.id}
          market={market}
          order={{ side, outcome, price: String(price), size: String(shares), timeInForce: tif, cost }}
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
  order: { side: Side; outcome: string; price: string; size: string; timeInForce: TimeInForce; cost: number };
  onClose: () => void;
  onPlaced: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<OrderResult>();

  if (result) {
    return (
      <Sheet title="Order placed" onClose={onClose}>
        <div className="stack">
          <div className="result" data-testid="order-result">
            <div className="ink2">
              {order.side === 'buy' ? 'Buying' : 'Selling'} {Number(order.size).toLocaleString()} {order.outcome} at{' '}
              {cents(Number(order.price))}
            </div>
            <div className="small muted">Status: {result.status}</div>
          </div>
          <Button onClick={() => navigate('/predict', { tab: 'orders' })}>View orders</Button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title="Confirm order" onClose={onClose}>
      <div className="stack">
        <div className="panel">
          <div className="kv">
            <span>Market</span>
            <span>{market.title}</span>
          </div>
          <div className="kv">
            <span>Order</span>
            <span>
              {order.side === 'buy' ? 'Buy' : 'Sell'} {order.outcome}
            </span>
          </div>
          <div className="kv">
            <span>Shares</span>
            <span className="num">{Number(order.size).toLocaleString()}</span>
          </div>
          <div className="kv">
            <span>Limit price</span>
            <span className="num">{cents(Number(order.price))}</span>
          </div>
          <div className="kv">
            <span>{order.side === 'buy' ? 'Max cost' : 'Min proceeds'}</span>
            <span className="num">${order.cost.toFixed(2)} pUSD</span>
          </div>
          <div className="kv">
            <span>Type</span>
            <span>{order.timeInForce === 'GTC' ? 'Limit, stays open until filled or cancelled' : 'Fill now or cancel'}</span>
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
          Place order
        </Button>
      </div>
    </Sheet>
  );
}
