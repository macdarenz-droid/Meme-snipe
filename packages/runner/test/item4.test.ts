// Pre-funding item 4 block: TEST-2's bounds applied to the journal's simulation lines, and its report text.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JournalLine } from '../src/contract.ts';
import { item4 } from '../src/item4.ts';
import { checkJournal } from '../src/journal.ts';
import { makePlan } from '../src/plan.ts';
import { buildReport, reportMarkdown, type RunMeta } from '../src/report.ts';

let seq = 0;
const sim = (errE4: number | null, extra: Record<string, unknown> = {}): JournalLine => {
  seq += 1;
  return {
    seq, ts: '2026-10-03T00:00:00.000Z', boot: 'b', kind: 'simulation', trade: `t${seq}`, leg: 'entry',
    outcome: 'simulated', success: true, error: null, standIn: null, quotedOut: '1000000', simulatedOut: '1000000',
    amountErrorE4: errE4, quoteAgeSlots: '3', rentDeclared: '0', rentPaid: '0', balancesFrom: 'simulation', ...extra,
  };
};
const fail = (outcome: string): JournalLine => sim(null, { outcome, success: false, error: 'x' });
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
  it('never counts a rehearsal or the stub, whatever the numbers', () => {
    const lines = many(20, () => sim(0));
    expect(item4(lines, 'rehearsal', false)).toMatchObject({ pass: true, counts: false, note: 'Rehearsal: does not count for item 4.' });
    expect(item4(lines, 'vps', true)).toMatchObject({ pass: true, counts: false, note: 'Stub worker: does not count for item 4.' });
    expect(item4([], 'vps', false).pass).toBe(false);
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
    const r = buildReport(meta, [], 10, 100, checkJournal(''), [], [], item4(lines, 'vps', false));
    const md = reportMarkdown(r);
    const block = md.slice(md.indexOf('## Item 4'));
    expect(block).toBe(readFileSync(join(import.meta.dirname, 'golden', 'item4.md'), 'utf8'));
    expect(r.item4.counts).toBe(true);
  });
});
