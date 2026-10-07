// RED TEAM C probe: an entry is dispatched only once its evidence is durable ("Check evidence BEFORE a new buy reaches
// the outside world", worker.ts runner). The journal's decision lines are fsynced there, but the recorder's release
// lines for the same drain stay in its in-memory buffer until step() flushes after the drain. A kill at that moment
// (what the dry run's restart drills do) leaves a journal whose entry the recording cannot replay: TEST-1 fails.
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUG_CONFIG } from '../../../core/src/config/index.ts';
import { STATE_FILES } from '../../../runner/src/contract.ts';
import { checkBoot, loadSession, type ParityDeps } from '../../src/run/parity.ts';
import { blockNetwork } from '../helpers.ts';
import { makeWorker, passingMarket, type Harness } from '../worker-harness.ts';

blockNetwork();

describe('red team C: evidence on disk when an entry is dispatched', () => {
  it('a kill right after the entry is dispatched leaves a recording that replays to the journaled decisions', async () => {
    let h: Harness | undefined;
    let snap: string | null = null;
    h = makeWorker({
      worldFault: (e) => {
        // The first paper report of an entry intent: the buy has reached the (paper) outside world. A SIGKILL here keeps
        // exactly what is on disk; copy it.
        if (snap === null && e.type === 'intent' && h!.worker.book.intents[e.intentId]?.intent.purpose === 'entry') {
          const journal = readFileSync(join(h!.stateDir, STATE_FILES.journal), 'utf8');
          if (journal.includes('"reasons":["enter"')) {
            snap = mkdtempSync(join(tmpdir(), 'redteam-c-kill-'));
            cpSync(h!.stateDir, snap, { recursive: true });
          }
        }
        return e;
      },
    });
    await h.worker.reconcile();
    const m = await passingMarket(h, { heldPoolFacts: true });
    await m.run(4_000, 100, () => m.pool());
    await h.worker.stop();
    expect(snap).not.toBeNull();
    const deps: ParityDeps = { session: h.session, rugs: RUG_CONFIG, strategy: h.worker.strategyConfig };
    const b = loadSession(snap!)[0]!;
    expect(b.live.some((l) => l.includes('"reasons":["enter"'))).toBe(true);
    const r = checkBoot(b, deps, 2);
    expect(r.divergence).toBeNull();
  });
});
