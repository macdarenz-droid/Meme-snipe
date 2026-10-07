// CI step: the security audit of the packages the checked importers reach (tools/policy/audit.ts). One registry
// request, Retry-After honoured, stop at the third failure. `--include-zeroed` audits the whole lockfile. On a pull
// request a matching advisory for a version the change adds fails the step; every other run reports only (audit.ts).
import { main } from '../audit.ts';
import { wallClockNowMs } from '../clock.ts';
import { gitAt } from '../git.ts';

const io = { out: (s: string) => console.log(s), err: (s: string) => console.error(s) };
const post = (url: string, body: string) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body, redirect: 'error', signal: AbortSignal.timeout(120_000),
});
const pacing = { sleep: (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }), nowMs: wallClockNowMs };
process.exitCode = await main(process.argv.slice(2), process.env, io, post, pacing, gitAt(process.cwd()));
