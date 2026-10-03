import type { ReactNode } from 'react';
import type { Loaded } from '../api/useEndpoint.ts';
import { Empty } from '../components/ui.tsx';
import { ago } from './time.ts';

const ERROR_TEXT: Record<Extract<Loaded<unknown>, { state: 'error' }>['reason'], { title: string; detail?: string }> = {
  offline: { title: 'Worker not connected' },
  'mixed-modes': { title: 'Data from another mode', detail: 'Not shown.' },
  'bad-data': { title: 'Data failed checks', detail: 'Not shown.' },
  failed: { title: 'Could not load', detail: 'Retrying.' },
};

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="dash-loading" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="dash-skeleton" style={{ width: `${92 - i * 17}%` }} />
      ))}
    </div>
  );
}

export function ErrorState({ reason }: { reason: keyof typeof ERROR_TEXT }) {
  const t = ERROR_TEXT[reason];
  return (
    <div className={reason === 'offline' ? '' : 'dash-error'}>
      <Empty title={t.title} {...(t.detail ? { detail: t.detail } : {})} />
    </div>
  );
}

export function StaleNote({ asOf, now = Date.now() }: { asOf: string; now?: number }) {
  return (
    <p className="dash-stale" role="status">
      Stale data · updated {ago(asOf, now)}
    </p>
  );
}

/**
 * Shows loading, error or stale states around a section's content. Ready data
 * with `isEmpty` shows `empty`. With the worker offline a section shows its
 * empty state; the Worker section, which has none, names the cause once.
 */
export function Load<T>({ loaded, children, empty, isEmpty, rows }: { loaded: Loaded<T>; children: (data: T) => ReactNode; empty?: ReactNode; isEmpty?: (data: T) => boolean; rows?: number }) {
  if (loaded.state === 'loading') return <Loading {...(rows ? { rows } : {})} />;
  if (loaded.state === 'error') return loaded.reason === 'offline' && empty ? <>{empty}</> : <ErrorState reason={loaded.reason} />;
  const body = isEmpty?.(loaded.data) ? empty : children(loaded.data);
  return (
    <>
      {loaded.stale && <StaleNote asOf={loaded.asOf} />}
      {body}
    </>
  );
}
