// SEED-1: the deployer index's start-up seed from DATA-1's published days and an RPC backfill (docs/DECISIONS.md).
// No day release exists yet (2026-10-04), so the day source runs on a synthetic release built here in the exact
// published layout (units tar split in parts, SHA256SUMS-DAY). The RPC source runs on real mainnet create
// transactions (DEC-1's fixtures, 2026-10-03, after the pump upgrade).
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import type { TransactionRecord } from '../../core/src/chain/index.ts';
import { AsOfStore, OFF_CHAIN, SimClock, compareEvents, compareMoments, type MarketEvent, type Moment } from '../../core/src/engine/index.ts';
import { DAY_MS } from '../../core/src/config/time.ts';
import { DeployerIndex, createOf, createsCoverage } from '../../core/src/gates/index.ts';
import { eventsOfFrame, type Frame } from '../src/providers/canonical.ts';
import { rpcHandler, scriptedHttp } from '../src/providers/faults.ts';
import { ProviderError } from '../src/providers/http.ts';
import { RpcHttp, type SignatureInfo } from '../src/providers/solana-http.ts';
import { HELIUS_FREE, ManualTimers, Scheduler, type Timers } from '../src/scheduler/index.ts';
import {
  PUMP_CREATE_AUTHORITY, RUGS_NOT_SEEDED, REGIME_BOUNDARY_DAY, buildSeed, createEventsOf, estimateBackfillCredits, readDayRelease, type SeedOptions, type SeedRpc,
} from '../src/seed/index.ts';
import { blockNetwork, recordOf, TXS, type tx } from './helpers.ts';

blockNetwork();

const S = (iso: string) => Date.parse(iso) / 1_000;
const BOUNDARY_S = S(`${REGIME_BOUNDARY_DAY}T00:00:00Z`);

// ---------- a synthetic day release in the published layout ----------

const tarFile = (name: string, body: Buffer): Buffer => {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([h, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
};

interface UnitSpec {
  readonly from: number;
  readonly to: number;
  readonly firstS: number;
  readonly lastS: number;
  readonly creates?: readonly { readonly slot: number; readonly s: number; readonly mint: string; readonly creator: string; readonly txIdx?: number }[];
  readonly stats?: Record<string, unknown>;
  readonly blocks?: readonly (readonly [number, number])[];
  readonly unfinished?: boolean;
}

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Writes `units-DAY.tar.part00/01`, `manifest-DAY.json` and `SHA256SUMS-DAY` like DATA-1's publish-day.sh. */
const dayRelease = (day: string, units: readonly UnitSpec[], tamper?: (dir: string) => void, reports?: (dir: string) => void): string => {
  const dir = mkdtempSync(join(tmpdir(), 'seed-day-'));
  dirs.push(dir);
  const parts: Buffer[] = [];
  for (const u of units) {
    const base = `units/1047/${u.from}-${u.to}`;
    const events = (u.creates ?? []).map((c, i) => JSON.stringify({
      slot: c.slot, block_time: c.s, tx_idx: c.txIdx ?? i, ev_idx: 0, signature: `sig${c.mint}`, signer: c.creator, program: 'pump', event: 'CreateEvent',
      fields: { mint: c.mint, creator: c.creator, user: c.creator, timestamp: String(c.s), token_total_supply: '1000000000000000' }, outer_ix: 2, inner_ix: 0,
    }));
    // A non-create event and an amm event in the same file are ignored.
    events.push(JSON.stringify({ slot: u.from, block_time: u.firstS, tx_idx: 0, ev_idx: 0, signature: 'sigOther', program: 'pump', event: 'CompleteEvent', fields: { mint: 'X' } }));
    parts.push(tarFile(`${base}/events.jsonl.zst`, zstdCompressSync(Buffer.from(`${events.join('\n')}\n`))));
    parts.push(tarFile(`${base}/curve_trades.csv.zst`, zstdCompressSync(Buffer.from('slot\n'))));
    if (u.blocks !== undefined) parts.push(tarFile(`${base}/blocks.csv.zst`, zstdCompressSync(Buffer.from(`slot,block_time,parent_slot\n${u.blocks.map(([s, t]) => `${s},${t},${s - 1}`).join('\n')}\n`))));
    if (u.unfinished !== true) {
      parts.push(tarFile(`${base}/stats.json`, Buffer.from(JSON.stringify({
        schema: 2, from_slot: u.from, to_slot: u.to, first_block_time: u.firstS, last_block_time: u.lastS, decode_failures: 0, missing_meta: 0, unknown_events: {}, chain_breaks: null, ...u.stats,
      }))));
    }
  }
  const tar = Buffer.concat([...parts, Buffer.alloc(1024)]);
  const cut = Math.floor(tar.length / 2) + 7; // a split that falls inside an entry, as `split -b` does
  writeFileSync(join(dir, `units-${day}.tar.part00`), tar.subarray(0, cut));
  writeFileSync(join(dir, `units-${day}.tar.part01`), tar.subarray(cut));
  writeFileSync(join(dir, `manifest-${day}.json`), '{}');
  writeFileSync(join(dir, `qa-${day}.md`), 'ok');
  writeFileSync(join(dir, `qa-${day}.json`), JSON.stringify({ strict: { pass: true, misses: [] } }));
  writeFileSync(join(dir, `parity-${day}.json`), JSON.stringify({ mismatch_count: 0, missing_row_count: 0, rows_checked: 10 }));
  reports?.(dir);
  const sha = (f: string) => createHash('sha256').update(readFileSync(join(dir, f))).digest('hex');
  const names = [`units-${day}.tar.part00`, `units-${day}.tar.part01`, `qa-${day}.md`, `qa-${day}.json`, `parity-${day}.json`, `manifest-${day}.json`];
  writeFileSync(join(dir, `SHA256SUMS-${day}`), names.map((n) => `${sha(n)}  ${n}`).join('\n') + '\n');
  tamper?.(dir);
  return dir;
};

const DAY = '2026-10-01';
const CREATOR = 'Creator1111111111111111111111111111111111111';
const t = (hms: string) => S(`${DAY}T${hms}Z`);
/** Three units: A clean, B with a decode failure, a hole, then C crossing the regime boundary. */
const UNITS: readonly UnitSpec[] = [
  { from: 452_700_000, to: 452_700_999, firstS: t('22:00:00'), lastS: t('22:04:00'), creates: [{ slot: 452_700_100, s: t('22:00:30'), mint: 'MintA1', creator: CREATOR }, { slot: 452_700_200, s: t('22:01:00'), mint: 'MintA2', creator: CREATOR }] },
  { from: 452_701_000, to: 452_701_999, firstS: t('22:04:00'), lastS: t('22:08:00'), stats: { decode_failures: 1 }, creates: [{ slot: 452_701_500, s: t('22:06:00'), mint: 'MintB1', creator: CREATOR }] },
  {
    from: 452_702_500, to: 452_703_499, firstS: t('23:58:00'), lastS: BOUNDARY_S + 300,
    blocks: [[452_702_500, t('23:58:00')], [452_702_900, t('23:59:59')], [452_702_901, BOUNDARY_S], [452_703_499, BOUNDARY_S + 300]],
    creates: [{ slot: 452_702_800, s: t('23:59:30'), mint: 'MintC1', creator: CREATOR }, { slot: 452_703_000, s: BOUNDARY_S + 40, mint: 'MintAfterBoundary', creator: CREATOR }],
  },
];

// ---------- a scripted RPC over real create transactions ----------

const CREATES = TXS.filter((x) => x.label.startsWith('pump CreateEvent'));
const UNTIL = 452_941_300n;
const ASOF: Moment = { slot: UNTIL + 10n, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: 1_791_032_700_000 };

interface FakeRpc extends SeedRpc {
  readonly fetched: string[];
  readonly pages: (string | undefined)[];
  readonly contexts: (bigint | undefined)[];
}

/** Signatures newest first; `txs` answers getTransaction (a function may throw a fault). */
const fakeRpc = (sigs: readonly SignatureInfo[], txs: (sig: string) => TransactionRecord | null, opts: { pageFault?: (n: number) => Error | null } = {}): FakeRpc => {
  const fetched: string[] = [];
  const pages: (string | undefined)[] = [];
  const contexts: (bigint | undefined)[] = [];
  return {
    fetched, pages, contexts,
    getSignaturesForAddress: async (address, o) => {
      expect(address).toBe(PUMP_CREATE_AUTHORITY);
      pages.push(o.before);
      contexts.push(o.minContextSlot);
      const f = opts.pageFault?.(pages.length);
      if (f) throw f;
      const from = o.before === undefined ? 0 : sigs.findIndex((s) => s.signature === o.before) + 1;
      return sigs.slice(from, from + o.limit);
    },
    getTransaction: async (sig) => {
      fetched.push(sig);
      return txs(sig);
    },
  };
};

const sigOf = (f: ReturnType<typeof tx>): SignatureInfo => ({ signature: f.signature, slot: BigInt(f.slot), err: null, blockTime: f.base64.blockTime ?? null });
/** A future-only marker: a signature after the process start whose transaction would seed mint FUTURE. */
const FUTURE_SIG: SignatureInfo = { signature: 'FutureOnlyMarker1111111111111111111111111111', slot: UNTIL + 1n, err: null, blockTime: 1_791_032_690 };
const SIGS: readonly SignatureInfo[] = [
  FUTURE_SIG,
  { signature: 'FailedAtUntil111111111111111111111111111111', slot: UNTIL, err: { InstructionError: [0, 'x'] }, blockTime: 1_791_032_689 },
  ...CREATES.map(sigOf).sort((a, b) => (a.slot > b.slot ? -1 : a.slot < b.slot ? 1 : 0)),
  { signature: 'FailedCreate11111111111111111111111111111111', slot: 452_941_170n, err: { InstructionError: [0, 'x'] }, blockTime: 1_791_032_555 },
  { signature: 'OlderThanDays111111111111111111111111111111', slot: 452_702_900n, err: null, blockTime: t('23:59:59') },
];
const byFixture = (sig: string): TransactionRecord | null => {
  if (sig === FUTURE_SIG.signature) throw new Error('the future-only marker must never be fetched');
  const f = CREATES.find((x) => x.signature === sig);
  return f === undefined ? null : recordOf(f);
};

/** Backoff waits recorded, then run at once, so a retry test needs no wall clock. */
const instantTimers = (): Timers & { readonly waits: number[] } => {
  const waits: number[] = [];
  return { waits, now: () => 0, setTimeout: (fn, ms) => { waits.push(ms); queueMicrotask(fn); return { id: waits.length }; }, clearTimeout: () => {} };
};

const seedOpts = (over: Partial<SeedOptions> & { rpcImpl?: SeedRpc; creditCap?: number; timers?: Timers } = {}): SeedOptions => ({
  days: [{ dir: dayRelease(DAY, UNITS), day: DAY }],
  rpc: { rpc: over.rpcImpl ?? fakeRpc(SIGS, byFixture), timers: over.timers ?? instantTimers(), creditCap: over.creditCap ?? 1_000, provider: 'helius' },
  untilSlot: UNTIL, asOf: ASOF, ...over,
});

/** Releases seed coverage plus the live watch's start into an as-of store and asks H14's coverage question. */
const coverageAt = (coverage: readonly MarketEvent[], now: Moment, windowStartMs: number) => {
  const clock = new SimClock({ slot: 0n, txIndex: 0, ixIndex: 0, receivedAt: Number.MIN_SAFE_INTEGER });
  const store = new AsOfStore(clock);
  const live: MarketEvent = { kind: 'market', id: 'live-start', moment: { ...ASOF, slot: UNTIL + 10n }, key: 'coverage:creates:start', value: { value: { fromSlot: UNTIL, via: 'logs:creates' }, source: 'worker', backfilled: false, seq: 1 } };
  for (const e of [...coverage, live]) {
    clock.advanceTo(e.moment);
    store.record(e.key, e.value, e.moment, e.id);
  }
  clock.advanceTo(now);
  return createsCoverage((k, f, to) => store.history(k, f, to), now, windowStartMs);
};

describe('SEED-1 day releases', () => {
  it('reads creates and per-unit coverage from a verified release; a defective unit and a missing range are gaps', () => {
    const r = readDayRelease(dayRelease(DAY, UNITS), DAY);
    expect(r.creates.map((c) => c.mint)).toEqual(expect.arrayContaining(['MintA1', 'MintA2', 'MintB1', 'MintC1']));
    expect(r.units.map((u) => [u.fromSlot, u.toSlot, u.covered])).toEqual([[452_700_000n, 452_700_999n, true], [452_701_000n, 452_701_999n, false], [452_702_500n, 452_702_900n, true]]);
    expect(r.units[1]!.reason).toMatch(/decode failures/);
  });

  it('regime boundary: 2026-10-02 and later are never read, and a crossing unit is cut at the last block before it', () => {
    expect(() => readDayRelease(dayRelease('2026-10-02', UNITS), '2026-10-02')).toThrow(/regime boundary/);
    expect(() => readDayRelease(dayRelease('2026-10-05', UNITS), '2026-10-05')).toThrow(/regime boundary/);
    const r = readDayRelease(dayRelease(DAY, UNITS), DAY);
    expect(r.creates.some((c) => c.mint === 'MintAfterBoundary')).toBe(false);
    expect(r.creates.every((c) => c.blockTimeMs < BOUNDARY_S * 1_000)).toBe(true);
    // A crossing unit without block rows cannot be cut: refused rather than guessed.
    const noBlocks = UNITS.map((u) => (u.blocks === undefined ? u : { ...u, blocks: undefined }));
    expect(() => readDayRelease(dayRelease(DAY, noBlocks as UnitSpec[]), DAY)).toThrow(/crosses 2026-10-02/);
  });

  it('every asset must match SHA256SUMS-DAY, and a part it does not list is refused', () => {
    expect(() => readDayRelease(dayRelease(DAY, UNITS, (d) => writeFileSync(join(d, `units-${DAY}.tar.part01`), 'altered')), DAY)).toThrow(/sha256/);
    expect(() => readDayRelease(dayRelease(DAY, UNITS, (d) => writeFileSync(join(d, `units-${DAY}.tar.part02`), 'extra')), DAY)).toThrow(/not listed/);
    expect(() => readDayRelease(dayRelease(DAY, UNITS, (d) => rmSync(join(d, `manifest-${DAY}.json`))), DAY)).toThrow(/missing/);
    expect(() => readDayRelease(dayRelease(DAY, UNITS, (d) => rmSync(join(d, `SHA256SUMS-${DAY}`))), DAY)).toThrow(/SHA256SUMS/);
  });

  it('an unfinished unit (no stats.json) is a gap over its whole range', () => {
    const r = readDayRelease(dayRelease(DAY, [UNITS[0]!, { from: 452_701_000, to: 452_701_999, firstS: t('22:04:00'), lastS: t('22:08:00'), unfinished: true }]), DAY);
    expect(r.units.find((u) => u.fromSlot === 452_701_000n)).toMatchObject({ covered: false, reason: expect.stringContaining('unfinished') });
  });
});

describe('SEED-1 RPC backfill', () => {
  it('seeds the same create event FEED-1 builds live from the same transaction', () => {
    for (const f of CREATES) {
      const r = recordOf(f);
      const frame: Frame = { seq: 1, receivedAt: 0, source: 'helius', backfilled: false, place: { at: 'chain', slot: r.slot }, duplicate: false, body: { type: 'tx', record: r } };
      const live = eventsOfFrame(frame, new Map([[r.signature, 0]])).filter((e) => e.kind === 'market' && e.key.startsWith('pump:CreateEvent:')) as MarketEvent[];
      const seeded = createEventsOf(r, 0, 1);
      expect(seeded.map((e) => [e.id, e.key, (e.value as { event: unknown }).event])).toEqual(live.map((e) => [e.id, e.key, (e.value as { event: unknown }).event]));
      expect(seeded.length).toBeGreaterThan(0);
      for (const e of seeded) expect(createOf(e.value)).not.toBeNull();
    }
  });

  it('builds a seed from days then RPC: start at the first unit, gaps for the defective unit, the hole and nothing else', async () => {
    const rpc = fakeRpc(SIGS, byFixture);
    const seed = await buildSeed(seedOpts({ rpcImpl: rpc }));
    expect(seed.report.start).toEqual({ slot: 452_700_000n, ms: t('22:00:00') * 1_000 });
    expect(seed.report.gaps.map((g) => [g.fromSlot, g.toSlot])).toEqual([[452_701_000n, 452_702_499n]]);
    expect(seed.report.rpc?.result).toMatchObject({ stoppedBy: 'done', creates: CREATES.length, droppedFuture: 1 });
    // Day creates (before the boundary) then the RPC creates, in release order, each parseable as FEED-1's create.
    const mints = seed.creates.map((e) => createOf(e.value)!.mint);
    expect(mints.slice(0, 4)).toEqual(['MintA1', 'MintA2', 'MintB1', 'MintC1']);
    expect(mints).toHaveLength(4 + CREATES.length);
    expect(seed.coverage.map((e) => e.key)).toEqual(['coverage:creates:start', 'coverage:creates:gap']);
    expect(seed.report.rugs).toBe(RUGS_NOT_SEEDED);
    expect(seed.coverage.some((e) => e.key.startsWith('coverage:rugs'))).toBe(false);
    // A failed create is never fetched; paging stopped at the days' last slot.
    expect(rpc.fetched).toEqual(CREATES.map(sigOf).sort((a, b) => (a.slot > b.slot ? -1 : 1)).map((s) => s.signature));
  });

  it('leak test: a future-only marker after the process start is never fetched, seeded or visible', async () => {
    const rpc = fakeRpc(SIGS, byFixture);
    const seed = await buildSeed(seedOpts({ rpcImpl: rpc }));
    expect(rpc.fetched).not.toContain(FUTURE_SIG.signature);
    for (const e of [...seed.creates, ...seed.coverage]) {
      expect(e.moment.slot <= ASOF.slot && e.moment.receivedAt <= ASOF.receivedAt).toBe(true);
      expect(JSON.stringify(e, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))).not.toContain('FutureOnlyMarker');
    }
    // Day data after the process start is dropped too: with asOf before the last unit, its creates do not enter.
    const early: Moment = { slot: 452_700_150n, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: t('22:00:45') * 1_000 };
    const s2 = await buildSeed({ days: [{ dir: dayRelease(DAY, UNITS), day: DAY }], untilSlot: 452_700_150n, asOf: early });
    expect(s2.creates.map((e) => createOf(e.value)!.mint)).toEqual(['MintA1']);
    expect(s2.report.droppedFuture).toBe(3);
    for (const e of s2.coverage) expect(e.moment.slot <= early.slot && e.moment.receivedAt <= early.receivedAt).toBe(true);
    const idx = new DeployerIndex();
    idx.seed(s2.creates, s2.coverage, early);
    expect(idx.factFor(CREATOR, { ...early, slot: 10n ** 12n, receivedAt: Number.MAX_SAFE_INTEGER }, 0).mints.map((m) => m.mint)).toEqual(['MintA1']);
  });

  it('a 429 backs off exponentially and retries; an unreadable transaction leaves a one-slot gap and the rest continue', async () => {
    const timers = instantTimers();
    let tries = 0;
    const first = CREATES.map(sigOf).sort((a, b) => (a.slot > b.slot ? -1 : 1))[0]!;
    const second = CREATES.map(sigOf).sort((a, b) => (a.slot > b.slot ? -1 : 1))[1]!;
    const rpc = fakeRpc(SIGS, (sig) => {
      if (sig === first.signature && tries++ < 2) throw new ProviderError('helius', 'rate_limited', 'rate limited', 429);
      if (sig === second.signature) throw new ProviderError('helius', 'timeout', 'timed out');
      return byFixture(sig);
    });
    const seed = await buildSeed(seedOpts({ rpcImpl: rpc, timers }));
    expect(timers.waits).toEqual([2_000, 4_000, 2_000, 4_000, 8_000]);
    expect(seed.report.gaps).toContainEqual(expect.objectContaining({ fromSlot: second.slot, toSlot: second.slot, reason: expect.stringContaining('timed out') }));
    expect(seed.report.rpc?.result).toMatchObject({ stoppedBy: 'done', retries: 5, creates: CREATES.length - 1 });
  });

  it('a shape or decode failure is not retried: one attempt, a one-slot gap', async () => {
    const timers = instantTimers();
    const one = CREATES.map(sigOf)[0]!;
    const rpc = fakeRpc(SIGS, (sig) => { if (sig === one.signature) throw new ProviderError('helius', 'shape', 'bad'); return byFixture(sig); });
    const seed = await buildSeed(seedOpts({ rpcImpl: rpc, timers }));
    expect(timers.waits).toEqual([]);
    expect(seed.report.gaps.some((g) => g.fromSlot <= one.slot && g.toSlot >= one.slot)).toBe(true);
  });

  it('a signature page that keeps failing stops the run: everything not yet done is a bounded gap', async () => {
    const rpc = fakeRpc(SIGS, byFixture, { pageFault: () => new ProviderError('helius', 'http', 'HTTP 503', 503) });
    const seed = await buildSeed(seedOpts({ rpcImpl: rpc }));
    expect(rpc.pages).toHaveLength(4);
    expect(seed.report.rpc?.result.stoppedBy).toBe('page-failed');
    expect(seed.report.gaps).toContainEqual(expect.objectContaining({ fromSlot: 452_702_901n, toSlot: UNTIL }));
    expect(seed.report.gaps.at(-1)!.atMs).toBe(ASOF.receivedAt); // nothing seen: dated at the process start
  });

  it('an abort (the worker stopped waiting for the seed) stops the run before its next call: nothing is fetched after it', async () => {
    const ctl = new AbortController();
    const inner = fakeRpc(SIGS, byFixture);
    // The worker's seed wait runs out while the first page is in flight.
    const rpc: SeedRpc = { ...inner, getSignaturesForAddress: async (...a) => inner.getSignaturesForAddress(...a).finally(() => ctl.abort()) };
    const seed = await buildSeed(seedOpts({ rpc: { rpc, timers: instantTimers(), creditCap: 1_000, provider: 'helius', signal: ctl.signal } }));
    expect(inner.pages).toHaveLength(1);
    expect(inner.fetched).toEqual([]);
    expect(seed.report.rpc?.result).toMatchObject({ stoppedBy: 'aborted', creates: 0 });
    // Everything from the signature whose transaction was not fetched down is a gap.
    const newest = CREATES.map(sigOf).sort((x, y) => (x.slot > y.slot ? -1 : 1))[0]!;
    expect(seed.report.gaps.at(-1)).toMatchObject({ fromSlot: 452_702_901n, toSlot: newest.slot });
  });

  it('budget exhaustion: the credit cap stops the run newest first, and the unfetched old end is a gap', async () => {
    const seed = await buildSeed(seedOpts({ creditCap: 3 })); // 1 page + 2 transactions
    const sorted = CREATES.map(sigOf).sort((a, b) => (a.slot > b.slot ? -1 : 1));
    expect(seed.report.rpc?.result).toMatchObject({ stoppedBy: 'credit-cap', creditsUsed: 3, creates: 2 });
    const gap = seed.report.gaps.at(-1)!;
    expect(gap).toMatchObject({ fromSlot: 452_702_901n, toSlot: sorted[2]!.slot });
    // The gap is inside the look-back from now, so H14 is not covered.
    expect(coverageAt(seed.coverage, ASOF, ASOF.receivedAt - 14 * DAY_MS).covered).toBe(false);
  });

  it("the provider's 70% halt stops the run through the real scheduler, never past it", async () => {
    const used = 0.7 * 1_000_000 - 3;
    const scheduler = new Scheduler({ ...HELIUS_FREE, window: { limit: 1_000, windowMs: 1_000 } }, { timers: new ManualTimers(0), creditsUsed: used });
    const http = scriptedHttp(rpcHandler((method, params) => {
      if (method === 'getSignaturesForAddress') return SIGS.map((s) => ({ signature: s.signature, slot: Number(s.slot), err: s.err, blockTime: s.blockTime }));
      const f = CREATES.find((x) => x.signature === (params[0] as string));
      return f === undefined ? null : f.base64;
    }));
    const rpc = new RpcHttp({ provider: 'helius', url: () => 'https://rpc.test/', http, scheduler, timeoutMs: 1_000 });
    const seed = await buildSeed(seedOpts({ rpcImpl: rpc, creditCap: 1_000_000 }));
    expect(seed.report.rpc?.result).toMatchObject({ stoppedBy: 'halted', creates: 2 });
    expect(scheduler.status().creditsUsed).toBe(0.7 * 1_000_000);
    expect(scheduler.halted).toBe(true);
  });

  it('the cost estimate is reported: about 64k credits a day of catch-up, so 14 days exceed the 70% halt', async () => {
    const perDay = estimateBackfillCredits(DAY_MS, 'helius');
    expect(perDay).toBe(64_101);
    expect(estimateBackfillCredits(14 * DAY_MS, 'helius')).toBeGreaterThan(0.7 * 1_000_000);
    const seed = await buildSeed(seedOpts());
    expect(seed.report.rpc).toMatchObject({ estimatedCredits: expect.any(Number), creditCap: 1_000, fitsCap: false });
  });
});

describe('SEED-1 end to end with the index and H14 coverage', () => {
  const NOW: Moment = { ...ASOF, slot: ASOF.slot + 100n, receivedAt: ASOF.receivedAt + 1_000 };

  it('a gap-free seed covers a restart; the seeded gap keeps H14 not covered until it leaves the look-back', async () => {
    // Clean days and a complete backfill: covered from the first unit.
    const clean = UNITS.filter((u) => u.stats === undefined).map((u, i) => (i === 1 ? { ...u, from: 452_701_000 } : u));
    const seed = await buildSeed(seedOpts({ days: [{ dir: dayRelease(DAY, clean), day: DAY }] }));
    expect(seed.report.gaps).toEqual([]);
    const windowStart = seed.report.start!.ms; // the look-back starts at the seeded start
    expect(coverageAt(seed.coverage, NOW, windowStart)).toEqual({ covered: true, fromMs: windowStart });
    const idx = new DeployerIndex();
    idx.seed(seed.creates, seed.coverage, ASOF);
    expect(idx.factFor(CREATOR, NOW, windowStart).coverageFromMs).toBe(windowStart);
    expect(idx.factFor(CREATOR, NOW, windowStart).mints.map((m) => m.mint)).toEqual(['MintA1', 'MintA2', 'MintC1']);
    // With the defective unit: not covered while its gap is in the window, covered once the window starts after it.
    const gappy = await buildSeed(seedOpts());
    expect(coverageAt(gappy.coverage, NOW, windowStart).covered).toBe(false);
    // The merged gap (unit B and the hole after it) is dated at the next known block, unit C's first (23:58:00).
    expect(coverageAt(gappy.coverage, NOW, t('23:57:59') * 1_000).covered).toBe(false);
    expect(coverageAt(gappy.coverage, NOW, t('23:58:01') * 1_000).covered).toBe(true);
  });

  it('restart re-seed: a second process seeds the same data identically, and a later restart extends it', async () => {
    const days = [{ dir: dayRelease(DAY, UNITS), day: DAY }];
    const a = await buildSeed(seedOpts({ days }));
    const b = await buildSeed(seedOpts({ days }));
    const plain = (x: unknown) => JSON.stringify(x, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v));
    expect(plain(b.creates)).toBe(plain(a.creates));
    expect(plain(b.coverage)).toBe(plain(a.coverage));
    // Restarted before the newest creates existed: those are left out, and come in on the next restart's seed.
    const sorted = CREATES.map(sigOf).sort((x, y) => (x.slot > y.slot ? -1 : 1));
    const earlyUntil = sorted[0]!.slot - 1n;
    const earlyAsOf: Moment = { ...ASOF, slot: earlyUntil, receivedAt: sorted[0]!.blockTime! * 1_000 - 1 };
    const early = await buildSeed(seedOpts({ days, untilSlot: earlyUntil, asOf: earlyAsOf }));
    expect(early.creates.length).toBeLessThan(a.creates.length);
    for (const e of early.creates) expect(e.moment.slot <= earlyUntil).toBe(true);
    const i1 = new DeployerIndex();
    i1.seed(early.creates, early.coverage, earlyAsOf);
    const i2 = new DeployerIndex();
    i2.seed(a.creates, a.coverage, ASOF);
    const creatorOf = createOf(a.creates.at(-1)!.value)!.creator;
    expect(i2.factFor(creatorOf, NOW, 0).mints.length).toBeGreaterThan(i1.factFor(creatorOf, NOW, 0).mints.length);
  });

  it('without days or RPC configured past the last day, the missing range up to the live start is a gap', async () => {
    const seed = await buildSeed({ days: [{ dir: dayRelease(DAY, UNITS), day: DAY }], untilSlot: UNTIL, asOf: ASOF });
    expect(seed.report.gaps.at(-1)).toMatchObject({ fromSlot: 452_702_901n, toSlot: UNTIL, reason: 'no RPC backfill configured', atMs: ASOF.receivedAt });
    expect(coverageAt(seed.coverage, NOW, ASOF.receivedAt - DAY_MS).covered).toBe(false);
  });

  it('an RPC-only seed starts at the given look-back slot', async () => {
    const from = { slot: 452_941_000n, ms: 1_791_032_400_000 };
    const seed = await buildSeed({ days: [], rpc: { rpc: fakeRpc(SIGS, byFixture), timers: instantTimers(), creditCap: 100, provider: 'helius' }, rpcFrom: from, untilSlot: UNTIL, asOf: ASOF });
    expect(seed.report.start?.slot).toBe(452_941_000n);
    expect(seed.report.gaps).toEqual([]);
    expect(seed.creates).toHaveLength(CREATES.length);
    await expect(buildSeed({ days: [], rpc: { rpc: fakeRpc([], byFixture), timers: instantTimers(), creditCap: 1, provider: 'helius' }, untilSlot: UNTIL, asOf: ASOF })).rejects.toThrow(/rpcFrom/);
  });
});

describe('SEED-1 downtime fill after a restart with saved state (supervisor ruling 2026-10-04)', () => {
  const VIA = 'logs:creates';
  const DOWN_FROM = 452_941_100n; // first slot after the saved state
  const DOWN_MS = 1_791_032_500_000;
  const wrapped = (value: Record<string, unknown>) => ({ value, source: 'worker', backfilled: false, seq: 1 });
  /** The saved coverage: the watch started 20 days ago and its gap opened at shutdown. */
  const saved: readonly MarketEvent[] = [
    { kind: 'market', id: 'saved-start', moment: { slot: 445_000_000n, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: DOWN_MS - 20 * DAY_MS }, key: 'coverage:creates:start', value: wrapped({ fromSlot: 445_000_000n, via: VIA }) },
    { kind: 'market', id: 'saved-gap', moment: { slot: DOWN_FROM, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: DOWN_MS }, key: 'coverage:creates:gap', value: wrapped({ fromSlot: DOWN_FROM, toSlot: null, reason: 'shutdown', via: VIA }) },
  ];
  const NOW: Moment = { ...ASOF, slot: ASOF.slot + 100n, receivedAt: ASOF.receivedAt + 1_000 };
  /** Saved facts, then the fill's facts, then the restarted watch's new start, through an as-of store. */
  /** `savedGap` replaces the saved open gap (its fromSlot and the moment it was reported). */
  const coveredAfter = (fill: readonly MarketEvent[], restartAt: Moment = { ...ASOF }, savedGap?: { fromSlot: bigint; at: Moment }) => {
    const clock = new SimClock({ slot: 0n, txIndex: 0, ixIndex: 0, receivedAt: Number.MIN_SAFE_INTEGER });
    const store = new AsOfStore(clock);
    // The feed's own id for an off-chain fact (`<key>#<seq>`): order on a tie must come from the moment, not the id.
    const restart: MarketEvent = { kind: 'market', id: 'coverage:creates:start#99', moment: restartAt, key: 'coverage:creates:start', value: wrapped({ fromSlot: UNTIL, via: VIA }) };
    const base = savedGap === undefined ? saved : [saved[0]!, { ...saved[1]!, id: 'zz-saved-gap' /* sorts after the fill's ids: order must come from the moment */, moment: savedGap.at, value: wrapped({ fromSlot: savedGap.fromSlot, toSlot: null, reason: 'shutdown', via: VIA }) }];
    for (const e of [...base, ...fill, restart].sort(compareEvents)) {
      clock.advanceTo(e.moment);
      store.record(e.key, e.value, e.moment, e.id);
    }
    clock.advanceTo(NOW);
    return createsCoverage((k, f, to) => store.history(k, f, to), NOW, NOW.receivedAt - 14 * DAY_MS);
  };
  const fillOpts = (over: { creditCap?: number; rpc?: false; liveStart?: Moment } = {}): SeedOptions => ({
    days: [], untilSlot: UNTIL, asOf: ASOF, fill: { fromSlot: DOWN_FROM, fromMs: DOWN_MS, close: { via: VIA, fromSlot: DOWN_FROM }, liveStart: over.liveStart ?? { ...ASOF } },
    ...(over.rpc === false ? {} : { rpc: { rpc: fakeRpc(SIGS, byFixture), timers: instantTimers(), creditCap: over.creditCap ?? 100, provider: 'helius' } }),
  });

  it('a restart without a fill is not covered: the new start settles the open gap as lossy', () => {
    expect(coveredAfter([]).covered).toBe(false);
  });

  it('a complete fill backfills only the downtime and closes the saved gap with a resume: coverage stays continuous', async () => {
    const seed = await buildSeed(fillOpts());
    expect(seed.report).toMatchObject({ mode: 'fill', start: null, gaps: [] });
    expect(seed.report.rpc?.result).toMatchObject({ stoppedBy: 'done', creates: CREATES.length, creditsUsed: 1 + CREATES.length });
    expect(seed.coverage.map((e) => [e.key, (e.value as { value: { via: string } }).value.via])).toEqual([['coverage:creates:resume', VIA]]);
    expect(coveredAfter(seed.coverage).covered).toBe(true);
    // Fill creates reach the restored index, which has already seen live events, through fill(), and count.
    const idx = new DeployerIndex();
    for (const e of saved) idx.observe(e);
    idx.observe({ kind: 'market', id: 'live-tick', moment: { ...ASOF }, key: 'tick', value: 0 });
    idx.fill(seed.creates, ASOF);
    const creator = createOf(seed.creates[0]!.value)!.creator;
    expect(idx.factFor(creator, NOW, 0).mints.length).toBeGreaterThan(0);
  });

  it('the close is dated from the live start fact wherever it lands: at, one and two slots below untilSlot, or at released+1 with no tip', async () => {
    const off = (slot: bigint): Moment => ({ slot, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: ASOF.receivedAt - 1_000 });
    // The last: a restart timed at the downtime's first block, so the close's time comes from liveStart - 1 ms.
    for (const liveStart of [off(UNTIL), off(UNTIL - 1n), off(UNTIL - 2n), off(DOWN_FROM + 1n), { ...off(UNTIL), receivedAt: DOWN_MS }]) {
      const seed = await buildSeed(fillOpts({ liveStart }));
      const close = seed.coverage.at(-1)!;
      expect(close.key).toBe('coverage:creates:resume');
      expect(compareEvents(close, { moment: liveStart, id: 'coverage:creates:start#99' })).toBeLessThan(0);
      expect(coveredAfter(seed.coverage, liveStart).covered).toBe(true);
    }
  });

  it('a fill whose saved gap starts after untilSlot (failover, a node behind the saved state) is empty and complete: no RPC, a resume', async () => {
    const rpc = fakeRpc(SIGS, byFixture);
    const liveStart: Moment = { slot: UNTIL, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: ASOF.receivedAt - 1_000 };
    // The saved state reached UNTIL+3; its open gap was reported there, after the restarted watch's start in order.
    const at: Moment = { slot: UNTIL + 3n, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: ASOF.receivedAt - 5_000 };
    for (const close of [{ via: VIA, fromSlot: UNTIL + 3n, at }, { via: VIA, fromSlot: null, at }]) {
      const seed = await buildSeed({ ...fillOpts({ liveStart }), rpc: { rpc, timers: instantTimers(), creditCap: 100, provider: 'helius' }, fill: { fromSlot: UNTIL + 3n, fromMs: DOWN_MS, close, liveStart } });
      expect(rpc.pages).toEqual([]);
      expect(seed.report).toMatchObject({ mode: 'fill', gaps: [], rpc: null, creates: 0 });
      expect(seed.coverage.map((e) => e.key)).toEqual(['coverage:creates:resume']);
      expect(coveredAfter(seed.coverage, liveStart, { fromSlot: close.fromSlot ?? UNTIL + 3n, at }).covered).toBe(close.fromSlot !== null);
    }
  });

  it('the fetch starts at the saved open gap\'s start when it is older than fill.fromSlot: no unfetched slot is restored', async () => {
    const liveStart: Moment = { slot: UNTIL, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: ASOF.receivedAt - 1_000 };
    const later = DOWN_FROM + 100n;
    const seed = await buildSeed({ ...fillOpts({ liveStart }), fill: { fromSlot: later, fromMs: DOWN_MS, close: { via: VIA, fromSlot: DOWN_FROM }, liveStart } });
    expect(seed.report.rpc?.fromSlot).toBe(DOWN_FROM);
    expect(coveredAfter(seed.coverage, liveStart).covered).toBe(true);
    // Its history ends between the two: not covered.
    const cut = await buildSeed({
      ...fillOpts({ liveStart }), rpc: { rpc: fakeRpc(SIGS.filter((x) => x.slot > later || x.slot === UNTIL + 1n || x.slot === UNTIL), byFixture), timers: instantTimers(), creditCap: 100, provider: 'helius' },
      fill: { fromSlot: later, fromMs: DOWN_MS, close: { via: VIA, fromSlot: DOWN_FROM }, liveStart },
    });
    expect(cut.report.rpc?.result.stoppedBy).toBe('history-end');
    expect(coveredAfter(cut.coverage, liveStart).covered).toBe(false);
  });

  it('an "empty" fill whose saved gap starts by untilSlot still fetches that range', async () => {
    const liveStart: Moment = { slot: UNTIL, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: ASOF.receivedAt - 1_000 };
    const rpc = fakeRpc(SIGS, byFixture);
    const seed = await buildSeed({ ...fillOpts({ liveStart }), rpc: { rpc, timers: instantTimers(), creditCap: 100, provider: 'helius' }, fill: { fromSlot: UNTIL + 3n, fromMs: DOWN_MS, close: { via: VIA, fromSlot: DOWN_FROM }, liveStart } });
    expect(rpc.pages.length).toBeGreaterThan(0);
    expect(seed.report.rpc?.fromSlot).toBe(DOWN_FROM);
    expect(coveredAfter(seed.coverage, liveStart).covered).toBe(true);
    // Without RPC it is a gap, not a resume.
    const none = await buildSeed({ ...fillOpts({ rpc: false, liveStart }), fill: { fromSlot: UNTIL + 3n, fromMs: DOWN_MS, close: { via: VIA, fromSlot: DOWN_FROM }, liveStart } });
    expect(none.coverage.at(-1)!.key).toBe('coverage:creates:gap');
    expect(coveredAfter(none.coverage, liveStart).covered).toBe(false);
  });

  it('a live start placed below the saved gap\'s opening: without close.at the gap stays open (fail safe); with it the close follows the gap', async () => {
    const liveStart: Moment = { slot: DOWN_FROM - 1n, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: DOWN_MS - 1 };
    const seed = await buildSeed(fillOpts({ liveStart }));
    expect(coveredAfter(seed.coverage, liveStart).covered).toBe(false);
    const at: Moment = { slot: DOWN_FROM, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: DOWN_MS };
    const withAt = await buildSeed({ ...fillOpts({ liveStart }), fill: { fromSlot: DOWN_FROM, fromMs: DOWN_MS, close: { via: VIA, fromSlot: DOWN_FROM, at }, liveStart } });
    expect(compareEvents(withAt.coverage.at(-1)!, { moment: at, id: 'saved-gap' })).toBeGreaterThan(0);
    expect(coveredAfter(withAt.coverage, liveStart, { fromSlot: DOWN_FROM, at }).covered).toBe(true);
  });

  it('an incomplete fill leaves bounded gaps and closes the saved gap as lossy: not covered', async () => {
    const seed = await buildSeed(fillOpts({ creditCap: 2 }));
    expect(seed.report.rpc?.result.stoppedBy).toBe('credit-cap');
    expect(seed.coverage.map((e) => e.key)).toEqual(['coverage:creates:gap', 'coverage:creates:gap']);
    expect(seed.coverage.at(-1)!.value).toMatchObject({ value: { fromSlot: DOWN_FROM, toSlot: UNTIL, via: VIA } });
    expect(coveredAfter(seed.coverage).covered).toBe(false);
  });

  it('a fill with no RPC configured is one gap over the whole downtime', async () => {
    const seed = await buildSeed(fillOpts({ rpc: false }));
    expect(seed.report.gaps).toEqual([expect.objectContaining({ fromSlot: DOWN_FROM, toSlot: UNTIL, reason: 'no RPC backfill configured' })]);
    expect(coveredAfter(seed.coverage).covered).toBe(false);
  });

  it('as-of: a close.at or liveStart after the process start is refused, so no coverage fact is dated after it', async () => {
    const after: Moment = { slot: ASOF.slot + 1_000n, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: ASOF.receivedAt + 60_000 };
    await expect(buildSeed({ ...fillOpts(), fill: { fromSlot: DOWN_FROM, fromMs: DOWN_MS, close: { via: VIA, fromSlot: DOWN_FROM, at: after }, liveStart: { ...ASOF } } })).rejects.toThrow(/after the process start/);
    await expect(buildSeed({ ...fillOpts(), fill: { fromSlot: DOWN_FROM, fromMs: DOWN_MS, close: { via: VIA, fromSlot: DOWN_FROM }, liveStart: after } })).rejects.toThrow(/after the process start/);
    // Exactly at asOf is allowed.
    const ok = await buildSeed({ ...fillOpts(), fill: { fromSlot: DOWN_FROM, fromMs: DOWN_MS, close: { via: VIA, fromSlot: DOWN_FROM, at: { ...ASOF, receivedAt: ASOF.receivedAt - 1 } }, liveStart: { ...ASOF } } });
    for (const e of ok.coverage) expect(compareMoments(e.moment, ASOF) <= 0).toBe(true);
    // close.at exactly at asOf: following it by 1 ms would date the close after asOf, so no close is made (the saved
    // gap stays open: fail safe).
    const equal = await buildSeed({ ...fillOpts(), fill: { fromSlot: DOWN_FROM, fromMs: DOWN_MS, close: { via: VIA, fromSlot: DOWN_FROM, at: { ...ASOF } }, liveStart: { ...ASOF } } });
    for (const e of equal.coverage) expect(compareMoments(e.moment, ASOF) <= 0).toBe(true);
    expect(equal.coverage.some((e) => e.key === 'coverage:creates:resume')).toBe(false);
  });

  it('a fill takes no day releases, and a close needs the live start fact', async () => {
    await expect(buildSeed({ ...fillOpts(), days: [{ dir: dayRelease(DAY, UNITS), day: DAY }] })).rejects.toThrow(/neither day releases/);
    await expect(buildSeed({ ...fillOpts(), fill: { fromSlot: DOWN_FROM, fromMs: DOWN_MS, close: { via: VIA, fromSlot: DOWN_FROM } } })).rejects.toThrow(/liveStart/);
  });
});

describe('SEED-1 review fixes', () => {
  const sorted = () => CREATES.map(sigOf).sort((a, b) => (a.slot > b.slot ? -1 : a.slot < b.slot ? 1 : 0));

  it('history end before afterSlot is not done: drop the oldest signature and the rest of the range is a gap', async () => {
    const rpc = fakeRpc(SIGS.slice(0, -1), byFixture);
    const seed = await buildSeed(seedOpts({ rpcImpl: rpc }));
    expect(seed.report.rpc?.result).toMatchObject({ stoppedBy: 'history-end', creates: CREATES.length });
    expect(seed.report.gaps.at(-1)).toMatchObject({ fromSlot: 452_702_901n, toSlot: 452_941_170n });
    // An empty first page is the same.
    const empty = await buildSeed(seedOpts({ rpcImpl: fakeRpc([], byFixture) }));
    expect(empty.report.rpc?.result.stoppedBy).toBe('history-end');
    expect(empty.report.gaps.at(-1)).toMatchObject({ fromSlot: 452_702_901n, toSlot: UNTIL });
  });

  it('the first page waits for confirmed to reach untilSlot (minContextSlot); never reached is a gap up to it', async () => {
    let refusals = 2;
    const notYet = () => new ProviderError('helius', 'rpc', 'getSignaturesForAddress error -32016');
    const rpc = fakeRpc(SIGS, byFixture, { pageFault: () => (refusals-- > 0 ? notYet() : null) });
    const timers = instantTimers();
    const seed = await buildSeed(seedOpts({ rpcImpl: rpc, timers }));
    expect(rpc.contexts[0]).toBe(UNTIL);
    expect(rpc.contexts.slice(3)).toEqual(rpc.contexts.slice(3).map(() => undefined)); // later pages page by `before`
    expect(timers.waits).toEqual([2_000, 4_000]);
    expect(seed.report.rpc?.result.stoppedBy).toBe('done');
    const never = await buildSeed(seedOpts({ rpcImpl: fakeRpc(SIGS, byFixture, { pageFault: notYet }) }));
    expect(never.report.rpc?.result.stoppedBy).toBe('not-confirmed');
    expect(never.report.gaps.at(-1)).toMatchObject({ fromSlot: 452_702_901n, toSlot: UNTIL });
  });

  it('RpcHttp sends minContextSlot and its -32016 answer is retried, through the real client', async () => {
    let n = 0;
    const scheduler = new Scheduler({ ...HELIUS_FREE, window: { limit: 1_000, windowMs: 1_000 } }, { timers: new ManualTimers(0) });
    const seen: unknown[] = [];
    const http = scriptedHttp((req) => {
      const body = JSON.parse(req.body!) as { id: number; method: string; params: unknown[] };
      if (body.method === 'getSignaturesForAddress') seen.push((body.params[1] as Record<string, unknown>)['minContextSlot']);
      if (body.method === 'getSignaturesForAddress' && n++ === 0) return { status: 200, header: () => null, text: JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32016, message: 'Minimum context slot has not been reached' } }) };
      return rpcHandler((method, params) => {
        if (method === 'getSignaturesForAddress') return SIGS.map((x) => ({ signature: x.signature, slot: Number(x.slot), err: x.err, blockTime: x.blockTime }));
        const f = CREATES.find((x) => x.signature === (params[0] as string));
        return f === undefined ? null : f.base64;
      })(req);
    });
    const rpc = new RpcHttp({ provider: 'helius', url: () => 'https://rpc.test/', http, scheduler, timeoutMs: 1_000 });
    const seed = await buildSeed(seedOpts({ rpcImpl: rpc }));
    expect(seen.slice(0, 2)).toEqual([Number(UNTIL), Number(UNTIL)]);
    expect(seed.report.rpc?.result).toMatchObject({ stoppedBy: 'done', retries: 1, creates: CREATES.length });
  });

  it('the UNTIL+1 marker is dropped and a signature at exactly untilSlot is kept in range', async () => {
    const rpc = fakeRpc(SIGS, byFixture);
    const seed = await buildSeed(seedOpts({ rpcImpl: rpc }));
    expect(seed.report.rpc?.result.droppedFuture).toBe(1);
    expect(rpc.fetched).not.toContain(FUTURE_SIG.signature);
  });

  it('a transaction whose slot differs from its signature is a one-slot gap, never seeded', async () => {
    const one = sorted()[0]!;
    const rpc = fakeRpc(SIGS, (sig) => (sig === one.signature ? { ...byFixture(sig)!, slot: one.slot + 1n } : byFixture(sig)));
    const seed = await buildSeed(seedOpts({ rpcImpl: rpc }));
    expect(seed.report.gaps).toContainEqual(expect.objectContaining({ fromSlot: one.slot, toSlot: one.slot, reason: expect.stringContaining('differs') }));
    expect(seed.creates.some((e) => e.id.includes(one.signature))).toBe(false);
  });

  it('a create placed by slot before untilSlot but timed after the process start is dropped', async () => {
    // asOf in a later slot but at an earlier time than unit A's second create (22:01:00).
    const asOf: Moment = { slot: 452_800_000n, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: t('22:00:45') * 1_000 };
    const seed = await buildSeed({ days: [{ dir: dayRelease(DAY, UNITS.slice(0, 1)), day: DAY }], untilSlot: 452_700_999n, asOf });
    expect(seed.creates.map((e) => createOf(e.value)!.mint)).toEqual(['MintA1']);
    expect(seed.report.droppedFuture).toBe(1);
  });

  it('a unit in two days (crossing midnight) that is defective in either copy is a gap', async () => {
    const shared: UnitSpec = { from: 452_699_000, to: 452_699_999, firstS: S('2026-09-30T23:59:00Z'), lastS: S('2026-10-01T00:01:00Z') };
    const bad: UnitSpec = { ...shared, stats: { missing_meta: 1 } };
    for (const [first, second] of [[shared, bad], [bad, shared]] as const) {
      const seed = await buildSeed({
        days: [{ dir: dayRelease('2026-09-30', [first]), day: '2026-09-30' }, { dir: dayRelease(DAY, [second, UNITS[0]!]), day: DAY }], untilSlot: 452_700_999n, asOf: ASOF,
      });
      expect(seed.report.gaps[0]).toMatchObject({ fromSlot: 452_699_000n, toSlot: 452_699_999n, reason: expect.stringContaining('without meta') });
    }
  });

  it('a missing or corrupt day is dropped and reported; its range becomes a gap, or RPC covers it when it was the last day', async () => {
    const mid = '2026-09-30';
    const missing = mkdtempSync(join(tmpdir(), 'seed-missing-'));
    dirs.push(missing);
    const early: UnitSpec = { from: 452_600_000, to: 452_600_999, firstS: S('2026-09-30T10:00:00Z'), lastS: S('2026-09-30T10:04:00Z') };
    const seed = await buildSeed({ ...seedOpts(), days: [{ dir: dayRelease('2026-09-29', [early]), day: '2026-09-29' }, { dir: missing, day: mid }, { dir: dayRelease(DAY, UNITS), day: DAY }] });
    expect(seed.report.days.find((d) => d.day === mid)).toMatchObject({ error: expect.stringContaining('SHA256SUMS') });
    expect(seed.report.gaps[0]).toMatchObject({ fromSlot: 452_601_000n, toSlot: 452_699_999n });
    // The last day corrupt: dropped, and the RPC backfill starts after the previous day's last slot.
    const corrupt = dayRelease(DAY, UNITS, (d) => writeFileSync(join(d, `units-${DAY}.tar.part00`), 'altered'));
    const older: SignatureInfo = { signature: 'OlderThanEarly11111111111111111111111111111', slot: 452_600_500n, err: null, blockTime: S('2026-09-30T10:02:00Z') };
    const s2 = await buildSeed({ ...seedOpts({ rpcImpl: fakeRpc([...SIGS, older], byFixture) }), days: [{ dir: dayRelease('2026-09-29', [early]), day: '2026-09-29' }, { dir: corrupt, day: DAY }] });
    expect(s2.report.days.find((d) => d.day === DAY)).toMatchObject({ error: expect.stringContaining('sha256') });
    expect(s2.report.rpc?.fromSlot).toBe(452_601_000n);
    expect(s2.report.rpc?.result.stoppedBy).toBe('done');
    // Every day failing with no rpcFrom: nothing to start from, so nothing is seeded and no RPC runs.
    const s3 = await buildSeed({ ...seedOpts(), days: [{ dir: corrupt, day: DAY }] });
    expect(s3.report).toMatchObject({ start: null, rpc: null, creates: 0 });
    expect(s3.coverage).toEqual([]);
  });

  it('a day whose strict QA or decoder parity failed, or whose report is missing, is refused', () => {
    const failing = [
      [(d: string) => writeFileSync(join(d, `qa-${DAY}.json`), JSON.stringify({ strict: { pass: false, misses: ['x'] } })), /strict QA did not pass/],
      [(d: string) => writeFileSync(join(d, `parity-${DAY}.json`), JSON.stringify({ mismatch_count: 1, missing_row_count: 0 })), /decoder parity failed/],
      [(d: string) => writeFileSync(join(d, `parity-${DAY}.json`), JSON.stringify({ mismatch_count: 0, missing_row_count: 2 })), /decoder parity failed/],
      [(d: string) => writeFileSync(join(d, `parity-${DAY}.json`), JSON.stringify({})), /decoder parity failed/],
      [(d: string) => writeFileSync(join(d, `qa-${DAY}.json`), 'not json'), /cannot be read/],
    ] as const;
    for (const [bad, msg] of failing) expect(() => readDayRelease(dayRelease(DAY, UNITS, undefined, bad), DAY)).toThrow(msg);
    // Not listed in SHA256SUMS: refused even if present.
    const unlisted = dayRelease(DAY, UNITS, (d) => writeFileSync(join(d, `SHA256SUMS-${DAY}`), readFileSync(join(d, `SHA256SUMS-${DAY}`), 'utf8').split('\n').filter((l) => !l.includes('parity-')).join('\n')));
    expect(() => readDayRelease(unlisted, DAY)).toThrow(/parity-2026-10-01.json is not listed/);
  });
});
