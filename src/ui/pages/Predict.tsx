import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { PredictionEvent, TradingStatus, VenueStatus } from '../../core/predictions/types';
import { VENUE_INFO, VENUES, type Venue } from '../../core/predictions/venues';
import type { OrderView, PositionView, PositionsView } from '../../core/predictions/portfolio';
import type { RecoveryState } from '../../core/predictions/recovery';
import type { Category } from '../../core/predictions/client';
import { CATEGORIES } from '../../core/predictions/client';
import { formatAmount, shortAddress } from '../../core/format';
import { api } from '../lib/api';
import { navigate, useRoute } from '../lib/router';
import { useWallet } from '../lib/store';
import { cacheEvents } from '../lib/predictCache';
import { Button, CopyButton, Empty, ErrorNote, Sheet, Spinner, TopBar } from '../components/ui';
import { Icon } from '../components/Icon';
import { AddFundsSheet, type AddFundsPreset } from '../components/AddFundsSheet';
import { ARBITRUM_USDC, HYPERLIQUID_MIN_DEPOSIT } from '../../core/predictions/hyperliquid';

type Tab = 'markets' | 'positions' | 'orders';

export const pct = (p?: number) => (p === undefined ? '—' : `${Math.round(p * 100)}%`);
export const cents = (p?: number) => (p === undefined ? '—' : `${(p * 100).toFixed(p * 100 < 1 ? 1 : 0)}¢`);

export function compactUsd(v?: number): string {
  if (v === undefined) return '';
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

/** USDT on BNB Chain: what Predict.fun trades in. */
export const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955';

/** One venue's readiness and balance. Polymarket is the top level; other venues exist only on a multi-venue node. */
export function venueStatus(status: TradingStatus | undefined, venue: Venue): VenueStatus | undefined {
  if (!status) return undefined;
  if (venue === 'polymarket') return { ready: status.ready, next: status.next, balance: status.balance, currency: 'pUSD' };
  return status.venues?.[venue];
}

/**
 * What a venue reporting `next: "fund"` is short of. Predict.fun also reports `fund` when the
 * wallet has collateral but no BNB to send its one-time approvals with.
 */
export function venueShortfall(vs?: VenueStatus): { gas: boolean; collateral: boolean } | undefined {
  if (vs?.next !== 'fund') return undefined;
  const detail = vs.venueDetail ?? {};
  // Hyperliquid: USDC on the wallet's perps covers it; the next order asks to move what it needs to spot.
  if (perpsUsdc(vs) > 0) return undefined;
  const gas = Number(detail.missingApprovals ?? 0) > 0 && detail.gasBalance !== undefined && !(Number(detail.gasBalance) > 0);
  const collateral = !(Number(vs.balance ?? 0) > 0);
  // Nothing identifiable: the collateral is the likelier gap.
  return { gas, collateral: collateral || !gas };
}

/** Plain words for a shortfall, e.g. "Add a few cents of BNB on BNB Chain to pay for the one-time approvals." */
export function shortfallText(venue: Venue, short: { gas: boolean; collateral: boolean }): string {
  const { currency } = VENUE_INFO[venue];
  if (venue === 'polymarket') return 'Add pUSD to start trading.';
  if (venue === 'hyperliquid')
    return `Deposit ${currency} to your Hyperliquid account (at least ${HYPERLIQUID_MIN_DEPOSIT} ${currency}).`;
  if (short.gas && short.collateral) return `Add ${currency} and a few cents of BNB on BNB Chain to this wallet.`;
  if (short.gas) return `Add a few cents of BNB on BNB Chain to pay for the one-time approvals.`;
  return `Add ${currency} on BNB Chain to this wallet.`;
}

/** Where to get what's missing: BNB for gas first, else the collateral. */
export function getFunds(short: { gas: boolean; collateral: boolean }) {
  if (short.gas) navigate('/swap', { mode: 'bridge', toNetwork: 'bsc', to: 'native' });
  else navigate('/swap', { mode: 'bridge', toNetwork: 'bsc', to: USDT_BSC });
}

/** USDC on the wallet's Hyperliquid perps that the next order can move to spot. */
export function perpsUsdc(vs?: VenueStatus): number {
  const t = vs?.venueDetail?.transferFromPerps as { available?: string } | undefined;
  return Number(t?.available ?? 0) || 0;
}

/** Why a venue can't take orders right now, other than setup and funding: still confirming, or ruled out. */
export function venueHold(vs?: VenueStatus): string | undefined {
  if (vs?.next === 'wait') return 'Your approvals are still confirming. Try again in a minute.';
  if (vs?.next === 'blocked') {
    const reason = vs.venueDetail?.reason;
    return `This account can't trade here${typeof reason === 'string' && reason ? `: ${reason}` : '.'}`;
  }
  return undefined;
}

/** A small label naming the venue, the same on every market, position and order. */
export function VenueTag({ venue }: { venue: Venue }) {
  return <span className={`venue-tag ${venue}`}>{VENUE_INFO[venue].name}</span>;
}

/** Where each venue's trading money sits. */
const VENUE_HOLDING: Record<Venue, string> = {
  polymarket: 'pUSD in your trading wallet on Polygon',
  predictfun: 'USDT on BNB Chain, in this wallet',
  hyperliquid: 'USDC on your Hyperliquid account',
};

/** How each venue gets ready, in one line, for the venue sheet. */
const VENUE_SETUP: Record<Venue, string> = {
  polymarket: 'Setup creates a trading wallet owned by this wallet and approves the Polymarket exchange. Two signatures, no gas.',
  predictfun:
    "Your first order approves Predict.fun's contracts on BNB Chain (a few cents of BNB, once) and signs you in to Predict.fun.",
  hyperliquid:
    'Your first order lets Kairos place trades for you on Hyperliquid. It can only place and cancel trades, never withdraw. No gas.',
};

/** Taking money out of a venue whose funds aren't in a Kairos trading wallet. */
const VENUE_WITHDRAW: Record<Exclude<Venue, 'polymarket'>, string> = {
  predictfun: 'The USDT is already in this wallet: send it like any other token.',
  hyperliquid: 'Withdraw on Hyperliquid itself. Kairos never moves funds out of your Hyperliquid account.',
};

/**
 * Where a venue stands: `text` in full (the venue sheet), `action` as the row's short label when
 * something must happen before it can trade.
 */
export function venueLine(venue: Venue, vs: VenueStatus): { text: string; attention: boolean; action?: string } {
  const hold = venueHold(vs);
  if (hold) return { text: hold, attention: true, action: vs.next === 'wait' ? 'Confirming' : 'Unavailable' };
  if (venue === 'polymarket' && vs.next === 'setup')
    return { text: 'Set up to start trading.', attention: true, action: 'Set up' };
  const short = venueShortfall(vs);
  if (short) return { text: shortfallText(venue, short), attention: true, action: short.gas ? 'Add BNB' : 'Add funds' };
  const perps = perpsUsdc(vs);
  if (perps > 0) return { text: `${usd(perps)} more in your Hyperliquid perps`, attention: false };
  if (vs.next === 'setup') return { text: 'Sets up with your first order', attention: false };
  return { text: VENUE_HOLDING[venue], attention: false };
}

/** The venues this node trades, in the wallet's order. */
export function tradedVenues(status?: TradingStatus): Venue[] {
  return VENUES.filter((v) => venueStatus(status, v));
}

/** One venue as a row: name and balance, or what it needs first. Details live in its sheet. */
function VenueRow({ venue, vs, onOpen }: { venue: Venue; vs: VenueStatus; onOpen: () => void }) {
  const line = venueLine(venue, vs);
  const balance = Number(vs.balance ?? 0);
  return (
    <button
      className="venue-row"
      onClick={onOpen}
      data-testid={`venue-balance-${venue}`}
      title={line.text}
      aria-label={`${VENUE_INFO[venue].name}, ${usd(balance)}. ${line.text}`}
    >
      <span className={`venue-dot ${venue}`} aria-hidden />
      <span className="name">{VENUE_INFO[venue].name}</span>
      {line.action && (
        <span className="venue-action" data-testid="venue-shortfall">
          {line.action}
        </span>
      )}
      {(!line.action || balance > 0) && (
        <span className="num amount" title={`${vs.balance ?? '0'} ${vs.currency ?? VENUE_INFO[venue].currency}`}>
          {usd(balance)}
        </span>
      )}
      <span className="chevron" aria-hidden />
    </button>
  );
}

/**
 * Everything about one venue in one place, the same shape for each: balance, what it still needs,
 * and its actions (set up, add funds, withdraw). Used from the Predictions card and the trade panel.
 */
export function VenueSheet({
  venue,
  status,
  accountId,
  onChange,
  onWithdraw,
  onClose,
}: {
  venue: Venue;
  status: TradingStatus;
  accountId: string;
  onChange: () => Promise<void> | void;
  onWithdraw?: () => void;
  onClose: () => void;
}) {
  const { toast } = useWallet();
  const [view, setView] = useState<'main' | 'add-pusd' | 'deposit'>('main');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const vs = venueStatus(status, venue);
  if (!vs) return null;
  const { name } = VENUE_INFO[venue];
  const line = venueLine(venue, vs);
  const short = venueShortfall(vs);
  const balance = Number(vs.balance ?? 0);
  const needsSetup = venue === 'polymarket' && vs.next === 'setup';

  if (view === 'add-pusd') {
    return <AddFundsSheet tradingWallet={status.tradingWallet} onClose={onClose} onDone={async () => void (await onChange())} />;
  }
  if (view === 'deposit') {
    return <HyperliquidDepositSheet accountId={accountId} onClose={onClose} onDone={() => void onChange()} />;
  }

  const addFunds = () => {
    if (venue === 'polymarket') setView('add-pusd');
    else if (venue === 'hyperliquid') setView('deposit');
    else navigate('/swap', { mode: 'bridge', toNetwork: 'bsc', to: USDT_BSC });
  };

  return (
    <Sheet title={name} onClose={onClose}>
      <div className="stack" style={{ gap: 12 }} data-testid={`venue-sheet-${venue}`}>
        <div className="panel">
          <div className="small muted">Balance</div>
          <div className="num" style={{ fontWeight: 800, fontSize: 24, letterSpacing: '-0.02em' }}>
            {usd(balance)}
          </div>
          <div className="small muted">{VENUE_HOLDING[venue]}</div>
        </div>
        {(line.attention || perpsUsdc(vs) > 0) && (
          <div className="notice">{line.attention ? line.text : `${line.text}. Your next order asks to move what it needs.`}</div>
        )}
        <div className="small ink2">{VENUE_SETUP[venue]}</div>
        <ErrorNote error={error} />
        {needsSetup ? (
          <Button
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(undefined);
              try {
                // Other venues set up inside their first order, so nobody pays their gas without trading there.
                await api.predictionSetup(accountId, status.venues ? ['polymarket'] : undefined);
                toast('Trading wallet ready');
                await onChange();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Setting up (about 30 seconds)…' : 'Set up trading'}
          </Button>
        ) : (
          <div className="row" style={{ gap: 8 }}>
            {short?.gas && (
              <Button style={{ flex: 1 }} onClick={() => getFunds(short)}>
                Get BNB
              </Button>
            )}
            {vs.next !== 'blocked' && (
              <Button style={{ flex: 1 }} variant={short?.gas ? 'secondary' : 'primary'} icon="plus" onClick={addFunds}>
                Add funds
              </Button>
            )}
            {venue === 'polymarket' && balance > 0 && onWithdraw && (
              <Button style={{ flex: 1 }} variant="secondary" icon="send" onClick={onWithdraw} data-testid="withdraw-open">
                Withdraw
              </Button>
            )}
          </div>
        )}
        {venue !== 'polymarket' && <div className="small muted">{VENUE_WITHDRAW[venue]}</div>}
      </div>
    </Sheet>
  );
}

export function usePredictionStatus(accountId?: string) {
  const [status, setStatus] = useState<TradingStatus>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    if (!accountId) return;
    setError(undefined);
    try {
      setStatus(await api.predictionStatus(accountId));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [accountId]);
  useEffect(() => {
    void load();
  }, [load]);
  return { status, error, reload: load };
}

export function Predict() {
  const { state } = useWallet();
  // Remount when the Kairos environment changes in Settings so balances, positions and orders reload from the new endpoints.
  return <PredictScreen key={state.settings.apis.kairosExecutionUrl} />;
}

function PredictScreen() {
  const { state, account } = useWallet();
  const route = useRoute();
  const tab = (route.query.get('tab') as Tab) || 'markets';
  const { status, error, reload } = usePredictionStatus(account?.evmAddress ? account.id : undefined);
  const [addFunds, setAddFunds] = useState<{ preset?: AddFundsPreset }>();
  const [withdrawing, setWithdrawing] = useState(false);
  /** Bumped when a withdrawal starts, to remount the recovery card and run its first step. */
  const [recoveryKey, setRecoveryKey] = useState(0);

  if (!state.settings.apis.kairosEnabled) {
    return (
      <div className="screen">
        <TopBar title="Predictions" />
        <div className="screen-body">
          <Empty title="Prediction markets are off">
            <button className="link-btn" onClick={() => navigate('/settings/apis')}>
              Turn them on in Settings
            </button>
          </Empty>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <TopBar title="Predictions" />
      <div className="screen-body stack" style={{ gap: 12 }}>
        {account && !account.evmAddress ? (
          <div className="notice">Prediction markets trade on Polygon. Switch to an account with an EVM address to trade.</div>
        ) : (
          <>
            <TradingCard
              status={status}
              error={error}
              onChange={reload}
              onAddFunds={() => setAddFunds({})}
              onWithdraw={() => setWithdrawing(true)}
            />
            {status && account && (
              <RecoveryCard
                key={recoveryKey}
                autoStart={recoveryKey > 0}
                accountId={account.id}
                onChange={reload}
                onConvert={() => setAddFunds({ preset: { networkId: 'polygon', address: USDC_POLYGON } })}
              />
            )}
          </>
        )}
        <div className="segmented" role="tablist">
          {(['markets', 'positions', 'orders'] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? 'active' : ''}
              onClick={() => navigate('/predict', { tab: t }, true)}
            >
              {t === 'markets' ? 'Markets' : t === 'positions' ? 'Positions' : 'Orders'}
            </button>
          ))}
        </div>
        {tab === 'markets' && <MarketList />}
        {tab === 'positions' && account?.evmAddress && <Positions accountId={account.id} />}
        {tab === 'orders' && account?.evmAddress && <Orders accountId={account.id} />}
      </div>
      {withdrawing && status && account && (
        <WithdrawSheet
          accountId={account.id}
          balance={status.balance ?? '0'}
          owner={account.evmAddress ?? ''}
          onClose={() => setWithdrawing(false)}
          onStarted={() => {
            setWithdrawing(false);
            setRecoveryKey((k) => k + 1);
          }}
        />
      )}
      {addFunds && status && (
        <AddFundsSheet
          tradingWallet={status.tradingWallet}
          preset={addFunds.preset}
          onClose={() => setAddFunds(undefined)}
          onDone={reload}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ trading wallet status

function TradingCard({
  status,
  error,
  onChange,
  onAddFunds,
  onWithdraw,
}: {
  status?: TradingStatus;
  error?: string;
  onChange: () => Promise<void>;
  onAddFunds: () => void;
  onWithdraw: () => void;
}) {
  const { account, toast } = useWallet();
  const [busy, setBusy] = useState(false);
  const [setupError, setSetupError] = useState<string>();

  if (error) return <div className="notice error">Couldn't reach Kairos: {error}</div>;
  if (!status || !account) {
    return (
      <div className="panel row">
        <Spinner size={14} /> <span className="muted">Checking your trading wallet…</span>
      </div>
    );
  }

  // A multi-venue node: every venue as the same row, under one total.
  if (status.venues) return <VenuesCard status={status} accountId={account.id} onChange={onChange} onWithdraw={onWithdraw} />;

  if (status.next === 'setup') {
    return (
      <div className="panel stack" style={{ gap: 10 }} data-testid="prediction-setup">
        <div>
          <div style={{ fontWeight: 700 }}>Set up prediction trading</div>
          <div className="small ink2" style={{ marginTop: 4 }}>
            Creates a trading wallet owned by {shortAddress(status.wallet)} and approves the Polymarket exchange to use it. You'll
            sign twice in this wallet. No gas is needed.
          </div>
        </div>
        <ErrorNote error={setupError} />
        <Button
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setSetupError(undefined);
            try {
              await api.predictionSetup(account.id);
              toast('Trading wallet ready');
              await onChange();
            } catch (e) {
              setSetupError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Setting up (about 30 seconds)…' : 'Set up trading'}
        </Button>
      </div>
    );
  }

  return (
    <div className="panel" data-testid="prediction-balance">
      <div className="row">
        <div style={{ flex: 1 }}>
          <div className="small muted">Trading balance</div>
          <div
            style={{ fontWeight: 800, fontSize: 24, letterSpacing: '-0.02em' }}
            className="num"
            title={`${status.balance ?? '0'} pUSD`}
          >
            {usd(Number(status.balance ?? 0))}
          </div>
        </div>
        <div className="stack" style={{ gap: 6 }}>
          <Button small variant={status.next === 'fund' ? 'primary' : 'secondary'} icon="plus" onClick={onAddFunds}>
            Add funds
          </Button>
          {Number(status.balance ?? 0) > 0 && (
            <Button small variant="secondary" icon="send" onClick={onWithdraw} data-testid="withdraw-open">
              Withdraw
            </Button>
          )}
        </div>
      </div>
      {status.next === 'fund' && (
        <div className="small ink2" style={{ marginTop: 6 }}>
          Add pUSD to start trading.
        </div>
      )}
    </div>
  );
}

/** The trading card on a multi-venue node: one total, then each venue as the same row. */
function VenuesCard({
  status,
  accountId,
  onChange,
  onWithdraw,
}: {
  status: TradingStatus;
  accountId: string;
  onChange: () => Promise<void>;
  onWithdraw: () => void;
}) {
  const venues = tradedVenues(status);
  const [open, setOpen] = useState<Venue>();
  const [choosing, setChoosing] = useState(false);
  const total = venues.reduce((t, v) => t + Number(venueStatus(status, v)?.balance ?? 0), 0);
  const rows = (onOpen: (v: Venue) => void) => (
    <div className="venue-rows">
      {venues.map((v) => (
        <VenueRow key={v} venue={v} vs={venueStatus(status, v)!} onOpen={() => onOpen(v)} />
      ))}
    </div>
  );
  return (
    <div className="panel" data-testid="prediction-balance">
      <div className="row">
        <div style={{ flex: 1 }}>
          <div className="small muted">Trading balance</div>
          <div style={{ fontWeight: 800, fontSize: 24, letterSpacing: '-0.02em' }} className="num">
            {usd(total)}
          </div>
        </div>
        <Button small variant={total > 0 ? 'secondary' : 'primary'} icon="plus" onClick={() => setChoosing(true)}>
          Add funds
        </Button>
      </div>
      {rows(setOpen)}
      {choosing && (
        <Sheet title="Add funds to" onClose={() => setChoosing(false)}>
          <div className="stack" style={{ gap: 8 }}>
            <div className="small muted">Each venue trades with its own balance.</div>
            {rows((v) => {
              setChoosing(false);
              setOpen(v);
            })}
          </div>
        </Sheet>
      )}
      {open && (
        <VenueSheet
          venue={open}
          status={status}
          accountId={accountId}
          onChange={onChange}
          onWithdraw={() => {
            setOpen(undefined);
            onWithdraw();
          }}
          onClose={() => setOpen(undefined)}
        />
      )}
    </div>
  );
}

/**
 * Deposits USDC on Arbitrum to the wallet's own Hyperliquid account through Hyperliquid's bridge.
 * The bridge credits perps; the first order that needs it asks to move it to spot.
 */
export function HyperliquidDepositSheet({
  accountId,
  onClose,
  onDone,
}: {
  accountId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [balances, setBalances] = useState<{ arbitrumUsdc: number; spotUsdc: number; perpsUsdc: number }>();
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState<string>();
  useEffect(() => {
    api
      .hyperliquidBalances(accountId)
      .then(setBalances)
      .catch((e: Error) => setError(e.message));
  }, [accountId]);
  const max = balances?.arbitrumUsdc ?? 0;
  const amt = Number(amount);
  const problem = !amount
    ? undefined
    : !(amt > 0)
      ? 'Enter an amount'
      : amt < HYPERLIQUID_MIN_DEPOSIT
        ? `Deposit at least ${HYPERLIQUID_MIN_DEPOSIT} USDC. Hyperliquid loses smaller deposits.`
        : amt > max
          ? `You have ${usd(max)} USDC on Arbitrum`
          : undefined;

  if (sent) {
    return (
      <Sheet title="Deposit sent" onClose={onClose}>
        <div className="stack" data-testid="hl-deposit-sent">
          <div className="result">
            <div className="ink2">{usd(Number(sent))} USDC is on its way to your Hyperliquid account.</div>
            <div className="small muted">Hyperliquid usually credits it within a minute.</div>
          </div>
          <Button onClick={onClose}>Done</Button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title="Deposit to Hyperliquid" onClose={onClose}>
      <div className="stack" style={{ gap: 12 }} data-testid="hl-deposit-sheet">
        <div>
          <div className="row small" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
            <label htmlFor="hl-deposit-amount" className="muted" style={{ fontWeight: 600 }}>
              USDC from Arbitrum
            </label>
            <span className="muted num">{balances ? `Available ${usd(max)}` : <Spinner />}</span>
          </div>
          <div className="amount-input">
            <span className="amount-prefix">$</span>
            <input
              id="hl-deposit-amount"
              className="num"
              inputMode="decimal"
              placeholder="0"
              autoComplete="off"
              autoFocus
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            />
          </div>
          <div className="quick-amounts">
            <button
              type="button"
              disabled={!(max >= HYPERLIQUID_MIN_DEPOSIT)}
              onClick={() => setAmount(String(Math.floor(max * 100) / 100))}
            >
              Max
            </button>
          </div>
        </div>
        {balances && (
          <div className="small muted num">
            On Hyperliquid now: {usd(balances.spotUsdc)} spot, {usd(balances.perpsUsdc)} perps
          </div>
        )}
        {balances && max < HYPERLIQUID_MIN_DEPOSIT && (
          <div className="notice">
            You need at least {HYPERLIQUID_MIN_DEPOSIT} USDC on Arbitrum.{' '}
            <button
              className="link-btn"
              onClick={() => navigate('/swap', { mode: 'bridge', toNetwork: 'arbitrum', to: ARBITRUM_USDC })}
            >
              Get USDC on Arbitrum
            </button>
          </div>
        )}
        <div className="small muted">
          Sent to Hyperliquid&apos;s bridge on Arbitrum, which credits your own Hyperliquid account (your address there is this
          wallet&apos;s). Costs a little ETH on Arbitrum for gas.
        </div>
        {problem && <div className="small neg">{problem}</div>}
        <ErrorNote error={error} />
        <Button
          variant="dark"
          loading={busy}
          disabled={!amount || !!problem || !balances}
          data-testid="hl-deposit-confirm"
          onClick={async () => {
            setBusy(true);
            setError(undefined);
            try {
              const tx = await api.hyperliquidDeposit(accountId, amount);
              setSent(tx.amount ?? amount);
              onDone();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Deposit {amt >= HYPERLIQUID_MIN_DEPOSIT ? usd(amt) : ''}
        </Button>
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ recovering non-pUSD deposits

const USDC_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const PUSD_POLYGON = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';

/** Shown when the trading wallet holds tokens trading can't use; walks the owner through the timelocked exit. */
function RecoveryCard({
  accountId,
  autoStart,
  onChange,
  onConvert,
}: {
  accountId: string;
  /** Run the first step as soon as the state loads (right after the user starts a withdrawal). */
  autoStart?: boolean;
  onChange: () => Promise<void>;
  onConvert: () => void;
}) {
  const { account, toast } = useWallet();
  const [state, setState] = useState<RecoveryState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [recovered, setRecovered] = useState<'stray' | 'pusd'>();
  const [needGas, setNeedGas] = useState<{ address: string; have: string; needed: string }>();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const load = useCallback(() => {
    api
      .predictionRecoveryState(accountId)
      .then(setState)
      .catch(() => setState(undefined));
  }, [accountId]);
  useEffect(load, [load]);
  useEffect(() => {
    if (state?.next !== 'wait') return;
    const t = setInterval(() => {
      const n = Math.floor(Date.now() / 1000);
      setNow(n);
      // Re-read the chain once the timelock has passed.
      if (n > state.unlocksAt) load();
    }, 15_000);
    return () => clearInterval(t);
  }, [state, load]);

  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStarted.current || state?.next !== 'pause') return;
    autoStarted.current = true;
    void stepRef.current?.();
  }, [autoStart, state]);
  const stepRef = useRef<() => Promise<void>>(undefined);

  if (recovered === 'pusd') {
    return (
      <div className="panel stack" style={{ gap: 8 }} data-testid="withdraw-done">
        <div style={{ fontWeight: 700 }}>pUSD is in your wallet</div>
        <div className="small ink2">
          It's on Polygon in {account?.name ?? 'this account'}. Convert it to USDC to use it anywhere.
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Button small onClick={() => navigate('/swap', { network: 'polygon', from: PUSD_POLYGON, to: USDC_POLYGON })}>
            Convert to USDC
          </Button>
          <Button small variant="secondary" onClick={() => setRecovered(undefined)}>
            Done
          </Button>
        </div>
      </div>
    );
  }
  if (recovered) {
    return (
      <div className="panel stack" style={{ gap: 8 }}>
        <div style={{ fontWeight: 700 }}>Funds recovered to your wallet</div>
        <div className="small ink2">Convert them to pUSD and add them to your trading balance in one step.</div>
        <Button small onClick={onConvert}>
          Convert to pUSD and add funds
        </Button>
      </div>
    );
  }
  if (!state || state.next === 'none' || !account?.evmAddress) return null;
  const notOwner = state.owner.toLowerCase() !== account.evmAddress.toLowerCase();
  const total = state.stray.map((t) => `${formatAmount(t.amount, t.decimals)} ${t.symbol}`).join(' and ');
  const minutes = Math.max(0, Math.ceil((state.unlocksAt - now) / 60));

  const step = async () => {
    if (!state) return;
    setBusy(true);
    setError(undefined);
    try {
      // Without enough POL for gas, prompt for it and continue automatically once it arrives.
      const gas = await api.predictionRecoveryGas(accountId);
      if (BigInt(gas.have) < BigInt(gas.needed)) {
        setNeedGas(gas);
        return;
      }
      setNeedGas(undefined);
      const prev = state.next;
      const next = await api.predictionRecoveryStep(accountId);
      setState(next);
      if (prev === 'withdraw') {
        setRecovered(state.withdrawal && !state.stray.length ? 'pusd' : 'stray');
        toast(state.withdrawal ? 'Withdrawn to your wallet' : 'Funds recovered');
      } else if (prev === 'pause') toast(state.withdrawal ? 'Withdrawal started' : 'Recovery started');
      await onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  stepRef.current = step;
  const w = state.withdrawal;
  const cancel = async () => {
    setBusy(true);
    try {
      setState(await api.predictionWithdrawCancel(accountId));
      toast('Withdrawal cancelled');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel stack" style={{ gap: 8 }} data-testid="recovery-card">
      <div>
        <div style={{ fontWeight: 700 }}>
          {w
            ? `Withdrawing $${formatAmount(w.amount, 6, 2)} to your wallet`
            : state.stray.length
              ? `Recover ${total}`
              : 'Finish recovery'}
        </div>
        <div className="small ink2" style={{ marginTop: 4 }}>
          {w
            ? `pUSD moves from your trading wallet to ${shortAddress(account.evmAddress)} on Polygon${state.stray.length ? `, along with ${total}` : ''}.`
            : state.stray.length
              ? 'Your trading wallet holds tokens that trading can’t use (only pUSD counts). Move them back to your wallet, then convert them to pUSD.'
              : 'Your trading wallet is still paused from a withdrawal. Resume it to keep trading normally.'}
        </div>
      </div>
      {state.next === 'pause' && (
        <div className="small muted">
          Step 1 of 2: start the {Math.round(state.timelockSeconds / 60)}-minute safety delay. Needs a little POL for gas.
        </div>
      )}
      {state.next === 'wait' && (
        <div className="small muted">
          Step 2 unlocks at {new Date(state.unlocksAt * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}{' '}
          (about {minutes} min). You can close the wallet and come back.
        </div>
      )}
      {state.next === 'withdraw' && (
        <div className="small muted">Step 2 of 2: withdraw to your wallet and resume the trading wallet.</div>
      )}
      {notOwner && <div className="notice">This trading wallet is owned by another account.</div>}
      {w && (state.next === 'pause' || state.next === 'wait') && !busy && (
        <button className="link-btn small" style={{ alignSelf: 'flex-start' }} onClick={cancel}>
          Cancel withdrawal
        </button>
      )}
      <ErrorNote error={error} />
      {needGas && state.next !== 'wait' && <GasTopUp gas={needGas} onFunded={() => void step()} />}
      {state.next !== 'wait' && !notOwner && !needGas && (
        <Button small loading={busy} onClick={step}>
          {state.next === 'pause'
            ? w
              ? 'Start withdrawal'
              : 'Start recovery'
            : state.next === 'withdraw'
              ? 'Withdraw to my wallet'
              : 'Resume trading wallet'}
        </Button>
      )}
    </div>
  );
}

/** Starts moving pUSD from the trading wallet back to the main wallet. */
function WithdrawSheet({
  accountId,
  balance,
  owner,
  onClose,
  onStarted,
}: {
  accountId: string;
  balance: string;
  owner: string;
  onClose: () => void;
  onStarted: () => void;
}) {
  const [amount, setAmount] = useState('');
  /** Max withdraws everything, including sub-cent dust the field doesn't show. */
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const max = Number(balance);
  const amt = Number(amount);
  const problem = amount && !(amt > 0) ? 'Enter an amount' : !all && amt > max ? `You have ${usd(max)} to withdraw` : undefined;

  return (
    <Sheet title="Withdraw to your wallet" onClose={onClose}>
      <div className="stack" style={{ gap: 12 }} data-testid="withdraw-sheet">
        <div>
          <div className="row small" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
            <label htmlFor="withdraw-amount" className="muted" style={{ fontWeight: 600 }}>
              Amount
            </label>
            <span className="muted num">Available {usd(max)}</span>
          </div>
          <div className="amount-input">
            <span className="amount-prefix">$</span>
            <input
              id="withdraw-amount"
              className="num"
              inputMode="decimal"
              placeholder="0"
              autoComplete="off"
              autoFocus
              value={amount}
              onChange={(e) => {
                setAll(false);
                setAmount(e.target.value.replace(/[^0-9.]/g, ''));
              }}
            />
          </div>
          <div className="quick-amounts">
            {[0.25, 0.5].map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => {
                  setAll(false);
                  setAmount((Math.floor(max * f * 100) / 100).toString());
                }}
              >
                {f * 100}%
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setAll(true);
                setAmount((Math.floor(max * 100) / 100).toString());
              }}
            >
              Max
            </button>
          </div>
        </div>

        <div className="panel stack" style={{ gap: 6 }}>
          <div className="kv">
            <span>To</span>
            <span className="num">{shortAddress(owner)} · Polygon</span>
          </div>
          <div className="kv">
            <span>Arrives in</span>
            <span>About 1 hour</span>
          </div>
          <div className="kv">
            <span>Network fee</span>
            <span>A few cents of POL</span>
          </div>
        </div>
        <div className="small muted">
          Your trading wallet has a 60-minute safety delay before money can leave it. Trading keeps working meanwhile, but cancel
          open orders that would need this money. You can close the wallet and come back to finish.
        </div>
        {problem && <div className="small neg">{problem}</div>}
        <ErrorNote error={error} />
        <Button
          block
          loading={busy}
          disabled={!(amt > 0) || !!problem}
          data-testid="withdraw-start"
          onClick={async () => {
            setBusy(true);
            setError(undefined);
            try {
              await api.predictionWithdrawStart(accountId, all ? 'all' : amount);
              onStarted();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {amt > 0 ? `Withdraw ${usd(all ? Math.floor(max * 100) / 100 : amt)}` : 'Withdraw'}
        </Button>
      </div>
    </Sheet>
  );
}

/** Prompts for the POL the next recovery step needs, polls the balance, and fires onFunded once it's there. */
function GasTopUp({ gas, onFunded }: { gas: { address: string; have: string; needed: string }; onFunded: () => void }) {
  const { account } = useWallet();
  const [qr, setQr] = useState<string>();
  const fired = useRef(false);
  useEffect(() => {
    QRCode.toDataURL(gas.address, { margin: 1, width: 240, color: { dark: '#1a2233', light: '#ffffff' } }).then(setQr, () => {});
  }, [gas.address]);
  useEffect(() => {
    if (!account) return;
    const t = setInterval(async () => {
      try {
        const g = await api.predictionRecoveryGas(account.id);
        if (!fired.current && BigInt(g.have) >= BigInt(g.needed)) {
          fired.current = true;
          clearInterval(t);
          onFunded();
        }
      } catch {
        // Keep polling.
      }
    }, 6000);
    return () => clearInterval(t);
  }, [account, onFunded]);
  const missing = BigInt(gas.needed) - BigInt(gas.have);
  return (
    <div className="stack" style={{ gap: 8 }} data-testid="gas-topup">
      <div className="notice info">
        Your account needs about <strong>{formatAmount(missing > 0n ? missing : 0n, 18, 4)} POL</strong> on Polygon to pay the
        network fee (a few cents). Send POL to the address below from any wallet or exchange. Recovery continues automatically
        once it arrives.
      </div>
      <div className="row" style={{ alignItems: 'center' }}>
        {qr && <img src={qr} alt="QR code for your Polygon address" width={88} height={88} />}
        <div style={{ minWidth: 0 }}>
          <div className="small muted">Your Polygon address</div>
          <div className="mono">{gas.address}</div>
          <CopyButton text={gas.address} label="Copy address" />
        </div>
      </div>
      <div className="row small muted">
        <Spinner size={12} /> Waiting for POL…
      </div>
      <Button small variant="secondary" onClick={() => navigate('/swap', { mode: 'bridge', toNetwork: 'polygon', to: 'native' })}>
        Bridge POL from another network
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------ markets

type VenueFilter = Venue | 'all';
const PAGE = 30;
/** Per venue when listing them all together; merged by 24h volume. */
const ALL_PAGE = 15;

/**
 * One page of markets: one venue's, or every venue's merged by 24h volume. `loaded` counts what each
 * venue has already shown, so the next page continues each list; `exhausted` lists venues with no more.
 */
async function marketPage(
  filter: VenueFilter,
  q: { category: Category; search: string },
  loaded: PredictionEvent[],
): Promise<{ events: PredictionEvent[]; exhausted: Venue[] }> {
  const venues = filter === 'all' ? VENUES : [filter];
  const limit = filter === 'all' ? ALL_PAGE : PAGE;
  const pages = await Promise.allSettled(
    venues.map((venue) => api.predictionMarkets({ venue, ...q, limit, offset: loaded.filter((e) => e.venue === venue).length })),
  );
  // One venue being down shouldn't hide the others; with nothing at all, say why.
  if (pages.every((p) => p.status === 'rejected')) throw (pages[0] as PromiseRejectedResult).reason;
  const exhausted = venues.filter(
    (_, i) => pages[i].status === 'rejected' || (pages[i] as PromiseFulfilledResult<PredictionEvent[]>).value.length < limit,
  );
  const events = pages
    .flatMap((p) => (p.status === 'fulfilled' ? p.value : []))
    .sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0));
  return { events, exhausted };
}

function MarketList() {
  const route = useRoute();
  const asked = route.query.get('venue');
  const venue: VenueFilter = VENUES.find((v) => v === asked) ?? 'all';
  const [category, setCategory] = useState<Category>('all');
  const [query, setQuery] = useState('');
  const [events, setEvents] = useState<PredictionEvent[]>();
  const [error, setError] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState<Venue[]>([]);
  const done = venue === 'all' ? VENUES.every((v) => exhausted.includes(v)) : exhausted.includes(venue);

  useEffect(() => {
    let stale = false;
    setEvents(undefined);
    setError(undefined);
    setExhausted([]);
    const t = setTimeout(
      () =>
        marketPage(venue, { category, search: query }, [])
          .then((page) => {
            if (stale) return;
            cacheEvents(page.events);
            setEvents(page.events);
            setExhausted(page.exhausted);
          })
          .catch((e: Error) => !stale && setError(e.message)),
      query ? 350 : 0,
    );
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [venue, category, query]);

  const more = async () => {
    setLoadingMore(true);
    try {
      const page = await marketPage(venue, { category, search: query }, events ?? []);
      cacheEvents(page.events);
      // Appended, not re-sorted, so rows already on screen stay put.
      setEvents((cur) => [...(cur ?? []), ...page.events.filter((n) => !cur?.some((c) => c.id === n.id))]);
      setExhausted((cur) => [...new Set([...cur, ...page.exhausted])]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="venue-switch" role="radiogroup" aria-label="Venue">
        {(['all', ...VENUES] as const).map((v) => (
          <button
            key={v}
            role="radio"
            aria-checked={venue === v}
            className={venue === v ? 'active' : ''}
            onClick={() => navigate('/predict', { tab: 'markets', ...(v === 'all' ? {} : { venue: v }) }, true)}
          >
            {v !== 'all' && <span className={`venue-dot ${v}`} aria-hidden />}
            {v === 'all' ? 'All' : VENUE_INFO[v].name}
          </button>
        ))}
      </div>
      <div className="input-group">
        <input
          className="input"
          placeholder="Search markets"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search markets"
        />
        <span className="suffix muted">
          <Icon name="search" size={16} />
        </span>
      </div>
      <div className="chip-row" role="tablist" aria-label="Categories">
        {CATEGORIES.map((c) => (
          <button key={c} className={`chip ${category === c ? 'active' : ''}`} onClick={() => setCategory(c)}>
            {c === 'all' ? 'Trending' : c[0].toUpperCase() + c.slice(1)}
          </button>
        ))}
      </div>
      <ErrorNote error={error} />
      {!events && !error && (
        <div className="center" style={{ padding: 24 }}>
          <Spinner />
        </div>
      )}
      {events && !events.length && <Empty title="No markets found">Try another search or category.</Empty>}
      <div className="list" data-testid="market-list">
        {events?.map((e) => (
          <EventRow key={e.id} event={e} />
        ))}
      </div>
      {events && events.length > 0 && !done && (
        <Button variant="secondary" small loading={loadingMore} onClick={more}>
          Load more
        </Button>
      )}
    </div>
  );
}

function EventRow({ event }: { event: PredictionEvent }) {
  const single = event.outcomes.length === 1;
  const lead = [...event.outcomes].sort((a, b) => (b.price ?? 0) - (a.price ?? 0))[0];
  return (
    <button
      className="list-item"
      onClick={() =>
        single ? navigate('/predict/market', { id: event.outcomes[0].marketId }) : navigate('/predict/event', { id: event.id })
      }
    >
      {event.image ? <img className="market-thumb" src={event.image} alt="" /> : <span className="market-thumb" />}
      <div className="main">
        <div className="title market-row-title">{event.title}</div>
        <div className="sub ellipsis">
          <span
            className={`venue-dot ${event.venue}`}
            title={VENUE_INFO[event.venue].name}
            aria-label={VENUE_INFO[event.venue].name}
          />
          {single ? (event.sides?.join(' / ') ?? 'Yes / No') : (lead.label ?? lead.title)}
          {event.volume24h ? ` · ${compactUsd(event.volume24h)} vol` : ''}
        </div>
      </div>
      <div className="end">
        <div className="prob">{pct(lead.price)}</div>
        {single && <div className="sub">{event.sides?.[0] ?? 'Yes'}</div>}
      </div>
    </button>
  );
}

// ------------------------------------------------------------------ positions & orders

const usd = (v: number) =>
  `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signedUsd = (v: number) => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`;
const signedPct = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%`;
const shareCount = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2 });

function timeAgo(iso?: string): string | undefined {
  if (!iso) return undefined;
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return undefined;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const outcomeTone = (o: string) => (/^no$/i.test(o) ? 'no' : /^yes$/i.test(o) ? 'yes' : 'neutral');

function Thumb({ image, title }: { image?: string; title: string }) {
  return image ? (
    <img className="market-thumb" src={image} alt="" />
  ) : (
    <span className="market-thumb market-thumb-letter" aria-hidden="true">
      {title.trim()[0]?.toUpperCase() ?? '?'}
    </span>
  );
}

function Positions({ accountId }: { accountId: string }) {
  const [data, setData] = useState<PositionsView>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api
      .predictionPositions(accountId)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [accountId]);
  if (error) return <ErrorNote error={error} />;
  if (!data)
    return (
      <div className="center" style={{ padding: 24 }}>
        <Spinner />
      </div>
    );
  if (!data.positions.length && !data.history.length)
    return (
      <Empty title="No positions yet">
        Shares you buy show up here.{' '}
        <button className="link-btn" onClick={() => navigate('/predict', { tab: 'markets' }, true)}>
          Browse markets
        </button>
      </Empty>
    );
  const { totals } = data;
  const open = data.positions.filter((p) => p.state === 'open');
  const resolved = data.positions.filter((p) => p.state !== 'open');
  return (
    <div className="stack" style={{ gap: 12 }}>
      {!data.positions.length && <div className="small muted center">No open positions right now.</div>}
      {data.positions.length > 0 && (
        <div className="portfolio-summary" data-testid="positions-summary">
          <div>
            <div className="small muted">Positions value</div>
            <div className="portfolio-value num">{usd(totals.value)}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="small muted">Unrealized P&amp;L</div>
            <div className={`num portfolio-pnl ${totals.pnl >= 0 ? 'pos' : 'neg'}`}>
              {signedUsd(totals.pnl)}
              {totals.pnlPct !== undefined && <span className="small"> ({signedPct(totals.pnlPct)})</span>}
            </div>
            <div className="small muted num">
              Cost {usd(totals.cost)} · {data.positions.length} {data.positions.length === 1 ? 'position' : 'positions'}
            </div>
          </div>
        </div>
      )}
      <div className="stack" style={{ gap: 8 }} data-testid="position-list">
        {open.map((p) => (
          <PositionCard key={p.key} p={p} />
        ))}
      </div>
      {resolved.length > 0 && (
        <>
          <div className="section-label">Resolved</div>
          <div className="stack" style={{ gap: 8 }}>
            {resolved.map((p) => (
              <PositionCard key={p.key} p={p} />
            ))}
          </div>
        </>
      )}
      {data.history.length > 0 && <ClosedPositions history={data.history} realized={totals.realized} />}
    </div>
  );
}

const CLOSED_PREVIEW = 5;

/** Positions sold down to nothing, with what each one made or lost. */
function ClosedPositions({ history, realized }: { history: PositionView[]; realized?: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? history : history.slice(0, CLOSED_PREVIEW);
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div className="section-label">Closed</div>
        {realized !== undefined && (
          <div className="small num" data-testid="realized-total">
            <span className="muted">Realized P&amp;L </span>
            <span className={realized >= 0 ? 'pos' : 'neg'} style={{ fontWeight: 700 }}>
              {signedUsd(realized)}
            </span>
          </div>
        )}
      </div>
      <div className="stack" style={{ gap: 8 }} data-testid="closed-list">
        {shown.map((p) => (
          <ClosedCard key={p.key} p={p} />
        ))}
      </div>
      {history.length > CLOSED_PREVIEW && (
        <button className="link-btn small" onClick={() => setAll(!all)}>
          {all ? 'Show less' : `Show all ${history.length}`}
        </button>
      )}
    </>
  );
}

function ClosedCard({ p }: { p: PositionView }) {
  const pnl = p.realizedPnl ?? 0;
  return (
    <div className="position-card closed">
      <button
        className="position-main"
        onClick={() => p.marketId && navigate('/predict/market', { id: p.marketId, outcome: p.outcome })}
        disabled={!p.marketId}
      >
        <Thumb image={p.image} title={p.title} />
        <div className="main">
          <div className="position-title">{p.title}</div>
          {p.subtitle && <div className="small muted ellipsis">{p.subtitle}</div>}
          <div className="row" style={{ gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            <span className={`outcome-pill ${outcomeTone(p.outcome)}`}>{p.outcome}</span>
            <VenueTag venue={p.venue} />
            {p.avgPrice !== undefined && <span className="small muted num">Avg {cents(p.avgPrice)}</span>}
          </div>
        </div>
        <div className="end">
          <div className={`num ${Math.abs(pnl) < 0.005 ? 'muted' : pnl > 0 ? 'pos' : 'neg'}`} style={{ fontWeight: 750 }}>
            {signedUsd(pnl)}
          </div>
          <div className="small muted">{p.closedAt ? `Closed ${timeAgo(p.closedAt)}` : 'Closed'}</div>
        </div>
      </button>
    </div>
  );
}

function PositionCard({ p }: { p: PositionView }) {
  const go = (side?: 'buy' | 'sell') =>
    p.marketId && navigate('/predict/market', { id: p.marketId, outcome: p.outcome, ...(side ? { side } : {}) });
  return (
    <div className="position-card">
      <button className="position-main" onClick={() => go()} disabled={!p.marketId}>
        <Thumb image={p.image} title={p.title} />
        <div className="main">
          <div className="position-title">{p.title}</div>
          {p.subtitle && <div className="small muted ellipsis">{p.subtitle}</div>}
          <div className="row" style={{ gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            <span className={`outcome-pill ${outcomeTone(p.outcome)}`}>{p.outcome}</span>
            <span className="small num" style={{ fontWeight: 650 }}>
              {shareCount(p.shares)} shares
            </span>
            <VenueTag venue={p.venue} />
          </div>
          {p.avgPrice !== undefined && (
            <div className="small muted num" style={{ marginTop: 3 }}>
              Avg {cents(p.avgPrice)}
              {p.state === 'open' && p.price !== undefined && ` → now ${cents(p.price)}`}
            </div>
          )}
        </div>
        <div className="end">
          {p.state === 'open' ? (
            <>
              <div className="num" style={{ fontWeight: 750 }}>
                {p.value !== undefined ? usd(p.value) : '—'}
              </div>
              {p.pnl !== undefined && (
                <div className={`small num ${p.pnl >= 0 ? 'pos' : 'neg'}`} style={{ fontWeight: 650 }}>
                  {signedUsd(p.pnl)}
                  {p.pnlPct !== undefined && ` (${signedPct(p.pnlPct)})`}
                </div>
              )}
            </>
          ) : (
            <>
              <span className={`status-badge ${p.state === 'won' ? 'filled' : 'failed'}`}>
                {p.state === 'won' ? 'Won' : 'Lost'}
              </span>
              {p.value !== undefined && (
                <div className="small num muted" style={{ marginTop: 4 }}>
                  {usd(p.value)}
                </div>
              )}
            </>
          )}
        </div>
      </button>
      {p.state === 'open' && p.marketId && (
        <div className="position-actions">
          {p.endDate && (
            <span className="small muted">
              Ends {new Date(p.endDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </span>
          )}
          <span className="spacer" />
          <button className="mini-btn" onClick={() => go('buy')}>
            Buy more
          </button>
          <button className="mini-btn strong" onClick={() => go('sell')} data-testid="sell-position">
            Sell
          </button>
        </div>
      )}
      {p.state === 'won' && <div className="position-actions small muted">Winning shares pay $1 each when redeemed.</div>}
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  queued: 'Pending',
  locked: 'Pending',
  orphaned: 'Pending',
  executing: 'Sending',
  live: 'Open',
  open: 'Open',
  partial: 'Partly filled',
  filled: 'Filled',
  cancelled: 'Cancelled',
  expired: 'Expired',
  failed: 'Failed',
};

function Orders({ accountId }: { accountId: string }) {
  const { toast } = useWallet();
  const [open, setOpen] = useState(true);
  const [orders, setOrders] = useState<OrderView[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  const load = useCallback(() => {
    setOrders(undefined);
    setError(undefined);
    api
      .predictionOrders(accountId, open)
      .then(setOrders)
      .catch((e: Error) => setError(e.message));
  }, [accountId, open]);
  useEffect(load, [load]);

  const cancel = async (ids: string[] | 'all') => {
    setBusy(ids === 'all' ? 'all' : ids[0]);
    try {
      await api.predictionCancel(accountId, ids);
      toast(ids === 'all' ? 'Open orders cancelled' : 'Order cancelled');
      load();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row">
        <div className="chip-row" style={{ flex: 1, padding: 0 }}>
          <button className={`chip ${open ? 'active' : ''}`} onClick={() => setOpen(true)}>
            Open
          </button>
          <button className={`chip ${!open ? 'active' : ''}`} onClick={() => setOpen(false)}>
            History
          </button>
        </div>
        {open && !!orders?.length && (
          <Button small variant="secondary" loading={busy === 'all'} onClick={() => cancel('all')}>
            Cancel all
          </Button>
        )}
      </div>
      <ErrorNote error={error} />
      {!orders && !error && (
        <div className="center" style={{ padding: 24 }}>
          <Spinner />
        </div>
      )}
      {orders && !orders.length && (
        <Empty title={open ? 'No open orders' : 'No orders yet'}>
          {open ? 'Limit orders waiting to fill show up here.' : 'Orders you place show up here.'}
        </Empty>
      )}
      <div className="stack" style={{ gap: 8 }} data-testid="order-list">
        {orders?.map((o) => (
          <OrderCard key={o.id} o={o} busy={busy} onCancel={() => cancel([o.id])} />
        ))}
      </div>
    </div>
  );
}

function OrderCard({ o, busy, onCancel }: { o: OrderView; busy?: string; onCancel: () => void }) {
  const fillPct = o.shares > 0 ? Math.min(1, o.filled / o.shares) : 0;
  const shownPrice = o.avgFillPrice ?? o.price;
  return (
    <div className="position-card">
      <button
        className="position-main"
        onClick={() => o.marketId && navigate('/predict/market', { id: o.marketId })}
        disabled={!o.marketId}
      >
        <Thumb image={o.image} title={o.title} />
        <div className="main">
          <div className="position-title">{o.title}</div>
          {o.subtitle && <div className="small muted ellipsis">{o.subtitle}</div>}
          <div className="row" style={{ gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            <span className={`outcome-pill ${outcomeTone(o.outcome)}`}>
              {o.side === 'buy' ? 'Buy' : 'Sell'} {o.outcome}
            </span>
            <span className="small muted num">
              {shareCount(o.shares)} @ {cents(o.price)}
            </span>
            <VenueTag venue={o.venue} />
          </div>
        </div>
        <div className="end">
          <span className={`status-badge ${o.status}`}>{STATUS_LABEL[o.status] ?? o.status}</span>
          <div className="small muted" style={{ marginTop: 4 }}>
            {timeAgo(o.createdAt)}
          </div>
        </div>
      </button>
      {(o.open || o.filled > 0 || o.error) && (
        <div className="position-actions">
          <div style={{ flex: 1, minWidth: 0 }}>
            {o.error && o.status === 'failed' ? (
              <div className="small neg ellipsis" title={o.error}>
                {o.error}
              </div>
            ) : (
              <>
                <div className="small muted num">
                  {shareCount(o.filled)} of {shareCount(o.shares)} filled
                  {o.filled > 0 && shownPrice !== undefined && ` · avg ${cents(shownPrice)}`}
                  {o.filled > 0 && shownPrice !== undefined && ` · ${usd(o.filled * shownPrice)}`}
                </div>
                {o.open && (
                  <div className="fill-bar" aria-hidden="true">
                    <span style={{ width: `${fillPct * 100}%` }} />
                  </div>
                )}
              </>
            )}
          </div>
          {o.open && (
            <button className="mini-btn" disabled={!!busy} onClick={onCancel}>
              {busy === o.id ? <Spinner size={12} /> : 'Cancel'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
