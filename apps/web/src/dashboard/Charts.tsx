import { useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import type { ChartsView, FunnelDay, Mode } from '../api/contract.ts';
import { totalUsd } from '../api/modes.ts';
import { Empty } from '../components/ui.tsx';
import { formatUsdCompact } from '../lib/format.ts';
import { fromMicro, decToPlot, formatR, formatSol, formatUsdExact, toLamports, toMicro, toneOf } from '../lib/money.ts';
import { COST_LABEL } from './labels.ts';
import { melDateTime } from './time.ts';

const PAD = { left: 52, right: 12, top: 10, bottom: 22 };

export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    setWidth(Math.max(240, Math.floor(ref.current.getBoundingClientRect().width)));
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.max(240, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * How a chart's money reads (APP-SOL): SOL from the worker's lamports when every point carries them, else dollars from
 * the dollar fields. Values are exact integers (lamports or micro-dollars); only drawing uses floats.
 */
export interface MoneyUnit {
  readonly of: (lamports: string | null | undefined, usd: string) => bigint;
  readonly plot: (v: bigint) => number;
  readonly text: (v: bigint, signed?: boolean) => string;
  readonly tone: (v: bigint) => 'gain' | 'loss' | '';
  readonly axis: (n: number, signed?: boolean) => string;
}
const MINUS = '−';
export const SOL_UNIT: MoneyUnit = {
  of: (l) => toLamports(l!), plot: (v) => Number(v) / 1e9, text: (v, s = false) => formatSol(v.toString(), s),
  tone: (v) => (v > 0n ? 'gain' : v < 0n ? 'loss' : ''),
  axis: (n, s = false) => `${n < 0 ? MINUS : s && n > 0 ? '+' : ''}${Math.abs(n).toFixed(Math.abs(n) >= 1 ? 2 : 4)}`,
};
export const USD_UNIT: MoneyUnit = {
  of: (_l, u) => toMicro(u), plot: (v) => Number(v) / 1e6, text: (v, s = false) => formatUsdExact(fromMicro(v), s),
  tone: (v) => toneOf(fromMicro(v)), axis: (n, s = false) => formatUsdCompact(n, s),
};
/** SOL when every item carries lamports, else dollars. */
export const unitOf = <T,>(items: readonly T[], lam: (x: T) => string | null | undefined): MoneyUnit => (items.length > 0 && items.every((x) => lam(x) != null) ? SOL_UNIT : USD_UNIT);

const shortDay = (d: string) => `${Number(d.slice(8, 10))}/${Number(d.slice(5, 7))}`;

/** Cumulative net P&L, with drawdown from the high-water mark on its own chart below. */
export function CumulativeChart({ points }: { points: ChartsView['cumulative'] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) {
    return (
      <div ref={ref}>
        <Empty title="No closed trades" />
      </div>
    );
  }
  const H = 168;
  const DD_H = 72;
  const u = unitOf(points, (p) => p.cumNetLamports);
  // The series starts at zero before the first trade.
  const cum = [0n, ...points.map((p) => u.of(p.cumNetLamports, p.cumNetUsd))];
  let peak: bigint | null = null;
  const dd = cum.map((c) => {
    peak = peak === null || c > peak ? c : peak;
    return c - peak;
  });
  const v = cum.map(u.plot);
  const lo = Math.min(...v, 0);
  const hi = Math.max(...v, 0);
  const span = hi - lo || 1;
  const ddMinB = dd.reduce((m, x) => (x < m ? x : m), 0n);
  const ddMin = Math.min(u.plot(ddMinB), u === SOL_UNIT ? -0.0001 : -0.01);
  const w = width || 600;
  const plotW = w - PAD.left - PAD.right;
  const x = (i: number) => PAD.left + (i / (cum.length - 1)) * plotW;
  const y = (n: number) => PAD.top + (1 - (n - lo) / span) * (H - PAD.top - PAD.bottom);
  const yDd = (n: number) => 4 + (n / ddMin) * (DD_H - 12);
  const line = v.map((n, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(n).toFixed(1)}`).join('');
  const ddArea = `M${x(0)},4${dd.map((n, i) => `L${x(i).toFixed(1)},${yDd(u.plot(n)).toFixed(1)}`).join('')}L${x(dd.length - 1)},4Z`;
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - box.left - PAD.left) / plotW) * (cum.length - 1));
    setHover(Math.max(0, Math.min(cum.length - 1, i)));
  };
  const last = cum[cum.length - 1] ?? 0n;
  const hp = hover === null ? null : hover;
  return (
    <div ref={ref} className="dash-chart">
      {width > 0 && (
        <>
          <svg width={w} height={H} role="img" aria-label={`Cumulative net ${u.text(last, true)} after ${points.length} trades`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
            {[hi, (hi + lo) / 2, lo].map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={w - PAD.right} y1={y(t)} y2={y(t)} className="grid" />
                <text x={PAD.left - 8} y={y(t) + 4} className="axis" textAnchor="end">
                  {u.axis(t, t !== 0)}
                </text>
              </g>
            ))}
            {lo < 0 && hi > 0 && <line x1={PAD.left} x2={w - PAD.right} y1={y(0)} y2={y(0)} className="zero" />}
            <path d={line} className="equity-line" />
            {hp !== null && (
              <>
                <line x1={x(hp)} x2={x(hp)} y1={PAD.top} y2={H - PAD.bottom} className="crosshair" />
                <circle cx={x(hp)} cy={y(v[hp] ?? 0)} r={4} className="equity-dot" />
              </>
            )}
          </svg>
          <div className="chart-sub">Drawdown from high</div>
          <svg width={w} height={DD_H} role="img" aria-label={`Largest drawdown ${u.text(ddMinB)}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
            <line x1={PAD.left} x2={w - PAD.right} y1={4} y2={4} className="grid" />
            <text x={PAD.left - 8} y={8} className="axis" textAnchor="end">
              {u.axis(0)}
            </text>
            <text x={PAD.left - 8} y={DD_H - 6} className="axis" textAnchor="end">
              {u.axis(ddMin)}
            </text>
            <path d={ddArea} className="drawdown-area" />
            {hp !== null && <line x1={x(hp)} x2={x(hp)} y1={4} y2={DD_H - 4} className="crosshair" />}
          </svg>
        </>
      )}
      <div className="chart-tip num" aria-live="polite">
        {hp !== null ? (
          <>
            <span>{hp === 0 ? 'Start' : melDateTime(points[hp - 1]?.at ?? '')}</span>
            <span className={u.tone(cum[hp] ?? 0n)}>Net {u.text(cum[hp] ?? 0n, true)}</span>
            <span className={u.tone(dd[hp] ?? 0n)}>Drawdown {u.text(dd[hp] ?? 0n)}</span>
          </>
        ) : (
          <span className="muted">
            {points.length} trades · net {u.text(last, true)} · largest drawdown {u.text(ddMinB)}
          </span>
        )}
      </div>
    </div>
  );
}

export interface Bar {
  key: string;
  /** Axis label, shown under some bars. */
  tick: string;
  /** Height, for drawing only. */
  value: number;
  /** Exact text for the tooltip and screen readers. */
  text: string;
  tone: 'gain' | 'loss' | 'neutral' | 'accent';
}

/** Vertical bars from a zero line; negatives hang below it. */
export function BarChart({ bars, label, height = 140, format = (n: number) => formatUsdCompact(n, n !== 0) }: { bars: Bar[]; label: string; height?: number; format?: (n: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const w = width || 600;
  const hi = Math.max(0, ...bars.map((b) => b.value));
  const lo = Math.min(0, ...bars.map((b) => b.value));
  const span = hi - lo || 1;
  const plotW = w - PAD.left - PAD.right;
  const step = plotW / Math.max(bars.length, 1);
  const bw = Math.max(1, Math.min(28, step * 0.7));
  const y = (n: number) => PAD.top + (1 - (n - lo) / span) * (height - PAD.top - PAD.bottom);
  const every = Math.max(1, Math.ceil(bars.length / Math.max(1, Math.floor(plotW / 44))));
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - box.left - PAD.left) / step);
    setHover(i >= 0 && i < bars.length ? i : null);
  };
  const h = hover === null ? null : bars[hover];
  return (
    <div ref={ref} className="dash-chart">
      {width > 0 && (
        <svg width={w} height={height} role="img" aria-label={label} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          {(lo < 0 ? [hi, 0, lo] : [hi, 0]).map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={w - PAD.right} y1={y(t)} y2={y(t)} className={t === 0 ? 'zero' : 'grid'} />
              <text x={PAD.left - 8} y={y(t) + 4} className="axis" textAnchor="end">
                {format(t)}
              </text>
            </g>
          ))}
          {bars.map((b, i) => {
            const cx = PAD.left + step * i + step / 2;
            const top = Math.min(y(b.value), y(0));
            const hgt = Math.max(1, Math.abs(y(b.value) - y(0)));
            return (
              <g key={b.key}>
                <rect x={cx - bw / 2} y={top} width={bw} height={hgt} rx={Math.min(2, bw / 4)} className={`bar-${b.tone} ${hover === i ? 'bar-hover' : ''}`} />
                {i % every === 0 && (
                  <text x={cx} y={height - 6} className="axis" textAnchor="middle">
                    {b.tick}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      <div className="chart-tip num" aria-live="polite">
        {h ? (
          <>
            <span>{h.key}</span>
            <span className={h.tone === 'gain' || h.tone === 'loss' ? h.tone : ''}>{h.text}</span>
          </>
        ) : (
          <span className="muted">{label}</span>
        )}
      </div>
    </div>
  );
}

export function DailyPnlChart({ daily }: { daily: ChartsView['daily'] }) {
  if (daily.length === 0) return <Empty title="No closed trades" />;
  const u = unitOf(daily, (d) => d.netLamports);
  // Colour follows the printed amount (the unit's tone), never the float used for drawing.
  const bars: Bar[] = daily.map((d) => {
    const v = u.of(d.netLamports, d.netUsd);
    return { key: d.date, tick: shortDay(d.date), value: u.plot(v), text: u.text(v, true), tone: u.tone(v) || 'neutral' };
  });
  const up = bars.filter((b) => b.tone === 'gain').length;
  return <BarChart bars={bars} label={`${daily.length} days, ${up} up and ${daily.length - up} flat or down`} format={(n) => u.axis(n, n !== 0)} />;
}

export function RDistribution({ buckets }: { buckets: ChartsView['rBuckets'] }) {
  const bars: Bar[] = buckets.map((b) => {
    const mid = (decToPlot(b.fromR) + decToPlot(b.toR)) / 2;
    return {
      key: `${formatR(b.fromR)} to ${formatR(b.toR)}`,
      tick: formatR(b.fromR),
      value: b.count,
      text: `${b.count} ${b.count === 1 ? 'trade' : 'trades'}`,
      tone: mid > 0 ? 'gain' : mid < 0 ? 'loss' : 'neutral',
    };
  });
  const total = buckets.reduce((s, b) => s + b.count, 0);
  return <BarChart bars={bars} label={`Realized R of ${total} trades`} format={(n) => String(Math.round(n))} />;
}

export function CostsChart({ view, mode }: { view: ChartsView; mode: Mode }) {
  const daily = view.costsDaily;
  if (daily.length === 0) return <Empty title="No costs yet" />;
  const u = unitOf(daily, (d) => d.totalLamports);
  const bars: Bar[] = daily.map((d) => {
    const v = u.of(d.totalLamports, d.totalUsd);
    return { key: d.date, tick: shortDay(d.date), value: u.plot(v), text: u.text(v), tone: 'neutral' };
  });
  return (
    <>
      <BarChart bars={bars} label={`Costs per day over ${daily.length} days`} format={(n) => u.axis(n)} height={120} />
      <CostTable view={view} mode={mode} />
    </>
  );
}

function CostTable({ view, mode }: { view: ChartsView; mode: Mode }) {
  const byKind = view.costsByKind;
  if (byKind.length === 0) return null;
  const u = unitOf(byKind, (c) => c.amountLamports);
  // Every kind must be this chart's mode (totalUsd refuses another mode), whichever unit is shown.
  totalUsd(mode, byKind, (c) => c.amountUsd);
  const amount = (c: (typeof byKind)[number]) => u.of(c.amountLamports, c.amountUsd);
  const sorted = [...byKind].sort((a, b) => (amount(b) > amount(a) ? 1 : amount(b) < amount(a) ? -1 : 0));
  const total = sorted.reduce((s, c) => s + amount(c), 0n);
  const max = sorted[0] === undefined ? 0n : amount(sorted[0]);
  const share = (v: bigint, of: bigint) => (of > 0n ? Number((v * 1000n) / of) / 10 : 0);
  return (
    <table className="bars dash-cost-table">
      <caption className="sr-only">Costs by type</caption>
      <tbody>
        {sorted.map((c) => (
          <tr key={c.kind}>
            <th scope="row">{COST_LABEL[c.kind]}</th>
            <td className="bar-cell" aria-hidden="true">
              <span className="bar" style={{ width: `${share(amount(c), max)}%` }} />
            </td>
            <td className="num">{u.text(amount(c))}</td>
            <td className="num muted">{total > 0n ? `${Math.round(share(amount(c), total))}%` : ''}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">Total</th>
          <td />
          <td className="num">{u.text(total)}</td>
          <td />
        </tr>
      </tfoot>
    </table>
  );
}

export function FunnelChart({ perDay }: { perDay: FunnelDay[] }) {
  if (perDay.length === 0) return <Empty title="No candidates seen" />;
  const seen: Bar[] = perDay.map((d) => ({ key: d.date, tick: shortDay(d.date), value: d.seen, text: `${d.seen} seen`, tone: 'neutral' }));
  const entered: Bar[] = perDay.map((d) => ({ key: d.date, tick: shortDay(d.date), value: d.entered, text: `${d.entered} entered`, tone: 'accent' }));
  const count = (n: number) => String(Math.round(n));
  return (
    <>
      <div className="chart-sub">Seen per day</div>
      <BarChart bars={seen} label="Candidates seen per day" format={count} height={100} />
      <div className="chart-sub">Entered per day</div>
      <BarChart bars={entered} label="Entries per day" format={count} height={80} />
    </>
  );
}
