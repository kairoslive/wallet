import { useId, useRef, useState, type PointerEvent } from 'react';
import type { Candle, PricePoint } from '../../core/predictions/types';

export interface ScrubPoint {
  t: number;
  price: number;
  /** Candle mode: the bucket under the finger. */
  candle?: Candle;
}

const W = 320;
const H = 132;

/**
 * Probability chart: a line with a fading fill, or OHLC candles. Dragging (or hovering) scrubs it:
 * a crosshair follows the pointer 1:1 and `onScrub` reports the point under it, so the price above
 * the chart can follow along. Letting go hands the price back to live.
 */
export function PriceChart({
  points,
  candles,
  color = 'var(--accent)',
  onScrub,
}: {
  points: PricePoint[];
  /** When given, draws candles instead of the line. */
  candles?: Candle[];
  color?: string;
  onScrub?: (p: ScrubPoint | undefined) => void;
}) {
  const gradient = useId();
  const plot = useRef<HTMLDivElement>(null);
  const [scrub, setScrub] = useState<number>();
  const series: ScrubPoint[] = candles
    ? candles.map((c) => ({ t: c.t, price: c.close, candle: c }))
    : points.map((p) => ({ t: p.t, price: p.price }));

  if (series.length < 2) {
    return (
      <div className="price-chart price-chart-empty muted small">
        {candles ? 'Not enough trading in this range to draw candles' : 'Not enough trading history to chart yet'}
      </div>
    );
  }
  const t0 = series[0].t;
  // Candles: leave half a bucket at the end so the last body isn't cut off.
  const bucket = candles && candles.length > 1 ? (candles[candles.length - 1].t - candles[0].t) / (candles.length - 1) : 0;
  const t1 = series[series.length - 1].t + bucket / 2;
  const lows = candles ? candles.map((c) => c.low) : series.map((p) => p.price);
  const highs = candles ? candles.map((c) => c.high) : series.map((p) => p.price);
  // Pad the range so a flat line doesn't sit on the edge.
  const lo = Math.max(0, Math.min(...lows) - 0.04);
  const hi = Math.min(1, Math.max(...highs) + 0.04);
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const y = (p: number) => H - ((p - lo) / Math.max(0.01, hi - lo)) * (H - 10) - 5;

  const span = hi - lo;
  const step = span > 0.6 ? 0.25 : span > 0.3 ? 0.1 : span > 0.12 ? 0.05 : 0.02;
  const grid: number[] = [];
  for (let g = Math.ceil((lo + 0.01) / step) * step; g < hi - 0.01; g += step) grid.push(Number(g.toFixed(4)));

  const active = scrub !== undefined ? series[scrub] : undefined;
  const last = series[series.length - 1];
  const pointAt = (e: PointerEvent) => {
    const r = plot.current!.getBoundingClientRect();
    const t = t0 + ((e.clientX - r.left) / r.width) * (t1 - t0);
    // Nearest point by time (series is sorted): binary search.
    let a = 0;
    let b = series.length - 1;
    while (b - a > 1) {
      const m = (a + b) >> 1;
      if (series[m].t < t) a = m;
      else b = m;
    }
    return Math.abs(series[a].t - t) <= Math.abs(series[b].t - t) ? a : b;
  };
  const move = (e: PointerEvent) => {
    // Hover only scrubs with a mouse; touch and pen scrub while pressed.
    if (e.pointerType !== 'mouse' && e.buttons === 0) return;
    const i = pointAt(e);
    if (i === scrub) return;
    setScrub(i);
    onScrub?.(series[i]);
  };
  const end = () => {
    if (scrub === undefined) return;
    setScrub(undefined);
    onScrub?.(undefined);
  };

  const line = series.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.price).toFixed(1)}`).join(' ');
  const body = Math.max(1, Math.min(8, ((bucket || (t1 - t0) / series.length) / Math.max(1, t1 - t0)) * W * 0.62));

  return (
    <div className="price-chart-wrap">
      <div
        ref={plot}
        className={`price-chart-plot ${active ? 'scrubbing' : ''}`}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const i = pointAt(e);
          setScrub(i);
          onScrub?.(series[i]);
        }}
        onPointerMove={move}
        onPointerUp={(e) => e.pointerType !== 'mouse' && end()}
        onPointerCancel={end}
        onPointerLeave={(e) => e.pointerType === 'mouse' && end()}
        data-testid="price-chart"
      >
        <svg className="price-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Price history">
          <defs>
            <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity="0.16" />
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
          {candles ? (
            candles.map((c) => {
              const up = c.close >= c.open;
              const cx = x(c.t);
              const top = y(Math.max(c.open, c.close));
              const h = Math.max(1, Math.abs(y(c.open) - y(c.close)));
              const fill = up ? 'var(--yes)' : 'var(--no)';
              return (
                <g key={c.t} opacity={active?.candle && active.candle.t !== c.t ? 0.45 : 1}>
                  <line
                    x1={cx}
                    x2={cx}
                    y1={y(c.high)}
                    y2={y(c.low)}
                    stroke={fill}
                    strokeWidth="1"
                    vectorEffect="non-scaling-stroke"
                  />
                  <rect x={cx - body / 2} y={top} width={body} height={h} fill={fill} rx={Math.min(1, body / 4)} />
                </g>
              );
            })
          ) : (
            <>
              <path d={`${line} L${x(last.t)},${H} L0,${H} Z`} fill={`url(#${gradient})`} />
              <path
                d={line}
                fill="none"
                stroke={color}
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
              />
            </>
          )}
        </svg>
        {active ? (
          <>
            <span className="price-chart-cursor" style={{ left: `${(x(active.t) / W) * 100}%` }} />
            {!candles && (
              <span
                className="price-chart-dot"
                style={{ left: `${(x(active.t) / W) * 100}%`, top: `${(y(active.price) / H) * 100}%`, background: color }}
              />
            )}
          </>
        ) : (
          !candles && (
            <span
              className="price-chart-dot live"
              style={{ left: `${(x(last.t) / W) * 100}%`, top: `${(y(last.price) / H) * 100}%`, background: color }}
            />
          )
        )}
      </div>
      {grid.map((g) => (
        <span key={g} className="price-chart-label" style={{ top: `${(y(g) / H) * 100}%` }}>
          {Math.round(g * 100)}%
        </span>
      ))}
    </div>
  );
}
