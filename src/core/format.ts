/** Amount parsing/formatting helpers that work on base-unit bigints. */

export function parseUnits(value: string, decimals: number): bigint {
  const v = value.trim();
  if (!/^\d*\.?\d*$/.test(v) || v === '' || v === '.') throw new Error('Invalid amount');
  const [whole, frac = ''] = v.split('.');
  if (frac.length > decimals) throw new Error(`Too many decimal places (max ${decimals})`);
  return BigInt((whole || '0') + frac.padEnd(decimals, '0'));
}

export function formatUnits(value: bigint | string, decimals: number): string {
  let v = BigInt(value);
  const neg = v < 0n;
  if (neg) v = -v;
  const s = v.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals) || '0';
  const frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, '') : '';
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** Compact display: up to `maxFrac` significant fractional digits, thousands separators. */
export function formatAmount(value: bigint | string, decimals: number, maxFrac = 6): string {
  const full = formatUnits(value, decimals);
  const [whole, frac = ''] = full.split('.');
  const wholeFmt = BigInt(whole.replace('-', '')).toLocaleString('en-US');
  const sign = full.startsWith('-') ? '-' : '';
  if (!frac) return sign + wholeFmt;
  let shown = frac.slice(0, maxFrac).replace(/0+$/, '');
  if (!shown && whole.replace('-', '') === '0') {
    // Tiny non-zero value: show the first significant digits instead of 0.
    const firstSig = frac.search(/[1-9]/);
    shown = frac.slice(0, Math.min(firstSig + 2, frac.length)).replace(/0+$/, '');
  }
  return shown ? `${sign}${wholeFmt}.${shown}` : sign + wholeFmt;
}

export function formatUsd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  if (value > 0 && value < 0.01) return '<$0.01';
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function shortAddress(addr: string, chars = 4): string {
  if (!addr) return '';
  const pre = addr.startsWith('0x') ? chars + 2 : chars;
  return addr.length <= pre + chars + 3 ? addr : `${addr.slice(0, pre)}…${addr.slice(-chars)}`;
}

export function toUsd(balance: bigint | string, decimals: number, price?: number): number | undefined {
  if (price === undefined) return undefined;
  return Number(formatUnits(balance, decimals)) * price;
}
