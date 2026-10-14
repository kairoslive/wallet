import type { PricePoint } from '../../core/predictions/types';

/** Minimal probability line chart (0–100%) for a market's price history. */
export function PriceChart({ points, color = 'var(--accent)' }: { points: PricePoint[]; color?: string }) {
  if (points.length < 2) {
    return (
      <div className="price-chart center muted small" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        Not enough trading history to chart yet
      </div>
    );
  }
  const W = 320;
  const H = 120;
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const prices = points.map((p) => p.price);
  // Pad the range so a flat line doesn't sit on the edge.
  const lo = Math.max(0, Math.min(...prices) - 0.05);
  const hi = Math.min(1, Math.max(...prices) + 0.05);
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const y = (p: number) => H - ((p - lo) / Math.max(0.01, hi - lo)) * (H - 8) - 4;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.price).toFixed(1)}`).join(' ');
  return (
    <svg className="price-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Price history">
      <path d={`${d} L${W},${H} L0,${H} Z`} fill={color} opacity="0.08" />
      <path d={d} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}
