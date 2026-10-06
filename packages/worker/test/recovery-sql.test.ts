// ops/README.md "Updates held by open intents", step 2: the console's read-only SQL must list exactly the intents the
// worker counts as open (desk.ts openIntents, the count `zeroed-update` gates on), so the recovery steps cannot drift
// from the lifecycle's isTerminal. Ledgers here are written by the real recorder from a replayed stream, cut at many
// points so intents are caught in every state the stream reaches.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { replayOnce } from '../../core/src/engine/index.ts';
import { openLedger } from '../../core/src/ledger/index.ts';
import { isTerminal, type IntentState } from '../../core/src/lifecycle/index.ts';
import { V1_INTENT_STATUSES } from '../../core/src/ledger/migrations.ts';
import { generateStream, stubRun } from '../../core/test/engine-fixtures.ts';
import { CONFIG } from '../../core/test/fixtures.ts';
import { tempPath } from '../../core/test/ledger/helpers.ts';
import { appliedEvents, recordEvents } from '../../core/test/ledger/recorder.ts';
import { openIntents } from '../src/run/desk.ts';

const readme = readFileSync(fileURLToPath(new URL('../../../ops/README.md', import.meta.url)), 'utf8');
const section = readme.slice(readme.indexOf('### Updates held by open intents'), readme.indexOf('## Backups'));
const SQL = /sqlite3 -readonly \/var\/lib\/zeroed\/ledger\.sqlite "([^"]+)"/.exec(section)?.[1] ?? '';

describe('README recovery SQL', () => {
  it('is the one read-only query in the section, on the worker\'s ledger', () => {
    expect(SQL).toMatch(/^SELECT /);
    expect(section.match(/sqlite3 /g)).toHaveLength(1);
  });

  it('lists exactly the intents the worker counts as open, at every point of a replayed run', () => {
    const events = appliedEvents(replayOnce(stubRun(generateStream('recovery-sql', 600))).records);
    expect(events.length).toBeGreaterThan(40);
    const statuses = new Set<string>();
    let open = 0;
    let closed = 0;
    // 24 cuts spread over the run (each records its prefix from an empty ledger), the last one the whole run.
    const cuts = [...new Set(Array.from({ length: 24 }, (_, i) => Math.max(1, Math.round(((i + 1) * events.length) / 24))))];
    for (const k of cuts) {
      const path = tempPath();
      const ledger = openLedger(path, 'paper');
      const book = recordEvents(ledger, events.slice(0, k), CONFIG);
      const stored = ledger.storedBookEvents(CONFIG).book;
      ledger.close();
      const db = new DatabaseSync(path, { readOnly: true });
      const rows = db.prepare(SQL).all() as { intent_id: string; status: string }[];
      db.close();
      const liveIds = Object.entries(book.intents).filter(([, i]) => !isTerminal(i)).map(([id]) => id).sort();
      expect(rows.length, `after ${k} events`).toBe(openIntents(book));
      expect(rows.length, `after ${k} events (as the worker restores it)`).toBe(openIntents(stored));
      expect(rows.map((r) => r.intent_id).sort(), `after ${k} events: the listed ids are the book's open ones`).toEqual(liveIds);
      for (const r of rows) statuses.add(r.status);
      if (rows.length > 0) open += 1;
      else closed += 1;
    }
    // The cuts reach both a ledger with open intents and one with none, and more than one open status.
    expect(open).toBeGreaterThan(0);
    expect(closed).toBeGreaterThan(0);
    expect(statuses.size).toBeGreaterThan(1);
  });

  it('agrees with isTerminal for every intent status in the schema, with and without a fill', () => {
    const path = tempPath();
    openLedger(path, 'paper').close();
    const db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys = OFF');
    const want: string[] = [];
    let n = 0;
    for (const status of V1_INTENT_STATUSES) {
      for (const filled of [false, true]) {
        const id = `i${(n += 1)}-${status}-${filled ? 'fill' : 'none'}`;
        db.prepare("INSERT INTO intent (intent_id, idem_key, purpose, side, mint, venue, position_id, spend, quantity, decision_id, created_ts) VALUES (?, ?, 'entry', 'buy', 'M', 'pump-curve', ?, '1', NULL, NULL, 1)").run(id, `k-${id}`, `p-${id}`);
        // An earlier status first: only the latest event decides.
        db.prepare("INSERT INTO intent_event (intent_id, status, event, detail, ts) VALUES (?, 'candidate', 'created', NULL, 1)").run(id);
        db.prepare("INSERT INTO intent_event (intent_id, status, event, detail, ts) VALUES (?, ?, 'e', NULL, 2)").run(id, status);
        if (filled) db.prepare("INSERT INTO fill (intent_id, signature, slot, commitment, tokens, sol, fees, ts) VALUES (?, ?, 1, 'confirmed', '1', '1', '0', 2)").run(id, `sig-${id}`);
        if (!isTerminal({ status, fills: filled ? [{}] : [] } as unknown as IntentState)) want.push(id);
      }
    }
    db.close();
    const ro = new DatabaseSync(path, { readOnly: true });
    const got = (ro.prepare(SQL).all() as { intent_id: string }[]).map((r) => r.intent_id).sort();
    ro.close();
    expect(got).toEqual(want.sort());
    expect(want.length).toBeGreaterThan(0);
  });
});
