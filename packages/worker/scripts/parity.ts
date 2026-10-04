// TEST-1, one command: replays every recorded boot of a worker state folder N times through the backtest's engine path
// and compares the decisions with the live journal byte for byte (wall-clock fields aside); also replays the ledger.
//   node --no-warnings packages/worker/scripts/parity.ts <state dir> [--replays 10]
// Prints the report as JSON. Exit 0: parity holds; 1: a divergence, a nondeterministic replay or a bad ledger;
// 2: the folder cannot be replayed with this code (another policy or strategy version, no journal start).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILL_CONFIG, RESEARCH_CONFIG, RUG_CONFIG, TRIAL_POLICY, startSession } from '../../core/src/config/index.ts';
import { S0_DIAGNOSTIC_PARTS } from '../../core/src/gates/index.ts';
import { replayLedgerFile } from '../../core/src/ledger/replay/index.ts';
import { STATE_FILES } from '../../runner/src/contract.ts';
import { jsonText } from '../src/run/json.ts';
import { checkSession } from '../src/run/parity.ts';
import { strategyConfig } from '../src/run/settings.ts';

const fail = (message: string, code: number): never => {
  console.error(message);
  process.exit(code);
};

const dir = process.argv[2] ?? fail('usage: parity.ts <state dir> [--replays N]', 2);
const at = process.argv.indexOf('--replays');
const replays = at === -1 ? 10 : Number(process.argv[at + 1]);
if (!Number.isSafeInteger(replays) || replays < 1) fail('--replays must be a whole number of at least 1', 2);

interface Start { readonly kind: string; readonly boot: string; readonly policy_version?: string; readonly strategy?: string; readonly paper_edge_ppm?: string | null; readonly entry_rule?: string; readonly s0_salt?: string | null; readonly s0_diagnostic?: readonly string[] | null }
const starts = readFileSync(join(dir, STATE_FILES.journal), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Start).filter((j) => j.kind === 'start');
const first = starts[0] ?? fail('no start line in the journal', 2);
// WORKER-1e's diagnostic set as the start line names it (null or absent: off); the strategy version does not carry it.
const diagnostic = (s: Start): string => JSON.stringify(s.s0_diagnostic ?? null);
for (const s of starts) {
  if (s.policy_version !== first.policy_version || s.strategy !== first.strategy || s.paper_edge_ppm !== first.paper_edge_ppm || s.entry_rule !== first.entry_rule || s.s0_salt !== first.s0_salt || diagnostic(s) !== diagnostic(first)) {
    fail(`boot ${s.boot} ran another policy or strategy than boot ${first.boot}: replay the boots one by one`, 2);
  }
}
// The same session and strategy main.ts builds from the same settings.
const session = startSession(TRIAL_POLICY);
if (first.policy_version !== session.versionHash) fail(`the session ran policy ${first.policy_version}; this code has ${session.versionHash}`, 2);
const s0Diagnostic = first.s0_diagnostic !== null && first.s0_diagnostic !== undefined;
if (s0Diagnostic && diagnostic(first) !== JSON.stringify(S0_DIAGNOSTIC_PARTS)) fail(`the session ran S0's diagnostic set ${diagnostic(first)}; this code has ${JSON.stringify(S0_DIAGNOSTIC_PARTS)}`, 2);
if (s0Diagnostic && first.entry_rule !== 'S0') fail(`the session names S0's diagnostic set on entry rule ${String(first.entry_rule)}`, 2);
const strategy = strategyConfig(session.policy, FILL_CONFIG, RESEARCH_CONFIG, BigInt(first.paper_edge_ppm ?? 0), first.entry_rule === 'S0' ? { timing: 'random', salt: first.s0_salt ?? '', s0Diagnostic } : { timing: 'gates', salt: '' });
if (strategy.version !== first.strategy) fail(`the session ran strategy ${first.strategy}; this code builds ${strategy.version}`, 2);

const report = checkSession(dir, { session, rugs: RUG_CONFIG, strategy }, replayLedgerFile, replays);
console.log(jsonText(report));
process.exit(report.ok ? 0 : 1);
