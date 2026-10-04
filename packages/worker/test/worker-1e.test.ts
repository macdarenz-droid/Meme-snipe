// WORKER-1e: can the live dry run make paper trades? The S0 shakedown on live-like facts (no curve-volume or graduates series, no
// execution-health limits, a host whose creates coverage is days old) enters only with S0's diagnostic set, and every
// entry is still simulated; the qualifying configuration refuses the set.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CURVE_VOLUME_KEY, EXEC_HEALTH_KEY, GRADUATES_KEY, S0_DIAGNOSTIC_PARTS, simKey } from '../../core/src/gates/index.ts';
import { RAW } from '../../core/src/facts/index.ts';
import { passingFacts, roundTrip } from '../../core/test/gates/world.ts';
import { lamports } from '../../core/src/units/index.ts';
import { LiveFacts, type LiveReaders } from '../src/facts/index.ts';
import { checkJournal } from '../../runner/src/journal.ts';
import { entryRule } from '../../runner/src/quota.ts';
import { closedFlow, s0EntryAt } from '../src/engine/strategy.ts';
import { MIGRATED_AT, MINT, POOL_ADDRESS, T, dueTimers, makeWorker, passingMarket, testConfig, tempState } from './worker-harness.ts';
import { parseConfig } from '../src/run/config.ts';
import { route } from '../src/run/api.ts';

const DAY = 86_400_000;
const HELD = { heldPoolFacts: true } as const;
const lines = (dir: string) => readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const from = MIGRATED_AT + 60 * 60_000;
const to = MIGRATED_AT + 240 * 60_000;
/** A salt whose drawn moment is before T, so the candidate is due when the passing market is up. */
const early = (() => {
  for (let k = 0; ; k++) if (s0EntryAt(`salt-${k}`, MINT, from, to) < T - 60_000) return `salt-${k}`;
})();

/** H15 live: no simulation fact is published; the fact source simulates each candidate the gates ask for. */
const simulating = (asked: [string, bigint][]) => new LiveFacts({
  readers: (ctx) => {
    const none = async () => false;
    const r: LiveReaders = {
      readAccounts: none, readHolders: none, readHoldersAll: none, readCrossChecks: async () => [], readMintHistory: none, readSolUsd: none,
      readSim: async (mint, spend) => {
        asked.push([mint, spend]);
        const q = roundTrip(lamports(spend));
        if (!q.ok) return false;
        const read = { mint, slot: ctx.tip() ?? 0n, spend, ok: true, paid: q.trade.paid, proceeds: q.trade.proceeds, error: null };
        ctx.ingest.ingest('helius', { type: 'offchain', key: RAW.sim(mint), value: read }, { receivedAt: ctx.timers.now() });
        return true;
      },
    };
    return r;
  },
  tickMs: 1_000, minReadGapMs: 60_000, survivalAfterMs: 30 * 60_000, survivalReadDelayMs: 5_000, solUsdStartHours: 27,
  mintHistory: { maxPages: 20, funderPages: 3, funderTransactions: 10, insiderSlots: 2, firstBuyers: 20 },
});

/** The S0 shakedown on live-like facts: no curve volume, no graduates series, no exec-health fact, creates coverage from 2 days ago, H15 simulated live. */
/** The regime parts the served status says were not judged (API-1: the card's "practice" marker). */
const servedWaived = (h: Awaited<ReturnType<typeof shakedown>>) => (route('/api/v1/paper/status', () => h.worker.apiInputs()).body as { data: { regime: { waived: string[] } | null } }).data.regime?.waived;

const shakedown = async (diag: boolean, asked: [string, bigint][] = []) => {
  const h = makeWorker({ timers: dueTimers(T - 16 * DAY), entry: { timing: 'random', salt: early, s0Diagnostic: diag }, facts: [simulating(asked)], config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18980', ZEROED_API_ADDR: '127.0.0.1:18981' } });
  // Started, so the fact source runs; the critical feed is up, so entries are not halted.
  // The clock moves only when the test moves it (the fact source's timer fires on time, not at once).
  let started: unknown = null;
  void h.worker.start().then((r) => void (started = r));
  for (let k = 0; k < 200 && started === null; k++) {
    h.timers.set(h.timers.now() + 100);
    for (let j = 0; j < 4; j++) await new Promise<void>((r) => setImmediate(r));
  }
  expect(started).toEqual({ ok: true });
  h.worker.feed.ingest('helius', { type: 'offchain', key: 'feed:status:helius', value: { state: 'up' } }, { receivedAt: h.timers.now() });
  const m = await passingMarket(h, { ...HELD, omit: [CURVE_VOLUME_KEY, GRADUATES_KEY, EXEC_HEALTH_KEY, simKey(MINT)], coverageAt: T - 2 * DAY });
  await m.run(4_000, 100, () => m.pool());
  await m.run(10_000, 400, () => {
    m.slot();
    m.pool();
  });
  await h.worker.stop();
  return h;
};

describe('the S0 shakedown on live-like facts', () => {
  it('makes no entry without the diagnostic set: the regime and H14 cannot be judged', async () => {
    const h = await shakedown(false);
    expect(Object.values(h.worker.book.positions)).toEqual([]);
    const rejects = lines(h.stateDir).filter((l) => l['kind'] === 'decision' && l['action'] === 'reject');
    expect(rejects.length).toBeGreaterThan(0);
    expect(rejects.every((l) => l['s0_diagnostic'] === undefined)).toBe(true);
    // The status serves a regime judged in full: nothing waived.
    expect(servedWaived(h)).toEqual([]);
  });

  it('with the set it enters, simulates every entry, and names each part it relied on', async () => {
    const asked: [string, bigint][] = [];
    const h = await shakedown(true, asked);
    // H15 was judged on the simulation the fact source made at the gate's own spend.
    expect(asked.length).toBeGreaterThanOrEqual(1);
    expect(asked.every(([mint]) => mint === MINT)).toBe(true);
    const report = checkJournal(readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8'));
    expect(report.problems).toEqual([]);
    expect(report.entries).toBeGreaterThanOrEqual(1);
    // Each entry is built and simulated first (TEST-2), as without the set.
    expect(h.legs.filter((l) => l.leg === 'entry').length).toBe(report.entries);
    const all = lines(h.stateDir);
    const enter = all.find((l) => l['kind'] === 'decision' && l['action'] === 'enter')!;
    expect(enter['s0_diagnostic']).toEqual(['regime-volume', 'regime-survival', 'exec-health', 'h14-creates-coverage']);
    expect(all.find((l) => l['kind'] === 'decision' && l['action'] === 'mark_eligible')!['s0_diagnostic']).toEqual(enter['s0_diagnostic']);
    expect(all.find((l) => l['kind'] === 'decision' && l['action'] === 'approve_risk')!['s0_diagnostic']).toEqual(enter['s0_diagnostic']);
    // Every part on every line it changed (the entry's two lines and the rejects before it), counted for the report.
    const n = report.s0_diagnostic['exec-health']!;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(report.s0_diagnostic).toEqual({ 'regime-volume': n, 'regime-survival': n, 'exec-health': n, 'h14-creates-coverage': n });
    // Exec-health is measured from paper's own attempts (every one lands in this scenario), for the owner's limits.
    const stats = h.worker.execStats();
    expect(stats.attempts).toBeGreaterThanOrEqual(report.entries);
    expect(stats.failed).toBe(0);
    expect(stats.landingSlotsP50).toBeGreaterThanOrEqual(1);
    expect(stats.quoteErrorBpsP50).not.toBeNull();
    // The start line and /health name the set; the qualifying guard fails on it.
    const start = all.find((l) => l['kind'] === 'start')!;
    expect(start['s0_diagnostic']).toEqual(S0_DIAGNOSTIC_PARTS);
    expect(h.worker.health().s0_diagnostic).toEqual(S0_DIAGNOSTIC_PARTS);
    expect(entryRule(report.starts, 'S0', ['S0']).problems).toContainEqual(expect.stringContaining('S0 diagnostic'));
    // The status serves every part the set waived, H14's creates coverage included (API-1 B1, N1): the card shows
    // "On (practice)", never a plain "On".
    expect(servedWaived(h)).toEqual(['regime-volume', 'regime-survival', 'exec-health', 'h14-creates-coverage']);
  });
});

describe('the served regime under the set (API-1 N1\')', () => {
  it('names every part of the set, H14\'s creates coverage included, even when the candidate stopped before H14', async () => {
    const h = makeWorker({ entry: { timing: 'random', salt: early, s0Diagnostic: true }, config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18986', ZEROED_API_ADDR: '127.0.0.1:18987' } });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    // No fee terms and no swap seen: the pool cannot be quoted, so the candidate stops before the hard gates run.
    const m = await passingMarket(h, { ...HELD, fees: false, omit: [CURVE_VOLUME_KEY, GRADUATES_KEY, EXEC_HEALTH_KEY, simKey(MINT)], coverageAt: T - 2 * DAY });
    await m.run(4_000, 400, () => {
      m.slot();
      m.pool();
    });
    const cand = h.worker.apiInputs().discovered.find((t) => t.mint === MINT)!;
    expect(cand.gates).toEqual([expect.objectContaining({ gate: 'worker', code: 'no-market' })]);
    expect(servedWaived(h)).toEqual(['regime-volume', 'regime-survival', 'exec-health', 'h14-creates-coverage']);
    await h.worker.stop();
  });
});

describe('a reject line under the set', () => {
  it('is written again when only the parts it relied on change', async () => {
    const h = makeWorker({ entry: { timing: 'random', salt: early, s0Diagnostic: true }, config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18984', ZEROED_API_ADDR: '127.0.0.1:18985' } });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    // No simulation ever: the candidate keeps rejecting on H15 with the same reason.
    const m = await passingMarket(h, { ...HELD, omit: [CURVE_VOLUME_KEY, GRADUATES_KEY, EXEC_HEALTH_KEY, simKey(MINT)], coverageAt: T - 2 * DAY });
    await m.run(4_000, 400, () => {
      m.slot();
      m.pool();
    });
    // The curve-volume series arrives: the same reject no longer relies on regime-volume.
    m.omit = new Set([GRADUATES_KEY, EXEC_HEALTH_KEY, simKey(MINT)]);
    m.fact(CURVE_VOLUME_KEY, passingFacts().get(CURVE_VOLUME_KEY)!.value);
    await m.run(4_000, 400, () => {
      m.slot();
      m.pool();
    });
    await h.worker.stop();
    const h15 = lines(h.stateDir).filter((l) => l['action'] === 'reject' && String((l['reasons'] as string[])[3]).includes('H15'));
    expect(h15.map((l) => l['s0_diagnostic'])).toEqual([
      ['regime-volume', 'regime-survival', 'exec-health', 'h14-creates-coverage'],
      ['regime-survival', 'exec-health', 'h14-creates-coverage'],
    ]);
  });
});

describe('ZEROED_S0_DIAGNOSTIC', () => {
  const env = (over: Record<string, string>) => ({ STATE_DIRECTORY: tempState(), ZEROED_MODE: 'paper', ...over });
  it('is on only for S0, never in a release that names a qualifying run, and only as "on"', () => {
    const ok = parseConfig(env({ ZEROED_STRATEGY: 'S0', ZEROED_S0_DIAGNOSTIC: 'on' }), () => null, null);
    expect(ok.ok && ok.config.strategy.s0Diagnostic).toBe(true);
    expect(parseConfig(env({ ZEROED_S0_DIAGNOSTIC: 'on' }), () => null, null)).toMatchObject({ ok: false, message: expect.stringContaining('only for the S0 shakedown') });
    expect(parseConfig(env({ ZEROED_STRATEGY: 'S0', ZEROED_S0_DIAGNOSTIC: 'yes' }), () => null, null)).toMatchObject({ ok: false });
    // A release with qualifying-run.json: refused even under a shakedown run id.
    expect(parseConfig(env({ ZEROED_STRATEGY: 'S0', ZEROED_S0_DIAGNOSTIC: 'on', ZEROED_RUN_ID: 'shakedown-1' }), () => null, 'q-run')).toMatchObject({ ok: false, message: expect.stringContaining('qualifying run') });
    expect(testConfig(tempState()).strategy.s0Diagnostic).toBe(false);
  });
});

describe('EXIT-1 negative flow from the held pool\'s swaps', () => {
  const held = async () => {
    const h = makeWorker({ config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18982', ZEROED_API_ADDR: '127.0.0.1:18983' } });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, HELD);
    await m.run(4_000, 100, () => m.pool());
    await m.run(10_000, 400, () => {
      m.slot();
      m.pool();
    });
    const open = Object.values(h.worker.book.positions).find((p) => p.status === 'open');
    expect(open?.mint).toBe(MINT);
    return { h, m, id: open!.id };
  };
  const exitReasons = (dir: string) => lines(dir).filter((l) => l['kind'] === 'decision' && (l['reasons'] as string[])[0] === 'exit').flatMap((l) => l['reasons'] as string[]);

  it('sells outweighing buys for 5 whole minutes after entry close the position as negative flow', async () => {
    const { h, m, id } = await held();
    // Each 400 ms: a sale of 0.5 SOL and a buy of 0.1 SOL, the price held where it is (the pool fact re-published).
    let k = 0;
    await m.run(6 * 60_000 + 2_000, 400, () => {
      m.slot();
      m.pool();
      m.swap('SellEvent', `seller${k}`, 1_000_000n, 500_000_000n);
      m.swap('BuyEvent', `buyer${k++}`, 1_000_000n, 100_000_000n);
    });
    expect(exitReasons(h.stateDir).some((r) => r.startsWith('negative_flow'))).toBe(true);
    expect(h.worker.book.positions[id]!.status).not.toBe('open');
    await h.worker.stop();
  });

  it('the strategy passes only finished minutes, oldest first', () => {
    const m = new Map<number, bigint>([[120_000, -5n], [0, -1n], [60_000, 2n]]);
    expect(closedFlow(m, 179_999)).toEqual([{ startMs: 0, net: -1n }, { startMs: 60_000, net: 2n }]);
    expect(closedFlow(m, 180_000)).toEqual([{ startMs: 0, net: -1n }, { startMs: 60_000, net: 2n }, { startMs: 120_000, net: -5n }]);
  });

  it('a big sale in the still-open minute counts only once that minute closes', async () => {
    const { h, m, id } = await held();
    // Four whole minutes of net selling, then the fifth opens with a large sale.
    const minuteStart = Math.floor(m.now / 60_000) * 60_000;
    let k = 0;
    await m.run(minuteStart + 5 * 60_000 - m.now, 400, () => {
      m.slot();
      m.pool();
      m.swap('SellEvent', `seller${k}`, 1_000_000n, 200_000_000n);
      m.swap('BuyEvent', `buyer${k++}`, 1_000_000n, 100_000_000n);
    });
    const fifth = minuteStart + 5 * 60_000;
    let sold = false;
    // Inside the fifth minute: one big sale at its start, then quiet; the run of five is not complete until it closes.
    await m.run(fifth + 59_000 - m.now, 400, () => {
      m.slot();
      m.pool();
      if (!sold && m.now >= fifth) {
        m.swap('SellEvent', 'whale', 1_000_000n, 5_000_000_000n);
        sold = true;
      }
    });
    const fired = () => exitReasons(h.stateDir).some((r) => r.startsWith('negative_flow'));
    expect(sold).toBe(true);
    expect(fired()).toBe(false);
    expect(h.worker.book.positions[id]!.status).toBe('open');
    await m.run(3_000, 400, () => {
      m.slot();
      m.pool();
    });
    expect(fired()).toBe(true);
    await h.worker.stop();
  });

  it('net buying never fires it, and a swap released twice (two keys, one signature) counts once', async () => {
    const { h, m, id } = await held();
    let k = 0;
    const sale = (n: number) => ({
      event: { program: 'pump_amm', name: 'SellEvent', data: { pool: POOL_ADDRESS, user: `seller${n}`, baseAmountIn: 1_000_000n, quoteAmountOut: 150_000_000n, timestamp: 0n } },
      signature: `dup-${n}`,
    });
    await m.run(6 * 60_000 + 2_000, 400, () => {
      m.slot();
      m.pool();
      // Counted twice, sales (0.3 SOL) would outweigh the buy (0.2 SOL) every minute.
      m.fact(`logs:pump_amm:SellEvent:${POOL_ADDRESS}:dup-a-${k}`, sale(k));
      m.fact(`logs:pump_amm:SellEvent:${POOL_ADDRESS}:dup-b-${k}`, sale(k));
      m.swap('BuyEvent', `buyer${k++}`, 1_000_000n, 200_000_000n);
    });
    expect(exitReasons(h.stateDir).some((r) => r.startsWith('negative_flow'))).toBe(false);
    expect(h.worker.book.positions[id]!.status).toBe('open');
    await h.worker.stop();
  });
});

describe('the runner report counts H15\'s simulations and their credits', () => {
  it('h15_sim lines: how many, how many ran, the credits spent (the live feed\'s are in the quota)', () => {
    const line = (seq: number, kind: string, more: Record<string, unknown> = {}) => JSON.stringify({ seq, ts: '2026-10-04T00:00:00.000Z', boot: 'b', kind, ...more });
    const text = [
      line(1, 'start'),
      line(2, 'h15_sim', { outcome: 'simulated', credits: 3 }),
      line(3, 'h15_sim', { outcome: 'not-run', reason: 'hourly cap: 120 simulations in the last hour', credits: 0 }),
      line(4, 'h15_sim', { outcome: 'rpc-error', credits: 2 }),
    ].join('\n');
    expect(checkJournal(text).h15_sim).toEqual({ lines: 3, run: 2, credits: 5 });
  });
});
