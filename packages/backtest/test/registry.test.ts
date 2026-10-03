// The study registry's holdout run log: every run is recorded before it starts, and any second run burns the holdout
// (PR #24 review follow-up), whatever became of the first.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openHoldout } from '../../core/src/stats/index.ts';
import {
  beginHoldoutRun, failHoldoutRun, newStudyRegistry, readStudyRegistry, recordTrial, register, sealHoldoutRun, writeStudyRegistry,
} from '../src/study/registry.ts';
import { attemptAlpha } from '../src/strategy/config.ts';

const dir = mkdtempSync(join(tmpdir(), 'reg-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const fresh = () => register(newStudyRegistry(2), [
  { holdoutId: 'U1-h', universe: 'U1', configId: 'U1-c', fromDay: '2026-09-22', toDay: '2026-10-01' },
  { holdoutId: 'U2-h', universe: 'U2', configId: 'U2-c', fromDay: '2026-09-22', toDay: '2026-10-01' },
]);
const ids = ['U1-h', 'U2-h'];
const counts = { candidates: 40, entries: 12, entryDays: 5 };
const seal = (r: ReturnType<typeof fresh>) => sealHoldoutRun(r, [{ holdoutId: 'U1-h', configId: 'U1-c', counts }, { holdoutId: 'U2-h', configId: 'U2-c', counts }], 'abc');

describe('holdout run log', () => {
  it('records a run before it starts and seals it once', () => {
    const b = beginHoldoutRun(fresh(), ids, '/x/h.db', '2026-10-04T00:00:00Z', 1);
    expect(b.ok).toBe(true);
    expect(b.registry.runs).toEqual([expect.objectContaining({ holdoutIds: ids, status: 'started', sealHash: null, attempt: 1, alpha: 0.04 })]);
    const s = seal(b.registry);
    expect(s.steps.every((x) => x.ok)).toBe(true);
    expect(s.registry.runs[0]).toMatchObject({ status: 'sealed', sealHash: 'abc' });
    expect(s.registry.holdouts.entries.map((e) => e.seal)).toEqual(['sealed', 'sealed']);
  });

  it('burns every holdout of a second run after a sealed one, into a new file', () => {
    const sealed = seal(beginHoldoutRun(fresh(), ids, '/x/h.db', 't1', 1).registry).registry;
    const again = beginHoldoutRun(sealed, ids, '/x/other.db', 't2', 2);
    expect(again.ok).toBe(false);
    expect(again.registry.holdouts.entries.every((e) => e.burned && e.burnReason === 'reconfigured')).toBe(true);
    // Burned holdouts never open, whatever is presented to the scoring stage.
    const step = openHoldout(again.registry.holdouts, 'U1-h', { configId: 'U1-c', ledgerHash: 'abc', requiredTrades: 1, minDays: 1, nowMs: 0 });
    expect(step.ok).toBe(false);
  });

  it('burns after a run that crashed before sealing, and after a run that failed', () => {
    const started = beginHoldoutRun(fresh(), ids, '/x/h.db', 't1', 1).registry;
    expect(beginHoldoutRun(started, ids, '/x/h2.db', 't2', 2)).toMatchObject({ ok: false });
    const failed = failHoldoutRun(started, ids, 'crashed');
    expect(failed.runs[0]).toMatchObject({ status: 'failed', detail: 'crashed' });
    const again = beginHoldoutRun(failed, ids, '/x/h3.db', 't3', 2);
    expect(again.ok).toBe(false);
    expect(again.registry.holdouts.entries.every((e) => e.burned)).toBe(true);
  });

  it('burns when only one of the universes was run before', () => {
    const one = register(newStudyRegistry(2), [{ holdoutId: 'U1-h', universe: 'U1', configId: 'U1-c', fromDay: '2026-09-22', toDay: '2026-10-01' }]);
    const r1 = beginHoldoutRun(one, ['U1-h'], '/x/a.db', 't1', 1).registry;
    const r2 = register(r1, [{ holdoutId: 'U2-h', universe: 'U2', configId: 'U2-c', fromDay: '2026-09-22', toDay: '2026-10-01' }]);
    const b = beginHoldoutRun(r2, ids, '/x/b.db', 't2', 2);
    expect(b.ok).toBe(false);
    expect(b.registry.holdouts.entries.find((e) => e.holdoutId === 'U1-h')!.burned).toBe(true);
  });

  it('refuses an unregistered holdout and keeps one entry per trial', () => {
    expect(beginHoldoutRun(fresh(), ['U3-h'], '/x/h.db', 't', 1)).toMatchObject({ ok: false });
    const t = { trialId: 'U2-c', sharpe: 0.1, nTrades: 10, configId: 'U2-c', evaluatedOn: 'wf' };
    expect(recordTrial(recordTrial(fresh(), t), t).trials).toHaveLength(1);
  });

  it('spends the error budget in order: attempt 1 at 0.04, attempt k at 0.01 / 2^(k-1), never skipped or repeated', () => {
    expect([1, 2, 3, 4].map(attemptAlpha)).toEqual([0.04, 0.005, 0.0025, 0.00125]);
    expect(() => attemptAlpha(0)).toThrow(RangeError);
    const skipped = beginHoldoutRun(fresh(), ids, '/x/h.db', 't1', 2);
    expect(skipped).toMatchObject({ ok: false, reason: expect.stringMatching(/attempt 2 after 0/) });
    expect(skipped.registry.holdouts.entries.every((e) => e.burned)).toBe(true);
    // A new window registered after a sealed first attempt runs as attempt 2 at 0.005.
    const first = seal(beginHoldoutRun(fresh(), ids, '/x/h.db', 't1', 1).registry).registry;
    // (The first window's holdouts are scored by then; only its run record matters to the budget.)
    const later = { ...register(newStudyRegistry(2), [{ holdoutId: 'U1-h2', universe: 'U1', configId: 'U1-c', fromDay: '2026-10-21', toDay: '2026-10-31' }]), runs: first.runs };
    expect(beginHoldoutRun(later, ['U1-h2'], '/x/h4.db', 't4', 1)).toMatchObject({ ok: false });
    const second = beginHoldoutRun(later, ['U1-h2'], '/x/h4.db', 't4', 2);
    expect(second.ok).toBe(true);
    expect(second.registry.runs[1]).toMatchObject({ attempt: 2, alpha: 0.005 });
  });

  it('survives a write and read', () => {
    const p = join(dir, 'registry.json');
    const r = beginHoldoutRun(fresh(), ids, '/x/h.db', 't1', 1).registry;
    writeStudyRegistry(p, r);
    expect(readStudyRegistry(p)).toEqual(r);
  });
});
