import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { httpApi, OfflineError } from '../src/api/client.ts';
import { BAD_ANSWER_TTL_MS, ConnectionStore } from '../src/api/connection.ts';
import { PATHS, type DashboardApi, type Mode } from '../src/api/contract.ts';
import { DataError } from '../src/api/modes.ts';
import { MAX_BACKOFF_MS, nextDelay, REFRESH_MS, documentForeground, startPolling, type Foreground, type Timers } from '../src/api/poll.ts';
import { REQUEST_TIMEOUT_MS, type Got } from '../src/api/reportLoader.ts';
import { reportData } from '../src/api/reportSchema.ts';
import { schemaFor } from '../src/api/schemas.ts';
import { keepOnOffline, settle, type Loaded } from '../src/api/useEndpoint.ts';
import { clearServer, loadSeen, loadServer, parseServer, saveServer, SERVER_ERROR_TEXT, type KeyValue } from '../src/api/server.ts';
import { DashboardBody, type Loads } from '../src/dashboard/Dashboard.tsx';
import { FIXTURE_MONTH, fixtureApi } from '../src/dev/dashboardFixtures.ts';
import { connectionLabel, ServerForm, ServerView } from '../src/screens/Server.tsx';

const ORIGIN = 'https://zeroed.tail1234.ts.net';
const text = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const noop = () => {};
Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) } });

function memory(): KeyValue & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

/**
 * Contract mock server: answers every contract path with the fixture envelope for that path, as the
 * worker would, and records each request's method and headers.
 */
interface Mock {
  base: string;
  requests: { method: string; url: string; headers: IncomingHttpHeaders }[];
  server: Server;
}

async function startMock(api: DashboardApi = fixtureApi()): Promise<Mock> {
  const routes = new Map<string, () => Promise<unknown>>();
  for (const m of ['backtest', 'paper', 'live'] as Mode[]) {
    routes.set(PATHS.status(m), () => api.status(m));
    routes.set(PATHS.funnel(m), () => api.funnel(m));
    routes.set(PATHS.decisions(m), () => api.decisions(m));
    routes.set(PATHS.position(m), () => api.position(m));
    routes.set(PATHS.calendar(m, FIXTURE_MONTH[m]), () => api.calendar(m, FIXTURE_MONTH[m]));
    routes.set(PATHS.trades(m), () => api.trades(m));
    routes.set(PATHS.charts(m), () => api.charts(m));
    routes.set(PATHS.stats(m), () => api.stats(m));
  }
  routes.set(PATHS.backtestReport(), () => api.backtestReport());
  const requests: Mock['requests'] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    const route = req.method === 'GET' ? routes.get(req.url ?? '') : undefined;
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    void route().then((body) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body)));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, server };
}

/** Sends the tailnet address to the mock server, the way Tailscale routes it to the worker. Real HTTP, real failures. */
const tailnetTo = (base: string) => async (url: string): Promise<Got> => {
  expect(url.startsWith(ORIGIN + '/api/v1/')).toBe(true);
  const res = await fetch(base + url.slice(ORIGIN.length), { headers: { accept: 'application/json' } });
  return { status: res.status, body: await res.text() };
};

describe('server address', () => {
  it('accepts an https tailnet address and keeps only its origin', () => {
    expect(parseServer(' https://zeroed.tail1234.ts.net ')).toEqual({ ok: true, origin: ORIGIN });
    expect(parseServer('https://Zeroed.Tail1234.TS.NET/')).toEqual({ ok: true, origin: ORIGIN });
    expect(parseServer('https://zeroed.tail1234.ts.net:8443')).toEqual({ ok: true, origin: `${ORIGIN}:8443` });
  });

  it.each([
    ['', 'empty'],
    ['zeroed.tail1234.ts.net', 'not-url'],
    ['http://zeroed.tail1234.ts.net', 'not-https'],
    ['ftp://zeroed.tail1234.ts.net', 'not-https'],
    ['https://zeroed.example.com', 'not-tailnet'],
    ['https://tail1234.ts.net', 'not-tailnet'],
    ['https://ts.net', 'not-tailnet'],
    ['https://zeroed.tail1234.ts.net.evil.com', 'not-tailnet'],
    ['https://100.101.102.103', 'not-tailnet'],
    ['https://-bad.tail1234.ts.net', 'not-tailnet'],
    ['https://user:pass@zeroed.tail1234.ts.net', 'extra'],
    ['https://zeroed.tail1234.ts.net/api', 'extra'],
    ['https://zeroed.tail1234.ts.net/?key=abc', 'extra'],
    ['https://zeroed.tail1234.ts.net/#token', 'extra'],
  ])('refuses %j (%s)', (input, error) => {
    expect(parseServer(input)).toEqual({ ok: false, error });
    expect(SERVER_ERROR_TEXT[error as keyof typeof SERVER_ERROR_TEXT]).toBeTruthy();
  });

  it('remembers the address and nothing else, and drops a saved value that fails the check', () => {
    const kv = memory();
    expect(loadServer(kv)).toBeNull();
    expect(saveServer(ORIGIN, kv)).toBe(true);
    expect([...kv.data.keys()]).toEqual(['zeroed.server']);
    expect(kv.data.get('zeroed.server')).toBe(ORIGIN);
    expect(loadServer(kv)).toBe(ORIGIN);
    expect(() => saveServer('http://zeroed.tail1234.ts.net', kv)).toThrow();
    kv.data.set('zeroed.server', 'http://zeroed.tail1234.ts.net');
    expect(loadServer(kv)).toBeNull();
    clearServer(kv);
    expect(kv.data.size).toBe(0);
  });

  it('works with blocked storage', () => {
    const blocked: KeyValue = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadServer(blocked)).toBeNull();
    expect(saveServer(ORIGIN, blocked)).toBe(false);
    const store = new ConnectionStore(blocked);
    expect(store.setServer(ORIGIN)).toBe(false);
    expect(store.get()).toEqual({ origin: ORIGIN, state: 'connecting', lastOk: null, lastAnswer: null });
  });

  it('bad address: the form opens empty with the address field and no saved value', () => {
    const out = renderToStaticMarkup(h(ServerForm, { onSave: noop }));
    expect(out).toContain('Server address');
    expect(out).toContain('placeholder="https://zeroed.example.ts.net"');
    expect(out).toContain('type="url"');
  });
});

describe('contract mock server', () => {
  let mock: Mock;
  beforeAll(async () => {
    mock = await startMock();
  });
  afterAll(() => new Promise<void>((ok) => mock.server.close(() => ok())));

  it('connected: every paper endpoint passes the contract check, read-only, and the app shows Online', async () => {
    const kv = memory();
    const store = new ConnectionStore(kv);
    store.setServer(ORIGIN);
    expect(store.get().state).toBe('connecting');
    const at = Date.parse('2026-10-03T07:30:00Z');
    const api = httpApi(ORIGIN, tailnetTo(mock.base), store, () => at);
    mock.requests.length = 0;
    const envs = await Promise.all([
      api.status('paper'),
      api.funnel('paper'),
      api.decisions('paper'),
      api.position('paper'),
      api.calendar('paper', FIXTURE_MONTH.paper),
      api.trades('paper'),
      api.charts('paper'),
      api.stats('paper'),
    ]);
    for (const env of envs) expect(env.mode).toBe('paper');
    expect(store.get()).toEqual({ origin: ORIGIN, state: 'online', lastOk: '2026-10-03T07:30:00.000Z', lastAnswer: '2026-10-03T07:30:00.000Z' });
    expect(loadSeen(ORIGIN, kv)).toBe('2026-10-03T07:30:00.000Z');
    expect(connectionLabel(store.get())).toBe('Online');
    // Read-only: GET only, no credentials of any kind.
    expect(mock.requests).toHaveLength(8);
    for (const r of mock.requests) {
      expect(r.method).toBe('GET');
      expect(r.headers.authorization).toBeUndefined();
      expect(r.headers.cookie).toBeUndefined();
    }
  });

  it('a response in another mode, an HTTP error or a non-JSON body is never an update: Server error, last update kept', async () => {
    const leaky = await startMock(fixtureApi({ leakMode: 'live' }));
    try {
      const kv = memory();
      const store = new ConnectionStore(kv);
      store.setServer(ORIGIN);
      store.reportOk(ORIGIN, '2026-10-03T03:32:00.000Z');
      const at = Date.parse('2026-10-03T03:40:00Z');
      const api = httpApi(ORIGIN, tailnetTo(leaky.base), store, () => at);
      await expect(api.trades('paper')).rejects.toBeInstanceOf(DataError);
      expect(store.get()).toEqual({ origin: ORIGIN, state: 'error', lastOk: '2026-10-03T03:32:00.000Z', lastAnswer: '2026-10-03T03:40:00.000Z' });
      expect(loadSeen(ORIGIN, kv)).toBe('2026-10-03T03:32:00.000Z');
      expect(connectionLabel(store.get())).toBe('Server error · last update 3 Oct, 13:32');
      const view = text(renderToStaticMarkup(h(ServerView, { c: store.get(), onChange: noop, onRemove: noop })));
      expect(view).toContain('Last update 3 Oct, 13:32');
      expect(view).toContain('Last answer 3 Oct, 13:40');
      expect(view).not.toContain('Online');

      const fresh = new ConnectionStore(memory());
      fresh.setServer(ORIGIN);
      await expect(httpApi(ORIGIN, async () => ({ status: 500, body: 'oops' }), fresh).stats('paper')).rejects.toThrow('500');
      await expect(httpApi(ORIGIN, async () => ({ status: 200, body: '<html>' }), fresh).stats('paper')).rejects.toBeInstanceOf(DataError);
      expect(fresh.get().state).toBe('error');
      expect(fresh.get().lastOk).toBeNull();
      expect(connectionLabel(fresh.get())).toBe('Server error · no update yet');
    } finally {
      await new Promise<void>((ok) => leaky.server.close(() => ok()));
    }
  });

  it('mode shown: live server data renders with its mode on every section and no sample marker', async () => {
    const api = httpApi(ORIGIN, tailnetTo(mock.base));
    const now = Date.now();
    const s = <T,>(check: Parameters<typeof settle>[1], value: unknown, mode: Mode = 'paper') => settle<T>(mode, check, { ok: true, value }, now);
    const m: Mode = 'paper';
    const loaded: Loads = {
      status: s(schemaFor('status', m), await api.status(m)),
      funnel: s(schemaFor('funnel', m), await api.funnel(m)),
      decisions: s(schemaFor('decisions', m), await api.decisions(m)),
      position: s(schemaFor('position', m), await api.position(m)),
      calendar: s(schemaFor('calendar', m), await api.calendar(m, FIXTURE_MONTH.paper)),
      trades: s(schemaFor('trades', m), await api.trades(m)),
      charts: s(schemaFor('charts', m), await api.charts(m)),
      stats: s(schemaFor('stats', m), await api.stats(m)),
      report: s(reportData, await api.backtestReport(), 'backtest'),
    };
    for (const [k, v] of Object.entries(loaded)) expect(v.state, k).toBe('ready');
    const out = renderToStaticMarkup(h(DashboardBody, { mode: 'paper', month: FIXTURE_MONTH.paper, setMonth: noop, loaded }));
    const sections = out.match(/<section /g)?.length ?? 0;
    expect(sections).toBeGreaterThan(10);
    expect(out.match(/data-mode="paper"/g)).toHaveLength(sections);
    expect(out).not.toMatch(/data-mode="(live|backtest)"/);
    expect(text(out)).toContain('OPEN1');
    expect(text(out)).not.toContain('Sample data');
    expect(text(out)).not.toContain('Worker not connected');
  });

  it('offline: an unreachable server shows Offline with the last update time, and on-screen data stays, marked stale', async () => {
    const down = await startMock();
    const base = down.base;
    await new Promise<void>((ok) => down.server.close(() => ok()));
    const kv = memory();
    const store = new ConnectionStore(kv);
    store.setServer(ORIGIN);
    store.reportOk(ORIGIN, '2026-10-03T03:32:00.000Z');
    const api = httpApi(ORIGIN, tailnetTo(base), store);
    await expect(api.status('paper')).rejects.toBeInstanceOf(OfflineError);
    expect(store.get()).toEqual({ origin: ORIGIN, state: 'offline', lastOk: '2026-10-03T03:32:00.000Z', lastAnswer: '2026-10-03T03:32:00.000Z' });
    // 03:32 UTC is 13:32 in Melbourne (AEST, before the 4 Oct change).
    expect(connectionLabel(store.get())).toBe('Offline · last update 3 Oct, 13:32');
    const view = text(renderToStaticMarkup(h(ServerView, { c: store.get(), onChange: noop, onRemove: noop })));
    expect(view).toContain('Offline · last update 3 Oct, 13:32');
    expect(view).toContain('Read only');
    // A restart keeps the last update time.
    expect(new ConnectionStore(kv).get()).toEqual({ origin: ORIGIN, state: 'connecting', lastOk: '2026-10-03T03:32:00.000Z', lastAnswer: null });
    expect(connectionLabel({ origin: ORIGIN, state: 'offline', lastOk: null, lastAnswer: null })).toBe('Offline · no update yet');

    const ready: Loaded<number> = { state: 'ready', data: 1, asOf: '2026-10-03T03:32:00.000Z', stale: false };
    const offline: Loaded<number> = { state: 'error', reason: 'offline' };
    expect(keepOnOffline(ready, offline, 'paper')).toEqual({ ...ready, stale: true });
    expect(keepOnOffline(undefined, offline, 'paper')).toEqual(offline);
    expect(keepOnOffline(ready, { state: 'error', reason: 'bad-data' }, 'paper')).toEqual({ state: 'error', reason: 'bad-data' });
  });

  it('one endpoint failing its check keeps Server error steady while another endpoint answers well', async () => {
    const store = new ConnectionStore(memory());
    store.setServer(ORIGIN);
    const fixtures = fixtureApi();
    const get = async (url: string) =>
      url.endsWith(PATHS.stats('paper')) ? { status: 200, body: JSON.stringify(await fixtures.stats('live')) } : { status: 200, body: JSON.stringify(await fixtures.trades('paper')) };
    let t = Date.parse('2026-10-03T03:00:00Z');
    const api = httpApi(ORIGIN, get, store, () => t);
    const states: string[] = [];
    for (let i = 0; i < 4; i++) {
      t += 10_000;
      await api.trades('paper');
      states.push(store.get().state);
      t += 10_000;
      await api.stats('paper').catch(() => {});
      states.push(store.get().state);
    }
    expect(states.slice(1)).toEqual(Array(7).fill('error'));
    // Good data still counts as an update.
    expect(store.get().lastOk).toBe('2026-10-03T03:01:10.000Z');
  });

  it('a bad answer outlives the slowest poll, so a broken endpoint cannot flicker back to Online', () => {
    // The slowest poll waits MAX_BACKOFF_MS plus 10% jitter, then up to REQUEST_TIMEOUT_MS for the answer.
    expect(BAD_ANSWER_TTL_MS).toBeGreaterThan(MAX_BACKOFF_MS * 1.1 + REQUEST_TIMEOUT_MS);
    expect(nextDelay(64, 0.999999)).toBeLessThanOrEqual(MAX_BACKOFF_MS * 1.1);
  });

  it('Server error clears once the bad endpoint answers well, or after it has not answered for 10 minutes', () => {
    const store = new ConnectionStore(memory());
    store.setServer(ORIGIN);
    const at = (m: number) => new Date(Date.parse('2026-10-03T03:00:00Z') + m * 60_000).toISOString();
    store.reportBad(ORIGIN, at(0), 'live/stats');
    store.reportOk(ORIGIN, at(1), 'paper/trades');
    expect(store.get().state).toBe('error');
    store.reportOk(ORIGIN, at(2), 'live/stats');
    expect(store.get().state).toBe('online');
    store.reportBad(ORIGIN, at(3), 'live/stats');
    store.reportOk(ORIGIN, at(12), 'paper/trades');
    expect(store.get().state).toBe('error');
    store.reportOk(ORIGIN, at(13) , 'paper/trades');
    expect(store.get().state).toBe('online');
    // A new address starts clean.
    store.reportBad(ORIGIN, at(14), 'live/stats');
    store.setServer('https://other.tail1234.ts.net');
    store.reportOk('https://other.tail1234.ts.net', at(15), 'paper/trades');
    expect(store.get().state).toBe('online');
  });

  it('a timed-out request counts as offline', async () => {
    const store = new ConnectionStore(memory());
    store.setServer(ORIGIN);
    const api = httpApi(ORIGIN, () => Promise.reject(new DOMException('timed out', 'TimeoutError')), store);
    await expect(api.stats('paper')).rejects.toBeInstanceOf(OfflineError);
    expect(store.get().state).toBe('offline');
  });

  it('reports for a replaced address are ignored', () => {
    const store = new ConnectionStore(memory());
    store.setServer(ORIGIN);
    store.setServer('https://other.tail1234.ts.net');
    store.reportOk(ORIGIN, '2026-10-03T00:00:00.000Z');
    store.reportBad(ORIGIN, '2026-10-03T00:00:00.000Z');
    store.reportOffline(ORIGIN);
    expect(store.get()).toEqual({ origin: 'https://other.tail1234.ts.net', state: 'connecting', lastOk: null, lastAnswer: null });
    store.clear();
    expect(store.get()).toEqual({ origin: null, state: 'none', lastOk: null, lastAnswer: null });
  });
});

describe('polling', () => {
  function harness(visible = true) {
    let now = 0;
    let seq = 0;
    const pending = new Map<number, { at: number; fn: () => void }>();
    let listener: ((v: boolean) => void) | null = null;
    const fg: Foreground & { set(v: boolean): void } = {
      visible: () => visible,
      watch: (fn) => {
        listener = fn;
        return () => (listener = null);
      },
      set(v) {
        visible = v;
        listener?.(v);
      },
    };
    const timers: Timers = {
      set: (fn, ms) => (pending.set(++seq, { at: now + ms, fn }), seq),
      clear: (h) => void pending.delete(h as number),
      now: () => now,
    };
    /** Moves the clock to the next timer and fires it; returns the wait. */
    const step = async () => {
      const [id, t] = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0] ?? [];
      if (id === undefined || !t) return null;
      pending.delete(id);
      const wait = t.at - now;
      now = t.at;
      t.fn();
      await new Promise((r) => setTimeout(r, 0));
      return wait;
    };
    return { fg, timers, step, pending, advance: (ms: number) => (now += ms) };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('waits 10 s after an answer and doubles after each failure up to 5 minutes', () => {
    expect(nextDelay(0)).toBe(REFRESH_MS);
    expect([1, 2, 3, 4, 5, 6, 40].map((f) => nextDelay(f))).toEqual([20_000, 40_000, 80_000, 160_000, MAX_BACKOFF_MS, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
    expect(nextDelay(3, 0.999)).toBeLessThanOrEqual(80_000 * 1.1);
  });

  it('polls on success, backs off while offline, and recovers', async () => {
    const t = harness();
    const results = [true, false, false, false, true];
    let calls = 0;
    const stop = startPolling(async () => results[calls++] ?? true, { foreground: t.fg, timers: t.timers, random: () => 0 });
    await flush();
    expect(calls).toBe(1);
    const waits: (number | null)[] = [];
    for (let i = 0; i < 5; i++) waits.push(await t.step());
    expect(waits).toEqual([10_000, 20_000, 40_000, 80_000, 10_000]);
    stop();
    expect(t.pending.size).toBe(0);
  });

  it('makes no requests in the background and catches up on return', async () => {
    const t = harness();
    let calls = 0;
    const stop = startPolling(async () => (calls++, true), { foreground: t.fg, timers: t.timers });
    await flush();
    t.fg.set(false);
    expect(t.pending.size).toBe(0);
    t.advance(60 * 60_000);
    expect(await t.step()).toBeNull();
    expect(calls).toBe(1);
    t.fg.set(true);
    expect(await t.step()).toBe(0);
    expect(calls).toBe(2);
    stop();
  });

  it('does not start while in the background', async () => {
    const t = harness(false);
    let calls = 0;
    const stop = startPolling(async () => (calls++, true), { foreground: t.fg, timers: t.timers });
    await flush();
    expect(calls).toBe(0);
    t.fg.set(true);
    await t.step();
    expect(calls).toBe(1);
    stop();
  });

  it('a finished backtest loads once; a failed load retries', async () => {
    const t = harness();
    const results = [false, true];
    let calls = 0;
    startPolling(async () => results[calls++] ?? true, { once: true, foreground: t.fg, timers: t.timers, random: () => 0 });
    await flush();
    expect(await t.step()).toBe(20_000);
    expect(calls).toBe(2);
    expect(await t.step()).toBeNull();
  });

  it('follows the page visibility and the Android pause and resume events', () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' }) as unknown as Document & { visibilityState: string };
    const fg = documentForeground(doc);
    const seen: boolean[] = [];
    const unwatch = fg.watch((v) => seen.push(v));
    expect(fg.visible()).toBe(true);
    doc.dispatchEvent(new Event('pause'));
    expect(fg.visible()).toBe(false);
    doc.dispatchEvent(new Event('resume'));
    expect(fg.visible()).toBe(true);
    (doc as { visibilityState: string }).visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(fg.visible()).toBe(false);
    expect(seen).toEqual([false, true, false]);
    unwatch();
    doc.dispatchEvent(new Event('pause'));
    expect(seen).toHaveLength(3);
  });
});

describe('android network', () => {
  const main = new URL('../android/app/src/main/', import.meta.url);
  const read = (p: string) => readFileSync(new URL(p, main), 'utf8');

  it('allows HTTPS only, with no cleartext exception for any host', () => {
    const manifest = read('AndroidManifest.xml');
    expect(manifest).toContain('android:usesCleartextTraffic="false"');
    expect(manifest).toContain('android:networkSecurityConfig="@xml/network_security_config"');
    const config = read('res/xml/network_security_config.xml');
    expect(config).toMatch(/<base-config cleartextTrafficPermitted="false">/);
    expect(config).not.toMatch(/cleartextTrafficPermitted="true"/);
    expect(config).not.toContain('<domain-config');
    expect(config).not.toContain('src="user"');
  });

  it('serves the app over https with no mixed content or cleartext override', () => {
    const cap = JSON.parse(readFileSync(new URL('../capacitor.config.json', import.meta.url), 'utf8')) as Record<string, unknown> & { android?: Record<string, unknown>; server?: Record<string, unknown> };
    expect(cap.android?.['allowMixedContent']).toBe(false);
    expect(cap.server?.['cleartext']).toBeUndefined();
    expect(cap.server?.['androidScheme'] ?? 'https').toBe('https');
    expect(cap.server?.['url']).toBeUndefined();
  });
});
