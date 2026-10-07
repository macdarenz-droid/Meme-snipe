// CI step `node tools/policy/bin/age.ts`: the 14-day rule for package versions new against the base branch (tools/policy/age.ts).
// One registry request in flight, at least 500 ms apart, Retry-After honoured, stop at the third failure.
import { main, registryTimes } from '../age.ts';
import { wallClockNowMs } from '../clock.ts';
import { DEFAULT_BASE_REF } from '../config.ts';
import { gitAt } from '../git.ts';

const io = { out: (s: string) => console.log(s), err: (s: string) => console.error(s) };
const get = (url: string) => fetch(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(120_000) });
const pacing = { sleep: (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }), nowMs: wallClockNowMs };
process.exitCode = await main(process.cwd(), wallClockNowMs(), io, registryTimes(get, wallClockNowMs), gitAt(process.cwd()),
  process.env['POLICY_BASE_REF'] ?? DEFAULT_BASE_REF, pacing);
