// A-M13-01 `phase0-report` input and CLI (card Z09): a small SYNTHETIC dataset written in the M07 layout (day index,
// gzip segments of canonical record lines), read back into the report; the recorded pricing bound to the venue maths.
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, it } from 'vitest';
import { quoteExactIn } from '@bot/venue';
import { MINTS } from '@bot/venue/constants';
import { buildUniverseManifest } from '../../src/m05/manifest.ts';
import { PRIOR_2026_10 } from '../../src/m10/params.ts';
import { parsePhase0Args, runPhase0Report } from '../../src/m13/phase0-cli.ts';
import { readPhase0Dataset, recordedPricing } from '../../src/m13/phase0-input.ts';
import { tempDir } from '../helpers.ts';
import { flatFees } from '../m10/pricing.ts';

const R0 = Date.UTC(2026, 9, 20, 7, 0, 0);
const D1 = '2026-10-22';
const dayMs = (d: string): number => Date.parse(`${d}T00:00:00Z`);
const SOL = 1_000_000_000n;
const pricing = recordedPricing({ quote: (p, side, a, fees) => quoteExactIn(p as never, side, a, fees as never), feesForTotal: (t) => flatFees(t), wsolMint: MINTS.wsol });

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
const fields = (realSol: bigint, virtSol: bigint, fee = 30) => ({
  baseReserve: '200000000000000', quoteReserveReal: (realSol * SOL).toString(), quoteReserveVirtual: (virtSol * SOL).toString(), baseMintSupply: '1000000000000000',
  asOfSlot: '1', isCanonical: true, coinCreatorSet: true, creatorFeeBps: 0, isMayhemMode: false, baseDecimals: 6, swappedMints: false,
  effectiveQuoteLamports: ((realSol + virtSol) * SOL).toString(), spotSolPerToken: '1', feeTotalBps: fee,
});

function dataset(): { dir: string; days: string[] } {
  const dir = tempDir('phase0');
  const days: string[] = [];
  for (let k = -2; k < 10; k++) {
    const day = new Date(dayMs(D1) + k * 86_400_000).toISOString().slice(0, 10);
    days.push(day);
    const t0 = dayMs(day);
    const manifest = buildUniverseManifest({
      dayUtc: day, generatedAtMs: t0 + 86_400_000, late: false, prefilterOnly: true,
      crossCheck: { poolsOnlyInVendor: 0, otherDexPairs: 0, knownPoolsUnderOtherDex: 0, status: 'ok' }, migrationCoverage: { chainMigrations: 1, seenByPumpPortal: 0, gapBps: 10_000 }, limitSet: { id: 'pm01', paramHash: 'h' },
      events: [{ poolId: 'pool-1', mint: 'mint-1', from: 'discovered', to: 'eligible', reason: 'r', atMs: t0 - 1 }],
    });
    const index = [
      segment(dir, day, '00', 'pool_snapshot', [
        { recvMs: (k === -2 ? R0 : t0) + 0, payload: { kind: 'keyframe', poolId: 'pool-1', rawHash: 'h0', priorityClass: 'candidate', fields: fields(300n, 0n) } },
        { recvMs: t0 + 10_000, payload: { kind: 'delta', poolId: 'pool-1', rawHash: 'h1', set: { quoteReserveReal: (2_000n * SOL).toString(), effectiveQuoteLamports: (2_000n * SOL).toString() }, unset: [] } },
        { recvMs: t0 + 11_000, payload: { kind: 'delta', poolId: 'pool-2', rawHash: 'x', set: {}, unset: [] } },                // no keyframe: skipped
        { recvMs: t0 + 12_000, payload: { kind: 'keyframe', poolId: 'pool-9', rawHash: 'y', priorityClass: 'candidate', fields: fields(1n, 0n) } },   // not eligible
        { recvMs: t0 + 13_000, payload: { kind: 'keyframe', poolId: 'pool-1', rawHash: 'z', priorityClass: 'candidate', fields: { ...fields(5_000n, 0n), feeTotalBps: 10_000 } } }, // fee unknown
      ]),
      segment(dir, day, '00', 'universe_manifest', [{ recvMs: t0 + 86_400_000, payload: k === 3 ? { ...manifest, sha256: '0'.repeat(64) } : manifest }]),
      segment(dir, day, '00', 'coverage', [{ recvMs: t0 + 86_400_000, payload: { dayUtc: day, streams: [], universeManifestSha256: manifest.sha256, lowCoverage: k === 5 } }]),
      segment(dir, day, '00', 'ref_price', [{ recvMs: t0, payload: { kind: 'unavailable', pair: 'SOL/USD', pool: 'p', reason: 'x' } }, { recvMs: t0 + 1, payload: { kind: 'price', pair: 'SOL/USD', pool: 'p', usdE6PerSol: '150000000', sqrtPriceX64: '1', solVaultLamports: '1', usdcVaultE6: '1' } }]),
      { ...(segment(dir, day, '01', 'discovery', [{ recvMs: t0, payload: {} }]) as object), codec: 'zstd', path: `${day}/01/discovery.ndjson.zst` },
    ];
    writeFileSync(join(dir, day, 'index.json'), JSON.stringify(index));
  }
  return { dir, days };
}

describe('A-M13-01 phase0-report input (SYNTHETIC dataset)', () => {
  it('reads manifests (sha checked), coverage, stream bytes, D1 SOL/USD and weighted eligible pool states from a pulled dataset', () => {
    const { dir, days } = dataset();
    const i = readPhase0Dataset({ dataDir: dir, days, pricing });
    assert.equal(i.r0Ms, R0);
    assert.equal(i.solUsdD1, 150);
    const byDay = new Map(i.days.map((d) => [d.dayUtc, d]));
    assert.equal(byDay.get('2026-10-25')?.manifest, null);                          // its sha did not match: not used
    assert.equal(byDay.get('2026-10-27')?.lowCoverage, true);
    assert.equal(byDay.get(D1)?.lowCoverage, false);
    const d1States = i.poolStates.filter((s) => s.dayUtc === D1);
    assert.deepEqual(d1States.map((s) => [s.poolId, s.minDepthLamports, s.weight]), [['pool-1', 300n * SOL, 10], ['pool-1', 2_000n * SOL, 3]]);
    const zst = i.streams.find((s) => s.dayUtc === D1 && s.stream === 'discovery');
    assert.deepEqual([zst?.codec, zst?.decodedBytes], ['zstd', null]);
    const snap = i.streams.find((s) => s.dayUtc === D1 && s.stream === 'pool_snapshot');
    assert.ok(snap !== undefined && snap.decodedBytes !== null && snap.decodedBytes > snap.compressedBytes);
  });

  it('the CLI writes the report and CSVs, byte-for-byte the same on a second run; --sol-usd is noted', () => {
    const { dir, days } = dataset();
    const files = new Map<string, string>();
    const run = (argv: string[]): void => {
      const a = parsePhase0Args(argv);
      assert.ok(typeof a !== 'string');
      runPhase0Report(a, { pricing, simParams: PRIOR_2026_10, write: (p, t) => { files.set(p, t); } });
    };
    run(['--data', dir, '--days', days.join(','), '--out', 'out']);
    const first = new Map(files);
    run(['--data', dir, '--days', days.join(','), '--out', 'out']);
    assert.deepEqual(files, first);
    assert.deepEqual([...files.keys()].sort(), ['out/a48-2026-10-22.csv', 'out/hurdle-2026-10-22.csv', 'out/report-2026-10-22.md']);
    const md = files.get('out/report-2026-10-22.md') as string;
    assert.ok(md.includes('D1: 2026-10-22; status: ok'));
    run(['--data', dir, '--days', days.join(','), '--out', 'out', '--sol-usd', '200']);
    assert.ok((files.get('out/report-2026-10-22.md') as string).includes('SOL/USD given on the command line (200)'));
    for (const bad of [[], ['--data', 'd', '--days', '22/10', '--out', 'o'], ['--data', 'd', '--days', D1, '--out', 'o', '--sol-usd', '-1']]) assert.equal(typeof parsePhase0Args(bad), 'string');
    assert.equal(readFileSync(join(dir, D1, 'index.json'), 'utf8').length > 0, true);
  });

  it('recorded pricing refuses malformed fields and an unknown fee, and prices on min(real, effective) depth', () => {
    const at = { poolId: 'p', mint: 'm' };
    assert.equal(pricing({ ...fields(300n, 0n), baseReserve: 'x' }, at), null);
    assert.equal(pricing({ ...fields(300n, 0n), feeTotalBps: 10_000 }, at), null);
    assert.equal(pricing({ ...fields(0n, 0n) }, at), null);
    assert.equal(pricing({ ...fields(300n, 0n), feeTotalBps: 1.5 }, at), null);
    const p = pricing({ ...fields(300n, 1_200n), isCanonical: null, coinCreatorSet: 'x', baseDecimals: 'x' }, at);
    assert.ok(p !== null);
    assert.deepEqual([p.effectiveQuoteLamports, p.realQuoteLamports], [300n * SOL, 300n * SOL]);
    assert.equal(p.quote('buy', SOL).ok, false);                                     // decimals unknown: the venue refuses
    const q = pricing(fields(300n, 1_200n), at);
    assert.ok(q !== null && q.quote('buy', SOL).ok);
  });
});

describe('phase0-report operator script, end to end (SYNTHETIC dataset; ruling Z09-10)', () => {
  it('writes the same bytes on two runs, and the same bytes as the in-process runner bound the same way', () => {
    const { dir, days } = dataset();
    const script = new URL('../../scripts/phase0-report.ts', import.meta.url).pathname;
    const outs = [tempDir('phase0-out'), tempDir('phase0-out')];
    for (const out of outs) {
      const stdout = execFileSync(process.execPath, ['--no-warnings', script, '--data', dir, '--days', days.join(','), '--out', out], { encoding: 'utf8' });
      assert.match(stdout, /phase0-report: wrote .*report-2026-10-22\.md/);
    }
    const read = (d: string): Map<string, string> => new Map(readdirSync(d).sort().map((f) => [f, readFileSync(join(d, f), 'utf8')]));
    const [a, b] = outs.map(read) as [Map<string, string>, Map<string, string>];
    assert.deepEqual([...a.keys()], ['a48-2026-10-22.csv', 'hurdle-2026-10-22.csv', 'report-2026-10-22.md']);
    assert.deepEqual(a, b);
    // The script's flat fee schedule is the recorded per-side total in one component (lp); bind the runner the same way.
    const flat = (total: number) => {
      const fees = { lpBps: total, protocolBps: 0, creatorBps: 0 };
      return { curve: null, pumpswap: { account: 'recorded', asOfSlot: 0n, configHash: 'recorded-fee-total', tiers: [{ thresholdLamports: 0n, fees }], flat: fees, exoticFlat: fees }, creatorFeeConfigurable: false };
    };
    const same = recordedPricing({ quote: (p, side, amt, fees) => quoteExactIn(p as never, side, amt, fees as never), feesForTotal: flat, wsolMint: MINTS.wsol });
    const files = new Map<string, string>();
    const args = parsePhase0Args(['--data', dir, '--days', days.join(','), '--out', 'o']);
    assert.ok(typeof args !== 'string');
    runPhase0Report(args, { pricing: same, simParams: PRIOR_2026_10, write: (p, t) => { files.set(p.slice(2), t); } });
    assert.deepEqual(new Map([...files].sort()), a);
    assert.ok((a.get('hurdle-2026-10-22.csv') as string).split('\n').length > 2);
    // Bad arguments exit 2.
    assert.throws(() => execFileSync(process.execPath, ['--no-warnings', script, '--days', 'x'], { stdio: 'pipe' }), (e: unknown) => (e as { status: number }).status === 2);
  });
});
