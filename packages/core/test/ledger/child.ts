// Child process for the crash and concurrency tests. Runs the real ledger code in its own process.
//   hang <db> <stage>      opens the ledger, writes part of a transaction, prints "ready" at stage 1-4, then blocks forever
//   loop <db> <offset>     writes intent + reservation + outbox transactions until killed, printing "wrote <n>"
//   writer <db> <startAt>  waits for startAt, then tries to open the ledger as its writer and prints the outcome
//   reserve <db> <startAt> <maxHeld> <ids...>   waits for startAt, then reserves each id on its own connection
import { DatabaseSync } from 'node:sqlite';
import { openLedger, type Ledger } from '../../src/ledger/index.ts';
import { reserveIn } from '../../src/ledger/ledger.ts';
import { inTransaction } from '../../src/ledger/sqlite.ts';
import { lamports } from '../../src/units/index.ts';
import { entryIntent } from '../fixtures.ts';
import { PADDING } from './constants.ts';

const [mode, path, ...rest] = process.argv.slice(2);
if (path === undefined) throw new Error('usage: child <mode> <db> ...');
const blockForever = (): never => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error('unreachable');
};

const writeOneTrade = (ledger: Ledger, n: number, at?: { readonly stage: number; readonly fn: () => void }): void => {
  const stop = (stage: number) => { if (at?.stage === stage) at.fn(); };
  ledger.atomically(() => {
    const intent = entryIntent(n);
    ledger.recordIntent(intent, { status: 'risk_approved', ts: n });
    stop(1);
    // Padding, so nearly all of the child's time is spent inside an open transaction.
    for (let k = 0; k < PADDING; k++) ledger.recordObservation({ provider: 'test', mint: intent.mint, kind: 'pad', receiptTs: n, payload: { k } });
    stop(2);
    ledger.reserveExposure({
      reservationId: `r${n}`, intentId: intent.id, amount: lamports(1_000), ts: n,
      limits: { maxHeld: lamports(10n ** 15n), maxCount: 1_000_000 },
      transition: { status: 'exposure_reserved', event: 'reserve', effects: [{ type: 'keep_reservation', intentId: intent.id, amount: lamports(1_000) }] },
    });
    stop(3);
    ledger.appendIntentTransition({ intentId: intent.id, status: 'prepared', event: 'prepare', effects: [{ type: 'reconcile_balances', intentId: intent.id }], ts: n });
    stop(4); // every row written, COMMIT not yet run
  });
};

if (mode === 'hang') {
  const ledger = openLedger(path, 'paper');
  writeOneTrade(ledger, 1); // committed before the crash
  writeOneTrade(ledger, 2, { stage: Number(rest[0] ?? 3), fn: () => {
    console.log('ready');
    blockForever();
  } });
} else if (mode === 'loop') {
  const ledger = openLedger(path, 'paper');
  for (let n = Number(rest[0]); ; n++) {
    writeOneTrade(ledger, n);
    if (n % 25 === 0) console.log(`wrote ${n}`);
  }
} else if (mode === 'writer') {
  const [startAt] = rest;
  while (Date.now() < Number(startAt)) { /* start together */ }
  try {
    const ledger = openLedger(path, 'paper');
    console.log('writer ok');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000); // hold the lock while the others try
    ledger.close();
  } catch (err) {
    console.log(`writer refused ${(err as Error).message}`);
  }
} else if (mode === 'reserve') {
  const [startAt, maxHeld, ...ids] = rest;
  const db = new DatabaseSync(path, { readBigInts: true, timeout: 30_000, enableForeignKeyConstraints: true });
  while (Date.now() < Number(startAt)) { /* start together */ }
  const results = ids.map((id, i) => inTransaction(db, () => reserveIn(db, {
    reservationId: `r-${id}`, intentId: id, amount: lamports(1_000_000), ts: i,
    limits: { maxHeld: lamports(BigInt(maxHeld ?? '0')), maxCount: 1_000 },
  })).ok);
  console.log(`result ${JSON.stringify(results)}`);
  db.close();
} else {
  throw new Error(`unknown mode ${mode}`);
}
