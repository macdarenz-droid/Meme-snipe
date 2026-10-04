import { useMemo } from 'react';
import { apiFor } from '../api/client.ts';
import { connection, useConnection } from '../api/connection.ts';
import type { DashboardApi, DiscoveredView } from '../api/contract.ts';
import { schemaFor } from '../api/schemas.ts';
import { useEndpoint, type Loaded } from '../api/useEndpoint.ts';
import { TokenActions } from '../components/TokenActions.tsx';
import { Empty, Section } from '../components/ui.tsx';
import { Load, OfflineContext } from '../dashboard/State.tsx';
import { formatDuration, formatUsd, shortAddress } from '../lib/format.ts';
import { usdToPlot } from '../lib/money.ts';
import type { TokenRowView } from './types.ts';

const NONE = '—';
const seconds = (fromIso: string, toMs: number) => Math.max(0, Math.round((toMs - Date.parse(fromIso)) / 1000));

/** The worker's discovered tokens as table rows, timed at the answer's asOf. What it does not serve stays null. */
export function rowsOf(view: DiscoveredView, asOf: string): TokenRowView[] {
  const at = Date.parse(asOf);
  return view.tokens.map((t) => ({
    mint: t.mint, symbol: t.symbol, ageSeconds: seconds(t.migratedAt, at), venue: t.venue,
    liquidityUsd: t.liquidityUsd === null ? null : usdToPlot(t.liquidityUsd),
    security: t.checks, promoted: false, dataAgeSeconds: t.checkedAt === null ? null : seconds(t.checkedAt, at),
  }));
}

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
            <th scope="col">Security</th>
            <th scope="col" className="num">Data age</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.mint}>
              <td>
                <span className="token-cell">
                  {r.symbol !== null && <span className="token-symbol">{r.symbol}</span>}
                  <span className="mono muted">{shortAddress(r.mint)}</span>
                  {r.promoted && <span className="badge badge-neutral">Promoted</span>}
                  <TokenActions mint={r.mint} />
                </span>
              </td>
              <td className="num">{formatDuration(r.ageSeconds)}</td>
              <td>{r.venue}</td>
              <td className="num">{r.liquidityUsd === null ? NONE : formatUsd(r.liquidityUsd)}</td>
              <td className={r.security === 'passed' ? '' : 'muted'}>{SECURITY[r.security]}</td>
              <td className="num">{r.dataAgeSeconds === null ? NONE : formatDuration(r.dataAgeSeconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The paper worker's discovered tokens (the only mode a worker runs today), or why there are none to show. */
function Discovered({ api }: { api: DashboardApi }) {
  return <DiscoveredBody loaded={useEndpoint<DiscoveredView>('paper', 'discovered', schemaFor('discovered', 'paper'), () => api.discovered('paper'))} />;
}

/** The Discovered section for one loaded answer: the tokens, "No tokens discovered", or the reason there is no answer. */
export function DiscoveredBody({ loaded }: { loaded: Loaded<DiscoveredView> }) {
  const aside = loaded.state === 'ready' ? <span className="muted num">{loaded.data.tokens.length} tokens</span> : undefined;
  return (
    <Section title="Discovered" className="span-2" {...(aside ? { aside } : {})}>
      <Load loaded={loaded} isEmpty={(d) => d.tokens.length === 0} empty={<Empty title="No tokens discovered" />}>
        {(d) => <TokenTable rows={rowsOf(d, loaded.state === 'ready' ? loaded.asOf : new Date().toISOString())} />}
      </Load>
    </Section>
  );
}

export function Home({ api }: { api?: DashboardApi }) {
  const conn = useConnection();
  const source = useMemo(() => api ?? apiFor(conn.origin, connection()), [api, conn.origin]);
  return (
    <div className="screen-grid">
      <OfflineContext.Provider value={{ state: conn.state, lastOk: conn.lastOk }}>
        <Discovered key={api ? 'given' : (conn.origin ?? 'none')} api={source} />
      </OfflineContext.Provider>
    </div>
  );
}
