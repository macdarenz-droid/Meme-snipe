import { useId } from 'react';
import { Dot } from '../components/ui.tsx';
import type { SessionView } from '../screens/types.ts';

const SESSION_STATE: Record<SessionView['state'], string> = { 'not-started': 'Not started', running: 'Running', paused: 'Paused', ended: 'Ended' };

export const sessionLabel = (s: SessionView) => SESSION_STATE[s.state];
export const dataLabel = (s: SessionView) => (s.workerConnected ? 'Connected' : 'No feed');

export const modeLabel = (s: SessionView) => (s.mode === 'live' ? 'Live' : 'Paper');

/** Until the worker API exists there is no session and no data. */
export function StatusList({ session }: { session: SessionView }) {
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
          <Dot state={session.state === 'running' ? 'on' : 'off'} /> {sessionLabel(session)}
        </dd>
      </div>
      <div>
        <dt>Data</dt>
        <dd>
          <Dot state={session.workerConnected ? 'on' : 'off'} /> {dataLabel(session)}
        </dd>
      </div>
    </dl>
  );
}

export function PauseButton({ compact = false }: { compact?: boolean }) {
  const noteId = useId();
  return (
    <button type="button" className={compact ? 'button' : 'button button-block'} disabled aria-label={compact ? 'Pause new entries' : undefined} aria-describedby={noteId}>
      {compact ? 'Pause' : 'Pause new entries'}
      <span id={noteId} className="sr-only">
        Worker not connected
      </span>
    </button>
  );
}
