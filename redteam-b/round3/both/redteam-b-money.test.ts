// RED TEAM B round 3, item 2a: the resume config (S0, ZEROED_S0_DIAGNOSTIC on, no ZEROED_PAPER_EDGE_PPM so edge 0) on
// a market that passes the gates, for hours of simulated time across a Melbourne midnight, while SOL/USD swings
// between -40% and +40%. Nothing may book money, move the wallet, latch a kill line or change a limit.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CURVE_VOLUME_KEY, EXEC_HEALTH_KEY, GRADUATES_KEY } from '../../core/src/gates/index.ts';
import { s0EntryAt } from '../src/engine/strategy.ts';
import { accountFile } from '../src/run/account.ts';
import { NO_CONTROL, controlFile } from '../src/run/state.ts';
import { MIGRATED_AT, MINT, SOL_PRICE, T, makeWorker, passingMarket } from './worker-harness.ts';

const DAY = 86_400_000;
const from = MIGRATED_AT + 60 * 60_000;
const to = MIGRATED_AT + 240 * 60_000;
const early = (() => { for (let k = 0; ; k++) if (s0EntryAt(`salt-${k}`, MINT, from, to) < T - 60_000) return `salt-${k}`; })();

describe('RB-12 no trade, no money', () => {
  it('RB-12a hours of S0 + diagnostic at edge 0 with SOL/USD ±40%: wallet, costs, trades, latches and limits unchanged', async () => {
    const h = makeWorker({ edgePpm: 0n, entry: { timing: 'random', salt: early, s0Diagnostic: true }, config: { ZEROED_STRATEGY: 'S0', ZEROED_S0_DIAGNOSTIC: 'on' } });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, { heldPoolFacts: true, omit: [CURVE_VOLUME_KEY, GRADUATES_KEY, EXEC_HEALTH_KEY], coverageAt: T - 2 * DAY });
    await m.run(6_000, 400, () => { m.slot(); m.pool(); });
    const a0 = accountFile(h.stateDir).read(null as never);
    const stops0 = h.worker.apiInputs().stops;
    expect(a0.walletLamports).not.toBeNull();
    const swing = [1_400n, 600n, 1_000n, 1_300n, 700n, 1_000n, 1_400n, 600n, 1_000n, 1_300n, 700n, 1_000n, 1_400n, 600n, 1_000n, 1_300n, 700n, 1_000n, 1_400n, 600n, 1_000n, 1_300n, 700n, 1_000n, 1_400n, 600n];
    // ~26 h of event time in 2 s steps (a Melbourne midnight is crossed), the SOL/USD price stepping through the swing every hour.
    const startDay = h.worker.apiInputs().stops?.atMs ?? 0;
    for (let hr = 0; hr < swing.length; hr++) {
      m.solUsd = (SOL_PRICE * swing[hr]!) / 1_000n;
      await m.run(3_600_000, 2_000, () => { m.slot(); m.pool(); m.solPrice(); });
    }
    const a1 = accountFile(h.stateDir).read(null as never);
    const stops1 = h.worker.apiInputs().stops;
    const latches = controlFile(h.stateDir).read(NO_CONTROL).latches;
    const lines = readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    await h.worker.stop();
    if (process.env.RB_DEBUG) console.log('DBG12', JSON.stringify({ stops0, stops1, setup: a0.setup, dayMark0: a0.dayMark, dayMark1: a1.dayMark, weekMark1: a1.weekMark, navPeak: a1.navPeak, opening: a1.openingSolPrice, w: a1.walletLamports }, (_k, v) => typeof v === 'bigint' ? String(v) : v));
    expect(a1.walletLamports).toBe(a0.walletLamports);
    expect(a1.trades).toEqual([]);
    expect(a1.entries).toEqual([]);
    expect(a1.strayFees ?? {}).toEqual(a0.strayFees ?? {});
    expect(a1.setup).toEqual(a0.setup);
    expect(latches.killTrippedAtMs).toBeNull();
    expect(latches.weeklyTrippedAtMs).toBeNull();
    expect(lines.filter((l) => l['kind'] === 'decision' && l['action'] === 'enter')).toEqual([]);
    expect(lines.some((l) => l['kind'] === 'decision' && JSON.stringify(l).includes('expected_net_not_positive'))).toBe(true);
    expect(Object.keys(h.worker.book.positions)).toHaveLength(0);
    expect(Object.keys(h.worker.book.intents)).toHaveLength(0);
    // Limits are the policy's, in lamports: the same before and after the swing.
    expect(stops1?.dailyLimit ?? null).toBe(stops0?.dailyLimit ?? null);
    // Only cost ever booked: the wallet's one-time setup rent, on its own day; the next day starts at zero.
    expect(stops0?.dayLoss).toBe(a0.setup!.lamports);
    expect(stops1?.dayLoss).toBe(0n);
    expect(a1.dayMark!.startMs).toBeGreaterThan(a0.dayMark!.startMs);
    void startDay;
    console.log('RB-12a', JSON.stringify({ wallet: String(a1.walletLamports), dailyLimit: String(stops1?.dailyLimit), codes: stops1?.codes, journal: lines.length }));
  }, 900_000);
});
