// A crash mid-transaction leaves no partial state: real child processes are killed with SIGKILL
// (no cleanup, no close) and the file is reopened.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openLedger, openLedgerReader } from '../../src/ledger/index.ts';
import { runChild, tempPath } from './helpers.ts';

const counts = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  const n = (t: string) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.['n']);
  const result = {
    integrity: db.prepare('PRAGMA integrity_check').get()?.['integrity_check'],
    intents: n('intent'), events: n('intent_event'), reservations: n('reservation'), outbox: n('outbox'),
  };
  db.close();
  return result;
};

describe('crash safety', () => {
  it('a process killed inside a transaction leaves none of that transaction, and keeps what committed', async () => {
    const path = tempPath();
    const child = runChild(['hang', path]);
    await child.line('ready'); // trade 1 committed; trade 2 has intent, events, reservation and an outbox row written but not committed
    child.kill();
    await child.exit;

    // Reopening as the writer takes over the dead process's lock and recovers the WAL.
    const ledger = openLedger(path, 'paper');
    expect(ledger.intent('e1')?.status).toBe('prepared');
    expect(ledger.intent('e2')).toBeNull();
    expect(ledger.heldReservations().map((r) => r.intentId)).toEqual(['e1']);
    expect(ledger.pendingOutbox().map((o) => o.intentId)).toEqual(['e1', 'e1']);
    ledger.close();
    expect(counts(path)).toEqual({ integrity: 'ok', intents: 1, events: 3, reservations: 1, outbox: 2 });
  }, 20_000);

  it('killed at random moments while writing, every trade is all there or not there at all', async () => {
    const path = tempPath();
    openLedger(path, 'paper').close();
    let offset = 1;
    for (let round = 0; round < 4; round++) {
      const child = runChild(['loop', path, String(offset)]);
      await child.line('wrote');
      await new Promise((r) => setTimeout(r, 20 + Math.floor(Math.random() * 60)));
      child.kill();
      await child.exit;
      const c = counts(path);
      expect(c.integrity).toBe('ok');
      // Each trade writes exactly 1 intent, 3 events, 1 reservation and 2 outbox rows in one transaction.
      expect(c).toEqual({ integrity: 'ok', intents: c.intents, events: 3 * c.intents, reservations: c.intents, outbox: 2 * c.intents });
      const reader = openLedgerReader(path);
      expect(reader.unresolvedIntents().every((r) => r.status === 'prepared')).toBe(true);
      reader.close();
      offset = c.intents + 1_000_000 * (round + 1); // fresh ids and keys per round
    }
    expect(counts(path).intents).toBeGreaterThan(0);
  }, 60_000);
});
