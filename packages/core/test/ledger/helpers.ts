// Shared helpers for the ledger tests: temp files and child processes running the real ledger code.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

export const tempPath = (name = 'ledger.db'): string => {
  const dir = mkdtempSync(join(tmpdir(), 'zeroed-ledger-'));
  dirs.push(dir);
  return join(dir, name);
};

export const CHILD = new URL('./child.ts', import.meta.url).pathname;

export interface Child {
  readonly pid: number;
  /** Resolves with the first stdout line that starts with the prefix. */
  readonly line: (prefix: string) => Promise<string>;
  readonly exit: Promise<number | null>;
  readonly kill: () => void;
}

/** Runs test/ledger/child.ts in a separate Node process (type stripping, no build step). */
export const runChild = (args: readonly string[]): Child => {
  const p = spawn(process.execPath, ['--no-warnings', CHILD, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  const waiters: { prefix: string; resolve: (l: string) => void }[] = [];
  const scan = () => {
    for (const w of [...waiters]) {
      const l = out.split('\n').find((x) => x.startsWith(w.prefix));
      if (l !== undefined) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(l);
      }
    }
  };
  p.stdout.on('data', (d: Buffer) => { out += d.toString(); scan(); });
  p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
  const exit = new Promise<number | null>((resolve) => p.on('exit', (code) => resolve(code)));
  return {
    pid: p.pid ?? -1,
    line: (prefix) => new Promise((resolve, reject) => {
      waiters.push({ prefix, resolve });
      scan();
      void exit.then(() => setTimeout(() => reject(new Error(`child exited before "${prefix}". stderr: ${err}`)), 50));
    }),
    exit,
    kill: () => { p.kill('SIGKILL'); },
  };
};
