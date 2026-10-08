// Crash injection (B-M24-01 tests and acceptance): SIGKILL during 10,000 transactions, then restart. The outbox and
// the state always agree (one event per committed state row, none for a row that was not committed), and after the
// restarts every event reached the consumer exactly once per entity key.
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { tempDir } from '../helpers.ts';

const WORKER = fileURLToPath(new URL('./crash-worker.ts', import.meta.url));
const TOTAL = 10_000;

/** Runs the worker; kills it with SIGKILL after `killAfterMs` (null: let it finish). Resolves with how it ended. */
function run(dbPath: string, journal: string, killAfterMs: number | null): Promise<'done' | 'killed'> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', WORKER, dbPath, journal, String(TOTAL)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    const timer = killAfterMs === null ? null : setTimeout(() => child.kill('SIGKILL'), killAfterMs);
    child.on('exit', (code, signal) => {
      if (timer !== null) clearTimeout(timer);
      if (signal === 'SIGKILL') resolve('killed');
      else if (code === 0 && out === 'done\n') resolve('done');
      else reject(new Error(`worker exited ${code}: ${err}`));
    });
  });
}

describe('crash injection: SIGKILL during 10,000 transactions (B-M24-01)', () => {
  it('outbox and state agree after every kill, and each event is consumed exactly once per key', async () => {
    const dir = tempDir('crash');
    const dbPath = join(dir, 'crash.db');
    const journal = join(dir, 'consumer.journal');
    const delays = fc.sample(fc.integer({ min: 150, max: 900 }), { numRuns: 5, seed: 20261007 });
    let kills = 0;
    for (const delay of delays) {
      if ((await run(dbPath, journal, delay)) === 'killed') kills++;
      const raw = new DatabaseSync(dbPath, { readOnly: true });
      const state = (raw.prepare('SELECT count(*) AS n FROM state').get() as { n: number }).n;
      const events = (raw.prepare("SELECT count(*) AS n FROM outbox WHERE topic = 'state'").get() as { n: number }).n;
      const orphans = (raw.prepare("SELECT count(*) AS n FROM outbox o WHERE NOT EXISTS (SELECT 1 FROM state s WHERE s.id = CAST(json_extract(o.payload_json, '$.id') AS INTEGER))").get() as { n: number }).n;
      raw.close();
      assert.equal(events, state);
      assert.equal(orphans, 0);
    }
    assert.ok(kills >= 3, `only ${kills} of 5 runs were killed mid-way`);
    assert.equal(await run(dbPath, journal, null), 'done');
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal((raw.prepare('SELECT count(*) AS n FROM state').get() as { n: number }).n, TOTAL);
    assert.equal((raw.prepare('SELECT count(*) AS n FROM outbox WHERE published_at IS NULL').get() as { n: number }).n, 0);
    raw.close();
    const consumed = readFileSync(journal, 'utf8').split('\n').filter(Boolean).map((l) => l.split(',')[0]);
    assert.equal(consumed.length, TOTAL);
    assert.equal(new Set(consumed).size, TOTAL);
  });
});
