// MEDIAN-TARGET (supervisor ruling, owner rule "the bot never guesses"): R14's inputs are the same live and in the
// backtest. Live took U2's exit `partialAtGainBps` (+100%) as the median target, so its share cap was 33% where the
// study's is 10%: the decisions would part as soon as the round-trip cap rose above 10%.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { startSession } from '../../core/src/config/session.ts';
import { registeredMedianTargetBps, STUDY_CONFIG, type StudyConfig } from '../../backtest/src/strategy/config.ts';
import { strategyConfig } from '../src/run/settings.ts';
import { blockNetwork } from './helpers.ts';
import { makeWorker, passingMarket, tempState } from './worker-harness.ts';

blockNetwork();

const study = (u: 'U1' | 'U2') => STUDY_CONFIG.universes.find((x) => x.universe === u)!;

describe('R14 inputs, live and backtest (MEDIAN-TARGET)', () => {
  it('live hands risk the median target the study registered for U2, for the gated strategy and for S0', () => {
    const policy = startSession(TRIAL_POLICY).policy;
    for (const entry of [{ timing: 'gates', salt: '' }, { timing: 'random', salt: 'S0', s0Diagnostic: true }] as const) {
      const live = strategyConfig(policy, FILL_CONFIG, RESEARCH_CONFIG, 0n, entry);
      expect(live.universe).toBe('U2');
      // The study strategy hands risk `u.medianTargetBps` of the position's universe (strategy/study.ts, evaluateEntry).
      expect(live.medianTargetBps).toBe(study('U2').medianTargetBps);
    }
    // costGate is the locked policy's on both sides: neither strategy config carries one of its own.
    expect('costGate' in strategyConfig(policy, FILL_CONFIG, RESEARCH_CONFIG)).toBe(false);
    expect('costGate' in study('U2')).toBe(false);
  });

  it('no registered value, or configurations that disagree, gives none (risk then refuses: median_target_invalid)', () => {
    expect(registeredMedianTargetBps(STUDY_CONFIG, 'U2')).toBe(3_000);
    expect(registeredMedianTargetBps(STUDY_CONFIG, 'U3')).toBeNull();
    const split: StudyConfig = { ...STUDY_CONFIG, universes: [...STUDY_CONFIG.universes, { ...study('U2'), id: 'H9-U2', medianTargetBps: 5_000 }] };
    expect(registeredMedianTargetBps(split, 'U2')).toBeNull();
    const same: StudyConfig = { ...STUDY_CONFIG, universes: [...STUDY_CONFIG.universes, { ...study('U2'), id: 'H9-U2' }] };
    expect(registeredMedianTargetBps(same, 'U2')).toBe(3_000);
    // Live without a registered U2 target hands risk 0, never a stand-in.
    const policy = startSession(TRIAL_POLICY).policy;
    expect(strategyConfig(policy, FILL_CONFIG, RESEARCH_CONFIG, 0n, undefined, split).medianTargetBps).toBe(0);
    expect(strategyConfig(policy, FILL_CONFIG, RESEARCH_CONFIG, 0n, undefined, { ...STUDY_CONFIG, universes: [study('U1')] }).medianTargetBps).toBe(0);
  });

  it('a live entry without a registered target is refused with R14 median_target_invalid', async () => {
    const stateDir = tempState();
    const h = makeWorker({ stateDir, strategy: { medianTargetBps: 0 } });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, { heldPoolFacts: true });
    await m.run(10_000, 400, () => {
      m.slot();
      m.pool();
    });
    await h.worker.stop();
    const lines = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.some((l) => l['kind'] === 'entry')).toBe(false);
    expect(lines.some((l) => l['kind'] === 'decision' && JSON.stringify(l['reasons'] ?? []).includes('median_target_invalid'))).toBe(true);
  });

  it('at the trial cost gate the share rule never binds for any registered universe, so no decision changes', () => {
    const g = TRIAL_POLICY.costGate;
    for (const u of STUDY_CONFIG.universes) {
      // R14 refuses above maxRoundTripBps, or above maxShareOfMedianTargetBps of the median target: here the first is lower.
      expect(g.maxShareOfMedianTargetBps * u.medianTargetBps / 10_000).toBeGreaterThan(g.maxRoundTripBps);
    }
  });

  it('the live worker makes the same decisions with the registered target as with the old stand-in at 500 bps', async () => {
    const journal = async (over: { medianTargetBps?: number }) => {
      const stateDir = tempState();
      const h = makeWorker({ stateDir, strategy: over });
      expect(await h.worker.reconcile()).toEqual({ ok: true });
      const m = await passingMarket(h, { heldPoolFacts: true });
      await m.run(10_000, 400, () => {
        m.slot();
        m.pool();
      });
      await h.worker.stop();
      return readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((l) => l['kind'] === 'decision' || l['kind'] === 'entry' || l['kind'] === 'exit')
        .map((l) => JSON.stringify([l['kind'], l['action'] ?? null, l['reasons'] ?? null, l['gate_reasons'] ?? null]));
    };
    const registered = await journal({});
    const standIn = await journal({ medianTargetBps: 10_000 });
    expect(registered.some((l) => l.startsWith('["entry"'))).toBe(true);
    expect(registered).toEqual(standIn);
  });
});
