import { describe, expect, it } from 'vitest';
import { httpApi, offlineApi, OfflineError } from '../src/api/client.ts';
import { MIN_TRADES, MODES, PATHS, type DashboardApi, type Mode, type StatsView } from '../src/api/contract.ts';
import { checkEnvelope, DataError, hasSample, onlyMode, requiredTrades, totalUsd, totalWithin } from '../src/api/modes.ts';
import { reportData } from '../src/api/reportSchema.ts';
import { schemaFor, type Endpoint } from '../src/api/schemas.ts';
import { isStale, settle } from '../src/api/useEndpoint.ts';
import { FIXTURE_MONTH, fixtureApi } from '../src/dev/dashboardFixtures.ts';

type Call = (api: DashboardApi, m: Mode) => Promise<unknown>;
const CALLS: Record<Endpoint, Call> = {
  status: (a, m) => a.status(m),
  funnel: (a, m) => a.funnel(m),
  decisions: (a, m) => a.decisions(m),
  position: (a, m) => a.position(m),
  calendar: (a, m) => a.calendar(m, FIXTURE_MONTH[m]),
  trades: (a, m) => a.trades(m),
  charts: (a, m) => a.charts(m),
  stats: (a, m) => a.stats(m),
  discovered: (a, m) => a.discovered(m),
};

const NOW = Date.parse('2026-10-03T00:00:00Z');

describe('worker API contract', () => {
  it('every fixture response passes the contract check for its mode', async () => {
    const api = fixtureApi();
    for (const m of MODES) {
      for (const [name, call] of Object.entries(CALLS) as [Endpoint, Call][]) {
        const env = checkEnvelope(await call(api, m), m, schemaFor(name, m));
        expect(env.mode, `${m} ${name}`).toBe(m);
      }
    }
    expect(checkEnvelope(await api.backtestReport(), 'backtest', reportData).mode).toBe('backtest');
  });

  it('fixture money is decimal strings, never JSON numbers', async () => {
    const json = JSON.stringify(await fixtureApi().trades('backtest'));
    expect(json).not.toMatch(/"\w*Usd":-?\d/);
    expect(json).toMatch(/"netUsd":"-?\d/);
  });

  it('rejects a response whose envelope or any nested record is in another mode', async () => {
    const leaky = fixtureApi({ leakMode: 'live' });
    for (const [name, call] of Object.entries(CALLS) as [Endpoint, Call][]) {
      if (name === 'position') continue;
      const raw = await call(leaky, 'paper');
      expect(() => checkEnvelope(raw, 'paper', schemaFor(name, 'paper')), name).toThrow(DataError);
      expect(settle('paper', schemaFor(name, 'paper'), { ok: true, value: raw }, NOW), name).toEqual({ state: 'error', reason: 'mixed-modes' });
    }
    expect(() => checkEnvelope({ mode: 'live', asOf: '2026-10-03T00:00:00Z', data: [] }, 'paper', schemaFor('trades', 'paper'))).toThrow(/expected paper/);
  });

  // Review of 236cee3: each of these passed the old name-based check and then crashed a screen.
  describe('review probes', () => {
    const at = '2026-10-03T00:00:00Z';
    const state = (endpoint: Endpoint, data: unknown) => settle('paper', schemaFor(endpoint, 'paper'), { ok: true, value: { mode: 'paper', asOf: at, data } }, NOW);
    const paper = async <T>(f: (api: DashboardApi) => Promise<{ data: T }>) => structuredClone((await f(fixtureApi())).data);

    it('a calendar day with no mode is refused', async () => {
      const cal = await paper((a) => a.calendar('paper', FIXTURE_MONTH.paper));
      delete (cal.days[0] as unknown as Record<string, unknown>)['mode'];
      expect(state('calendar', cal)).toEqual({ state: 'error', reason: 'bad-data' });
    });

    it('a record with no mode is refused even where no schema reaches', () => {
      expect(() => checkEnvelope({ mode: 'paper', asOf: at, data: [{ x: 1 }] }, 'paper', () => {})).toThrow(/expected paper/);
    });

    it('cost money that is not an exact string is refused', async () => {
      const charts = await paper((a) => a.charts('paper'));
      (charts.costsByKind[0] as unknown as Record<string, unknown>)['amountUsd'] = 12.5;
      expect(state('charts', charts)).toEqual({ state: 'error', reason: 'bad-data' });
      const renamed = await paper((a) => a.charts('paper'));
      (renamed.costsByKind[0] as unknown as Record<string, unknown>)['usd'] = 'abc';
      expect(state('charts', renamed)).toEqual({ state: 'error', reason: 'bad-data' });
    });

    it('a malformed decimal is refused (R, win rate, bucket edges, prices)', async () => {
      const trades = await paper((a) => a.trades('paper'));
      (trades[0] as unknown as Record<string, unknown>)['realizedR'] = 'abc';
      expect(state('trades', trades)).toEqual({ state: 'error', reason: 'bad-data' });
      const stats = await paper((a) => a.stats('paper'));
      (stats as unknown as Record<string, unknown>)['winRate'] = 0.41;
      expect(state('stats', stats)).toEqual({ state: 'error', reason: 'bad-data' });
      const charts = await paper((a) => a.charts('paper'));
      (charts.rBuckets[0] as unknown as Record<string, unknown>)['fromR'] = '1,5';
      expect(state('charts', charts)).toEqual({ state: 'error', reason: 'bad-data' });
      const pos = await paper((a) => a.position('paper'));
      (pos as unknown as Record<string, unknown>)['entryPriceUsd'] = 4e-5;
      expect(state('position', pos)).toEqual({ state: 'error', reason: 'bad-data' });
    });

    it('a reject by H17 (unsupported trade shape, TX-1b) is shown; an unknown check is refused', async () => {
      const funnel = await paper((a) => a.funnel('paper'));
      const withCheck = (check: string) => ({ ...funnel, rejects: [{ mode: 'paper', check, count: 3 }] });
      expect(state('funnel', withCheck('H17')).state).not.toBe('error');
      expect(state('funnel', withCheck('H18'))).toEqual({ state: 'error', reason: 'bad-data' });
    });

    it('unknown and missing fields are refused', async () => {
      const stats = await paper((a) => a.stats('paper'));
      expect(state('stats', { ...stats, extra: '1' })).toEqual({ state: 'error', reason: 'bad-data' });
      const { netUsd: _drop, ...noNet } = stats;
      expect(state('stats', noNet)).toEqual({ state: 'error', reason: 'bad-data' });
      expect(() => checkEnvelope({ mode: 'paper', asOf: at, data: stats, extra: 1 }, 'paper', schemaFor('stats', 'paper'))).toThrow(/unknown field/);
    });
  });

  it('rejects money sent as a number or with more than 6 places', () => {
    const env = (data: unknown) => ({ mode: 'paper', asOf: '2026-10-03T00:00:00Z', data });
    const stats = schemaFor('stats', 'paper');
    const base = { mode: 'paper', trades: 0, requiredTrades: null, netUsd: '0', maxDrawdownUsd: '0', winRate: null, meanNetUsd: null, meanR: null, ci95: null };
    expect(checkEnvelope(env(base), 'paper', stats).data).toEqual(base);
    expect(() => checkEnvelope(env({ ...base, netUsd: 1.5 }), 'paper', stats)).toThrow(/exact dollar/);
    expect(() => checkEnvelope(env({ ...base, netUsd: '1.0000001' }), 'paper', stats)).toThrow(/exact dollar/);
    expect(settle('paper', stats, { ok: true, value: env({ ...base, netUsd: 1.5 }) }, NOW)).toEqual({ state: 'error', reason: 'bad-data' });
    expect(() => checkEnvelope({ mode: 'paper', data: base }, 'paper', stats)).toThrow(/asOf/);
  });

  it('totals refuse records from another mode', () => {
    const days = [
      { mode: 'paper' as const, netUsd: '1.1' },
      { mode: 'paper' as const, netUsd: '2.2' },
    ];
    expect(totalUsd('paper', days, (d) => d.netUsd)).toBe('3.3');
    expect(() => totalUsd('paper', [...days, { mode: 'live' as const, netUsd: '100' }], (d) => d.netUsd)).toThrow(DataError);
    expect(() => onlyMode('backtest', days)).toThrow(/paper record reached the backtest view/);
    expect(() => totalWithin('live', { mode: 'paper' }, ['1'])).toThrow(DataError);
    expect(totalWithin('paper', { mode: 'paper' }, ['1', '0.5'])).toBe('1.5');
  });

  it('never lowers the sample a statistic needs below the §14 floor', () => {
    const s = (mode: Mode, trades: number, requiredTrades: number | null) => ({ mode, trades, requiredTrades }) as StatsView;
    expect(MIN_TRADES).toEqual({ backtest: 300, paper: 30, live: 30 });
    expect(requiredTrades(s('backtest', 0, 5))).toBe(300);
    expect(requiredTrades(s('backtest', 0, 321))).toBe(321);
    expect(requiredTrades(s('paper', 0, null))).toBe(30);
    expect(hasSample(s('paper', 29, 10))).toBe(false);
    expect(hasSample(s('paper', 30, null))).toBe(true);
    expect(hasSample(s('backtest', 320, 321))).toBe(false);
  });

  it('marks paper and live data stale after 15 s; a backtest never', () => {
    const old = new Date(NOW - 16_000).toISOString();
    const fresh = new Date(NOW - 14_000).toISOString();
    expect(isStale('paper', old, NOW)).toBe(true);
    expect(isStale('live', fresh, NOW)).toBe(false);
    expect(isStale('backtest', old, NOW)).toBe(false);
  });

  it('maps failures to screen states', () => {
    const s = schemaFor('stats', 'paper');
    expect(settle('paper', s, { ok: false, error: new OfflineError('x') }, NOW)).toEqual({ state: 'error', reason: 'offline' });
    expect(settle('paper', s, { ok: false, error: new Error('500') }, NOW)).toEqual({ state: 'error', reason: 'failed' });
  });

  it('offline API fails every call as offline', async () => {
    await expect(offlineApi.trades('paper')).rejects.toBeInstanceOf(OfflineError);
    await expect(offlineApi.backtestReport()).rejects.toBeInstanceOf(OfflineError);
  });

  it('HTTP API reads the contract paths and checks every response', async () => {
    const seen: string[] = [];
    const fixtures = fixtureApi();
    const fake = async (url: string) => {
      seen.push(url);
      const body = url.endsWith('/paper/stats') ? await fixtures.stats('live') : await fixtures.trades('paper');
      return { status: 200, body: JSON.stringify(body) };
    };
    const api = httpApi('https://worker.example/', fake);
    expect((await api.trades('paper')).mode).toBe('paper');
    await expect(api.stats('paper')).rejects.toBeInstanceOf(DataError);
    expect(seen).toEqual([`https://worker.example${PATHS.trades('paper')}`, `https://worker.example${PATHS.stats('paper')}`]);
    expect(PATHS.calendar('backtest', '2026-08')).toBe('/api/v1/backtest/calendar/2026-08');
  });
});
