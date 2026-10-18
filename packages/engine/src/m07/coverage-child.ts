// SW-45: the daily coverage report built in a short-lived child of the recorder, so the decode churn of a day's
// poll_counts (one inflate a gzip member, about 12,660 a day) is freed with the process when it exits and never raises
// the recorder's own high-water mark (DECISIONS "SWITCH-FIX" SW-45). The same reader as the recorder's in-process job
// (`dailyCoverage`); it reads files only, writes nothing but the report to stdout, and opens no connection. The parent
// passes no environment, checks the report before use, and kills this process on a timeout or at its own stop.
//   node coverage-child.ts <dataDir> <YYYY-MM-DD> <universeManifestSha256 | ->
import { constants, setPriority } from 'node:os';
import { dailyCoverage } from './daily.ts';

const [dataDir, day, sha] = process.argv.slice(2);
if (dataDir === undefined || day === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(day) || sha === undefined || !(sha === '-' || /^[0-9a-f]{64}$/.test(sha))) {
  process.stderr.write('usage: coverage-child.ts <dataDir> <YYYY-MM-DD> <sha256|->\n');
  process.exitCode = 2;
} else {
  // Below the recorder's loop on the server's one vCPU (nice 10). Refused (a sandbox that filters setpriority): run on.
  try { setPriority(constants.priority.PRIORITY_BELOW_NORMAL); } catch { process.stderr.write('priority_unchanged\n'); }
  const { report } = dailyCoverage({ dataDir, dayUtc: day, universeManifestSha256: sha === '-' ? null : sha });
  process.stdout.write(JSON.stringify(report));
}
