// REC-1 review: a window that ends on the very event where the candidate's gates first pass is never an entry, whatever
// the order of the window-end pass and the entries pass (`#entries` keeps its own `now >= to` backstop).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blockNetwork } from './helpers.ts';
import { MIGRATED_AT, MINT, makeWorker, passingMarket } from './worker-harness.ts';

blockNetwork();

/** The worker's first entry moment on the passing market with the default window (the probe below pins it). */
const FIRST_PASS = Date.parse('2026-10-03T15:00:01.800Z');

const decisions = async (windowToMs?: number) => {
  const h = makeWorker(windowToMs === undefined ? {} : { strategy: { windowToMs } });
  await h.worker.reconcile();
  const m = await passingMarket(h, { heldPoolFacts: true });
  await m.run(4_000, 100, () => m.pool());
  await m.run(10_000, 400, () => {
    m.slot();
    m.pool();
  });
  await h.worker.stop();
  return readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; ts: string; action?: string; reasons?: string[] })
    .filter((l) => l.kind === 'decision');
};
const enters = (d: Awaited<ReturnType<typeof decisions>>) => d.filter((l) => l.action === 'enter');

describe('REC-1: the window end and a passing evaluation on the same event', () => {
  it('with the default window the gates first pass at FIRST_PASS, and a window ending 1 ms later still enters there', async () => {
    expect(enters(await decisions()).map((l) => Date.parse(l.ts))).toEqual([FIRST_PASS]);
    expect(enters(await decisions(FIRST_PASS + 1 - MIGRATED_AT)).map((l) => Date.parse(l.ts))).toEqual([FIRST_PASS]);
  });

  it('a window ending exactly at FIRST_PASS: no entry, the candidate leaves with `window ended`', async () => {
    const d = await decisions(FIRST_PASS - MIGRATED_AT);
    expect(enters(d)).toEqual([]);
    const ended = d.find((l) => (l.reasons ?? [])[0] === 'no entry' && (l.reasons ?? [])[2] === MINT);
    expect(ended).toBeDefined();
    expect(Date.parse(ended!.ts)).toBe(FIRST_PASS);
    expect(ended!.reasons![3]).toMatch(/^window ended/);
  });
});
