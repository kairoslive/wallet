import { useState } from 'react';
import type { FeeSettlement, FeeVenue } from '@kairos.trade/sdk';
import { formatUnits, shortAddress } from '../../core/format';
import { FEE_DECIMALS, VENUE_INFO } from '../../core/predictions/venues';
import { api } from '../lib/api';
import { useQuery } from '../lib/query';
import { invalidateAfterTrade } from '../lib/predictQueries';
import { Button, ErrorNote, Sheet, Spinner } from './ui';

type Review = Awaited<ReturnType<typeof api.predictionPrepareFee>>;

export function PredictionFees({ accountId }: { accountId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="mini-btn" onClick={() => setOpen(true)}>
        Trading fees
      </button>
      {open && <FeeSheet accountId={accountId} onClose={() => setOpen(false)} />}
    </>
  );
}

function FeeSheet({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const summary = useQuery(`p/fees/${accountId}`, () => api.predictionFees(accountId));
  const [review, setReview] = useState<Review>();
  const [settlement, setSettlement] = useState<FeeSettlement>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const prepare = (venue: FeeVenue) =>
    run(async () => {
      const next = await api.predictionPrepareFee(accountId, venue);
      setReview(next);
      setSettlement(next.settlement);
    });

  const update = () => {
    if (!settlement) return;
    void run(async () => {
      const next =
        settlement.status === 'awaiting_signature'
          ? await api.predictionSettleFee(accountId, {
              id: settlement.id,
              venue: settlement.venue,
              amountRaw: settlement.amountRaw,
              treasury: settlement.treasury,
              gasMaxWei: review?.gasMaxWei,
            })
          : await api.predictionFeeStatus(accountId, settlement.id);
      setSettlement(next);
      if (next.status === 'confirmed') {
        invalidateAfterTrade(accountId);
        void summary.reload();
      }
    });
  };

  const final = settlement && ['confirmed', 'failed', 'expired'].includes(settlement.status);
  return (
    <Sheet
      title="Trading fees"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="stack" style={{ gap: 12 }}>
        {settlement ? (
          <>
            <div className="trade-review">
              <div className="row funded-summary">
                <span className="muted">Venue</span>
                <strong>{VENUE_INFO[settlement.venue].name}</strong>
              </div>
              <div className="row funded-summary">
                <span className="muted">Amount</span>
                <strong>
                  {formatUnits(settlement.amountRaw, FEE_DECIMALS[settlement.venue])} {VENUE_INFO[settlement.venue].currency}
                </strong>
              </div>
              <div className="row funded-summary">
                <span className="muted">Treasury</span>
                <span title={settlement.treasury}>{shortAddress(settlement.treasury)}</span>
              </div>
              {review?.gasMaxWei && (
                <div className="row funded-summary">
                  <span className="muted">Network fee, up to</span>
                  <span>{formatUnits(review.gasMaxWei, 18)} BNB</span>
                </div>
              )}
              {settlement.venue === 'polymarket' && (
                <div className="row funded-summary">
                  <span className="muted">Network fee</span>
                  <span>Gasless</span>
                </div>
              )}
            </div>
            {settlement.status !== 'awaiting_signature' && (
              <div className="notice" role="status">
                {settlement.status === 'confirmed'
                  ? 'Payment confirmed and credited.'
                  : settlement.status === 'submitted'
                    ? 'Payment submitted. Waiting for the network to finalize.'
                    : settlement.failure || 'This payment ended before it could confirm.'}
              </div>
            )}
            <Button
              block
              loading={busy}
              onClick={
                final
                  ? () => {
                      setSettlement(undefined);
                      setReview(undefined);
                      void summary.reload();
                    }
                  : update
              }
            >
              {final
                ? 'Back to trading fees'
                : settlement.status === 'submitted'
                  ? 'Check status'
                  : review?.resuming
                    ? 'Resume payment'
                    : 'Confirm payment'}
            </Button>
            {!final && (
              <Button
                block
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setSettlement(undefined);
                  setReview(undefined);
                  setError(undefined);
                }}
              >
                Back
              </Button>
            )}
          </>
        ) : (
          <>
            <div className="small muted">Fees from filled trade plans accrue by venue. Paying clears the current balance.</div>
            {summary.loading && <Spinner />}
            <ErrorNote error={summary.error} />
            {summary.data && !summary.data.venues.length && <div className="notice">No fees to pay.</div>}
            {summary.data?.venues.map((row) => (
              <div className="position-card position-tools" key={row.venue}>
                <strong>{VENUE_INFO[row.venue].name}</strong>
                <div className="row funded-summary">
                  <span className="muted">{row.owedRaw.startsWith('-') ? 'Credit' : 'Amount due'}</span>
                  <span className="num">
                    {formatUnits(row.owedRaw.replace(/^-/, ''), row.decimals)} {VENUE_INFO[row.venue].currency}
                  </span>
                </div>
                {(row.settlement || BigInt(row.owedRaw) > 0n) && (
                  <Button
                    small
                    loading={busy}
                    onClick={() =>
                      row.settlement?.status === 'submitted' ? setSettlement(row.settlement) : void prepare(row.venue)
                    }
                  >
                    {row.settlement?.status === 'submitted' ? 'View payment' : 'Review payment'}
                  </Button>
                )}
              </div>
            ))}
          </>
        )}
        <ErrorNote error={error} />
      </div>
    </Sheet>
  );
}
