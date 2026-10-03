import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { openLedgerReader } from '../../core/src/ledger/index.ts';
import { runAndSealHoldout, runHoldout } from '../src/holdout.ts';
import { createHoldoutRegistry, holdoutReady, registerHoldout } from '../../core/src/stats/index.ts';
import { leakTest, replayHashes, shiftTest } from '../src/proofs.ts';
import { buildReport } from '../src/report.ts';
import { runBacktest, type RunOptions } from '../src/run.ts';
import { tradesOf } from '../src/trades.ts';
import { key, SOL_USD, syntheticRows, T0 } from './synthetic.ts';

const rows = syntheticRows({ mints: 4, slots: 2.5 * 3600 * 6 });
const opts = (over: Partial<RunOptions> = {}): RunOptions => ({
  rows: () => rows[Symbol.iterator](), series: [SOL_USD], seed: 'test-seed', scenario: 'base', policy: TRIAL_POLICY, fills: FILL_CONFIG, research: RESEARCH_CONFIG,
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
    // A tiny ladder so a single failing rung blocks.
    const s = runBacktest(opts({ seed: 'block-seed', policy: { ...TRIAL_POLICY, exits: { ...TRIAL_POLICY.exits, ladder: { ...TRIAL_POLICY.exits.ladder, maxAttempts: 1 } } },
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

  test('seals in the STATS-1 registry; the size check reads the counts alone', () => {
    let reg = createHoldoutRegistry(1);
    reg = registerHoldout(reg, { holdoutId: 'h-u2', universe: 'U2', configId: 's0-u2', fromDay: '2026-09-20', toDay: '2026-09-20' });
    const out = runAndSealHoldout({ ...opts(), ledgerPath: join(dir, 'holdout2.sqlite') }, { registry: reg, byUniverse: { U2: { holdoutId: 'h-u2', configId: 's0-u2' } } });
    expect(out.steps.map((s) => s.ok)).toEqual([true]);
    const entry = out.registry.entries[0]!;
    expect(entry.seal).toBe('sealed');
    expect(entry.ledgerHash).toBe(out.ledgerHash);
    expect(entry.counts).toEqual(out.counts['U2']);
    // A few synthetic trades are far from 300: not ready, so the seal stays closed.
    expect(holdoutReady(entry, 300, 20)).toBe(false);
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
  test('with no dropped attempts and landing under 150 slots, nothing expires, whatever the seed and scenario', () => {
    let betweenHeartbeats = 0;
    let onLifecycle = 0;
    for (const scenario of ['base', 'conservative', 'optimistic'] as const) {
      for (const seed of ['h1', 'h2', 'h3']) {
        const r = runBacktest(opts({ rows: () => crowd[Symbol.iterator](), seed, scenario, windowEnd: T0 + 7 * 3_600_000 }));
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
