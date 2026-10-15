// `md-pull` (SPEC-A A-M07-03 logic 4, card Z08; ruling Z08-5: engine-local, no new package). Runs on the operator's
// machine, never on the host. It downloads day folders of market-data segments over the tailnet with OpenSSH `sftp`
// (the pull account `zeroed-pull` is sftp-only, chrooted to /srv/zeroed_pull, with `md` read-only and `md/receipts`
// writable; PATHS-FIX ruling 17), recomputes the SHA-256 of every segment, and for each one that matches its manifest
// writes a PullReceipt signed with the research Ed25519 key (receipt-sig.ts), then uploads the receipts. The host
// deletes a segment only after verifying such a receipt (disk.ts).
//
// It never deletes anything, on either side: the operator's copy is kept whatever the evaluation windows (`W_B`, `W_R`;
// logic 5 is met by never deleting). Node built-ins and the system's `sftp` only.
import { spawnSync } from 'node:child_process';
import { createHash, type KeyObject } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import type { UnixMs } from '@bot/types';
import { isDayName, isHourName, isManifest, manifestNameOf, parseSegmentName } from './manifest.ts';
import { compressorFor } from './segments.ts';
import { receiptText, signReceipt, type PullReceipt } from './receipt-sig.ts';
import { receiptFileName } from './receipts.ts';

/** How md-pull reaches the host; production is `sftpTransport`, tests pass a local one. */
export interface PullTransport {
  /** Day folder names on the host (`YYYY-MM-DD`). */
  listDays(): string[];
  /** Copies the host's `<day>` folder into `<localRoot>/<day>`. */
  fetchDay(day: string, localRoot: string): void;
  /** Uploads one receipt file into the host's receipts folder. */
  putReceipts(files: ReadonlyArray<{ local: string; name: string }>): void;
}

export interface PullResult { days: string[]; verified: PullReceipt[]; mismatched: string[]; unmanifested: string[] }

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** Lines the file decodes to, or -1 when it does not decode completely (or the codec cannot be read here). */
export function decodedLines(bytes: Uint8Array, codec: 'gzip' | 'zstd'): number {
  const comp = compressorFor(codec);
  if (comp === null) return -1;
  if (bytes.length === 0) return 0;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(comp.decompress(bytes));
  } catch {
    return -1;
  }
  if (!text.endsWith('\n')) return -1;
  const lines = text.slice(0, -1).split('\n');
  for (const l of lines) {
    try {
      JSON.parse(l);
    } catch {
      return -1;
    }
  }
  return lines.length;
}

export function runPull(o: {
  transport: PullTransport; localRoot: string; since: string; privateKey: KeyObject; verifier: string; nowMs: () => UnixMs;
  log: (line: string) => void; fs?: Pick<typeof nodeFs, 'readdirSync' | 'readFileSync' | 'existsSync' | 'statSync' | 'mkdirSync' | 'writeFileSync'>;
}): PullResult {
  if (!isDayName(o.since)) throw new RangeError('--since must be YYYY-MM-DD');
  const fs = o.fs ?? nodeFs;
  const days = o.transport.listDays().filter((d) => isDayName(d) && d >= o.since).sort();
  const out: PullResult = { days, verified: [], mismatched: [], unmanifested: [] };
  const receiptsDir = join(o.localRoot, 'receipts');
  if (!fs.existsSync(receiptsDir)) fs.mkdirSync(receiptsDir, { recursive: true });
  const toUpload: Array<{ local: string; name: string }> = [];
  for (const day of days) {
    o.transport.fetchDay(day, o.localRoot);
    const dayDir = join(o.localRoot, day);
    if (!fs.existsSync(dayDir)) continue;
    for (const hour of (fs.readdirSync(dayDir) as string[]).filter(isHourName).sort()) {
      const dir = join(dayDir, hour);
      for (const name of (fs.readdirSync(dir) as string[]).sort()) {
        const seg = parseSegmentName(name);
        if (seg === null) continue;
        const path = `${day}/${hour}/${name}`;
        const mPath = join(dir, manifestNameOf(name) as string);
        let m: unknown = null;
        try {
          m = fs.existsSync(mPath) ? JSON.parse(fs.readFileSync(mPath, 'utf8') as string) : null;
        } catch {
          m = null;
        }
        if (!isManifest(m)) { out.unmanifested.push(path); continue; }        // still open on the host, or unreadable
        const bytes = fs.readFileSync(join(dir, name)) as Buffer;
        const got = sha256(bytes);
        // Ruling Z08-14: a receipt lets the host delete its only copy, so the file must also DECODE to exactly the
        // manifest's record count (a hash only proves the copy equals the host's file, which may itself be torn).
        if (got !== m.sha256 || bytes.length !== m.bytes || m.path !== path || decodedLines(bytes, seg.codec) !== m.records) {
          out.mismatched.push(path);
          o.log(`MISMATCH ${path}`);
          continue;
        }
        const r = signReceipt({ path, sha256: got, verifiedAtMs: o.nowMs(), verifier: o.verifier }, o.privateKey);
        const fileName = receiptFileName(path);
        const local = join(receiptsDir, fileName);
        fs.writeFileSync(local, receiptText(r));
        toUpload.push({ local, name: fileName });
        out.verified.push(r);
      }
    }
  }
  if (toUpload.length > 0) o.transport.putReceipts(toUpload);
  o.log(`days ${days.length}, verified ${out.verified.length}, mismatched ${out.mismatched.length}, open ${out.unmanifested.length}`);
  return out;
}

/** A batch line argument: sftp batch files split on spaces, so only plain path characters are allowed. */
const SAFE = /^[A-Za-z0-9._/-]+$/;
export function sftpBatch(lines: ReadonlyArray<readonly string[]>): string {
  return `${lines.map((args) => {
    for (const a of args.slice(1)) if (!SAFE.test(a)) throw new RangeError(`unsafe sftp argument: ${a}`);
    return args.join(' ');
  }).join('\n')}\n`;
}

/** The production transport: `sftp -b` in batch mode against the pull account on the tailnet host. */
export function sftpTransport(host: string, run: (args: string[], batch: string) => { status: number; stdout: string } = runSftp): PullTransport {
  if (!/^[A-Za-z0-9.-]+$/.test(host)) throw new RangeError('--host must be a tailnet name');
  const target = `zeroed-pull@${host}`;
  const call = (batch: string): string => {
    const r = run(['-b', '-', '-o', 'BatchMode=yes', target], batch);
    if (r.status !== 0) throw new Error(`sftp exited ${r.status}`);
    return r.stdout;
  };
  return {
    listDays(): string[] {
      return call(sftpBatch([['ls', '-1', 'md']])).split('\n').map((l) => l.trim().replace(/^md\//, '')).filter(isDayName);
    },
    fetchDay(day: string, localRoot: string): void {
      call(sftpBatch([['lcd', localRoot], ['get', '-r', `md/${day}`]]));
    },
    putReceipts(files): void {
      call(sftpBatch(files.map((f) => ['put', f.local, `md/receipts/${f.name}`])));
    },
  };
}

function runSftp(args: string[], batch: string): { status: number; stdout: string } {
  const r = spawnSync('sftp', args, { input: batch, encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '' };
}

/** `md-pull --host <tailnet-name> --since <day> --out <dir> --key <pkcs8.pem> --verifier <label>` argument parsing. */
export function parseArgs(argv: readonly string[]): { host: string; since: string; out: string; key: string; verifier: string } | string {
  const want = ['host', 'since', 'out', 'key', 'verifier'] as const;
  const got: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i] ?? '';
    const v = argv[i + 1];
    if (!k.startsWith('--') || v === undefined) return `bad argument ${k}`;
    got[k.slice(2)] = v;
  }
  for (const k of want) if (got[k] === undefined) return `missing --${k}`;
  return { host: got.host as string, since: got.since as string, out: got.out as string, key: got.key as string, verifier: got.verifier as string };
}
