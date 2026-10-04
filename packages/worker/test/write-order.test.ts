// WORKER-ORDER (ARCHITECTURE §12.4): a fill is journaled before the ledger lets the position go. A crash image of the
// state dir is taken right after the first of an exit fill's two durable writes (the journal line, the ledger commit),
// which is exactly what a SIGKILL between them leaves on disk; a new worker then starts on that image. The runner's
// own restart check (`closedSince`, `recoveredState`) judges it: the position is either still recovered or excused by
// its `exit` line, never silently gone. The other way round (line written, ledger not), the restart books the fill
// again from the paper world and the line is not written twice.
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Health, JournalLine } from '../../runner/src/contract.ts';
import type { Kept } from '../../runner/src/report.ts';
import { closedSince, recoveredState, withoutTrades } from '../../runner/src/runner.ts';
import { type AccountState, accountFile } from '../src/run/account.ts';
import { Market, makeWorker, passingMarket } from './worker-harness.ts';

type H = ReturnType<typeof makeWorker>;
const lines = (dir: string): JournalLine[] => readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as JournalLine);
const kept = (h: Health): Kept => ({ pending_exits: [...h.pending_exits], positions: h.open_positions.map((p) => ({ trade: p.trade, universe: p.universe })) });

const tick = (m: Market, scalePpm = 1_000_000n) => (): void => {
  m.slot();
  m.pool(scalePpm);
};

const until = async (m: Market, done: () => boolean, maxMs: number, each: () => void): Promise<boolean> => {
  const end = m.now + maxMs;
  while (!done() && m.now < end) await m.run(400, 400, each);
  return done();
};

interface Image {
  readonly dir: string;
  readonly point: string;
  readonly intent: string;
  /** The last health reply before the kill, as the runner holds it. */
  readonly reply: Health;
}

/**
 * Enters, lets the price fall 30% so the stop exits in full, and takes a crash image at the first durable write of the
 * exit fill (or right after its ledger commit, `at`). Returns the image and the first worker (still running).
 */
const crashBetweenExitWrites = async (at?: 'fill-committed'): Promise<{ h: H; image: Image }> => {
  let image: Image | null = null;
  let reply: Health | null = null;
  let h: H | null = null;
  const exits = new Set<string>();
  h = makeWorker({
    crashPoint: (point, intent) => {
      if (image !== null || !exits.has(intent) || (at !== undefined && point !== at)) return;
      const dir = mkdtempSync(join(tmpdir(), 'zeroed-crash-'));
      cpSync(h!.stateDir, dir, { recursive: true });
      image = { dir, point, intent, reply: reply! };
    },
  });
  expect(await h.worker.reconcile()).toEqual({ ok: true });
  const m = await passingMarket(h, { heldPoolFacts: true });
  const open = () => Object.values(h!.worker.book.positions).find((p) => p.status === 'open');
  expect(await until(m, () => open() !== undefined, 30_000, tick(m))).toBe(true);
  const each = (scale: bigint) => (): void => {
    tick(m, scale)();
    // The runner's view: the reply it sampled last before the kill.
    reply = h!.worker.health();
    for (const i of Object.values(h!.worker.book.intents)) if (i.intent.purpose === 'exit') exits.add(i.intent.id);
  };
  expect(await until(m, () => image !== null, 30_000, each(700_000n))).toBe(true);
  return { h, image: image! };
};

/**
 * A new worker on the crash image. The first boot traded without a full start (the harness's reconcile only); a real
 * first boot's start would have journaled `recovered` and removed the cold-start marker.
 */
const restart = (h: H, image: Image): H => {
  rmSync(join(image.dir, 'cold_start'), { force: true });
  return makeWorker({ stateDir: image.dir, timers: h.timers });
};

describe('an exit fill is journaled before the ledger lets the position go (§12.4)', () => {
  it('a kill between the two writes: the runner finds the position kept or its exit line, never a silent loss', async () => {
    const { h, image } = await crashBetweenExitWrites();
    await h.worker.stop();
    // The order itself: the journal line is the first durable write.
    expect(image.point).toBe('fill-journaled');
    const pid = image.reply.open_positions[0]!.trade;
    expect(image.reply.pending_exits).toContain(pid);

    const h2 = restart(h, image);
    expect(await h2.worker.start()).toEqual({ ok: true });
    const all = lines(image.dir);
    const atKill = kept(image.reply);
    const closed = closedSince(all, h.worker.boot, image.reply.journal_seq);
    const state = recoveredState(all, h2.worker.boot, 'crash', withoutTrades(atKill, closed), atKill);
    expect(state.notes, JSON.stringify(state)).toEqual([]);
    expect(state.state_ok).toBe(true);
    expect(closed).toEqual([pid]);
    await h2.worker.stop();
  });

  it('the reverse (line written, ledger not): the restart books the fill once, closes the trade, and writes no second line', async () => {
    const { h, image } = await crashBetweenExitWrites();
    await h.worker.stop();
    const pid = image.reply.open_positions[0]!.trade;
    const exitLines = () => lines(image.dir).filter((l) => l.kind === 'exit' && l['intent'] === image.intent);
    expect(exitLines()).toHaveLength(1);

    const h2 = restart(h, image);
    expect(await h2.worker.start()).toEqual({ ok: true });
    const m2 = new Market(h2, { heldPoolFacts: true });
    expect(await until(m2, () => h2.worker.book.positions[pid]?.status === 'closed', 30_000, tick(m2, 700_000n))).toBe(true);
    // Booked from the world's record of the landing: the same fill, once, under the same intent.
    const fills = h2.worker.book.intents[image.intent as never]!.fills;
    expect(fills).toHaveLength(1);
    expect(String(fills[0]!.tokens)).toBe(exitLines()[0]!['tokens']);
    expect(exitLines()).toHaveLength(1);
    // The account closed the trade in the new boot (its record follows the ledger).
    const a = accountFile(image.dir).read(null as unknown as AccountState);
    expect(a.trades.find((t) => t.positionId === pid)?.closedAtMs).not.toBeNull();
    await h2.worker.stop();
  });

  it('a kill after the ledger commit, before account.json: the restart records the close from the ledger and the exit line', async () => {
    const { h, image } = await crashBetweenExitWrites('fill-committed');
    await h.worker.stop();
    const pid = image.reply.open_positions[0]!.trade;
    const before = accountFile(image.dir).read(null as unknown as AccountState).trades.find((t) => t.positionId === pid)!;
    expect(before.closedAtMs).toBeNull();
    const line = lines(image.dir).find((l) => l.kind === 'exit' && l['intent'] === image.intent)!;
    const h2 = restart(h, image);
    expect(await h2.worker.start()).toEqual({ ok: true });
    expect(h2.worker.book.positions[pid]?.status).toBe('closed');
    const m2 = new Market(h2, { heldPoolFacts: true });
    // The first SOL price values the close.
    expect(await until(m2, () => accountFile(image.dir).read(null as unknown as AccountState).trades.find((t) => t.positionId === pid)?.closedAtMs != null, 10_000, tick(m2))).toBe(true);
    const t = accountFile(image.dir).read(null as unknown as AccountState).trades.find((x) => x.positionId === pid)!;
    expect(t.closedAtMs).toBe(Date.parse(line.ts as string));
    expect(t.netLamports).not.toBeNull();
    expect(t.booked).toBe(t.netLamports);
    expect(t.exitReasons).toContain('stop');
    expect(lines(image.dir).filter((l) => l.kind === 'exit' && l['intent'] === image.intent)).toHaveLength(1);
    await h2.worker.stop();
  });
});
