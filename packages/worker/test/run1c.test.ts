// RUN-1c's worker contract (#49): coverage_gap and exposure journal lines, typed gate_reasons on rejects, and the
// health fields the runner scores (open_position.mark, unresolved trades, exit_capable, quota, lookups).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { transactionEvents } from '../../core/src/chain/index.ts';
import { coverageGaps, rejections } from '../../runner/src/quota.ts';
import { checkJournal } from '../../runner/src/journal.ts';
import type { JournalLine } from '../../runner/src/contract.ts';
import { CoverageJournal } from '../src/run/coverage-journal.ts';
import { rebuildMove, swapPrices } from '../src/run/exposure.ts';
import { recordOf, tx } from './helpers.ts';
import { makeWorker, Market, passingMarket } from './worker-harness.ts';

/** Test-only (POS-1): these tests move a held position's price by re-publishing the pool fact. */
const HELD = { heldPoolFacts: true } as const;

const lines = (dir: string) => readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as JournalLine);

describe('coverage_gap lines', () => {
  const at = Date.parse('2026-10-04T00:00:00Z');
  it('an open gap is journaled when it opens and again when it closes, under one id; the runner reads both', () => {
    const out: Record<string, unknown>[] = [];
    const j = new CoverageJournal((f) => void out.push(f));
    const via = 'logs:TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';
    j.fact('coverage:creates:start', { fromSlot: 100n, via }, at);
    j.fact('coverage:creates:gap', { fromSlot: 150n, toSlot: null, reason: 'disconnect', via }, at + 1_000);
    j.fact('coverage:creates:resume', { fromSlot: 150n, toSlot: 170n, via }, at + 9_000);
    j.fact('coverage:trades:POOL1:gap', { fromSlot: 200n, toSlot: null, reason: 'disconnect', via: 'logs:POOL1' }, at + 10_000);
    j.fact('coverage:trades:POOL1:start', { fromSlot: 260n, via: 'logs:POOL1' }, at + 30_000);
    j.fact('coverage:rugs:gap', { fromSlot: 300n, toSlot: 309n, reason: 'cut log', via: 'logs:x' }, at + 40_000);
    expect(out).toEqual([
      { stream: 'creates', gap_id: `creates|${via}|150`, from_ts: '2026-10-04T00:00:01.000Z', to_ts: null, reason: 'disconnect', coverage: 'creates', via },
      { stream: 'creates', gap_id: `creates|${via}|150`, from_ts: '2026-10-04T00:00:01.000Z', to_ts: '2026-10-04T00:00:09.000Z', reason: 'restored by backfill', coverage: 'creates', via },
      { stream: 'trades', gap_id: 'trades:POOL1|logs:POOL1|200', from_ts: '2026-10-04T00:00:10.000Z', to_ts: null, reason: 'disconnect', coverage: 'trades:POOL1', via: 'logs:POOL1' },
      { stream: 'trades', gap_id: 'trades:POOL1|logs:POOL1|200', from_ts: '2026-10-04T00:00:10.000Z', to_ts: '2026-10-04T00:00:30.000Z', reason: 'watch started again', coverage: 'trades:POOL1', via: 'logs:POOL1' },
      { stream: 'rugs', gap_id: 'rugs|logs:x|300', from_ts: '2026-10-04T00:00:36.000Z', to_ts: '2026-10-04T00:00:40.000Z', reason: 'cut log', coverage: 'rugs', via: 'logs:x', estimated_from_slots: true },
    ]);
    const journal = out.map((f, k) => ({ seq: k + 1, ts: new Date(at + 40_000).toISOString(), boot: 'b', kind: 'coverage_gap', ...f }) as JournalLine);
    const report = coverageGaps(journal, at + 60_000);
    expect(report.problems).toEqual([]);
    expect(report.streams['creates']).toMatchObject({ gaps: 1, open: 0, total_s: 8 });
    expect(report.streams['trades']).toMatchObject({ gaps: 1, open: 0, total_s: 20 });
    expect(report.streams['rugs']).toMatchObject({ gaps: 1, open: 0, total_s: 4 });
  });
});

describe('exposure lines', () => {
  const buy = recordOf(tx('PumpSwap BuyEvent'));
  const pool = (() => {
    const e = transactionEvents(buy).find((x) => x.program === 'pump_amm' && x.name === 'BuyEvent')!;
    return (e.data as unknown as { pool: string }).pool;
  })();

  it('reads the pool price before and after each swap on that pool from the transaction', () => {
    const prices = swapPrices(buy, pool);
    expect(prices).toHaveLength(2);
    // A buy takes tokens out and puts SOL in: the price rises.
    expect(prices[1]! > prices[0]!).toBe(true);
    expect(swapPrices(buy, 'another-pool')).toEqual([]);
  });

  it('the worst move over the down window, against the price saved before the kill; a gap in the reading gives no number', async () => {
    const [before, after] = swapPrices(buy, pool);
    const t = Number(buy.blockTime) * 1000;
    const rpc = (txs: (typeof buy | null)[]) => ({
      getSignaturesForAddress: async () => txs.map((_, k) => ({ signature: `s${k}`, slot: buy.slot, err: null, blockTime: Number(buy.blockTime) })),
      getTransaction: async (sig: string) => txs[Number(sig.slice(1))] ?? null,
    });
    const ok = await rebuildMove({ rpc: rpc([buy]), pool, ref: before!, fromMs: t - 60_000, toMs: t + 60_000, maxTx: 10 });
    expect(ok.swaps).toBe(1);
    expect(ok.worst_move_bps).toBe(Number(((after! - before!) * 10_000n + before! - 1n) / before!));
    expect((await rebuildMove({ rpc: rpc([null]), pool, ref: before!, fromMs: t - 60_000, toMs: t + 60_000, maxTx: 10 })).worst_move_bps).toBeNull();
    expect((await rebuildMove({ rpc: rpc([buy]), pool: null, ref: before!, fromMs: t, toMs: t, maxTx: 10 })).reason).toMatch(/pool unknown/);
    // Outside the window: nothing read, no move.
    expect(await rebuildMove({ rpc: rpc([buy]), pool, ref: before!, fromMs: t + 120_000, toMs: t + 180_000, maxTx: 10 })).toMatchObject({ worst_move_bps: 0, swaps: 0 });
  });

  it('a kill with a position open: the next start journals one exposure line for it, from the last line before the kill', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, HELD);
    await m.run(4_000, 100, () => m.pool());
    await m.run(10_000, 400, () => {
      m.slot();
      m.pool();
    });
    const pid = Object.values(h.worker.book.positions).find((p) => p.status === 'open')!.id;
    const lastBefore = lines(h.stateDir).at(-1)!.ts;
    await h.worker.kill();
    h.timers.set(h.timers.now() + 60_000);
    const reads: string[] = [];
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers, exposureRpc: {
      getSignaturesForAddress: async (a) => {
        reads.push(a);
        return [];
      },
      getTransaction: async () => null,
    } });
    expect(await h2.worker.start()).toEqual({ ok: true });
    await new Market(h2, HELD).run(1_000, 200);
    const exposure = lines(h.stateDir).filter((l) => l.kind === 'exposure');
    expect(exposure).toEqual([expect.objectContaining({ trade: pid, from_ts: lastBefore, worst_move_bps: 0, swaps: 0, pool: expect.any(String) })]);
    expect(reads).toEqual([exposure[0]!['pool']]);
    expect(checkJournal(readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8')).problems).toEqual([]);
    await h2.worker.stop();
    // Each down window once: the next start (the position still open) journals only the window since boot 2 stopped.
    const lastOfBoot2 = lines(h.stateDir).at(-1)!.ts;
    const h3 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    expect(await h3.worker.start()).toEqual({ ok: true });
    await new Market(h3, HELD).run(1_000, 200);
    const all = lines(h.stateDir).filter((l) => l.kind === 'exposure');
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ trade: pid, from_ts: lastOfBoot2, worst_move_bps: null, detail: 'no chain history reader configured' });
    await h3.worker.stop();
  });
});

describe('typed gate_reasons and the health fields', () => {
  it('every reject carries typed reasons the runner counts by gate and code; an entry is "enter"', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, HELD);
    await m.run(4_000, 100, () => m.pool());
    await m.run(10_000, 400, () => {
      m.slot();
      m.pool();
    });
    const decisions = lines(h.stateDir).filter((l) => l.kind === 'decision');
    const rejects = decisions.filter((l) => l['action'] === 'reject');
    expect(rejects.length).toBeGreaterThan(0);
    for (const r of rejects) {
      expect(Array.isArray(r['gate_reasons'])).toBe(true);
      for (const g of r['gate_reasons'] as { gate: string; code: string; detail: string }[]) expect(g).toEqual({ gate: expect.any(String), code: expect.any(String), detail: expect.any(String) });
      expect((r.reasons ?? []).some((x) => x.startsWith('gate_reasons '))).toBe(false);
    }
    expect(decisions.some((l) => l['action'] === 'enter')).toBe(true);
    expect(Object.keys(rejections(decisions).by_reason)).toEqual(expect.arrayContaining(['regime:unknown']));

    const health = h.worker.health();
    const pid = Object.values(h.worker.book.positions).find((p) => p.status === 'open')!.id;
    expect(health.open_position).toMatchObject({ trade: pid, mark: expect.stringMatching(/^\d+$/), mark_slot: expect.any(Number), mark_ts: expect.any(Number) });
    expect(health.ts - health.open_position!.mark_ts).toBeLessThanOrEqual(30_000);
    expect(health.unresolved_intents.trades).toHaveLength(health.unresolved_intents.count);
    expect(health.lookups.counts).toHaveLength(10);
    // No live feed in this harness: no exit path is up.
    expect(health.exit_capable).toBe(false);
    await h.worker.stop();
  });

});
