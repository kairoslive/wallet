import { useState } from 'react';
import type { TradePlan } from '@kairos.trade/sdk';
import { formatUnits, parseUnits } from '../../core/format';
import type { FundingSource } from '../../core/predictions/plans';
import type { MarketDetail } from '../../core/predictions/types';
import { VENUE_INFO } from '../../core/predictions/venues';
import { api } from '../lib/api';
import { invalidateAfterTrade } from '../lib/predictQueries';
import { Button, ErrorNote, Field, Sheet } from './ui';

const SOURCE_LABEL: Record<FundingSource, string> = { arbitrum: 'Arbitrum', polygon: 'Polygon' };
const FINAL = new Set(['completed', 'expired', 'failed', 'funded_trade_failed', 'funded_trade_expired', 'refunded']);

const amount = (raw: string, decimals: number) => formatUnits(raw, decimals);
const canonical = (input: string, decimals: number) => formatUnits(parseUnits(input, decimals), decimals);

export function FundedOrder({
  accountId,
  market,
  initialToken,
}: {
  accountId: string;
  market: MarketDetail;
  initialToken?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!market.tokens.length || !['active', 'open', 'live', 'upcoming'].includes(market.status.toLowerCase())) return null;
  return (
    <>
      <button className="mini-btn" onClick={() => setOpen(true)}>
        Buy with USDC
      </button>
      {open && (
        <FundedOrderSheet accountId={accountId} market={market} initialToken={initialToken} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function FundedOrderSheet({
  accountId,
  market,
  initialToken,
  onClose,
}: {
  accountId: string;
  market: MarketDetail;
  initialToken?: string;
  onClose: () => void;
}) {
  const [token, setToken] = useState(initialToken ?? market.tokens[0].tokenId);
  const [source, setSource] = useState<FundingSource>('arbitrum');
  const [price, setPrice] = useState('');
  const [shares, setShares] = useState('');
  const [budget, setBudget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [plan, setPlan] = useState<TradePlan>();
  const [attempted, setAttempted] = useState(false);
  const [checked, setChecked] = useState(false);
  const venue = VENUE_INFO[market.venue];
  const finished = plan && FINAL.has(plan.status);
  const completed = plan?.status === 'completed';

  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (!plan) {
        const cap = parseUnits(budget, 6);
        const p = canonical(price, 18);
        const size = canonical(shares, 18);
        if (cap <= 0n || Number(p) <= 0 || Number(p) >= 1 || Number(size) <= 0) {
          throw new Error('Enter a limit price between 0 and 1, a positive share count, and a USDC limit.');
        }
        setPlan(
          await api.predictionPrepareFundedBuy(accountId, {
            marketId: market.marketId,
            tokenId: token,
            price: p,
            shares: size,
            funding: { source, maxAmountRaw: cap.toString() },
          }),
        );
      } else {
        const check = attempted;
        setAttempted(true);
        const next = check
          ? await api.predictionFundedBuyStatus(accountId, plan.id)
          : await api.predictionExecuteFundedBuy(accountId, plan.id);
        setPlan(next);
        if (check) setChecked(true);
        if (FINAL.has(next.status)) invalidateAfterTrade(accountId);
      }
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title="Buy with USDC"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="stack" style={{ gap: 12 }}>
        <strong>{market.title}</strong>
        {!plan ? (
          <>
            <div className="small muted">
              Fund any shortfall from your wallet’s USDC, then place a limit order on {venue.name}.
            </div>
            <Field label="Outcome" htmlFor="funded-outcome">
              <select id="funded-outcome" value={token} disabled={busy} onChange={(e) => setToken(e.target.value)}>
                {market.tokens.map((t) => (
                  <option value={t.tokenId} key={t.tokenId}>
                    {t.outcome}
                  </option>
                ))}
              </select>
            </Field>
            <div className="funded-order-fields">
              <Field label="Limit price ($)" htmlFor="funded-price">
                <input
                  id="funded-price"
                  inputMode="decimal"
                  placeholder="0.50"
                  disabled={busy}
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                />
              </Field>
              <Field label="Shares" htmlFor="funded-shares">
                <input
                  id="funded-shares"
                  inputMode="decimal"
                  placeholder="10"
                  disabled={busy}
                  value={shares}
                  onChange={(e) => setShares(e.target.value)}
                />
              </Field>
            </div>
            <Field label="USDC source" htmlFor="funded-source">
              <select
                id="funded-source"
                disabled={busy}
                value={source}
                onChange={(e) => setSource(e.target.value as FundingSource)}
              >
                <option value="arbitrum">Arbitrum</option>
                {market.venue !== 'polymarket' && <option value="polygon">Polygon</option>}
              </select>
            </Field>
            <Field label="Maximum USDC to bridge" htmlFor="funded-budget">
              <input
                id="funded-budget"
                inputMode="decimal"
                placeholder="0.00"
                disabled={busy}
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
            </Field>
          </>
        ) : (
          <>
            <div className="trade-review">
              <Summary label="Order" value={`${plan.order.size} ${plan.order.outcome} shares`} />
              <Summary label="Limit price" value={`$${plan.order.price} per share`} />
              <Summary label="Venue" value={venue.name} />
              <Summary
                label="Maximum debit"
                value={`${amount(plan.tradeBudget.maxDebitRaw, plan.tradeBudget.decimals)} ${venue.currency}`}
              />
              <Summary
                label="Maximum trade fees"
                value={`${amount(plan.tradeBudget.maxCollateralFeeRaw, plan.tradeBudget.decimals)} ${venue.currency}`}
              />
              <Summary
                label={`USDC from ${SOURCE_LABEL[source]}`}
                value={plan.funding ? amount(plan.funding.amountInRaw, plan.funding.sourceDecimals) : '0 · Already funded'}
              />
              {plan.funding && <Summary label="Maximum bridge slippage" value={`${plan.funding.slippageBps / 100}%`} />}
            </div>
            {attempted && (
              <div className="notice" role="status">
                {completed
                  ? 'Order accepted by the venue. Track fills in Orders.'
                  : finished
                    ? plan.error?.message || 'The trade did not complete.'
                    : plan.status === 'needs_signatures'
                      ? 'This plan has no submitted signatures yet.'
                      : 'The plan is in progress. Check its status before placing another order.'}
              </div>
            )}
            {plan.status.startsWith('funded_trade_') && (
              <div className="small muted">Bridged funds are available in your trading account.</div>
            )}
          </>
        )}
        <ErrorNote error={error} />
        <Button
          block
          loading={busy}
          disabled={!plan && (!price || !shares || !budget)}
          onClick={finished ? onClose : () => void run()}
        >
          {finished ? 'Done' : attempted ? 'Check status' : plan ? 'Confirm funded buy' : 'Review funded buy'}
        </Button>
        {plan && (!attempted || (checked && plan.status === 'needs_signatures')) && (
          <Button
            block
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setPlan(undefined);
              setAttempted(false);
              setChecked(false);
              setError(undefined);
            }}
          >
            {attempted ? 'Review a fresh plan' : 'Edit order'}
          </Button>
        )}
      </div>
    </Sheet>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="row funded-summary">
      <span className="muted">{label}</span>
      <span className="num">{value}</span>
    </div>
  );
}
