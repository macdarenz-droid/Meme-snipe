// PERSIST-3: a held position's exit inputs (its deployer, the deployer's sales, the pool's net flow) survive a restart
// with the exits file, as of the save; when they cannot come back the position is flattened (sell-only), never left
// with exits that count from zero.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRIAL_POLICY } from '../../core/src/config/index.ts';
import { parseTyped, typedText } from '../src/run/json.ts';
import { DEV, MINT, Market, POOL_ADDRESS, SUPPLY, makeWorker, passingMarket } from './worker-harness.ts';

const HELD = { heldPoolFacts: true } as const;
type H = ReturnType<typeof makeWorker>;
const lines = (h: H) => readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const mine = (h: H) => lines(h).filter((l) => l['boot'] === h.worker.boot && l['kind'] === 'decision').map((l) => (l['reasons'] as string[]) ?? []);
const position = (h: H) => Object.values(h.worker.book.positions).find((p) => String(p.mint) === MINT);
/** 60% of the deployer-sell threshold, in tokens: two of them cross it, one does not. */
const SHARE = (SUPPLY * BigInt(TRIAL_POLICY.exits.deployerSellSupplyBps) * 6n) / 10n / 10_000n;
const keep = async (m: Market, ms: number) => m.run(ms, 400, () => {
  m.slot();
  m.pool();
});

/** Holds the passing mint, its create seen and 60% of the threshold sold by the deployer; then killed. */
const heldAndKilled = async () => {
  const h = makeWorker({ config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18992', ZEROED_API_ADDR: '127.0.0.1:18993' } });
  expect(await h.worker.reconcile()).toEqual({ ok: true });
  const m = await passingMarket(h, HELD);
  m.create();
  await m.run(4_000, 100, () => m.pool());
  await keep(m, 10_000);
  expect(position(h)?.status).toBe('open');
  m.swap('SellEvent', DEV, SHARE);
  await keep(m, 2_000);
  expect(position(h)?.status).toBe('open');
  await h.worker.kill();
  return h;
};

const restart = async (h: H, port = 18994) => {
  const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers, config: { ZEROED_HEALTH_ADDR: `127.0.0.1:${port}`, ZEROED_API_ADDR: `127.0.0.1:${port + 1}` } });
  expect(await h2.worker.reconcile()).toEqual({ ok: true });
  return { h2, m2: new Market(h2, HELD) };
};

type Saved = Record<string, Record<string, unknown> & { deployer: { sellers: unknown[] } | null; deployerSales: { ids: string[]; list: { atMs: number; amount: unknown }[] }; flow: { minutes: [number, bigint][]; ids: [string, number][] } }>;
/** Rewrites the saved exits file of a killed worker. */
const edit = (h: H, f: (s: Saved[string]) => void) => {
  const path = join(h.stateDir, 'exits.json');
  const saved = parseTyped(readFileSync(path, 'utf8')) as Saved;
  for (const s of Object.values(saved)) f(s);
  writeFileSync(path, typedText(saved));
};
/** EXIT-KEEP: inputs that did not come back put the position in EXIT-1g's sell-only recovery, the reason saved with it. */
const sellOnly = (h: H, why: string) => mine(h).some((r) => r[0] === 'recovery exit' && r[2] === `exit inputs not restored (${why})`);
/** The whole holding exits through the recovery's emergency full exit (the price has not moved: no trigger fired). */
const flattened = (h: H) => mine(h).some((r) => r[0] === 'exit');

describe('PERSIST-3: exit inputs across a restart', () => {
  it('60% of the threshold sold before the restart and 60% after: deployer_sell fires (the create is not seen again)', async () => {
    const h = await heldAndKilled();
      const { h2, m2 } = await restart(h);
    await keep(m2, 2_000);
    expect(position(h2)?.status).toBe('open');
    // A new market's swaps number from 1 again: a first swap by someone else keeps the deployer's signature new.
    m2.swap('BuyEvent', 'someone-else', 1n);
    m2.swap('SellEvent', DEV, SHARE);
    await keep(m2, 4_000);
    expect(mine(h2).some((r) => r[0] === 'exit' && r.some((x) => x.startsWith('deployer_sell')))).toBe(true);
    await h2.worker.stop();
  });

  it('a saved exit without its inputs (a file from before PERSIST-3) puts the position in sell-only recovery, reported, instead of counting from zero', async () => {
    const h = await heldAndKilled();
    const path = join(h.stateDir, 'exits.json');
    // Drop the three fields from every saved exit, as an older worker wrote them.
    const saved = parseTyped(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>>;
    for (const s of Object.values(saved)) for (const k of ['deployer', 'deployerSales', 'flow']) delete s[k];
    writeFileSync(path, typedText(saved));
    expect(readFileSync(path, 'utf8')).not.toContain('deployerSales');
    const { h2, m2 } = await restart(h);
    await keep(m2, 4_000);
    expect(sellOnly(h2, 'not in the saved exit')).toBe(true);
    expect(mine(h2).some((r) => r[0] === 'exit')).toBe(true);
    await h2.worker.stop();
  });

  it.each([
    ['a sale', (s: Saved[string], at: number) => s.deployerSales.list.push({ atMs: at, amount: 1n })],
    ['a flow minute', (s: Saved[string], at: number) => s.flow.minutes.push([at, -1n])],
    ['a flow id', (s: Saved[string], at: number) => s.flow.ids.push(['later', at])],
  ])('is as-of honest: %s dated after the restore refuses the inputs whole (sell-only), never dropped alone', async (_, add) => {
    const h = await heldAndKilled();
    // A host clock behind the save: the file holds an entry a day ahead of the restore.
    edit(h, (s) => add(s, h.timers.now() + 86_400_000));
    const { h2, m2 } = await restart(h);
    await keep(m2, 4_000);
    expect(sellOnly(h2, 'dated after the restore')).toBe(true);
    expect(flattened(h2)).toBe(true);
    await h2.worker.stop();
  });

  it.each([
    ['a sale amount as a number', (s: Saved[string]) => { s.deployerSales.list[0]!.amount = 1; }],
    ['a deployer without sellers', (s: Saved[string]) => { s.deployer!.sellers = []; }],
    // A negative amount would offset the real sales and hide a dump (persist review B2).
    ['a negative sale amount', (s: Saved[string]) => { s.deployerSales.list[0]!.amount = -1n; }],
  ])('a malformed field (%s) flattens the position (sell-only)', async (_, spoil) => {
    const h = await heldAndKilled();
    edit(h, (s) => {
      expect(s.deployer).not.toBeNull();
      expect(s.deployerSales.list).toHaveLength(1);
      spoil(s);
    });
    const { h2, m2 } = await restart(h);
    await keep(m2, 4_000);
    expect(sellOnly(h2, 'malformed')).toBe(true);
    expect(flattened(h2)).toBe(true);
    await h2.worker.stop();
  });

  it('stays sell-only across a second restart: the recovery reason is saved in the file, the inputs written since never read as complete', async () => {
    const h = await heldAndKilled();
    edit(h, (s) => {
      for (const k of ['deployer', 'deployerSales', 'flow']) delete s[k];
    });
    const { h2, m2 } = await restart(h);
    // Slots only: no pool read, so the flatten waits for a quote and the position is still held at the kill.
    await m2.run(2_000, 400, () => m2.slot());
    expect(sellOnly(h2, 'not in the saved exit')).toBe(true);
    expect(position(h2)?.status).toBe('open');
    await h2.worker.kill();
    // EXIT-KEEP: one mechanism, EXIT-1g's recovery; its reason is what the file keeps (no separate flag).
    const file = readFileSync(join(h.stateDir, 'exits.json'), 'utf8');
    expect(file).toContain('exit inputs not restored (not in the saved exit)');
    expect(file).not.toContain('inputsLost');
    const { h2: h3, m2: m3 } = await restart(h2, 18998);
    // The inputs written by the second boot are well formed, but the position is still in recovery.
    expect(Object.values(h3.worker.strategy.saved()).map((x) => x.recovery)).toEqual(['exit inputs not restored (not in the saved exit)']);
    await keep(m3, 4_000);
    expect(flattened(h3)).toBe(true);
    await h3.worker.stop();
  });

  it('a file with PERSIST-3\'s inputsLost flag (written before EXIT-KEEP) keeps the position in sell-only recovery', async () => {
    const h = await heldAndKilled();
    edit(h, (s) => {
      s['inputsLost'] = true;
    });
    const { h2, m2 } = await restart(h);
    expect(sellOnly(h2, 'lost at an earlier restart')).toBe(true);
    const saved = Object.values(h2.worker.strategy.saved());
    expect(saved.map((x) => [x.recovery, x.tracker.pendingFull, x.inputsLost])).toEqual([['exit inputs not restored (lost at an earlier restart)', ['emergency'], undefined]]);
    await keep(m2, 4_000);
    expect(flattened(h2)).toBe(true);
    await h2.worker.stop();
  });

  it('a refused saved plan (its inputs never read) stays in sell-only recovery across a second restart, though the inputs saved since are well formed', async () => {
    const h = await heldAndKilled();
    edit(h, (s) => {
      (s['plan'] as Record<string, unknown>)['stopPrice'] = 'none';
    });
    const { h2, m2 } = await restart(h);
    await m2.run(2_000, 400, () => m2.slot());
    expect(mine(h2).some((r) => r[0] === 'recovery exit' && r[2] === 'saved plan refused')).toBe(true);
    expect(position(h2)?.status).toBe('open');
    await h2.worker.kill();
    const { h2: h3, m2: m3 } = await restart(h2, 18998);
    expect(Object.values(h3.worker.strategy.saved()).map((x) => x.recovery)).toEqual(['saved plan refused']);
    await keep(m3, 4_000);
    expect(flattened(h3)).toBe(true);
    await h3.worker.stop();
  });

  it('restores the deployer sale ids: the same sale released again after the restart counts once', async () => {
    const h = await heldAndKilled();
    let id = '';
    edit(h, (s) => {
      expect(s.deployerSales.ids).toHaveLength(1);
      id = s.deployerSales.ids[0]!;
    });
    const { h2, m2 } = await restart(h);
    await keep(m2, 2_000);
    const [signature, user, base] = id.split('|');
    expect([user, base]).toEqual([DEV, String(SHARE)]);
    m2.fact(`logs:pump_amm:SellEvent:${POOL_ADDRESS}:again`, { event: { program: 'pump_amm', name: 'SellEvent', data: { pool: POOL_ADDRESS, user: DEV, baseAmountIn: SHARE, quoteAmountOut: 1n, baseSupply: SUPPLY } }, signature });
    await keep(m2, 4_000);
    expect(mine(h2).some((r) => r[0] === 'exit')).toBe(false);
    expect(position(h2)?.status).toBe('open');
    await h2.worker.stop();
  });

  /** Net selling for 3 whole minutes on a held position (swaps tagged `a`, numbered from 1), then killed. */
  const flowKilled = async (port: number) => {
    const h = makeWorker({ config: { ZEROED_HEALTH_ADDR: `127.0.0.1:${port}`, ZEROED_API_ADDR: `127.0.0.1:${port + 1}` } });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, HELD);
    await m.run(4_000, 100, () => m.pool());
    await keep(m, 10_000);
    expect(position(h)?.status).toBe('open');
    // Up to just inside the fourth minute after a minute boundary: three whole negative minutes.
    const start = Math.ceil(m.now / 60_000) * 60_000;
    await m.run(start - m.now, 400, () => {
      m.slot();
      m.pool();
    });
    await m.run(3 * 60_000 + 1_000, 400, flow(m, 'a'));
    expect(lines(h).some((l) => l['kind'] === 'decision' && ((l['reasons'] as string[]) ?? []).some((x) => x.startsWith('negative_flow')))).toBe(false);
    await h.worker.kill();
    return h;
  };
  /** Each step: one sell of 0.3 SOL and one buy of 0.1 SOL, each with its own signature `<tag>-<n>` (n from 1 per tag). */
  const flow = (mk: Market, tag: string) => {
    let n = 0;
    return () => {
      mk.slot();
      mk.pool();
      for (const [name, quote] of [['SellEvent', 300_000_000n], ['BuyEvent', 100_000_000n]] as const) {
        const k = ++n;
        mk.fact(`logs:pump_amm:${name}:${POOL_ADDRESS}:${tag}${k}`, { event: { program: 'pump_amm', name, data: { pool: POOL_ADDRESS, user: `u${k}`, ...(name === 'SellEvent' ? { baseAmountIn: 1_000n, quoteAmountOut: quote } : { baseAmountOut: 1_000n, quoteAmountIn: quote }) } }, signature: `${tag}-${k}` });
      }
    };
  };

  it('net selling for 3 whole minutes before the restart and 3 after: negative_flow fires across it', async () => {
    const h = await flowKilled(18996);
    const { h2, m2 } = await restart(h);
    await m2.run(2 * 60_000 + 2_000, 400, flow(m2, 'b'));
    expect(mine(h2).some((r) => r[0] === 'exit' && r.some((x) => x.startsWith('negative_flow')))).toBe(true);
    await h2.worker.stop();
  });

  it('restores every flow id, the oldest minute too: swaps released again after the restart count once', async () => {
    const h = await flowKilled(18996);
    edit(h, (s) => {
      // Ids from the first of the three minutes, more than 2 minutes before the newest, are kept.
      const first = s.flow.minutes[0]![0];
      expect(s.flow.minutes.at(-1)![0] - first).toBeGreaterThanOrEqual(3 * 60_000);
      expect(s.flow.ids.some(([, at]) => at === first)).toBe(true);
    });
    const { h2, m2 } = await restart(h);
    // The same swaps again (a fill re-releasing them): with their ids restored, no minute after the restart is negative.
    await m2.run(3 * 60_000 + 2_000, 400, flow(m2, 'a'));
    expect(mine(h2).some((r) => r.some((x) => x.startsWith('negative_flow')))).toBe(false);
    expect(position(h2)?.status).toBe('open');
    await h2.worker.stop();
  });
});
