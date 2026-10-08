// Test helpers for @bot/engine: a settable clock and a temporary directory per test file.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import type { Clock, UnixMs } from '@bot/types';
import type { Db, TxHandle } from '../src/m24/db.ts';
import { schemaTx } from '../src/m24/schema-tx.ts';

export interface FakeClock extends Clock { set(ms: number): void; advance(ms: number): void }

export function fakeClock(startMs = Date.UTC(2026, 9, 7, 12, 0, 0)): FakeClock {
  let now = startMs;
  return {
    kind: 'sim',
    nowMs: () => now as UnixMs,
    set(ms: number): void { now = ms; },
    advance(ms: number): void { now += ms; },
  };
}

const dirs: string[] = [];
// Registered when a test file imports this module, so it runs when that file ends; Vitest refuses hooks added inside a test.
afterAll(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A fresh directory removed when the test file ends. */
export function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `engine-${label}-`));
  dirs.push(dir);
  return dir;
}

export function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const poll = (): void => {
      if (cond()) return resolve();
      if (process.hrtime.bigint() - started > BigInt(timeoutMs) * 1_000_000n) return reject(new Error('waitFor: timed out'));
      setTimeout(poll, 5);
    };
    poll();
  });
}

/** Test fixtures' own schema transaction (Z02 round 5 ruling 26): tables and triggers a test needs beside the migrations. */
export function schemaFixture<T>(db: Db, fn: (tx: TxHandle) => T): T {
  return schemaTx(db, fn);
}
