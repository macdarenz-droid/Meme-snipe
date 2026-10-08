// Child process for the crash-injection test (B-M24-01 tests): commits state rows with their outbox events and
// drains the outbox to a consumer that appends "<id>,<seq>" lines to a journal file. The parent kills it with
// SIGKILL at random points and restarts it; on restart the consumer reloads its watermark from the journal.
// Usage: node crash-worker.ts <db path> <journal path> <total>
import { closeSync, existsSync, openSync, readFileSync, writeSync } from 'node:fs';
import { openDb, OUTBOX_DDL, OutboxConsumer } from '../../src/m24/db.ts';
import { schemaTx } from '../../src/m24/schema-tx.ts';

const [dbPath, journalPath, totalText] = process.argv.slice(2) as [string, string, string];
const total = Number(totalText);
let tick = 0;
const db = openDb({ create: true, path: dbPath, clock: { kind: 'sim', nowMs: () => tick++ } });
const exists = schemaTx(db, (tx) => tx.get("SELECT 1 AS x FROM sqlite_schema WHERE name = 'state'")) !== undefined;
if (!exists) {
  schemaTx(db, (tx) => {
    for (const stmt of `${OUTBOX_DDL}\nCREATE TABLE state (id INTEGER PRIMARY KEY, v TEXT NOT NULL);`.split(';').map((s) => s.trim()).filter(Boolean)) tx.run(stmt);
  });
}
let watermark = 0n;                                    // the consumer's persisted position: the last journal line's seq
if (existsSync(journalPath)) {
  for (const line of readFileSync(journalPath, 'utf8').split('\n')) {
    const seq = line.split(',')[1];
    if (seq !== undefined && seq !== '' && BigInt(seq) > watermark) watermark = BigInt(seq);
  }
}
const fd = openSync(journalPath, 'a');
const consumer = new OutboxConsumer(
  (row) => { writeSync(fd, `${(JSON.parse(row.payloadJson) as { id: string }).id},${row.seq}\n`); },
  watermark,
);
const last = db.withTx((tx) => tx.get('SELECT coalesce(max(id), 0) AS m FROM state'))?.m as bigint;
for (let i = Number(last) + 1; i <= total; i++) {
  db.withTx((tx) => {
    tx.run('INSERT INTO state (id, v) VALUES (?, ?)', i, `v${i}`);
    db.outbox.append(tx, 'state', { id: String(i) });
  });
  if (i % 25 === 0) db.outbox.drain((rows) => consumer.handle(rows));
}
db.outbox.drain((rows) => consumer.handle(rows));
closeSync(fd);
db.close();
process.stdout.write('done\n');
