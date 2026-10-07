// RC-STATE (red team B, RB-17): every account.json the real writers produce must pass the start's check
// (`checkAccount`), or a later type change the checker does not follow refuses the next start. Loaded for every test
// file (vitest.config.ts setupFiles): each write through the account's StateFile is read back and checked, and a test
// that made a shape the checker refuses fails at its end. The check itself stays strict.
import { readFileSync } from 'node:fs';
import { afterEach } from 'vitest';
import { checkAccount } from '../src/run/account.ts';
import { parseTyped } from '../src/run/json.ts';
import { StateFile } from '../src/run/state.ts';

/** Writes of account.json the checker refused since the last test ended: path and the written text (cut). */
export const refusedAccountWrites: { path: string; text: string }[] = [];

const write = StateFile.prototype.write;
StateFile.prototype.write = function (this: StateFile<unknown>, v: unknown): void {
  write.call(this, v);
  if (!this.path.endsWith('account.json')) return;
  const text = readFileSync(this.path, 'utf8');
  let ok = false;
  try {
    ok = checkAccount(parseTyped(text)) !== null;
  } catch {
    ok = false;
  }
  if (!ok) refusedAccountWrites.push({ path: this.path, text: text.slice(0, 2_000) });
};

afterEach(() => {
  const bad = refusedAccountWrites.splice(0);
  if (bad.length > 0) throw new Error(`account.json written in a shape checkAccount refuses (the next start would refuse it): ${bad[0]!.text}`);
});
