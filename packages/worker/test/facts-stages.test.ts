// FACTS-1f: the live worker evaluates the hard rejects in BT-2's stages (GATE-2), every gate of a stage evaluated,
// stopping at the first stage with a reject and naming the gates after it as not evaluated, so live and the backtest
// record the same reasons for the same facts (G3 compares the reject mix).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RUG_CONFIG } from '../../core/src/config/index.ts';
import { Engine, type LogRecord } from '../../core/src/engine/index.ts';
import { HARD_GATES, HARD_STAGE, candlesKey, evaluateHardRejects, gatesOfStages, holdersKey, mintKey } from '../../core/src/gates/index.ts';
import { contextOf, deps, drop, MINT, passingFacts, patch, request, session } from '../../core/test/gates/world.ts';
import { GATE_REASONS_PREFIX, HARD_STAGE_GROUPS, LiveStrategy, NOT_EVALUATED, stagedHardRejects } from '../src/engine/strategy.ts';
import { replayRecorded, type Frame, type Release } from '../src/providers/index.ts';
import { engineFeed } from '../src/run/engine-feed.ts';
import { parseTyped } from '../src/run/json.ts';
import { blockNetwork } from './helpers.ts';
import { makeWorker, passingMarket } from './worker-harness.ts';

blockNetwork();

const staged = (facts: ReturnType<typeof passingFacts>) => stagedHardRejects(contextOf(facts), deps('live', session(), 'RUG-1'), request());
const STAGE_1 = gatesOfStages([1]);
const STAGE_2 = gatesOfStages([2]);
const STAGES_3_4 = gatesOfStages([3, 4]);

describe('stagedHardRejects (BT-2\'s stages: 1, then 2, then 3 and 4)', () => {
  it('the groups are BT-2\'s: stage 1, stage 2, stages 3 and 4, covering every hard gate once', () => {
    expect(HARD_STAGE_GROUPS).toEqual([STAGE_1, STAGE_2, STAGES_3_4]);
    expect([...HARD_STAGE_GROUPS.flat()].sort()).toEqual([...HARD_GATES].sort());
  });

  it('a passing world is evaluated in full: every gate, no reason, complete, nothing left out', () => {
    const { hard, notEvaluated } = staged(passingFacts());
    expect(hard.pass).toBe(true);
    expect(hard.complete).toBe(true);
    expect(hard.reasons).toEqual([]);
    expect([...hard.evaluated].sort()).toEqual([...HARD_GATES].sort());
    expect(notEvaluated).toEqual([]);
  });

  it('a stage-1 reject ends there: only stage-1 gates evaluated, stages 2 to 4 listed as not evaluated', () => {
    const { hard, notEvaluated } = staged(drop(passingFacts(), candlesKey(MINT)));
    expect(hard.pass).toBe(false);
    expect(hard.complete).toBe(false);
    expect(hard.evaluated).toEqual(STAGE_1);
    expect(hard.failed.every((g) => HARD_STAGE[g] === 1)).toBe(true);
    expect(notEvaluated).toEqual([...STAGE_2, ...STAGES_3_4]);
  });

  it('a stage-2 reject: stages 1 and 2 evaluated, stages 3 and 4 not evaluated', () => {
    const { hard, notEvaluated } = staged(drop(passingFacts(), mintKey(MINT)));
    expect(hard.pass).toBe(false);
    expect(hard.evaluated).toEqual([...STAGE_1, ...STAGE_2]);
    expect(hard.failed.length).toBeGreaterThan(0);
    expect(hard.failed.every((g) => HARD_STAGE[g] === 2)).toBe(true);
    expect(notEvaluated).toEqual(STAGES_3_4);
  });

  it('a stage-3 reject: every gate evaluated (3 and 4 are one step), nothing left out, still not an entry', () => {
    const { hard, notEvaluated } = staged(drop(passingFacts(), holdersKey(MINT)));
    expect(hard.pass).toBe(false);
    expect([...hard.evaluated].sort()).toEqual([...HARD_GATES].sort());
    expect(notEvaluated).toEqual([]);
    expect(hard.failed.every((g) => HARD_STAGE[g] >= 3)).toBe(true);
  });

  it('inside a stage every gate is evaluated, as BT-2\'s calibration log does: two rejects in one stage are both named', () => {
    // Stage 2: the mint read missing (H1–H4 need it) and the pool fact missing (H5, H6 need it).
    const facts = drop(drop(passingFacts(), mintKey(MINT)), `gates/pool:${MINT}`);
    const { hard } = staged(facts);
    const byStage = evaluateHardRejects(contextOf(facts), deps('live', session(), 'RUG-1'), request(), { stopAtFirst: false, only: STAGE_2 });
    expect(hard.failed).toEqual(byStage.failed);
    expect(hard.failed.length).toBeGreaterThan(1);
    expect(hard.reasons).toEqual(byStage.reasons);
  });

  it('each stage\'s reasons equal BT-2\'s call for that stage (`only`, every gate): the same facts give the same reasons', () => {
    for (const facts of [patch(passingFacts(), candlesKey(MINT), { bars: [] }), drop(passingFacts(), mintKey(MINT)), drop(passingFacts(), holdersKey(MINT))]) {
      const { hard } = staged(facts);
      const expected = [STAGE_1, STAGE_2, STAGES_3_4].flatMap((only) => {
        const r = evaluateHardRejects(contextOf(facts), deps('live', session(), 'RUG-1'), request(), { stopAtFirst: false, only });
        return [r];
      });
      // Stages up to and including the first one with a reject.
      const upTo = expected.findIndex((r) => !r.pass);
      const used = expected.slice(0, upTo === -1 ? expected.length : upTo + 1);
      expect(hard.reasons).toEqual(used.flatMap((r) => r.reasons));
      expect(hard.failed).toEqual(used.flatMap((r) => r.failed));
    }
  });
});

const rows = <T>(dir: string, re: RegExp, parse: (l: string) => T): T[] =>
  readdirSync(join(dir, 'days')).sort().flatMap((d) => readdirSync(join(dir, 'days', d)).filter((f) => re.test(f)).sort()
    .flatMap((f) => zstdDecompressSync(readFileSync(join(dir, 'days', d, f))).toString('utf8').split('\n').filter((l) => l !== '').map(parse)));

describe('the live worker records staged rejects, and the recording replays to the same reasons', () => {
  it('a stage-2 reject names stages 3 and 4 as not evaluated; live and replay give the same typed reasons at every decision', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, { heldPoolFacts: true });
    // The holder read goes bad (stage 3) for a while, then the mint read (stage 2; the pool refresh re-reads the holders).
    await m.run(3_000, 400, () => {
      m.slot();
      m.pool();
      m.fact(holdersKey(MINT), { unreadable: true });
    });
    await m.run(3_000, 400, () => {
      m.slot();
      m.pool();
      m.fact(mintKey(MINT), { unreadable: true });
    });
    await h.worker.stop();
    const journal = readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; event?: string; reasons?: string[]; gate_reasons?: { gate: string; code: string }[] });
    const rejects = journal.filter((l) => l.kind === 'decision' && (l.reasons ?? [])[0] === 'reject');
    const stage2 = rejects.find((l) => (l.reasons ?? []).some((x) => x.includes('H16 malformed mint')));
    expect(stage2).toBeDefined();
    expect(stage2!.reasons!.join(' ')).toContain(`${NOT_EVALUATED}${STAGES_3_4.join(',')}`);
    const stage3 = rejects.find((l) => (l.reasons ?? []).some((x) => x.includes('H16 malformed holders')));
    expect(stage3).toBeDefined();
    expect(stage3!.reasons!.join(' ')).not.toContain(NOT_EVALUATED);

    // The recording, replayed through the same engine path: the same decisions, with the same typed reasons.
    const dir = join(h.stateDir, 'recorder', h.worker.boot);
    const frames = rows(dir, /^frames-/, (l) => parseTyped(l) as Frame);
    const releases = rows(dir, /^releases-/, (l) => JSON.parse(l) as Release);
    const start = journal.find((l) => l.kind === 'start') as unknown as { seed: string };
    const { clock, feed } = replayRecorded(frames, releases);
    const strategy = new LiveStrategy({ session: h.session, rugs: RUG_CONFIG, config: h.worker.strategyConfig });
    const engine = new Engine({ clock, feed: engineFeed(feed, h.session.policy).feed, strategy, runner: { run: () => undefined }, seed: start.seed, book: { maxOpenPositions: h.session.policy.positions.maxOpen } });
    engine.drain();
    const replayed = (engine.records as readonly LogRecord[]).flatMap((r) => (r.type === 'decision' && r.reasons[0] === 'reject' ? [r] : []));
    const typed = (reasons: readonly string[]) => JSON.parse(reasons.find((x) => x.startsWith(GATE_REASONS_PREFIX))!.slice(GATE_REASONS_PREFIX.length)) as unknown;
    expect(replayed.map((r) => ({ event: r.eventId, reasons: r.reasons.filter((x) => !x.startsWith(GATE_REASONS_PREFIX)), gate_reasons: typed(r.reasons) })))
      .toEqual(rejects.map((l) => ({ event: l.event, reasons: l.reasons, gate_reasons: l.gate_reasons })));
  });
});
