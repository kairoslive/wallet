import { useState } from 'react';
import { shortAddress } from '../../core/format';
import type { PredictionActivity } from '../../core/predictions/plans';
import { api } from '../lib/api';
import { useQuery } from '../lib/query';
import { invalidateAfterTrade } from '../lib/predictQueries';
import { ErrorNote, Sheet, Spinner } from './ui';

const LABEL = { split: 'Split pUSD', merge: 'Merge shares', redeem: 'Redeem shares' };
const STATE: Record<string, string> = {
  completed: 'Order accepted',
  confirmed: 'Confirmed',
  expired: 'Expired',
  failed: 'Failed',
  reverted: 'Reverted',
  refunded: 'Refunded',
  funded_trade_failed: 'Funds arrived · order failed',
  funded_trade_expired: 'Funds arrived · order expired',
  needs_signatures: 'Awaiting authorization',
  ready: 'Submitted',
  reconciling: 'Confirming',
  funding_pending: 'Bridging USDC',
  trade_pending: 'Submitting order',
};

export function TradeActivity({ accountId }: { accountId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="mini-btn" onClick={() => setOpen(true)}>
        Trade activity
      </button>
      {open && <ActivitySheet accountId={accountId} onClose={() => setOpen(false)} />}
    </>
  );
}

function ActivitySheet({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const { data, loading, error } = useQuery(`p/activity/${accountId}`, () => api.predictionActivity(accountId), { ttl: 0 });
  return (
    <Sheet title="Trade activity" onClose={onClose}>
      <div className="stack" style={{ gap: 8 }}>
        {loading && <Spinner />}
        <ErrorNote error={error} />
        {data && !data.length && (
          <div className="small muted">Funded orders and position operations appear here after submission.</div>
        )}
        {data?.map((item) => (
          <ActivityRow key={item.id} item={item} accountId={accountId} />
        ))}
      </div>
    </Sheet>
  );
}

function ActivityRow({ item, accountId }: { item: PredictionActivity; accountId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const check = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const next =
        item.kind === 'funded-buy'
          ? (await api.predictionFundedBuyStatus(accountId, item.id)).status
          : (await api.predictionOnchainStatus(accountId, item.id)).intent.status;
      setStatus(next);
      if (next === 'completed' || next === 'confirmed') invalidateAfterTrade(accountId);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="position-card position-tools">
      <div className="row funded-summary">
        <strong>{item.kind === 'funded-buy' ? 'Funded buy' : LABEL[item.operation]}</strong>
        <span className="small muted">
          {new Date(item.createdAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
        </span>
      </div>
      <div className="small muted" title={item.market}>
        {item.market.includes('0x') ? shortAddress(item.market.slice(item.market.indexOf('0x'))) : item.market}
      </div>
      <div className="row funded-summary">
        <span className="small muted" aria-live="polite">
          {status ? (STATE[status] ?? 'In progress') : 'Check the latest status'}
        </span>
        <button className="mini-btn" disabled={busy} onClick={() => void check()}>
          {busy ? 'Checking…' : 'Check status'}
        </button>
      </div>
      <ErrorNote error={error} />
    </div>
  );
}
