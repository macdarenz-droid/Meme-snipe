// REPLAY-1000 prefetcher: fills the disk cache (data/, git-ignored) with the chain data a coin's replay is likely to
// ask for, oldest migration first, while publicnode still holds it (its ledger keeps about 20 hours; older reads fall to
// the slow Foundation endpoint). It decides nothing and the replay never reads it directly: the replay's as-of world
// asks the same cache through the same calls, and anything not prefetched is fetched on demand.
//
//   node research/replay-1000/collect.ts <day> [concurrency] [onlySample]
//
// Per coin: every signature of its pool from migration to +4 h (the end of U2's 240-minute window) and of its mint from
// the create to the same end, and every successful transaction among them (the pool tape the bot's live watch receives
// from the migration, S0-ZERO, and the mint history H13 and the holder rebuild read). The tail from +4 h to +6 h (the
// longest hold) is fetched later, on demand, for coins with an open position.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Coin, inSample, loadIndex } from './coins.ts';
import { ChainView } from './world/chain.ts';
import { DATA_DIR, PublicRpc, type RawSig, atomicWrite, pool } from './rpc.ts';

export const WINDOW_END_S = 4 * 3600;

/** Every signature of `address` newer than `afterTime` and at or before `untilTime` (seconds), newest first. */
export const sigsBetween = async (rpc: PublicRpc, address: string, afterTime: number, untilTime: number, anchor?: string): Promise<RawSig[]> => {
  const out: RawSig[] = [];
  let cursor = anchor;
  for (;;) {
    let page: RawSig[];
    try {
      page = await rpc.sigPage(address, cursor);
    } catch (e) {
      // Older than the first endpoint's ledger: the replay's world fetches the rest on demand.
      if (rpc.urls.length === 1) { (out as RawSig[] & { truncated?: boolean }).truncated = true; break; }
      throw e;
    }
    if (page.length === 0) break;
    for (const x of page) if (x.blockTime !== null && x.blockTime <= untilTime && x.blockTime > afterTime) out.push(x);
    cursor = page.at(-1)!.signature;
    if ((page.at(-1)!.blockTime ?? 0) <= afterTime || page.length < 1000) break;
  }
  return out;
};

export interface CoinTapes {
  readonly mint: string;
  readonly endTime: number;
  readonly poolSigs: number;
  readonly poolOk: number;
  readonly poolOkFirstHour: number;
  readonly mintSigs: number;
  /** The fast endpoint's ledger ended inside the range: the rest is read on demand. */
  readonly truncated: boolean;
  readonly fetched: number;
  readonly createSig: string | null;
}

const main = async () => {
  const day = process.argv[2]!;
  const n = Number(process.argv[3] ?? '16');
  const onlySample = process.argv[4] === 'sample';
  // Prefetch on the fast endpoint only; what it no longer holds is left to the replay's on-demand reads.
  const rpc = new PublicRpc([new PublicRpc().urls[0]!]);
  const file = JSON.parse(readFileSync(join(DATA_DIR, `coins-${day}.json`), 'utf8')) as { coins: Coin[] };
  // The seeded sample first, then the rest; oldest migration first within each (older data leaves the ledger first).
  const coins = file.coins.filter((c) => !onlySample || inSample(c)).sort((a, b) => Number(inSample(b)) - Number(inSample(a)) || a.migrationTime - b.migrationTime);
  const doneFile = join(DATA_DIR, `tapes-${day}.json`);
  const done: Record<string, CoinTapes> = existsSync(doneFile) ? JSON.parse(readFileSync(doneFile, 'utf8')) : {};
  // Anchors: a newer signature to page back from (finalized pages anchored by a signature are cached).
  const nowAnchor = (await rpc.sigPage('TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM', undefined, 1))[0]!.signature;
  const chain = new ChainView(rpc, loadIndex());
  let k = 0;
  await pool(coins, Number(process.env['COINS_IN_FLIGHT'] ?? '6'), async (c) => {
    k++;
    const end = c.migrationTime + WINDOW_END_S;
    if (done[c.mint] !== undefined) return;
    if (end > Date.now() / 1000 - 60) return; // its window is not over yet: collected on a later pass
    const t0 = Date.now();
    // Paged back from the index's anchor after the window end (stable anchors: the replay reuses these pages).
    const endSlot = chain.clock.slotAt(end * 1000);
    const between = async (address: string, fromSlot: number): Promise<RawSig[]> => {
      try {
        return [...(await chain.signaturesBetween(address, fromSlot, endSlot))].reverse();
      } catch (e) {
        if (String(e).includes('no anchor')) return sigsBetween(rpc, address, fromSlot === 0 ? 0 : c.migrationTime - 1, end, nowAnchor);
        const out: RawSig[] & { truncated?: boolean } = [];
        out.truncated = true;
        return out;
      }
    };
    const poolSigs = await between(c.pool, c.migrationSlot - 1);
    const mintSigs = await between(c.mint, 0);
    const ok = (xs: RawSig[]) => xs.filter((x) => x.err === null);
    const poolOk = ok(poolSigs);
    const firstHour = poolOk.filter((x) => x.blockTime! <= c.migrationTime + 65 * 60).length;
    const mintOk = ok(mintSigs).reverse();
    const createSig = mintOk[0]?.signature ?? null;
    const all = new Map<string, number>();
    for (const x of [...mintOk, ...poolOk]) all.set(x.signature, x.slot);
    all.set(c.migrationSig, c.migrationSlot);
    const want = [...all].sort((a, b) => a[1] - b[1]).map(([s]) => s);
    const missing = want.filter((s) => !rpc.hasTx(s));
    await pool(missing, n, (s) => rpc.tx(s));
    const truncated = (poolSigs as { truncated?: boolean }).truncated === true || (mintSigs as { truncated?: boolean }).truncated === true;
    done[c.mint] = { mint: c.mint, endTime: end, poolSigs: poolSigs.length, poolOk: poolOk.length, poolOkFirstHour: firstHour, mintSigs: mintSigs.length, truncated, fetched: want.length, createSig };
    atomicWrite(doneFile, JSON.stringify(done));
    console.error(`${Object.keys(done).length}/${coins.length} ${c.mint.slice(0, 6)} pool ${poolOk.length}/${poolSigs.length} (1h ${firstHour}) mint ${mintSigs.length}${truncated ? ' TRUNCATED' : ''} txs ${want.length} (${missing.length} new) ${((Date.now() - t0) / 1000).toFixed(0)}s calls ${JSON.stringify(rpc.stats.calls)} retries ${rpc.stats.retries}`);
  });
};

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
