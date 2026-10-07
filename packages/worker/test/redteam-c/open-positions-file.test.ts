// RC-FIXES-2b (S1 on #271): the host's probation rollback holds while a position is open, so the worker writes
// `open_positions` beside `open_intents`. An open position with no intent in flight reads 0 intents and 1 position.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STATE_FILES } from '../../../runner/src/contract.ts';
import { Market, makeWorker, passingMarket, until } from '../worker-harness.ts';

const HELD = { heldPoolFacts: true } as const;
const tick = (m: Market, scalePpm = 1_000_000n) => (): void => {
  m.slot();
  m.pool(scalePpm);
};
const read = (dir: string, f: string) => readFileSync(join(dir, f), 'utf8');

describe('RC-FIXES-2b: open_positions for the host', () => {
  it('reads 1 while a position is open with no intent in flight, and 0 once it closed', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    expect(read(h.stateDir, STATE_FILES.openPositions)).toBe('0\n');
    const m = await passingMarket(h, HELD);
    const open = () => Object.values(h.worker.book.positions).some((p) => p.status === 'open');
    const idle = () => Object.values(h.worker.book.intents).every((i) => ['reconciled', 'rejected', 'cancelled', 'abandoned', 'confirmed_fill', 'failed', 'expired_unfilled'].includes(i.status));
    expect(await until(m, 30_000, () => open() && idle() && read(h.stateDir, STATE_FILES.openIntents) === '0\n', tick(m))).toBe(true);
    expect(read(h.stateDir, STATE_FILES.openIntents)).toBe('0\n');
    expect(read(h.stateDir, STATE_FILES.openPositions)).toBe('1\n');
    // The price falls through the stop: the position closes, and the file follows.
    expect(await until(m, 60_000, () => Object.values(h.worker.book.positions).every((p) => p.status === 'closed'), tick(m, 700_000n))).toBe(true);
    expect(read(h.stateDir, STATE_FILES.openPositions)).toBe('0\n');
    await h.worker.stop();
  });
});
