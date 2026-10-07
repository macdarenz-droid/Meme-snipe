// RED TEAM A, probe RT-A2 (FACTS-REREAD, worker.ts #rereadMigration): the re-read asks the curve's NEWEST
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
import { CUT_CREATE_RETRY_MS } from '../../src/run/worker.ts';
import { AT, CURVE, FIX, complete, migrate, missingMigration, run, type Rpc } from './reread-kit.ts';

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

describe('RT-A2: the re-read reads only the curve\'s newest page, so failed late attempts hide the completion for good', () => {
  it('with 6 failed attempts on the curve after the migration, the re-read still brings the completing buy and H7/H10 pass in the window', async () => {
    const { asked, rpc } = curveRpc();
    const r = await run(rpc, { reread: null });
    // Sanity: the fills' budget was spent, so the re-read (not COMPLETION-READ) was the reader.
    expect(r.h.logs).toContain(`Curve completion of ${FIX.meta.mint} not read: the fill budget is spent; H7 waits for it.`);
    console.log("RT-A2 asked:", JSON.stringify(asked), "tries:", JSON.stringify(r.rereads.map((x) => [x["try"], x["landed"]])));
    // Correct behaviour: the completing buy is fetched and the migration fact forms before the window ends.
    expect(asked).toContain(`tx ${complete.signature}`);
    expect(r.judged.some((j) => j.migration)).toBe(true);
    expect(missingMigration(r.last.r)).toBe(false);
    // (The buggy run: every try reads the same 6 failed signatures, CUT_CREATE_RETRY_MS.length + 1 tries in all.)
    void CUT_CREATE_RETRY_MS;
    void AT;
  }, 120_000);

  // Variant, fills' budget available: 5 failed attempts land on the completed curve between the completing buy and the
  // migration (the seconds in which other bots' buys hit BondingCurveComplete). COMPLETION-READ reads `before:
  // migration, limit 5`: 5 failed signatures, nothing read, and it is never made again. The refusal's re-read reads the
  // newest 6: the migration and the same 5 failed signatures, 5 times. The completion is the next signature down.
  it('with 5 failed attempts between the completing buy and the migration, the completion is still read (fills\' budget available)', async () => {
    const between = Array.from({ length: 5 }, (_, i) => ({ signature: `failedEarlyBuy${i}`, slot: migrate.slot - BigInt(i), err: { InstructionError: [2, { Custom: 6005 }] }, blockTime: migrate.blockTime! }));
    const hist = [{ signature: migrate.signature, slot: migrate.slot, err: null, blockTime: migrate.blockTime }, ...between, ...before];
    const { asked, rpc } = curveRpc(hist);
    const r = await run(rpc, { reread: null, fill: 10 * 6 });
    const { readFileSync } = await import('node:fs');
    const lines = readFileSync(r.h.stateDir + '/journal.jsonl', 'utf8').split('\n').filter((l) => l.includes('reject') || l.includes('shortlist')).slice(0, 6);
    console.log('RT-A2b journal:', lines.map((l) => l.slice(0, 600)).join('\n'));
    console.log('RT-A2b asked:', JSON.stringify(asked), 'tries:', JSON.stringify(r.rereads.map((x) => [x['try'], x['landed']])));
    expect(asked).toContain(`tx ${complete.signature}`);
    expect(r.judged.some((j) => j.migration)).toBe(true);
    expect(missingMigration(r.last.r)).toBe(false);
  }, 120_000);
});
