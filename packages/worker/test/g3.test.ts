// TEST-3's G3 half: counterfactual trades of live-only-vetoed candidates, scored offline from a recorded session.
import { describe, expect, it } from 'vitest';
import { FILL_CONFIG, RUG_CONFIG } from '../../core/src/config/index.ts';
import { xcheckKey } from '../../core/src/gates/index.ts';
import { readRecording } from '../src/research/recording.ts';
import { scoreCounterfactual } from '../src/research/counterfactual.ts';
import { LANDS, MINT, Market, makeWorker, passingMarket } from './worker-harness.ts';

/** The cross-check disagrees: GoPlus reads a mint authority our own read does not see (an H16 live-only veto). */
const disagree = (m: Market) => {
  m.fact(xcheckKey(MINT), { obs: { slot: null, receivedAt: m.now - 50, source: 'rugcheck' }, sources: [{ provider: 'rugcheck', mintAuthority: 'none', freezeAuthority: 'none' }, { provider: 'goplus', mintAuthority: 'set', freezeAuthority: null }] });
};

describe('scratch', () => {
  it('veto then counterfactual', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, { omit: [xcheckKey(MINT)] });
    m.omit = new Set();
    const tick = (scale = 1_000_000n) => () => {
      m.omit = new Set([xcheckKey(MINT)]);
      m.slot();
      m.pool(scale);
      m.omit = new Set();
      disagree(m);
    };
    await m.run(20_000, 400, tick());
    await m.run(20_000, 400, tick(700_000n));
    const lines = (await import('node:fs')).readFileSync(`${h.stateDir}/journal.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    console.log(JSON.stringify(lines.filter((l: any) => l.action === 'reject' || l.action === 'enter').slice(-3).map((l: any) => [l.reasons, l.gate_reasons])));
    await h.worker.stop();
    const rec = readRecording(h.stateDir);
    const frames = rec.flatMap((b) => b.frames);
    console.log('frames', frames.length);
    const cf = await scoreCounterfactual({ mint: MINT, frames, session: h.session, rugs: RUG_CONFIG, strategy: h.worker.strategyConfig, scenario: LANDS, network: FILL_CONFIG.network, seed: 'g3:test' });
    console.log(JSON.stringify(cf, (_k, v) => (typeof v === 'bigint' ? String(v) : v)));
  }, 120_000);
});
