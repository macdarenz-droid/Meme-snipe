// Child process for the book-writer crash test: commits one book event, then writes the rest of an entry inside an
// open transaction, prints "ready" and blocks until killed.
import { openLedger } from '../../src/ledger/index.ts';
import { emptyBook } from '../../src/lifecycle/index.ts';
import { lamports } from '../../src/units/index.ts';
import { CONFIG, entryToSubmitted } from '../fixtures.ts';

const [path] = process.argv.slice(2);
if (path === undefined) throw new Error('usage: book-child <db>');
const limits = { maxHeld: lamports(10n ** 15n), maxCount: 1_000 };
const ledger = openLedger(path, 'backtest');
const [first, ...rest] = entryToSubmitted(1, 500n);
let book = ledger.recordBookEvent(emptyBook(CONFIG), first!, { ts: 1, limits });
ledger.atomically(() => {
  for (const e of rest) book = ledger.recordBookEvent(book, e, { ts: 2, limits });
  console.log('ready');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
});
