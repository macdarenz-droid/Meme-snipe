// Journal completeness (RUN-1 accept: "journal completeness"). Pure: takes the file's text.
import { NEEDS_REASONS, type JournalLine } from './contract.ts';
import { isOutcome } from './item4.ts';

export interface JournalReport {
  readonly lines: number;
  readonly boots: number;
  readonly entries: number;
  readonly exits: number;
  readonly simulations: number;
  readonly repairs: number;
  /** WORKER-1e: decision lines that relied on S0's diagnostic set, by part (`s0_diagnostic`). */
  readonly s0_diagnostic: Readonly<Record<string, number>>;
  /** WORKER-1e: H15's simulations (`h15_sim` lines): how many, how many ran, and the Helius credits they spent. */
  readonly h15_sim: { readonly lines: number; readonly run: number; readonly credits: number };
  readonly complete: boolean;
  readonly problems: readonly string[];
  /** Each boot's entry rule as its `start` line states it (WORKER-1: entry_rule, paper_edge_ppm, qualifying, s0_salt). */
  readonly starts: readonly StartFields[];
}

export interface StartFields {
  readonly boot: string;
  readonly entry_rule: unknown;
  readonly paper_edge_ppm: unknown;
  readonly qualifying: unknown;
  readonly s0_salt: unknown;
  /** WORKER-1e: S0's diagnostic set (its parts), or null. */
  readonly s0_diagnostic: unknown;
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
  const diagnosed: Record<string, number> = {};
  const h15 = { lines: 0, run: 0, credits: 0 };
  const starts: StartFields[] = [];
  for (const l of lines) {
    const parts = l['s0_diagnostic'];
    if (l.kind === 'h15_sim') {
      h15.lines += 1;
      if (l['outcome'] !== 'not-run') h15.run += 1;
      if (typeof l['credits'] === 'number' && Number.isFinite(l['credits'])) h15.credits += l['credits'];
    }
    if (l.kind === 'decision' && Array.isArray(parts)) for (const p of parts) diagnosed[String(p)] = (diagnosed[String(p)] ?? 0) + 1;
    if (l.kind === 'start') starts.push({ boot: l.boot, entry_rule: l['entry_rule'], paper_edge_ppm: l['paper_edge_ppm'], qualifying: l['qualifying'], s0_salt: l['s0_salt'], s0_diagnostic: l['s0_diagnostic'] ?? null });
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
        // TEST-2's DryRunRecord: without an outcome the leg cannot be scored for item 4.
        if (!isOutcome(l['outcome'])) add(`seq ${l.seq}: simulation without an outcome`);
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
  return { lines: lines.length, boots: bootsSeen.size, entries, exits, simulations, repairs, s0_diagnostic: diagnosed, h15_sim: h15, complete: problems.length === 0, problems, starts };
};
