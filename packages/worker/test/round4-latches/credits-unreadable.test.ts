// ROUND 4 PARALYSIS PROBE (red team, latches): an unreadable credits.json halts entries for the rest of the UTC month.
// run/sources.ts:124 sets every budgeted provider's count to its WHOLE monthly budget when credits.json cannot be read;
// :106-111 then saves those counts, so every later boot of the month reads them back. Alchemy at 100% >= its 70% halt
// (scheduler.ts:147-149) -> `providers.alchemy.halted` -> worker.ts:2299 SECOND_PATH_UNAVAILABLE on every candidate
// until the month rolls over (up to ~31 days), across restarts, with no automatic recovery. The trigger is a bookkeeping
// fault (a torn/garbled/EACCES state file), not a spend: the halt rests on a guess (unknown count = all spent). Writes are
// atomic + fsync (state.ts:28), so frequency is low (disk fault, hand edit, restore from a bad backup). Non-paralysed
// behaviour asserted: once a good save has landed, a later boot is not halted for the month on a count nobody spent.
// FAILS on cd4d7a6.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CreditBook } from '../../src/run/sources.ts';
import { ALCHEMY_FREE } from '../../src/scheduler/index.ts';
import { virtualTimers } from '../worker-harness.ts';

describe('round4 latches: an unreadable credit file does not stop entries for the month', () => {
  it('after a corrupt credits.json and one good save, the next boot does not hold Alchemy halted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'r4-credits-'));
    writeFileSync(join(dir, 'credits.json'), '{"month": "2026-10", "used": {"alch');
    const timers = virtualTimers(Date.UTC(2026, 9, 2));
    const b1 = new CreditBook(dir, timers, () => undefined);
    const a1 = b1.scheduler(ALCHEMY_FREE);
    b1.flush();
    expect(a1.halted).toBe(true); // fail-closed for this boot is defensible
    const b2 = new CreditBook(dir, timers, () => undefined);
    const a2 = b2.scheduler(ALCHEMY_FREE);
    expect({ halted: a2.halted, used: b2.used['alchemy'] ?? 0 }).toEqual({ halted: false, used: expect.any(Number) });
  });
});
