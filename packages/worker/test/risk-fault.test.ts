// RISK-FAULT: risk that cannot evaluate the account says so. An entry is refused (fail-closed) and logged, and the
// worker keeps stepping; an exit still goes, with `risk_fault` among its tripped codes and the reason, latching nothing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { markedHistory } from '../src/engine/marks.ts';
import { RISK_FAULT_PREFIX, TRIPPED_PREFIX, TRIP_PREFIX } from '../src/engine/strategy.ts';
import { NO_CONTROL, controlFile } from '../src/run/state.ts';
import { MINT, type Market, makeWorker, passingMarket, until } from './worker-harness.ts';

type H = ReturnType<typeof makeWorker>;
const decisions = (h: H): string[][] => readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l['kind'] === 'decision').map((l) => (l['reasons'] as string[]) ?? []);
const position = (h: H) => Object.values(h.worker.book.positions).find((p) => String(p.mint) === MINT);

/** A worker whose marked account can be made unreadable to risk (closed trades not a list: risk throws inside). */
const broken = () => {
  const seam = { broken: false };
  const mark: typeof markedHistory = (...args) => {
    const r = markedHistory(...args);
    return seam.broken ? { ...r, closedTrades: null as never } : r;
  };
  return { h: makeWorker({ markedHistory: mark }), seam };
};
const tick = (h: H, m: Market) => (): void => {
  m.slot();
  m.chainSwap('buy', m.chainState.baseReserve / 1_000_000n, h.worker.feed.openSlot);
  m.solPrice();
};

describe('a risk fault is told apart from a clean account (RISK-FAULT)', () => {
  it('refuses the entry and logs the fault, keeps stepping, and enters once risk can evaluate again', async () => {
    const { h, seam } = broken();
    seam.broken = true;
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h);
    const read = h.worker.feed.releasedThrough;
    m.tradesStart(read - 100n);
    m.accountsRead(read);
    await until(m, 8_000, () => false, () => { m.slot(); m.pool(); });
    expect(position(h)).toBeUndefined();
    expect(decisions(h).some((r) => r[0] === 'reject' && r.some((x) => x.startsWith('risk fault: ')))).toBe(true);
    expect(h.logs.some((l) => l.includes('Engine step failed'))).toBe(false);
    seam.broken = false;
    expect(await until(m, 40_000, () => position(h)?.status === 'open', () => { m.slot(); m.pool(); })).toBe(true);
    await h.worker.stop();
  });

  it('an exit judged while risk cannot evaluate still goes, with risk_fault and its reason logged and nothing latched', async () => {
    const { h, seam } = broken();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h);
    const read = h.worker.feed.releasedThrough;
    m.tradesStart(read - 100n);
    m.accountsRead(read);
    expect(await until(m, 40_000, () => position(h)?.status === 'open', () => { m.slot(); m.pool(); })).toBe(true);
    const pid = position(h)!.id;
    await until(m, 2_000, () => false, tick(h, m));
    seam.broken = true;
    m.chainSwap('sell', (m.chainState.baseReserve * 20n) / 100n, h.worker.feed.openSlot);
    expect(await until(m, 20_000, () => h.worker.book.positions[pid]!.status === 'closed', tick(h, m))).toBe(true);
    const exit = decisions(h).find((r) => r[0] === 'exit')!;
    expect(exit.some((x) => x.startsWith('price_stop: '))).toBe(true);
    expect(exit.find((x) => x.startsWith(TRIPPED_PREFIX))?.slice(TRIPPED_PREFIX.length).split(',')).toEqual(['risk_fault']);
    expect(exit.some((x) => x.startsWith(RISK_FAULT_PREFIX) && x.length > RISK_FAULT_PREFIX.length)).toBe(true);
    expect(exit.some((x) => x.startsWith(TRIP_PREFIX))).toBe(false);
    const l = controlFile(h.stateDir).read(NO_CONTROL).latches;
    expect([l.killTrippedAtMs, l.weeklyTrippedAtMs]).toEqual([null, null]);
    await h.worker.stop();
  });
});
