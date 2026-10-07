// RED TEAM B, RB-3 at worker level: the planned resume config (ZEROED_STRATEGY S0, ZEROED_S0_DIAGNOSTIC on, no
// ZEROED_PAPER_EDGE_PPM, so edgePpm 0) with a market that passes every gate never proposes an entry, and the refusal is
// risk's expected_net_not_positive (costs: edge-not-above-cost). Control: the same boot at edge 400,000 ppm enters.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CURVE_VOLUME_KEY, EXEC_HEALTH_KEY, GRADUATES_KEY} from '../../core/src/gates/index.ts';
import { s0EntryAt } from '../src/engine/strategy.ts';
import { MIGRATED_AT, MINT, T, makeWorker, passingMarket } from './worker-harness.ts';

const DAY = 86_400_000;
const from = MIGRATED_AT + 60 * 60_000;
const to = MIGRATED_AT + 240 * 60_000;
const early = (() => { for (let k = 0; ; k++) if (s0EntryAt(`salt-${k}`, MINT, from, to) < T - 60_000) return `salt-${k}`; })();

const boot = async (edgePpm: bigint) => {
  const h = makeWorker({ edgePpm, entry: { timing: 'random', salt: early, s0Diagnostic: true }, config: { ZEROED_STRATEGY: 'S0', ZEROED_S0_DIAGNOSTIC: 'on' } });
  expect(await h.worker.reconcile()).toEqual({ ok: true });
  const m = await passingMarket(h, { heldPoolFacts: true, omit: [CURVE_VOLUME_KEY, GRADUATES_KEY, EXEC_HEALTH_KEY], coverageAt: T - 2 * DAY });
  await m.run(6_000, 400, () => { m.slot(); m.pool(); });
  await h.worker.stop();
  const lines = readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const reasons = lines.filter((l) => l['kind'] === 'decision').map((l) => (l['reasons'] as string[]) ?? []);
  return { reasons, positions: Object.keys(h.worker.book.positions).length };
};

describe('RB-3w edge 0 never enters (S0 + diagnostic set)', () => {
  it('no enter decision, no position, and the refusal is expected_net_not_positive', async () => {
    const r = await boot(0n);
    expect(r.reasons.filter((x) => x[0] === 'enter')).toEqual([]);
    expect(r.positions).toBe(0);
    expect(r.reasons.some((x) => x[0] === 'reject' && x.some((s) => s.includes('expected_net_not_positive')))).toBe(true);
  });
  it('control: the same boot at edge 400,000 ppm does enter (the market passes the gates)', async () => {
    const r = await boot(400_000n);
    expect(r.reasons.filter((x) => x[0] === 'enter').length).toBeGreaterThan(0);
  });
});
