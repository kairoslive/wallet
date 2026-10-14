import type { Network, Token } from '../../core/types';
import { formatAmount, formatUsd, parseUnits } from '../../core/format';
import { Spinner, TokenIcon } from './ui';
import { Icon } from './Icon';

/** Keeps only digits and a single dot, and trims fraction digits past the token's precision. */
export function sanitizeAmount(raw: string, decimals = 18): string {
  let v = raw.replace(',', '.').replace(/[^\d.]/g, '');
  const dot = v.indexOf('.');
  if (dot !== -1) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '').slice(0, decimals);
  if (/^0\d/.test(v)) v = v.replace(/^0+(?=\d)/, '');
  return v;
}

/** USD value of a human-readable amount, if the price is known. */
export function amountUsd(amount: string, priceUsd?: number): number | undefined {
  const n = Number(amount);
  if (priceUsd === undefined || !amount || !Number.isFinite(n)) return undefined;
  return n * priceUsd;
}

/** Why an entered amount can't be used, or undefined if it's fine (or still empty). */
export function amountError(amount: string, token: Token, balance?: string): string | undefined {
  if (!amount || amount === '.') return undefined;
  let base: bigint;
  try {
    base = parseUnits(amount, token.decimals);
  } catch (e) {
    return (e as Error).message;
  }
  if (balance !== undefined && base > BigInt(balance)) {
    return `Not enough ${token.symbol}. You have ${formatAmount(balance, token.decimals)}.`;
  }
  return undefined;
}

export function AmountInput({
  label,
  token,
  network,
  value,
  onChange,
  onPickToken,
  balance,
  usd,
  onMax,
  maxLoading,
  readOnly,
  invalid,
}: {
  label: string;
  token?: Token;
  network?: Network;
  value: string;
  onChange?: (v: string) => void;
  onPickToken: () => void;
  /** Base units. */
  balance?: string;
  usd?: number;
  onMax?: () => void;
  maxLoading?: boolean;
  readOnly?: boolean;
  invalid?: boolean;
}) {
  return (
    <div className="amount-box" style={invalid ? { borderColor: 'var(--neg)' } : undefined}>
      <div className="row small">
        <span className="muted">{label}</span>
        <div className="spacer" />
        {token && balance !== undefined && (
          <span className="muted num">
            Balance {formatAmount(balance, token.decimals)} {token.symbol}
          </span>
        )}
      </div>
      <div className="row">
        {readOnly ? (
          <div className="readonly ellipsis" style={{ flex: 1, color: value ? undefined : 'var(--muted)' }}>
            {value || '0'}
          </div>
        ) : (
          <input
            inputMode="decimal"
            placeholder="0"
            aria-label={`${label} amount`}
            value={value}
            onChange={(e) => onChange?.(sanitizeAmount(e.target.value, token?.decimals))}
          />
        )}
        <button type="button" className="chip" onClick={onPickToken} style={{ paddingLeft: token ? 4 : 10 }}>
          {token ? (
            <>
              <TokenIcon token={token} network={network} size={22} />
              {token.symbol}
            </>
          ) : (
            'Select token'
          )}
          <Icon name="chevronDown" size={14} />
        </button>
      </div>
      <div className="row small" style={{ minHeight: 18 }}>
        <span className="muted num">{usd !== undefined ? formatUsd(usd) : ''}</span>
        <div className="spacer" />
        {onMax && token && (
          <button type="button" className="link-btn" onClick={onMax} disabled={maxLoading}>
            {maxLoading ? <Spinner size={12} /> : 'Max'}
          </button>
        )}
      </div>
    </div>
  );
}
