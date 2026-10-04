import { useEffect, useState } from 'react';
import { STALE_AFTER_SECONDS, type Envelope, type Mode } from './contract.ts';
import { OfflineError } from './client.ts';
import { checkAnswer, DataError } from './modes.ts';
import { startPolling } from './poll.ts';
import type { Check } from './schema.ts';

export type Loaded<T> =
  | { state: 'loading' }
  | { state: 'error'; reason: 'offline' | 'mixed-modes' | 'bad-data' | 'update-needed' | 'failed' }
  /** The server answered that it does not run this mode (API-1). */
  | { state: 'not-running' }
  | { state: 'ready'; data: T; asOf: string; stale: boolean };

export function isStale(mode: Mode, asOf: string, now: number): boolean {
  return mode !== 'backtest' && now - Date.parse(asOf) > STALE_AFTER_SECONDS * 1000;
}

/** Turns a response (or failure) into a screen state. Every response is checked for mode and money first. */
export function settle<T>(mode: Mode, check: Check, result: { ok: true; value: unknown } | { ok: false; error: unknown }, now: number): Loaded<T> {
  if (!result.ok) {
    if (result.error instanceof OfflineError) return { state: 'error', reason: 'offline' };
    if (result.error instanceof DataError) {
      return { state: 'error', reason: result.error.kind === 'mixed-modes' ? 'mixed-modes' : result.error.kind === 'app-outdated' ? 'update-needed' : 'bad-data' };
    }
    return { state: 'error', reason: 'failed' };
  }
  try {
    const env: Envelope<T> = checkAnswer<T>(result.value, mode, check);
    if (env.notRunning !== undefined) return { state: 'not-running' };
    return { state: 'ready', data: env.data, asOf: env.asOf, stale: isStale(mode, env.asOf, now) };
  } catch (e) {
    return settle<T>(mode, check, { ok: false, error: e }, now);
  }
}

/**
 * When the server stops answering, paper and live data already on screen stays, marked stale with
 * its update time, instead of disappearing; anything else replaces it.
 */
export function keepOnOffline<T>(prev: Loaded<T> | undefined, next: Loaded<T>, mode: Mode): Loaded<T> {
  if (mode !== 'backtest' && next.state === 'error' && next.reason === 'offline' && prev?.state === 'ready') return { ...prev, stale: true };
  return next;
}

/**
 * Loads one endpoint for one mode. Paper and live poll (src/api/poll.ts: backoff after failures,
 * nothing in the background); a backtest loads once, retrying only after a failure. Changing the
 * key (mode, month) drops the old data at once.
 */
export function useEndpoint<T>(mode: Mode, what: string, check: Check, load: () => Promise<Envelope<T>>): Loaded<T> {
  const key = `${mode}|${what}`;
  const [loaded, setLoaded] = useState<{ key: string; value: Loaded<T> }>({ key, value: { state: 'loading' } });

  useEffect(() => {
    let live = true;
    const put = (value: Loaded<T>) => setLoaded((prev) => ({ key, value: keepOnOffline(prev.key === key ? prev.value : undefined, value, mode) }));
    const run = () =>
      load().then(
        (value) => {
          const next = settle<T>(mode, check, { ok: true, value }, Date.now());
          if (live) put(next);
          return next.state === 'ready';
        },
        (error: unknown) => {
          if (live) put(settle<T>(mode, check, { ok: false, error }, Date.now()));
          return false;
        },
      );
    const stop = startPolling(run, { once: mode === 'backtest' });
    return () => {
      live = false;
      stop();
    };
    // `load` is rebuilt every render; `key` names what it loads.
  }, [key, mode]);

  // Data from a previous mode or month is never shown, even for one frame.
  return loaded.key === key ? loaded.value : { state: 'loading' };
}
