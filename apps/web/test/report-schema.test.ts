import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BacktestReport } from '../src/api/contract.ts';
import { DataError } from '../src/api/modes.ts';
import { loadReport, REPORT_URL, type Getter } from '../src/api/reportLoader.ts';
import { parseReport } from '../src/api/reportSchema.ts';
import { settle } from '../src/api/useEndpoint.ts';
import { fixtureReport } from '../src/dev/dashboardFixtures.ts';

const valid = (): BacktestReport => structuredClone(fixtureReport);
const serve = (status: number, body?: unknown): Getter => async () => ({ status, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
const NOW = Date.parse('2026-10-03T00:00:00Z');

async function stateOf(get: Getter) {
  try {
    return settle('backtest', { ok: true, value: await loadReport(REPORT_URL, get) }, NOW);
  } catch (error) {
    return settle('backtest', { ok: false, error }, NOW);
  }
}

describe('backtest report loader', () => {
  it('reads the fixed release URL', async () => {
    const seen: string[] = [];
    await loadReport(undefined, async (url) => (seen.push(url), { status: 404 }));
    expect(seen).toEqual(['https://github.com/macdarenz-droid/Meme-snipe/releases/download/backtest/latest-report.json']);
  });

  it('missing file: no backtest yet', async () => {
    const s = await stateOf(serve(404));
    expect(s).toMatchObject({ state: 'ready', data: null });
  });

  it('valid file: the whole report, dated by the file', async () => {
    const s = await stateOf(serve(200, valid()));
    expect(s.state).toBe('ready');
    if (s.state !== 'ready') return;
    expect(s.data).toEqual(fixtureReport);
    expect(s.asOf).toBe(fixtureReport.generatedAt);
    expect(s.stale).toBe(false);
  });

  it('malformed file: an error, never partial numbers', async () => {
    expect(await stateOf(serve(200, '{"schemaVersion":1,'))).toEqual({ state: 'error', reason: 'bad-data' });
    const noTrades = valid() as unknown as Record<string, unknown>;
    delete noTrades['trades'];
    expect(await stateOf(serve(200, noTrades))).toEqual({ state: 'error', reason: 'bad-data' });
    const floatMoney = valid();
    (floatMoney.results[0] as unknown as Record<string, unknown>)['netUsd'] = 12.5;
    expect(await stateOf(serve(200, floatMoney))).toEqual({ state: 'error', reason: 'bad-data' });
  });

  it('a mode other than backtest is refused, at the top or in any record', async () => {
    expect(await stateOf(serve(200, { ...valid(), mode: 'paper' }))).toEqual({ state: 'error', reason: 'mixed-modes' });
    const r = valid();
    (r.trades[5] as unknown as Record<string, unknown>)['mode'] = 'live';
    expect(await stateOf(serve(200, r))).toEqual({ state: 'error', reason: 'mixed-modes' });
    const e = valid();
    (e.results[0]?.equity[0] as unknown as Record<string, unknown>)['mode'] = 'paper';
    expect(() => parseReport(e)).toThrow(/expected backtest/);
  });

  it('server errors and unreachable hosts show as could not load', async () => {
    expect(await stateOf(serve(500))).toEqual({ state: 'error', reason: 'failed' });
    expect(await stateOf(async () => Promise.reject(new TypeError('Failed to fetch')))).toEqual({ state: 'error', reason: 'failed' });
  });
});

describe('backtest report schema', () => {
  it('accepts the fixture report', () => {
    expect(parseReport(valid())).toEqual(fixtureReport);
  });

  it('has no place for holdout results: any extra field rejects the file', () => {
    expect(() => parseReport({ ...valid(), holdout: { meanNetUsd: '2.5' } })).toThrow(/\$\.holdout: unknown field/);
    const r = valid();
    (r.results[0] as unknown as Record<string, unknown>)['holdoutMeanUsd'] = '1';
    expect(() => parseReport(r)).toThrow(/unknown field/);
    const g = valid();
    (g.gates[0] as unknown as Record<string, unknown>)['gate'] = 'G2';
    expect(() => parseReport(g)).toThrow(/gate/);
  });

  it('refuses other versions, bad hashes, bad commits and bad days', () => {
    expect(() => parseReport({ ...valid(), schemaVersion: 2 })).toThrow(DataError);
    expect(() => parseReport({ ...valid(), codeCommit: 'abc' })).toThrow(/commit/);
    expect(() => parseReport({ ...valid(), policyHash: 'md5:1' })).toThrow(/sha256/);
    const d = valid();
    (d.results[0]?.days[0] as unknown as Record<string, unknown>)['date'] = '2026-13-01';
    expect(() => parseReport(d)).toThrow(/YYYY-MM-DD/);
  });

  it('checks what the shape cannot: duplicate groups, wins above trades, trades without a result', () => {
    const dup = valid();
    dup.results.push(structuredClone(dup.results[0]!));
    expect(() => parseReport(dup)).toThrow(/twice/);
    const wins = valid();
    wins.results[0]!.wins = wins.results[0]!.trades + 1;
    expect(() => parseReport(wins)).toThrow(/more wins/);
    const orphan = valid();
    orphan.trades[0]!.group = 'U3';
    expect(() => parseReport(orphan)).toThrow(/no result/);
  });

  it('the shared module in packages/core holds types only', () => {
    const src = readFileSync(new URL('../../../packages/core/src/report/index.ts', import.meta.url), 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
    const exports = [...src.matchAll(/^export\s+(\w+)/gm)].map((m) => m[1]);
    expect(exports.length).toBeGreaterThan(5);
    expect(exports.filter((k) => k !== 'type' && k !== 'interface')).toEqual([]);
    expect(src).not.toMatch(/^import\s+(?!type\b)/m);
  });

  it('the web app imports the shared module as types only', () => {
    const contract = readFileSync(new URL('../src/api/contract.ts', import.meta.url), 'utf8');
    const lines = contract.split('\n').filter((l) => l.includes('packages/core'));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toMatch(/^import type |^\/\//);
  });
});
