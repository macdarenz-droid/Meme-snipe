import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { makeWorker, passingMarket } from '/home/user/Meme-snipe/packages/worker/test/worker-harness.ts';
it('x', async () => {
  const h = makeWorker();
  await h.worker.reconcile();
  const m = await passingMarket(h);
  await m.run(4_000, 100, () => m.pool());
  await h.worker.kill();
  const dir = join(h.stateDir, 'recorder', h.worker.boot);
  const walk = (d: string, p = ''): string[] => readdirSync(join(d, p), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(d, join(p, e.name)) : [join(p, e.name)]);
  console.log('DBG', walk(dir).join(' '));
});
