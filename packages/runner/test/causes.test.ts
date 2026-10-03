// RUN-1d: drills split by cause, recovery to "reconciled and able to exit", nothing a restart must keep is lost.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Health, JournalLine } from '../src/contract.ts';
import { LocalControl, snapshotState, SystemdControl } from '../src/control.ts';
import { checkJournal } from '../src/journal.ts';
import { item4 } from '../src/item4.ts';
import { DEFAULT_CAUSES, makePlan } from '../src/plan.ts';
import { buildReport, recoveryByCause, type DrillOutcome, type RunMeta, type Sample } from '../src/report.ts';
import { exitShed, offsiteNote, recoveredState } from '../src/runner.ts';
import { fullDrills, OPS_OK } from './fixtures.ts';

const rec = (boot: string, extra: Record<string, unknown>): JournalLine => ({ seq: 1, ts: '2026-10-04T00:00:00.000Z', boot, kind: 'recovered', ...extra }) as JournalLine;
const K = (pending_exits: string[], positions: { trade: string; universe: string }[]) => ({ pending_exits, positions });

describe('recovered state', () => {
  const atKill = K(['t1'], [{ trade: 't1', universe: 'U2' }]);
  it('passes when every pending exit and position comes back with its universe', () => {
    const r = recoveredState([rec('b', { source: 'state', pending_exits: ['t1'], positions: [{ trade: 't1', universe: 'U2' }] })], 'b', 'crash', atKill, atKill);
    expect(r).toMatchObject({ state_ok: true, universe_ok: true, missing: [] });
  });
  it.each([
    ['a lost pending exit', { pending_exits: [], positions: [{ trade: 't1', universe: 'U2' }] }, { state_ok: false, missing: ['exit t1'] }],
    ['a lost position', { pending_exits: ['t1'], positions: [] }, { state_ok: false, missing: ['position t1'] }],
    ['a changed universe (CFG-2)', { pending_exits: ['t1'], positions: [{ trade: 't1', universe: 'U1' }] }, { state_ok: true, universe_ok: false }],
    ['a position without a universe', { pending_exits: ['t1'], positions: [{ trade: 't1' }] }, { universe_ok: false }],
  ])('fails on %s', (_, line, want) => {
    expect(recoveredState([rec('b', { source: 'state', ...line })], 'b', 'reboot', atKill, atKill)).toMatchObject(want);
  });
  it('fails when the new boot wrote no recovered line', () => {
    expect(recoveredState([rec('a', { source: 'state' })], 'b', 'crash', atKill, atKill)).toMatchObject({ state_ok: false, universe_ok: false, notes: ['no recovered line after the restart'] });
  });
  it('host loss is held to the backup, not to the moment of the kill', () => {
    const backup = K([], [{ trade: 't0', universe: 'U2' }]);
    expect(recoveredState([rec('b', { source: 'state', pending_exits: [], positions: [{ trade: 't0', universe: 'U2' }] })], 'b', 'host-loss', backup, atKill).state_ok).toBe(true);
    expect(recoveredState([rec('b', { source: 'state', pending_exits: [], positions: [] })], 'b', 'host-loss', backup, atKill).missing).toEqual(['position t0']);
  });
  it('a chain rebuild must say so, and reports the paper positions it lost', () => {
    const r = recoveredState([rec('b', { source: 'chain', pending_exits: [], positions: [] })], 'b', 'chain-rebuild', null, atKill);
    expect(r).toMatchObject({ state_ok: true, lost: ['t1'], notes: ['1 paper position(s) lost: paper positions are not on chain'] });
    expect(recoveredState([rec('b', { source: 'state' })], 'b', 'chain-rebuild', null, atKill).state_ok).toBe(false);
  });
});

describe('plan', () => {
  it('plans every cause and RPC drops, none overlapping a restart window', () => {
    const D = 48 * 3_600_000;
    const plan = makePlan({ durationMs: D, feeds: ['a', 'b', 'c'] });
    const causes = plan.flatMap((d) => (d.kind === 'restart' ? [d.cause] : []));
    expect(causes).toEqual([...DEFAULT_CAUSES]);
    expect(new Set(causes)).toEqual(new Set(['crash', 'reboot', 'host-loss', 'chain-rebuild']));
    expect(causes.filter((c) => c === 'crash').length).toBeGreaterThanOrEqual(3);
    expect(plan.filter((d) => d.kind === 'rpc')).toHaveLength(2);
    for (const r of plan) {
      if (r.kind !== 'restart') continue;
      for (const f of plan) if (f.kind !== 'restart') expect(f.atMs < r.atMs || f.atMs > r.atMs + r.windowMs + 300_000).toBe(true);
    }
  });
});

const meta: RunMeta = { runId: 'r', label: 'vps', commit: 'c0ffee', startedAt: 0, targetMs: 100, entry: 'e', plan: makePlan({ durationMs: 100, feeds: ['f'], restartWindowMs: 1, feedDropMs: 1 }) };
const samples: Sample[] = Array.from({ length: 11 }, (_, i) => ({
  t: i * 10, up: true, ready: true, boot: 'a', git_sha: 'c0ffee', rss_bytes: 1, in_trade: false, entries_halted: false, recorder: true, simulation: true, stub: false, feeds: 'f', feeds_down: [],
}));
const report = (drills: DrillOutcome[]) => buildReport(meta, samples, 10, 100, checkJournal(''), drills, [], item4([], 'vps', false), OPS_OK);
const all = fullDrills(meta.plan);
const swap = (id: string, d: Partial<DrillOutcome>): DrillOutcome[] => all.map((x) => (x.id === id ? ({ ...x, ...d } as DrillOutcome) : x));
const idOf = (cause: string): string => all.find((d) => d.cause === cause)!.id;

describe('report by cause', () => {
  it('passes with every cause drilled and recovered', () => {
    const r = report(all);
    expect(Object.entries(r.checks).filter(([, v]) => !v)).toEqual([]);
    expect(Object.keys(r.recovery_by_cause)).toEqual(['crash', 'reboot', 'host-loss', 'chain-rebuild', 'rpc']);
    expect(r.recovery_by_cause['crash']).toMatchObject({ planned: 4, drills: 4, passed: 4, mid_trade: 4, exit_capable_ms: { median: 800, worst: 800 } });
  });
  it.each([
    ['a cause never drilled', all.filter((d) => d.cause !== 'reboot'), 'drills_by_cause'],
    ['no RPC drill passed', all.map((d) => (d.kind === 'rpc' ? { ...d, pass: false } : d)), 'drills_by_cause'],
    ['a restart that lost a pending exit', swap(idOf('reboot'), { state: { ...all[0]!.state!, state_ok: false, missing: ['exit t1'] } }), 'recovered_state'],
    ['a restart without a recovered line', swap(idOf('crash'), { state: undefined as never }), 'recovered_state'],
    ['a universe changed on restore', swap(idOf('host-loss'), { state: { ...all[0]!.state!, universe_ok: false } }), 'restored_universe_kept'],
    ['an unknown exposure (no reply at the window end)', swap(idOf('crash'), { exposure: { status: 'unknown', duration_ms: 900, reconciled_ms: 100, trades: ['t'], trades_complete: true, chain_trades: ['t'], mark_before: '1', mark_after: '1', worst_move_bps: 0, move_source: 'marks' } }), 'exposure_measured'],
  ])('fails on %s', (_, drills, check) => {
    const r = report(drills as DrillOutcome[]);
    expect(r.checks[check]).toBe(false);
    expect(r.pass).toBe(false);
  });
  it('a tabletop host loss counts as drilled and is labelled; it must still recover its state', () => {
    const vps = swap(idOf('host-loss'), { off_run: true });
    expect(report(vps).checks).toMatchObject({ drills_by_cause: true, recovered_state: true, restored_universe_kept: true });
    expect(recoveryByCause(meta, vps)['host-loss']).toMatchObject({ off_run: 1 });
    expect(report(swap(idOf('host-loss'), { off_run: true, state: undefined as never })).checks['recovered_state']).toBe(false);
  });
  it('a chain rebuild never asks for chain-rebuilt exposure of a lost paper position', () => {
    const ex = { status: 'measured' as const, duration_ms: 900, reconciled_ms: 100, trades: ['t'], trades_complete: true, chain_trades: [], mark_before: '1', mark_after: null, worst_move_bps: 0, move_source: 'marks' as const };
    expect(report(swap(idOf('chain-rebuild'), { exposure: ex })).checks['exposure_measured']).toBe(true);
    expect(report(swap(idOf('crash'), { exposure: ex })).checks['exposure_measured']).toBe(false);
  });
});

describe('helpers', () => {
  it('reads P0 and P1 shed, and states the off-site backup plainly', () => {
    expect(exitShed({ quota: [{ shed: [1, 2, 3, 4] }, { shed: [0, 1, 9, 9] }] } as unknown as Health)).toBe(4);
    expect(offsiteNote(false)).toMatch(/^off-site backup is off: a real host loss would lose the local snapshots too/);
    expect(offsiteNote(undefined)).toMatch(/fresh seed/);
  });
  it('a snapshot skips a file the worker renames away mid-copy instead of failing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'run1d-snap-'));
    const state = join(dir, 'state');
    mkdirSync(state);
    writeFileSync(join(state, 'stub-state.json'), 's');
    // A dangling symlink stands in for a file that vanishes between the listing and the copy.
    symlinkSync(join(state, 'gone.tmp'), join(state, 'stub-state.json.tmp'));
    expect(() => snapshotState(state, join(dir, 'backup'))).not.toThrow();
    expect(readdirSync(join(dir, 'backup'))).toContain('stub-state.json');
  });
  it('a wipe keeps the evidence (journal, recorder) and restores the backup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'run1d-'));
    const state = join(dir, 'state');
    mkdirSync(join(state, 'recorder'), { recursive: true });
    writeFileSync(join(state, 'journal.jsonl'), 'j\n');
    writeFileSync(join(state, 'recorder', 'r.jsonl'), 'r\n');
    writeFileSync(join(state, 'stub-state.json'), 'old');
    snapshotState(state, join(dir, 'backup'));
    expect(readdirSync(join(dir, 'backup'))).toEqual(['stub-state.json']);
    writeFileSync(join(state, 'stub-state.json'), 'new');
    writeFileSync(join(state, 'extra.db'), 'x');
    const c = new LocalControl({ entry: 'packages/runner/stub/worker.ts', cwd: dir, env: {}, logPath: join(dir, 'log'), stateDir: state, restartDelayMs: 60_000 });
    await c.wipe({ restoreFrom: join(dir, 'backup') });
    await c.stop();
    expect(readdirSync(state).sort()).toEqual(['journal.jsonl', 'recorder', 'stub-state.json']);
    expect(readFileSync(join(state, 'stub-state.json'), 'utf8')).toBe('old');
    const c2 = new LocalControl({ entry: 'x', cwd: dir, env: {}, logPath: join(dir, 'log2'), stateDir: state, restartDelayMs: 60_000 });
    await c2.wipe({});
    await c2.stop();
    expect(readdirSync(state).sort()).toEqual(['journal.jsonl', 'recorder']);
  });
  it('on the host, the tabletop decrypts the newest backup into its own dir, starts the reconcile-only unit, and empties the dir after', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'run1d-table-'));
    writeFileSync(join(dir, 'leftover'), 'x');
    const calls: string[] = [];
    const c = new SystemdControl('zeroed-worker.service', async (f, a) => void calls.push(`${f} ${a.join(' ')}`), dir);
    expect(await c.tabletop({ restore: true })).toEqual({ healthAddr: '127.0.0.1:8789', stateDir: dir });
    expect(readdirSync(dir)).toEqual([]);
    expect(calls[0]).toMatch(/^\/bin\/sh -c .*age -d -i \/etc\/zeroed\/age\/host\.key .*tar -x -C "\$1"/);
    expect(calls[0]!.endsWith(` sh ${dir}`)).toBe(true);
    expect(calls[1]).toBe(`chown -R zeroed-worker:zeroed-worker ${dir}`);
    expect(calls[2]).toBe('systemctl start zeroed-worker-tabletop.service');
    await c.tabletop({ restore: false });
    expect(calls.slice(3)).toEqual([`chown -R zeroed-worker:zeroed-worker ${dir}`, 'systemctl start zeroed-worker-tabletop.service']);
    writeFileSync(join(dir, 'journal.jsonl'), 'j');
    await c.endTabletop();
    expect(calls.at(-1)).toBe('systemctl stop zeroed-worker-tabletop.service');
    expect(readdirSync(dir)).toEqual([]);
    await expect(c.wipe()).rejects.toThrow(/never run on the qualifying host/);
  });
});
