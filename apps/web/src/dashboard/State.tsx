import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Connection } from '../api/connection.ts';
import type { Loaded } from '../api/useEndpoint.ts';
import { Empty } from '../components/ui.tsx';
import { Boundary } from './Boundary.tsx';
import { ago, melDateTime } from './time.ts';

const ERROR_TEXT: Record<Extract<Loaded<unknown>, { state: 'error' }>['reason'], { title: string; detail?: string }> = {
  offline: { title: 'Offline' },
  'mixed-modes': { title: 'Data from another mode', detail: 'Not shown.' },
  'bad-data': { title: 'Data failed checks', detail: 'Not shown.' },
  'update-needed': { title: 'App update needed', detail: 'Not shown.' },
  failed: { title: 'Could not load' },
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

/** The server connection, for offline sections: whether an address is saved and when data last arrived. */
export const OfflineContext = createContext<Pick<Connection, 'state' | 'lastOk'>>({ state: 'offline', lastOk: null });

/** A section with no data because the server can't be reached. Never an empty state, which would claim there is nothing. */
export function OfflineState() {
  const { state, lastOk } = useContext(OfflineContext);
  if (state === 'none') return <Empty title="No server" />;
  return <Empty title="Offline" {...(lastOk ? { detail: `Last update ${melDateTime(lastOk)}` } : {})} />;
}

export function ErrorState({ reason }: { reason: keyof typeof ERROR_TEXT }) {
  const t = ERROR_TEXT[reason];
  return (
    <div className={reason === 'offline' ? '' : 'dash-error'}>
      <Empty title={t.title} {...(t.detail ? { detail: t.detail } : {})} />
    </div>
  );
}

/** How often a stale note re-reads the clock, so "updated 3m ago" stays true. */
export const STALE_TICK_MS = 30_000;

/** Calls `onTick` every `ms` until the returned stop function runs. */
export function startStaleTicker(onTick: () => void, ms: number = STALE_TICK_MS): () => void {
  const timer = setInterval(onTick, ms);
  return () => clearInterval(timer);
}

export function StaleNote({ asOf, now: fixed }: { asOf: string; now?: number }) {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (fixed !== undefined) return;
    return startStaleTicker(() => setTick(Date.now()));
  }, [fixed]);
  const now = fixed ?? tick;
  return (
    <p className="dash-stale" role="status">
      Stale data · updated {ago(asOf, now)}
    </p>
  );
}

/**
 * Shows loading, error or stale states around a section's content. Ready data
 * with `isEmpty` shows `empty`. With the server offline and no data, a section
 * shows the offline state, never its empty state.
 */
export function Load<T>({ loaded, children, empty, isEmpty, rows }: { loaded: Loaded<T>; children: (data: T) => ReactNode; empty?: ReactNode; isEmpty?: (data: T) => boolean; rows?: number }) {
  if (loaded.state === 'loading') return <Loading {...(rows ? { rows } : {})} />;
  if (loaded.state === 'error') return loaded.reason === 'offline' ? <OfflineState /> : <ErrorState reason={loaded.reason} />;
  if (loaded.state === 'not-running') return <Empty title="Not running" />;
  const body = isEmpty?.(loaded.data) ? empty : children(loaded.data);
  // New data remounts the boundary, so a section recovers once the data is good again.
  return (
    <Boundary key={loaded.asOf}>
      {loaded.stale && <StaleNote asOf={loaded.asOf} />}
      {body}
    </Boundary>
  );
}
