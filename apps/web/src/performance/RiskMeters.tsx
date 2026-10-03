import { formatUsd } from '../lib/format.ts';
import type { RiskMeterView } from './types.ts';

export function RiskMeters({ meters }: { meters: RiskMeterView[] }) {
  return (
    <ul className="meters">
      {meters.map((m) => {
        const share = m.limitUsd ? Math.min(1, m.usedUsd / m.limitUsd) : 0;
        return (
          <li key={m.label} className="meter">
            <div className="meter-label">
              <span>{m.label}</span>
              <span className="num">
                {m.limitUsd === null ? 'Limit not set' : `${formatUsd(m.usedUsd)} of ${formatUsd(m.limitUsd)}`}
              </span>
            </div>
            <div
              className="meter-track"
              role="meter"
              aria-label={m.label}
              aria-valuemin={0}
              aria-valuemax={m.limitUsd ?? 0}
              aria-valuenow={m.usedUsd}
              aria-valuetext={m.limitUsd === null ? 'Limit not set' : `${formatUsd(m.usedUsd)} of ${formatUsd(m.limitUsd)}`}
            >
              <div className={`meter-fill ${share >= 0.8 ? 'meter-high' : ''}`} style={{ width: `${share * 100}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
