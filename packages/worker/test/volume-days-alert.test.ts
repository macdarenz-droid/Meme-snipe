// NT-1 (red team A round 3, S1 ruling): a chain-volume day missing from the regime's window is left out of the
// percentile, and the worker raises a named critical alert (journal, counted in the daily summary, and the log) instead
// of judging silently or blocking every coin for the year the day stays in the window.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CURVE_VOLUME_KEY } from '../../core/src/gates/index.ts';
import { passingFacts } from '../../core/test/gates/world.ts';
import { foldLine, emptySummaryState } from '../src/run/summary.ts';
import { T, makeWorker, passingMarket } from './worker-harness.ts';
import { TRIAL_POLICY } from '../../core/src/config/index.ts';

const lines = (dir: string) => readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

describe('NT-1: a missing curve volume day', () => {
  it('is left out with a named alert, and the candidate is still judged', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, { heldPoolFacts: true, omit: [CURVE_VOLUME_KEY] });
    const full = passingFacts().get(CURVE_VOLUME_KEY)!.value as { days: { day: number }[] };
    // 20 days before the day the check judges: inside the window, after the series start.
    const gone = Math.floor(T / 86_400_000) - TRIAL_POLICY.regime.volumeLagDays - 20;
    expect(full.days.some((d) => d.day === gone)).toBe(true);
    m.omit = new Set();
    m.fact(CURVE_VOLUME_KEY, { ...full, days: full.days.filter((d) => d.day !== gone) });
    await m.run(4_000, 100, () => m.pool());
    const name = new Date(gone * 86_400_000).toISOString().slice(0, 10);
    const alerts = lines(h.stateDir).filter((l) => l['kind'] === 'alert' && l['code'] === 'volume_days_missing');
    expect(alerts.map((l) => [l['level'], l['reasons']])).toEqual([['critical', [`curve volume judged without 1 day(s) of its window: ${name}`]]]);
    expect(h.logs).toContain(`ALERT curve volume judged without 1 day(s) of its window: ${name}`);
    // The entry lands.
    await m.run(10_000, 400, () => {
      m.slot();
      m.pool();
    });
    // Judged on the days present: the regime is on and the coin entered.
    expect(lines(h.stateDir).filter((l) => l['kind'] === 'entry')).toHaveLength(1);
    // The daily summary counts it.
    const s = emptySummaryState();
    for (const l of lines(h.stateDir)) foldLine(s, l);
    expect(Object.values(s.days).some((d) => (d.alerts as Record<string, number>)['volume_days_missing'] === 1)).toBe(true);
    await h.worker.kill();
  });
});
