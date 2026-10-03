import { Dot } from '../components/ui.tsx';

/** Until the worker API exists there is no session and no data. */
export function StatusList() {
  return (
    <dl className="status-list">
      <div>
        <dt>Mode</dt>
        <dd>
          <span className="badge badge-neutral">Paper</span>
        </dd>
      </div>
      <div>
        <dt>Session</dt>
        <dd>
          <Dot state="off" /> Not started
        </dd>
      </div>
      <div>
        <dt>Data</dt>
        <dd>
          <Dot state="off" /> No feed
        </dd>
      </div>
    </dl>
  );
}

export function PauseButton() {
  return (
    <button type="button" className="button button-block" disabled aria-describedby="pause-note">
      Pause new entries
      <span id="pause-note" className="sr-only">
        Worker not connected
      </span>
    </button>
  );
}
