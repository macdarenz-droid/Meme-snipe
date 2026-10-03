import { useMemo, useState } from 'react';
import { defaultApi } from '../api/client.ts';
import type { DashboardApi, Mode } from '../api/contract.ts';
import { isMode } from '../api/modes.ts';
import { Badge, Empty, Section } from '../components/ui.tsx';
import { Dashboard } from '../dashboard/Dashboard.tsx';
import { ModeSwitch } from '../dashboard/Sections.tsx';
import { formatUsd } from '../lib/format.ts';
import { sessionLabel } from '../shell/Status.tsx';
import { EMPTY_SESSION, type SessionView } from './types.ts';

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
    <Section title="Session" aside={<Badge>{sessionLabel(session)}</Badge>}>
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

const MODE_KEY = 'zeroed.dashboardMode';

function savedMode(fallback: Mode): Mode {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return isMode(m) ? m : fallback;
  } catch {
    return fallback;
  }
}

function saveMode(m: Mode): void {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    // Storage blocked: the choice lasts for this visit only.
  }
}

interface SnipeProps {
  session?: SessionView;
  api?: DashboardApi;
  /** First calendar month per mode (Samples screen). */
  months?: Partial<Record<Mode, string>>;
}

export function Snipe({ session = EMPTY_SESSION, api, months }: SnipeProps) {
  const [mode, setMode] = useState<Mode>(() => savedMode(session.mode));
  const source = useMemo(() => api ?? defaultApi(), [api]);
  const change = (m: Mode) => {
    setMode(m);
    saveMode(m);
  };
  const sessionCard =
    mode === session.mode ? (
      <SessionCard session={session} />
    ) : (
      <Section title="Session">
        <Empty title={mode === 'live' ? 'Live trading off' : 'No session'} />
      </Section>
    );
  return (
    <div className="screen-grid">
      <div className="span-2 dash-toolbar">
        <ModeSwitch mode={mode} onChange={change} />
      </div>
      <Dashboard key={mode} api={source} mode={mode} session={sessionCard} {...(months ? { months } : {})} />
    </div>
  );
}
