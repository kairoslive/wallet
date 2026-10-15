import { useState } from 'react';
import type { BookState, BookLevel } from '../../core/predictions/orderbook';
import type { MarketDetail } from '../../core/predictions/types';
import type { FeedStatus } from './useOrderbook';
import { Sheet, Spinner } from './ui';

const DEPTH = 8;

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
}: {
  market: MarketDetail;
  book?: BookState;
  feed: FeedStatus;
  onClose: () => void;
}) {
  const names = book?.outcomes.map((o) => o.name) ?? market.tokens.map((t) => t.outcome);
  const [outcome, setOutcome] = useState(names[0] ?? 'Yes');
  const ob = book?.outcomes.find((o) => o.name === outcome);
  const asks = (ob?.asks ?? []).slice(0, DEPTH);
  const bids = (ob?.bids ?? []).slice(0, DEPTH);
  const max = Math.max(1, ...asks.map((l) => l.size), ...bids.map((l) => l.size));
  const spread = ob?.asks[0] && ob?.bids[0] ? ob.asks[0].price - ob.bids[0].price : undefined;

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
            {[...asks].reverse().map((l) => (
              <Row key={`a${l.price}`} level={l} max={max} side="ask" />
            ))}
            <div className="ob-spread">{spread !== undefined ? `Spread ${(spread * 100).toFixed(1)}¢` : 'One-sided book'}</div>
            {bids.map((l) => (
              <Row key={`b${l.price}`} level={l} max={max} side="bid" />
            ))}
          </div>
        )}
        <div className="small muted">Polymarket book via Kairos, updated about every 150 ms.</div>
      </div>
    </Sheet>
  );
}

function Row({ level, max, side }: { level: BookLevel; max: number; side: 'bid' | 'ask' }) {
  return (
    <div className={`ob-row ${side}`}>
      <span className="ob-bar" style={{ width: `${Math.max(2, (level.size / max) * 100)}%` }} />
      <span className="ob-price">{(level.price * 100).toFixed(level.price * 100 < 1 ? 1 : 0)}¢</span>
      <span>{level.size.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
      <span>${(level.size * level.price).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
    </div>
  );
}
