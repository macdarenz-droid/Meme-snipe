import { formatPercent, formatUsd } from '../lib/format.ts';
import type { ResultsStatsView } from './types.ts';

const INSUFFICIENT = 'Insufficient evidence';

export function ResultsStats({ stats }: { stats: ResultsStatsView }) {
  const enough = stats.minSample !== null && stats.sample >= stats.minSample;
  const tone = (v: number) => (v > 0 ? 'gain' : v < 0 ? 'loss' : undefined);
  const items: { label: string; value: string; tone?: 'gain' | 'loss' | undefined }[] = [
    { label: 'Net result', value: stats.sample ? formatUsd(stats.netUsd, true) : '—', tone: tone(stats.netUsd) },
    { label: 'Win rate', value: enough ? formatPercent(stats.winRate) : INSUFFICIENT },
    { label: 'Expectancy', value: enough ? formatUsd(stats.expectancyUsd, true) : INSUFFICIENT, tone: enough ? tone(stats.expectancyUsd) : undefined },
    { label: 'Max drawdown', value: stats.sample ? formatUsd(-Math.abs(stats.maxDrawdownUsd)) : '—', tone: stats.maxDrawdownUsd ? 'loss' : undefined },
  ];
  return (
    <div className="results-stats">
      <dl className="stat-row">
        {items.map((i) => (
          <div className="stat" key={i.label}>
            <dt>{i.label}</dt>
            <dd className={`num ${i.tone ?? ''} ${i.value === INSUFFICIENT ? 'muted-value' : ''}`}>{i.value}</dd>
          </div>
        ))}
      </dl>
      <p className="sample num">
        Sample: {stats.sample} {stats.sample === 1 ? 'trade' : 'trades'}
        {stats.minSample !== null && !enough ? ` of ${stats.minSample} needed` : ''}
      </p>
    </div>
  );
}
