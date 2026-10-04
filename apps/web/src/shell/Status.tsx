import { useId } from 'react';
import { Dot } from '../components/ui.tsx';
import type { Connection } from '../api/connection.ts';
import type { WorkerStatus } from '../api/contract.ts';
import type { Loaded } from '../api/useEndpoint.ts';
import { connectionDot, connectionLabel } from '../screens/Server.tsx';
import { usdToPlot } from '../lib/money.ts';
import { EMPTY_SESSION, type SessionView } from '../screens/types.ts';

const SESSION_STATE: Record<SessionView['state'], string> = { 'not-started': 'Not started', running: 'Running', paused: 'Paused', ended: 'Ended' };

export const sessionLabel = (s: SessionView) => SESSION_STATE[s.state];
/** The server connection: "Not set", "Connecting", "Online" or "Offline · last update …". */
export const dataLabel = (c: Connection) => connectionLabel(c);

export const modeLabel = (s: SessionView) => (s.mode === 'live' ? 'Live' : 'Paper');

/** The shell's session line: what the worker's status says, or why there is no status (APP-HOME). */
export interface ShellSession {
  label: string;
  on: boolean;
}

/**
 * From the paper worker's status: Running, Paused (the owner's pause) or Ended (the policy session ended). With no
 * status the reason shows instead, never a state the worker did not report: no server saved, connecting, offline,
 * a mode the server does not run, or an answer that failed the checks.
 */
export function shellSession(status: Loaded<WorkerStatus>, conn: Pick<Connection, 'state'>): ShellSession {
  if (conn.state === 'none') return { label: 'No server', on: false };
  if (status.state === 'ready') {
    if (status.data.flags.includes('paused')) return { label: 'Paused', on: false };
    if (status.data.haltReasons?.some((h) => h.code === 'session-ended')) return { label: 'Ended', on: false };
    return { label: 'Running', on: true };
  }
  if (status.state === 'not-running') return { label: 'Not running', on: false };
  if (status.state === 'loading') return { label: 'Connecting', on: false };
  return { label: status.reason === 'offline' ? 'Offline' : 'Unknown', on: false };
}

/**
 * The Session card's values from the paper worker's status (APP-HOME): its state and its policy's limits. Without a
 * served session, the empty session: every value "Not set" and no start button.
 */
export function sessionView(status: Loaded<WorkerStatus>): SessionView {
  if (status.state !== 'ready' || status.data.session === undefined) return EMPTY_SESSION;
  const s = status.data.session;
  return {
    mode: 'paper', state: s.state, bankrollUsd: usdToPlot(s.bankrollUsd), entryUsd: usdToPlot(s.entryUsd), maxEntryUsd: usdToPlot(s.maxEntryUsd),
    maxOpenPositions: s.maxOpenPositions, dailyLossLimitUsd: usdToPlot(s.dailyLossLimitUsd), weeklyLossLimitUsd: usdToPlot(s.weeklyLossLimitUsd),
    sessionLossLimitUsd: s.sessionLossLimitUsd === null ? null : usdToPlot(s.sessionLossLimitUsd), workerConnected: true, startable: s.startable,
  };
}

/** Mode, session and the server connection, in the desktop rail. */
export function StatusList({ session, state, conn }: { session: SessionView; state: ShellSession; conn: Connection }) {
  return (
    <dl className="status-list">
      <div>
        <dt>Mode</dt>
        <dd>
          <span className="badge badge-neutral">{modeLabel(session)}</span>
        </dd>
      </div>
      <div>
        <dt>Session</dt>
        <dd>
          <Dot state={state.on ? 'on' : 'off'} /> {state.label}
        </dd>
      </div>
      <div>
        <dt>Data</dt>
        <dd>
          <Dot state={connectionDot(conn)} /> {dataLabel(conn)}
        </dd>
      </div>
    </dl>
  );
}

/**
 * Pausing is the watchdog's signed request, sent with Telegram's /pause (ARCHITECTURE §12); the app sends no
 * commands, so the button stays disabled and names where pausing happens (APP-WIRE). It reads "Paused" while the
 * worker reports the owner's pause, never "Worker not connected" for a worker that answers.
 */
export function PauseButton({ compact = false, paused = false }: { compact?: boolean; paused?: boolean }) {
  const noteId = useId();
  const label = paused ? 'Paused' : compact ? 'Pause' : 'Pause new entries';
  return (
    <button type="button" className={compact ? 'button' : 'button button-block'} disabled aria-label={compact && !paused ? 'Pause new entries' : undefined} aria-describedby={noteId}>
      {label}
      <span id={noteId} className="sr-only">
        Telegram /pause
      </span>
    </button>
  );
}
