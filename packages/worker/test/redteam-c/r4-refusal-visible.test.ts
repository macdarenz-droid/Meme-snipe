// RED TEAM C round 4 (PR B #280): a start refused on lost state throws StateRefused before the journal's start line, and
// main.ts turns it into fatal -> EXIT.crash. systemd (Restart=always) restarts it every 5 s until StartLimitBurst; under
// #271's probation the first restart rolls the host back to the release before (the stand-in during the resume). Nothing
// the owner or the watchdog reads names the refusal: the journal gets no line. The refusal should leave a durable,
// readable reason (a journal alert line, or a state file the heartbeat and zeroed-update can report).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STATE_FILES } from '../../../runner/src/contract.ts';
import { makeWorker } from '../worker-harness.ts';

describe('red team C: a refused start leaves its reason where the owner can read it', () => {
  it('a lost ledger refusal writes a journal alert naming it', async () => {
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    await h.worker.stop();
    // The ledger is lost while account.json says the bot traded (a partial restore, or a disk fault).
    const acct = JSON.parse(readFileSync(join(h.stateDir, 'account.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(h.stateDir, 'account.json'), JSON.stringify({ ...acct, entries: [{ atMs: 1, mint: 'x' }] }));
    writeFileSync(join(h.stateDir, 'ledger.sqlite'), '');
    let refused = '';
    try {
      makeWorker({ stateDir: h.stateDir, timers: h.timers });
    } catch (e) {
      refused = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
    expect(refused).toMatch(/StateRefused/);
    const journal = join(h.stateDir, STATE_FILES.journal);
    const lines = existsSync(journal) ? readFileSync(journal, 'utf8').split('\n').filter((l) => /refus|state_lost|ledger/i.test(l) && /"kind":"alert"/.test(l)) : [];
    expect(lines.length, `refusal "${refused.slice(0, 120)}" left no journal alert`).toBeGreaterThan(0);
  });
});
