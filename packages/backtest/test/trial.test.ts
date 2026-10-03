// The trial view's report: UI-2's strict schema, labelled as a trial in progress, practice days only. No day of the
// sealed window can appear in it, whatever the parts claim.
import { describe, expect, it } from 'vitest';
import { parseReport } from '../../../apps/web/src/api/reportSchema.ts';
import { FILL_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { STUDY_CONFIG } from '../src/strategy/config.ts';
import { holdoutDaysOf, windowDays } from '../src/study/plan.ts';
import { assertPractice, toPartTrade, trialReport, type TrialPart } from '../src/study/trial.ts';
import type { TradeRecord } from '../src/trades.ts';

const COMMIT = 'a'.repeat(40);
const at = (day: string, h: number) => Date.parse(`${day}T00:00:00Z`) + h * 3_600_000;
const trade = (id: string, day: string, net: bigint): TradeRecord => ({
  id, mint: 'M'.repeat(43), symbol: 'TST', openedAt: at(day, 3), closedAt: at(day, 4), entrySol: 16_000_000n, tokens: 5_000_000_000n,
  exitSol: 16_000_000n + net, networkBase: 10_000n, priority: 40_000n, tip: 10_000n, venueFee: 200_000n, creatorFee: 100_000n, slippage: 50_000n,
  rentPaid: 1_513_840n, rentReturned: 1_513_840n, exitReason: 'time-stop', net, attempts: 2, failedAttempts: 0,
});
const part = (days: string[], trades: TrialPart['trades'], over: Partial<TrialPart> = {}): TrialPart => ({
  kind: 'BT-2 trial part', runId: `trial-${days[0]}`, commit: COMMIT, datasetId: `sha256:${days[0]}`, days,
  engine: { replays: 10, identicalReplays: true, crashes: 0, illegalStates: 0, unreconciledIntents: 0, leak: true, ledgerReplay: true },
  candidates: 10, entries: trades.length, trades, ...over,
});
const sol = { name: 'SOL/USD', source: 'test', tag: 'fixed' as const, barMs: 3_600_000, fetchedAt: at('2026-07-01', 0), bars: Array.from({ length: 24 * 100 }, (_, k) => ({ start: at('2026-07-15', k), close: '150.00' })) };
const input = (parts: TrialPart[]) => ({ parts, config: STUDY_CONFIG, policy: TRIAL_POLICY, fills: FILL_CONFIG, solUsd: sol, commit: COMMIT, generatedAt: '2026-10-06T00:00:00Z' });

describe('trial report', () => {
  const a = part(['2026-09-10', '2026-09-11', '2026-09-12'], [toPartTrade(trade('p:U2:a', '2026-09-10', 300_000n), 'U2'), toPartTrade(trade('p:S0-U2:a', '2026-09-11', -200_000n), 'S0-U2')]);
  const b = part(['2026-09-13', '2026-09-14', '2026-09-15'], [toPartTrade(trade('p:U1:b', '2026-09-14', -100_000n), 'U1')]);

  it('merges parts into a report UI-2 accepts, labelled as a trial in progress', () => {
    const r = trialReport(input([a, b]));
    expect(() => parseReport(JSON.parse(JSON.stringify(r)))).not.toThrow();
    expect(r.trades.map((t) => t.group).sort()).toEqual(['S0', 'U1', 'U2']);
    expect(r.gates.find((g) => g.gate === 'G1')).toMatchObject({ state: 'not-run' });
    expect(r.gates.find((g) => g.gate === 'G1')!.checks[0]).toMatchObject({ label: 'Trial in progress', value: '2026-09-10 to 2026-09-15 (6 days)', limit: 'not a verdict' });
    expect(r.candidates).toBe(20);
    // The publish step refuses any report that names the sealed window.
    expect(/holdout/i.test(JSON.stringify(r))).toBe(false);
  });

  it('refuses every day of the sealed window, a trade reaching it, and a day outside the window', () => {
    for (const d of holdoutDaysOf(STUDY_CONFIG)) expect(() => trialReport(input([part([d], [])]))).toThrow(/sealed window/);
    const late = { ...trade('p:U2:z', '2026-09-21', 1n), closedAt: Date.parse('2026-09-22T00:00:00Z') };
    expect(() => trialReport(input([part(['2026-09-21'], [toPartTrade(late, 'U2')])]))).toThrow(/reaches the sealed window/);
    expect(() => assertPractice(STUDY_CONFIG, ['2026-07-25'])).toThrow(/not a decision day/);
    // Every practice day is accepted on its own.
    const practice = windowDays(STUDY_CONFIG).filter((d) => !holdoutDaysOf(STUDY_CONFIG).includes(d));
    for (const d of practice) expect(() => assertPractice(STUDY_CONFIG, [d])).not.toThrow();
  });

  it('refuses a day in two parts and a part from another commit', () => {
    expect(() => trialReport(input([a, part(['2026-09-12'], [])]))).toThrow(/two trial parts/);
    expect(() => trialReport(input([a, { ...b, commit: 'b'.repeat(40) }]))).toThrow(/ran on/);
  });

  it('shows a failed engine check as a failed G0', () => {
    const r = trialReport(input([a, { ...b, engine: { ...b.engine, leak: false } }]));
    expect(r.gates.find((g) => g.gate === 'G0')!.state).toBe('fail');
  });
});
