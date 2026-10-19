// REPLAY-1000: the replay harness (research/replay-1000) on its offline fixture: one quiet coin's migration and first
// twelve minutes, read from mainnet on 2026-10-06. No network: the fixture's cache answers everything.
// - Determinism: two full replays write the same journal, and TEST-1's parity check replays the recording 10 times
//   with identical decision lines.
// - No lookahead: a marker transaction planted in the coin's pool history at a slot inside the window must not reach
//   the bot (any recorded frame, any journal line) before that slot is produced; and it must reach it after (so its
//   absence before is meaningful). Every recorded frame is also checked against its receipt time (audit.ts).
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { auditRecording } from '../../../research/replay-1000/audit.ts';
import { loadIndex } from '../../../research/replay-1000/coins.ts';
import { PublicRpc, readZ, txFile, writeZ, type RawSig } from '../../../research/replay-1000/rpc.ts';
import { runReplay, type RunCoin } from '../../../research/replay-1000/run.ts';
import { ChainView, SlotClock } from '../../../research/replay-1000/world/chain.ts';
import { blockOrder } from '../../../research/replay-1000/world/ws-world.ts';
// The harness's command-line scripts, so typecheck covers them too (none runs here: each runs only as a main module).
import type * as _collect from '../../../research/replay-1000/collect.ts';
import type * as _prep from '../../../research/replay-1000/prep.ts';
import type * as _prefetch from '../../../research/replay-1000/prefetch-others.ts';
import type * as _fixture from '../../../research/replay-1000/fixture.ts';
import type * as _vEvents from '../../../research/replay-1000/validate-events.ts';
import type * as _vPools from '../../../research/replay-1000/validate-pools.ts';
import type * as _vSupply from '../../../research/replay-1000/validate-supply.ts';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/replay-1000');
const { coin, startMs, endMs } = JSON.parse(readFileSync(join(FIXTURE, 'fixture-coin.json'), 'utf8')) as { coin: RunCoin; startMs: number; endMs: number };
const temps: string[] = [];
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'replay-1000-'));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const run = async (dataDir: string, out: string, parityReplays = 0) =>
  runReplay({ out, coins: [coin], startMs, endMs, creates: [], mode: 'A', dataDir, offline: true, parityReplays, log: () => undefined });

/** Journal lines without nothing removed: their times are virtual, so two replays must agree byte for byte. */
const journal = (out: string): string[] => readFileSync(join(out, 'state', 'journal.jsonl'), 'utf8').split('\n').filter((l) => l !== '');

/** Every recorded frame line of a run. */
const frames = (out: string): string[] => {
  const root = join(out, 'state', 'recorder');
  const lines: string[] = [];
  for (const boot of readdirSync(root)) {
    const days = join(root, boot, 'days');
    for (const day of readdirSync(days)) {
      for (const f of readdirSync(join(days, day)).filter((x) => x.startsWith('frames-'))) {
        const p = join(days, day, f);
        const text = f.endsWith('.zst') ? zstdDecompressSync(readFileSync(p)).toString('utf8') : readFileSync(p, 'utf8');
        lines.push(...text.split('\n').filter((l) => l !== ''));
      }
    }
  }
  return lines;
};

describe('REPLAY-1000 harness (offline fixture)', () => {
  it('replays deterministically: two runs write the same journal, and TEST-1 parity holds over 10 replays', async () => {
    const a = temp();
    const b = temp();
    const ra = await run(FIXTURE, join(a, 'run'), 10);
    const rb = await run(FIXTURE, join(b, 'run'));
    const ja = journal(join(a, 'run'));
    expect(ja.length).toBeGreaterThan(5);
    expect(ja.some((l) => l.includes('"shortlist"') && l.includes(coin.mint))).toBe(true);
    expect(journal(join(b, 'run'))).toEqual(ja);
    expect(Object.keys(ra.refusals)).toEqual([]);
    expect(Object.keys(rb.refusals)).toEqual([]);
    const parity = ra.parity as { ok: boolean; boots: { deterministic: boolean; divergence: unknown }[] };
    expect(parity.ok).toBe(true);
    expect(parity.boots.every((x) => x.deterministic && x.divergence === null)).toBe(true);
  }, 300_000);

  it('never hands the bot a planted future transaction before its slot is produced', async () => {
    const dir = temp();
    cpSync(FIXTURE, dir, { recursive: true });
    const index = loadIndex(dir);
    const clock = new SlotClock(index);
    // The marker: a copy of a real pool trade of the window, moved to slot F, under a signature nothing else has.
    const chain = new ChainView(new PublicRpc([], dir), index);
    const F = clock.slotAt(startMs + 7 * 60_000);
    const pages = readdirSync(join(dir, 'sigs')).filter((x) => x.startsWith(`${coin.pool}.`)).flatMap((f) => readZ(join(dir, 'sigs', f)) as RawSig[]);
    const tape = blockOrder(pages.filter((x) => x.err === null && x.slot > coin.migrationSlot + 10 && x.slot < F && existsSync(txFile(dir, x.signature))));
    const donor = tape[0]!;
    const MARK = `MarkerFuture${'1'.repeat(76)}`;
    const tx = readZ(txFile(dir, donor.signature)) as { slot: number; blockTime: number };
    writeZ(txFile(dir, MARK), { ...tx, slot: F, blockTime: Math.floor(clock.timeOf(F) / 1000) });
    // Into every cached page of the pool's history that reaches slot F, in its place (newest first).
    let planted = 0;
    for (const f of readdirSync(join(dir, 'sigs')).filter((x) => x.startsWith(`${coin.pool}.`))) {
      const p = join(dir, 'sigs', f);
      const page = readZ(p) as RawSig[];
      const anchor = index.find((x) => x.signature.startsWith(f.split('.')[1]!));
      if (anchor === undefined || anchor.slot <= F) continue;
      if (page.length >= 1000 && page.at(-1)!.slot > F) continue;
      const at = page.findIndex((x) => x.slot < F);
      page.splice(at < 0 ? page.length : at, 0, { signature: MARK, slot: F, err: null, blockTime: Math.floor(clock.timeOf(F) / 1000) });
      writeZ(p, page);
      planted++;
    }
    expect(planted).toBeGreaterThan(0);
    // As of any slot before F the transaction does not exist yet; as of F it does.
    expect(await chain.transaction(MARK, F - 1)).toBe(null);
    expect(await chain.transaction(MARK, F)).not.toBe(null);
    // The bot: no frame or journal line names the marker before slot F was produced; some frame does after it.
    const out = join(dir, 'run');
    await run(dir, out);
    const produced = clock.timeOf(F);
    const seen = frames(out).filter((l) => l.includes(MARK)).map((l) => (JSON.parse(l) as { receivedAt: number }).receivedAt);
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(produced);
    const early = journal(out).filter((l) => l.includes(MARK) && Date.parse((JSON.parse(l) as { ts: string }).ts) < produced);
    expect(early).toEqual([]);
  }, 300_000);

  it('audits a replay: no recorded frame names a slot produced after its receipt', async () => {
    const out = join(temp(), 'run');
    await run(FIXTURE, out);
    const r = auditRecording(join(out, 'state'), new SlotClock(loadIndex(FIXTURE)));
    expect(r.checked).toBeGreaterThan(1000);
    expect(r.future).toEqual([]);
    expect(existsSync(join(out, 'world.json'))).toBe(true);
  }, 300_000);
});
