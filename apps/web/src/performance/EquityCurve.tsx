import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Empty } from '../components/ui.tsx';
import { formatDateTime, formatUsd } from '../lib/format.ts';
import type { EquityPointView } from './types.ts';

const EQ_H = 168;
const DD_H = 72;
const PAD = { left: 52, right: 12, top: 10, bottom: 8 };

export function drawdowns(points: EquityPointView[]): number[] {
  let peak = -Infinity;
  return points.map((p) => {
    peak = Math.max(peak, p.equityUsd);
    return p.equityUsd - peak;
  });
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.max(240, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Equity line, with drawdown from the running peak on its own chart below (one y-axis each). */
export function EquityCurve({ points }: { points: EquityPointView[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  if (points.length < 2) {
    return (
      <div ref={ref}>
        <Empty title="No closed trades" />
      </div>
    );
  }

  const dd = drawdowns(points);
  const eq = points.map((p) => p.equityUsd);
  const lo = Math.min(...eq);
  const hi = Math.max(...eq);
  const span = hi - lo || 1;
  const ddMin = Math.min(...dd, -0.01);
  const plotW = width - PAD.left - PAD.right;
  const x = (i: number) => PAD.left + (i / (points.length - 1)) * plotW;
  const yEq = (v: number) => PAD.top + (1 - (v - lo) / span) * (EQ_H - PAD.top - PAD.bottom);
  const yDd = (v: number) => 4 + (v / ddMin) * (DD_H - 12);

  const line = eq.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${yEq(v).toFixed(1)}`).join('');
  const ddArea = `M${x(0)},4${dd.map((v, i) => `L${x(i).toFixed(1)},${yDd(v).toFixed(1)}`).join('')}L${x(dd.length - 1)},4Z`;

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - box.left - PAD.left) / plotW) * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  };

  const h = hover === null ? null : points[hover];
  const hd = hover === null ? null : dd[hover];
  const ticks = [hi, (hi + lo) / 2, lo];

  return (
    <div ref={ref} className="equity">
      <svg width={width} height={EQ_H} role="img" aria-label={`Equity from ${formatUsd(eq[0] ?? 0)} to ${formatUsd(eq[eq.length - 1] ?? 0)}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={width - PAD.right} y1={yEq(t)} y2={yEq(t)} className="grid" />
            <text x={PAD.left - 8} y={yEq(t) + 4} className="axis" textAnchor="end">
              {formatUsd(t)}
            </text>
          </g>
        ))}
        <path d={line} className="equity-line" />
        {hover !== null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={EQ_H - PAD.bottom} className="crosshair" />
            <circle cx={x(hover)} cy={yEq(eq[hover] ?? 0)} r={4} className="equity-dot" />
          </>
        )}
      </svg>
      <div className="chart-sub">Drawdown</div>
      <svg width={width} height={DD_H} role="img" aria-label={`Largest drawdown ${formatUsd(ddMin)}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <line x1={PAD.left} x2={width - PAD.right} y1={4} y2={4} className="grid" />
        <text x={PAD.left - 8} y={8} className="axis" textAnchor="end">
          $0
        </text>
        <text x={PAD.left - 8} y={DD_H - 6} className="axis" textAnchor="end">
          {formatUsd(ddMin)}
        </text>
        <path d={ddArea} className="drawdown-area" />
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={4} y2={DD_H - 4} className="crosshair" />}
      </svg>
      <div className="chart-tip num" aria-live="polite">
        {h && hd !== null && hd !== undefined ? (
          <>
            <span>{formatDateTime(h.at)}</span>
            <span>Equity {formatUsd(h.equityUsd)}</span>
            <span className={hd < 0 ? 'loss' : ''}>Drawdown {formatUsd(hd)}</span>
          </>
        ) : (
          <span className="muted">
            {points.length} points · last {formatUsd(eq[eq.length - 1] ?? 0)}
          </span>
        )}
      </div>
    </div>
  );
}
