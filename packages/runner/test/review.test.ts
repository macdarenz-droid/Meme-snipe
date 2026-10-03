// PR #64 review: drills that pass without proving anything, the qualifying guard, lifecycle decisions.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STUB_ENTRY, type Health, type JournalLine } from '../src/contract.ts';
import { LocalControl } from '../src/control.ts';
import { checkJournal } from '../src/journal.ts';
import { item4 } from '../src/item4.ts';
import { makePlan } from '../src/plan.ts';
import { entryRule, rejections } from '../src/quota.ts';
import { buildReport, reportMarkdown, type DrillOutcome, type Report, type RunMeta, type Sample } from '../src/report.ts';
import { journalTimes, killReplyValid, runSegment } from '../src/runner.ts';
import { fullDrills, OPS_OK } from './fixtures.ts';

const root = join(import.meta.dirname, '..', '..', '..');
const freePort = (): Promise<number> =>
  new Promise((res) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
const quiet = (): void => {};
const stubRun = async (env: Record<string, string>, opts: Partial<Parameters<typeof runSegment>[0]>, newRun: NonNullable<Parameters<typeof runSegment>[0]['newRun']>) => {
  const dir = mkdtempSync(join(tmpdir(), 'run1d-review-'));
  const addr = `127.0.0.1:${await freePort()}`;
  const stateDir = join(dir, 'state');
  const evidenceDir = join(dir, 'ev');
  const control = new LocalControl({
    entry: STUB_ENTRY, cwd: root, logPath: join(evidenceDir, 'logs', 'w.log'), stateDir, restartDelayMs: 200,
    env: { PATH: process.env['PATH'] ?? '', ZEROED_STATE_DIR: stateDir, ZEROED_MODE: 'paper', ZEROED_RECORDER: 'on', ZEROED_SIMULATE: 'on', ZEROED_DRILLS: 'on', ZEROED_HEALTH_ADDR: addr, ZEROED_GIT_SHA: 'c0ffee', ZEROED_STUB_TICK_MS: '50', ZEROED_STUB_CYCLE_MS: '1000', ...env },
  });
  const res = await runSegment({ identity: { label: 'rehearsal', commit: 'c0ffee' }, healthAddr: addr, stateDir, evidenceDir, keepRecorded: 'copy', sampleMs: 100, recoverMs: 5000, log: quiet, control, segmentEnd: Number.POSITIVE_INFINITY, hostDrills: 'wipe', newRun, ...opts });
  return { r: res.report as Report, dir };
};

const meta: RunMeta = { runId: 'r', label: 'vps', commit: 'c0ffee', startedAt: 0, targetMs: 100, entry: 'e', plan: makePlan({ durationMs: 100, feeds: ['f'], restartWindowMs: 1, feedDropMs: 1 }) };
const samples: Sample[] = Array.from({ length: 11 }, (_, i) => ({ t: i * 10, up: true, ready: true, boot: 'a', git_sha: 'c0ffee', rss_bytes: 1, in_trade: false, entries_halted: false, recorder: true, simulation: true, stub: false, feeds: 'f', feeds_down: [] }));
const all = fullDrills(meta.plan);
const report = (drills: DrillOutcome[], ops = OPS_OK) => buildReport(meta, samples, 10, 100, checkJournal(''), drills, [], item4([], 'vps', false), ops);

describe('1. a cause counts only when a drill had something to keep', () => {
  it('fails drills_by_cause and says "not exercised" when every reboot kept nothing', () => {
    const r = report(all.map((d) => (d.cause === 'reboot' ? { ...d, keep: 0 } : d)));
    expect(r.checks['drills_by_cause']).toBe(false);
    expect(r.recovery_by_cause['reboot']).toMatchObject({ passed: 2, exercised: 0 });
    expect(reportMarkdown(r)).toMatch(/\| reboot \| 2 \| 2 \| 2 \| not exercised \|/);
    expect(report(all).checks['drills_by_cause']).toBe(true);
  });
});

describe('2. the reply at a kill is validated', () => {
  const h = (o: Record<string, unknown>): Health => ({ pending_exits: [], open_position: null, ...o }) as unknown as Health;
  it.each([
    ['no reply', null, false],
    ['pending exits missing', h({ pending_exits: undefined }), false],
    ['a pending exit that is not an id', h({ pending_exits: [''] }), false],
    ['an open position without a universe', h({ open_position: { trade: 't', universe: '' } }), false],
    ['a valid reply', h({ pending_exits: ['t'], open_position: { trade: 't', universe: 'U2' } }), true],
  ])('%s', (_, reply, ok) => expect(killReplyValid(reply as Health | null)).toBe(ok));
  it('an invalid reply at the kill fails the drill and makes its exposure unknown', async () => {
    const { r } = await stubRun({ ZEROED_STUB_BAD_PENDING: '1' }, {}, { runId: 'r', targetMs: 8000, entry: STUB_ENTRY, restarts: 3, causes: ['crash', 'crash', 'crash'], restartWindowMs: 1500, rpcDrops: 0 });
    const restarts = r.drills.filter((d) => d.kind === 'restart');
    expect(restarts.length).toBe(3);
    for (const d of restarts) {
      expect(d.pass).toBe(false);
      expect(d.notes).toContain('the reply at the kill was missing or invalid: what had to be kept is unknown');
      if (d.exposure) expect(d.exposure.status).toBe('unknown');
    }
  }, 40_000);
});

describe('3. a host loss needs a backup that holds something', () => {
  it('fails with "no backup to restore" when there is none', async () => {
    const { r } = await stubRun({}, {}, { runId: 'r', targetMs: 6000, entry: STUB_ENTRY, restarts: 3, causes: ['host-loss', 'crash', 'crash'], restartWindowMs: 1000, rpcDrops: 0 });
    const d = r.drills.find((x) => x.cause === 'host-loss')!;
    expect(d).toMatchObject({ pass: false, notes: ['no backup to restore'] });
  }, 40_000);
  it('backs up at the first trade of the window, restores it, and lists what opened after it', async () => {
    const { r } = await stubRun({}, { backupEveryMs: 3_600_000 }, { runId: 'r', targetMs: 8000, entry: STUB_ENTRY, restarts: 3, causes: ['host-loss', 'crash', 'crash'], restartWindowMs: 1500, rpcDrops: 0 });
    const d = r.drills.find((x) => x.cause === 'host-loss')!;
    expect(d.pass).toBe(true);
    expect(d.keep).toBeGreaterThan(0);
    expect(d.notes.join(' ')).toMatch(/a SQLite ledger copied that way can be torn/);
  }, 40_000);
});

describe('4. a skipped drill never counts as passed', () => {
  it('fails drills_by_cause and reads "not proven on this run"', () => {
    const r = report(all.map((d) => (d.cause === 'chain-rebuild' ? { ...d, skipped: true } : d)));
    expect(r.recovery_by_cause['chain-rebuild']).toMatchObject({ passed: 0, exercised: 0, skipped: 1 });
    expect(r.checks['drills_by_cause']).toBe(false);
    expect(reportMarkdown(r)).toContain('chain-rebuild (not proven on this run)');
  });
});

describe('5–7. reboot timing and units', () => {
  it('times a reboot from the new boot\'s journal lines', () => {
    const l = (kind: string, ts: string, extra: Record<string, unknown> = {}): JournalLine => ({ seq: 1, ts, boot: 'b', kind, ...extra }) as JournalLine;
    const kill = Date.parse('2026-10-04T00:00:00.000Z');
    expect(journalTimes([l('start', '2026-10-04T00:00:40.000Z'), l('reconcile', '2026-10-04T00:00:41.000Z', { ok: true }), l('exit_capable', '2026-10-04T00:00:43.500Z')], 'b', kill)).toEqual({ reconciled_ms: 41_000, exit_capable_ms: 43_500 });
    expect(journalTimes([l('reconcile', '2026-10-04T00:00:41.000Z', { ok: true })], 'b', kill)).toBeNull();
  });
  it('keeps pending-reboot.json until the drill is recorded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'run1d-reboot-'));
    const addr = `127.0.0.1:${await freePort()}`;
    const stateDir = join(dir, 'state');
    const evidenceDir = join(dir, 'ev');
    const control = () => new LocalControl({ entry: STUB_ENTRY, cwd: root, logPath: join(evidenceDir, 'w.log'), stateDir, restartDelayMs: 200, env: { PATH: process.env['PATH'] ?? '', ZEROED_STATE_DIR: stateDir, ZEROED_MODE: 'paper', ZEROED_RECORDER: 'on', ZEROED_SIMULATE: 'on', ZEROED_DRILLS: 'on', ZEROED_HEALTH_ADDR: addr, ZEROED_STUB_TICK_MS: '50', ZEROED_STUB_CYCLE_MS: '1000', ZEROED_STUB_EXIT_DELAY_MS: '60000' } });
    const common = { identity: { label: 'rehearsal' as const, commit: 'c0ffee' }, healthAddr: addr, stateDir, evidenceDir, keepRecorded: 'copy' as const, sampleMs: 100, recoverMs: 60_000, log: quiet, handover: false };
    await runSegment({ ...common, control: control(), newRun: { runId: 'r', targetMs: 120_000, entry: STUB_ENTRY, restarts: 3, causes: ['reboot', 'crash', 'crash'], rpcDrops: 0 }, segmentEnd: Date.now() + 800 });
    const plan = (JSON.parse(readFileSync(join(evidenceDir, 'run.json'), 'utf8')) as { plan: { id: string }[] }).plan;
    writeFileSync(join(evidenceDir, 'pending-reboot.json'), JSON.stringify({ kind: 'restart', drill: plan.find((d) => d.id === 'restart-1'), since: Date.now(), killedAt: Date.now(), prevBoot: 'gone', open: false, trades: [], tradesComplete: true, killValid: true, keep: 1, atKill: { pending_exits: [], positions: [] }, expect: { pending_exits: [], positions: [] } }));
    // The worker never becomes exit capable in this segment (60 s delay), so the drill is not recorded yet.
    await runSegment({ ...common, control: control(), segmentEnd: Date.now() + 1500 });
    expect(existsSync(join(evidenceDir, 'pending-reboot.json'))).toBe(true);
  }, 40_000);
  it('the tick timer resumes soon after boot, so a reboot drill costs little uptime', () => {
    expect(readFileSync(join(root, 'packages/runner/systemd/zeroed-dryrun-tick.timer'), 'utf8')).toMatch(/^OnBootSec=20s$/m);
  });
});

describe('qualifying guard: the registered entry rule, no paper edge, nothing changed between boots', () => {
  const start = (boot: string, extra: Record<string, unknown>): JournalLine => ({ seq: 1, ts: '2026-10-04T00:00:00.000Z', boot, kind: 'start', entry_rule: 'none', paper_edge_ppm: null, s0_salt: null, ...extra }) as JournalLine;
  it.each([
    ['the S0 shakedown', [start('a', { entry_rule: 'S0' })], /entry rule "S0", the registered rule is none/],
    ['a paper edge', [start('a', { paper_edge_ppm: '5000' })], /paper edge 5000 ppm/],
    ['a rule change between boots', [start('a', {}), start('b', { entry_rule: 'S0' })], /entry rule changed between boots/],
    ['a salt change between boots', [start('a', { s0_salt: 'x' }), start('b', { s0_salt: 'y' })], /salt changed between boots/],
    ['no entry rule at all', [start('a', { entry_rule: undefined })], /entry rule null/],
  ])('%s is NOT qualifying and fails the run', (_, lines, why) => {
    const g = entryRule(lines, 'none');
    expect(g.ok).toBe(false);
    expect(g.problems.join('; ')).toMatch(why);
    const r = report(all, { ...OPS_OK, entry_rule: g });
    expect(r.checks['entry_rule_registered']).toBe(false);
    expect(r.pass).toBe(false);
    expect(r.counts).toMatch(/^NOT qualifying: /);
  });
  it('the registered rule on every boot passes', () => {
    expect(entryRule([start('a', {}), start('b', {})], 'none')).toMatchObject({ ok: true, seen: ['none'] });
    expect(entryRule([start('a', { entry_rule: 'U2-v1' })], 'U2-v1').ok).toBe(true);
  });
});

describe('rejections count only reject and skip', () => {
  it('lifecycle decision lines are not rejections', () => {
    const d = (action: string, extra: Record<string, unknown> = {}): JournalLine => ({ seq: 1, ts: '2026-10-04T00:00:00.000Z', boot: 'b', kind: 'decision', action, ...extra }) as JournalLine;
    const r = rejections([d('enter'), d('prepare'), d('sign'), d('submit'), d('reconcile'), d('skip', { gate_reasons: [{ gate: 'H16', code: 'not-covered' }] }), d('reject', { gate_reasons: [{ gate: 'H9', code: 'top10' }] })]);
    expect(r).toMatchObject({ decisions: 7, rejected: 2, h16_not_covered: { count: 1 } });
    expect(Object.keys(r.by_reason).sort()).toEqual(['H16:not-covered', 'H9:top10']);
  });
});
