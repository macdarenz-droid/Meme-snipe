// ENTRY-TRIPS (AUDIT-RM2 F1, golden rule): a weekly loss or a NAV kill that risk finds on the entry path, while the
// account is flat, is latched like one found while managing an exit. Before, the trip rode inside the reject's text, the
// worker latches only reasons that start `trip `, and entries would have resumed the next week with no owner review.
import { describe, expect, it } from 'vitest';
import { usd } from '../../core/src/config/amounts.ts';
import { melbourneWeek } from '../../core/src/risk/melbourne.ts';
import { simulationLatency } from '../../runner/src/item4.ts';
import { accountFile } from '../src/run/account.ts';
import { controlFile } from '../src/run/state.ts';
import { blockNetwork } from './helpers.ts';
import { T, makeWorker, passingMarket, tempState } from './worker-harness.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

blockNetwork();

const HELD = { heldPoolFacts: true } as const;

/** A paper account whose recorded week-start or NAV peak puts it past a stop while it holds nothing. */
const seeded = (over: Record<string, unknown>): string => {
  const dir = tempState();
  const f = accountFile(dir);
  f.write({ openedAtMs: T - 30 * 86_400_000, openingEquity: usd('20'), walletLamports: null, trades: [], entries: [], ...over } as never);
  return dir;
};

const run = async (stateDir: string) => {
  const h = makeWorker({ stateDir });
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
    const { h, lines, latches } = await run(dir);
    const rejects = lines.filter((l) => l.kind === 'decision' && l.reasons?.[0] === 'reject');
    expect(rejects.some((l) => l.reasons!.includes('trip weekly_loss')), JSON.stringify(lines.filter((l) => l.kind === 'decision').map((l) => l.reasons?.slice(0, 4)))).toBe(true);
    expect(Object.values(h.worker.book.positions)).toEqual([]);
    expect(typeof latches['weeklyTrippedAtMs']).toBe('number');
  });

  it('NAV kill: the reject carries `trip kill_switch` as its own reason, and the kill latch is set', async () => {
    const dir = seeded({ navPeak: { atMs: T - 3_600_000, nav: usd('40') } });
    const { h, lines, latches } = await run(dir);
    const rejects = lines.filter((l) => l.kind === 'decision' && l.reasons?.[0] === 'reject');
    expect(rejects.some((l) => l.reasons!.includes('trip kill_switch'))).toBe(true);
    expect(Object.values(h.worker.book.positions)).toEqual([]);
    expect(typeof latches['killTrippedAtMs']).toBe('number');
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
