// Live decisions do not move with GateContext.observedTip (supervisor ruling, BT-2): the live strategy passes its feed's
// observed tip, the newest released chain slot, which is the clock's own slot. A recorded live session is replayed twice
// through the engine: as live runs it, and with Evidence judging freshness against the clock's slot alone (the rule
// before the field existed, forced here through a mock of Evidence). Both give byte-identical decisions, every gate
// reason included. No digest is pinned, so a base change to live decisions never needs a retake (BT review of 9c1bc67).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { RUG_CONFIG } from '../../core/src/config/index.ts';
import { canonical, Engine, type LogRecord } from '../../core/src/engine/index.ts';
import { LiveStrategy } from '../src/engine/strategy.ts';
import { replayRecorded, type Frame, type Release } from '../src/providers/index.ts';
import { engineFeed } from '../src/run/engine-feed.ts';
import { parseTyped } from '../src/run/json.ts';
import { makeWorker, passingMarket } from './worker-harness.ts';

const files = (dir: string, re: RegExp): string[] =>
  readdirSync(join(dir, 'days')).sort().flatMap((d) => readdirSync(join(dir, 'days', d)).filter((f) => re.test(f)).sort().map((f) => join(dir, 'days', d, f)));
const rows = <T>(paths: readonly string[], parse: (l: string) => T): T[] =>
  paths.flatMap((p) => zstdDecompressSync(readFileSync(p)).toString('utf8').split('\n').filter((l) => l !== '').map(parse));

const force = vi.hoisted(() => ({ clockSlot: false, forced: 0 }));
vi.mock('../../core/src/gates/evidence.ts', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../core/src/gates/evidence.ts')>();
  class Evidence extends m.Evidence {
    constructor(ctx: ConstructorParameters<typeof m.Evidence>[0], policy: ConstructorParameters<typeof m.Evidence>[1]) {
      super(force.clockSlot ? { ...ctx, observedTip: ctx.now.slot } : ctx, policy);
      if (force.clockSlot) force.forced++;
    }
  }
  return { ...m, Evidence };
});


describe('observed tip in live', () => {
  it('a recorded live session replays to byte-identical decisions, gate reasons included', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, { heldPoolFacts: true });
    await m.run(4_000, 100, () => m.pool());
    await m.run(10_000, 400, () => {
      m.slot();
      m.pool();
    });
    await m.run(6_000, 400, () => {
      m.slot();
      m.pool(700_000n);
    });
    await h.worker.stop();
    const dir = join(h.stateDir, 'recorder', h.worker.boot);
    const replay = (clockSlot: boolean) => {
      force.clockSlot = clockSlot;
      const { clock, feed } = replayRecorded(rows(files(dir, /^frames-/), (l) => parseTyped(l) as Frame), rows(files(dir, /^releases-/), (l) => JSON.parse(l) as Release));
      const strategy = new LiveStrategy({ session: h.session, rugs: RUG_CONFIG, config: h.worker.strategyConfig });
      const engine = new Engine({ clock, feed: engineFeed(feed, h.session.policy).feed, strategy, runner: { run: () => undefined }, seed: 'observed-tip', book: { maxOpenPositions: h.session.policy.positions.maxOpen } });
      engine.drain();
      force.clockSlot = false;
      return (engine.records as readonly LogRecord[]).flatMap((r) => (r.type === 'decision' ? [{ event: r.eventId, reasons: r.reasons, result: r.result }] : []));
    };
    const live = replay(false);
    const before = replay(true);
    // The forced rule really judged the replay's gates.
    expect(force.forced).toBeGreaterThan(0);
    expect(live.some((d) => d.reasons[0] === 'enter')).toBe(true);
    expect(live.length).toBeGreaterThan(0);
    const digest = (x: unknown) => createHash('sha256').update(canonical(x)).digest('hex');
    expect(digest(live)).toBe(digest(before));
  });
});
