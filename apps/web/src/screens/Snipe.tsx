import { useMemo, useState } from 'react';
import { apiFor } from '../api/client.ts';
import { connection, useConnection } from '../api/connection.ts';
import type { DashboardApi, Mode } from '../api/contract.ts';
import { isMode } from '../api/modes.ts';
import { Badge, Empty, Section } from '../components/ui.tsx';
import { Dashboard } from '../dashboard/Dashboard.tsx';
import { OfflineContext } from '../dashboard/State.tsx';
import { ModeSwitch } from '../dashboard/Sections.tsx';
import { formatUsd } from '../lib/format.ts';
import { formatSol } from '../lib/money.ts';
import { sessionLabel } from '../shell/Status.tsx';
import { ServerCard } from './Server.tsx';
import { EMPTY_SESSION, type SessionView } from './types.ts';

const NOT_SET = 'Not set';
/** A limit the worker's policy does not have (review N2): "None", never "Not set", which reads as missing setup. */
const NONE = 'None';

export function SessionCard({ session, label = sessionLabel(session), onStart }: { session: SessionView; label?: string; onStart?: () => void }) {
  // A served session states every limit; one it leaves null is a limit its policy does not have. Without one, a value
  // is expected but missing.
  const usd = (v: number | null) => (v !== null ? formatUsd(v) : session.workerConnected ? NONE : NOT_SET);
  // SOL first (the books are in SOL): the limit as risk holds it, its configured dollars beside it.
  const lam = session.lamports;
  const money = (l: string | null | undefined, v: number | null) => (l != null && v !== null ? `${formatSol(l)} (${formatUsd(v)})` : usd(v));
  const rows: [string, string][] = [
    ['Mode', session.mode === 'live' ? 'Live' : 'Paper'],
    ['Bankroll', money(lam?.bankroll, session.bankrollUsd)],
    ['Entry', session.entryUsd === null ? NOT_SET : session.maxEntryUsd === null ? money(lam?.entry, session.entryUsd) : `${money(lam?.entry, session.entryUsd)}, max ${money(lam?.maxEntry, session.maxEntryUsd)}`],
    // R3's limit, not a count of open trades (APP-TRUTH): the same words as the halt it stops entries with.
    ['Open trade limit', session.maxOpenPositions === null ? NOT_SET : String(session.maxOpenPositions)],
    ['Daily loss', money(lam?.dailyLoss, session.dailyLossLimitUsd)],
    ['Weekly loss', money(lam?.weeklyLoss, session.weeklyLossLimitUsd)],
    ['Session loss', usd(session.sessionLossLimitUsd)],
  ];
  return (
    <Section title="Session" aside={<Badge>{label}</Badge>}>
      <dl className="kv">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className={`num ${v === NOT_SET || v === NONE ? 'muted' : ''}`}>{v}</dd>
          </div>
        ))}
      </dl>
      {/* Only a worker that accepts a start from the app, with a start the app can send, gets the button: never a dead one (APP-HOME). */}
      {session.startable && onStart !== undefined && session.state !== 'running' && (
        <div className="actions">
          <button type="button" className="button button-primary" onClick={onStart}>
            Start paper session
          </button>
        </div>
      )}
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
  /** The Session card's state label (the shell's session line), when it comes from the worker. */
  sessionState?: string;
  /** Sample data (Samples screen). Without it the screens read the saved server. */
  api?: DashboardApi;
  /** First calendar month per mode (Samples screen). */
  months?: Partial<Record<Mode, string>>;
}

export function Snipe({ session = EMPTY_SESSION, sessionState, api, months }: SnipeProps) {
  const [mode, setMode] = useState<Mode>(() => savedMode(session.mode));
  const conn = useConnection();
  const { origin } = conn;
  const source = useMemo(() => api ?? apiFor(origin, connection()), [api, origin]);
  const change = (m: Mode) => {
    setMode(m);
    saveMode(m);
  };
  const sessionCard =
    mode === session.mode ? (
      <SessionCard session={session} {...(sessionState === undefined ? {} : { label: sessionState })} />
    ) : (
      <Section title="Session">
        <Empty title={mode === 'live' ? 'Live trading off' : 'No session'} />
      </Section>
    );
  return (
    <div className="screen-grid">
      {!api && <ServerCard />}
      <div className="span-2 dash-toolbar">
        <ModeSwitch mode={mode} onChange={change} />
      </div>
      <OfflineContext.Provider value={{ state: conn.state, lastOk: conn.lastOk }}>
        <Dashboard key={`${api ? 'sample' : (origin ?? 'none')}|${mode}`} api={source} mode={mode} session={sessionCard} {...(months ? { months } : {})} />
      </OfflineContext.Provider>
    </div>
  );
}
