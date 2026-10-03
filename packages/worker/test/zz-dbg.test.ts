import { it } from 'vitest';
import { makeWorker, passingMarket } from './worker-harness.ts';
import { parseMigration, migrationKey } from '../../core/src/gates/index.ts';
import { passingFacts, MINT } from '../../core/test/gates/world.ts';
it('dbg', async () => {
  console.log('parse', parseMigration(passingFacts().get(migrationKey(MINT))!.value) !== null);
  const h = makeWorker();
  await h.worker.reconcile();
  const m = await passingMarket(h);
  await m.run(6_000, 100, () => m.pool());
  console.log(JSON.stringify(h.worker.feed.status(), (_k, v) => typeof v === 'bigint' ? String(v) : v));
});
