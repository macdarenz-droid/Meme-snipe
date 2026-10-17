// Card Z10: the 48 h soak of the recorder, off the server, on compressed time. The SAME composition root as the server
// (src/recorder-main/compose.ts) runs on a virtual clock and the fake chain (test/z10/fake-chain.ts): real mainnet
// fixture accounts (fixtures/mainnet), SYNTHETIC trades and SYNTHETIC migrations (a new pool every MIGRATION_EVERY_MS,
// an alias of a fixture pool), written to real folders: segments, the M24 database, the watch log.
//
// Why compressed time stands in for 48 wall-clock hours: what can grow is driven by events, and the soak produces the
// same events as 48 real hours: one poll a second per watched pool, every bar, flush, hourly rotation, disk check, the
// two 00:00 UTC jobs, the universe's retries, retirements and tails, the anchor refreshes. What it does NOT reproduce
// (proved only by the M1 exit's 48 h run on the server): garbage-collector idle behaviour over wall time, real
// provider latency and errors, and timer drift.
//
// Each simulated hour, after a full GC: heap used, RSS, the recorder folder's bytes and the database's size. Pass
// (all must hold):
//   1. peak heap in hours 24-48 <= peak heap in hours 1-24 x 1.10 + 8 MiB (bounded, no growth in the second day);
//   2. the least-squares slope of heap over hours 24-48 <= 0.5 MiB an hour, and of RssAnon <= 0.25 MiB an hour (ruling
//      Z10-38, tightened from Z10-35's 1 MiB: 6 MiB a day at most, where the bounded rings have filled by hour 14);
//   3. peak RSS <= LIMIT_RSS (75% of the unit's MemoryMax, passed in);
//   4. no `m27.unknown_code` line, no `recorder.internal_error`, no unhandled rejection;
//   5. at least one pool watched (SWITCH-FIX: a soak that recorded nothing passed 1-4).
// Usage: node --expose-gc --no-warnings --max-old-space-size=<RECORDER_HEAP_MB> --max-semi-space-size=<RECORDER_SEMI_SPACE_MB>
//   scripts/soak/soak.ts [hours=48] [outDir] [rssLimitMiB=600]   (SW-35: both from logic.sh, as worker-start passes them)
// (CI passes the server's heap limit, so a heap the recorder could not hold on the server fails here too.)
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pubkey, UnixMs } from '@bot/types';
import { MINTS } from '@bot/venue/constants';
import { FakeChain, VirtualTime } from '../../test/z10/fake-chain.ts';
import { startRig } from '../../test/z10/rig.ts';

const HOURS = Number(process.argv[2] ?? 48);
const OUT = process.argv[3] ?? mkdtempSync(join(tmpdir(), 'z10-soak-'));
const LIMIT_RSS = Number(process.argv[4] ?? 600) * 1_048_576;
/** SYNTHETIC: a new migration every 5 minutes (288 a day; the real rate is UNVERIFIED); SOAK_MIGRATION_MS changes it. */
export const MIGRATION_EVERY_MS = Number(process.env.SOAK_MIGRATION_MS ?? 300_000);
const MIB = 1_048_576;
const gc = (globalThis as { gc?: () => void }).gc;
if (gc === undefined) { process.stdout.write('run with --expose-gc\n'); process.exit(2); }

let unhandled = 0;
process.on('unhandledRejection', () => { unhandled++; });

const du = (dir: string): number => {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? du(join(dir, e.name)) : statSync(join(dir, e.name)).size;
  return n;
};

const time = new VirtualTime(Date.UTC(2026, 9, 6, 17, 30, 0));
const chain = new FakeChain(time, { seed: 48 });
// Ruling Z10-35: SOAK_FAILED_SIGS_PER_S SYNTHETIC failed transactions a second on the migration authority, so each
// backfill run pages past its 1,000-signature page.
chain.failedSigsPerSec = Number(process.env.SOAK_FAILED_SIGS_PER_S ?? 0);
let unknown = 0, internal = 0, lines = 0;
const counted = new Map<string, number>();
const rig = await startRig(join(OUT, 'run'), { time, chain, keepLines: false });
// Count the log lines as they go (keepLines: false keeps none in memory).
const origEvent = rig.rec.parts.log.event.bind(rig.rec.parts.log);
rig.rec.parts.log.event = (level, code, fields) => {
  lines++;
  if (code === 'recorder.internal_error') internal++;
  counted.set(code, (counted.get(code) ?? 0) + 1);
  if (process.env.SOAK_TRACE !== undefined && code.includes(process.env.SOAK_TRACE) && (counted.get(code) ?? 0) <= 5) process.stdout.write(`TRACE ${level} ${code} ${JSON.stringify(fields, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}\n`);
  origEvent(level, code, fields);
};

const fixtures = [...chain.pools];
const clones: Array<{ p: (typeof fixtures)[number]; atMs: number }> = [];
/** SYNTHETIC: a clone closes 12 h after its migration (past every tail: PM-01's window is 2 h, tails 1 h more). */
const CLONE_KEEP_MS = Number(process.env.SOAK_CLONE_KEEP_H ?? 12) * 3_600_000;
let peakHeapTotal = 0;
let peakRssAny = 0;
let nextMigration = 0;
let migrations = 0;
const samples: Array<{ hour: number; heapMiB: number; rssMiB: number; rssAnonMiB: number; rssFileMiB: number; externalMiB: number; arrayBuffersMiB: number; ringMiB: number; metricsRingMiB: number; trackedPools: number; encoderStates: number; mdMiB: number; dbMiB: number; watched: number; queueDepth: number; wallS: number }> = [];
/** RssAnon and RssFile of /proc/self/status (Linux), in MiB; -1 elsewhere. */
const procRss = (field: 'RssAnon' | 'RssFile'): number => {
  try { return Number(new RegExp(`^${field}:\\s+(\\d+) kB$`, 'm').exec(readFileSync('/proc/self/status', 'utf8'))?.[1] ?? -1024) / 1024; } catch { return -1; }
};
const started = process.hrtime.bigint();
for (let s = 0; s < HOURS * 3_600; s++) {
  if (time.elapsedMs() >= nextMigration) {
    nextMigration += MIGRATION_EVERY_MS;
    const f = fixtures[migrations % fixtures.length]!;
    const clone = chain.clonePool(f, `soak-${migrations}`);
    const pool = clone.pool;
    clones.push({ p: clone, atMs: time.elapsedMs() });
    migrations++;
    // A clone older than CLONE_KEEP_MS is no longer readable (as a closed pool would be), so the fake chain stays bounded.
    while (clones.length > 0 && time.elapsedMs() - clones[0]!.atMs > CLONE_KEEP_MS) chain.dropPool(clones.shift()!.p);
    // As the backfill does (m03/backfill.ts publish): verify the pool on chain (P4 reads), then hand M05 the facts.
    const migratedAtMs = (time.nowMs() - 60_000) as UnixMs;
    const { backfill, universe, model } = rig.rec.parts;
    void backfill.verifyPool(pool, f.baseMint).then((v) => {
      if (!v.ok) return;
      universe.onDiscovery({ poolId: pool, baseMint: f.baseMint, quoteMint: MINTS.wsol, venue: 'pumpswap', verifiedOnChain: true, migratedAtMs },
        { venue: 'pumpswap', quoteMint: MINTS.wsol, feeTotalBps: model.feeTotalBps(v.value) ?? 10_000, effectiveQuoteLamports: model.effectiveQuote(v.value), observedAtMs: v.value.observedAtMs });
    });
  }
  await time.advance(1_000);
  // Transient peaks (the 00:00 UTC jobs read a whole day): the committed heap and RSS each simulated minute, no GC.
  if ((s + 1) % 60 === 0) {
    const m = process.memoryUsage();
    if (m.heapTotal > peakHeapTotal) peakHeapTotal = m.heapTotal;
    if (m.rss > peakRssAny) peakRssAny = m.rss;
  }
  if ((s + 1) % 3_600 === 0) {
    gc();
    const m = process.memoryUsage();
    const st = rig.rec.status();
    samples.push({
      hour: (s + 1) / 3_600, heapMiB: m.heapUsed / MIB, rssMiB: m.rss / MIB, rssAnonMiB: procRss('RssAnon'), rssFileMiB: procRss('RssFile'),
      externalMiB: m.external / MIB, arrayBuffersMiB: m.arrayBuffers / MIB, ringMiB: rig.rec.parts.tracker.ringBytes() / MIB, metricsRingMiB: rig.rec.parts.metrics.ringBytes() / MIB,
      trackedPools: rig.rec.parts.tracker.ready().length, encoderStates: rig.rec.parts.queue.stats().encoderStates, mdMiB: du(rig.paths.mdDir) / MIB,
      dbMiB: ['', '-wal', '-shm'].reduce((n, x) => { try { return n + statSync(rig.paths.db + x).size; } catch { return n; } }, 0) / MIB, watched: st.watched, queueDepth: st.queueDepth,
      wallS: Number(process.hrtime.bigint() - started) / 1e9,
    });
    process.stdout.write(`${JSON.stringify(samples.at(-1))}\n`);
  }
}
unknown = counted.get('m27.unknown_code') ?? 0;
await rig.rec.stop();

const half = samples.filter((x) => x.hour <= HOURS / 2), second = samples.filter((x) => x.hour > HOURS / 2);
const peak = (xs: typeof samples, k: 'heapMiB' | 'rssMiB'): number => Math.max(...xs.map((x) => x[k]));
const slope = (xs: typeof samples, k: 'heapMiB' | 'rssAnonMiB' = 'heapMiB'): number => {
  const n = xs.length, mx = xs.reduce((a, x) => a + x.hour, 0) / n, my = xs.reduce((a, x) => a + x[k], 0) / n;
  const num = xs.reduce((a, x) => a + (x.hour - mx) * (x[k] - my), 0), den = xs.reduce((a, x) => a + (x.hour - mx) ** 2, 0);
  return den === 0 ? 0 : num / den;
};
const result = {
  hours: HOURS, migrations, lines, logCodes: Object.fromEntries([...counted].sort((a, b) => b[1] - a[1]).slice(0, 25)),
  peakHeapFirstMiB: peak(half, 'heapMiB'), peakHeapSecondMiB: peak(second, 'heapMiB'), heapSlopeSecondMiBPerHour: slope(second),
  rssAnonSlopeSecondMiBPerHour: slope(second, 'rssAnonMiB'), maxWatched: Math.max(...samples.map((x) => x.watched)), migrationEveryMs: MIGRATION_EVERY_MS,
  failedSigsPerSec: chain.failedSigsPerSec, sigPagesBefore: chain.sigPagesBefore,
  peakRssMiB: Math.max(peak(samples, 'rssMiB'), peakRssAny / MIB), peakHeapCommittedMiB: peakHeapTotal / MIB, rssLimitMiB: LIMIT_RSS / MIB, recorderMiBEnd: samples.at(-1)?.mdMiB, dbMiBEnd: samples.at(-1)?.dbMiB,
  recorderMiBPerDay: ((samples.at(-1)?.mdMiB ?? 0) - (samples[23]?.mdMiB ?? 0)) / ((HOURS - 24) / 24 || 1),
  unknownCodes: unknown, internalErrors: internal, unhandledRejections: unhandled, wallSeconds: samples.at(-1)?.wallS,
};
const checks = {
  heapBounded: result.peakHeapSecondMiB <= result.peakHeapFirstMiB * 1.10 + 8,
  heapFlat: result.heapSlopeSecondMiBPerHour <= 0.5,
  rssFlat: result.rssAnonSlopeSecondMiBPerHour <= 0.25,
  rssUnderLimit: result.peakRssMiB * MIB <= LIMIT_RSS,
  clean: unknown === 0 && internal === 0 && unhandled === 0,
  // SWITCH-FIX: memory that stays flat proves nothing if nothing was recorded: the soak must watch pools.
  recording: result.maxWatched > 0,
};
const pass = Object.values(checks).every(Boolean);
writeFileSync(join(OUT, 'soak-result.json'), `${JSON.stringify({ pass, checks, result, samples }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ pass, checks, result })}\n`);
process.exit(pass ? 0 : 1);

export type { Pubkey };
