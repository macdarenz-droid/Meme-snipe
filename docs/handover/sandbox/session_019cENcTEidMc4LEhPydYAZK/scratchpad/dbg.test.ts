import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { PERSIST_FILE } from '/home/user/Meme-snipe/packages/worker/src/run/worker.ts';
import { Market, T, makeWorker, slotAt, tempState, virtualTimers } from '/home/user/Meme-snipe/packages/worker/test/worker-harness.ts';
it('dbg', async () => {
  const stateDir = tempState(]) + '\n');
  const timers = virtualTimers(T]) + '\n');
  const h = makeWorker({ stateDir, timers, seed: () => new Promise(() => undefined), seedMaxMs: 3_600_000, config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18890', ZEROED_API_ADDR: '127.0.0.1:18891' } }]) + '\n');
  const m = new Market(h]) + '\n');
  void h.worker.start(]) + '\n');
  while (!h.order.includes('start helius-ws')) await new Promise<void>((r) => setImmediate(r)]) + '\n');
  appendFileSync('/tmp/claude-0/-home-user-Meme-snipe/d94e7d09-e45c-557f-8a81-c430595aae8d/scratchpad/dbg.out', JSON.stringify(['A exists', existsSync(join(stateDir, PERSIST_FILE)), h.worker.strategy.seedApplied]) + '\n');
  m.slot(]) + '\n');
  h.worker.step(]) + '\n');
  appendFileSync('/tmp/claude-0/-home-user-Meme-snipe/d94e7d09-e45c-557f-8a81-c430595aae8d/scratchpad/dbg.out', JSON.stringify(['B exists', existsSync(join(stateDir, PERSIST_FILE)), h.worker.strategy.seedApplied, h.logs.join(' | ').slice(0, 1500)]) + '\n');
}]) + '\n');
