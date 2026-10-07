// RED TEAM B round 4 (integration merge), RC-STATE x #268 (switch to the real worker): RC-STATE writes control.json at
// every start and, when a ledger was there but control.json is not, latches the kill switch and pauses entries. Workers
// before RC-STATE wrote control.json only on a latch or a control change, and the stand-in never does; both leave a
// ledger.sqlite. So the first start of the merged worker on such a host (the resume) comes up latched and paused with a
// critical alert, though nothing was lost. Asserts it does not, so it FAILS on the merge.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ledger, openLedger } from '../../../core/src/ledger/index.ts';
import { NO_CONTROL, controlFile } from '../../src/run/state.ts';
import { makeWorker, tempState } from '../worker-harness.ts';

const firstStart = async (prepare: (dir: string) => void) => {
  const dir = tempState();
  prepare(dir);
  expect(existsSync(join(dir, 'control.json'))).toBe(false);
  const h = makeWorker({ stateDir: dir });
  await h.worker.reconcile();
  const ctl = controlFile(dir).read(NO_CONTROL);
  await h.worker.stop();
  return ctl;
};

describe('RB-15 the first start after the switch is not a lost control.json', () => {
  it('RB-15a a ledger from a worker before RC-STATE that never latched or paused (no control.json)', async () => {
    const ctl = await firstStart((dir) => { openLedger(join(dir, Ledger.FILE), 'paper').close(); });
    expect(ctl.latches.killTrippedAtMs).toBeNull();
    expect(ctl.paused).toBe(false);
  });
  it('RB-15b a ledger.sqlite made by the host stand-in (host_events only)', async () => {
    const ctl = await firstStart((dir) => {
      const db = new DatabaseSync(join(dir, Ledger.FILE));
      db.exec('CREATE TABLE IF NOT EXISTS host_events (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT)');
      db.prepare("INSERT INTO host_events (ts, kind, detail) VALUES ('2026-10-07T00:00:00Z', 'start', null)").run();
      db.close();
    });
    expect(ctl.latches.killTrippedAtMs).toBeNull();
    expect(ctl.paused).toBe(false);
  });
});
