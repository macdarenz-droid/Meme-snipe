// `pnpm ledger:replay <ledger.db> [more.db ...] [--max-open-positions N] [--timing]`
// Replays each ledger file read-only through the CORE-1 reducer (src/ledger/replay). Prints one line per file:
// `ok <purpose> <path> <counts>` or `FAIL <purpose> <path> <first failure>`, in canonical JSON, so the same
// file always gives the same output. Exit 0 when every file passes, 1 on a failure, 2 on bad usage or
// files with different purpose stamps (one run checks one kind of ledger). `--timing` adds throughput on stderr.
import { canonical } from '../src/engine/log.ts';
import { openLedgerReader } from '../src/ledger/index.ts';
import { replayLedger, type ReplayOptions } from '../src/ledger/replay/index.ts';

const usage = (message: string): never => {
  process.stderr.write(`ledger:replay: ${message}\nusage: ledger:replay <ledger.db> [more.db ...] [--max-open-positions N] [--timing]\n`);
  process.exit(2);
};

const args = process.argv.slice(2);
const paths: string[] = [];
let timing = false;
let options: ReplayOptions = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === '--timing') timing = true;
  else if (a === '--max-open-positions') {
    const n = Number(args[++i]);
    if (!Number.isSafeInteger(n) || n < 1) usage('--max-open-positions needs an integer >= 1');
    options = { maxOpenPositions: n };
  } else if (a.startsWith('--')) usage(`unknown option ${a}`);
  else paths.push(a);
}
if (paths.length === 0) usage('no ledger file given');

const readers = paths.map((p) => {
  try {
    return openLedgerReader(p);
  } catch (err) {
    return usage(`${p}: ${(err as Error).message}`);
  }
});
const stamps = [...new Set(readers.map((r) => r.purpose()))];
if (stamps.length > 1) {
  for (const r of readers) r.close();
  usage(`mixed stamps: ${stamps.join(', ')}; replay one kind of ledger per run`);
}

let failed = false;
readers.forEach((reader, k) => {
  const started = process.hrtime.bigint();
  const report = replayLedger(reader, options);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  reader.close();
  const path = paths[k]!;
  if (report.ok) {
    process.stdout.write(`ok ${report.purpose} ${path} ${canonical(report.counts)}\n`);
  } else {
    failed = true;
    process.stdout.write(`FAIL ${report.purpose ?? '-'} ${path} ${canonical(report.failure)}\n`);
  }
  if (timing) {
    const rows = report.counts.intentRows + report.counts.positionRows;
    process.stderr.write(`${path}: ${report.counts.events} events, ${rows} rows in ${ms.toFixed(0)} ms (${Math.round(report.counts.events / (ms / 1000))} events/s)\n`);
  }
});
process.exit(failed ? 1 : 0);
