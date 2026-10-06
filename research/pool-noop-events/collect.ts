// POOL-FIRST-READ part 2: do PumpSwap's CloseUserVolumeAccumulatorEvent and ExtendAccountEvent leave a pool's
// reserves unchanged? Pulls recent PumpSwap transactions from a keyless public RPC (never a bot key), finds those two
// events, and for every pool in such a transaction checks, from the program's own swap events and the transaction's
// token balances, that the pool's base vault, quote vault and virtual quote reserves are the same right before and
// right after the event. Raw `getTransaction` results are cached under data/ (git-ignored).
//
//   node research/pool-noop-events/collect.ts discover <pages>      program-wide recent transactions with the events
//   node research/pool-noop-events/collect.ts tapes <per-disc>      each found pool's swaps around the event
//   node research/pool-noop-events/collect.ts report                writes data/report.json and prints the counts
//
// Only Node built-ins and packages/core. SOLANA_RPC is read from the environment and defaults to the public endpoint.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUMP_AMM_PROGRAM, recordFromRpc, transactionEvents, type LocatedEvent } from '../../packages/core/src/chain/index.ts';
import { swapEventState, type SwapEvent } from '../../packages/core/src/fills/index.ts';

const RPC = process.env['SOLANA_RPC'] ?? 'https://api.mainnet-beta.solana.com';
const DATA = join(dirname(fileURLToPath(import.meta.url)), 'data');
const TX_DIR = join(DATA, 'tx');
mkdirSync(TX_DIR, { recursive: true });

/** Anchor event discriminators: sha256("event:<Name>")[0..8]. */
export const TARGETS: Record<string, string> = { '929fbdac925838f4': 'CloseUserVolumeAccumulatorEvent', '6161d7905d92167c': 'ExtendAccountEvent' };

let last = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rpc = async (method: string, params: unknown[]): Promise<any> => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const wait = last + 250 - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (res.status === 429 || res.status >= 500) { await sleep(Math.min(10_000, 1500 * (attempt + 1))); continue; }
      const body = (await res.json()) as { result?: unknown; error?: unknown };
      if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
      return body.result;
    } catch (e) {
      if (attempt === 19) throw e;
      await sleep(1000 * 2 ** Math.min(attempt, 4));
    }
  }
  throw new Error(`${method}: gave up`);
};

const txPath = (sig: string) => join(TX_DIR, `${sig}.json`);
const getTx = async (sig: string): Promise<any> => {
  if (existsSync(txPath(sig))) return JSON.parse(readFileSync(txPath(sig), 'utf8'));
  const tx = await rpc('getTransaction', [sig, { maxSupportedTransactionVersion: 1, encoding: 'base64', commitment: 'confirmed' }]);
  if (tx) writeFileSync(txPath(sig), JSON.stringify(tx));
  return tx;
};
const readJson = <T>(name: string, fallback: T): T => (existsSync(join(DATA, name)) ? (JSON.parse(readFileSync(join(DATA, name), 'utf8')) as T) : fallback);
const writeJson = (name: string, v: unknown) => writeFileSync(join(DATA, name), JSON.stringify(v, null, 1));

const events = (sig: string, tx: any): LocatedEvent[] => (!tx?.meta || tx.meta.err !== null ? [] : transactionEvents(recordFromRpc(sig, tx)));
const isSwap = (e: LocatedEvent): e is LocatedEvent & SwapEvent => e.program === 'pump_amm' && (e.name === 'BuyEvent' || e.name === 'SellEvent');
const discOf = (e: LocatedEvent): string | null => (e.program === 'pump_amm' && e.name === 'other' ? (e as { discriminator: string }).discriminator : null);
interface Occurrence { sig: string; slot: number; disc: string; outerIx: number; innerIx: number; pools: string[] }

/** Program-wide recent transactions; keeps those holding a target event, with the pools whose swaps appear in them. */
const discover = async (pages: number) => {
  const found = readJson<Occurrence[]>('occurrences.json', []);
  const have = new Set(found.map((o) => `${o.sig}:${o.outerIx}:${o.innerIx}`));
  let before: string | undefined = readJson<{ before?: string }>('cursor.json', {}).before;
  for (let p = 0; p < pages; p++) {
    const res = (await rpc('getSignaturesForAddress', [PUMP_AMM_PROGRAM, { limit: 1000, ...(before ? { before } : {}) }])) as { signature: string; err: unknown }[];
    if (res.length === 0) break;
    before = res.at(-1)!.signature;
    for (const s of res.filter((x) => x.err === null)) {
      const tx = await getTx(s.signature);
      let evs: LocatedEvent[];
      try { evs = events(s.signature, tx); } catch { continue; }
      const pools = [...new Set(evs.filter(isSwap).map((e) => e.data.pool as string))];
      for (const e of evs) {
        const d = discOf(e);
        if (d === null || TARGETS[d] === undefined) continue;
        const k = `${s.signature}:${e.outerIx}:${e.innerIx}`;
        if (have.has(k)) continue;
        have.add(k);
        found.push({ sig: s.signature, slot: Number(e.slot), disc: d, outerIx: e.outerIx, innerIx: e.innerIx, pools });
      }
    }
    writeJson('occurrences.json', found);
    writeJson('cursor.json', { before });
    const by = Object.fromEntries(Object.keys(TARGETS).map((d) => [TARGETS[d], found.filter((o) => o.disc === d).length]));
    console.log(`page ${p + 1}/${pages}: ${JSON.stringify(by)}`);
  }
};

/** An event's place on its pool's tape: the transaction's place in the tape, then its place in the transaction. */
type Pos = readonly [number, number, number];
const cmp = (a: Pos, b: Pos) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** For each occurrence and each pool swapped in its transaction, the pool's swaps just before and after it. */
const tapes = async (perDisc: number) => {
  const occ = readJson<Occurrence[]>('occurrences.json', []);
  const done = readJson<Record<string, string[]>>('tapes.json', {});
  const count: Record<string, number> = {};
  for (const o of occ) {
    if ((count[o.disc] ?? 0) >= perDisc) continue;
    for (const pool of o.pools) {
      const key = `${o.sig}:${o.outerIx}:${o.innerIx}:${pool}`;
      if (done[key] === undefined) {
        // The pool's transactions around the occurrence: 10 before it, and up to 1,000 after it (newest first).
        const older = (await rpc('getSignaturesForAddress', [pool, { limit: 10, before: o.sig }])) as { signature: string; err: unknown }[];
        const newer = (await rpc('getSignaturesForAddress', [pool, { limit: 1000, until: o.sig }])) as { signature: string; err: unknown }[];
        // Chronological, in the RPC's order (its order within a slot is checked by the whole tape chaining, in report).
        const sigs = [...[...older].reverse(), { signature: o.sig, err: null }, ...newer.slice(-10).reverse()].filter((x) => x.err === null).map((x) => x.signature);
        for (const s of sigs) await getTx(s);
        done[key] = sigs;
        writeJson('tapes.json', done);
      }
    }
    count[o.disc] = (count[o.disc] ?? 0) + 1;
    console.log(`${TARGETS[o.disc]} ${count[o.disc]}/${perDisc}`);
  }
};

interface Check { key: string; disc: string; pool: string; slot: number; verdict: 'unchanged' | 'changed' | 'inconclusive'; why: string }

const report = () => {
  const occ = readJson<Occurrence[]>('occurrences.json', []);
  const tapesOf = readJson<Record<string, string[]>>('tapes.json', {});
  const checks: Check[] = [];
  for (const o of occ) {
    for (const pool of o.pools) {
      const key = `${o.sig}:${o.outerIx}:${o.innerIx}:${pool}`;
      const sigs = tapesOf[key];
      if (sigs === undefined) continue;
      const add = (verdict: Check['verdict'], why: string) => checks.push({ key, disc: o.disc, pool, slot: o.slot, verdict, why });
      // Every pool event on the tape (the occurrence's transaction and its neighbours), in chain order.
      const all: { pos: Pos; e: LocatedEvent }[] = [];
      let undecodable = false;
      sigs.forEach((s, i) => {
        const tx = JSON.parse(readFileSync(txPath(s), 'utf8'));
        try {
          for (const e of events(s, tx)) all.push({ pos: [i, e.outerIx, e.innerIx], e });
        } catch {
          undecodable = true;
        }
      });
      if (undecodable) { add('inconclusive', 'a transaction on the tape does not decode'); continue; }
      const at: Pos = all.find((x) => x.e.signature === o.sig && x.e.outerIx === o.outerIx && x.e.innerIx === o.innerIx)!.pos;
      const mine = all.filter((x) => isSwap(x.e) && x.e.data.pool === pool).sort((a, b) => cmp(a.pos, b.pos));
      // The tape's order is the RPC's; it is trusted only when every consecutive pair of the pool's swaps on it chains
      // exactly (the one pair across the occurrence aside, which is the question).
      const chains = (a: LocatedEvent, b: LocatedEvent): boolean => {
        const r = swapEventState(a as unknown as SwapEvent);
        const d = (b as unknown as SwapEvent).data;
        return r.ok && r.after.baseReserve === d.poolBaseTokenReserves && r.after.quoteVault + r.after.virtualQuoteReserves === d.poolQuoteTokenReserves + (d.virtualQuoteReserves ?? 0n);
      };
      const prev = mine.filter((x) => cmp(x.pos, at) < 0).at(-1);
      const next = mine.find((x) => cmp(x.pos, at) > 0);
      if (prev === undefined || next === undefined) { add('inconclusive', 'no swap of the pool on one side'); continue; }
      const broken = mine.slice(1).filter((x, i) => x !== next && !chains(mine[i]!.e, x.e) && !all.some((y) => cmp(y.pos, mine[i]!.pos) > 0 && cmp(y.pos, x.pos) < 0 && y.e.program === 'pump_amm' && !isSwap(y.e)));
      if (broken.length > 0) { add('inconclusive', `tape order not proven (${broken.length} pairs do not chain)`); continue; }
      // Nothing else of PumpSwap between them (other than the two target events) may have touched the pool.
      const between = all.filter((x) => cmp(x.pos, prev.pos) > 0 && cmp(x.pos, next.pos) < 0 && x.e.program === 'pump_amm');
      const foreign = between.filter((x) => !(isSwap(x.e) && x.e.data.pool !== pool) && !(discOf(x.e) !== null && TARGETS[discOf(x.e)!] !== undefined));
      if (foreign.length > 0) { add('inconclusive', `other PumpSwap event between: ${foreign.map((x) => x.e.name === 'other' ? discOf(x.e) : x.e.name).join(',')}`); continue; }
      // The tape is the pool's own signature list, so every transaction touching the pool between prev and next is on it.
      const r = swapEventState(prev.e as unknown as SwapEvent);
      if (!r.ok) { add('inconclusive', `previous swap does not replay: ${r.reason}`); continue; }
      const d = (next.e as unknown as SwapEvent).data;
      const pre = { baseReserve: d.poolBaseTokenReserves, quoteVault: d.poolQuoteTokenReserves, virtualQuoteReserves: d.virtualQuoteReserves ?? 0n };
      const same = pre.baseReserve === r.after.baseReserve && pre.quoteVault === r.after.quoteVault && pre.virtualQuoteReserves === r.after.virtualQuoteReserves;
      if (same) add('unchanged', `prev ${prev.e.signature} → next ${next.e.signature}`);
      else {
        // A sell does not say whether it was v2, so its vault/virtual split may be the v1 one: compare the price-setting
        // reserves too, and report which part moved.
        const eff = pre.quoteVault + pre.virtualQuoteReserves === r.after.quoteVault + r.after.virtualQuoteReserves && pre.baseReserve === r.after.baseReserve;
        add(eff ? 'inconclusive' : 'changed', `${eff ? 'split only' : 'moved'}: after ${r.after.baseReserve}/${r.after.quoteVault}/${r.after.virtualQuoteReserves}, next pre ${pre.baseReserve}/${pre.quoteVault}/${pre.virtualQuoteReserves}`);
      }
    }
  }
  const summary = Object.fromEntries(Object.entries(TARGETS).map(([d, n]) => {
    const c = checks.filter((x) => x.disc === d);
    return [n, { occurrences: occ.filter((x) => x.disc === d).length, unchanged: c.filter((x) => x.verdict === 'unchanged').length, changed: c.filter((x) => x.verdict === 'changed').length, inconclusive: c.filter((x) => x.verdict === 'inconclusive').length, pools: new Set(c.filter((x) => x.verdict === 'unchanged').map((x) => x.pool)).size }];
  }));
  writeJson('report.json', { rpc: RPC.includes('api.mainnet-beta') ? 'public api.mainnet-beta.solana.com' : 'SOLANA_RPC (keyless)', summary, checks });
  console.log(JSON.stringify(summary, null, 1));
};

const [cmd, a] = process.argv.slice(2);
if (cmd === 'discover') await discover(Number(a ?? 1));
else if (cmd === 'tapes') await tapes(Number(a ?? 60));
else if (cmd === 'report') report();
else console.log('discover <pages> | tapes <per-disc> | report');
