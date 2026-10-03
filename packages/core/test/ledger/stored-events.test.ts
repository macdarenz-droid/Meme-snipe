// Ledger.storedBookEvents (WORKER-1's restart): the book events a ledger stores, read back in order, rebuild the book the
// engine had; a ledger that cannot be read back refuses rather than guessing.
import { describe, expect, it } from 'vitest';
import { canonical, replayOnce } from '../../src/engine/index.ts';
import { Ledger, openLedger } from '../../src/ledger/index.ts';
import { generateStream, stubRun } from '../engine-fixtures.ts';
import { CONFIG } from '../fixtures.ts';
import { tempPath } from './helpers.ts';
import { appliedEvents, recordEvents } from './recorder.ts';

describe('Ledger.storedBookEvents', () => {
  it('rebuilds the engine\'s book from what the ledger stored (entries, exits, merges, late landings)', () => {
    const { records } = replayOnce(stubRun(generateStream('stored-events', 600)));
    const path = tempPath();
    const ledger = openLedger(path, 'paper');
    const engineBook = recordEvents(ledger, appliedEvents(records), CONFIG);
    const { events, book } = ledger.storedBookEvents(CONFIG);
    ledger.close();
    expect(events.length).toBeGreaterThan(20);
    expect(events.some((e) => e.type === 'trigger_exit')).toBe(true);
    // Ticks, pauses and a restart that changes no intent are not stored; every state they could change is.
    const state = (b: typeof book) => canonical({ intents: b.intents, positions: b.positions, reserved: b.reserved, orphans: b.orphans });
    expect(state(book)).toBe(state(engineBook));
  });

  it('names the ledger file of the state directory', () => {
    expect(Ledger.FILE).toBe('ledger.sqlite');
  });
});
