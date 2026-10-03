import { Badge, Empty, Section } from '../components/ui.tsx';
import { emptyResults, type ResultsView } from '../performance/types.ts';
import { Results } from '../performance/Results.tsx';
import { RiskMeters } from '../performance/RiskMeters.tsx';

/** Owner's planned settings (PROJECT_STATE.md); loss limits stay unset until the owner chooses them. */
const POLICY: [string, string][] = [
  ['Bankroll', '$20'],
  ['Entry', '$2, max $5'],
  ['Open positions', '1'],
  ['Daily loss', 'Not set'],
  ['Session loss', 'Not set'],
];

const FUNNEL = ['Discovered', 'Data checks passed', 'Risk checks passed', 'Entered'];

export function Snipe({ results = emptyResults(currentMonth()) }: { results?: ResultsView }) {
  return (
    <div className="screen-grid">
      <Section title="Session" aside={<Badge>Not started</Badge>}>
        <dl className="kv">
          <div>
            <dt>Mode</dt>
            <dd>Paper</dd>
          </div>
          {POLICY.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd className={`num ${v === 'Not set' ? 'muted' : ''}`}>{v}</dd>
            </div>
          ))}
        </dl>
        <div className="actions">
          <button type="button" className="button button-primary" disabled>
            Start paper session
          </button>
          <span className="muted small">Worker not connected</span>
        </div>
      </Section>

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
