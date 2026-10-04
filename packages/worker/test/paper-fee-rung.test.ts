// PAPER-FEE-RUNG: a paper exit attempt pays the priority fee its plan put on the transaction. The rung climbs across the
// position's exit intents (a full exit after a partial starts one rung up), so the intent's own attempt count does not
// give it: the old re-derivation charged a later intent's first attempt the first rung's fee.
import { describe, expect, it } from 'vitest';
import { attemptFee } from '../../core/src/fills/index.ts';
import { FILL_CONFIG } from '../../core/src/config/index.ts';
import { makeWorker, passingMarket } from './worker-harness.ts';

const HELD = { heldPoolFacts: true } as const;

/** A position that sold half at +15% (a partial exit) and then hit its stop (a second exit intent). */
const partialThenStop = async (patch?: (h: ReturnType<typeof makeWorker>) => void) => {
  const h = makeWorker();
  patch?.(h);
  await h.worker.reconcile();
  const m = await passingMarket(h, HELD);
  await m.run(4_000, 100, () => m.pool());
  await m.run(10_000, 400, () => { m.slot(); m.pool(); });
  await m.run(8_000, 400, () => { m.slot(); m.pool(1_150_000n); });
  await m.run(6_000, 400, () => { m.slot(); m.pool(700_000n); });
  const i = h.worker.apiInputs();
  const exits = [...i.attempts.values()].filter((a) => a.purpose === 'exit').sort((a, b) => (a.sentAtMs ?? 0) - (b.sentAtMs ?? 0));
  const fees = i.policy.exits.ladder.steps.map((s) => BigInt(s.priorityFeeLamports));
  return { h, i, exits, fees };
};

describe('a paper exit pays its plan\'s priority fee (PAPER-FEE-RUNG)', () => {
  it('the first exit pays rung 0; the exit after a partial pays the rung it climbed to, and its fill is charged that fee', async () => {
    const { h, i, exits, fees } = await partialThenStop();
    expect(new Set(exits.map((a) => a.intentId)).size).toBe(2);
    const [partial, rest] = exits;
    expect(partial!.outcome).toBe('filled');
    expect(partial!.priorityFee).toBe(fees[0]);
    // One attempt used on the position, rung 0 tried: the next exit starts at rung 1 (core nextExitRung).
    expect(rest!.priorityFee).toBe(fees[1]);
    expect(fees[1]).not.toBe(fees[0]);
    expect(rest!.outcome).toBe('filled');
    expect(rest!.fill!.fees).toBe(attemptFee(FILL_CONFIG.network, fees[1]!, 'filled'));
    expect(i.trades.find((t) => t.positionId === rest!.trade)!.closedAtMs).not.toBeNull();
    await h.worker.stop();
  });

  it('an exit attempt whose plan is unknown (signed before a restart) pays the highest rung\'s fee, never less', async () => {
    const { h, exits, fees } = await partialThenStop((w) => { w.worker.strategy.exitFee = () => null; });
    expect(exits.length).toBeGreaterThanOrEqual(1);
    const top = fees.reduce((m, f) => (f > m ? f : m), 0n);
    for (const a of exits) expect(a.priorityFee).toBe(top);
    await h.worker.stop();
  });

  it('the strategy forgets a closed position\'s planned fees', async () => {
    const { h, exits } = await partialThenStop();
    for (const a of exits) expect(h.worker.strategy.exitFee(a.signature)).toBeNull();
    await h.worker.stop();
  });
});
