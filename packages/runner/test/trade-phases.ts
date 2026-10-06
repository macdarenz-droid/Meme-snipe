// Event barriers for the real synthetic worker. Commands never write its position, intent or journal.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Health, JournalLine } from '../src/contract.ts';
import { httpHealth } from '../src/runner.ts';

export const journalLines = (stateDir: string): JournalLine[] =>
  readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as JournalLine);

export const tradePhases = (dir: string, initial: 'entry' | 'exit' | 'hold') => {
  const file = join(dir, 'trade-phase');
  const set = (phase: 'entry' | 'exit' | 'hold'): void => writeFileSync(file, phase);
  set(initial);
  const wait = async (addr: string, deadline: number, predicate: (h: Health) => boolean): Promise<Health> => {
    while (Date.now() < deadline) {
      const h = await httpHealth(addr);
      if (Date.now() < deadline && h !== null && predicate(h)) return h;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('fixture event did not occur before the unchanged segment/recovery deadline');
  };
  return { file, set, wait };
};
