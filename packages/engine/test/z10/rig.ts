// Boots the recorder's composition root (src/recorder-main/compose.ts) on the fake chain, in a temporary folder, with
// a virtual clock (card Z10). Shared by the composition tests and the soak.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UnixMs } from '@bot/types';
import { createRecorder, type RecorderPaths, type RunningRecorder } from '../../src/recorder-main/compose.ts';
import type { FileStat } from '../../src/m25/files.ts';
import type { LogSink } from '../../src/m27/log.ts';
import { FakeChain, FAKE_SECRETS, VirtualTime } from './fake-chain.ts';

/** The recorder's ceilings: the tightest values M25 accepts (every value 1). The recorder never trades. */
export const RECORDER_CEILINGS = {
  per_trade_notional_lamports: '1', open_positions: 1, daily_loss_lamports: '1', hot_wallet_cap_lamports: '1', slippage_bps: 1,
  signer_day_cap_lamports: '1', tip_cap_lamports: '1', exit_fee_cap_lamports: '1',
};
export const RECORDER_ALLOCATION = { shares: { shyft: { engine: 10_000 }, chainstack: { engine: 10_000 } }, credits: { chainstack: { engine: 'rest' } } };

export function recorderConfig(paths: RecorderPaths, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'm24.db_path': paths.db, 'm27.log_dir': paths.logDir, 'recorder.data_dir': paths.mdDir, 'rpc.allocation_file': join(paths.ceilings, '..', 'rpc-allocation.json'),
    'universe.screening_required': false, ...over,
  };
}

const rootFile: FileStat = { uid: 0, mode: 0o100644, isFile: true, isSymbolicLink: false, isDirectory: false };
const rootDir: FileStat = { uid: 0, mode: 0o40755, isFile: false, isSymbolicLink: false, isDirectory: true };
/** Test only: the temporary /etc/bot is treated as root-owned (CI runs as an ordinary user). */
export const rootStat = (p: string): FileStat | null => (p.endsWith('.json') || p.endsWith('.pem') ? rootFile : rootDir);

export interface Rig {
  time: VirtualTime; chain: FakeChain; rec: RunningRecorder; lines: string[]; paths: RecorderPaths; dir: string;
  codes(): string[];
  /** Advances virtual time a second at a time. */
  run(ms: number): Promise<void>;
}

export const WALL_START = Date.UTC(2026, 9, 6, 17, 30, 0);

export async function startRig(dir: string, o: { seed?: number; config?: Record<string, unknown>; time?: VirtualTime; chain?: FakeChain; keepLines?: boolean; release?: string } = {}): Promise<Rig> {
  const time = o.time ?? new VirtualTime(WALL_START);
  const chain = o.chain ?? new FakeChain(time, { seed: o.seed ?? 1 });
  const etc = join(dir, 'etc');
  mkdirSync(etc, { recursive: true });
  const paths: RecorderPaths = {
    db: join(dir, 'state/bot.db'), preMigrationBackup: join(dir, 'state/premigrate/bot.premigrate'), initMarker: join(dir, 'state/init/first-start'),
    logDir: join(dir, 'state/log'), usageDb: join(dir, 'usage/rpc-usage.db'), mdDir: join(dir, 'md'), receiptsDir: join(dir, 'md/receipts'),
    ceilings: join(etc, 'ceilings.json'), config: join(etc, 'config.json'),
  };
  for (const d of ['state/premigrate', 'state/init', 'state/log', 'usage', 'md/receipts']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(paths.ceilings, JSON.stringify(RECORDER_CEILINGS));
  writeFileSync(paths.config, JSON.stringify(recorderConfig(paths, o.config)));
  writeFileSync(join(etc, 'rpc-allocation.json'), JSON.stringify(RECORDER_ALLOCATION));
  const lines: string[] = [];
  const sink: LogSink = { write: (l) => { if (o.keepLines !== false) lines.push(l); return 'written'; } };
  const r = await createRecorder({
    paths, secrets: { get: (n) => FAKE_SECRETS[n] }, fetch: chain.fetch, clock: time, scheduler: time.scheduler, releaseId: o.release ?? 'a'.repeat(40),
    euid: 1000, createDb: true, logSink: sink, readFile: (p) => readFileSync(p, 'utf8'), stat: rootStat,
    diskUsage: () => ({ totalBytes: 55e9, freeBytes: 40e9 }), researchKey: () => null,
  });
  if (!r.ok) throw new Error(`recorder refused to start: ${r.error.reason}: ${r.error.message}`);
  return {
    time, chain, rec: r.value, lines, paths, dir,
    codes: () => lines.map((l) => (JSON.parse(l) as { code: string }).code),
    async run(ms: number) { for (let t = 0; t < ms; t += 1_000) await time.advance(1_000); },
  };
}

export const at = (r: Rig): UnixMs => r.time.nowMs();
