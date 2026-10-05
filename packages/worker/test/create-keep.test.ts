// OOM-MINT (supervisor rulings): a coin that migrates more than CREATE_KEEP_MS after its create is refused
// `create-expired` from the facts (the create's chain time and the migration's), before the regime or any gate. A create
// with no migration seen CREATE_KEEP_MS + CREATE_LATE_MS after it is let go; its coin, if it migrates later, is refused
// on the expired mark. A candidate is never let go while in its window.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CREATE_LATE_MS, LOG_CREATE_PREFIX, createKey } from '../../core/src/gates/index.ts';
import { CREATE_KEEP_MS } from '../src/engine/strategy.ts';
import { blockNetwork } from './helpers.ts';
import { DEV, MIGRATED_AT, MINT, T, type Harness, makeWorker, passingMarket } from './worker-harness.ts';
import { passingFacts } from '../../core/test/gates/world.ts';
import { KEEP_SLOTS, backtestCoin, expiredIn, judgedIn } from '../../backtest/test/create-keep-world.ts';

blockNetwork();

type Line = { kind: string; ts: string; action?: string; reasons?: string[]; gate_reasons?: { gate: string; code: string; detail?: string }[] };

const CREATE_FACT = passingFacts().get(createKey(MINT))!.value as Record<string, unknown>;
const logCreate = (h: Harness, createdAtMs: number, mint: string = MINT) =>
  h.worker.feed.ingest('helius', { type: 'fact', key: `${LOG_CREATE_PREFIX}${mint}`, value: { event: { program: 'pump', name: 'CreateEvent', data: { mint, creator: DEV, timestamp: BigInt(Math.floor(createdAtMs / 1000)) } }, signature: `createsig${mint.slice(0, 4)}` } }, { receivedAt: h.timers.now() });
const OTHER = 'Other111111111111111111111111111111111111111';

const watch = (h: Harness): string[] => {
  const s = h.worker.strategy;
  const got: string[] = [];
  const own = s.retired.bind(s);
  s.retired = () => {
    const r = own();
    got.push(...r);
    return r;
  };
  return got;
};

const decisions = (h: Harness): Line[] => readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Line).filter((l) => l.kind === 'decision');
const expiredLines = (lines: Line[]) => lines.filter((l) => (l.gate_reasons ?? []).some((g) => g.code === 'create-expired'));

/** The passing market with the create fact's chain time set: `gapMs` before the migration (MIGRATED_AT). */
const byFacts = async (gapMs: number) => {
  const h = makeWorker({});
  const got = watch(h);
  await h.worker.reconcile();
  const m = await passingMarket(h, { heldPoolFacts: true, omit: [createKey(MINT)] });
  m.omit = new Set([...m.omit].filter((k) => k !== createKey(MINT)));
  m.fact(createKey(MINT), { ...CREATE_FACT, createdAtMs: MIGRATED_AT - gapMs });
  await m.run(4_000, 100, () => m.pool());
  await m.run(10_000, 400, () => {
    m.slot();
    m.pool();
  });
  await h.worker.stop();
  return { lines: decisions(h), got, expired: h.worker.strategy.createExpired(MINT) };
};

describe('create-expired from the facts (CREATE_KEEP_MS)', () => {
  it('is twelve hours, and live keeps a create an hour longer before letting it go', () => {
    expect(CREATE_KEEP_MS).toBe(12 * 3_600_000);
    expect(CREATE_LATE_MS).toBe(3_600_000);
  });

  it('review N1: a migration exactly twelve hours after its create is judged as before (it enters)', async () => {
    const r = await byFacts(CREATE_KEEP_MS);
    expect(expiredLines(r.lines)).toEqual([]);
    expect(r.lines.filter((l) => l.action === 'enter')).toHaveLength(1);
    expect(r.expired).toBe(false);
  });

  it('a migration a second past twelve hours is refused create-expired at every judgement, before the regime or any gate', async () => {
    const r = await byFacts(CREATE_KEEP_MS + 1_000);
    expect(r.lines.filter((l) => l.action === 'enter')).toEqual([]);
    // Judgements before the create fact was stated (at T) saw no create; every one after it is the expiry.
    const rejects = r.lines.filter((l) => l.action === 'reject' && Date.parse(l.ts) >= T);
    expect(rejects.length).toBeGreaterThan(0);
    for (const l of rejects) expect(l.gate_reasons).toEqual([{ gate: 'worker', code: 'create-expired', detail: `migrated ${CREATE_KEEP_MS + 1_000} ms after its create; the limit is ${CREATE_KEEP_MS} ms` }]);
    // Refused from the facts: nothing was let go, no expired mark.
    expect(r.expired).toBe(false);
  });
});

describe('a create let go with no migration seen (CREATE_KEEP_MS + CREATE_LATE_MS)', () => {
  /** A create of MINT (chain time `createdAtMs`) released a minute before the migration fact, the create fact itself never stated. */
  const run = async (createdAtMs: number, first?: (h: Harness) => void) => {
    const h = makeWorker({});
    const got = watch(h);
    await h.worker.reconcile();
    const m = await passingMarket(h, { heldPoolFacts: true, omit: [createKey(MINT)], before: { atMs: T - 21 * 60_000, run: () => {
      first?.(h);
      logCreate(h, createdAtMs);
    } } });
    await m.run(4_000, 100, () => m.pool());
    await m.run(10_000, 400, () => {
      m.slot();
      m.pool();
    });
    await h.worker.stop();
    return { lines: decisions(h), got, expired: h.worker.strategy.createExpired(MINT), h };
  };

  it('order-proof: a younger create released first does not hold back an older one released after it', async () => {
    const r = await run(T - 21 * 60_000 - CREATE_KEEP_MS - CREATE_LATE_MS - 1_000, (h) => logCreate(h, T - 21 * 60_000 - 60_000, OTHER));
    expect(r.expired).toBe(true);
    expect(r.got).toContain(MINT);
    expect(r.got).not.toContain(OTHER);
    expect(r.h.worker.strategy.createExpired(OTHER)).toBe(false);
  });

  it('review N1: once its age by its chain time (released only 21 minutes before) passes the keep and the hour, it is let go and its coin is refused on the expired mark, never judged', async () => {
    // Released at T − 21 min, its chain time a second past the keep and the hour before that.
    const r = await run(T - 21 * 60_000 - CREATE_KEEP_MS - CREATE_LATE_MS - 1_000);
    expect(r.expired).toBe(true);
    expect(r.got).toContain(MINT);
    const rejects = r.lines.filter((l) => l.action === 'reject');
    expect(rejects.length).toBeGreaterThan(0);
    for (const l of rejects) expect(l.gate_reasons).toEqual([{ gate: 'worker', code: 'create-expired', detail: 'its create was let go 13 h after it with no migration seen' }]);
  });

  it('review B3: a candidate inside its window across the create\'s let-go time is never let go', async () => {
    // The let-go time falls at T − 15 min, after the migration fact (T − 20 min) made the coin a candidate.
    const created = T - 15 * 60_000 - CREATE_KEEP_MS - CREATE_LATE_MS;
    const r = await run(created);
    expect(r.expired).toBe(false);
    expect(r.got).not.toContain(MINT);
    expect(expiredLines(r.lines)).toEqual([]);
  });
});

describe('review B1: live and the backtest judge a coin alike on both sides of twelve hours', () => {
  // The same create-to-migration gaps through the live worker and through the backtest's study strategy.
  it.each([
    ['exactly twelve hours', 0, false],
    ['1.2 s past twelve hours', 3, true],
  ] as const)('%s: refused create-expired in both or in neither', async (_name, extraSlots, refused) => {
    const live = await byFacts(CREATE_KEEP_MS + extraSlots * 400);
    const bt = backtestCoin(KEEP_SLOTS + extraSlots);
    const liveRefused = live.lines.filter((l) => l.action === 'reject' && Date.parse(l.ts) >= T).some((l) => (l.gate_reasons ?? []).some((g) => g.code === 'create-expired'));
    const btRefused = expiredIn(bt.decisions).length > 0;
    expect([liveRefused, btRefused]).toEqual([refused, refused]);
    // Refused, every judgement after the facts were known is the expiry, on both sides.
    if (refused) {
      expect(live.lines.filter((l) => l.action === 'enter')).toEqual([]);
      expect(expiredIn(bt.decisions)).toEqual(judgedIn(bt.decisions));
    }
  }, 120_000);
});
