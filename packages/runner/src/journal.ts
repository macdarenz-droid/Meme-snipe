// Journal completeness (RUN-1 accept: "journal completeness"). Pure: takes the file's text.
import { NEEDS_REASONS, type JournalLine } from './contract.ts';

export interface JournalReport {
  readonly lines: number;
  readonly boots: number;
  readonly entries: number;
  readonly exits: number;
  readonly simulations: number;
  readonly repairs: number;
  readonly complete: boolean;
  readonly problems: readonly string[];
}

const MAX_PROBLEMS = 50;

/**
 * Complete means: every line parses (a torn last line is allowed only while the worker is down, `allowTornTail`);
 * seq runs 1, 2, 3 … with no gap or repeat across restarts; each boot opens with `start`; no `entry` before a
 * successful `reconcile` in the same boot; every entry and exit follows its own `simulation` line (simulation on); every
 * decision-type line has reasons.
 */
export const checkJournal = (text: string, opts: { readonly allowTornTail?: boolean } = {}): JournalReport => {
  const problems: string[] = [];
  const add = (p: string): void => {
    if (problems.length < MAX_PROBLEMS) problems.push(p);
  };
  const raw = text.split('\n');
  if (raw[raw.length - 1] === '') raw.pop();
  const lines: JournalLine[] = [];
  raw.forEach((s, i) => {
    try {
      lines.push(JSON.parse(s) as JournalLine);
    } catch {
      if (!(opts.allowTornTail === true && i === raw.length - 1)) add(`line ${i + 1}: not JSON`);
    }
  });

  const bootsSeen = new Set<string>();
  const reconciled = new Set<string>();
  // Simulated legs not yet used by an entry or exit, keyed `trade|leg`. The worker simulates first, then journals the fill.
  const simulated = new Set<string>();
  let expect = 1;
  let entries = 0;
  let exits = 0;
  let simulations = 0;
  let repairs = 0;
  for (const l of lines) {
    if (l.seq !== expect) add(`seq ${l.seq} where ${expect} expected`);
    expect = l.seq + 1;
    if (typeof l.ts !== 'string' || Number.isNaN(Date.parse(l.ts))) add(`seq ${l.seq}: bad ts`);
    if (!bootsSeen.has(l.boot)) {
      bootsSeen.add(l.boot);
      if (l.kind !== 'start') add(`seq ${l.seq}: boot ${l.boot} opens with ${l.kind}, not start`);
    }
    if (NEEDS_REASONS.has(l.kind) && !(Array.isArray(l.reasons) && l.reasons.length > 0 && l.reasons.every((r) => typeof r === 'string' && r !== ''))) {
      add(`seq ${l.seq}: ${l.kind} without reasons`);
    }
    switch (l.kind) {
      case 'reconcile':
        if (l.ok === true) reconciled.add(l.boot);
        break;
      case 'journal_repair':
        repairs += 1;
        break;
      case 'simulation':
        simulations += 1;
        if (typeof l.trade !== 'string' || (l['leg'] !== 'entry' && l['leg'] !== 'exit')) add(`seq ${l.seq}: simulation without trade and leg`);
        else simulated.add(`${l.trade}|${l['leg']}`);
        break;
      case 'entry':
      case 'exit': {
        if (l.kind === 'entry') {
          entries += 1;
          if (!reconciled.has(l.boot)) add(`seq ${l.seq}: entry before reconcile in boot ${l.boot}`);
        } else exits += 1;
        const key = `${String(l.trade)}|${l.kind}`;
        if (typeof l.trade !== 'string') add(`seq ${l.seq}: ${l.kind} without trade id`);
        else if (!simulated.delete(key)) add(`seq ${l.seq}: ${l.kind} of ${l.trade} without its simulation`);
        break;
      }
      default:
        break;
    }
  }
  return { lines: lines.length, boots: bootsSeen.size, entries, exits, simulations, repairs, complete: problems.length === 0, problems };
};
