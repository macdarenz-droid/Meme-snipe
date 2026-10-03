import { describe, expect, it } from 'vitest';
import { httpApi, offlineApi, OfflineError } from '../src/api/client.ts';
import { MIN_TRADES, MODES, PATHS, type DashboardApi, type Mode, type StatsView } from '../src/api/contract.ts';
import { checkEnvelope, DataError, hasSample, onlyMode, requiredTrades, totalUsd, totalWithin } from '../src/api/modes.ts';
import { isStale, settle } from '../src/api/useEndpoint.ts';
import { FIXTURE_MONTH, fixtureApi } from '../src/dev/dashboardFixtures.ts';

type Call = (api: DashboardApi, m: Mode) => Promise<unknown>;
const CALLS: Record<string, Call> = {
  status: (a, m) => a.status(m),
  funnel: (a, m) => a.funnel(m),
  decisions: (a, m) => a.decisions(m),
  position: (a, m) => a.position(m),
  calendar: (a, m) => a.calendar(m, FIXTURE_MONTH[m]),
  trades: (a, m) => a.trades(m),
  charts: (a, m) => a.charts(m),
  stats: (a, m) => a.stats(m),
};

const NOW = Date.parse('2026-10-03T00:00:00Z');

describe('worker API contract', () => {
  it('every fixture response passes the contract check for its mode', async () => {
    const api = fixtureApi();
    for (const m of MODES) {
      for (const [name, call] of Object.entries(CALLS)) {
        const env = checkEnvelope(await call(api, m), m);
        expect(env.mode, `${m} ${name}`).toBe(m);
      }
    }
    expect(checkEnvelope(await api.backtestReport(), 'backtest').mode).toBe('backtest');
  });

  it('fixture money is decimal strings, never JSON numbers', async () => {
    const json = JSON.stringify(await fixtureApi().trades('backtest'));
    expect(json).not.toMatch(/"\w*Usd":-?\d/);
    expect(json).toMatch(/"netUsd":"-?\d/);
  });

  it('rejects a response whose envelope or any nested record is in another mode', async () => {
    const leaky = fixtureApi({ leakMode: 'live' });
    for (const [name, call] of Object.entries(CALLS)) {
      if (name === 'position') continue;
      const raw = await call(leaky, 'paper');
      expect(() => checkEnvelope(raw, 'paper'), name).toThrow(DataError);
      expect(settle('paper', { ok: true, value: raw }, NOW), name).toEqual({ state: 'error', reason: 'mixed-modes' });
    }
    expect(() => checkEnvelope({ mode: 'live', asOf: '2026-10-03T00:00:00Z', data: [] }, 'paper')).toThrow(/mixed|expected paper/);
  });

  it('rejects money sent as a number or with more than 6 places, but allows long prices', () => {
    const env = (data: unknown) => ({ mode: 'paper', asOf: '2026-10-03T00:00:00Z', data });
    expect(() => checkEnvelope(env({ netUsd: 1.5 }), 'paper')).toThrow(/exact dollar/);
    expect(() => checkEnvelope(env({ netUsd: '1.0000001' }), 'paper')).toThrow(/exact dollar/);
    expect(() => checkEnvelope(env({ entryPriceUsd: 0.00004 }), 'paper')).toThrow(/exact price/);
    expect(checkEnvelope(env({ entryPriceUsd: '0.0000412300123', netUsd: null }), 'paper').data).toBeTruthy();
    expect(settle('paper', { ok: true, value: env({ netUsd: 1.5 }) }, NOW)).toEqual({ state: 'error', reason: 'bad-data' });
    expect(() => checkEnvelope({ mode: 'paper', data: [] }, 'paper')).toThrow(/time/);
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
    expect(settle('paper', { ok: false, error: new OfflineError('x') }, NOW)).toEqual({ state: 'error', reason: 'offline' });
    expect(settle('paper', { ok: false, error: new Error('500') }, NOW)).toEqual({ state: 'error', reason: 'failed' });
  });

  it('offline API fails every call as offline', async () => {
    await expect(offlineApi.trades('paper')).rejects.toBeInstanceOf(OfflineError);
    await expect(offlineApi.backtestReport()).rejects.toBeInstanceOf(OfflineError);
  });

  it('HTTP API reads the contract paths and checks every response', async () => {
    const seen: string[] = [];
    const fixtures = fixtureApi();
    const fake = (async (url: string) => {
      seen.push(url);
      const body = url.endsWith('/paper/stats') ? await fixtures.stats('live') : await fixtures.trades('paper');
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const api = httpApi('https://worker.example/', fake);
    expect((await api.trades('paper')).mode).toBe('paper');
    await expect(api.stats('paper')).rejects.toBeInstanceOf(DataError);
    expect(seen).toEqual([`https://worker.example${PATHS.trades('paper')}`, `https://worker.example${PATHS.stats('paper')}`]);
    expect(PATHS.calendar('backtest', '2026-08')).toBe('/api/v1/backtest/calendar/2026-08');
  });
});
