// RED TEAM A, probe RT-A7 (FACTS-REREAD, worker.ts #rereadMigration): the re-read asks the curve's NEWEST
// REREAD_CURVE_READS (6) signatures, with no `before` and no paging, and skips the failed ones (err !== null) without
// reading further. Failed transactions count in getSignaturesForAddress's `limit`.
//
// Scenario (realistic on mainnet): once a pump.fun curve completes, late buy/sell attempts on the curve keep landing
// and failing (BondingCurveComplete) for a while after the migration; every one of them names the curve account, so
// it is in the curve's signature list. With 6 or more failed attempts after the migration, the curve's newest page
// holds only failed signatures: the migration and the completing buy are on the next page (one `before:` call away).
// The fills' budget is spent after a boot seed (the very case FACTS-REREAD exists for, DECISIONS "FACTS-REREAD" c),
// so COMPLETION-READ (which does read `before: migration`) is skipped and hands over to the re-read.
//
// Every one of the 5 tries reads the same page of failed signatures; the chain is spent; later refusals find it spent
// and start nothing: the coin is refused H16 missing curve/migration for its whole window although one more page
// (2-3 credits) would bring both transactions. A good coin blocked for good: golden rule, a missed trade is a loss.
import { describe, expect, it } from 'vitest';
import { CURVE_PAGE_LIMIT, CUT_CREATE_RETRY_MS, FETCH_TX_CREDITS, REREAD_CURVE_READS } from '../../src/run/worker.ts';
import { CURVE, FIX, complete, migrate, missingMigration, run, type Rpc } from './reread-kit.ts';

const failedAfterMigration = Array.from({ length: 6 }, (_, i) => ({ signature: `failedLateBuy${i}`, slot: migrate.slot + BigInt(6 - i), err: { InstructionError: [2, { Custom: 6005 }] }, blockTime: migrate.blockTime! + 3 }));
const before = FIX.curveSignaturesBeforeMigration.map((x) => ({ ...x, slot: BigInt(x.slot) }));
/** The curve's whole history, newest first, as getSignaturesForAddress pages it (limit and before honoured). */
const history = [...failedAfterMigration, { signature: migrate.signature, slot: migrate.slot, err: null, blockTime: migrate.blockTime }, ...before];

const curveRpc = (hist = history) => {
  const asked: string[] = [];
  const rpc: Rpc = {
    getSignaturesForAddress: async (address, o) => {
      asked.push(`sigs ${address}${o.before === undefined ? '' : ` before ${o.before}`}`);
      if (address !== CURVE) return [];
      const from = o.before === undefined ? 0 : hist.findIndex((x) => x.signature === o.before) + 1;
      return hist.slice(from, from + (o.limit ?? 1000));
    },
    getTransaction: async (sig) => {
      asked.push(`tx ${sig}`);
      return sig === complete.signature ? complete : sig === migrate.signature ? migrate : null;
    },
  };
  return { asked, rpc };
};

describe('RT-A7: the re-read reads only the curve\'s newest page, so failed late attempts hide the completion for good', () => {
  it('with 6 failed attempts on the curve after the migration, the re-read still brings the completing buy and H7/H10 pass in the window', async () => {
    const { asked, rpc } = curveRpc();
    const r = await run(rpc, { reread: null });
    // Sanity: the fills' budget was spent, so the re-read (not COMPLETION-READ) was the reader.
    expect(r.h.logs).toContain(`Curve completion of ${FIX.meta.mint} not read: the fill budget is spent; H7 waits for it.`);
    console.log("RT-A7 asked:", JSON.stringify(asked), "tries:", JSON.stringify(r.rereads.map((x) => [x["try"], x["landed"]])));
    // Correct behaviour: the completing buy is fetched and the migration fact forms before the window ends.
    expect(asked).toContain(`tx ${complete.signature}`);
    expect(r.judged.some((j) => j.migration)).toBe(true);
    expect(missingMigration(r.last.r)).toBe(false);
    // (The buggy run: every try reads the same 6 failed signatures, CUT_CREATE_RETRY_MS.length + 1 tries in all.)
  }, 120_000);

  // Variant (b), fills' budget available: 5 failed attempts land on the completed curve between the completing buy and the
  // migration (the seconds in which other bots' buys hit BondingCurveComplete). COMPLETION-READ reads `before:
  // migration, limit 5`: 5 failed signatures, nothing read, and it is never made again. The refusal's re-read reads the
  // newest 6: the migration and the same 5 failed signatures, 5 times. The completion is the next signature down.
  it('with 5 failed attempts between the completing buy and the migration, the completion is still read (fills\' budget available)', async () => {
    const between = Array.from({ length: 5 }, (_, i) => ({ signature: `failedEarlyBuy${i}`, slot: migrate.slot - BigInt(i), err: { InstructionError: [2, { Custom: 6005 }] }, blockTime: migrate.blockTime! }));
    const hist = [{ signature: migrate.signature, slot: migrate.slot, err: null, blockTime: migrate.blockTime }, ...between, ...before];
    const { asked, rpc } = curveRpc(hist);
    // The test world's regime is off, so its refusals carry no typed H16 reasons; the production refusal trigger
    // (rereadFacts(mint, ['curve' | 'migration'], 'refused')) is stood in for by the equivalent fetch_failed trigger.
    const r = await run(rpc, {
      reread: null, fill: 10 * 6, window: false, runMs: 60_000,
      after: async (h, m, tick) => {
        h.worker.feed.ingest('worker', { type: 'offchain', key: 'feed:status:helius', value: { state: 'fetch_failed', signature: migrate.signature } }, { receivedAt: m.now });
        await m.run(45 * 60_000, 5_000, tick);
      },
    });
    console.log('RT-A7b asked:', JSON.stringify(asked), 'tries:', JSON.stringify(r.rereads.map((x) => [x['try'], x['landed']])));
    expect(asked).toContain(`tx ${complete.signature}`);
    expect(r.judged.some((j) => j.migration)).toBe(true);
    expect(missingMigration(r.last.r)).toBe(false);
  }, 120_000);

  // A-FACTS-FIXES: more failed signatures than one page holds: the reads page back with `before`, within the reserve.
  const failed = (n: number, tag: string, slot: (i: number) => bigint) => Array.from({ length: n }, (_, i) => ({ signature: `${tag}${i}`, slot: slot(i), err: { InstructionError: [2, { Custom: 6005 }] }, blockTime: migrate.blockTime! + 3 }));
  const sigPages = (asked: string[]) => asked.filter((a) => a.startsWith(`sigs ${CURVE}`));

  it('more pages of failed attempts after the migration than a try can page (7 pages): the re-read reads from the migration and brings the completion', async () => {
    const late = failed(7 * CURVE_PAGE_LIMIT, 'failedLateBuy', (i) => migrate.slot + BigInt(10_000 - i));
    const { asked, rpc } = curveRpc([...late, { signature: migrate.signature, slot: migrate.slot, err: null, blockTime: migrate.blockTime }, ...before]);
    const r = await run(rpc, { reread: null });
    // The migration's signature is known (its fetch through the fetcher failed): read by it, then the curve before it.
    expect(sigPages(asked)).toEqual([`sigs ${CURVE} before ${migrate.signature}`]);
    expect(asked.slice(0, 3)).toEqual([`tx ${migrate.signature}`, `sigs ${CURVE} before ${migrate.signature}`, `tx ${complete.signature}`]);
    expect(r.judged.some((j) => j.migration)).toBe(true);
    expect(missingMigration(r.last.r)).toBe(false);
  }, 120_000);

  it('a full page of failed attempts between the completion and the migration: COMPLETION-READ pages back within its reserve', async () => {
    const between = failed(CURVE_PAGE_LIMIT + 20, 'failedEarlyBuy', (i) => migrate.slot - BigInt(i % 3));
    const { asked, rpc } = curveRpc([{ signature: migrate.signature, slot: migrate.slot, err: null, blockTime: migrate.blockTime }, ...between, ...before]);
    const r = await run(rpc, { reread: null, fill: 10 * 6, window: false, runMs: 60_000 });
    expect(sigPages(asked)).toEqual([`sigs ${CURVE} before ${migrate.signature}`, `sigs ${CURVE} before ${between[CURVE_PAGE_LIMIT - 1]!.signature}`]);
    expect(asked).toContain(`tx ${complete.signature}`);
    // Two pages and one transaction of the 6 reserved.
    expect(r.fillLeft()).toBe(10 * 6 - 3);
    expect(r.judged.some((j) => j.migration)).toBe(true);
  }, 120_000);

  it('20 pages of failed attempts between the completion and the migration: every try stays inside its reserve and the refusal stands (fail closed)', async () => {
    const between = failed(20 * CURVE_PAGE_LIMIT, 'failedEarlyBuy', (i) => migrate.slot - BigInt(i % 3));
    const { asked, rpc } = curveRpc([{ signature: migrate.signature, slot: migrate.slot, err: null, blockTime: migrate.blockTime }, ...between, ...before]);
    const r = await run(rpc, { reread: null });
    expect(asked).not.toContain(`tx ${complete.signature}`);
    const tries = CUT_CREATE_RETRY_MS.length + 1;
    expect(r.rereads).toHaveLength(tries);
    // Each try reserves at most the migration's fetch (FETCH_TX_CREDITS, RC-FIXES), a page and REREAD_CURVE_READS reads;
    // its further pages come out of what is left, and a page is asked only while a read can follow it.
    const reserve = FETCH_TX_CREDITS + 1 + REREAD_CURVE_READS;
    expect(sigPages(asked).length).toBeLessThanOrEqual(tries * (reserve - 1));
    expect(sigPages(asked).length).toBeGreaterThan(tries);
    expect(r.caps.reread).toBeLessThanOrEqual(tries * reserve);
    expect(missingMigration(r.last.r)).toBe(true);
  }, 120_000);

  it('successful transactions that are not the completion use up the reads: COMPLETION-READ stops at its reserve', async () => {
    const other = Array.from({ length: 10 }, (_, i) => ({ signature: `otherOk${i}`, slot: migrate.slot - BigInt(i), err: null, blockTime: migrate.blockTime! }));
    const { asked, rpc } = curveRpc([{ signature: migrate.signature, slot: migrate.slot, err: null, blockTime: migrate.blockTime }, ...other, ...before]);
    const r = await run(rpc, { reread: null, fill: 10 * 6, window: false, runMs: 60_000 });
    // One page and five reads: the reserve of 6, never a sixth read.
    expect(asked.filter((a) => a.startsWith('tx otherOk'))).toEqual(other.slice(0, 5).map((o) => `tx ${o.signature}`));
    expect(sigPages(asked)).toEqual([`sigs ${CURVE} before ${migrate.signature}`]);
    expect(r.fillLeft()).toBe(10 * 6 - 6);
  }, 120_000);
});
