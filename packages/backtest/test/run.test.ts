import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { openLedgerReader } from '../../core/src/ledger/index.ts';
import { replayLedgerFile } from '../../core/src/ledger/replay/index.ts';
import { authoriseHoldout, holdoutConfigId, readHoldoutStore, researchDays, runAndSealHoldout, runHoldout, writeHoldoutStore } from '../src/holdout.ts';
import { holdoutReady } from '../../core/src/stats/index.ts';
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
      expect(t.closedAt - t.openedAt).toBeGreaterThanOrEqual(TRIAL_POLICY.exits.tMaxMs);
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
  const window = { fromDay: '2026-09-20', toDay: '2026-09-20' };

  test('seals in the STATS-1 registry; the size check reads the counts alone', () => {
    const a = authority('seal');
    authoriseHoldout(a, 1, { holdoutId: 'h-u2', universe: 'U2' }, opts());
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
    authoriseHoldout(a, 1, { holdoutId: 'h-once', universe: 'U2' }, opts());
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
    authoriseHoldout(a, 1, { holdoutId: 'h-fail', universe: 'U2' }, opts());
    const crashing = opts({ strategy: () => ({ onMarket: () => { throw new Error('boom'); } }) });
    expect(() => runAndSealHoldout({ ...crashing, ledgerPath: join(dir, 'fail.sqlite') }, { ...a, byUniverse: { U2: 'h-fail' }, window })).toThrow(/crashed/);
    const store = readHoldoutStore(a.registryPath);
    expect(store.registry.entries[0]).toMatchObject({ burned: true, burnReason: 'run-failed' });
    expect(store.runs.map((r) => r.outcome)).toEqual(['started', 'failed']);
    expect(() => runAndSealHoldout({ ...opts(), ledgerPath: join(dir, 'fail2.sqlite') }, { ...a, byUniverse: { U2: 'h-fail' }, window })).toThrow(/burned/);

    // A run killed mid-way leaves only its start record: the window is spent.
    const b = authority('killed');
    authoriseHoldout(b, 1, { holdoutId: 'h-killed', universe: 'U2' }, opts());
    const killed = readHoldoutStore(b.registryPath);
    writeHoldoutStore(b.registryPath, { ...killed, runs: [{ holdoutId: 'h-killed', outcome: 'started', configId: holdoutConfigId(opts(), b), ledgerPath: 'x', at: '2026-10-03T00:00:00Z', reason: '' }] });
    expect(() => runAndSealHoldout({ ...opts(), ledgerPath: join(dir, 'killed.sqlite') }, { ...b, byUniverse: { U2: 'h-killed' }, window })).toThrow(/already run/);
    expect(readHoldoutStore(b.registryPath).registry.entries[0]).toMatchObject({ burned: true, burnReason: 'run-failed' });
  });

  test('a window started under one id cannot be registered or run again under another id or universe (H2)', () => {
    const a = authority('overlap');
    authoriseHoldout(a, 2, { holdoutId: 'h-first', universe: 'U2' }, opts());
    expect(() => authoriseHoldout(a, 2, { holdoutId: 'h-u1', universe: 'U1' }, opts())).toThrow(/produces U2/);
    runAndSealHoldout({ ...opts(), ledgerPath: join(dir, 'overlap1.sqlite') }, { ...a, byUniverse: { U2: 'h-first' }, window });
    expect(() => authoriseHoldout(a, 2, { holdoutId: 'h-second', universe: 'U2' }, opts())).toThrow(/overlaps h-first/);
  });

  test('entries stop at the cutoff while the run keeps observing (final holdout form)', () => {
    const a = authority('cutoff');
    const early = opts({ research: { ...RESEARCH, holdout: { ...RESEARCH.holdout, entryCutoffDay: '2026-09-20' } } });
    authoriseHoldout(a, 1, { holdoutId: 'h-cut', universe: 'U2' }, early);
    const out = runAndSealHoldout({ ...early, ledgerPath: join(dir, 'cutoff.sqlite') }, { ...a, byUniverse: { U2: 'h-cut' }, window });
    expect(out.counts['U2']?.entries ?? 0).toBe(0);
    expect(out.ledgerHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('the registry must be under version control: a dirty one is refused before anything runs; every write is committed (H3)', () => {
    const a = authority('vcs');
    const commits: string[] = [];
    let dirty = false;
    const vcs = { check: () => { if (dirty) throw new Error('registry is not tracked or has changes'); }, commit: (m: string) => { commits.push(m); } };
    authoriseHoldout({ ...a, vcs }, 1, { holdoutId: 'h-vcs', universe: 'U2' }, opts());
    dirty = true;
    expect(() => runAndSealHoldout({ ...opts(), ledgerPath: join(dir, 'vcs.sqlite') }, { ...a, vcs, byUniverse: { U2: 'h-vcs' }, window })).toThrow(/not tracked/);
    expect(existsSync(join(dir, 'vcs.sqlite'))).toBe(false);
    dirty = false;
    runAndSealHoldout({ ...opts(), ledgerPath: join(dir, 'vcs.sqlite') }, { ...a, vcs, byUniverse: { U2: 'h-vcs' }, window });
    expect(commits.map((m) => m.split(':')[1]!.trim().split(' ')[0])).toEqual(['registered', 'started', 'sealed']);
  });

  test('the configured tail lets every entry before the cutoff finish', () => {
    const h = RESEARCH_CONFIG.holdout;
    const tail = Date.parse(`${h.tailEndDay}T00:00:00Z`) - Date.parse(`${h.entryCutoffDay}T00:00:00Z`);
    const s0 = RESEARCH_CONFIG.s0;
    expect(tail).toBeGreaterThanOrEqual(TRIAL_POLICY.exits.tMaxMs + s0.blockedRetries * s0.blockedRetryMs + s0.endMarginMs);
    expect([h.fromDay, h.entryCutoffDay]).toEqual(['2026-09-22', '2026-10-20']);
  });

  test('research days never include the reserved holdout start or a registered window (H1)', () => {
    const r = { ...RESEARCH_CONFIG };
    expect(researchDays(['2026-09-20', '2026-09-21'], r, null, true)).toEqual(['2026-09-20', '2026-09-21']);
    expect(() => researchDays(['2026-09-21', '2026-09-22'], r, null, true)).toThrow(/reserved holdout start/);
    expect(researchDays(['2026-09-21', '2026-09-22', '2026-09-30'], r, null, false)).toEqual(['2026-09-21']);
    expect(() => researchDays(['2026-09-25'], r, null, false)).toThrow(/no practice days/);
    const a = authority('days');
    const store = authoriseHoldout(a, 1, { holdoutId: 'h-days', universe: 'U2' }, opts());
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
