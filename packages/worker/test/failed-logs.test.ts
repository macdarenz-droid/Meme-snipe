// FAILED-LOGS: a failed transaction's log lines are no decision input. The same paper session, with bots' failed swaps
// on the watched pool interleaved, journals the same decisions whether their lines reach the feed (before) or only
// their sightings do (after).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STATE_FILES } from '../../runner/src/contract.ts';
import { normalise } from '../src/run/parity.ts';
import { blockNetwork } from './helpers.ts';
import { Market, makeWorker, passingMarket } from './worker-harness.ts';

blockNetwork();

const session = async (lines: boolean): Promise<string[]> => {
  const h = makeWorker();
  await h.worker.reconcile();
  const m: Market = await passingMarket(h, { heldPoolFacts: true });
  await m.run(4_000, 100, () => m.pool());
  await m.run(10_000, 400, () => {
    m.slot();
    m.pool();
    m.failedSwap(lines);
  });
  await m.run(6_000, 400, () => {
    m.slot();
    m.pool(700_000n);
    m.failedSwap(lines);
  });
  await h.worker.stop();
  return readFileSync(join(h.stateDir, STATE_FILES.journal), 'utf8').split('\n').filter((l) => l.includes('"kind":"decision"')).map(normalise);
};

describe('FAILED-LOGS', () => {
  it('a session journals the same decisions with or without failed transactions\' log lines, an entry and an exit included', async () => {
    const withLines = await session(true);
    const without = await session(false);
    expect(withLines.some((l) => l.includes('"reasons":["enter"'))).toBe(true);
    expect(withLines.some((l) => l.includes('"reasons":["exit"'))).toBe(true);
    // The decisions are equal; only the feed's frame counter in worker event ids differs (fewer frames: `worker:account#807`
    // for `#819`), so it is blanked: every other byte is compared.
    // Equal decisions: actions, intents, results, reasons byte for byte. Only the feed's frame counter at the end of an
    // event id differs (fewer frames: `gates/pool:<mint>#970` for `#995`), so it alone is blanked.
    const bare = (ls: readonly string[]) => ls.map((l) => l.replace(/("event":"[^"#]*#)\d+"/, '$1"'));
    expect(bare(without)).toEqual(bare(withLines));
    expect(without.length).toBe(withLines.length);
  });
});
