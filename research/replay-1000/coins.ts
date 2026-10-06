// REPLAY-1000: the day's coins and the slot index, from chain.
//
//   node research/replay-1000/coins.ts index <fromIso> [toIso]   page the pump create authority's signatures (slot↔time
//                                                                samples, `before` anchors, every create signature)
//   node research/replay-1000/coins.ts migrations <day>           every pump → PumpSwap canonical-pool migration of a UTC day
//
// Survivorship-free: the migration list is every successful transaction of pump's withdraw authority (only
// migrate/migrate_v2 pass it, venues.md, measured) in the day, decoded with DEC-1; nothing is filtered by later fate.
import { createHash } from 'node:crypto';
import { NATIVE_MINT, poolAddress, pumpPoolAuthority, recordFromRpc, transactionEvents, type Address, type RpcTransactionBase64 } from '../../packages/core/src/chain/index.ts';
import { PUMP_CREATE_AUTHORITY, PUMP_MIGRATION_AUTHORITY } from '../../packages/worker/src/run/sources.ts';
import { PublicRpc, type RawSig, atomicWrite, DATA_DIR, pool } from './rpc.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Coin {
  readonly mint: string;
  readonly pool: string;
  readonly migrationSig: string;
  readonly migrationSlot: number;
  readonly migrationTime: number;
  /** sha256(mint) as hex: the seeded sample key (unbiased: independent of anything about the coin). */
  readonly hash: string;
}

export const sampleKey = (mint: string): string => createHash('sha256').update(mint).digest('hex');
/** The seeded 10% sample: the first byte of sha256(mint) below 26 (26/256 = 10.2%). Fixed before any result exists. */
export const inSample = (c: Pick<Coin, 'hash'>): boolean => parseInt(c.hash.slice(0, 2), 16) < 26;

export const canonicalPool = (mint: string): string => poolAddress(0, pumpPoolAuthority(mint as Address), mint as Address, NATIVE_MINT);

/** Pages an address's signatures from `before` (or the newest) back past `fromTime` (seconds); oldest-last order. */
export const pageBack = async (rpc: PublicRpc, address: string, fromTime: number, before?: string, onPage?: (n: number, last: RawSig) => void): Promise<RawSig[]> => {
  const out: RawSig[] = [];
  let cursor = before;
  for (let n = 1; ; n++) {
    const page = await rpc.sigPage(address, cursor);
    if (page.length === 0) break;
    out.push(...page);
    cursor = page.at(-1)!.signature;
    onPage?.(n, page.at(-1)!);
    if ((page.at(-1)!.blockTime ?? Infinity) < fromTime || page.length < 1000) break;
  }
  return out;
};

export const INDEX_FILE = join(DATA_DIR, 'create-index.json');

/** The slot index: every create-authority signature (slot, time, sig, err) between `from` and the newest page. */
export const loadIndex = (dir?: string): RawSig[] => JSON.parse(readFileSync(dir === undefined ? INDEX_FILE : join(dir, 'create-index.json'), 'utf8')) as RawSig[];

const main = async () => {
  const rpc = new PublicRpc();
  const cmd = process.argv[2];
  if (cmd === 'index') {
    const from = Date.parse(process.argv[3]!) / 1000;
    const to = process.argv[4] === undefined ? Infinity : Date.parse(process.argv[4]) / 1000;
    const prev: RawSig[] = existsSync(INDEX_FILE) ? loadIndex() : [];
    // Extend at the new end: page from the newest down to the newest already held, then keep the old tail.
    const newestHeld = prev[0]?.slot ?? 0;
    const fresh: RawSig[] = [];
    let cursor: string | undefined;
    for (let n = 1; ; n++) {
      const page = await rpc.sigPage(PUMP_CREATE_AUTHORITY, cursor);
      if (page.length === 0) break;
      fresh.push(...page);
      cursor = page.at(-1)!.signature;
      const last = page.at(-1)!;
      if (n % 10 === 0) console.error(`index: ${n} pages, at ${new Date((last.blockTime ?? 0) * 1000).toISOString()}`);
      if (last.slot <= newestHeld) break;
      if ((last.blockTime ?? Infinity) < from && prev.length === 0) break;
    }
    let all = [...fresh.filter((x) => x.slot > newestHeld), ...prev];
    // Extend at the old end when asked for an earlier start.
    if ((all.at(-1)?.blockTime ?? 0) > from) all.push(...(await pageBack(rpc, PUMP_CREATE_AUTHORITY, from, all.at(-1)!.signature, (n, l) => { if (n % 10 === 0) console.error(`index back: ${n} pages, at ${new Date((l.blockTime ?? 0) * 1000).toISOString()}`); })));
    all = all.filter((x) => (x.blockTime ?? 0) <= to);
    // Strictly newest first, no duplicates.
    const seen = new Set<string>();
    all = all.filter((x) => (seen.has(x.signature) ? false : (seen.add(x.signature), true))).sort((a, b) => b.slot - a.slot);
    atomicWrite(INDEX_FILE, JSON.stringify(all));
    console.error(`index: ${all.length} signatures, ${new Date((all.at(-1)!.blockTime ?? 0) * 1000).toISOString()} .. ${new Date((all[0]!.blockTime ?? 0) * 1000).toISOString()}`);
    return;
  }
  if (cmd === 'migrations') {
    const day = process.argv[3]!;
    // An optional later start (ISO) for a partial day (the previous day's tail, for the replay's warm-up).
    const start = process.argv[4] === undefined ? Date.parse(`${day}T00:00:00Z`) / 1000 : Date.parse(process.argv[4]) / 1000;
    const end = start + 86_400;
    const sigs = (await pageBack(rpc, PUMP_MIGRATION_AUTHORITY, start)).filter((x) => x.blockTime !== null && x.blockTime >= start && x.blockTime < end);
    const ok = sigs.filter((x) => x.err === null).reverse();
    const coins: Coin[] = [];
    const other: Record<string, number> = {};
    let n = 0;
    const raws = await pool(ok, 16, async (s) => {
      const r = await rpc.tx(s.signature);
      if (++n % 100 === 0) console.error(`migrations: ${n}/${ok.length} fetched`);
      return r;
    });
    for (const [i, s] of ok.entries()) {
      const raw = raws[i];
      if (raw === null) { other['not-found'] = (other['not-found'] ?? 0) + 1; continue; }
      const rec = recordFromRpc(s.signature, raw as RpcTransactionBase64);
      const ev = transactionEvents(rec);
      const done = ev.find((e) => e.name === 'CompletePumpAmmMigrationEvent');
      const created = ev.find((e) => e.name === 'CreatePoolEvent');
      if (done === undefined || created === undefined) { other['no-migration-event'] = (other['no-migration-event'] ?? 0) + 1; continue; }
      const mint = (done.data as { mint: string }).mint;
      const pool = (created.data as { pool: string }).pool;
      if (pool !== canonicalPool(mint)) { other['not-canonical'] = (other['not-canonical'] ?? 0) + 1; continue; }
      coins.push({ mint, pool, migrationSig: s.signature, migrationSlot: s.slot, migrationTime: s.blockTime!, hash: sampleKey(mint) });
    }
    const out = { day, source: 'getSignaturesForAddress(pump withdraw authority) + getTransaction, finalized, public RPC', authority: PUMP_MIGRATION_AUTHORITY, transactions: sigs.length, failed: sigs.length - ok.length, skipped: other, coins };
    atomicWrite(join(DATA_DIR, process.argv[4] === undefined ? `coins-${day}.json` : `coins-${day}-from-${process.argv[4].slice(11, 13)}.json`), JSON.stringify(out, null, 1));
    console.error(`migrations ${day}: ${sigs.length} transactions, ${ok.length} ok, ${coins.length} canonical coins, skipped ${JSON.stringify(other)}, sample ${coins.filter(inSample).length}`);
    return;
  }
  throw new Error('usage: coins.ts index <fromIso> [toIso] | migrations <day>');
};

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
