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

const restart = async (h: H) => {
  const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers, config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18994', ZEROED_API_ADDR: '127.0.0.1:18995' } });
  expect(await h2.worker.reconcile()).toEqual({ ok: true });
  return { h2, m2: new Market(h2, HELD) };
};

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

  it('a saved exit without its inputs (a file from before PERSIST-3) flattens the position, reported, instead of counting from zero', async () => {
    const h = await heldAndKilled();
    const path = join(h.stateDir, 'exits.json');
    // Drop the three fields from every saved exit, as an older worker wrote them.
    const saved = parseTyped(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>>;
    for (const s of Object.values(saved)) for (const k of ['deployer', 'deployerSales', 'flow']) delete s[k];
    writeFileSync(path, typedText(saved));
    expect(readFileSync(path, 'utf8')).not.toContain('deployerSales');
    const { h2, m2 } = await restart(h);
    await keep(m2, 4_000);
    expect(mine(h2).some((r) => r[0] === 'sell-only' && /exit inputs not restored \(not in the saved exit\)/.test(r[2] ?? ''))).toBe(true);
    expect(mine(h2).some((r) => r[0] === 'exit')).toBe(true);
    await h2.worker.stop();
  });

  it('is as-of honest: a saved sale dated after the restart moment is not taken', async () => {
    const h = await heldAndKilled();
    const path = join(h.stateDir, 'exits.json');
    const saved = parseTyped(readFileSync(path, 'utf8')) as Record<string, { deployerSales: { ids: string[]; list: { atMs: number; amount: bigint }[] } }>;
    // A file claiming a large sale a day ahead (a host clock behind the save): with it the threshold would be crossed.
    for (const s of Object.values(saved)) s.deployerSales.list.push({ atMs: h.timers.now() + 86_400_000, amount: SHARE * 2n });
    writeFileSync(path, typedText(saved));
    const { h2, m2 } = await restart(h);
    await keep(m2, 4_000);
    expect(mine(h2).some((r) => r[0] === 'exit' && r.some((x) => x.startsWith('deployer_sell')))).toBe(false);
    expect(position(h2)?.status).toBe('open');
    await h2.worker.stop();
  });

  it('net selling for 3 whole minutes before the restart and 3 after: negative_flow fires across it', async () => {
    const h = makeWorker({ config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18996', ZEROED_API_ADDR: '127.0.0.1:18997' } });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, HELD);
    await m.run(4_000, 100, () => m.pool());
    await keep(m, 10_000);
    expect(position(h)?.status).toBe('open');
    // Swaps with their own signatures, so the two processes' swaps never share an id.
    let n = 0;
    const flow = (mk: Market, tag: string) => () => {
      mk.slot();
      mk.pool();
      for (const [name, quote] of [['SellEvent', 300_000_000n], ['BuyEvent', 100_000_000n]] as const) {
        const k = ++n;
        mk.fact(`logs:pump_amm:${name}:${POOL_ADDRESS}:${tag}${k}`, { event: { program: 'pump_amm', name, data: { pool: POOL_ADDRESS, user: `u${k}`, ...(name === 'SellEvent' ? { baseAmountIn: 1_000n, quoteAmountOut: quote } : { baseAmountOut: 1_000n, quoteAmountIn: quote }) } }, signature: `${tag}-${k}` });
      }
    };
    // Up to just inside the fourth minute after a minute boundary: three whole negative minutes.
    const start = Math.ceil(m.now / 60_000) * 60_000;
    await m.run(start - m.now, 400, () => {
      m.slot();
      m.pool();
    });
    await m.run(3 * 60_000 + 1_000, 400, flow(m, 'a'));
    expect(lines(h).some((l) => l['kind'] === 'decision' && ((l['reasons'] as string[]) ?? []).some((x) => x.startsWith('negative_flow')))).toBe(false);
    await h.worker.kill();
    const { h2, m2 } = await restart(h);
    await m2.run(2 * 60_000 + 2_000, 400, flow(m2, 'b'));
    expect(mine(h2).some((r) => r[0] === 'exit' && r.some((x) => x.startsWith('negative_flow')))).toBe(true);
    await h2.worker.stop();
  });
});
