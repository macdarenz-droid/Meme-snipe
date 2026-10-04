// Live decisions do not move with GateContext.observedTip (supervisor ruling, BT-2): the live strategy passes its feed's
// observed tip, the newest released chain slot, which is the clock's own slot. A recorded live session replayed through
// the engine gives the same decisions, every gate reason included, as before the field existed: the digest below was
// taken with Evidence judging freshness against the clock's slot alone (the rule before the field existed), on this
// head's live strategy. When live decisions change for another reason, retake it that way (Evidence's tip forced to
// `now.slot`), never from the code under test.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
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

const BEFORE = '677234af876820edc65d23308b6eff1d3e653383d2bab2ea46687af8342ce4e6';

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
    const { clock, feed } = replayRecorded(rows(files(dir, /^frames-/), (l) => parseTyped(l) as Frame), rows(files(dir, /^releases-/), (l) => JSON.parse(l) as Release));
    const strategy = new LiveStrategy({ session: h.session, rugs: RUG_CONFIG, config: h.worker.strategyConfig });
    const engine = new Engine({ clock, feed: engineFeed(feed, h.session.policy).feed, strategy, runner: { run: () => undefined }, seed: 'observed-tip', book: { maxOpenPositions: h.session.policy.positions.maxOpen } });
    engine.drain();
    const decisions = (engine.records as readonly LogRecord[]).flatMap((r) => (r.type === 'decision' ? [{ event: r.eventId, reasons: r.reasons, result: r.result }] : []));
    expect(decisions.some((d) => d.reasons[0] === 'enter')).toBe(true);
    const digest = createHash('sha256').update(canonical(decisions)).digest('hex');
    expect(digest).toBe(BEFORE);
  });
});
