// TAIL-PROOF tail study: finds where one pool's trade-event tail changes value, by binary search over the pool's
// recent signatures, and prints every transaction in each bracket (old value -> new value) with what it ran.
//
//   node research/tail-proof/changes.ts <pool> [pages]
//
// Uses the transaction cache of collect.ts (research/tail-proof/data/tx). Writes data/changes-<pool>.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUMP_AMM_PROGRAM, accountKeys, decodeTransaction, recordFromRpc, toHex, transactionEvents } from '../../packages/core/src/chain/index.ts';

const RPC = process.env['SOLANA_RPC'] ?? 'https://api.mainnet-beta.solana.com';
const DATA = join(dirname(fileURLToPath(import.meta.url)), 'data');
const TX_DIR = join(DATA, 'tx');
mkdirSync(TX_DIR, { recursive: true });
let last = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rpc = async (method: string, params: unknown[]): Promise<any> => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const wait = last + 300 - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (res.status === 429 || res.status >= 500) { await sleep(Math.min(10_000, 1500 * (attempt + 1))); continue; }
      const body = (await res.json()) as { result?: unknown; error?: unknown };
      if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
      return body.result;
    } catch (e) { if (attempt === 19) throw e; await sleep(2000); }
  }
  throw new Error('gave up');
};
const getTx = async (sig: string): Promise<any> => {
  const p = join(TX_DIR, `${sig}.json`);
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const tx = await rpc('getTransaction', [sig, { maxSupportedTransactionVersion: 1, encoding: 'base64', commitment: 'finalized' }]);
  if (tx) writeFileSync(p, JSON.stringify(tx));
  return tx;
};

const pool = process.argv[2]!;
const pages = Number(process.argv[3] ?? '2');
/** The pool's trade events in a transaction, with tails as u64. */
const tails = async (sig: string) => {
  const tx = await getTx(sig);
  if (!tx?.meta || tx.meta.err !== null) return [];
  return transactionEvents(recordFromRpc(sig, tx)).flatMap((e) =>
    (e.name === 'BuyEvent' || e.name === 'SellEvent') && e.data.pool === pool ? [{ kind: e.name, tail: BigInt(`0x${(e.extra.match(/../g) ?? []).reverse().join('') || '0'}`), data: e.data }] : []);
};
/** What a transaction ran: top-level and inner PumpSwap instruction discriminators and other event discriminators. */
const describe = async (sig: string) => {
  const raw = await getTx(sig);
  if (!raw?.meta) return { sig, missing: true };
  const rec = recordFromRpc(sig, raw);
  const tx = decodeTransaction(rec.transaction);
  const keys = accountKeys(tx, rec.loadedAddresses);
  const amm: string[] = [];
  tx.instructions.forEach((ix, i) => {
    const list = [ix, ...(rec.innerInstructions?.find((g) => g.index === i)?.instructions ?? [])];
    for (const x of list) if (keys[x.programIdIndex] === PUMP_AMM_PROGRAM) amm.push(toHex(x.data).slice(0, 32));
  });
  const ev = rec.err === null ? transactionEvents(rec, tx).map((e) => (e.name === 'other' ? `other:${e.discriminator}` : e.name)) : [];
  return { sig, slot: Number(rec.slot), err: rec.err, amm, events: ev, logs: (rec.logMessages ?? []).filter((l) => /Instruction:/.test(l)) };
};

const main = async () => {
  const sigs: { signature: string; slot: number; err: unknown }[] = [];
  let before: string | undefined;
  for (let p = 0; p < pages; p++) {
    const res = await rpc('getSignaturesForAddress', [pool, { limit: 1000, ...(before ? { before } : {}) }]);
    if (res.length === 0) break;
    sigs.push(...res);
    before = res[res.length - 1].signature;
  }
  sigs.reverse(); // oldest first
  const ok = sigs.filter((s) => s.err === null);
  // Tail at index i: the first trade's tail in that transaction, or null when it has no trade on the pool.
  const memo = new Map<number, bigint | null>();
  const at = async (i: number) => {
    if (!memo.has(i)) { const t = await tails(ok[i]!.signature); memo.set(i, t.length ? t[0]!.tail : null); }
    return memo.get(i)!;
  };
  /** Nearest index >= i (<= hi) with a trade, or -1. */
  const tradeFrom = async (i: number, hi: number) => { for (let j = i; j <= hi; j++) if ((await at(j)) !== null) return j; return -1; };
  const brackets: [number, number][] = [];
  const search = async (lo: number, hi: number) => {
    // lo and hi are trade indices; find every change between them.
    if ((await at(lo)) === (await at(hi))) return; // assumes no A->B->A between samples (checked: values only grew)
    if (hi - lo <= 1) { brackets.push([lo, hi]); return; }
    const mid = await tradeFrom(Math.floor((lo + hi) / 2), hi);
    if (mid === hi || mid < 0) { const m2 = await tradeFrom(lo + 1, hi); if (m2 === hi) { brackets.push([lo, hi]); return; } return search(m2, hi).then(() => search(lo, m2)); }
    await search(lo, mid);
    await search(mid, hi);
  };
  const first = await tradeFrom(0, ok.length - 1);
  let lastT = ok.length - 1;
  while ((await at(lastT)) === null) lastT--;
  await search(first, lastT);
  const out = { pool, span: [ok[0]!.slot, ok[ok.length - 1]!.slot], transactions: ok.length, first: String(await at(first)), last: String(await at(lastT)), changes: [] as unknown[] };
  for (const [lo, hi] of brackets.sort((a, b) => a[0] - b[0])) {
    const between = [];
    for (let i = lo; i <= hi; i++) between.push(await describe(ok[i]!.signature));
    const before = await tails(ok[lo]!.signature);
    const after = await tails(ok[hi]!.signature);
    out.changes.push({ from: String(before[0]!.tail), to: String(after[0]!.tail), delta: String(after[0]!.tail - before.at(-1)!.tail), between,
      beforeTrade: Object.fromEntries(Object.entries(before.at(-1)!.data).map(([k, v]) => [k, String(v)])), afterTrade: Object.fromEntries(Object.entries(after[0]!.data).map(([k, v]) => [k, String(v)])) });
    console.error(`change ${before.at(-1)!.tail} -> ${after[0]!.tail} between slots ${ok[lo]!.slot} and ${ok[hi]!.slot}`);
  }
  writeFileSync(join(DATA, `changes-${pool}.json`), JSON.stringify(out, null, 1));
  console.error(`${brackets.length} changes over ${ok.length} transactions; fetched ${memo.size}`);
};

await main();
