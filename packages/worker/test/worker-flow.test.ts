import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkJournal } from '../../runner/src/journal.ts';
import { makeWorker, passingMarket } from './worker-harness.ts';

const journalOf = (dir: string) => readFileSync(join(dir, 'journal.jsonl'), 'utf8');
const lines = (dir: string) => journalOf(dir).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

describe('explore', () => {
  it('runs', async () => {
    const h = makeWorker();
    const r = await h.worker.reconcile();
    expect(r.ok).toBe(true);
    const m = await passingMarket(h);
    await m.run(4_000, 100, () => m.pool());
    await m.run(6_000, 400, () => { m.slot(); m.pool(); });
    console.log('positions', JSON.stringify(Object.values(h.worker.book.positions).map((p) => [p.id, p.status, String(p.quantity)])));
    await m.run(12_000, 400, () => { m.slot(); m.pool(700_000n); });
    console.log('positions', JSON.stringify(Object.values(h.worker.book.positions).map((p) => [p.id, p.status, String(p.quantity)])));
    console.log(lines(h.stateDir).filter((l) => l['kind'] !== 'decision' || (l['reasons'] as string[])[0] !== 'reject').slice(-30).map((l) => JSON.stringify(l).slice(0, 300)).join('\n'));
    console.log(JSON.stringify(checkJournal(journalOf(h.stateDir))));
  });
});
