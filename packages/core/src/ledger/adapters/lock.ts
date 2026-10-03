// The writer lock. It lives in adapters/ because it pauses the thread and draws randomness for its
// back-off, which core code outside adapters may not do (docs/ARCHITECTURE.md §16.1). No ledger SQL lives here.

import { randomInt } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { LedgerError } from '../errors.ts';

/** Attempts at the writer lock before an opener is refused (about 1.5 s in all with the pauses between them). */
const WRITER_LOCK_ATTEMPTS = 60;

const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Holds an exclusive SQLite lock on a sidecar file for the writer's whole life. The lock is an OS
 * file lock: the kernel drops it when the process dies, so there is no pid file, no stale check
 * and no window where two openers can both win. A second opener, in this process or another, is refused.
 *
 * Openers racing for a fresh lock can deadlock inside SQLite (each holds a read lock while waiting for
 * the others to drop theirs), so each attempt does not wait: on failure it closes, which drops its read
 * lock, pauses for a random 5-45 ms, and tries again. One racer wins; a live writer
 * makes every attempt fail, and the opener is refused.
 */
export const takeWriterLock = (dbPath: string): (() => void) => {
  let last = '';
  for (let attempt = 0; attempt < WRITER_LOCK_ATTEMPTS; attempt++) {
    const lock = new DatabaseSync(`${dbPath}-writer.lock`, { timeout: 0 });
    try {
      lock.exec('PRAGMA locking_mode = EXCLUSIVE');
      lock.exec('BEGIN EXCLUSIVE');
      return () => {
        if (lock.isOpen) lock.close(); // closing ends the transaction and releases the lock
      };
    } catch (err) {
      lock.close();
      last = (err as Error).message;
      if (!/locked|busy/i.test(last)) throw new LedgerError(`${dbPath}: cannot take the writer lock (${last})`);
      pause(randomInt(5, 46)); // 5-45 ms; random, so racers fall out of step
    }
  }
  throw new LedgerError(`${dbPath} already has a writer (${last})`);
};

