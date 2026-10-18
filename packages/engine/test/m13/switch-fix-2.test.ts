// Card SWITCH-FIX-2 SW-25 (RT2-a): Phase 0 weights D's states with D's poll counts, and the counts of D's last bars
// are in D+1's first hour (stamped with their close plus a grace; SW-12). A SYNTHETIC two-day dataset in the M07 layout.
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, it } from 'vitest';
import { quoteExactIn } from '@bot/venue';
import { MINTS } from '@bot/venue/constants';
import { buildUniverseManifest } from '../../src/m05/manifest.ts';
import { readPhase0Dataset, recordedPricing } from '../../src/m13/phase0-input.ts';
import { tempDir } from '../helpers.ts';
import { flatFees } from '../m10/pricing.ts';

const D = '2026-10-22';
const NEXT = '2026-10-23';
const T0 = Date.parse(`${D}T00:00:00Z`);
const T1 = T0 + 86_400_000;
const SOL = 1_000_000_000n;
const pricing = recordedPricing({ quote: (p, side, a, fees) => quoteExactIn(p as never, side, a, fees as never), feesForTotal: (t) => flatFees(t), wsolMint: MINTS.wsol });
const fields = (realSol: bigint) => ({
  baseReserve: '200000000000000', quoteReserveReal: (realSol * SOL).toString(), quoteReserveVirtual: '0', baseMintSupply: '1000000000000000',
  asOfSlot: '1', isCanonical: true, coinCreatorSet: true, creatorFeeBps: 0, isMayhemMode: false, baseDecimals: 6, swappedMints: false,
  effectiveQuoteLamports: (realSol * SOL).toString(), spotSolPerToken: '1', feeTotalBps: 30,
});
let seq = 0n;
function segment(dir: string, day: string, hour: string, stream: string, recs: Array<{ recvMs: number; payload: unknown }>): object {
  const lines = recs.map((r) => JSON.stringify({ commitment: 'confirmed', payload: r.payload, recvMs: r.recvMs, seq: String(seq++), slot: null, source: 't', stream }));
  const gz = gzipSync(Buffer.from(`${lines.join('\n')}\n`));
  const path = `${day}/${hour}/${stream}.ndjson.gz`;
  mkdirSync(join(dir, day, hour), { recursive: true });
  writeFileSync(join(dir, path), gz);
  return { path, stream, firstSlot: null, lastSlot: null, records: recs.length, bytes: gz.length, sha256: createHash('sha256').update(gz).digest('hex'), gaps: [], codec: 'gzip',
    firstSeq: null, lastSeq: null, hourUtc: `${day}T${hour}`, keyframes: 0, firstRecvMs: recs[0]?.recvMs ?? null, lastRecvMs: recs.at(-1)?.recvMs ?? null };
}
const bar = (barStartMs: number, successfulPolls: number) => ({ recvMs: barStartMs + 16_500, payload: { poolId: 'pool-1', barStartMs, durationMs: 15_000, minuteStartMs: barStartMs - (barStartMs % 60_000), successfulPolls, changedPolls: 0, failedPolls: 0, priorityClass: 'candidate' } });

describe('SW-25: D\'s poll counts include those in D+1\'s first hour whose bar starts inside D', () => {
  it('a state held through D\'s last bar is weighted by its counts in D+1/00; D+1\'s own bars and later hours are not D\'s', () => {
    const dir = tempDir('sw25');
    const manifest = buildUniverseManifest({
      dayUtc: D, generatedAtMs: T1, late: false, prefilterOnly: true,
      crossCheck: { poolsOnlyInVendor: 0, otherDexPairs: 0, knownPoolsUnderOtherDex: 0, status: 'ok' }, migrationCoverage: { chainMigrations: 1, seenByPumpPortal: 0, gapBps: 10_000 }, limitSet: { id: 'pm01', paramHash: 'h' },
      events: [{ poolId: 'pool-1', mint: 'mint-1', from: 'discovered', to: 'eligible', reason: 'r', atMs: T0 - 1 }],
    });
    const last = T1 - 15_000;                                             // 23:59:45, D's last bar
    const dIndex = [
      segment(dir, D, '23', 'pool_snapshot', [{ recvMs: last, payload: { kind: 'keyframe', poolId: 'pool-1', rawHash: 'h0', priorityClass: 'candidate', fields: fields(300n) } }]),
    ];
    const nIndex = [
      // D+1/00: D's last bar (15 polls, stamped 00:00:01.5 of D+1) and D+1's first bar (15 polls, D+1's).
      segment(dir, NEXT, '00', 'poll_counts', [bar(last, 15), bar(T1, 15)]),
      // D+1/01: a bar of D moved there would be outside the grace hour, as dailyCoverage reads it.
      segment(dir, NEXT, '01', 'poll_counts', [{ ...bar(last - 15_000, 15), recvMs: T1 + 3_600_500 }]),
      segment(dir, NEXT, '00', 'universe_manifest', [{ recvMs: T1, payload: manifest }]),
    ];
    writeFileSync(join(dir, D, 'index.json'), JSON.stringify(dIndex));
    writeFileSync(join(dir, NEXT, 'index.json'), JSON.stringify(nIndex));
    const i = readPhase0Dataset({ dataDir: dir, days: [D], pricing });
    assert.ok(i.days[0]?.manifest !== null);
    assert.deepEqual(i.poolStates.filter((s) => s.dayUtc === D).map((s) => [s.poolId, s.minDepthLamports, s.weight]), [['pool-1', 300n * SOL, 15]]);
    // The bytes of D+1's segments stay D+1's.
    assert.equal(i.streams.some((s) => s.dayUtc === D && s.stream === 'poll_counts'), false);
  });
});
