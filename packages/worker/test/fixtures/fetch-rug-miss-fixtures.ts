// Refetches rug-misses.json: real launches whose deployer's tokens or creation-slot buyers sold, the cases rugs-1 does
// not count as the deployer's own sale (docs/DECISIONS.md "Rug labels"). Token balances are kept, because transfers
// are read from them. CACHE_DIR, when set, is read first (getTransaction results saved as <signature>.json).
// Run: node --no-warnings packages/worker/test/fixtures/fetch-rug-miss-fixtures.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactRpc } from '../../../core/test/redact-rpc.ts';

const RPC = process.env['SOLANA_RPC'] ?? 'https://api.mainnet-beta.solana.com';
const CACHE = process.env['CACHE_DIR'];
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'rug-misses.json');

const CASES = [
  {
    // Launched 2026-10-02. The deployer moved 7.44% of supply to other wallets in three transfers, and those wallets
    // sold all of it. Partial history: the create, the transfers and the sales by the receiving wallets.
    name: 'transfer-then-sell', mint: '5wBy5RdjRzdKdkdcyZ3fhBUhrEd9HS8PREkomhdZX2s2', partial: true,
    signatures: [
    '4MBtPJbtDVJHe67iU9B1hSbBRD9cLUxBzVRes6CVZ4HH4SKrm5TKaHH8Ehb38j4PoU5SppzHXqpCFR6aLnfgQKqJ',
    'mnsR7Gb3GeQmbTZoMmqkBPzCTN3XP7etQA2DAYWtD6DJuKdtb2nsuw7Jk5xnVsY2bH2mXUt9G2TSP1WoyuHhDGt',
    '54NFntNRfRmeeMUPA364C8AjgSPjvdScP4q3GdEHyr8DwD5qGoDzwHoMVti2cbu4hYVAP9xTPi367GFcw7neZEZ6',
    '4zP2wfCVRb9g3SEPJv5zew2kmw9FZkxEqSCNk8qXcJJjsvS6AkPzUQXEJfBzj1c3QtRmA6B5xxr2yD9h5aQJUbiJ',
    'hYuZLZtcxtE5shT5TSreFQcXLxZJ1r6d774gee4SfD1mvxhRGy6XPyFcUBM9jLwnBCE12cdZCgut4n3NoYUsP1P',
    '4FvnYptL121YcRBwMfPAHE5ufrk6cweyrBkXKaDbPwT1YyMxBQsaSGmryh1iz5iTZw2U7YTy45vzXCY9nHf5kyqB',
    '4MyYf9YR5gVZJWQUBVjsgkQuvBU8xmk1sQNCTzP8CFmnEAMprkGT1XNj8SByFQHkdGouMHvRahAgBbg8XraauebC',
    ],
  },
  // Launched 2026-10-02. Wallets other than the deployer bought 4.58% in the create's slot and sold it; the deployer
  // never sold. Whole history.
  { name: 'bundle-dump', mint: 'BH5poyjNJp2r9ktMC8XTLH3gcAteQKMjnQQmKKTapaid', partial: false, signatures: null },
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let calls = 0;
const rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
  for (let i = 0; ; i++) {
    calls++;
    const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if ((res.status === 429 || res.status >= 500) && i < 8) {
      await sleep(500 * 2 ** i);
      continue;
    }
    const j = (await res.json()) as { result?: T; error?: unknown };
    if (j.error !== undefined) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
    return j.result as T;
  }
};
type Tx = { slot: number; blockTime: number | null; transaction: [string, string]; meta: Record<string, unknown> };
const tx = async (signature: string): Promise<Tx> => {
  const f = CACHE === undefined ? null : join(CACHE, `${signature}.json`);
  if (f !== null && existsSync(f)) return JSON.parse(readFileSync(f, 'utf8')) as Tx;
  return rpc<Tx>('getTransaction', [signature, { encoding: 'base64', maxSupportedTransactionVersion: 1, commitment: 'finalized' }]);
};

const cases = [];
for (const c of CASES) {
  let sigs: readonly string[];
  if (c.signatures !== null) sigs = c.signatures;
  else {
    const page = await rpc<{ signature: string; err: unknown }[]>('getSignaturesForAddress', [c.mint, { limit: 1000, commitment: 'finalized' }]);
    if (page.length === 1000) throw new Error(`${c.mint} has more history than one page`);
    sigs = page.reverse().filter((s) => s.err === null).map((s) => s.signature);
  }
  const transactions = [];
  for (const signature of sigs) {
    const t = await tx(signature);
    const m = t.meta;
    transactions.push({
      signature, slot: t.slot, blockTime: t.blockTime, transaction: t.transaction,
      meta: { err: m['err'], loadedAddresses: m['loadedAddresses'], innerInstructions: m['innerInstructions'], logMessages: m['logMessages'], preTokenBalances: m['preTokenBalances'], postTokenBalances: m['postTokenBalances'] },
    });
  }
  cases.push({ name: c.name, mint: c.mint, partial: c.partial, transactions });
}
writeFileSync(OUT, `${JSON.stringify({ meta: { rpc: redactRpc(RPC), fetchedAt: new Date().toISOString(), calls }, cases }, null, 1)}\n`);
console.log(`wrote ${cases.map((c) => `${c.name}: ${c.transactions.length}`).join(', ')} with ${calls} calls`);
