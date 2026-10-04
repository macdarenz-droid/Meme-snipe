import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { openLedgerReader } from '../../core/src/ledger/index.ts';
import { replayLedgerFile } from '../../core/src/ledger/replay/index.ts';
import { attemptAlpha, authoriseHoldout, endAttempt, holdoutConfigId, type HoldoutPlan, openSealedHoldout, readHoldoutStore, recordHoldoutG1, type RegistryVcs, registerAttempt, researchDays, runAndSealHoldout, runHoldout, setHoldoutPlan, writeHoldoutStore } from '../src/holdout.ts';
import { gitRegistryVcs } from '../src/registry-git.ts';
import { holdoutReady, registerHoldout } from '../../core/src/stats/index.ts';
import { leakTest, replayHashes, shiftTest } from '../src/proofs.ts';
import { buildReport } from '../src/report.ts';
import { runBacktest, type RunOptions } from '../src/run.ts';
import { burstSweep, ladderCongestion } from '../src/stress.ts';
import { tradesOf } from '../src/trades.ts';
import { key, SOL_USD, syntheticRows, T0 } from './synthetic.ts';

const rows = syntheticRows({ mints: 4, slots: 2.5 * 3600 * 6 });
// The synthetic day stands in for the holdout window in holdout tests (research runs here never read the CLI's guard).
const RESEARCH = { ...RESEARCH_CONFIG, holdout: { ...RESEARCH_CONFIG.holdout, fromDay: '2026-09-20', entryCutoffDay: '2026-09-21', tailEndDay: '2026-09-21' } };
const opts = (over: Partial<RunOptions> = {}): RunOptions => ({
  rows: () => rows[Symbol.iterator](), series: [SOL_USD], seed: 'test-seed', scenario: 'base', policy: TRIAL_POLICY, fills: FILL_CONFIG, research: RESEARCH,
  windowEnd: T0 + 6 * 3_600_000, ...over,
});
// Whole runs through the engine take seconds each.
vi.setConfig({ testTimeout: 180_000 });
const dir = mkdtempSync(join(tmpdir(), 'bt-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const reasons = (r: ReturnType<typeof runBacktest>) => r.records.flatMap((x) => (x.type === 'decision' ? [x.reasons] : []));

describe('S0 through the real engine', () => {
  const r = runBacktest(opts({ ledgerPath: join(dir, 'base.sqlite') }));

  test('no crash, no illegal state, nothing unreconciled, mirror equals the engine book', () => {
    expect(r.stats.crash).toBeNull();
    expect(r.stats.illegalStates).toBe(0);
    expect(r.stats.unreconciledIntents).toBe(0);
    expect(r.stats.mirrorMatches).toBe(true);
  });

  test('candidates come from discoveries, and entries fill and exit on the time stop', () => {
    const c = reasons(r).filter((x) => x[0] === 'candidate');
    expect(c.length).toBeGreaterThanOrEqual(2);
    const entries = r.attempts.filter((a) => a.purpose === 'entry');
    expect(entries.length).toBeGreaterThan(0);
    const { trades } = tradesOf(r, FILL_CONFIG);
    expect(trades.length).toBeGreaterThan(0);
    for (const t of trades) {
      expect(t.exitReason).toBe('time-stop');
      expect(t.closedAt - t.openedAt).toBeGreaterThanOrEqual(TRIAL_POLICY.exits.universes.U2.tMaxMs);
      // A round trip on an unmoving-ish pool loses at least the fees.
      expect(t.net).toBe(t.exitSol - t.entrySol - t.networkBase - t.priority - t.tip - t.rentPaid + t.rentReturned);
    }
  });

  test('later real swaps see our trades: the traded pool ends shifted, an untraded pool does not', () => {
    const traded = new Set(r.attempts.filter((a) => a.outcome === 'filled').map((a) => r.discoveries.get(a.mint)!.pool));
    expect(traded.size).toBeGreaterThan(0);
    for (const [mint, d] of r.discoveries) {
      const delta = r.poolDelta(d.pool);
      if (traded.has(d.pool)) expect(delta.vault, mint).not.toBe(0n);
      else expect(delta).toEqual({ base: 0n, vault: 0n, virtual: 0n });
    }
  });

  test('the ledger holds every intent, attempt, fill and position, and none is unresolved', () => {
    const L = openLedgerReader(join(dir, 'base.sqlite'));
    try {
      expect(L.purpose()).toBe('backtest');
      expect(L.unresolvedIntents()).toEqual([]);
      const entryIds = Object.values(r.book.intents).map((i) => i.intent.id);
      for (const id of entryIds) {
        expect(L.intent(id)?.status).toBe(r.book.intents[id]!.status);
        expect(L.attempts(id).length).toBe(r.book.intents[id]!.attempts.length);
        expect(L.fills(id).length).toBe(r.book.intents[id]!.fills.length);
      }
      expect(L.positions().length).toBe(Object.keys(r.book.positions).length);
    } finally {
      L.close();
    }
  });

  test('the ledger replay check (pre-funding item 2) passes on backtest ledgers, failures and blocked exits included', () => {
    expect(replayLedgerFile(join(dir, 'base.sqlite'))).toMatchObject({ ok: true, purpose: 'backtest' });
    const lossy = opts({ seed: 'replay-check', ledgerPath: join(dir, 'lossy.sqlite'), policy: { ...TRIAL_POLICY, exits: { ...TRIAL_POLICY.exits, ladder: { ...TRIAL_POLICY.exits.ladder, maxAttempts: 2 } } },
      fills: { ...FILL_CONFIG, scenarios: { ...FILL_CONFIG.scenarios, base: { ...FILL_CONFIG.scenarios.base, landPpm: { pumpswap: 450_000n, 'pump-curve': 0n }, dropPpm: 300_000n } } } });
    const r = runBacktest(lossy);
    expect(r.stats.illegalStates).toBe(0);
    expect(r.attempts.some((a) => a.outcome !== 'filled')).toBe(true);
    const report = replayLedgerFile(join(dir, 'lossy.sqlite'));
    expect(report.ok ? 'ok' : report.failure).toBe('ok');
    expect(report.counts.intents).toBe(Object.keys(r.book.intents).length);
  });

  test('a failed attempt pays base and priority fees and is recorded', () => {
    const s = runBacktest(opts({ seed: 'fail-seed', fills: { ...FILL_CONFIG, scenarios: { ...FILL_CONFIG.scenarios, base: { ...FILL_CONFIG.scenarios.base, landPpm: { pumpswap: 300_000n, 'pump-curve': 0n } } } } }));
    expect(s.stats.illegalStates).toBe(0);
    expect(s.stats.unreconciledIntents).toBe(0);
    const failed = s.attempts.filter((a) => a.outcome === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    for (const a of failed) expect(a.fee).toBe(5_000n + a.priorityFee);
    // Failed exits climb the ladder: a later attempt pays a higher priority fee.
    const exits = s.attempts.filter((a) => a.purpose === 'exit');
    const byIntent = new Map<string, typeof exits>();
    for (const a of exits) byIntent.set(a.intentId, [...(byIntent.get(a.intentId) ?? []), a]);
    const climbed = [...byIntent.values()].some((list) => list.length > 1 && list[1]!.priorityFee > list[0]!.priorityFee);
    expect(climbed).toBe(true);
  });

  test('dropped attempts expire after their last valid block height and cost nothing', () => {
    const s = runBacktest(opts({ seed: 'drop-seed', fills: { ...FILL_CONFIG, scenarios: { ...FILL_CONFIG.scenarios, base: { ...FILL_CONFIG.scenarios.base, landPpm: { pumpswap: 500_000n, 'pump-curve': 0n }, dropPpm: 1_000_000n } } } }));
    expect(s.stats.illegalStates).toBe(0);
    expect(s.stats.unreconciledIntents).toBe(0);
    const dropped = s.attempts.filter((a) => a.outcome === 'dropped');
    expect(dropped.length).toBeGreaterThan(0);
    for (const a of dropped) expect(a.fee).toBe(0n);
    const expired = s.records.filter((x) => x.type === 'world' && x.event.type === 'intent' && x.event.event.type === 'status' && x.event.event.result === 'not_found' && x.event.event.searchedHistory);
    expect(expired.length).toBeGreaterThan(0);
  });

  test('blocked exits: an unquotable pool blocks the exit and the position is valued at the end', () => {
    // A tiny ladder so a single failing rung blocks. The seed gives failed exits under the fills-2 draws.
    const s = runBacktest(opts({ seed: 'b3', policy: { ...TRIAL_POLICY, exits: { ...TRIAL_POLICY.exits, ladder: { ...TRIAL_POLICY.exits.ladder, maxAttempts: 1 } } },
      fills: { ...FILL_CONFIG, scenarios: { ...FILL_CONFIG.scenarios, base: { ...FILL_CONFIG.scenarios.base, landPpm: { pumpswap: 600_000n, 'pump-curve': 0n } } } }, s0: { blockedRetries: 0 } }));
    expect(s.stats.illegalStates).toBe(0);
    expect(s.stats.unreconciledIntents).toBe(0);
    const blocked = Object.values(s.book.positions).filter((p) => p.status === 'exit_blocked');
    expect(blocked.length).toBeGreaterThan(0);
    const t = tradesOf(s, FILL_CONFIG).trades.filter((x) => x.exitReason === 'blocked');
    expect(t.length).toBe(blocked.length);
    for (const x of t) expect(x.rentReturned).toBe(0n);
  });

  test('scenarios differ as §11 says: conservative pays more than base on the same seed', () => {
    const c = runBacktest(opts({ scenario: 'conservative' }));
    expect(c.stats.illegalStates).toBe(0);
    const net = (x: ReturnType<typeof runBacktest>) => tradesOf(x, FILL_CONFIG).trades.reduce((t, y) => t + y.net, 0n);
    const o = runBacktest(opts({ scenario: 'optimistic' }));
    expect(net(c)).toBeLessThan(net(o));
  });
});

describe('proofs on a dataset run', () => {
  test('10 runs give identical decision-log hashes; another seed differs', () => {
    const h = replayHashes(opts(), 10);
    expect(new Set(h).size).toBe(1);
    expect(runBacktest(opts({ seed: 'other' })).logHash).not.toBe(h[0]);
  });

  test('leak test: a planted future pool state and account state stay invisible until their time', () => {
    const r = runBacktest(opts());
    const fill = r.attempts.find((a) => a.purpose === 'entry' && a.outcome === 'filled')!;
    const pool = r.discoveries.get(fill.mint)!.pool;
    const token = 'FUTURE-ONLY-MARKER-7f3a';
    const slot = fill.landedSlot! + 200n;
    const at = { slot, txIndex: 5, ixIndex: 0, receivedAt: fill.landedAt! + 80_000 };
    const view = { pool, mint: fill.mint, quoteMint: token, baseReserve: 1n, quoteVault: 1n, virtualQuoteReserves: 0n,
      fees: { split: { lp: 20, protocol: 5, creator: 95 }, buybackFeeBps: 0, instruction: 'v1' }, baseSupply: 1n, side: 'buy', userQuote: 1n, baseAmount: 1n };
    const report = leakTest(opts(), {
      token, at,
      rows: [{ ...(rows.find((x) => x.kind === 'amm' && x.slot > slot) as Extract<typeof rows[number], { kind: 'amm' }>), signature: `plant-${token}`, pool: token, txIdx: 9_000, slot }],
      events: [
        { kind: 'market', id: `plant:pool`, moment: at, key: `pool:${pool}`, value: view },
        { kind: 'market', id: `plant:acct`, moment: { ...at, ixIndex: 1 }, key: `life:${fill.mint}`, value: { event: 'AccountState', fields: { marker: token } } },
      ],
    }, { labels: [{ mint: fill.mint, y_tb: 1, note: token }] });
    expect(report.violations).toEqual([]);
  });

  test('leak test catches a strategy that peeks at the future', () => {
    const token = 'PEEK-MARKER';
    const at = { slot: rows[rows.length - 1]!.slot - 10n, txIndex: 0, ixIndex: 0, receivedAt: T0 + 5 * 3_600_000 };
    // A leaky strategy: reads the planted key at a moment far ahead (the store refuses), then cheats with a
    // captured reference to the planted events.
    const planted = [{ kind: 'market' as const, id: 'plant:x', moment: at, key: 'x', value: token }];
    const report = leakTest(opts({ strategy: () => ({ onMarket: () => [{ action: null, reasons: [String(planted[0]!.value)] }] }) }), { token, at, events: planted }, { token });
    expect(report.ok).toBe(false);
  });

  test('+1-slot shift test', () => {
    const report = shiftTest(opts(), rows);
    expect(report.violations).toEqual([]);
  });
});

describe('holdout mode', () => {
  test('exposes only the sealed file hash and per-universe candidate and entry counts', () => {
    const path = join(dir, 'holdout.sqlite');
    const h = runHoldout({ ...opts(), ledgerPath: path });
    expect(Object.keys(h).sort()).toEqual(['counts', 'ledgerHash']);
    expect(h.ledgerHash).toMatch(/^[0-9a-f]{64}$/);
    for (const c of Object.values(h.counts)) expect(Object.keys(c).sort()).toEqual(['candidates', 'entries', 'entryDays']);
    expect(h.counts['U2']!.entries).toBeGreaterThan(0);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(() => runHoldout({ ...opts(), ledgerPath: path })).toThrow(/run once/);
    // Sealed: read-only.
    expect(statSync(path).mode & 0o777).toBe(0o400);
  });

  const authority = (name: string) => ({ registryPath: join(dir, `${name}.registry.json`), codeCommit: 'test-commit', datasetId: 'sha256:test' });
  const planOf = (o: RunOptions, familySize: number): HoldoutPlan => ({
    fromDay: o.research.holdout.fromDay, entryCutoffDay: o.research.holdout.entryCutoffDay, tailEndDay: o.research.holdout.tailEndDay, familySize,
    tieSalt: 'test-ties', alpha: { first: 0.04, laterBase: 0.01 }, decoderBoundaries: [], procedure: ['test procedure'], details: {},
  });
  // STATS-1c: registering freezes each holdout's size requirement and n_power seed. The synthetic run has a few trades,
  // so the tests that open a holdout freeze 1.
  const REQ = { requiredTrades: 1, requiredDays: 1, nPower: 1, nPowerSeed: 1 };
  // That needs the test-only requirement floor (production keeps the owner's 300 trades on 10 days).
  const TEST_FLOOR = { minTrades: 1, minDays: 1 };
  /** Sets the plan if the registry has none, then registers S0's attempt for one U2 holdout. */
  const register = (a: Parameters<typeof authoriseHoldout>[0], holdoutId: string, o: RunOptions = opts(), attempt = 1, familySize = 1, requirement = REQ) => {
    a.vcs?.check();
    if (!existsSync(a.registryPath) || readHoldoutStore(a.registryPath).plan === null) setHoldoutPlan(a, planOf(o, familySize), o.research, TEST_FLOOR);
    return authoriseHoldout(a, { attempt, holdouts: [{ holdoutId, universe: 'U2', requirement }] }, o);
  };
  const window = { fromDay: '2026-09-20', toDay: '2026-09-20' };
  // The synthetic tail ends 2026-09-21: the STATS-1c registry opens a seal only from then on.
  const TAIL_END = Date.parse('2026-09-21T00:00:00Z');

  test('seals in the STATS-1 registry; the size check reads the counts alone', () => {
    const a = authority('seal');
    register(a, 'h-u2', opts());
    const out = runAndSealHoldout({ ...opts(), ledgerPath: join(dir, 'holdout2.sqlite') }, { ...a, byUniverse: { U2: 'h-u2' }, window });
    const entry = readHoldoutStore(a.registryPath).registry.entries[0]!;
    expect(entry.seal).toBe('sealed');
    expect(entry.configId).toBe(holdoutConfigId(opts(), a));
    expect(entry.ledgerHash).toBe(out.ledgerHash);
    expect(entry.counts).toEqual(out.counts['U2']);
    // A few synthetic trades are far from 300: not ready, so the seal stays closed.
    expect(holdoutReady(entry, 300, 20)).toBe(false);
  });

  test('a window runs once, only as authorised: re-runs, other configurations and unregistered windows are refused and logged', () => {
    const a = authority('once');
    const run = (file: string, o = opts()) => runAndSealHoldout({ ...o, ledgerPath: join(dir, file) }, { ...a, byUniverse: { U2: 'h-once' }, window });
    expect(() => run('unregistered.sqlite')).toThrow(/not registered/);
    expect(existsSync(join(dir, 'unregistered.sqlite'))).toBe(false);
    register(a, 'h-once', opts());
    expect(() => runAndSealHoldout({ ...opts(), ledgerPath: join(dir, 'other-id.sqlite') }, { ...a, byUniverse: { U2: 'h-other' }, window })).toThrow(/not registered/);
    expect(() => run('other-config.sqlite', opts({ scenario: 'optimistic' }))).toThrow(/configuration/);
    expect(() => runAndSealHoldout({ ...opts(), ledgerPath: join(dir, 'other-window.sqlite') }, { ...a, byUniverse: { U2: 'h-once' }, window: { fromDay: '2026-09-20', toDay: '2026-09-21' } })).toThrow(/window/);
    run('first.sqlite');
    // Same window, a new file name: refused before anything runs.
    expect(() => run('second.sqlite')).toThrow(/already run/);
    expect(existsSync(join(dir, 'second.sqlite'))).toBe(false);
    const store = readHoldoutStore(a.registryPath);
    expect(store.runs.map((r) => r.outcome)).toEqual(['refused', 'refused', 'refused', 'started', 'sealed', 'refused']);
  });

  test('a failed run is persisted and burns the window; an interrupted one cannot be rerun', () => {
    const a = authority('fail');
    register(a, 'h-fail', opts());
    const crashing = opts({ strategy: () => ({ onMarket: () => { throw new Error('boom'); } }) });
    expect(() => runAndSealHoldout({ ...crashing, ledgerPath: join(dir, 'fail.sqlite') }, { ...a, byUniverse: { U2: 'h-fail' }, window })).toThrow(/crashed/);
    const store = readHoldoutStore(a.registryPath);
    expect(store.registry.entries[0]).toMatchObject({ burned: true, burnReason: 'run-failed' });
    expect(store.runs.map((r) => r.outcome)).toEqual(['started', 'failed']);
    expect(() => runAndSealHoldout({ ...opts(), ledgerPath: join(dir, 'fail2.sqlite') }, { ...a, byUniverse: { U2: 'h-fail' }, window })).toThrow(/burned/);

    // A run killed mid-way leaves only its start record: the window is spent.
    const b = authority('killed');
    register(b, 'h-killed', opts());
    const killed = readHoldoutStore(b.registryPath);
    writeHoldoutStore(b.registryPath, { ...killed, runs: [{ holdoutId: 'h-killed', outcome: 'started', configId: holdoutConfigId(opts(), b), ledgerPath: 'x', at: '2026-10-03T00:00:00Z', reason: '' }] });
    expect(() => runAndSealHoldout({ ...opts(), ledgerPath: join(dir, 'killed.sqlite') }, { ...b, byUniverse: { U2: 'h-killed' }, window })).toThrow(/already run/);
    expect(readHoldoutStore(b.registryPath).registry.entries[0]).toMatchObject({ burned: true, burnReason: 'run-failed' });
  });

  test('a window started under one id cannot be registered or run again under another id or universe (H2)', () => {
    const a = authority('overlap');
    register(a, 'h-first', opts(), 1, 2);
    expect(() => authoriseHoldout(a, { attempt: 2, holdouts: [{ holdoutId: 'h-u1', universe: 'U1', requirement: REQ }] }, opts())).toThrow(/produces U2/);
    runAndSealHoldout({ ...opts(), ledgerPath: join(dir, 'overlap1.sqlite') }, { ...a, byUniverse: { U2: 'h-first' }, window });
    // Another id on the same window: refused (attempt 2 waits for attempt 1 to be scored, then may not overlap it; see the
    // attempt k ≥ 2 test).
    expect(() => register(a, 'h-second', opts(), 2, 2)).toThrow(/not scored yet/);
  });

  test('the STATS-1c registry owns α, the tail, the frozen requirement and the earliest open', () => {
    const a = authority('core');
    const o = opts();
    const st = register(a, 'h-core');
    expect(st.registry.entries[0]).toMatchObject({ attempt: 1, alpha: 0.04, requirement: REQ, fromDay: '2026-09-20', toDay: '2026-09-20', tailEnd: '2026-09-21' });
    expect(st.registry.rule).toEqual({ windowDays: 28, tailDays: 0, ...TEST_FLOOR });
    // Without the test floor, the owner's 300 trades on 10 days hold: a smaller requirement is refused, nothing written.
    const p = authority('floor');
    setHoldoutPlan(p, planOf(o, 1), o.research);
    expect(() => authoriseHoldout(p, { attempt: 1, holdouts: [{ holdoutId: 'h-floor', universe: 'U2', requirement: REQ }] }, o)).toThrow(/below the floor of 300 on 10/);
    expect(readHoldoutStore(p.registryPath).registry.entries).toEqual([]);
    const configId = holdoutConfigId(o, a);
    const sealed = runAndSealHoldout({ ...o, ledgerPath: join(dir, 'core.sqlite') }, { ...a, byUniverse: { U2: 'h-core' }, window });
    recordHoldoutG1(a, { holdoutId: 'h-core', configId, passed: true, evaluatedOn: 'practice' });
    const open = (nowMs: number, requiredTrades = 1) => openSealedHoldout(a, 'h-core', { configId, ledgerHash: sealed.ledgerHash, requiredTrades, minDays: 1, nowMs });
    // Before the tail has matured: refused, nothing burned.
    expect(() => open(TAIL_END - 1)).toThrow(/stays sealed until 2026-09-21/);
    // A requirement other than the frozen one: refused, nothing burned.
    expect(() => open(TAIL_END, 2)).toThrow(/froze 1 trades/);
    expect(readHoldoutStore(a.registryPath).registry.entries[0]).toMatchObject({ seal: 'sealed', burned: false });
    // 'short' reads the frozen requirement (1 trade on 1 day) from the registry: this holdout is ready, so not short.
    expect(() => endAttempt(a, 1, 'short', new Date(TAIL_END))).toThrow(/is ready/);
    expect(open(TAIL_END).registry.entries[0]).toMatchObject({ seal: 'opened', burnReason: 'scored' });
    // A holdout registered without a frozen requirement (an older registry) is refused before anything runs.
    const l = authority('legacy');
    setHoldoutPlan(l, planOf(o, 1), o.research, TEST_FLOOR);
    const store = readHoldoutStore(l.registryPath);
    const reg = registerHoldout(store.registry, { holdoutId: 'h-legacy', universe: 'U2', configId: holdoutConfigId(o, l), fromDay: '2026-09-20', toDay: '2026-09-20', registeredOnDay: '2026-09-01' });
    writeHoldoutStore(l.registryPath, { ...store, registry: reg, attempts: [{ index: 1, alpha: 0.04, window: { fromDay: '2026-09-20', entryCutoffDay: '2026-09-21', tailEndDay: '2026-09-21' }, holdoutIds: ['h-legacy'], configIds: { 'h-legacy': holdoutConfigId(o, l) }, registeredAt: 'x', started: null, ended: null }] });
    expect(() => runAndSealHoldout({ ...o, ledgerPath: join(dir, 'legacy.sqlite') }, { ...l, byUniverse: { U2: 'h-legacy' }, window })).toThrow(/no frozen size requirement/);
    expect(existsSync(join(dir, 'legacy.sqlite'))).toBe(false);
  });

  test('entries stop at the cutoff while the run keeps observing (final holdout form)', () => {
    const a = authority('cutoff');
    // STATS-1c: a window has at least one entry day, so the only entry day (09-19) comes before the data and the data's
    // day (09-20) is the observation tail.
    const empty = opts({ research: { ...RESEARCH, holdout: { ...RESEARCH.holdout, entryCutoffDay: '2026-09-20' } } });
    expect(() => register(authority('cutoff-empty'), 'h-empty', empty)).toThrow(/in order/);
    const early = opts({ research: { ...RESEARCH, holdout: { ...RESEARCH.holdout, fromDay: '2026-09-19', entryCutoffDay: '2026-09-20' } } });
    register(a, 'h-cut', early);
    const out = runAndSealHoldout({ ...early, ledgerPath: join(dir, 'cutoff.sqlite') }, { ...a, byUniverse: { U2: 'h-cut' }, window: { fromDay: '2026-09-19', toDay: '2026-09-20' } });
    expect(out.counts['U2']?.entries ?? 0).toBe(0);
    expect(out.ledgerHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('the registry must be under version control: a dirty one is refused before anything runs; every write is committed (H3)', () => {
    const a = authority('vcs');
    const commits: string[] = [];
    let dirty = false;
    const vcs = { check: () => { if (dirty) throw new Error('registry is not tracked or has changes'); }, commit: (m: string) => { commits.push(m); } };
    register({ ...a, vcs }, 'h-vcs', opts());
    dirty = true;
    expect(() => runAndSealHoldout({ ...opts(), ledgerPath: join(dir, 'vcs.sqlite') }, { ...a, vcs, byUniverse: { U2: 'h-vcs' }, window })).toThrow(/not tracked/);
    expect(existsSync(join(dir, 'vcs.sqlite'))).toBe(false);
    dirty = false;
    runAndSealHoldout({ ...opts(), ledgerPath: join(dir, 'vcs.sqlite') }, { ...a, vcs, byUniverse: { U2: 'h-vcs' }, window });
    expect(commits.map((m) => m.split(':')[1]!.trim().split(' ')[0])).toEqual(['set', 'registered', 'started', 'sealed']);
  });

  test('the configured tail lets every entry before the cutoff finish', () => {
    const h = RESEARCH_CONFIG.holdout;
    const tail = Date.parse(`${h.tailEndDay}T00:00:00Z`) - Date.parse(`${h.entryCutoffDay}T00:00:00Z`);
    const s0 = RESEARCH_CONFIG.s0;
    // The longest hold any universe may have (the cap), so the tail holds for every registered universe.
    expect(tail).toBeGreaterThanOrEqual(TRIAL_POLICY.exits.tMaxCapMs + s0.blockedRetries * s0.blockedRetryMs + s0.endMarginMs);
    expect([h.fromDay, h.entryCutoffDay]).toEqual(['2026-09-22', '2026-10-20']);
  });

  test('the registry on a remote branch: a fresh clone sees the started window, a failed push or a race blocks the run, a symlink is refused (D2, D3)', () => {
    const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    const top = mkdtempSync(join(tmpdir(), 'reg-'));
    const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const origin = join(top, 'origin.git');
    sh(top, 'init', '-q', '--bare', origin);
    // Each clone's origin reads as the project's GitHub URL, rewritten (insteadOf) to the local bare repository.
    const GH = 'https://github.com/macdarenz-droid/Meme-snipe';
    const clone = (name: string) => {
      const d = join(top, name);
      sh(top, 'clone', '-q', origin, d);
      sh(d, 'config', `url.${origin}.insteadOf`, GH);
      sh(d, 'remote', 'set-url', 'origin', GH);
      sh(d, 'commit', '-q', '--allow-empty', '-m', 'root');
      return d;
    };
    const vcsAt = (root: string) => gitRegistryVcs({ root, relPath: 'research/holdout/registry.json', remote: 'origin', branch: 'holdout-registry', fileName: 'registry.json', repo: 'macdarenz-droid/Meme-snipe' });
    const at = (root: string) => ({ registryPath: join(root, 'research/holdout/registry.json'), codeCommit: 'c', datasetId: 'd', vcs: vcsAt(root) });
    try {
      const a = clone('a');
      const A = at(a);
      A.vcs.check();
      mkdirSync(join(a, 'research/holdout'), { recursive: true });
      register(A, 'h-git', opts());
      expect(sh(top, '--git-dir', origin, 'show', 'holdout-registry:registry.json')).toContain('h-git');
      // A push failure (the remote goes away after the check) blocks the run and leaves the local copy as the remote has it.
      const before = readFileSync(A.registryPath, 'utf8');
      const losing: RegistryVcs = { check: () => { A.vcs.check(); renameSync(origin, `${origin}.away`); }, commit: (m) => A.vcs.commit(m) };
      expect(() => runAndSealHoldout({ ...opts(), ledgerPath: join(top, 'nopush.sqlite') }, { ...A, vcs: losing, byUniverse: { U2: 'h-git' }, window })).toThrow(/push|origin|repository/i);
      expect(existsSync(join(top, 'nopush.sqlite'))).toBe(false);
      expect(readFileSync(A.registryPath, 'utf8')).toBe(before);
      renameSync(`${origin}.away`, origin);
      // A race: another clone pushes after A's check, so A's start record cannot be pushed and nothing runs.
      const b = clone('b');
      const B = at(b);
      B.vcs.check();
      const race = () => {
        const st = readHoldoutStore(B.registryPath);
        writeHoldoutStore(B.registryPath, { ...st, runs: [...st.runs, { holdoutId: 'h-x', outcome: 'refused', configId: 'x', ledgerPath: 'x', at: 'x', reason: 'race' }] });
        B.vcs.commit('race');
      };
      const racing: RegistryVcs = { check: () => { A.vcs.check(); race(); }, commit: (m) => A.vcs.commit(m) };
      expect(() => runAndSealHoldout({ ...opts(), ledgerPath: join(top, 'race.sqlite') }, { ...A, vcs: racing, byUniverse: { U2: 'h-git' }, window })).toThrow(/rejected|fetch first|non-fast-forward|failed to push/);
      expect(existsSync(join(top, 'race.sqlite'))).toBe(false);
      // A runs once it is in step; a fresh clone then sees the started window and refuses to run it again.
      rmSync(A.registryPath);
      A.vcs.check();
      runAndSealHoldout({ ...opts(), ledgerPath: join(top, 'run.sqlite') }, { ...A, byUniverse: { U2: 'h-git' }, window });
      const c = clone('c');
      const C = at(c);
      C.vcs.check();
      expect(readHoldoutStore(C.registryPath).runs.map((r) => r.outcome)).toContain('sealed');
      expect(() => runAndSealHoldout({ ...opts(), ledgerPath: join(top, 'again.sqlite') }, { ...C, byUniverse: { U2: 'h-git' }, window })).toThrow(/already run/);
      // A local copy that differs from the remote is refused.
      writeFileSync(C.registryPath, `${readFileSync(C.registryPath, 'utf8')} `);
      expect(() => C.vcs.check()).toThrow(/differs/);
      // The remote must be the project's repository.
      sh(c, 'remote', 'set-url', 'origin', 'https://github.com/someone/else');
      expect(() => C.vcs.check()).toThrow(/must be github.com\/macdarenz-droid\/Meme-snipe/);
      sh(c, 'remote', 'set-url', 'origin', GH);
      // A deleted registry branch, with a local record, is refused rather than read as empty.
      writeFileSync(C.registryPath, sh(top, '--git-dir', origin, 'show', 'holdout-registry:registry.json'));
      sh(top, '--git-dir', origin, 'update-ref', '-d', 'refs/heads/holdout-registry');
      expect(() => C.vcs.check()).toThrow(/missing \(deleted or never pushed\)/);
      // An emptied branch (an empty registry file, or none) is refused too.
      const g = (input: string, ...args: string[]) => execFileSync('git', ['--git-dir', origin, ...args], { input, encoding: 'utf8' }).trim();
      const emptyBlob = g('', 'hash-object', '-w', '--stdin');
      g('', 'update-ref', 'refs/heads/holdout-registry', g('', 'commit-tree', g(`100644 blob ${emptyBlob}\tregistry.json\n`, 'mktree'), '-m', 'emptied'));
      expect(() => C.vcs.check()).toThrow(/empty registry.json/);
      g('', 'update-ref', 'refs/heads/holdout-registry', g('', 'commit-tree', g('', 'mktree'), '-m', 'no file'));
      expect(() => C.vcs.check()).toThrow(/has no registry.json/);
      // A symlinked registry path is refused.
      const d = clone('d');
      mkdirSync(join(d, 'research/holdout'), { recursive: true });
      symlinkSync(C.registryPath, join(d, 'research/holdout/registry.json'));
      expect(() => at(d).vcs.check()).toThrow(/symbolic link/);
      expect(() => readHoldoutStore(join(d, 'research/holdout/registry.json'))).toThrow(/symbolic link/);
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  });

  test('one registry with typed sections: plan fixed once, attempts in order, G1 before opening; every write one commit (BT-1d)', () => {
    const commits: string[] = [];
    const a = { ...authority('typed'), vcs: { check: () => {}, commit: (m: string) => { commits.push(m); } } };
    const o = opts();
    expect(() => registerAttempt(a, { index: 1, entries: [{ holdoutId: 'x', universe: 'U2', configId: 'c', requirement: REQ }] })).toThrow(/plan/);
    expect(() => setHoldoutPlan(a, { ...planOf(o, 2), entryCutoffDay: '2026-10-19' }, o.research)).toThrow(/research config/);
    setHoldoutPlan(a, planOf(o, 2), o.research, TEST_FLOOR);
    setHoldoutPlan(a, planOf(o, 2), o.research, TEST_FLOOR);
    expect(() => setHoldoutPlan(a, { ...planOf(o, 2), tieSalt: 'other' }, o.research)).toThrow(/fixed once set/);
    // A skipped index is refused, recorded, and burns what it names (nothing registered yet, so nothing to burn).
    expect(() => registerAttempt(a, { index: 2, entries: [{ holdoutId: 'h-a', universe: 'U2', configId: 'c', requirement: REQ }] })).toThrow(/next is 1/);
    const s1 = authoriseHoldout(a, { attempt: 1, holdouts: [{ holdoutId: 'h-a', universe: 'U2', requirement: REQ }] }, o);
    expect(s1.attempts).toMatchObject([{ index: 1, alpha: 0.04, holdoutIds: ['h-a'], started: null, ended: null }]);
    expect(s1.registry.entries[0]).toMatchObject({ holdoutId: 'h-a', fromDay: o.research.holdout.fromDay });
    // A repeated index is refused and burns the earlier attempt's holdouts.
    expect(() => registerAttempt(a, { index: 1, entries: [{ holdoutId: 'h-b', universe: 'U1', configId: 'c', requirement: REQ }] })).toThrow(/next is 2/);
    expect(readHoldoutStore(a.registryPath).registry.entries.find((e) => e.holdoutId === 'h-a')).toMatchObject({ burned: true, burnReason: 'reconfigured' });
    // Attempt k ≥ 2 spends 0.01 / 2^(k-1).
    expect([1, 2, 3].map((k) => attemptAlpha(planOf(o, 2), k))).toEqual([0.04, 0.005, 0.0025]);
    // Each change was one commit (the plan, attempt 1, the burn of the repeat); a refusal that changed nothing and
    // setting the same plan again wrote nothing.
    expect(commits.map((m) => m.split(':')[0])).toEqual(['Holdout plan', 'Holdout attempt 1', 'Holdout attempt 1']);
  });

  test('a sealed holdout opens only on a latest G1 pass for its registered configuration; the attempt records start and end', () => {
    const a = authority('open');
    register(a, 'h-open');
    const sealed = runAndSealHoldout({ ...opts(), ledgerPath: join(dir, 'open.sqlite') }, { ...a, byUniverse: { U2: 'h-open' }, window });
    const st = readHoldoutStore(a.registryPath);
    expect(st.attempts[0]!.started).not.toBeNull();
    expect(st.attempts[0]!.ended).toMatchObject({ outcome: 'sealed' });
    const configId = st.registry.entries[0]!.configId;
    const open = () => openSealedHoldout(a, 'h-open', { configId, ledgerHash: sealed.ledgerHash, requiredTrades: 1, minDays: 1, nowMs: TAIL_END });
    expect(open).toThrow(/no G1 result/);
    recordHoldoutG1(a, { holdoutId: 'h-open', configId, passed: false, evaluatedOn: 'practice' });
    expect(open).toThrow(/did not pass/);
    recordHoldoutG1(a, { holdoutId: 'h-open', configId: 'another', passed: true, evaluatedOn: 'practice' });
    expect(open).toThrow(/latest G1 is for another/);
    recordHoldoutG1(a, { holdoutId: 'h-open', configId, passed: true, evaluatedOn: 'practice' });
    const opened = open();
    expect(opened.registry.entries[0]).toMatchObject({ seal: 'opened', burned: true, burnReason: 'scored' });
    expect(opened.g1.map((g) => g.passed)).toEqual([false, true, true]);
    expect(open).toThrow(/burned/);
  });

  test('attempt k ≥ 2: after every earlier holdout is scored, from the first whole UTC day after registration, 28 entry days and the plan\'s tail', () => {
    const a = authority('second');
    register(a, 'first');
    const o = opts();
    const configId = holdoutConfigId(o, a);
    const second = (now: string, fromDay?: string) => registerAttempt(a, { index: 2, entries: [{ holdoutId: 'second', universe: 'U2', configId, requirement: REQ }], ...(fromDay === undefined ? {} : { fromDay }) }, new Date(now));
    expect(() => second('2026-09-25T10:00:00Z')).toThrow(/not scored yet \(first\)/);
    const sealed = runAndSealHoldout({ ...o, ledgerPath: join(dir, 'second-1.sqlite') }, { ...a, byUniverse: { U2: 'first' }, window });
    recordHoldoutG1(a, { holdoutId: 'first', configId, passed: true, evaluatedOn: 'practice' });
    openSealedHoldout(a, 'first', { configId, ledgerHash: sealed.ledgerHash, requiredTrades: 1, minDays: 1, nowMs: TAIL_END });
    // Registered the day before attempt 1's window: the next whole day overlaps it.
    expect(() => second('2026-09-19T12:00:00Z')).toThrow(/overlaps attempt 1/);
    // A requested start before the first whole day after registration.
    expect(() => second('2026-09-25T10:00:00Z', '2026-09-25')).toThrow(/cannot start before 2026-09-26/);
    // Nor later (the STATS-1c rule: exactly the first whole UTC day after registration).
    expect(() => second('2026-09-25T10:00:00Z', '2026-09-27')).toThrow(/or after it/);
    const st = second('2026-09-25T10:00:00Z');
    // The synthetic plan has no tail (cutoff = tail end), so neither has attempt 2.
    expect(st.attempts[1]).toMatchObject({ index: 2, alpha: 0.005, window: { fromDay: '2026-09-26', entryCutoffDay: '2026-10-24', tailEndDay: '2026-10-24' } });
    expect(st.registry.entries.find((e) => e.holdoutId === 'second')).toMatchObject({ fromDay: '2026-09-26', toDay: '2026-10-23' });
  });

  test('α is pinned to the ruled budget: attempt 1 at 0.04, attempt k ≥ 2 at 0.01 / 2^(k-1) (R4)', () => {
    const a = authority('alpha');
    const o = opts();
    for (const alpha of [{ first: 0.05, laterBase: 0.01 }, { first: 0.04, laterBase: 0.02 }]) {
      expect(() => setHoldoutPlan(a, { ...planOf(o, 1), alpha }, o.research)).toThrow(/ruled α budget/);
    }
    expect(existsSync(a.registryPath)).toBe(false);
  });

  test('an attempt that fails G1 or ends short is spent after its tail, so the next attempt can register (R3)', () => {
    for (const why of ['g1-failed', 'short'] as const) {
      const a = authority(`spent-${why}`);
      // The frozen requirement (300 trades on 10 days) is the one 'short' is judged against.
      register(a, 'one', opts(), 1, 1, { requiredTrades: 300, requiredDays: 10, nPower: 300, nPowerSeed: 1 });
      const o = opts();
      const configId = holdoutConfigId(o, a);
      runAndSealHoldout({ ...o, ledgerPath: join(dir, `spent-${why}.sqlite`) }, { ...a, byUniverse: { U2: 'one' }, window });
      if (why === 'g1-failed') recordHoldoutG1(a, { holdoutId: 'one', configId, passed: false, evaluatedOn: 'practice' });
      const two = () => registerAttempt(a, { index: 2, entries: [{ holdoutId: 'two', universe: 'U2', configId, requirement: REQ }] }, new Date('2026-09-25T10:00:00Z'));
      expect(two).toThrow(/not scored yet/);
      // Not before the attempt's tail has ended (the synthetic tail ends 2026-09-21).
      expect(() => endAttempt(a, 1, why, new Date('2026-09-20T12:00:00Z'))).toThrow(/tail/);
      const st = endAttempt(a, 1, why, new Date('2026-09-22T00:00:00Z'));
      expect(st.registry.entries.find((e) => e.holdoutId === 'one')).toMatchObject({ burned: true, burnReason: 'spent' });
      expect(st.attempts[0]!.ended).toMatchObject({ outcome: 'spent', why });
      expect(two().attempts.map((x) => x.index)).toEqual([1, 2]);
    }
  });

  test('endAttempt never skips a mandatory opening: a sealed, ready attempt with a G1 pass is refused for any reason (E1)', () => {
    const a = authority('mandatory');
    register(a, 'ready');
    const o = opts();
    const configId = holdoutConfigId(o, a);
    runAndSealHoldout({ ...o, ledgerPath: join(dir, 'mandatory.sqlite') }, { ...a, byUniverse: { U2: 'ready' }, window });
    recordHoldoutG1(a, { holdoutId: 'ready', configId, passed: true, evaluatedOn: 'practice' });
    const after = new Date('2026-09-22T00:00:00Z');
    // Ready against its frozen requirement (1 trade on 1 day), so not short.
    expect(() => endAttempt(a, 1, 'short', after)).toThrow(/is ready/);
    expect(() => endAttempt(a, 1, 'g1-failed', after)).toThrow(/G1 passed/);
    expect(() => endAttempt(a, 1, 'never-run', after)).toThrow(/was run/);
    expect(() => endAttempt(a, 1, 'tired' as never, after)).toThrow(/reason/);
    expect(readHoldoutStore(a.registryPath).registry.entries[0]).toMatchObject({ burned: false, seal: 'sealed' });
    // An attempt registered and never run may end as never-run.
    const b = authority('never-run');
    register(b, 'idle');
    expect(endAttempt(b, 1, 'never-run', after).registry.entries[0]).toMatchObject({ burned: true, burnReason: 'spent' });
  });

  test('a run must feed every holdout of its attempt', () => {
    const a = authority('whole');
    const o = opts();
    setHoldoutPlan(a, planOf(o, 2), o.research, TEST_FLOOR);
    registerAttempt(a, { index: 1, entries: [{ holdoutId: 'w-u2', universe: 'U2', configId: holdoutConfigId(o, a), requirement: REQ }, { holdoutId: 'w-u1', universe: 'U1', configId: 'u1-config', requirement: REQ }] });
    expect(() => runAndSealHoldout({ ...o, ledgerPath: join(dir, 'whole.sqlite') }, { ...a, byUniverse: { U2: 'w-u2' }, window })).toThrow(/every holdout of its registered attempt/);
    expect(existsSync(join(dir, 'whole.sqlite'))).toBe(false);
  });

  test('research days never include the reserved holdout start or a registered window (H1)', () => {
    const r = { ...RESEARCH_CONFIG };
    expect(researchDays(['2026-09-20', '2026-09-21'], r, null, true)).toEqual(['2026-09-20', '2026-09-21']);
    expect(() => researchDays(['2026-09-21', '2026-09-22'], r, null, true)).toThrow(/reserved holdout start/);
    expect(researchDays(['2026-09-21', '2026-09-22', '2026-09-30'], r, null, false)).toEqual(['2026-09-21']);
    expect(() => researchDays(['2026-09-25'], r, null, false)).toThrow(/no practice days/);
    const a = authority('days');
    const store = register(a, 'h-days', opts());
    expect(() => researchDays(['2026-09-19', '2026-09-20'], { ...r, holdout: { ...r.holdout, fromDay: '2026-12-01' } }, store, true)).toThrow(/inside holdout h-days/);
  });
});

describe('report', () => {
  test('a valid version-1 report with exact money and no holdout field', () => {
    const r = runBacktest(opts());
    const { trades, stray } = tradesOf(r, FILL_CONFIG);
    const rep = buildReport({
      runId: 'test', generatedAt: '2026-10-03T00:00:00.000Z', codeCommit: 'a'.repeat(40), policy: TRIAL_POLICY, fills: FILL_CONFIG,
      dataset: { id: 'synthetic', from: T0, to: T0 + 6 * 3_600_000 },
      engine: { replays: 1, identicalReplays: true, crashes: 0, illegalStates: 0, unreconciledIntents: 0 }, solUsd: SOL_USD,
      candidates: 4, entries: trades.length, groups: [{ group: 'S0', trades, stray }], gates: [],
    });
    expect(rep.schemaVersion).toBe(1);
    expect(rep.policyHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const usd = /^-?\d+(\.\d{1,6})?$/;
    for (const t of rep.trades) {
      expect(t.mode).toBe('backtest');
      for (const v of [t.netUsd, t.sizeUsd, t.grossUsd, ...Object.values(t.costs)]) expect(v).toMatch(usd);
    }
    expect(rep.results[0]!.trades).toBe(trades.length);
    expect(JSON.stringify(rep)).not.toMatch(/holdout/i);
  });
});

describe('many candidates at once', () => {
  test('two entries due at the same moment never produce an illegal second proposal', () => {
    const crowd = syntheticRows({ mints: 30, slots: 2.5 * 3600 * 8, swapEvery: 60, seed: 'crowd' });
    const r = runBacktest(opts({ rows: () => crowd[Symbol.iterator](), windowEnd: T0 + 8 * 3_600_000 }));
    expect(r.stats.crash).toBeNull();
    expect(r.stats.illegalStates).toBe(0);
    expect(r.stats.unreconciledIntents).toBe(0);
    expect(r.attempts.filter((a) => a.purpose === 'entry').length).toBeGreaterThan(1);
  });
});

describe('signing heights and skipped slots', () => {
  const base = syntheticRows({ mints: 12, slots: 2.5 * 3600 * 7, swapEvery: 37, seed: 'heights' });
  // The reviewer's repro: another mint's CreateEvent every 7 slots, so S0 often acts on lifecycle events.
  const crowd = base.flatMap((r) => (r.kind === 'block' && r.slot % 7n === 0n
    ? [{ kind: 'event' as const, slot: r.slot, blockTime: r.blockTime, txIdx: 900, evIdx: 0, signature: `create-${r.slot}`, program: 'pump', event: 'CreateEvent',
      fields: { mint: key(`other-${r.slot}`), symbol: 'OTHER' } }, r]
    : [r]));
  // The premise of the next test: no drops and every landing well under the 150-block blockhash life.
  const calm = (f: typeof FILL_CONFIG): typeof FILL_CONFIG => ({ ...f, scenarios: Object.fromEntries(Object.entries(f.scenarios).map(([k, s]) => [k, {
    ...s, dropPpm: 0n, landingTail: { ppm: 0n, slots: [1] }, congestion: { ...s.congestion, network: { ...s.congestion.network, enterPpm: 0n, maxEnterPpm: 0n }, providerFailPpm: 0n },
  }])) as unknown as typeof f.scenarios });
  test('with no dropped attempts and landing under 150 slots, nothing expires, whatever the seed and scenario', () => {
    let betweenHeartbeats = 0;
    let onLifecycle = 0;
    for (const scenario of ['base', 'conservative', 'optimistic'] as const) {
      for (const seed of ['h1', 'h2', 'h3']) {
        const r = runBacktest(opts({ rows: () => crowd[Symbol.iterator](), seed, scenario, fills: calm(FILL_CONFIG), windowEnd: T0 + 7 * 3_600_000 }));
        expect(r.stats.illegalStates).toBe(0);
        expect(r.attempts.filter((a) => a.outcome === 'expired' || a.outcome === 'dropped')).toEqual([]);
        // Entries and time stops decided between heartbeats, on pool swaps and on other mints' lifecycle events.
        const acted = r.records.filter((x) => x.type === 'decision' && (x.reasons[0] === 'time stop' || x.reasons[0] === 'enter'));
        betweenHeartbeats += acted.filter((x) => x.type === 'decision' && x.eventId.startsWith('s:')).length;
        onLifecycle += acted.filter((x) => x.type === 'decision' && x.eventId.startsWith('e:')).length;
        expect(r.records.some((x) => x.type === 'decision' && x.reasons[0] === 'not signing')).toBe(false);
      }
    }
    expect(betweenHeartbeats).toBeGreaterThan(5);
    expect(onLifecycle).toBeGreaterThan(5);
  });

  test('a landing drawn for a skipped slot lands at the next block', () => {
    // Every 3rd slot has no block (skipped by its leader); swaps only happen in slots with blocks.
    const skipped = new Set(crowd.filter((x) => x.kind === 'block' && x.slot % 3n === 0n).map((x) => x.slot));
    const holes = crowd.filter((x) => !skipped.has(x.slot));
    const r = runBacktest(opts({ rows: () => holes[Symbol.iterator](), seed: 'holes', windowEnd: T0 + 7 * 3_600_000 }));
    expect(r.stats.illegalStates).toBe(0);
    expect(r.stats.unreconciledIntents).toBe(0);
    const landed = r.attempts.filter((a) => a.landedSlot !== null);
    expect(landed.length).toBeGreaterThan(0);
    for (const a of landed) expect(skipped.has(a.landedSlot!)).toBe(false);
  });
});

describe('observation delay (BT-1c item 3 and delay ruling)', () => {
  const byId = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (r.kind !== 'block') byId.set(`${r.signature}:${r.evIdx}`, r);
  const blockAt = new Map<bigint, number>();
  for (const r of rows) if (r.kind === 'block') blockAt.set(r.slot, r.blockTime * 1000);
  type Seen = { id: string; key: string; slot: bigint; receivedAt: number; observed?: { slot: bigint; at: number } | undefined };
  const watch = (o: RunOptions) => {
    const seen: Seen[] = [];
    const r = runBacktest({ ...o, strategy: () => ({ onMarket: (e) => {
      if (e.kind === 'market') seen.push({ id: e.id, key: e.key, slot: e.moment.slot, receivedAt: e.moment.receivedAt, observed: (e.value as { observed?: Seen['observed'] }).observed });
      return [];
    } }) });
    return { r, seen };
  };
  const firstBlockFrom = (slot: bigint): bigint => {
    for (let s = slot; ; s++) if (blockAt.has(s)) return s;
  };

  test('each swap or lifecycle event arrives at the end of the first block after event→processed, processed→confirmed and provider→worker delays, at that block\'s real time', () => {
    for (const scenario of ['conservative', 'base', 'optimistic'] as const) {
      const profile = FILL_CONFIG.delays[FILL_CONFIG.scenarios[scenario].delay];
      expect(RESEARCH_CONFIG.decisionCommitment).toBe('confirmed');
      const slots = BigInt(profile.eventToProcessedSlots + profile.processedToConfirmedSlots);
      const { seen } = watch(opts({ scenario }));
      const obs = seen.filter((x) => x.key.startsWith('pool:') || x.key.startsWith('life:'));
      expect(obs.length).toBeGreaterThan(0);
      for (const x of obs) {
        const row = byId.get(x.id.slice(2))!;
        const at = firstBlockFrom(row.slot + slots);
        expect(x.slot).toBe(at);
        expect(x.receivedAt).toBe(blockAt.get(at)! + profile.providerMs);
        // The chain moment travels with the value, so the observation's age is never reset by its arrival.
        expect(x.observed).toEqual({ slot: row.slot, at: row.blockTime * 1000 });
      }
    }
  });

  test('recorded receipt times are never charged the delay again', () => {
    const { seen } = watch(opts({ observation: 'recorded' }));
    const obs = seen.filter((x) => x.key.startsWith('pool:'));
    expect(obs.length).toBeGreaterThan(0);
    for (const x of obs) {
      const row = byId.get(x.id.slice(2))!;
      expect([x.slot, x.receivedAt]).toEqual([row.slot, row.blockTime * 1000]);
    }
  });

  test('stress blackouts of 30 s and 60 s: nothing arrives inside one, the backlog arrives in order after it, stale stays stale, the clock keeps running', () => {
    const stress = FILL_CONFIG.delays.stress;
    expect(stress.blackouts.map((b) => b.durationMs)).toEqual([30_000, 60_000]);
    const { r, seen } = watch(opts({ delay: 'stress', research: { ...RESEARCH_CONFIG, heartbeatBlocks: 5 } }));
    expect(r.stats.crash).toBeNull();
    expect(r.blackouts.length).toBeGreaterThanOrEqual(2);
    const inside = (t: number) => r.blackouts.some((b) => t >= b.from && t < b.to);
    const obs = seen.filter((x) => x.key.startsWith('pool:') || x.key.startsWith('life:'));
    for (const x of obs) expect(inside(x.receivedAt)).toBe(false);
    // Clock events keep coming during a blackout.
    expect(seen.some((x) => x.key === 'slot' && inside(x.receivedAt))).toBe(true);
    // A backlog: observations from inside a blackout arrive after it, still dated at their chain time, in chain order.
    let backlog = 0;
    for (const b of r.blackouts) {
      const held = obs.filter((x) => x.observed!.at >= b.from && x.observed!.at < b.to - 10_000);
      if (held.length === 0) continue;
      backlog++;
      for (const x of held) expect(x.receivedAt).toBeGreaterThanOrEqual(b.to);
      const order = held.map((x) => byId.get(x.id.slice(2))!).map((w) => (w.kind === 'block' ? [0n, 0, 0] as const : [w.slot, w.txIdx, w.evIdx] as const));
      for (let k = 1; k < order.length; k++) {
        const [s0, t0, e0] = order[k - 1]!;
        const [s1, t1, e1] = order[k]!;
        expect(s1 > s0 || (s1 === s0 && (t1 > t0 || (t1 === t0 && e1 > e0)))).toBe(true);
      }
    }
    expect(backlog).toBeGreaterThan(0);
  });

  test('discoveries are held by blackouts too: none arrives inside one, and each keeps at least its drawn lag', () => {
    const grads = new Map<string, bigint>();
    for (const r of rows) if (r.kind === 'event' && r.event === 'CompletePumpAmmMigrationEvent') grads.set(r.fields['mint']!, r.slot);
    // A blackout placed over the synthetic graduations (seconds after midnight UTC).
    const dark = (blackouts: { durationMs: number; atMsOfDay?: number }[]) => ({ ...FILL_CONFIG, delays: { ...FILL_CONFIG.delays, stress: { ...FILL_CONFIG.delays.stress, blackouts } } });
    const { r, seen } = watch(opts({ delay: 'stress', fills: dark([{ durationMs: 60_000, atMsOfDay: 5_000 }]) }));
    const lit = watch(opts({ delay: 'stress', fills: dark([]) })).seen.filter((x) => x.key.startsWith('disc:'));
    const inside = (t: number) => r.blackouts.some((b) => t >= b.from && t < b.to);
    const disc = seen.filter((x) => x.key.startsWith('disc:'));
    expect(disc.length).toBe(grads.size);
    for (const x of disc) {
      expect(inside(x.receivedAt)).toBe(false);
      expect(x.slot).toBeGreaterThan(grads.get(x.key.slice(5))!);
    }
    // A discovery that would arrive inside a blackout comes after it ends.
    let held = 0;
    for (const x of lit) {
      const b = r.blackouts.find((w) => x.receivedAt >= w.from && x.receivedAt < w.to);
      if (b === undefined) continue;
      held++;
      expect(disc.find((y) => y.key === x.key)!.receivedAt).toBeGreaterThanOrEqual(b.to);
    }
    expect(held).toBeGreaterThan(0);
  });
});

describe('rent follows the account-close outcome (BT-1c rent ruling)', () => {
  const withClose = (closeSuccessPpm: bigint, dustPpm = 0n): typeof FILL_CONFIG => ({
    ...FILL_CONFIG, scenarios: { ...FILL_CONFIG.scenarios, base: { ...FILL_CONFIG.scenarios.base, rentRecovery: true, closeSuccessPpm, dustPpm } },
  });

  test('a failed close rolls back the sell and charges the fee; the sell-only fallback leaves the rent locked', () => {
    const f = withClose(0n);
    const r = runBacktest(opts({ fills: f }));
    expect(r.stats.illegalStates).toBe(0);
    const closeFails = r.attempts.filter((a) => a.purpose === 'exit' && a.reason === 'close failed');
    expect(closeFails.length).toBeGreaterThan(0);
    for (const a of closeFails) {
      expect(a.outcome).toBe('failed');
      expect(a.fill).toBeNull();
      expect(a.fee).toBeGreaterThan(0n);
    }
    const { trades } = tradesOf(r, f);
    expect(trades.filter((t) => t.exitReason === 'time-stop').length).toBeGreaterThan(0);
    for (const t of trades) expect(t.rentReturned).toBe(0n);
  });

  test('the close draw has its own seed, so scenarios keep common random numbers for every other draw', () => {
    const fate = (f: typeof FILL_CONFIG) => runBacktest(opts({ fills: f, seed: 'crn' })).attempts.map((a) => `${a.signature}:${a.outcome}:${a.landedSlot}`);
    // Closes always succeed; with dust no account closes, so no close is drawn. Nothing else may change.
    const a = fate(withClose(1_000_000n, 0n));
    expect(a.length).toBeGreaterThan(3);
    expect(fate(withClose(1_000_000n, 1_000_000n))).toEqual(a);
  });

  test('the rent comes back once, only with a landed sell-and-close; dust in the account keeps it locked', () => {
    const f = withClose(1_000_000n);
    const r = runBacktest(opts({ fills: f }));
    const { trades } = tradesOf(r, f);
    const closed = trades.filter((t) => t.exitReason === 'time-stop');
    expect(closed.length).toBeGreaterThan(0);
    const closers = new Set(r.attempts.filter((a) => a.closedAccount).map((a) => a.intentId));
    for (const t of closed) {
      const refunded = t.rentReturned > 0n;
      expect(t.rentReturned).toBe(refunded ? t.rentPaid : 0n);
      if (refunded) expect(t.rentPaid).toBe(FILL_CONFIG.network.tokenAccountRent);
    }
    expect(closed.some((t) => t.rentReturned > 0n)).toBe(true);
    expect(closers.size).toBe(closed.filter((t) => t.rentReturned > 0n).length);
    const dusty = withClose(1_000_000n, 1_000_000n);
    const d = runBacktest(opts({ fills: dusty }));
    expect(d.attempts.some((a) => a.closedAccount)).toBe(false);
    for (const t of tradesOf(d, dusty).trades) expect(t.rentReturned).toBe(0n);
  });
});

describe('exit failures (BT-1c exit-failure ruling)', () => {
  test('attempts sent inside a deterministic burst never reach a block, and a dropped attempt is replaced only after its last valid height', () => {
    const r = runBacktest(opts({ seed: 'burst', failureBursts: { perDay: 720, durationMs: 60_000 } }));
    expect(r.stats.crash).toBeNull();
    expect(r.stats.illegalStates).toBe(0);
    expect(r.stats.unreconciledIntents).toBe(0);
    const burst = r.attempts.filter((a) => a.forcedDrop === 'burst');
    expect(burst.length).toBeGreaterThan(0);
    for (const a of burst) {
      expect(a.outcome).toBe('dropped');
      expect(a.fee).toBe(0n);
      expect(a.landedSlot).toBeNull();
    }
    const valid = FILL_CONFIG.network.blockhashValidBlocks;
    const byIntent = new Map<string, typeof r.attempts[number][]>();
    for (const a of r.attempts) byIntent.set(a.intentId, [...(byIntent.get(a.intentId) ?? []), a]);
    let checked = 0;
    for (const list of byIntent.values()) {
      for (let k = 1; k < list.length; k++) {
        const prev = list[k - 1]!;
        if (prev.outcome !== 'dropped' && prev.outcome !== 'expired') continue;
        // The replacement was signed at a height past the dropped attempt's last valid height.
        expect(list[k]!.lastValidBlockHeight - valid).toBeGreaterThan(prev.lastValidBlockHeight);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  test('the blocked-exit rate is reported for ladders that fall wholly inside congestion', () => {
    const r = runBacktest(opts({ scenario: 'conservative', seed: 'ladder' }));
    const l = ladderCongestion(r);
    const exits = Object.values(r.book.intents).filter((i) => i.intent.purpose === 'exit').map((i) => i.intent.positionId);
    expect(l.allCongested + l.rest).toBe(new Set(exits).size);
    expect(l.allCongestedBlocked).toBeLessThanOrEqual(l.allCongested);
    expect(l.restBlocked).toBeLessThanOrEqual(l.rest);
  });

  test('expectancy and survival against burst frequency, for 10, 30 and 60 s bursts', () => {
    const rowsOut = burstSweep(opts(), { perDay: [0, 48], durationsMs: [10_000, 30_000, 60_000] }, { from: T0, to: T0 + 6 * 3_600_000 });
    expect(rowsOut.map((x) => [x.perDay, x.durationMs])).toEqual([[0, 10_000], [48, 10_000], [0, 30_000], [48, 30_000], [0, 60_000], [48, 60_000]]);
    for (const x of rowsOut) {
      expect(typeof x.survived).toBe('boolean');
      expect(x.blockedExitRate).toBeGreaterThanOrEqual(0);
      expect(x.entryDecisions).toBeGreaterThan(0);
    }
    // No bursts: the same run whatever the duration.
    expect(rowsOut[0]!.allInPerEntryDecisionMicro).toBe(rowsOut[2]!.allInPerEntryDecisionMicro);
  });
});

describe('exit failure responds to congestion (BT-1d, reviewer test)', () => {
  test('blocked exits and failed exit attempts: always congested > real ≥ congestion without effect, in both scenarios', () => {
    // 30 mints, 8 h, swapEvery 60, seeds s0-s7, 3 modes x 2 scenarios = 48 replays, in their own process (see the script).
    const out = JSON.parse(execFileSync('node', ['--no-warnings', join(import.meta.dirname, 'congestion-tally.ts')], { encoding: 'utf8', timeout: 240_000, maxBuffer: 1 << 20 }).trim()) as
      Record<'conservative' | 'base', Record<'always' | 'real' | 'none', { blocked: number; exits: number; failed: number }>>;
    for (const scenario of ['conservative', 'base'] as const) {
      const { always, real, none } = out[scenario];
      const share = (x: { exits: number; failed: number }) => x.failed / x.exits;
      expect(always.blocked).toBeGreaterThan(real.blocked);
      expect(real.blocked).toBeGreaterThanOrEqual(none.blocked);
      expect(share(always)).toBeGreaterThan(share(none));
    }
  });
});
