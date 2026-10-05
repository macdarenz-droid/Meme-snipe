// EXIT-KEEP (AUDIT-RM3): what a restart must keep for an open position's exit. Crash images of the state dir are taken
// at the exact point a SIGKILL would leave them, and a new worker starts on the image.
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SavedExit } from '../src/engine/strategy.ts';
import { TRIAL_POLICY } from '../../core/src/config/index.ts';
import { StateFile, exitsFile } from '../src/run/state.ts';
import { DEV, Market, POOL_ADDRESS, SUPPLY, makeWorker, passingMarket, until } from './worker-harness.ts';

type H = ReturnType<typeof makeWorker>;
const HELD = { heldPoolFacts: true } as const;

const tick = (m: Market, scalePpm = 1_000_000n) => (): void => {
  m.slot();
  m.pool(scalePpm);
};

describe('a re-made exit after a hard kill is sent at once (EXIT-KEEP B3)', () => {
  it('killed after the paper world saved the exit attempt but before the ledger booked it: the restart exits within a few slots, at the first rung', async () => {
    let image: string | null = null;
    let h: H | null = null;
    h = makeWorker({
      // The paper world reports send_accepted right after it saved paper.json, inside the engine's drain: the ledger has
      // not booked this step yet. A crash image there is what a kill at that point leaves on disk.
      worldFault: (e) => {
        if (image === null && e.type === 'intent' && e.event.type === 'send_accepted' && h!.worker.book.intents[e.intentId]?.intent.purpose === 'exit') {
          image = mkdtempSync(join(tmpdir(), 'zeroed-crash-'));
          cpSync(h!.stateDir, image, { recursive: true });
        }
        return e;
      },
    });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, HELD);
    expect(await until(m, 30_000, () => Object.values(h!.worker.book.positions).some((p) => p.status === 'open'), tick(m))).toBe(true);
    const pid = Object.values(h.worker.book.positions).find((p) => p.status === 'open')!.id;
    // The price falls through the stop: the exit is decided and its first attempt broadcast.
    expect(await until(m, 30_000, () => image !== null, tick(m, 700_000n))).toBe(true);
    await h.worker.stop();

    rmSync(join(image!, 'cold_start'), { force: true });
    const h2 = makeWorker({ stateDir: image!, timers: h.timers });
    expect(await h2.worker.start()).toEqual({ ok: true });
    expect(h2.worker.book.positions[pid]!.status).toBe('open');
    const m2 = new Market(h2, HELD);
    expect(await until(m2, 200_000, () => h2.worker.book.positions[pid]!.status === 'closed', tick(m2, 700_000n))).toBe(true);
    // From the re-made exit's decision to its fill: the paper world's landing, not a dead signature waiting out its
    // blockhash (150 slots, about 60 s) before a second attempt.
    const ls = readFileSync(join(image!, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l['boot'] === h2.worker.boot);
    const at = (kind: string, first: string) => Date.parse(String(ls.find((l) => l['kind'] === kind && (l['reasons'] as string[] | undefined)?.[0] === first)!['ts']));
    expect(at('exit', 'exit filled (paper)') - at('decision', 'prepare exit')).toBeLessThan(40_000);
    // One attempt, at the ladder's first rung: no rung was burned on the dead signature.
    const exits = Object.values(h2.worker.book.intents).filter((i) => i.intent.purpose === 'exit' && i.intent.positionId === pid);
    expect(exits.flatMap((i) => i.attempts)).toHaveLength(1);
    await h2.worker.stop();
  });
});

describe('a blocked-exit retry the ledger never booked is not spent (EXIT-KEEP N1)', () => {
  it('killed after the plans counted the retry but before the desk booked it: the restart counts only booked retries and retries at once', async () => {
    let image: string | null = null;
    let pid = '';
    const write = StateFile.prototype.write;
    // Every exits.json write, and the most retries each boot's writes counted for the position.
    const counted = new Map<string, number>();
    let boot = 'first';
    const spy = vi.spyOn(StateFile.prototype, 'write').mockImplementation(function (this: StateFile<unknown>, v: unknown) {
      write.call(this, v);
      if (!this.path.endsWith('exits.json') || pid === '') return;
      const t = (v as Record<string, SavedExit>)[pid]?.tracker;
      if (t === undefined) return;
      counted.set(boot, Math.max(counted.get(boot) ?? 0, t.blockedRetries));
      // The step's plans are on disk with the retry counted; the desk has not booked the step yet.
      if (boot === 'first' && image === null && t.blockedRetries > 0) {
        image = mkdtempSync(join(tmpdir(), 'zeroed-crash-'));
        cpSync(this.path.slice(0, -'/exits.json'.length), image, { recursive: true });
      }
    });
    try {
      const h = makeWorker();
      expect(await h.worker.reconcile()).toEqual({ ok: true });
      const m = await passingMarket(h, HELD);
      expect(await until(m, 30_000, () => Object.values(h.worker.book.positions).some((p) => p.status === 'open'), tick(m))).toBe(true);
      pid = Object.values(h.worker.book.positions).find((p) => p.status === 'open')!.id;
      // A pool that cannot quote the sale: the stop's exit is booked blocked.
      expect(await until(m, 30_000, () => h.worker.book.positions[pid]!.status === 'exit_blocked', tick(m, 0n))).toBe(true);
      // A quoting pool again, below the stop: the blocked-retry wait passes and the retry is decided.
      expect(await until(m, 120_000, () => image !== null, tick(m, 700_000n))).toBe(true);
      await h.worker.stop();

      boot = 'second';
      rmSync(join(image!, 'cold_start'), { force: true });
      const h2 = makeWorker({ stateDir: image!, timers: h.timers });
      expect(await h2.worker.start()).toEqual({ ok: true });
      expect(h2.worker.book.positions[pid]!.status).toBe('exit_blocked');
      const m2 = new Market(h2, HELD);
      expect(await until(m2, 200_000, () => h2.worker.book.positions[pid]!.status === 'closed', tick(m2, 700_000n))).toBe(true);
      const ls = readFileSync(join(image!, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((l) => l['boot'] === h2.worker.boot && l['kind'] === 'decision');
      expect(ls.filter((l) => (l['reasons'] as string[])[0] === 'blocked retry not booked').map((l) => l['reasons'])).toEqual([['blocked retry not booked', pid, '1 retry not in the ledger; due again at once']]);
      // The lost retry was due when it was decided: the restart sends it on its first quoting step, before a new
      // blocked-retry wait (counted from its first step after the restore) could pass.
      const ts = (first: string) => Date.parse(String(ls.find((l) => (l['reasons'] as string[])[0] === first)!['ts']));
      expect(ts('retry blocked exit') - ts('blocked retry not booked')).toBeLessThan(TRIAL_POLICY.exits.blockedRetryMs);
      // The restart's retry is the first the ledger holds: one retry spent, not two.
      expect(counted.get('second')).toBe(1);
      await h2.worker.stop();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('a restart keeps the deployer sales and the flow it has seen (EXIT-KEEP B2)', () => {
  const journal = (dir: string) => readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  it('the deployer sells 1.5% of supply, the worker restarts, the deployer sells 1% more: 2.5% exits the position (deployer_sell)', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const pre = new Market(h);
    pre.create();
    h.worker.step();
    const m = await passingMarket(h, HELD);
    expect(await until(m, 30_000, () => Object.values(h.worker.book.positions).some((p) => p.status === 'open'), tick(m))).toBe(true);
    const pid = Object.values(h.worker.book.positions).find((p) => p.status === 'open')!.id;
    m.swap('SellEvent', DEV, (SUPPLY * 150n) / 10_000n);
    await m.run(2_000, 400, tick(m));
    expect(h.worker.book.positions[pid]!.status).toBe('open');
    await h.worker.kill();

    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    const m2 = new Market(h2, HELD);
    await m2.run(2_000, 400, tick(m2));
    expect(h2.worker.book.positions[pid]!.status).toBe('open');
    // 1% more: under the 2% trigger alone, over it with the 1.5% seen before the restart.
    m2.swap('SellEvent', DEV, (SUPPLY * 100n) / 10_000n);
    expect(await until(m2, 20_000, () => h2.worker.book.positions[pid]!.status === 'closed', tick(m2))).toBe(true);
    const exit = journal(h.stateDir).filter((l) => l['kind'] === 'exit' && l['boot'] === h2.worker.boot);
    expect(exit[0]!['reasons']).toEqual(expect.arrayContaining(['thesis_lost']));
    await h2.worker.stop();
  });
});

describe('a restart keeps the negative-flow run it has seen (EXIT-KEEP B2)', () => {
  const journal = (dir: string) => readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const selling = (m: Market) => {
    let k = 0;
    return (): void => {
      m.slot();
      m.pool();
      m.swap('SellEvent', `seller${m.now}-${k}`, 1_000_000n, 500_000_000n);
      m.swap('BuyEvent', `buyer${m.now}-${k++}`, 1_000_000n, 100_000_000n);
    };
  };
  it('three minutes of net selling, a restart, then net selling: the run of five ends within three minutes, not five fresh ones', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, HELD);
    expect(await until(m, 30_000, () => Object.values(h.worker.book.positions).some((p) => p.status === 'open'), tick(m))).toBe(true);
    const pid = Object.values(h.worker.book.positions).find((p) => p.status === 'open')!.id;
    // Start the run on a whole minute after the entry, and sell through three whole minutes.
    const start = (Math.floor(m.now / 60_000) + 1) * 60_000;
    await m.run(start - m.now, 400, tick(m));
    await m.run(3 * 60_000, 400, selling(m));
    expect(h.worker.book.positions[pid]!.status).toBe('open');
    await h.worker.kill();

    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    const m2 = new Market(h2, HELD);
    const restarted = m2.now;
    expect(await until(m2, 6 * 60_000, () => h2.worker.book.positions[pid]!.status !== 'open', selling(m2))).toBe(true);
    const exits = journal(h.stateDir).filter((l) => l['boot'] === h2.worker.boot && l['kind'] === 'decision' && (l['reasons'] as string[])[0] === 'exit');
    expect(exits.flatMap((l) => l['reasons'] as string[]).some((r) => r.startsWith('negative_flow'))).toBe(true);
    // Minutes 4 and 5 of the run close at most three minutes after the restart; five fresh minutes would take five.
    expect(m2.now - restarted).toBeLessThan(3 * 60_000 + 30_000);
    await h2.worker.stop();
  });
});

describe('restored trade evidence is never counted twice (EXIT-KEEP review B1)', () => {
  /** A PumpSwap swap on the passing pool with a fixed signature, so the same event can be released again. */
  const swap = (m: Market, sig: string, name: 'BuyEvent' | 'SellEvent', user: string, base: bigint, quote: bigint): void => {
    const data = {
      pool: POOL_ADDRESS, user, ...(name === 'SellEvent' ? { baseAmountIn: base, quoteAmountOut: quote } : { baseAmountOut: base, quoteAmountIn: quote }),
      timestamp: BigInt(Math.floor(m.now / 1000)), lpFeeBasisPoints: 2n, protocolFeeBasisPoints: 93n, coinCreatorFeeBasisPoints: 30n, buybackFeeBasisPoints: 5_000n,
      ixName: name === 'SellEvent' ? 'sell' : 'buy_exact_quote_in_v2', baseSupply: SUPPLY,
    };
    m.fact(`logs:pump_amm:${name}:${POOL_ADDRESS}:${sig}:${m.now}`, { event: { program: 'pump_amm', name, data }, signature: sig });
  };
  const DEV_SALE = (SUPPLY * 150n) / 10_000n;
  /** Entered; the deployer sells 1.5% and one other sale makes a flow minute; killed. */
  const seen = async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const pre = new Market(h);
    pre.create();
    h.worker.step();
    const m = await passingMarket(h, HELD);
    expect(await until(m, 30_000, () => Object.values(h.worker.book.positions).some((p) => p.status === 'open'), tick(m))).toBe(true);
    const pid = Object.values(h.worker.book.positions).find((p) => p.status === 'open')!.id;
    swap(m, 'dev-sale', 'SellEvent', DEV, DEV_SALE, 300_000_000n);
    swap(m, 'other-sale', 'SellEvent', 'someone', 1_000_000n, 200_000_000n);
    await m.run(1_200, 400, tick(m));
    const before = h.worker.strategy.saved()[pid]!;
    expect(before.deployerSales!.list.map((s) => s.amount)).toEqual([DEV_SALE]);
    expect(before.flow!.minutes.length).toBeGreaterThan(0);
    await h.worker.kill();
    return { h, pid, before };
  };
  const totals = (e: SavedExit) => ({
    sold: e.deployerSales!.list.reduce((t, s) => t + s.amount, 0n), sales: e.deployerSales!.ids.length,
    flow: e.flow!.minutes.reduce((t, [, net]) => t + net, 0n), ids: e.flow!.ids.length,
  });

  it('the same swaps released again after the restart count once: the deployer share and the flow stay as they were', async () => {
    const { h, pid, before } = await seen();
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    const m2 = new Market(h2, HELD);
    await m2.run(800, 400, tick(m2));
    // A fill after the restart re-releases what was seen before the kill: same signature, user and amounts.
    swap(m2, 'dev-sale', 'SellEvent', DEV, DEV_SALE, 300_000_000n);
    swap(m2, 'other-sale', 'SellEvent', 'someone', 1_000_000n, 200_000_000n);
    await m2.run(1_200, 400, tick(m2));
    expect(totals(h2.worker.strategy.saved()[pid]!)).toEqual(totals(before));
    // Counted twice, 3% would be over the 2% trigger.
    expect(h2.worker.book.positions[pid]!.status).toBe('open');
    await h2.worker.stop();
  });

  it('evidence restored twice for one mint (two saved exits on it) counts once', async () => {
    const { h, pid, before } = await seen();
    const file = exitsFile(h.stateDir);
    const saved = file.read({});
    // A second saved exit on the same mint, carrying the same evidence.
    file.write({ ...saved, [`${pid.slice(0, pid.lastIndexOf(':'))}:9`]: saved[pid]! });
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    const m2 = new Market(h2, HELD);
    await m2.run(800, 400, tick(m2));
    expect(totals(h2.worker.strategy.saved()[pid]!)).toEqual(totals(before));
    expect(h2.worker.book.positions[pid]!.status).toBe('open');
    await h2.worker.stop();
  });
});

describe('saved blocked-retry ids the worker cannot act on are refused (EXIT-KEEP persist review B1)', () => {
  const journal = (dir: string) => readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  it.each([['a string', 'x'], ['a number in the list', [1]]] as const)('retryIds as %s refuses the saved exit into sell-only recovery; management goes on and the position exits', async (_, bad) => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, HELD);
    expect(await until(m, 30_000, () => Object.keys(h.worker.strategy.saved()).length > 0, tick(m))).toBe(true);
    const pid = Object.keys(h.worker.strategy.saved())[0]!;
    await h.worker.kill();
    const file = exitsFile(h.stateDir);
    const saved = file.read({});
    file.write({ ...saved, [pid]: { ...saved[pid]!, retryIds: bad as never } });
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    const m2 = new Market(h2, HELD);
    // A field the manage loop would throw on (a string has no filter) must never reach it: every position's exits run there.
    expect(await until(m2, 10_000, () => h2.worker.book.positions[pid]!.status === 'closed', tick(m2))).toBe(true);
    const said = journal(h.stateDir).filter((l) => l['boot'] === h2.worker.boot && l['kind'] === 'decision').map((l) => (l['reasons'] as string[]).slice(0, 3));
    expect(said).toEqual(expect.arrayContaining([['restore entry refused', pid, 'malformed saved plan'], ['recovery exit', pid, 'saved plan refused']]));
    await h2.worker.stop();
  });
});
