// Dev tool, not a test: collects real successful mainnet swaps of the exact kinds TX-1 builds, plus the accounts
// needed to rebuild them, for the byte-for-byte golden tests (test/tx/golden.test.ts) and the provisional compute
// calibration (src/tx/calibration.ts).
// Run: node packages/core/test/tx/fixtures/fetch-golden.ts
// Public RPC (override with SOLANA_RPC), about 9 requests a second, with backoff on 429 and 5xx. Node built-ins and
// the DEC-1 decoders only.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NATIVE_MINT,
  PUMP_AMM_GLOBAL_CONFIG,
  PUMP_AMM_PROGRAM,
  PUMP_GLOBAL,
  PUMP_PROGRAM,
  type Address,
  accountKeys,
  bondingCurveAddress,
  decodeBondingCurve,
  decodePool,
  decodeTransaction,
  fromBase64,
  isCanonicalPool,
  toHex,
} from '../../../src/chain/index.ts';

const RPC = process.env['SOLANA_RPC'] ?? 'https://api.mainnet-beta.solana.com';
const OUT = dirname(fileURLToPath(import.meta.url));
const SPACING_MS = 110;
const GOLDEN_PER_KIND = 3;
const SAMPLES_PER_KIND = 60;
const MAX_SCANNED = 1500;
let last = 0;
let calls = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const wait = last + SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    calls++;
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 7) throw new Error(`${method}: HTTP ${res.status} after ${attempt} retries`);
      const backoff = Math.min(30_000, 1000 * 2 ** attempt);
      console.error(`${method}: HTTP ${res.status}, waiting ${backoff} ms`);
      await sleep(backoff);
      continue;
    }
    const body = (await res.json()) as { result?: T; error?: unknown };
    if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
    return body.result as T;
  }
}

type Kind = 'curve-buy' | 'curve-sell' | 'pool-buy' | 'pool-sell';
// Anchor discriminators from the pinned IDLs: pump buy_exact_quote_in_v2 / sell_v2; PumpSwap buy_exact_quote_in /
// sell (the v1 family, ruled for SOL pools in the CORE-2b review).
const KINDS: readonly { kind: Kind; program: Address; disc: string }[] = [
  { kind: 'curve-buy', program: PUMP_PROGRAM, disc: 'c2ab1c46684d5b2f' },
  { kind: 'curve-sell', program: PUMP_PROGRAM, disc: '5df6823ce7e940b2' },
  { kind: 'pool-buy', program: PUMP_AMM_PROGRAM, disc: 'c62e1552b4d9e870' },
  { kind: 'pool-sell', program: PUMP_AMM_PROGRAM, disc: '33e685a4017f83ad' },
];

/** Top-level programs a qualifying transaction may use: the same set TX-1 builds with (plus Token-2022). */
const PLAIN_PROGRAMS = new Set<string>([
  'ComputeBudget111111111111111111111111111111',
  '11111111111111111111111111111111',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  PUMP_PROGRAM,
  PUMP_AMM_PROGRAM,
]);

interface RpcTx {
  slot: number;
  blockTime: number | null;
  transaction: [string, string];
  meta: { err: unknown; fee: number; computeUnitsConsumed?: number; loadedAddresses?: { writable: string[]; readonly: string[] } | null } | null;
}
type RpcAccount = { context: { slot: number }; value: { owner: string; lamports: number; data: [string, string] } | null };

interface AccountFixture { label: string; address: string; slot: number; owner: string; lamports: number; dataBase64: string }
interface GoldenTx {
  kind: Kind;
  signature: string;
  slot: number;
  /** Wire bytes, base64. */
  transaction: string;
  loadedAddresses: { writable: string[]; readonly: string[] };
  computeUnitsConsumed: number | null;
  fee: number;
  /** Index of the swap among the top-level instructions. */
  swapIndex: number;
  /** Bonding curve (curve kinds) or pool (pool kinds). */
  market: string;
  mint: string;
}
interface Sample { kind: Kind; signature: string; slot: number; computeUnitsConsumed: number; computeUnitLimit: number | null; topLevel: string[] }

const accounts: AccountFixture[] = [];
const golden: GoldenTx[] = [];
const samples: Sample[] = [];
const have = new Set<string>();

async function addAccount(label: string, address: string): Promise<AccountFixture | null> {
  const known = accounts.find((a) => a.address === address);
  if (known) return known;
  const r = await rpc<RpcAccount>('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
  if (!r.value) return null;
  const f = { label, address, slot: r.context.slot, owner: r.value.owner, lamports: r.value.lamports, dataBase64: r.value.data[0] };
  accounts.push(f);
  return f;
}

const cuLimitOf = (tx: ReturnType<typeof decodeTransaction>, keys: readonly string[]): number | null => {
  for (const ix of tx.instructions) {
    if (keys[ix.programIdIndex] === 'ComputeBudget111111111111111111111111111111' && ix.data[0] === 2 && ix.data.length === 5) {
      return ix.data[1]! | (ix.data[2]! << 8) | (ix.data[3]! << 16) | (ix.data[4]! * 2 ** 24);
    }
  }
  return null;
};

async function scan(program: Address): Promise<void> {
  let before: string | undefined;
  let scanned = 0;
  while (scanned < MAX_SCANNED) {
    const sigs = await rpc<{ signature: string; err: unknown }[]>('getSignaturesForAddress', [program, { limit: 1000, ...(before ? { before } : {}), commitment: 'confirmed' }]);
    if (sigs.length === 0) return;
    before = sigs[sigs.length - 1]!.signature;
    for (const s of sigs) {
      if (s.err !== null || have.has(s.signature)) continue;
      const wanted = KINDS.filter((k) => k.program === program);
      const goldenDone = wanted.every((k) => golden.filter((g) => g.kind === k.kind).length >= GOLDEN_PER_KIND);
      const samplesDone = wanted.every((k) => samples.filter((x) => x.kind === k.kind).length >= SAMPLES_PER_KIND);
      if (goldenDone && samplesDone) return;
      scanned++;
      const r = await rpc<RpcTx | null>('getTransaction', [s.signature, { encoding: 'base64', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
      if (!r || !r.meta || r.meta.err !== null) continue;
      const tx = decodeTransaction(fromBase64(r.transaction[0]));
      if (tx.version === 1 || tx.signatures.length !== 1) continue;
      const loaded = { writable: (r.meta.loadedAddresses?.writable ?? []) as Address[], readonly: (r.meta.loadedAddresses?.readonly ?? []) as Address[] };
      const keys = accountKeys(tx, loaded);
      const topLevel = tx.instructions.map((ix) => keys[ix.programIdIndex]!);
      // A system transfer is allowed (a tip); anything else outside the plain set is a wrapper program.
      if (!topLevel.every((p) => PLAIN_PROGRAMS.has(p))) continue;
      const swaps = tx.instructions
        .map((ix, i) => ({ ix, i, kind: KINDS.find((k) => k.program === keys[ix.programIdIndex] && toHex(ix.data.subarray(0, 8)) === k.disc) }))
        .filter((x) => x.kind !== undefined);
      if (swaps.length !== 1) continue;
      const { ix, i, kind } = swaps[0]!;
      const k = kind!.kind;
      have.add(s.signature);
      if (r.meta.computeUnitsConsumed !== undefined && samples.filter((x) => x.kind === k).length < SAMPLES_PER_KIND) {
        samples.push({ kind: k, signature: s.signature, slot: r.slot, computeUnitsConsumed: r.meta.computeUnitsConsumed, computeUnitLimit: cuLimitOf(tx, keys), topLevel });
      }
      if (golden.filter((g) => g.kind === k).length >= GOLDEN_PER_KIND) continue;
      // Golden cases: SOL-quoted, non-mayhem markets only (the ones TX-1 trades).
      const acc = (n: number) => keys[ix.accounts[n]!]!;
      let market: string;
      let mint: string;
      if (k.startsWith('curve')) {
        mint = acc(1);
        if (acc(2) !== NATIVE_MINT) continue;
        market = acc(10);
        if (market !== bondingCurveAddress(mint as Address)) continue;
        const c = await addAccount('bonding curve', market);
        if (!c) continue;
        const curve = decodeBondingCurve(fromBase64(c.dataBase64)).value;
        if (curve.isMayhemMode || curve.complete) continue;
      } else {
        market = acc(0);
        mint = acc(3);
        if (acc(4) !== NATIVE_MINT) continue;
        const p = await addAccount('PumpSwap pool', market);
        if (!p) continue;
        const pool = decodePool(fromBase64(p.dataBase64)).value;
        if (pool.isMayhemMode || !isCanonicalPool(pool, market as Address)) continue;
      }
      await addAccount('mint', mint);
      golden.push({
        kind: k, signature: s.signature, slot: r.slot, transaction: r.transaction[0], loadedAddresses: loaded,
        computeUnitsConsumed: r.meta.computeUnitsConsumed ?? null, fee: r.meta.fee, swapIndex: i, market, mint,
      });
      console.log(`${k} ${s.signature} (${golden.length} golden, ${samples.length} samples, ${calls} calls)`);
    }
  }
}

await addAccount('pump Global', PUMP_GLOBAL);
await addAccount('PumpSwap GlobalConfig', PUMP_AMM_GLOBAL_CONFIG);
await scan(PUMP_PROGRAM);
await scan(PUMP_AMM_PROGRAM);
const fetchedAt = new Date().toISOString();
writeFileSync(
  join(OUT, 'golden.json'),
  JSON.stringify({ source: RPC, fetchedAt, calls, accounts, golden, samples }, null, 1) + '\n',
);
console.log(`wrote ${golden.length} golden transactions, ${samples.length} samples, ${accounts.length} accounts in ${calls} calls`);
