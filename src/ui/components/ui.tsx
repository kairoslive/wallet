import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { Network, Token } from '../../core/types';
import { Icon, type IconName } from './Icon';
import { back } from '../lib/router';
import { useMaybeWallet } from '../lib/store';

export function Screen({ children }: { children: ReactNode }) {
  return <div className="screen">{children}</div>;
}

export function TopBar({
  title,
  onBack,
  noBack,
  right,
}: {
  title: ReactNode;
  onBack?: () => void;
  noBack?: boolean;
  right?: ReactNode;
}) {
  return (
    <div className="topbar">
      {!noBack && (
        <button className="icon-btn" aria-label="Back" onClick={onBack ?? (() => back())}>
          <Icon name="back" />
        </button>
      )}
      <h1 style={noBack ? { paddingLeft: 12 } : undefined}>{title}</h1>
      {right}
    </div>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'dark';
  loading?: boolean;
  small?: boolean;
  block?: boolean;
  icon?: IconName;
};

export function Button({ variant = 'primary', loading, small, block, icon, children, disabled, className, ...rest }: BtnProps) {
  const cls = ['btn', variant !== 'dark' && variant, small && 'small', block && 'block', className].filter(Boolean).join(' ');
  return (
    <button className={cls} disabled={disabled || loading} {...rest}>
      {loading ? <span className="spinner" /> : icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="field">
      {label && <label htmlFor={htmlFor}>{label}</label>}
      {children}
      {error ? <div className="error">{error}</div> : hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`toggle ${on ? 'on' : ''}`}
      onClick={() => onChange(!on)}
    />
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />;
}

export function Sheet({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={typeof title === 'string' ? title : undefined} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h3>{title}</h3>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

export function Toasts() {
  const { toasts } = useMaybeWallet();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function ErrorNote({ error }: { error?: string }) {
  if (!error) return null;
  return <div className="notice error">{error}</div>;
}

// ------------------------------------------------------------------ identity

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Two overlapping circles whose hues come from the account's addresses — the wallet's visual signature. */
export function Avatar({ seed, size = 32 }: { seed: string; size?: number }) {
  const h = hash32(seed || 'x');
  const hue1 = h % 360;
  const hue2 = (hue1 + 70 + ((h >>> 9) % 120)) % 360;
  const r = size * 0.36;
  return (
    <svg className="avatar" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size * 0.38} cy={size / 2} r={r} fill={`hsl(${hue1} 72% 56%)`} />
      <circle cx={size * 0.62} cy={size / 2} r={r} fill={`hsl(${hue2} 70% 62%)`} fillOpacity={0.88} />
    </svg>
  );
}

export function NetworkDot({ network, size = 8 }: { network?: Pick<Network, 'color'>; size?: number }) {
  return <span className="dot" style={{ background: network?.color ?? '#9aa3b2', width: size, height: size }} />;
}

export function TokenIcon({ token, network, size = 36 }: { token: Pick<Token, 'symbol' | 'logoURI'>; network?: Network; size?: number }) {
  const [broken, setBroken] = useState(false);
  const color = `hsl(${hash32(token.symbol) % 360} 45% 52%)`;
  return (
    <div className="token-icon" style={{ width: size, height: size }}>
      <div className="face" style={{ background: color, width: size, height: size, fontSize: size / 3 }}>
        {token.logoURI && !broken && /^https:\/\//.test(token.logoURI) ? (
          <img src={token.logoURI} alt="" onError={() => setBroken(true)} />
        ) : (
          token.symbol.slice(0, 3)
        )}
      </div>
      {network && <span className="net" style={{ background: network.color ?? '#9aa3b2' }} title={network.name} />}
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="icon-btn"
      aria-label={label}
      title={label}
      onClick={async (e) => {
        e.stopPropagation();
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      <Icon name={done ? 'check' : 'copy'} size={16} />
    </button>
  );
}

export function StatusPill({ status }: { status: 'pending' | 'confirmed' | 'failed' }) {
  if (status === 'confirmed') return null;
  return <span className={`status-pill ${status}`}>{status === 'pending' ? 'Pending' : 'Failed'}</span>;
}
