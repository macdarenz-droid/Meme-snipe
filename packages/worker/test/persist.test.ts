// PERSIST-1: save and restore the deployer index, the labeller's tables and the coverage facts across restarts
// (docs/DECISIONS.md, PERSIST-1). The top-up runs on real mainnet create transactions (DEC-1's fixtures).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { TransactionRecord } from '../../core/src/chain/index.ts';
import { RUG_CONFIG } from '../../core/src/config/rugs.ts';
import { DAY_MS, HOUR_MS } from '../../core/src/config/time.ts';
import { AsOfStore, OFF_CHAIN, SimClock, compareEvents, type MarketEvent, type Moment } from '../../core/src/engine/index.ts';
import { DeployerIndex, RugLabeller, createsCoverage } from '../../core/src/gates/index.ts';
import type { SignatureInfo } from '../src/providers/solana-http.ts';
import { DailyBudget, STATE_VERSION, loadState, saveState, type SavedState } from '../src/persist/index.ts';
import { buildSeed, type SeedRpc } from '../src/seed/index.ts';
import type { Timers } from '../src/scheduler/index.ts';
import { blockNetwork, recordOf, TXS } from './helpers.ts';

blockNetwork();

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'persist-')); dirs.push(d); return d; };

const off = (slot: bigint, receivedAt: number): Moment => ({ slot, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt });
const wrap = (value: Record<string, unknown>, seq = 1) => ({ value, source: 'worker', backfilled: false, seq });
const fact = (id: string, key: string, moment: Moment, value: Record<string, unknown>): MarketEvent => ({ kind: 'market', id, key, moment, value: wrap(value) });
const VIA = 'logs:TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';

// The saved process: watched for 20 days, saved one slot below the fixture creates' slots.
const SAVED_AT: Moment = off(452_941_150n, 1_791_032_540_000);
const START_MS = SAVED_AT.receivedAt - 20 * DAY_MS;
const createAt = (mint: string, creator: string, ms: number, slot: bigint, supply: bigint | null = 1_000_000_000_000_000n): MarketEvent => ({
  kind: 'market', id: `ev:sig-${mint}:00002:00000`, key: `pump:CreateEvent:${mint}`, moment: { slot, txIndex: 5, ixIndex: 1, receivedAt: ms },
  value: { event: { name: 'CreateEvent', program: 'pump', data: { mint, creator, user: creator, timestamp: BigInt(ms / 1_000), ...(supply === null ? {} : { tokenTotalSupply: supply }) } }, source: 'helius', backfilled: false, seq: 1 },
});
const COVERAGE: MarketEvent[] = [
  fact('seed-start', 'coverage:creates:start', off(445_000_000n, START_MS - DAY_MS), { fromSlot: 445_000_000n, via: 'seed' }),
  fact('live-start', 'coverage:creates:start', off(447_000_000n, START_MS), { fromSlot: 447_000_000n, via: VIA }),
  fact('rugs-start', 'coverage:rugs:start', off(447_000_001n, START_MS + 1), { fromSlot: 447_000_001n, via: 'rug-labeller' }),
];
const EVENTS = [createAt('M1', 'Dev1', SAVED_AT.receivedAt - 3 * HOUR_MS, 452_900_000n), createAt('M2', 'Dev1', SAVED_AT.receivedAt - 2 * HOUR_MS, 452_910_000n, null)];

/** A live process up to SAVED_AT: index and labeller fed every released event. */
const liveProcess = () => {
  const index = new DeployerIndex();
  const labeller = new RugLabeller(RUG_CONFIG);
  for (const e of [...COVERAGE, ...EVENTS].sort(compareEvents)) {
    index.observe(e);
    for (const out of labeller.observe(e)) index.observe(out);
  }
  return { index, labeller };
};
const savedState = (over: Partial<SavedState> = {}): SavedState => {
  const { index, labeller } = liveProcess();
  return { asOf: SAVED_AT, index: index.snapshot(SAVED_AT), labeller: labeller.snapshot(), coverage: COVERAGE, ...over };
};

// ---------- the top-up after the restart ----------
const CREATES = TXS.filter((x) => x.label.startsWith('pump CreateEvent'));
const UNTIL = 452_941_300n;
const NOW: Moment = off(UNTIL + 50n, 1_791_032_700_000);
const LIVE_START: Moment = off(UNTIL, NOW.receivedAt - 1_000);
const sigOf = (t: (typeof TXS)[number]): SignatureInfo => ({ signature: t.signature, slot: BigInt(t.slot), err: null, blockTime: t.base64.blockTime ?? null });
/** History newest first; anything at or below `floor` makes the test fail if fetched (the 14 days the save spares). */
const HISTORY: SignatureInfo[] = [...CREATES.map(sigOf).sort((a, b) => (a.slot > b.slot ? -1 : 1)), { signature: 'Old'.padEnd(44, '1'), slot: 452_941_100n, err: null, blockTime: 1_791_032_500 }];
const rpcFor = (): SeedRpc & { fetched: string[] } => {
  const fetched: string[] = [];
  return {
    fetched,
    getSignaturesForAddress: async (_a, o) => {
      const from = o.before === undefined ? 0 : HISTORY.findIndex((s) => s.signature === o.before) + 1;
      return HISTORY.slice(from, from + o.limit);
    },
    getTransaction: async (s): Promise<TransactionRecord | null> => {
      fetched.push(s);
      if (s.startsWith('Old')) throw new Error('fetched a transaction from before the saved moment');
      const t = TXS.find((x) => x.signature === s);
      return t === undefined ? null : recordOf(t);
    },
  };
};
const instant: Timers = { now: () => NOW.receivedAt, setTimeout: (fn) => { queueMicrotask(fn); return { id: 0 }; }, clearTimeout: () => {} };

/** Restored coverage, any fill coverage and the restarted watch's start, through an as-of store, asked over 14 days. */
const coveredNow = (coverage: readonly MarketEvent[], stream = 'creates') => {
  const clock = new SimClock({ slot: 0n, txIndex: 0, ixIndex: 0, receivedAt: Number.MIN_SAFE_INTEGER });
  const store = new AsOfStore(clock);
  const live = fact('restart-live-start', `coverage:${stream}:start`, LIVE_START, { fromSlot: UNTIL, via: stream === 'creates' ? VIA : 'rug-labeller' });
  for (const e of [...coverage, live].sort(compareEvents)) {
    clock.advanceTo(e.moment);
    store.record(e.key, e.value, e.moment, e.id);
  }
  clock.advanceTo(NOW);
  return createsCoverage((k, f, t) => store.history(k, f, t), NOW, NOW.receivedAt - 14 * DAY_MS, stream);
};

describe('PERSIST-1 save and restore', () => {
  it('a restart restores without re-fetching: the index and labeller come back whole, and the top-up reads only after the save', async () => {
    const path = join(tmp(), 'state.json');
    const { index, labeller } = liveProcess();
    saveState(path, { asOf: SAVED_AT, index: index.snapshot(SAVED_AT), labeller: labeller.snapshot(), coverage: COVERAGE });
    const r = loadState(path, RUG_CONFIG);
    if (!r.ok) throw new Error(r.reason);
    expect(r.index.factFor('Dev1', NOW, 0)).toEqual(index.factFor('Dev1', NOW, 0));
    expect(r.index.snapshot(SAVED_AT)).toEqual(index.snapshot(SAVED_AT));
    expect(r.labeller.snapshot()).toEqual(labeller.snapshot());
    expect(r.labeller.unjudged.get('M2')).toBe('the create carries no total supply');
    // Every live watch gets a restart gap and a fill; the seed's via does not.
    expect(r.fills.map((f) => [f.stream, f.via, f.fromSlot, f.synthesized])).toEqual([['creates', VIA, SAVED_AT.slot, true], ['rugs', 'rug-labeller', SAVED_AT.slot, true]]);
    // The creates top-up: from the saved moment to the live start, closing the restart gap.
    const f = r.fills[0]!;
    const rpc = rpcFor();
    const fill = await buildSeed({
      days: [], untilSlot: UNTIL, asOf: NOW, rpc: { rpc, timers: instant, creditCap: 100, provider: 'helius' },
      fill: { fromSlot: SAVED_AT.slot, fromMs: SAVED_AT.receivedAt, close: { via: f.via, fromSlot: f.fromSlot, at: f.at }, liveStart: LIVE_START },
    });
    expect(fill.report.rpc).toMatchObject({ fromSlot: SAVED_AT.slot, result: { stoppedBy: 'done', creates: CREATES.length } });
    expect(fill.report.rpc!.result.creditsUsed).toBe(1 + CREATES.length);
    expect(rpc.fetched.some((s) => s.startsWith('Old'))).toBe(false);
    r.index.fill(fill.creates, NOW);
    expect(coveredNow([...r.coverage, ...fill.coverage])).toMatchObject({ covered: true });
  });

  it('as-of honesty: without the top-up the restored coverage is not covered, and nothing restored is after the save', () => {
    const path = join(tmp(), 'state.json');
    saveState(path, savedState());
    const r = loadState(path, RUG_CONFIG);
    if (!r.ok) throw new Error(r.reason);
    for (const e of r.coverage) expect(compareEvents(e, { moment: SAVED_AT, id: '￿' })).toBeLessThan(0);
    expect(coveredNow(r.coverage).covered).toBe(false);
    expect(coveredNow(r.coverage, 'rugs').covered).toBe(false);
    // Saved covered only: the same coverage read at the saved moment was covered.
    const clock = new SimClock({ slot: 0n, txIndex: 0, ixIndex: 0, receivedAt: Number.MIN_SAFE_INTEGER });
    const store = new AsOfStore(clock);
    for (const e of COVERAGE) { clock.advanceTo(e.moment); store.record(e.key, e.value, e.moment, e.id); }
    clock.advanceTo(SAVED_AT);
    expect(createsCoverage((k, a, b) => store.history(k, a, b), SAVED_AT, SAVED_AT.receivedAt - 14 * DAY_MS).covered).toBe(true);
  });

  it('a gap already open at the save is a fill target with its own start and moment, not doubled', () => {
    const path = join(tmp(), 'state.json');
    const gapAt = off(452_940_000n, SAVED_AT.receivedAt - 60_000);
    saveState(path, savedState({ coverage: [...COVERAGE, fact('open-gap', 'coverage:creates:gap', gapAt, { fromSlot: 452_939_990n, toSlot: null, reason: 'disconnect', via: VIA })] }));
    const r = loadState(path, RUG_CONFIG);
    if (!r.ok) throw new Error(r.reason);
    expect(r.fills.filter((f) => f.stream === 'creates')).toEqual([{ stream: 'creates', via: VIA, fromSlot: 452_939_990n, at: gapAt, synthesized: false }]);
    expect(r.coverage.filter((e) => e.id.startsWith('persist:restart:creates'))).toEqual([]);
  });

  it('the index snapshot never claims what it no longer holds: pruning moves its start, and a moment before its last event is refused', () => {
    const { index } = liveProcess();
    expect(() => index.snapshot(off(1n, 0))).toThrow(/after the snapshot moment/);
    const retain = SAVED_AT.receivedAt - 150 * 60_000; // keeps M2 only
    const s = index.snapshot(SAVED_AT, retain);
    expect(s.mints).toEqual([['Dev1', [['M2', SAVED_AT.receivedAt - 2 * HOUR_MS]]]]);
    const r = DeployerIndex.restore(s);
    expect(r.factFor('Dev1', NOW, 0).coverageFromMs).toBe(retain);
  });
});

describe('PERSIST-1 discards a bad file whole', () => {
  const rewrite = (path: string, edit: (payload: Record<string, unknown>) => void) => {
    const outer = JSON.parse(readFileSync(path, 'utf8')) as { version: number; sha256: string; payload: string };
    const p = JSON.parse(outer.payload) as Record<string, unknown>;
    edit(p);
    const payload = JSON.stringify(p);
    writeFileSync(path, JSON.stringify({ ...outer, payload, sha256: createHash('sha256').update(payload).digest('hex') }));
  };
  const fresh = () => { const path = join(tmp(), 'state.json'); saveState(path, savedState()); return path; };

  it('corrupt, truncated, missing, version-mismatched or another rug config: discarded, never clean', () => {
    const corrupt = fresh();
    const text = readFileSync(corrupt, 'utf8');
    writeFileSync(corrupt, text.replace('Dev1', 'Dev2'));
    expect(loadState(corrupt, RUG_CONFIG)).toEqual({ ok: false, reason: 'saved state checksum does not match' });
    const truncated = fresh();
    writeFileSync(truncated, readFileSync(truncated, 'utf8').slice(0, 200));
    expect(loadState(truncated, RUG_CONFIG)).toMatchObject({ ok: false, reason: expect.stringContaining('unreadable') });
    expect(loadState(join(tmp(), 'none.json'), RUG_CONFIG)).toEqual({ ok: false, reason: 'no saved state' });
    const version = fresh();
    writeFileSync(version, readFileSync(version, 'utf8').replace(`"version":${STATE_VERSION}`, '"version":99'));
    expect(loadState(version, RUG_CONFIG)).toMatchObject({ ok: false, reason: expect.stringContaining('version 99') });
    expect(loadState(fresh(), { ...RUG_CONFIG, version: 'rugs-2' })).toMatchObject({ ok: false, reason: expect.stringContaining('rugs-2') });
  });

  it('a well-formed file that claims anything after its moment is discarded', () => {
    const late = fresh();
    rewrite(late, (p) => { (p['coverage'] as { moment: { receivedAt: number } }[])[1]!.moment.receivedAt = SAVED_AT.receivedAt + 1; });
    expect(loadState(late, RUG_CONFIG)).toMatchObject({ ok: false, reason: expect.stringContaining('after the saved moment') });
    const lateMint = fresh();
    rewrite(lateMint, (p) => { ((p['index'] as { mints: [string, [string, number][]][] }).mints[0]![1][0]![1]) = SAVED_AT.receivedAt + 5; });
    expect(loadState(lateMint, RUG_CONFIG)).toMatchObject({ ok: false, reason: expect.stringContaining('after the snapshot moment') });
    const moved = fresh();
    rewrite(moved, (p) => { (p['index'] as { asOf: { receivedAt: number } }).asOf.receivedAt -= 1; });
    expect(loadState(moved, RUG_CONFIG)).toMatchObject({ ok: false, reason: expect.stringContaining('another moment') });
    const badLaunch = fresh();
    rewrite(badLaunch, (p) => { ((p['labeller'] as { launches: Record<string, unknown>[] }).launches[0]!)['sold'] = -1; });
    expect(loadState(badLaunch, RUG_CONFIG)).toMatchObject({ ok: false, reason: expect.stringContaining('rejected') });
  });

  it('a discarded file leaves the restart not covered: a fresh index and no saved coverage', () => {
    const corrupt = fresh();
    writeFileSync(corrupt, '{');
    const r = loadState(corrupt, RUG_CONFIG);
    expect(r.ok).toBe(false);
    expect(coveredNow([]).covered).toBe(false);
  });

  it('saveState refuses a fact after its moment or an index taken at another moment', () => {
    const path = join(tmp(), 'state.json');
    expect(() => saveState(path, savedState({ coverage: [...COVERAGE, fact('late', 'coverage:creates:gap', off(SAVED_AT.slot + 1n, SAVED_AT.receivedAt), { fromSlot: 1n, toSlot: 2n, via: VIA })] }))).toThrow(/after the snapshot moment/);
    const { index } = liveProcess();
    expect(() => saveState(path, savedState({ index: index.snapshot({ ...SAVED_AT, receivedAt: SAVED_AT.receivedAt + 1 }) }))).toThrow(/another moment/);
  });
});

describe('PERSIST-1 daily credit budget', () => {
  it('spends within a UTC day, survives a reload, resets the next day; a corrupt file counts today as spent', () => {
    const path = join(tmp(), 'budget.json');
    const day = Date.parse('2026-10-04T01:00:00Z');
    const b = DailyBudget.load(path, 10_000, day);
    expect(b.remaining(day)).toBe(10_000);
    b.spend(4_150, day);
    expect(DailyBudget.load(path, 10_000, day + HOUR_MS).remaining(day + HOUR_MS)).toBe(5_850);
    expect(DailyBudget.load(path, 10_000, day + DAY_MS).remaining(day + DAY_MS)).toBe(10_000);
    expect(b.remaining(day + DAY_MS)).toBe(10_000);
    writeFileSync(path, 'garbage');
    expect(DailyBudget.load(path, 10_000, day).remaining(day)).toBe(0);
    expect(() => b.spend(-1, day)).toThrow(/non-negative/);
  });
});
