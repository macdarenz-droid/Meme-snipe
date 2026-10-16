// Operator-side `md-pull` (SPEC-A A-M07-03 logic 4, card Z08): runs on the operator's machine, never on the host.
//   node scripts/md-pull.ts --host <tailnet-name> --since <YYYY-MM-DD> --out <dir> --key <research-ed25519-pkcs8.pem> --verifier <label>
import { readFileSync } from 'node:fs';
import type { UnixMs } from '@bot/types';
import { parseArgs, runPull, sftpTransport } from '../src/m07/md-pull.ts';
import { ed25519Key } from '../src/m07/receipt-sig.ts';
import { operatorWallClock } from '../src/m07/wall-clock.ts';

const args = parseArgs(process.argv.slice(2));
if (typeof args === 'string') {
  console.error(`md-pull: ${args}`);
  process.exit(2);
}
// The receipt time is wall time on the operator's machine (informational: the host checks the signature and the hash).
const wall = (): UnixMs => operatorWallClock.nowMs();
const result = runPull({
  transport: sftpTransport(args.host), localRoot: args.out, since: args.since, verifier: args.verifier,
  privateKey: ed25519Key(readFileSync(args.key, 'utf8'), 'private'), nowMs: wall, log: (l) => console.log(l),
});
process.exit(result.mismatched.length > 0 ? 1 : 0);
