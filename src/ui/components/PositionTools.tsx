import { useState } from 'react';
import type { OnchainIntentView } from '@kairos.trade/sdk';
import { formatUnits, parseUnits } from '../../core/format';
import type { OnchainRequest } from '../../core/predictions/onchain';
import type { MarketDetail } from '../../core/predictions/types';
import { api } from '../lib/api';
import { invalidateAfterTrade } from '../lib/predictQueries';
import { Button, ErrorNote, Field, Sheet } from './ui';
import { FundedOrder } from './FundedOrder';

type Operation = OnchainRequest['operation'];
type Draft =
  | Omit<Extract<OnchainRequest, { operation: 'redeem' }>, 'idempotencyKey'>
  | { market: string; operation: 'split' | 'merge'; outcomes: string[] };
const LABEL: Record<Operation, string> = { split: 'Split pUSD', merge: 'Merge shares', redeem: 'Redeem shares' };

export function PositionTools({
  accountId,
  market,
  initialToken,
}: {
  accountId: string;
  market: MarketDetail;
  initialToken?: string;
}) {
  const [operation, setOperation] = useState<'split' | 'merge'>();
  const hasPositionTools =
    market.venue === 'polymarket' && market.tokens.length === 2 && /^0x[0-9a-f]{64}$/i.test(market.conditionId);
  if (!hasPositionTools) return <FundedOrder accountId={accountId} market={market} initialToken={initialToken} />;
  const outcomes = market.tokens.map((t) => t.outcome);
  return (
    <section className="position-card position-tools" aria-label="Manage outcome shares">
      <div>
        <strong>Manage outcome shares</strong>
        <div className="small muted">Convert between pUSD and a complete set of outcomes.</div>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button className="mini-btn" onClick={() => setOperation('split')}>
          Split pUSD
        </button>
        <button className="mini-btn" onClick={() => setOperation('merge')}>
          Merge shares
        </button>
        <FundedOrder accountId={accountId} market={market} initialToken={initialToken} />
      </div>
      {operation && (
        <PositionIntentSheet
          accountId={accountId}
          title={market.title}
          draft={{ operation, market: market.conditionId, outcomes }}
          onClose={() => setOperation(undefined)}
        />
      )}
    </section>
  );
}

export function PositionIntentSheet({
  accountId,
  title,
  draft,
  onClose,
}: {
  accountId: string;
  title: string;
  draft: Draft;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState(draft.operation === 'redeem' ? formatUnits(draft.amountRaw, 6) : '');
  const [view, setView] = useState<OnchainIntentView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [authorization, setAuthorization] = useState<{ idempotencyKey: string; executeBefore: string }>();
  const status = view?.intent.status as string | undefined;
  const confirmed = status === 'confirmed';
  const failed = status === 'failed' || status === 'reverted' || status === 'expired';
  const pending = view && !confirmed && !failed;
  const failure = (view?.intent as { failure?: { reason?: string } } | undefined)?.failure?.reason;
  let raw = 0n;
  try {
    raw = parseUnits(amount, 6);
  } catch {
    /* Keep the confirmation disabled until the amount is valid. */
  }

  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const request = authorization ?? {
        idempotencyKey: crypto.randomUUID(),
        executeBefore: new Date(Date.now() + 16 * 60_000).toISOString(),
      };
      if (!authorization) setAuthorization(request);
      const next = view
        ? await api.predictionOnchainStatus(accountId, view.intent.terms.id)
        : await api.predictionOnchain(
            accountId,
            draft.operation === 'redeem'
              ? { operation: 'redeem', market: draft.market, amountRaw: draft.amountRaw, outcome: draft.outcome, ...request }
              : { operation: draft.operation, market: draft.market, amountRaw: raw.toString(), ...request },
          );
      setView(next);
      if (next.intent.status === 'confirmed') {
        invalidateAfterTrade(accountId);
        // The market screen's holdings reload on this event.
        window.dispatchEvent(new Event('predict:traded'));
      }
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={LABEL[draft.operation]}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="stack" style={{ gap: 12 }}>
        <strong>{title}</strong>
        <div className="small muted">
          {draft.operation === 'redeem'
            ? 'Exchange winning shares for the market payout in your trading wallet.'
            : draft.operation === 'split'
              ? `Each pUSD gives you 1 share of ${draft.outcomes.join(' and 1 share of ')}.`
              : `Each set of ${draft.outcomes.join(' and ')} shares returns 1 pUSD to your trading wallet.`}
        </div>
        {!view && draft.operation !== 'redeem' && (
          <Field
            label={draft.operation === 'split' ? 'Amount in pUSD' : 'Number of complete sets'}
            htmlFor="prediction-intent-amount"
          >
            <input
              id="prediction-intent-amount"
              inputMode="decimal"
              placeholder="0"
              value={amount}
              disabled={busy || !!authorization}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
        )}
        <div className="row small muted" style={{ justifyContent: 'space-between' }}>
          <span>Polygon</span>
          <span>Gasless{draft.operation === 'redeem' ? ` · ${amount} shares` : ''}</span>
        </div>
        {confirmed && (
          <div className="notice" role="status">
            Confirmed on Polygon.
          </div>
        )}
        {pending && (
          <div className="notice" role="status">
            Submitted. Waiting for confirmation on Polygon.
          </div>
        )}
        {failed && (
          <ErrorNote
            error={
              status === 'expired'
                ? 'The operation expired before it could complete.'
                : failure || 'The position operation could not complete.'
            }
          />
        )}
        <ErrorNote error={error} />
        <Button block loading={busy} disabled={!view && raw <= 0n} onClick={confirmed || failed ? onClose : () => void run()}>
          {confirmed || failed ? 'Done' : pending ? 'Check status' : LABEL[draft.operation]}
        </Button>
      </div>
    </Sheet>
  );
}
