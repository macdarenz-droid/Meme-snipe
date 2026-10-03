import { Badge, Empty, Section } from '../components/ui.tsx';
import { formatUsd } from '../lib/format.ts';
import { emptyResults, type ResultsView } from '../performance/types.ts';
import { Results } from '../performance/Results.tsx';
import { RiskMeters } from '../performance/RiskMeters.tsx';
import { EMPTY_SESSION, type SessionView } from './types.ts';

const STATE: Record<SessionView['state'], string> = { 'not-started': 'Not started', running: 'Running', paused: 'Paused', ended: 'Ended' };
const NOT_SET = 'Not set';

const usd = (v: number | null) => (v === null ? NOT_SET : formatUsd(v));

export function SessionCard({ session }: { session: SessionView }) {
  const rows: [string, string][] = [
    ['Mode', session.mode === 'live' ? 'Live' : 'Paper'],
    ['Bankroll', usd(session.bankrollUsd)],
    ['Entry', session.entryUsd === null ? NOT_SET : session.maxEntryUsd === null ? formatUsd(session.entryUsd) : `${formatUsd(session.entryUsd)}, max ${formatUsd(session.maxEntryUsd)}`],
    ['Open positions', session.maxOpenPositions === null ? NOT_SET : String(session.maxOpenPositions)],
    ['Daily loss', usd(session.dailyLossLimitUsd)],
    ['Session loss', usd(session.sessionLossLimitUsd)],
  ];
  return (
    <Section title="Session" aside={<Badge>{STATE[session.state]}</Badge>}>
      <dl className="kv">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className={`num ${v === NOT_SET ? 'muted' : ''}`}>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="actions">
        <button type="button" className="button button-primary" disabled={!session.workerConnected || session.state === 'running'}>
          Start paper session
        </button>
        {!session.workerConnected && <span className="muted small">Worker not connected</span>}
      </div>
    </Section>
  );
}

const FUNNEL = ['Discovered', 'Data checks passed', 'Risk checks passed', 'Entered'];

export function Snipe({ session = EMPTY_SESSION, results = emptyResults(currentMonth()) }: { session?: SessionView; results?: ResultsView }) {
  return (
    <div className="screen-grid">
      <SessionCard session={session} />

      <Section title="Open trade">
        <Empty title="No open trade" />
      </Section>

      <Section title="Candidates">
        <ol className="funnel">
          {FUNNEL.map((stage) => (
            <li key={stage}>
              <span>{stage}</span>
              <span className="num muted">—</span>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="Risk">
        <RiskMeters meters={results.risk} />
      </Section>

      <Section title="Decision journal" className="span-2">
        <Empty title="No decisions recorded" />
      </Section>

      <Results view={results} />
    </div>
  );
}

export function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
