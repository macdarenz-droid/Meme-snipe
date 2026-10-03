import { Empty, Section } from '../components/ui.tsx';
import { formatDuration, formatPercent, formatUsd, shortAddress } from '../lib/format.ts';
import type { TokenRowView } from './types.ts';

const SECURITY: Record<TokenRowView['security'], string> = { passed: 'Passed', failed: 'Failed', missing: 'Missing checks' };

export function TokenTable({ rows }: { rows: TokenRowView[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Token</th>
            <th scope="col" className="num">Age</th>
            <th scope="col">Venue</th>
            <th scope="col" className="num">Liquidity</th>
            <th scope="col" className="num">Volume 24h</th>
            <th scope="col" className="num">Holders</th>
            <th scope="col">Security</th>
            <th scope="col" className="num">Data age</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.mint}>
              <td>
                <span className="token-cell">
                  <span className="token-symbol">{r.symbol}</span>
                  <span className="mono muted">{shortAddress(r.mint)}</span>
                  {r.promoted && <span className="badge badge-neutral">Promoted</span>}
                </span>
              </td>
              <td className="num">{formatDuration(r.ageSeconds)}</td>
              <td>{r.venue}</td>
              <td className="num">{formatUsd(r.liquidityUsd)}</td>
              <td className="num">{formatUsd(r.volume24hUsd)}</td>
              <td className="num">
                {r.holders} <span className="muted">top {formatPercent(r.topHolderShare, 0)}</span>
              </td>
              <td className={r.security === 'passed' ? '' : 'muted'}>{SECURITY[r.security]}</td>
              <td className="num">{formatDuration(r.dataAgeSeconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <Empty title="No tokens discovered" detail="Waiting for the data feed" />}
    </div>
  );
}

export function Home({ rows = [] }: { rows?: TokenRowView[] }) {
  return (
    <div className="screen-grid">
      <Section title="Discovered" className="span-2" aside={<span className="muted num">{rows.length} tokens</span>}>
        <TokenTable rows={rows} />
      </Section>
    </div>
  );
}
