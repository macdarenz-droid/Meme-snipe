// Worker state files in the state directory, each written whole and atomically (temp file, fsync, rename), in lossless
// JSON. A file that is missing reads as its default; a file that exists but cannot be read stops the start (stored
// state is never guessed).
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { Latches } from '../../../core/src/risk/index.ts';
import { NO_LATCHES } from '../../../core/src/risk/index.ts';
import type { SavedExit } from '../engine/strategy.ts';
import { parseTyped, typedText } from './json.ts';

export const atomicWrite = (path: string, text: string): void => {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
};

export class StateFile<T> {
  readonly path: string;
  readonly #check: (v: unknown) => T | null;

  constructor(dir: string, name: string, check: (v: unknown) => T | null) {
    this.path = join(dir, name);
    this.#check = check;
  }

  read(fallback: T): T {
    if (!existsSync(this.path)) return fallback;
    const v = this.#check(parseTyped(readFileSync(this.path, 'utf8')));
    if (v === null) throw new Error(`${this.path} is not a valid state file`);
    return v;
  }

  write(v: T): void {
    atomicWrite(this.path, `${typedText(v)}\n`);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The month's provider credit use (FEED-1 scheduler), so a restart never resets the 70% halt. Month: UTC `YYYY-MM`. */
export interface Credits {
  readonly month: string;
  readonly used: Readonly<Record<string, number>>;
}
export const creditsFile = (dir: string) =>
  new StateFile<Credits>(dir, 'credits.json', (v) => (isObj(v) && typeof v['month'] === 'string' && isObj(v['used']) && Object.values(v['used']).every((x) => typeof x === 'number' && x >= 0) ? (v as unknown as Credits) : null));

/** The month a credit total belongs to. */
export const creditMonth = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

/** Owner controls the worker applies: the watchdog's pause and the risk latches (trips and owner reviews). */
export interface Control {
  readonly paused: boolean;
  readonly pausedAtMs: number | null;
  readonly latches: Latches;
}
export const NO_CONTROL: Control = { paused: false, pausedAtMs: null, latches: NO_LATCHES };
export const controlFile = (dir: string) =>
  new StateFile<Control>(dir, 'control.json', (v) => (isObj(v) && typeof v['paused'] === 'boolean' && isObj(v['latches']) ? (v as unknown as Control) : null));

/**
 * Trades open or in flight when the previous process died, and when it last wrote (RUN-1c's exposure window): kept
 * until the next full start journals their `exposure` lines, so a `--reconcile` run in between does not lose them.
 */
export interface Exposed {
  readonly trades: readonly string[];
  readonly fromMs: number;
}
/** Nothing pending. */
export const NO_EXPOSED: Exposed = { trades: [], fromMs: 0 };
export const exposedFile = (dir: string) =>
  new StateFile<Exposed>(dir, 'exposure.json', (v) => (isObj(v) && Array.isArray(v['trades']) && typeof v['fromMs'] === 'number' ? (v as unknown as Exposed) : null));

/** Exit plans, trackers and bars per open position (EXIT-1 restart acceptance). */
export const exitsFile = (dir: string) =>
  new StateFile<Record<string, SavedExit>>(dir, 'exits.json', (v) => (isObj(v) && Object.values(v).every((s) => isObj(s) && isObj(s['plan']) && isObj(s['tracker']) && Array.isArray(s['bars'])) ? (v as Record<string, SavedExit>) : null));
