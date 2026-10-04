// APP-COMPAT: a worker newer than the app (a field the app does not know) reads "App update needed", not "Server error".
// Every check stays strict: such an answer is still refused and never shown. Any other refusal stays "Server error".
// From real use: the owner's pre-API-1 APK showed "Server error" when the worker added status fields.
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { httpApi } from '../src/api/client.ts';
import { BAD_ANSWER_TTL_MS, ConnectionStore } from '../src/api/connection.ts';
import type { WorkerStatus } from '../src/api/contract.ts';
import { checkAnswer, checkEnvelope } from '../src/api/modes.ts';
import { DataError } from '../src/api/schema.ts';
import { schemaFor } from '../src/api/schemas.ts';
import { settle } from '../src/api/useEndpoint.ts';
import { ErrorState } from '../src/dashboard/State.tsx';
import { connectionLabel } from '../src/screens/Server.tsx';
import { shellSession } from '../src/shell/Status.tsx';
import { findBanned } from './banned-copy.ts';

const AT = '2026-10-05T00:10:00.000Z';
const NOW = Date.parse(AT);
const status: WorkerStatus = { mode: 'paper', connected: true, flags: [], risk: [{ mode: 'paper', kind: 'daily-loss', usedUsd: '0', limitUsd: '1.5' }] };
const env = (data: unknown, extra: object = {}) => ({ mode: 'paper', asOf: AT, data, ...extra });
const check = schemaFor('status', 'paper');
const load = (value: unknown) => settle<WorkerStatus>('paper', check, { ok: true, value }, NOW);

const NEWER = env({ ...status, futureField: { a: 1 } });
const NEWER_NESTED = env({ ...status, risk: [{ ...status.risk[0], newRiskField: '1' }] });
const NEWER_ENVELOPE = env(status, { servedBy: 'worker-2' });
const BAD_VALUE = env({ ...status, connected: 'yes' });
const NEWER_AND_BAD = env({ ...status, futureField: 1, connected: 'yes' });
const MISSING = env({ mode: 'paper', connected: true, risk: [] });

describe('telling a newer worker from a broken answer (APP-COMPAT)', () => {
  it('an answer refused only for fields the app does not know is "update-needed", and its data is never used', () => {
    for (const value of [NEWER, NEWER_NESTED, NEWER_ENVELOPE]) {
      expect(load(value)).toEqual({ state: 'error', reason: 'update-needed' });
      let thrown: unknown;
      try { checkAnswer(value, 'paper', check); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(DataError);
      expect((thrown as DataError).kind).toBe('app-outdated');
    }
  });

  it('any other refusal stays "bad-data": a bad value, a missing field, or a bad value next to a new field', () => {
    for (const value of [BAD_VALUE, MISSING, NEWER_AND_BAD]) expect(load(value), JSON.stringify(value)).toEqual({ state: 'error', reason: 'bad-data' });
  });

  it('the checks stay strict after a classification: a new field is still refused by the plain check', () => {
    expect(load(NEWER)).toMatchObject({ reason: 'update-needed' });
    expect(() => checkEnvelope(NEWER, 'paper', check)).toThrow(/unknown field/);
    expect(load(env(status))).toMatchObject({ state: 'ready' });
  });

  it('an older worker (optional fields absent) still loads; a required field absent is refused', () => {
    // API-1's fields are optional(): a worker from before them answers without haltReasons, exitCapable, alerts, regime.
    expect(load(env(status))).toMatchObject({ state: 'ready', data: status });
    expect(load(MISSING)).toEqual({ state: 'error', reason: 'bad-data' });
  });
});

describe('the connection and its labels', () => {
  const origin = 'https://zeroed.example.ts.net'; // the app's placeholder (Server.tsx PLACEHOLDER), never a real tailnet name
  const store = () => {
    const kv = new Map<string, string>();
    const s = new ConnectionStore({ getItem: (k) => kv.get(k) ?? null, setItem: (k, v) => void kv.set(k, v), removeItem: (k) => void kv.delete(k) });
    s.setServer(origin);
    return s;
  };
  const answering = (s: ConnectionStore, byPath: Record<string, { status: number; body: unknown }>, at = NOW) =>
    httpApi(origin, async (url) => {
      const r = byPath[new URL(url).pathname]!;
      return { status: r.status, body: JSON.stringify(r.body) };
    }, s, () => at);

  it('a newer worker reads "App update needed" on the Server card and the shell; a broken answer reads "Server error"', async () => {
    const s = store();
    await answering(s, { '/api/v1/paper/status': { status: 200, body: NEWER } }).status('paper').catch(() => undefined);
    expect(s.get().state).toBe('update');
    expect(connectionLabel(s.get())).toBe('App update needed');
    expect(shellSession({ state: 'error', reason: 'update-needed' }, s.get()).label).toBe('App update needed');

    const t = store();
    await answering(t, { '/api/v1/paper/status': { status: 200, body: BAD_VALUE } }).status('paper').catch(() => undefined);
    expect(t.get().state).toBe('error');
    expect(connectionLabel(t.get())).toMatch(/^Server error/);

    const u = store();
    await answering(u, { '/api/v1/paper/status': { status: 500, body: 'oops' } }).status('paper').catch(() => undefined);
    expect(u.get().state).toBe('error');
  });

  it('a real error on any endpoint outranks "App update needed"; both expire after BAD_ANSWER_TTL_MS', async () => {
    const s = store();
    const paths = { '/api/v1/paper/status': { status: 200, body: NEWER }, '/api/v1/paper/stats': { status: 200, body: env({ broken: true }) } };
    await answering(s, paths).status('paper').catch(() => undefined);
    await answering(s, paths).stats('paper').catch(() => undefined);
    expect(s.get().state).toBe('error');
    // The TTL rule is unchanged: a good answer after both bad ones have aged out reads Online.
    const later = NOW + BAD_ANSWER_TTL_MS;
    s.reportOk(origin, new Date(later).toISOString(), '/api/v1/paper/funnel');
    expect(s.get().state).toBe('online');
    const v = store();
    await answering(v, paths).status('paper').catch(() => undefined);
    v.reportOk(origin, new Date(NOW + BAD_ANSWER_TTL_MS - 1).toISOString(), '/api/v1/paper/funnel');
    expect(v.get().state).toBe('update');
    v.reportOk(origin, new Date(NOW + BAD_ANSWER_TTL_MS).toISOString(), '/api/v1/paper/funnel');
    expect(v.get().state).toBe('online');
  });

  it('a section shows "App update needed" and nothing of the data; the labels pass the copy guard', () => {
    const out = renderToStaticMarkup(h(ErrorState, { reason: 'update-needed' })).replace(/<[^>]+>/g, ' ');
    expect(out).toContain('App update needed');
    expect(findBanned(out)).toEqual([]);
    expect(findBanned('App update needed')).toEqual([]);
  });
});
