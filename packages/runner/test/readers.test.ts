// WORKER-GROW G4c: the runner never holds the worker's journal whole. The end-of-run report streams it and keeps only
// the lines it reads line by line, a subsequence that gives the same report; the restart drills keep only the lines of
// the two boots and four kinds they read.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JournalLine } from '../src/contract.ts';
import { item4 } from '../src/item4.ts';
import { coverageGaps, rejections } from '../src/quota.ts';
import type { DrillOutcome } from '../src/report.ts';
import { closedSince, exitLines, journalTimes, openedSince, recoveredState, reportJournal, restartLines, withChainMoves } from '../src/runner.ts';

const T0 = Date.parse('2026-10-04T00:00:00.000Z');
const iso = (s: number): string => new Date(T0 + s * 1000).toISOString();

/** Four boots: decisions (the bulk), gaps opened and closed or left open, simulations, exposure rebuilds, other lines. */
const journal = (decisions: number): JournalLine[] => {
  const out: JournalLine[] = [];
  let seq = 0;
  let t = 0;
  const add = (boot: string, kind: string, extra: Record<string, unknown> = {}): void => void out.push({ seq: ++seq, ts: iso(t++), boot, kind, ...extra } as JournalLine);
  for (const [b, boot] of ['a', 'b', 'c', 'd'].entries()) {
    add(boot, 'start');
    add(boot, 'reconcile', { ok: true });
    add(boot, 'coverage_gap', { stream: 'creates', gap_id: `g${b}`, from_ts: iso(t), to_ts: null });
    for (let i = 0; i < decisions; i++) {
      add(boot, 'decision', { action: i % 3 === 0 ? 'enter' : 'reject', gate_reasons: [{ gate: 'H16', code: i % 2 === 0 ? 'not-covered' : 'stale' }] });
      if (i === 5) add(boot, 'simulation', { ok: i % 2 === 0, trade: `t${b}`, simulatedSlot: '9' });
      if (i === 7) add(boot, 'exposure', { trade: `t${b}`, worst_move_bps: 40 + b, from_ts: iso(t) });
      if (i === 9 && b !== 3) add(boot, 'coverage_gap', { stream: 'creates', gap_id: `g${b}`, from_ts: iso(3), to_ts: iso(t) });
    }
    add(boot, 'heartbeat');
  }
  return out;
};

describe('the end-of-run report reads a subsequence of the journal (G4c)', () => {
  it('item 4, coverage, chain moves and rejections are the same as from the whole journal', () => {
    const all = journal(40);
    const kept = reportJournal(all);
    expect(kept.length).toBeLessThan(all.length / 5);
    // In journal order, as read.
    expect(kept.map((l) => l.seq)).toEqual(kept.map((l) => l.seq).sort((x, y) => x - y));
    expect(item4(kept, 'vps', false)).toEqual(item4(all, 'vps', false));
    expect(item4(all, 'vps', false)).not.toEqual(item4([], 'vps', false));
    expect(coverageGaps(kept, T0 + 10_000_000)).toEqual(coverageGaps(all, T0 + 10_000_000));
    expect(coverageGaps(all, T0 + 10_000_000).streams['creates']).toMatchObject({ open: 1 });
    const drill: DrillOutcome = {
      id: 'restart-1', kind: 'restart', plannedAt: 0, at: T0, pass: true, midTrade: true, recoveredMs: 1, notes: [],
      exposure: { duration_ms: 10_000_000, reconciled_ms: 100, trades: ['t0', 't2'], trades_complete: true, chain_trades: [], mark_before: '1', mark_after: '1', worst_move_bps: 10, move_source: 'marks' },
    };
    expect(withChainMoves([drill], kept)).toEqual(withChainMoves([drill], all));
    expect(withChainMoves([drill], kept)[0]!.exposure).toMatchObject({ worst_move_bps: 42, chain_trades: ['t0', 't2'] });
    // rejections takes the stream itself.
    expect(rejections(all.values())).toEqual(rejections(all));
  });

  it('keeps a bounded number of lines however many decisions the journal holds', () => {
    expect(reportJournal(journal(20_000)).length).toBe(reportJournal(journal(40)).length);
  });

  it('a boot with one line keeps it once', () => {
    const one = [{ seq: 1, ts: iso(0), boot: 'x', kind: 'coverage_gap', stream: 'creates', gap_id: 'g', from_ts: iso(0), to_ts: null } as JournalLine];
    expect(reportJournal(one)).toEqual(one);
  });
});

describe('the restart drills read a slice of the journal (G4c)', () => {
  /** The killed boot opens and closes trades around the kill's seq; the next boot reconciles, recovers, is exit capable. */
  const drillJournal = (): JournalLine[] => {
    const out: JournalLine[] = [];
    let seq = 0;
    const add = (boot: string, kind: string, extra: Record<string, unknown> = {}): void => void out.push({ seq: ++seq, ts: iso(seq), boot, kind, ...extra } as JournalLine);
    add('other', 'entry', { trade: 'x0', universe: 'U1' });
    add('old', 'start');
    add('old', 'entry', { trade: 't1', universe: 'U1' });
    for (let i = 0; i < 200; i++) add('old', 'decision', { action: 'reject' });
    add('old', 'entry', { trade: 't2', universe: 'U2' }); // seq above the kill's
    add('old', 'exit', { trade: 't1', position: 'closed' });
    add('old', 'entry', { trade: 't3' });
    add('old', 'exit', { trade: 't3', position: 'partial' });
    add('other', 'exit', { trade: 'x0', position: 'closed' });
    add('new', 'start');
    add('new', 'reconcile', { ok: false });
    add('new', 'reconcile', { ok: true });
    add('new', 'recovered', { source: 'state', pending_exits: ['t2'], positions: [{ trade: 't2', universe: 'U2' }] });
    add('new', 'exit_capable');
    for (let i = 0; i < 200; i++) add('new', 'decision', { action: 'reject' });
    return out;
  };

  it('kept trades, recovery times and the recovered state are the same as from the whole journal', () => {
    const all = drillJournal();
    const killSeq = 100;
    const lines = restartLines(all, 'new', 'old');
    expect(lines.length).toBeLessThan(20);
    expect(closedSince(lines, 'old', killSeq)).toEqual(closedSince(all, 'old', killSeq));
    expect(openedSince(lines, 'old', killSeq)).toEqual(openedSince(all, 'old', killSeq));
    expect(openedSince(all, 'old', killSeq)).toEqual([{ trade: 't2', universe: 'U2' }, { trade: 't3', universe: 'unknown' }]);
    expect(closedSince(all, 'old', killSeq)).toEqual(['t1']);
    expect(journalTimes(lines, 'new', T0)).toEqual(journalTimes(all, 'new', T0));
    expect(journalTimes(all, 'new', T0)).not.toBeNull();
    const kept = { pending_exits: ['t2'], positions: [{ trade: 't2', universe: 'U2' }] };
    expect(recoveredState(lines, 'new', 'crash', kept, kept)).toEqual(recoveredState(all, 'new', 'crash', kept, kept));
    expect(recoveredState(all, 'new', 'crash', kept, kept).source).toBe('state');
  });

  it('the RPC drill\'s finished exits are the same from the boot\'s exit lines', () => {
    const all = drillJournal();
    expect(closedSince(exitLines(all, 'old'), 'old', 100)).toEqual(closedSince(all, 'old', 100));
    expect(exitLines(all, 'old').map((l) => l.trade)).toEqual(['t1', 't3']);
  });
});

describe('no whole-journal read in the runner (guard)', () => {
  it('the runner reads the journal only through the streamed records', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'runner.ts'), 'utf8');
    expect(src).not.toMatch(/readLines<JournalLine>/);
    expect(src).not.toMatch(/\bjournalLines\(/);
  });
});
