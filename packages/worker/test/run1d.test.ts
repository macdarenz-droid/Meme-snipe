// RUN-1d's worker contract (#64): pending_exits and open_position.universe in health, the `recovered` line after the
// start reconcile, the drop-rpc drill, and `--reconcile-only` (the host-loss tabletop).
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JournalLine } from '../../runner/src/contract.ts';
import { exitsFile } from '../src/run/state.ts';
import { LANDS, Market, makeWorker, passingMarket, tempState } from './worker-harness.ts';

const lines = (dir: string) => readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as JournalLine);
const token = (dir: string) => readFileSync(join(dir, 'drill.token'), 'utf8').trim();

const pending = (h: ReturnType<typeof makeWorker>): string[] => (h.worker.health() as unknown as { pending_exits: string[] }).pending_exits;

const entered = async (h: ReturnType<typeof makeWorker>) => {
  expect(await h.worker.reconcile()).toEqual({ ok: true });
  const m = await passingMarket(h);
  await m.run(4_000, 100, () => m.pool());
  await m.run(10_000, 400, () => {
    m.slot();
    m.pool();
  });
  return m;
};

describe('pending exits and the recovered line', () => {
  it('an exit that cannot land stays pending in health, survives a kill and is listed in the next boot recovered line', async () => {
    const h = makeWorker({ scenario: { ...LANDS, landPpm: { pumpswap: 1_000_000n, 'pump-curve': 1_000_000n } } });
    const m = await entered(h);
    const pid = Object.values(h.worker.book.positions).find((p) => p.status === 'open')!.id;
    expect(pending(h)).toEqual([]);
    expect((h.worker.health().open_position as unknown as { universe: string }).universe).toBe('U2');
    // The price stop fires: from the exit request until it lands, the trade is a pending exit.
    const seen = new Set<string>();
    m.slot();
    m.pool(700_000n);
    for (let k = 0; k < 20 && seen.size === 0; k++) {
      await m.run(100, 100);
      for (const t of pending(h)) seen.add(t);
    }
    expect([...seen]).toEqual([pid]);
    await h.worker.kill();
    // This test's first boot traded without a full start; a real first boot's start would have journaled `recovered`.
    rmSync(join(h.stateDir, 'cold_start'), { force: true });
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers, config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18870', ZEROED_API_ADDR: '127.0.0.1:18871' } });
    expect(await h2.worker.start()).toEqual({ ok: true });
    const recovered = lines(h.stateDir).filter((l) => l.kind === ('recovered' as JournalLine['kind']));
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ boot: h2.worker.boot, source: 'state', positions: [{ trade: pid, universe: 'U2' }] });
    // The restart settled the lost attempt; the position's exit is re-triggered, never dropped.
    expect([...(recovered[0]!['pending_exits'] as string[]), ...Object.values(h2.worker.book.positions).filter((p) => p.status !== 'closed').map((p) => p.id)]).toContain(pid);
    await h2.worker.stop();
  });

  it('an empty state dir is a cold start: source chain, and a paper position never comes back from the chain', async () => {
    const h = makeWorker({ config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18872', ZEROED_API_ADDR: '127.0.0.1:18873' } });
    expect(await h.worker.start()).toEqual({ ok: true });
    expect(lines(h.stateDir).find((l) => l.kind === ('recovered' as JournalLine['kind']))).toMatchObject({ source: 'chain', pending_exits: [], positions: [] });
    await h.worker.stop();
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers, config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18872', ZEROED_API_ADDR: '127.0.0.1:18873' } });
    expect(await h2.worker.start()).toEqual({ ok: true });
    expect(lines(h.stateDir).filter((l) => l.kind === ('recovered' as JournalLine['kind'])).map((l) => l['source'])).toEqual(['chain', 'state']);
    await h2.worker.stop();
  });
});

describe('the drop-rpc drill', () => {
  it('needs the token and a duration; it cuts every provider, halts entries and makes no exit possible until it ends', async () => {
    const cuts: number[] = [];
    const h = makeWorker({ cutRpc: (ms) => void cuts.push(ms), config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18874', ZEROED_API_ADDR: '127.0.0.1:18875' } });
    expect(await h.worker.start()).toEqual({ ok: true });
    const url = 'http://127.0.0.1:18874/drill/drop-rpc';
    expect((await fetch(url, { method: 'POST', body: JSON.stringify({ ms: 5_000 }) })).status).toBe(403);
    const headers = { 'x-zeroed-drill-token': token(h.stateDir) };
    expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ms: -1 }) })).status).toBe(400);
    expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ms: 2_592_000_000 }) })).status).toBe(202);
    expect(cuts).toEqual([2_592_000_000]);
    // Every feed went down by the drill, and came back when it ended (the harness clock runs each timer at once).
    await new Market(h).run(400, 400);
    const feedLines = lines(h.stateDir).filter((l) => l.kind === 'feed');
    expect(feedLines.some((l) => l['feed'] === 'all providers' && l['cause'] === 'drop-rpc drill')).toBe(true);
    for (const s of h.sources) expect(feedLines.filter((l) => l['feed'] === s.name && l['cause'] === 'drill').length).toBe(1);
    expect(h.sources.map((s) => [s.stops, s.starts])).toEqual([[1, 2], [1, 2]]);
    // While the cut lasts (read at once, before any timer runs): no exit is possible and every feed reads dropped.
    h.worker.dropRpc(60_000);
    const health = h.worker.health();
    expect(health.exit_capable).toBe(false);
    expect(Object.values(health.feeds).every((f) => f.dropped_by_drill && !f.connected)).toBe(true);
    await h.worker.stop();
  });
});

describe('--reconcile-only (the host-loss tabletop)', () => {
  it('reconciles, journals recovered, serves health and decides nothing, with no API; stops clean', async () => {
    const dir = tempState();
    const h = makeWorker({ stateDir: dir, config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18876', ZEROED_API_ADDR: '127.0.0.1:18877', ZEROED_DRILLS: 'off' } });
    expect(await h.worker.observeOnly()).toEqual({ ok: true });
    const health = (await (await fetch('http://127.0.0.1:18876/health')).json()) as { reconciled: boolean; exit_capable: boolean };
    expect(health.reconciled).toBe(true);
    expect(health.exit_capable).toBe(false);
    expect(lines(dir).find((l) => l.kind === ('recovered' as JournalLine['kind']))).toMatchObject({ source: 'chain', positions: [] });
    // Market events arrive and are drained unread: no decision is ever taken.
    const before = lines(dir).filter((l) => l.kind === 'decision').length;
    const m = await passingMarket(h);
    await m.run(4_000, 100, () => m.pool());
    expect(lines(dir).filter((l) => l.kind === 'decision').length).toBe(before);
    expect(h.worker.book.positions).toEqual({});
    expect(h.order.includes('seed')).toBe(false);
    expect(await h.worker.stop()).toBe(0);
  });
});

describe('a restored position whose universe the loaded policy lacks (EXIT-1b review)', () => {
  it('starts sell-only, says why on the start line, and flattens the position through the global exit ladder', async () => {
    const h = makeWorker();
    await entered(h);
    const pid = Object.values(h.worker.book.positions).find((p) => p.status === 'open')!.id;
    await h.worker.kill();
    // The position was entered under a universe this release's policy no longer has.
    const file = exitsFile(h.stateDir);
    const saved = file.read({});
    file.write({ ...saved, [pid]: { ...saved[pid]!, plan: { ...saved[pid]!.plan, universe: 'U9' as never } } });
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    const start = lines(h.stateDir).filter((l) => l.kind === 'start').at(-1)!;
    expect(start['sell_only']).toEqual([expect.stringMatching(new RegExp(`lacks universe U9 of ${pid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))]);
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    const m = new Market(h2);
    // The first decision may meet only the stale pre-kill quote and book the exit blocked; it retries within minutes.
    await m.run(150_000, 1_000, () => {
      m.slot();
      m.pool();
    });
    // Exits are never blocked for good: the position is flattened at an unchanged price, its decision line names why.
    expect(h2.worker.book.positions[pid]!.status).toBe('closed');
    const decisions = lines(h.stateDir).filter((l) => l.kind === 'decision' && l.boot === h2.worker.boot);
    expect(decisions.some((d) => (d.reasons ?? [])[0] === 'universe missing')).toBe(true);
    expect(decisions.some((d) => (d.reasons ?? [])[0] === 'exit' && (d.reasons ?? []).includes('universe missing: flatten'))).toBe(true);
    expect(h2.worker.health().halt_reasons).toEqual(expect.arrayContaining([expect.stringMatching(/^sell-only: /)]));
    await h2.worker.stop();
  });
});
