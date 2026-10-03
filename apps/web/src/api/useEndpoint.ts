import { useEffect, useState } from 'react';
import { STALE_AFTER_SECONDS, type Envelope, type Mode } from './contract.ts';
import { OfflineError } from './client.ts';
import { checkEnvelope, DataError } from './modes.ts';
import type { Check } from './schema.ts';

export type Loaded<T> =
  | { state: 'loading' }
  | { state: 'error'; reason: 'offline' | 'mixed-modes' | 'bad-data' | 'failed' }
  | { state: 'ready'; data: T; asOf: string; stale: boolean };

/** Paper and live refresh on this interval; a backtest is loaded once. */
const REFRESH_MS = 10_000;

export function isStale(mode: Mode, asOf: string, now: number): boolean {
  return mode !== 'backtest' && now - Date.parse(asOf) > STALE_AFTER_SECONDS * 1000;
}

/** Turns a response (or failure) into a screen state. Every response is checked for mode and money first. */
export function settle<T>(mode: Mode, check: Check, result: { ok: true; value: unknown } | { ok: false; error: unknown }, now: number): Loaded<T> {
  if (!result.ok) {
    if (result.error instanceof OfflineError) return { state: 'error', reason: 'offline' };
    if (result.error instanceof DataError) return { state: 'error', reason: result.error.kind === 'mixed-modes' ? 'mixed-modes' : 'bad-data' };
    return { state: 'error', reason: 'failed' };
  }
  try {
    const env: Envelope<T> = checkEnvelope<T>(result.value, mode, check);
    return { state: 'ready', data: env.data, asOf: env.asOf, stale: isStale(mode, env.asOf, now) };
  } catch (e) {
    return settle<T>(mode, check, { ok: false, error: e }, now);
  }
}

/** Loads one endpoint for one mode. Changing the key (mode, month) drops the old data at once. */
export function useEndpoint<T>(mode: Mode, what: string, check: Check, load: () => Promise<Envelope<T>>): Loaded<T> {
  const key = `${mode}|${what}`;
  const [loaded, setLoaded] = useState<{ key: string; value: Loaded<T> }>({ key, value: { state: 'loading' } });

  useEffect(() => {
    let live = true;
    const run = () =>
      load().then(
        (value) => live && setLoaded({ key, value: settle<T>(mode, check, { ok: true, value }, Date.now()) }),
        (error: unknown) => live && setLoaded({ key, value: settle<T>(mode, check, { ok: false, error }, Date.now()) }),
      );
    void run();
    const timer = mode === 'backtest' ? undefined : window.setInterval(run, REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
    // `load` is rebuilt every render; `key` names what it loads.
  }, [key, mode]);

  // Data from a previous mode or month is never shown, even for one frame.
  return loaded.key === key ? loaded.value : { state: 'loading' };
}
