import { useId } from 'react';
import type { PricePoint } from '../../core/predictions/types';

/** Probability line chart for a market's price history, with a fading fill and light gridlines. */
export function PriceChart({ points, color = 'var(--accent)' }: { points: PricePoint[]; color?: string }) {
  const gradient = useId();
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
  const last = points[points.length - 1];
  // Gridlines at round percentages inside the visible range (2–4 of them).
  const span = hi - lo;
  const step = span > 0.6 ? 0.25 : span > 0.3 ? 0.1 : span > 0.12 ? 0.05 : 0.02;
  const grid: number[] = [];
  for (let g = Math.ceil((lo + 0.01) / step) * step; g < hi - 0.01; g += step) grid.push(Number(g.toFixed(4)));
  return (
    <div className="price-chart-wrap">
      <div className="price-chart-plot">
        <svg className="price-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Price history">
          <defs>
            <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity="0.18" />
              <stop offset="1" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {grid.map((g) => (
            <line
              key={g}
              x1="0"
              x2={W}
              y1={y(g)}
              y2={y(g)}
              stroke="var(--line)"
              strokeDasharray="3 4"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <path d={`${d} L${W},${H} L0,${H} Z`} fill={`url(#${gradient})`} />
          <path d={d} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        </svg>
        <span
          className="price-chart-dot"
          style={{ left: `${(x(last.t) / W) * 100}%`, top: `${(y(last.price) / H) * 100}%`, background: color }}
        />
      </div>
      {grid.map((g) => (
        <span key={g} className="price-chart-label" style={{ top: `${(y(g) / H) * 100}%` }}>
          {Math.round(g * 100)}%
        </span>
      ))}
    </div>
  );
}
