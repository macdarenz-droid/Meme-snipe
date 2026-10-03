// journal.jsonl (docs/ARCHITECTURE.md §12.4): one JSON line per event, appended synchronously, so a kill can tear only
// the last line. At open a torn last line is cut and a `journal_repair` line follows the boot's `start`; `seq` runs on
// across restarts.
import { appendFileSync, existsSync, readFileSync, truncateSync } from 'node:fs';
import { redact } from './redact.ts';
import type { JournalKind } from '../../../runner/src/contract.ts';
import { jsonText } from './json.ts';

export class Journal {
  readonly #path: string;
  readonly #boot: string;
  readonly #now: () => number;
  #seq = 0;
  /** True when a torn last line was cut at open. */
  readonly repaired: boolean;

  constructor(path: string, boot: string, now: () => number) {
    this.#path = path;
    this.#boot = boot;
    this.#now = now;
    let repaired = false;
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8');
      const lines = text.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      const last = lines[lines.length - 1];
      if (last !== undefined) {
        try {
          JSON.parse(last);
        } catch {
          // Keep everything before the torn line, newline included.
          truncateSync(path, Buffer.byteLength(text.slice(0, text.length - last.length - (text.endsWith('\n') ? 1 : 0))));
          lines.pop();
          repaired = true;
        }
      }
      const good = lines[lines.length - 1];
      if (good !== undefined) this.#seq = (JSON.parse(good) as { seq: number }).seq;
    }
    this.repaired = repaired;
  }

  get seq(): number {
    return this.#seq;
  }

  write(kind: JournalKind, fields: Readonly<Record<string, unknown>> = {}): void {
    this.#seq += 1;
    appendFileSync(this.#path, `${redact(jsonText({ seq: this.#seq, ts: new Date(this.#now()).toISOString(), boot: this.#boot, kind, ...fields }))}\n`);
  }
}
