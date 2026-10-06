// TAIL-PROOF collector: pulls recent PumpSwap trades from a keyless public Solana RPC and caches the raw
// `getTransaction` results (base64, with meta) under research/tail-proof/data/ (git-ignored), for analyze.ts.
//
//   node research/tail-proof/collect.ts discover [pages]         recent program-wide trades; lists pools by tail
//   node research/tail-proof/collect.ts pools [nonzero] [zero] [perPool]   per-pool trades for a spread of pools
//   node research/tail-proof/collect.ts history <pool> [pages] [every] [newest]   one pool's tape, every n-th trade (tail over time)
//   node research/tail-proof/collect.ts accounts                 Pool accounts, FeeConfig and admin history
//
// Only Node built-ins and packages/core. Never put a keyed RPC URL in the repo: SOLANA_RPC is read from the
// environment and defaults to the public endpoint, which is rate limited, so requests are spaced and retried.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUMP_AMM_FEE_CONFIG, PUMP_AMM_PROGRAM, recordFromRpc, transactionEvents } from '../../packages/core/src/chain/index.ts';

const RPC = process.env['SOLANA_RPC'] ?? 'https://api.mainnet-beta.solana.com';
const DATA = join(dirname(fileURLToPath(import.meta.url)), 'data');
const TX_DIR = join(DATA, 'tx');
/** The single admin of both FeeConfigs and PumpSwap GlobalConfig (docs/research/venues.md 2.7). */
const ADMIN = 'FFWtrEQ4B4PKQoVuHYzZq8FabGkVatYzDpEVHsK5rrhF';
mkdirSync(TX_DIR, { recursive: true });

let last = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const rpc = async (method: string, params: unknown[]): Promise<any> => {
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
    } catch (e) {
      if (attempt === 19) throw e;
      await sleep(1000 * 2 ** Math.min(attempt, 4));
    }
  }
  throw new Error(`${method}: gave up after retries`);
};

const txPath = (sig: string) => join(TX_DIR, `${sig}.json`);
const getTx = async (sig: string): Promise<any> => {
  if (existsSync(txPath(sig))) return JSON.parse(readFileSync(txPath(sig), 'utf8'));
  const tx = await rpc('getTransaction', [sig, { maxSupportedTransactionVersion: 1, encoding: 'base64', commitment: 'finalized' }]);
  if (tx) writeFileSync(txPath(sig), JSON.stringify(tx));
  return tx;
};

/** Pool trade events (pool, kind, tail) in a cached transaction. */
const poolTrades = (sig: string, tx: any) => {
  if (!tx?.meta || tx.meta.err !== null) return [];
  return transactionEvents(recordFromRpc(sig, tx)).flatMap((e) =>
    e.name === 'BuyEvent' || e.name === 'SellEvent' ? [{ pool: e.data.pool as string, kind: e.name, slot: Number(e.slot), extra: e.extra, trailing: e.trailing }] : []);
};

const page = async (address: string, pages: number, stopBeforeSlot = 0) => {
  const sigs: string[] = [];
  let before: string | undefined;
  for (let p = 0; p < pages; p++) {
    const res = (await rpc('getSignaturesForAddress', [address, { limit: 1000, ...(before ? { before } : {}) }])) as { signature: string; err: unknown; slot: number }[];
    if (res.length === 0) break;
    before = res[res.length - 1]!.signature;
    sigs.push(...res.filter((x) => x.err === null && x.slot > stopBeforeSlot).map((x) => x.signature));
    if (res[res.length - 1]!.slot <= stopBeforeSlot) break;
  }
  return sigs;
};

const readJson = <T>(name: string, fallback: T): T => (existsSync(join(DATA, name)) ? (JSON.parse(readFileSync(join(DATA, name), 'utf8')) as T) : fallback);
const writeJson = (name: string, v: unknown) => writeFileSync(join(DATA, name), JSON.stringify(v, null, 1));

type PoolSeen = { nonzero: number; zero: number; lastExtra: string; lastSlot: number };
const tally = (seen: Record<string, PoolSeen>, sig: string, tx: any) => {
  for (const t of poolTrades(sig, tx)) {
    const s = (seen[t.pool] ??= { nonzero: 0, zero: 0, lastExtra: '', lastSlot: 0 });
    if (/[^0]/.test(t.extra)) s.nonzero++; else s.zero++;
    if (t.slot >= s.lastSlot) { s.lastSlot = t.slot; s.lastExtra = t.extra; }
  }
};

const main = async () => {
  const cmd = process.argv[2];
  if (cmd === 'discover') {
    // Program-wide: the newest successful PumpSwap transactions, a sample of every n-th one per page.
    const pages = Number(process.argv[3] ?? '1');
    const every = Number(process.argv[4] ?? '4');
    const sigs = (await page(PUMP_AMM_PROGRAM, pages)).filter((_, i) => i % every === 0);
    const seen = readJson<Record<string, PoolSeen>>('pools-seen.json', {});
    let n = 0;
    for (const sig of sigs) {
      tally(seen, sig, await getTx(sig));
      if (++n % 50 === 0) console.error(`discover: ${n}/${sigs.length} transactions, ${Object.keys(seen).length} pools`);
    }
    writeJson('pools-seen.json', seen);
    const nz = Object.values(seen).filter((s) => s.nonzero > 0).length;
    console.error(`pools: ${Object.keys(seen).length}, with a non-zero tail: ${nz}`);
    return;
  }
  if (cmd === 'pools') {
    // A spread of pools: up to N with non-zero tails and M with zero tails, each with its newest trades.
    const [nNonzero, nZero, perPool] = [Number(process.argv[3] ?? '30'), Number(process.argv[4] ?? '15'), Number(process.argv[5] ?? '12')];
    const seen = readJson<Record<string, PoolSeen>>('pools-seen.json', {});
    const pick = [
      ...Object.entries(seen).filter(([, s]) => s.nonzero > 0).slice(0, nNonzero),
      ...Object.entries(seen).filter(([, s]) => s.nonzero === 0).slice(0, nZero),
    ];
    for (const [pool] of pick) {
      const res = (await rpc('getSignaturesForAddress', [pool, { limit: perPool * 2 }])) as { signature: string; err: unknown }[];
      let got = 0;
      for (const s of res.filter((x) => x.err === null)) {
        if (got >= perPool) break;
        if (poolTrades(s.signature, await getTx(s.signature)).some((t) => t.pool === pool)) got++;
      }
      console.error(`pool ${pool}: ${got} trades`);
    }
    return;
  }
  if (cmd === 'history') {
    // One pool's tape, newest first, for the tail-over-time study.
    const pool = process.argv[3]!;
    const every = Number(process.argv[5] ?? '1');
    const limit = Number(process.argv[6] ?? '0');
    const all = (await page(pool, Number(process.argv[4] ?? '1'))).slice(0, limit > 0 ? limit : undefined);
    // Every n-th transaction, plus the oldest few (the pool's first trades after migration).
    const sigs = all.filter((_, i) => i % every === 0 || i >= all.length - 10);
    const hist = readJson<Record<string, string[]>>('histories.json', {});
    hist[pool] = all;
    writeJson('histories.json', hist);
    let n = 0;
    for (const sig of sigs) { await getTx(sig); if (++n % 100 === 0) console.error(`history ${pool.slice(0, 6)}: ${n}/${sigs.length}`); }
    return;
  }
  if (cmd === 'accounts') {
    // Current Pool accounts of every pool traded in the cache, the PumpSwap FeeConfig, and the admin's history since B5.
    const pools = readJson<Record<string, unknown>>('pool-accounts.json', {});
    const names = new Set<string>();
    for (const f of readdirSync(TX_DIR)) {
      const sig = f.replace(/\.json$/, '');
      for (const t of poolTrades(sig, JSON.parse(readFileSync(txPath(sig), 'utf8')))) names.add(t.pool);
    }
    for (const p of names) {
      if (pools[p]) continue;
      const info = await rpc('getAccountInfo', [p, { encoding: 'base64' }]);
      pools[p] = info.value ? { slot: info.context.slot, owner: info.value.owner, data: info.value.data[0] } : null;
    }
    writeJson('pool-accounts.json', pools);
    const fc = await rpc('getAccountInfo', [PUMP_AMM_FEE_CONFIG, { encoding: 'base64' }]);
    writeJson('fee-config.json', { address: PUMP_AMM_FEE_CONFIG, slot: fc.context.slot, data: fc.value.data[0] });
    const admin = (await rpc('getSignaturesForAddress', [ADMIN, { limit: 1000 }])) as unknown[];
    writeJson('admin-signatures.json', admin);
    console.error(`pool accounts: ${Object.keys(pools).length}; admin signatures: ${admin.length}`);
    return;
  }
  throw new Error('usage: collect.ts discover|pools|history|accounts');
};

await main();
