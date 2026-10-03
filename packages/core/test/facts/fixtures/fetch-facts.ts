// Dev tool, not a test: records the real inputs of the fact producers (FACTS-1) for one graduated pump coin, plus
// third-party and series answers. Run: node --no-warnings packages/core/test/facts/fixtures/fetch-facts.ts
// Public RPC (override with SOLANA_RPC), spaced requests with backoff on 429 and 5xx. Every record keeps its signature
// or address, the slot it was read at and the time it was fetched.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountKeys, decodePool, decodeTokenAccount, decodeTransaction, firstFunder, fromBase64, recordFromRpc, transactionEvents, type Address, type RpcTransactionBase64 } from '../../../src/chain/index.ts';

const RPC = process.env['SOLANA_RPC'] ?? 'https://api.mainnet-beta.solana.com';
const OUT = dirname(fileURLToPath(import.meta.url));
/** A coin that graduated and migrated in slot 452,941,614 (DEC-1's migration fixture). */
const MINT = 'DRnMYnkK3dCwypBgZaH5jcVoQHQhoEr8NcMNLJ18pump';
const POOL = '3u3BeZjsfaWxoEfJDbgiGaqS4aikdgE3gKFJzJGSs4vn';
const MIGRATION_SLOT = 452_941_614;
const SPACING_MS = 250;
const SWAPS = 40;
const FIRST_BUYERS = 20;
const FUNDER_PAGES = 3;
let last = 0;
let calls = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Answers are cached on disk (fixtures/.rpc-cache.json, not committed) so an interrupted run resumes where it stopped.
const CACHE = join(OUT, '.rpc-cache.json');
const cache: Record<string, unknown> = existsSync(CACHE) ? (JSON.parse(readFileSync(CACHE, 'utf8')) as Record<string, unknown>) : {};
let dirty = 0;
const save = () => writeFileSync(CACHE, JSON.stringify(cache));

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const key = JSON.stringify([method, params]);
  if (key in cache) return cache[key] as T;
  const v = await rpcLive<T>(method, params);
  cache[key] = v;
  if (++dirty % 20 === 0) {
    save();
    console.error(`${calls} calls`);
  }
  return v;
}

async function rpcLive<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const wait = last + SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    calls++;
    const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 8) throw new Error(`${method}: HTTP ${res.status} after ${attempt} retries`);
      await sleep(Math.min(30_000, 1000 * 2 ** attempt));
      continue;
    }
    const body = (await res.json()) as { result?: T; error?: unknown };
    if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
    return body.result as T;
  }
}

interface Sig { signature: string; slot: number; err: unknown }
const signatures = async (address: string, pages: number): Promise<{ sigs: Sig[]; complete: boolean }> => {
  const out: Sig[] = [];
  let before: string | undefined;
  for (let p = 0; p < pages; p++) {
    const page = await rpc<Sig[]>('getSignaturesForAddress', [address, { limit: 1000, commitment: 'confirmed', ...(before ? { before } : {}) }]);
    out.push(...page);
    if (page.length < 1000) return { sigs: out, complete: true };
    before = page.at(-1)!.signature;
  }
  return { sigs: out, complete: false };
};

interface TxFixture { label: string; signature: string; slot: string; base64: RpcTransactionBase64 }
const getTx = async (signature: string, label: string): Promise<TxFixture> => {
  const r = await rpc<RpcTransactionBase64 & { slot: number }>('getTransaction', [signature, { encoding: 'base64', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]);
  return { label, signature, slot: String(r.slot), base64: r };
};

const getJson = async (url: string): Promise<unknown> => {
  const res = await fetch(url, { headers: { 'user-agent': 'zeroed-fixtures' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
};

const fetchedAt = Date.now();
const txs: TxFixture[] = [];

// 1. The mint's transactions, oldest first: its create, the creation-slot window and the first buyers.
const mintSigs = await signatures(MINT, 40);
if (!mintSigs.complete) throw new Error('mint history longer than 40 pages');
const oldestFirst = [...mintSigs.sigs].reverse().filter((s) => s.err === null);
const s0 = oldestFirst[0]!.slot;
// Curve buyers only (the launch cohort): after the CompleteEvent no curve buy can follow, so the list is final there.
const buyers: string[] = [];
let completeSlot: number | null = null;
for (const s of oldestFirst) {
  if (s.slot > s0 + 2 && (buyers.length >= FIRST_BUYERS || (completeSlot !== null && s.slot > completeSlot))) break;
  const t = await getTx(s.signature, s.slot <= s0 + 2 ? 'creation window' : 'first buyers');
  txs.push(t);
  for (const e of transactionEvents(recordFromRpc(t.signature, t.base64))) {
    if (e.name === 'TradeEvent' && e.data.mint === MINT && e.data.isBuy && !buyers.includes(e.data.user) && buyers.length < FIRST_BUYERS) buyers.push(e.data.user);
    if (e.name === 'CompleteEvent' && e.data.mint === MINT) completeSlot ??= s.slot;
  }
}

// 2. First funders of the dev and the first buyers, as of an hour after migration (9,000 slots): later history
// never counts.
const AS_OF = BigInt(MIGRATION_SLOT + 9_000);
const creator = (() => {
  for (const t of txs) for (const e of transactionEvents(recordFromRpc(t.signature, t.base64))) if (e.name === 'CreateEvent' && e.data.mint === MINT) return e.data.creator;
  throw new Error('no create in the recorded history');
})();
const funders: unknown[] = [];
for (const w of [creator, ...buyers.filter((b) => b !== creator)]) {
  const h = await signatures(w, FUNDER_PAGES);
  const oldest = h.sigs.filter((x) => x.err === null && BigInt(x.slot) <= AS_OF).at(-1);
  const none = { wallet: w, asOfSlot: String(AS_OF), complete: false, funder: null, signature: null, slot: null, atMs: null };
  if (!h.complete) {
    funders.push(none);
    continue;
  }
  if (oldest === undefined) {
    funders.push({ ...none, complete: true });
    continue;
  }
  const t = await getTx(oldest.signature, 'oldest transaction of a funded wallet');
  const rec = recordFromRpc(t.signature, t.base64);
  const f = firstFunder(rec, w);
  txs.push(t);
  funders.push(f === null
    ? { ...none, complete: true, signature: t.signature }
    : { wallet: w, asOfSlot: String(AS_OF), complete: true, funder: f.from, signature: t.signature, slot: t.slot, atMs: rec.blockTime === null ? null : rec.blockTime * 1000 });
}

// 3. The pool's first swaps after migration.
const poolSigs = await signatures(POOL, 10);
const poolOld = [...poolSigs.sigs].reverse().filter((s) => s.err === null && s.slot >= MIGRATION_SLOT);
for (const s of poolOld.slice(0, SWAPS)) txs.push(await getTx(s.signature, 'pool swap after migration'));

// 4. Account state now: mint, pool, vaults, LP mint, at confirmed.
const pool0 = await rpc<{ value: { data: [string, string] } }>('getAccountInfo', [POOL, { encoding: 'base64', commitment: 'confirmed' }]);
const pool = decodePool(fromBase64(pool0.value.data[0])).value;
const addresses = [MINT, POOL, pool.poolBaseTokenAccount, pool.poolQuoteTokenAccount, pool.lpMint];
const multi = await rpc<{ context: { slot: number }; value: ({ owner: string; data: [string, string] } | null)[] }>('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed' }]);
const accountsRead = {
  mint: MINT, slot: String(multi.context.slot), commitment: 'confirmed',
  accounts: addresses.map((address, i) => ({ address, owner: multi.value[i]?.owner ?? null, data: multi.value[i]?.data[0] ?? null })),
};

// 5. Holders. The public RPC refuses getTokenLargestAccounts (429 "Too many requests for a specific RPC call", as
// GATE-1's fetch-holders.ts found), so the candidates are every token account of the mint named in the recorded
// transactions' token balances, read now at confirmed, and the 20 largest kept. Recorded as the same answer shape.
const candidates = new Set<string>();
for (const t of txs) {
  const rec = recordFromRpc(t.signature, t.base64);
  const keys = accountKeys(decodeTransaction(rec.transaction), rec.loadedAddresses);
  const meta = (t.base64 as unknown as { meta?: { postTokenBalances?: { accountIndex: number; mint: string }[] } }).meta;
  for (const b of meta?.postTokenBalances ?? []) if (b.mint === MINT && keys[b.accountIndex] !== undefined) candidates.add(keys[b.accountIndex]!);
}
const balances: { address: string; amount: bigint }[] = [];
let candidatesSlot = 0;
const list = [...candidates].sort();
for (let i = 0; i < list.length; i += 100) {
  const chunk = list.slice(i, i + 100);
  const r = await rpc<{ context: { slot: number }; value: ({ owner: string; data: [string, string] } | null)[] }>('getMultipleAccounts', [chunk, { encoding: 'base64', commitment: 'confirmed' }]);
  candidatesSlot = Math.max(candidatesSlot, r.context.slot);
  chunk.forEach((address, k) => {
    const v = r.value[k];
    if (v) balances.push({ address, amount: decodeTokenAccount(fromBase64(v.data[0]), v.owner as Address).amount });
  });
}
balances.sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : a.address < b.address ? -1 : 1));
const largest = { context: { slot: candidatesSlot }, value: balances.slice(0, 20).map((b) => ({ address: b.address, amount: String(b.amount) })), candidates: list.length };
const tokenAccts = await rpc<{ context: { slot: number }; value: ({ owner: string; data: [string, string] } | null)[] }>('getMultipleAccounts', [[...largest.value.map((a) => a.address), MINT], { encoding: 'base64', commitment: 'confirmed' }]);
const owners = largest.value.map((a, i) => {
  const v = tokenAccts.value[i];
  if (!v) throw new Error(`token account ${a.address} vanished`);
  return decodeTokenAccount(fromBase64(v.data[0]), v.owner as Address).owner;
});
const ownerAccts = await rpc<{ context: { slot: number }; value: ({ owner: string } | null)[] }>('getMultipleAccounts', [owners, { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }]);
const mintAcct = tokenAccts.value.at(-1)!;
const holdersRaw = {
  largest, tokenAccountsSlot: tokenAccts.context.slot, ownersSlot: ownerAccts.context.slot,
  mint: { owner: mintAcct.owner, data: mintAcct.data[0] },
  owners: owners.map((o, i) => ({ owner: o, program: ownerAccts.value[i]?.owner ?? null })),
};

// 5b. The complete holder set: one getProgramAccounts on the mint's own token program, memcmp on the mint at offset
// 0 (no dataSize filter: Token-2022 accounts are 170 bytes or more), after a read of the mint's supply.
const mintRead = await rpc<{ context: { slot: number }; value: { owner: string; data: [string, string] } }>('getAccountInfo', [MINT, { encoding: 'base64', commitment: 'confirmed' }]);
const gpaStarted = Date.now();
const gpa = await rpc<{ context: { slot: number }; value: { pubkey: string; account: { owner: string; data: [string, string]; lamports: number } }[] }>('getProgramAccounts', [mintRead.value.owner, { encoding: 'base64', commitment: 'confirmed', withContext: true, filters: [{ memcmp: { offset: 0, bytes: MINT } }] }]);
const holdersComplete = {
  mint: { slot: mintRead.context.slot, owner: mintRead.value.owner, data: mintRead.value.data[0] },
  gpa: { slot: gpa.context.slot, latencyMs: Date.now() - gpaStarted, accounts: gpa.value.map((a) => ({ address: a.pubkey, owner: a.account.owner, data: a.account.data[0] })) },
};

// 6. Third-party authority reads, trimmed to the fields H16 compares (the RugCheck report is large).
const rc = (await getJson(`https://api.rugcheck.xyz/v1/tokens/${MINT}/report`)) as Record<string, unknown>;
const gp = (await getJson(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${MINT}`)) as { result: Record<string, Record<string, unknown>> };
const jup = (await getJson(`https://lite-api.jup.ag/tokens/v2/search?query=${MINT}`)) as { id: string; audit?: Record<string, unknown> }[];
const thirdParty = {
  rugcheck: { mint: rc['mint'], mintAuthority: rc['mintAuthority'], freezeAuthority: rc['freezeAuthority'], token: rc['token'] },
  goplus: gp.result[MINT] === undefined ? null : { mintable: gp.result[MINT]!['mintable'], freezable: gp.result[MINT]!['freezable'] },
  jupiter: jup.find((t) => t.id === MINT)?.audit ?? null,
};

// 7. Series: hourly SOL/USD candles (Coinbase, the backtest's source) and DefiLlama's daily pump.fun volume.
const end = Math.floor(fetchedAt / 3_600_000) * 3_600_000;
const coinbase = await (await fetch(`https://api.exchange.coinbase.com/products/SOL-USD/candles?granularity=3600&start=${new Date(end - 72 * 3_600_000).toISOString()}&end=${new Date(end).toISOString()}`, { headers: { 'user-agent': 'zeroed-fixtures' } })).text();
const llama = (await getJson('https://api.llama.fi/summary/dexs/pump.fun?dataType=dailyVolume')) as { totalDataChart: [number, number][] };

save();
writeFileSync(join(OUT, 'facts.json'), JSON.stringify({
  meta: { rpc: RPC, fetchedAt: new Date(fetchedAt).toISOString(), calls, mint: MINT, pool: POOL, migrationSlot: MIGRATION_SLOT, creationSlot: s0, creator, asOfSlot: String(AS_OF), firstBuyers: buyers },
  transactions: txs, funders, accountsRead, holdersRaw, holdersComplete, thirdParty, coinbase, llama: llama.totalDataChart.slice(-400),
}, null, 1) + '\n');
console.log(`wrote facts.json: ${txs.length} transactions, ${funders.length} funders, ${calls} RPC calls`);
