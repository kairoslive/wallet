import { useState } from 'react';
import type { BookState, BookLevel } from '../../core/predictions/orderbook';
import type { MarketDetail } from '../../core/predictions/types';
import type { FeedStatus } from './useOrderbook';
import { Sheet, Spinner } from './ui';

const DEPTH = 8;

/** A clicked price level: asks become a buy at that price, bids a sell. */
export interface BookPick {
  outcome: string;
  side: 'buy' | 'sell';
  price: number;
}

const STATUS_TEXT: Record<FeedStatus, string> = {
  live: 'Live',
  connecting: 'Connecting…',
  waiting: 'Waiting for the book…',
  offline: 'Reconnecting…',
};

/** Live order book for one outcome: asks above the spread, bids below, with depth bars. */
export function OrderbookSheet({
  market,
  book,
  feed,
  onClose,
  onPick,
}: {
  market: MarketDetail;
  book?: BookState;
  feed: FeedStatus;
  onClose: () => void;
  onPick?: (p: BookPick) => void;
}) {
  const names = book?.outcomes.map((o) => o.name) ?? market.tokens.map((t) => t.outcome);
  const [outcome, setOutcome] = useState(names[0] ?? 'Yes');
  const ob = book?.outcomes.find((o) => o.name === outcome);
  const asks = (ob?.asks ?? []).slice(0, DEPTH);
  const bids = (ob?.bids ?? []).slice(0, DEPTH);
  // Depth bars show cumulative size from the spread outward.
  const cumAsks = cumulative(asks);
  const cumBids = cumulative(bids);
  const max = Math.max(1, cumAsks.at(-1) ?? 0, cumBids.at(-1) ?? 0);
  const spread = ob?.asks[0] && ob?.bids[0] ? ob.asks[0].price - ob.bids[0].price : undefined;
  const mid = spread !== undefined ? (ob!.asks[0].price + ob!.bids[0].price) / 2 : undefined;

  return (
    <Sheet
      title={
        <span className="row" style={{ gap: 8 }}>
          Order book <span className={`live-dot ${feed}`} title={STATUS_TEXT[feed]} />
          <span className="small muted" style={{ fontWeight: 500 }}>
            {STATUS_TEXT[feed]}
          </span>
        </span>
      }
      onClose={onClose}
    >
      <div className="stack" style={{ gap: 10 }} data-testid="orderbook">
        <div className="segmented">
          {names.map((n) => (
            <button key={n} className={outcome === n ? 'active' : ''} onClick={() => setOutcome(n)}>
              {n}
            </button>
          ))}
        </div>
        {!ob ? (
          <div className="center muted small" style={{ padding: 24 }}>
            {feed === 'live' ? 'No resting orders yet.' : <Spinner />}
          </div>
        ) : (
          <div className="ob">
            <div className="ob-row ob-head">
              <span>Price</span>
              <span>Shares</span>
              <span>Total</span>
            </div>
            {asks
              .map((l, i) => (
                <Row
                  key={`a${l.price}`}
                  level={l}
                  depth={cumAsks[i] / max}
                  side="ask"
                  onClick={onPick && (() => onPick({ outcome, side: 'buy', price: l.price }))}
                />
              ))
              .reverse()}
            <div className="ob-spread">
              {mid !== undefined ? (
                <>
                  <span className="ob-mid">{fmtCents(mid)}</span>
                  <span>Spread {(spread! * 100).toFixed(1)}¢</span>
                </>
              ) : (
                <span>One-sided book</span>
              )}
            </div>
            {bids.map((l, i) => (
              <Row
                key={`b${l.price}`}
                level={l}
                depth={cumBids[i] / max}
                side="bid"
                onClick={onPick && (() => onPick({ outcome, side: 'sell', price: l.price }))}
              />
            ))}
          </div>
        )}
        <div className="small muted">
          {onPick ? 'Tap a price to place a limit order there. ' : ''}Polymarket book via Kairos, updated about every 150 ms.
        </div>
      </div>
    </Sheet>
  );
}

function cumulative(levels: BookLevel[]): number[] {
  let sum = 0;
  return levels.map((l) => (sum += l.size));
}

function fmtCents(p: number) {
  const c = p * 100;
  return `${Number.isInteger(Math.round(c * 10) / 10) ? c.toFixed(0) : c.toFixed(1)}¢`;
}

function Row({ level, depth, side, onClick }: { level: BookLevel; depth: number; side: 'bid' | 'ask'; onClick?: () => void }) {
  const content = (
    <>
      <span className="ob-bar" style={{ width: `${Math.max(2, depth * 100)}%` }} />
      <span className="ob-price">{fmtCents(level.price)}</span>
      <span>{level.size.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
      <span>${(level.size * level.price).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
    </>
  );
  if (!onClick) return <div className={`ob-row ${side}`}>{content}</div>;
  return (
    <button
      type="button"
      className={`ob-row ${side} clickable`}
      onClick={onClick}
      title={`${side === 'ask' ? 'Buy' : 'Sell'} at ${fmtCents(level.price)}`}
      aria-label={`${side === 'ask' ? 'Buy' : 'Sell'} at ${fmtCents(level.price)}`}
    >
      {content}
      <span className="ob-action" aria-hidden="true">
        {side === 'ask' ? 'Buy' : 'Sell'}
      </span>
    </button>
  );
}
