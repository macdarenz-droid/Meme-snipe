// WORKER-1d: the saved coverage history is pruned to the look-back (keeping the start that says a stream ran from
// before it, and any gap still open), and a restart no longer stacks `#pre<k>` on the ids of the facts it re-seeds.
// Fifty restarts two days apart keep the saved state and the deployer store bounded, every restart gap inside the
// look-back is kept, and each boot still replays to its own decisions.
import { cpSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUG_CONFIG } from '../../core/src/config/rugs.ts';
import type { MarketEvent, Moment } from '../../core/src/engine/index.ts';
import { type History, createsCoverage, pruneCoverage } from '../../core/src/gates/index.ts';
import { DeployerStore, liveWatchToClose } from '../src/run/deployer-store.ts';
import { replayLedgerFile } from '../../core/src/ledger/replay/index.ts';
import { loadState } from '../src/persist/index.ts';
import { checkSession } from '../src/run/parity.ts';
import { PERSIST_FILE } from '../src/run/worker.ts';
import { Market, T, makeWorker, slotAt, tempState, virtualTimers } from './worker-harness.ts';

const VIA = 'logs:TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';
const DAY = 86_400_000;

const boot = async (h: ReturnType<typeof makeWorker>) => {
  const m = new Market(h);
  const started = h.worker.start();
  while (!h.order.includes('start helius-ws')) await new Promise<void>((r) => setImmediate(r));
  m.slot();
  m.offchain('coverage:creates:start', { fromSlot: slotAt(m.now), via: VIA });
  expect(await started).toEqual({ ok: true });
  await m.run(2_000, 400, () => m.slot());
  return m;
};

describe('WORKER-1d: coverage pruning across restarts', () => {
  it('50 restarts two days apart: the saved state stays bounded, restart gaps inside the look-back are kept, each boot replays', async () => {
    const stateDir = tempState();
    const timers = virtualTimers(T);
    const seed = async () => ({ mode: 'none' as const, creates: [], coverage: [], report: 'test' });
    const sizes: number[] = [];
    const store: number[] = [];
    let h = makeWorker({ stateDir, timers, seed });
    const lookback = (h.session.policy.gates.deployerRugLookbackDays + 1) * DAY;
    const boots: string[] = [];
    const bootAt: number[] = [];
    for (let k = 0; k < 50; k++) {
      if (k > 0) {
        timers.set(timers.now() + 2 * DAY);
        h = makeWorker({ stateDir, timers, seed });
      }
      bootAt.push(timers.now());
      await boot(h);
      boots.push(h.worker.boot);
      await h.worker.stop();
      sizes.push(statSync(join(stateDir, PERSIST_FILE)).size);
      store.push(statSync(join(stateDir, 'deployers.jsonl')).size);
    }
    // Bounded: once the look-back is full (about 8 restarts), the files stop growing.
    const steady = (xs: number[]) => Math.max(...xs.slice(10, 20));
    expect(Math.max(...sizes.slice(30))).toBeLessThanOrEqual(steady(sizes) * 1.1);
    expect(Math.max(...store.slice(30))).toBeLessThanOrEqual(steady(store) * 1.1);
    const saved = loadState(join(stateDir, PERSIST_FILE), RUG_CONFIG);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    // No stacked suffixes.
    expect(saved.coverage.filter((e) => /#pre\d+#pre/.test(e.id))).toEqual([]);
    // Every restart gap received inside the look-back is kept: one per restart in it.
    const retain = timers.now() - lookback;
    const v = (e: { value: unknown }) => (e.value as { value: Record<string, unknown> }).value;
    const restartGaps = saved.coverage.filter((e) => e.key === 'coverage:creates:gap' && v(e)['reason'] === 'restart' && e.moment.receivedAt >= retain);
    const restartsInside = Math.floor(lookback / (2 * DAY));
    expect(restartGaps).toHaveLength(bootAt.filter((t, k) => k > 0 && t >= retain).length);
    // The start that says the watch ran from before the look-back is kept.
    expect(saved.coverage.some((e) => e.key === 'coverage:creates:start' && v(e)['via'] === VIA && e.moment.receivedAt < retain)).toBe(true);
    // The deployer store (what seeds H14 when the state file is missing or discarded) is cut at the same point.
    const fromStore = new DeployerStore(stateDir).load(retain).coverage;
    expect(fromStore.filter((e) => /#pre\d+#pre/.test(e.id))).toEqual([]);
    // Exactly one downtime gap and one live start per boot inside the look-back: none lost to a later cut.
    const inside = bootAt.filter((t, k) => k > 0 && t >= retain).length;
    expect(inside).toBeGreaterThanOrEqual(restartsInside);
    expect(fromStore.filter((e) => e.key === 'coverage:creates:gap' && v(e)['reason'] === 'worker down; no downtime fill' && e.moment.receivedAt >= retain)).toHaveLength(inside);
    expect(fromStore.filter((e) => e.key === 'coverage:creates:start' && v(e)['via'] === VIA && e.moment.receivedAt >= retain)).toHaveLength(inside);
    expect(fromStore.some((e) => e.key === 'coverage:creates:start' && v(e)['via'] === VIA && e.moment.receivedAt < retain)).toBe(true);
    // A replay rebuilds each boot's decisions.
    const r = checkSession(stateDir, { session: h.session, rugs: RUG_CONFIG, strategy: h.worker.strategyConfig }, replayLedgerFile, 1);
    expect(r.boots.map((b) => b.boot)).toEqual(boots);
    for (const b of r.boots) expect(b.divergence, b.boot).toBeNull();
    expect(r.ok).toBe(true);

    // One more boot, then 16 days with no gap, so every lossy restart ages out of the look-back: H14 reads covered,
    // from the start kept from before the look-back. A boot on a copy with the state file removed (seeded from the
    // store alone, the downtime filled) keeps that verdict.
    timers.set(timers.now() + 2 * DAY);
    h = makeWorker({ stateDir, timers, seed });
    const m = await boot(h);
    await m.run(16 * DAY, 3_600_000, () => m.slot());
    const live = h.worker.strategy.coverage;
    expect(live?.covered, JSON.stringify(live)).toBe(true);
    await h.worker.stop();
    const dir = tempState();
    cpSync(stateDir, dir, { recursive: true });
    rmSync(join(dir, PERSIST_FILE));
    const h3 = makeWorker({ stateDir: dir, timers, seed: async () => ({ mode: 'fill' as const, creates: [], coverage: [], report: 'test' }) });
    expect(h3.logs.some((l) => l.startsWith('Saved state restored'))).toBe(false);
    await boot(h3);
    const seeded = h3.worker.strategy.coverage;
    expect(seeded?.covered, JSON.stringify(seeded)).toBe(true);
    await h3.worker.kill();
  }, 600_000);
});

/** A small seeded generator (mulberry32), so every run checks the same histories. */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Coverage facts on two streams and three watches: starts, open and bounded gaps, resumes, restart gaps, unreadable facts. */
const history = (seed: number): MarketEvent[] => {
  const r = rng(seed);
  const out: MarketEvent[] = [];
  const open: { stream: string; via: string; from: bigint }[] = [];
  let ms = 1_000_000;
  for (let k = 0; k < 60; k++) {
    ms += Math.floor(r() * 5 * DAY);
    const stream = r() < 0.7 ? 'creates' : 'rugs';
    const via = ['logs:A', 'logs:B', 'seed'][Math.floor(r() * 3)]!;
    const slot = BigInt(ms);
    const x = r();
    let key: string;
    let value: Record<string, unknown>;
    if (x < 0.25) [key, value] = [`coverage:${stream}:start`, { fromSlot: slot, via }];
    else if (x < 0.5) {
      [key, value] = [`coverage:${stream}:gap`, { fromSlot: slot, toSlot: null, reason: r() < 0.5 ? 'restart' : 'disconnect', via }];
      open.push({ stream, via, from: slot });
    } else if (x < 0.8 && open.length > 0) {
      const g = open.splice(Math.floor(r() * open.length), 1)[0]!;
      [key, value] = r() < 0.5 ? [`coverage:${g.stream}:gap`, { fromSlot: g.from, toSlot: slot, reason: 'disconnect', via: g.via }] : [`coverage:${g.stream}:resume`, { fromSlot: g.from, via: g.via }];
    } else if (x < 0.83) [key, value] = [`coverage:${stream}:gap`, { fromSlot: slot, toSlot: 'bad', via }];
    else if (x < 0.85) [key, value] = [`coverage:${stream}:start`, { fromSlot: slot }];
    else [key, value] = [`coverage:${stream}:gap`, { fromSlot: slot, toSlot: slot + 5n, reason: 'disconnect', via }];
    const moment: Moment = { slot, txIndex: -1, ixIndex: k, receivedAt: ms };
    out.push({ kind: 'market', id: `c${k}`, moment, key, value: { value, source: 'test', backfilled: false, seq: k } });
  }
  return out;
};

const asHistory = (facts: readonly MarketEvent[]): History => (key, _from, to) =>
  facts.filter((e) => e.key === key && (to === undefined || e.moment.receivedAt <= to.receivedAt)).map((e) => ({ moment: e.moment, value: e.value, source: e.id }));

describe('pruneCoverage', () => {
  it('300 generated histories: every window from the retain point on reads the same coverage, and the live watch to close is the same', () => {
    let pruned = 0;
    let checked = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const facts = history(seed);
      const last = facts.at(-1)!.moment;
      for (const retain of [facts[10]!.moment.receivedAt, facts[30]!.moment.receivedAt + 1, facts[50]!.moment.receivedAt]) {
        const cut = pruneCoverage(facts, retain);
        pruned += facts.length - cut.length;
        // Release order and every fact from the retain point on are kept.
        expect(cut.map((e) => e.id)).toEqual(facts.filter((e) => cut.includes(e)).map((e) => e.id));
        expect(cut.filter((e) => e.moment.receivedAt >= retain)).toEqual(facts.filter((e) => e.moment.receivedAt >= retain));
        expect(liveWatchToClose(cut)).toEqual(liveWatchToClose(facts));
        for (const stream of ['creates', 'rugs']) {
          for (const w of [retain, retain + DAY, facts[40]!.moment.receivedAt, last.receivedAt]) {
            if (w < retain) continue;
            const a = createsCoverage(asHistory(facts), last, w, stream);
            const b = createsCoverage(asHistory(cut), last, w, stream);
            checked++;
            if (a.covered && b.covered && a.fromMs < retain) expect(b.fromMs).toBeLessThanOrEqual(retain);
            else expect(b, `seed ${seed} retain ${retain} window ${w} ${stream}`).toEqual(a);
          }
        }
      }
    }
    // The property is not vacuous: facts were dropped, and windows were checked.
    expect(pruned).toBeGreaterThan(3000);
    expect(checked).toBeGreaterThan(5000);
  });

  it('keeps the latest start per watch, an open gap from before the retain point, and unreadable facts; drops settled history', () => {
    const f = (id: string, ms: number, key: string, value: Record<string, unknown>): MarketEvent =>
      ({ kind: 'market', id, moment: { slot: BigInt(ms), txIndex: -1, ixIndex: 0, receivedAt: ms }, key, value: { value, source: 'test', backfilled: false, seq: 0 } });
    const facts = [
      f('s1', 1, 'coverage:creates:start', { fromSlot: 1n, via: 'A' }),
      f('g1', 2, 'coverage:creates:gap', { fromSlot: 2n, toSlot: null, via: 'A' }),
      f('s2', 3, 'coverage:creates:start', { fromSlot: 3n, via: 'A' }),
      f('g2', 4, 'coverage:creates:gap', { fromSlot: 4n, toSlot: 5n, via: 'A' }),
      f('t1', 5, 'coverage:creates:start', { fromSlot: 5n, via: 'B' }),
      f('o1', 6, 'coverage:creates:gap', { fromSlot: 6n, toSlot: null, via: 'B' }),
      f('u1', 7, 'coverage:creates:gap', { fromSlot: 7n }),
      // Gaps settled before the retain point, by a resume (C) and by the bounded report of the same gap (D): dropped.
      f('c1', 8, 'coverage:creates:start', { fromSlot: 8n, via: 'C' }),
      f('c2', 8, 'coverage:creates:gap', { fromSlot: 8n, toSlot: null, via: 'C' }),
      f('c3', 9, 'coverage:creates:resume', { fromSlot: 8n, via: 'C' }),
      f('d1', 8, 'coverage:creates:start', { fromSlot: 8n, via: 'D' }),
      f('d2', 8, 'coverage:creates:gap', { fromSlot: 8n, toSlot: null, via: 'D' }),
      f('d3', 9, 'coverage:creates:gap', { fromSlot: 8n, toSlot: 9n, via: 'D' }),
      f('n1', 20, 'coverage:creates:gap', { fromSlot: 20n, toSlot: 21n, via: 'A' }),
    ];
    expect(pruneCoverage(facts, 10).map((e) => e.id)).toEqual(['s2', 't1', 'o1', 'u1', 'c1', 'd1', 'n1']);
  });
});
