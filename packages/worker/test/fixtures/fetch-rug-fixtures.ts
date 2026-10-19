// Refetches the RUG-1 replay fixture (rug-replay.json) from the public Solana RPC: every successful transaction of
// each case, oldest first, as `getTransaction` returns it in base64 with the meta trimmed to what DEC-1 reads.
// Run: node --no-warnings packages/worker/test/fixtures/fetch-rug-fixtures.ts
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { casesHash } from './fixture-hash.ts';
import { redactRpc } from '../../../core/test/redact-rpc.ts';

const RPC = process.env['SOLANA_RPC'] ?? 'https://api.mainnet-beta.solana.com';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'rug-replay.json');

/** Each case: the mint, and how far its history is kept (up to and including `until`, or the whole history). */
const CASES = [
  { name: 'rug', mint: '3sNmNcLTywfmxbXW9M1S7nuQP34oow2FeKzUBgFipump', until: '4f4YRWURmxFMtdrWB4EoYiodfBSawRrwnHQV3B9LZqtT2VJEtK9as4yDBfah9JmDkr615suRt9DtXGESji1CJUxq' },
  // Non-rugs: launches more than 24 h old at fetch time with no label, whole history kept. Mints as arguments.
  ...process.argv.slice(2).map((mint) => ({ name: 'non-rug', mint, until: null })),
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

type Sig = { signature: string; err: unknown; blockTime: number | null };
type Tx = { slot: number; blockTime: number | null; version?: unknown; transaction: [string, string]; meta: Record<string, unknown> };

const cases = [];
for (const c of CASES) {
  const sigs: Sig[] = [];
  for (let before: string | undefined; ;) {
    const page = await rpc<Sig[]>('getSignaturesForAddress', [c.mint, { limit: 1000, commitment: 'finalized', ...(before ? { before } : {}) }]);
    sigs.push(...page);
    if (page.length < 1000) break;
    before = page[page.length - 1]!.signature;
  }
  const ordered = sigs.reverse().filter((s) => s.err === null);
  const end = c.until === null || c.until === undefined ? ordered.length : ordered.findIndex((s) => s.signature === c.until) + 1;
  if (end === 0) throw new Error(`${c.until} is not in the history of ${c.mint}`);
  const transactions = [];
  for (const s of ordered.slice(0, end)) {
    const t = await rpc<Tx>('getTransaction', [s.signature, { encoding: 'base64', maxSupportedTransactionVersion: 1, commitment: 'finalized' }]);
    const m = t.meta;
    transactions.push({
      signature: s.signature, slot: t.slot, blockTime: t.blockTime, transaction: t.transaction,
      meta: { err: m['err'], loadedAddresses: m['loadedAddresses'], innerInstructions: m['innerInstructions'], logMessages: m['logMessages'], preTokenBalances: m['preTokenBalances'], postTokenBalances: m['postTokenBalances'] },
    });
  }
  cases.push({ name: c.name, mint: c.mint, until: c.until, transactions });
}
writeFileSync(OUT, `${JSON.stringify({ meta: { rpc: redactRpc(RPC), fetchedAt: new Date().toISOString(), calls, sha256: casesHash(cases) }, cases }, null, 1)}\n`);
console.log(`wrote ${cases.map((c) => `${c.name}: ${c.transactions.length} transactions`).join(', ')} with ${calls} calls`);
