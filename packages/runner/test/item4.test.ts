// Pre-funding item 4 block: TEST-2's bounds applied to the journal's simulation lines, and its report text.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JournalLine } from '../src/contract.ts';
import { item4, malformedReason } from '../src/item4.ts';
import { OPS_OK } from './fixtures.ts';
import { checkJournal } from '../src/journal.ts';
import { makePlan } from '../src/plan.ts';
import { buildReport, reportMarkdown, type RunMeta } from '../src/report.ts';

let seq = 0;
const sim = (errE4: number | null, extra: Record<string, unknown> = {}): JournalLine => {
  seq += 1;
  return {
    seq, ts: '2026-10-03T00:00:00.000Z', boot: 'b', kind: 'simulation', trade: `t${seq}`, leg: 'entry',
    // quotedOut 1,000,000: the amount error in E4 units is exactly the difference.
    outcome: 'simulated', success: true, error: null, standIn: null, quotedOut: '1000000', simulatedOut: String(1_000_000 + (errE4 ?? 0)),
    amountErrorE4: errE4, quoteAgeSlots: '3', rentDeclared: '0', rentPaid: '0', balancesFrom: 'simulation', ...extra,
  };
};
const fail = (outcome: string): JournalLine => sim(null, { outcome, success: false, error: 'x', simulatedOut: null });
const many = (n: number, f: () => JournalLine): JournalLine[] => Array.from({ length: n }, f);

describe('item 4 bounds', () => {
  it('passes 95% success, median 0.5 pts and every trade ≤ 2 pts exactly on the bounds', () => {
    const lines = [...many(18, () => sim(5000)), sim(20_000), fail('sim-error')];
    const r = item4(lines, 'vps', false);
    expect(r).toMatchObject({ trades: 20, successes: 19, pass: true, counts: true });
    expect(r.bounds.success).toEqual({ pass: true, percent: 95, min_percent: 95 });
    expect(r.bounds.median).toEqual({ pass: true, points: 0.5, max_points: 0.5 });
    expect(r.bounds.each).toEqual({ pass: true, max_seen_points: 2, max_points: 2 });
  });
  it('fails success under 95%', () => {
    const r = item4([...many(18, () => sim(1000)), fail('sim-error'), fail('rpc-error')], 'vps', false);
    expect(r.bounds.success.pass).toBe(false);
    expect(r.bounds.median.pass && r.bounds.each.pass).toBe(true);
    expect(r.pass).toBe(false);
  });
  it('fails a median over 0.5 pts', () => {
    const r = item4(many(20, () => sim(5001)), 'vps', false);
    expect(r.bounds.median.pass).toBe(false);
    expect(r.bounds.success.pass && r.bounds.each.pass).toBe(true);
    expect(r.pass).toBe(false);
  });
  it('fails one trade over 2 pts', () => {
    const r = item4([...many(19, () => sim(1000)), sim(20_001)], 'vps', false);
    expect(r.bounds.each.pass).toBe(false);
    expect(r.bounds.success.pass && r.bounds.median.pass).toBe(true);
    expect(r.worst).toEqual({ id: expect.stringMatching(/^t\d+\|entry$/), errorPoints: 2.0001 });
    expect(r.pass).toBe(false);
  });
  it('counts outcomes, closes omitted, stand-ins and the median quote age', () => {
    const standIn = { address: 'A', role: 'holder', tokenAccount: 'T', closeOmitted: true };
    const r = item4([sim(0, { standIn, quoteAgeSlots: '1' }), sim(0, { quoteAgeSlots: '5' }), fail('not-simulable')], 'vps', false);
    expect(r.outcomes).toEqual({ simulated: 2, 'not-simulable': 1 });
    expect(r).toMatchObject({ close_omitted: 1, stand_ins: 1, median_quote_age_slots: 3 });
  });
  it('never passes a rehearsal or the stub, whatever the numbers', () => {
    const lines = many(20, () => sim(0));
    expect(item4(lines, 'rehearsal', false)).toMatchObject({ bounds_pass: true, pass: false, counts: false, note: 'Rehearsal: does not count for item 4.' });
    expect(item4(lines, 'vps', true)).toMatchObject({ bounds_pass: true, pass: false, counts: false, note: 'Stub worker: does not count for item 4.' });
    expect(item4(lines, 'vps', false)).toMatchObject({ bounds_pass: true, pass: true, counts: true });
    expect(item4([], 'vps', false).pass).toBe(false);
  });
});

describe('bad simulation lines stay in the denominator as malformed', () => {
  it('19 good and 1 without an outcome fails the 95% bound', () => {
    const r = item4([...many(19, () => sim(0)), sim(0, { outcome: undefined })], 'vps', false);
    expect(r).toMatchObject({ trades: 20, successes: 19, outcomes: { simulated: 19, malformed: 1 } });
    expect(r.bounds.success.pass).toBe(true); // exactly 95%
    const r2 = item4([...many(18, () => sim(0)), sim(0, { outcome: 'bogus' }), sim(0, { outcome: undefined })], 'vps', false);
    expect(r2).toMatchObject({ trades: 20, successes: 18, pass: false });
    expect(r2.bounds.success.pass).toBe(false);    // The reviewer's case: 19 good and 6 bad is 76%, not 19 of 19.
    const r3 = item4([...many(19, () => sim(0)), ...many(3, () => sim(0, { outcome: 'bogus' })), ...many(3, () => sim(0, { amountErrorE4: -1 }))], 'vps', false);
    expect(r3).toMatchObject({ trades: 25, successes: 19, pass: false });
    expect(r3.bounds.success).toMatchObject({ pass: false, percent: 76 });
  });
  it.each([
    ['a negative amount error', { amountErrorE4: -999_999 }, 'amountErrorE4 is not a non-negative integer'],
    ['a fractional amount error', { amountErrorE4: 1.5e-9 }, 'amountErrorE4 is not a non-negative integer'],
    ['a string amount error', { amountErrorE4: '0' }, 'amountErrorE4 is not a non-negative integer'],
    ['an amount error that disagrees with the amounts', { amountErrorE4: 0, simulatedOut: '1030000' }, 'amountErrorE4 disagrees with the amounts'],
    ['missing amounts', { quotedOut: null }, 'simulated without positive quotedOut and simulatedOut'],
    ['a zero quote', { quotedOut: '0' }, 'simulated without positive quotedOut and simulatedOut'],
    ['a non-numeric quote age', { quoteAgeSlots: 'soon' }, 'quoteAgeSlots is not a decimal string'],
    ['a negative quote age', { quoteAgeSlots: '-5' }, 'quoteAgeSlots is not a decimal string'],
    ['a negative simulated amount', { simulatedOut: '-1000000' }, 'simulatedOut is not a decimal string'],
    ['a number where a bigint string belongs', { rentPaid: 5 }, 'rentPaid is not a decimal string'],
    ['success with a failing outcome', { outcome: 'sim-error' }, 'success disagrees with outcome'],
    ['a simulated outcome marked unsuccessful', { success: false }, 'success disagrees with outcome'],
  ])('scores %s as a failed, malformed trade', (_, over, why) => {
    const line = sim(0, over);
    expect(malformedReason(line)).toBe(why);
    const r = item4([line], 'vps', false);
    expect(r).toMatchObject({ trades: 1, successes: 0, outcomes: { malformed: 1 }, pass: false });
  });
  it('accepts a well-formed line, recomputing its amount error', () => {
    expect(malformedReason(sim(12_345))).toBeNull();
    expect(malformedReason(fail('rpc-error'))).toBeNull();
  });
});

describe('journal', () => {
  it('fails a simulation line with no outcome', () => {
    const base = [
      { seq: 1, ts: '2026-10-03T00:00:00.000Z', boot: 'b', kind: 'start' },
      { seq: 2, ts: '2026-10-03T00:00:01.000Z', boot: 'b', kind: 'reconcile', ok: true },
    ];
    const withOutcome = [...base, { seq: 3, ts: '2026-10-03T00:00:02.000Z', boot: 'b', kind: 'simulation', trade: 'x', leg: 'entry', outcome: 'sim-error' }];
    const without = [...base, { seq: 3, ts: '2026-10-03T00:00:02.000Z', boot: 'b', kind: 'simulation', trade: 'x', leg: 'entry' }];
    expect(checkJournal(withOutcome.map((l) => JSON.stringify(l)).join('\n')).complete).toBe(true);
    const r = checkJournal(without.map((l) => JSON.stringify(l)).join('\n'));
    expect(r.problems).toEqual(['seq 3: simulation without an outcome']);
  });
});

describe('report', () => {
  it('writes the item 4 block (golden)', () => {
    seq = 0;
    const standIn = { address: 'A', role: 'funded-wallet', tokenAccount: null, closeOmitted: false };
    const lines = [...many(17, () => sim(4000, { standIn })), sim(19_000), sim(6000), fail('policy-violation')];
    const meta: RunMeta = { runId: 'vps-golden', label: 'vps', commit: 'c0ffee', startedAt: 0, targetMs: 100, entry: 'systemd:zeroed-worker.service', plan: makePlan({ durationMs: 100, feeds: ['f'], restartWindowMs: 1, feedDropMs: 1 }) };
    const r = buildReport(meta, [], 10, 100, checkJournal(''), [], [], item4(lines, 'vps', false), OPS_OK);
    const md = reportMarkdown(r);
    const block = md.slice(md.indexOf('## Item 4'));
    expect(block).toBe(readFileSync(join(import.meta.dirname, 'golden', 'item4.md'), 'utf8'));
    expect(r.item4.counts).toBe(true);
  });
  it('prints H15\'s simulations and credits beside the quota table (WORKER-1e)', () => {
    const meta: RunMeta = { runId: 'r', label: 'rehearsal', commit: 'c0ffee', startedAt: 0, targetMs: 100, entry: 'e', plan: makePlan({ durationMs: 100, feeds: ['f'], restartWindowMs: 1, feedDropMs: 1 }) };
    const j = (seq: number, kind: string, more: Record<string, unknown> = {}) => JSON.stringify({ seq, ts: '2026-10-04T00:00:00.000Z', boot: 'b', kind, ...more });
    const journal = checkJournal([j(1, 'start'), j(2, 'h15_sim', { outcome: 'simulated', credits: 3 }), j(3, 'h15_sim', { outcome: 'not-run', credits: 0 })].join('\n'));
    const md = reportMarkdown(buildReport(meta, [], 10, 100, journal, [], [], item4([], 'rehearsal', false), OPS_OK));
    const quota = md.indexOf('## Quota and coverage');
    const line = md.indexOf('H15 simulations: 1 run of 2, 3 Helius credits');
    expect(quota).toBeGreaterThan(-1);
    expect(line).toBeGreaterThan(quota);
  });

  it('never prints a pass for a run that does not count', () => {
    const meta: RunMeta = { runId: 'r', label: 'rehearsal', commit: 'c0ffee', startedAt: 0, targetMs: 100, entry: 'e', plan: makePlan({ durationMs: 100, feeds: ['f'], restartWindowMs: 1, feedDropMs: 1 }) };
    const md = (lines: JournalLine[]) => reportMarkdown(buildReport(meta, [], 10, 100, checkJournal(''), [], [], item4(lines, 'rehearsal', false), OPS_OK));
    expect(md(many(20, () => sim(0)))).toContain('Item 4: **not counted** (bounds met: yes)');
    expect(md([fail('sim-error')])).toContain('Item 4: **not counted** (bounds met: no)');
    expect(md(many(20, () => sim(0)))).not.toContain('Item 4: **pass**');
  });
});

describe('item 4 mechanics diagnostics (TEST-2, supervisor ruling 90fac89)', () => {
  it('journal lines carry finalExit and simulatedSlot through to the mechanics counts', async () => {
    const { dryRunReport } = await import('../../worker/src/dryrun/report.ts');
    const { toRecord } = await import('../src/item4.ts');
    const standIn = (closeOmitted: boolean) => ({ address: 'x', role: 'holder', tokenAccount: 'y', closeOmitted, closeOmittedReason: closeOmitted ? 'the holder holds 3, the position is 1' : null });
    const lines = [
      sim(0, { leg: 'exit', finalExit: true, simulatedSlot: '9', standIn: standIn(false) }),
      sim(null, { leg: 'exit', finalExit: true, simulatedSlot: '9', standIn: standIn(false), outcome: 'sim-error', success: false, simulatedOut: null }),
      sim(0, { leg: 'exit', finalExit: true, simulatedSlot: '9', standIn: standIn(true) }),
      sim(0, { leg: 'exit', finalExit: false, simulatedSlot: '9', standIn: standIn(false) }),
      sim(0, { leg: 'entry', finalExit: true, simulatedSlot: '9' }),
    ];
    const m = dryRunReport(lines.map(toRecord)).mechanics;
    expect(m).toMatchObject({ finalExitSimulations: 3, withRealClose: 2, completeSellAndClose: 1, closeOmitted: 1 });
    expect(m.closeOmittedReasons[0]?.reason).toBe('the holder holds 3, the position is 1');
    expect(malformedReason(sim(0, { simulatedSlot: 9 }))).toBe('simulatedSlot is not a decimal string');
  });
});
