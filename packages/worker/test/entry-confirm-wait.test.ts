// LATE-LOG (S1 ruling on the #272 review, MEDIUM-2): an entry that passes every gate is held until the release point is
// `confirmLagSlots` past the slot it passed at, then judged again on the facts as of then, and proposed only if it passes
// again. A confirmed pool log delivered late (at most 5 released slots, measured) is then in the facts it is judged on.
// Exits never wait. The same strategy code runs in the backtest, so the backtest's entries wait the same.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { RUG_CONFIG } from '../../core/src/config/index.ts';
import { Engine } from '../../core/src/engine/index.ts';
import { LiveStrategy } from '../src/engine/strategy.ts';
import { replayRecorded, type Frame, type Release } from '../src/providers/index.ts';
import { engineFeed } from '../src/run/engine-feed.ts';
import { parseTyped } from '../src/run/json.ts';
import { describe, expect, it } from 'vitest';
import { candlesKey } from '../../core/src/gates/index.ts';
import { CONFIRM_LAG_SLOTS } from '../../core/src/facts/index.ts';
import { passingFacts } from '../../core/test/gates/world.ts';
import { CONFIRM_WAIT } from '../src/engine/strategy.ts';
import { blockNetwork } from './helpers.ts';
import { MINT, makeWorker, passingMarket } from './worker-harness.ts';

blockNetwork();

interface Line { kind: string; ts: string; action?: string; reasons?: string[] }

/** The passing market, with an optional change to the facts once the first pass is held (`during`). */
const run = async (confirmLagSlots: number, during?: (m: Awaited<ReturnType<typeof passingMarket>>) => void, drop = false) => {
  const h = makeWorker({ strategy: { confirmLagSlots } });
  await h.worker.reconcile();
  const m = await passingMarket(h, { heldPoolFacts: true });
  let held = false;
  const journal = () => readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Line).filter((l) => l.kind === 'decision');
  // As soon as the held pass is journaled (the wait has started), the test's change goes on the feed.
  const hook = () => {
    if (during !== undefined && !held && journal().some((l) => (l.reasons ?? []).some((r) => r.startsWith(CONFIRM_WAIT)))) {
      held = true;
      during(m);
    }
  };
  await m.run(4_000, 100, () => {
    hook();
    m.pool();
  });
  await m.run(10_000, 400, () => {
    hook();
    m.slot();
    m.pool();
  });
  // `drop`: the price falls 30% (a stop exit), at the same moment whatever the entry waited.
  if (drop) await m.run(6_000, 400, () => {
    m.slot();
    m.pool(700_000n);
  });
  await h.worker.stop();
  return { lines: journal(), held, h };
};
const files = (dir: string, re: RegExp): string[] =>
  readdirSync(join(dir, 'days')).sort().flatMap((d) => readdirSync(join(dir, 'days', d)).filter((f) => re.test(f)).sort().map((f) => join(dir, 'days', d, f)));
const rows = <T>(paths: readonly string[], parse: (l: string) => T): T[] =>
  paths.flatMap((p) => zstdDecompressSync(readFileSync(p)).toString('utf8').split('\n').filter((l) => l !== '').map(parse));
const enters = (d: readonly Line[]) => d.filter((l) => l.action === 'enter');
const waits = (d: readonly Line[]) => d.filter((l) => (l.reasons ?? []).some((r) => r.startsWith(CONFIRM_WAIT)));

describe('LATE-LOG: an entry waits confirmLagSlots and passes its gates again', () => {
  it('the default is the measured lag plus one: 6 slots', () => {
    expect(CONFIRM_LAG_SLOTS).toBe(6);
  });

  it('with no late frame it enters after the wait, later than with no wait', async () => {
    const now = await run(0);
    const later = await run(CONFIRM_LAG_SLOTS);
    expect(waits(now.lines)).toEqual([]);
    expect(enters(now.lines)).toHaveLength(1);
    expect(waits(later.lines).length).toBeGreaterThan(0);
    expect(enters(later.lines)).toHaveLength(1);
    const waitedAt = Date.parse(waits(later.lines)[0]!.ts);
    const enteredAt = Date.parse(enters(later.lines)[0]!.ts);
    // At 400 ms a slot, at least the lag's slots after the held pass.
    expect(enteredAt - waitedAt).toBeGreaterThanOrEqual(CONFIRM_LAG_SLOTS * 400 - 400);
    // The wait starts where the entry would have been made with no wait.
    expect(waitedAt).toBe(Date.parse(enters(now.lines)[0]!.ts));
    const r = waits(later.lines)[0]!.reasons!.find((x) => x.startsWith(CONFIRM_WAIT))!;
    expect(r).toMatch(/^confirm wait: passed at slot \d+; proposed once slot \d+ is released and it passes again$/);
  });

  it('a spike that reaches the candles inside the wait refuses the entry (H11)', async () => {
    const f = passingFacts().get(candlesKey(MINT))!.value as { obs: Record<string, unknown>; candles: { open: { quote: bigint; base: bigint }; high: unknown }[] };
    const spiky = (now: number) => ({ ...f, obs: { ...f.obs, receivedAt: now - 50 }, candles: f.candles.map((c, i) => (i === f.candles.length - 1 ? { ...c, high: { quote: c.open.quote * 3n, base: c.open.base } } : c)) });
    const r = await run(CONFIRM_LAG_SLOTS, (m) => m.fact(candlesKey(MINT), spiky(m.now)));
    expect(r.held).toBe(true);
    expect(enters(r.lines)).toEqual([]);
    expect(r.lines.some((l) => (l.reasons ?? []).some((x) => x.includes('H11') && x.includes('candle-spike')))).toBe(true);
  });

  it('exits never wait: the stop exit is at the same moment with and without the entry wait', async () => {
    const exitAt = (d: readonly Line[]) => d.filter((l) => l.action === 'trigger_exit').map((l) => l.ts);
    const now = await run(0, undefined, true);
    const later = await run(CONFIRM_LAG_SLOTS, undefined, true);
    expect(exitAt(now.lines)).toHaveLength(1);
    expect(exitAt(later.lines)).toEqual(exitAt(now.lines));
  });

  it('the recording replays to the same decision log 10 times, the wait and the entry included', async () => {
    const r = await run(CONFIRM_LAG_SLOTS);
    const h = r.h;
    const dir = join(h.stateDir, 'recorder', h.worker.boot);
    const frames = rows(files(dir, /^frames-/), (l) => parseTyped(l) as Frame);
    const releases = rows(files(dir, /^releases-/), (l) => JSON.parse(l) as Release);
    const hashes = new Set<string>();
    let reasons: string[][] = [];
    for (let i = 0; i < 10; i++) {
      const { clock, feed } = replayRecorded(frames, releases);
      const strategy = new LiveStrategy({ session: h.session, rugs: RUG_CONFIG, config: h.worker.strategyConfig });
      const engine = new Engine({ clock, feed: engineFeed(feed, h.session.policy).feed, strategy, runner: { run: () => undefined }, seed: 'confirm-wait', book: { maxOpenPositions: h.session.policy.positions.maxOpen } });
      engine.drain();
      hashes.add(engine.logHash());
      reasons = engine.records.flatMap((x) => (x.type === 'decision' ? [[...x.reasons]] : []));
    }
    expect(hashes.size).toBe(1);
    expect(reasons.some((x) => x.some((y) => y.startsWith(CONFIRM_WAIT)))).toBe(true);
    expect(reasons.some((x) => x[0] === 'enter')).toBe(true);
  });
});
