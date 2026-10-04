// ENTRY-TRIPS (AUDIT-RM2 F1, golden rule): a weekly loss or a NAV kill that risk finds on the entry path, while the
// account is flat, is latched like one found while managing an exit. Before, the trip rode inside the reject's text, the
// worker latches only reasons that start `trip `, and entries would have resumed the next week with no owner review.
import { describe, expect, it } from 'vitest';
import { usd } from '../../core/src/config/amounts.ts';
import { melbourneWeek } from '../../core/src/risk/melbourne.ts';
import type { MicroUsd } from '../../core/src/units/index.ts';
import { simulationLatency } from '../../runner/src/item4.ts';
import { markedHistory } from '../src/engine/marks.ts';
import { accountFile } from '../src/run/account.ts';
import { controlFile } from '../src/run/state.ts';
import { blockNetwork } from './helpers.ts';
import { T, makeWorker, passingMarket, tempState } from './worker-harness.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

blockNetwork();

const HELD = { heldPoolFacts: true } as const;

/**
 * RISK-LATCH (#124) latches R9/R10 from the worker's account valuation at the end of every step, which comes before a
 * candidate is first judged. To pin the entry path's own latching, this marking seam shows that valuation one open
 * position with no mark (never latchable) and leaves the strategy's marking as given. `valuations` counts the calls it
 * changed, so a renamed frame fails the test instead of passing it vacuously.
 */
const entryPath = (inner: typeof markedHistory = markedHistory) => {
  const seen = { valuations: 0 };
  const mark: typeof markedHistory = (h, held, sol, nowMs, st) => {
    const r = inner(h, held, sol, nowMs, st);
    if (!(new Error().stack ?? '').includes('#markAccount')) return r;
    seen.valuations++;
    return { ...r, openPositions: [...r.openPositions, { mint: 'Unmarked' as never, openedAtMs: nowMs, notional: 0n as MicroUsd, mark: null, markAtMs: null }] };
  };
  return { mark, seen };
};

/** A paper account whose recorded week-start or NAV peak puts it past a stop while it holds nothing. */
const seeded = (over: Record<string, unknown>): string => {
  const dir = tempState();
  const f = accountFile(dir);
  f.write({ openedAtMs: T - 30 * 86_400_000, openingEquity: usd('20'), walletLamports: null, trades: [], entries: [], ...over } as never);
  return dir;
};

const run = async (stateDir: string, mark?: typeof markedHistory) => {
  const h = makeWorker({ stateDir, ...(mark === undefined ? {} : { markedHistory: mark }) });
  expect(await h.worker.reconcile()).toEqual({ ok: true });
  const m = await passingMarket(h, HELD);
  await m.run(10_000, 400, () => {
    m.slot();
    m.pool();
  });
  await h.worker.stop();
  const lines = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; reasons?: string[] });
  return { h, lines, latches: controlFile(stateDir).read({ paused: false, latches: {} } as never).latches as unknown as Record<string, unknown> };
};

describe('a stop reached on the entry path while flat is latched', () => {
  it('weekly loss: the reject carries `trip weekly_loss` as its own reason, and the weekly latch is set', async () => {
    // A $5 loss realized this Melbourne week: equity $15 against $20 at the week's start, past the 20% weekly limit ($4)
    // and above the kill line ($14).
    const closedAt = T - 2 * 3_600_000;
    expect(closedAt).toBeGreaterThanOrEqual(melbourneWeek(T).start);
    const dir = seeded({ trades: [{ positionId: 'p:old:1', mint: 'OldMint1111111111111111111111111111111111111', openedAtMs: closedAt - 600_000, notional: usd('5'), closedAtMs: closedAt, netLamports: -33_000_000n, netPnl: -usd('5'), stoppedOut: true, booked: -33_000_000n }] });
    const e = entryPath();
    const { h, lines, latches } = await run(dir, e.mark);
    expect(e.seen.valuations).toBeGreaterThan(0);
    const rejects = lines.filter((l) => l.kind === 'decision' && l.reasons?.[0] === 'reject');
    expect(rejects.some((l) => l.reasons!.includes('trip weekly_loss')), JSON.stringify(lines.filter((l) => l.kind === 'decision').map((l) => l.reasons?.slice(0, 4)))).toBe(true);
    expect(Object.values(h.worker.book.positions)).toEqual([]);
    expect(typeof latches['weeklyTrippedAtMs']).toBe('number');
  });

  it('NAV kill: the reject carries `trip kill_switch` as its own reason, and the kill latch is set', async () => {
    const dir = seeded({ navPeak: { atMs: T - 3_600_000, nav: usd('40') } });
    const e = entryPath();
    const { h, lines, latches } = await run(dir, e.mark);
    expect(e.seen.valuations).toBeGreaterThan(0);
    const rejects = lines.filter((l) => l.kind === 'decision' && l.reasons?.[0] === 'reject');
    expect(rejects.some((l) => l.reasons!.includes('trip kill_switch'))).toBe(true);
    expect(Object.values(h.worker.book.positions)).toEqual([]);
    expect(typeof latches['killTrippedAtMs']).toBe('number');
  });
});

// Risk review of 75145cd: risk counts an open position with an unknown or stale mark as a total loss, a stand-in that
// refuses the entry but proves no breach. A latch lasts the week (R9) or until re-armed (R10), so the entry path emits
// `trip ` reasons only from a fully marked account at a fresh SOL price (marks.ts `latchable`, RISK-LATCH).
describe('an entry-path trip latches only from a fully marked account', () => {
  type Seam = 'unmarked' | 'stale' | 'dip';
  /**
   * Marking that adds a held $3 position (cost) and a $2.01 loss closed an hour ago: a total loss of the position
   * crosses the $4 weekly line (20% of $20); the account stays above the $14 kill line either way. The position's mark
   * is null, a micro-dollar older than maxQuoteAgeMs, or a fresh micro-dollar (a real fall).
   */
  const steered = (mode: Seam, maxAgeMs: number): typeof markedHistory => (h0, held, sol, nowMs, st) => {
    const lost = { mint: 'MintX' as never, openedAtMs: nowMs - 7_200_000, closedAtMs: nowMs - 3_600_000, notional: 3_000_000n as MicroUsd, netPnl: -2_010_000n as MicroUsd, stoppedOut: true };
    const r = markedHistory({ ...h0, closedTrades: [...h0.closedTrades, lost] }, held, sol, nowMs, st);
    const mark = mode === 'unmarked' ? { mark: null, markAtMs: null } : mode === 'stale' ? { mark: 1n as MicroUsd, markAtMs: nowMs - maxAgeMs - 1 } : { mark: 1n as MicroUsd, markAtMs: nowMs };
    return { ...r, openPositions: [...r.openPositions, { mint: 'MintY' as never, openedAtMs: nowMs - 600_000, notional: 3_000_000n as MicroUsd, ...mark }] };
  };
  const rejects = (lines: { kind: string; reasons?: string[] }[]) => lines.filter((l) => l.kind === 'decision' && l.reasons?.[0] === 'reject').map((l) => l.reasons!);
  const maxAge = makeWorker().session.policy.gates.maxQuoteAgeMs;

  it('(a) a flat account with a booked weekly loss, refused at entry, is latched R9 (fully marked: nothing held)', async () => {
    const closedAt = T - 2 * 3_600_000;
    const dir = seeded({ trades: [{ positionId: 'p:old:1', mint: 'OldMint1111111111111111111111111111111111111', openedAtMs: closedAt - 600_000, notional: usd('5'), closedAtMs: closedAt, netLamports: -33_000_000n, netPnl: -usd('5'), stoppedOut: true, booked: -33_000_000n }] });
    // The whole worker: since RISK-LATCH the account valuation latches it before the candidate is judged, so the
    // reject reads R9's review reason; the entry path's own latching is pinned in the tests above and in (c).
    const { lines, latches } = await run(dir);
    expect(typeof latches['weeklyTrippedAtMs']).toBe('number');
    expect(rejects(lines).some((r) => r.some((x) => x.startsWith('risk ') && x.includes('weekly_review')))).toBe(true);
  });

  for (const mode of ['unmarked', 'stale'] as const) {
    it(`(b) a held position with ${mode === 'unmarked' ? 'no' : 'a stale'} mark, whose stand-in crosses the weekly line: no trip reason, no latch`, async () => {
      const { lines, latches } = await run(tempState(), steered(mode, maxAge));
      const rs = rejects(lines);
      // Risk saw the stand-in cross the line: the refusal names the trip in its text...
      expect(rs.some((r) => r.some((x) => x.startsWith('risk ') && x.includes('trip weekly_loss'))), JSON.stringify(rs.map((r) => r.slice(0, 4)))).toBe(true);
      // ...but no reason the worker latches from, and no latch.
      expect(rs.some((r) => r.some((x) => x.startsWith('trip ')))).toBe(false);
      expect(latches['weeklyTrippedAtMs'] ?? null).toBeNull();
      expect(latches['killTrippedAtMs'] ?? null).toBeNull();
    });
  }

  it('(d) the same candidate refused first on a stale mark, then on a fresh one: the second reject is written with `trip weekly_loss` and R9 latches', async () => {
    const seam = { mode: 'stale' as Seam };
    const e = entryPath((...a) => steered(seam.mode, maxAge)(...a));
    const stateDir = tempState();
    const h = makeWorker({ stateDir, markedHistory: e.mark });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, HELD);
    const tick = () => {
      m.slot();
      m.pool();
    };
    await m.run(10_000, 400, tick);
    const latched = () => (controlFile(stateDir).read({ paused: false, latches: {} } as never).latches as unknown as Record<string, unknown>)['weeklyTrippedAtMs'] ?? null;
    const before = rejects(readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; reasons?: string[] }));
    expect(before.some((r) => r.some((x) => x.startsWith('risk ') && x.includes('trip weekly_loss')))).toBe(true);
    expect(latched()).toBeNull();
    seam.mode = 'dip';
    await m.run(10_000, 400, tick);
    await h.worker.stop();
    const after = rejects(readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; reasons?: string[] })).slice(before.length);
    expect(after.some((r) => r.includes('trip weekly_loss') && r[2] === before.at(-1)![2])).toBe(true);
    expect(typeof latched()).toBe('number');
    expect(e.seen.valuations).toBeGreaterThan(0);
  });

  it('(c) the same position with a fresh mark showing a real fall: `trip weekly_loss` on the reject, and R9 latched', async () => {
    const e = entryPath(steered('dip', maxAge));
    const { lines, latches } = await run(tempState(), e.mark);
    expect(e.seen.valuations).toBeGreaterThan(0);
    expect(rejects(lines).some((r) => r.includes('trip weekly_loss'))).toBe(true);
    expect(typeof latches['weeklyTrippedAtMs']).toBe('number');
    expect(latches['killTrippedAtMs'] ?? null).toBeNull();
  });
});

describe('N2: paper attempts\' simulation time against their drawn landing', () => {
  it('each simulation line carries its send height, drawn landing, blockhash limit, answer height and time', async () => {
    const stateDir = tempState();
    const h = makeWorker({ stateDir });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, HELD);
    await m.run(10_000, 400, () => {
      m.slot();
      m.pool();
    });
    await h.worker.stop();
    const sims = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l['kind'] === 'simulation');
    expect(sims.length).toBeGreaterThan(0);
    for (const s of sims) {
      for (const k of ['sent_height', 'land_slot', 'last_valid']) expect(typeof s[k], k).toBe('string');
      expect(typeof s['sim_ms']).toBe('number');
      expect(BigInt(s['land_slot'] as string)).toBeGreaterThan(BigInt(s['sent_height'] as string));
    }
  });

  it('the report counts simulations that held the drawn landing and those that ran past the blockhash', () => {
    const line = (sent: number, land: number, last: number, done: number | null, ms: number) => ({ seq: 1, ts: '', boot: 'b', kind: 'simulation' as const, sent_height: String(sent), land_slot: String(land), last_valid: String(last), sim_done_height: done === null ? null : String(done), sim_ms: ms });
    const l = simulationLatency([line(100, 103, 250, 101, 300), line(100, 103, 250, 110, 4_000), line(100, 103, 250, 260, 70_000), { seq: 2, ts: '', boot: 'b', kind: 'simulation' }]);
    expect(l).toEqual({ timed: 3, median_ms: 4_000, median_slots: 10, held_landing: 2, expired_by_simulation: 1 });
  });
});
