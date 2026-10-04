// API-1: a mode the server does not run (a paper-only worker asked for live or backtest) is "Not running", never
// "Server error": the worker answers every app path of that mode with no data and the reason; the app accepts exactly
// that shape, counts it as a good answer for the connection, and shows "Not running" in the section.
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { httpApi } from '../src/api/client.ts';
import { ConnectionStore } from '../src/api/connection.ts';
import { checkEnvelope } from '../src/api/modes.ts';
import { schemaFor } from '../src/api/schemas.ts';
import { settle } from '../src/api/useEndpoint.ts';
import { Load } from '../src/dashboard/State.tsx';
import { findBanned } from './banned-copy.ts';

const AT = '2026-10-04T06:00:00.000Z';
const notRunning = (mode: string) => ({ mode, asOf: AT, data: null, notRunning: 'this server runs paper only' });
const text = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('a mode the server does not run', () => {
  it('the envelope check accepts exactly the not-running shape, in the asked mode', () => {
    for (const m of ['live', 'backtest'] as const) {
      expect(checkEnvelope(notRunning(m), m, schemaFor('status', m)).notRunning).toBe('this server runs paper only');
      expect(() => checkEnvelope(notRunning(m), m === 'live' ? 'backtest' : 'live', schemaFor('status', m))).toThrow();
    }
    const m = 'live';
    for (const bad of [
      { ...notRunning(m), data: { mode: m, connected: true, flags: [], risk: [] } },
      { ...notRunning(m), notRunning: '' },
      { ...notRunning(m), notRunning: 3 },
      { ...notRunning(m), extra: 1 },
      { mode: m, data: null, notRunning: 'x' },
      { ...notRunning(m), asOf: 'yesterday' },
    ]) expect(() => checkEnvelope(bad, m, schemaFor('status', m))).toThrow();
    // Without the reason, null data is still checked by the endpoint's own schema (and refused there).
    expect(() => checkEnvelope({ mode: m, asOf: AT, data: null }, m, schemaFor('status', m))).toThrow();
  });

  it('a section shows "Not running", never an error', () => {
    const loaded = settle('live', schemaFor('status', 'live'), { ok: true, value: notRunning('live') }, Date.parse(AT));
    expect(loaded).toEqual({ state: 'not-running' });
    const out = text(renderToStaticMarkup(h(Load<unknown>, { loaded, children: () => 'data' })));
    expect(out).toBe('Not running');
    expect(out).not.toMatch(/error/i);
    expect(findBanned(out)).toEqual([]);
  });

  it('counts as a good answer: the connection stays online, no "Server error" for the next 10 minutes', async () => {
    const kv = new Map<string, string>();
    const store = new ConnectionStore({ getItem: (k) => kv.get(k) ?? null, setItem: (k, v) => void kv.set(k, v), removeItem: (k) => void kv.delete(k) });
    const origin = 'https://zeroed.tail1.ts.net';
    store.setServer(origin);
    const api = httpApi(origin, async (url) => ({ status: 200, body: JSON.stringify(url.includes('/paper/') ? { mode: 'paper', asOf: AT, data: { mode: 'paper', connected: true, flags: [], risk: [] } } : notRunning(url.includes('/live/') ? 'live' : 'backtest')) }), store, () => Date.parse(AT));
    await api.status('paper');
    const live = await api.status('live');
    expect(live.notRunning).toBe('this server runs paper only');
    await api.trades('backtest');
    expect(store.get().state).toBe('online');
    await api.status('paper');
    expect(store.get().state).toBe('online');
  });
});
