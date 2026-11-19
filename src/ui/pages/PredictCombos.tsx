import { useEffect, useMemo, useRef, useState } from 'react';
import {
  comboEnabled,
  comboRedeemMarket,
  comboUnits,
  type ComboInput,
  type ComboMarket,
  type ComboPosition,
  type ComboResult,
} from '../../core/predictions/combos';
import { Button, Empty, ErrorNote, Field, Screen, Sheet, Spinner, TopBar } from '../components/ui';
import { Icon } from '../components/Icon';
import { PositionIntentSheet } from '../components/PositionTools';
import { api } from '../lib/api';
import { navigate, useRoute } from '../lib/router';
import { useQuery } from '../lib/query';
import { invalidateAfterTrade, useTradingStatus } from '../lib/predictQueries';
import { useWallet } from '../lib/store';
import { venueHold, venueStatus, VenueSheet } from './Predict';

const decimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 });
const money = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const amount = (value: string | number) => decimal.format(Number(value));
const pusd = (value: string | number | undefined) => (value === undefined ? '—' : `${money.format(Number(value))} pUSD`);
const price = (value: string | number) => `${decimal.format(Number(value) * 100)}¢`;

interface Pick {
  market: ComboMarket;
  outcome: ComboMarket['outcomes'][number];
}

function positive(value: string) {
  try {
    return comboUnits(value) > 0n;
  } catch {
    return false;
  }
}

export function PredictCombos() {
  const { state, account } = useWallet();
  const execution = state.settings.apis.kairosExecutionUrl;
  const eligible = state.settings.apis.kairosEnabled && comboEnabled(execution);
  return (
    <Screen>
      <TopBar title="Combos" onBack={() => navigate('/predict', undefined, true)} />
      {eligible ? (
        <ComboScreen key={`${execution}|${account?.id ?? ''}`} accountId={account?.evmAddress ? account.id : undefined} />
      ) : (
        <div className="screen-body">
          <Empty title="Combos are in preview">
            <p>Use Kairos Staging to build and trade combos.</p>
            <Button small onClick={() => navigate('/settings/apis')}>
              Open provider settings
            </Button>
          </Empty>
        </div>
      )}
    </Screen>
  );
}

function ComboScreen({ accountId }: { accountId?: string }) {
  const route = useRoute();
  const tab = route.query.get('tab') === 'positions' ? 'positions' : 'build';
  const { data: status, error: statusError, reload } = useTradingStatus(accountId);
  const positions = useQuery(
    accountId && tab === 'positions' ? `predict:combos:${accountId}` : undefined,
    () => api.predictionCombos(accountId!),
    { refreshMs: 15_000 },
  );
  const [picks, setPicks] = useState<Pick[]>([]);
  const [stake, setStake] = useState('');
  const [manageFunds, setManageFunds] = useState(false);
  const [trade, setTrade] = useState<{ input: ComboInput; picks?: Pick[]; position?: ComboPosition }>();
  const [redeem, setRedeem] = useState<ComboPosition>();
  const balance = status?.balance;
  const ready = status?.ready;
  const hold = venueHold(venueStatus(status, 'polymarket'));
  const canQuote = !!accountId && !!ready && picks.length >= 2 && positive(stake) && Number(stake) <= Number(balance ?? 0);

  const choose = (market: ComboMarket, outcome: Pick['outcome']) => {
    setPicks((prev) => {
      const existing = prev.find((p) => p.market.id === market.id);
      if (!existing && prev.length === 10) return prev;
      if (existing?.outcome.id === outcome.id) return prev.filter((p) => p.market.id !== market.id);
      if (existing) return prev.map((p) => (p.market.id === market.id ? { market, outcome } : p));
      return [...prev, { market, outcome }];
    });
  };

  const positionsTab = () => navigate('/predict/combos', { tab: 'positions' }, true);
  const finish = () => {
    if (accountId) invalidateAfterTrade(accountId);
    void reload();
    void positions.reload();
    setTrade(undefined);
    setRedeem(undefined);
    positionsTab();
  };

  return (
    <div className="screen-body stack combo-screen">
      <div className="segmented" role="tablist" aria-label="Combos">
        <button
          role="tab"
          aria-selected={tab === 'build'}
          className={tab === 'build' ? 'active' : ''}
          onClick={() => navigate('/predict/combos', undefined, true)}
        >
          Build combo
        </button>
        <button
          role="tab"
          aria-selected={tab === 'positions'}
          className={tab === 'positions' ? 'active' : ''}
          onClick={positionsTab}
        >
          My combos
        </button>
      </div>
      {tab === 'build' ? (
        <>
          <div className="combo-ticket stack">
            <div className="combo-ticket-heading">
              <div className="row" style={{ gap: 7 }}>
                <Icon name="layers" size={16} />
                <h2>Your combo</h2>
              </div>
              <span className="combo-count num">{picks.length} / 10</span>
            </div>
            <div className="small muted">Pick 2–10 outcomes. Every leg must win for the combo to pay out.</div>
            {picks.length > 0 && (
              <ol className="combo-picks">
                {picks.map(({ market, outcome }) => (
                  <li key={market.id}>
                    <span>
                      <strong className="combo-pick-outcome">{outcome.label}</strong>
                      <span>{market.title}</span>
                    </span>
                    <button className="icon-btn" aria-label={`Remove ${market.title}`} onClick={() => choose(market, outcome)}>
                      <Icon name="close" size={14} />
                    </button>
                  </li>
                ))}
              </ol>
            )}
            <Field
              htmlFor="combo-stake"
              label="Stake (pUSD)"
              hint={balance === undefined || balance === null ? undefined : `${pusd(balance)} available`}
            >
              <input
                className="input num"
                id="combo-stake"
                inputMode="decimal"
                placeholder="0.00"
                value={stake}
                onChange={(event) => {
                  if (/^\d{0,18}(\.\d{0,6})?$/.test(event.target.value)) setStake(event.target.value);
                }}
              />
            </Field>
            {!accountId ? (
              <div className="small muted">Switch to an EVM account to trade.</div>
            ) : statusError ? (
              <ErrorNote error={statusError} />
            ) : hold ? (
              <div className="small muted" role="status">
                {hold}
              </div>
            ) : status?.next === 'setup' || (status && Number(balance ?? 0) < Number(stake)) ? (
              <Button variant="secondary" onClick={() => setManageFunds(true)}>
                {status.next === 'setup' ? 'Set up trading' : 'Add pUSD'}
              </Button>
            ) : (
              <Button
                block
                disabled={!canQuote}
                onClick={() =>
                  setTrade({ input: { legs: picks.map((pick) => pick.outcome.id), side: 'buy', amount: stake }, picks })
                }
              >
                Get combo quote
              </Button>
            )}
          </div>
          <ComboCatalog picks={picks} onChoose={choose} />
        </>
      ) : (
        <ComboHoldings
          accountId={accountId}
          data={positions.data}
          error={positions.error}
          reload={positions.reload}
          onSell={(position) =>
            setTrade({
              position,
              input: { legs: position.legs.map((leg) => leg.legPositionId), side: 'sell', amount: position.sharesBalance },
            })
          }
          onRedeem={setRedeem}
        />
      )}
      {manageFunds && accountId && status && (
        <VenueSheet
          venue="polymarket"
          status={status}
          accountId={accountId}
          onChange={async () => {
            await reload();
          }}
          onClose={() => setManageFunds(false)}
        />
      )}
      {trade && accountId && (
        <ComboQuoteSheet
          accountId={accountId}
          input={trade.input}
          picks={trade.picks}
          position={trade.position}
          balance={balance}
          onClose={() => setTrade(undefined)}
          onDone={(confirmed) => {
            if (confirmed && trade.input.side === 'buy') {
              setPicks([]);
              setStake('');
            }
            finish();
          }}
        />
      )}
      {redeem && accountId && <ComboRedeemSheet position={redeem} accountId={accountId} onClose={finish} />}
    </div>
  );
}

function ComboCatalog({ picks, onChoose }: { picks: Pick[]; onChoose: (market: ComboMarket, outcome: Pick['outcome']) => void }) {
  const first = useQuery('predict:combo-markets', () => api.predictionComboMarkets(), { ttl: 60_000 });
  const [pages, setPages] = useState<{ markets: ComboMarket[]; cursor?: string }[]>([]);
  const [term, setTerm] = useState('');
  const [limit, setLimit] = useState(12);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const cursor = (pages.at(-1) ?? first.data)?.cursor;
  const markets = useMemo(() => {
    const all = new Map((first.data?.markets ?? []).map((market) => [market.id, market]));
    for (const page of pages) for (const market of page.markets) all.set(market.id, market);
    const needle = term.trim().toLowerCase();
    return [...all.values()].filter(
      (market) => !needle || `${market.title} ${market.tags.join(' ')}`.toLowerCase().includes(needle),
    );
  }, [first.data, pages, term]);

  const load = async () => {
    if (limit < markets.length) {
      setLimit((count) => count + 12);
      return;
    }
    if (!cursor || loading) return;
    setLoading(true);
    setError(undefined);
    try {
      const next = await api.predictionComboMarkets(cursor);
      setPages((previous) => [...previous, next.cursor === cursor ? { ...next, cursor: undefined } : next]);
      setLimit((count) => count + 12);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="stack combo-catalog" aria-labelledby="combo-catalog-heading">
      <h2 id="combo-catalog-heading">Eligible markets</h2>
      <Field htmlFor="combo-market-search" label="Filter listed markets">
        <div className="combo-search">
          <Icon name="search" size={16} />
          <input
            className="input"
            id="combo-market-search"
            placeholder="Market or topic"
            value={term}
            onChange={(event) => {
              setTerm(event.target.value);
              setLimit(12);
            }}
          />
        </div>
      </Field>
      {first.loading && (
        <div className="row small muted" role="status">
          <Spinner size={14} /> Loading eligible markets…
        </div>
      )}
      {first.error && (
        <>
          <ErrorNote error={first.error} />
          <Button variant="secondary" onClick={() => void first.reload()}>
            Retry
          </Button>
        </>
      )}
      {first.data && markets.length === 0 && (
        <Empty title="No matches in the listed markets">Load more markets or try a different search.</Empty>
      )}
      {markets.slice(0, limit).map((market) => {
        const selected = picks.find((pick) => pick.market.id === market.id);
        return (
          <article className="combo-market" key={market.id}>
            <div className="combo-market-title">
              {market.image && <img className="market-thumb" src={market.image} alt="" loading="lazy" />}
              <h3>{market.title}</h3>
            </div>
            <div className="outcome-buttons">
              {market.outcomes.map((outcome, i) => {
                const picked = selected?.outcome.id === outcome.id;
                return (
                  <button
                    className={`outcome-btn ${i === 0 ? 'yes' : 'no'} ${picked ? 'selected' : ''}`}
                    key={outcome.id}
                    aria-label={`${outcome.label} · ${market.title}`}
                    aria-pressed={picked}
                    disabled={picks.length >= 10 && !selected}
                    onClick={() => onChoose(market, outcome)}
                  >
                    <span>
                      {picked && <Icon name="check" size={13} />}
                      {outcome.label}
                    </span>
                    {outcome.price !== undefined && <span className="num">{price(outcome.price)}</span>}
                  </button>
                );
              })}
            </div>
          </article>
        );
      })}
      <ErrorNote error={error} />
      {(limit < markets.length || cursor) && (
        <Button variant="secondary" loading={loading} onClick={() => void load()}>
          Load more markets
        </Button>
      )}
    </section>
  );
}

function ComboHoldings({
  accountId,
  data,
  error,
  reload,
  onSell,
  onRedeem,
}: {
  accountId?: string;
  data?: ComboPosition[];
  error?: string;
  reload: () => Promise<unknown>;
  onSell: (position: ComboPosition) => void;
  onRedeem: (position: ComboPosition) => void;
}) {
  if (!accountId) return <Empty title="Switch to an EVM account to see your combos" />;
  if (error)
    return (
      <>
        <ErrorNote error={error} />
        <Button variant="secondary" onClick={() => void reload()}>
          Retry
        </Button>
      </>
    );
  if (!data)
    return (
      <div className="row small muted" role="status">
        <Spinner size={14} /> Loading your combos…
      </div>
    );
  if (!data.length) return <Empty title="No combo positions yet">Your trades will appear here once they settle.</Empty>;
  return data.map((position) => {
    const lost = position.legs.some((leg) => leg.legStatus === 'RESOLVED_LOSS');
    const sellable = positive(position.sharesBalance) && !lost && !position.redeemable && position.legsPending > 0;
    return (
      <article className="combo-ticket stack" key={position.comboPositionId}>
        <div className="combo-ticket-heading">
          <h2>{position.legs.length}-leg combo</h2>
          <span className="combo-count">
            {position.redeemable
              ? 'Ready to redeem'
              : lost
                ? 'Lost'
                : position.legsPending > 0
                  ? `${position.legsPending} pending`
                  : 'Settled'}
          </span>
        </div>
        <ul className="combo-picks">
          {position.legs.map((leg) => (
            <li key={leg.legPositionId}>
              <span>
                <strong className="combo-pick-outcome">{leg.outcomeLabel ?? leg.outcome ?? 'Outcome'}</strong>
                <span>{leg.title ?? 'Outcome'}</span>
              </span>
              <span
                className={`small ${leg.legStatus === 'RESOLVED_WIN' ? 'pos' : leg.legStatus === 'RESOLVED_LOSS' ? 'neg' : 'muted'}`}
              >
                {leg.legStatus === 'RESOLVED_WIN' ? 'Won' : leg.legStatus === 'RESOLVED_LOSS' ? 'Lost' : 'Pending'}
              </span>
            </li>
          ))}
        </ul>
        <div className="kv">
          <span>Shares</span>
          <span className="num">{amount(position.sharesBalance)}</span>
        </div>
        <div className="kv">
          <span>{position.redeemable ? 'Payout' : 'Pays if all legs win'}</span>
          <span className="num">{pusd(lost ? 0 : position.sharesBalance)}</span>
        </div>
        {position.totalCostUsdc && (
          <div className="kv">
            <span>Cost</span>
            <span className="num">{pusd(position.totalCostUsdc)}</span>
          </div>
        )}
        {sellable && (
          <Button variant="secondary" onClick={() => onSell(position)}>
            Get cash-out quote
          </Button>
        )}
        {position.redeemable && <Button onClick={() => onRedeem(position)}>Redeem payout</Button>}
      </article>
    );
  });
}

function ComboQuoteSheet({
  accountId,
  input,
  picks,
  position,
  balance,
  onClose,
  onDone,
}: {
  accountId: string;
  input: ComboInput;
  picks?: Pick[];
  position?: ComboPosition;
  balance?: string | null;
  onClose: () => void;
  onDone: (confirmed: boolean) => void;
}) {
  const buy = input.side === 'buy';
  const [quote, setQuote] = useState<ComboResult>();
  const [result, setResult] = useState<ComboResult>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const locked = useRef(false);

  useEffect(() => {
    let active = true;
    void api.predictionComboQuote(accountId, input).then(
      (next) => {
        if (active) {
          setQuote(next);
          setLoading(false);
        }
      },
      (err: Error) => {
        if (active) {
          setError(err.message);
          setLoading(false);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [accountId, input, revision]);

  const refresh = () => {
    setQuote(undefined);
    setError(undefined);
    setLoading(true);
    setRevision((value) => value + 1);
  };
  const submit = async () => {
    if (!quote || locked.current) return;
    locked.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      const fill = await api.predictionComboTrade(
        accountId,
        buy ? { ...input, side: 'buy', maxPrice: quote.price } : { ...input, side: 'sell', minProceeds: quote.netProceeds! },
      );
      setResult(fill);
    } catch (err) {
      const message = (err as Error).message;
      setUnknown(/check your combo positions/i.test(message));
      setError(message);
      setQuote(undefined);
    } finally {
      setSubmitting(false);
      locked.current = false;
    }
  };

  const shown = result ?? quote;
  const reviewable =
    shown &&
    (buy
      ? positive(shown.price) && shown.cost && Number(shown.cost) <= Number(balance ?? 0)
      : !!shown.netProceeds && positive(shown.netProceeds));
  return (
    <Sheet
      title={result ? (buy ? 'Combo bought' : 'Combo cashed out') : buy ? 'Review combo buy' : 'Review cash out'}
      onClose={submitting ? () => undefined : result || unknown ? () => onDone(!!result) : onClose}
    >
      <div className="stack combo-review">
        {loading && (
          <div className="row small muted" role="status">
            <Spinner size={14} /> Requesting a maker quote…
          </div>
        )}
        {submitting && (
          <div className="row small muted" role="status">
            <Spinner size={14} /> Pricing and confirming…
          </div>
        )}
        {shown && (
          <>
            <div className="review-hero">
              <div className="small muted">
                {buy ? 'Pays if every leg wins' : result ? 'Net proceeds' : 'Estimated net proceeds'}
              </div>
              <div className="review-amount num">{pusd(buy ? shown.shares : shown.netProceeds)}</div>
              <div className="small muted">
                {amount(shown.shares)} shares · {price(shown.price)} per share
              </div>
            </div>
            <div className="panel">
              <div className="kv">
                <span>{buy ? 'Trading wallet debit' : 'Trading wallet credit'}</span>
                <span className="num">{pusd(buy ? shown.cost : shown.proceeds)}</span>
              </div>
              <div className="kv">
                <span>Exchange fee included</span>
                <span className="num">{pusd(shown.exchangeFee)}</span>
              </div>
              <div className="kv">
                <span>Kairos fee owed</span>
                <span className="num">{pusd(shown.kairosFee)}</span>
              </div>
              <div className="kv">
                <span>{buy ? 'Total cost with fees' : 'After all fees'}</span>
                <span className="num">{pusd(buy ? shown.totalCost : shown.netProceeds)}</span>
              </div>
              {!result && (
                <div className="kv">
                  <span>{buy ? 'Maximum price' : 'Minimum net proceeds'}</span>
                  <span className="num">{buy ? `${price(shown.price)} / share` : pusd(shown.netProceeds)}</span>
                </div>
              )}
              {!result && buy && shown.cost !== input.amount && (
                <div className="kv">
                  <span>Maximum trading debit</span>
                  <span className="num">{pusd(input.amount)}</span>
                </div>
              )}
            </div>
          </>
        )}
        <ul className="combo-picks">
          {picks?.map((pick) => (
            <li key={pick.market.id}>
              <span>
                <strong className="combo-pick-outcome">{pick.outcome.label}</strong>
                {pick.market.title}
              </span>
            </li>
          ))}
          {position?.legs.map((leg) => (
            <li key={leg.legPositionId}>
              <span>
                <strong className="combo-pick-outcome">{leg.outcomeLabel ?? leg.outcome}</strong>
                {leg.title ?? 'Outcome'}
              </span>
            </li>
          ))}
        </ul>
        {!result && shown && (
          <div className="small muted">
            Quotes last about five seconds. Confirmation asks for a fresh quote within your limit.
          </div>
        )}
        <ErrorNote error={error} />
        {result || unknown ? (
          <Button onClick={() => onDone(!!result)}>View my combos</Button>
        ) : quote ? (
          <Button loading={submitting} disabled={!reviewable} onClick={() => void submit()}>
            {buy ? 'Buy combo' : 'Cash out full position'}
          </Button>
        ) : (
          !loading && (
            <Button variant="secondary" onClick={refresh}>
              Refresh quote
            </Button>
          )
        )}
      </div>
    </Sheet>
  );
}

function ComboRedeemSheet({ position, accountId, onClose }: { position: ComboPosition; accountId: string; onClose: () => void }) {
  try {
    return (
      <PositionIntentSheet
        accountId={accountId}
        title={`${position.legs.length}-leg combo · ${pusd(position.sharesBalance)} payout`}
        draft={{
          operation: 'redeem',
          market: comboRedeemMarket(position),
          amountRaw: comboUnits(position.sharesBalance).toString(),
          outcome: 0,
        }}
        onClose={onClose}
      />
    );
  } catch (err) {
    return (
      <Sheet title="Redeem payout" onClose={onClose}>
        <ErrorNote error={(err as Error).message} />
      </Sheet>
    );
  }
}
